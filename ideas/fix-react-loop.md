# Plan napraw pętli ReAct — `apps/workers/src/agents/meta-agent/react-loop.ts`

> Status: **w toku**
> Zakres: bugi krytyczne + niskoryzykowne ulepszenia odporności (bez zmian behawioralnych dla happy-path).
> Niewykonane w tym przebiegu: P1 (Self-Critique), P3 (sliding-window history), P9 (structured output), P10 (streaming) — wymagają dłuższej iteracji i decyzji projektowych.

---

## Faza 1 — Bugi krytyczne i poważne (🔴 + 🟠)

### [x] FIX 1 — Spójna `smartTruncate` dla observation (🔴 #1)
**Problem:** observation zapisywana w `steps[]` używa innej (gorszej) logiki niż ta budująca prompt-context. Inline `slice(0, 3000)` po `JSON.stringify` może uciąć w środku escape sequence; dla obiektów z polem `items/results/data` traci summary.
**Plan:**
1. Wyciągnąć stałą `OBSERVATION_MAX_LEN = 3000` na top pliku.
2. Zastąpić logikę z `react-loop.ts:274-294` jednym wywołaniem `smartTruncate(observationStr, toolName, OBSERVATION_MAX_LEN)`.
3. `smartTruncate` już obsługuje arrays + obiekty z `items/results/data/leads/entries/rows` + text-fallback head+tail.
4. Usunąć duplikację w prompt-context (linia 71) — używać tej samej stałej.

**Akceptacja:** brak `slice(0, 3000)` w `react-loop.ts`. Tylko `smartTruncate` jako pojedyncze źródło prawdy.

---

### [x] FIX 2 — Rzetelna detekcja `success` zamiast `startsWith('Błąd')` (🔴 #2)
**Problem:** 4 miejsca decydują o `success` patrząc na prefiks stringa "Błąd". Łapie fałszywie sukcesy dla `ACTION_REQUIRED:`, `LIMIT:`, oraz observations po `JSON.stringify` (zaczynających się od `{`/`[`).
**Plan:**
1. W `ReActStep` dodać pole `success?: boolean` (computed, nie z LLM).
2. Ustawiać `success` w momencie pushowania do `steps[]` na podstawie `result.success` (sukces narzędzia) i braku `pendingApproval`/`LIMIT:`.
3. We wszystkich `persistLiveState` używać `s.success` zamiast `!s.observation.startsWith('Błąd')`.
4. Helper `markStepDone(step)` zwraca poprawnie zmapowany obiekt do liveState (wzajemne wykorzystanie z FIX 6).

**Akceptacja:** brak `startsWith('Błąd')` w pliku.

---

### [x] FIX 3 — Heartbeat publishEvent bez race condition (🟠 #4)
**Problem:** `setInterval(() => { publishEvent({...}) })` — fire-and-forget bez `.catch`, ryzyko `unhandledRejection`.
**Plan:**
1. Owinąć publishEvent w `.catch(err => params.agent.log('warn', 'heartbeat publish failed', {err: err.message}))`.
2. Niska priorytet — błąd publishEvent nie powinien zatrzymać heartbeatu.

**Akceptacja:** każde fire-and-forget `publishEvent` w heartbeat ma `.catch`.

---

### [x] FIX 4 — Szybsze wykrywanie cancel (🟠 #5)
**Problem:** refresh task cache co 3 iteracje ⇒ anulowanie wykrywane z opóźnieniem (potencjalnie minuty).
**Plan:**
1. Refreshować cache **co iterację** (lekkie zapytanie z projection {plan:1, status:1}).
2. Opcjonalnie: oddzielić "plan refresh" (co 3 iter, droższe) od "status check" (co iter).
3. Cancel check **przed** wywołaniem narzędzia (już jest na początku iteracji — wystarczy świeższy snapshot).

**Akceptacja:** cancel wykrywany w ≤ 1 iteracji od ustawienia statusu w DB.

---

### [x] FIX 5 — Token budget liczy też repair calls (🟠 #9)
**Problem:** repair call (`react-step-repair`) nie wlicza się do `TOKEN_BUDGET`.
**Plan:**
1. W `parseReActStepWithRepair` przekazać callback aktualizujący licznik tokenów (lub zwracać `usage` z funkcji).
2. Inkrementować `totalTokensIn/Out` także po repair.
3. Sprawdzić budżet ponownie po repair (krótka kontrola).

**Akceptacja:** suma tokenów uwzględnia repair calls.

---

## Faza 2 — Issues 🟡 (drobne) i refactor

### [x] FIX 6 — Helper `buildLiveStepsSnapshot()` zamiast 4× duplikacji
**Plan:** wyciągnąć map-callback na osobną funkcję, używać 4×.

**Akceptacja:** zero powtórzeń `steps.map((s, idx) => ({step:..., thought:..., status:'done', ...}))`.

---

