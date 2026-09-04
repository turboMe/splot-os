#!/usr/bin/env tsx
/**
 * check:capability-build-gates — Etap 7, BUILD path.
 *
 * The build pipeline's whole value is that it REFUSES. Anyone can wire a
 * happy path; what makes it trustworthy is that a red gate cannot reach a merge
 * and a promote cannot happen without a human. These assertions prove the
 * refusals, deterministically — no LLM, no worktree, no live slots, because
 * every executor is injectable.
 *
 *   1. spec gate     — a spec missing any of goal / ioContract / integrationPoint
 *                      / testPlan is rejected BEFORE any code is written;
 *                      both markdown and JSON specs are understood.
 *   2. red tsc       — no merge, no promote.
 *   3. red check:all — no merge, no promote (and tsc having passed is not enough).
 *   4. conflict      — a merge conflict blocks for a human, never auto-resolves.
 *   5. promote gate  — refused without a token, with a missing token, and with a
 *                      PENDING token: self-approval is impossible.
 *   6. happy path    — green gate → merge → capability recorded 'built'/'shadow'
 *                      and the gap closed.
 */
import assert from 'node:assert/strict';

import { getDb } from '../lib/mongo.js';
import { putArtifact } from '../services/artifact-store.js';
import {
  runCapabilityBuild,
  validateBuildSpec,
  type CapabilityBuildDeps,
} from '../services/capability-build.js';
import {
  recordCapabilityGap,
  getCapabilityGap,
  getCapability,
  CAPABILITIES_COLLECTION,
  GAPS_COLLECTION,
} from '../services/capability-registry.js';

const TAG = `build-check-${Date.now()}`;
let failures = 0;

function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures += 1; console.error(`  ✗ ${name}: ${(err as Error).message}`); });
}

const COMPLETE_SPEC = JSON.stringify({
  toolName: `${TAG}/echo`,
  goal: 'Expose an echo tool so agents can smoke-test the build pipeline end to end.',
  ioContract: 'input: { text: string } → output: { echoed: string }',
  integrationPoint: 'capabilitySmith toolset',
  testPlan: 'check:capability-build-echo asserts the tool returns its input verbatim.',
});

/** Executors that record what was attempted, so refusals are provable. */
function spyDeps(overrides: Partial<CapabilityBuildDeps> = {}): {
  deps: Partial<CapabilityBuildDeps>;
  calls: { commands: string[]; merged: boolean; promoted: boolean };
} {
  const calls = { commands: [] as string[], merged: false, promoted: false };
  const deps: Partial<CapabilityBuildDeps> = {
    runDelegation: async () => ({
      ok: true,
      branch: `${TAG}-branch`,
      worktreePath: `/tmp/${TAG}-worktree`,
    }),
    runCommand: async (command) => {
      calls.commands.push(command);
      return { ok: true, output: 'ok' };
    },
    mergeBranch: async () => {
      calls.merged = true;
      return { ok: true, commit: `commit-${TAG}` };
    },
    consumeApproval: async () => 'approved',
    promote: async () => {
      calls.promoted = true;
      return { ok: true, output: 'promoted' };
    },
    ...overrides,
  };
  return { deps, calls };
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection(CAPABILITIES_COLLECTION).deleteMany({ registryName: { $regex: TAG } }).catch(() => undefined);
  await db.collection(GAPS_COLLECTION).deleteMany({ description: { $regex: TAG } }).catch(() => undefined);
  await db.collection('artifacts').deleteMany({ producedBy: TAG }).catch(() => undefined);
  await db.collection('capability_builds').deleteMany({ buildId: { $regex: TAG } }).catch(() => undefined);
  // The build path records a skill-distillation candidate on success, and this
  // cleanup list predates that. Measured: 918 copies of this gate's own smoke-test
  // goal sitting in the production learning corpus — 71% of it — one per
  // `check:all` since the recording was added. A gate that teaches the system
  // about its own fixture is worse than a gate that leaves a stray row.
  await db.collection('distillation_candidates')
    .deleteMany({ goal: { $regex: 'smoke-test the build pipeline' } }).catch(() => undefined);
}

