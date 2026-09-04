/**
 * Adaptive Depth Controller (Phase 4 — Cognitive Loop)
 *
 * Classifies task complexity from the user prompt and phase, then returns
 * a DepthProfile that governs how deeply the agent processes the task:
 *
 *   fast     → 10 steps, no planning, lightweight reflector, 60s timeout
 *   standard → 25 steps, inline planning, relaxed reflector, 180s
 *   deep     → 40 steps, persisted planning, strict reflector, goalContract, 300s
 *   critical → 40 steps, everything + review + approval, 300s
 *
 * The depth can be UPGRADED mid-run (never downgraded) via upgradeDepth().
 * The Strategy Reflector calls upgradeDepth() when it detects anomalies
 * at lower depth levels.
 *
 * Feature flag: FEATURE_ADAPTIVE_DEPTH (default: true).
 * When disabled, all runs use the 'deep' profile (backward compatible).
 */

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../config/agent-ids.js';
import { isPipelineAgent } from '../config/pipeline-phase-tools.js';
import { type ThinkingTier } from '../config/thinking-budget.js';
import { logHarnessEvent } from './harness-events.js';
import { upgradeRunDeadline } from './run-budget.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type DepthLevel = 'fast' | 'standard' | 'deep' | 'critical';

type HarnessPhase =
  | 'diagnose'
  | 'plan'
  | 'subtask'
  | 'retry'
  | 'review'
  | 'merge'
  | 'cleanup'
  | 'discover'
  | 'compose'
  | 'validate'
  | 'deploy'
  | 'test'
  | 'repair'
  | 'activate'
  | 'list'
  | 'source'
  | 'query'
  | 'research'
  | 'studio'
  | 'chat';

export interface DepthProfile {
  level: DepthLevel;
  thinkingTier: ThinkingTier;
  maxSteps: number;
  /**
   * Legacy wall-clock budget for the whole run (DEADLINE mode). Cuts the agent
   * purely for taking long, which is why it also forced the loop detectors to
   * be tuned down (see strategy-reflector §loop_fix.P2c).
   */
  timeoutMs: number;
  /**
   * LIVENESS mode (ideas/liveness-budget-plan.md): how long the run may emit NO
   * event before it is considered dead. Reset by every step/tool result, so an
   * agent that keeps working is never cut for duration alone.
   */
  idleTimeoutMs: number;
  /**
   * LIVENESS mode: absolute backstop, never reset. Deliberately far above normal
   * work — it exists to catch what neither the idle watchdog nor the detectors
   * caught, not to bound ordinary runs.
   */
  hardCapMs: number;
  planning: 'skip' | 'inline' | 'persisted';
  reflector: {
    enabled: boolean;
    config?: {
      warmupSteps?: number;
      maxToolRepetitions?: number;
      maxStepsWithoutProgress?: number;
      maxReflectionsPerRun?: number;
      maxDirectionChanges?: number;
      maxDelegationFailures?: number;
      errorRateThreshold?: number;
    };
  };
  goalContract: boolean;
  autoDeliberation: boolean;
  autoReview: boolean;
  requireApproval: boolean;
  contextBudgetTokens: number;
}

export interface ClassificationInput {
  prompt: string;
  agentId: string;
  phase: HarnessPhase;
  /**
   * Delegation hardening P1: thread the conversation id through so short
   * continuation imperatives ("Deleguj", "dalej") can inherit the thread's
   * recent heavy depth instead of classifying as `fast` on zero signals.
   */
  threadId?: string;
}

export interface ClassificationResult {
  level: DepthLevel;
  score: number;
  profile: DepthProfile;
  signals: ClassificationSignal[];
}

interface ClassificationSignal {
  name: string;
  delta: number;
  matched?: string;
}

// ── Depth Profiles ───────────────────────────────────────────────────────────

