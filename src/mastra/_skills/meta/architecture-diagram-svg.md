---
name: architecture-diagram-svg
category: meta
description: >-
  Hand-authored SVG for explaining system structure — agent topologies, delegation paths, durable-job
  state machines, data pipelines, deployment slots. Produces a self-contained diagram to make an
  explanation legible. Trigger when an answer about how the system is wired would be clearer drawn
  than written.
keywords: [architecture-diagram, svg, topology, agent-graph, state-machine, data-flow, explanation-visual, system-map]
allowedTools: [artifact_put, repo_map, code_search, graphify_explain, graphify_god_nodes]
minComplexity: medium
recommendedTier: pro
estimatedTokens: 1500
outputFormat: svg
tags: [meta, architecture, svg, diagram, explanation]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Explanatory Architecture Diagrams (SVG)

## 1. Scope boundary — read this first

This skill produces **thinking aids and explanations**, not design deliverables.

| This skill | `designAgent` |
|---|---|
| "Here is how the durable-job lane actually flows" | "Make us a diagram for the deck" |
| A topology sketch inside an answer or an audit doc | Anything a client, investor, or user will see |
| Rough, correct, disposable | Composed, branded, exported |

If the diagram is going into a deliverable — deck, landing page, PDF, client report — **stop and
delegate to `designAgent`**. The routing rule (`Visual/landing/UI artifacts -> designAgent`) is not
suspended because a diagram is easy to draw. Drawing your own explanation is inside the boundary;
producing visual artifacts is not.

## 2. Ground the diagram before drawing it

A wrong diagram is worse than no diagram, because it looks authoritative. Before the first `<rect>`:

- `repo_map` / `code_search` for the real module and agent names — use the exact identifiers
  (`meta-front-agent`, `automationArchitect`), never a prettified label.
- `graphify_explain` / `graphify_god_nodes` when the question is about relationships you have not
  personally traced this session.
- If an edge is an assumption, either verify it or **draw it dashed and label it `?`**. Do not draw
  a confident line through a guess.

## 3. Template

```xml
<svg viewBox="0 0 900 460" width="100%" xmlns="http://www.w3.org/2000/svg"
     style="background:#09090B; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">
  <defs>
    <linearGradient id="lead" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#3B82F6" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#1D4ED8" stop-opacity="0.05"/>
    </linearGradient>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#60A5FA"/>
    </marker>
  </defs>

  <text x="24" y="34" font-size="13" fill="#71717A">Delegation path — verified 2026-08-26</text>

  <rect x="310" y="60" width="280" height="76" rx="10" fill="url(#lead)" stroke="#3B82F6" stroke-width="1.5"/>
  <text x="450" y="92"  text-anchor="middle" font-size="15" font-weight="bold" fill="#60A5FA">meta-front-agent</text>
  <text x="450" y="114" text-anchor="middle" font-size="11" fill="#93C5FD">durable job intake</text>

  <path d="M 450 136 L 450 176" stroke="#60A5FA" stroke-width="1.5" marker-end="url(#arrow)"/>
  <path d="M 450 176 L 190 226" stroke="#60A5FA" stroke-width="1.5" marker-end="url(#arrow)"/>
  <path d="M 450 176 L 450 226" stroke="#60A5FA" stroke-width="1.5" marker-end="url(#arrow)"/>
  <path d="M 450 176 L 710 226" stroke="#3F3F46" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#arrow)"/>
  <text x="640" y="205" font-size="10" fill="#71717A">? nie zweryfikowane</text>

  <rect x="70"  y="226" width="240" height="72" rx="8" fill="#18181B" stroke="#27272A" stroke-width="1.5"/>
  <text x="190" y="258" text-anchor="middle" font-size="13" font-weight="bold" fill="#F4F4F5">codingAgent</text>
  <text x="190" y="279" text-anchor="middle" font-size="11" fill="#A1A1AA">worktree · tracked writes</text>

  <rect x="330" y="226" width="240" height="72" rx="8" fill="#18181B" stroke="#27272A" stroke-width="1.5"/>
  <text x="450" y="258" text-anchor="middle" font-size="13" font-weight="bold" fill="#F4F4F5">researcherAgent</text>
  <text x="450" y="279" text-anchor="middle" font-size="11" fill="#A1A1AA">PSEV · Tavily · Playwright</text>

  <rect x="590" y="226" width="240" height="72" rx="8" fill="#18181B" stroke="#27272A" stroke-width="1.5"/>
  <text x="710" y="258" text-anchor="middle" font-size="13" font-weight="bold" fill="#F4F4F5">automationArchitect</text>
  <text x="710" y="279" text-anchor="middle" font-size="11" fill="#A1A1AA">Golden Path · n8n</text>
</svg>
```

## 4. Rules that keep it readable

1. **`viewBox` + `width="100%"`, no fixed pixel width.** It gets embedded at unknown sizes.
2. **Type floor**: 11px for sublabels, 13-15px for node titles. Below 11px it is decoration.
3. **Node labels are real identifiers**; the sublabel carries the ≤5-word role.
4. **Solid line = verified edge. Dashed + `?` = assumed.** This is the single most useful convention
   here — it lets a diagram be published before every path is traced.
5. **Arrowheads on every edge.** A topology without direction is a topology nobody can act on.
6. **Date-stamp it** in the corner. A structure diagram is a snapshot; an undated one gets trusted
   long after it stopped being true.
7. **Max ~9 nodes.** More than that is not a diagram, it is a table with lines — draw the layer that
   answers the question and say what you collapsed.
8. **Self-contained.** No external fonts, no `<image href>` to a URL, no script.

## 5. Delivery

Persist with `artifact_put` and hand back the ref. Inline SVG in a chat answer is fine for a small
sketch; anything you might want to reference twice goes to the artifact store, because a pasted
diagram cannot be updated.
