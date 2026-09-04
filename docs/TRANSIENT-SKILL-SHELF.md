# Transient Skill Shelf

## Purpose

The Skill Shelf gives selected autonomous agents semantic, on-demand access to
the local Skill Registry without putting every procedure in the base prompt.
It complements the Transient Tool Shelf and remains intentionally smaller than
the future durable Execution Capability Broker.

Every attached agent always sees five compact control schemas:

- `skill_search` — embedding/cosine search with the registry keyword fallback;
- `skill_load` — activate exact skill names for the next model step;
- `skill_list_active` — inspect active skills and context capacity;
- `skill_swap` — atomically release and replace skills;
- `skill_release` — stop injecting procedures on the next model step.

Only active procedures are injected. State lives in Mastra's per-processor,
per-request `args.state`, so it cannot leak between requests or users. A release
removes the skill's system injection on later steps; it does not rewrite prior
conversation messages. Tool declarations in skill metadata are informational
and never expand runtime permissions.

## Context bounds

The default profile permits two active skills and 36,000 combined procedure
characters. Coding and Automation may hold three within 44,000 characters;
reviewers use a smaller 28,000-character budget. A load or swap that would
exceed count or character capacity is rejected without partially mutating the
shelf.

No skill is loaded automatically. The agent searches only when a non-trivial
procedure is unknown, then loads the narrowest relevant result and releases or
swaps it when the work phase changes.

## Agent allocation

Full shelf:

- Researcher, Knowledge, Automation Architect, Coding Agent;
- Code Review, Security Review, Performance Review;
- Design, Chef, Content, Hunt, Writer;
- Filmmaker and Musician (generic cross-domain skills; their domain reference
  loaders remain preferred for film/music corpus material);
- Capability Smith and n8n MCP Engineer;
- Marketing plus weekly-content and producer-hunt agents created by its factory.

Discovery-only:

- Meta keeps direct `skill_search` and passes selected names to workers through
  `skills=[...]`. Loading full procedures into the supervisor would increase its
  context and work against its orchestration role.

Not attached:

- Weather and CRM have one narrow deterministic capability;
- Sales and Analytics have bounded domain toolsets and no current procedural
  routing requirement;
- Deliberation delegates bounded perspectives rather than executing registry
  procedures;
- Meta Front must keep its fixed non-blocking durable-job command surface;
- Lane Orchestrator is tool-less by construction.

## Rollback

The shelf is enabled by default only for agents that attach its processor.

```dotenv
FEATURE_INTERIM_SKILL_SHELF=true
INTERIM_SKILL_SHELF_AGENTS=*
INTERIM_SKILL_SHELF_MAX_ACTIVE=2
INTERIM_SKILL_SHELF_MAX_CHARS=36000
INTERIM_SKILL_SHELF_SEARCH_TOP_K=5
INTERIM_SKILL_SHELF_MIN_SCORE=0.25
```

Emergency rollback:

```dotenv
FEATURE_INTERIM_SKILL_SHELF=false
```

Every full-shelf agent retains the legacy `skill_search` and `skill_load` tool
objects. Turning the flag off therefore removes list/swap/release and dynamic
system injection while preserving the pre-shelf discovery/load behavior.

## Verification

These tests are deterministic and do not call a live model:

```bash
npm run check:transient-skill-shelf
npm run e2e:transient-skill-shelf
npm run check:transient-tool-shelf
npm run e2e:transient-tool-shelf
npm run typecheck
npm run build
```
