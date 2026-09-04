# Ruflo → Mastra: Plan Ulepszeń (wersja po audycie)

> **Rewizja:** 2026-06-10. Plan przepriorytetyzowany na podstawie audytu kodu obu repo (`_external/ruflo/` vs `src/mastra/`).
> **Zmiana tezy:** Pierwotny plan proponował port 5 modułów infrastruktury. Audyt wykazał, że **~60% tej infrastruktury już istnieje w Mastrze — czasem zrobione lepiej niż w Ruflo.** Prawdziwa wartość Ruflo to **treść promptów, skille i metodyki**, nie szkielet.
> **Źródło:** `_external/ruflo/`

---

## 0. Teza strategiczna (czytaj najpierw)

**To, jak `.claude/` "spina się z kodem" w Ruflo, to NIE jest ich wynalazek — to natywny mechanizm Claude Code.** Ruflo nie ma własnego loadera:
- Claude Code natywnie czyta `.claude/settings.json`, `agents/*.md`, `skills/SKILL.md`, `hooks.json`.
- Hooki robią `exec` na `ruflo-hook.sh` → CLI `ruflo` → TypeScriptowy `HookExecutor`.
- Cały system jest **advisory** (`exit 0`, nigdy nie blokuje toola) i **przywiązany do Claude Code + modeli Claude**.

**Mastra ma już model-agnostyczny odpowiednik tego mechanizmu: `generate-with-harness.ts`.** Pre/post fazy, `depth-controller`, `strategy-reflector`, `semantic-memory-worker`, output processors — to to samo co hooki Claude Code, ale in-process i działające z Ollamą / Gemini / OpenAI.

**Wniosek operacyjny:**
1. **NIE replikuj `.claude/`** — podważyłoby to multi-model przewagę Mastry. Harness już jest tym mechanizmem.
2. **Pożyczaj WIEDZĘ (prompty, skille, checklisty), nie SZKIELET.**
3. **Zasada budżetu tokenów:** prompty Ruflo mają 255–1233 linie i są naszpikowane idiomami `npx claude-flow` / `mcp__claude-flow__*`. Port 1:1 = (a) rozwalony budżet kontekstu modeli lokalnych, (b) halucynowane wywołania nieistniejących toolów. **Wyłuskuj metodykę do lazy-loadowanych `_skills/*.md`; bazowe prompty trzymaj lean.** Mastra ma już do tego lepszy system niż Ruflo (96 skilli z embeddingami + lazy-load + feedback `success_rate`).

---

## 1. Mapa pokrycia — co już masz vs co proponował stary plan

| Stara faza | Propozycja | Stan w Mastrze | Werdykt |
|---|---|---|---|
| **1. ReasoningBank** | nowy store wzorców + embeddings | `system_knowledge` (12 typów wiedzy, bge-m3, TTL, recall) + `semantic-memory-worker` + `memory-extractor` | **redundantne ~80%** |
| **2. Periodic Workers** | timer framework + alerty | tylko *one-shot* `background-task-manager`; brak cyklicznych | **realna luka → P2** |
| **3. Plugin System** | interfejs plugin + interceptory | feature-flagi + input/output processors + `onStepFinish`; brak czystego pre/post-tool-call | **częściowa luka → opcjonalne P4** |
| **4. Agent Pool** | per-agent metryki + load balancing | `smart-router` (VRAM/cost/latency) + `dashboard-stats` (per-agent success EMA) | **redundantne → pomiń** |
| **5. Prompt Enhancement** | wzbogacić prompty | prompty świadomie lean (review 56 lin., coding 139 lin.) | **najwyższy ROI → P1** |
| **6. Hive-Mind / GOAP / Queen** | A* planner, dyrektywy królowej | depth-controller + strategy-reflector + goal-contracts = już OODA | **spekulatywne → deprioryzuj** |

---

## 2. Weryfikacja kodu Ruflo (SOLID / PARTIAL / SCAFFOLD)

Zanim cokolwiek portujesz — co jest realne, a co atrapą:

