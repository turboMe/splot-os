# Mastra Harness Layer

> Status: Etap 4 + pierwsza lista Tool Envelope + Output Compaction MVP + Policy log-only MVP + Replay CLI MVP + Soft Interrupt MVP + Code Outline/Search V2 MVP wykonane dla core coding tools; Automation Architect ma Sprint A/B + Pre-Sprint C autonomy plumbing; Knowledge Agent harness zamkniety po testach runtime/API/UI 2026-05-14  
> Data: 2026-05-13  
> Zakres: telemetria, kontrakty eventow, feature flagi, log-only harness, auto pre-context, async semantic memory, run state, FileTouch Ledger, Tool Execution Envelope dla pierwszej listy, output compaction dla test/search/diff outputs, replay CLI, pending message queue dla soft interrupts oraz strukturalny code outline/search.

## Cel

Mastra zostaje runtime'em agentow, workflowow, narzedzi i modeli. Harness jest cienka warstwa operacyjna nad tym runtime'em: ma dawac jedno miejsce na pre-context, run state, soft interrupts, tool envelope, output compaction, policy i replay.

Etap 0 nie zmienia zachowania agentow. Dodaje tylko wspolne kontrakty, zeby kolejne etapy byly mierzalne i mozliwe do debugowania.

## Wdrozone

### Feature Flagi

Dopisano flagi rolloutowe w `.env.example`:

- `FEATURE_CODING_PRECONTEXT`
- `FEATURE_AUTOMATION_PRECONTEXT`
- `FEATURE_KNOWLEDGE_PRECONTEXT`
- `FEATURE_ASYNC_SEMANTIC_MEMORY`
- `FEATURE_FILE_ACTIVITY_LEDGER`
- `FEATURE_CODE_OUTLINE`
- `FEATURE_BACKGROUND_TASKS`
- `FEATURE_SOFT_INTERRUPTS`
- `FEATURE_MASTRA_HARNESS`
- `FEATURE_TOOL_ENVELOPE`
- `FEATURE_OUTPUT_COMPACTION`
- `FEATURE_HARNESS_POLICY`
- `FEATURE_HARNESS_REPLAY`

Runtime helper jest w `src/mastra/config/harness-flags.ts`. Funkcja `isHarnessFeatureEnabled()` przyjmuje jawny default per call-site. `coding-harness.ts` uzywa default `true`, bo obecny etap jest log-only i nie zmienia promptu ani decyzji agenta. Kolejne warstwy zmieniajace zachowanie powinny uzywac ostrozniejszych defaultow albo wymagac jawnej flagi.

Knowledge Agent ma osobna brame `generateKnowledge()` w `src/mastra/services/knowledge-harness.ts`. Uzywa `FEATURE_KNOWLEDGE_PRECONTEXT`, dodaje kompaktowy NotebookLM pre-context, zapisuje run state przez wspolny `generateWithHarness()` i wspiera async delegation results przez `pending_user_messages`. Ten zakres zostal zamkniety 2026-05-14 po pozytywnych testach runtime/API/UI.

`HARNESS_POLICY_MODE=log_only` wlacza warning/log-only dla policy. Tryb `enforce` jest przygotowany w kodzie, ale nie jest domyslny.

### Event Contract

Rozszerzono `AgentEventType` w `src/mastra/lib/agent-event-log.ts` o typy harnessowe, m.in.:

- `run_started`, `run_completed`, `run_failed`
- `llm_call_started`, `llm_call_completed`, `llm_call_failed`
- `precontext_injected`
- `semantic_memory_*`
- `file_touch`, `file_conflict_warning`
- `soft_interrupt_queued`, `soft_interrupt_consumed`
- `tool_call_*`
- `tool_output_compacted`
- `policy_allowed`, `policy_blocked`
- `cache_usage_observed`, `cache_miss_reason`

Schemat eventu dopuszcza teraz pola `runId`, `turnId`, `threadId`, `feature` i `data`.

### Harness Event Helper

Dodano `src/mastra/services/harness-events.ts`:

- `HARNESS_EVENT_TYPES`
- `HarnessEventInput`
- `logHarnessEvent()`
- `tokenEstimate()`

`logHarnessEvent()` opiera sie na istniejacym `logAgentEvent()`, wiec awaria Mongo/event logu nie blokuje pracy agenta.

## Kontrakt Dla Kolejnych Etapow

