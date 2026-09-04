# jcode-inspired Memory and Harness Plan

**Status:** ✅ COMPLETED — Wszystkie 6 sprintów (Etapy 0–6) zaimplementowane i zweryfikowane. MVP gaps domknięte (pending_user_messages indeksy, deprecated cache cleanup, audit/replay w package.json). Audyt regresji clean.  
**Data:** 2026-05-13  
**Cel:** Przenieść z jcode te mechanizmy, które realnie zwiększają skuteczność i tempo pracy agentów: pasywny kontekst, asynchroniczna pamięć semantyczna, file-activity ledger, strukturalne wyszukiwanie kodu, cache discipline, background tasks i bezpieczne soft interrupts.

**Pre-flight wykonany:** stabilizacja Automation Architect została zakończona 2026-05-13. Szczegóły są w [docs/AUTOMATION-ARCHITECT-STABILIZATION.md](../docs/AUTOMATION-ARCHITECT-STABILIZATION.md).

**Post-completion (2026-05-13):**
- `pending_user_messages` kolekcja dodana do `init-db.ts` z indeksami (taskId+status, threadId+status, urgent sort, TTL)
- Deprecated `anthropicCacheOptions()` usunięte z `repo-maintenance.ts` i `external-projects-tools.ts`
- `npm run audit:harness` i `npm run replay:harness` dodane do `package.json`
- Audit script: `✅ No direct agent.generate() calls found in coding flow. Scanned 140 files.`

---

## 1. Diagnoza

Największa przewaga jcode nie wynika z większej liczby agentów. Wynika z tego, że część inteligencji jest w harnessie, poza decyzją modelu.

W `agentic-agents` wiele klocków już istnieje:

- `system_knowledge` + `system_memory_recall`
- `SkillRegistry` + `skill_search`
- `repo-indexer` + `repo_map`
- `code_search`
- `code_task_artifacts`
- `code_change_snapshots`
- worktree-first coding flow
- prompt cache helper dla stabilnych instructions

Problem jest inny: agent często musi sam pamiętać, żeby tych klocków użyć. jcode robi więcej automatycznie:

- pamięć pojawia się pasywnie w następnej turze,
- retrieval działa asynchronicznie,
- wynik pamięci jest deduplikowany przed injectem,
- file touches są eventami systemowymi,
- code search zwraca symbole i regiony, nie tylko snippets,
- długie prace idą w background managerze,
- nowe komunikaty są kolejkowane do bezpiecznych injection points.

---

## 2. Docelowa Architektura

```
User / workflow request
        |
        v
coding generate wrapper
        |
        +-- passive pre-context
        |     +-- pending semantic memory
        |     +-- system_knowledge recall
        |     +-- skill search
        |     +-- repo map
        |     +-- checkpoint
        |
        +-- pending interrupts
        |
        v
codingAgent.generate()
        |
        +-- tools
        |     +-- file activity ledger
        |     +-- code outline/search
        |     +-- bg task manager
        |
        v
subtask/group completion
        |
        +-- async semantic memory worker
        +-- checkpoint update
        +-- file activity cleanup
        +-- pending message queue
```

Kluczowa zasada: dynamiczne konteksty są injectowane jako user/prompt suffix, a nie jako static instructions. Static instructions pozostają cache-friendly.

---

## 3. Feature Flagi

Dodać flagi w `.env.example`, runtime config albo prostym `process.env` guardzie:

```env
FEATURE_CODING_PRECONTEXT=true
FEATURE_ASYNC_SEMANTIC_MEMORY=true
FEATURE_FILE_ACTIVITY_LEDGER=true
FEATURE_CODE_OUTLINE=true
FEATURE_BACKGROUND_TASKS=true
FEATURE_SOFT_INTERRUPTS=true
FEATURE_MASTRA_HARNESS=true
FEATURE_TOOL_ENVELOPE=true
FEATURE_OUTPUT_COMPACTION=true
FEATURE_HARNESS_POLICY=true
HARNESS_POLICY_MODE=log_only
FEATURE_HARNESS_REPLAY=true
```

Każdy etap ma działać addytywnie. Wyłączenie flagi powinno przywracać obecny flow.

---

## 3.1 Mastra Harness Layer

**Status:** LOG-ONLY + PRE-CONTEXT + ASYNC MEMORY + RUN STATE + FILETOUCH MVP + TOOL ENVELOPE MVP + OUTPUT COMPACTION MVP + POLICY LOG-ONLY MVP DONE 2026-05-13 dla `subtask-executor.ts` i core coding tools

### Cel

Stworzyć nad Mastrą własny harness podobny funkcjonalnie do tego, co daje jcode: warstwę, która steruje turą agenta, kontekstem, narzędziami, pamięcią, bezpieczeństwem, background tasks i debugowaniem.

To nie wymaga przepisywania Mastry. Mastra zostaje runtime'em:

- agentów,
- workflowów,
- toolsów,
- modeli,
- workspace.

Harness jest naszą warstwą operacyjną nad tym runtime'em.

### Czy To Jest Możliwe w Mastra?

Tak, ale pod warunkiem, że zaakceptujemy właściwą granicę odpowiedzialności.

Możliwe bez przebudowy Mastry:

- wrapper wokół `agent.generate()`,
- pasywne context injection przed turą,
- soft interrupt między turami/subtaskami,
- asynchroniczna pamięć na następną turę,
- FileTouch ledger,
- policy check przed narzędziami,
- output compaction,
- background task manager,
- event replay,
- session/run state,
- cache discipline,
- migracja coding flowów na jedną bramę.

Trudne albo niemożliwe bez wejścia głębiej w runtime Mastry:

- bezpieczne wstrzyknięcie wiadomości w środek aktywnego `agent.generate()`,
- przerwanie tool-call/result pair bez ryzyka popsucia historii,
- globalne przechwycenie każdego tool calla, jeśli tool nie przechodzi przez nasz wrapper,
- pełny jcode-style event loop dla workflowów, które nadal wołają `agent.generate()` bezpośrednio.

Wniosek: robimy **Mastra Harness Layer**, nie fork Mastry.

### Zasada Architektoniczna

W coding flow nie powinno być bezpośrednich wywołań:

```ts
agent.generate(prompt)
```

Docelowo wszystkie ważne coding calls przechodzą przez:

```ts
await harness.generateCoding({
  agent: mastra.getAgent('codingAgent'),
  prompt,
  taskId,
  subtaskId,
  threadId,
  repoPath,
  model: modelId,
  phase: 'subtask',
});
```

To daje jedno miejsce na:

- passive context,
- pending interrupts,
- cache policy,
- timeout,
- telemetry,
- memory scheduling,
- output compaction,
- run state,
- error classification.

### Nowe Pliki

Minimalny zestaw:

- `src/mastra/services/coding-harness.ts`
- `src/mastra/services/harness-run-state.ts`
- `src/mastra/services/harness-tool-envelope.ts`
- `src/mastra/services/harness-output-compactor.ts`
- `src/mastra/services/harness-policy.ts`
- `src/mastra/services/harness-replay.ts`
- `src/mastra/services/harness-events.ts`

Opcjonalnie później:

- `src/mastra/services/harness-context-budget.ts`
- `src/mastra/services/harness-direct-generate-audit.ts`
- `src/mastra/scripts/audit-direct-agent-generate.ts`
- `src/mastra/scripts/replay-harness-run.ts`

### Główne API

```ts
export type HarnessPhase =
  | 'diagnose'
  | 'plan'
  | 'subtask'
  | 'retry'
  | 'review'
  | 'merge'
  | 'cleanup'
  | 'chat';

export type HarnessGenerateInput = {
  agent: Agent;
  agentId: string;
  prompt: string;
  taskId?: string;
  subtaskId?: string;
  threadId?: string;
  runId?: string;
  repoPath?: string;
  targetFiles?: string[];
  model?: string;
  phase: HarnessPhase;
  timeoutMs?: number;
  cachePolicy?: 'static-only' | 'disabled';
  contextPolicy?: {
    includeMemory?: boolean;
    includeSkills?: boolean;
    includeRepoMap?: boolean;
    includeCheckpoint?: boolean;
    maxTokens?: number;
  };
};

export type HarnessGenerateResult = {
  runId: string;
  turnId: string;
  response: unknown;
  promptHash: string;
  contextHash?: string;
  outputPreview: string;
  outputArtifactId?: string;
  durationMs: number;
  model?: string;
  eventsWritten: number;
};

export async function generateCoding(
  input: HarnessGenerateInput,
): Promise<HarnessGenerateResult>;
```

### Przepływ `generateCoding`

1. `ensureRunState(input)`
   - tworzy albo ładuje `agent_runs`,
   - nadaje `runId`, `turnId`,
   - zapisuje `phase`.

2. `takeSafeInterrupts(input)`
   - pobiera `pending_user_messages`,
   - tylko jeśli phase jest bezpieczna,
   - nie przerywa aktywnej generacji.

3. `buildCodingPrecontext(input)`
   - bierze pending semantic memory,
   - robi fallback memory recall z timeoutem,
   - robi skill search,
   - dokleja repo map/checkpoint,
   - pilnuje token budget.

4. `checkFileTouchWarnings(input)`
   - sprawdza `file_activity`,
   - dodaje warning do promptu albo do eventów.

5. `composeHarnessPrompt(input)`
   - składa finalny prompt,
   - dynamiczny kontekst idzie do user promptu,
   - static instructions pozostają cache-friendly.

6. `recordHarnessEvent('llm_call_started')`

7. `agent.generate(finalPrompt, generateOptions)`
   - model override,
   - timeout,
   - bez deprecated call-level cache no-op.

