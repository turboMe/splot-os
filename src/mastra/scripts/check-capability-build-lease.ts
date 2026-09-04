#!/usr/bin/env tsx
/**
 * F6 work item 3 — capability BUILD: renewed lease, fence, one-time permit.
 *
 * The build's dangerous moments are `git merge` into the live repo and `promote`,
 * which switches what serves :4111. Everything here is about those two being
 * impossible to reach without still holding the right to do them:
 *
 *  1. **The lease is renewed.** It was taken once with a 20-minute TTL and never
 *     re-asserted, while `cleanupExpired` DELETES an expired lock. A build is a
 *     delegation plus `npm run check:all` inside a worktree — routinely longer
 *     than that — so the lock silently vanished mid-build and a second build
 *     could acquire `repo:src/mastra/**` and merge into the same repo.
 *  2. **There is a fence at the point of use.** Renewal narrows the window; it
 *     does not close it. Merge and promote now ask the DATABASE whether this lane
 *     still holds the claim, instead of trusting a variable set twenty minutes
 *     earlier. Two green builds merging one repo is silent — nothing errors.
 *  3. **The permit is spent, not read.** `checkApproval` only asked whether a
 *     token said `approved`, and nothing marked it used, so one human approval
 *     could promote any number of times, for any number of commits, forever.
 *  4. **A dead build stops looking alive.** `void runCapabilityBuild(...)` left
 *     rows `running` for a process that no longer existed.
 *
 * The lease assertions run against the REAL claim store, because the bug being
 * fixed lives in the interaction between renewal, expiry and cleanup — a fake
 * lock would only re-test my idea of it.
 *
 * Run: npx tsx src/mastra/scripts/check-capability-build-lease.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  acquireClaims,
  claimsStillHeld,
  releaseClaims,
  renewClaims,
  isSchedulerEnabled,
} from '../services/task-ledger-scheduler.js';
import {
  markStaleCapabilityBuilds,
  runCapabilityBuild,
  runCommandInProcessGroup,
  CAPABILITY_BUILDS_COLLECTION,
  type CapabilityBuildDeps,
} from '../services/capability-build.js';
import { putArtifact } from '../services/artifact-store.js';
import { getDb } from '../lib/mongo.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const TAG = `chk-buildlease-${Date.now()}`;
const LOCKS = 'claim_locks';

console.log('check:capability-build-lease');

if (!isSchedulerEnabled()) {
  console.log('  ⚠ SKIP — FEATURE_LEDGER_SCHEDULER is off, so there are no leases to test');
  process.exit(0);
}

const db = await getDb();

// ── 1. The lease behaves like a lease ──────────────────────────────────────
await check('renewal extends only MY lock, and reports that I still hold it', async () => {
  const laneId = `${TAG}-a`;
  const claim = `repo:${TAG}/a/**`;
  assert.ok((await acquireClaims({ laneId, laneNo: 1, claims: [claim], ttlMs: 5_000 })).acquired);
  const before = await db.collection(LOCKS).findOne({ claim });
  const renewed = await renewClaims({ laneId, claims: [claim], ttlMs: 60_000 });
  const after = await db.collection(LOCKS).findOne({ claim });
  assert.equal(renewed.held, true);
  assert.deepEqual(renewed.lost, []);
  assert.ok(
    new Date(after!.expiresAt).getTime() > new Date(before!.expiresAt).getTime(),
    'the lease must actually move forward, or a long build still loses it',
  );
  await releaseClaims(laneId);
});

await check('SECURITY: renewal cannot create a lock, nor steal one', async () => {
  // Ownership is in the FILTER, not the update. If it were in the update, a lane
  // that lost its lock could renew its way back into ownership of a resource
  // somebody else is holding — and then merge.
  const mine = `${TAG}-b`;
  const theirs = `${TAG}-c`;
  const claim = `repo:${TAG}/b/**`;
  await acquireClaims({ laneId: theirs, laneNo: 2, claims: [claim], ttlMs: 60_000 });
  const renewed = await renewClaims({ laneId: mine, claims: [claim] });
  assert.equal(renewed.held, false, 'a lane that does not hold it must be told so');
  assert.deepEqual(renewed.lost, [claim]);
  const lock = await db.collection(LOCKS).findOne({ claim });
  assert.equal(lock?.laneId, theirs, 'and the real holder must be untouched');

  const unheld = `repo:${TAG}/nonexistent/**`;
  assert.equal((await renewClaims({ laneId: mine, claims: [unheld] })).held, false);
  assert.equal(await db.collection(LOCKS).countDocuments({ claim: unheld }), 0,
    'renewal must never conjure a lock into existence');
  await releaseClaims(theirs);
});

await check('LIVE REGRESSION: an unrenewed lease expires and the fence notices', async () => {
  // This is the actual pre-F6 build: acquire once, work longer than the TTL.
  const laneId = `${TAG}-d`;
  const claim = `repo:${TAG}/d/**`;
  await acquireClaims({ laneId, laneNo: 3, claims: [claim], ttlMs: 250 });
  assert.equal(await claimsStillHeld(laneId, [claim]), true, 'held while fresh');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await claimsStillHeld(laneId, [claim]), false,
    'an expired lock is gone — the old code would have merged here believing it held the repo');
  await releaseClaims(laneId);
});

await check('a renewed lease survives past its original expiry', async () => {
  const laneId = `${TAG}-e`;
  const claim = `repo:${TAG}/e/**`;
  await acquireClaims({ laneId, laneNo: 4, claims: [claim], ttlMs: 300 });
  await new Promise((r) => setTimeout(r, 150));
  await renewClaims({ laneId, claims: [claim], ttlMs: 10_000 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await claimsStillHeld(laneId, [claim]), true,
    'the renewal tick is what lets a build outlive one TTL');
  await releaseClaims(laneId);
});

await check('the fence is per-lane, not per-claim', async () => {
  const holder = `${TAG}-f`;
  const other = `${TAG}-g`;
  const claim = `repo:${TAG}/f/**`;
  await acquireClaims({ laneId: holder, laneNo: 5, claims: [claim], ttlMs: 60_000 });
  assert.equal(await claimsStillHeld(holder, [claim]), true);
  assert.equal(await claimsStillHeld(other, [claim]), false,
    '"somebody holds it" is not the question the fence asks');
  await releaseClaims(holder);
});

// ── 2. The build refuses to merge or promote without the lock ──────────────
const specArtifact = await putArtifact({
  type: 'action_plan',
  producedBy: TAG,
  content: [
    '## Goal', `Add an echo tool for ${TAG} testing purposes.`,
    '## IO Contract', 'input: { text: string } → output: { echoed: string }',
    '## Integration Point', 'src/mastra/tools/system',
    '## Test Plan', 'unit test asserting the echoed text matches the input text',
  ].join('\n\n'),
});

/**
 * `realApproval` leaves `consumeApproval` UNSTUBBED so the production CAS runs
 * against the real `approvals` collection.
 *
 * Not a convenience — the point. The first version of the permit tests stubbed
 * `consumeApproval` to return `'approved'`, which meant they asserted that my
 * fake returns what my fake returns; the one-time logic they were named after
 * never executed. Same shape as the `readResult` fake that hid an invalid
 * envelope one work item ago.
 */
