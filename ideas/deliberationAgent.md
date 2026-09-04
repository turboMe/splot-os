# Deliberation Agent — Master Design Document

> **Status:** Draft v1.0 · **Data:** 2026-05-16 · **Autor:** Patryk + Antigravity

---

## Spis treści

Pełny design jest podzielony na 3 dokumenty:

| Dokument | Zawartość | Link |
|----------|-----------|------|
| **01 — Architecture** | Problem, architektura, 6 worker perspectives, debate depth tiers, rundy debaty, output contract, artifact formats, model routing, metaAgent integration, evals, safety | [01-architecture.md](deliberation/01-architecture.md) |
| **02 — Prompts** | Pełny prompt deliberationAgent, worker brief template, critique template, 6 worker prompts (systemsArchitect, llmEngineer, creativeStrategist, memoryArchitect, redTeamCritic, synthesisPlanner), przykład Instagram | [02-prompts.md](deliberation/02-prompts.md) |
| **03 — Implementation Plan** | 8 etapów implementacji z plikami, weryfikacją, ryzykiem, zależnościami, estymacjami | [03-implementation-plan.md](deliberation/03-implementation-plan.md) |

---

## TL;DR

### Co budujemy
Nowy agent domenowy `deliberationAgent` — strukturalna debata między wyspecjalizowanymi workerami LLM przed wykonaniem złożonych zadań. Design Council, nie brainstorming.

### Kluczowe decyzje

1. **6 workerów** (nie 9) — `systemsArchitect`, `llmEngineer`, `creativeStrategist`, `memoryArchitect`, `redTeamCritic`, `synthesisPlanner`
2. **Workery, nie agenty** — `run_worker` (text-in/text-out), zero narzędzi, zero side-effects
3. **3 tryby głębokości** — `light` (3 workers, ~60s), `standard` (5-6 workers, ~2min), `deep` (6 workers + critique, ~4min)
4. **Warunkowa krytyka** — nie zawsze, tylko gdy konflikty lub risk ≥ medium
5. **Obowiązkowe artefakty na dysku** — `debate-notes.md`, `decision-brief.md`, `implementation-plan.md`
6. **Ewaluacja od dnia 1** — mierzymy czy deliberation jest lepsza niż single-pass
7. **Cost section w każdym workerze** — zamiast osobnego opsCostEngineer

### Milestones

| Milestone | Etapy | Czas | Wynik |
|-----------|-------|------|-------|
| **MVP** | 0-3 | ~4h | Light deliberation działa E2E |
| **Full** | 4-6 | ~4h | Wszystkie depths + evals |
| **Polish** | 7-8 | ~2h | Iteration loop + async |

### Diagram architektury

```
metaAgent
  └─► delegateTask("deliberationAgent")
        └─► deliberationAgent
              │
              ├── [Runda 0] Intake — analiza zadania, wybór głębokości
              │
              ├── [Runda 1] Niezależne stanowiska (parallel run_worker)
              │   ├── systemsArchitect  (reasoning)
              │   ├── llmEngineer       (reasoning)
              │   ├── creativeStrategist (default)   ← opcjonalny
              │   ├── memoryArchitect   (default)
              │   ├── redTeamCritic     (cloud)
              │   └── synthesisPlanner  (default)
              │
              ├── [Runda 2] Krytyka krzyżowa (warunkowa)
              │   └── redTeamCritic → krytykuje wszystkich
              │
              ├── [Runda 3] Konwergencja — decision type + synteza
              │
              ├── [Runda 4] Zapis artefaktów na dysk
              │
              └── Return structured output → metaAgent
                    └── metaAgent: accept / reject+feedback / execute
```

---

## Czytanie planu

1. Zacznij od **01-architecture.md** — zrozum CO budujemy i DLACZEGO
2. Przejdź do **02-prompts.md** — zobacz JAK agenci i workerzy będą komunikować
3. Skończ na **03-implementation-plan.md** — plan KIEDY i W JAKIEJ KOLEJNOŚCI implementować

Po przeczytaniu wszystkich 3 dokumentów masz kompletną wiedzę do rozpoczęcia implementacji od Etapu 0.