Kazda nowa warstwa harnessu powinna logowac przez `logHarnessEvent()` i uzywac tego samego zestawu pol:

- `agentId`
- `runId`
- `turnId`
- `threadId`
- `taskId`
- `subtaskId`
- `feature`
- `durationMs`
- `data`

Dla injectowanych blokow kontekstu uzywamy `tokenEstimate(text)`, czyli `Math.ceil(text.length / 4)`.

## Log-only Coding Harness

Dodano `src/mastra/services/coding-harness.ts` z publicznym API:

- `generateCoding(input)`
- `HarnessGenerateInput`
- `HarnessGenerateResult`
- `HarnessPhase`

Na tym etapie wrapper:

- nadaje `runId` i `turnId`,
- liczy `promptHash`,
- szacuje tokeny promptu przez `tokenEstimate()`,
- wykonuje `agent.generate()` bez zmiany promptu,
- zachowuje timeout znany z `subtask-executor`,
- loguje `llm_call_started`, `llm_call_completed` albo `llm_call_failed`,
- zwraca oryginalna odpowiedz w `result.response`.

`src/mastra/services/subtask-executor.ts` jest pierwszym call-site'em przepietym na `generateCoding()`. To daje jedna brame dla subtaskow codingowych bez wlaczania jeszcze pre-contextu ani asynchronicznej pamieci.

Usunieto z tego call-site'u `cacheOptionsForModel()`. Ten helper jest oznaczony jako deprecated i jego call-level `providerOptions` nie wlaczaly realnego Anthropic prompt cachingu.

## Run State

Dodano `src/mastra/services/harness-run-state.ts` z publicznym API:

- `beginHarnessTurn(input)`
- `completeHarnessTurn(input)`
- `failHarnessTurn(input)`
- `appendRunEvent(input)`

`generateCoding()` zapisuje teraz trwaly stan runu przed wywolaniem modelu, po sukcesie i po bledzie.

`agent_runs` przechowuje:

- `runId`, `threadId`, `taskId`, `agentId`
- `status`: `active`, `waiting`, `completed`, `failed`, `cancelled`
- `phase` i `currentSubtaskId`
- `repoPath`, `model`
- `safeInterruptPoint`
- `lastPromptHash`, `lastContextHash`, `lastProviderCallAt`
- `turnCount`
- `createdAt`, `updatedAt`, opcjonalnie `completedAt`, `errorClass`, `errorMessage`

Stan tury:

- przed `agent.generate()` run przechodzi w `active`, `safeInterruptPoint=false`;
- po sukcesie tury run przechodzi w `waiting`, `safeInterruptPoint=true`;
- po bledzie tury run przechodzi w `failed`, `safeInterruptPoint=true`;
- kolejny retry moze ponownie ustawic run na `active`.

`agent_run_events` przechowuje timeline runu: `run_started`, `run_phase_changed`, `llm_call_started`, `llm_call_completed`, `llm_call_failed`, `run_failed`. Dane sa TTL-owane po 30 dniach. Dodatkowo `run_started`, `run_phase_changed` i `run_failed` sa logowane przez `logHarnessEvent()` do istniejacego `agent_events`.

Run state jest best-effort. Blad Mongo przy zapisie stanu nie blokuje wywolania agenta.

## FileTouch Ledger

Dodano `src/mastra/services/file-activity.ts` z publicznym API:

- `recordFileActivity(input)`
- `findPeerTouches(input)`
- `detectLineOverlap(current, peer)`
- `formatFileConflictWarning(current, peers)`
- `getFileActivityWarning(input)`

Ledger jest aktywny tylko przy `FEATURE_FILE_ACTIVITY_LEDGER=true`. Dziala jako soft warning: awaria Mongo albo ledgeru nie blokuje odczytu, zapisu, testu ani merge.

Mongo `file_activity` zapisuje:

- `taskId`, `subtaskId`, `agentId`, `threadId`
- `file`
- `op`: `read`, `write`, `edit`, `patch`, `delete`, `test`
- opcjonalne `lineStart`, `lineEnd`
- `summary`, `diffPreview`
- `createdAt`, `expiresAt`

Indeksy:

- `{ file: 1, createdAt: -1 }`
- `{ taskId: 1, file: 1, createdAt: -1 }`
- `{ agentId: 1, createdAt: -1 }`
- `{ expiresAt: 1 }` TTL

