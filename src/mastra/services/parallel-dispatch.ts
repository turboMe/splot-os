/**
 * Parallel Dispatch Engine (Etap 8.3)
 *
 * Heart of the orchestration layer. Executes subtask groups sequentially,
 * with subtasks WITHIN each group running in parallel via Promise.allSettled.
 *
 * Flow:
 *   Group 0 → Promise.allSettled([A, B]) → retry/escalate → collect results
 *   Group 1 → Promise.allSettled([C]) → retry/escalate → collect results  (C depends on A,B)
 *   ...
 *   Aggregate → conflict detection → summary
 */

import type { Mastra } from '@mastra/core/mastra';
import type { RoutingResult } from './smart-router.js';
import { getGpuGuard } from './gpu-guard.js';
import { verifyPlanModels } from './model-availability.js';
import { modelRegistry } from '../config/model-capabilities.js';
import {
  type SubtaskResult,
  type SubtaskContext,
  executeSubtask,
  retryFailedSubtasks,
} from './subtask-executor.js';
import { ackPendingMessages, formatPendingMessagesForPrompt, takePendingMessages } from './pending-message-queue.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DispatchResult {
  taskId: string;
  groups: GroupResult[];
  aggregated: AggregatedResult;
  overallStatus: 'all_success' | 'partial_failure' | 'critical_failure';
}

export interface GroupResult {
  groupIndex: number;
  subtaskResults: SubtaskResult[];
  groupStatus: 'success' | 'partial' | 'failed';
  durationMs: number;
}

export interface AggregatedResult {
  totalSubtasks: number;
  succeeded: number;
  failed: number;
  skipped: number;
  needsHuman: number;
  allFilesChanged: Array<{ path: string; subtaskId: string; summary: string }>;
  allErrors: Array<{ subtaskId: string; error: string }>;
  conflictingFiles: string[];
  totalDurationMs: number;
  estimatedCost: number;
}

export const DEFAULT_DISPATCH_CONCURRENCY = 3;

/** One wave cap for every subtask, regardless of local/cloud model placement. */
export function resolveDispatchConcurrency(
  raw: string | undefined = process.env.J2_DISPATCH_CONCURRENCY,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DISPATCH_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_DISPATCH_CONCURRENCY;
}

/**
 * Map every item with bounded concurrency while preserving `allSettled`.
 *
 * Results stay aligned with input indexes because dispatch uses the same index
 * to recover subtask/model identity after a rejection. Each worker catches its
 * own item, so one failed subtask never aborts the wave or hides later results.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => R | Promise<R>,
): Promise<Array<PromiseSettledResult<Awaited<R>>>> {
  if (items.length === 0) return [];
  const safeLimit = Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit))
    : DEFAULT_DISPATCH_CONCURRENCY;
  const results = new Array<PromiseSettledResult<Awaited<R>>>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        const value = await fn(items[index]!, index);
        results[index] = { status: 'fulfilled', value: value as Awaited<R> };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(safeLimit, items.length) }, () => worker()),
  );
  return results;
}

// ── Pre-flight ───────────────────────────────────────────────────────────────

/**
 * Quick model verification for models used in the routing plan.
 * Runs before dispatch to catch issues early.
 */
async function quickModelCheck(routingResult: RoutingResult): Promise<void> {
  const modelIds = new Set<string>();
  for (const group of routingResult.groups) {
    for (const assignment of group.subtasks) {
      if (assignment.subtask.assignedModel) {
        modelIds.add(assignment.subtask.assignedModel);
      }
    }
  }

  if (modelIds.size === 0) return;

  const results = await verifyPlanModels([...modelIds]);
  const unavailable = results.filter((r) => !r.available);

  if (unavailable.length > 0) {
    console.warn(
      `[Dispatch] ⚠️ ${unavailable.length} model(s) unavailable: ` +
      unavailable.map((r) => `${r.name} (${r.reason})`).join(', '),
    );
  }
}

/**
 * Pre-flight VRAM check before executing a group.
 * Ensures there's enough GPU memory for local models in the group.
 */
function preFlightVramCheck(group: RoutingResult['groups'][0]): void {
  if (group.totalVramMb === 0) return; // All cloud — skip

  try {
    const guard = getGpuGuard();
    const check = guard.canLoadModel(group.totalVramMb);

    if (!check.allowed) {
      console.warn(
        `[Dispatch] VRAM pre-flight failed for group ${group.groupIndex}: ${check.reason}. ` +
        `Local subtasks may fall back to cloud.`,
      );
    }
  } catch {
    // GpuGuard unavailable — proceed with caution
  }
}

// ── Main Dispatch ────────────────────────────────────────────────────────────

/**
 * Execute all subtask groups: sequential across groups, parallel within groups.
 * Includes retry/escalation loop and result aggregation.
 */
