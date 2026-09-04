# PLAN — Hardening delegacji i głębokości (case: Bistro Finnsson, 2026-07-21)

Data: 2026-07-22. Status: **DO ZATWIERDZENIA — bez zmian runtime.**
Źródło: sekcja żywej awarii — wątek `telegram-chat-578179283-2026-07-21-1784661608129`
+ wątek delegacji `delegation-62aaf8a9-76ad-42c5-9e3e-d57566b85a6a` (researcherAgent).

---

## 0. TL;DR

Zadanie „research Finnsson → design agent → strona HTML na telefon" **nigdy nie doszło do
designAgenta**. Cztery niezależne przyczyny, w kolejności ważności:

1. **P1 — klasyfikator głębokości jest bezstanowy.** Komenda kontynuacji `"Deleguj"` dostała
   `fast` (score 0.00, 10 kroków, 60 s, 4000 tokenów) mimo że kontynuowała zadanie `critical`.
   Zweryfikowane bezpośrednim wywołaniem `classifyComplexity`.
2. **P2 — timeouty rodzic↔dziecko nieskoordynowane.** Delegacja bezpośrednia = sztywne 240 s
   niezależnie od budżetu rodzica (60/180/300 s). Przy `fast` dziecko ma 4× więcej czasu niż
   rodzic; przy `critical` margines 300−240=60 s zjada narracja modelu.
3. **P3 — praca ginie przy timeoucie.** researcherAgent zrobił ~226 s poprawnego scrapingu
   (12× firecrawl, TripAdvisor, foodandfun), timeout zabił run PRZED `artifact_put` → zero
   artefaktów, cały wynik wyrzucony (został tylko w `mastra_messages` wątku delegacji).
4. **P4 — drobne błędy narzędzi zjadały kroki budżetu:** `planTaskTool` wywala się na
   brakującym `expectedOutput`, `firecrawl_extract` odrzucił schematy 5×, Tavily 400 na
   query samo-`site:`, `delegateTaskTool` wywołany z `args={}`.

Do tego: **P5** — mylący sygnał `depth_floor:deep` przy floor=0 (kosmetyka logów),
**P6** — luka zdolności: menu Finnssona to PNG-i na Wixie, researcher nie ma ścieżki OCR/VLM,
**P7** — operacyjne odzyskanie researchu i domknięcie zadania Finnsson.

Kolejność wdrożenia: **P1 → P2 → P3** (rdzeń, każdy za osobną flagą), potem P4/P5 (szybkie,
niskie ryzyko), P6 osobny mini-projekt, P7 czynność operacyjna (można wykonać od razu).

---

## P1 — Sticky depth: dziedziczenie głębokości w wątku

### Root cause
`classifyComplexity()` ([depth-controller.ts:233](../src/mastra/services/depth-controller.ts))
dostaje tylko `{prompt, agentId, phase}` — zero stanu wątku. Jednosłowne imperatywy
(„Deleguj", „dalej", „rób", „kontynuuj") nie mają żadnych sygnałów → score 0 → `fast`.
Weryfikacja: `"Deleguj"` → `{level:'fast', score:0, signals:[]}`.

Skutek wtórny: przy `fast` context budget = 4000 tokenów → model składał wielki brief dla
designAgenta i wyemitował `delegateTaskTool` z pustymi argumentami (P4d), po czym run padł
na 60 s timeoucie.

### Fix design
1. **Rejestr głębokości wątku** w `depth-controller.ts`, analogiczny do istniejącego
   `setRunDepth/getRunDepth` (linie ~371-378), ale kluczowany `threadId`:
   `setThreadDepth(threadId, level, at)` / `getThreadDepth(threadId)`.
   In-memory Map z TTL (proponuję 6 h) + limit rozmiaru. `generateWithHarness` zapisuje po
   klasyfikacji ([generate-with-harness.ts:203](../src/mastra/services/generate-with-harness.ts)) —
   `threadId` jest już rozwiązany w linii 185, PRZED klasyfikacją, więc wystarczy przekazać.
2. **Reguła dziedziczenia** w `classifyComplexity` (nowe wejście `threadId?`):
   - jeśli świeży (`< TTL`) poprzedni poziom wątku ≥ `deep` **i** nowy prompt sklasyfikował
     się niżej **wyłącznie z braku sygnałów** (score < 0.15, brak `fast_hint`):
     - **imperatyw kontynuacji** (nowy regex `CONTINUATION_KEYWORDS`:
       `deleguj|kontynuuj|dalej|dokończ|rób|zrób to|wykonaj|continue|go ahead|proceed|resume`)
       → dziedziczy pełny poziom wątku, sygnał `depth_inherited:<level>`;
     - **pytanie o status** (`QUESTION_ONLY` + `status|i jak|jak idzie`) → zostaje `fast`
       ALE dostaje nową instrukcję depth (patrz 3) zakazującą wznawiania ciężkiej pracy.
   - jawny `fast_hint` („szybko", „krótko") ZAWSZE wygrywa z dziedziczeniem — użytkownik
     wie lepiej.