| Plik Ruflo | Klasyfikacja | Dowód | Werdykt portu |
|---|---|---|---|
| `v3/@claude-flow/hooks/src/workers/index.ts` | **SOLID** | realne `setInterval`, `os.freemem`/`fs.statfs`/`git`, ring buffer, progi, persystencja JSON, zero deps | **bierz framework (P2)** |
| `v3/@claude-flow/neural/src/pattern-learner.ts` | **SOLID** | prawdziwy k-means (Lloyd), EMA, cosine, zero deps | idea opcjonalnie (dedupe `system_knowledge`) |
| `v3/src/infrastructure/plugins/PluginManager.ts` | **SOLID** | semver, dependency graph, priority dispatch, 277 lin., zero deps | opcjonalne (P4) |
| `v3/@claude-flow/hooks/src/reasoningbank/index.ts` | **PARTIAL** | logika OK, ale bez `@claude-flow/memory` fallback do `Map` z **hash-embeddingiem `Math.sin`** (semantycznie bezwartościowym) | **pomiń — masz lepsze** |
| `v3/src/coordination/.../SwarmCoordinator.ts` | **PARTIAL** | consensus = potwierdzony `Math.random() > 0.5`; load-balance realny ale robi to `smart-router` | pomiń |
| `neural/` (DQN/PPO/SONA/flash-attention) | realne, ale uproszczone; "flash attention" = CPU-approx z niezweryfikowanymi claimami | — | pomiń |

---

## <a name="p1"></a>P1 — Prompt + Skill Content (najwyższy ROI) — ✅ DONE (2026-06-10)

> **Status:** zaimplementowane. Wszystkie prompty i skille napisane **po angielsku**
> (konwencja: całe narzędzie po angielsku; tylko meta-agent odpowiada userowi po polsku).
> `verification-scoring.md` **pominięty** — pokrywa go istniejący `_skills/coding/run-verification.md`.

### Cel
Przenieść *jakość promptowania* Ruflo (structured output, few-shot, checklisty, metodyki) do Mastry — **jako lean prompt + lazy `_skills/`**, z wyciętymi idiomami claude-flow.

### Luka jakościowa (zweryfikowana)

| Agent | Mastra | Ruflo | Czego brakuje |
|---|---:|---:|---|
| Coder | 139 lin. | `coder.md` 255 lin. | TDD protocol, ❌/✅ few-shot, ADR-first |
| Reviewer | 56 lin. | `reviewer.md` 310 lin. | **format ✅/🔴/🟡/📊**, few-shot, security+perf checklisty |
| Security | ❌ brak | `security-architect.md` 868 lin. | STRIDE/DREAD, zero-trust |
| Performance | ❌ brak | `performance-engineer.md` 1233 lin. | profiling, N+1, latency targets |

### Zadania

**1.1 [✅ DONE] Przepisz `prompts/coding/review.md`** na strukturalny format (niski koszt, natychmiastowy zysk w jakości i *parsowalności*):

```markdown
## Format wyjścia (OBOWIĄZKOWY)
### ✅ Mocne strony
### 🔴 Krytyczne (blokujące) — opis + wpływ + sugerowany fix
### 🟡 Sugestie (nieblokujące)
### 📊 Podsumowanie — złożoność, pokrycie testami, poziom ryzyka

## Security checklist (STRIDE-lite)
- [ ] walidacja inputu z zewnątrz
- [ ] brak hardcoded secrets
- [ ] parametryzowane zapytania (no string interpolation)
- [ ] output encoding (XSS)
- [ ] authz/authn obecne
- [ ] brak wrażliwych danych w logach

## Performance checklist
- [ ] brak N+1, [ ] cache hot-paths, [ ] async zrównoleglony, [ ] brak blokad w hot-path
```
+ dodaj 2–3 few-shoty `// ❌ złe` vs `// ✅ dobre`.

**1.2 [✅ DONE] Nowe agenty jako CIENKI prompt + lazy skill** (NIE 868/1233-liniowy prompt):
- `agents/security-review-agent.ts` (45 lin.) + `prompts/coding/security-review.md` — metodyka STRIDE/DREAD + OWASP w skillach, ładowana on-demand przez `skill_load`. Zarejestrowany w `index.ts`.
- `agents/performance-review-agent.ts` + `prompts/coding/performance-review.md` — performance review analogicznie. **✅ DONE (2026-06-10, punkt B poniżej).**

**1.3 [✅ DONE] Port metodyk do `_skills/` (treść, nie system — Twój system jest lepszy):**

