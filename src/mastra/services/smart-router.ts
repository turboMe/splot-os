/**
 * Smart Model Router
 *
 * Assigns optimal models to subtasks based on complexity, available GPU slots,
 * and cost optimization. Builds parallel execution groups from dependency graph.
 *
 * Flow: diagnosticPlan.subtasks → assignModels() → subtasks with assignedModel + parallelGroup
 */
import {
  type ModelCapability,
  type TaskComplexity,
  modelRegistry,
  complexityMeetsRequirement,
  VRAM_BUDGET_MB,
} from '../config/model-capabilities.js';
import { models } from '../config/model-manifest.js';
import { resolveSubAgentRole } from '../config/subagent-roles.js';
import { getGpuGuard, type GpuSnapshot } from './gpu-guard.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { getBudgetTracker } from './budget-tracker.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoutableSubtask {
  id: string;
  estimatedComplexity?: TaskComplexity;
  dependencies: string[];
  targetFiles: string[];
  type: string;
  // Populated by router:
  assignedModel?: string;
  parallelGroup?: number;
  estimatedVramMb?: number;
}

interface RouteDecision {
  subtaskId: string;
  model: ModelCapability;
  reason: string;
}

// ── Slot Manager ─────────────────────────────────────────────────────────────

/**
 * Tracks VRAM usage across concurrent local model assignments.
 * Cloud models have unlimited slots (rate limited by API).
 *
 * TWO layers of protection:
 * 1. Planning budget (VRAM_BUDGET_MB) — calculated at startup
 * 2. Runtime pre-flight (GpuGuard.canLoadModel) — live nvidia-smi check
 */
class VramBudgetTracker {
  private usedVramMb = 0;
  private readonly budgetMb: number;
  private readonly gpuSnapshot: GpuSnapshot | null;

  constructor(budgetMb: number = VRAM_BUDGET_MB, gpuSnapshot?: GpuSnapshot) {
    // Use the SMALLER of planning budget and live available VRAM
    // This catches cases where other processes consumed VRAM since startup
    const liveBudget = gpuSnapshot?.availableForModelsMb ?? Infinity;
    this.budgetMb = Math.min(budgetMb, liveBudget);
    this.gpuSnapshot = gpuSnapshot ?? null;

    if (gpuSnapshot && liveBudget < budgetMb) {
      console.warn(
        `[SmartRouter] Live VRAM (${liveBudget}MB) < planning budget (${budgetMb}MB) — ` +
        `using live value. System VRAM pressure detected.`,
      );
    }
  }

  canFit(model: ModelCapability): boolean {
    if (model.vramMb === 0) return true; // Cloud
    return this.usedVramMb + model.vramMb <= this.budgetMb;
  }

  allocate(model: ModelCapability): void {
    this.usedVramMb += model.vramMb;
  }

  release(model: ModelCapability): void {
    this.usedVramMb = Math.max(0, this.usedVramMb - model.vramMb);
  }

  reset(): void {
    this.usedVramMb = 0;
  }

  get available(): number {
    return this.budgetMb - this.usedVramMb;
  }

  /** Whether GPU is available at all (vs cloud-only) */
  get gpuAvailable(): boolean {
    return this.gpuSnapshot?.gpuAvailable ?? (this.budgetMb > 0);
  }
}

// ── Dependency Graph → Parallel Groups ───────────────────────────────────────

/**
 * Split one topological level only where two code writers target the same file.
 *
 * Readers reserve nothing. A writer and a reader for the same path therefore
 * stay together, deliberately: serializing read-write overlap would collapse
 * most useful parallelism, and verification normally declares a dependency on
 * the edit anyway. Only write-write is forbidden by the J2 step 4 decision.
 */
function splitWriteConflicts(group: RoutableSubtask[]): RoutableSubtask[][] {
  const waves: Array<{ subtasks: RoutableSubtask[]; writtenFiles: Set<string> }> = [];

  for (const subtask of group) {
    if (!subtaskWritesCode(subtask)) {
      if (waves.length === 0) waves.push({ subtasks: [], writtenFiles: new Set() });
      waves[0]!.subtasks.push(subtask);
      continue;
    }

    const targets = new Set(subtask.targetFiles.filter((file) => file.length > 0));
    let wave = waves.find(
      (candidate) => [...targets].every((file) => !candidate.writtenFiles.has(file)),
    );
    if (!wave) {
      wave = { subtasks: [], writtenFiles: new Set() };
      waves.push(wave);
    }
    wave.subtasks.push(subtask);
    for (const file of targets) wave.writtenFiles.add(file);
  }

  return waves.map((wave) => wave.subtasks);
}

/**
 * Topological sort subtasks into execution groups.
 * Subtasks with no unmet dependencies go into the earliest topological level;
 * write-write file collisions split that level into sequential subwaves.
 */