3. **Instrukcja dla `fast` przy otwartym zadaniu** w `formatDepthHeader`
   ([generate-with-harness.ts:1663](../src/mastra/services/generate-with-harness.ts)):
   gdy poziom `fast`, a wątek ma świeży poziom ≥ `deep`:
   `- This is a lightweight turn inside a heavier task. Report status only. Do NOT resume multi-step work here — ask the user or continue via async delegation.`
   To domyka awarię z 19:31 („I jak?" → meta wznowił scraping w budżecie 60 s → timeout).
4. **Odporność na restart (opcjonalne, druga iteracja):** fallback do Mongo — ostatni event
   `depth_classified` dla `threadId` z `agent_events` (już logowany z `level` w `data`).
   Pierwsza iteracja: sama mapa in-memory wystarczy (meta żyje w jednym procesie).

### Flaga
`FEATURE_DEPTH_THREAD_INHERITANCE` (default ON, konwencja jak `FEATURE_ADAPTIVE_DEPTH`).

### Pliki
- `src/mastra/services/depth-controller.ts` — rejestr wątków, regex, reguła dziedziczenia,
  nowy sygnał `depth_inherited`.
- `src/mastra/services/generate-with-harness.ts` — przekazanie `threadId` do klasyfikacji,
  zapis do rejestru, wariant instrukcji fast-in-heavy-task.
- `src/mastra/config/harness-flags.ts` — flaga.

### Weryfikacja
- Unit: `"Deleguj"` po turze `critical` w tym samym wątku → `critical` + `depth_inherited`.
- Unit: `"Deleguj"` w świeżym wątku → `fast` (bez regresji).
- Unit: `"szybko, jaki status?"` po `critical` → `fast` (fast_hint wygrywa).
- Live: powtórka scenariusza Finnsson przez Telegram.

### Ryzyko
Niskie. Najgorszy przypadek = za wysoki poziom dla lekkiej komendy → wolniejsza odpowiedź,
zero zmiany semantyki. Mapa in-memory nie przeżywa restartu — akceptowalne (degraduje do
stanu obecnego).

---

## P2 — Koordynacja budżetów: timeout dziecka ≤ pozostały budżet rodzica

### Root cause
`getDelegationTimeoutMsFor()` ([delegate-task.ts:1232-1253](../src/mastra/tools/system/delegate-task.ts))
zwraca stałe (240 s direct / 900 s filmmaker / 1200 s automation) — ślepe na budżet rodzica.
Rodzic `fast` (60 s) może zlecić dziecku 240 s pracy, która NIGDY nie wróci przed śmiercią
rodzica. Rodzic `critical` (300 s) + dziecko 240 s = margines zjedzony przez sam turn modelu
(zaobserwowane: meta padł na 300 s o 19:25:24, delegacja odbiła 240 s o 19:26:11 — **47 s po
śmierci rodzica**, wynik nie miał już do kogo wrócić).

Dodatkowo agent-board `designAgent` deklaruje `delegation: sync` + `latencyClass: long` —
sprzeczność, która zachęca metę do synchronicznej delegacji długiego zadania.

### Fix design
1. **Rejestr deadline'ów runów** — analogicznie do `setRunDepth`: w nowym module
   `src/mastra/services/run-budget.ts`: `setRunDeadline(threadId, deadlineTs)` /
   `getRemainingRunBudgetMs(threadId)`. `generateWithHarness` zapisuje na starcie
   (`Date.now() + effectiveTimeoutMs`, linia ~201), czyści w finally.
   Klucz: **threadId** — `delegateTaskTool` już dostaje `callerThreadId` w schemacie wejścia,
   więc lookup nie wymaga przewiercania runId przez Mastrę. (Iteracja 2: AsyncLocalStorage,
   gdyby model podawał zły `callerThreadId`.)
2. **Reguła w `withDelegationTimeout` / `generateWithAbortableTimeout`**
   ([delegate-task.ts:1262+](../src/mastra/tools/system/delegate-task.ts)):
   `effective = min(defaultForAgent, remainingParent − SAFETY_MARGIN_MS)` gdzie
   `SAFETY_MARGIN_MS = 20_000` (czas na przyjęcie wyniku + narrację + zapis).
3. **Bramka minimalnej wykonalności:** jeśli `effective < MIN_VIABLE_SYNC_MS` (proponuję
   60 s), sync delegacja jest z góry skazana → **automatyczne przełączenie na async**
   (`startAsyncDelegation` już istnieje i ma cały mechanizm doręczeń przez
   `pending_user_messages` → `checkPendingUpdatesTool`). Zwrotka do modelu:
   `"Sync budget insufficient (Xs left). Delegation started ASYNC as <delegationId> — result will arrive as a pending update."`
4. **Async-by-default dla `latencyClass: long`:** w ścieżce wyboru trybu delegacji — jeśli
   karta agenta (agent-board) ma `latencyClass: 'long'` i wywołujący nie wymusił sync,
   preferuj async (wzorzec już istnieje dla automationArchitect golden_path, WS-B, linia ~387).
   Plus korekta danych: karta `designAgent` w agent-board → `delegation: 'both'`.

### Flaga
`FEATURE_DELEGATION_BUDGET_COORDINATION` (default ON).

### Pliki
- `src/mastra/services/run-budget.ts` (nowy, ~40 linii).
- `src/mastra/services/generate-with-harness.ts` — zapis/czyszczenie deadline.
- `src/mastra/tools/system/delegate-task.ts` — effective timeout, bramka min-viable,
  auto-async, preferencja latencyClass.
- `src/mastra/config/agent-board.ts` — `designAgent.delegation: 'both'`.
- `src/mastra/config/harness-flags.ts` — flaga.
- `.env.example` — `DELEGATION_SYNC_SAFETY_MARGIN_MS`, `DELEGATION_MIN_VIABLE_SYNC_MS`.

### Weryfikacja
- Unit: rodzic z 90 s budżetu → delegacja direct dostaje ~70 s, nie 240 s.
- Unit: rodzic z 50 s budżetu → auto-async, natychmiastowa zwrotka z delegationId.
- Unit: brak wpisu w rejestrze (wywołanie spoza harness) → stare defaulty (bez regresji).
- Live: scenariusz Finnsson — `"Deleguj"` (po P1 → critical, 300 s) → design delegacja
  powinna pójść async i wrócić pending update'em.

### Ryzyko
Średnie-niskie. Auto-przełączenie na async zmienia kontrakt zwrotki (model dostaje
delegationId zamiast wyniku) — ale prompt mety już zna pending updates (`checkPendingUpdatesTool`
wywoływany nawykowo w każdej turze, potwierdzone w transkrypcie). Fallback na stare defaulty
gdy rejestr pusty = zerowa regresja dla wywołań spoza harnessu.

---

## P3 — Ratowanie pracy przy timeoucie delegacji

### Root cause
Timeout w `generateWithAbortableTimeout` abortuje dziecko (WS-A, słusznie — brak zombie),
ale wynik częściowy przepada. Researcher zebrał komplet danych i zginął tuż przed
`artifact_put`. Dane zostały WYŁĄCZNIE w `mastra_messages` wątku delegacji — rodzic nie ma
do nich żadnego uchwytu (envelope błędu: `"Delegation to researcherAgent timed out after 240s"`,
`artifacts: []`).

### Fix design
Dwa poziomy, od najtańszego:

1. **Uchwyt salvage w envelope błędu (tanie, duży zysk).** Przy timeoucie delegacji zwracaj
   w envelope: `salvage: { delegationThreadId, messagesCount, lastToolResults: <skrót 3 ostatnich
   wyników narzędzi, po ~500 znaków> }`. Do tego nowe narzędzie
   `delegationSalvageTool(threadId)` — czyta `mastra_messages` wątku delegacji, wyciąga
   wyniki tool-calli i teksty asystenta, zwraca skompresowany digest (limit ~4-6k tokenów).
   Meta może wtedy: (a) samodzielnie skompilować wynik z digestu, (b) przekazać digest jako
   kontekst ponownej delegacji — bez powtarzania scrapingu.
2. **Checkpoint-artefakty w konwencji workerów (systemowe).** Do briefu delegacji
   (`renderWorkerBriefWithArtifacts` w `worker-task-spec.ts`) dopisać stałą regułę:
   `"After each completed research/build phase, persist partial results via artifact_put
   (type: partial_<artifact_type>). Do NOT hold all results until the end."`
   Harness przy timeoucie dołącza do envelope listę artefaktów częściowych wyprodukowanych
   przez dziecko w tym runie (query po `producedBy` + oknie czasowym runu).

ŚWIADOMIE ODRZUCONE: „promote-to-background przy timeoucie" (nie abortować, pozwolić dziecku
skończyć w tle). Kusi, ale reintrodukuje zombie-runy, które WS-A właśnie wyeliminował —
dziecko bez limitu mutowałoby stan po tym, jak rodzic już zaraportował porażkę. Jeśli
delegacja ma żyć dłużej niż budżet rodzica, właściwą ścieżką jest **async od początku** (P2.3),
nie reanimacja po timeoucie.