Instrumentacja MVP:

- `coding_record_before_change` zapisuje `read`;
- `coding_record_after_change` sprawdza peer touches przed zapisem after snapshotu i zapisuje `edit`;
- `coding_write_file_tracked` sprawdza peer touches przed zapisem pliku i zapisuje `write`;
- `coding_apply_patch` sprawdza peer touches dla `filesChanged` przed merge i zapisuje `patch` po sukcesie;
- `coding_read_worktree_file` zapisuje `read`;
- `coding_run_test` zapisuje `test` z preview outputu.

Soft warning wraca w tool output, np. w polu `fileActivityWarning` albo `fileActivityWarnings`, oraz jest logowany jako `file_conflict_warning` w `agent_events`.

`subtask-executor.ts` dopisuje do promptu, zeby narzedzia codingowe dostawaly `subtaskId` i `agentId`, gdy schema je akceptuje. To pozwala odroznic rownolegle subtaski tego samego `codingAgent`.

Przy `FEATURE_SOFT_INTERRUPTS=true` warning jest tez kolejkowany w `pending_user_messages` jako `source=file_activity`. Nadal wraca bezposrednio w wyniku narzedzia i eventach, wiec integracja pozostaje backward-compatible.

## Tool Execution Envelope

Dodano `src/mastra/services/harness-tool-envelope.ts` z publicznym API:

- `withToolEnvelope()`
- `buildToolPreview()`
- `classifyToolError()`

Envelope jest log-only i best-effort. Przy `FEATURE_TOOL_ENVELOPE=false` narzedzie wykonuje sie tak jak przed integracja. Przy wlaczonej fladze envelope:

- zapisuje `tool_call_started`;
- wykonuje oryginalne `execute`;
- klasyfikuje wynik `success: false` jako `failed` albo `blocked`;
- zapisuje `tool_call_completed` albo `tool_call_failed`;
- zapisuje dokument do `tool_executions`;
- redaguje sekrety i ucina preview wejscia/wyjscia;
- dla `coding_write_file_tracked` redaguje pole `content`, zeby pelna tresc pliku nie trafiala do preview telemetrycznego.

Mongo `tool_executions` przechowuje:

- `id`, `runId`, `turnId`, `taskId`, `subtaskId`, `agentId`
- `toolId`, `category`, `risk`
- `status`: `started`, `completed`, `failed`, `blocked`
- `inputPreview`, `outputPreview`
- `durationMs`, `errorClass`, `errorMessage`
- `createdAt`, `completedAt`, `expiresAt`

Indeksy:

- `{ runId: 1, createdAt: 1 }`
- `{ taskId: 1, createdAt: -1 }`
- `{ toolId: 1, createdAt: -1 }`
- `{ expiresAt: 1 }` TTL

Instrumentacja pierwszej listy:

- `coding_write_file_tracked`
- `coding_record_before_change`
- `coding_record_after_change`
- `coding_apply_patch`
- `coding_run_test`
- `coding_read_worktree_file`
- `coding_worktree_diff`
- `code_search`
- `repo_map`
- `system_memory_recall`
- `skill_search`

`runId` i `turnId` sa opcjonalnymi polami wejscia narzedzi. Gdy `runId` nie zostanie przekazany, envelope uzywa `taskId` jako lokalnego scope runu. Pelne przekazywanie `turnId` do tool calli wymaga pozniejszej integracji z brama tool-call w runtime albo dodatkowego injectu w harness prompt.

## Output Compaction MVP

Dodano `src/mastra/services/harness-output-compactor.ts` z publicznym API:

- `compactHarnessOutput()`
- `compactTextForPreview()`

Compaction jest aktywna przy `FEATURE_OUTPUT_COMPACTION=true`. MVP obejmuje tylko `coding_run_test`.

Zasady startowe:

- preview command/test output: 16 KB;
- pelny output jest redagowany przez `redactSecrets()`;
- gdy output miesci sie w limicie, wraca bez artifactu;
- gdy output przekracza limit, do modelu wraca krotki blok `Output truncated`;
- pelny output trafia do `harness_artifacts`;
- storage `mongo` jest uzywany do 512 KB;
- storage `file` zapisuje tresc do `.mastra/harness-artifacts/<artifactId>.txt`.

Mongo `harness_artifacts` przechowuje:

