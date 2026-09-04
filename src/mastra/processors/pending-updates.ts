/**
 * Pending Updates Input Processor
 *
 * Runs at processInput (once per generate/stream call) to check for
 * pending messages from async delegations, background tasks, and system
 * notifications. Injects them as a system context block so the target agent
 * naturally surfaces updates in its response.
 *
 * Etap Harness — Async Delegation Layer
 */

import type { ProcessInputArgs, ProcessInputResult } from '@mastra/core/processors';
import { BaseProcessor } from '@mastra/core/processors';
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
} from '@mastra/core/request-context';
import { takePendingMessages, formatPendingMessagesForPrompt, ackPendingMessages } from '../services/pending-message-queue.js';
import { getLedgerDigest, isLedgerEnabled } from '../services/task-ledger.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  META_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../config/agent-ids.js';

import type { PendingMessage } from '../services/pending-message-queue.js';

// ── Trusted scope extraction ─────────────────────────────────────────────────

function extractTrustedThreadId(
  args: ProcessInputArgs,
): string | undefined {
  const rc = args.requestContext;
  try {
    const threadId = rc?.get?.(MASTRA_THREAD_ID_KEY);
    const resourceId = rc?.get?.(MASTRA_RESOURCE_ID_KEY);
    if (
      typeof threadId === 'string'
      && threadId.trim().length > 0
      && typeof resourceId === 'string'
      && resourceId.trim().length > 0
    ) {
      return threadId.trim();
    }
  } catch { /* fail closed */ }
  return undefined;
}

// ── Processor ────────────────────────────────────────────────────────────────

export class PendingUpdatesProcessor extends BaseProcessor<'pending-updates'> {
  readonly id = 'pending-updates' as const;
  readonly name = 'Pending Updates Processor';
  readonly description =
    'Checks for async delegation results and background task notifications before each agent turn.';

  constructor(
    private readonly options: {
      agentId?: string;
      maxUpdates?: number;
    } = {},
  ) {
    super();
  }

  async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
    const { messages, systemMessages } = args;
    const threadId = extractTrustedThreadId(args);
    const agentId = canonicalizeRuntimeAgentId(this.options.agentId) ?? META_AGENT_ID;
    const limit = this.options.maxUpdates ?? 5;

    console.log(
      `[PendingUpdatesProcessor] ▶ processInput called. `
      + `agentId=${agentId}, scope=${threadId ? 'thread' : 'missing'}, `
      + `messages=${messages.length}`,
    );

    if (!threadId) {
      // Only server-populated reserved request-context keys are trusted here.
      // Both owner and thread must exist even though the legacy queue cannot
      // enforce immutable owner binding until the V2 cutover.
      // User message fields and ad-hoc object properties must never select a
      // durable queue scope.
      console.warn(
        '[PendingUpdatesProcessor] pending_scope_missing; '
        + 'pending and ledger lookup skipped',
      );
      return messages;
    }

    try {
      const pendingMessages: PendingMessage[] = await takePendingMessages({
        threadId,
        agentId,
        limit,
      });

      // Task Ledger (Etap 1): surface lanes that NEED the agent's attention
      // (blocked / awaiting approval) even when no pending message arrived.
      // Digest consumption (finished lanes) stays with checkPendingUpdates —
      // markDigested: false here so the tool still reports them.
      let attentionBlock = '';
      if (isLedgerEnabled()) {
        const digest = await getLedgerDigest({ markDigested: false }).catch(() => undefined);
        if (digest && (digest.attention.length > 0 || digest.killSwitch)) {
          attentionBlock = [
            '## ⏸ Lanes needing attention (Task Ledger)',
            digest.killSwitch ? '🛑 KILL SWITCH ACTIVE — background lanes are paused.' : '',
            ...digest.attention.map((l) =>
              `#${l.laneNo} [${l.state}] ${l.source}/${l.agentId ?? '-'} · ${l.goal.slice(0, 100)}`),
            'Surface these to the user (approval questions first). Use ledger_status(laneId) for detail.',
          ].filter(Boolean).join('\n');
        }
      }

      if (pendingMessages.length === 0 && !attentionBlock) {
        console.log('[PendingUpdatesProcessor] No pending messages found — passing through');
        return messages;
      }

      if (pendingMessages.length === 0 && attentionBlock) {
        return {
          messages,
          systemMessages: [...systemMessages, { role: 'system' as const, content: attentionBlock }],
        };
      }

      const updateBlock = formatPendingMessagesForPrompt(pendingMessages);
      // SEC-001 — the content is now in the prompt block, so the lease can be
      // acknowledged. A crash before this point leaves it reclaimable.
      // Awaited: the processor returns the mutated prompt immediately after, so
      // settling must happen before the caller can observe the delivery.
      await ackPendingMessages({ messages: pendingMessages, agentId });

      console.log(
        `[PendingUpdatesProcessor] ✅ Injecting ${pendingMessages.length} pending update(s) into system messages`,
      );

      const injectedSystemMessage = {
        role: 'system' as const,
        content: [
          '## ⚡ Background Updates Available',
          'IMPORTANT: The following background task results arrived since your last response.',
          'You MUST acknowledge them at the beginning of your reply before addressing the user\'s question.',
          '',
          updateBlock,
          '',
          attentionBlock,
          attentionBlock ? '' : undefined,
          'After reporting these updates, proceed to address the user\'s current message.',
        ].filter((line): line is string => line !== undefined).join('\n'),
      };

      return {
        messages,
        systemMessages: [...systemMessages, injectedSystemMessage],
      };
    } catch {
      console.error('[PendingUpdatesProcessor] pending_updates_failed');
      return messages;
    }
  }
}

export const pendingUpdatesProcessor = new PendingUpdatesProcessor();
export const automationPendingUpdatesProcessor = new PendingUpdatesProcessor({
  agentId: AUTOMATION_ARCHITECT_AGENT_ID,
});
export const knowledgePendingUpdatesProcessor = new PendingUpdatesProcessor({
  agentId: KNOWLEDGE_AGENT_ID,
});
