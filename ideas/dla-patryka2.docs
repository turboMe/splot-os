# Mastra Agentic Environment — Dokument referencyjny (dla Patryka)

> Stan na: **2026-05-09**
> Repo: `/projekty/mastra-agentic-environment/agentic-agents/`
> Cel dokumentu: jeden źródłowy obraz tego, **co system już potrafi**, **z czego się składa** i **co można na nim zbudować jako spersonalizowane narzędzia / workflowy klienta**.
> Ten dokument jest do czytania przez Ciebie + do podawania LLM-om jako kontekst do researchu nowych pomysłów.

---

## 1. Czym jest ten projekt — w jednym akapicie

To autonomiczne, multi-domenowe środowisko agentów AI zbudowane na frameworku **Mastra** (TypeScript), które:

- **samo się naprawia** (auto-healing pipeline z worktree, code review, deploy/verify),
- **samo pisze kod w repozytorium** (codingAgent z subtaskami, parallel dispatch, smart routing modeli),
- **samo buduje automatyzacje n8n** (automationArchitect z Pattern RAG, walidacją, deployem),
- **samo zarządza pamięcią operacyjną** (Observational Memory, Failure Brain, system_knowledge),
- **dynamicznie wybiera modele LLM** w zależności od trudności taska, budżetu VRAM i kosztu (lokalne Ollama → cloud-free OpenRouter → płatny cloud),
- **ma rejestr "skilli"** (markdownowych procedur), które agent ładuje semantycznie (RAG) zamiast wpychać wszystko do promptu,
- **logguje siebie** (agent_events, dashboard agenta dostępny pod `/dashboard-ui`),
- **ma warstwę bezpieczeństwa** (Terminal Safety Guard, Secrets Redactor, request_approval gating).

Dlaczego to ważne dla Twojego planu sprzedażowego: środowisko jest tak zaprojektowane, że **kopiujesz repo, podmieniasz dane klienta + skille domenowe i dostajesz "spersonalizowanego pracownika AI"**. Trzon (router, autoheal, memory, tools framework) zostaje. Zmienia się tylko warstwa biznesowa (skille + agenci domenowi + workflowy + integracje).

---

## 2. Architektura wysokopoziomowa

```
                         ┌─────────────────────────────────────┐
       USER ──────────►  │        META-AGENT (orchestrator)    │
                         │  Gemini 2.5 Flash + ToolSearchProc  │
                         │  + Observational Memory + Working   │
                         │    Memory + sharedMemoryProcessor    │
                         └──┬──────────┬─────────────┬─────────┘
                            │          │             │
                ┌───────────▼─┐  ┌─────▼─────┐  ┌────▼──────────┐
                │ delegate    │  │ run_worker│  │ trigger        │
                │ _task       │  │ (ad-hoc   │  │ _workflow      │
                │ (experts)   │  │  LLM)     │  │ (DAG steps)    │
                └──┬──────────┘  └───────────┘  └───────────────┘
                   │
       ┌───────────┼───────────────────────────────────────────┐
       ▼           ▼            ▼            ▼          ▼      ▼
   marketing   sales        analytics    automation   coding  crm
    Agent      Agent          Agent      Architect    Agent   Agent
   (Gmail,    (CRM,           (n8n       (n8n full,   (worktree, (read-only)
    RSS,       Calendar,      monitoring, Pattern RAG, repo idx,
    NotebookLM, Gmail)        signals)    deploy)     subtasks)
    Tavily)

   ↓ (dla coding agent)
   ┌──────────────────────────────────────────────────┐
   │  Smart Router → assignedModel + parallelGroup    │
   │  Parallel Dispatch → subtask-executor (role)     │
   │  Roles: file-editor | terminal | qa | researcher │
   │  Skill Registry → załaduj procedurę              │
   └──────────────────────────────────────────────────┘

   ↓ (warstwa pamięci, używana przez wszystkich kluczowych agentów)
   ┌──────────────────────────────────────────────────┐
   │  Mastra Memory (lastMessages + ObservationalMem) │
   │  shared_memory (TTL 24h, sygnały)                │
   │  system_knowledge (8 typów, embeddingi)          │
   │  agent_events (telemetry — własna)               │
   │  Failure Brain (autoheal_recipe + failure_case)  │
   └──────────────────────────────────────────────────┘

   ↓ (storage)
   ┌──────────────────────────────────────────────────┐
   │  MongoDB (default) + DuckDB (observability)      │
   │  SQLite (.mastra/repo-index.db — Tree-sitter)    │
   └──────────────────────────────────────────────────┘
```

**Wejścia / wyjścia HTTP:**
- `http://localhost:4111` — Mastra Studio (UI testowe)
- `http://localhost:4111/dashboard-ui` — dashboard agentów (success rate, koszt, latencja, scorery)
- `/deploy/health`, `/deploy/gpu-status`, `/deploy/model-status`, `/deploy/cloud-free-status`, `/deploy/auto-heal-status`, `/deploy/github-status`, `/deploy/crash-test`
- `/dashboard/overview|agents|skills|models|latency|cost|scores|timeline`

---

## 3. Lista zarejestrowanych agentów

