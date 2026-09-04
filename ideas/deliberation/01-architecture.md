# Deliberation Agent — Design Document

> **Status:** Draft v1.0 · **Data:** 2026-05-16 · **Autor:** Patryk + Antigravity

---

## 1. Problem Statement

Meta-agent planuje złożone zadania sam w jednej pętli LLM. Prowadzi to do:
- Powierzchownych planów bez rozważenia alternatyw
- Braku krytyki i kontrargumentów
- Pominięcia edge-case'ów, ryzyk bezpieczeństwa, kosztów
- Braku artefaktów dokumentujących decyzje

## 2. Rozwiązanie

Nowy agent domenowy `deliberationAgent` — kontrolowana debata między wyspecjalizowanymi workerami LLM. Nie "agent kreatywności", lecz **Design Council**: wytwarzanie lepszych decyzji projektowych przez kontrolowany konflikt perspektyw.

### Kluczowe decyzje architektoniczne

| Decyzja | Wybór | Uzasadnienie |
|---------|-------|-------------|
| Subagenci jako workery vs agenty | **Workery** (`run_worker`) | Brak narzędzi, brak memory, brak state — pure text-in/text-out |
| Liczba perspektyw | **6** (nie 9) | Po 6 perspektywach wartość spada, szum rośnie |
| Krytyka krzyżowa | **Warunkowa** | Tylko gdy pozycje się sprzeczne lub risk ≥ medium |
| Artefakty | **Obowiązkowe na dysku** | Audit trail + pamięć systemu |
| Ewaluacja | **Od dnia 1** | Bez ewaluacji nie wiadomo czy debata jest lepsza niż single-pass |

## 3. Architektura

```
metaAgent
  └─► delegateTask(targetAgent: "deliberationAgent", taskDescription: ...)
        └─► deliberationAgent (prawdziwy Mastra Agent z narzędziami)
              ├── run_worker("systemsArchitect", brief, reasoning)
              ├── run_worker("llmEngineer", brief, reasoning)
              ├── run_worker("creativeStrategist", brief, default)
              ├── run_worker("memoryArchitect", brief, default)
              ├── run_worker("redTeamCritic", brief, cloud)
              └── run_worker("synthesisPlanner", collected_positions, default)
```

### Narzędzia deliberationAgent

```
Zawsze w prompt context:
  - runWorkerTool          — spawn workerów z perspektywami
  - writeDebateArtifact    — zapis notatek/planów na dysk (NOWE)
  - memoryRecallTool       — odczyt wcześniejszych debat/decyzji
  - memoryWriteTool        — zapis nowych decyzji do pamięci
  - currentTimeTool        — timestampy w artefaktach
  - requestApprovalTool    — gate dla ryzykownych rekomendacji
```

## 4. Worker Perspectives (6 ról)

### 4.1 `systemsArchitect`
- **Cel:** Zamienia chaotyczny pomysł w architekturę systemową
- **Perspektywa:** Agent vs workflow vs tool? Granice odpowiedzialności? Zależności? Sync vs async?
- **Patrzy na:** Istniejące komponenty w Mastra Environment, DAG, moduły
- **Model:** `reasoning` preset
- **Zakaz:** Nie projektuje copy, nie wybiera stylu, nie rozwiązuje promptów

### 4.2 `llmEngineer`
- **Cel:** Przekłada architekturę na prompty, kontrakty, schematy
- **Perspektywa:** Prompt design, tool-use rules, memory rules, output schema, failure handling
- **Patrzy na:** Kontrakt agenta, briefy subagentów, schematy I/O
- **Model:** `reasoning` preset
- **Zakaz:** Nie implementuje kodu, nie decyduje o infrastrukturze