export async function dispatchSubtasks(
  taskId: string,
  routingResult: RoutingResult,
  mastra: Mastra,
): Promise<DispatchResult> {
  console.log(
    `[Dispatch] Starting parallel dispatch: ${routingResult.summary.totalSubtasks} subtasks in ${routingResult.summary.totalGroups} groups`,
  );

  // Pre-flight: verify model availability
  await quickModelCheck(routingResult);

  const groupResults: GroupResult[] = [];
  const previousResults: SubtaskResult[] = [];
  const dispatchConcurrency = resolveDispatchConcurrency();
  console.log(`[Dispatch] Wave concurrency cap: ${dispatchConcurrency}`);

  // ── Sequential across groups ──
  for (const [groupIndex, group] of routingResult.groups.entries()) {
    const groupStart = Date.now();

    console.log(
      `[Dispatch] Group ${group.groupIndex}: ${group.subtasks.length} subtask(s), ` +
      `${group.totalVramMb}MB VRAM, est. ${(group.estimatedLatencyMs / 1000).toFixed(1)}s`,
    );

    const pendingMessages = await takePendingMessages({
      taskId,
      agentId: 'codingAgent',
      limit: 5,
    });
    // SEC-001 — every claimed record is acknowledged here, not only the urgent
    // ones consumed below: this path claims the whole batch, so leaving the
    // non-urgent remainder unacknowledged would have it redelivered pointlessly.
    void ackPendingMessages({ messages: pendingMessages, agentId: 'codingAgent' });
    const urgentInterrupt = pendingMessages.some((message) => message.urgent);
    if (urgentInterrupt) {
      const interruptSummary = formatPendingMessagesForPrompt(pendingMessages);
      console.warn(
        `[Dispatch] Urgent interrupt consumed before group ${group.groupIndex}; stopping remaining groups for replan.`,
      );
      for (const remainingGroup of routingResult.groups.slice(groupIndex)) {
        groupResults.push(buildInterruptedGroupResult(remainingGroup, interruptSummary));
      }
      break;
    }

    // Pre-flight VRAM check
    preFlightVramCheck(group);

    // Build context with results from previous groups
    const context: SubtaskContext = {
      taskId,
      previousResults: [...previousResults],
      pendingMessages,
    };

    // ── Parallel within group, bounded across local and cloud subtasks ──
    const settled = await runWithConcurrency(
      group.subtasks,
      dispatchConcurrency,
      ({ subtask }) => executeSubtask(subtask, taskId, context, mastra),
    );

    // Normalize settled results
    const rawResults: SubtaskResult[] = settled.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        subtaskId: group.subtasks[i].subtask.id,
        status: 'failed' as const,
        assignedModel: group.subtasks[i].model.modelId,
        filesChanged: [],
        commandsRun: [],
        diagnostics: '',
        errors: [result.reason?.message || 'Unknown Promise rejection'],
        durationMs: 0,
      };
    });

    // ── 8.3a: Intelligent Retry & Escalation ──
    const retriedResults = await retryFailedSubtasks(
      rawResults, group, taskId, context, mastra,
    );

    const groupResult: GroupResult = {
      groupIndex: group.groupIndex,
      subtaskResults: retriedResults,
      groupStatus: deriveGroupStatus(retriedResults),
      durationMs: Date.now() - groupStart,
    };

    groupResults.push(groupResult);
    previousResults.push(...retriedResults);

    console.log(
      `[Dispatch] Group ${group.groupIndex} done: ${groupResult.groupStatus} (${groupResult.durationMs}ms)`,
    );

    // ── Circuit breaker: abort if critical subtask failed ──
    if (groupResult.groupStatus === 'failed') {
      const hasCritical = retriedResults.some(
        (r) => r.status === 'failed' && isCriticalSubtask(r.subtaskId, routingResult),
      );
      if (hasCritical) {
        console.error(
          `[Dispatch] 🚨 Critical subtask failed in group ${group.groupIndex} — aborting remaining groups`,
        );
        break;
      }
    }

    // ── VRAM cooldown: give Ollama time to unload group models ──
    if (group.totalVramMb > 0) {
      await sleep(2000);
    }
  }

  // ── Aggregate Results ──
  const aggregated = aggregateResults(groupResults);

  const overallStatus = deriveOverallStatus(aggregated);

  console.log(
    `[Dispatch] ✅ Complete: ${aggregated.succeeded}/${aggregated.totalSubtasks} succeeded, ` +
    `${aggregated.failed} failed, ${aggregated.needsHuman} needs_human, ` +
    `${aggregated.conflictingFiles.length} conflicts`,
  );

  return { taskId, groups: groupResults, aggregated, overallStatus };
}

// ── Result Aggregation ───────────────────────────────────────────────────────