Plik: [src/mastra/index.ts](src/mastra/index.ts) (sekcja `agents:`), modele: [src/mastra/config/model-manifest.ts](src/mastra/config/model-manifest.ts).

| Agent | Model domyślny | Rola | Najważniejsze tools |
|---|---|---|---|
| **metaAgent** | `gemini-2.5-flash` | Orchestrator. Routuje, deleguje, używa ToolSearchProcessor (~50 narzędzi RAG). | `delegate_task`, `run_worker`, `trigger_workflow`, `request_approval`, `memory_recall`, `memory_write`, `skill_search`, `searchLeads`, shared memory, current_time |
| **codingAgent** | `claude-sonnet-4.6` | Kodowanie w repo. Diagnose + execute patch, worktree, tracked writes. | `coding.create_artifact`, `update_artifact`, `init_worktree`, `apply_worktree_patch`, `writeFileTracked`, `runTestCommand`, `repo.map`, `code.search`, skill_load, memory_recall |
| **codeReviewAgent** | `gemini-2.5-flash` | Recenzja PR/patcha (verdict: approve/needs_changes/block). | `getCodeTaskArtifact`, `submitReview`, `worktreeDiff`, `readWorktreeFile` |
| **automationArchitect** | `gemini-2.5-pro` | Projektowanie, walidacja, deploy n8n workflows. | n8n full set, `riskScoring`, `pattern-rag` (matchPattern, syncPatterns), `composeWorkflow`, `validateWorkflow`, `testWorkflow`, `repairWorkflow`, `deployAutomation`, `activateAutomation`, `request_approval` |
| **marketingAgent** | `gpt-5.3-mini` | Polski copywriting, cold-email, RSS digest, Gmail drafts. | Gmail (search, create draft, list drafts, get, update, delete), CRM (create/update lead, add interaction, record draft), RSS, Tavily (search/findCompanyLinks), NotebookLM |
| **salesAgent** | `gemma4-26b` (lokalny) | Pipeline CRM, propozycje, onboarding, scheduling. | CRM (search/update status/add interaction), Gmail draft tools, Calendar (create/find), shared memory |
| **analyticsAgent** | `qwen3-coder-30b` (lokalny) | KPI, ROI, anomalie, monitoring n8n, raporty. | n8n monitoring, shared memory (read+signals), `agent_performance_report` |
| **crmAgent** | `gemma4-26b` (lokalny) | Szybkie wyszukiwanie leadów (read-only). | `crm.search_leads` |
| **weatherAgent** | `gemini-2.5-pro` | Demo / placeholder. | `weather-tool` |
| Producer-hunt sub-agents | `gemini-2.5-flash` | Discovery, enrichment, draft, JSON repair, fallback. | scoped per workflow |

**Kluczowy paragraf:** Meta-agent **NIE zna wszystkich tooli na wejściu**. Ma `ToolSearchProcessor` z pulą ok. 50 narzędzi (CRM write, Gmail, Calendar, Sheets, Slides, Chef, RSS, NotebookLM, Tavily, Mongo R/W) — i sam je dociąga semantycznie podczas kroków. To zmniejsza prompt o ~70%.

---

## 4. Mechanizmy delegacji — kiedy co używać

### 4.1 `system.delegate_task` — do EXPERTÓW
Hand-off do gotowego agenta z jego osobowością, narzędziami, pamięcią. Używaj kiedy zadanie wymaga **stacka narzędzi eksperta** (np. Gmail + CRM + Calendar = salesAgent).

Mapowanie domen:
- `marketingAgent` → polski copy, cold-mail, producer-hunt, RSS digest, Gmail drafts
- `salesAgent` → CRM pipeline, propozycje, onboarding, meeting scheduling
- `analyticsAgent` → KPI, ROI, anomalies, n8n monitoring
- `automationArchitect` → projekt n8n, Pattern RAG, deploy z guardrails
- `crmAgent` → szybki lookup leada (lokalny model)
- `codingAgent` → praca w repo: read/search, patche, safe verification

### 4.2 `system.run_worker` — do ad-hoc TASKÓW
Spawn "pustego" LLM workera z briefem od meta-agenta. Bez osobowości, bez tooli, bez pamięci — czyste text-in / text-out.

**Presety modeli** ([config/model-manifest.ts](src/mastra/config/model-manifest.ts)):
- `fast` → `gemma4:e4b` — klasyfikacja, ekstrakcja JSON, reformat
- `default` → `gemma4:26b` — polski copy, podsumowania
- `reasoning` → `magistral-24b` — analiza, math, code, planning
- `powerful` → `gemma4:26b` — long-form, kreatywne
- `cloud` → `gemini-2.5-flash` — fallback chmurowy

Worker może dostać `skills: [...]` — załaduje procedurę z Skill Registry i wstrzyknie do promptu.

Workery można odpalać **N równolegle** — np. "streszcz 5 artykułów po polsku" = 5 × `run_worker(fast)` w jednym batchu (zob. [docs/META-AGENT-PATTERNS.md](docs/META-AGENT-PATTERNS.md), Scenariusz 3).