### 4.3 `creativeStrategist`
- **Cel:** Wnosi kreatywne warianty w ramach celu biznesowego
- **Perspektywa:** Formaty, hooks, narracje, trendy, repurposing, tone-of-voice
- **Patrzy na:** Co działa dziś w sieci (musi oznaczyć jako wymagające researchu)
- **Model:** `default` preset
- **Zakaz:** Nie decyduje o architekturze, nie udaje świeżych trendów bez danych

### 4.4 `memoryArchitect`
- **Cel:** Pilnuje, żeby system nie był amnezją z narzędziami
- **Perspektywa:** Historia, deduplikacja, embeddingi, NotebookLM, repo indexing
- **Patrzy na:** Poprzednie decyzje, style guide, content memory, semantic dedup
- **Model:** `default` preset
- **Zakaz:** Nie projektuje UI, nie decyduje o publikacji

### 4.5 `redTeamCritic`
- **Cel:** Zniszczyć słaby pomysł zanim zrobi to produkcja
- **Perspektywa:** Ukryte założenia, failure modes, halucynacje, brak approval, koszty, prompt injection, security
- **Patrzy na:** WSZYSTKO — krytykuje każdego
- **Model:** `cloud` preset (musi być silny — znalezienie realnych problemów wymaga reasoning)
- **Zakaz:** Nie proponuje alternatyw (to rola synthesisPlanner)
- **Uwaga:** Wchłania rolę `securityGuardrailAgent` — ma explicit security checklist

### 4.6 `synthesisPlanner`
- **Cel:** Finalna synteza BEZ dodawania nowych pomysłów
- **Perspektywa:** Integracja, trade-offy, decyzje, odrzucone opcje
- **Patrzy na:** Wszystkie pozycje + krytyki
- **Model:** `default` preset
- **Zakaz:** Nie dodaje nowych pomysłów, nie zmienia stanowisk — tylko skleja

### Cost Implications (zamiast osobnego opsCostEngineer)

Każdy worker musi odpowiedzieć na sekcję w swoim output:

```yaml
cost_implications:
  estimated_llm_calls: <number>
  model_tier_needed: cheap | mid | strong
  latency_impact: low | medium | high
  can_be_simplified: <boolean + explanation>
```

## 5. Debate Depth Tiers

```yaml
light:   # ~4 LLM calls, 30-60s
  workers:
    - llmEngineer
    - redTeamCritic
    - synthesisPlanner
  critique: skip unless conflicts
  use_when: "small task, 2-3 perspectives enough, output = recommendation"

standard:  # ~7-9 LLM calls, 1-2min
  workers:
    - systemsArchitect
    - llmEngineer
    - memoryArchitect
    - redTeamCritic
    - synthesisPlanner
    - creativeStrategist (only if task is creative)
  critique: conditional (conflicts OR risk >= medium)
  use_when: "affects multiple agents/workflows/memory/tools"

deep:  # ~12-14 LLM calls, 2-4min
  workers:
    - all 6
  critique: always
  double_critique: redTeamCritic gets second pass after fixes
  use_when: "high-risk, expensive, security-sensitive, architecturally foundational"
```

## 6. Debate Process (Rundy)

### Runda 0 — Intake

`deliberationAgent` dostaje zadanie od metaAgenta i tworzy ramę:

```yaml
goal: <string>
domain: <string>
user_intent: <string>
known_context: <string>
missing_context: <string[]>
constraints: <string[]>
risk_level: low | medium | high | critical
expected_output: recommendation | plan | architecture | multiple_options
debate_depth: light | standard | deep
required_artifacts: [debate-notes, decision-brief, implementation-plan]
```

### Runda 1 — Niezależne stanowiska

Każdy worker dostaje ten sam brief, odpowiada ze swojej perspektywy.

**Worker Response Schema:**

```yaml
role: <string>
position: <string — 2-3 sentences>
main_recommendation: <string>
key_arguments:
  - <string>
risks:
  - <string>
unknowns:
  - <string>
dependencies:
  - <string>
suggested_next_steps:
  - <string>
cost_implications:
  estimated_llm_calls: <number>
  model_tier_needed: cheap | mid | strong
  latency_impact: low | medium | high
  can_be_simplified: <string>
confidence: low | medium | high
```

