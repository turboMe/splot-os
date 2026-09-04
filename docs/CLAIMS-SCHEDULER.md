# Claims, scheduler i idempotencja (Etap 5)

> Implementacja Etapu 5 planu `ideas/IDEALSYSTEMMASTERPLAN.md` (§3.3).
> Wdrożono: 2026-07-20, branch `feat/ideal-system-etap-5-claims-scheduler`.
> Flagi: `FEATURE_LEDGER_SCHEDULER`, `FEATURE_IDEMPOTENCY` (obie default **ON**).

## Problem

Task Ledger (E1) *widzi* wszystkie lane'y, ale ich nie *koordynuje*. Dwie
orkiestracje mogły równolegle dotknąć tego samego workflow n8n albo tego samego
leada; retry mógł wysłać drugiego maila / dodać zdublowaną interakcję. E5 dokłada
dwie warstwy: **scheduler claimów** (serializacja kolizji) i **idempotencję**
(retry nie dubluje efektu).

## 1. Scheduler claimów (`services/task-ledger-scheduler.ts`)

Lane deklaruje zasoby, których dotknie, jako `claims[]`
(`n8n:workflow:<id>`, `n8n:deploy`, `crm:write`, `gmail:send`, `gpu:local`,
`repo:src/mastra/**`). Przed startem pracy lane bierze **lease** na claimy:

- claimy **rozłączne** → lane'y jadą **równolegle**;
- claimy **nakładające się** → późniejszy lane **czeka** (zostaje `queued`),
  aż trzymający zwolni.

Lease'y w Mongo `claim_locks` (unikalny indeks na `claim` — atomowy backstop dla
częstego przypadku exact-match). Dopasowanie claimów (`claimsOverlap`):
- ten sam namespace (przed pierwszym `:`) jest wymagany — n8n i CRM nigdy nie kolidują;
- w namespace: exact lub overlap glob (`**` przez `/`, `*` w segmencie, `?` = 1 znak).

Cykl życia lease'a:
- `acquireClaims` — all-or-nothing; konflikt → nic nie trzymane;
- `waitAndAcquireClaims` — bounded poll (domyślnie do 15 min), respektuje anulowanie;
- **zwolnienie automatyczne** przy przejściu lane'a w stan terminalny
  (wpięte w `task-ledger.transitionLane`) oraz przy reconcile stale;
- **TTL na lease** (domyślnie 20 min) — lock po crashe procesu sam wygasa.

### Egzekwowanie — gdzie realne, gdzie widoczne

| Pisarz | Egzekwowanie |
|---|---|
| `automation-job-manager` | **REALNE** — bramka `queued→running` w `executeAutomationJob`: kill switch wstrzymuje start, potem `waitAndAcquireClaims` na claimach lane'a. Claim `n8n:workflow:<id>` derywowany automatycznie z inputu Golden Path (`deriveAutomationClaims`) → dwa buildy na tym samym workflow serializują się; różne workflow → równolegle. |
| `async-delegation`, `background-task-manager` | Claimy **zapisywane + konflikt widoczny** w digeście; twarda preempcja fire-and-forget czeka na rework egzekutora (E1 = obserwator). |

To świadome ograniczenie zakresu, spójne z decyzją E1 (ledger jako obserwator):
najwyższe ryzyko (kolizja deployów n8n) jest egzekwowane realnie na jedynej
bramce, która wspiera punkt oczekiwania; reszta jest widoczna i gotowa do
egzekwowania, gdy egzekutory dostaną punkt wstrzymania.

### Kill switch (domknięcie E1)

Globalny kill switch z E1 był dotąd tylko widoczny w digeście. E5 **egzekwuje** go
na bramce automation-job: gdy aktywny, start nowych jobów jest wstrzymany w pętli,
aż `resume_all` go zwolni.

### gpu:local

`gpu:local` jest rozpoznawanym stringiem claima serializowanym przez scheduler
(jeden ciężki lokalny job GPU naraz). `gpu-guard.ts` zostaje jako preflight VRAM
(zasób ciągły) — spójny mechanizm zamiast osobnego locka.

