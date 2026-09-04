# Agent Board — roster jako dane, nie proza (Etap 2)

> Implementacja Etapu 2 planu `ideas/IDEALSYSTEMMASTERPLAN.md` (projekt A1).
> Wdrożono: 2026-07-20, branch `feat/ideal-system-etap-2-agent-board`.

## Problem, który rozwiązuje

Roster agentów żył w dwóch ręcznie utrzymywanych kopiach: ~6 tys. znaków w opisie
`delegate-task.ts` + tabela i akapity w `prompts/meta/base.md` (~35,6 tys. znaków).
Każda tura meta płaciła za to tokenami; kopie się rozjeżdżały; enum agentów wymagał
ręcznej synchronizacji; inni agenci nie widzieli, kogo mają do pomocy.

## Architektura

```
config/agent-board.ts            ← ŹRÓDŁO PRAWDY: 17 kart (AgentCard)
        │
        ├─ scripts/build-agent-board.ts  (npm run build:agent-board)
        │    ├─ + model z model-manifest.ts (nie duplikujemy)
        │    ├─ + trackRecord z agent_events (30d, dashboard-stats)
        │    ├─ → Mongo `agent_board` (pełne karty wzbogacone)
        │    └─ → prompts/meta/_generated/roster.md (kompakt, 3 linie/agenta)
        │
        ├─ delegate-task.ts: z.enum(AGENT_BOARD_IDS)  ← koniec ręcznej synchronizacji
        ├─ prompts/meta/base.md: {{include:_generated/roster.md}}  ← prompt-loader
        │    (nowa obsługa include w lib/prompt-loader.ts, ścieżki względem pliku)
        └─ tools/system/agent-board-tools.ts
             ├─ agent_board_list  — kompaktowy przegląd + track record
             └─ agent_board_get   — pełna karta: when(Not)ToUse, inputContract,
                                    przykładowe briefy, hard rules, model, track record
```

**Karta (AgentCard):** id, oneLiner, whenToUse[], whenNotToUse[], inputContract,
outputArtifacts[] (typy z E3), delegation sync/async/both, costClass, latencyClass,
examples[], hardRules[] (reguły z realnych porażek, np. zakaz dekompozycji zadań
chefa na coding).

**Kto ma toole tablicy:** meta ORAZ orkiestratorzy domenowi (chef, hunt, content,
writer, filmmaker, musician, automationArchitect) — agenci mogą używać siebie
nawzajem: zanim agent powie „nie umiem", sprawdza tablicę.

**Odświeżanie:** `npm run build:agent-board` ręcznie; cron-runner odświeża
automatycznie w poniedziałki 07:30 (in-process). Generator jest fail-safe — bez
Mongo pisze roster ze statycznych kart (bez track recordów), `mastra build` nigdy
nie blokuje się na infrze.

## Pomiar (vs baseline E0)

| Metryka | Przed (E0) | Po (E2) | Zmiana |
|---|---|---|---|
| `meta/base` załadowany (include rozwiązany) | 35 568 zn. | 28 499 zn. | −19,9 % |
| Opis delegate-task | 5 944 zn. | 1 050 zn. | −82,3 % |
| **Łączny statyczny balast / turę** | **41 512 zn.** | **29 549 zn.** | **−28,8 %** ✅ (cel ≥25 %) |

Roster w zamian **zyskał** dane, których stara tabela nie miała: track record 30d
(success rate, koszt/zadanie, latencja) i model — np. tablica od razu pokazuje
automationArchitect 39% ok (122 zadania) jako najsłabsze ogniwo.

Pełny spadek „tokeny/turę meta" (cel −25% na metryce live z `agent_events`) do
potwierdzenia po wygenerowaniu ruchu: `npm run baseline:metrics` i porównanie z
`reports/baseline/baseline-metrics-2026-07-20.json`.

## Strażnicy dryfu (w `check:all`)

- `check:agent-board-sync` — karta ↔ rejestracja w index.ts, enum z tablicy,
  registry delegate-task ≡ karty, include obecny i rozwiązywalny, roster świeży,
  toole zarejestrowane u meta + 7 orkiestratorów, kompletność kart.
- `check:meta-prompt-size` — limity: base ≤33k zn., opis delegate ≤2k zn.,
  łącznie ≥25% poniżej baseline E0. Gdy pęknie: treść przenosić do kart
  (`agent_board_get` serwuje na żądanie), nie podnosić limitu.

## Aktualizacja checków domenowych

`check:n8n-mcp-engineer`, `check:filmmaker-domain`, `check:musician-domain`
assertowały literalny enum/opisy w delegate-task i base.md — zaktualizowane, by
sprawdzały tablicę i wygenerowany roster (to samo pokrycie, nowe źródło prawdy).