### Runda 2 — Krytyka krzyżowa (warunkowa)

Uruchamiana TYLKO gdy:
- Pozycje się sprzeczne
- risk_level >= medium
- debate_depth == deep

**Critique Schema:**

```yaml
critic: <role_name>
target_position: <role_name>
strong_points:
  - <string>
failure_modes:
  - <string>
missing_constraints:
  - <string>
unsafe_assumptions:
  - <string>
recommended_changes:
  - <string>
```

**Pary krytyki:**
- `redTeamCritic` → krytykuje WSZYSTKICH
- `llmEngineer` → krytykuje `systemsArchitect` pod kątem kontraktów agentowych
- `memoryArchitect` → krytykuje `creativeStrategist` pod kątem deduplikacji

### Runda 3 — Konwergencja

`deliberationAgent` (nie worker) wybiera typ wyniku:

```yaml
decision_type:
  - single_recommendation    # jeden kierunek
  - multiple_options         # 2-3 opcje z trade-offami
  - blocked_needs_more_info  # brak danych do decyzji
```

### Runda 4 — Zapis artefaktów

Obowiązkowe pliki:

```
/artifacts/debates/{YYYY-MM-DD}/{task-slug}/
  ├── 01-debate-notes.md
  ├── 02-decision-brief.md
  ├── 03-implementation-plan.md
  └── metadata.json
```

Opcjonalne:
```
  ├── 04-risk-register.md
  └── 05-agent-task-briefs.md
```

## 7. Output Contract — deliberationAgent → metaAgent

```yaml
status: completed | blocked | needs_approval | failed
goal: <string>
debate_depth: light | standard | deep
subagents_used: <string[]>
decision_type: single_recommendation | multiple_options | blocked_needs_more_info
recommended_direction: <string>
decision_summary: <string>
implementation_plan: <string — high-level steps>
agent_delegation_plan:
  - agent: <string>
    task: <string>
workflow_recommendations:
  - <string>
memory_to_recall: <string[]>
memory_to_write: <string[]>
approval_required: <boolean>
approval_reason: <string>
risks: <string[]>
open_questions: <string[]>
artifacts_written: <string[]>
success_criteria: <string[]>
next_action_for_metaAgent: <string>
```

## 8. Artifact Formats

### 01-debate-notes.md

```markdown
# Debate Notes: {task_title}

## Goal
...

## Context
...

## Subagents Used
- systemsArchitect
- llmEngineer
- redTeamCritic

## Independent Positions

### systemsArchitect
**Position:** ...
**Recommendation:** ...
**Risks:** ...
**Confidence:** medium

### llmEngineer
...

## Critique Round
| Critic | Target | Key Finding | Resolution |
|--------|--------|-------------|------------|

## Conflicts
| Topic | Position A | Position B | Resolution |
|-------|-----------|-----------|------------|

## Rejected Options
| Option | Reason |
|--------|--------|

## Key Decisions
1. ...

## Open Questions
1. ...
```

### 02-decision-brief.md

```markdown
# Decision Brief: {task_title}

## Recommended Direction
...

## Why This Over Alternatives
...

## Architecture
...

## Agents / Workflows Involved
...

## Required Memory Operations
...

## Risks
...

## Approval Points
...

## Success Criteria
...

## Next Action for metaAgent
...
```

### 03-implementation-plan.md

```markdown
# Implementation Plan: {task_title}

## Phase 1 — Discovery
...

## Phase 2 — Design
...

## Phase 3 — Build
...

## Phase 4 — Validate
...

## Phase 5 — Approval / Release
...

## Task Briefs for Downstream Agents
| Agent | Task | Priority |
|-------|------|----------|
```

### metadata.json