- `id`, `runId`, `turnId`, `threadId`, `taskId`, `subtaskId`, `agentId`, `toolId`
- `kind`: `tool_output`, `llm_output`, `command_log`, `diff`, `memory_context`
- `storage`: `mongo` albo `file`
- `content` albo `filePath`
- `bytes`, `sha256`
- `createdAt`, `expiresAt`
- `metadata`

Indeksy:

- `{ id: 1 }` unique
- `{ runId: 1, createdAt: 1 }`
- `{ taskId: 1, createdAt: -1 }`
- `{ kind: 1, createdAt: -1 }`
- `{ expiresAt: 1 }` TTL

`coding_run_test` zapisuje teraz w `commandsRun` i `testResult`:

- `outputPreview`
- `outputArtifactId`
- `outputTruncated`
- `originalBytes`
- `previewBytes`

## Policy Layer MVP

Dodano `src/mastra/services/harness-policy.ts` z publicznym API:

- `getHarnessPolicyMode()`
- `evaluateAndLogHarnessPolicy()`
- typy `HarnessPolicyRequest` i `HarnessPolicyDecision`

Domyslny tryb to `log_only`. Policy podejmuje decyzje tak, jakby mogla blokowac akcje, ale `effectiveAllow=true` zostaje zachowane, wiec obecny rollout nie zmienia zachowania narzedzi. Decyzje sa logowane jako `policy_allowed` albo `policy_blocked` z `enforcementMode`, `enforced`, `effectiveAllow`, `severity`, `matchedRule` i `reason`.

Startowe reguly:

- read file w worktree/repo workspace: allow;
- write file tylko w task worktree: allow;
- write bez artifactu/worktree albo poza worktree: would-block w log-only;
- `npm run build`, testy, lint i read-only shell/git commands: allow;
- package install, network fetch, git mutation i nieznane komendy: approval/warning w log-only;
- destrukcyjne komendy: would-block w log-only;
- `coding_apply_patch`: approval/warning, bo mutuje live repo.

Integracja MVP:

- `withToolEnvelope()` przyjmuje opcjonalny builder `policy`;
- `tool_executions.policyDecision` zapisuje skrot decyzji;
- `coding_write_file_tracked` loguje `write_file`;
- `coding_read_worktree_file` loguje `read_file`;
- `coding_run_test` loguje `run_command`;
- `coding_apply_patch` jest teraz objety envelope i loguje `apply_patch`.

Tool output zwraca te same metadane. `harness-tool-envelope.ts` odczytuje `outputArtifactId` z wyniku toola i zapisuje go w `tool_executions` oraz eventach `tool_call_*`.

Event `tool_output_compacted` jest logowany po skompaktowaniu duzego outputu.

## Replay CLI MVP

Dodano `src/mastra/scripts/replay-harness-run.ts`.

Uruchomienie:

```bash
npx tsx src/mastra/scripts/replay-harness-run.ts <runId>
npx tsx src/mastra/scripts/replay-harness-run.ts <runId> --json
```

Skrypt czyta:

- `agent_runs`
- `agent_run_events`
- `agent_events`
- `tool_executions`
- `harness_artifacts`

Output tekstowy pokazuje:

- run summary;
- model calls;
- tools;
- memory;
- warnings;
- artifacts;
- timeline.

Replay laczy dane po `runId` i po `taskId` znalezionym w `agent_runs`. To jest potrzebne, bo do czasu pelnej bramy tool-call runtime czesc tooli moze zapisac `runId=taskId`, jesli agent nie przekaze jawnie `runId`/`turnId`.

## Soft Interrupt MVP

Dodano `src/mastra/services/pending-message-queue.ts` z publicznym API:

- `queuePendingMessage()`
- `takePendingMessages()`
- `hasUrgentInterrupt()`
- `markConsumed()`
- `formatPendingMessagesForPrompt()`

Kolejka jest aktywna przy `FEATURE_SOFT_INTERRUPTS=true`. Wiadomosci sa scoped po `taskId` albo `threadId`, redagowane przed zapisem i wygasaja przez TTL. Konsumpcja jest safe-point only: nie ma injectu w srodku aktywnego `agent.generate()` ani w srodku tool-call/result pair.

Mongo `pending_user_messages` przechowuje:

- `id`, `taskId`, `threadId`, opcjonalnie `targetAgentId`
- `source`: `user`, `system`, `file_activity`, `background_task`
- `content`, `urgent`, `status`
- `createdAt`, `consumedAt`, `consumedBy`, `expiresAt`
- `metadata`