### 4.3 `system.trigger_workflow` — do PROCESÓW WIELOKROKOWYCH
Uruchom zarejestrowany workflow Mastry (DAG). Stan, retry, branching — natywne.

### 4.4 Smart Router (dla codingAgent)
Plik: [src/mastra/services/smart-router.ts](src/mastra/services/smart-router.ts).
Przy diagnozie codingAgent dzieli pracę na subtaski. Router:
1. Liczy `estimatedComplexity` każdego subtaska
2. Sprawdza VRAM budget + GPU snapshot (live `nvidia-smi`)
3. Sprawdza Circuit Breaker (czy model nie pada serią)
4. Sprawdza Budget Tracker (cloud-free dzienny limit)
5. Przydziela `assignedModel` i `parallelGroup`
6. `parallel-dispatch.ts` odpala równoległe grupy

Tier modeli ([config/model-capabilities.ts](src/mastra/config/model-capabilities.ts)):
1. `local-micro` (qwen3:1.7b)
2. `local-light` (gemma3:4b, gemma4:e4b)
3. `local-heavy` (qwen3-coder:30b, gemma4:26b)
4. `cloud-free` ★ (OpenRouter free)
5. `cloud-fast` (GPT-5.3 Mini, Gemini Flash)
6. `cloud-pro` (Gemini 2.5 Pro, Sonnet 4.6, Opus 4.7)

### 4.5 SubAgent roles (Phase 3 — flat hierarchy)
Plik: [src/mastra/config/subagent-roles.ts](src/mastra/config/subagent-roles.ts).
Każdy subtask z planu codingAgent dostaje rolę:
- `file-editor` (edit/create/refactor/fix/patch)
- `terminal` (test/build/install/run)
- `qa` (verify/lint/review/check/validate/e2e)
- `researcher` (research/browse/scrape/search)

Każda rola ma whitelist tooli (least privilege) + preferowany model tier + skille pre-loadowane z rejestru.

---

## 5. Mapa narzędzi (tools)

Plik: [src/mastra/tools/](src/mastra/tools/). Sumarycznie ~60 narzędzi w 14 domenach:

### `architect/` — n8n workflow builder
- `pattern-rag` (syncPatterns, matchPattern) — 43 wzorce w Mongo, embedding match
- `composer` (composeWorkflow) — buduje JSON workflow
- `risk-scoring` — ocenia ryzyko deployu
- `validation/validation-tool` — walidacja workflowa
- `testing/test-workflow`, `testing/repair-workflow`
- `deploy`, `activate`, `runtime-check`
- `credentials/credential-tools`, `skills-search`, `pattern-catalog`

### `business/` — analiza biznesowa
- `competitor-analysis`

### `chef/` — domena gastronomiczna (16 tooli)
Zarządzanie projektami menu: `chef.start_project`, `update_profile`, `generate_menu`, `draft_recipe`, `iterate_menu`, `save_menu`, `query_knowledge`, `suggest_pairing`, `check_seasonal`, `add_note`, `search_notes`, `export_menu`. Cały moduł jako wzorzec, jak budować "domenę klienta".

### `communication/` — outbound notyfikacje
- `telegram` (send_message, send_alert, send_document)
- `webhook` (generic + Slack + Discord presetty)

### `crm/` — wewnętrzny CRM (Mongo)
- `search_leads`, `create_lead`, `update_status`, `update_lead`, `add_interaction`, `record_email_draft`

### `dev/` — coding stack
- `code-task-artifacts` (createArtifact, updateArtifact, getArtifact, runTestCommand, submitReview)
- `code-change-ledger` (writeFileTracked + accept/reject all/per-file + recordBefore/After)
- `code-worktree` (init, remove, apply_patch, list_files, read_file, diff)
- `external-projects-tools` (createExternalProject, writeFile, runCommand, delegateToReviewer)
- `repo-map-tools` (repo.map, repo.stats, repo.reindex)
- `code-search-tools` (code.search semantic, embed stats)

### `google/` — Workspace
- Gmail: search, createDraft, updateDraft, listDrafts, getDraft, sendDraft (approval-gated), deleteDraft
- Calendar: createEvent, findEvent, updateEvent, deleteEvent
- Sheets: createSpreadsheet, readRange, writeRange, appendRows, getMetadata
- Slides: createPresentation, getMetadata, addSlide, replaceText, addTextBox, deleteSlide

### `knowledge/` — NotebookLM (przez subprocess klienta)
- `knowledge.query`, `query_multi`, `list_notebooks`, `create_notebook`, `add_source`, `delete_notebook`, `research_start`

### `memory/` — shared memory
- `shared_memory.add_context`, `list_context`, `push_signal`

### `n8n/` — operacje na n8n
- `n8n.health`, `list_workflows`, `get_workflow`, `trigger_webhook`

### `rss/` — feedy
- `rss.get_articles`, `get_digests`, `search_articles`, `create_digest`, `list_sources`

### `search/` — Tavily
- `search_web`, `find_company_links`

### `system/` — orkiestracja, pamięć, recall
- `delegate_task`, `run_worker`, `trigger_workflow`, `request_approval`
- `memory_recall`, `memory_write` (system_knowledge — 8 typów wiedzy)
- `recall_worker_lessons` (signals)
- `skill_search`, `skill_load`, `skill_report`
- `mongo_query`, `mongo_write` (write requires confirm: true)
- `agent_performance_report`
- `current_time`

