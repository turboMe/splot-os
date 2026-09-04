# Rollout — włączenie silnika V2 dla uzgodnionego zestawu agentów

**Dla kogo:** osobna instancja. **Nie koliduje** z instancją domykającą F8 ani z instancją
migracji F7 (patrz §7).
**Data zebrania faktów:** 2026-08-18. Wszystko policzone w źródle **dzisiaj**.

**Decyzja właściciela:** włączamy na V2 wszystkich poza `filmmakerAgent`, `musicianAgent`
i `capabilitySmith`. Domena coding jedzie mimo niedokończenia — patrz §3, dlaczego to jest
bezpieczne.

---

## 0. STAN WYKONANIA — 2026-08-18

| krok | stan | dowód |
|---|---|---|
| §2 blocker — precontext obu recenzentów | ✅ | `bd48e6b`, brama sfalsyfikowana **dwukrotnie** |
| krok 2 — `ORCHESTRATION_V2_CAPABILITIES` 8 → 16 | ✅ | `.env:414` (plik nieśledzony przez git) |
| krok 3 — dwie flagi cutoveru | ✅ odkomentowane | `.env:428–429` |
| **restart serwera** | ⬜ **NIE wykonany** | czeka na domknięcie ostatniego scenariusza F8 |
| krok 4 — canary | ⬜ **żaden nie uruchomiony** | `orch_jobs` nadal 0 |

⚠️ **Nic z powyższego nie działa jeszcze w produkcji.** Flagi są w pliku, ale proces nie
został zrestartowany, więc tło **nadal jedzie legacy**. Rollback na tym etapie = zakomentować
dwie linie w `.env`; nie ma pracy w locie, bo silnik nie przyjął ani jednego zadania.

**Ustalenie przy okazji §2 — brama BYŁA dekoracją.** Falsyfikacja przed naprawą: usunięcie
loadera zostawiało `check:capability-precontext` **zielone** (exit 0), bo wszystkie asercje
nazywały agentów po ID i żadna nie dotyczyła nowych wpisów. Po dopisaniu dwóch asercji
tożsamości ta sama operacja daje `1 FAILED` (exit 1). Gdyby nie falsyfikacja, dołożylibyśmy
wpisy pod bramę, która nie potrafi ich obronić — dokładnie ten wzorzec, który §9 nazywa
„asercją niezdolną do oblania".

---

## 1. Stan wyjściowy — zmierzony

```
orch_jobs w produkcji:                    0     ← silnik V2 nigdy nie przetworzył zadania
ORCHESTRATION_V2_CAPABILITIES:            8     ← 7 domyślnych + designAgent
FEATURE_ORCHESTRATION_V2_DELEGATION:      zakomentowana
FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS: zakomentowana
ERROR_COLLECTOR_ENABLED:                  false ← cykl samonaprawy JUŻ wyłączony
AUTOHEAL_AUTO_PROMOTE / DEPLOY_AUTO_SWAP: false
```

Włączone dziś (8): `researcherAgent` `chefAgent` `contentAgent` `writerAgent`
`analyticsAgent` `deliberationAgent` `crmAgent` `designAgent`.

**Do dołożenia (8):** `automationArchitect` `huntAgent` `marketingAgent` `knowledgeAgent`
`codingAgent` `codeReviewAgent` `securityReviewAgent` `performanceReviewAgent`.

**Świadomie poza:** `filmmakerAgent` `musicianAgent` `capabilitySmith` (decyzja właściciela),
`salesAgent` — patrz §5, wymaga potwierdzenia.

---

## 2. ⭐ JEDYNY REALNY BLOCKER — ✅ ZDJĘTY 2026-08-18 (`bd48e6b`)

> **Zrobione.** Oba loadery dopisane, brama rozszerzona i sfalsyfikowana dwukrotnie (patrz §0).
> Poniższy opis zostaje jako uzasadnienie — nie jako zadanie do wykonania.

`securityReviewAgent` i `performanceReviewAgent` **nie miały precontextu w V2**.

Zarejestrowane są cztery: `automationArchitect`, `codeReviewAgent`, `codingAgent`,
`knowledgeAgent` (`src/mastra/orchestration/execution/capability-precontext.ts:53`,
`LOADERS`). Dwaj pozostali recenzenci nie.

Dlaczego to blokuje: badanie sita F7 ustaliło, że legacy to **trzy ścieżki**, i dla agentów
z **dedykowanym harnessem** V2 jest ⛔ **gorsze**, dopóki nie poda `contextBuilder`.
`services/review-harness.ts:40` buduje precontext dla **dowolnego** recenzenta
(`buildReviewPrecontext` z runtime `agentId`), więc w legacy security i performance go
dostają. Na V2 — dziś nie.