| Nowy plik | Bazuje na (Ruflo) | Cel | Status |
|---|---|---|---|
| `_skills/coding/sparc.md` | `sparc-methodology/SKILL.md` | Spec→Pseudo→Arch→Refine→Complete | ✅ |
| `_skills/coding/tdd-london.md` | `agent-tdd-london-swarm` | mock-driven TDD, TypeScript | ✅ |
| `_skills/security/owasp-code-review.md` | `security-audit/SKILL.md` | actionable OWASP Top 10 | ✅ |
| `_skills/security/stride-dread.md` | `security-architect.md` | STRIDE × DREAD threat model | ✅ |
| ~~`_skills/meta/verification-scoring.md`~~ | `verification-quality/SKILL.md` | — | ⏭️ pominięte (pokrywa `run-verification.md`) |

**1.4 [✅ DONE] Wzbogać `meta-agent` o task decomposition** (Feature / Bug Fix / Refactor) — dodane w `prompts/meta/base.md`; TDD protocol + code-quality checklist dodane w `prompts/coding/base.md`.

### ⚠️ Warunek konieczny przy każdym porcie
Wytnij **wszystkie** `npx claude-flow ...` i `mcp__claude-flow__memory_usage` → przetłumacz na realne tooly Mastry: `memoryWriteTool` / `memoryRecallTool`, `skill_load`, worktrees, `bg_task`. Inaczej agent zacznie halucynować.

---

## <a name="p2"></a>P2 — Periodic Worker Manager (realna luka infra) — ✅ DONE (2026-06-10)

> **Status:** zaimplementowane. `services/periodic-worker-manager.ts` (framework + 5 wbudowanych
> workerów), nowe event types (`worker_run_started/completed/failed`, `worker_alert`),
> kolekcja `worker_metrics` (TTL 7 dni), `startAll()` w `index.ts`, endpoint
> `GET /deploy/workers-status` (prefix `/api` jest zarezerwowany przez Mastrę).
> Smoke test: 5 workerów zarejestrowanych, `health` zwraca `healthy` z realnymi metrykami.

### Cel
Cykliczne workery tła do health-monitoringu, konsolidacji pamięci i czyszczenia cache. Mastra ma tylko *one-shot* `background-task-manager` — brak timerów.

### Źródło
`v3/@claude-flow/hooks/src/workers/index.ts` — **SOLID** (realne timery, ring buffer, progi, persystencja, zero deps). Bierzemy **framework**, nie konkretne workery ADR/DDD.

### `src/mastra/services/periodic-worker-manager.ts` (~250 lin.)

```typescript
export interface PeriodicWorker {
  id: string; name: string; intervalMs: number; enabled: boolean;
  handler: () => Promise<WorkerResult>;
}
export interface WorkerResult {
  status: 'healthy' | 'warning' | 'critical';
  metrics: Record<string, number | string>; message?: string;
}
export function registerWorker(w: PeriodicWorker): void;
export function startAll(): void;   // wywołaj w index.ts przy starcie
export function stopAll(): void;
export function getWorkerStatus(): WorkerState[];
```

### Wbudowane workery (podpięte pod TO, CO JUŻ MASZ)

| Worker | Interwał | Co robi | Wykorzystuje istniejące |
|---|:--:|---|---|
| `health` | 5 min | RAM/disk/uptime | `gpu-guard.ts` |
| `models` | 10 min | dostępność Ollamy | `model-availability.ts` |
| `cache` | 1 h | sprzątanie `agent_events`, `background_tasks` | `cleanupBackgroundTasks()` |
| `telemetry` | 30 min | agregacja metryk | `dashboard-stats.ts` → `worker_metrics` |
| `memory` | 15 min | konsolidacja/dedupe `system_knowledge` | `memory-extractor.ts` (+ opcjonalnie k-means z `pattern-learner`) |

### Alerty
```typescript
const ALERT_THRESHOLDS = {
  ramUsagePercent:  { warn: 80, critical: 95 },
  diskUsagePercent: { warn: 85, critical: 95 },
  errorRate1h:      { warn: 0.3, critical: 0.5 },
};
// breach → logHarnessEvent + console.warn; dashboard czyta worker_metrics
```

### Integracja
- `startAll()` w `src/mastra/index.ts`. ✅
- Endpoint `GET /deploy/workers-status` (zmiana z `/api/workers/status` — `/api` zarezerwowane przez Mastrę). ✅
- Nowe event types w `harness-events.ts` + `agent-event-log.ts`; nowa kolekcja `worker_metrics` z indeksami i TTL w `lib/mongo.ts`. ✅

---

