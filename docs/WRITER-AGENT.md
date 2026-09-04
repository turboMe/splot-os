# Writer Agent

> Status: Sprint 5 implemented. Foundation, prompts, domain tools, writerAgent,
> model assignments, worker presets, meta delegation, pipeline phase tools,
> runtime registration, topology, read-only writer API routes, researcher
> delegation contracts, source/claim ingest, structured worker review prep, and
> deterministic quality/revision gates are in place. `/dashboard-ui` -> Workspace
> now includes a Writer card for projects and manuscript previews. An isolated
> V2 canary has proved durable earned-time and fail-closed finalization, but not
> full domain parity or production rollout. Post-canary abort, review-provenance,
> revision and hard-brief fixes pass targeted deterministic checks but do not yet
> have a second live proof.
> Date: 2026-08-10

Writer Agent is the long-form writing domain for fiction, books, articles,
reports, essays, and manuscript editing. The runtime design follows the existing
chef-domain pattern: durable project state in MongoDB, deterministic quality
checks, incremental markdown documents on disk, and later orchestration through
`metaAgent -> writerAgent`.

## Language Contract

All code identifiers, prompt filenames, tool descriptions, and internal
contracts are English. Deliverable content defaults to Polish through
`deliverableLanguage: "pl"`, but each project can request another output
language, for example English.

The project also stores:

- `autonomyMode`: `checkpointed` or `full_auto`;
- `taskMode`: `quick_write`, `edit`, `outline_only`, `continue_project`, or
  `full_project`;
- `workingLanguage`: currently fixed to `en` for internal contracts.

## Implemented Runtime Pieces

| File | Purpose |
|---|---|
| `src/mastra/tools/writer/db.ts` | MongoDB helper and writer collection indexes |
| `src/mastra/tools/writer/writer-service.ts` | Durable project state, sections, manuscript snapshots, continuity, sources, claims, audits, and notes |
| `src/mastra/tools/writer/anti-slop.ts` | Deterministic style/slop audit for English and Polish text |
| `src/mastra/tools/writer/continuity-validator.ts` | Deterministic canon/continuity validation for fiction projects |
| `src/mastra/tools/writer/writer-tools.ts` | Mastra tool wrappers for project state, style, sections, continuity, sources, claims, audits, and notes |
| `src/mastra/tools/writer/writer-document-tools.ts` | Incremental manuscript document tools and helper functions |
| `src/mastra/tools/writer/writer-workflow-tools.ts` | Research delegation, source/claim ingest, structured worker review prep, quality gate, and revision decision helpers |
| `src/mastra/prompts/writer/domain.md` | Writer domain contract |
| `src/mastra/prompts/writer/pipeline.md` | Writer state machine and autonomy/checkpoint rules |
| `src/mastra/prompts/writer/workers/*.md` | Critic, reader-sim, muse, chronicler, and polisher worker contracts |
| `src/mastra/agents/writer-agent.ts` | Mastra writerAgent definition |
| `src/mastra/tools/system/delegate-task.ts` | `writerAgent` target delegation and recursive self-delegation guard |
| `src/mastra/config/pipeline-phase-tools.ts` | Writer phase tool allowlist for pipeline reflector |
| `src/mastra/prompts/meta/base.md` | Meta routing for long-form writing to writerAgent |
| `src/mastra/prompts/meta/intent-router.md` | Intent classification for writer domain requests |
| `src/mastra/index.ts` | Runtime registration, topology, and `/ws/writer/*` read/preview routes |
| `src/mastra/services/workspace-service.ts` | Writer project bundle, document preview, audit summary, and branded HTML render |
| `src/mastra/workspace/index.html` | Standalone `/workspace-ui` Writer tab |
| `dashboard/index.html` | `/dashboard-ui` Workspace Writer tab |
| `src/mastra/scripts/check-writer-domain.ts` | Network-free smoke checks for the foundation |

## Data Model

Writer stores project truth in MongoDB collections:

| Collection | Role |
|---|---|
| `writer_projects` | Project metadata, status, language, autonomy, task mode, style profile |
| `writer_sections` | Ordered chapters, scenes, article sections, outlines, and appendices |
| `writer_manuscripts` | Versioned manuscript snapshots |
| `writer_continuity` | Fiction canon/runtime continuity state |
| `writer_sources` | Research source cards returned by `researcherAgent` |
| `writer_claims` | Factual claims and their source coverage |
| `writer_audits` | Slop, continuity, claim, critic, reader, polish, and revision audit records |
| `writer_notes` | Durable project notes with optional embeddings and regex fallback search |

`writer_projects.reviewRevision` is a monotonic review-contract version. It
increments when brief, style, sections, continuity, sources or claims change.
`writer_projects.auditRevision` increments with each transactionally committed
audit and is copied onto that `WriterAudit`. Latest-audit selection uses this
per-project sequence before timestamp fallback, so equal timestamps cannot make
an older green result outrank a newer red result. Together with
`currentManuscriptId`, these fields fence finalization from stale or concurrent
quality results.

Independent review provenance uses two short-lived system collections:

| Collection | Role |
|---|---|
| `worker_review_requests` | Trusted, expiring `writer_prepare_worker_review` requests bound to an exact normalized taskSpec and contract revision |
| `worker_run_receipts` | One-use successful worker receipts bound to project, role, preset, contract revision, worker run, and exact output hash |

## Incremental Documents

Writer documents are not generated in one final burst. The manuscript is written
section by section to:

```text
WRITER_DOCS_DIR || /projekty/splot-projects/writer-books
```

Each project gets its own directory:

```text
/projekty/splot-projects/writer-books/<projectId>/manuscript.md
/projekty/splot-projects/writer-books/<projectId>/snapshots/v0001.md
/projekty/splot-projects/writer-books/<projectId>/exports/final.md
/projekty/splot-projects/writer-books/<projectId>/exports/final.html
```

Sections use stable anchors:

```markdown
<!-- section:chapter:01 start -->
...
<!-- section:chapter:01 end -->
```

`writer_document_write_section` replaces or appends only one anchored region, so
long projects can continue chapter by chapter without rewriting the whole book.
`writer_document_snapshot` captures a version before or after major revision
passes.

`saveManuscriptSnapshot` and `markCurrentManuscript` use Mongo transactions for
the complete authority switch: existing `isCurrent` flags, target
insert/activation, and project `currentManuscriptId` plus status. A missing
target or failed project/target `matchedCount` aborts the transaction and leaves
the previous current manuscript unchanged.

Invalidation is transactional as well: it removes the project current pointer
and clears all manuscript `isCurrent` flags together. Snapshot creation allocates
its project version inside the Mongo transaction before deriving the `vNNNN`
archive path. The additional compatible full, non-partial unique index
`{ projectId: 1, version: 1 }` coexists with the legacy descending non-unique
`{ projectId: 1, version: -1 }` index and prevents separate Writer instances from
sharing a version number or filename. No index creation or migration was run
against the live database in this work.

## Deterministic Quality Checks

`auditSlop(text, language)` catches weak openers, stock phrases, repeated
openers, list-heavy structure, passive voice clusters, and sentence rhythm
issues. It returns a score from 0 to 100 plus actionable issues.

`validateContinuity(state, sections)` catches:

- dead characters appearing after death without memory/dream/flashback context;
- payoff before setup;
- stale unresolved promises/questions;
- answers before questions;
- timeline conflicts;
- glossary conflicts.

These checks are deterministic and do not replace the later writer workers. They
give `writerAgent` and its critic/polisher workers stable signals to act on.
For `full_project`, the composite quality gate must use the project's fixed
`deliverableLanguage` and cannot lower `minSlopScore` below 80. The audit records
that policy and the completion gate verifies it again.

## Source And Claim Ledgers

For article/report/scientific writing, `researcherAgent` remains the research
specialist. Writer stores research output as source cards in `writer_sources` and
tracks factual statements in `writer_claims`.

The Sprint 4 flow is:

1. `writer_prepare_research_delegation` builds the structured
   `system_delegate_task` contract for `researcherAgent`.
2. `system_delegate_task` runs with `targetAgent = "researcherAgent"` and
   `callerAgentId = "writerAgent"`.