Włączenie ich w tym stanie znaczy: **ten sam agent dostaje mniej kontekstu niż wcześniej.**
To łamie regułę nadrzędną właściciela: *„na V2 ma być tak samo albo lepiej".*

**Naprawa jest mała** — dopisz dwa loadery wskazujące na te same `reviewPrecontextFields`,
tym samym wzorcem, którym zarejestrowany jest `codeReviewAgent`. Potem **sfalsyfikuj**:
usuń jeden loader i sprawdź, że brama `check:capability-precontext` robi się ✗. Jeśli nie
robi — brama nie pokrywa nowych wpisów i trzeba ją rozszerzyć, bo inaczej jest dekoracją.

---

## 3. Dlaczego niedokończona domena coding NIE blokuje

Domena coding ma **71 z 86** pozycji z dowodem live. Otwarte 15, z czego 9 to praca.
Kluczowe: **wszystkie niedomknięte pozycje o realnym skutku to merge i wdrożenie**
(F2, F3, F4, F7, F9) — a te są za **własnymi, osobnymi flagami, które są wyłączone**:

| co | flaga | stan |
|---|---|---|
| cykl samonaprawy w ogóle się otwiera | `ERROR_COLLECTOR_ENABLED` | **false** |
| automatyczna promocja kandydata | `AUTOHEAL_AUTO_PROMOTE` | **false** |
| swap na nowy kod | `DEPLOY_AUTO_SWAP` | **false** |
| merge do żywego kodu | zgoda człowieka (`live-merge-permission.ts`) | wymagana |

Czyli `codingAgent` na V2 dostaje zadania, pracuje w worktree i produkuje patche —
a niedokończone ścieżki wdrożeniowe **nie mają jak wystrzelić**.

⚠️ `ERROR_COLLECTOR_ENABLED` przy braku wpisu domyślnie **`true`**
(`services/error-collector.ts:49`). Ta linijka ma **zostać** w `.env`, nie zniknąć.

---

## 4. Co dokładnie zrobić

### Krok 1 — domknij precontext (§2), z falsyfikacją

### Krok 2 — rozszerz listę capability

Jedna zmienna, `.env:408`:
```
ORCHESTRATION_V2_CAPABILITIES=researcherAgent,chefAgent,contentAgent,writerAgent,analyticsAgent,deliberationAgent,crmAgent,designAgent,automationArchitect,huntAgent,marketingAgent,knowledgeAgent,codingAgent,codeReviewAgent,securityReviewAgent,performanceReviewAgent
```

**Ta lista jest jednocześnie mechanizmem wycofania** i to jest jej najlepsza własność:
wycofanie jednego agenta = usunięcie jednej nazwy, bez dotykania silnika i bez wpływu na
pozostałych. Rollback per agent, nie wszystko-albo-nic.

### Krok 3 — włącz dwie flagi cutoveru

`.env:420–421` — odkomentuj. **To jedyny moment, w którym wolno Ci je ruszyć, i tylko
dlatego, że właściciel podjął tę decyzję w rozmowie 2026-08-18.**

Co robią: przenoszą **tło** (delegacje meta agenta i automatyzacje n8n) z legacy na durable
joby. Brama przyjęcia (`services/durable-delegation.ts:174`) sprawdza capability i zwraca
`null` dla nieznanego — czyli agent spoza listy **cicho zostaje na legacy**, bez wyjątku.

### Krok 4 — canary, jeden po drugim

`orch_jobs = 0`. Pierwsze uruchomienie **jest** canary — nie sprawdzeniem, że działa.
W historii tego projektu **każdy** canary znalazł defekty niewidoczne dla testów: dwa przy
pierwszym włączeniu flag V2, dwa przy kroku 3b, trzy szeregowo przy designie. Znalezienie
czegoś jest celem, nie porażką.

Dla **każdej** nowo włączonej zdolności: jedno realne zadanie, i sprawdź trzy rzeczy:

1. **job kończy się `COMPLETED`** — nie `FAILED`, nie wisi;
2. **wynikiem jest produkt, nie raport frameworka** — ta pomyłka wystąpiła tu wielokrotnie
   (`fullResponseText` brał ostatni tekst runu zamiast produktu);
