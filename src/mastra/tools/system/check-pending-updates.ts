/**
 * Check Pending Updates Tool
 *
 * Allows meta-agent to poll for async delegation results and background
 * task completions. Returns pending updates if any are available.
 *
 * This replaces the InputProcessor approach which doesn't work reliably
 * because the Mastra processor pipeline can fail on OM threadId checks.
 */

import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
} from '@mastra/core/request-context';
import { z } from 'zod';
import { getLedgerDigest, isLedgerEnabled } from '../../services/task-ledger.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  META_AGENT_ID,
  META_FRONT_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../../config/agent-ids.js';
import { ackPendingMessages, takePendingMessages } from '../../services/pending-message-queue.js';
import { getHarnessExecutionContext } from '../../services/harness-execution-context.js';

const ALLOWED_AGENT_IDS = new Set<string>([
  META_AGENT_ID,
  'metaAgent',
  META_FRONT_AGENT_ID,
  'meta-front',
  AUTOMATION_ARCHITECT_AGENT_ID,
  'automation-architect',
]);

function trustedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function trustedRequestValue(
  context: ToolExecutionContext,
  key: string,
): string | undefined {
  try {
    return trustedString(context.requestContext?.get(key));
  } catch {
    return undefined;
  }
}

function trustedScope(context: ToolExecutionContext): {
  agentId: string;
  threadId: string;
} | undefined {
  const harnessCtx = getHarnessExecutionContext();
  const rawAgentId = trustedString(context.agent?.agentId) || harnessCtx?.agentId;
  const agentId = canonicalizeRuntimeAgentId(rawAgentId);
  if (!agentId || !ALLOWED_AGENT_IDS.has(agentId)) return undefined;

  const agentThreadId = trustedString(context.agent?.threadId) || harnessCtx?.threadId;
  const reservedThreadId = trustedRequestValue(context, MASTRA_THREAD_ID_KEY);
  const reservedResourceId = trustedRequestValue(context, MASTRA_RESOURCE_ID_KEY);

  const effectiveThreadId = reservedThreadId || agentThreadId;
  if (!effectiveThreadId) return undefined;

  if (agentThreadId && reservedThreadId && agentThreadId !== reservedThreadId) {
    return undefined;
  }

  const agentResourceId = trustedString(context.agent?.resourceId);
  if (
    agentResourceId
    && reservedResourceId
    && agentResourceId !== reservedResourceId
  ) {
    return undefined;
  }
  return { agentId, threadId: effectiveThreadId };
}

export const checkPendingUpdatesTool = createTool({
  id: 'checkPendingUpdates',
  description:
    'Check for completed background tasks and async delegation results. ' +
    'Call this FIRST at the start of every conversation turn to see if there are any pending updates from background processes. ' +
    'If results are available, report them to the user before answering their question.',
  // Identity and queue scope are deliberately absent from model-controlled
  // input. They are resolved only from Mastra's trusted execution context.
  inputSchema: z.object({}),
  outputSchema: z.object({
    hasUpdates: z.boolean(),
    updates: z.array(z.object({
      source: z.string(),
      content: z.string(),
      urgent: z.boolean(),
      type: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })),
    laneDigest: z.string().optional()
      .describe('Task Ledger digest: running/blocked/awaiting-approval/finished lanes (Etap 1)'),
    message: z.string(),
  }),

  execute: async (_input, context: ToolExecutionContext = {}) => {
    const scope = trustedScope(context);
    if (!scope) {
      console.warn('[checkPendingUpdates] pending_scope_missing');
      return {
        hasUpdates: false,
        updates: [],
        message: 'Pending updates unavailable: trusted conversation scope is missing.',
      };
    }
    const { agentId, threadId } = scope;

    try {
      const docs = await takePendingMessages({
        threadId,
        agentId,
        limit: 5,
        sources: ['background_task', 'automation_job'],
        subtaskId: 'checkPendingUpdatesTool',
      });
      // SEC-001 — this tool returns the records to the agent as its result, so
      // the lease is acknowledged here; a crash before this leaves them
      // reclaimable rather than consumed-and-lost.
      await ackPendingMessages({
        messages: docs,
        agentId,
        subtaskId: 'checkPendingUpdatesTool',
      });

      // Task Ledger digest (Etap 1). Only meta "consumes" finished lanes so
      // other agents polling updates don't eat meta's since-last-check list.
      let laneDigest: string | undefined;
      if (isLedgerEnabled()) {
        const digest = await getLedgerDigest({ markDigested: agentId === META_AGENT_ID })
          .catch(() => undefined);
        laneDigest = digest?.text;
      }

      if (docs.length === 0) {
        return {
          hasUpdates: false,
          updates: [],
          laneDigest,
          message: laneDigest && laneDigest !== 'No background lanes.'
            ? 'No pending messages, but see laneDigest for background lane status.'
            : 'No pending background updates.',
        };
      }

      console.log(`[checkPendingUpdates] Delivered ${docs.length} update(s) to ${agentId}`);

      const updates = docs.map((d) => ({
        source: d.source,
        content: d.content,
        urgent: d.urgent,
        type: (d.metadata as Record<string, unknown>)?.type as string ?? 'background_task',
        metadata: d.metadata,
      }));

      return {
        hasUpdates: true,
        updates,
        laneDigest,
        message: `${docs.length} background update(s) available. Report these to the user.`,
      };
    } catch {
      console.warn('[checkPendingUpdates] pending_updates_failed');
      return {
        hasUpdates: false,
        updates: [],
        message: 'Pending updates are temporarily unavailable.',
      };
    }
  },
});