const DEPTH_PROFILES: Record<DepthLevel, DepthProfile> = {
  fast: {
    level: 'fast',
    thinkingTier: 'none',
    maxSteps: 10,
    timeoutMs: 180_000,
    idleTimeoutMs: 60_000,
    hardCapMs: 600_000,
    planning: 'skip',
    reflector: {
      enabled: true,
      config: {
        warmupSteps: 2,
        maxToolRepetitions: 4,
        maxStepsWithoutProgress: 8,
        maxReflectionsPerRun: 1,
        maxDirectionChanges: 4,
        maxDelegationFailures: 1,
        errorRateThreshold: 0.8,
      },
    },
    goalContract: false,
    autoDeliberation: false,
    autoReview: false,
    requireApproval: false,
    contextBudgetTokens: 4_000,
  },
  standard: {
    level: 'standard',
    thinkingTier: 'light',
    maxSteps: 25,
    timeoutMs: 600_000,
    idleTimeoutMs: 180_000,
    hardCapMs: 900_000,
    planning: 'inline',
    reflector: {
      enabled: true,
      config: {
        warmupSteps: 5,
        maxToolRepetitions: 6,
        // K8 — this was 25, exactly `maxSteps`. The check is `stepNumber >
        // threshold` and the run only ever reaches step 25, so the low-progress
        // nudge could never fire: a dead lever that looked configured. 15 leaves
        // ten steps for the nudge to actually change the outcome.
        maxStepsWithoutProgress: 15,
        maxReflectionsPerRun: 3,
        maxDirectionChanges: 4,
        maxDelegationFailures: 3,
        errorRateThreshold: 0.6,
      },
    },
    goalContract: false,
    autoDeliberation: false,
    autoReview: false,
    requireApproval: false,
    contextBudgetTokens: 16_000,
  },
  deep: {
    level: 'deep',
    thinkingTier: 'medium',
    maxSteps: 40,
    timeoutMs: 900_000,
    idleTimeoutMs: 300_000,
    hardCapMs: 1_800_000,
    planning: 'persisted',
    reflector: {
      enabled: true,
      config: {
        warmupSteps: 3,
        maxToolRepetitions: 4,
        maxStepsWithoutProgress: 20,
        maxReflectionsPerRun: 5,
        maxDirectionChanges: 3,
        maxDelegationFailures: 2,
        errorRateThreshold: 0.5,
      },
    },
    goalContract: true,
    autoDeliberation: isHarnessFeatureEnabled('FEATURE_HARNESS_AUTO_DELIBERATION', false),
    autoReview: false,
    requireApproval: false,
    contextBudgetTokens: 32_000,
  },
  critical: {
    level: 'critical',
    thinkingTier: 'deep',
    maxSteps: 40,
    timeoutMs: 1_200_000,
    idleTimeoutMs: 360_000,
    hardCapMs: 3_600_000,
    planning: 'persisted',
    reflector: {
      enabled: true,
      config: {
        warmupSteps: 2,
        maxToolRepetitions: 3,
        maxStepsWithoutProgress: 15,
        maxReflectionsPerRun: 7,
        maxDirectionChanges: 2,
        maxDelegationFailures: 2,
        errorRateThreshold: 0.4,
      },
    },
    goalContract: true,
    autoDeliberation: isHarnessFeatureEnabled('FEATURE_HARNESS_AUTO_DELIBERATION', false),
    autoReview: isHarnessFeatureEnabled('FEATURE_HARNESS_AUTO_REVIEW', false),
    requireApproval: true,
    contextBudgetTokens: 32_000,
  },
};

// ── Classification Keywords ──────────────────────────────────────────────────

const COMPLEX_KEYWORDS = /zaprojektuj|zrefaktoruj|zbuduj|przeanalizuj|zbadaj|porównaj|porownaj|zintegruj|zmigruj|przepisz|zoptymalizuj|audyt|audit|debat|implementac|architektur|architekton|design|refactor|build|architect|analyze|compare|integrate|migrate|rewrite|optimize|implementation|implement.*from.*scratch/i;

const SIMPLE_KEYWORDS = /pokaż|sprawdź|wylistuj|jaki.*status|co to jest|przypomnij|(?<![\p{L}\p{N}_])ile(?![\p{L}\p{N}_])|show|check|list|status|what is|remind|how many|count/iu;

const FAST_HINT_KEYWORDS = /szybko|krótko|w skrócie|jednym zdaniem|quick|brief|fast|short|tldr|tl;dr/i;

const DEEP_HINT_KEYWORDS = /dokładn|dokladn|głęboko|gleboko|szczegół|szczegol|wyczerpująco|wyczerpujaco|thorough|deep|careful|detailed|exhaustive|comprehensive/i;