export function buildParallelGroups(subtasks: RoutableSubtask[]): RoutableSubtask[][] {
  const groups: RoutableSubtask[][] = [];
  const resolved = new Set<string>();
  const remaining = [...subtasks];

  while (remaining.length > 0) {
    const group: RoutableSubtask[] = [];

    for (let i = remaining.length - 1; i >= 0; i--) {
      const task = remaining[i];
      const depsMetOrEmpty = task.dependencies.length === 0
        || task.dependencies.every((dep) => resolved.has(dep));

      if (depsMetOrEmpty) {
        group.push(task);
        remaining.splice(i, 1);
      }
    }

    if (group.length === 0) {
      // Circular dependency — force remaining into last group
      console.warn('[SmartRouter] Circular dependency detected, forcing remaining subtasks');
      groups.push(...splitWriteConflicts(remaining.splice(0)));
      break;
    }

    // Sort group by priority (lower = first)
    group.sort((a, b) => (a as any).priority - (b as any).priority);
    groups.push(...splitWriteConflicts(group));
    group.forEach((t) => resolved.add(t.id));
  }

  return groups;
}


// ── Which work may run on a small local model ────────────────────────────────

/**
 * Roles whose subtask EDITS THIS SYSTEM'S OWN SOURCE, and therefore may not be
 * assigned to a small local model however much VRAM is free.
 *
 * The router's stated policy is "prefer local if VRAM available (cost = 0)", and
 * its only quality filter is `estimatedComplexity` — which the diagnosing model
 * estimates for itself. Nothing said that WRITING A REPAIR is different from
 * summarising a log, so the autoheal cycle handed its code edits to a 12B local
 * model. Both live G4 runs (2026-08-17) ended the same way:
 *
 *   [SubtaskExecutor] Retry: Quality issues: no_files_changed,
 *                     target_files_missed, empty_diagnostics
 *   [SubtaskExecutor] Escalate: gemma4:12b → bielik-11b
 *   → worktree pusty po implementacji → cykl zatrzymany
 *
 * The escalation ladder cannot save it: escalating within local models trades a
 * 12B for an 11B. The cost saving is also illusory — a repair that produces
 * nothing costs a full cycle and leaves the defect in place.
 *
 * This is NOT a ban on local models. Verification, builds, tests, greps and
 * summaries keep using them, which is the point of having workers: the strong
 * model does the repair and calls on them for small, targeted work.
 */
const ROLES_THAT_WRITE_CODE = new Set(['file-editor']);

/**
 * Roles the owner moved off local models entirely (J7, 2026-08-23) as part of
 * reviving the subagent-role system: `terminal` and `qa` were declared
 * `defaultModelTier: 'local-micro'` in `subagent-roles.ts`, but that field was
 * never read anywhere (`git log -S defaultModelTier` = zero commits) — the
 * ACTUAL routing decision lived here, in `skipLocal`, which defaults every
 * non-code-writing role onto "prefer local if VRAM available". Verification
 * and command-running work is cheap and fast on a small cloud model, and
 * moving it off local frees VRAM for whatever else wants it, without the
 * quality risk `ROLES_THAT_WRITE_CODE` exists to prevent — this is a cost/
 * availability choice, not a correctness one.
 *
 * Not `ROLES_THAT_WRITE_CODE`: those get PINNED to one specific model
 * (`REPAIR_MODEL_KEY`) because a wrong local model produced empty diffs.
 * These roles just skip local candidates and fall through to the normal
 * cheapest-capable-cloud selection below — any capable cloud model is fine.
 */
const ROLES_EXCLUDED_FROM_LOCAL = new Set(['terminal', 'qa']);

/**
 * Does this subtask's role prefer to stay off local models regardless of
 * VRAM? Exported so `findOfflineFallback` — the SECOND, independent producer
 * of a model decision (Z22's exact lesson: pinning one producer is not
 * pinning) — applies the same rule instead of silently reopening local
 * models for terminal/qa the moment their cloud model has a bad day.
 */
export function roleExcludedFromLocal(subtask: Pick<RoutableSubtask, 'type'>): boolean {
  return ROLES_EXCLUDED_FROM_LOCAL.has(resolveSubAgentRole(subtask.type).roleId);
}

/**
 * The model a code-editing subtask is PINNED to: the coding domain's own model.
 *
 * Excluding local models was not enough. The router then picked the cheapest
 * cloud candidate that CLAIMED to handle the declared complexity — and the
 * complexity is declared by the diagnosing model about its own plan, so
 * "cheapest that says it can" is the same weak guarantee one layer up. Measured
 * after the local exclusion: repairs landed on a 20B, escalating to gpt-5.3-mini
 * only after failing first.
 *
 * Owner's decision, 2026-08-17: the agent that repairs this system's code uses
 * the coding domain's model, and reaches for workers itself when it wants small
 * targeted help. This makes the router agree with `model-manifest.ts`, where
 * `codingAgent` has been `deepseek-v4-pro` all along — the split between the two
 * is what let the repair path drift.
 */
