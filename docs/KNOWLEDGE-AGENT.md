# Knowledge Agent

> Status: Closed on 2026-05-14. Sprint A-F implemented, core runtime/API verification passed, and UI behavior tests passed.

## Purpose

`knowledgeAgent` is the dedicated Google NotebookLM operator. It should handle NotebookLM research and notebook operations for other agents instead of spreading NotebookLM behavior across the supervisor, coding agent, or automation architect.

Primary responsibilities:

- list, create, describe, rename, and query notebooks,
- add and manage NotebookLM sources,
- run deep research and import discovered sources,
- generate Studio artifacts,
- run cross-notebook queries and batch operations,
- return structured research results to the delegating agent.

It should not receive coding, n8n deployment, CRM, Gmail, Calendar, or broad workspace tools.

## Runtime Contract

The agent exposes a small always-visible tool set:

- `server_info`
- `refresh_auth`
- `notebook_list`
- `skill_search`
- `skill_load`
- `skill_report_result`
- `system_memory_recall`
- `system_memory_write_observation`

The rest of the NotebookLM MCP tools are discoverable through `ToolSearchProcessor`:

- call `search_tools(query)` to find a NotebookLM tool,
- call `load_tool(toolId)` to activate it for the turn,
- then call the exact loaded tool name.

The prompt explicitly forbids names such as `skill:search`, `mcp_notebooklm_*`, and `mcp__notebooklm-mcp__*`.

## Memory

`knowledgeAgent` now has Mastra Memory enabled:

- last 30 messages,
- observational memory scoped to thread,
- working memory for NotebookLM runtime state, notebook aliases, active research, source state, and operational lessons.

It also has system knowledge tools for durable lessons:

- `system_memory_recall`
- `system_memory_write_observation`

## Harness

Calls should go through `generateKnowledge()` in `src/mastra/services/knowledge-harness.ts`.

The harness provides:

- run state and LLM call telemetry,
- compact NotebookLM pre-context,
- memory resource scoping,
- timeout handling,
- async result compatibility through `startAsyncDelegation`.

The feature flag is:

```env
FEATURE_KNOWLEDGE_PRECONTEXT=true
```

It is present in `.env.example` and the local runtime `.env`.

## Delegation

`system_delegate_task` supports `targetAgent: "knowledgeAgent"`.

Use synchronous delegation for short tasks:

- list notebooks,
- query one notebook,
- inspect source status.

Use async delegation for long tasks:

- deep research,
- source indexing,
- Studio artifact generation,
- batch or cross-notebook operations.

Async results are queued to `pending_user_messages` for the `returnToAgentId` and `returnToThreadId`, so `metaAgent` can report them on the next user turn.

## Model

`agentModels.knowledgeAgent` is assigned to:

```ts
knowledgeAgent: 'gemini-3.1-flash-lite-preview'
```

The previous local `gemma4-26b` configuration was not reliable enough for the NotebookLM tool-calling contract.

## Verification

Verified locally on 2026-05-14:

- `npm run build` completed successfully.
- `npx tsx src/mastra/scripts/verify-knowledge-skills.ts` completed successfully.
- `GET /api/agents/knowledge-agent` showed the English prompt, Google model, aliased skill tools, and no stale `skillSearchTool` / `skillLoadTool` names.
- A `/generate` call with a memory thread used `search_tools` and returned `source_add` for URL-source discovery.
- A `/generate` call with a memory thread used `skill_search`, `notebook_list`, `skill_report_result`, and `updateWorkingMemory`, then returned real NotebookLM notebook titles.

Verified in UI on 2026-05-14:

- direct `knowledgeAgent` correctly acknowledged NotebookLM access and used exact tool names,
- notebook listing worked through NotebookLM MCP,
- embedded tool discovery found the right NotebookLM tools,
- thread memory preserved notebook aliases,
- `metaAgent` delegation to `knowledgeAgent` worked,
- async delegation results returned through pending updates.

Raw `/generate` API calls must include a memory thread because observational memory is thread-scoped:

```json
{
  "memory": {
    "thread": "knowledge-agent-test",
    "resource": "knowledgeAgent"
  }
}
```

Operational checks:

```bash
nlm doctor
nlm notebook list --json
curl -sS http://localhost:4111/api/agents/knowledge-agent
```

Behavior tests:

```text
Czy masz dostep do narzedzi NotebookLM? Wymien dokladne nazwy 5 narzedzi, ktorych mozesz uzyc. Nie zgaduj nazw.
```

```text
Uzyj NotebookLM MCP i wypisz 3 ostatnio widoczne notebooki. Najpierw sprawdz procedure skillami, potem uzyj wlasciwego narzedzia MCP.
```

```text
Chce dodac URL jako zrodlo do notebooka. Znajdz wlasciwe narzedzie przez search_tools i powiedz, jakiego toola uzyjesz.
```

Meta delegation test:

```text
Zlec knowledgeAgentowi sprawdzenie, jakie notebooki GastroBridge sa dostepne w NotebookLM, a potem podsumuj wynik.
```

## Closure

Knowledge Agent work is complete as of 2026-05-14. Future changes should be treated as follow-up enhancements, not part of the original fix scope.
