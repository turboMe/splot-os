/**
 * Singleton MongoDB connection for tools and services.
 * Replaces: apps/workers/src/core/db.ts from jarvis.
 * Used by: CRM tools, RSS tools, Chef service, memory tools, architect patterns.
 */
import { MongoClient, type Db } from 'mongodb';
import { ensurePendingMessageClaimIndexes } from './pending-message-indexes.js';

let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;

async function connectClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/agentforge';
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000),
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export async function getDb(): Promise<Db> {
  if (cachedDb) return cachedDb;
  cachedClient = await connectClient();
  cachedDb = cachedClient.db();
  return cachedDb;
}

export async function getRssDb(): Promise<Db> {
  if (!cachedClient) {
    cachedClient = await connectClient();
  }
  return cachedClient.db('rss_intelligence');
}

export async function closeDb(): Promise<void> {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    cachedDb = null;
  }
}

/**
 * Ensures required indexes exist for chef + core collections.
 * Safe to call multiple times (MongoDB no-ops if already exists).
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  const rssDb = await getRssDb();
  await Promise.all([
    // CRM
    db.collection('leads').createIndex({ email: 1 }),
    db.collection('leads').createIndex({ status: 1 }),
    db.collection('leads').createIndex({ region: 1 }),
    db.collection('leads').createIndex({ updatedAt: -1 }),
    // Tasks / runs / logs
    db.collection('tasks').createIndex({ taskId: 1 }),
    db.collection('tasks').createIndex({ agentId: 1 }),
    db.collection('tasks').createIndex({ createdAt: -1 }),
    db.collection('tasks').createIndex({ status: 1 }),
    db.collection('runs').createIndex({ taskId: 1 }),
    db.collection('logs').createIndex({ timestamp: -1 }),
    db.collection('agent_runs').createIndex({ runId: 1 }, { unique: true }),
    db.collection('agent_runs').createIndex({ taskId: 1, updatedAt: -1 }),
    db.collection('agent_runs').createIndex({ threadId: 1, updatedAt: -1 }),
    db.collection('agent_runs').createIndex({ status: 1, updatedAt: -1 }),
    db.collection('agent_run_events').createIndex({ runId: 1, timestamp: 1 }),
    db.collection('agent_run_events').createIndex({ taskId: 1, timestamp: -1 }),
    db.collection('agent_run_events').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Approvals
    db.collection('approvals').createIndex({ status: 1 }),
    db.collection('approvals').createIndex({ createdAt: -1 }),
    // Coding agent artifacts / rollback ledger
    db.collection('code_task_artifacts').createIndex({ taskId: 1 }, { unique: true }),
    db.collection('code_task_artifacts').createIndex({ status: 1, updatedAt: -1 }),
    db.collection('code_task_artifacts').createIndex({ agentId: 1, updatedAt: -1 }),
    db.collection('code_change_snapshots').createIndex({ taskId: 1, path: 1 }, { unique: true }),
    db.collection('code_change_snapshots').createIndex({ taskId: 1, status: 1 }),
    db.collection('code_change_snapshots').createIndex({ status: 1, updatedAt: -1 }),
    db.collection('maintenance_tasks').createIndex({ id: 1 }, { unique: true, sparse: true }),
    db.collection('maintenance_tasks').createIndex({ status: 1, updatedAt: -1 }),
    db.collection('maintenance_tasks').createIndex({ source: 1, createdAt: -1 }),
    // Self-healing tickets (Etap 7)
    db.collection('auto_healing_tickets').createIndex({ ticketId: 1 }, { unique: true }),
    db.collection('auto_healing_tickets').createIndex({ errorSignature: 1, status: 1 }),
    db.collection('auto_healing_tickets').createIndex({ status: 1, createdAt: -1 }),
    db.collection('auto_healing_tickets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Memory / signals (TTL)
    db.collection('signals').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('shared_memory').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('conversations').createIndex({ threadId: 1 }),
    db.collection('pending_memory_context').createIndex({ threadId: 1, status: 1, computedAt: -1 }),
    db.collection('pending_memory_context').createIndex({ taskId: 1, status: 1, computedAt: -1 }),
    db.collection('pending_memory_context').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('injected_memory_context').createIndex({ threadId: 1, memoryId: 1 }, { unique: true }),
    db.collection('injected_memory_context').createIndex(
      { injectedAt: 1 },
      { expireAfterSeconds: 90 * 24 * 3600 },
    ),
    db.collection('pending_user_messages').createIndex({ taskId: 1, status: 1, createdAt: 1 }),
    db.collection('pending_user_messages').createIndex({ threadId: 1, status: 1, createdAt: 1 }),
    ensurePendingMessageClaimIndexes(db),
    db.collection('pending_user_messages').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('file_activity').createIndex({ file: 1, createdAt: -1 }),
    db.collection('file_activity').createIndex({ taskId: 1, file: 1, createdAt: -1 }),
    db.collection('file_activity').createIndex({ agentId: 1, createdAt: -1 }),
    db.collection('file_activity').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('tool_executions').createIndex({ runId: 1, createdAt: 1 }),
    db.collection('tool_executions').createIndex({ taskId: 1, createdAt: -1 }),
    db.collection('tool_executions').createIndex({ toolId: 1, createdAt: -1 }),
    db.collection('tool_executions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('harness_artifacts').createIndex({ id: 1 }, { unique: true }),
    db.collection('harness_artifacts').createIndex({ runId: 1, createdAt: 1 }),
    db.collection('harness_artifacts').createIndex({ taskId: 1, createdAt: -1 }),
    db.collection('harness_artifacts').createIndex({ kind: 1, createdAt: -1 }),
    db.collection('harness_artifacts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Periodic worker metrics (P2 — ring-buffer of last runs per worker, TTL-pruned)
    db.collection('worker_metrics').createIndex({ workerId: 1, timestamp: -1 }),
    db.collection('worker_metrics').createIndex({ status: 1, timestamp: -1 }),
    db.collection('worker_metrics').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Background tasks
    db.collection('background_tasks').createIndex({ taskId: 1 }, { unique: true }),
    db.collection('background_tasks').createIndex({ ownerTaskId: 1, startedAt: -1 }),
    db.collection('background_tasks').createIndex({ status: 1, startedAt: -1 }),
    db.collection('background_tasks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Native automation jobs
    db.collection('automation_jobs').createIndex({ jobId: 1 }, { unique: true }),
    db.collection('automation_jobs').createIndex({ automationId: 1, startedAt: -1 }),
    db.collection('automation_jobs').createIndex({ targetAgentId: 1, status: 1, startedAt: -1 }),
    db.collection('automation_jobs').createIndex({ returnToAgentId: 1, status: 1, startedAt: -1 }),
    db.collection('automation_jobs').createIndex({ status: 1, lastHeartbeatAt: -1 }),
    db.collection('automation_jobs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Universal scheduled task orchestrator
    db.collection('scheduled_tasks').createIndex({ taskId: 1 }, { unique: true }),
    db.collection('scheduled_tasks').createIndex({ status: 1, 'schedule.fireAt': 1 }),
    db.collection('scheduled_tasks').createIndex({ chainId: 1, createdAt: 1 }),
    db.collection('scheduled_tasks').createIndex({ 'lease.expiresAt': 1 }),
    db.collection('scheduled_tasks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('task_chains').createIndex({ chainId: 1, completedAt: 1 }),
    db.collection('task_chains').createIndex({ taskId: 1 }, { unique: true, sparse: true }),
    db.collection('task_chains').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('scheduled_task_dispatches').createIndex({ idempotencyKey: 1 }, { unique: true }),
    db.collection('scheduled_task_dispatches').createIndex({ taskId: 1, status: 1 }),
    db.collection('scheduled_task_dispatches').createIndex({ status: 1, startedAt: -1 }),
    db.collection('scheduled_task_dispatches').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Chef
    db.collection('chef_projects').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_projects').createIndex({ status: 1 }),
    db.collection('chef_menus').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_menus').createIndex({ projectId: 1, version: -1 }),
    db.collection('chef_recipes').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_notes').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_notes').createIndex({ projectId: 1 }),
    // Automation patterns
    db.collection('automation_patterns').createIndex({ id: 1 }, { unique: true }),
    // RSS/content intelligence lives in the dedicated rss_intelligence database.
    rssDb.collection('rss_articles').createIndex({ guid: 1 }, { unique: true }),
    rssDb.collection('rss_articles').createIndex({ canonicalUrl: 1 }),
    rssDb.collection('rss_articles').createIndex({ processed: 1, sourcePriority: -1, publishedAt: -1 }),
    rssDb.collection('rss_articles').createIndex({ source: 1, publishedAt: -1 }),
    rssDb.collection('rss_sources').createIndex({ url: 1 }, { unique: true, sparse: true }),
    rssDb.collection('rss_sources').createIndex({ active: 1, priority: -1 }),
    rssDb.collection('content_signals').createIndex({ signalId: 1 }, { unique: true }),
    rssDb.collection('content_signals').createIndex({ 'scores.relevance': -1, publishedAt: -1 }),
    rssDb.collection('content_signals').createIndex({ language: 1, country: 1, publishedAt: -1 }),
    rssDb.collection('content_signals').createIndex({ usedInTasks: 1 }),
    rssDb.collection('research_runs').createIndex({ taskId: 1 }, { unique: true }),
    rssDb.collection('research_runs').createIndex({ weekDate: -1 }),
  ]);
}