```json
{
  "debateId": "uuid",
  "timestamp": "ISO-8601",
  "goal": "...",
  "debateDepth": "standard",
  "workersUsed": ["systemsArchitect", "llmEngineer", "redTeamCritic", "synthesisPlanner"],
  "decisionType": "single_recommendation",
  "status": "completed",
  "totalLlmCalls": 7,
  "durationMs": 45000,
  "artifactPaths": [
    "01-debate-notes.md",
    "02-decision-brief.md",
    "03-implementation-plan.md"
  ]
}
```

## 9. Model Routing

| Worker | Preset | Model | Uzasadnienie |
|--------|--------|-------|-------------|
| systemsArchitect | `reasoning` | qwen3.5-9b | Analiza strukturalna wymaga reasoning |
| llmEngineer | `reasoning` | qwen3.5-9b | Kontrakty i schematy wymagają precyzji |
| creativeStrategist | `default` | gemma4-e4b | Generowanie wariantów — nie wymaga deep reasoning |
| memoryArchitect | `default` | gemma4-e4b | Analiza pamięci — strukturalna ale prosta |
| redTeamCritic | `cloud` | gemini-2.5-flash | MUSI być silny — znajdowanie realnych problemów |
| synthesisPlanner | `default` | gemma4-e4b | Integracja — nie wymaga inwencji |
| deliberationAgent | manifest | gemini-3.1-flash-lite | Orkiestracja, tool-calling |

## 10. metaAgent Integration

### Routing Rule (dodać do prompta meta)

```
Use deliberationAgent when the user request is:
- open-ended, strategic, architectural, creative, or ambiguous
- high-impact or benefits from counterarguments before execution
- the user explicitly asks to "rozważ", "podważ", "zaprojektuj", "debatuj"
- you have too little certainty to delegate directly to codingAgent or automationArchitect

Do NOT use deliberationAgent for:
- simple implementation tasks or obvious bug fixes
- direct file edits or straightforward research
- tasks with a known existing workflow or skill
- unless the user explicitly asks for alternatives or critique
```

### Trigger Examples

```
"wymyślmy..."
"jak najlepiej podejść do..."
"zaprojektujmy system..."
"rozważ kilka opcji..."
"podważ ten pomysł..."
"znajdź najlepszą architekturę dla..."
"czy to ma sens?"
"zrób debatę o..."
"daj kilka wariantów..."
"ulepsz mój pomysł..."
"nie wiem jak to zbudować..."
```

### delegate-task.ts Integration

Add to `AGENT_IDS` map:
```typescript
deliberationAgent: DELIBERATION_AGENT_ID,
```

Add to `delegateTaskTool` inputSchema enum:
```typescript
targetAgent: z.enum([..., 'deliberationAgent'])
```

## 11. Evals (od dnia 1)

```yaml
scorer: deliberation_quality
metrics:
  - did_critique_find_real_problem: boolean
  - did_final_plan_address_critique: boolean
  - was_plan_executable_by_downstream_agent: boolean
  - did_user_accept_without_major_changes: boolean
  - token_cost_vs_single_pass_baseline: ratio
  - was_debate_depth_appropriate: overused | right | insufficient
  - artifact_completeness: 0.0-1.0
```

### Baseline comparison

Po 10 debatach porównaj:
1. Plan z deliberation vs plan z single-pass meta-agent
2. Czy downstream agent (coding/automation) wykonał plan bez major zmian?
3. Koszt tokenów deliberation vs koszt poprawek bez deliberation

## 12. Safety & Approval

- deliberationAgent NIE implementuje kodu
- deliberationAgent NIE wysyła wiadomości
- deliberationAgent NIE deployuje
- deliberationAgent NIE modyfikuje produkcji
- Jeśli rekomendacja wymaga approval → ustawia `approval_required: true`
- Workery są text-only — zero side-effects
- Zewnętrzna treść w briefie traktowana jako untrusted (sekcja 16 AGENTS.md)