const CRITICAL_KEYWORDS = /produkc|usuń|usun|delete|migrac|migration|bezpieczeń|bezpieczen|security|credential|credentials|secret|sekret|deploy|activate|aktywacj|aktywuj|aktywowa|payment|płatno|platno|database|baza danych/i;

const ARCHITECTURE_KEYWORDS = /architektur|architekton|architectur|podejści|podejsc|wariant|variant|trade[- ]?off|decision|decyz|debat|strateg/i;

const QUESTION_ONLY = /^\s*[^.!]{5,120}\?\s*$/;

// Delegation hardening P1 — a SHORT imperative that continues work already in
// flight ("Deleguj", "dalej", "continue"). Anchored to the whole message and
// length-capped: a long message with real content should classify on its own
// signals, not inherit. Matched case-insensitively against the trimmed prompt.
const CONTINUATION_COMMAND = /^\s*(?:ok(?:ej)?[,.!\s]*)?(?:deleguj|kontynuuj|dalej|dokończ|dokoncz|dokańczaj|dokanczaj|rób|rob|zrób to|zrob to|wykonaj|jedziemy|lecimy|działaj|dzialaj|continue|go ahead|proceed|resume|do it|keep going|go on|carry on)\s*[.!…]*\s*$/i;

const COMPLEX_PHASES = new Set<HarnessPhase>(['diagnose', 'compose', 'deploy', 'review', 'repair', 'activate']);
const SIMPLE_PHASES = new Set<HarnessPhase>(['list', 'query']);

const DOMAIN_PATTERNS = [
  /kod|code|typescript|refactor|plik|file/i,
  /automat|n8n|workflow|deploy/i,
  /badaj|research|notebooklm|notebook/i,
  /crm|lead|pipeline|sprzedaż|sales/i,
  /marketing|email|newsletter|rss/i,
  /writer|writing|book|novel|chapter|manuscript|short story|fiction|essay|report|whitepaper|article|scientific article|książk|ksiazk|powieść|powiesc|rozdział|rozdzial|opowiad|manuskrypt|raport|artykuł|artykul|esej/i,
];

// ── Depth Level Ordering ─────────────────────────────────────────────────────

const DEPTH_ORDER: Record<DepthLevel, number> = {
  fast: 0,
  standard: 1,
  deep: 2,
  critical: 3,
};

// Representative score floor per level — used when a level is assigned by
// inheritance rather than by signal arithmetic, so logged scores stay
// consistent with the level→score mapping below.
const LEVEL_SCORE_FLOOR: Record<DepthLevel, number> = {
  fast: 0,
  standard: 0.15,
  deep: 0.40,
  critical: 0.70,
};

// ── Thread-scoped depth state (Delegation hardening P1) ─────────────────────
//
// Remembers the heaviest recent depth per conversation thread so continuation
// imperatives can inherit it. Semantics: a heavier (or equal) turn refreshes
// the entry; a lighter turn does NOT overwrite or extend it — status chit-chat
// between heavy turns must not erase the memory of the ongoing task, and must
// not keep it alive forever either.

const THREAD_DEPTH_TTL_MS = 6 * 60 * 60 * 1000; // 6h — matches a working session
const THREAD_DEPTH_MAX_ENTRIES = 500;

const _threadDepths = new Map<string, { level: DepthLevel; at: number }>();

/**
 * Record the depth a thread just ran at. Only upgrades or refreshes:
 * lighter turns never lower the remembered level nor extend its TTL.
 */
export function recordThreadDepth(threadId: string, level: DepthLevel): void {
  const existing = _threadDepths.get(threadId);
  const now = Date.now();
  const existingFresh = existing && now - existing.at <= THREAD_DEPTH_TTL_MS;
  if (existingFresh && DEPTH_ORDER[existing.level] > DEPTH_ORDER[level]) {
    return; // lighter turn — keep the heavier memory, do not extend its TTL
  }
  // Delete+set keeps Map insertion order ≈ recency for cheap pruning below.
  _threadDepths.delete(threadId);
  _threadDepths.set(threadId, { level, at: now });
  if (_threadDepths.size > THREAD_DEPTH_MAX_ENTRIES) {
    const oldest = _threadDepths.keys().next().value;
    if (oldest !== undefined) _threadDepths.delete(oldest);
  }
}

