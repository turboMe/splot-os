/**
 * Shared event helper for the Mastra Harness Layer.
 *
 * This keeps harness telemetry additive: logging failures are swallowed by
 * logAgentEvent(), so agent execution does not depend on Mongo telemetry.
 */

import type { AgentEventType } from '../lib/agent-event-log.js';
import { logAgentEvent } from '../lib/agent-event-log.js';

export const HARNESS_EVENT_TYPES = [
  'precontext_injected',
  'semantic_memory_check_started',
  'semantic_memory_pending_prepared',
  'semantic_memory_injected',
  'semantic_memory_suppressed',
  'file_touch',
  'file_conflict_warning',
  'code_outline_used',
  'bg_task_started',
  'bg_task_progress',
  'bg_task_completed',
  'soft_interrupt_queued',
  'soft_interrupt_consumed',
  'run_started',
  'run_phase_changed',
  'run_completed',
  'run_failed',
  'llm_call_started',
  'llm_call_completed',
  'llm_call_failed',
  'tool_call_started',
  'tool_call_completed',
  'tool_call_failed',
  'tool_output_compacted',
  'policy_allowed',
  'policy_blocked',
  'policy_flagged',
  'cache_usage_observed',
  'cache_miss_reason',
  'reflector_triggered',
  'reflector_snapshot',
  'reflector_intervention',
  'reflector_stop_when',
  'reflector_convergence_stop',
  'output_score',
  'pipeline_phase_transition',
  'pipeline_reflector_intervention',
  'pipeline_phase_tools_applied',
  'reflection_repair_started',
  'reflection_repair_completed',
  'reflection_repair_failed',
  'goal_contract_created',
  'goal_evidence_recorded',
  'goal_plan_revised',
  'goal_contract_completed',
  'goal_completion_evaluated',
  'goal_completion_gate_started',
  'goal_completion_gate_completed',
  'goal_completion_gate_failed',
  'auto_deliberation_started',
  'auto_deliberation_completed',
  'auto_deliberation_failed',
  'auto_review_started',
  'auto_review_completed',
  'auto_review_failed',
  'approval_gate_started',
  'approval_gate_completed',
  'approval_gate_failed',
  'depth_upgrade_second_pass_started',
  'depth_upgrade_second_pass_completed',
  'depth_upgrade_second_pass_failed',
  'depth_classified',
  'depth_upgraded',
  'worker_run_started',
  'worker_run_completed',
  'worker_run_failed',
  'worker_alert',
  'capability_gap',
] as const satisfies readonly AgentEventType[];

export type HarnessEventType = typeof HARNESS_EVENT_TYPES[number];

export type HarnessEventStatus = 'success' | 'error' | 'pending';

export interface HarnessEventInput {
  type: HarnessEventType;
  agentId: string;
  runId?: string;
  turnId?: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  feature?: string;
  model?: string;
  toolId?: string;
  status?: HarnessEventStatus;
  input?: string;
  output?: string;
  errorMessage?: string;
  durationMs?: number;
  tokenUsage?: { prompt: number; completion: number };
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function tokenEstimate(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export async function logHarnessEvent(event: HarnessEventInput): Promise<void> {
  await logAgentEvent({
    type: event.type,
    agentId: event.agentId,
    runId: event.runId,
    turnId: event.turnId,
    threadId: event.threadId,
    taskId: event.taskId,
    subtaskId: event.subtaskId,
    feature: event.feature,
    model: event.model,
    toolId: event.toolId,
    input: event.input,
    output: event.output,
    status: event.status ?? 'pending',
    errorMessage: event.errorMessage,
    durationMs: event.durationMs,
    tokenUsage: event.tokenUsage,
    data: event.data,
    metadata: event.metadata,
  });
}