### Flaga
`FEATURE_DELEGATION_TIMEOUT_SALVAGE` (default ON).

### Pliki
- `src/mastra/tools/system/delegate-task.ts` — salvage w envelope przy timeout.
- `src/mastra/tools/system/delegation-salvage.ts` (nowe narzędzie, rejestracja u mety).
- `src/mastra/tools/system/worker-task-spec.ts` — reguła checkpoint-artefaktów w briefie.
- `src/mastra/services/result-envelope.ts` — pole `salvage` w schemacie envelope.

### Weryfikacja
- Unit: symulowany timeout → envelope zawiera `salvage.delegationThreadId`.
- Unit: `delegationSalvageTool` na wątku `delegation-62aaf8a9-…` (żywe dane z awarii!)
  → digest zawiera godziny otwarcia, telefon, adres Finnssona.
- Live: przerwana delegacja → meta odzyskuje dane bez ponownego researchu.

### Ryzyko
Niskie. Salvage jest read-only. Checkpoint-artefakty zwiększają liczbę artefaktów
(sprzątanie: partial_* można TTL-ować później — poza zakresem).

---

## P4 — Poprawki narzędzi (drobne, każde zjadało kroki budżetu)

### P4a. `planTaskTool` — sztywny schemat wywala cały plan
**Objaw:** `steps[].expectedOutput: expected string, received undefined` → plan padł,
meta planował inline (stracony persisted plan przy poziomie `critical`).
**Fix:** w `planStepSchema` ([plan-task.ts:28](../src/mastra/tools/system/plan-task.ts)):
`expectedOutput: z.string().optional().default('')` — LLM-y notorycznie gubią to pole.
Alternatywnie pas naprawczy przed `planSchema.parse`: uzupełnij brakujące `expectedOutput`
z `intent`. Rekomendacja: **oba** (schemat leniency + backfill z intent, żeby GoalContract
dostawał niepuste kryteria).
**Weryfikacja:** unit z payloadem z awarii (3 kroki bez expectedOutput) → plan przechodzi.

