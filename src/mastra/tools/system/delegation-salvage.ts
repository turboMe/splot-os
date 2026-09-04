/**
 * P3 (delegation-depth-hardening — ideas/delegation-depth-hardening-plan.md)
 *
 * system_delegation_salvage — recover the partial work of a timed-out (or
 * otherwise interrupted) delegation from its thread in `mastra_messages`.
 *
 * Live case that motivated this: researcherAgent spent ~226s scraping the
 * Finnsson site, the 240s delegation timeout killed the run seconds before
 * `artifact_put`, and every scrape result survived ONLY inside the delegation
 * thread — with no tool to read it back, meta redid (and re-failed) the work.
 *
 * The digest compresses assistant text + tool results into a bounded string
 * the caller can compile directly or hand to a fresh delegation as context.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { isHarnessFeatureEnabled } from '../../config/harness-flags.js';

// Budgets: keep the digest useful but bounded (~4-6k tokens ≈ 16-24k chars).
const MAX_DIGEST_CHARS = 20_000;
const MAX_PER_TOOL_RESULT_CHARS = 1_500;
const MAX_PER_TEXT_CHARS = 1_200;

type DigestEntry = {
  at?: string;
  kind: 'tool_result' | 'assistant_text';
  tool?: string;
  content: string;
};

function parseMessageContent(raw: unknown): { parts: any[] } {
  let content: any = raw;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { return { parts: [] }; }
  }
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return { parts };
}

function compact(text: string, maxChars: number): string {
  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}\n…[truncated]`
    : normalized;
}

export async function buildDelegationSalvageDigest(threadId: string): Promise<{
  found: boolean;
  messagesCount: number;
  toolResultsCount: number;
  digest: string;
}> {
  const db = await getDb();
  const messages = await db.collection('mastra_messages')
    .find({ thread_id: threadId })
    .sort({ createdAt: 1 })
    .toArray();

  if (messages.length === 0) {
    return { found: false, messagesCount: 0, toolResultsCount: 0, digest: '' };
  }

  const entries: DigestEntry[] = [];
  for (const message of messages) {
    const { parts } = parseMessageContent((message as any).content);
    const at = (message as any).createdAt instanceof Date
      ? (message as any).createdAt.toISOString()
      : undefined;
    for (const part of parts) {
      if (part?.type === 'tool-invocation') {
        const ti = part.toolInvocation ?? {};
        if (ti.result === undefined) continue;
        const resultText = typeof ti.result === 'string' ? ti.result : JSON.stringify(ti.result);
        entries.push({
          at,
          kind: 'tool_result',
          tool: typeof ti.toolName === 'string' ? ti.toolName : 'unknown_tool',
          content: compact(resultText, MAX_PER_TOOL_RESULT_CHARS),
        });
      } else if (part?.type === 'text' && (message as any).role === 'assistant') {
        const text = typeof part.text === 'string' ? part.text : '';
        if (text.trim().length > 0) {
          entries.push({ at, kind: 'assistant_text', content: compact(text, MAX_PER_TEXT_CHARS) });
        }
      }
    }
  }

  const toolResultsCount = entries.filter((entry) => entry.kind === 'tool_result').length;

  // Newest entries carry the most refined state — when over budget, keep the
  // TAIL (drop oldest first), since early steps are usually superseded.
  const lines: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const header = entry.kind === 'tool_result'
      ? `── TOOL ${entry.tool}${entry.at ? ` @ ${entry.at}` : ''} ──`
      : `── ASSISTANT${entry.at ? ` @ ${entry.at}` : ''} ──`;
    const block = `${header}\n${entry.content}\n`;
    if (used + block.length > MAX_DIGEST_CHARS) break;
    lines.unshift(block);
    used += block.length;
  }

  const skipped = entries.length - lines.length;
  const digest = [
    `# Delegation salvage digest — thread ${threadId}`,
    `Messages: ${messages.length} | tool results: ${toolResultsCount}` +
      (skipped > 0 ? ` | oldest ${skipped} entries dropped for budget` : ''),
    '',
    ...lines,
  ].join('\n');

  return { found: true, messagesCount: messages.length, toolResultsCount, digest };
}

export const delegationSalvageTool = createTool({
  id: 'system_delegation_salvage',
  description: `Recover the partial work of a TIMED-OUT or interrupted delegation from its thread.
Returns a compressed digest of the sub-agent's tool results and notes (bounded, newest-first priority).
Use the "delegationThreadId" from a failed system_delegate_task result (salvage field).
Then: compile the result yourself, or re-delegate WITH the digest as context — never redo work that is already in the digest.`,
  inputSchema: z.object({
    threadId: z.string().min(1).describe('The delegation thread id (e.g. "delegation-<uuid>") from the salvage pointer of a failed delegation.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    found: z.boolean(),
    messagesCount: z.number(),
    toolResultsCount: z.number(),
    digest: z.string().describe('Bounded digest of tool results + assistant notes from the delegation thread.'),
    error: z.string().optional(),
  }),
  execute: async (context: { threadId: string }) => {
    if (!isHarnessFeatureEnabled('FEATURE_DELEGATION_TIMEOUT_SALVAGE', true)) {
      return {
        success: false,
        found: false,
        messagesCount: 0,
        toolResultsCount: 0,
        digest: '',
        error: 'FEATURE_DELEGATION_TIMEOUT_SALVAGE is disabled.',
      };
    }
    try {
      const result = await buildDelegationSalvageDigest(context.threadId);
      return { success: result.found, ...result, ...(result.found ? {} : { error: `No messages found for thread "${context.threadId}".` }) };
    } catch (error) {
      return {
        success: false,
        found: false,
        messagesCount: 0,
        toolResultsCount: 0,
        digest: '',
        error: (error as Error).message,
      };
    }
  },
});
