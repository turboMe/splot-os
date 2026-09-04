/**
 * Async semantic memory worker for the Mastra coding harness.
 *
 * The worker prepares memory context after an LLM turn, stores it as
 * pending_memory_context, and lets the next turn consume it cheaply.
 */

import { createHash, randomUUID } from 'crypto';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { EMBEDDING_MODEL_ID, cosineSimilarity, generateEmbedding } from '../lib/embedder.js';
import { getDb } from '../lib/mongo.js';
import type { SystemKnowledge } from './memory-extractor.js';
import { logHarnessEvent, tokenEstimate } from './harness-events.js';

export type PendingMemoryStatus = 'pending' | 'consumed' | 'stale' | 'suppressed';
export type InjectedMemorySource = 'pending' | 'sync_fallback';

export type PendingMemoryContext = {
  id: string;
  threadId: string;
  taskId?: string;
  agentId: string;
  queryHash: string;
  prompt: string;
  displayPrompt?: string;
  memoryIds: string[];
  count: number;
  tokenEstimate: number;
  status: PendingMemoryStatus;
  computedAt: Date;
  consumedAt?: Date;
  expiresAt: Date;
  runId?: string;
  turnId?: string;
  subtaskId?: string;
  sourceScores?: Array<{ memoryId: string; rawScore: number; score: number }>;
};

export type ScheduleSemanticMemoryInput = {
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  agentId: string;
  runId?: string;
  turnId?: string;
  model?: string;
  contextText: string;
  projectId?: string;
  maxCandidates?: number;
};

export type TakePendingMemoryInput = {
  threadId?: string;
  taskId?: string;
  agentId?: string;
  maxAgeMs?: number;
};

const PENDING_COLLECTION = 'pending_memory_context';
const INJECTED_COLLECTION = 'injected_memory_context';
const PENDING_TTL_MS = 24 * 3600 * 1000;
const DEFAULT_MAX_CANDIDATES = 300;
const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0.42;
const MAX_QUERY_CHARS = 5000;
const MAX_MEMORY_ITEM_TOKENS = 220;
const MAX_MEMORY_PROMPT_TOKENS = 1100;

const TYPE_BOOST: Record<string, number> = {
  failure_case: 0.06,
  coding_pattern: 0.06,
  architecture_decision: 0.05,
  tool_contract: 0.04,
  prompt_rule: 0.03,
};

type ScoredMemory = {
  knowledgeId: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  createdAt: Date;
  updatedAt?: Date;
  rawScore: number;
  score: number;
};

export async function scheduleSemanticMemoryCheck(
  input: ScheduleSemanticMemoryInput,
): Promise<void> {
  if (!isHarnessFeatureEnabled('FEATURE_ASYNC_SEMANTIC_MEMORY', false)) return;

  const scope = normalizeScope(input);
  if (!scope.threadId) {
    void logHarnessEvent({
      type: 'semantic_memory_suppressed',
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'async_semantic_memory',
      model: input.model,
      status: 'success',
      data: { reason: 'missing_thread_or_task_scope' },
    });
    return;
  }

  const job = runSemanticMemoryCheck({ ...input, threadId: scope.threadId });
  void job.catch((error) => {
    void logHarnessEvent({
      type: 'semantic_memory_suppressed',
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: scope.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'async_semantic_memory',
      model: input.model,
      status: 'error',
      errorMessage: (error as Error).message,
      data: { reason: 'worker_failed' },
    });
  });
}

export async function takePendingMemoryContext(
  input: TakePendingMemoryInput,
): Promise<PendingMemoryContext | null> {
  if (!isHarnessFeatureEnabled('FEATURE_ASYNC_SEMANTIC_MEMORY', false)) return null;

  const scope = normalizeScope(input);
  if (!scope.threadId) return null;

  const db = await getDb();
  const now = new Date();
  const minComputedAt = new Date(now.getTime() - (input.maxAgeMs ?? PENDING_TTL_MS));
  const clauses = scopeClauses(scope);
  if (clauses.length === 0) return null;

  const doc = await db
    .collection<PendingMemoryContext>(PENDING_COLLECTION)
    .find({
      status: 'pending',
      expiresAt: { $gt: now },
      computedAt: { $gte: minComputedAt },
      $or: clauses,
    })
    .sort({ computedAt: -1 })
    .limit(1)
    .next();

  if (!doc) return null;

  const freshIds = await filterPreviouslyInjectedMemoryIds(scope, doc.memoryIds);
  if (freshIds.length !== doc.memoryIds.length) {
    await db.collection(PENDING_COLLECTION).updateOne(
      { id: doc.id },
      { $set: { status: 'suppressed', consumedAt: now } },
    );
    return null;
  }

  await db.collection(PENDING_COLLECTION).updateOne(
    { id: doc.id },
    { $set: { status: 'consumed', consumedAt: now } },
  );

  await recordInjectedMemoryContext({
    threadId: scope.threadId,
    taskId: input.taskId,
    agentId: input.agentId,
    memoryIds: freshIds,
    source: 'pending',
  });

  return { ...doc, memoryIds: freshIds, count: freshIds.length };
}

