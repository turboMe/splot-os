/**
 * Root meta-agent harness installer.
 *
 * Mastra serves the registered metaAgent directly, so root calls do not pass
 * through delegate-task gateways. This wrapper routes metaAgent.generate()
 * through the shared harness while keeping the original Agent instance,
 * tools, memory, processors, and registry entry intact.
 */

import { randomUUID } from 'crypto';
import type { Agent } from '@mastra/core/agent';
import { META_AGENT_ID, agentIdFieldFilter } from '../config/agent-ids.js';
import { getDb } from '../lib/mongo.js';
import { generateWithHarness } from './generate-with-harness.js';
import {
  attachmentNoteBlock,
  resolveInboxDir,
  scanAndPersistMessages,
} from './prompt-attachments.js';

const META_HARNESS_INSTALLED = Symbol.for('agentic.metaHarnessInstalled');
const META_STATUS_TIMEOUT_MS = 180_000;

type GenerateFn = (prompt: unknown, options?: Record<string, unknown>) => Promise<unknown>;

export function installMetaAgentHarness<TAgent extends Agent>(agent: TAgent): TAgent {
  const mutableAgent = agent as unknown as {
    [META_HARNESS_INSTALLED]?: boolean;
    generate: GenerateFn;
  };

  if (mutableAgent[META_HARNESS_INSTALLED]) return agent;

  const originalGenerate = mutableAgent.generate.bind(agent) as GenerateFn;
  mutableAgent[META_HARNESS_INSTALLED] = true;
  (mutableAgent as any).generate = async (prompt: unknown, options: Record<string, unknown> = {}) => {
    const memory = extractMemoryIds(options.memory);
    const taskId = String(options.taskId ?? options.runId ?? `meta-${randomUUID()}`);
    const runId = String(options.runId ?? taskId);
    const threadId = memory.threadId ?? taskId;

    // Persist user file attachments (Telegram gateway / REST multimodal input)
    // BEFORE flattening the prompt to text — normalizeGeneratePrompt keeps only
    // text parts, so without this step the file bytes would be silently lost.
    // Each persisted part is replaced in place with a `[załączony plik
    // zapisany: <path>]` marker, and the note block below tells the agent how
    // to use the paths.
    let attachmentNote = '';
    try {
      const promptMessages = extractPromptMessages(prompt);
      if (promptMessages.length > 0) {
        const saved = await scanAndPersistMessages(promptMessages, resolveInboxDir(threadId));
        if (saved.length > 0) attachmentNote = `\n\n---\n\n${attachmentNoteBlock(saved)}`;
      }
    } catch (error) {
      console.warn(`[MetaHarness] attachment persist failed: ${(error as Error).message}`);
    }

    const promptText = normalizeGeneratePrompt(prompt) + attachmentNote;
    // A short status question normally deserves the fast profile's 60 seconds.
    // It does not when Meta must reconcile a live delegation or Task Ledger: a
    // single tool read plus a grounded response already consumed that entire
    // window in production. Keep an explicit caller timeout authoritative.
    const timeoutMs = typeof options.timeoutMs === 'number'
      ? options.timeoutMs
      : await resolveMetaTimeout(promptText, threadId);
    const model = typeof options.model === 'string' ? options.model : undefined;

    // Forward the real agent's `listTools` so the harness prepareStep can
    // enumerate the tool universe and build the id→key map. Without it the
    // reflector's `restrictTools` hard lever is a no-op (empty tool universe),
    // so a detected tool_loop can be flagged but never actually broken.
    const agentWithTools = agent as unknown as {
      listTools?: (...args: unknown[]) => unknown;
      listConfiguredInputProcessors?: (...args: unknown[]) => unknown;
    };
    const rawAgent = {
      generate: originalGenerate,
      listTools: typeof agentWithTools.listTools === 'function'
        ? agentWithTools.listTools.bind(agent)
        : undefined,
      // Per-call inputProcessors replace the Agent's configured processors in
      // Mastra. Forward this method so the harness can append its abort fence
      // without dropping attachment persistence, pending updates, tool search,
      // or any request-context-dependent processor configured on metaAgent.
      listConfiguredInputProcessors:
        typeof agentWithTools.listConfiguredInputProcessors === 'function'
          ? agentWithTools.listConfiguredInputProcessors.bind(agent)
          : undefined,
    } as unknown as Agent;

    const harnessResult = await generateWithHarness({
      agent: rawAgent,
      agentId: META_AGENT_ID,
      prompt: promptText,
      taskId,
      runId,
      threadId,
      phase: 'chat',
      model,
      memoryResource: memory.resourceId ?? META_AGENT_ID,
      timeoutMs,
      precontextFeature: 'meta_depth_context',
      precontextDefaultEnabled: false,
      generateOptions: sanitizeGenerateOptions(options),
      onStepObservation:
        typeof options.onStepObservation === 'function'
          ? (options.onStepObservation as any)
          : typeof options.onStepFinish === 'function'
            ? async (obs: any) => (options.onStepFinish as any)(obs)
            : undefined,
    });

    return harnessResult.response;
  };

  return agent;
}