Indeksy:

- `{ taskId: 1, status: 1, createdAt: 1 }`
- `{ threadId: 1, status: 1, createdAt: 1 }`
- `{ expiresAt: 1 }` TTL

Integracja MVP:

- `file-activity.ts` kolejuje file conflict warning jako `source=file_activity`;
- `subtask-executor.ts` dokleja pending messages do promptu przed `agent.generate()`;
- retry i escalation konsumują nowe pending messages przed kolejną próbą;
- urgent message przed retry/escalation zwraca `needs_human`, żeby wymusić replan;
- `parallel-dispatch.ts` konsumuje pending messages przed startem grupy;
- urgent message przed grupą zatrzymuje pozostałe grupy i oznacza je jako `needs_human`.

Eventy:

- `soft_interrupt_queued`
- `soft_interrupt_consumed`

## Automation Architect Pre-Sprint C

Automation Architect korzysta teraz z tych samych mechanizmow harnessu w wariancie dopasowanym do n8n:

- `automation-architect.ts` ma `automationPendingUpdatesProcessor`, `ToolSearchProcessor`, subagent delegation (`system_delegate_task`), ad-hoc workers (`system_run_worker`) i `checkPendingUpdates`.
- Krytyczne narzedzia Golden Path/n8n/validate/deploy/test zostaja stale dostepne. Tool search jest kontrolowany i sluzy do rzadkich orchestration tools, obecnie `bg_task`, bez otwierania architektowi calego tool poola meta-agenta.
- `pending-message-queue.ts` ma `targetAgentId`, zeby wyniki async/background byly konsumowane przez wlasciwego agenta, a nie przypadkowo przez meta albo architekta na tym samym threadzie.
- `background-task-manager.ts` zapisuje `threadId` i `agentId` w rekordzie taska; completion z `wake=true` wraca jako pending message do target agenta.
- `async-delegation.ts` przyjmuje `callerAgentId`, wiec wynik delegacji moze wrocic do `meta-agent` albo `automationArchitect`.
- `automation-golden-path.ts` ma recovery strategy layer (`recoveryStrategies`) i automatyczny failure-learning hook. Kazdy terminalny failure zapisuje `failure_case` w `system_knowledge`, `automation_events` i `task_failed` w event logu; udane naprawy zapisują recovery jako `workflow_result` oraz `retry_success`.

## Code Outline/Search V2 MVP

`RepoIndexer` rozszerza tabelę `symbols` o:

- `end_line`
- `kind_detail`
- `parent_symbol`

Migracja dodaje brakujące kolumny i czyści stary cache `files/symbols`, żeby następne indeksowanie odtworzyło bogatsze dane. AST extractor zapisuje teraz zakresy linii i typ symbolu dla funkcji, metod, klas, interface, type alias, enum i variable declarators.

Dodano `src/mastra/tools/dev/code-outline-tool.ts`:

- tool id: `code_outline`
- wejście: `file`, opcjonalnie `repoPath`, `maxSymbols`
- wynik: `file`, `language`, `totalLines`, `symbols[]` z `name`, `kind`, `signature`, `startLine`, `endLine`, `parentSymbol`

`codingAgent` ma teraz `codeOutlineTool` obok `repo_map` i `code_search`.

`code_search` V2:

- sam odświeża `RepoIndexer` przed syncem chunków;
- usuwa stale wpisy z `code_chunks`;
- zapisuje `search_text`, `signature`, `kind_detail`, `parent_symbol`, `neighbor_symbols`, `read_hint`;
- buduje embedding/search text z realnego regionu kodu, signature, kind, parent i sąsiadujących symboli;
- zwraca `kind`, `signature`, `neighborSymbols`, `snippet`, `score`, `readHint`;
- obsługuje `mode: semantic | literal | hybrid`;
- obsługuje `pathsOnly`, `maxRegions`, `maxSnippetChars` i `scope`.

Output compaction:

- `code_search` zapisuje pełny wynik do `harness_artifacts`, jeśli output przekracza preview limit;
- `coding_worktree_diff` używa `compactHarnessOutput(kind='diff')` i zwraca `outputArtifactId`, `outputTruncated`, `originalBytes`, `previewBytes`.

## Auto Pre-Context