### P4b. `firecrawl_extract` — 5× odrzucony schemat
**Objaw:** worker tracił kroki na próby-błędy formatu schematu (nested `additionalProperties`
niewspierane przez Firecrawl).
**Fix:** (1) sanitizer schematu w warstwie narzędzia: strip `additionalProperties`,
spłaszczenie `required` do formatu akceptowanego przez Firecrawl; (2) dopisek w description
narzędzia: `"Schema must be flat JSON Schema: object → properties → array/items. No additionalProperties."`
**Weryfikacja:** unit — schemat z awarii po sanityzacji przechodzi walidację Firecrawl.

### P4c. Tavily — 400 na query samo-`site:`
**Objaw:** `search_web {query:"site:finnssonbistro.is"}` → 400.
**Fix:** w warstwie narzędzia: jeśli query po usunięciu operatorów `site:` jest puste,
dodaj automatycznie nazwę domeny jako term (`site:x.is` → `site:x.is x`). Plus dopisek
w description.
**Weryfikacja:** unit na wywołaniu z awarii.

### P4d. `delegateTaskTool` z `args={}`
**Objaw:** przy `fast` (4000 tokenów kontekstu) model wyemitował pusty obiekt argumentów.
**Analiza:** to symptom P1 (za mały budżet na wielki inline-brief), nie samodzielny bug —
walidacja zadziałała poprawnie (odrzuciła + czytelny komunikat). 
**Fix (obrona w głąb):** wspieraj **brief-by-artifact**: nowe opcjonalne pole
`taskSpecArtifactId` — meta najpierw `artifact_put` z briefem, potem delegacja z samą
referencją (mały, stabilny payload argumentów). Duże briefy przestają być wrażliwe na
budżet tokenów tool-calla. Infrastruktura częściowo jest (`renderWorkerBriefWithArtifacts`).
**Weryfikacja:** live — delegacja design z briefem >3k tokenów przez artifact-ref.

---

## P5 — Mylący sygnał `depth_floor:deep` przy floor=0

