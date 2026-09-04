/**
 * Memory Extractor (Phase 1.3)
 *
 * Background worker that analyzes `agent_events` and extracts
 * typed knowledge patterns into `system_knowledge`.
 *
 * Extraction patterns:
 *   1. retry_success + task_failed in same taskId → failure_case
 *   2. Repeated tool_error with same errorMessage → tool_contract
 *   3. autoheal_triggered + autoheal_resolved → autoheal_recipe
 *   4. delegation with high durationMs → prompt_rule (costly prompt)
 *
 * Knowledge has 90-day TTL (renewable on recall).
 *
 * Usage:
 *   import { extractKnowledge } from './services/memory-extractor.js';
 *   const extracted = await extractKnowledge();
 *   console.log(`Extracted ${extracted} knowledge items`);
 */

import { createHash, randomUUID } from 'crypto';
import { getDb } from '../lib/mongo.js';
import { EMBEDDING_MODEL_ID, generateEmbedding } from '../lib/embedder.js';
import type { AgentEvent, AgentEventType } from '../lib/agent-event-log.js';

// ── Types ────────────────────────────────────────────────────────────────────

// Single source of truth for knowledge categories. Both memory-write and
// memory-recall import this array so their Zod enums can NEVER drift apart.
// (A past drift — recall missing 'system_diagnostic' etc. that write accepts —
// caused an infinite tool_loop: agent writes a type it cannot recall.)
export const KNOWLEDGE_TYPES = [
  'failure_case',
  'coding_pattern',
  'autoheal_recipe',
  'tool_contract',
  'prompt_rule',
  'user_preference',
  'project_fact',
  'architecture_decision',
  'system_diagnostic',
  'workflow_result',
  'operational_note',
  'env_config',
] as const;

export type KnowledgeType = typeof KNOWLEDGE_TYPES[number];

export interface SystemKnowledge {
  knowledgeId: string;
  type: KnowledgeType;
  title: string;
  content: string;
  tags?: string[];
  sourceAgent?: string;
  projectId?: string;
  searchText?: string;
  searchTextHash?: string;
  embedding: number[];
  embeddingModel?: string;
  sourceEventIds: string[];
  confidence: number;       // 0–1
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

// ── Config ───────────────────────────────────────────────────────────────────

const KNOWLEDGE_TTL_DAYS = 90;
const MAX_EVENTS_PER_RUN = 500;

/** Metadata key to track last extraction run */
const LAST_RUN_KEY = 'memory_extractor_last_run';

// ── Helpers ──────────────────────────────────────────────────────────────────

export function buildSystemKnowledgeSearchText(input: {
  type?: string;
  title?: string;
  content?: string;
  tags?: string[];
  sourceAgent?: string;
  projectId?: string;
}): string {
  return [
    input.type,
    input.title,
    input.content,
    ...(input.tags ?? []),
    input.sourceAgent,
    input.projectId,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .join('\n')
    .slice(0, 4000);
}

export function hashSystemKnowledgeSearchText(searchText: string): string {
  return createHash('sha256').update(searchText).digest('hex');
}

function truncate(text: string, max = 1000): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

async function getLastRunTimestamp(): Promise<Date> {
  const db = await getDb();
  const meta = await db.collection('system_metadata').findOne({ key: LAST_RUN_KEY });
  return meta?.value ? new Date(meta.value as string) : new Date(0);
}

async function setLastRunTimestamp(ts: Date): Promise<void> {
  const db = await getDb();
  await db.collection('system_metadata').updateOne(
    { key: LAST_RUN_KEY },
    { $set: { key: LAST_RUN_KEY, value: ts.toISOString() } },
    { upsert: true },
  );
}

async function saveKnowledge(
  type: KnowledgeType,
  title: string,
  content: string,
  sourceEventIds: string[],
  confidence: number,
): Promise<string> {
  const db = await getDb();
  const knowledgeId = randomUUID();
  const now = new Date();
  const storedContent = truncate(content);
  const searchText = buildSystemKnowledgeSearchText({ type, title, content: storedContent });
  const searchTextHash = hashSystemKnowledgeSearchText(searchText);

  let embedding: number[] = [];
  try {
    embedding = await generateEmbedding(searchText);
  } catch (err) {
    console.warn('[MemoryExtractor] Embedding failed, saving without vector:', (err as Error).message);
  }

  // Check for duplicate by title similarity (exact title match)
  const existing = await db.collection<SystemKnowledge>('system_knowledge').findOne({
    type,
    title,
  });

  if (existing) {
    // Update existing knowledge — refresh TTL and merge event IDs
    await db.collection('system_knowledge').updateOne(
      { knowledgeId: existing.knowledgeId },
      {
        $set: {
          content: storedContent,
          searchText,
          searchTextHash,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000),
          embedding,
          embeddingModel: embedding.length > 0 ? EMBEDDING_MODEL_ID : undefined,
          confidence: Math.min(1, existing.confidence + 0.1), // grows with repetition
        },
        $addToSet: { sourceEventIds: { $each: sourceEventIds } },
      },
    );
    return existing.knowledgeId;
  }

  const doc: SystemKnowledge = {
    knowledgeId,
    type,
    title,
    content: storedContent,
    searchText,
    searchTextHash,
    embedding,
    embeddingModel: embedding.length > 0 ? EMBEDDING_MODEL_ID : undefined,
    sourceEventIds,
    confidence,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000),
  };

