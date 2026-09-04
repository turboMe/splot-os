/**
 * Capability Build — the BUILD half of the Capability Gap Protocol (Etap 7).
 *
 * CGP promises the system either FINDS a capability (mcp_discover → sandbox →
 * approve → attach, already shipped) or BUILDS one. This is the build path.
 *
 * It deliberately owns no new machinery: every step is an existing piece that
 * until now nothing sequenced.
 *
 *   1. SPEC GATE     — artifact-store (E3): the spec must name a goal, an I/O
 *                      contract, an integration point and a test plan. Anything
 *                      missing stops here rather than sending a coding agent off
 *                      to guess.
 *   2. LANE + CLAIMS — task-ledger (E1) + claims scheduler (E5), claiming
 *                      `repo:src/mastra/**` so two builds cannot interleave edits.
 *   3. DELEGATE      — codingAgent works in its own git worktree; the write guard
 *                      in code-workspace makes writing to the live repo impossible.
 *   4. QUALITY GATE  — `npx tsc --noEmit` AND `npm run check:all`, run INSIDE the
 *                      worktree. Red gate ⇒ no merge, no promote, ever.
 *   5. MERGE         — only after green. A conflict is a human decision, not a
 *                      thing to resolve automatically.
 *   6. PROMOTE       — OFF by default. Switching what runs on :4111 needs an
 *                      approved approvals doc; self-approval is impossible.
 *   7. REGISTER      — Capability Registry entry ('built' + tier 'shadow'), gap
 *                      closed, distillation candidate recorded (E6).
 *
 * Every executor is injectable so `check:capability-build-gates` can prove the
 * gates without an LLM, a worktree or a live slot — the same pattern E6 uses for
 * SkillWriter.
 */

import { randomUUID } from 'node:crypto';
import {
  runCommandInProcessGroup,
  mergeGuardedBranch,
  shellQuote,
  type CommandOutcome,
  type MergeOutcome,
} from './guarded-build-core.js';

import { getArtifact } from './artifact-store.js';
import {
  openLane,
  transitionLane,
  addLaneMilestone,
  isLedgerEnabled,
} from './task-ledger.js';
import {
  waitAndAcquireClaims,
  releaseClaims,
  renewClaims,
  claimsStillHeld,
  isSchedulerEnabled,
} from './task-ledger-scheduler.js';
import {
  recordBuiltCapability,
  resolveCapabilityGap,
  type CapabilityRecord,
} from './capability-registry.js';
import { getDb } from '../lib/mongo.js';
import type { PermitOutcome } from './one-time-permit.js';
import { consumeOneTimePermit } from './one-time-permit.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type BuildStepName =
  | 'spec_gate'
  | 'lane'
  | 'delegate'
  | 'quality_gate'
  | 'merge'
  | 'promote'
  | 'register';

export type BuildStatus = 'running' | 'completed' | 'failed' | 'blocked_needs_approval';

export type BuildStep = {
  step: BuildStepName;
  ok: boolean;
  note: string;
  ms?: number;
};

export type BuildReport = {
  buildId: string;
  status: BuildStatus;
  laneId?: string;
  branch?: string;
  worktreePath?: string;
  steps: BuildStep[];
  capabilityId?: string;
  mergedCommit?: string;
  approvalId?: string;
  error?: string;
  /** Written by the renewal tick; how `markStaleCapabilityBuilds` tells dead from slow. */
  lastHeartbeatAt?: Date;
};

/** The four things a spec must answer before any code gets written. */
export type BuildSpec = {
  goal: string;
  ioContract: string;
  integrationPoint: string;
  testPlan: string;
  toolName?: string;
};

export type SpecValidation =
  | { ok: true; spec: BuildSpec }
  | { ok: false; missing: string[] };

export type RunCapabilityBuildInput = {
  specArtifactId: string;
  gapId?: string;
  buildId?: string;
  /** Promote onto the live process. Requires an APPROVED approvals token. */
  autoPromote?: boolean;
  approvalToken?: string;
  /** Branch the worktree merges into. Defaults to the current checkout. */
  targetBranch?: string;
};

export type DelegationOutcome = {
  ok: boolean;
  branch?: string;
  worktreePath?: string;
  error?: string;
};