3. **liczba zadań i replanów** — 1 zadanie, 0 replanów to zdrowy kształt; więcej znaczy,
   że sędzia nie rozpoznał wyniku.

**Kolejność — od najmniejszego promienia rażenia:**

| kolejność | kto | co realnie robi w świecie |
|---|---|---|
| 1 | `knowledgeAgent` | nic — wszystkie 8 narzędzi to odczyty, pamięć, skille, artefakty |
| 2 | `codeReviewAgent` `securityReviewAgent` `performanceReviewAgent` | czytają kod, piszą recenzję |
| 3 | `codingAgent` | pracuje w worktree; merge za zgodą człowieka |
| 4 | `automationArchitect` | **wdraża workflow do n8n** |
| 5 | `huntAgent` | **pisze na zewnątrz** |
| 6 | `marketingAgent` | **pisze na zewnątrz** |

Pozycje 4–6 zostawiają trwały ślad poza systemem. Zrób je **ostatnie**, po jednym, i
**powiedz właścicielowi, zanim ruszysz każdą z nich** — canary automationArchitecta
naprawdę wdrożył workflow do n8n, co zostało potwierdzone przez API n8n, a nie przez
odpowiedź agenta.

### Krok 5 — zapisz wyniki

Tabela w `ideas/plan-dziecko-po-odlozeniu-g0.md` §6: zdolność → wynik → co znaleziono.
Zdolność, która oblała canary, **wypada z listy** (krok 2), a defekt idzie do naprawy.

---

## 5. `salesAgent` — ROZSTRZYGNIĘTE 2026-08-18