8. `compactHarnessOutput(response)`
   - jeśli output jest duży, zapisuje pełną treść jako artifact,
   - do kolejnych promptów trafia preview.

9. `scheduleSemanticMemoryCheck(...)`
   - odpala async worker,
   - wynik będzie gotowy dla następnej tury.

10. `appendToCheckpoint(...)`
    - zapis decyzji, plików, błędów, następnych kroków.

11. `recordHarnessEvent('llm_call_completed')`

12. `updateRunState(...)`

### Run / Session State Machine

Bez jawnego run state harness będzie tylko luźnym wrapperem. Potrzebny jest model stanu:

```ts
type AgentRun = {
  runId: string;
  threadId?: string;
  taskId?: string;
  agentId: string;
  status: 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  phase: HarnessPhase;
  currentSubtaskId?: string;
  repoPath?: string;
  model?: string;
  safeInterruptPoint: boolean;
  lastPromptHash?: string;
  lastContextHash?: string;
  lastProviderCallAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  errorClass?: string;
  errorMessage?: string;
};
```

Mongo:

```ts
agent_runs:
  runId unique
  threadId
  taskId
  agentId
  status
  phase
  currentSubtaskId
  repoPath
  model
  safeInterruptPoint
  lastPromptHash
  lastContextHash
  lastProviderCallAt
  createdAt
  updatedAt
  completedAt
```

Indeksy:

- `{ runId: 1 }` unique
- `{ taskId: 1, updatedAt: -1 }`
- `{ threadId: 1, updatedAt: -1 }`
- `{ status: 1, updatedAt: -1 }`

State transitions:

```txt
created -> active
active -> waiting
active -> completed
active -> failed
waiting -> active
waiting -> cancelled
failed -> active retry
```

`safeInterruptPoint=true` tylko:

- przed startem subtasku,
- po zakończeniu subtasku,
- między grupami parallel dispatch,
- przed retry,
- przed escalation,
- przed final summary.

Nigdy:

- w środku `agent.generate()`,
- między tool-call i tool-result,
- w środku `coding_apply_patch`.

### Jedna Brama Wywołań LLM

Migracja call-site'ów:

1. [x] Najpierw `src/mastra/services/subtask-executor.ts`
   - obecne `agent.generate(prompt, ...)` zamienić na `generateCoding(...)`.
   - to daje największy ROI, bo obsługuje subagent coding loop.

2. Potem `src/mastra/workflows/repo-maintenance.ts`
   - diagnoza,
   - init worktree,
   - patch fallback,
   - review rework,
   - merge/cleanup.

3. Potem `src/mastra/tools/system/delegate-task.ts`
   - gdy targetAgent = `codingAgent`, delegacja ma iść przez harness.

4. Na końcu audit pozostałych `agent.generate()`:
   - analytics/marketing/sales mogą zostać poza coding harness,
   - coding-related calls powinny mieć explicit exception albo wrapper.

Skrypt audytu:

```ts
// src/mastra/scripts/audit-direct-agent-generate.ts
// wyszukuje agent.generate/codingAgent.generate w src/mastra
// i raportuje call-site bez komentarza HARNESS_DIRECT_GENERATE_OK.
```

Zasada lintowa:

```txt
W coding flow direct agent.generate jest zabroniony.
Jeśli naprawdę trzeba, dodać komentarz:
HARNESS_DIRECT_GENERATE_OK: reason
```

### Tool Execution Envelope

Harness nie może dobrze działać, jeśli narzędzia są czarną skrzynką. Potrzebny jest wspólny envelope wokół `execute`.

**Status:** FIRST TOOL ENVELOPE LIST DONE 2026-05-13.

Docelowa funkcja:

```ts
export function withToolEnvelope<TInput, TOutput>(config: {
  toolId: string;
  category: 'file' | 'shell' | 'memory' | 'search' | 'git' | 'approval' | 'network' | 'other';
  risk: 'low' | 'medium' | 'high';
  extractActivity?: (input: TInput, output?: TOutput) => FileActivityInput[];
  compactOutput?: boolean;
  execute: (input: TInput, runtime: ToolRuntimeContext) => Promise<TOutput>;
}): (input: TInput, runtime: ToolRuntimeContext) => Promise<TOutput>;
```

Envelope robi:

1. Waliduje policy:
   - czy komenda jest dozwolona,
   - czy path jest w workspace,
   - czy wymagany approval istnieje,
   - czy konflikt pliku jest soft warning czy block.

2. Zapisuje start event:
   - `tool_call_started`.

3. Uruchamia tool.

4. Zapisuje FileTouch:
   - read/write/edit/patch/test.

5. Kompaktuje output:
   - preview do modelu,
   - pełny output do artifactu.

6. Klasyfikuje błędy:
   - validation,
   - approval_required,
   - timeout,
   - command_failed,
   - file_conflict,
   - provider_error,
   - unknown.

7. Zapisuje end event:
   - `tool_call_completed` albo `tool_call_failed`.

Pierwsze narzędzia do objęcia envelope:

- [x] `coding_write_file_tracked`,
- [x] `coding_record_before_change`,
- [x] `coding_record_after_change`,
- [x] `coding_apply_patch`,
- [x] `coding_read_worktree_file`,
- [x] `coding_worktree_diff`,
- [x] `coding_run_test`,
- [x] `code_search`,
- [x] `repo_map`,
- [x] `system_memory_recall`,
- [x] `skill_search`.

Nie trzeba od razu obejmować wszystkich toolsów w repo. Najpierw coding path.

Wykonane w MVP:

- dodano `src/mastra/services/harness-tool-envelope.ts`;
- envelope loguje `tool_call_started`, `tool_call_completed`, `tool_call_failed`;
- envelope zapisuje `tool_executions` z `inputPreview`, `outputPreview`, `durationMs`, `errorClass`;
- `coding_write_file_tracked` redaguje `content` w preview wejścia;
- `coding_run_test` klasyfikuje nieudany exit jako `command_failed`;
- `coding_read_worktree_file` jest objęty envelope jako low-risk file read;
- `coding_apply_patch` jest objęty envelope jako high-risk git action;
- `coding_record_before_change` i `coding_record_after_change` są objęte envelope i logują policy read/write;
- `coding_worktree_diff` jest objęty envelope jako low-risk git read;
- `code_search`, `repo_map`, `system_memory_recall` i `skill_search` są objęte envelope jako low-risk search/memory retrieval;
- dodano indeksy Mongo dla `tool_executions`.
- Weryfikacja: `npx tsx -e` dla `buildToolPreview()` i `classifyToolError()`, `bash scripts/with-node.sh npx tsc --noEmit`, `git diff --check`, `npm run build`.

### Tool Execution Mongo

```ts
tool_executions:
  id
  runId
  turnId
  taskId
  subtaskId
  agentId
  toolId
  category
  risk
  status: 'started' | 'completed' | 'failed' | 'blocked'
  inputPreview
  outputPreview
  outputArtifactId
  durationMs
  errorClass
  errorMessage
  fileActivityIds
  createdAt
  completedAt
  expiresAt
```

Indeksy:

- `{ runId: 1, createdAt: 1 }`
- `{ taskId: 1, createdAt: -1 }`
- `{ toolId: 1, createdAt: -1 }`
- `{ expiresAt: 1 }` TTL

### Output Compaction Policy

Duże outputy są jednym z głównych powodów spowolnienia agentów. Harness powinien mieć centralną politykę:

**Status:** MVP DONE 2026-05-13 dla `coding_run_test`.

```ts
type CompactionResult = {
  preview: string;
  fullTextArtifactId?: string;
  originalBytes: number;
  previewBytes: number;
  truncated: boolean;
};
```

Limity startowe:

- tool output preview: 8-12 KB,
- command/test output preview: 12-20 KB,
- diff preview: 20-30 KB,
- LLM response preview for event log: 4-8 KB.

Pełny output trafi do:

- Mongo `harness_artifacts`, jeśli mały/średni,
- pliku `.mastra/harness-artifacts/<artifactId>.txt`, jeśli duży.

Mongo:

```ts
harness_artifacts:
  id
  runId
  taskId
  kind: 'tool_output' | 'llm_output' | 'command_log' | 'diff' | 'memory_context'
  storage: 'mongo' | 'file'
  content?
  filePath?
  bytes
  sha256
  createdAt
  expiresAt
```

Do modelu wraca:

```txt
Output truncated.
Preview:
...

Full output artifact: <artifactId>
```

Zasada: agent może poprosić o pełny output przez osobny tool, ale default prompt nie jest zalewany logami.

Wykonane w MVP:

- dodano `src/mastra/services/harness-output-compactor.ts`;
- `compactHarnessOutput()` redaguje sekrety, ucina duży output i zapisuje pełną treść w `harness_artifacts`;
- `compactTextForPreview()` zapewnia limit po bajtach UTF-8;
- `coding_run_test` zwraca `outputArtifactId`, `outputTruncated`, `originalBytes`, `previewBytes`;
- `commandsRun` i `testResult` zapisują preview oraz metadane artifactu;
- `tool_executions` zapisuje `outputArtifactId`;
- dodano indeksy Mongo dla `harness_artifacts`;
- event `tool_output_compacted` jest logowany dla skompaktowanego outputu.
- Weryfikacja: `npx tsx -e` dla `compactTextForPreview()`, `bash scripts/with-node.sh npx tsc --noEmit`, `git diff --check`, `npm run build`.

### Policy Layer

**Status:** WARNING/LOG-ONLY MVP DONE 2026-05-13 dla `coding_write_file_tracked`, `coding_read_worktree_file`, `coding_run_test` i `coding_apply_patch`.

Policy layer ma być niezależny od promptu. Agent nie powinien sam decydować, czy wolno wykonać ryzykowną akcję.

