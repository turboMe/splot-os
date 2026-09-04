# Coverage gaps

Schema: agent-baseline/v1  
Report: 67e6eed4-f256-47d2-8017-899eaf9e5edf  
Commit: eff419ee54280fb4f517d56833ab8b772fbf485b

## Blocking gaps

- Meta-mediated route coverage is 0/18. A faithful run needs a test-owned sanitized HTTP runtime, safe registry imports, isolated stores and an autonomous completion consumer.
- Restart recovery and crash-window injection were not run because no test-owned worker/runtime lifecycle was available.
- Autonomous wake and exactly-once pending delivery were not run; current custom path has no autonomous consumer to exercise safely.
- No tool-level live fixture was run. Static inventory covers 309 entries, but cancellation, kill and post-timeout side effects remain unmeasured for individual tools.

## Agent gaps

- weatherAgent: Direct smoke was skipped because configured sampled scorers include a Google LLM judge and could incur paid external evaluation.
- metaAgent: A faithful direct smoke imports the full registry and can activate MCP discovery, workspace, telemetry and multi-collection harness effects; no isolated sanitized HTTP runtime was available.
- producerHuntDiscoveryAgent: Workflow-only helper requires a synthetic producer workflow fixture; configured cloud fallback would be nonlocal.
- producerHuntEnrichmentAgent: Workflow-only helper requires a synthetic producer workflow fixture; configured cloud fallback would be nonlocal.
- producerHuntEmailExtractionAgent: Workflow-only helper requires a synthetic producer workflow fixture; configured cloud fallback would be nonlocal.
- producerHuntDraftAgent: Workflow-only helper requires a synthetic producer workflow fixture; configured cloud fallback would be nonlocal.
- producerHuntJsonRepairAgent: Workflow-only helper requires a synthetic producer workflow fixture; configured cloud fallback would be nonlocal.
- producerHuntCloudFallbackAgent: Workflow-only cloud fallback is explicitly nonlocal and was prohibited.
- automationArchitect: Tool search, pending processing and mutating automation surfaces require a fully isolated runtime and stores.
- n8nMcpEngineer: MCP import/tool discovery can spawn subprocesses and contact n8n; no disposable complete runtime was available.
- codingAgent: Workspace and subprocess tools require a disposable worktree and process sandbox outside the report directory.
- codeReviewAgent: Review smoke needs a disposable worktree and artifact fixture.
- securityReviewAgent: Review smoke needs a disposable worktree and artifact fixture.
- performanceReviewAgent: Review smoke needs a disposable worktree and artifact fixture.
- knowledgeAgent: Unguarded top-level MCP/toolset discovery can create credentials or spawn npx; import was not considered safe.
- researcherAgent: MCP/network discovery is not bounded to local read-only fixtures.

## Measurement gaps

- Only 1/12 memory fingerprints was dynamically exercised.
- Generate/stream parity is narrow: Sales with one local 12b configuration; Meta and all other channels are unmeasured.
- Timing n is below 10 for every agent; p95 is orientation only. TTFT, queue wait, delivery latency and event-loop lag were not captured.
- Ten repeated empty-output agents need instrumented SDK/provider traces to localize the cause; the current evidence establishes the symptom only.
- Mongo replica-set transactions, multiple workers, process restart and network partition behavior were not available.

## Unsafe package-script inventory

The preflight classified 47 matching package scripts: 21 conditionally safe and 26 unsafe. Every unsafe item has a NOT_RUN record in test-runs.jsonl with its source-derived reason. The missing local tsx executable is separately recorded as TST-001; no installation or dependency change was made.

## Source-status policy

- observed: direct process/log/database evidence captured during this report.
- static_analysis: pinned repository or installed-framework source.
- inferred: conclusion derived from observations/static evidence, never presented as runtime fact.
- unknown, not_run, blocked: retained explicitly; no success imputed.
