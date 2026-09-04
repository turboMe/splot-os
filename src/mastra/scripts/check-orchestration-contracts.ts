#!/usr/bin/env tsx
/**
 * check:orchestration-contracts — durable orchestration substrate, PR-1.
 *
 * Deterministic assertions on the Tier-1 contract layer (plan §15.7.1):
 *   - branded ids are server-minted, distinct, prefixed; adopt guards fail closed
 *   - strict result envelope (§9.1 / RES-001 / §3.6): empty, prose, malformed,
 *     unknown-status and non-envelope JSON are `invalid_result`, never `ok`
 *   - runtime binding cannot be overridden by producer content (§9.1 trust split)
 *   - execution-budget math + invariants (§10.1), incl. the dead 25/25 no-progress
 *     config (K8) and child-deadline clamp (K2–K4)
 */
import assert from 'node:assert/strict';
import {
  newJobId, newTaskId, newAttemptId, newRuntimeRunId, adoptId, adoptVersion,
  validateProducerResult, sealResultEnvelope, type RuntimeBinding, type ProducerResult,
  deriveAttemptDeadlines, deriveChildDeadline, validateBudgetInvariants,
} from '../orchestration/contracts/index.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:orchestration-contracts');

// --- ids -------------------------------------------------------------------

check('minted ids are distinct, prefixed, uuid-shaped', () => {
  const j = newJobId(), t = newTaskId(), a = newAttemptId(), r = newRuntimeRunId();
  assert.ok(j.startsWith('job_'), 'job prefix');
  assert.ok(t.startsWith('task_'), 'task prefix');
  assert.ok(a.startsWith('attempt_'), 'attempt prefix');
  assert.ok(r.startsWith('run_'), 'run prefix');
  // taskId is never runtimeRunId; two mints never collide
  assert.notEqual(String(a), String(r));
  assert.notEqual(String(newJobId()), String(newJobId()));
});

check('adoptId fails closed on empty identity (§5.2)', () => {
  assert.throws(() => adoptId('', 'ResourceId'));
  assert.throws(() => adoptId(undefined as unknown as string, 'ResourceId'));
  assert.equal(String(adoptId('res-abc', 'ResourceId')), 'res-abc');
});

check('adoptVersion rejects non-monotonic values', () => {
  assert.throws(() => adoptVersion(-1, 'PlanVersion'));
  assert.throws(() => adoptVersion(1.5, 'PlanVersion'));
  assert.equal(Number(adoptVersion(0, 'PlanVersion')), 0);
});

// --- strict result envelope (RES-001) --------------------------------------

check('valid ok/partial/blocked/failed producer results validate', () => {
  const ok = validateProducerResult({ status: 'ok', data: { answer: 42 } });
  assert.equal(ok.ok, true);

  const partial = validateProducerResult({ status: 'partial', data: { done: ['a'], todo: ['b'] } });
  assert.equal(partial.ok, true);

  const blocked = validateProducerResult({ status: 'blocked', blocked: { kind: 'user', action: 'confirm delete', expiresAt: null } });
  assert.equal(blocked.ok, true);

  const failed = validateProducerResult({ status: 'failed', error: { code: 'tool_error', message: 'boom' } });
  assert.equal(failed.ok, true);
});

check('empty input → invalid_result, never ok', () => {
  const r = validateProducerResult('');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'empty');
});

check('plain prose → invalid_result, never ok (RES-001)', () => {
  const r = validateProducerResult('Here is my long analysis. Everything went fine.');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'not_json');
});

check('malformed JSON → invalid_result', () => {
  const r = validateProducerResult('{status: broken');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'not_json');
});

check('unknown status → invalid_result with detail', () => {
  const r = validateProducerResult({ status: 'weird', data: {} });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'unknown_status');
});

check('non-object / array / missing-status → invalid_result', () => {
  assert.equal(validateProducerResult(['ok']).ok, false);
  assert.equal(validateProducerResult(42).ok, false);
  const noStatus = validateProducerResult({ data: {} });
  assert.equal(noStatus.ok, false);
  assert.equal(noStatus.ok === false && noStatus.reason, 'missing_status');
});

check('ok without data payload is schema_invalid (not a silent ok)', () => {
  const r = validateProducerResult({ status: 'ok' });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'schema_invalid');
});

check('producer payload is canonical JSON only (Date/BigInt/cycle/non-finite rejected)', () => {
  const cyclic: Record<string, unknown> = { status: 'ok', data: {} };
  (cyclic.data as Record<string, unknown>).self = cyclic;
  const accessorArray: unknown[] = [1];
  Object.defineProperty(accessorArray, '0', { enumerable: true, get: () => 1 });
  const extraArrayProperty: unknown[] = [1];
  Object.defineProperty(extraArrayProperty, '4294967295', { enumerable: true, value: 'hidden' });
  for (const candidate of [
    { status: 'ok', data: { value: new Date('2026-01-01T00:00:00.000Z') } },
    { status: 'ok', data: { value: 1n } },
    { status: 'ok', data: { value: Number.POSITIVE_INFINITY } },
    { status: 'ok', data: { value: accessorArray } },
    { status: 'ok', data: { value: extraArrayProperty } },
    cyclic,
  ]) {
    const r = validateProducerResult(candidate);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'schema_invalid');
  }
  assert.equal(validateProducerResult({
    status: 'ok',
    data: { nested: [null, true, 1.5, 'text', { key: 'value' }] },
  }).ok, true);
});