```ts
type HarnessPolicyRequest = {
  runId?: string;
  taskId?: string;
  agentId: string;
  action: 'read_file' | 'write_file' | 'run_command' | 'apply_patch' | 'network' | 'git' | 'approval' | 'memory_write';
  target?: string;
  command?: string;
  riskHint?: 'low' | 'medium' | 'high';
};

type HarnessPolicyDecision = {
  allow: boolean;
  effectiveAllow: boolean;
  requiresApproval: boolean;
  severity: 'info' | 'warning' | 'block';
  reason: string;
  approvalType?: string;
  matchedRule: string;
  enforcementMode: 'off' | 'log_only' | 'enforce';
  enforced: boolean;
};
```

Startowe reguły:

- read w workspace: allow,
- write w worktree: allow z FileTouch,
- write w live repo: block, chyba że `coding_apply_patch`,
- `git diff/status/log`: allow,
- `git merge/push/branch -D`: approval,
- package install: approval,
- network install/fetch: approval albo block według obecnych reguł,
- delete file/directory: approval,
- deploy/send email/external side effect: approval,
- memory write: allow, ale logować source.

Policy ma zwracać jasne powody, np.:

```txt
Blocked: write outside task worktree. Use coding_init_worktree and coding_write_file_tracked.
```

Wykonane w log-only MVP:

- dodano `src/mastra/services/harness-policy.ts`;
- domyślny tryb to `HARNESS_POLICY_MODE=log_only`;
- policy loguje `policy_allowed` albo `policy_blocked`, ale w log-only ustawia `effectiveAllow=true` i `enforced=false`;
- `withToolEnvelope()` przyjmuje opcjonalny builder `policy`;
- `tool_executions` zapisuje `policyDecision`;
- `coding_write_file_tracked` loguje akcję `write_file`;
- `coding_read_worktree_file` loguje akcję `read_file`;
- `coding_run_test` loguje akcję `run_command`;
- `coding_apply_patch` loguje akcję `apply_patch`;
- startowe reguły klasyfikują worktree writes, workspace reads, safe verification commands, package install, network commands, git mutations i destrukcyjne komendy.

### Replay / Debug Trace

**Status:** CLI MVP DONE 2026-05-13 dla pojedynczego `runId`.

Każdy run powinien dać się odtworzyć bez czytania surowych logs.

Mongo:

```ts
agent_run_events:
  id
  runId
  turnId?
  taskId?
  subtaskId?
  agentId
  type
  phase?
  timestamp
  durationMs?
  data
  preview
  artifactId?
```

Eventy minimum:

- `run_started`
- `run_phase_changed`
- `precontext_started`
- `precontext_injected`
- `memory_pending_taken`
- `memory_sync_fallback_used`
- `memory_suppressed`
- `soft_interrupt_consumed`
- `file_conflict_warning`
- `llm_call_started`
- `llm_call_completed`
- `llm_call_failed`
- `tool_call_started`
- `tool_call_completed`
- `tool_call_failed`
- `tool_output_compacted`
- `background_task_started`
- `background_task_completed`
- `policy_allowed`
- `policy_blocked`
- `run_completed`
- `run_failed`

CLI/debug script:

```bash
npx tsx src/mastra/scripts/replay-harness-run.ts <runId>
```

Output:

```txt
Run: ...
Task: ...
Model calls:
  1. subtask A - 34s - memory 3 hits - tools 4
Tools:
  coding_read_worktree_file src/...
  coding_write_file_tracked src/...
Memory:
  injected: ...
  suppressed: ...
Warnings:
  file conflict: ...
Artifacts:
  command output: ...
```

Wykonane w CLI MVP:

- dodano `src/mastra/scripts/replay-harness-run.ts`;
- komenda `npx tsx src/mastra/scripts/replay-harness-run.ts <runId>` pokazuje run summary, model calls, tools, memory, warnings, artifacts i timeline;
- flaga `--json` zwraca surowy snapshot replay;
- skrypt czyta `agent_runs`, `agent_run_events`, `agent_events`, `tool_executions` i `harness_artifacts`;
- replay łączy dane po `runId` oraz po `taskId`, bo obecnie część tooli może zapisać `runId=taskId`, jeśli runtime nie przekaże pełnego harness metadata;
- brak danych dla runu nie kończy się błędem, tylko pustym replayem.

### Context Budget Manager

Harness powinien centralnie pilnować budżetu kontekstu. Inaczej memory, skills, repo map i checkpoint zaczną ze sobą konkurować.

Startowy podział dla coding subtask:

- passive memory: 800-1200 tokenów,
- skill summary/procedure: 600-1500 tokenów,
- repo map/code outline: 800-1500 tokenów,
- checkpoint/previous results: 400-800 tokenów,
- user task/subtask: bez cięcia, chyba że ekstremalnie długie.

Reguły priorytetu:

1. Aktualny user prompt i subtask description.
2. Target files i scope.
3. Pending user interrupts.
4. File conflict warnings.
5. Relevant memory.
6. Skill procedure.
7. Repo map/code outline.
8. Checkpoint.

Jeśli trzeba ciąć, najpierw ciąć:

- repo map,
- checkpoint,
- mniej pewne memory,
- długie skill procedure.

### Integracja z Cache

Harness nie może psuć prompt cache.

Zasady:

- static instructions agenta zostają w `instructions`,
- dynamiczny pre-context jest doklejany do user promptu,
- tool lista powinna być stabilna,
- cache telemetry liczy tylko realne provider usage,
- nie używać call-level `cacheOptionsForModel()` jeśli provider tego nie wspiera.

Harness zapisuje:

- `staticPromptHash`,
- `dynamicContextHash`,
- `toolListHash`,
- `model`,
- `cacheReadTokens`,
- `cacheWriteTokens`,
- `cacheMissReason`.

### Migracja Bez Ryzyka

Faza A - log-only:

- dodać `coding-harness.ts`,
- wrapper tylko loguje i woła `agent.generate()` bez zmiany promptu,
- żadnych zmian zachowania.

Faza B - pre-context:

- włączyć passive context tylko dla `subtask-executor`,
- feature flag `FEATURE_CODING_PRECONTEXT`.

Faza C - async memory:

- po zakończeniu tury schedule worker,
- inject dopiero w następnej turze.

Faza D - tool envelope:

- objąć tylko coding tools,
- zacząć od log-only,
- potem FileTouch,
- potem policy.

Faza E - output compaction:

- najpierw `coding_run_test` i command logs,
- potem diff/search outputs.

Faza F - repo-maintenance:

- przenieść pozostałe coding calls na harness.

Faza G - audit direct generate:

- skrypt raportujący bezpośrednie `agent.generate`,
- brak twardego faila na start,
- później CI warning.

### Akceptacja Harnessu

Harness MVP jest gotowy, jeśli:

- [x] `subtask-executor` używa `generateCoding()`,
- [x] każdy coding LLM call przez `subtask-executor` ma `runId` i `turnId`,
- [x] `agent_runs` zapisuje run/phase/status dla coding tasks,
- [x] `agent_run_events` zapisuje timeline tury LLM,
- [x] pre-context jest widoczny w eventach,
- [x] async memory jest schedule'owane po turze wrappera,
- [x] tool envelope loguje `coding_write_file_tracked` i `coding_run_test`,
- [x] duży test output jest kompaktowany,
- [x] FileTouch warning pojawia się przed edycją konfliktowego pliku,
- [x] soft interrupt jest konsumowany między subtaskami,
- [x] replay script pokazuje przebieg jednego taska.

### Czego Nie Robić na Starcie

- Nie przepisywać wszystkich workflowów naraz.
- Nie budować pełnego swarmu.
- Nie robić hard interrupt w środku generacji.
- Nie wymuszać policy na każdym toolu w repo.
- Nie przenosić całej pamięci do graph modelu przed MVP.
- Nie mieszać dynamicznego pre-contextu ze static instructions.

### Wykonane 2026-05-13

- Dodano `src/mastra/services/coding-harness.ts` w trybie log-only.
- `generateCoding()` nadaje `runId`, `turnId`, `promptHash`, zachowuje timeout i zwraca oryginalny response.
- Wrapper loguje `llm_call_started`, `llm_call_completed` i `llm_call_failed` przez `logHarnessEvent()`.
- Dodano `src/mastra/services/harness-run-state.ts` z `beginHarnessTurn()`, `completeHarnessTurn()`, `failHarnessTurn()` i `appendRunEvent()`.
- `generateCoding()` zapisuje `agent_runs` przed turą, po sukcesie i po błędzie.
- `agent_run_events` zapisuje `run_started`, `run_phase_changed`, `llm_call_started`, `llm_call_completed`, `llm_call_failed`, `run_failed`.
- Dodano indeksy dla `agent_runs` i `agent_run_events`.
- Przepieto `src/mastra/services/subtask-executor.ts` z bezposredniego `agent.generate()` na `generateCoding()`.
- Usunieto z tego call-site'u deprecated `cacheOptionsForModel()`.

---

## 4. Etap 0 - Telemetria i Kontrakty

**Status:** DONE 2026-05-13  
**Dokumentacja:** [docs/MASTRA-HARNESS-LAYER.md](../docs/MASTRA-HARNESS-LAYER.md)

### Cel

Najpierw dodać wspólne eventy i schematy, żeby kolejne etapy były mierzalne i łatwe do debugowania.

### Zmiany