function spyDeps(
  overrides: Partial<CapabilityBuildDeps> = {},
  opts: { realApproval?: boolean } = {},
): {
  deps: Partial<CapabilityBuildDeps>;
  calls: { merged: boolean; promoted: boolean; consumed: string[] };
} {
  const calls = { merged: false, promoted: false, consumed: [] as string[] };
  const deps: Partial<CapabilityBuildDeps> = {
    runDelegation: async () => ({ ok: true, branch: `${TAG}-branch`, worktreePath: `/tmp/${TAG}-wt` }),
    runCommand: async () => ({ ok: true, output: 'ok' }),
    mergeBranch: async () => { calls.merged = true; return { ok: true, commit: `commit-${TAG}` }; },
    consumeApproval: async (token) => { calls.consumed.push(token); return 'approved'; },
    promote: async () => { calls.promoted = true; return { ok: true, output: 'promoted' }; },
    ...overrides,
  };
  if (opts.realApproval) delete deps.consumeApproval;
  return { calls, deps };
}

await check('LIVE REGRESSION: a build that lost its repo lock does NOT merge', async () => {
  // The failure this whole step exists to prevent, and it is silent: two green
  // builds, two merges, one repo, nothing raised.
  const buildId = `${TAG}-lostlock`;
  const { deps, calls } = spyDeps({
    // The delegation is where the real build spends minutes. Steal the lock
    // during it, exactly as an expiry would.
    runDelegation: async (args) => {
      if (args.laneId) await releaseClaims(args.laneId);
      return { ok: true, branch: `${TAG}-branch`, worktreePath: `/tmp/${TAG}-wt` };
    },
  });
  const report = await runCapabilityBuild({ specArtifactId: specArtifact.id, buildId }, deps);
  assert.equal(calls.merged, false, 'merging without the repo lock is the thing that must not happen');
  assert.equal(report.status, 'failed');
  assert.match(report.error ?? '', /no longer holds|lost/i);
  const mergeStep = report.steps.find((s) => s.step === 'merge');
  assert.ok(mergeStep && !mergeStep.ok, 'and the refusal must be legible in the report');
});

