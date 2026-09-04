# Kontrakty komunikacji agentów (Etap 3)

> Implementacja Etapu 3 planu `ideas/IDEALSYSTEMMASTERPLAN.md` (projekt A2 — cztery warstwy).
> Wdrożono: 2026-07-20, branch `feat/ideal-system-etap-3-communication-contracts`.
> Feature flag: `FEATURE_COMM_CONTRACTS` (default **ON**; rollback = `FEATURE_COMM_CONTRACTS=false`).

## Zasada

**Im ważniejszy przekaz, tym bardziej strukturalny nośnik.** Agenci wymieniają
**dokumenty (artefakty), nie transkrypty czatu** — do promptu następnego agenta
idzie `summary (≤300 znaków) + id`, pełna treść dopiero na żądanie. To główny
mechanizm oszczędzania tokenów w sekwencjach: zmierzone **−99,2%** payloadu
handoffu na teście 76 KB research → brief writera.

## Warstwa 2 — Artifact Store (`services/artifact-store.ts`)

Typowane dokumenty w Mongo `artifacts` (małe inline, >512 KB → plik pod
`MASTRA_ARTIFACT_DIR`, jak w harness-output-compactor). Rekord indeksu:
`{ id, type, laneId, producedBy, schemaVersion, uri, summary≤300, bytes, sha256 }`.
Sekrety redagowane przy zapisie, TTL 90 dni (lifecycle przejmie Kurator w E6).

- Typy artefaktów: `config/artifact-types.ts` (14 typów; `agent-board.ts`
  re-eksportuje `ArtifactType` — jedno źródło prawdy dla kart tablicy).
- Toole `artifact_put` / `artifact_get` / `artifact_list(laneId)` u **meta +
  orkiestratorów + ekspertów** (chef, hunt, content, writer, film, musician,
  automationArchitect, researcher, knowledge, deliberation, coding).
- `renderArtifactRefsForBrief` — składa linie `summary + id → artifact_get(id)`;
  pełna treść NIGDY nie trafia do briefu.

## Warstwa 1 — TaskBrief v2 (`worker-task-spec.ts`)

Rozszerzenie istniejącego `workerTaskSpecSchema` (dokończenie, nie przepisanie):
- `inputs[].artifactId` — referencja do Artifact Store zamiast wklejki
  (`source: 'artifact'`);
- `outputContract.artifactType` — typ artefaktu, który zadanie ma wyprodukować;
- `constraints.budgetUsd` / `constraints.deadline`;
- `laneId` — korelacja z Task Ledger (artefakty dziedziczą);
- `claims[]` — zasoby, których zadanie dotknie (**zapisywane teraz,
  schedulowane w E5**).

`renderWorkerBriefWithArtifacts()` — async renderer: linie z `artifactId`
rozwiązuje na `summary + id` (fallback do sync renderera bez artefaktów).
delegate-task używa go automatycznie.

## Warstwa 3 — ResultEnvelope (`services/result-envelope.ts`)

Każda delegacja zwraca strukturę zamiast surowej prozy:

```json
{ "status": "ok|partial|failed|blocked_needs_approval",
  "artifacts": [{"id","type","summary"}],
  "metrics": {"costUsd","durationS","toolCalls"},
  "lessons": ["…"],          // paliwo destylacji skilli (E6)
  "followup": "…" }
```

- Parser priorytetów: fenced ` ```json result_envelope ` → trailing bare JSON →
  **fallback prozy** (`{ status: ok, artifacts: [], parsed: false, raw }`) — starzy
  agenci działają bez zmian, migracja jest stopniowa.
- `delegate-task` opakowuje wynik przez `wrapWithResultEnvelope`: parsuje odpowiedź,
  a `status: failed` / `blocked_needs_approval` **degraduje `success`** — pętle
  retry/approval meta odpalają na sygnale strukturalnym, nie na dopasowaniu stringów.
- Snippet instrukcji `prompts/shared/result-envelope.md` dołączany do każdego
  briefu delegacji (za flagą): „zapisz przez artifact_put, zakończ envelope".

## Warstwa 4 — Zdarzenia

Bez zmian w E3 — istniejące `pushSignal`/`harness-events` + digest Task Ledgera
z E1 pełnią tę rolę; pełne tematy `lane.*`/`approval.*` dojrzeją z Plays (E4).

## plan-task

`planStepSchema.out?: ArtifactType` — krok planu nazywa typ artefaktu, który
produkuje (handoffy nazywają swój artefakt; podstawa bramek Plays w E4).

## Testy (w `check:all`)

- `check:result-envelope-parse` — fenced/bare/fallback, złe statusy i malformed
  JSON → fallback bez wyjątku, `stripEnvelopeBlock` (9 asercji).
- `e2e:artifact-handoff` — realny store: researcher zapisuje 76 KB → brief writera
  niesie summary+id (**−99,2%**, <3 KB), full content round-trip byte-identyczny,
  `artifact_list(laneId)`, split >512 KB do pliku, envelope writera z ref+lesson.

## Ograniczenia E3 (świadome)

- `claims[]` są zapisywane w TaskBrief v2, ale **nie schedulowane** (scheduler
  kolizji → E5).
- Egzekwowanie envelope u ekspertów jest miękkie (instrukcja w briefie + parser z
  fallbackiem); twarda walidacja wyjścia w harnessach — kandydat na E6.
- Metryki `costUsd/durationS` w envelope wypełnia model, jeśli je poda; twarde
  źródło pozostaje `agent_events` (baseline).