async function main(): Promise<void> {
  console.log('check:capability-build-gates');

  // ── 1. Spec gate ───────────────────────────────────────────────────────────
  await ok('spec gate: markdown spec with all four answers is accepted', () => {
    const result = validateBuildSpec([
      '# Goal',
      'Add an echo tool so the build pipeline can be smoke-tested.',
      '## IO contract',
      'input { text: string } → output { echoed: string }',
      '## Integration point',
      'capabilitySmith',
      '## Test plan',
      'check:capability-build-echo asserts the echo is verbatim.',
    ].join('\n'));
    assert.equal(result.ok, true, 'complete markdown spec should pass');
  });

  await ok('spec gate: JSON spec is accepted', () => {
    const result = validateBuildSpec(COMPLETE_SPEC);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.spec.integrationPoint, /capabilitySmith/);
  });

  await ok('spec gate: a spec WITHOUT a test plan is rejected by name', () => {
    const result = validateBuildSpec(JSON.stringify({
      goal: 'Add an echo tool for smoke-testing the pipeline.',
      ioContract: 'input { text } → output { echoed }',
      integrationPoint: 'capabilitySmith',
    }));
    assert.equal(result.ok, false, 'missing testPlan must fail');
    if (!result.ok) assert.ok(result.missing.includes('testPlan'), `missing should name testPlan, got ${result.missing.join(',')}`);
  });

  await ok('spec gate: prose that merely mentions the words is not a spec', () => {
    const result = validateBuildSpec('Our goal is a test plan for the io contract at the integration point.');
    assert.equal(result.ok, false, 'unstructured prose must not pass as a spec');
  });

  const incompleteArtifact = await putArtifact({
    type: 'action_plan',
    producedBy: TAG,
    content: JSON.stringify({ goal: 'Build something vague and unspecified for us.' }),
  });

  await ok('spec gate: incomplete spec blocks BEFORE any command runs', async () => {
    const { deps, calls } = spyDeps();
    const report = await runCapabilityBuild({ specArtifactId: incompleteArtifact.id }, deps);
    assert.equal(report.status, 'blocked_needs_approval');
    assert.equal(calls.commands.length, 0, 'no command may run on an incomplete spec');
    assert.equal(calls.merged, false, 'nothing may be merged');
    assert.match(report.error ?? '', /missing/i);
  });

  await ok('spec gate: a missing artifact blocks instead of throwing', async () => {
    const { deps } = spyDeps();
    const report = await runCapabilityBuild({ specArtifactId: `nope-${TAG}` }, deps);
    assert.equal(report.status, 'blocked_needs_approval');
    assert.match(report.error ?? '', /not found/i);
  });

  const specArtifact = await putArtifact({
    type: 'action_plan',
    producedBy: TAG,
    content: COMPLETE_SPEC,
  });

  // ── 2-3. Quality gate ──────────────────────────────────────────────────────
  await ok('red tsc: no merge, no promote', async () => {
    const { deps, calls } = spyDeps({
      runCommand: async (command) => {
        calls.commands.push(command);
        return command.includes('tsc')
          ? { ok: false, output: 'src/foo.ts(1,1): error TS2322' }
          : { ok: true, output: 'ok' };
      },
    });
    const report = await runCapabilityBuild(
      { specArtifactId: specArtifact.id, autoPromote: true, approvalToken: 'irrelevant' },
      deps,
    );
    assert.equal(report.status, 'failed');
    assert.equal(calls.merged, false, 'a red tsc must never reach merge');
    assert.equal(calls.promoted, false, 'a red tsc must never reach promote');
    assert.match(report.error ?? '', /tsc failed/);
  });

  await ok('red check:all: no merge, no promote (green tsc is not enough)', async () => {
    const { deps, calls } = spyDeps({
      runCommand: async (command) => {
        calls.commands.push(command);
        return command.includes('check:all')
          ? { ok: false, output: 'AssertionError: gate broke' }
          : { ok: true, output: 'ok' };
      },
    });
    const report = await runCapabilityBuild(
      { specArtifactId: specArtifact.id, autoPromote: true, approvalToken: 'irrelevant' },
      deps,
    );
    assert.equal(report.status, 'failed');
    assert.equal(calls.merged, false, 'a red check:all must never reach merge');
    assert.equal(calls.promoted, false);
    assert.match(report.error ?? '', /check:all failed/);
    assert.ok(
      calls.commands.some((c) => c.includes('tsc')) && calls.commands.some((c) => c.includes('check:all')),
      'both gate commands should have been attempted',
    );
  });

  // ── 4. Merge conflict ──────────────────────────────────────────────────────
  await ok('merge conflict blocks for a human and does not promote', async () => {
    const { deps, calls } = spyDeps({
      mergeBranch: async () => ({ ok: false, conflict: true, error: 'CONFLICT (content)' }),
    });
    const report = await runCapabilityBuild(
      { specArtifactId: specArtifact.id, autoPromote: true, approvalToken: 'irrelevant' },
      deps,
    );
    assert.equal(report.status, 'blocked_needs_approval');
    assert.equal(calls.promoted, false, 'a conflict must never reach promote');
    assert.match(report.error ?? '', /conflict/i);
  });

  // ── 5. Promote gate ────────────────────────────────────────────────────────
  await ok('promote without a token is refused (code still merged)', async () => {
    const { deps, calls } = spyDeps();
    const report = await runCapabilityBuild(
      { specArtifactId: specArtifact.id, autoPromote: true },
      deps,
    );
    assert.equal(calls.merged, true, 'the merge itself was legitimate');
    assert.equal(calls.promoted, false, 'promote must not run without a token');
    assert.equal(report.status, 'blocked_needs_approval');
  });

  for (const state of ['pending', 'missing', 'rejected'] as const) {
    await ok(`promote with a '${state}' approval is refused`, async () => {
      const { deps, calls } = spyDeps({ consumeApproval: async () => state });
      const report = await runCapabilityBuild(
        { specArtifactId: specArtifact.id, autoPromote: true, approvalToken: `token-${state}` },
        deps,
      );
      assert.equal(calls.promoted, false, `promote must not run on a ${state} approval`);
      assert.equal(report.status, 'blocked_needs_approval');
      assert.match(report.error ?? '', new RegExp(state));
    });
  }

  // ── 6. Happy path ──────────────────────────────────────────────────────────
  const gapId = await recordCapabilityGap({
    agentId: 'capabilitySmith',
    description: `no tool to echo text ${TAG}`,
  });

  await ok('green gate → merge → capability registered built/shadow → gap resolved', async () => {
    const { deps, calls } = spyDeps();
    const report = await runCapabilityBuild(
      { specArtifactId: specArtifact.id, gapId, buildId: `${TAG}-happy` },
      deps,
    );
    assert.equal(report.status, 'completed', `expected completed, got ${report.status}: ${report.error}`);
    assert.equal(calls.merged, true);
    assert.equal(calls.promoted, false, 'promote stays off unless explicitly requested');
    assert.ok(report.capabilityId, 'a capability should be registered');

    const capability = await getCapability(report.capabilityId!);
    assert.equal(capability?.status, 'built');
    assert.equal(capability?.tier, 'shadow', 'a built capability starts in shadow, never auto');
    assert.equal(capability?.source, 'manual');

    const gap = await getCapabilityGap(gapId!);
    assert.equal(gap?.status, 'resolved');
    assert.equal(gap?.resolvedByCapabilityId, report.capabilityId);

    const stepNames = report.steps.map((s) => s.step);
    assert.deepEqual(
      stepNames,
      ['spec_gate', 'lane', 'delegate', 'quality_gate', 'merge', 'register'],
      'the pipeline should report every step it ran, in order',
    );
  });

  await ok('promote runs only with an approved token', async () => {
    const { deps, calls } = spyDeps();
    const report = await runCapabilityBuild(
      { specArtifactId: specArtifact.id, autoPromote: true, approvalToken: `token-approved-${TAG}` },
      deps,
    );
    assert.equal(report.status, 'completed');
    assert.equal(calls.promoted, true, 'an approved token should let promote run');
  });

  await cleanup();

  if (failures > 0) {
    console.error(`\n❌ check:capability-build-gates — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:capability-build-gates — all assertions passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ crashed:', err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