await check('a build that keeps its lock still merges', async () => {
  // The fence must not be so eager that it blocks the normal path.
  const { deps, calls } = spyDeps();
  const report = await runCapabilityBuild(
    { specArtifactId: specArtifact.id, buildId: `${TAG}-happy` },
    deps,
  );
  assert.equal(report.status, 'completed', `expected completed, got ${report.status}: ${report.error}`);
  assert.equal(calls.merged, true);
});

// ── 3. The promote permit is spent, not read ───────────────────────────────
await check('LIVE REGRESSION: one approval token cannot promote twice', async () => {
  // Promotion switches what serves :4111. A permit that survives its use is not
  // a permit, it is a standing grant nobody agreed to.
  const token = `${TAG}-token`;
  await db.collection('approvals').insertOne({ id: token, status: 'approved' });
  const first = await runCapabilityBuild(
    { specArtifactId: specArtifact.id, buildId: `${TAG}-p1`, autoPromote: true, approvalToken: token },
    spyDeps({}, { realApproval: true }).deps,
  );
  assert.equal(first.status, 'completed', `first promote should succeed: ${first.error}`);

  const { deps, calls } = spyDeps({}, { realApproval: true });
  const second = await runCapabilityBuild(
    { specArtifactId: specArtifact.id, buildId: `${TAG}-p2`, autoPromote: true, approvalToken: token },
    deps,
  );
  assert.equal(calls.promoted, false, 'the SECOND promote must not run on a spent permit');
  assert.equal(second.status, 'blocked_needs_approval');
  assert.match(second.error ?? '', /already spent/);

  const approval = await db.collection('approvals').findOne({ id: token });
  assert.equal(approval?.promoteConsumedBy, `${TAG}-p1`,
    'the permit must record WHICH build spent it');
  assert.ok(approval?.promoteConsumedCommit, 'and for which commit');
});

await check('the permit is spent BEFORE the switch, so a crashed promote cannot be replayed', async () => {
  const token = `${TAG}-token-crash`;
  await db.collection('approvals').insertOne({ id: token, status: 'approved' });
  const { deps } = spyDeps(
    { promote: async () => ({ ok: false, output: 'slot-b failed to boot' }) },
    { realApproval: true },
  );
  const report = await runCapabilityBuild(
    { specArtifactId: specArtifact.id, buildId: `${TAG}-p3`, autoPromote: true, approvalToken: token },
    deps,
  );
  assert.equal(report.status, 'blocked_needs_approval');
  const approval = await db.collection('approvals').findOne({ id: token });
  assert.equal(approval?.promoteConsumedBy, `${TAG}-p3`,
    'a failed promote still spent the permit — a retry needs a human to look first');
});