/**
 * Raises only Meta's status/reconciliation turns. The depth classifier remains
 * responsible for actual task complexity; this is a narrow I/O allowance for
 * a fast turn that must inspect durable state before responding.
 */
export async function resolveMetaTimeout(promptText: string, threadId: string): Promise<number | undefined> {
  if (mentionsDelegationOrLedger(promptText) || await hasPendingMetaWork(threadId)) {
    return META_STATUS_TIMEOUT_MS;
  }
  return undefined;
}

export function mentionsDelegationOrLedger(promptText: string): boolean {
  return /\b(?:delegac\w*|task\s+ledger|ledger|background\s+(?:task|update)|stan\s+(?:delegac|zadań)|status\s+(?:delegac|zadań))\b/i.test(promptText);
}

async function hasPendingMetaWork(threadId: string): Promise<boolean> {
  if (!threadId.trim()) return false;
  try {
    const db = await getDb();
    const metaAgentFilter = agentIdFieldFilter(META_AGENT_ID);
    const pendingQuery = {
      threadId,
      status: { $in: ['pending', 'claimed'] },
      ...(metaAgentFilter ? { targetAgentId: metaAgentFilter } : {}),
    };
    const [runningDelegation, pendingMessage] = await Promise.all([
      db.collection('async_delegations').findOne(
        { callerThreadId: threadId, status: 'running' },
        { projection: { _id: 1 }, maxTimeMS: 250 },
      ),
      db.collection('pending_user_messages').findOne(
        pendingQuery,
        { projection: { _id: 1 }, maxTimeMS: 250 },
      ),
    ]);
    return Boolean(runningDelegation || pendingMessage);
  } catch (error) {
    // Timeout selection must never make an ordinary chat fail when Mongo is
    // briefly unavailable. The normal depth profile remains the safe fallback.
    console.warn(`[MetaHarness] pending-work probe skipped: ${(error as Error).message}`);
    return false;
  }
}

/** Best-effort extraction of a mutable messages array from any prompt shape. */
function extractPromptMessages(prompt: unknown): unknown[] {
  if (Array.isArray(prompt)) return prompt;
  if (prompt && typeof prompt === 'object') {
    const record = prompt as Record<string, unknown>;
    if (Array.isArray(record.messages)) return record.messages;
    if ('role' in record && 'content' in record) return [record];
  }
  return [];
}

function normalizeGeneratePrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;

  if (Array.isArray(prompt)) {
    return prompt
      .map((message) => normalizeMessage(message))
      .filter(Boolean)
      .join('\n\n');
  }

  if (prompt && typeof prompt === 'object') {
    const record = prompt as Record<string, unknown>;
    if (typeof record.content === 'string') return record.content;
    if (Array.isArray(record.messages)) return normalizeGeneratePrompt(record.messages);
  }

  return JSON.stringify(prompt);
}

function normalizeMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return String(message ?? '');
  const record = message as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : 'message';
  const content = normalizeContent(record.content);
  return content ? `${role}: ${content}` : '';
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
          if (typeof record.content === 'string') return record.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function extractMemoryIds(memory: unknown): { threadId?: string; resourceId?: string } {
  if (!memory || typeof memory !== 'object') return {};
  const record = memory as Record<string, unknown>;
  return {
    threadId: extractId(record.thread),
    resourceId: extractId(record.resource),
  };
}

function extractId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && record.id.trim()) return record.id;
  }
  return undefined;
}

function sanitizeGenerateOptions(options: Record<string, unknown>): Record<string, unknown> {
  const {
    maxSteps: _maxSteps,
    memory: _memory,
    model: _model,
    onStepFinish: _onStepFinish,
    onStepObservation: _onStepObservation,
    runId: _runId,
    taskId: _taskId,
    timeoutMs: _timeoutMs,
    ...rest
  } = options;
  return rest;
}
