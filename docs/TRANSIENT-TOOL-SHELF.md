# Transient Tool Shelf hotfix

## Purpose

This hotfix reduces the tool schemas sent to the model while the durable
Execution Capability Broker is built on its own branch. It does not add new
permissions and it is not a security boundary.

The complete agent tool registry remains in the host process. On each model
step, `TransientToolShelfProcessor` exposes only:

- pinned/core tools from the agent profile;
- a small lexical preselection based on the current user request;
- tools loaded during the current request;
- `search_tools`, `load_tool`, `release_tools`, and `list_active_tools`.

`release_tools` removes schemas from subsequent model steps. All shelf state is
stored in Mastra's per-processor `args.state`, so it is automatically discarded
when the generate/stream request ends and is never shared through a `default`
thread key.

Harness and pipeline allowlist composition also preserves the control schemas
from the companion [Transient Skill Shelf](./TRANSIENT-SKILL-SHELF.md), so an
agent can never hide the selectors it needs to recover or narrow its context.

## Flags and rollback

The hotfix is enabled by default for agents that explicitly attach the
processor.

```dotenv
FEATURE_INTERIM_TOOL_SHELF=true
INTERIM_TOOL_SHELF_AGENTS=*
INTERIM_TOOL_SHELF_INITIAL_TOP_K=4
INTERIM_TOOL_SHELF_MAX_ACTIVE=8
INTERIM_TOOL_SHELF_SEARCH_TOP_K=6
```

Immediate rollback:

```dotenv
FEATURE_INTERIM_TOOL_SHELF=false
```

For agents that previously used Mastra's native `ToolSearchProcessor` (Meta,
Knowledge and Automation), off mode delegates to a native processor with the
same legacy pool. Other agents simply return to their original full static tool
surface.

`INTERIM_TOOL_SHELF_AGENTS` accepts a comma-separated runtime `Agent.id`
allowlist. An empty value or `*` enables every agent that has the processor.

## Deliberate limitations

- lexical BM25-style retrieval plus PL/EN aliases, not semantic embeddings;
- no persistence between requests or process restarts;
- no policy/credential/risk broker;
- no lazy MCP client discovery;
- no durable V2 capability session;
- logical schema release, not unloading JavaScript objects from memory.

The hotfix profiles and `activeTools` composition are intentionally compatible
with migration to the durable broker. The processor itself can then be removed.

## Verification

```bash
npm run check:transient-tool-shelf
npm run e2e:transient-tool-shelf
npm run e2e:reflector-prepare-step
npm run typecheck
npm run build
```
