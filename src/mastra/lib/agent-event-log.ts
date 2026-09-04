/**
 * Agent Event Log (Phase 1.2)
 *
 * Centralized, structured log of ALL significant agent events.
 * Used as input for Memory Extractor (Phase 1.3) and Failure Brain (Phase 2).
 *
 * Events have a 30-day TTL by default. Memory Extractor compresses
 * recurring patterns into permanent system_knowledge.
 */
import { randomUUID } from 'crypto';
import { canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { getDb } from './mongo.js';
import { redactSecrets } from './secrets-redactor.js';

// ── Event Types ──────────────────────────────────────────────────────────────

export type AgentEventType =
  | 'task_started' | 'task_completed' | 'task_failed'
  | 'tool_called' | 'tool_error'
  | 'delegation' | 'escalation'
  | 'retry_success' | 'retry_failed'
  | 'autoheal_triggered' | 'autoheal_resolved'
  | 'lesson_learned' | 'skill_used'
  | 'approval_requested' | 'approval_granted' | 'approval_denied'
  | 'precontext_injected'
  | 'semantic_memory_check_started'
  | 'semantic_memory_pending_prepared'
  | 'semantic_memory_injected'
  | 'semantic_memory_suppressed'
  | 'file_touch'
  | 'file_conflict_warning'
  | 'code_outline_used'
  | 'bg_task_started'
  | 'bg_task_progress'
  | 'bg_task_completed'
  | 'soft_interrupt_queued'
  | 'soft_interrupt_consumed'
  | 'run_started'
  | 'run_phase_changed'
  | 'run_completed'
  | 'run_failed'
  | 'llm_call_started'
  | 'llm_call_completed'
  | 'llm_call_failed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'tool_call_failed'
  | 'tool_output_compacted'
  | 'policy_allowed'
  | 'policy_blocked'
  /**
   * The policy WOULD have blocked, but `HARNESS_POLICY_MODE` is `log_only`, so
   * the call ran anyway. Distinct from `policy_blocked` because nothing was
   * blocked: emitting the latter made an advisory verdict read as an enforced
   * guardrail in both the logs and the dashboard's "Policy blocks" count.
   */
  | 'policy_flagged'
  | 'cache_usage_observed'
  | 'cache_miss_reason'
  | 'reflector_triggered'
  | 'reflector_snapshot'
  | 'reflector_intervention'
  | 'reflector_stop_when'
  | 'reflector_convergence_stop'
  | 'output_score'
  | 'pipeline_phase_transition'
  | 'pipeline_reflector_intervention'
  | 'pipeline_phase_tools_applied'
  | 'reflection_repair_started'
  | 'reflection_repair_completed'
  | 'reflection_repair_failed'
  | 'goal_contract_created'
  | 'goal_evidence_recorded'
  | 'goal_plan_revised'
  | 'goal_contract_completed'
  | 'goal_completion_evaluated'
  | 'goal_completion_gate_started'
  | 'goal_completion_gate_completed'
  | 'goal_completion_gate_failed'
  | 'auto_deliberation_started'
  | 'auto_deliberation_completed'
  | 'auto_deliberation_failed'
  | 'auto_review_started'
  | 'auto_review_completed'
  | 'auto_review_failed'
  | 'approval_gate_started'
  | 'approval_gate_completed'
  | 'approval_gate_failed'
  | 'depth_upgrade_second_pass_started'
  | 'depth_upgrade_second_pass_completed'
  | 'depth_upgrade_second_pass_failed'
  | 'depth_classified'
  | 'depth_upgraded'
  | 'worker_run_started'
  | 'worker_run_completed'
  | 'worker_run_failed'
  | 'worker_alert'
  | 'plan_task_started'
  | 'plan_task_completed'
  | 'plan_task_failed'
  | 'capability_gap';

// ── Event Schema ─────────────────────────────────────────────────────────────

export interface AgentEvent {
  eventId: string;
  type: AgentEventType;
  timestamp: Date;
  agentId: string;
  runId?: string;
  turnId?: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  feature?: string;
  model?: string;
  toolId?: string;
  input?: string;           // truncated (max 500 chars)
  output?: string;          // truncated (max 500 chars)
  status: 'success' | 'error' | 'pending';
  errorMessage?: string;
  durationMs?: number;
  tokenUsage?: { prompt: number; completion: number };
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  expiresAt: Date;
}

// ── Helper ───────────────────────────────────────────────────────────────────

function truncate(text: string | undefined, maxLen = 500): string | undefined {
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

/** Truncate AND redact secrets from text fields. */
function sanitize(text: string | undefined, maxLen = 500): string | undefined {
  const truncated = truncate(text, maxLen);
  if (!truncated) return undefined;
  return redactSecrets(truncated).text;
}

const DEFAULT_TTL_DAYS = 30;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Log a single agent event.
 * Fire-and-forget safe — errors are caught and logged, never thrown.
 */
export async function logAgentEvent(
  event: Omit<AgentEvent, 'eventId' | 'timestamp' | 'expiresAt'>,
): Promise<void> {
  try {
    const db = await getDb();
    await db.collection('agent_events').insertOne({
      ...event,
      agentId: canonicalizeRuntimeAgentId(event.agentId) ?? event.agentId,
      input: sanitize(event.input),
      output: sanitize(event.output),
      errorMessage: event.errorMessage ? redactSecrets(event.errorMessage).text : undefined,
      eventId: randomUUID(),
      timestamp: new Date(),
      expiresAt: new Date(Date.now() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
    });
  } catch (err) {
    console.warn('[AgentEventLog] Failed to log event:', (err as Error).message);
  }
}

/**
 * Query recent events by type and/or agentId.
 */
export async function queryAgentEvents(
  filter: {
    type?: AgentEventType;
    agentId?: string;
    runId?: string;
    threadId?: string;
    taskId?: string;
    since?: Date;
    limit?: number;
  } = {},
): Promise<AgentEvent[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};

  if (filter.type) query.type = filter.type;
  if (filter.agentId) query.agentId = filter.agentId;
  if (filter.runId) query.runId = filter.runId;
  if (filter.threadId) query.threadId = filter.threadId;
  if (filter.taskId) query.taskId = filter.taskId;
  if (filter.since) query.timestamp = { $gte: filter.since };

  return db
    .collection<AgentEvent>('agent_events')
    .find(query)
    .sort({ timestamp: -1 })
    .limit(filter.limit ?? 50)
    .toArray() as unknown as AgentEvent[];
}