/**
 * Get the remembered (non-expired) depth for a thread.
 */
export function getThreadDepth(threadId: string): DepthLevel | undefined {
  const entry = _threadDepths.get(threadId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > THREAD_DEPTH_TTL_MS) {
    _threadDepths.delete(threadId);
    return undefined;
  }
  return entry.level;
}

/**
 * Test helper — clear the thread depth registry.
 */
export function _resetThreadDepths(): void {
  _threadDepths.clear();
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Classify task complexity based on prompt content and phase.
 * Returns a score (0.0-1.0) mapped to a DepthLevel with full profile.
 * Runs synchronously in < 1ms.
 */
export function classifyComplexity(input: ClassificationInput): ClassificationResult {
  // When feature is disabled, always return 'deep' (backward compatible)
  if (!isHarnessFeatureEnabled('FEATURE_ADAPTIVE_DEPTH', true)) {
    return {
      level: 'deep',
      score: 0.5,
      profile: profileForAgent('deep', input.agentId),
      signals: [{ name: 'feature_disabled', delta: 0 }],
    };
  }

  let score = 0.0;
  const signals: ClassificationSignal[] = [];

  // ── 1. Message length (weight: 0.15) ──
  const len = input.prompt.length;
  if (len < 80) {
    // Very short — likely simple
  } else if (len < 200) {
    score += 0.05;
    signals.push({ name: 'msg_length_medium', delta: 0.05 });
  } else if (len < 500) {
    score += 0.10;
    signals.push({ name: 'msg_length_long', delta: 0.10 });
  } else {
    score += 0.15;
    signals.push({ name: 'msg_length_very_long', delta: 0.15 });
  }

  // ── 2. Complexity keywords (weight: 0.25) ──
  const complexMatch = input.prompt.match(COMPLEX_KEYWORDS);
  if (complexMatch) {
    score += 0.25;
    signals.push({ name: 'complex_keyword', delta: 0.25, matched: complexMatch[0] });
  }

  // ── 3. High-risk keywords (weight: 0.35 + floor) ──
  const criticalMatch = input.prompt.match(CRITICAL_KEYWORDS);
  if (criticalMatch) {
    score += 0.35;
    signals.push({ name: 'critical_keyword', delta: 0.35, matched: criticalMatch[0] });
  }

  // ── 4. Architecture/design hints (weight: 0.15 + floor with complex tasks) ──
  const architectureMatch = input.prompt.match(ARCHITECTURE_KEYWORDS);
  if (architectureMatch) {
    score += 0.15;
    signals.push({ name: 'architecture_keyword', delta: 0.15, matched: architectureMatch[0] });
  }

  const fastHint = input.prompt.match(FAST_HINT_KEYWORDS);
  const deepHint = input.prompt.match(DEEP_HINT_KEYWORDS);

  // ── 5. Simplicity keywords (weight: -0.15) ──
  const simpleMatch = input.prompt.match(SIMPLE_KEYWORDS);
  if (simpleMatch && !complexMatch && !criticalMatch && !architectureMatch && !deepHint) {
    score -= 0.15;
    signals.push({ name: 'simple_keyword', delta: -0.15, matched: simpleMatch[0] });
  } else if (simpleMatch) {
    signals.push({ name: 'simple_keyword_ignored', delta: 0, matched: simpleMatch[0] });
  }

  // ── 6. Phase-based (weight: ±0.15) ──
  if (COMPLEX_PHASES.has(input.phase)) {
    score += 0.15;
    signals.push({ name: 'complex_phase', delta: 0.15, matched: input.phase });
  } else if (SIMPLE_PHASES.has(input.phase)) {
    score -= 0.10;
    signals.push({ name: 'simple_phase', delta: -0.10, matched: input.phase });
  }

  // ── 7. Multi-domain detection (weight: 0.15) ──
  const domainCount = DOMAIN_PATTERNS.filter((d) => d.test(input.prompt)).length;
  if (domainCount >= 2) {
    score += 0.15;
    signals.push({ name: 'multi_domain', delta: 0.15, matched: `${domainCount} domains` });
  }

  // ── 8. Explicit hints (weight: ±0.20) ──
  if (fastHint) {
    score -= 0.20;
    signals.push({ name: 'fast_hint', delta: -0.20, matched: fastHint[0] });
  }

  if (deepHint) {
    score += 0.20;
    signals.push({ name: 'deep_hint', delta: 0.20, matched: deepHint[0] });
  }

  // ── 9. Question-only detection (weight: -0.15) ──
  if (QUESTION_ONLY.test(input.prompt) && !complexMatch && !criticalMatch && !architectureMatch) {
    score -= 0.15;
    signals.push({ name: 'question_only', delta: -0.15 });
  }

  // Floors keep strategic/high-risk tasks from being pulled down by chat wording.
  // P5 fix: only emit the depth_floor signal when a REAL floor (>0) engaged.
  // Previously a negative score (e.g. question_only) tripped `0 > score` and
  // logged a bogus "depth_floor:deep" on plain chit-chat.
  let scoreFloor = 0;
  if (criticalMatch) scoreFloor = Math.max(scoreFloor, 0.70);
  if ((complexMatch && domainCount >= 2) || (complexMatch && architectureMatch) || (complexMatch && deepHint)) {
    scoreFloor = Math.max(scoreFloor, 0.40);
  }
  if (scoreFloor > 0 && scoreFloor > score) {
    signals.push({ name: 'depth_floor', delta: scoreFloor - score, matched: scoreFloor >= 0.70 ? 'critical' : 'deep' });
    score = scoreFloor;
  }

  // ── Clamp ──
  score = Math.max(0, Math.min(1, score));

  // ── Map to level ──
  let level: DepthLevel;
  if (score < 0.15)      level = 'fast';
  else if (score < 0.40) level = 'standard';
  else if (score < 0.70) level = 'deep';
  else                    level = 'critical';

  // ── Delegation hardening P1: thread depth inheritance ──
  // A short continuation imperative ("Deleguj") carries zero classifiable
  // signals, yet continues heavy work already in flight. When the thread
  // recently ran at deep/critical and this prompt is such a command, inherit
  // the thread level instead of starving the continuation at `fast`.
  // An explicit fast hint ("szybko") always wins — the user knows better.
  if (
    input.threadId &&
    !fastHint &&
    isHarnessFeatureEnabled('FEATURE_DEPTH_THREAD_INHERITANCE', true) &&
    CONTINUATION_COMMAND.test(input.prompt)
  ) {
    const threadLevel = getThreadDepth(input.threadId);
    if (
      threadLevel &&
      DEPTH_ORDER[threadLevel] >= DEPTH_ORDER.deep &&
      DEPTH_ORDER[level] < DEPTH_ORDER[threadLevel]
    ) {
      signals.push({ name: 'depth_inherited', delta: LEVEL_SCORE_FLOOR[threadLevel] - score, matched: threadLevel });
      level = threadLevel;
      score = Math.max(score, LEVEL_SCORE_FLOOR[threadLevel]);
    }
  }

  // ── A pipeline agent is never a `fast` turn ────────────────────────────────
  //
  // The classifier reads the prompt, and a CORRECT brief for a pipeline agent can
  // be one short line. Measured: "Przygotuj nowe menu dla restauracji
  // https://www.saetasvinid.is/" scores 0.00 with no signals at all, so chefAgent
  // — an eleven-phase state machine — was handed `fast` and told, in its own
  // prompt, "Max steps: 10 … Planning: skip … Keep the answer direct." It ran
  // recon, drafted the menu, produced 4 recipe cards for 18 dishes, left
  // overview/profile/pairings/allergens/notes empty and stopped at 10.7 minutes
  // of a 30-minute window. Nothing cut it off; it was told to be brief.
  //
  // The perverse part is that the same agent did the complete job when its brief
  // was WORSE: a planner-rewritten goal starting "Zaprojektuj…" tripped
  // `complex_keyword` and bought the depth by accident. Fidelity to the user cost
  // the run its budget, which is exactly backwards.
  //
  // So the floor comes from what the agent IS, not from how its task was worded.
  // `PIPELINE_PHASE_TOOLS` already declares which agents walk a multi-phase state
  // machine — the same map the tool channeling uses — so there is no second list
  // to keep in sync.
  //
  // Deliberately `standard`, not `deep`. `deep` additionally installs the generic
  // GoalContract whose first planned step is "Clarify the objective, constraints
  // and success criteria" — unsatisfiable in a run with nobody to ask, measured
  // burning two full 30-minute windows on twelve consecutive "NOT COMPLETE
  // (replan)" evaluations. A raise, never a lowering: a prompt that genuinely
  // classifies deep or critical keeps it.
  if (
    isPipelineAgent(input.agentId)
    && DEPTH_ORDER[level] < DEPTH_ORDER.standard
    && isHarnessFeatureEnabled('FEATURE_PIPELINE_DEPTH_FLOOR', true)
  ) {
    signals.push({
      name: 'pipeline_depth_floor',
      delta: LEVEL_SCORE_FLOOR.standard - score,
      matched: input.agentId,
    });
    level = 'standard';
    score = Math.max(score, LEVEL_SCORE_FLOOR.standard);
  }

  return {
    level,
    score,
    profile: profileForAgent(level, input.agentId),
    signals,
  };
}

/**
 * Get the DepthProfile for a given level.
 */
export function getDepthProfile(level: DepthLevel, agentId?: string): DepthProfile {
  return profileForAgent(level, agentId);
}

/**
 * Automation Architect receives authority from the current user request (or the
 * exact delegated brief that carries that request). It has no interactive
 * operator inside a durable job, so the generic critical-depth approval pass is
 * not a usable safety boundary for this agent: it can only create an orphaned
 * dashboard approval and stop. The architect's deterministic ownership,
 * validation, credential, forbidden-node and risk=block gates remain in force.
 */
function profileForAgent(level: DepthLevel, agentId?: string): DepthProfile {
  const profile = { ...DEPTH_PROFILES[level] };
  if (canonicalizeRuntimeAgentId(agentId) === AUTOMATION_ARCHITECT_AGENT_ID) {
    profile.requireApproval = false;
  }
  return profile;
}

// ── Run-scoped depth state ───────────────────────────────────────────────────

const _runDepths = new Map<string, DepthLevel>();

/**
 * Store the classified depth for a run.
 */
export function setRunDepth(runId: string, level: DepthLevel): void {
  _runDepths.set(runId, level);
}

/**
 * Get the current depth for a run.
 */
export function getRunDepth(runId: string): DepthLevel | undefined {
  return _runDepths.get(runId);
}

/**
 * Upgrade depth for a run (only upward, never downward).
 * Returns true if the upgrade was applied, false if already at or above target.
 */
export function upgradeRunDepth(
  runId: string,
  targetLevel: DepthLevel,
  reason: string,
  agentId?: string,
): boolean {
  const current = _runDepths.get(runId);
  if (!current) return false;

  if (DEPTH_ORDER[targetLevel] <= DEPTH_ORDER[current]) {
    return false; // Already at or above target
  }

  _runDepths.set(runId, targetLevel);

  const newProfile = DEPTH_PROFILES[targetLevel];

  // Dynamically extend run-budget deadline & limits so the running harness watchdog does not abort prematurely
  upgradeRunDeadline(runId, newProfile.timeoutMs, {
    idleTimeoutMs: newProfile.idleTimeoutMs,
    hardCapMs: newProfile.hardCapMs,
  });

  console.warn(
    `[DepthController] 📈 UPGRADED run ${runId.slice(0, 8)}: ${current} → ${targetLevel} (${reason})`,
  );

  // Fire-and-forget telemetry
  logHarnessEvent({
    type: 'depth_upgraded' as any,
    agentId: agentId ?? 'unknown',
    runId,
    status: 'success',
    data: {
      previousLevel: current,
      newLevel: targetLevel,
      reason,
      newMaxSteps: newProfile.maxSteps,
    },
  }).catch(() => { /* non-critical */ });

  return true;
}

/**
 * Get the current effective DepthProfile for a run (may have been upgraded).
 */
export function getEffectiveProfile(runId: string, agentId?: string): DepthProfile {
  const level = _runDepths.get(runId) ?? 'deep';
  return profileForAgent(level, agentId);
}

/**
 * Clean up after run completes.
 */
export function disposeRunDepth(runId: string): void {
  _runDepths.delete(runId);
}