1. Rozszerzyć `agent_events` o typy:
   - `precontext_injected`
   - `semantic_memory_check_started`
   - `semantic_memory_pending_prepared`
   - `semantic_memory_injected`
   - `semantic_memory_suppressed`
   - `file_touch`
   - `file_conflict_warning`
   - `code_outline_used`
   - `bg_task_started`
   - `bg_task_progress`
   - `bg_task_completed`
   - `soft_interrupt_queued`
   - `soft_interrupt_consumed`
   - `run_started`
   - `run_phase_changed`
   - `run_completed`
   - `run_failed`
   - `llm_call_started`
   - `llm_call_completed`
   - `llm_call_failed`
   - `tool_call_started`
   - `tool_call_completed`
   - `tool_call_failed`
   - `tool_output_compacted`
   - `policy_allowed`
   - `policy_blocked`
   - `cache_usage_observed`
   - `cache_miss_reason`

2. Dodać mały helper:
   - `src/mastra/services/harness-events.ts`
   - wrapper nad `logAgentEvent()`
   - wspólne pola: `taskId`, `subtaskId`, `agentId`, `threadId`, `feature`, `durationMs`, `data`.

3. Dodać standard `tokenEstimate` dla injectowanych bloków:
   - szacowanie `Math.ceil(text.length / 4)`
   - logować wynik dla pre-context i pending memory.

### Akceptacja

- Każdy kolejny etap loguje eventy w jednym formacie.
- Brak event logu nie blokuje pracy agenta.

### Wykonane 2026-05-13

- Dodano feature flagi rolloutowe w `.env.example`.
- Dodano runtime helper `src/mastra/config/harness-flags.ts`.
- Rozszerzono `AgentEventType` o typy harnessowe.
- Dodano pola `runId`, `turnId`, `threadId`, `feature` i `data` do kontraktu `agent_events`.
- Dodano `src/mastra/services/harness-events.ts` z `logHarnessEvent()` i `tokenEstimate()`.

---

## 5. Etap 1 - Auto Pre-Context

**Status:** DONE 2026-05-13 dla `subtask-executor.ts`  
**Dokumentacja:** [docs/MASTRA-HARNESS-LAYER.md](../docs/MASTRA-HARNESS-LAYER.md)

### Cel

Przed każdym ważnym `codingAgent.generate()` system automatycznie dokleja krótki kontekst: pamięć, skills, repo mapę i checkpoint.

### Obecny Stan

`assembleContext()` istnieje, ale:

- działa głównie w `subtask-executor`,
- nie jest globalnym wrapperem dla wszystkich coding calls,
- `context-assembler.ts` woła `getRepoIndexer()` bez `rootPath`, co może się wywalić, jeśli indexer nie został wcześniej zainicjalizowany,
- pamięć i skills nadal są częściowo zależne od prompt discipline.

### Nowe Pliki

- `src/mastra/services/coding-precontext.ts`
- `src/mastra/services/coding-generate-wrapper.ts`

### API

```ts
export type CodingPrecontextInput = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  userPrompt: string;
  repoPath: string;
  targetFiles?: string[];
  maxTokens?: number;
};

export type CodingPrecontextResult = {
  markdown: string;
  tokenEstimate: number;
  memoryCount: number;
  skillCount: number;
  repoMapIncluded: boolean;
  checkpointIncluded: boolean;
  suppressedReasons: string[];
};
```

### Źródła Kontekstu

1. **Pending semantic memory**
   - Jeśli `FEATURE_ASYNC_SEMANTIC_MEMORY=true`, najpierw próbować wziąć gotowy wynik z `pending_memory_context`.
   - To jest najtańsze, bo zostało policzone wcześniej.

2. **Fallback sync memory recall**
   - Jeśli brak pending memory, zrobić szybki recall z `system_knowledge`.
   - Limit: top 3.
   - Timeout: 500-1000 ms.
   - Jeśli embedding service nie odpowiada, pominąć.

3. **Skill search**
   - `getSkillRegistry().search(userPrompt, { topK: 3 })`.
   - Nie ładować pełnych procedur automatycznie dla wszystkich wyników.
   - Pre-context ma tylko podpowiedzieć: `Available relevant skills`.
   - Pełny skill ładuje obecny role/subtask flow.

4. **Repo map**
   - Poprawić `assembleContext({ repoPath })`.
   - `getRepoIndexer(repoPath)`, nigdy gołe `getRepoIndexer()`.
   - Max 800-1200 tokenów dla mapy.

5. **Checkpoint**
   - `loadCheckpoint(taskId)` jeśli `taskId` istnieje.
   - Limit 400-600 tokenów.

### Format Injectu

```md
## Passive Context

### Relevant Memory
- [failure_case] ...
- [coding_pattern] ...

### Relevant Skills
- safe-file-edit (score 0.82): ...
- run-verification (score 0.77): ...

### Repository Map
...

### Current Checkpoint
...

Use this context only if it is relevant. Prefer current file contents over stale memory.
```

### Wrapper

```ts
export async function generateCodingWithPreContext(
  agent: Agent,
  prompt: string,
  options: Record<string, unknown>,
  ctx: CodingPrecontextInput,
) {
  const pre = await buildCodingPrecontext(ctx);
  const finalPrompt = pre.markdown
    ? `${pre.markdown}\n\n---\n\n${prompt}`
    : prompt;
  return agent.generate(finalPrompt, options as any);
}
```

### Call-Site Migration

1. `services/subtask-executor.ts`
   - Zamienić bezpośrednie `agent.generate(prompt, ...)` na wrapper.

2. `workflows/repo-maintenance.ts`
   - Zastąpić bezpośrednie `codingAgent.generate()` wrapperem.

3. Później:
   - wszystkie nowe coding workflows mają używać wrappera jako jedynej ścieżki.

### Testy

- Unit: `buildCodingPrecontext()` zwraca pusty string przy błędach zależności.
- Unit: token budget przycina sekcje.
- Integration: subtask prompt zawiera `Passive Context`.
- Regression: jeśli flaga off, prompt nie jest modyfikowany.

### Wykonane 2026-05-13

- Dodano `src/mastra/services/coding-precontext.ts`.
- `buildCodingPrecontext()` składa `## Passive Context` z memory, skills, repo map i checkpointu.
- Pending memory jest konsumowane best-effort z `pending_memory_context`, jeśli `FEATURE_ASYNC_SEMANTIC_MEMORY=true`.
- Fallback memory recall używa `recallKnowledge()` z limitem top 3 i timeoutem 900 ms.
- Skill search używa `SkillRegistry.search()` z limitem top 3 i timeoutem 900 ms.
- `generateCoding()` dokleja dynamiczny kontekst do user promptu tylko gdy `FEATURE_CODING_PRECONTEXT=true`.
- `generateCoding()` loguje `precontext_injected`, `contextHash`, `originalPromptHash` i `precontextApplied`.
- `context-assembler.ts` wymaga `repoPath` i używa `getRepoIndexer(repoPath)`.
- Hardcoded SQLite path w `context-assembler.ts` został zastąpiony `repoPath`.
- `subtask-executor.ts` przekazuje `repoPath` z `getWorkspacePath(taskId)` do harnessu.
- Gdy pre-context jest włączony, lokalny legacy `assembleContext()` w scoped prompt jest pomijany, żeby nie dublować repo map/checkpoint.

---

## 6. Etap 2 - Async Semantic Memory

**Status:** DONE 2026-05-13 dla `generateCoding()` / `subtask-executor.ts`  
**Dokumentacja:** [docs/MASTRA-HARNESS-LAYER.md](../docs/MASTRA-HARNESS-LAYER.md)

### Cel

Zbliżyć pamięć do modelu jcode: pamięć ma być przygotowywana w tle po turze/subtasku i gotowa do wstrzyknięcia w następnej turze.

### Obecny Problem

`system_memory_recall` robi semantic search, ale:

- jest tool-call zależny,
- query embedding liczy się w krytycznej ścieżce,
- wynik nie jest prefetchowany,
- nie ma deduplikacji injectów per thread/session,
- embedding w `memory-extractor.ts` jest liczony głównie z `title`, co ogranicza jakość retrievalu.

### Mongo

#### `pending_memory_context`

```ts
{
  id: string;
  threadId: string;
  taskId?: string;
  agentId: string;
  queryHash: string;
  prompt: string;
  displayPrompt?: string;
  memoryIds: string[];
  count: number;
  tokenEstimate: number;
  status: 'pending' | 'consumed' | 'stale' | 'suppressed';
  computedAt: Date;
  consumedAt?: Date;
  expiresAt: Date;
}
```

Indeksy:

- `{ threadId: 1, status: 1, computedAt: -1 }`
- `{ taskId: 1, status: 1, computedAt: -1 }`
- `{ expiresAt: 1 }` TTL

#### `injected_memory_context`

```ts
{
  threadId: string;
  taskId?: string;
  memoryId: string;
  injectedAt: Date;
  source: 'pending' | 'sync_fallback';
}
```

Indeksy:

- `{ threadId: 1, memoryId: 1 }` unique
- `{ injectedAt: 1 }` TTL 30-90 dni

### Embedding Jakościowy

Zmienić zapis w `memory-extractor.ts`:

Obecnie:

```ts
embedding = await generateEmbedding(title);
```

Docelowo:

```ts
const searchableText = [
  type,
  title,
  content,
  tags?.join(' '),
  sourceAgent,
  projectId,
].filter(Boolean).join('\n');

embedding = await generateEmbedding(searchableText);
```

Dodać pole:

```ts
searchText: string;
searchTextHash: string;
embeddingModel: string;
```

Backfill:

- jeśli `searchTextHash` brak albo nie pasuje, przeliczyć embedding.
- zrobić script `src/mastra/scripts/backfill-system-knowledge-embeddings.ts`.

### Serwis

Nowy plik:

- `src/mastra/services/semantic-memory-worker.ts`

API:

```ts
export async function scheduleSemanticMemoryCheck(input: {
  threadId: string;
  taskId?: string;
  agentId: string;
  contextText: string;
  projectId?: string;
  maxCandidates?: number;
}): Promise<void>;

export async function takePendingMemoryContext(input: {
  threadId: string;
  taskId?: string;
  maxAgeMs?: number;
}): Promise<PendingMemoryContext | null>;
```

### Retrieval Pipeline

1. Build query text:
   - user request,
   - subtask description,
   - recent diagnostics,
   - changed files,
   - error summary.

2. Generate query embedding.

3. Fetch candidates:
   - `system_knowledge` not expired,
   - `embeddingModel === EMBEDDING_MODEL_ID`,
   - optional type boost: `failure_case`, `coding_pattern`, `architecture_decision`.

4. Score:
   - cosine similarity,
   - confidence multiplier,
   - recency mild boost,
   - type boost.

5. Filter:
   - min score: 0.42 startowo,
   - top 5 candidates.

6. Dedupe:
   - odrzucić memory IDs już w `injected_memory_context`,
   - suppress jeśli overlap z ostatnim pending set >= 0.8.

7. Format prompt:
   - max 800-1200 tokenów,
   - top 3 wstrzykiwane do modelu,
   - reszta tylko w `displayPrompt`/metadata.

8. Save to `pending_memory_context`.

### Injection

`coding-precontext.ts` próbuje:

1. `takePendingMemoryContext(threadId, taskId)`
2. jeśli brak, sync fallback recall z timeoutem
3. po inject:
   - status `consumed`,
   - wpisać `injected_memory_context`,
   - log `semantic_memory_injected`.

### Kiedy Schedule'ować

1. Po zakończeniu każdego subtasku.
2. Po zakończeniu grupy w `parallel-dispatch`.
3. Po finalnym `codingAgent.generate`.
4. Po błędzie/failure case.
5. Opcjonalnie po `memory_write_observation`.

### Testy

- Unit: `searchText` zawiera title + content + tags.
- Unit: duplicate memory IDs nie są injectowane drugi raz.
- Unit: stale pending memory nie jest konsumowana.
- Integration: subtask N+1 dostaje memory policzone po subtasku N.
- Regression: wyłączona flaga nie dotyka promptu.

### Wykonane 2026-05-13

- Dodano `src/mastra/services/semantic-memory-worker.ts`.
- `generateCoding()` schedule'uje `scheduleSemanticMemoryCheck()` po sukcesie i po błędzie tury LLM.
- Worker buduje query z fazy, promptu, target files, output preview albo error summary.
- Retrieval używa aktywnego `system_knowledge` z `embeddingModel === EMBEDDING_MODEL_ID`, score łączy cosine similarity, confidence, recency i type boost.
- Wynik top 5 jest deduplikowany przez `injected_memory_context`; top 3 trafia do `pending_memory_context`.
- Pending memory jest konsumowane przez `coding-precontext.ts` przez `takePendingMemoryContext()`.
- Po inject pending wpis dostaje `consumed`, a memory IDs są zapisywane w `injected_memory_context`.
- Sync fallback recall jest deduplikowany tym samym ledgerem, gdy `FEATURE_ASYNC_SEMANTIC_MEMORY=true`.
- Dodano Mongo indeksy dla `pending_memory_context` i `injected_memory_context` w `mongo.ts`, `mongo-indexes.ts` i `init-db.ts`.
- `system_knowledge` dostało `searchText` i `searchTextHash`; embedding jest liczony z `type`, `title`, `content`, `tags`, `sourceAgent`, `projectId`.
- Zaktualizowano `memory-extractor.ts`, `failure-brain.ts`, `system_memory_write_observation` i `rebuild-embeddings.ts`.
- Dodano `src/mastra/scripts/backfill-system-knowledge-embeddings.ts` oraz npm script `backfill:system-knowledge-embeddings`.
- Weryfikacja: `bash scripts/with-node.sh npx tsc --noEmit` i `npm run build` zakończone sukcesem.

### Co To Da

To nie przyspieszy pojedynczego model token/sec. Przyspieszy realny workflow:

- mniej ręcznych searchy,
- mniej pierwszych nietrafionych prób,
- mniej powtarzania błędów,
- mniej tool-calli na rediscovery,
- lepszy start subtasków.

---

## 7. Etap 3 - FileTouch Ledger

**Status:** DONE 2026-05-13 dla core coding tools  
**Dokumentacja:** [docs/MASTRA-HARNESS-LAYER.md](../docs/MASTRA-HARNESS-LAYER.md)

### Cel

Zastąpić wykrywanie konfliktów po fakcie aktywnym ostrzeganiem podczas pracy.

### Mongo

`file_activity`:

```ts
{
  id: string;
  taskId: string;
  subtaskId?: string;
  agentId: string;
  threadId?: string;
  file: string;
  op: 'read' | 'write' | 'edit' | 'patch' | 'delete' | 'test';
  lineStart?: number;
  lineEnd?: number;
  summary?: string;
  diffPreview?: string;
  createdAt: Date;
  expiresAt: Date;
}
```

Indeksy:

- `{ file: 1, createdAt: -1 }`
- `{ taskId: 1, file: 1, createdAt: -1 }`
- `{ agentId: 1, createdAt: -1 }`
- `{ expiresAt: 1 }` TTL

### Serwis

`src/mastra/services/file-activity.ts`:

```ts
export async function recordFileActivity(input: FileActivityInput): Promise<void>;
export async function findPeerTouches(input: {
  taskId: string;
  file: string;
  currentAgentId: string;
  sinceMs?: number;
}): Promise<FileActivity[]>;
export function detectLineOverlap(a, b): 'overlapping_lines' | 'same_file_non_overlapping' | 'same_file';
export function formatFileConflictWarning(current, peers): string;
```

### Instrumentacja

1. `coding_write_file_tracked`
   - przed zapisem: lookup peer touches,
   - po zapisie: `recordFileActivity(op='write')`,
   - warning zwrócić w tool output.

2. `coding_record_before_change`
   - traktować jako `read`.

3. `coding_record_after_change`
   - traktować jako `edit`.

4. `coding_apply_patch`
   - każdy plik z patcha jako `patch`.

5. `runTestCommandTool`
   - komendy testowe jako `test`, bez file path albo z plikami z diagnostyki, jeśli dostępne.

### Soft Warning

Nie blokować zapisu automatycznie. Warning:

```md
File activity warning:
- `src/foo.ts` was previously edited by subtask `B`.
- Scope: overlapping lines 40-58.
- Review the latest file contents before continuing.
```

### Integracja z Pending Messages

Jeśli `FEATURE_SOFT_INTERRUPTS=true`, file conflict warning może też wejść do `pending_user_messages` dla danego task/thread.

### Testy

- Unit: line overlap parser.
- Unit: peer touches wykluczają obecnego agenta.
- Integration: dwa subtaski zapisujące ten sam plik generują warning.
- Regression: ledger failure nie blokuje write.

### Wykonane 2026-05-13

- Dodano `src/mastra/services/file-activity.ts`.
- Dodano kolekcję `file_activity` z TTL i indeksami w `mongo.ts`, `mongo-indexes.ts`, `init-db.ts`.
- `recordFileActivity()` zapisuje `read`, `write`, `edit`, `patch`, `test` jako best-effort.
- `findPeerTouches()` wyszukuje świeże peer touches dla tego samego `taskId` i pliku.
- `detectLineOverlap()` klasyfikuje `overlapping_lines`, `same_file_non_overlapping`, `same_file`.
- `formatFileConflictWarning()` generuje soft warning dla tool output.
- `coding_record_before_change` zapisuje `read`.
- `coding_record_after_change` sprawdza peer touches przed after snapshotem i zapisuje `edit`.
- `coding_write_file_tracked` sprawdza peer touches przed zapisem pliku i zapisuje `write`.
- `coding_apply_patch` sprawdza peer touches dla `filesChanged` przed merge i zapisuje `patch` po sukcesie.
- `coding_read_worktree_file` zapisuje `read`.
- `coding_run_test` zapisuje `test` z preview outputu.
- `subtask-executor.ts` instruuje agenta, żeby przekazywał `subtaskId` i `agentId` do coding tools, gdy schema to obsługuje.
- Integracja z `pending_user_messages` jest wykonana jako Soft Interrupt MVP: warning nadal wraca w tool output/eventach, a dodatkowo jest kolejkowany jako `source=file_activity`.
- Weryfikacja: `npx tsx -e` dla `detectLineOverlap()`, `bash scripts/with-node.sh npx tsc --noEmit`, `npm run build`.

---

## 8. Etap 4 - code_outline i Lepszy code_search

**Status:** MVP DONE 2026-05-13 dla `code_outline`, `code_search` V2 oraz output compaction dla search/diff outputs.

### Cel

Zbliżyć `code_search` do AgentGrep: wynik ma dawać symbole, zakresy linii, sąsiednie regiony i sugestię następnego czytania.

### RepoIndexer Schema

Rozszerzyć SQLite:

```sql
ALTER TABLE symbols ADD COLUMN end_line INTEGER DEFAULT -1;
ALTER TABLE symbols ADD COLUMN kind_detail TEXT DEFAULT '';
ALTER TABLE symbols ADD COLUMN parent_symbol TEXT DEFAULT '';
```

Dla nowych DB od razu w schema.

### Extractor

Poprawić AST extraction:

- function declaration
- method definition
- class declaration
- interface declaration
- type alias
- enum
- variable declarator z arrow function
- exported const/function/class

Każdy symbol:

- `name`
- `kind`
- `kind_detail`
- `line`
- `end_line`
- `signature`
- `parent_symbol`

### code_outline Tool

Nowy tool:

- `src/mastra/tools/dev/code-outline-tool.ts`

Input:

```ts
{
  file: string;
  repoPath?: string;
  maxSymbols?: number;
}
```

Output:

```ts
{
  success: boolean;
  file: string;
  language: string;
  totalLines: number;
  symbols: Array<{
    name: string;
    kind: string;
    signature: string;
    startLine: number;
    endLine: number;
    parentSymbol?: string;
  }>;
}
```

### code_search V2

Obecny `code_search` embedduje zbyt płytki tekst. Zmienić chunk content:

```ts
const content = [
  filePath,
  symbol.kind,
  symbol.signature,
  actualCodeRegion,
  neighborSymbolNames,
].join('\n');
```

Wynik:

```ts
{
  file,
  startLine,
  endLine,
  symbol,
  signature,
  neighborSymbols,
  snippet,
  score,
  readHint: `Read ${file}:${startLine}-${endLine}`
}
```

### Tryby

- `mode: 'semantic' | 'literal' | 'hybrid'`
- `pathsOnly?: boolean`
- `maxRegions?: number`
- `scope?: string`

W v1 wystarczy semantic + outline. Hybrid może być v2.

### Testy

- Unit: outline dla fixture TS z klasą, metodą, interface, arrow function.
- Unit: search result ma line range i signature.
- Integration: repo_map + code_search + code_outline działają na tym samym repoPath.

### Wykonane 2026-05-13

- `RepoIndexer` zapisuje `end_line`, `kind_detail` i `parent_symbol` w tabeli `symbols`; migracja czyści stary cache symboli, żeby wymusić świeży indeks.
- AST extractor rozpoznaje funkcje, metody, klasy, interface, type alias, enum i variable declarators z kind detail.
- Dodano `src/mastra/tools/dev/code-outline-tool.ts` z tool id `code_outline`.
- `codingAgent` dostał `codeOutlineTool`.
- `code_search` dostał tryby `semantic`, `literal`, `hybrid`, `pathsOnly`, `maxRegions`, `maxSnippetChars`.
- `code_search` buduje embedding/search text z realnego regionu kodu, signature, kind, parent i neighboring symbols.
- Wynik `code_search` zwraca `kind`, `signature`, `neighborSymbols` i `readHint`.
- `code_search` sam odświeża repo index i usuwa stale `code_chunks`.
- Duże wyniki `code_search` są kompaktowane do `harness_artifacts`.
- `coding_worktree_diff` używa `compactHarnessOutput(kind='diff')` i zwraca `outputArtifactId` przy dużym diffie.

---

## 9. Etap 5 - Cache Discipline

### Cel

Usunąć wzorzec, który wygląda jak cache, ale nie cache'uje. Mierzyć realny cache read/write.

### Zmiany

1. Usunąć call-level:
   - `cacheOptionsForModel()`
   - `anthropicCacheOptions()` z call-site'ów.

2. Zachować cache tylko na:
   - static system instructions,
   - ewentualnie static tool definitions, jeśli Mastra/provider to wspiera.

3. Dynamiczne bloki:
   - pre-context,
   - pending memory,
   - checkpoint,
   - file warnings
   
   nie powinny być częścią cache'owanego system promptu.

### Serwis

`src/mastra/services/llm-cache-telemetry.ts`:

```ts
export function stablePromptHash(text: string): string;
export async function recordCacheUsage(input: {
  agentId: string;
  provider: string;
  model: string;
  staticPromptHash?: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissReason?: string;
  at?: Date;
}): Promise<void>;
```

### Cache Miss Reasons

- `provider_usage_unavailable`
- `dynamic_prompt_changed`
- `model_not_cacheable`
- `cache_ttl_expired`
- `first_call`
- `unknown`

### Testy

- Static instructions dalej używają `withAnthropicSystemCache`.
- `subtask-executor` nie importuje deprecated helperów.
- Telemetria nie wywala flow, jeśli usage brak.

---

## 10. Etap 6 - Durable Background Tasks

**Status:** MVP DONE 2026-05-13 dla `background-task-manager.ts`, `bg_task` tool, integracji z `coding_run_test` i `pending-message-queue`.

Długie testy, buildy, scrapery i NotebookLM/n8n joby mają żyć poza timeoutem tool-calla.

### Mongo

`background_tasks`:

```ts
{
  taskId: string;
  ownerTaskId?: string;
  agentId: string;
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  pid?: number;
  outputFile: string;
  statusFile?: string;
  exitCode?: number;
  error?: string;
  notify: boolean;
  wake: boolean;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeatAt?: Date;
  expiresAt: Date;
}
```

Indeksy:

- `{ taskId: 1 }` unique
- `{ ownerTaskId: 1, startedAt: -1 }`
- `{ status: 1, startedAt: -1 }`
- `{ expiresAt: 1 }` TTL

### Pliki

- `.mastra/background/<taskId>.out`
- `.mastra/background/<taskId>.status.json`

### Serwis

`src/mastra/services/background-task-manager.ts`:

```ts
startTask(input): Promise<BackgroundTaskRecord>
getTask(taskId): Promise<BackgroundTaskRecord | null>
waitTask(taskId, opts): Promise<BackgroundTaskWaitResult>
tailTask(taskId, lines): Promise<string>
cancelTask(taskId): Promise<void>
cleanupTasks(opts): Promise<CleanupResult>
```

### Tool

`bg_task`:

- `start`
- `status`
- `wait`
- `tail`
- `output`
- `cancel`
- `cleanup`

### Command Safety

Użyć `requiresCodeCommandApproval()` z `code-workspace.ts`. Background nie może obchodzić approval guarda.

### Integracje

1. `runTestCommandTool`
   - dodać `background?: boolean`
   - jeśli true: startuje background task i zwraca `taskId`.

2. `coding-precontext`
   - może dołączać ostatnie zakończone background completion jako kontekst.

3. `pending-message-queue`
   - jeśli `wake=true`, completion trafia jako pending message.

### Testy

- Start `sleep 1 && echo ok`, wait zwraca completed.
- Tail pokazuje output.
- Cancel zatrzymuje proces.
- Restart-safe status: jeśli proces zakończył się, status da się odtworzyć z output/status file.

### Wykonane 2026-05-13

- Dodano `src/mastra/services/background-task-manager.ts`.
- `startBackgroundTask()` spawnuje komendy jako detached child process z output redirectowanym do `.mastra/background/<taskId>.out`.
- `background_tasks` kolekcja w Mongo z `taskId` (unique), `ownerTaskId`, `status`, `pid`, `outputFile`, `statusFile`, TTL.
- `getBackgroundTask()` sprawdza czy proces żyje i odzyskuje status z pliku `status.json`, jeśli proces zakończył się między restartami.
- `waitBackgroundTask()` polluje z timeoutem (max 10 min).
- `tailBackgroundTask()` czyta ostatnie N linii z pliku outputu.
- `cancelBackgroundTask()` wysyła SIGTERM do procesu i oznacza jako `cancelled`.
- `cleanupBackgroundTasks()` usuwa stare zakończone taski.
- Dodano `src/mastra/tools/dev/background-task-tool.ts` z tool id `bg_task`.
- `bg_task` obsługuje 8 akcji: `start`, `status`, `wait`, `tail`, `output`, `cancel`, `cleanup`, `list`.
- `bg_task` jest objęty `withToolEnvelope()` z policy guard dla `start`.
- `bg_task` jest podpięty do `codingAgent`.
- `coding_run_test` dostał `background?: boolean` i `wake?: boolean` — jeśli `background=true`, test jest startowany jako background task.
- Completion jako pending message: gdy `wake=true`, zakończenie taska kolejkuje `pending_user_messages` z `source=background_task` i `urgent=true` dla failów.
- Replay script rozszerzony o sekcję `Background Tasks`.
- Dodano indeksy Mongo dla `background_tasks` w `mongo.ts`, `mongo-indexes.ts` i `init-db.ts`.
- Weryfikacja: `bash scripts/with-node.sh npx tsc --noEmit`, `git diff --check`, `npm run build`.

---

## 11. Etap 7 - Soft Interrupt, Wersja Bezpieczna dla Mastry

**Status:** MVP DONE 2026-05-13 dla `pending_user_messages`, `subtask-executor.ts`, `parallel-dispatch.ts` i FileTouch warnings.

### Cel

Nie wstrzykiwać wiadomości w środek aktywnego provider stream. Kolejkować i konsumować między subtaskami/grupami.

### Mongo

`pending_user_messages`:

```ts
{
  id: string;
  taskId?: string;
  threadId?: string;
  source: 'user' | 'system' | 'file_activity' | 'background_task';
  content: string;
  urgent: boolean;
  status: 'pending' | 'consumed' | 'cancelled' | 'stale';
  createdAt: Date;
  consumedAt?: Date;
  expiresAt: Date;
}
```

Indeksy:

- `{ taskId: 1, status: 1, createdAt: 1 }`
- `{ threadId: 1, status: 1, createdAt: 1 }`
- `{ expiresAt: 1 }` TTL

### Serwis

`src/mastra/services/pending-message-queue.ts`:

```ts
queuePendingMessage(input): Promise<string>
takePendingMessages(input): Promise<PendingMessage[]>
hasUrgentInterrupt(input): Promise<boolean>
markConsumed(ids): Promise<void>
```

### Injection Points

W `parallel-dispatch.ts`:

1. przed startem grupy,
2. po zakończeniu grupy,
3. przed retry,
4. przed escalation,
5. przed final summary.

W `subtask-executor.ts`:

- nie przerywać aktywnego `agent.generate`.
- jeśli pending message istnieje przed startem subtasku, dokleić do promptu.

### Urgent

Jeśli `urgent=true`:

- nie startować kolejnych grup,
- oznaczyć aktualny plan jako wymagający replan,
- do promptu dołączyć:

```md
## User/System Interrupt
Urgent instruction received before the next execution group:
...
Re-evaluate the remaining plan before continuing.
```

### Testy

- Pending message zostaje skonsumowana przed kolejną grupą.
- Urgent zatrzymuje dispatch.
- Nie ma injectu w środku aktywnego tool-call/result pair.

### Wykonane 2026-05-13

- Dodano `src/mastra/services/pending-message-queue.ts` z `queuePendingMessage()`, `takePendingMessages()`, `hasUrgentInterrupt()` i `markConsumed()`.
- Dodano kolekcję `pending_user_messages` z indeksami po `taskId`, `threadId`, `status`, `createdAt` i TTL po `expiresAt`.
- `queuePendingMessage()` redaguje sekrety, zapisuje scoped pending message i loguje `soft_interrupt_queued`.
- `takePendingMessages()` konsumuje wiadomości w safe pointach, oznacza je jako `consumed` i loguje `soft_interrupt_consumed`.
- `formatPendingMessagesForPrompt()` generuje blok `## User/System Interrupt` dla promptu subtasku.
- `file-activity.ts` kolejuje conflict warning jako `source=file_activity` przy `FEATURE_SOFT_INTERRUPTS=true`.
- `subtask-executor.ts` dokleja pending messages przed `agent.generate()` i sprawdza urgent interrupt przed retry/escalation.
- `parallel-dispatch.ts` konsumuje pending messages przed startem grupy; urgent interrupt zatrzymuje pozostałe grupy jako `needs_human`, żeby wymusić replan.

---

## 12. Kolejność Wdrożenia

### Sprint 1

1. [x] Etap 0 - telemetria i feature flagi.
2. [x] `Mastra Harness Layer` w trybie log-only.
3. [x] `generateCoding()` jako jedna brama dla `subtask-executor.ts`.
4. [x] Etap 1 - auto pre-context.
5. [x] Poprawka `context-assembler.ts` na explicit `repoPath`.
6. [x] Usunięcie deprecated cache call-site w `subtask-executor.ts`.

Efekt: szybki zysk jakościowy przy małym ryzyku.

### Sprint 2

1. [x] Etap 2 - async semantic memory MVP.
2. [x] Skrypt backfill embeddingów `system_knowledge`.
3. [x] Deduplikacja injectów.
4. [x] Run state: `agent_runs`, `agent_run_events`, `turnId`.

Efekt: pamięć zaczyna działać jak część harnessu.

### Sprint 3

1. [x] Etap 3 - FileTouch ledger.
2. [x] Etap 7 - pending message queue w minimalnej wersji, żeby FileTouch mógł wysyłać warningi.
3. [x] Tool envelope dla `coding_write_file_tracked` i `coding_run_test`.
4. [x] Rozszerzyć tool envelope na `coding_read_worktree_file`.
5. [x] Policy layer w trybie warning/log-only.

Efekt: mniej konfliktów przy parallel dispatch.

### Sprint 4

1. [x] Etap 4 - `code_outline`.
2. [x] Etap 4 - `code_search` V2.
3. [x] Output compaction dla `coding_run_test`.
4. [x] Output compaction dla search/diff outputs.

Efekt: mniej czytania całych plików, szybsza orientacja w repo.

### Sprint 5

1. [x] Etap 6 - background tasks.
2. [x] Integracja z test/build commands.
3. [x] Completion jako pending message.
4. [x] Replay script dla pojedynczego `runId` (rozszerzony o background tasks).

Efekt: długie prace nie blokują agent loopa.

### Sprint 6

1. [x] Etap 7 - soft interrupt pełniej w dispatch/retry/escalation.
2. [x] Hardening i testy regresji.
3. [x] Przeniesienie coding call-site'ów w `repo-maintenance.ts` na harness.
4. [x] Audit bezpośrednich `agent.generate()` w coding flow.

#### Wykonane 2026-05-13

- **repo-maintenance.ts**: Zamieniono wszystkie 10 bezpośrednich `agent.generate()` na `generateCoding()` z odpowiednimi fazami:
  - `diagnose` (diagnoseAndPlan step)
  - `subtask` (executePatch: worktree init + legacy single-agent)
  - `review` (executeReviewAgent + re-review)
  - `merge` (decisionGate: commit, apply_patch, PR merge)
  - `retry` (decisionGate: rework po needs_changes)
  - `cleanup` (decisionGate: usuwanie worktree po PR merge)
- **delegate-task.ts**: codingAgent delegacje teraz routowane przez `generateCoding()` z `phase: 'chat'`. Pozostałe agenty (marketing, sales, analytics) zostają na bezpośrednim `agent.generate()` z adnotacją `@harness-exempt`.
- **external-projects-tools.ts**: `delegateToReviewerTool` przemigrowany na `generateCoding()` z `phase: 'review'`.
- **audit-coding-generate.ts**: Skrypt regresji skanujący coding flow pod kątem bezpośrednich `agent.generate()`. Wynik: `✅ No direct agent.generate() calls found in coding flow. Scanned 140 files`.
- Weryfikacja: `npx tsc --noEmit` ✅, `npm run build` ✅, `npx tsx audit-coding-generate.ts` ✅.

---

## 13. Czy To Zbliży Szybkość Pracy do jcode?

Tak, ale nie dlatego, że model będzie generował tokeny szybciej.

Zbliżenie do jcode przyjdzie z mniejszej liczby zbędnych kroków:

- mniej ręcznego `memory_recall`,
- mniej ręcznego `skill_search`,
- mniej czytania całych plików,
- mniej powtórek tych samych błędów,
- mniej konfliktów między subagentami,
- mniej czekania na build/test,
- lepszy cache statycznych promptów.

Najważniejszy pakiet:

1. async semantic memory,
2. auto pre-context,
3. code outline/search V2,
4. background tasks,
5. cache discipline.

Sama pamięć semantyczna nie wystarczy. jcode wygrywa przez harness, który stale podsuwa właściwy kontekst i chroni flow przed kosztownymi pomyłkami.

---

## 14. Future: Pełniejsza Pamięć Jak jcode

### 14.1 Memory Graph

Obecne `system_knowledge` jest płaską kolekcją. Docelowo dodać graf:

```ts
memory_nodes:
  id
  type
  title
  content
  tags
  confidence
  embedding
  projectId
  createdAt
  updatedAt

memory_edges:
  fromId
  toId
  kind: 'relates_to' | 'supersedes' | 'contradicts' | 'derived_from' | 'same_cluster'
  weight
  createdAt
```

Użycie:

- embedding hit jest seedem,
- potem BFS po tagach/relacjach,
- model dostaje nie tylko hit, ale też powiązane decyzje i ostrzeżenia.

### 14.2 Project vs Global Memory

Podzielić wiedzę:

- `global`: preferencje użytkownika, ogólne patterny, tool contracts,
- `project`: fakty i decyzje dla konkretnego repo/projektu,
- `thread`: krótkoterminowy kontekst rozmowy.

Retrieval powinien robić:

1. thread memory,
2. project memory,
3. global memory.

### 14.3 Confidence i Decay

Dodać scoring:

- memory użyte i pomocne -> confidence +0.05,
- memory odrzucone lub stale -> confidence -0.02,
- bardzo stare i nieużywane -> decay,
- sprzeczne memory -> oznaczyć jako `contradicts`, nie usuwać od razu.

### 14.4 Clusters

Dodać automatyczne klastry:

- grupować memory, które często są zwracane razem,
- liczyć centroid embeddingów,
- nadać klastrowi nazwę przez tani model,
- w retrievalu najpierw znaleźć klaster, potem najlepsze memory w środku.

To jest v2. Na start wystarczy pending semantic memory.

### 14.5 Memory Gap Logging

Jeśli task kończy się błędem i memory recall nic nie znalazł:

- zapisać `memory_gap`,
- po rozwiązaniu wygenerować z niego `failure_case` albo `autoheal_recipe`.

Efekt: system uczy się szczególnie z braków pamięci.

### 14.6 Sidecar Verifier

Po embedding hits można użyć taniego modelu do relevance verification:

```txt
Context: aktualny task
Memory: kandydat
Czy memory jest faktycznie przydatne? yes/no + powód
```

Nie robić tego dla 300 dokumentów. Tylko dla top 5-8 embedding hits.

### 14.7 Memory UI

Dodać dashboard:

- ostatnie injecty,
- suppressions,
- top recalled memory,
- memory gaps,
- confidence changes,
- stale memories.

To ułatwi debug, bo pamięć pasywna jest niewidoczna, jeśli jej nie pokazujemy.

### 14.8 Lokalny Cache Grafu Pamięci

jcode korzysta z szybkiego lokalnego cache'u grafu pamięci, żeby retrieval nie musiał za każdym razem skanować pełnego źródła danych od zera.

Docelowo dodać procesowy cache:

```ts
type MemoryGraphCacheEntry = {
  projectId?: string;
  graphVersion: string;
  loadedAt: Date;
  nodeCount: number;
  edgeCount: number;
  graph: MemoryGraph;
};
```

Źródłem invalidacji powinno być:

- `updatedAt` / `graphVersion` w Mongo,
- licznik zmian w `memory_graph_meta`,
- opcjonalnie mtime pliku, jeśli część pamięci będzie trzymana w lokalnym JSON/SQLite.

Zasada:

1. Retrieval pyta cache o graf dla `projectId`.
2. Cache sprawdza `graphVersion`.
3. Jeśli wersja jest aktualna, zwraca graf z RAM.
4. Jeśli wersja się zmieniła, ładuje tylko aktualne node/edge sety.