Dodano `src/mastra/services/coding-precontext.ts` z publicznym API:

- `buildCodingPrecontext(input)`
- `CodingPrecontextInput`
- `CodingPrecontextResult`

Pre-context jest aktywny tylko przy `FEATURE_CODING_PRECONTEXT=true`. Gdy flaga jest wylaczona, `generateCoding()` przekazuje prompt bez zmian.

Zrodla kontekstu:

- pending memory z `pending_memory_context`, jesli `FEATURE_ASYNC_SEMANTIC_MEMORY=true`;
- fallback sync recall przez `recallKnowledge()` z limitem top 3 i timeoutem 900 ms;
- `SkillRegistry.search()` z limitem top 3 i timeoutem 900 ms;
- repo map przez `assembleContext({ repoPath })`;
- checkpoint przez `loadCheckpoint(taskId)` wewnatrz `assembleContext()`.

Format injectu:

```md
## Passive Context

### Relevant Memory
...

### Relevant Skills
...

### Repository Map
...

### Current Checkpoint
...

Use this context only if it is relevant. Prefer current file contents over stale memory.
```

`generateCoding()` liczy `contextHash`, loguje `precontext_injected` i zapisuje w `llm_call_*`, czy pre-context zostal zastosowany.

## Explicit Repo Path

`src/mastra/services/context-assembler.ts` wymaga teraz `repoPath` i wywoluje `getRepoIndexer(repoPath)`. Usunieto ukryty fallback do pierwszej zainicjalizowanej instancji repo-indexera oraz hardcoded path dla SQLite code chunks.

`src/mastra/services/subtask-executor.ts` pobiera repo/worktree path przez `getWorkspacePath(taskId)` i przekazuje je do harnessu. Gdy pre-context jest wylaczony, zachowany jest poprzedni lokalny `assembleContext()` w scoped prompt. Gdy pre-context jest wlaczony, repo map i checkpoint ida przez harness, zeby uniknac dublowania tych samych blokow.

## Async Semantic Memory

Dodano `src/mastra/services/semantic-memory-worker.ts` z publicznym API:

- `scheduleSemanticMemoryCheck(input)`
- `takePendingMemoryContext(input)`
- `filterPreviouslyInjectedMemoryIds(input, memoryIds)`
- `recordInjectedMemoryContext(input)`

`generateCoding()` schedule'uje memory check po kazdej turze LLM, takze po bledzie. Worker dziala poza krytyczna sciezka odpowiedzi: buduje query z fazy, oryginalnego promptu, target files, output preview albo error summary, liczy embedding i zapisuje gotowy prompt do `pending_memory_context`.

Retrieval MVP:

- kandydaci pochodza z aktywnego `system_knowledge` z `embeddingModel === EMBEDDING_MODEL_ID`;
- scoring laczy cosine similarity, confidence, recency boost i type boost dla `failure_case`, `coding_pattern`, `architecture_decision`, `tool_contract`;
- filtr startowy to score `0.42`, top 5 kandydatow, top 3 w prompt;
- worker odrzuca memory IDs obecne juz w `injected_memory_context`;
- nowy pending set jest suppressowany, gdy overlap z ostatnim pending set wynosi co najmniej `0.8`;
- poprzednie pending wpisy dla tego scope sa oznaczane jako `stale` przed zapisem nowego wpisu.

`coding-precontext.ts` konsumuje pending memory przez `takePendingMemoryContext()`. Po inject:

- pending wpis dostaje status `consumed`;
- memory IDs sa zapisywane do `injected_memory_context`;
- logowany jest `semantic_memory_injected`;
- sync fallback recall jest deduplikowany tym samym ledgerem, jesli `FEATURE_ASYNC_SEMANTIC_MEMORY=true`.

Scope: jesli `threadId` nie istnieje, worker uzywa `taskId` jako lokalnego scope. Dzieki temu obecny `subtask-executor` dostaje deduplikacje bez dodatkowej migracji thread state.

Mongo indeksy:

- `pending_memory_context`: `{ threadId: 1, status: 1, computedAt: -1 }`
- `pending_memory_context`: `{ taskId: 1, status: 1, computedAt: -1 }`
- `pending_memory_context`: `{ expiresAt: 1 }` TTL
- `injected_memory_context`: `{ threadId: 1, memoryId: 1 }` unique
- `injected_memory_context`: `{ injectedAt: 1 }` TTL 90 dni