const REPAIR_MODEL_KEY = 'deepseek-v4-pro';

/** Does this subtask edit code? Unknown types default to yes, deliberately. */
export function subtaskWritesCode(subtask: Pick<RoutableSubtask, 'type'>): boolean {
  // `resolveSubAgentRole` falls back to `file-editor`, so an unrecognised type
  // lands on the strong model. That is the right direction to be wrong in.
  return ROLES_THAT_WRITE_CODE.has(resolveSubAgentRole(subtask.type).roleId);
}

// ── Model Selection ──────────────────────────────────────────────────────────

/**
 * Select the best model for a subtask:
 * 1. Filter by complexity capability
 * 2. Prefer local if VRAM available (cost = 0)
 * 3. Fall back to cheapest cloud
 * 4. Respect VRAM budget for parallel local models
 */
function selectModel(
  subtask: RoutableSubtask,
  vramTracker: VramBudgetTracker,
  preferLocal: boolean = true,
): RouteDecision {
  const complexity: TaskComplexity = subtask.estimatedComplexity ?? 'simple';

  // If no GPU available at all, skip local candidates entirely — and likewise
  // when the subtask writes code (`ROLES_THAT_WRITE_CODE`) or its role was
  // moved off local by the owner (`ROLES_EXCLUDED_FROM_LOCAL`).
  const editsCode = subtaskWritesCode(subtask);
  const skipLocal = !vramTracker.gpuAvailable || editsCode || roleExcludedFromLocal(subtask);

  if (editsCode) {
    const pinned = modelRegistry.find(
      (m) => m.modelId === models[REPAIR_MODEL_KEY as keyof typeof models],
    );
    if (pinned?.available && !getCircuitBreaker().isOpen(pinned.modelId)) {
      console.log(`[SmartRouter] ${subtask.id}: writes code — pinned to ${pinned.name}`);
      return { subtaskId: subtask.id, model: pinned, reason: 'pinned: repairs use the coding model' };
    }
    // No silent downgrade to whatever is cheapest: say which guarantee was lost.
    console.warn(
      `[SmartRouter] ${subtask.id}: writes code, but ${REPAIR_MODEL_KEY} is `
      + `${pinned ? 'circuit-broken' : 'not in the registry'} — falling back to the strongest `
      + 'available CLOUD model. Local models stay ineligible.',
    );
  }

  // Get all capable models sorted by cost
  const candidates = modelRegistry
    .filter((m) => {
      if (!m.available) return false;
      if (!complexityMeetsRequirement(m.maxComplexity, complexity)) return false;
      // Skip local models if GPU unavailable (container without GPU, etc.)
      if (skipLocal && m.vramMb > 0) return false;
      // Phase 4.2: Skip models with open circuit breaker
      if (getCircuitBreaker().isOpen(m.modelId)) return false;
      // Phase 4.3: Skip cloud-free models when over daily budget
      if (m.tier === 'cloud-free' && getBudgetTracker().isOverBudget('openrouter')) return false;
      return true;
    })
    .sort((a, b) => {
      if (preferLocal && !skipLocal) {
        const aLocal = a.vramMb > 0 ? 0 : 1;
        const bLocal = b.vramMb > 0 ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
      }
      if (a.costPerCall !== b.costPerCall) return a.costPerCall - b.costPerCall;
      return a.avgLatencyMs - b.avgLatencyMs;
    });

  // Try to fit a local model first
  for (const model of candidates) {
    if (model.vramMb > 0) {
      // Local model — check VRAM budget (planning layer)
      if (vramTracker.canFit(model)) {
        // Runtime layer — live GpuGuard pre-flight check
        try {
          const guard = getGpuGuard();
          const check = guard.canLoadModel(model.vramMb);
          if (!check.allowed) {
            console.warn(
              `[SmartRouter] Runtime VRAM check BLOCKED ${model.name}: ${check.reason}`,
            );
            continue; // Skip to next candidate
          }
        } catch {
          // GpuGuard unavailable — rely on planning budget only
        }

        vramTracker.allocate(model);
        return {
          subtaskId: subtask.id,
          model,
          reason: `Local ${model.name} fits VRAM budget (${model.vramMb}MB, ${vramTracker.available}MB remaining)`,
        };
      }
      // Doesn't fit — skip to next candidate
      continue;
    } else {
      // Cloud model — always available
      return {
        subtaskId: subtask.id,
        model,
        reason: `Cloud ${model.name} — local VRAM insufficient (${vramTracker.available}MB free)`,
      };
    }
  }

  // Absolute fallback — cheapest cloud model
  const fallback = modelRegistry.find((m) => m.vramMb === 0 && m.available);
  if (fallback) {
    return {
      subtaskId: subtask.id,
      model: fallback,
      reason: `Fallback to ${fallback.name} — no suitable model found`,
    };
  }

  throw new Error(`[SmartRouter] No available model for subtask ${subtask.id} (complexity: ${complexity})`);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RoutingResult {
  groups: Array<{
    groupIndex: number;
    subtasks: Array<{
      subtask: RoutableSubtask;
      model: ModelCapability;
      reason: string;
    }>;
    totalVramMb: number;
    estimatedLatencyMs: number;
  }>;
  summary: {
    totalSubtasks: number;
    totalGroups: number;
    localAssignments: number;
    cloudAssignments: number;
    estimatedCost: number;
    estimatedTotalLatencyMs: number;
  };
}

/**
 * Route subtasks to optimal models and organize into parallel execution groups.
 *
 * @param subtasks - Subtasks from diagnosticPlan
 * @param preferLocal - Prefer free local models over cloud (default: true)
 * @returns RoutingResult with groups, assignments, and cost estimate
 */
export function routeSubtasks(
  subtasks: RoutableSubtask[],
  preferLocal: boolean = true,
): RoutingResult {
  // Step 0: Get live GPU snapshot for runtime protection
  let liveSnapshot: GpuSnapshot | undefined;
  try {
    const guard = getGpuGuard();
    liveSnapshot = guard.getSnapshot(true); // Force fresh read
    console.log(guard.formatSnapshot(liveSnapshot));
  } catch {
    console.warn('[SmartRouter] GpuGuard unavailable — using planning budget only');
  }

  // Step 1: Build parallel groups from dependency graph
  const parallelGroups = buildParallelGroups(subtasks);

  let totalLocalAssignments = 0;
  let totalCloudAssignments = 0;
  let totalCost = 0;
  let totalLatency = 0;

  const groups = parallelGroups.map((group, groupIndex) => {
    // Each group gets fresh VRAM budget (previous group's models unloaded)
    // Pass live snapshot so budget adapts to actual GPU state
    const vramTracker = new VramBudgetTracker(VRAM_BUDGET_MB, liveSnapshot);
    let groupMaxLatency = 0;
    let groupVram = 0;

    const assignments = group.map((subtask) => {
      const decision = selectModel(subtask, vramTracker, preferLocal);

      // Annotate subtask with routing info
      subtask.assignedModel = decision.model.modelId;
      subtask.parallelGroup = groupIndex;
      subtask.estimatedVramMb = decision.model.vramMb;

      // Track stats
      if (decision.model.vramMb > 0) {
        totalLocalAssignments++;
      } else {
        totalCloudAssignments++;
      }
      totalCost += decision.model.costPerCall;
      groupMaxLatency = Math.max(groupMaxLatency, decision.model.avgLatencyMs);
      groupVram += decision.model.vramMb;

      return {
        subtask,
        model: decision.model,
        reason: decision.reason,
      };
    });

    totalLatency += groupMaxLatency; // Groups are sequential

    return {
      groupIndex,
      subtasks: assignments,
      totalVramMb: groupVram,
      estimatedLatencyMs: groupMaxLatency,
    };
  });

  return {
    groups,
    summary: {
      totalSubtasks: subtasks.length,
      totalGroups: groups.length,
      localAssignments: totalLocalAssignments,
      cloudAssignments: totalCloudAssignments,
      estimatedCost: totalCost,
      estimatedTotalLatencyMs: totalLatency,
    },
  };
}

/**
 * Pretty-print routing result for logging/diagnostics.
 */
export function formatRoutingResult(result: RoutingResult): string {
  const lines: string[] = [
    `\n═══ Smart Router — ${result.summary.totalSubtasks} subtasks → ${result.summary.totalGroups} groups ═══`,
    `   Local: ${result.summary.localAssignments} | Cloud: ${result.summary.cloudAssignments} | Est. cost: $${(result.summary.estimatedCost * 0.01).toFixed(2)}`,
    `   Est. total time: ${(result.summary.estimatedTotalLatencyMs / 1000).toFixed(1)}s`,
    '',
  ];

  for (const group of result.groups) {
    lines.push(`── Group ${group.groupIndex} (parallel, ~${(group.estimatedLatencyMs / 1000).toFixed(1)}s, ${group.totalVramMb}MB VRAM) ──`);
    for (const { subtask, model, reason } of group.subtasks) {
      const tag = model.vramMb > 0 ? '🖥️ LOCAL' : '☁️ CLOUD';
      lines.push(`   ${tag} [${subtask.id}] → ${model.name} (${(subtask as any).estimatedComplexity ?? '?'}) — ${reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
