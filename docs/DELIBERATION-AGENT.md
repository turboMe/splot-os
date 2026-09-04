# Deliberation Agent (Design Council)

> Agent domenowy odpowiedzialny za strukturalną debatę, krytykę i syntezę decyzji.

## Architektura

```
metaAgent
  └── delegateTask(deliberationAgent)
        ├── run_deliberation_worker(systemsArchitect)
        ├── run_deliberation_worker(llmEngineer)
        ├── run_deliberation_worker(redTeamCritic)
        ├── run_deliberation_worker(creativeStrategist)
        ├── run_deliberation_worker(memoryArchitect)
        └── run_deliberation_worker(synthesisPlanner)
```

## Kiedy jest wywoływany

MetaAgent automatycznie routuje do deliberationAgent, gdy:
- Zadanie jest otwarte, strategiczne, architektoniczne lub kreatywne
- Użytkownik prosi o "rozważenie", "podważenie", "zaprojektowanie", "debatę"
- Potrzeba kilku wariantów rozwiązania
- Zadanie jest wysokiego ryzyka i wymaga kontrargumentów przed wykonaniem

**NIE** jest używany do: prostych implementacji, bugfixów, edycji plików, zadań z jasnym workflow.

## Głębokości debaty

| Depth | Workerzy | Czas | Kiedy |
|-------|----------|------|-------|
| light | 3 (llmEngineer, redTeamCritic, synthesisPlanner) | ~30-60s | Mały task, 2-3 perspektywy wystarczą |
| standard | 5-6 | ~1-2min | Task dotyka wielu agentów/workflow/memory |
| deep | 6 + double critique | ~2-4min | Wysoki risk, security, architektura fundacyjna |

## Narzędzia

| Narzędzie | Opis |
|-----------|------|
| `run_deliberation_worker` | Spawn workera z przypisaną rolą Design Council |
| `writeDebateArtifactTool` | Zapis artefaktów debaty na dysk |
| `memoryRecallTool` | Przypomnienie wcześniejszych decyzji |
| `memoryWriteTool` | Zapis nowych obserwacji/decyzji |
| `currentTimeTool` | Aktualny czas |
| `requestApprovalTool` | Brama akceptacji przed destrukcyjnymi akcjami |

## Konfiguracja modeli

Główny agent: `agentModels.deliberationAgent` w `model-manifest.ts`

Modele subagentów (role → model) w `deliberationAssignments` w `model-manifest.ts`:

| Rola | Model (domyślny) |
|------|-------------------|
| systemsArchitect | qwen3.5-9b |
| llmEngineer | qwen3.5-9b |
| redTeamCritic | gemini-2.5-flash |
| creativeStrategist | gemma4-e4b |
| memoryArchitect | gemma4-e4b |
| synthesisPlanner | gemma4-e4b |

Zmiana modelu: edytuj `src/mastra/config/model-manifest.ts` → sekcja `SECTION 6: DELIBERATION ASSIGNMENTS`.

## Artefakty

Zapisywane w: `artifacts/debates/{YYYY-MM-DD}/{slug}/`

Pliki:
- `01-debate-notes.md` — notatki z debaty
- `02-decision-brief.md` — brief decyzyjny
- `03-implementation-plan.md` — plan implementacji
- `04-risk-register.md` — rejestr ryzyk
- `05-agent-task-briefs.md` — briefy dla downstream agentów
- `metadata.json` — metadane debaty

## Output Contract

Agent zwraca do metaAgent structured YAML z polami:
`status`, `goal`, `debate_depth`, `subagents_used`, `decision_type`, `recommended_direction`, `decision_summary`, `implementation_plan`, `agent_delegation_plan`, `risks`, `open_questions`, `artifacts_written`, `next_action_for_metaAgent`.

## Revision Mode

Jeśli metaAgent odrzuci plan, może odesłać zadanie z feedbackiem. deliberationAgent:
1. Przywołuje poprzednie artefakty z pamięci
2. Uruchamia TYLKO dotkniętych workerów
3. Dopisuje "Revision History" do artefaktów
4. Zwraca poprawiony plan

Limit: max 2 iteracje.

## Ewaluacja

Scorer: `deliberationQualityScorer` w `src/mastra/scorers/deliberation-scorer.ts`

Mierzy:
- Czy krytyka znalazła realny problem
- Czy plan uwzględnił krytykę
- Czy plan jest wykonalny
- Czy głębokość debaty była adekwatna
- Kompletność artefaktów

## Pliki źródłowe

| Plik | Opis |
|------|------|
| `src/mastra/agents/deliberation-agent.ts` | Definicja agenta |
| `src/mastra/prompts/deliberation/base.md` | Pełny prompt |
| `src/mastra/tools/deliberation/run-deliberation-worker.ts` | Narzędzie workerów |
| `src/mastra/tools/deliberation/write-debate-artifact.ts` | Narzędzie artefaktów |
| `src/mastra/scorers/deliberation-scorer.ts` | Scorer ewaluacyjny |
| `src/mastra/config/model-manifest.ts` (Section 6) | Konfiguracja modeli ról |
| `ideas/deliberation/01-architecture.md` | Architektura (design doc) |
| `ideas/deliberation/02-prompts.md` | Pełne prompty (design doc) |
| `ideas/deliberation/03-implementation-plan.md` | Plan implementacji |