// ── 4. The command runs in its own process group and dies with it ──────────
await check('LIVE: a timed-out command kills its whole TREE, not just bash', async () => {
  // `execFile`'s timeout signalled the direct child only. The command here is
  // `npm run check:all`: npm spawns node, node spawns tsx, tsx spawns dozens of
  // scripts. Killing bash left that tree running — holding the worktree, CPU and
  // Mongo connections, invisible to the build that gave up on it, so the next
  // build competed with the ghost of the last one.
  //
  // A real grandchild, a real timeout, and a real check that the grandchild is
  // gone: this is the one claim that cannot be argued, only observed.
  const marker = `${TAG}-tree-${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  const outcome = await runCommandInProcessGroup(
    // bash -> sleep(child) -> a second bash holding its own sleep(grandchild)
    `sleep 120 & bash -c 'sleep 120 # ${marker}' & wait`,
    '/tmp',
    { timeoutMs: 600, graceMs: 200 },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /timed out/);
  assert.ok(Date.now() - started < 30_000, 'the call must return at the timeout, not at sleep 120');

  // Give SIGKILL a moment, then look for survivors by the marker.
  await new Promise((r) => setTimeout(r, 1_000));
  const survivors = await new Promise<string>((resolve) => {
    const ps = spawn('bash', ['-lc', `pgrep -fa ${marker} || true`]);
    let out = '';
    ps.stdout.on('data', (c) => { out += String(c); });
    ps.on('close', () => resolve(out));
  });
  // pgrep matches its own bash -lc line, so only count real leftovers.
  const leftovers = survivors.split('\n')
    .filter((l) => l.includes(marker) && !l.includes('pgrep'))
    .filter((l) => l.trim().length > 0);
  assert.deepEqual(leftovers, [], `the process tree outlived its build:\n${survivors}`);
});

// ── 5. A dead build stops looking alive ────────────────────────────────────
await check('a build whose process died is swept to failed, not left running forever', async () => {
  const buildId = `${TAG}-zombie`;
  await db.collection(CAPABILITY_BUILDS_COLLECTION).insertOne({
    buildId, status: 'running', steps: [],
    lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  assert.ok(await markStaleCapabilityBuilds() >= 1);
  const row = await db.collection(CAPABILITY_BUILDS_COLLECTION).findOne({ buildId });
  assert.equal(row?.status, 'failed');
  assert.match(String(row?.error), /stopped reporting/);
  assert.match(String(row?.error), /no merge or promote happened/,
    'the operator must be told the repo was not touched');
});

await check('a build that is still heartbeating is left alone', async () => {
  const buildId = `${TAG}-alive`;
  await db.collection(CAPABILITY_BUILDS_COLLECTION).insertOne({
    buildId, status: 'running', steps: [], lastHeartbeatAt: new Date(), updatedAt: new Date(),
  });
  await markStaleCapabilityBuilds();
  assert.equal((await db.collection(CAPABILITY_BUILDS_COLLECTION).findOne({ buildId }))?.status, 'running');
});

await check('a pre-heartbeat row is swept on its own evidence, not treated as eternally fresh', async () => {
  const buildId = `${TAG}-legacy`;
  await db.collection(CAPABILITY_BUILDS_COLLECTION).insertOne({
    buildId, status: 'running', steps: [], updatedAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  await markStaleCapabilityBuilds();
  assert.equal((await db.collection(CAPABILITY_BUILDS_COLLECTION).findOne({ buildId }))?.status, 'failed');
});

// ── cleanup ────────────────────────────────────────────────────────────────
await db.collection(LOCKS).deleteMany({ claim: { $regex: TAG } });
await db.collection(LOCKS).deleteMany({ laneId: { $regex: TAG } });
await db.collection('approvals').deleteMany({ id: { $regex: TAG } });
await db.collection(CAPABILITY_BUILDS_COLLECTION).deleteMany({ buildId: { $regex: TAG } });
await db.collection('artifacts').deleteMany({ producedBy: TAG });
await db.collection('capabilities').deleteMany({ description: { $regex: TAG } }).catch(() => undefined);
// Same omission as `check-capability-build-gates`: the build path records a
// distillation candidate on success, and this list never learned about it.
await db.collection('distillation_candidates')
  .deleteMany({ goal: { $regex: TAG } }).catch(() => undefined);

console.log(failures === 0 ? '\n✅ check:capability-build-lease passed' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