check('sealed envelope: producer cannot override trusted binding (§9.1)', () => {
  const binding: RuntimeBinding = {
    schemaVersion: 'execution-result/v1',
    resultId: 'res_1', tenantId: 'tenant_real', jobId: 'job_real', planVersion: 3,
    controlVersionAtDispatch: 5, jobStopGenerationAtDispatch: 1, taskId: 'task_1',
    taskStopGenerationAtDispatch: 0, attemptId: 'attempt_1', dispatchEdgeId: null,
    dispatchEdgeGenerationAtDispatch: 0, dispatchAncestorSnapshotHash: 'sha256:0',
    finishCurrentPauseGeneration: null, stopGeneration: 0, runtimeRunId: 'run_1',
    attemptFence: 7, businessPayloadReadyGeneration: 1, businessPayloadReadyHash: 'sha256:h',
    ACommittedAt: '2026-07-23T12:00:00.000Z', finishedAt: '2026-07-23T12:00:00.000Z',
  };
  // A hostile producer that tries to smuggle a different jobId/tenantId.
  const validated = validateProducerResult({
    status: 'ok', data: { jobId: 'job_HOSTILE', tenantId: 'tenant_HOSTILE' },
  });
  assert.equal(validated.ok, true);
  const sealed = sealResultEnvelope((validated as { ok: true; value: ProducerResult }).value, binding);
  assert.equal(sealed.jobId, 'job_real', 'trusted jobId wins');
  assert.equal(sealed.tenantId, 'tenant_real', 'trusted tenantId wins');
  // hostile values are quarantined inside producer.data, not authority
  assert.equal((sealed.producer.data as Record<string, unknown>).jobId, 'job_HOSTILE');
});

// --- execution budget (§10.1) ----------------------------------------------

check('deriveAttemptDeadlines: business ⊆ work ⊆ hard', () => {
  const hard = 100_000;
  const d = deriveAttemptDeadlines({ hardDeadlineAt: hard, reserveForFinalizeMs: 5_000, resultCommitReserveMs: 2_000 });
  assert.equal(d.workDeadlineAt, 95_000);
  assert.equal(d.businessOperationCutoffAt, 93_000);
  assert.ok(d.businessOperationCutoffAt <= d.workDeadlineAt && d.workDeadlineAt <= hard);
});

check('deriveChildDeadline clamps to min(parent cutoff, now+cap) (K2–K4)', () => {
  // parent cutoff is the binding constraint
  const clampedByParent = deriveChildDeadline({ parentBusinessOperationCutoffAt: 10_000, now: 0, operationPolicyCapMs: 999_999 });
  assert.equal(clampedByParent, 10_000);
  // policy cap is the binding constraint
  const clampedByCap = deriveChildDeadline({ parentBusinessOperationCutoffAt: 999_999, now: 1_000, operationPolicyCapMs: 3_000 });
  assert.equal(clampedByCap, 4_000);
});

check('validateBudgetInvariants catches dead 25/25 no-progress config (K8)', () => {
  const errs = validateBudgetInvariants({
    businessOperationCutoffAt: 93_000, workDeadlineAt: 95_000, hardDeadlineAt: 100_000,
    reserveForFinalizeMs: 5_000, resultCommitReserveMs: 2_000,
    stepProgress: { maxSteps: 25, maxStepsWithoutProgress: 25, recoveryReserveSteps: 5 },
  });
  assert.ok(errs.includes('progress_threshold_starves_recovery'), 'must flag 25/25');
});

check('validateBudgetInvariants catches deadline ordering violations', () => {
  const errs = validateBudgetInvariants({
    businessOperationCutoffAt: 96_000, workDeadlineAt: 95_000, hardDeadlineAt: 90_000,
    reserveForFinalizeMs: 5_000, resultCommitReserveMs: 2_000,
    stepProgress: { maxSteps: 40, maxStepsWithoutProgress: 10, recoveryReserveSteps: 5 },
  });
  assert.ok(errs.includes('work_after_hard'));
  assert.ok(errs.includes('business_after_work'));
});

check('a healthy budget + step policy passes with no errors', () => {
  const errs = validateBudgetInvariants({
    businessOperationCutoffAt: 93_000, workDeadlineAt: 95_000, hardDeadlineAt: 100_000,
    reserveForFinalizeMs: 5_000, resultCommitReserveMs: 2_000,
    stepProgress: { maxSteps: 40, maxStepsWithoutProgress: 30, recoveryReserveSteps: 5 },
  });
  assert.deepEqual(errs, []);
});

if (failures > 0) {
  console.error(`\n❌ check:orchestration-contracts — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:orchestration-contracts — all assertions passed');
process.exit(0);