## <a name="abc"></a>A/B/C — Rozszerzenia po debacie (wysoki ROI z Ruflo) — ✅ DONE (2026-06-10)

Trzy punkty wybrane w debacie jako najlepszy pozostały transfer wartości (pominięto swarm/HNSW/ReasoningBank/witness/mikro-opt). Szczegóły w `docs/CODE-REVIEW-WORKFLOW.md` (sekcja P3).

**A — Skill `diff-risk-analysis` + skill_tools dla reviewera. ✅**
- `_skills/coding/diff-risk-analysis.md` — pre-review triage ryzyka (auth, migracje DB, usunięta walidacja, exec/eval, hot-path, blast-radius) → lista hotspotów.
- Wpięty w krok 2 procedury `prompts/coding/review.md`. `codeReviewAgent` dostał `skill_search`/`skill_load` (wcześniej ich nie miał).

**B — `performanceReviewAgent` (bliźniak security-review). ✅**
- `_skills/coding/performance-profiling.md` (lazy) + `prompts/coding/performance-review.md` (cienki) + `agents/performance-review-agent.ts` (zarejestrowany w `index.ts`).
- Format werdyktu ✅/🔴/🟡/📊; zasada profile-before-optimize, blokowanie tylko realnych regresji.

**C — Agregacja błędów wg typu. ✅**
- `review.md` / `security-review.md` / `performance-review.md`: gdy 🔴/🟡 ma >3 itemy → grupowanie nagłówkami typu (wstecznie zgodne z parserem).
- `subagent-qa.md`: `issues` porządkowane wg fazy weryfikacji (static → test → dynamic).

Weryfikacja: `tsc --noEmit` czysty; smoke test — oba skille embedują się i wygrywają semantic search dla swoich zapytań (diff-risk 0.48 / perf 0.65), agent się ładuje.

---

## <a name="p3"></a>P3 (opcjonalne) — Pre-task guidance injection

> **Uwaga:** NIE budujemy nowego store'u i NIE włączamy `semanticRecall` (świadomie off — warstwowa pamięć wystarcza). `system_knowledge` + `memoryRecallTool` (bge-m3) to już Twój ReasoningBank, bogatszy niż płaski reasoningbank Ruflo.

### Jedyny realny brak vs Ruflo
Proaktywne wstrzyknięcie top-K wzorców do promptu **przed** taskiem (odpowiednik `formatGuidancePrompt`), zamiast czekać aż agent sam wywoła recall.

### Minimalne zadanie
W `generate-with-harness.ts`, w fazie precontext: opcjonalnie odpytaj `system_knowledge` po `bge-m3` dla danego `phase/domain`, sformatuj top-3 jako krótki blok "🧠 Sprawdzone wzorce" i dołącz do `contextMarkdown`. Feature-flagą, domyślnie off. **Jeśli uznasz że zbędne — pomiń; P1+P2 niosą ~80% wartości.**

---

## <a name="p4"></a>P4 (opcjonalne) — Plugin / Interceptor layer

### Cel
Czyste `pre-tool-call` / `post-tool-call` interceptory (np. auto-memory po `write_file`), których harness teraz nie ma w czystej formie.

### Źródło
`v3/src/infrastructure/plugins/PluginManager.ts` (**SOLID**, 277 lin., zero deps).

### `src/mastra/services/plugin-system.ts` (~200 lin.)
```typescript
export type PluginHookPoint =
  | 'pre-generate' | 'post-generate'
  | 'pre-tool-call' | 'post-tool-call'   // brakujące punkty
  | 'worker-tick' | 'agent-error';

export interface MastraPlugin {
  id: string; name: string; version: string; dependencies?: string[];
  initialize(cfg?: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void>;
  getHooks(): PluginHook[];
}
```
Wzorcowy plugin: `gpu-guard-plugin` (`pre-generate` → snapshot VRAM, ewentualnie `forceCloud`). Integracja: `pluginManager.invokeHook('pre-generate', ctx)` na początku `generateWithHarness()`.

**Priorytet niski** — rób tylko, jeśli realnie potrzebujesz interceptorów tool-call.

---

## <a name="pomijamy"></a>Czego NIE robimy (i dlaczego)