3. `writer_ingest_research_result` normalizes source ids, persists source cards,
   persists claims, stores a research note when provided, and saves a claim audit.

High-risk unsupported claims and conflicting claims block finalization.

## Worker Review And Revision Loop

Writer workers are text-only and do not own project state or inherit the global
Workspace. For substantial passes, writerAgent first calls
`writer_prepare_worker_review`. That call issues a trusted request bound to its
exact normalized `taskSpec`; `system_run_worker` must claim that request once
using the returned preset and unchanged taskSpec.

Supported structured worker presets:

| Role | Preset | Output use |
|---|---|---|
| critic | `writer_critic` | Specific findings, verdict, revision priorities |
| reader | `writer_reader` | Engagement, flow, confusion, payoff risks |
| muse | `writer_muse` | Alternatives and creative options |
| chronicler | `writer_chronicler` | Continuity patch and possible canon conflicts |
| polisher | `writer_polisher` | Style changes that preserve meaning/canon/sources |

For a successful critic, reader, or polisher, `system_run_worker` returns a
`workerRunId` and stores a one-use receipt for the exact output. A passing audit
must present both that id and the unedited output. The service hashes and claims
the matching receipt in the same Mongo transaction that inserts the audit. The
request is bound to the complete current snapshot, and final critic/reader/polish
passes reject focus, section, retry, skill, and outer prompt modifiers. A real
red worker result remains red worker provenance; a newer red or manual failure
invalidates an older green pass. Manual green self-attestation cannot satisfy the
full-project completion gate.

The prepared request and successful receipt also carry `contractRevision`,
captured from the project's current `reviewRevision`. Receipt consumption, audit
insertion, the project/manuscript/review fence and the `auditRevision` increment
occur in one Mongo transaction. A failed insert rolls back receipt consumption,
and a concurrent contract or snapshot change rejects the whole audit. A red
or otherwise unauthorized-green audit for the current manuscript atomically
reopens a `done` project at `revision`.

Deterministic audit tools capture `expectedReviewRevision` before computation.
If brief, style, section, continuity, source or claim state changes before save,
the result is rejected instead of being relabeled as current.

For section, continuity, source and claim mutations, the `reviewRevision` bump
and dependent collection write commit in one Mongo transaction. Callers cannot
observe a new review contract with old dependency data, and a rejected write
leaves no revision bump behind. Existing section, source and claim ids are also
project-owned: an upsert cannot move one to a different project.

`updateProject` remains one aggregation-pipeline update, but wraps patch values
in `$literal`. User content such as a brief beginning with `$status` is stored as
text and cannot be evaluated as a Mongo field expression.

The deterministic quality loop is:

1. Snapshot current manuscript with `writer_document_snapshot`.
2. Run `writer_quality_gate` for anti-slop, continuity, and claim checks.
3. Run structured worker reviews when useful.
4. Apply a bounded revision.
5. Snapshot and run `writer_quality_gate` again.
6. Pass the persisted before/after manuscript ids and both quality summaries to
   `writer_revision_decision`.
7. The decision activates the accepted snapshot, restores the previous snapshot,
   or requests human review. An unresolved latest decision blocks `done`.
8. Rerun every final deterministic and independent gate for the selected current
   manuscript id. Audits from another snapshot never authorize completion.

For a full project, `writer_revision_decision` may not set `saveAudit=false`.
Its audit score describes the selected snapshot: the before score when restoring
the previous manuscript, otherwise the after score. The saved revision audit
must identify the current manuscript; an unscoped or stale manuscript id is
rejected.

For a resolved decision, current-flag selection, the project pointer, project
status `revision`, the audit sequence and the required revision-audit insert are
one Mongo transaction. The database commits this authority before the selected
content is synchronized to the working file. If audit insertion fails, snapshot
selection rolls back. Completion fetches the latest revision independently of
the normal 100-audit window, so an unresolved decision cannot be hidden by later
unrelated audits.

After that commit, `writerDocumentSyncSelectedSnapshot` performs a file-only
copy into `manuscript.md`. It does not call `markCurrentManuscript` or write DB
authority a second time. If filesystem synchronization fails, the project stays
at `revision`; the remaining file/current mismatch blocks completion fail-closed.