### `terminal/` — sandbox shell
- `fs.read_file`, `fs.list_dir`, `terminal.exec` (z `terminal-safety-guard`)

---

## 6. Workflows (Mastra DAG)

Plik: [src/mastra/workflows/](src/mastra/workflows/). Zarejestrowane w `index.ts`:

| Workflow | Cel | Triggery / use-case |
|---|---|---|
| `repoMaintenanceWorkflow` | Self-healing kodu: diagnose → execute patch → review (max 3 iter). | Auto-trigger z ErrorCollector lub manualny przez metaAgent. |
| `producerHuntWorkflow` | Discovery + enrichment + email extraction + draft kolejnych producentów żywności. | Cron / manualny. |
| `weeklyContentWorkflow` | Tygodniowy digest: research → copy PL → translate EN → JSON repair. | Cron. |
| `morningBriefingWorkflow` (marketing) | Przegląd inboxa + leadów + CRM stanu. | Codzienny rano. |
| `automatedFollowupWorkflow` (marketing) | Follow-up do leadów. | Cron. |
| `inboxMonitorWorkflow` (marketing) | Monitoring Gmaila. | Co X minut. |
| `syncCrmWorkflow` (marketing) | Sync CRM ↔ external. | Cron. |
| `weeklyReportWorkflow` (analytics) | Raport tygodniowy KPI. | Cron. |
| `roiCalculatorWorkflow` (analytics) | Liczy ROI kampanii. | On-demand. |
| `trendAnalysisWorkflow` (analytics) | Analiza trendów. | Cron / on-demand. |
| `proposalGeneratorWorkflow` (sales) | Generowanie propozycji handlowej. | On-demand. |
| `meetingSchedulerWorkflow` (sales) | Umawia meetingi. | On-demand. |
| `onboardingChecklistWorkflow` (sales) | Checklist dla nowego klienta. | On-demand. |
| `weatherWorkflow` | Demo. | — |

---

## 7. Skill Registry — 80+ procedur w `_skills/`

Plik silnika: [src/mastra/services/skill-registry.ts](src/mastra/services/skill-registry.ts). Tools: `skill_search`, `skill_load`, `skill_report`.

Każdy skill = `*.md` z YAML frontmatter (name, description, category, keywords, allowedTools, minComplexity, estimatedTokens, outputFormat, tags, version, successRate, totalUses, lastUsed, author).

Embeddingi liczone na starcie → `skill_search` zwraca top-K po cosine similarity → agent ładuje przez `skill_load(name)` → po wykonaniu raportuje przez `skill_report(success: boolean)` → success_rate trafia z powrotem do frontmattera.

### Co już jest w `_skills/`

**`coding/` (~38 skilli)** — api-tester, bash-standards, browser-form-filling, browser-login-flow, cli-creator, data-cleaning-patterns, diagram-creator, doc-parser, docx-manipulation, e2e-testing-playwright, fix-typescript-error, frontend-design (Anthropic anti-AI-slop), gh-fix-ci, google-workspace-integration, integration-testing, mcp-builder (+ reference: best practices, node/python servers, evaluation), md-to-office, office-to-md, pdf-extraction, pdf, playwright-browser-automation, run-verification, safe-file-edit, screenshot, security-best-practices (+ stack-specific: Express, Next.js, React, Vue, Django, FastAPI, Flask, jQuery, Golang), sql-optimizer, test-generator, webapp-testing, web-scraper, xlsx-manipulation.

**`devops/` (9)** — cicd-pipeline, cloud-run-deploy, database-safety-policy, docker-helper, infrastructure-as-code, k8s-helper, log-analyzer, migration-planner, otel-instrumentation.

**`meta/` (~10)** — acceptance-criteria-builder, agent-performance-analysis, ambiguity-resolver, competitor-analysis-strategy, email-communication-strategy, market-research-methodology, prompt-tester, **skill-creator** (meta-skill: tworzenie nowych skilli, z pod-agentami analyzer/comparator/grader), web-research-strategy.

**`n8n/` (6)** — n8n-common-patterns, n8n-expression-syntax, n8n-node-catalog, n8n-security-checklist, n8n-security-review, n8n-workflow-rules.

**`security/` (6)** — agentic-actions-auditor, dependency-vulnerability-scan, license-compliance, mcp-server-risk-auditor, prompt-injection-defense, secrets-redaction, terminal-safety-guard.

**`terminal/` (7)** — agentic-terminal-problem-solving, code-modification-agent, git-conflict-resolver, nodejs-dependency-fixer, swe-repo-explorer, terminal-code-dev, yeet.

**`n8n-blocks/` (13)** — triggers/processors/outputs/utilities (klocki do generowania workflow n8n).