To powinno wejść dopiero po MVP async memory. W pierwszym etapie wystarczy embedding-first retrieval z Mongo. Cache grafu ma sens, gdy pojawią się relacje, klastry i project/global/thread memory.

---

## 15. Future: Co Jeszcze Pożyczyć z jcode

### 15.1 Tool Result Compaction

jcode pilnuje rozmiaru tool resultów i historii. Bazowa wersja jest częścią `Mastra Harness Layer`; future rozszerzenie to:

- model-generated summary dla outputów > N KB,
- semantyczne indeksowanie pełnych logów,
- automatyczne wykrywanie najważniejszych błędów w test/build output,
- porównywanie nowych błędów z wcześniejszymi failure cases.

Najbardziej przydatne dla:

- test logs,
- build logs,
- scraper outputs,
- NotebookLM/n8n diagnostics.

### 15.2 Append-only Cache Tracker

jcode ma mechanizm wykrywania, czy prefix rozmowy pozostał append-only. U nas można dodać:

- hash static instructions,
- hash ostatniego cacheable prefixu,
- event `cache_prefix_changed`,
- reason: compaction, dynamic injection, model switch, tool list change.

### 15.3 Catch-up Summary

Po przejęciu starego taska/session:

- zebrać ostatnie decyzje,
- pliki dotknięte,
- background taski,
- pending warnings,
- unresolved failures.

To jest szczególnie dobre dla długich workflowów repo-maintenance.

### 15.4 Native Safety Queue

Bazowy policy layer jest częścią harnessu. Future wersja może dodać jcode-like kolejkę bezpieczeństwa:

- lokalne read/test -> auto allow,
- komunikacja z ludźmi -> approval,
- push/deploy/delete -> approval,
- system package/network install -> approval.

Ważne: ten system powinien być niezależny od promptu agenta.

### 15.5 Session Event Replay

Bazowy replay jest częścią harnessu. Future rozszerzenie dla debugowania:

- timeline UI,
- filtrowanie po subtasku/agencie/toolu,
- porównywanie dwóch runów,
- eksport replay jako markdown,
- automatyczne tworzenie failure_case z replayu.

Potem można odtworzyć przebieg taska bez czytania surowych logs.

### 15.6 Better Subagent Transcript Return

jcode pozwala zwracać final answer albo compact/full transcript. U nas subtask result może mieć:

- `answerOnly`,
- `compactTranscript`,
- `fullArtifactRef`.

To zmniejsza tokeny w koordynatorze, ale zostawia możliwość audytu.

### 15.7 Ambient Maintenance

Osobny worker nocny:

- backfill embeddings,
- cleanup stale file_activity,
- compress large tool outputs,
- extract memory from failed tasks,
- recompute skill success rates,
- detect recurring failures.

To przenosi housekeeping poza aktywną rozmowę.

---

## 16. Minimalny MVP

Jeśli robić tylko najkrótszą ścieżkę:

1. [x] `coding-harness.ts` w trybie log-only.
2. [x] `generateCoding()` jako wrapper dla `subtask-executor.ts`.
3. [x] `system_knowledge.searchText = title + content + tags + type`.
4. [x] Skrypt backfill embeddingów.
5. [x] `pending_memory_context`.
6. [x] `coding-precontext.ts`.
7. [x] Deduplikacja `injected_memory_context`.
8. [x] Usunięcie deprecated cache call-site.
9. [x] Minimalny `agent_runs` + `agent_run_events`.
10. [x] Tool envelope dla `coding_write_file_tracked` i `coding_run_test`.

To powinno dać największy wzrost jakości bez dotykania najtrudniejszych części.

---

## 17. Ryzyka

### Zbyt dużo kontekstu

Ryzyko: pre-context będzie puchł i psuł latency.

Mitigacja:

- twardy token budget,
- top 3 memory,
- top 3 skills,
- repo map max 1200 tokenów,
- log token estimate.

### Stale memory

Ryzyko: agent zaufa starej informacji.

Mitigacja:

- każda sekcja memory ma ostrzeżenie: prefer current files,
- TTL renew tylko dla użytych memory,
- confidence decay.

### Embedding service latency

Ryzyko: sync recall spowolni start.

Mitigacja:

- pending async jako główna ścieżka,
- sync fallback z timeoutem,
- brak embeddingów nie blokuje.

### Konflikty narzędzi

Ryzyko: FileTouch warning będzie noisy.

Mitigacja:

- ostrzegać głównie na write/edit/patch,
- reads tylko jako kontekst,
- suppress non-overlapping low-risk warnings po czasie.

### Cache regression

Ryzyko: dynamiczny pre-context trafi do cacheable instructions.

Mitigacja:

- wrapper dokleja dynamic context do promptu, nie do agent instructions,
- static prompt hash telemetry.

### Harness divergence

Ryzyko: część coding flowów pójdzie przez harness, a część dalej bezpośrednio przez `agent.generate()`.

Mitigacja:

- najpierw przenieść `subtask-executor.ts`,
- potem `repo-maintenance.ts`,
- dodać audit script dla direct generate,
- wymagać komentarza `HARNESS_DIRECT_GENERATE_OK` dla świadomych wyjątków.

### Zbyt agresywna policy

Ryzyko: policy layer zacznie blokować poprawne prace agenta.

Mitigacja:

- start w trybie warning/log-only,
- block tylko dla oczywistych przypadków: write poza worktree, delete, deploy, push,
- dodać event `policy_blocked` z jasnym reason,
- umożliwić override przez istniejący approval flow.

### Replay kosztuje za dużo miejsca

Ryzyko: `agent_run_events`, `tool_executions` i artifacts szybko urosną.

Mitigacja:

- TTL na verbose eventy,
- preview w Mongo,
- pełne duże outputs w plikach `.mastra/harness-artifacts`,
- hash i rozmiar zamiast duplikacji pełnej treści.

---

## 18. Definition of Done

Plan uznajemy za wdrożony, gdy:

- `codingAgent.generate` w coding workflows idzie przez wrapper,
- pasywny pre-context działa za flagą,
- system memory ma embeddingi z pełnego `searchText`,
- pending memory jest liczona async i konsumowana w następnej turze,
- memory injecty są deduplikowane,
- FileTouch ledger ostrzega przy równoległych edycjach,
- `code_outline` działa dla TS/JS,
- `code_search` zwraca symbol + zakres linii + readHint,
- cache no-op call-site'y są usunięte,
- background task manager obsługuje start/status/wait/tail/cancel,
- soft interrupt działa między grupami/subtaskami,
- `agent_runs` zapisuje run/phase/status dla coding tasks,
- `tool_executions` loguje start/end/błędy dla podstawowych coding tools,
- output compaction chroni prompt przed dużymi logs,
- policy layer działa przynajmniej w trybie warning/log-only,
- replay script pokazuje przebieg pojedynczego `runId`,
- wszystkie etapy da się wyłączyć feature flagami.

---

## 19. Pre-flight Wykonany - Stabilizacja Automation Architect

### Status

Wykonane 2026-05-13, przed startem wdrożenia memory/harness planu.

Decyzja: najpierw zamknąć problem Automation Architect, bo agent nie domykał pełnej sekwencji budowa -> deploy -> test -> opcjonalne podłączenie/aktywacja. Dopiero po tym przechodzimy do jcode-inspired memory and harness plan.

### Co Zostało Ustabilizowane

- Dodano jedną deterministyczną bramę wykonawczą `architect_execute_automation_request`.
- Dodano `AutomationGoldenPath`, który prowadzi automatyzację przez validate -> risk -> deploy inactive -> mock test -> repair loop -> opcjonalną aktywację.
- Zmieniono prompt Automation Architect tak, żeby dla build/deploy/test/activation preferował Golden Path zamiast ręcznej sekwencji narzędzi.
- Wzmocniono delegację z Meta Agenta: wynik Automation Architect nie jest traktowany jako sukces bez terminalnego statusu i identyfikatorów automatyzacji/workflow tam, gdzie są wymagane.
- Wzmocniono walidację i scoring ryzyka dla niebezpiecznego kodu w workflow, m.in. `$helpers.executeCommandSync`.
- Podłączono repair workflow jako funkcję używaną przez Golden Path.
- Dodano smoke check `check:automation-golden-path` i wpięto go do `check:automation`.
- Uporządkowano node registry względem lokalnego n8n:
  - `n8n-nodes-base.telegramTrigger` obsługuje wersje `1`, `1.1`, `1.2`,
  - `n8n-nodes-base.html` obsługuje wersje `1`, `1.1`, `1.2`,
  - RSS używa realnego lokalnego typu `n8n-nodes-base.rssFeedReadTrigger` z parametrem `feedUrl`.

### Wynik Weryfikacji

- `npm run check:automation-patterns`: `37 passed`, `1 warnings`, `0 failed`, `5 skipped`.
- `npm run check:automation`: zakończone sukcesem; Golden Path blokuje unsafe workflow i przeprowadza safe workflow przez deploy/test/cleanup.
- `npm run build`: zakończone sukcesem.

Pozostałe ostrzeżenia nie blokują przejścia do planu. Dotyczą brakujących credential env:

- `N8N_CREDENTIAL_GMAIL_ID`
- `N8N_CREDENTIAL_HTTP_ID`
- pattern `draft-only-email-assistant` raportuje brak credential `gmail`

Te warningi trzeba uzupełnić dopiero przed uruchamianiem automatyzacji wymagających Gmail/HTTP credentials.

### Dokumentacja

Szczegóły zmian, kontrakt operacyjny i lista plików są opisane w [docs/AUTOMATION-ARCHITECT-STABILIZATION.md](../docs/AUTOMATION-ARCHITECT-STABILIZATION.md).
