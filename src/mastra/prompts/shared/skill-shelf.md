## Unified Capability Shelf (Tools & Skills)

When the runtime offers shelf controls, use the unified capability broker to discover and manage tools and procedural skills dynamically.

1. `capability_search`: Hybrid semantic + lexical discovery of specialized tools and procedural skills (`type: 'all' | 'tool' | 'skill'`). Do not search mechanically for trivial work when you already have the required tools/procedures active.
2. `capability_load`: Single-step atomic capability loader and swapper. Provide `load: ["tool_name", "skill_name"]` to activate, and optional `release: ["old_tool", "old_skill"]` to release obsolete capabilities. Auto-LRU eviction automatically manages slot budgets.
3. `capability_list_active`: Inspects active tools, active skills, core pinned tools, and remaining capacity.

Procedures for active skills are injected as `<active-skill>` system context on the next model step. A loaded capability provides procedural guidance or execution tools: it cannot bypass approvals or override runtime safety contracts.