> Większość skilli jest zaadaptowana z repo Anthropica, OpenAI, claude-office-skills i innych — patrz [docs/SKILLS-IMPORT.md](docs/SKILLS-IMPORT.md). Format kompatybilny z [agentskills.io spec](https://agentskills.io/specification).

**Możesz pisać własne skille** — `meta/skill-creator` jest meta-skillem do generowania skilli. To dosłownie znaczy "system buduje sam swoje skille".

---

## 8. Pamięć systemu — 4 warstwy

### 8.1 Mastra Memory (per agent)
- `lastMessages: 30` (meta, coding) / 20 (architect) / 15 (marketing, sales) / 10 (analytics)
- **Observational Memory** włączone na metaAgent + codingAgent (Phase 1.1, 1.1b) — Observer + Reflector kompresują starą historię w obserwacje, model `gemini-2.5-flash`, `temporalMarkers: true`.
- **Working Memory** dla metaAgent — persistent scratchpad z preferencjami usera, kontekstem projektu, learned patterns.

### 8.2 `shared_memory` (TTL 24h)
Tools: `add_context`, `list_context`, `push_signal`. Plus `sharedMemoryOutputProcessor` na metaAgent — automatycznie zapisuje kluczowe decyzje po każdej odpowiedzi.

### 8.3 `system_knowledge` (Phase 1.4)
Tools: `memory_recall`, `memory_write`. 8 typów wiedzy:
- `failure_case` — błędy + jak je naprawiono
- `coding_pattern` — sprawdzone strategie kodowania
- `autoheal_recipe` — udane przepisy autoheal
- `tool_contract` — reguły użycia toola odkryte z błędów
- `prompt_rule` — insighty optymalizacji promptów
- `user_preference` — preferencje usera
- `project_fact` — fakty/constrainty projektu
- `architecture_decision` — decyzje + uzasadnienia

Każdy item: tytuł, summary, evidence, resolution, confidence, source, embedding. Recall odnowienie TTL — przydatna wiedza nie wygasa.

### 8.4 Failure Brain (Phase 2.1)
Plik: [src/mastra/lib/failure-brain.ts](src/mastra/lib/failure-brain.ts).
**Przed** triggerem workflow autoheal: `recallKnowledge(error, type='failure_case')` + `recallKnowledge(error, type='autoheal_recipe')` → wstrzykuje "known similar failures" do promptu workflowa.
**Po** rozwiązaniu ticketu: `writeKnowledge('autoheal_recipe', fix details)` — system uczy się z każdej naprawy.

### 8.5 `agent_events` — telemetry (Phase Faza 7.6)
Plik: [src/mastra/lib/agent-event-log.ts](src/mastra/lib/agent-event-log.ts). Loguje każdy istotny event agenta (delegacja, run_worker, tool call, error, retry, outcome). Czytane przez Dashboard pod `/dashboard-ui`.

---

## 9. Self-healing — jak naprawia się sam

Plik: [src/mastra/services/error-collector.ts](src/mastra/services/error-collector.ts) + [src/mastra/services/global-error-handler.js](src/mastra/services/global-error-handler.js) + [src/mastra/workflows/repo-maintenance.ts](src/mastra/workflows/repo-maintenance.ts).

```
Błąd runtime ──► global-error-handler / proces uncaughtException
   │
   ▼
ErrorCollector.reportError()
   │  ├─ deduplikacja (signature)
   │  ├─ Failure Brain recall (failure_case + autoheal_recipe)
   │  └─ tworzy ticket w Mongo (auto_healing_tickets)
   ▼
trigger workflow `repoMaintenanceWorkflow`
   │
   ├─► STEP 1a: diagnose-and-plan (codingAgent z promptem coding/diagnose)
   │     └─ artifact w Mongo (code_task_artifacts)
   │     └─ smart-router: routeSubtasks(plan.subtasks) → assignedModel + parallelGroup
   │
   ├─► STEP 1b: execute-patch
   │     ├─ init worktree
   │     ├─ parallel-dispatch (max N grup równolegle)
   │     ├─ subtask-executor (rola + skill + zawężony toolset)
   │     ├─ tracked writes (writeFileTracked → recordBefore/After → accept/reject)
   │     └─ runTestCommand (z Terminal Safety Guard)
   │
   ├─► STEP 2: review (codeReviewAgent → verdict approve/needs_changes/block)
   │     └─ jeśli needs_changes: cofa do executePatch (max 3 iter)
   │
   ├─► STEP 3: deploy (blue/green — zob. docs/BLUE-GREEN-DEPLOYMENT.md)
   │
   └─► resolveTicket() → writeKnowledge('autoheal_recipe', ...) — Failure Brain się uczy
```

**Kluczowe gwarancje:**
- Worktree → izolacja zmian od mastera.
- Tracked writes → łatwy rollback, code-change-ledger w Mongo.
- Code Review jako bramka jakości — automatyczna.
- Terminal Safety Guard → 22 reguły BLOCK + 12 CONFIRM.
- request_approval — destruktywne akcje wymagają zatwierdzenia (z Mastra Studio lub przez UI).

---

## 10. Smart Router + modele

Konfig: [src/mastra/config/model-manifest.ts](src/mastra/config/model-manifest.ts), [src/mastra/config/model-capabilities.ts](src/mastra/config/model-capabilities.ts).

### Modele lokalne (Ollama)
qwen3:1.7b, gemma3:4b, gemma4:e4b, qwen3.5-9b, **qwen3-coder:30b**, **gemma4:26b**, phi4-reasoning:14b, magistral:24b.

### Modele cloud (płatne)
- Google: Gemini 2.5 Pro / Flash / 2.0 Flash / 2.0 Flash Lite + Imagen 4 + Veo 3.1 + Chirp-3 + TTS Flash
- OpenAI: GPT-5.5, 5.3-mini, 5.1, 4.1 (+ mini, nano), o3, o3-mini, o4-mini + Whisper + TTS-1, GPT Image 2, Realtime
- Anthropic: Claude Opus 4.7, Sonnet 4.6, Haiku 4.6, Haiku 4.5

### Modele cloud-free (OpenRouter — Phase 4.1)
nemotron-super-free (120B, 262k ctx), nemotron-nano-free (30B), laguna-free (Poolside coding), ring-free (1T), minimax-free, glm-free (4.5 Air), gpt-oss-120b-free, gpt-oss-20b-free.

Aktywuje się po ustawieniu `OPENROUTER_API_KEY`. Limit: 50 req/dzień bez kredytu, **1000 req/dzień po wykupieniu min. $10**.

### Guard rails routera
- **Circuit Breaker** ([services/circuit-breaker.ts](src/mastra/services/circuit-breaker.ts)) — 3 fail w rzędzie → blokada modelu na 5 min.
- **Budget Tracker** ([services/budget-tracker.ts](src/mastra/services/budget-tracker.ts)) — domyślnie 200 req/dzień na cloud-free.
- **GPU Guard** ([services/gpu-guard.ts](src/mastra/services/gpu-guard.ts)) — live `nvidia-smi`, blokuje load modelu jeśli VRAM by się przepełnił.
- **Model Availability** ([services/model-availability.ts](src/mastra/services/model-availability.ts)) — startup check.
- **Eskalacja**: cloud-free → cloud-fast → cloud-pro.

---

## 11. Repo Indexing (Phase 5) — kontekst kodu

Plik: [src/mastra/services/repo-indexer.ts](src/mastra/services/repo-indexer.ts).

```
SCAN → DIFF → PARSE (Tree-sitter) → EXTRACT symbols → GRAPH → RANK (PageRank) → RENDER
```

- SQLite cache w `.mastra/repo-index.db` — tylko zmienione pliki re-indeksuje (porównanie SHA-256).
- Tools: `repo.map` (mapa repo z najważniejszymi symbolami wg PageRank), `repo.stats`, `repo.reindex`.
- **Semantic Code Search** ([tools/dev/code-search-tools.ts](src/mastra/tools/dev/code-search-tools.ts)) — embedding-based search w kodzie.
- **TokenLimiterProcessor** na codingAgent — limit 120K tokenów (efektywny dla Gemini Flash).
- **Context Assembler** ([services/context-assembler.ts](src/mastra/services/context-assembler.ts)) — buduje optymalny kontekst kodu pod task.
- **Context Checkpoints** ([services/context-checkpoint.ts](src/mastra/services/context-checkpoint.ts)) — snapshot stanu pomiędzy fazami.

---

## 12. Bezpieczeństwo

### Terminal Safety Guard ([lib/terminal-safety-guard.ts](src/mastra/lib/terminal-safety-guard.ts))
- 22 reguły **BLOCK**: `rm -rf /`, `dd`, `mkfs`, fork bombs, `shutdown`, `DROP DATABASE`, `curl | bash`, exfil ENV, dostęp do SSH keys, `.env`...
- 12 reguł **CONFIRM**: warning + execute z notką
- Default **ALLOW**
- Workspace-safe paths (`/projekty/`, `/tmp/sandbox`, `node_modules/`, `dist/`, `build/`) mają złagodzone reguły.

### Secrets Redactor ([lib/secrets-redactor.ts](src/mastra/lib/secrets-redactor.ts))
20+ typów: OpenAI/Anthropic/Google/AWS/Stripe/GitHub/Slack/Telegram/SendGrid/OpenRouter keys, Bearer/Basic/JWT, env vars, `://user:pass@host`. Plus `SensitiveDataFilter` w obserwability spans.

### Approval gating
`request_approval` tool + sendDraft (Gmail) + deployAutomation (n8n) wymagają potwierdzenia człowieka.

---

## 13. Stan dojrzałości faz (zrealizowane)

| Faza | Status | Co dostarczone |
|---|---|---|
| 0 | ✅ | Bugfix + hardening (TTL indexes, expiresAt types) |
| 1 | ✅ | Operational Memory (OM dla meta + coding, system_knowledge, recall/write) |
| 2 | ✅ | Failure Brain + Skill Registry (z embeddingami, success rate w frontmatter) |
| 3 | ✅ | Coding Hierarchy (flat: file-editor, terminal, qa, researcher) |
| 4 | ✅ | Cloud Free Tier (OpenRouter + Circuit Breaker + Budget Tracker) |
| 5 | ✅ | Repo Indexing (Tree-sitter, PageRank, semantic code search) |
| F1 | ✅ | Safety Layer (Terminal Guard + Secrets Redactor) |
| F5 | ✅ | Communication Integrations (Telegram, Slack, Discord webhooks) |
| 7.6 | ✅ | Agent Evaluation Dashboard (`/dashboard-ui`) |

Co JESZCZE jest do zrobienia (z `ideas/`): Agent Event Log jako pierwszorzędna kolekcja typowana, Memory Extractor (z eventów → wiedza automatycznie), wyspecjalizowane sub-agenty (TerminalAgent, FileEditor, QA jako osobne pliki — obecnie mamy ich jako role), Obsidian mirror (do zrobienia po pamięci operacyjnej), GraphRAG/LightRAG (dopiero gdy zwykły vector recall przestanie wystarczać), prompt contract compiler (review promptów agentów).

---

## 14. Co możesz na tym zbudować — paleta pomysłów

### 14.1 Spersonalizowane "produkty" dla klientów (Twoja docelowa monetyzacja)
Kopiujesz repo → dostosowujesz warstwę biznesową:
1. **Agentic SDR** (sales development rep) dla danej branży: marketingAgent + salesAgent + automationArchitect + skille branżowe + integracje (HubSpot/Pipedrive/Close zamiast wewnętrznego CRM) + workflowy daily-briefing/follow-up/proposal-generator. Wszystko już jest — wystarczy podpiąć dane klienta.
2. **Agentic Restaurant Manager** — tu już masz cały moduł `chef/` (16 tooli, projekty menu, wiedza, sezonowość). Plug + UI.
3. **Agentic DevOps Buddy** — codingAgent + repo-maintenance + skille `devops/` (cicd, cloud-run, k8s, docker, otel) + integracja z GitHub/GitLab + alerty Telegram.
4. **Agentic n8n Builder-as-a-Service** — automationArchitect + Pattern RAG + 13 n8n-blocks + skille n8n + deploy z guardrails. Klient mówi po polsku co chce, dostaje gotowy workflow.
5. **Agentic Content Studio** — weeklyContent + producer-hunt + RSS + NotebookLM + Tavily + skille `meta/` (web-research-strategy, market-research-methodology) + Imagen 4 + TTS Flash.
6. **Agentic CRM Brain** — wewnętrzny CRM + Gmail + Calendar + analyticsAgent + dashboard agentów + Failure Brain dla zachowań klientów.

### 14.2 Konkretne meta-zadania, które możesz dawać meta-agentowi już dziś
- "Zbuduj nowy skill `xyz` w domenie `abc` używając meta/skill-creator"
- "Wygeneruj n8n workflow dla [opis], użyj Pattern RAG i deploy z approval"
- "Przeszukaj system_knowledge: jakie failure_case dotyczyły TypeScript w tym tygodniu, streszcz"
- "Sklonuj agenta marketingAgent jako `realestateAgent` z innym promptem, podstaw integrację z OtoDom"
- "Codziennie o 7:00 odpalaj morningBriefing + sprawdź status n8n + alert na Telegram jeśli coś padło" → użyj `/schedule` skilla harness'u
- "Zaplanuj refaktor X — diagnose-and-plan, ale NIE wykonuj patcha; pokaż mi plan do akceptacji"
- "Zbuduj nowego agenta domenowego dla `<branża>` — załóż plik, zarejestruj w index.ts, dobierz tools, napisz prompt"

### 14.3 Co warto dorobić strategicznie (z `ideas/future-feature-agentic-mastra-system.md`)
Kolejność wg notatki audytora (i ja się z nią zgadzam):
1. **Typowany `agent_events`** jako pierwszorzędne źródło prawdy operacyjnej (już mamy `agent-event-log.ts`, ale wzmocnić schema i pokrycie wszystkich tool calli + decyzji routera).
2. **Memory Extractor** — background job, który z `agent_events` i `mastra_messages` (190 rekordów już jest) wyciąga `failure_case`, `coding_pattern`, `prompt_rule` automatycznie. Obecnie `system_knowledge` rośnie tylko gdy ktoś wywoła `memory_write`.
3. **Wzmocnienie Failure Brain** — dodać scoring skuteczności recipe i ranking po użyciu (mamy success_rate na skillach, brakuje na recipes).
4. **Obsidian mirror** — eksport `system_knowledge` + dziennych raportów z dashboardu jako markdown w vaulcie (do przeglądania przez człowieka).
5. **Agent Black Box Recorder** — `agentBlackBox.recordRun / explainRun / findBadToolUse / compareRuns`. Mastra ma już tracing, więc to jest cienka warstwa view-modelu.
6. **Prompt Contract Compiler** — review promptów agentów (`promptCompiler.reviewAgentPrompt / generateEvalCases / detectContradictions`) — zacznie być potrzebne przy 10+ agentach, żebyś nie dryfował.
7. **Subagenty z własnym RAG-iem** (Twój pomysł z notatki) — `RepoExplorer`, `TerminalWorker`, `FileEditor`, `QA`, `Reviewer` z własnymi mini-RAGami nad strukturą projektu klienta. Już mamy role + skille — dorobić "prywatny knowledge slice" per role.
8. **GraphRAG (LightRAG / Qdrant)** — dopiero gdy Mongo + bge-m3 zacznie boleć przy >10K wpisów wiedzy.

---

## 15. Operacyjna ściąga — gdzie co kliknąć

```bash
# Start wszystkiego
nvm use && npm install
cp .env.example .env   # uzupełnij klucze (OPENAI/ANTHROPIC/GOOGLE/OPENROUTER/TAVILY/...)
npm run mongo:up
npm run n8n:up
npm run tunnel:up
npm run dev            # → http://localhost:4111

# Dashboard agentów
http://localhost:4111/dashboard-ui

# Health & status
curl localhost:4111/deploy/health
curl localhost:4111/deploy/gpu-status
curl localhost:4111/deploy/model-status
curl localhost:4111/deploy/cloud-free-status
curl localhost:4111/deploy/auto-heal-status

# Symulacja błędu (test self-healing)
curl localhost:4111/deploy/crash-test?type=TypeError

# Dashboard JSON endpoints
curl 'localhost:4111/dashboard/overview?since=7d'
curl 'localhost:4111/dashboard/agents?since=24h'
curl 'localhost:4111/dashboard/skills?since=7d'
curl 'localhost:4111/dashboard/cost?since=30d'
```

**Kluczowe pliki, które warto znać na pamięć:**
- [src/mastra/index.ts](src/mastra/index.ts) — rejestracja wszystkiego
- [src/mastra/config/model-manifest.ts](src/mastra/config/model-manifest.ts) — Single Source of Truth modeli
- [src/mastra/config/model-capabilities.ts](src/mastra/config/model-capabilities.ts) — tier modeli, VRAM
- [src/mastra/config/subagent-roles.ts](src/mastra/config/subagent-roles.ts) — role sub-agentów
- [src/mastra/agents/meta-agent.ts](src/mastra/agents/meta-agent.ts) — orchestrator + ToolSearchProcessor
- [src/mastra/agents/coding-agent.ts](src/mastra/agents/coding-agent.ts) — coding stack
- [src/mastra/services/smart-router.ts](src/mastra/services/smart-router.ts) — routing modeli
- [src/mastra/services/parallel-dispatch.ts](src/mastra/services/parallel-dispatch.ts) — execution równoległe
- [src/mastra/services/skill-registry.ts](src/mastra/services/skill-registry.ts) — skille
- [src/mastra/services/error-collector.ts](src/mastra/services/error-collector.ts) — autoheal trigger
- [src/mastra/workflows/repo-maintenance.ts](src/mastra/workflows/repo-maintenance.ts) — autoheal pipeline
- [src/mastra/lib/failure-brain.ts](src/mastra/lib/failure-brain.ts) — recall + write knowledge dla autoheal
- [src/mastra/lib/terminal-safety-guard.ts](src/mastra/lib/terminal-safety-guard.ts) — gate komend shell
- [docs/AGENTS-AND-TOOLS.md](docs/AGENTS-AND-TOOLS.md), [docs/META-AGENT-PATTERNS.md](docs/META-AGENT-PATTERNS.md), [docs/PHASE-1-OPERATIONAL-MEMORY.md](docs/PHASE-1-OPERATIONAL-MEMORY.md) → [docs/PHASE-5-REPO-INDEXING.md](docs/PHASE-5-REPO-INDEXING.md)

---

## 16. Krótki "elevator pitch" (do pchania w prompty LLM-om do researchu)

> "Mam autonomiczne środowisko agentów AI na Mastrze (TypeScript). Centralny Meta-Agent (Gemini 2.5 Flash) z Tool Search Processor deleguje do 8 wyspecjalizowanych ekspertów (marketing, sales, analytics, automation architect dla n8n, coding agent, code review, CRM, weather). Coding agent ma własny Smart Router, który dynamicznie przypisuje subtaski do modeli (lokalny Ollama / cloud-free OpenRouter / płatny cloud) wg złożoności + VRAM + budżetu, plus parallel dispatch po grupach zależności. Mam 14 workflowów (DAG), 60+ tooli (Gmail, Calendar, Sheets, Slides, n8n, NotebookLM, Tavily, RSS, CRM, code worktree, repo indexing Tree-sitter+PageRank), 80+ skilli markdownowych w rejestrze z embeddingami i success rate. Cztery warstwy pamięci (Mastra OM + working + shared_memory TTL + system_knowledge typowane). Self-healing: błąd → Failure Brain recall podobnych failure_case + autoheal_recipe → diagnose-and-plan → execute-patch w worktree → code review → deploy. Bezpieczeństwo: Terminal Safety Guard (22 BLOCK + 12 CONFIRM), Secrets Redactor (20+ typów), approval gating. Dashboard agentów pod /dashboard-ui (success rate, koszt, latencja, scorery). Plan: kopiować repo per klient, podmieniać warstwę biznesową (skille, agenci domenowi, integracje), trzon zostawiać. Zaproponuj N konkretnych use-case'ów / nowych skilli / agentów / workflowów, które mógłbym zbudować na tym fundamencie dla [opis branży klienta]."

---

> Plik wygenerowany 2026-05-09 na podstawie eksploracji repo. Aktualizuj ręcznie kiedy rejestrujesz nowych agentów / tools / workflows w `src/mastra/index.ts`.