„Wszyscy poza filmmaker, musician, capabilitySmith" obejmowałoby też `salesAgent` — ale
właściciel **sam go wykluczył** 2026-08-11 (plan, „`salesAgent`: ŚWIADOMIE POMINIĘTY").

✅ **Właściciel potwierdził wykluczenie** w rozmowie 2026-08-18: „sales agenta nie włączamy
jakby co, tak samo jak filmakera, music agenta". `salesAgent` **nie jest** w
`ORCHESTRATION_V2_CAPABILITIES` — zostaje na legacy.

---

## 5B. `n8nMcpEngineer` — dlaczego NIE MA go na liście (zweryfikowane w źródle)

Dokument pierwotnie nie wymieniał go w żadnej z trzech kategorii, choć jest zarejestrowany
w `index.ts` i figuruje w `SIDE_EFFECT_PRODUCT_CAPABILITIES`. Właściciel słusznie zapytał,
bo to **informator architekta o węzłach** i musi działać tak samo jak w legacy.

**Nie jest capability do routingu — jest krokiem WEWNĄTRZ runu architekta.** Dlatego wpis na
liście byłby martwy, a jego brak niczego nie psuje:

- `dispatchDurableDelegation` ma **jedno** wywołanie w repo (`async-delegation.ts:176`,
  wewnątrz `startAsyncDelegation`);
- `n8nMcpEngineer` nie może tam trafić trzema niezależnymi zatrzaskami: async jest jawnie
  odrzucany (`delegate-task.ts:365`, `n8n_mcp_engineer_async_not_supported`), gałąź MCP
  (`:679`) kończy się `return` **przed** blokiem async (`:830`), a `supportsGenericAsync`
  (`:819`) wyklucza go z nazwy.

**Brama tożsamości przeżywa V2 — to była jedyna realna pułapka.** `delegate-task.ts:357`
wpuszcza do MCP tylko gdy `callerAgentId === 'automationArchitect'`; przy złej pisowni handoff
wracałby `n8n_mcp_engineer_caller_not_allowed`, a architekt raportowałby `mcp_handoff_failed`
— **cały build umierałby na brakującym polu, nie na pracy**. `resolveDelegationCaller`
(`:152`) bierze jednak tożsamość z **runu** (AsyncLocalStorage) i kanonikalizuje ją, więc
`automationArchitect` i `automation-architect` mapują się na to samo. `check:n8n-mcp-engineer`
przechodzi i dowodzi obu kierunków na żywo (podszycie `chefAgent` zablokowane; zapomniane pole
nie zabija builda).

**Stan WS-G spięty z V2 świadomie:** `harness-agent-caller.ts:420` czyta
`mcpHandoffFailedForRun(runId)` **po jawnym runId**, bo ten kod biegnie już poza ALS runu — ta
sama pułapka, która dwa razy wywaliła `findArtifactIds`, obsłużona z góry.

**Budżet handoffu na V2 ≥ legacy:** baza 240 s; architekt ma `latencyClass: long` → podłoga
idle 480 s, hard cap 1800 s, `remaining = min(idle, hardCap)`, a okno idle **resetuje się na
każdym zdarzeniu** → pełne 240 s w momencie delegacji. W legacy (DEADLINE 1200 s) to samo 240 s
na początku, ale w 19. minucie builda zostaje już ~40 s. Zgodne z regułą „tak samo albo lepiej".

---

## 6. Jak wycofać

**Zasada, bez której wycofanie gubi pracę:** most domykający (kopiuje wynik joba V2 do
kontraktu legacy) jest montowany **raz przy starcie**, tylko gdy flaga była włączona
(`index.ts:2291`). Więc:

> **Zanim wyłączysz flagi — odczekaj, aż nic nie biegnie.** Nic w locie = nic do zgubienia.
> Sprawdzenie: `orch_jobs` bez dokumentów w stanie innym niż `COMPLETED`/`FAILED`/`CANCELLED`.

Szczegóły i hipoteza o osieroceniu: `ideas/rollback-rehearsal-cutover.md`.

Trzy poziomy wycofania, od najlżejszego:
1. **jeden agent** — usuń nazwę z `ORCHESTRATION_V2_CAPABILITIES`;
2. **całe tło** — zakomentuj dwie flagi (po odczekaniu, jak wyżej);
3. **awaryjnie, natychmiast** — kill switch pauzuje przyjmowanie nowej pracy, a to, co
   biegnie, domyka się (`pauseDispatch: () => isKillSwitchActive()`, `index.ts:2302`).

---

## 7. Jak nie wejść w drogę pozostałym instancjom

**Wszystkie pracują w TYM SAMYM drzewie** `/projekty/mastra-agentic-environment/agentic-agents` —
to nie są osobne worktree.

**Instancja F8 — nie dotykaj:**
```
src/mastra/scripts/f8-*.ts        scripts/f8-mongo-chaos.sh
src/mastra/orchestration/store/{conversation-writer,attempts,txn}.ts
docs/PROMPT-INSTANCJA-SILNIK-V2.md   docs/STATUS-AGENTOW-SILNIK-V2.md
```
Trzy pliki `store/` tamta instancja **celowo psuje i przywraca** przy falsyfikacji. Dziwny
stan w `git status` to nie defekt.

**Instancja F7 (jeśli działa) — nie dotykaj:** `docs/MIGRACJA-DOMENY-CODING.md` i pozycji
z grup A/B/F/I.

**Twoje:** `.env`, `capability-precontext.ts`, wyniki canary w dzienniku planu.

⚠️ **Restart serwera dotyka wszystkich.** Kroki 2 i 3 wymagają restartu, żeby weszły w
życie. **Uprzedź właściciela**, zanim zrestartujesz.

**Zawsze `git status --short` przed uznaniem czegokolwiek za swoje.**

---

## 8. Definicja ukończenia

- precontext dla obu recenzentów, **sfalsyfikowany**;
- lista capability rozszerzona, flagi cutoveru włączone;
- **każda** nowo włączona zdolność ma za sobą canary z zapisanym wynikiem;
- zdolności, które oblały, są usunięte z listy, a defekt opisany;
- `bash scripts/check-all.sh` exit 0;
- wpis w dzienniku `ideas/plan-dziecko-po-odlozeniu-g0.md` §6.

---

## 9. Zasady pracy w repo

- **Node v22 obowiązkowo** (`nvm use v22.20.0`). Pod v20 serwer startuje, **nie nasłuchuje
  i nie loguje błędu** — wygląda jak zawieszenie bez przyczyny.
- Commituj **wyłącznie jawnymi ścieżkami**. **Nigdy `git add -A`.**
- **Po napisaniu asercji zepsuj kod i sprawdź, że widzisz ✗.** W poprzedniej sesji cztery
  asercje okazały się niezdolne do oblania.
- **Zanim uznasz pustkę za defekt: policz wiersze bez filtra i przeczytaj sygnaturę w
  źródle.** Dziewięć „defektów" w jednej sesji okazało się błędami sondy.
- **Mastra: nazwą narzędzia w runtime jest KLUCZ obiektu `tools`**, nie `createTool({id})`.
- **Mastra tnie na 5 krokach** bez deklaracji `maxSteps`.
- **Git tu mówi po polsku** — nie buduj logiki na angielskim wyjściu gita.
- Mongo produkcyjne to **single-node RS `rs0`**; wolumen jest `external` i współdzielony z
  innym projektem — nigdy `docker compose down -v`.
