# Code Review Agent & Self-Healing Workflow

Aktualizacja: 2026-05-08 | Status: **Etap 5 UKOŃCZONY** (E2E potwierdzone)

## Architektura

Workflow `repo-maintenance-workflow` realizuje pełny cykl Self-Healing:

```
[Input] → [codingAgent] → [codeReviewAgent] → [decision-gate]
                                                     │
                                    ┌────────────────┼────────────────┐
                                    │                │                │
                                 APPROVE        NEEDS_CHANGES      BLOCK
                                    │                │                │
                               [SUSPEND]        [codingAgent]      [STOP]
                                    │           poprawia kod
                              Human Resume          │
                                    │          [codeReviewAgent]
                               confirmMerge?    re-review
                                /        \          │
                             true        false   (max 3x)
                              │            │
                        [apply_patch]    [STOP]
                        [cleanup]
                              │
                    [deploy-and-verify]
                    (build + health check)
```

## Kroki Workflow

### Step 1: `execute-coding-agent`
- Generuje UUID dla zadania (lub przyjmuje przekazany).
- Instruuje `codingAgent` aby użył `coding.create_artifact` + `coding.init_worktree`.
- Agent pisze kod, puszcza linter/TSC w worktree.
- Workflow automatycznie uzupełnia `diffSummary` z `git diff HEAD` (backup).

### Step 2: `execute-review-agent`
- Ładuje `diffSummary` i `filesChanged` z MongoDB.
- Wkleja diff bezpośrednio do promptu recenzenta.
- `codeReviewAgent` może też samodzielnie użyć narzędzi worktree (patrz niżej).
- Odczytuje faktyczny `reviewVerdict` z MongoDB po wywołaniu `submitReviewTool`.

### Step 3: `decision-gate`
- **`approve`** → `suspend()` → czeka na `{ confirmMerge: true }` → `apply_patch` + `remove_worktree`
- **`needs_changes`** → pętla naprawcza (codingAgent poprawia, reviewer re-review, max 3 iteracje)
- **`block`** → natychmiastowy stop

### Step 4: `deploy-and-verify`
- Uruchamia się tylko jeśli decision-gate zakończył się `approved_and_merged`.
- Wywołuje `deploy-blue-green.sh --dry-run`.
- Synchronizuje kod do stagingu (bez `.git`), buduje aplikację.
- Uruchamia staging serwer, weryfikuje health-check, a następnie gasi instancję.
- Wyprowadza status `deployed_and_verified` (gotowy do produkcyjnego swapu) lub `deploy_failed`.

## Narzędzia Reviewera (Worktree)

| Narzędzie | ID | Opis |
|-----------|-----|------|
| Diff | `coding.worktree_diff` | Git diff z worktree (z obsługą untracked files) |
| Lista plików | `coding.list_worktree_files` | Listing katalogu (z filtrem .git/node_modules) |
| Odczyt pliku | `coding.read_worktree_file` | Czyta plik z worktree (limit 200KB, path traversal guard) |
| Werdykt | `coding.submit_review` | Zapisuje approve/needs_changes/block w Mongo |
| Artefakt | `getCodeTaskArtifactTool` | Metadane zadania (plan, status, itp.) |

## Aktualizacja P1 — strukturalny format review + agent bezpieczeństwa (2026-06-10)

W ramach planu `ideas/ruflo-mastra.md` (P1) wzbogacono warstwę review o jakość promptowania
zaadaptowaną z Ruflo (structured output, few-shot, checklisty, metodyki). **Konwencja językowa:**
prompty i skille są po angielsku; meta-agent odpowiada userowi po polsku.

### Strukturalny format werdyktu (`prompts/coding/review.md`)
`codeReviewAgent` zwraca teraz `summary` w sztywnym, parsowalnym formacie:

```
### ✅ Strengths
### 🔴 Critical (blocking)        →  [file:line] problem → impact → fix
### 🟡 Suggestions (non-blocking)
### 📊 Summary                    →  complexity / test coverage / risk
```

Reguła werdyktu: ≥1 punkt 🔴 → `needs_changes` (lub `block` przy ryzyku bezpieczeństwa/utraty danych);
brak 🔴 → `approve`. Prompt zawiera STRIDE-lite security checklist, performance checklist i few-shoty ❌/✅.

### Nowy `securityReviewAgent`
Dla zmian *security-complex* (auth, krypto, deserializacja, uprawnienia, granice zaufania)
`codeReviewAgent` deleguje do `securityReviewAgent`. To **cienki agent** — metodyka jest w
lazy-loaded skillach ładowanych przez `skill_load`, a nie wpisana w prompt (oszczędność tokenów):
- `_skills/security/stride-dread.md` — STRIDE × DREAD threat model + progi ryzyka.
- `_skills/security/owasp-code-review.md` — OWASP Top 10 z wzorcami ❌/✅.
- `_skills/security/dependency-vulnerability-scan.md` — supply chain.

Agent używa tych samych narzędzi worktree co reviewer + `skill_search`/`skill_load` + memory recall/write.
Zarejestrowany w `src/mastra/index.ts` obok `codeReviewAgent`.

### Skille metodyczne dla codingAgent
- `_skills/coding/sparc.md` — Specification → Pseudocode → Architecture → Refinement → Completion.
- `_skills/coding/tdd-london.md` — mockist/outside-in TDD.

