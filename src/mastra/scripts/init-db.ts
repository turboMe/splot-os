#!/usr/bin/env tsx
/**
 * Script: init-db
 * Inicjalizuje kolekcje MongoDB i zakłada wszystkie potrzebne indeksy.
 * Uruchom RAZ po pierwszym deployu:
 *   npx tsx src/mastra/scripts/init-db.ts
 *
 * Bezpieczny — używa createIndex (idempotentny).
 */
import { MongoClient } from 'mongodb';
import { ensurePendingMessageClaimIndexes } from '../lib/pending-message-indexes.js';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/agentforge';
const DB_NAME = MONGODB_URI.split('/').pop()?.split('?')[0] ?? 'agentforge';

async function main() {
  console.log(`🔗 Łączenie z MongoDB: ${MONGODB_URI}`);
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const rssDb = client.db('rss_intelligence');
  console.log(`📦 Baza danych: ${DB_NAME}\n`);

  // ── leads (CRM) ───────────────────────────────────────────────────────────
  console.log('📋 leads...');
  const leads = db.collection('leads');
  await leads.createIndex({ id: 1 }, { unique: true, sparse: true });
  await leads.createIndex({ email: 1 }, { sparse: true });
  await leads.createIndex({ status: 1 });
  await leads.createIndex({ segment: 1 });
  await leads.createIndex({ region: 1 });
  await leads.createIndex({ createdAt: -1 });
  await leads.createIndex({ lastInteractionAt: -1 });
  await leads.createIndex({ status: 1, lastInteractionAt: -1 });  // for stale lead queries

  // ── approvals ─────────────────────────────────────────────────────────────
  console.log('✅ approvals...');
  const approvals = db.collection('approvals');
  await approvals.createIndex({ id: 1 }, { unique: true });
  await approvals.createIndex({ status: 1 });
  await approvals.createIndex({ agentId: 1, status: 1 });
  await approvals.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 30 * 24 * 3600 },  // TTL: 30 days
  );

  // ── coding agent artifacts / rollback ledger ─────────────────────────────
  console.log('🛠️  code_task_artifacts / code_change_snapshots / maintenance_tasks...');
  const codeTaskArtifacts = db.collection('code_task_artifacts');
  await codeTaskArtifacts.createIndex({ taskId: 1 }, { unique: true });
  await codeTaskArtifacts.createIndex({ status: 1, updatedAt: -1 });
  await codeTaskArtifacts.createIndex({ agentId: 1, updatedAt: -1 });

  const codeChangeSnapshots = db.collection('code_change_snapshots');
  await codeChangeSnapshots.createIndex({ taskId: 1, path: 1 }, { unique: true });
  await codeChangeSnapshots.createIndex({ taskId: 1, status: 1 });
  await codeChangeSnapshots.createIndex({ status: 1, updatedAt: -1 });

  const maintenanceTasks = db.collection('maintenance_tasks');
  await maintenanceTasks.createIndex({ id: 1 }, { unique: true, sparse: true });
  await maintenanceTasks.createIndex({ status: 1, updatedAt: -1 });
  await maintenanceTasks.createIndex({ source: 1, createdAt: -1 });

  // ── harness run state ─────────────────────────────────────────────────────
  console.log('🧭 agent_runs / agent_run_events...');
  const agentRuns = db.collection('agent_runs');
  await agentRuns.createIndex({ runId: 1 }, { unique: true });
  await agentRuns.createIndex({ taskId: 1, updatedAt: -1 });
  await agentRuns.createIndex({ threadId: 1, updatedAt: -1 });
  await agentRuns.createIndex({ status: 1, updatedAt: -1 });

  const agentRunEvents = db.collection('agent_run_events');
  await agentRunEvents.createIndex({ runId: 1, timestamp: 1 });
  await agentRunEvents.createIndex({ taskId: 1, timestamp: -1 });
  await agentRunEvents.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // ── shared_memory ─────────────────────────────────────────────────────────
  console.log('🧠 shared_memory...');
  const mem = db.collection('shared_memory');
  // partialFilter pomija dokumenty bez `key` (z duplikatami null); zapewnia
  // unikalnosc tylko dla rekordow z faktyczna wartoscia.
  await mem.createIndex(
    { key: 1 },
    { unique: true, partialFilterExpression: { key: { $type: 'string' } } },
  );
  await mem.createIndex({ type: 1 });
  await mem.createIndex({ sourceAgent: 1 });
  await mem.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },  // TTL driven by the expiresAt field value
  );

  // ── signals ───────────────────────────────────────────────────────────────
  console.log('📡 signals...');
  const signals = db.collection('signals');
  await signals.createIndex({ type: 1 });
  await signals.createIndex({ sourceAgent: 1 });
  await signals.createIndex({ createdAt: -1 });
  await signals.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },  // TTL
  );

  // ── harness async semantic memory ─────────────────────────────────────────
  console.log('🧠 pending_memory_context / injected_memory_context...');
  const pendingMemory = db.collection('pending_memory_context');
  await pendingMemory.createIndex({ threadId: 1, status: 1, computedAt: -1 });
  await pendingMemory.createIndex({ taskId: 1, status: 1, computedAt: -1 });
  await pendingMemory.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  const injectedMemory = db.collection('injected_memory_context');
  await injectedMemory.createIndex({ threadId: 1, memoryId: 1 }, { unique: true });
  await injectedMemory.createIndex(
    { injectedAt: 1 },
    { expireAfterSeconds: 90 * 24 * 3600 },
  );

  // ── harness file activity ledger ──────────────────────────────────────────
  console.log('📎 file_activity...');
  const fileActivity = db.collection('file_activity');
  await fileActivity.createIndex({ file: 1, createdAt: -1 });
  await fileActivity.createIndex({ taskId: 1, file: 1, createdAt: -1 });
  await fileActivity.createIndex({ agentId: 1, createdAt: -1 });
  await fileActivity.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // ── harness tool execution envelope ───────────────────────────────────────
  console.log('🧰 tool_executions...');
  const toolExecutions = db.collection('tool_executions');
  await toolExecutions.createIndex({ runId: 1, createdAt: 1 });
  await toolExecutions.createIndex({ taskId: 1, createdAt: -1 });
  await toolExecutions.createIndex({ toolId: 1, createdAt: -1 });
  await toolExecutions.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // ── harness output compaction artifacts ───────────────────────────────────
  console.log('🗜️  harness_artifacts...');
  const harnessArtifacts = db.collection('harness_artifacts');
  await harnessArtifacts.createIndex({ id: 1 }, { unique: true });
  await harnessArtifacts.createIndex({ runId: 1, createdAt: 1 });
  await harnessArtifacts.createIndex({ taskId: 1, createdAt: -1 });
  await harnessArtifacts.createIndex({ kind: 1, createdAt: -1 });
  await harnessArtifacts.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // ── background tasks (Harness Etap 6) ─────────────────────────────────────
  console.log('⏳ background_tasks...');
  const backgroundTasks = db.collection('background_tasks');
  await backgroundTasks.createIndex({ taskId: 1 }, { unique: true });
  await backgroundTasks.createIndex({ ownerTaskId: 1, startedAt: -1 });
  await backgroundTasks.createIndex({ status: 1, startedAt: -1 });
  await backgroundTasks.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // ── automation jobs (Sprint C native Golden Path jobs) ───────────────────
  console.log('🤖 automation_jobs...');
  const automationJobs = db.collection('automation_jobs');
  await automationJobs.createIndex({ jobId: 1 }, { unique: true });
  await automationJobs.createIndex({ automationId: 1, startedAt: -1 });
  await automationJobs.createIndex({ targetAgentId: 1, status: 1, startedAt: -1 });
  await automationJobs.createIndex({ returnToAgentId: 1, status: 1, startedAt: -1 });
  await automationJobs.createIndex({ status: 1, lastHeartbeatAt: -1 });
  await automationJobs.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // ── universal scheduled task orchestrator ────────────────────────────────
  console.log('🗓️  scheduled_tasks / task_chains...');
  const scheduledTasks = db.collection('scheduled_tasks');
  await scheduledTasks.createIndex({ taskId: 1 }, { unique: true });
  await scheduledTasks.createIndex({ status: 1, 'schedule.fireAt': 1 });
  await scheduledTasks.createIndex({ chainId: 1, createdAt: 1 });
  await scheduledTasks.createIndex({ 'lease.expiresAt': 1 });
  await scheduledTasks.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  const taskChains = db.collection('task_chains');
  await taskChains.createIndex({ chainId: 1, completedAt: 1 });
  await taskChains.createIndex({ taskId: 1 }, { unique: true, sparse: true });
  await taskChains.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  const scheduledDispatches = db.collection('scheduled_task_dispatches');
  await scheduledDispatches.createIndex({ idempotencyKey: 1 }, { unique: true });
  await scheduledDispatches.createIndex({ taskId: 1, status: 1 });
  await scheduledDispatches.createIndex({ status: 1, startedAt: -1 });
  await scheduledDispatches.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // ── pending user messages (Harness — soft interrupts) ───────────────────
  console.log('💬 pending_user_messages...');
  const pendingMessages = db.collection('pending_user_messages');
  await pendingMessages.createIndex({ taskId: 1, status: 1, expiresAt: -1 });
  await pendingMessages.createIndex({ threadId: 1, status: 1, expiresAt: -1 });
  await ensurePendingMessageClaimIndexes(db);
  await pendingMessages.createIndex({ urgent: -1, createdAt: 1 });
  await pendingMessages.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // ── rss_intelligence ──────────────────────────────────────────────────────
  console.log('📰 rss_intelligence.rss_articles / content_signals...');
  const rss = rssDb.collection('rss_articles');
  await rss.createIndex({ guid: 1 }, { unique: true });
  await rss.createIndex({ canonicalUrl: 1 });
  await rss.createIndex({ processed: 1, sourcePriority: -1, publishedAt: -1 });
  await rss.createIndex({ source: 1, publishedAt: -1 });

  console.log('📡 rss_intelligence.rss_sources...');
  await rssDb.collection('rss_sources').createIndex({ url: 1 }, { unique: true, sparse: true });
  await rssDb.collection('rss_sources').createIndex({ active: 1, priority: -1 });

  console.log('📋 rss_intelligence.digests...');
  await rssDb.collection('digests').createIndex({ generated_at: -1 });

  const contentSignals = rssDb.collection('content_signals');
  await contentSignals.createIndex({ signalId: 1 }, { unique: true });
  await contentSignals.createIndex({ 'scores.relevance': -1, publishedAt: -1 });
  await contentSignals.createIndex({ language: 1, country: 1, publishedAt: -1 });
  await contentSignals.createIndex({ usedInTasks: 1 });
  await contentSignals.createIndex({ source: 1, publishedAt: -1 });

  const researchRuns = rssDb.collection('research_runs');
  await researchRuns.createIndex({ taskId: 1 }, { unique: true });
  await researchRuns.createIndex({ weekDate: -1 });

  // ── reports ───────────────────────────────────────────────────────────────
  console.log('📊 reports...');
  const reports = db.collection('reports');
  await reports.createIndex({ id: 1 }, { unique: true, sparse: true });
  await reports.createIndex({ type: 1, generatedAt: -1 });

  // ── inbox_drafts ──────────────────────────────────────────────────────────
  console.log('📬 inbox_drafts...');
  const drafts = db.collection('inbox_drafts');
  await drafts.createIndex({ messageId: 1 }, { unique: true, sparse: true });
  await drafts.createIndex({ status: 1 });
  await drafts.createIndex({ createdAt: -1 });
  await drafts.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 7 * 24 * 3600 },  // 7 day TTL
  );

  // ── calendar_events ───────────────────────────────────────────────────────
  console.log('📅 calendar_events...');
  const cal = db.collection('calendar_events');
  await cal.createIndex({ leadId: 1 });
  await cal.createIndex({ attendeeEmail: 1 });
  await cal.createIndex({ startTime: 1 });
  await cal.createIndex({ status: 1 });

  // ── onboarding_checklists ─────────────────────────────────────────────────
  console.log('📋 onboarding_checklists...');
  await db.collection('onboarding_checklists').createIndex({ id: 1 }, { unique: true });

  // ── sync_meta ─────────────────────────────────────────────────────────────
  console.log('🔄 sync_meta...');
  await db.collection('sync_meta').createIndex({ key: 1 }, { unique: true });

  // ── gmail_messages ────────────────────────────────────────────────────────
  console.log('📧 gmail_messages...');
  const gmail = db.collection('gmail_messages');
  await gmail.createIndex({ messageId: 1 }, { unique: true, sparse: true });
  await gmail.createIndex({ direction: 1, sentAt: -1 });
  await gmail.createIndex({ direction: 1, receivedAt: -1 });
  await gmail.createIndex({ from: 1 });
  await gmail.createIndex({ to: 1 });

  // ── token_usage ───────────────────────────────────────────────────────────
  console.log('💰 token_usage...');
  const tokens = db.collection('token_usage');
  await tokens.createIndex({ timestamp: -1 });
  await tokens.createIndex({ agentId: 1, timestamp: -1 });
  await tokens.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 90 * 24 * 3600 },  // 90 day retention
  );

  // ── workflow_runs ─────────────────────────────────────────────────────────
  console.log('⚙️  workflow_runs...');
  const wfRuns = db.collection('workflow_runs');
  await wfRuns.createIndex({ workflowId: 1, startedAt: -1 });
  await wfRuns.createIndex({ status: 1 });
  await wfRuns.createIndex({ startedAt: -1 });
  await wfRuns.createIndex(
    { startedAt: 1 },
    { expireAfterSeconds: 90 * 24 * 3600 },
  );

  // ── automation_requests / events / snapshots ──────────────────────────────
  // Owned by automation-architect: rejestracja, audit trail i wersjonowanie
  // workflowow Mastry. Klucz dostepu: automationId.
  console.log('🤖 automation_requests / automation_events / automation_workflow_snapshots...');
  const automationRequests = db.collection('automation_requests');
  await automationRequests.createIndex({ automationId: 1 }, { unique: true });
  await automationRequests.createIndex({ status: 1 });
  await automationRequests.createIndex({ n8nWorkflowId: 1 }, { sparse: true });
  await automationRequests.createIndex({ managedBy: 1, status: 1 });
  await automationRequests.createIndex({ updatedAt: -1 });

  const automationEvents = db.collection('automation_events');
  await automationEvents.createIndex({ automationId: 1, createdAt: -1 });
  await automationEvents.createIndex({ type: 1, createdAt: -1 });
  await automationEvents.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 180 * 24 * 3600 }, // 180 day audit retention
  );

  const automationSnapshots = db.collection('automation_workflow_snapshots');
  await automationSnapshots.createIndex({ automationId: 1, version: -1 });
  await automationSnapshots.createIndex({ n8nWorkflowId: 1 }, { sparse: true });
  await automationSnapshots.createIndex({ createdAt: -1 });

  // ── automation_patterns (semantic RAG) ────────────────────────────────────
  console.log('📚 automation_patterns...');
  const automationPatterns = db.collection('automation_patterns');
  await automationPatterns.createIndex({ id: 1 }, { unique: true });
  await automationPatterns.createIndex({ executable: 1, maturity: 1 });
  await automationPatterns.createIndex({ updatedAt: -1 });

  // ── chef collections ──────────────────────────────────────────────────────
  console.log('👨‍🍳 chef_projects / chef_menus / chef_recipes / chef_notes...');
  await db.collection('chef_projects').createIndex({ id: 1 }, { unique: true });
  await db.collection('chef_projects').createIndex({ chefId: 1, status: 1 });
  await db.collection('chef_menus').createIndex({ id: 1 }, { unique: true });
  await db.collection('chef_menus').createIndex({ projectId: 1 });
  await db.collection('chef_recipes').createIndex({ id: 1 }, { unique: true });
  await db.collection('chef_recipes').createIndex({ projectId: 1 });
  await db.collection('chef_notes').createIndex({ id: 1 }, { unique: true });
  await db.collection('chef_notes').createIndex({ projectId: 1, category: 1 });
  await db.collection('chef_notes').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  console.log('\n✅ Wszystkie indeksy założone pomyślnie.');
  await client.close();
}

main().catch((err) => {
  console.error('❌ Błąd inicjalizacji bazy:', err);
  process.exit(1);
});
