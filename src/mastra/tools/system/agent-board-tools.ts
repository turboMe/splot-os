/**
 * Agent Board tools (Etap 2 — IDEALSYSTEMMASTERPLAN A1).
 *
 * agent_board_list — compact roster (1 entry/agent). For orientation.
 * agent_board_get  — full card: input contract, examples, hard rules, model,
 *                    live track record. Call BEFORE delegating anything
 *                    non-obvious — choose the agent by data, not by memory.
 *
 * Registered on meta AND on the domain orchestrators (chef, hunt, content,
 * writer, filmmaker, musician, automationArchitect) so agents can use each
 * other: before saying "I can't", check the board for a colleague who can.
 *
 * Reads Mongo `agent_board` (refreshed weekly + at build); falls back to the
 * static cards in config/agent-board.ts when Mongo is unavailable.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { agentBoard, AGENT_BOARD_IDS, getAgentCard } from '../../config/agent-board.js';
import { agentModels } from '../../config/model-manifest.js';

type BoardDoc = Record<string, unknown> & {
  id: string;
  oneLiner: string;
  trackRecord?: { totalTasks: number; successRate: number; avgCostUsd: number; avgLatencyMs: number };
  model?: string;
};

async function readBoardFromMongo(): Promise<Map<string, BoardDoc>> {
  const docs = new Map<string, BoardDoc>();
  try {
    const { getDb } = await import('../../lib/mongo.js');
    const db = await getDb();
    const rows = await db.collection<BoardDoc>('agent_board').find({}).toArray();
    for (const row of rows) docs.set(row.id, row);
  } catch { /* fall back to static cards */ }
  return docs;
}

function formatTrack(t: BoardDoc['trackRecord']): string {
  if (!t || t.totalTasks === 0) return 'no data';
  const latency = t.avgLatencyMs >= 60_000
    ? `~${Math.round(t.avgLatencyMs / 60_000)}min`
    : `~${Math.round(t.avgLatencyMs / 1000)}s`;
  return `${(t.successRate * 100).toFixed(0)}% ok, ~$${t.avgCostUsd.toFixed(3)}/task, ${latency} (n=${t.totalTasks})`;
}

export const agentBoardListTool = createTool({
  id: 'agent_board_list',
  description:
    'Compact Agent Board roster: one line per delegable agent (id, one-liner, delegation mode, cost/latency class, track record). ' +
    'Use to orient before delegation; for a full card with input contract and examples call agent_board_get.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    agents: z.array(z.string()),
    roster: z.string(),
  }),
  execute: async () => {
    const mongo = await readBoardFromMongo();
    const models = agentModels as Record<string, string>;
    const lines = Object.values(agentBoard).map((card) => {
      const doc = mongo.get(card.id);
      return `- ${card.id} [${card.delegation}, ${card.costClass}/${card.latencyClass}] ${card.oneLiner} ` +
        `(track: ${formatTrack(doc?.trackRecord)}${models[card.id] ? `, model: ${models[card.id]}` : ''})`;
    });
    return { agents: [...AGENT_BOARD_IDS], roster: lines.join('\n') };
  },
});

export const agentBoardGetTool = createTool({
  id: 'agent_board_get',
  description:
    'Full Agent Board card for one agent: when to use / when NOT to use, input contract (how to brief), ' +
    'output artifacts, hard routing rules, example briefs, model, and live track record. ' +
    'Call this BEFORE delegating a non-obvious task — choose the agent by data, not from memory.',
  inputSchema: z.object({
    agentId: z.enum(AGENT_BOARD_IDS),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    card: z.unknown().optional(),
    rendered: z.string(),
  }),
  execute: async (input) => {
    const card = getAgentCard(input.agentId);
    if (!card) {
      return { found: false, rendered: `No card for ${input.agentId}. Valid ids: ${AGENT_BOARD_IDS.join(', ')}` };
    }
    const mongo = await readBoardFromMongo();
    const doc = mongo.get(card.id);
    const models = agentModels as Record<string, string>;

    const rendered = [
      `# ${card.id} — ${card.oneLiner}`,
      `delegation: ${card.delegation} | cost: ${card.costClass} | latency: ${card.latencyClass} | model: ${models[card.id] ?? '?'}`,
      `track record (30d): ${formatTrack(doc?.trackRecord)}`,
      '',
      'USE WHEN:',
      ...card.whenToUse.map((w) => `  • ${w}`),
      'DO NOT USE WHEN:',
      ...card.whenNotToUse.map((w) => `  • ${w}`),
      '',
      `INPUT CONTRACT: ${card.inputContract}`,
      `OUTPUT ARTIFACTS: ${card.outputArtifacts.join(', ')}`,
      ...(card.hardRules?.length ? ['', 'HARD RULES:', ...card.hardRules.map((r) => `  ⛔ ${r}`)] : []),
      '',
      'EXAMPLE BRIEFS:',
      ...card.examples.flatMap((e) => [`  → ${e.brief}`, `    (${e.note})`]),
    ].join('\n');

    return { found: true, card: { ...card, model: models[card.id], trackRecord: doc?.trackRecord }, rendered };
  },
});
