/**
 * Goal Tracker (Phase 3 — Cognitive Loop)
 *
 * Tracks execution goals (GoalContracts) across agent runs.
 * Each delegation or complex task creates a GoalContract that persists:
 *   - The original goal
 *   - Planned steps with status tracking
 *   - Success criteria
 *   - Evidence for/against progress
 *   - Confidence level
 *   - Plan revision count
 *
 * Storage: MongoDB `goal_contracts` collection (TTL: 7 days).
 *
 * Integration points:
 *   - delegate-task.ts: creates/updates contracts on delegation
 *   - strategy-reflector.ts: reads progress for anomaly detection
 *   - context-checkpoint.ts: can import GoalContract into checkpoint
 */

import { randomUUID } from 'crypto';
import { getDb } from '../lib/mongo.js';
import { logAgentEvent } from '../lib/agent-event-log.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'critical';

export interface PlannedStep {
  stepId: string;
  description: string;
  targetAgent: string;
  status: StepStatus;
  evidence?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface GoalContract {
  /** Unique ID for this contract (usually same as taskId or delegationId) */
  contractId: string;
  /** Parent task/delegation ID */
  taskId: string;
  /** Agent responsible for executing this contract */
  agentId: string;
  /** The original user/caller goal */
  originalGoal: string;

  // ── PLAN ──
  plannedSteps: PlannedStep[];
  /**
   * WS2 — explicit plan assumptions. Replanning fires when a step result
   * contradicts one of these. Optional: legacy/static plans leave it empty.
   */
  assumptions?: string[];

  // ── GOAL TRACKING ──
  successCriteria: string[];
  currentProgress: number;        // 0.0 - 1.0
  planRevisions: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  confidenceLevel: ConfidenceLevel;

  // ── META ──
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  expiresAt: Date;
}

export interface GoalCompletionEvaluation {
  score: number;
  passed: boolean;
  missingCriteria: string[];
  recommendation: 'finalize' | 'replan' | 'ask_user' | 'escalate';
  progress: number;
  confidenceLevel: ConfidenceLevel;
}

// ── Configuration ────────────────────────────────────────────────────────────

const COLLECTION = 'goal_contracts';
const TTL_DAYS = 7;

// ── Singleton ────────────────────────────────────────────────────────────────

let _initialized = false;

async function ensureIndexes(): Promise<void> {
  if (_initialized) return;
  try {
    const db = await getDb();
    await Promise.all([
      db.collection(COLLECTION).createIndex({ contractId: 1 }, { unique: true }),
      db.collection(COLLECTION).createIndex({ taskId: 1 }),
      db.collection(COLLECTION).createIndex({ agentId: 1, status: 1 }),
      db.collection(COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
    _initialized = true;
  } catch {
    _initialized = true;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new GoalContract for a task/delegation.
 * The caller extracts the goal from the task description and provides
 * initial planned steps and success criteria.
 */
export async function createGoalContract(input: {
  taskId: string;
  agentId: string;
  originalGoal: string;
  plannedSteps?: Array<{ description: string; targetAgent: string }>;
  successCriteria?: string[];
  /** WS2 — explicit plan assumptions (the replanning trigger). */
  assumptions?: string[];
}): Promise<GoalContract> {
  await ensureIndexes();
  const db = await getDb();

  const now = new Date();
  const contractId = `goal-${input.taskId}-${randomUUID().slice(0, 8)}`;

  const contract: GoalContract = {
    contractId,
    taskId: input.taskId,
    agentId: input.agentId,
    originalGoal: input.originalGoal,
    plannedSteps: (input.plannedSteps ?? []).map((s, i) => ({
      stepId: `step-${i + 1}`,
      description: s.description,
      targetAgent: s.targetAgent,
      status: 'pending' as const,
    })),
    assumptions: input.assumptions ?? [],
    successCriteria: input.successCriteria ?? [],
    currentProgress: 0,
    planRevisions: 0,
    evidenceFor: [],
    evidenceAgainst: [],
    confidenceLevel: 'medium',
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000),
  };

  await db.collection(COLLECTION).insertOne(contract as any);

  logAgentEvent({
    type: 'goal_contract_created',
    agentId: 'goal-tracker',
    taskId: input.taskId,
    status: 'success',
    input: input.originalGoal,
    data: {
      contractId,
      taskId: input.taskId,
      targetAgent: input.agentId,
      stepCount: contract.plannedSteps.length,
      successCriteriaCount: contract.successCriteria.length,
    },
  }).catch(() => { /* non-critical */ });

  console.log(
    `[GoalTracker] Created contract ${contractId} for task ${input.taskId} ` +
    `(${contract.plannedSteps.length} steps, ${contract.successCriteria.length} criteria)`,
  );

  return contract;
}

/**
 * Record evidence from a step result. Updates progress automatically.
 */
export async function recordEvidence(
  contractId: string,
  evidence: {
    stepId?: string;
    type: 'for' | 'against';
    description: string;
    stepStatus?: StepStatus;
  },
): Promise<void> {
  await ensureIndexes();
  const db = await getDb();

  const $push: Record<string, any> = {};
  const $set: Record<string, any> = {
    updatedAt: new Date().toISOString(),
  };

  if (evidence.type === 'for') {
    $push['evidenceFor'] = evidence.description;
  } else {
    $push['evidenceAgainst'] = evidence.description;
  }

  // Update step status if provided
  if (evidence.stepId && evidence.stepStatus) {
    $set[`plannedSteps.$[step].status`] = evidence.stepStatus;
    if (evidence.stepStatus === 'in_progress') {
      $set[`plannedSteps.$[step].startedAt`] = new Date().toISOString();
    }
    if (evidence.stepStatus === 'done' || evidence.stepStatus === 'failed') {
      $set[`plannedSteps.$[step].completedAt`] = new Date().toISOString();
    }
    if (evidence.description) {
      $set[`plannedSteps.$[step].evidence`] = evidence.description;
    }
  }

  const updateOp: Record<string, any> = { $set, $push };
  const arrayFilters = evidence.stepId
    ? [{ 'step.stepId': evidence.stepId }]
    : undefined;

  await db.collection(COLLECTION).updateOne(
    { contractId },
    updateOp,
    { arrayFilters },
  );

  // Recalculate progress
  await recalculateProgress(contractId);

  logAgentEvent({
    type: 'goal_evidence_recorded',
    agentId: 'goal-tracker',
    taskId: contractId,
    status: evidence.type === 'for' ? 'success' : 'error',
    input: evidence.description,
    data: {
      contractId,
      stepId: evidence.stepId,
      evidenceType: evidence.type,
      stepStatus: evidence.stepStatus,
    },
  }).catch(() => { /* non-critical */ });
}

/**
 * Record a plan revision (when the agent changes its approach).
 */
export async function recordPlanRevision(
  contractId: string,
  newSteps: Array<{ description: string; targetAgent: string }>,
  reason: string,
  /** WS2 — when replanning because an assumption broke, pass the revised set. */
  newAssumptions?: string[],
): Promise<void> {
  await ensureIndexes();
  const db = await getDb();

  const plannedSteps: PlannedStep[] = newSteps.map((s, i) => ({
    stepId: `step-rev-${i + 1}`,
    description: s.description,
    targetAgent: s.targetAgent,
    status: 'pending' as const,
  }));

  const set: Record<string, unknown> = {
    plannedSteps,
    updatedAt: new Date().toISOString(),
  };
  if (newAssumptions) set.assumptions = newAssumptions;

  await db.collection(COLLECTION).updateOne(
    { contractId },
    {
      $set: set,
      $inc: { planRevisions: 1 },
      $push: {
        evidenceFor: `Plan revised: ${reason}` as any,
      },
    },
  );

  logAgentEvent({
    type: 'goal_plan_revised',
    agentId: 'goal-tracker',
    taskId: contractId,
    status: 'success',
    input: reason,
    data: {
      contractId,
      stepCount: plannedSteps.length,
    },
  }).catch(() => { /* non-critical */ });

  console.log(`[GoalTracker] Plan revised for ${contractId}: ${reason}`);
}

/**
 * Update confidence level based on accumulated evidence.
 */
export async function updateConfidence(
  contractId: string,
  level: ConfidenceLevel,
): Promise<void> {
  await ensureIndexes();
  const db = await getDb();

  await db.collection(COLLECTION).updateOne(
    { contractId },
    { $set: { confidenceLevel: level, updatedAt: new Date().toISOString() } },
  );
}

/**
 * Mark a contract as completed or failed.
 */
export async function completeGoalContract(
  contractId: string,
  status: 'completed' | 'failed' | 'abandoned',
  finalEvidence?: string,
): Promise<void> {
  await ensureIndexes();
  const db = await getDb();
  const now = new Date().toISOString();

  const $set: Record<string, any> = {
    status,
    completedAt: now,
    updatedAt: now,
  };

  const updateOp: Record<string, any> = { $set };
  if (finalEvidence) {
    updateOp.$push = status === 'completed'
      ? { evidenceFor: finalEvidence }
      : { evidenceAgainst: finalEvidence };
  }

  const updateOptions: Record<string, any> = {};
  if (status === 'completed') {
    // A completed contract is terminal. Close any still-open plan steps so future
    // deterministic completion checks cannot keep a successful run in a feedback
    // loop solely because generic harness steps were never individually marked.
    $set['plannedSteps.$[step].status'] = 'done';
    $set['plannedSteps.$[step].completedAt'] = now;
    updateOptions.arrayFilters = [{ 'step.status': { $in: ['pending', 'in_progress'] } }];
  }

  await db.collection(COLLECTION).updateOne({ contractId }, updateOp, updateOptions);
  await recalculateProgress(contractId);

  logAgentEvent({
    type: 'goal_contract_completed',
    agentId: 'goal-tracker',
    taskId: contractId,
    status: status === 'completed' ? 'success' : 'error',
    data: { contractStatus: status, finalEvidence },
  }).catch(() => { /* non-critical */ });

  console.log(`[GoalTracker] Contract ${contractId} → ${status}`);
}

/**
 * Evaluate whether a GoalContract has enough evidence to finalize.
 * This is intentionally deterministic and cheap; LLM-based criterion
 * verification can be layered on later when the contract is in precontext.
 */
export async function evaluateCompletion(contractId: string): Promise<GoalCompletionEvaluation> {
  await ensureIndexes();
  await recalculateProgress(contractId);

  const contract = await getGoalContract(contractId);
  if (!contract) {
    const missing: GoalCompletionEvaluation = {
      score: 0,
      passed: false,
      missingCriteria: ['GoalContract not found'],
      recommendation: 'ask_user',
      progress: 0,
      confidenceLevel: 'critical',
    };
    await logCompletionEvaluation(contractId, missing);
    return missing;
  }

  if (contract.status === 'completed') {
    const completed: GoalCompletionEvaluation = {
      score: 1,
      passed: true,
      missingCriteria: [],
      recommendation: 'finalize',
      progress: 1,
      confidenceLevel: contract.confidenceLevel === 'critical' ? 'high' : contract.confidenceLevel,
    };
    await logCompletionEvaluation(contractId, completed, contract);
    return completed;
  }

  if (contract.status === 'failed' || contract.status === 'abandoned') {
    const terminalFailure: GoalCompletionEvaluation = {
      score: 0,
      passed: false,
      missingCriteria: [`GoalContract is ${contract.status}`],
      recommendation: 'escalate',
      progress: contract.currentProgress,
      confidenceLevel: 'critical',
    };
    await logCompletionEvaluation(contractId, terminalFailure, contract);
    return terminalFailure;
  }

  const missingCriteria: string[] = [];
  const incompleteSteps = contract.plannedSteps.filter((step) =>
    step.status !== 'done' && step.status !== 'skipped',
  );
  const failedSteps = contract.plannedSteps.filter((step) => step.status === 'failed');

  if (contract.successCriteria.length === 0) {
    missingCriteria.push('No success criteria recorded');
  }
  for (const step of incompleteSteps) {
    missingCriteria.push(`Step ${step.stepId} is ${step.status}: ${step.description}`);
  }
  if (contract.evidenceAgainst.length > 0) {
    missingCriteria.push(`${contract.evidenceAgainst.length} evidenceAgainst item(s) require review`);
  }

  const progressScore = contract.currentProgress;
  const evidenceFor = contract.evidenceFor.length;
  const evidenceAgainst = contract.evidenceAgainst.length;
  const evidenceScore = evidenceFor + evidenceAgainst === 0
    ? 0.3
    : Math.max(0, evidenceFor / Math.max(1, evidenceFor + evidenceAgainst));
  const confidenceScore = confidenceToScore(contract.confidenceLevel);
  const score = roundScore((progressScore * 0.6) + (evidenceScore * 0.25) + (confidenceScore * 0.15));
  const passed = score >= 0.7
    && failedSteps.length === 0
    && contract.confidenceLevel !== 'critical';

  const recommendation: GoalCompletionEvaluation['recommendation'] =
    passed ? 'finalize'
      : contract.confidenceLevel === 'critical' || failedSteps.length > 0 ? 'escalate'
        : contract.currentProgress < 0.7 ? 'replan'
          : 'ask_user';

  const evaluation: GoalCompletionEvaluation = {
    score,
    passed,
    missingCriteria,
    recommendation,
    progress: contract.currentProgress,
    confidenceLevel: contract.confidenceLevel,
  };

  await logCompletionEvaluation(contractId, evaluation, contract);
  return evaluation;
}

/**
 * Get a contract by ID.
 */
export async function getGoalContract(contractId: string): Promise<GoalContract | null> {
  await ensureIndexes();
  const db = await getDb();
  return db.collection(COLLECTION).findOne({ contractId }) as unknown as GoalContract | null;
}

/**
 * Get the active contract for a task.
 */
export async function getActiveContractForTask(taskId: string): Promise<GoalContract | null> {
  await ensureIndexes();
  const db = await getDb();
  return db.collection(COLLECTION).findOne(
    { taskId, status: 'active' },
    { sort: { createdAt: -1 } },
  ) as unknown as GoalContract | null;
}

/**
 * Format a GoalContract for prompt injection (token-efficient).
 */
export function formatGoalForPrompt(contract: GoalContract): string {
  const sections: string[] = [];

  sections.push(`## Active Goal Contract`);
  sections.push(`**Goal:** ${contract.originalGoal}`);
  sections.push(`**Progress:** ${(contract.currentProgress * 100).toFixed(0)}% | **Confidence:** ${contract.confidenceLevel}`);

  if (contract.planRevisions > 0) {
    sections.push(`**Plan revised:** ${contract.planRevisions} time(s)`);
  }

  if (contract.plannedSteps.length > 0) {
    sections.push(`\n### Plan Steps:`);
    for (const step of contract.plannedSteps) {
      const icon = step.status === 'done' ? '✅'
        : step.status === 'failed' ? '❌'
        : step.status === 'in_progress' ? '🔄'
        : step.status === 'skipped' ? '⏭️'
        : '⏳';
      sections.push(`${icon} ${step.stepId}: ${step.description} → ${step.targetAgent} [${step.status}]`);
      if (step.evidence) {
        sections.push(`   Evidence: ${step.evidence}`);
      }
    }
  }

  if (contract.successCriteria.length > 0) {
    sections.push(`\n### Success Criteria:`);
    contract.successCriteria.forEach((c, i) => sections.push(`${i + 1}. ${c}`));
  }

  if (contract.evidenceAgainst.length > 0) {
    sections.push(`\n### ⚠️ Evidence Against:`);
    contract.evidenceAgainst.slice(-3).forEach((e) => sections.push(`- ${e}`));
  }

  return sections.join('\n');
}

/**
 * List active contracts (for diagnostics).
 */
export async function listActiveContracts(): Promise<Array<{
  contractId: string;
  taskId: string;
  agentId: string;
  originalGoal: string;
  progress: number;
  confidence: ConfidenceLevel;
  steps: number;
}>> {
  await ensureIndexes();
  const db = await getDb();

  const docs = await db.collection(COLLECTION)
    .find({ status: 'active' })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  return docs.map((d) => ({
    contractId: d.contractId,
    taskId: d.taskId,
    agentId: d.agentId,
    originalGoal: (d.originalGoal ?? '').slice(0, 100),
    progress: d.currentProgress ?? 0,
    confidence: d.confidenceLevel ?? 'medium',
    steps: (d.plannedSteps ?? []).length,
  }));
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Recalculate progress based on step completion.
 */
async function recalculateProgress(contractId: string): Promise<void> {
  const db = await getDb();
  const doc = await db.collection(COLLECTION).findOne({ contractId });
  if (!doc) return;

  const steps = (doc.plannedSteps ?? []) as PlannedStep[];
  if (steps.length === 0) return;

  const forCount = (doc.evidenceFor ?? []).length;
  const againstCount = (doc.evidenceAgainst ?? []).length;

  // ── §2.1 granular progress ──
  // Structural backbone: fraction of plan steps formally closed out.
  const doneOrSkipped = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const stepProgress = doneOrSkipped / steps.length;

  // Sub-step granularity: while steps remain open, accumulating NET positive
  // evidence nudges progress upward via a saturating proxy. This lets
  // `currentProgress` move as real work lands (so a stalled run — net evidence
  // stops growing — produces a flat delta the reflector can detect), WITHOUT
  // ever letting evidence alone claim the plan is finished (formal step
  // completion / the final-evidence pass must close it out). Bounded to a
  // fraction of the still-incomplete portion so mid-run progress stays clearly
  // below the completion threshold when no steps are formally done.
  const netEvidence = Math.max(0, forCount - againstCount);
  const EVIDENCE_SATURATION = 5;
  const evidenceProxy = netEvidence === 0 ? 0 : netEvidence / (netEvidence + EVIDENCE_SATURATION);
  const incompleteFraction = 1 - stepProgress;
  const progress = Math.max(0, Math.min(1, stepProgress + incompleteFraction * evidenceProxy * 0.4));

  // Auto-calculate confidence from evidence balance
  let confidence: ConfidenceLevel = 'medium';
  if (againstCount > forCount * 2) confidence = 'critical';
  else if (againstCount > forCount) confidence = 'low';
  else if (againstCount === 0 && forCount > 0) confidence = 'high';

  await db.collection(COLLECTION).updateOne(
    { contractId },
    { $set: { currentProgress: progress, confidenceLevel: confidence } },
  );
}

function confidenceToScore(confidence: ConfidenceLevel): number {
  switch (confidence) {
    case 'high': return 1;
    case 'medium': return 0.7;
    case 'low': return 0.35;
    case 'critical': return 0;
  }
}

function roundScore(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

async function logCompletionEvaluation(
  contractId: string,
  evaluation: GoalCompletionEvaluation,
  contract?: GoalContract,
): Promise<void> {
  await logAgentEvent({
    type: 'goal_completion_evaluated',
    agentId: 'goal-tracker',
    taskId: contractId,
    status: evaluation.passed ? 'success' : 'pending',
    data: {
      contractId,
      taskId: contract?.taskId,
      targetAgent: contract?.agentId,
      score: evaluation.score,
      passed: evaluation.passed,
      recommendation: evaluation.recommendation,
      progress: evaluation.progress,
      confidenceLevel: evaluation.confidenceLevel,
      missingCriteria: evaluation.missingCriteria.slice(0, 10),
    },
  }).catch(() => { /* non-critical */ });
}