| Element | Powód |
|---|---|
| **Port ReasoningBank (stara Faza 1)** | `system_knowledge` jest bogatszy; reasoningbank Ruflo i tak fallbackuje do hash-embeddingu |
| **Agent Pool (stara Faza 4)** | `smart-router` + `dashboard-stats` już robią routing i per-agent metryki |
| **Hive-Mind / GOAP / Queen (stara Faza 6)** | depth-controller + strategy-reflector + goal-contracts = już OODA/replanowanie; GOAP A* = spekulacja bez jasnego zysku |
| **Neural RL (DQN/PPO/SARSA/A2C)** | research, wymaga treningu GPU |
| **flash-attention.ts** | CPU-approx, claimy niezweryfikowane |
| **SONA / EWC / MoE Router** | pod spodem EMA + heurystyki; `smart-router` + `system_knowledge` prościej |
| **Swarm consensus** | `Math.random() > 0.5` — atrapa |
| **Federation, 34 domenowe pluginy** | irrelewantne (trading, IoT, JuJutsu, Arena) |
| **Kopiowanie `.claude/` 1:1** | związane z Claude Code; podważa multi-model przewagę. Harness już jest tym mechanizmem |

---

## Nowe / modyfikowane pliki (po rewizji)

### Tworzone
| Plik | Priorytet | Status |
|---|:--:|:--:|
| `prompts/coding/review.md` (przepisany) | P1 | ✅ |
| `prompts/coding/security-review.md` (nowy) | P1 | ✅ |
| `_skills/security/stride-dread.md` | P1 | ✅ |
| `_skills/coding/sparc.md` | P1 | ✅ |
| `_skills/coding/tdd-london.md` | P1 | ✅ |
| `_skills/security/owasp-code-review.md` | P1 | ✅ |
| ~~`_skills/meta/verification-scoring.md`~~ | P1 | ⏭️ pominięte |
| `agents/security-review-agent.ts` | P1 | ✅ |
| `services/periodic-worker-manager.ts` | P2 | ✅ |
| `services/plugin-system.ts` | P4 (opc.) | ⬜ |

### Modyfikowane
| Plik | Priorytet | Zmiana |
|---|:--:|---|
| `prompts/coding/base.md` | P1 | ✅ TDD protocol + code quality checklist + EN cleanup |
| `prompts/meta/base.md` | P1 | ✅ task decomposition (Feature/Bug/Refactor) |
| `src/mastra/index.ts` | P1 | ✅ rejestracja `securityReviewAgent` |
| `services/harness-events.ts` + `lib/agent-event-log.ts` | P2 | ✅ nowe event types `worker_*` |
| `lib/mongo.ts` | P2 | ✅ indeksy + TTL kolekcji `worker_metrics` |
| `src/mastra/index.ts` | P2 | ✅ `startAll()` + endpoint `/deploy/workers-status` |
| `services/dashboard-stats.ts` | P2 | ⬜ (opcjonalne) czytanie `worker_metrics` do dashboardu |
| `services/generate-with-harness.ts` | P3 (opc.) | pre-task guidance injection (flagą, off) |

### Nowe kolekcje MongoDB
| Kolekcja | Priorytet |
|---|:--:|
| `worker_metrics` | P2 |

---

## Harmonogram (po rewizji)

```
P1 (Prompty + Skille)     ── ✅ DONE (2026-06-10)
P2 (Periodic Workers)     ── ✅ DONE (2026-06-10)
P3 (Guidance injection)   ── 2 dni    (opcjonalne)  ← następne (jeśli w ogóle)
P4 (Plugin interceptors)  ── 3 dni    (opcjonalne, tylko jeśli potrzebne)
```

Stare Fazy 1, 4, 6 — **usunięte z planu** (redundantne lub spekulatywne; uzasadnienie w sekcjach 1–2 i "Czego NIE robimy").

---

## Referencje — pliki Ruflo do studiowania

| Cel | Plik |
|---|---|
| Format review, few-shot | `plugin/agents/core/reviewer.md` |
| TDD + ADR-first | `plugin/agents/core/coder.md` |
| STRIDE/DREAD | `plugins/.../security-architect.md` |
| Worker framework (SOLID) | `v3/@claude-flow/hooks/src/workers/index.ts` |
| Plugin lifecycle (SOLID) | `v3/src/infrastructure/plugins/PluginManager.ts` |
| k-means/EMA (idea dedupe) | `v3/@claude-flow/neural/src/pattern-learner.ts` |
| SPARC | `plugin/skills/sparc-methodology/SKILL.md` |
| Truth scoring | `.agents/skills/verification-quality/SKILL.md` |
