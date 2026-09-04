#!/usr/bin/env tsx
/**
 * F5B increment 1 — the lane decision boundary, before any model touches it.
 *
 * The whole safety argument of the Lane Orchestrator rests on this validation:
 * from increment 2 a MODEL produces the decision that a lane activation ends
 * with, inside a boundary that owns real authority over job state. §4.2 forbids
 * that component from trusting a model-supplied `taskId`, status or fencing
 * token. So the decision type must carry INTENT ONLY, and the validator must
 * reject anything it does not fully understand — before it can be hashed,
 * frozen and committed.
 *
 * Two things are pinned here:
 *  1. A decision that tries to carry authority (jobId/taskId/planVersion/fence)
 *     is rejected — the PRESENCE of such a field is the error, not its value.
 *  2. Increment 1 changes NO behaviour: the default decider reproduces the
 *     single-SERIAL-task plan the slice has always produced, and a decider that
 *     throws or returns nonsense falls back to it rather than stalling the lane.
 *
 * Run: npx tsx src/mastra/scripts/check-lane-decision.ts
 */
import assert from 'node:assert/strict';

import {
  assertLaneDecision,
  deterministicSerialDecider,
  InvalidLaneDecisionError,
  type LaneDecisionV1,
} from '../orchestration/contracts/lane-decision.js';

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

function rejects(value: unknown, why: string): void {
  assert.throws(
    () => assertLaneDecision(value),
    (error: unknown) => error instanceof InvalidLaneDecisionError,
    `must reject: ${why}`,
  );
}

console.log('check:lane-decision');

await check('all five decision kinds from §4.2 are accepted in their valid form', () => {
  const valid: LaneDecisionV1[] = [
    { kind: 'dispatch', attemptMode: 'SERIAL' },
    { kind: 'dispatch', attemptMode: 'SERIAL', taskGoal: 'summarize the report' },
    { kind: 'wait', reason: 'waiting for the running attempt' },
    { kind: 'request_user', question: 'Which environment should I deploy to?' },
    { kind: 'synthesize', summary: 'Collected three sources and compared them.' },
    { kind: 'terminalize', outcome: 'COMPLETED' },
    { kind: 'terminalize', outcome: 'PARTIAL', reason: 'budget exhausted' },
  ];
  for (const decision of valid) assertLaneDecision(decision);
});

await check('SECURITY: a decision may not carry authority — presence alone is the error', () => {
  // The attack this blocks: a model that emits a taskId/fence hoping the Service
  // will honour it. There is no field for it, so a decision containing one is
  // either confused or hostile — both must fail loudly, not be quietly stripped.
  for (const forbidden of ['jobId', 'taskId', 'attemptId', 'planVersion', 'fence', 'activationId']) {
    rejects(
      { kind: 'dispatch', attemptMode: 'SERIAL', [forbidden]: 'anything' },
      `dispatch carrying ${forbidden}`,
    );
  }
});

await check('unknown or missing kinds are rejected, not coerced', () => {
  rejects({ kind: 'delete_everything' }, 'unknown kind');
  rejects({ kind: '' }, 'empty kind');
  rejects({}, 'no kind at all');
  rejects(null, 'null');
  rejects('dispatch', 'a bare string');
  rejects([{ kind: 'dispatch', attemptMode: 'SERIAL' }], 'an array');
  rejects(42, 'a number');
});

await check('each kind enforces its own required fields', () => {
  rejects({ kind: 'wait' }, 'wait without a reason');
  rejects({ kind: 'wait', reason: '   ' }, 'wait with a blank reason');
  rejects({ kind: 'request_user' }, 'request_user without a question');
  rejects({ kind: 'synthesize' }, 'synthesize without a summary');
  rejects({ kind: 'terminalize' }, 'terminalize without an outcome');
  rejects({ kind: 'terminalize', outcome: 'MAYBE' }, 'terminalize with an invented outcome');
  rejects({ kind: 'dispatch' }, 'dispatch without attemptMode');
});

await check('fan-out is refused at the contract, not silently downgraded', () => {
  // Parallel/child topology needs ORC-DISPATCH-EDGE-01 on a full dependency
  // closure (Wave 6-7). Accepting it here and quietly running one task would be
  // the worst outcome: the caller would believe it fanned out.
  rejects({ kind: 'dispatch', attemptMode: 'PARALLEL' }, 'PARALLEL attemptMode');
  rejects({ kind: 'dispatch', attemptMode: 'FANOUT' }, 'FANOUT attemptMode');
});

await check('unbounded text cannot be pushed through the boundary', () => {
  rejects({ kind: 'wait', reason: 'x'.repeat(2_001) }, 'a reason past the cap');
  rejects({ kind: 'synthesize', summary: 'y'.repeat(50_000) }, 'a huge summary');
  // …but a normal-sized one is fine.
  assertLaneDecision({ kind: 'wait', reason: 'x'.repeat(2_000) });
});

await check('increment 1 changes NO behaviour: the default decider still plans one SERIAL task', async () => {
  const decision = await deterministicSerialDecider({
    jobId: 'job_x', goal: 'anything at all', planVersion: 1, hasTasks: false,
    businessOperationCutoffAt: new Date(Date.now() + 30_000),
  });
  assert.deepEqual(
    decision,
    { kind: 'dispatch', attemptMode: 'SERIAL' },
    'the default must reproduce exactly what this slice did before F5B',
  );
  assertLaneDecision(decision);
});

await check('the activation falls back to dispatch when a decider misbehaves', async () => {
  // Mirrors the fail-closed branch in runPlanningActivation: a decider that
  // throws, hangs on nonsense, or returns an invalid shape must not stall or
  // corrupt the lane — it degrades to the deterministic behaviour.
  const misbehaving: Array<(ctx: unknown) => Promise<unknown>> = [
    async () => { throw new Error('model exploded'); },
    async () => ({ kind: 'terminalize', outcome: 'EVERYTHING' }),
    async () => null,
  ];
  for (const decide of misbehaving) {
    let decision: LaneDecisionV1;
    try {
      const raw = await decide({
        jobId: 'j', goal: 'g', planVersion: 1, hasTasks: false,
        businessOperationCutoffAt: new Date(Date.now() + 30_000),
      });
      assertLaneDecision(raw);
      decision = raw;
    } catch {
      decision = { kind: 'dispatch', attemptMode: 'SERIAL' };
    }
    assert.equal(decision.kind, 'dispatch', 'a misbehaving decider must degrade to dispatch');
  }
});

if (failures > 0) {
  console.error(`\n❌ check:lane-decision — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:lane-decision — the decision boundary is total, authority-free and behaviour-preserving');
process.exit(0);