  await db.collection('system_knowledge').insertOne(doc as any);
  return knowledgeId;
}

// ── Pattern Detectors ────────────────────────────────────────────────────────

/**
 * Pattern 1: retry_success events → failure_case
 * A retry that succeeded means the first attempt failed for an identifiable reason.
 */
async function extractRetryPatterns(events: AgentEvent[]): Promise<number> {
  const retrySuccesses = events.filter(e => e.type === 'retry_success');
  let count = 0;

  for (const event of retrySuccesses) {
    if (!event.taskId) continue;

    const title = `Retry success: ${event.subtaskId ?? event.taskId}`;
    const content = [
      `Agent: ${event.agentId}`,
      `Model: ${event.model ?? 'unknown'}`,
      `Task: ${event.taskId}`,
      event.subtaskId ? `Subtask: ${event.subtaskId}` : '',
      event.output ? `Result: ${event.output}` : '',
      event.metadata ? `Context: ${JSON.stringify(event.metadata)}` : '',
    ].filter(Boolean).join('\n');

    await saveKnowledge('failure_case', title, content, [event.eventId], 0.7);
    count++;
  }

  return count;
}

/**
 * Pattern 2: Repeated tool_error with same errorMessage → tool_contract
 */
async function extractToolErrorPatterns(events: AgentEvent[]): Promise<number> {
  const toolErrors = events.filter(e => e.type === 'tool_error' && e.errorMessage);
  const errorGroups = new Map<string, AgentEvent[]>();

  for (const event of toolErrors) {
    const key = `${event.toolId ?? 'unknown'}::${event.errorMessage!.slice(0, 100)}`;
    const group = errorGroups.get(key) ?? [];
    group.push(event);
    errorGroups.set(key, group);
  }

  let count = 0;
  for (const [key, group] of errorGroups) {
    if (group.length < 2) continue; // only extract if pattern repeats

    const [toolId, errPrefix] = key.split('::');
    // A tool the POLICY stopped is not a tool with a broken contract. The same
    // reasoning as in `extractDirectFailures`: filing an approval gate here
    // teaches the next run that deploy/activate are defective tools to route
    // around, when refusing without approval is the feature.
    if (isPolicyGateMessage(errPrefix)) continue;
    const title = `Tool contract violation: ${toolId} — ${errPrefix}`;
    const content = [
      `Tool: ${toolId}`,
      `Error pattern: ${errPrefix}`,
      `Occurrences: ${group.length}`,
      `Models involved: ${[...new Set(group.map(e => e.model))].join(', ')}`,
      `Fix: Review tool input validation or update agent instructions for ${toolId}`,
    ].join('\n');

    const eventIds = group.map(e => e.eventId);
    await saveKnowledge('tool_contract', title, content, eventIds, Math.min(1, 0.5 + group.length * 0.1));
    count++;
  }

  return count;
}

/**
 * Pattern 3: autoheal_triggered → autoheal_recipe
 */
async function extractAutohealPatterns(events: AgentEvent[]): Promise<number> {
  const heals = events.filter(e => e.type === 'autoheal_triggered' || e.type === 'autoheal_resolved');
  let count = 0;

  for (const event of heals) {
    if (event.type !== 'autoheal_triggered') continue;

    const resolved = heals.find(e =>
      e.type === 'autoheal_resolved' && e.taskId === event.taskId
    );

    const title = `Autoheal: ${event.input?.slice(0, 80) ?? event.taskId ?? 'unknown'}`;
    const content = [
      `Trigger: ${event.input ?? 'unknown error'}`,
      `Source: ${(event.metadata as any)?.source ?? 'unknown'}`,
      `Origin: ${(event.metadata as any)?.origin ?? 'unknown'}`,
      resolved ? `Resolution: successful` : `Resolution: pending/unknown`,
    ].join('\n');

    await saveKnowledge('autoheal_recipe', title, content, [event.eventId], resolved ? 0.9 : 0.5);
    count++;
  }

  return count;
}

/**
 * Pattern 4 (REMOVED 2026-08-24): delegation duration → `prompt_rule`.
 *
 * This filed one `prompt_rule` per delegation over 60s, with the body
 * "Recommendation: Consider splitting task or reducing prompt size". Three
 * things were wrong with it and none are fixable by tuning the threshold:
 *
 *  1. **The premise is false here.** A long delegation is the NORMAL shape of
 *     this system's work — the architect runs on a 1200s budget, coding and chef
 *     on hundreds of seconds. "Over 60s" describes almost every real delegation,
 *     so the rule fired constantly and said nothing.
 *  2. **It was stored as a RULE.** `memoryRecallTool` presents `prompt_rule` as
 *     "prompt optimization insights", so agents recalled these as guidance. The
 *     advice actively discouraged the one handoff that grounds n8n node schemas:
 *     entries reading "Costly delegation: n8nMcpEngineer — consider splitting"
 *     sat in recall while the architect was hallucinating typeVersions for want
 *     of exactly that handoff (see project_architect_toolshelf_starvation).
 *  3. **It drowned the real rules.** One entry per event, no dedup: 119 of the
 *     124 `prompt_rule` records in `system_knowledge` came from here. The five
 *     genuine rules were 4% of the bucket.
 *
 * Latency is telemetry, not knowledge. It is already durable in `agent_events`
 * (`durationMs`) and surfaced by the dashboard's latency view, which is where a
 * question about slow delegations belongs. Nothing is lost by not also asserting
 * it into semantic recall as advice.
 */