export type { CommandOutcome, MergeOutcome };

/** Injectable executors — real ones below, fakes in the check script. */
export type CapabilityBuildDeps = {
  runDelegation: (args: {
    buildId: string;
    specArtifactId: string;
    spec: BuildSpec;
    laneId?: string;
  }) => Promise<DelegationOutcome>;
  runCommand: (command: string, cwd: string) => Promise<CommandOutcome>;
  mergeBranch: (branch: string, targetBranch?: string) => Promise<MergeOutcome>;
  /**
   * CONSUME an approval permit, not merely read it.
   *
   * `checkApproval` only asked whether a token said `approved`, and nothing ever
   * marked it used — so one human approval could promote any number of times,
   * for any number of commits, forever. Promotion switches what serves :4111;
   * a permit that survives its use is not a permit, it is a standing grant
   * nobody agreed to. The exchange is a single atomic CAS, so two builds racing
   * on one token means exactly one promotes.
   */
  consumeApproval: (token: string, buildId: string, commit: string) => Promise<ApprovalOutcome>;
  promote: (commit: string) => Promise<CommandOutcome>;
};

/**
 * The build path's name for a permit outcome. Aliased rather than restated: the
 * two drifted the moment the merge gate added `wrong_task`, and a local copy of
 * a shared vocabulary is how one of them ends up missing a case.
 */
export type ApprovalOutcome = PermitOutcome;

// ── Spec gate ────────────────────────────────────────────────────────────────

const SPEC_FIELDS: Array<{ key: keyof BuildSpec; labels: string[]; min: number }> = [
  { key: 'goal', labels: ['goal', 'cel'], min: 10 },
  { key: 'ioContract', labels: ['iocontract', 'io contract', 'contract', 'kontrakt'], min: 10 },
  { key: 'integrationPoint', labels: ['integrationpoint', 'integration point', 'integracja'], min: 3 },
  { key: 'testPlan', labels: ['testplan', 'test plan', 'test', 'plan testu'], min: 10 },
];

/**
 * Accepts either a JSON object or a markdown spec with `## <field>` sections.
 * Markdown is allowed because that is what an agent naturally writes; the point
 * of the gate is that all four answers EXIST, not that they arrive as JSON.
 */
export function validateBuildSpec(raw: string): SpecValidation {
  const parsed = tryParseJson(raw);
  const fromJson = parsed ? readSpecFromObject(parsed) : {};
  const fromMarkdown = parsed ? {} : readSpecFromMarkdown(raw);
  const merged = { ...fromMarkdown, ...fromJson };

  const missing: string[] = [];
  for (const field of SPEC_FIELDS) {
    const value = merged[field.key];
    if (typeof value !== 'string' || value.trim().length < field.min) {
      missing.push(String(field.key));
    }
  }
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    spec: {
      goal: merged.goal!.trim(),
      ioContract: merged.ioContract!.trim(),
      integrationPoint: merged.integrationPoint!.trim(),
      testPlan: merged.testPlan!.trim(),
      toolName: typeof merged.toolName === 'string' ? merged.toolName.trim() : undefined,
    },
  };
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readSpecFromObject(obj: Record<string, unknown>): Partial<BuildSpec> {
  const out: Partial<BuildSpec> = {};
  for (const field of SPEC_FIELDS) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string') continue;
      if (field.labels.includes(normalizeLabel(key))) {
        out[field.key] = value;
        break;
      }
    }
  }
  if (typeof obj.toolName === 'string') out.toolName = obj.toolName;
  return out;
}