## System Knowledge Search Text

`system_knowledge` dostalo jawny kontrakt searchable text:

- `searchText`
- `searchTextHash`
- `embeddingModel`

Embedding jest teraz liczony z `type`, `title`, `content`, `tags`, `sourceAgent` i `projectId`, a nie tylko z `title`. Wspolny helper jest w `src/mastra/services/memory-extractor.ts`:

- `buildSystemKnowledgeSearchText()`
- `hashSystemKnowledgeSearchText()`

Zaktualizowane call-site'y:

- `memory-extractor.ts`
- `failure-brain.ts`
- `system_memory_write_observation`
- `rebuild-embeddings.ts`

Backfill istniejacych wpisow:

```bash
npm run backfill:system-knowledge-embeddings
```

## Co wolno zapisać do `system_knowledge` (higiena ekstraktora)

`system_knowledge` **nie jest logiem**. `memoryRecallTool` podaje te wpisy agentom
jako wiedzę — `prompt_rule` dosłownie jako „prompt optimization insights" — więc
cokolwiek tu wyląduje, jest odczytywane jako wskazówka i realizowane. Dwa wzorce
zapisywały rzeczy, które nigdy nie były wskazówką. Zmierzone 2026-08-24 na żywej
bazie:

| co | ile | dlaczego szkodziło |
|---|---|---|
| `prompt_rule` „Costly delegation: `<agent>` (`<n>`s) … Consider splitting task" | **119 z 124** wszystkich `prompt_rule` | jeden wpis na delegację >60 s, czyli praktycznie na każdą realną delegację. 16 z nich dotyczyło `n8nMcpEngineer` i zniechęcało do jedynego handoffu uziemiającego schematy node'ów — dokładnie wtedy, gdy architekt halucynował `typeVersion` z braku tego handoffu. |
| `tool_contract` „Depth profile … requires explicit approval" | 4, confidence 0.9–1.0 | bramka zatwierdzeń robiąca swoje, zapisana jako naruszenie kontraktu przez `deployAutomationTool`, `activateAutomationTool` i `executeAutomationRequestTool` — trzy najważniejsze narzędzia Golden Path — z adnotacją „Fix: Review tool input validation". |

Reguły, które z tego wynikają:

1. **Latencja to telemetria, nie wiedza.** Wzorzec 4 (`extractCostlyDelegations`)
   został **usunięty**. `durationMs` jest trwale w `agent_events` i w widoku
   latencji dashboardu — tam należy pytać o wolne delegacje. Nie ma progu, przy
   którym „długa delegacja → podziel zadanie" byłoby tu prawdziwe: długie
   delegacje to normalny kształt pracy tego systemu (architekt ma budżet 1200 s).
2. **Bramka polityki to nie defekt.** `isPolicyGateMessage()` filtruje je i z
   `failure_case` (`extractDirectFailures`), i z `tool_contract`
   (`extractToolErrorPatterns`). Predykat dopuszcza przysłówek między
   „requires" a „approval" — bez tego realne brzmienie bramki głębokości
   („requires **explicit** approval") przechodziło obok filtra.

Bramka: `check:memory-extractor-hygiene` — pilnuje obu reguł, w tym tego, że żaden
przyszły ekstraktor oparty na czasie trwania nie zostanie z powrotem wpięty.

## Weryfikacja

- `npx tsx -e "import { detectLineOverlap } from './src/mastra/services/file-activity.ts'; ..."`
- `npx tsx -e "import { buildToolPreview, classifyToolError } from './src/mastra/services/harness-tool-envelope.ts'; ..."`
- `npx tsx -e "import { compactTextForPreview } from './src/mastra/services/harness-output-compactor.ts'; ..."`
- `npx tsx -e "import { queuePendingMessage, takePendingMessages } from './src/mastra/services/pending-message-queue.ts'; ..."`
- `npx tsx -e "import { codeOutlineTool } from './src/mastra/tools/dev/code-outline-tool.ts'; ..."`
- `npx tsx -e "import { codeSearchTool } from './src/mastra/tools/dev/code-search-tools.ts'; ..."`
- `bash scripts/with-node.sh npx tsc --noEmit`
- `git diff --check`
- `npm run build`

## Nastepny Krok

Kolejny naturalny etap to Sprint 5: Durable Background Tasks, integracja z test/build commands i completion jako pending message.