/**
 * Messages produced by approval / activation / risk policy stopping a run on
 * purpose, rather than by anything going wrong.
 */
export function isPolicyGateMessage(message: string | undefined): boolean {
  if (!message) return false;
  // `require(s) <anything> approval` rather than `requires approval`: the depth
  // gate phrases it as «Depth profile "critical" requires explicit approval
  // before high-risk tool execution», and the adverb was enough to slip past the
  // adjacent-words form. Four such records reached `system_knowledge` as
  // `tool_contract` at confidence 0.9–1.0, naming `deployAutomationTool`,
  // `activateAutomationTool` and `executeAutomationRequestTool` — the three most
  // important tools on the Golden Path — as contract violators, with a "Fix:
  // Review tool input validation" line. The gate had done exactly its job.
  return /requires?\b[^.]{0,40}\bapproval|approvalToken|activation (?:was )?blocked|awaiting (?:user|human)|pending approval/i
    .test(message);
}

/**
 * Pattern 5: task_failed with no retry → direct failure case
 */
async function extractDirectFailures(events: AgentEvent[]): Promise<number> {
  const failures = events.filter(e => e.type === 'task_failed' && e.errorMessage);
  const retryTaskIds = new Set(
    events.filter(e => e.type === 'retry_success').map(e => e.taskId).filter(Boolean),
  );

  let count = 0;
  for (const event of failures) {
    // Skip if this task had a successful retry (already captured by pattern 1)
    if (event.taskId && retryTaskIds.has(event.taskId)) continue;

    // A run that stopped for a human decision is not an unrecovered failure.
    // These messages come from approval and activation policy working as
    // designed, and filing them as `failure_case` puts "this needed your
    // approval" into the same recall bucket as real defects — teaching the next
    // run that the approval path is a failure mode to avoid. The decision is
    // already durable in `approvals`; it does not belong in failure learning.
    if (isPolicyGateMessage(event.errorMessage)) continue;

    const title = `Unrecovered failure: ${event.errorMessage?.slice(0, 80) ?? 'unknown'}`;
    const content = [
      `Agent: ${event.agentId}`,
      `Model: ${event.model ?? 'unknown'}`,
      `Task: ${event.taskId ?? 'N/A'}`,
      `Error: ${event.errorMessage}`,
      event.metadata ? `Context: ${JSON.stringify(event.metadata)}` : '',
    ].filter(Boolean).join('\n');

    await saveKnowledge('failure_case', title, content, [event.eventId], 0.8);
    count++;
  }

  return count;
}

// ── Main Extraction Function ─────────────────────────────────────────────────

/**
 * Run one extraction cycle.
 * Fetches new events since last run, applies all pattern detectors,
 * and saves extracted knowledge to system_knowledge.
 *
 * @returns Number of knowledge items extracted/updated
 */
export async function extractKnowledge(): Promise<number> {
  const since = await getLastRunTimestamp();
  const now = new Date();

  const db = await getDb();
  const events = await db
    .collection<AgentEvent>('agent_events')
    .find({ timestamp: { $gt: since } })
    .sort({ timestamp: 1 })
    .limit(MAX_EVENTS_PER_RUN)
    .toArray() as unknown as AgentEvent[];

  if (events.length === 0) {
    console.log('[MemoryExtractor] No new events since', since.toISOString());
    return 0;
  }

  console.log(`[MemoryExtractor] Processing ${events.length} events since ${since.toISOString()}`);

  let total = 0;
  total += await extractRetryPatterns(events);
  total += await extractToolErrorPatterns(events);
  total += await extractAutohealPatterns(events);
  // Pattern 4 (costly delegations) intentionally absent — see the block comment
  // above `isPolicyGateMessage`. It filed latency telemetry as a recallable rule.
  total += await extractDirectFailures(events);

  await setLastRunTimestamp(now);

  console.log(`[MemoryExtractor] Extracted ${total} knowledge items`);
  return total;
}

/**
 * Renew TTL on a knowledge item (called when it's recalled).
 * This prevents useful knowledge from expiring.
 */
export async function renewKnowledgeTTL(knowledgeId: string): Promise<void> {
  const db = await getDb();
  await db.collection('system_knowledge').updateOne(
    { knowledgeId },
    {
      $set: {
        expiresAt: new Date(Date.now() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000),
        updatedAt: new Date(),
      },
      $inc: { usageCount: 1 },
    },
  );
}