export function aggregateResults(groups: GroupResult[]): AggregatedResult {
  const allResults = groups.flatMap((g) => g.subtaskResults);

  // Collect all changed files
  const allFilesChanged = allResults.flatMap((r) =>
    r.filesChanged.map((f) => ({
      path: f.path,
      subtaskId: r.subtaskId,
      summary: f.summary,
    })),
  );

  // Detect conflicts: same file edited by >1 subtask
  const fileCounts = new Map<string, string[]>();
  for (const f of allFilesChanged) {
    const editors = fileCounts.get(f.path) ?? [];
    editors.push(f.subtaskId);
    fileCounts.set(f.path, editors);
  }
  const conflictingFiles = [...fileCounts.entries()]
    .filter(([_, editors]) => editors.length > 1)
    .map(([path]) => path);

  // Collect errors
  const allErrors = allResults
    .filter((r) => r.errors.length > 0)
    .flatMap((r) => r.errors.map((e) => ({ subtaskId: r.subtaskId, error: e })));

  // Estimate cost
  const estimatedCost = allResults.reduce((sum, r) => {
    const model = modelRegistry.find((m) => m.modelId === (r.actualModel ?? r.assignedModel));
    return sum + (model?.costPerCall ?? 0);
  }, 0);

  return {
    totalSubtasks: allResults.length,
    succeeded: allResults.filter((r) => r.status === 'success').length,
    failed: allResults.filter((r) => r.status === 'failed').length,
    skipped: allResults.filter((r) => r.status === 'skipped').length,
    needsHuman: allResults.filter((r) => r.status === 'needs_human').length,
    allFilesChanged,
    allErrors,
    conflictingFiles,
    totalDurationMs: groups.reduce((sum, g) => sum + g.durationMs, 0),
    estimatedCost,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function deriveGroupStatus(results: SubtaskResult[]): 'success' | 'partial' | 'failed' {
  const allFailed = results.every((r) => r.status === 'failed' || r.status === 'needs_human');
  const allSuccess = results.every((r) => r.status === 'success' || r.status === 'skipped');

  if (allSuccess) return 'success';
  if (allFailed) return 'failed';
  return 'partial';
}

function buildInterruptedGroupResult(
  group: RoutingResult['groups'][0],
  interruptSummary: string,
): GroupResult {
  const subtaskResults: SubtaskResult[] = group.subtasks.map(({ subtask, model }) => ({
    subtaskId: subtask.id,
    status: 'needs_human',
    assignedModel: subtask.assignedModel ?? model.modelId,
    filesChanged: [],
    commandsRun: [],
    diagnostics: interruptSummary,
    errors: ['Urgent soft interrupt consumed before this group; remaining plan needs re-evaluation.'],
    durationMs: 0,
    qualityCheck: {
      passed: false,
      reason: 'Urgent soft interrupt consumed before group execution',
      attempt: 0,
      escalationHistory: [],
    },
  }));

  return {
    groupIndex: group.groupIndex,
    subtaskResults,
    groupStatus: 'failed',
    durationMs: 0,
  };
}

function deriveOverallStatus(
  agg: AggregatedResult,
): 'all_success' | 'partial_failure' | 'critical_failure' {
  if (agg.failed === 0 && agg.needsHuman === 0) return 'all_success';
  if (agg.succeeded > 0) return 'partial_failure';
  return 'critical_failure';
}

/**
 * A subtask is critical if it's in parallelGroup 0 with priority 1
 * (foundation task that others depend on).
 */
function isCriticalSubtask(subtaskId: string, routing: RoutingResult): boolean {
  const firstGroup = routing.groups[0];
  if (!firstGroup) return false;

  const match = firstGroup.subtasks.find((s) => s.subtask.id === subtaskId);
  if (!match) return false;

  return (match.subtask as any).priority === 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format dispatch result for logging/diagnostics.
 */
export function formatDispatchResult(result: DispatchResult): string {
  const lines: string[] = [
    `\n═══ Dispatch Result — ${result.overallStatus} ═══`,
    `  Total: ${result.aggregated.totalSubtasks} | ✅ ${result.aggregated.succeeded} | ❌ ${result.aggregated.failed} | 🙋 ${result.aggregated.needsHuman} | ⏭️ ${result.aggregated.skipped}`,
    `  Duration: ${(result.aggregated.totalDurationMs / 1000).toFixed(1)}s | Est. cost: $${(result.aggregated.estimatedCost * 0.01).toFixed(2)}`,
    '',
  ];

  for (const group of result.groups) {
    lines.push(`── Group ${group.groupIndex} (${group.groupStatus}, ${group.durationMs}ms) ──`);
    for (const sr of group.subtaskResults) {
      const icon = sr.status === 'success' ? '✅' : sr.status === 'needs_human' ? '🙋' : '❌';
      const modelNote = sr.actualModel ? ` (escalated → ${sr.actualModel})` : '';
      const attempt = sr.qualityCheck?.attempt ? ` [attempt ${sr.qualityCheck.attempt}]` : '';
      lines.push(`   ${icon} [${sr.subtaskId}] ${sr.assignedModel}${modelNote}${attempt}`);
      if (sr.filesChanged.length > 0) {
        lines.push(`      Files: ${sr.filesChanged.map((f) => f.path).join(', ')}`);
      }
      if (sr.errors.length > 0) {
        lines.push(`      Errors: ${sr.errors[0].substring(0, 100)}`);
      }
    }
    lines.push('');
  }

  if (result.aggregated.conflictingFiles.length > 0) {
    lines.push(`⚠️ Conflicting files: ${result.aggregated.conflictingFiles.join(', ')}`);
  }

  return lines.join('\n');
}