Unchanged snapshots reuse their current manuscript id. Any content edit clears
that authority before the file changes, serializes concurrent writes, and reopens
a completed project at `revision`. The final `done` transition uses one CAS over
the current manuscript id, `reviewRevision` and `auditRevision`, closing
manuscript, contract and audit races together.

The Writer prompts also define **Hard Brief Invariants**. Explicit user
constraints, including reveal timing and required absence before a named
chapter, outrank reviewer suggestions and must be rechecked after every
revision.

## Workspace And Dashboard

The operational dashboard at `/dashboard-ui` has a Workspace tab with a Writer
card. It mirrors the existing Chef/Menu Book pattern: project list on the left,
current manuscript viewer on the right, and compact panels for continuity,
source/claim state, and quality audits.

Read-only routes:

```text
GET /ws/writer/projects
GET /ws/writer/documents
GET /ws/writer/projects/:id
GET /ws/writer/projects/:id/sections
GET /ws/writer/projects/:id/sources
GET /ws/writer/projects/:id/claims
GET /ws/writer/projects/:id/audits
GET /ws/writer/projects/:id/document
GET /ws/writer/projects/:id/html
GET /ws/writer/projects/:id/markdown
GET /ws/writer/manuscripts/:id
```

`/workspace-ui` is updated with the same Writer tab so the standalone workspace
view remains in sync with the dashboard copy.

## Verification

Current foundation checks:

```bash
npx tsc --noEmit --pretty false
npm run check:writer-domain
npm run build
```

`check:writer-domain` verifies:

- writer pipeline status constants;
- `agentModels.writerAgent`, `writerAssignments`, and `writer_*` worker presets;
- `run-worker.ts` schema/roles mention every writer worker preset;
- writer prompt files exist and are non-empty;
- `writer-agent.ts` loads writer prompts and registers writer/system tools;
- `delegate-task.ts`, `agent-ids.ts`, meta prompts, pipeline phase tools, and
  `index.ts` are wired for `writerAgent`;
- workspace-service exposes writer project/document bundle methods;
- `/dashboard-ui` and `/workspace-ui` contain a Writer tab;
- English and Polish anti-slop detection;
- continuity conflict detection;
- research delegation taskSpec construction for `researcherAgent`;
- source/claim ledger normalization and unresolved source ref reporting;
- structured writer worker taskSpec construction;
- trusted review request/taskSpec matching and one-use, exact-output worker
  receipts that reject forged, replayed, or manual green reviews;
- monotonic review-contract invalidation for brief/style/section/continuity/
  source/claim changes, `contractRevision` receipts and stale deterministic
  audit rejection through `expectedReviewRevision`;
- transactional dependency writes with their review bump, plus project-owned
  section/source/claim ids that cannot cross project boundaries;
- transactional snapshot save/activation that preserves the previous current
  manuscript on a missing target or failed matched-count fence;
- transactional current invalidation and cross-instance snapshot-version
  allocation protected by an additional full ascending unique index alongside
  the legacy descending non-unique index;
- transactional receipt consumption + audit insert + project fence, per-project
  `auditRevision` ordering, current red/unauthorized-green reopen, and final
  manuscript/review/audit CAS;
- revision accept/rollback decisions that activate the selected persisted
  before/after snapshot, persist the selected snapshot score, require an audit
  for the current manuscript in full projects, atomically commit selection with
  that audit, and block `done` while unresolved even beyond the top-100 window;
- literal-safe atomic project patch values in Mongo aggregation updates;
- full-project quality policy fixed to project language and anti-slop threshold
  of at least 80;
- post-abort `run_worker` cancellation before post-run telemetry, with no inherited
  Workspace tools;
- hard-brief invariants in the Writer prompts;
- incremental document init/write/read/snapshot/export in a temporary
  `WRITER_DOCS_DIR`.

Verified on 2026-06-19 after Sprint 2:

```bash
npx tsc --noEmit --pretty false
npm run check:writer-domain
```

Verified on 2026-06-19 after Sprint 3:

```bash
npm run check:pipeline-reflector
npm run build
```

Verified on 2026-06-19 after Sprint 4:

```bash
npx tsc --noEmit --pretty false
npm run check:writer-domain
npm run check:pipeline-reflector
```

Verified on 2026-06-19 after Sprint 5:

```bash
npx tsc --noEmit --pretty false
npm run check:writer-domain
npm run check:pipeline-reflector
npm run build
```

Targeted deterministic verification after the 2026-08-10 canary fixes:

```bash
npm run check:orchestration-gateway
npm run check:v2-harness-worker
npm run check:writer-domain
npm run check:writer-review-receipts
```

All four targeted checks, the final typecheck and a clean Mastra build passed on
the post-canary snapshot. This is deterministic evidence only; the post-canary
changes have not had a second live Writer run.

The receipt integration specifically proves that an unresolved revision remains
visible behind 100 newer audits, a forced revision-audit insert failure restores
the prior current selection, and concurrent snapshot transactions allocate two
different project versions. It also verifies that file-only synchronization does
not increment `auditRevision` after the atomic selection/audit commit.

### Isolated V2 live canary, 2026-08-10

The canary ran on port `4114` against the separate database
`writer_canary_earned_20260810_040826`. It did not change production routing or
flags and was not a rollout. Job
`job_e41e3729-4dc2-4af6-a828-3a8b97473059` ended `FAILED` fail-closed after
1494 seconds.

The earned-time mechanism behaved as designed:

- initial business window: 15 minutes;
- accepted progress: exactly two 5-minute extensions from snapshots v2 and v4;
- deduplication: v3 and v5 repeated content hashes and earned no time;
- resulting business window: 25 minutes;
- immutable maximum: 45 minutes.

The export contains five chapters and 4,760 words. The checked document,
snapshots and result contain neither U+2014 nor its HTML equivalents. This is not
a domain-quality pass: the blue-thread key appeared in chapter 3 despite the
brief requiring its reveal only in chapter 4. The independent critic remained
at `72/false`; setting the project to `done` was rejected and the project stayed
in `render`, which proves the final gate failed closed.

The run also exposed late tool calls starting after terminalization. That
material tool-start path is now closed deterministically. The harness installs a
Mastra input-step processor that checks abort immediately before actual
`tool.execute`; a real-dispatch regression first proves the same late sentinel
call does execute without the fence, then proves it cannot execute after the
fence authority signal is aborted. Existing configured meta-agent processors are
preserved when the fence is appended. `run_worker` forwards abort, disables inherited Workspace tools and
rethrows cancellation before post-run telemetry. The gateway maps harness
hard-cap and idle-timeout errors to `deadline`.

The trusted review receipts, snapshot activation/restore behavior, unresolved
revision blocker and Hard Brief Invariants described above are also covered by
passing targeted deterministic checks. No second live canary was run. These
fixes therefore do not yet provide fresh live proof, and full Writer parity and
production rollout remain open. Do not repeat the paid canary merely to
reproduce the old result.

A non-cooperative provider promise may still resolve after cancellation, but it
cannot execute a fenced tool. Forcibly terminating that remaining computation
would require process isolation and remains a separate future boundary.

The snapshot-to-file synchronization is currently safe under the deployed
single-instance Writer contract: its per-project mutex is process-local. Before
running multiple Writer processes or replicas against the same project, add a
durable cross-process project lock/fence. Without it, a second process could
change the selected snapshot between the authority check and `writeFile`; DB
completion would still fail closed, but a newer file edit could be overwritten.

## Next Sprints

1. Exercise a live article/report flow through researcherAgent when models and
   web credentials are available.
2. Keep the abort, transactional dependency, record-ownership,
   review/audit-revision, receipt, final-CAS, literal-patch, quality-policy,
   revision and hard-brief regressions green. Run
   another paid live Writer canary only for a materially new question that
   deterministic checks cannot answer.
3. Add process isolation if the system must forcibly terminate non-cooperative
   provider computation rather than only fence its side effects.
4. Add a durable per-project Writer lock before any multi-instance deployment.
5. Add later export formats when needed: EPUB, DOCX, PDF.
