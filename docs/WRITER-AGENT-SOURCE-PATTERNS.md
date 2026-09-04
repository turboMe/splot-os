# Writer Agent Source Patterns

This document captures the reusable design patterns extracted from the cloned
reference repositories under `storage/downloads`. The runtime should depend on
these distilled patterns, not on the downloaded repositories. After the patterns
are represented in code, prompts, and docs, the downloaded clones can be removed.

## License Boundary

| Source | License | Use |
|---|---|---|
| `better-writing` | MIT | Adapt writing-quality principles, voice dials, preflight, and anti-slop ideas |
| `story-skills` | MIT | Adapt story schema and continuity-validation concepts |
| `creative-writing-skills` | Apache 2.0 | Adapt staffing roles: critic, reader-sim, muse, chronicler |
| `autonovel` | not treated as vendored code | Use concepts only: immune system, reader panel, evaluate/keep-discard loop |
| `authorclaw` | MIT | Adapt style profile, plot promises, story structures, beta-reader ideas |
| `claude-scientific-writer` | MIT | Adapt source-first article/report workflow |
| `inkos` | AGPL-3.0-only | Concepts only; do not copy code into this repository |

## Patterns Moved Into The Plan

### Better Writing

Useful concepts:

- voice calibration through explicit dials;
- weak opener and stock phrase detection;
- preflight checks before publishing;
- avoiding generic "AI-shaped" prose.

Implemented in Sprint 1:

- `src/mastra/tools/writer/anti-slop.ts` with English and Polish phrase checks;
- `WriterStyleProfile` dials in `writer-service.ts`.

Future prompt use:

- `prompts/writer/domain.md`;
- `prompts/writer/workers/polisher.md`.

### Story Skills

Useful concepts:

- story bible split into characters, world, timeline, promises, and questions;
- deterministic checks for continuity failures;
- chronicler-style extraction after each chapter or scene.

Implemented in Sprint 1:

- `writer_continuity` collection;
- `validateContinuity()` in `continuity-validator.ts`.

Future prompt use:

- `prompts/writer/workers/chronicler.md`;
- fiction phases in `prompts/writer/pipeline.md`.

### Creative Writing Skills

Useful concepts:

- critic gives specific findings and does not rewrite the whole piece;
- reader simulation reports where attention, confusion, and emotional transport
  rise or fall;
- muse proposes alternatives without forcing them;
- chronicler extracts durable facts from written chapters.

Implemented in Sprint 2 and Sprint 4:

- `writer_critic`;
- `writer_reader`;
- `writer_muse`;
- `writer_chronicler`;
- `writer_polisher`;
- `writer_prepare_worker_review` creates structured JSON task contracts for
  worker passes;
- worker outputs are persisted by writerAgent through `writer_save_audit`,
  `writer_update_continuity`, or notes.

### Autonovel

Useful concepts:

- two-layer quality immune system: mechanical checks plus taste/judgment checks;
- bounded generate-evaluate-revise loop;
- keep/discard decisions based on whether a revision improves the manuscript.

Implemented in Sprint 1:

- deterministic slop and continuity checks;
- manuscript snapshots in `writer-document-tools.ts`.

Implemented in Sprint 4:

- `writer_quality_gate`;
- `writer_revision_decision`;
- pipeline sequence: snapshot -> audit -> worker review -> revision -> snapshot
  -> re-audit -> accept/rollback/human-review decision.

### AuthorClaw

Useful concepts:

- style markers and author personas;
- plot promise tracking;
- beta-reader style feedback;
- story structure catalog.

Implemented in Sprint 1:

- `WriterStyleProfile.signatureMarkers`;
- `writer_claims` and continuity promise structures as storage primitives.

Future implementation:

- `writer_analyze_style_sample`;
- richer story structure selection in outline generation.

### Claude Scientific Writer

Useful concepts:

- research-first article/report writing;
- source ledger before final prose;
- no fabricated citations;
- trace factual claims to sources.

Implemented in Sprint 1:

- `writer_sources`;
- `writer_claims`;
- `verifyClaims()` in `WriterService`.

Implemented in Sprint 4:

- `writer_prepare_research_delegation`;
- `writer_ingest_research_result`;
- source verification and claim verification phase allowlists.

### Inkos

Useful concepts:

- truth authority hierarchy;
- review cycle with a best-version snapshot;
- rollback when a revision does not improve the text.

Implemented in Sprint 1:

- `WriterCanonPolicy.authorityOrder`;
- manuscript snapshots.

Important boundary:

- Do not copy AGPL code into this repository.
- Treat this source as architectural inspiration only.

## Removal Readiness For `storage/downloads`

The downloaded repositories can be removed when:

1. `docs/WRITER-AGENT-SOURCE-PATTERNS.md` remains in the repo.
2. Prompt files explicitly encode the selected patterns.
3. `check:writer-domain` covers deterministic adaptations.
4. Future worker prompts cite the pattern name, not the local download path.
5. No source file imports or reads from `storage/downloads`.