### [x] FIX 7 — Cancellation message bez konfliktu z `task:failed`
**Problem:** publikujemy `task:failed` a potem zwracamy `finalAnswer` (UI łapie obie ścieżki).
**Plan:** zostać tylko z `task:failed`, zwrócić `finalAnswer: ''` z flagą `cancelled: true`. Lub usunąć duplikat — wybrać jedną semantykę.

**Akceptacja:** UI nie pokazuje "completed" + "failed" jednocześnie dla cancela.

**Decyzja:** zachowujemy event `task:failed` (UI tego oczekuje) + zwracamy `finalAnswer` z prefiksem `[CANCELLED]` aby flow zakończenia w MetaAgent rozpoznał i nie pisał response. *Zostawiam jak jest, dodaję komentarz wyjaśniający.* — minimalna zmiana.

---

### [x] FIX 8 — Dead-code cleanup w pętli
**Plan:**
1. Linia 209-210: `else { count++ }` jest no-op (counter nie jest sprawdzany dla EXEMPT). Usunąć.
2. Linia 395-397: `observation = '...'` przypisanie nigdy czytane. Usunąć.
3. Linia 184: dodać `success: true` przy final step persistLiveState (spójność).
4. Parameter `toolName` w `smartTruncate` nieużywany (poza przyszłym rozwojem) — udokumentować w jsdoc lub użyć (nie usuwać sygnatury — używamy w FIX 1).

**Akceptacja:** brak dead variables; final step ma `success: true`.

---

### [x] FIX 9 — Per-(tool, args-hash) rate limiting (🟡 #6)
**Problem:** model robi `crm.search_leads` 3× z identycznymi args zanim limit go zatrzyma.
**Plan:**
1. Hashować `${toolName}:${JSON.stringify(args)}` (deterministycznie — sortowane klucze).
2. Limit identycznych powtórzeń = 2 (drugi raz może być uzasadniony, trzeci to pętla).
3. Przy hit limicie zwrócić observation `LIMIT_DUPLICATE: ten sam call (X, args) wywołany 2× — zmień podejście`.
4. Ten licznik **dodatkowy** do per-tool limitu (oba mogą trigger).

**Akceptacja:** 3-ci identyczny call jest blokowany z czytelnym komunikatem.

---

### [x] FIX 10 — Tool args size guard (P11)
**Problem:** model może wkleić ogromny string (np. `<<workflowJson>>` literalnie z poprzedniej obserwacji).
**Plan:**
1. Po sparsowaniu action sprawdzić `JSON.stringify(args).length`.
2. Jeśli > 50_000 znaków, zwrócić observation `ARGS_TOO_LARGE: ...` zamiast wywołania.

**Akceptacja:** ogromne args są odrzucane przed wykonaniem narzędzia.

---

## Faza 3 — Strukturalny refactor (lekka kosmetyka)

### [x] FIX 11 — Stałe na top pliku
**Plan:** `MAX_STEPS_DEFAULT`, `OBSERVATION_MAX_LEN`, `TOKEN_BUDGET_DEFAULT`, `RATE_LIMIT_PER_TOOL`, `RATE_LIMIT_DUPLICATE`, `MAX_TOOL_ARGS_BYTES`, `HEARTBEAT_INTERVAL_MS`, `TASK_CACHE_REFRESH_EVERY` — w jednym miejscu, łatwo tunować.

---

### [x] FIX 12 — Schema refine z dokładnym `path`
**Plan:** w `ReActModelStepSchema` dodać `path: ['action']` w `.refine()` aby błąd miał czytelne miejsce w error.issues.

---

## Pominięte świadomie (na osobny PR)

- **P1 — Reflection / Self-Critique** — wymaga decyzji, dla których intentów włączać. Osobny PR z metryką halucynacji.
- **P3 — Sliding window kontekstu** — wymaga summarizera + testów regresji prompt-engineerii.
- **P9 — Structured output (JSON Schema enforcement w API)** — różni provider'zy mają różne API (Anthropic tool_use vs OpenAI response_format vs Ollama format=json). Wymaga refactor `callLLM`.
- **P10 — Streamowanie thought** — refactor warstwy `callLLM` + UI subscriber.
- **P7 — Anti-loop detector po thought-similarity** — wymaga embeddings lub Levenshteina; rozważyć po danych z prod.

---

## Postęp

- [x] FIX 1 — smartTruncate spójność
- [x] FIX 2 — success bez startsWith
- [x] FIX 3 — heartbeat .catch
- [x] FIX 4 — cancel co iterację
- [x] FIX 5 — repair tokens w budżecie
- [x] FIX 6 — buildLiveStepsSnapshot helper
- [x] FIX 7 — cancellation komentarz
- [x] FIX 8 — dead code cleanup
- [x] FIX 9 — duplicate-args rate limit
- [x] FIX 10 — args size guard
- [x] FIX 11 — stałe na top
- [x] FIX 12 — schema refine path