export async function filterPreviouslyInjectedMemoryIds(
  input: { threadId?: string; taskId?: string },
  memoryIds: string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(memoryIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const scope = normalizeScope(input);
  if (!scope.threadId) return uniqueIds;

  const db = await getDb();
  const injected = await db
    .collection<{ memoryId: string }>(INJECTED_COLLECTION)
    .find({
      memoryId: { $in: uniqueIds },
      $or: scopeClauses(scope),
    })
    .project({ memoryId: 1 })
    .toArray();

  const injectedIds = new Set(injected.map((item) => item.memoryId));
  return uniqueIds.filter((id) => !injectedIds.has(id));
}

export async function recordInjectedMemoryContext(input: {
  threadId?: string;
  taskId?: string;
  agentId?: string;
  memoryIds: string[];
  source: InjectedMemorySource;
}): Promise<void> {
  const scope = normalizeScope(input);
  if (!scope.threadId) return;

  const uniqueIds = [...new Set(input.memoryIds.filter(Boolean))];
  if (uniqueIds.length === 0) return;

  const db = await getDb();
  const now = new Date();
  await Promise.all(uniqueIds.map((memoryId) =>
    db.collection(INJECTED_COLLECTION).updateOne(
      { threadId: scope.threadId, memoryId },
      {
        $setOnInsert: {
          threadId: scope.threadId,
          taskId: input.taskId,
          agentId: input.agentId,
          memoryId,
          source: input.source,
          injectedAt: now,
        },
      },
      { upsert: true },
    ).catch(() => undefined),
  ));
}

async function runSemanticMemoryCheck(input: ScheduleSemanticMemoryInput): Promise<void> {
  const startedAt = Date.now();
  const scope = normalizeScope(input);
  const contextText = normalizeText(input.contextText).slice(0, MAX_QUERY_CHARS);

  await logHarnessEvent({
    type: 'semantic_memory_check_started',
    agentId: input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: scope.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: 'async_semantic_memory',
    model: input.model,
    status: 'pending',
    data: {
      contextTokensEstimate: tokenEstimate(contextText),
      maxCandidates: input.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    },
  });

  if (!contextText) {
    await logSemanticMemorySuppressed(input, 'empty_context_text', startedAt);
    return;
  }

  const queryEmbedding = await generateEmbedding(contextText);
  const db = await getDb();
  const now = new Date();
  const candidates = await db
    .collection<SystemKnowledge>('system_knowledge')
    .find({
      expiresAt: { $gt: now },
      embeddingModel: EMBEDDING_MODEL_ID,
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(input.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
    .toArray() as unknown as SystemKnowledge[];

  const scored = candidates
    .map((candidate) => scoreCandidate(queryEmbedding, candidate, input.projectId))
    .filter((candidate): candidate is ScoredMemory => !!candidate)
    .filter((candidate) => candidate.score >= DEFAULT_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_TOP_K);

  if (scored.length === 0) {
    await logSemanticMemorySuppressed(input, 'no_relevant_candidates', startedAt);
    return;
  }

  const freshMemoryIds = await filterPreviouslyInjectedMemoryIds(
    { threadId: scope.threadId, taskId: input.taskId },
    scored.map((item) => item.knowledgeId),
  );
  const fresh = scored.filter((item) => freshMemoryIds.includes(item.knowledgeId));

  if (fresh.length === 0) {
    await logSemanticMemorySuppressed(input, 'all_candidates_already_injected', startedAt, {
      candidateIds: scored.map((item) => item.knowledgeId),
    });
    return;
  }

  const overlap = await pendingOverlapRatio(
    { threadId: scope.threadId, taskId: input.taskId },
    fresh.map((item) => item.knowledgeId),
  );
  if (overlap >= 0.8) {
    await logSemanticMemorySuppressed(input, 'pending_set_overlap', startedAt, { overlap });
    return;
  }

  const prompt = formatMemoryPrompt(fresh.slice(0, 3));
  if (!prompt) {
    await logSemanticMemorySuppressed(input, 'empty_formatted_prompt', startedAt);
    return;
  }

  await staleExistingPending({ threadId: scope.threadId, taskId: input.taskId });

  const memoryIds = fresh.map((item) => item.knowledgeId);
  const doc: PendingMemoryContext = {
    id: randomUUID(),
    threadId: scope.threadId!,
    taskId: input.taskId,
    agentId: input.agentId,
    queryHash: hashText(contextText),
    prompt,
    displayPrompt: prompt,
    memoryIds,
    count: memoryIds.length,
    tokenEstimate: tokenEstimate(prompt),
    status: 'pending',
    computedAt: now,
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
    runId: input.runId,
    turnId: input.turnId,
    subtaskId: input.subtaskId,
    sourceScores: fresh.map((item) => ({
      memoryId: item.knowledgeId,
      rawScore: roundScore(item.rawScore),
      score: roundScore(item.score),
    })),
  };

  await db.collection<PendingMemoryContext>(PENDING_COLLECTION).insertOne(doc);

  await logHarnessEvent({
    type: 'semantic_memory_pending_prepared',
    agentId: input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: scope.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: 'async_semantic_memory',
    model: input.model,
    status: 'success',
    durationMs: Date.now() - startedAt,
    output: prompt,
    data: {
      pendingId: doc.id,
      queryHash: doc.queryHash,
      memoryIds,
      count: doc.count,
      tokenEstimate: doc.tokenEstimate,
      sourceScores: doc.sourceScores,
    },
  });
}

function scoreCandidate(
  queryEmbedding: number[],
  candidate: SystemKnowledge,
  projectId?: string,
): ScoredMemory | null {
  if (!Array.isArray(candidate.embedding) || candidate.embedding.length === 0) return null;

  let rawScore = 0;
  try {
    rawScore = cosineSimilarity(queryEmbedding, candidate.embedding);
  } catch {
    return null;
  }

  const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : 0.5;
  const recency = recencyBoost(candidate.updatedAt ?? candidate.createdAt);
  const typeBoost = TYPE_BOOST[candidate.type] ?? 0;
  const projectBoost = projectId && candidate.projectId === projectId ? 0.04 : 0;
  const score = (rawScore * (0.85 + confidence * 0.25)) + recency + typeBoost + projectBoost;

  return {
    knowledgeId: candidate.knowledgeId,
    type: candidate.type,
    title: candidate.title,
    content: candidate.content,
    confidence,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    rawScore,
    score,
  };
}

async function pendingOverlapRatio(
  input: { threadId?: string; taskId?: string },
  memoryIds: string[],
): Promise<number> {
  const scope = normalizeScope(input);
  if (!scope.threadId || memoryIds.length === 0) return 0;

  const db = await getDb();
  const previous = await db
    .collection<PendingMemoryContext>(PENDING_COLLECTION)
    .find({
      status: 'pending',
      expiresAt: { $gt: new Date() },
      $or: scopeClauses(scope),
    })
    .sort({ computedAt: -1 })
    .limit(1)
    .next();

  if (!previous || previous.memoryIds.length === 0) return 0;

  const previousIds = new Set(previous.memoryIds);
  const overlap = memoryIds.filter((id) => previousIds.has(id)).length;
  return overlap / Math.max(1, memoryIds.length);
}

async function staleExistingPending(input: { threadId?: string; taskId?: string }): Promise<void> {
  const scope = normalizeScope(input);
  if (!scope.threadId) return;

  const db = await getDb();
  await db.collection(PENDING_COLLECTION).updateMany(
    {
      status: 'pending',
      expiresAt: { $gt: new Date() },
      $or: scopeClauses(scope),
    },
    { $set: { status: 'stale', staleAt: new Date() } },
  );
}

async function logSemanticMemorySuppressed(
  input: ScheduleSemanticMemoryInput,
  reason: string,
  startedAt: number,
  data: Record<string, unknown> = {},
): Promise<void> {
  const scope = normalizeScope(input);
  await logHarnessEvent({
    type: 'semantic_memory_suppressed',
    agentId: input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: scope.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: 'async_semantic_memory',
    model: input.model,
    status: 'success',
    durationMs: Date.now() - startedAt,
    data: { reason, ...data },
  });
}

function formatMemoryPrompt(items: ScoredMemory[]): string {
  const lines = items.map((item) => {
    const content = truncateToTokens(normalizeText(item.content), MAX_MEMORY_ITEM_TOKENS);
    return `- [${item.type}] ${item.title} (score ${item.score.toFixed(2)}, confidence ${item.confidence.toFixed(2)}): ${content}`;
  });
  return truncateToTokens(lines.join('\n'), MAX_MEMORY_PROMPT_TOKENS);
}

function normalizeScope(input: { threadId?: string; taskId?: string }): { threadId?: string; taskId?: string } {
  return {
    threadId: input.threadId || input.taskId,
    taskId: input.taskId,
  };
}

function scopeClauses(scope: { threadId?: string; taskId?: string }): Array<Record<string, string>> {
  return [
    ...(scope.threadId ? [{ threadId: scope.threadId }] : []),
    ...(scope.taskId ? [{ taskId: scope.taskId }] : []),
  ];
}

function normalizeText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens) * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated to fit token budget)`;
}

function recencyBoost(value: Date | string | undefined): number {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const ageMs = Date.now() - date.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0.02;
  const ageDays = ageMs / (24 * 3600 * 1000);
  if (ageDays <= 7) return 0.03;
  if (ageDays <= 30) return 0.02;
  if (ageDays <= 90) return 0.01;
  return 0;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
