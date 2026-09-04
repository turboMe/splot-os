/**
 * Mongo Indexes — ensures TTL and performance indexes exist.
 * Called once at Mastra startup.
 *
 * Phase 0 — Bug #2.9: TTL indexes for auto-expiration.
 */
import { getDb } from './mongo.js';
import { ensurePendingMessageClaimIndexes } from './pending-message-indexes.js';

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  // ── TTL Indexes (auto-delete expired documents) ────────────────────────
  await db.collection('signals').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('shared_memory').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('auto_healing_tickets').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );

  // ── Agent Event Log indexes (Phase 1.2) ────────────────────────────────
  await db.collection('agent_events').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('agent_events').createIndex({ type: 1, timestamp: -1 });
  await db.collection('agent_events').createIndex({ agentId: 1, timestamp: -1 });
  await db.collection('agent_events').createIndex({ taskId: 1 });

  // ── Harness run state indexes ───────────────────────────────────────────
  await db.collection('agent_runs').createIndex({ runId: 1 }, { unique: true });
  await db.collection('agent_runs').createIndex({ taskId: 1, updatedAt: -1 });
  await db.collection('agent_runs').createIndex({ threadId: 1, updatedAt: -1 });
  await db.collection('agent_runs').createIndex({ status: 1, updatedAt: -1 });
  await db.collection('agent_run_events').createIndex({ runId: 1, timestamp: 1 });
  await db.collection('agent_run_events').createIndex({ taskId: 1, timestamp: -1 });
  await db.collection('agent_run_events').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );

  // ── System Knowledge indexes (Phase 1.3) ───────────────────────────────
  await db.collection('system_knowledge').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('system_knowledge').createIndex({ type: 1, createdAt: -1 });
  await db.collection('system_knowledge').createIndex({ knowledgeId: 1 }, { unique: true });

  // ── Async semantic memory indexes (Harness Etap 2) ─────────────────────
  await db.collection('pending_memory_context').createIndex({ threadId: 1, status: 1, computedAt: -1 });
  await db.collection('pending_memory_context').createIndex({ taskId: 1, status: 1, computedAt: -1 });
  await db.collection('pending_memory_context').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('injected_memory_context').createIndex(
    { threadId: 1, memoryId: 1 }, { unique: true },
  );
  await db.collection('injected_memory_context').createIndex(
    { injectedAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 },
  );

  // ── Pending message queue indexes (Harness soft interrupts) ────────────
  await db.collection('pending_user_messages').createIndex({ taskId: 1, status: 1, createdAt: 1 });
  await db.collection('pending_user_messages').createIndex({ threadId: 1, status: 1, createdAt: 1 });
  await ensurePendingMessageClaimIndexes(db);
  await db.collection('pending_user_messages').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );

  // ── File activity ledger indexes (Harness Etap 3) ──────────────────────
  await db.collection('file_activity').createIndex({ file: 1, createdAt: -1 });
  await db.collection('file_activity').createIndex({ taskId: 1, file: 1, createdAt: -1 });
  await db.collection('file_activity').createIndex({ agentId: 1, createdAt: -1 });
  await db.collection('file_activity').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );

  // ── Tool execution envelope indexes (Harness Etap 3) ───────────────────
  await db.collection('tool_executions').createIndex({ runId: 1, createdAt: 1 });
  await db.collection('tool_executions').createIndex({ taskId: 1, createdAt: -1 });
  await db.collection('tool_executions').createIndex({ toolId: 1, createdAt: -1 });
  await db.collection('tool_executions').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );

  // ── Harness artifact indexes (Harness output compaction) ────────────────
  await db.collection('harness_artifacts').createIndex({ id: 1 }, { unique: true });
  await db.collection('harness_artifacts').createIndex({ runId: 1, createdAt: 1 });
  await db.collection('harness_artifacts').createIndex({ taskId: 1, createdAt: -1 });
  await db.collection('harness_artifacts').createIndex({ kind: 1, createdAt: -1 });
  await db.collection('harness_artifacts').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );

  // ── Background tasks indexes (Harness Etap 6) ─────────────────────────────
  await db.collection('background_tasks').createIndex({ taskId: 1 }, { unique: true });
  await db.collection('background_tasks').createIndex({ ownerTaskId: 1, startedAt: -1 });
  await db.collection('background_tasks').createIndex({ status: 1, startedAt: -1 });
  await db.collection('background_tasks').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  // ── Native automation jobs (Sprint C) ─────────────────────────────────────
  await db.collection('automation_jobs').createIndex({ jobId: 1 }, { unique: true });
  await db.collection('automation_jobs').createIndex({ automationId: 1, startedAt: -1 });
  await db.collection('automation_jobs').createIndex({ targetAgentId: 1, status: 1, startedAt: -1 });
  await db.collection('automation_jobs').createIndex({ returnToAgentId: 1, status: 1, startedAt: -1 });
  await db.collection('automation_jobs').createIndex({ status: 1, lastHeartbeatAt: -1 });
  await db.collection('automation_jobs').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  // ── Universal scheduled task orchestrator ───────────────────────────────
  await db.collection('scheduled_tasks').createIndex({ taskId: 1 }, { unique: true });
  await db.collection('scheduled_tasks').createIndex({ status: 1, 'schedule.fireAt': 1 });
  await db.collection('scheduled_tasks').createIndex({ chainId: 1, createdAt: 1 });
  await db.collection('scheduled_tasks').createIndex({ 'lease.expiresAt': 1 });
  // GAP-CUTOVER-01: one occurrence may have at most ONE successor of each kind.
  // This is the only thing standing between a lease that expired mid-dispatch
  // and a recurring schedule that fires twice from then on, forever. PARTIAL so
  // the vast majority of tasks — which succeed nothing — do not all collide on a
  // missing key.
  await db.collection('scheduled_tasks').createIndex(
    { succeedsTaskId: 1, succession: 1 },
    { unique: true, partialFilterExpression: { succeedsTaskId: { $exists: true } } },
  );
  await db.collection('scheduled_tasks').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('task_chains').createIndex({ chainId: 1, completedAt: 1 });
  await db.collection('task_chains').createIndex({ taskId: 1 }, { unique: true, sparse: true });
  await db.collection('task_chains').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  await db.collection('scheduled_task_dispatches').createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection('scheduled_task_dispatches').createIndex({ taskId: 1, status: 1 });
  await db.collection('scheduled_task_dispatches').createIndex({ status: 1, startedAt: -1 });
  await db.collection('scheduled_task_dispatches').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 },
  );
  // ── Async delegation indexes (Harness async delegation layer) ───────────
  await db.collection('async_delegations').createIndex({ delegationId: 1 }, { unique: true });
  await db.collection('async_delegations').createIndex({ callerThreadId: 1, status: 1, startedAt: -1 });
  await db.collection('async_delegations').createIndex({ status: 1, startedAt: -1 });

  // ── Autoheal cycle store (Autoheal Etap 1) ──────────────────────────────
  // Grupowanie problemów po sygnaturze zamiast ticket-per-timestamp.
  await db.collection('autoheal_cycles').createIndex({ cycleId: 1 }, { unique: true });
  await db.collection('autoheal_cycles').createIndex({ signature: 1, status: 1 });
  await db.collection('autoheal_cycles').createIndex({ status: 1, updatedAt: -1 });
  await db.collection('autoheal_attempts').createIndex({ attemptId: 1 }, { unique: true });
  await db.collection('autoheal_attempts').createIndex({ cycleId: 1, createdAt: 1 });
  await db.collection('autoheal_runtime_events').createIndex({ cycleId: 1, createdAt: 1 });
  await db.collection('autoheal_runtime_events').createIndex({ signature: 1, createdAt: -1 });

  console.log('[MongoIndexes] TTL indexes ensured for: signals, shared_memory, auto_healing_tickets, agent_events, agent_run_events, system_knowledge, pending_memory_context, injected_memory_context, pending_user_messages, file_activity, tool_executions, harness_artifacts, background_tasks, automation_jobs, scheduled_tasks, task_chains, scheduled_task_dispatches, async_delegations, autoheal_cycles, autoheal_attempts, autoheal_runtime_events');
}