### Root cause
[depth-controller.ts:329-337](../src/mastra/services/depth-controller.ts): `scoreFloor`
startuje z 0; gdy score po sygnałach ujemnych < 0 (np. `question_only` = −0.15), warunek
`scoreFloor > score` jest prawdziwy i loguje sygnał `depth_floor` z etykietą `'deep'` —
mimo że żadna podłoga nie zadziałała, to zwykły clamp do zera. W logach z awarii każde
„Jestes?" ma fałszywe `depth_floor:deep`.

### Fix
Emituj sygnał `depth_floor` tylko gdy `scoreFloor > 0`; clamp ujemnego score zostawić
istniejącej linii `Math.max(0, …)` bez sygnału (albo osobny sygnał `clamped_to_zero` bez
etykiety poziomu).

### Pliki / weryfikacja
`depth-controller.ts`, unit: `"Jestes?"` → signals bez `depth_floor`. Czysta kosmetyka
observability, zero wpływu na wynik klasyfikacji.

---

## P6 — Luka zdolności: menu w obrazkach (Wix PNG) — osobny mini-projekt

### Problem
Cały cennik steków Finnssona istnieje wyłącznie jako PNG-i na Wixie. Żaden scraper tekstowy
tego nie wyciągnie — researcher słusznie eskalował do TripAdvisora, ale to dane wtórne
i niepełne. To ograniczenie klasy zadań „zbierz dane z restauracyjnej strony" (typowe
w domenie gastro!), nie jednostkowy przypadek.

### Fix design (szkic — do osobnej wyceny)
Narzędzie `image_extract` dla researcherAgent: `(imageUrls[], prompt, schema?) → JSON`.
Implementacja: pobierz obraz → model wizyjny z manifestu (mamy `claude-opus-4.8` /
`gemini-2.5-flash` w fallbackach — oba z wizją; wybór przez `model-capabilities.ts`).
Wpiąć w PSEV: gdy strona ma < N znaków tekstu a > M obrazów treściowych, zasugeruj
`image_extract` w instrukcjach researchera.

### Zakres
NIE w tym samym PR co P1-P5. Szacunek: 1 narzędzie + prompt researchera + unit na
menu-PNG Finnssona (żywy fixture z awarii).

---

## P7 — Operacyjne domknięcie zadania Finnsson (bez czekania na P1-P6)

1. **Odzysk researchu:** dane z wątku `delegation-62aaf8a9-76ad-42c5-9e3e-d57566b85a6a`
   (`mastra_messages`) — pełne scrape'y main/menu/chrismas-menu/foodandfun + TripAdvisor
   (adres Kringlan 4-12 3. hæð, tel. +1 555 019 2834, godziny, Happy Hour 15-18, brunch
   12-16 wkd, 4.4/44 opinii, Chef Tom Cook / USDA Prime / A5 Wagyu). Skompilować ręcznie
   (lub skryptem jednorazowym) do artefaktu `research_report`.
2. **Delegacja do designAgent** z tym artefaktem jako kontekst (brief: styl „Neon-Umami",
   responsive mobile+desktop, samodzielny HTML inline CSS/JS) — najlepiej **async**.
3. **Dostawa:** `telegramSendFileTool` z plikiem HTML.
4. Braki cen steków (PNG) → zaznaczyć w briefie „ceny placeholder, do uzupełnienia po P6".

---

## Kolejność i wycena

| Krok | Zakres | Rozmiar | Ryzyko |
|---|---|---|---|
| P7 | odzysk + design + dostawa (operacyjne) | S | zerowe (nic w kodzie) |
| P1 | sticky depth | M | niskie |
| P2 | koordynacja budżetów + auto-async | M | średnie-niskie |
| P3 | salvage + checkpoint-artefakty | M | niskie |
| P4a-d | poprawki narzędzi | S×4 | niskie |
| P5 | kosmetyka sygnału | XS | zerowe |
| P6 | image_extract (VLM OCR) | M | osobny projekt |

Wszystkie zmiany runtime za flagami (`FEATURE_DEPTH_THREAD_INHERITANCE`,
`FEATURE_DELEGATION_BUDGET_COORDINATION`, `FEATURE_DELEGATION_TIMEOUT_SALVAGE`), default ON,
kill-switch przez env — konwencja jak `FEATURE_AUTOMATION_FINALIZE_ON_DELIVERABLE`.

Weryfikacja końcowa (E2E, po P1-P3): powtórka pełnego scenariusza przez Telegram —
brief → research (async lub sync z budżetem) → design (async) → plik HTML doręczony.
Kryterium: zero timeoutów rodzica, delegacja do designAgent **wykonana i zakończona**,
artefakt research_report istnieje w `artifacts`.