## 2. Idempotencja (`services/idempotency.ts`)

`withIdempotency({ toolId, input, explicitKey?, isSuccess? }, fn)` uruchamia efekt
**najwyżej raz na klucz**. Retry z tym samym wejściem zwraca zapisany wynik **bez
ponownego uruchomienia**. Klucz = jawny (`laneId+step`) lub
`sha256(toolId + kanoniczny input)` (odporny na kolejność pól). Rekordy w Mongo
`idempotency_keys` z TTL; in-progress starszy niż 5 min jest przejmowany.

**Kluczowa zasada:** cache'owany jest tylko **sukces**. Nieudany efekt (np. webhook
zwrócił błąd) jest usuwany z cache → genuine retry może przejść; tylko **udany**
efekt uboczny się nie powtórzy.

Wpięte w 4 punkty prawdziwych efektów nieodwracalnych:
- `n8n_trigger` (webhook — retry nie odpala dwa razy; opcjonalny `idempotencyKey`);
- `gmail_manage_draft` akcje `create` i `send` (retry nie tworzy/wysyła dubla);
- `crm_add_interaction` (`$push` — retry nie dubluje wpisu historii; opcjonalny klucz).

`crm_create_lead` **nie** jest owijany — ma już idempotencję danych przez upsert
po emailu/nazwie; dokładanie wrappera maskowałoby legalne aktualizacje.

## Widoczność dla operatora

`ledger_status` dokleja sekcję **ACTIVE CLAIMS** — jakie lease'y są trzymane przez
które lane'y, żeby było widać co serializuje.

## Testy (w `check:all`)

- `check:ledger-claims-conflict` — `claimsOverlap` (exact/namespace/glob), dwa lane
  na ten sam claim → drugi konflikt/queue, rozłączne → równolegle, release →
  promocja, `waitAndAcquireClaims` faktycznie czeka i bierze po zwolnieniu,
  terminal zwalnia lease, flaga off wyłącza bramkę (8 grup asercji).
- `check:idempotency-replay` — retry nie dubluje efektu, porażka nie jest
  cache'owana (retryable), różne wejścia → różne klucze, jawny klucz dedupuje,
  klucz kanoniczny, flaga off wyłącza (6 grup asercji).

## Ograniczenia E5 (świadome) i znane luki

- **`sheets_append_rows` — NIEPOKRYTY idempotencją (realna luka).** Dopisywanie
  wierszy do arkusza jest nieodwracalne; retry **zdubluje wiersze**. Niska
  częstotliwość (mało agentów pisze do Sheets), więc odłożone. Wpięcie to ~5 min
  tym samym wzorcem `withIdempotency` co `crm_add_interaction` — do zrobienia,
  gdy jakiś agent zacznie realnie pisać do Sheets w pętli/retry.
- **Claims egzekwowane TYLKO na bramce automation-job.** Dla lane'ów
  hunt/content/chef (fire-and-forget) claims są **zapisywane i widoczne w
  konflikcie**, ale **nie wstrzymują pracy** — bo w E1 ledger jest świadomie
  obserwatorem. Skutek: dwa równoległe leady hunt piszące do CRM nie skolidują na
  poziomie lane'a — ALE **idempotencja i tak chroni sam zapis** przed duplikatem.
  Pełne wstrzymanie tych lane'ów wymaga reworku egzekutora (punkt wstrzymania w
  async-delegation/background-task) — odłożone.
- Overlap glob jest wykrywany, ale atomowy backstop (unikalny indeks) chroni
  najmocniej claimy exact; worktree i tak izoluje ścieżki repo (plan §3.3).
- Priorytet w kolejce jest polem lane'a; pełna kolejka FIFO-z-priorytetami między
  wieloma czekającymi lane'ami dojrzeje razem z egzekwowaniem w pozostałych
  egzekutorach.
- Płatna generacja (film/music/design) **celowo NIE** używa idempotencji — ma
  własny, mocniejszy dla wydatków wzorzec: approval gate + twardy spend cap per
  clip + generation-run ledger. Nakładanie dedup byłoby redundantne.
