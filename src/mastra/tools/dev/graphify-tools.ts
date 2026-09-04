/**
 * Graphify dev tools (Etap 8 — code impact map).
 *
 * graphify_affected — reverse-dependency impact of a symbol: what calls /
 * imports / references it, transitively. Use BEFORE editing a symbol to know
 * the blast radius WITHOUT reading every touching file (measured: ~400 tokens
 * vs ~14k to read the files). Fail-soft: when the graph/CLI is absent it tells
 * you to build it and to fall back to code_search/repo_map.
 *
 * Spike verdict (ideas/e8-graphify-plan.md): the precise structural commands
 * are the value; fuzzy NL query is NOT wrapped (code_search does that better).
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { runGraphifyAffected, runGraphifyExplain, runGraphifyGodNodes } from '../../services/graphify.js';

export const graphifyAffectedTool = createTool({
  id: 'graphify_affected',
  description:
    'Impact analysis: list what depends on a symbol (functions/files that call, import, or reference it, ' +
    'transitively to `depth`). Call this BEFORE changing a function/class to see the blast radius without ' +
    'reading every file. Much cheaper and more complete than grep for high-fanout symbols. ' +
    'Output includes `staleness` indicating graph freshness relative to git HEAD. ' +
    'Requires the code graph (npm run graph:build); degrades gracefully with a hint if it is missing — ' +
    'then use code_search / repo_map instead.',
  inputSchema: z.object({
    symbol: z.string().min(1).describe('Exact symbol name (function/class/const), e.g. "transitionLane"'),
    depth: z.number().optional().default(2).describe('Reverse-traversal depth 1–4 (default 2)'),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    symbol: z.string().optional(),
    depth: z.number().optional(),
    count: z.number().optional(),
    relations: z.array(z.string()).optional(),
    affected: z.array(z.object({
      label: z.string(), relation: z.string(), file: z.string(), line: z.number(),
    })).optional(),
    staleness: z.string().optional(),
    summary: z.string(),
  }),
  execute: async (input) => {
    const res = await runGraphifyAffected({ symbol: input.symbol, depth: input.depth });
    if (!res.available) {
      return { available: false, summary: `graphify_affected unavailable: ${res.reason}. ${res.hint}` };
    }
    const byRelation = new Map<string, number>();
    for (const e of res.affected) byRelation.set(e.relation, (byRelation.get(e.relation) ?? 0) + 1);
    const relSummary = [...byRelation.entries()].map(([r, n]) => `${r}:${n}`).join(', ');
    const topFiles = [...new Set(res.affected.map((e) => e.file))].slice(0, 15);

    return {
      available: true,
      symbol: res.symbol,
      depth: res.depth,
      count: res.affected.length,
      relations: res.relations,
      affected: res.affected.slice(0, 60),
      staleness: res.staleness,
      summary: `${res.affected.length} nodes depend on ${res.symbol} (depth ${res.depth}; ${relSummary}). ` +
        `Files: ${topFiles.join(', ')}${res.affected.length > 60 ? ' … (truncated)' : ''}`,
    };
  },
});

export const graphifyExplainTool = createTool({
  id: 'graphify_explain',
  description:
    'Explain a code symbol from the graph: its file/line, community, and its direct neighbors ' +
    '(who imports/calls it, and what it calls) with relation types. Output includes `staleness` relative to git HEAD. ' +
    'Use to orient on an unfamiliar symbol WITHOUT reading files. Degrades gracefully if the graph is missing (npm run graph:build).',
  inputSchema: z.object({
    symbol: z.string().min(1).describe('Exact symbol name, e.g. "openLane" or "delegateTaskTool"'),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    node: z.string().optional(),
    source: z.string().optional(),
    community: z.string().optional(),
    degree: z.number().optional(),
    connections: z.array(z.object({
      direction: z.enum(['in', 'out']), node: z.string(), relation: z.string(),
    })).optional(),
    staleness: z.string().optional(),
    summary: z.string(),
  }),
  execute: async (input) => {
    const res = await runGraphifyExplain({ symbol: input.symbol });
    if (!res.available) return { available: false, summary: `graphify_explain unavailable: ${res.reason}. ${res.hint}` };
    const inbound = res.connections.filter((c) => c.direction === 'in');
    const outbound = res.connections.filter((c) => c.direction === 'out');
    return {
      available: true,
      node: res.node,
      source: res.source,
      community: res.community,
      degree: res.degree,
      connections: res.connections.map((c) => ({ direction: c.direction, node: c.node, relation: c.relation })),
      staleness: res.staleness,
      summary: `${res.node} @ ${res.source ?? '?'} (degree ${res.degree ?? '?'}). ` +
        `In (${inbound.length}): ${inbound.slice(0, 8).map((c) => `${c.node}[${c.relation}]`).join(', ')}. ` +
        `Out (${outbound.length}): ${outbound.slice(0, 8).map((c) => `${c.node}[${c.relation}]`).join(', ')}.`,
    };
  },
});

export const graphifyGodNodesTool = createTool({
  id: 'graphify_god_nodes',
  description:
    'List the most-connected nodes (architectural hubs) in the codebase. Output includes `staleness` relative to git HEAD. ' +
    'Use to orient in an unfamiliar repo — the hubs are where the important logic concentrates. Degrades gracefully ' +
    'if the graph is missing (npm run graph:build).',
  inputSchema: z.object({
    top: z.number().optional().default(12).describe('How many hubs to return (1–50, default 12)'),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    nodes: z.array(z.object({ rank: z.number(), label: z.string(), edges: z.number() })).optional(),
    staleness: z.string().optional(),
    summary: z.string(),
  }),
  execute: async (input) => {
    const res = await runGraphifyGodNodes({ top: input.top });
    if (!res.available) return { available: false, summary: `graphify_god_nodes unavailable: ${res.reason}. ${res.hint}` };
    return {
      available: true,
      nodes: res.nodes,
      staleness: res.staleness,
      summary: `Top hubs: ${res.nodes.map((n) => `${n.label} (${n.edges})`).join(', ')}`,
    };
  },
});