function readSpecFromMarkdown(raw: string): Partial<BuildSpec> {
  const out: Partial<BuildSpec> = {};
  // Split on markdown headings; a section runs until the next heading.
  const sections = raw.split(/^#{1,6}\s+/m).slice(1);
  for (const section of sections) {
    const newline = section.indexOf('\n');
    if (newline === -1) continue;
    const heading = normalizeLabel(section.slice(0, newline));
    const body = section.slice(newline + 1).trim();
    for (const field of SPEC_FIELDS) {
      if (out[field.key]) continue;
      if (field.labels.some((label) => heading.includes(label.replace(/\s+/g, '')))) {
        out[field.key] = body;
      }
    }
  }
  return out;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

// ── Real executors ───────────────────────────────────────────────────────────

export { runCommandInProcessGroup };

const realRunCommand = (command: string, cwd: string): Promise<CommandOutcome> =>
  runCommandInProcessGroup(command, cwd);

const realMergeBranch = (branch: string, targetBranch?: string): Promise<MergeOutcome> =>
  mergeGuardedBranch(branch, targetBranch, AGENTIC_AGENTS_REPO);

/**
 * Exchange an approval token for the right to promote ONCE.
 *
 * The guarantee lives in `consumeOneTimePermit` — claim and consumption in one
 * CAS — and is shared with the coding agent's merge gate, which needs exactly
 * the same property. The `promote` stamp prefix is preserved verbatim: it has
 * been written on every permit this path ever spent, and renaming it would
 * silently re-open all of them.
 */
async function realConsumeApproval(
  token: string,
  buildId: string,
  commit: string,
): Promise<ApprovalOutcome> {
  return consumeOneTimePermit({
    token,
    consumerId: buildId,
    subject: commit,
    stampPrefix: 'promote',
    // Durable field name, unchanged since this path shipped.
    subjectField: 'promoteConsumedCommit',
  });
}

// start-candidate must run before verify-candidate: build-candidate only
// materializes and compiles the slot, it starts no process. Without this step
// verify-candidate polls :4222 with nothing listening on it and always times
// out, so every real promotion would roll back on a perfectly good build.
// The tested orchestrator this mirrors already has this step; this hand-
// rolled duplicate of it had fallen out of sync and dropped it.
async function realPromote(commit: string): Promise<CommandOutcome> {
  const repo = AGENTIC_AGENTS_REPO;
  const steps = [
    `bash scripts/autoheal/build-candidate.sh ${shellQuote(commit)} slot-b`,
    'bash scripts/autoheal/start-candidate.sh slot-b 4222',
    'bash scripts/autoheal/verify-candidate.sh 4222',
    'bash scripts/autoheal/promote-candidate.sh slot-b',
    'bash scripts/autoheal/canary-watch.sh 4111 120',
  ];
  const log: string[] = [];
  for (const step of steps) {
    const result = await realRunCommand(step, repo);
    log.push(`$ ${step}\n${result.output}`);
    if (!result.ok) {
      const rollback = await realRunCommand('bash scripts/autoheal/rollback-to-stable.sh', repo);
      log.push(`$ rollback\n${rollback.output}`);
      return { ok: false, output: log.join('\n\n') };
    }
  }
  const mark = await realRunCommand(
    `bash scripts/autoheal/mark-promoted.sh ${shellQuote(commit)} slot-b`,
    repo,
  );
  log.push(`$ mark-promoted\n${mark.output}`);
  return { ok: true, output: log.join('\n\n') };
}

async function realRunDelegation(): Promise<DelegationOutcome> {
  // v1: the caller (capabilitySmith) delegates to codingAgent itself and passes
  // the finished branch back in. Wiring the delegation from inside this service
  // would make the build a single blocking call far longer than any request
  // budget — see ideas/timeouts-audit.md.
  return {
    ok: false,
    error:
      'runDelegation must be supplied: delegate to codingAgent first (async), then call ' +
      'the build with the resulting branch.',
  };
}

export const defaultCapabilityBuildDeps: CapabilityBuildDeps = {
  runDelegation: realRunDelegation,
  runCommand: realRunCommand,
  mergeBranch: realMergeBranch,
  consumeApproval: realConsumeApproval,
  promote: realPromote,
};

// ── Orchestration ────────────────────────────────────────────────────────────

const BUILD_CLAIMS = ['repo:src/mastra/**'];
/**
 * Renew well inside the lease TTL (20 min) so one missed tick — a slow Mongo, a
 * busy event loop — does not drop the lock. Also the heartbeat interval for the
 * durable report.
 */
const LEASE_RENEW_MS = 60_000;
/**
 * A build whose heartbeat is this old is not slow, it is gone: nothing else in
 * the pipeline pauses for four minutes without writing. Generous enough that a
 * long `check:all` never trips it, since the tick is independent of the work.
 */
const BUILD_STALE_AFTER_MS = 4 * LEASE_RENEW_MS;

export async function runCapabilityBuild(
  input: RunCapabilityBuildInput,
  deps: Partial<CapabilityBuildDeps> = {},
): Promise<BuildReport> {
  const executors: CapabilityBuildDeps = { ...defaultCapabilityBuildDeps, ...deps };
  const buildId = input.buildId ?? `build-${randomUUID()}`;
  const steps: BuildStep[] = [];
  const report: BuildReport = { buildId, status: 'failed', steps };

  const step = async <T>(
    name: BuildStepName,
    fn: () => Promise<{ ok: boolean; note: string; value?: T }>,
  ): Promise<{ ok: boolean; value?: T }> => {
    const startedAt = Date.now();
    const result = await fn();
    steps.push({ step: name, ok: result.ok, note: result.note, ms: Date.now() - startedAt });
    if (report.laneId) {
      await addLaneMilestone(report.laneId, `${name}: ${result.ok ? 'ok' : 'FAILED'} — ${result.note}`)
        .catch(() => {});
    }
    return { ok: result.ok, value: result.value };
  };

  // ── 1. SPEC GATE ───────────────────────────────────────────────────────────
  const specStep = await step<BuildSpec>('spec_gate', async () => {
    const artifact = await getArtifact(input.specArtifactId);
    if (!artifact) {
      return { ok: false, note: `spec artifact not found: ${input.specArtifactId}` };
    }
    if (!artifact.content) {
      return { ok: false, note: `spec artifact ${artifact.id} has no readable content` };
    }
    const validation = validateBuildSpec(artifact.content);
    if (!validation.ok) {
      return { ok: false, note: `spec incomplete — missing: ${validation.missing.join(', ')}` };
    }
    return { ok: true, note: `spec accepted (${validation.spec.goal.slice(0, 80)})`, value: validation.spec };
  });

  if (!specStep.ok || !specStep.value) {
    report.status = 'blocked_needs_approval';
    report.error = steps.at(-1)?.note;
    return report;
  }
  const spec = specStep.value;

  // ── 2. LANE + CLAIMS ───────────────────────────────────────────────────────
  let claimsHeld = false;
  let laneNo: number | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  /** Set by the renewal tick the moment this build stops owning the repo lock. */
  let leaseLost: string | null = null;

  /**
   * The fence. Called immediately before anything that changes the real repo or
   * the live process, and it asks the DATABASE rather than trusting the variable
   * set twenty minutes ago. Merging or promoting without the lock is the failure
   * this whole step exists to prevent, and it is silent: two green builds, two
   * merges, one repo.
   */
  const fence = async (action: string): Promise<string | null> => {
    if (!claimsHeld || !report.laneId) return null;
    if (leaseLost) return `${action} refused: this build lost ${leaseLost} while working`;
    const held = await claimsStillHeld(report.laneId, BUILD_CLAIMS).catch(() => false);
    return held ? null : `${action} refused: this build no longer holds ${BUILD_CLAIMS.join(', ')}`;
  };

  try {
    if (isLedgerEnabled()) {
      const lane = await openLane({
        source: 'manual',
        sourceId: buildId,
        goal: `capability build — ${spec.goal.slice(0, 120)}`,
        agentId: 'capabilitySmith',
        // Opened 'running', not 'queued': a queued lane cannot transition
        // straight to done/failed, and this build starts working immediately.
        state: 'running',
        claims: BUILD_CLAIMS,
      }).catch(() => null);
      report.laneId = lane?.laneId;
      laneNo = lane?.laneNo;
    }

    await step('lane', async () => {
      if (!report.laneId || laneNo === undefined) {
        return { ok: true, note: 'ledger disabled — running unlogged' };
      }
      if (!isSchedulerEnabled()) return { ok: true, note: `lane ${report.laneId}, claims disabled` };
      const acquired = await waitAndAcquireClaims({
        laneId: report.laneId,
        laneNo,
        claims: BUILD_CLAIMS,
        maxWaitMs: 10 * 60 * 1000,
      });
      claimsHeld = acquired.acquired;
      return acquired.acquired
        ? { ok: true, note: `lane ${report.laneId} holds ${BUILD_CLAIMS.join(', ')}` }
        : {
            ok: false,
            note: `claims busy: ${acquired.conflictClaim ?? 'unknown'} held by lane #${acquired.conflictLaneNo ?? '?'}`,
          };
    });

    if (steps.at(-1)?.ok === false) {
      report.status = 'failed';
      report.error = steps.at(-1)?.note;
      return report;
    }

    // ── LEASE RENEWAL ────────────────────────────────────────────────────────
    //
    // The claim was taken once, with a 20-minute TTL, and `cleanupExpired`
    // DELETES an expired lock. A build is a delegation plus `npm run check:all`
    // inside a worktree — routinely longer than that. So the lock quietly
    // vanished mid-build while this code carried on believing it held
    // `repo:src/mastra/**`, and the next build could acquire it and merge into
    // the same repo at the same time.
    //
    // The same tick also heartbeats the durable report, so a build killed by a
    // restart stops looking like a build that is still working. Before this,
    // `void runCapabilityBuild(...)` left rows `running` forever with nothing to
    // sweep them — automation at least had a staleness pass.
    if (claimsHeld && report.laneId) {
      renewal = setInterval(() => {
        void (async () => {
          const laneId = report.laneId!;
          const renewed = await renewClaims({ laneId, claims: BUILD_CLAIMS }).catch(
            () => ({ held: true, lost: [] as string[] }),
          );
          if (!renewed.held) {
            leaseLost = renewed.lost.join(', ') || BUILD_CLAIMS.join(', ');
            console.warn(`[CapabilityBuild] ${buildId} lost its repo lease: ${leaseLost}`);
          }
          await heartbeatBuild(buildId).catch(() => {});
        })();
      }, LEASE_RENEW_MS);
      renewal.unref?.();
    }

    // ── 3. DELEGATE ──────────────────────────────────────────────────────────
    const delegation = await step<DelegationOutcome>('delegate', async () => {
      const outcome = await executors.runDelegation({
        buildId,
        specArtifactId: input.specArtifactId,
        spec,
        laneId: report.laneId,
      });
      if (!outcome.ok || !outcome.branch || !outcome.worktreePath) {
        return { ok: false, note: outcome.error ?? 'delegation produced no branch/worktree' };
      }
      return { ok: true, note: `branch ${outcome.branch}`, value: outcome };
    });

    if (!delegation.ok || !delegation.value) {
      report.status = 'failed';
      report.error = steps.at(-1)?.note;
      return report;
    }
    report.branch = delegation.value.branch;
    report.worktreePath = delegation.value.worktreePath;

    // ── 4. QUALITY GATE ──────────────────────────────────────────────────────
    const gate = await step('quality_gate', async () => {
      const cwd = report.worktreePath!;
      const tsc = await executors.runCommand('npx tsc --noEmit', cwd);
      if (!tsc.ok) {
        return { ok: false, note: `tsc failed:\n${tail(tsc.output)}` };
      }
      const checks = await executors.runCommand('npm run check:all', cwd);
      if (!checks.ok) {
        return { ok: false, note: `check:all failed:\n${tail(checks.output)}` };
      }
      return { ok: true, note: 'tsc clean + check:all green' };
    });

    if (!gate.ok) {
      report.status = 'failed';
      report.error = steps.at(-1)?.note;
      return report;
    }

    // ── 5. MERGE ─────────────────────────────────────────────────────────────
    const merge = await step<MergeOutcome>('merge', async () => {
      const lost = await fence('merge');
      if (lost) return { ok: false, note: lost };
      const outcome = await executors.mergeBranch(report.branch!, input.targetBranch);
      if (!outcome.ok) {
        return {
          ok: false,
          note: outcome.conflict
            ? `merge conflict on ${report.branch} — needs a human`
            : `merge failed: ${outcome.error ?? 'unknown'}`,
          value: outcome,
        };
      }
      return { ok: true, note: `merged as ${outcome.commit?.slice(0, 8) ?? 'unknown'}`, value: outcome };
    });

    if (!merge.ok) {
      report.status = merge.value?.conflict ? 'blocked_needs_approval' : 'failed';
      report.error = steps.at(-1)?.note;
      return report;
    }
    report.mergedCommit = merge.value?.commit;

    // ── 6. PROMOTE (opt-in, human-approved) ──────────────────────────────────
    if (input.autoPromote) {
      const promote = await step('promote', async () => {
        if (!input.approvalToken) {
          return { ok: false, note: 'promote requested without an approval token' };
        }
        const lost = await fence('promote');
        if (lost) return { ok: false, note: lost };
        // The permit is SPENT here, before the switch, not merely inspected —
        // see `consumeApproval`. Spending it before promoting rather than after
        // is deliberate: a promote that crashes half way must not leave a permit
        // that still looks unused.
        const status = await executors.consumeApproval(
          input.approvalToken,
          buildId,
          report.mergedCommit!,
        );
        if (status !== 'approved') {
          return {
            ok: false,
            note: status === 'already_used'
              ? `approval ${input.approvalToken} was already spent by an earlier promote — a new human approval is required`
              : `approval ${input.approvalToken} is '${status}' — a human must approve first`,
          };
        }
        const result = await executors.promote(report.mergedCommit!);
        return result.ok
          ? { ok: true, note: 'promoted; canary clean' }
          : { ok: false, note: `promote failed, rolled back:\n${tail(result.output)}` };
      });

      if (!promote.ok) {
        // The code is merged and green; only the live switch failed. Say exactly
        // that instead of reporting the whole build as a failure.
        report.status = 'blocked_needs_approval';
        report.error = steps.at(-1)?.note;
        report.approvalId = input.approvalToken;
        await registerCapability(report, spec, input.gapId);
        return report;
      }
    }

    // ── 7. REGISTER ──────────────────────────────────────────────────────────
    await step('register', async () => {
      const capability = await registerCapability(report, spec, input.gapId);
      return capability
        ? { ok: true, note: `capability ${capability.capabilityId} recorded (built/shadow)` }
        : { ok: false, note: 'registry write failed (build itself succeeded)' };
    });

    report.status = 'completed';
    return report;
  } finally {
    if (renewal) clearInterval(renewal);
    if (claimsHeld && report.laneId) {
      await releaseClaims(report.laneId).catch(() => {});
    }
    if (report.laneId) {
      const finalState =
        report.status === 'completed' ? 'done'
        : report.status === 'blocked_needs_approval' ? 'awaiting_approval'
        : 'failed';
      await transitionLane(report.laneId, finalState, {
        error: report.error?.slice(0, 300),
        milestone: `build ${report.status}`,
      }).catch(() => {});
    }
  }
}

async function registerCapability(
  report: BuildReport,
  spec: BuildSpec,
  gapId?: string,
): Promise<CapabilityRecord | null> {
  try {
    const capability = await recordBuiltCapability({
      name: spec.toolName ?? `built/${report.buildId}`,
      description: spec.goal.slice(0, 500),
      gapDescription: gapId ? `gap ${gapId}` : undefined,
      repositoryUrl: report.mergedCommit,
    });
    report.capabilityId = capability.capabilityId;
    if (gapId) await resolveCapabilityGap(gapId, capability.capabilityId);
    await recordBuildDistillation(report, spec);
    return capability;
  } catch (err) {
    console.warn('[CapabilityBuild] registry write failed:', (err as Error).message);
    return null;
  }
}

/**
 * Feed E6 so a successful build becomes a reusable skill ("how we added a tool")
 * rather than tribal knowledge. Fail-soft by design.
 */
async function recordBuildDistillation(report: BuildReport, spec: BuildSpec): Promise<void> {
  if (!isHarnessFeatureEnabled('FEATURE_SKILL_DISTILLATION', true)) return;
  try {
    const { recordDistillationCandidate } = await import('./skill-distiller.js');
    await recordDistillationCandidate({
      agentId: 'capabilitySmith',
      taskId: report.buildId,
      goal: `Built capability: ${spec.goal.slice(0, 200)}`,
      // A build is a multi-step recovery-prone procedure; mark it as such so the
      // distiller's threshold sees it as worth turning into a skill.
      toolCallCount: report.steps.length,
      lessons: [
        `Integration point: ${spec.integrationPoint}`,
        `Test plan: ${spec.testPlan}`,
        `Gate: tsc + check:all inside the worktree, merged as ${report.mergedCommit?.slice(0, 8) ?? 'n/a'}`,
      ],
      resultSummary: `capability ${report.capabilityId ?? 'n/a'} built via ${report.branch ?? 'n/a'}`,
    });
  } catch (err) {
    console.warn('[CapabilityBuild] distillation candidate skipped:', (err as Error).message);
  }
}

function tail(output: string, lines = 40): string {
  return output.split('\n').slice(-lines).join('\n');
}

// ── Detached runs ────────────────────────────────────────────────────────────
//
// The quality gate is `npm run check:all` — minutes, not seconds. A blocking
// tool call would outlive any request budget (see ideas/timeouts-audit.md: the
// deployer caps HTTP at 180s), so the tool starts the build and returns a
// buildId; progress lands in Mongo and is read back by capability_build_status.

export const CAPABILITY_BUILDS_COLLECTION = 'capability_builds';

export async function saveBuildReport(report: BuildReport): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<BuildReport & { updatedAt: Date }>(CAPABILITY_BUILDS_COLLECTION).updateOne(
      { buildId: report.buildId },
      { $set: { ...report, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[CapabilityBuild] report persist failed:', (err as Error).message);
  }
}

export async function getBuildReport(buildId: string): Promise<BuildReport | null> {
  const db = await getDb();
  return db.collection<BuildReport>(CAPABILITY_BUILDS_COLLECTION).findOne({ buildId });
}

/** Prove the build is still being worked on. Written by the renewal tick. */
async function heartbeatBuild(buildId: string): Promise<void> {
  const db = await getDb();
  await db.collection(CAPABILITY_BUILDS_COLLECTION).updateOne(
    { buildId, status: 'running' },
    { $set: { lastHeartbeatAt: new Date() } },
  );
}

/**
 * Close out builds whose process died.
 *
 * `void runCapabilityBuild(...)` is fire-and-forget, so a restart left rows
 * `running` forever — indistinguishable from a build still working, and each one
 * a phantom the operator has to reason about. The repo lock they held expires on
 * its own TTL; this closes the record so the two agree.
 *
 * `lastHeartbeatAt` missing means the row predates heartbeats, so `startedAt` is
 * the only evidence available and is used as the fallback rather than treating
 * an old row as eternally fresh.
 */
export async function markStaleCapabilityBuilds(
  opts: { staleAfterMs?: number } = {},
): Promise<number> {
  const cutoff = new Date(Date.now() - (opts.staleAfterMs ?? BUILD_STALE_AFTER_MS));
  const db = await getDb();
  const res = await db.collection<BuildReport & { lastHeartbeatAt?: Date; startedAt?: Date }>(
    CAPABILITY_BUILDS_COLLECTION,
  ).updateMany(
    {
      status: 'running',
      $or: [
        { lastHeartbeatAt: { $lt: cutoff } },
        { lastHeartbeatAt: { $exists: false }, updatedAt: { $lt: cutoff } },
      ],
    },
    {
      $set: {
        status: 'failed' as BuildStatus,
        error: 'build process stopped reporting (restart or crash); no merge or promote happened',
      },
    },
  );
  return res.modifiedCount;
}

/** Start a build in the background. Returns as soon as the record exists. */
export async function startCapabilityBuild(
  input: RunCapabilityBuildInput,
  deps: Partial<CapabilityBuildDeps> = {},
): Promise<{ buildId: string }> {
  const buildId = input.buildId ?? `build-${randomUUID()}`;
  // Heartbeat from the first moment, so a build that dies during the spec gate
  // or while waiting for claims is sweepable too — not only one that got as far
  // as starting the renewal tick.
  await saveBuildReport({ buildId, status: 'running', steps: [], lastHeartbeatAt: new Date() });

  void runCapabilityBuild({ ...input, buildId }, deps)
    .then((report) => saveBuildReport(report))
    .catch((err) =>
      saveBuildReport({
        buildId,
        status: 'failed',
        steps: [],
        error: `build threw: ${(err as Error).message}`,
      }),
    );

  return { buildId };
}