`prompts/coding/base.md` dostał zwięzły TDD protocol + code-quality checklist (z odwołaniem do skilli),
a `prompts/meta/base.md` — wzorce dekompozycji zadań (Feature / Bug fix / Refactor).

## Aktualizacja P3 — triage ryzyka, agent wydajności, agregacja błędów (2026-06-10)

Trzy punkty (A/B/C) domykające transfer wartości z Ruflo.

### A — Skill `diff-risk-analysis` + skill_tools dla reviewera
Nowy skill `_skills/coding/diff-risk-analysis.md` daje reviewerowi szybki **triage ryzyka przed**
głęboką analizą: tabela sygnałów (auth, migracje DB, usunięta walidacja, `child_process`/`eval`,
hot-path, szerokość blast-radius) → uporządkowana lista hotspotów. Wpięty kontraktem w krok 2
procedury `review.md`. **Uwaga:** `codeReviewAgent` dostał teraz `skill_search`/`skill_load`
(wcześniej ich nie miał — odwołania do skilli w prompcie były martwe).

### B — `performanceReviewAgent` (bliźniak agenta bezpieczeństwa)
Samodzielny agent do głębokiej analizy wydajności, delegowany przez `codeReviewAgent` dla zmian
performance-krytycznych. Cienki prompt + lazy skill (jak securityReviewAgent):
- `_skills/coding/performance-profiling.md` — hot-path, złożoność, N+1/blocking I/O, alokacje/GC,
  indeksy DB; zasada *profile-before-optimize*, blokowanie tylko realnych regresji (nie mikro-opt).
- `prompts/coding/performance-review.md` — ten sam format werdyktu ✅/🔴/🟡/📊.
- `agents/performance-review-agent.ts` — te same narzędzia worktree + skille + memory; zarejestrowany w `index.ts`.

### C — Agregacja błędów wg typu
Gdy sekcja 🔴/🟡 ma >3 itemy, prompty grupują je nagłówkami typu (Security / Correctness /
Performance / Tests / Style) — wstecznie zgodne z parserem ✅/🔴/🟡/📊. Dotyczy `review.md`,
`security-review.md`, `performance-review.md`; w `subagent-qa.md` `issues` jest porządkowane wg
fazy weryfikacji (static → test → dynamic), pole `source` już typuje każdy problem.

> **Zasięg:** prompty są przypisane do swoich agentów; agent B jest samodzielny. Oba nowe skille
> (`diff-risk-analysis`, `performance-profiling`) są — jak wszystkie skille — widoczne dla każdego
> z agentów ze skill-toolami (coding, code-review, security-review, performance-review, meta,
> automation-architect, knowledge, researcher), a twardo wpięte tylko w reviewera.

## Pliki źródłowe

| Plik | Opis |
|------|------|
| `src/mastra/workflows/repo-maintenance.ts` | Workflow (3 kroki + suspend/resume) |
| `src/mastra/agents/code-review-agent.ts` | Agent recenzujący (5 narzędzi) |
| `src/mastra/agents/security-review-agent.ts` | Agent bezpieczeństwa (worktree + skill_load + memory) |
| `src/mastra/agents/performance-review-agent.ts` | Agent wydajności (worktree + skill_load + memory) |
| `src/mastra/prompts/coding/review.md` | Prompt review ze strukturalnym formatem ✅/🔴/🟡/📊 + triage + delegacje |
| `src/mastra/prompts/coding/security-review.md` | Prompt security review (lazy methodology) |
| `src/mastra/prompts/coding/performance-review.md` | Prompt performance review (lazy methodology) |
| `src/mastra/_skills/security/stride-dread.md` | Skill: STRIDE/DREAD threat model |
| `src/mastra/_skills/security/owasp-code-review.md` | Skill: OWASP Top 10 code review |
| `src/mastra/_skills/coding/diff-risk-analysis.md` | Skill: pre-review triage ryzyka diffa |
| `src/mastra/_skills/coding/performance-profiling.md` | Skill: metodyka analizy wydajności |
| `src/mastra/_skills/coding/sparc.md` | Skill: metodyka SPARC |
| `src/mastra/_skills/coding/tdd-london.md` | Skill: London School TDD |
| `src/mastra/tools/dev/code-task-artifacts.ts` | Artifact + submitReview |
| `src/mastra/tools/dev/code-worktree.ts` | Worktree + diff/list/read tools |

## Wyniki testu E2E (2026-05-08)

```
codingAgent  → stworzył plik w worktree            ✅ (13s)
reviewAgent  → użył worktree_diff → approve         ✅ (6s)
decision-gate → SUSPENDED                           🟡
human        → confirmMerge: true                   ✅
apply_patch  → commit zmergowany na master           ✅
cleanup      → worktree usunięty                    ✅
```

Commit: `8ac80d7 Scalenie zatwierdzonych zmian dla zadania 7b365329-...`
Plik `scratch/reviewer-tools-test.js` poprawnie wylądował w live repo.

## Testowanie z Mastra Studio

1. **Workflows → repo-maintenance-workflow → Run**
2. Input JSON:
```json
{
  "userRequest": "Opis zadania do wykonania..."
}
```
3. Gdy workflow się zawiesi (status: suspended), kliknij **Resume**:
```json
{
  "confirmMerge": true
}
```
