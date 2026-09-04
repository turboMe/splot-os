#!/usr/bin/env tsx
/**
 * e2e:orchestration-stop-control-recovery — PR-40 typed terminal owner.
 *
 * Real replica-set proofs for one-owner materialization, fenced claim/start/
 * commit, protected reservation accounting, crash recovery, bounded exhaustion,
 * unsupported-shape fail-closed behavior and multi-reconciler replay.
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  canonicalHash,
  claimStopControlRecoveryActivation,
  COLLECTIONS,
  commitPendingFlatTerminalWithControlInSession,
  commitStopControlRecoveryActivation,
  CONTROL_BUDGET_POLICY_V1,
  drainStopControlRecovery,
  ensureOrchestrationIndexes,
  ensureStopControlRecovery,
  FlatTerminalTransactionRequiredError,
  reapExpiredActivationsToControlRecovery,
  reapExpiredStopControlRecoveries,
  reconcilePendingFlatTerminals,
  reducePendingFlatTerminalThroughControl,
  runTxn,
  runStopControlRecoveryActivation,
  startStopControlRecoveryActivation,
  type BudgetReservationDoc,
  type DispatchEdgeDoc,
  type JobDoc,
  type JobEventDoc,
  type LaneActivationDoc,
  type OutboxDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_stop_control_recovery';
const CONVERSATION_ID = 'conv_stop_control_recovery';

let failures = 0;

async function check(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(
      `  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-stop-control-recovery');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_stop_control_recovery_e2e_${Date.now()}`,
    section: 'e2e:orchestration-stop-control-recovery',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const activations =
    db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const reservations =
    db.collection<BudgetReservationDoc>(COLLECTIONS.budgetReservations);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);
  const edges = db.collection<DispatchEdgeDoc>(COLLECTIONS.edges);

  async function pendingStop(name: string): Promise<JobDoc> {
    const accepted = await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId: CONVERSATION_ID,
      commandId: `start:${name}`,
      goal: `stop-control:${name}`,
      payload: { operation: name },
    });
    await outbox.updateMany(
      {
        aggregate: accepted.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      },
      { $set: { state: 'PUBLISHED' } },
    );
    const now = new Date();
    const stopped = await jobs.findOneAndUpdate(
      {
        _id: accepted.jobId,
        terminalOutcome: null,
        controlState: 'NONE',
        activeActivationId: null,
      },
      {
        $set: {
          phase: 'RECONCILING',
          controlState: 'STOP_REQUESTED',
          pendingTerminalOutcome: 'CANCELLED',
          primaryJobStopCause: 'user_cancel',
          secondaryJobStopCauses: [],
          stopGraceDueAt: null,
          terminalBarrierMode: 'FLAT_STOP_V1',
          terminalBarrierBlocker: null,
          terminalBarrierNextCheckAt: now,
          terminalBarrierProbeAttempt: 0,
          stopControlRecoveryAttempt: 0,
          stopControlRecoveryState: 'IDLE',
          updatedAt: now,
        },
        $inc: {
          stateVersion: 1,
          activationDispatchGeneration: 1,
          jobStopGeneration: 1,
          controlVersion: 1,
        },
      },
      { returnDocument: 'after' },
    );
    assert.ok(stopped);
    await events.insertOne({
      _id: `${accepted.jobId}:1`,
      jobId: accepted.jobId,
      sequence: 1,
      type: 'JobStopRequested',
      payload: {
        cause: 'user_cancel',
        jobStopGeneration: stopped.jobStopGeneration,
        pendingTerminalOutcome: 'CANCELLED',
        terminalBarrierMode: 'FLAT_STOP_V1',
      },
      createdAt: now,
    });
    return stopped;
  }

  async function expireOwner(activationId: string): Promise<void> {
    const hardDeadlineAt = new Date(Date.now() - 1_000);
    const workDeadlineAt = new Date(
      hardDeadlineAt.getTime()
        - CONTROL_BUDGET_POLICY_V1.activationCommitReserveMs,
    );
    const activation = await activations.findOne({ _id: activationId });
    assert.ok(activation?.budgetReservationId);
    const reservation = await reservations.findOne({
      _id: activation.budgetReservationId,
    });
    assert.ok(reservation);
    const reservedAt = new Date(
      hardDeadlineAt.getTime()
        - CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
    );
    const activatedAt = reservation.state === 'ACTIVE'
      ? new Date(reservedAt.getTime() + 1)
      : null;
    await activations.updateOne(
      { _id: activationId, activeSlot: true },
      {
        $set: {
          leaseExpiresAt:
            activation.lifecycle === 'PENDING' ? null : workDeadlineAt,
          businessOperationCutoffAt: workDeadlineAt,
          workDeadlineAt,
          hardDeadlineAt,
          updatedAt: hardDeadlineAt,
        },
      },
    );
    await reservations.updateOne(
      { _id: activation.budgetReservationId },
      {
        $set: {
          reservedAt,
          expiresAt: hardDeadlineAt,
          ...(activatedAt ? { activatedAt } : {}),
        },
      },
    );
  }

  function assertReservationConservation(
    reservation: BudgetReservationDoc | null,
  ): asserts reservation is BudgetReservationDoc {
    assert.ok(reservation);
    if (
      reservation.state === 'SETTLED'
      || reservation.state === 'EXPIRED'
    ) {
      assert.equal(
        reservation.chargedActiveMs + reservation.refundedMs,
        reservation.allotmentMs,
      );
    }
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check(
      'owned terminal commit rejects a session outside a transaction',
      async () => {
        const session = client.startSession();
        try {
          await assert.rejects(
            () => commitPendingFlatTerminalWithControlInSession(
              db,
              session,
              'job_not_read_without_transaction',
              {
                activationId: 'activation_not_read_without_transaction',
                leaseOwner: 'lease_not_read_without_transaction',
                activationFence: 1,
                budgetReservationId:
                  'reservation_not_read_without_transaction',
                reducerPayloadHash: 'hash_not_read_without_transaction',
              },
            ),
            (error: unknown) =>
              error instanceof FlatTerminalTransactionRequiredError,
          );
        } finally {
          await session.endSession();
        }
      },
    );

    await check(
      'owned terminal boundary validates exact live reservation deadlines',
      async () => {
        const job = await pendingStop('direct-boundary-deadlines');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        const leaseOwner = 'stop-control:test:direct-boundary-deadlines';
        const lease = await claimStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          leaseTtlMs: 30_000,
        });
        assert.ok(lease);
        assert.equal(await startStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          activationFence: lease.activationFence,
        }), true);
        const [activation, reservation] = await Promise.all([
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.ok(activation?.reducerPayloadHash);
        assert.ok(activation.businessOperationCutoffAt);
        assert.ok(activation.workDeadlineAt);
        assert.ok(activation.hardDeadlineAt);
        assert.ok(reservation);
        const authority = {
          activationId: owner.activationId,
          leaseOwner,
          activationFence: lease.activationFence,
          budgetReservationId: owner.budgetReservationId,
          reducerPayloadHash: activation.reducerPayloadHash,
        };
        const shiftedExpiresAt = new Date(
          reservation.expiresAt.getTime() + 1_000,
        );
        await reservations.updateOne(
          { _id: owner.budgetReservationId },
          { $set: { expiresAt: shiftedExpiresAt } },
        );
        assert.equal(
          (await runTxn(client, (session) =>
            commitPendingFlatTerminalWithControlInSession(
              db,
              session,
              job._id,
              authority,
            ))).value,
          null,
          'reservation expiry must remain bound to activation hard deadline',
        );

        const shiftedBusinessCutoffAt = new Date(
          activation.businessOperationCutoffAt.getTime() + 1_000,
        );
        const shiftedWorkDeadlineAt = new Date(
          activation.workDeadlineAt.getTime() + 1_000,
        );
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              businessOperationCutoffAt: shiftedBusinessCutoffAt,
              workDeadlineAt: shiftedWorkDeadlineAt,
              hardDeadlineAt: shiftedExpiresAt,
            },
          },
        );
        assert.equal(
          (await runTxn(client, (session) =>
            commitPendingFlatTerminalWithControlInSession(
              db,
              session,
              job._id,
              authority,
            ))).value,
          null,
          'a widened reservation window must fail even when deadlines agree',
        );
        await Promise.all([
          reservations.updateOne(
            { _id: owner.budgetReservationId },
            { $set: { expiresAt: reservation.expiresAt } },
          ),
          activations.updateOne(
            { _id: owner.activationId },
            {
              $set: {
                businessOperationCutoffAt:
                  activation.businessOperationCutoffAt,
                workDeadlineAt: activation.workDeadlineAt,
                hardDeadlineAt: activation.hardDeadlineAt,
              },
            },
          ),
        ]);
        assert.equal(
          (await commitStopControlRecoveryActivation(client, db, {
            activationId: owner.activationId,
            leaseOwner,
            activationFence: lease.activationFence,
          }))?.reduction.status,
          'terminalized',
        );
      },
    );

    await check(
      'legacy jobs backfill the exact V1 reserve and malformed policy fails closed',
      async () => {
        const accepted = await acceptStartCommand(client, db, {
          resourceId: RESOURCE_ID,
          conversationId: CONVERSATION_ID,
          commandId: 'start:legacy-budget-backfill',
          goal: 'legacy-budget-backfill',
          payload: { operation: 'legacy-budget-backfill' },
        });
        await jobs.updateOne(
          { _id: accepted.jobId },
          {
            $unset: {
              controlBudgetPolicyVersion: '',
              jobControlRecoveryReserveMs: '',
              jobControlRecoveryReservedMs: '',
              jobControlRecoveryConsumedMs: '',
              stopControlRecoveryAttempt: '',
              stopControlRecoveryState: '',
            },
          },
        );
        await ensureOrchestrationIndexes(db);
        const repaired = await jobs.findOne({ _id: accepted.jobId });
        assert.equal(
          repaired?.controlBudgetPolicyVersion,
          CONTROL_BUDGET_POLICY_V1.version,
        );
        assert.equal(
          repaired?.jobControlRecoveryReserveMs,
          CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs,
        );
        assert.equal(repaired?.jobControlRecoveryReservedMs, 0);
        assert.equal(repaired?.jobControlRecoveryConsumedMs, 0);
        assert.equal(repaired?.stopControlRecoveryAttempt, 0);
        assert.equal(repaired?.stopControlRecoveryState, 'IDLE');

        await jobs.updateOne(
          { _id: accepted.jobId },
          {
            $set: {
              jobControlRecoveryReserveMs:
                CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs + 1,
            },
          },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /invalid control-budget tuple/,
        );
        await jobs.updateOne(
          { _id: accepted.jobId },
          {
            $set: {
              jobControlRecoveryReserveMs:
                CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs,
            },
          },
        );
        await ensureOrchestrationIndexes(db);
      },
    );

    await check(
      'compatibility façade is inert for an ordinary non-stop job',
      async () => {
        const accepted = await acceptStartCommand(client, db, {
          resourceId: RESOURCE_ID,
          conversationId: CONVERSATION_ID,
          commandId: 'start:not-applicable',
          goal: 'not-applicable',
          payload: { operation: 'not-applicable' },
        });
        assert.equal(
          (await reducePendingFlatTerminalThroughControl(
            client,
            db,
            accepted.jobId,
          )).status,
          'not_applicable',
        );
        assert.equal(await activations.countDocuments({
          jobId: accepted.jobId,
          controlSubtype: 'STOP_TERMINAL',
        }), 0);
        assert.equal(await reservations.countDocuments({
          jobId: accepted.jobId,
        }), 0);
      },
    );

    await check(
      'startup rejects future activation time and reservation for a missing job',
      async () => {
        const job = await pendingStop('startup-state-matrix');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        const leaseOwner = 'stop-control:test:startup-state-matrix';
        const lease = await claimStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          leaseTtlMs: 30_000,
        });
        assert.ok(lease);
        const activeReservation = await reservations.findOne({
          _id: owner.budgetReservationId,
        });
        assert.ok(activeReservation?.activatedAt);
        await reservations.updateOne(
          { _id: owner.budgetReservationId },
          {
            $set: {
              activatedAt: new Date(Date.now() + 60_000),
            },
          },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /invalid control reservation/,
        );
        await reservations.updateOne(
          { _id: owner.budgetReservationId },
          { $set: { activatedAt: activeReservation.activatedAt } },
        );
        await ensureOrchestrationIndexes(db);
        assert.equal(await startStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          activationFence: lease.activationFence,
        }), true);
        assert.equal((await commitStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          activationFence: lease.activationFence,
        }))?.reduction.status, 'terminalized');

        const now = new Date();
        const missingJobReservation: BudgetReservationDoc = {
          _id: 'bres_stop_control:missing-job',
          jobId: 'job_missing_for_budget_validation',
          jobStopGeneration: 1,
          activationDispatchGeneration: 1,
          pool: 'JOB_CONTROL_RECOVERY',
          ownerKind: 'ACTIVATION',
          ownerId: 'act_missing_for_budget_validation',
          policyVersion: CONTROL_BUDGET_POLICY_V1.version,
          state: 'EXPIRED',
          allotmentMs: CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
          reservedAt: new Date(now.getTime() - 60_000),
          expiresAt: new Date(now.getTime() - 30_000),
          activatedAt: null,
          settledAt: now,
          chargedActiveMs: 0,
          refundedMs: CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
          settlementReason: 'EXPIRED',
        };
        await reservations.insertOne(missingJobReservation);
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /invalid control reservation owner/,
        );
        await reservations.deleteOne({ _id: missingJobReservation._id });
        await ensureOrchestrationIndexes(db);
      },
    );

    await check(
      'startup enforces owner-reservation bijection and the live state matrix',
      async () => {
        const job = await pendingStop('startup-owner-bijection');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        const [savedActivation, savedReservation] = await Promise.all([
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.ok(savedActivation?.reducerPayload);
        assert.ok(savedActivation.reducerPayloadHash);
        assert.ok(savedReservation);

        await reservations.deleteOne({ _id: owner.budgetReservationId });
        await jobs.updateOne(
          { _id: job._id },
          { $set: { jobControlRecoveryReservedMs: 0 } },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /stop control owner missing reservation/,
        );
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              controlSubtype: null,
              reducerPayloadHash: null,
              budgetReservationId: null,
              budgetPool: null,
              activationActiveAllotmentMs: null,
            },
          },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /partial\/invalid activation budget envelope/,
        );
        const malformedStopMarker = {
          ...savedActivation.reducerPayload,
          pendingTerminalOutcome: 'NOT_A_TERMINAL_OUTCOME',
        };
        await activations.updateOne(
          { _id: owner.activationId },
          { $set: { reducerPayload: malformedStopMarker } },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /partial\/invalid activation budget envelope/,
        );
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              reducerPayload: savedActivation.reducerPayload,
              controlSubtype: savedActivation.controlSubtype,
              reducerPayloadHash: savedActivation.reducerPayloadHash,
              budgetReservationId: savedActivation.budgetReservationId,
              budgetPool: savedActivation.budgetPool,
              activationActiveAllotmentMs:
                savedActivation.activationActiveAllotmentMs,
            },
          },
        );
        await reservations.insertOne(savedReservation);
        await jobs.updateOne(
          { _id: job._id },
          {
            $set: {
              jobControlRecoveryReservedMs:
                CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
            },
          },
        );
        await ensureOrchestrationIndexes(db);

        const foreignPayload = {
          ...savedActivation.reducerPayload,
          kind: 'FOREIGN_CONTROL_V1',
        };
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              reducerPayload: foreignPayload,
              reducerPayloadHash: canonicalHash(foreignPayload),
            },
          },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /partial\/invalid activation budget envelope/,
        );
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              reducerPayload: savedActivation.reducerPayload,
              reducerPayloadHash: savedActivation.reducerPayloadHash,
            },
          },
        );

        const invalidEnumPayload = {
          ...savedActivation.reducerPayload,
          pendingTerminalOutcome: 'NOT_A_TERMINAL_OUTCOME',
        };
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              reducerPayload: invalidEnumPayload,
              reducerPayloadHash: canonicalHash(invalidEnumPayload),
            },
          },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /partial\/invalid activation budget envelope/,
        );
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              reducerPayload: savedActivation.reducerPayload,
              reducerPayloadHash: savedActivation.reducerPayloadHash,
            },
          },
        );

        await jobs.updateOne(
          { _id: job._id },
          { $set: { stopControlRecoveryState: 'ACTIVE' } },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /control-budget active owner mismatch/,
        );
        await jobs.updateOne(
          { _id: job._id },
          { $set: { stopControlRecoveryState: 'PENDING' } },
        );

        await reservations.updateOne(
          { _id: owner.budgetReservationId },
          { $set: { reservedAt: new Date(Date.now() + 60_000) } },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /invalid control reservation/,
        );
        await reservations.updateOne(
          { _id: owner.budgetReservationId },
          { $set: { reservedAt: savedReservation.reservedAt } },
        );
        await ensureOrchestrationIndexes(db);
        assert.equal(
          (await runStopControlRecoveryActivation(
            client,
            db,
            owner.activationId,
          ))?.reduction.status,
          'terminalized',
        );
      },
    );

    await check(
      'startup rejects a committed stop owner left in the active job slot',
      async () => {
        const job = await pendingStop('startup-terminal-owner-pointer');
        await outbox.insertOne({
          _id: `obx_test_pending_wake:${job._id}`,
          aggregate: job._id,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          payload: { reason: 'hold_terminal_barrier_open' },
          createdAt: new Date(),
        });
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        assert.equal(
          (await runStopControlRecoveryActivation(
            client,
            db,
            owner.activationId,
          ))?.reduction.status,
          'waiting',
        );
        const [waitingJob, committedOwner] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: owner.activationId }),
        ]);
        assert.equal(waitingJob?.stopControlRecoveryState, 'WAITING');
        assert.equal(waitingJob?.activeActivationId, null);
        assert.equal(committedOwner?.lifecycle, 'COMMITTED');
        await jobs.updateOne(
          { _id: job._id },
          { $set: { activeActivationId: owner.activationId } },
        );
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /terminal stop owner remains active/,
        );
        await jobs.updateOne(
          { _id: job._id },
          { $set: { activeActivationId: null } },
        );
        await ensureOrchestrationIndexes(db);
      },
    );

    await check(
      'eight materializers reserve exactly one current stop owner',
      async () => {
        const job = await pendingStop('materialize-once');
        const owners = await Promise.all(
          Array.from({ length: 8 }, () =>
            ensureStopControlRecovery(client, db, job._id)),
        );
        const ids = new Set(
          owners
            .map((owner) => owner?.activationId)
            .filter((id): id is string => Boolean(id)),
        );
        assert.equal(ids.size, 1);
        assert.equal(owners.filter((owner) => owner?.created).length, 1);
        const activationId = [...ids][0]!;
        const [currentJob, activation, reservation] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: activationId }),
          reservations.findOne({ ownerId: activationId }),
        ]);
        assert.equal(currentJob?.activeActivationId, activationId);
        assert.equal(currentJob?.stopControlRecoveryState, 'PENDING');
        assert.equal(
          currentJob?.jobControlRecoveryReservedMs,
          CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
        );
        assert.equal(activation?.lifecycle, 'PENDING');
        assert.equal(activation?.activeSlot, true);
        assert.equal(reservation?.state, 'RESERVED');
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'StopControlRecoveryRequested',
        }), 1);
        assert.equal((await runStopControlRecoveryActivation(
          client,
          db,
          activationId,
        ))?.reduction.status, 'terminalized');
      },
    );

    await check(
      'published-before-claim fallback settles terminal and reservation once',
      async () => {
        const job = await pendingStop('published-fallback');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await outbox.updateOne(
          {
            aggregate: job._id,
            type: 'StopControlRecoveryRequested',
            state: 'PENDING',
          },
          { $set: { state: 'PUBLISHED' } },
        );
        const drained = await drainStopControlRecovery(client, db);
        assert.equal(drained.terminalized, 1);
        const [terminal, activation, reservation] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.equal(terminal?.terminalOutcome, 'CANCELLED');
        assert.equal(terminal?.activeActivationId, null);
        assert.equal(terminal?.jobControlRecoveryReservedMs, 0);
        assert.equal(activation?.lifecycle, 'COMMITTED');
        assert.equal(activation?.activeSlot, false);
        assertReservationConservation(reservation);
        assert.equal(reservation.state, 'SETTLED');
        assert.equal(reservation.settlementReason, 'COMMITTED');
        assert.equal(await events.countDocuments({
          jobId: job._id,
          type: 'JobTerminalized',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'JobTerminal',
        }), 1);
      },
    );

    await check(
      'timer widening CANCELLED snapshot to UNKNOWN keeps the same owner valid',
      async () => {
        const job = await pendingStop('timer-widens-outcome');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        // Exact crash window: the command transaction committed its PENDING
        // owner, but no runner claimed it before stop-grace reconciliation
        // conservatively widened the current job truth.
        await jobs.updateOne(
          {
            _id: job._id,
            activeActivationId: owner.activationId,
            pendingTerminalOutcome: 'CANCELLED',
          },
          {
            $set: {
              pendingTerminalOutcome: 'UNKNOWN_OUTCOME',
              stopGraceDueAt: new Date(Date.now() - 1),
              updatedAt: new Date(),
            },
            $inc: { stateVersion: 1 },
          },
        );
        const sameOwner = await ensureStopControlRecovery(
          client,
          db,
          job._id,
        );
        assert.equal(sameOwner?.activationId, owner.activationId);
        assert.equal(sameOwner?.created, false);
        const committed = await runStopControlRecoveryActivation(
          client,
          db,
          owner.activationId,
        );
        assert.equal(
          committed?.reduction.outcome,
          'UNKNOWN_OUTCOME',
        );
        const terminal = await jobs.findOne({ _id: job._id });
        assert.equal(terminal?.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.notEqual(terminal?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
        }), 0);
      },
    );

    await check(
      'parallel exact commit has one charge and idempotent replays',
      async () => {
        const job = await pendingStop('parallel-commit');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        const leaseOwner = 'stop-control:test:parallel';
        const lease = await claimStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          leaseTtlMs: 30_000,
        });
        assert.ok(lease);
        assert.equal(await startStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          activationFence: lease.activationFence,
        }), true);
        const commits = await Promise.all(
          Array.from({ length: 8 }, () =>
            commitStopControlRecoveryActivation(client, db, {
              activationId: owner.activationId,
              leaseOwner,
              activationFence: lease.activationFence,
            })),
        );
        assert.equal(
          commits.filter((entry) => entry && !entry.deduped).length,
          1,
        );
        assert.ok(commits.every((entry) => entry !== null));
        const reservation = await reservations.findOne({
          _id: owner.budgetReservationId,
        });
        assertReservationConservation(reservation);
        const current = await jobs.findOne({ _id: job._id });
        assert.equal(
          current?.jobControlRecoveryConsumedMs,
          reservation.chargedActiveMs,
        );
        assert.equal(await events.countDocuments({
          jobId: job._id,
          type: 'JobTerminalized',
        }), 1);
      },
    );

    await check(
      'committed replay rejects malformed, inexact and future settlement',
      async () => {
        const job = await pendingStop('committed-replay-validation');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        assert.ok(await runStopControlRecoveryActivation(
          client,
          db,
          owner.activationId,
        ));
        const [committed, settled] = await Promise.all([
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.ok(committed?.committedAt);
        assert.ok(settled?.settledAt);
        const replayInput = {
          activationId: owner.activationId,
          leaseOwner: 'replay-does-not-reacquire-authority',
          activationFence: committed.activationFence,
        };
        await db.collection<{
          _id: string;
          chargedActiveMs: unknown;
        }>(COLLECTIONS.budgetReservations).updateOne(
          { _id: owner.budgetReservationId },
          { $set: { chargedActiveMs: 'not-an-integer' } },
        );
        assert.equal(await commitStopControlRecoveryActivation(
          client,
          db,
          replayInput,
        ), null);
        await reservations.updateOne(
          { _id: owner.budgetReservationId },
          { $set: { chargedActiveMs: settled.chargedActiveMs } },
        );

        const inexactCharge = settled.chargedActiveMs === 0
          ? 1
          : settled.chargedActiveMs - 1;
        const inexactRefund = settled.allotmentMs - inexactCharge;
        await Promise.all([
          reservations.updateOne(
            { _id: owner.budgetReservationId },
            {
              $set: {
                chargedActiveMs: inexactCharge,
                refundedMs: inexactRefund,
              },
            },
          ),
          jobs.updateOne(
            { _id: job._id },
            { $set: { jobControlRecoveryConsumedMs: inexactCharge } },
          ),
        ]);
        assert.equal(
          inexactCharge + inexactRefund,
          settled.allotmentMs,
          'tamper keeps conservation while changing elapsed-time charge',
        );
        assert.equal(await commitStopControlRecoveryActivation(
          client,
          db,
          replayInput,
        ), null);
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /invalid control reservation/,
        );
        await Promise.all([
          reservations.updateOne(
            { _id: owner.budgetReservationId },
            {
              $set: {
                chargedActiveMs: settled.chargedActiveMs,
                refundedMs: settled.refundedMs,
              },
            },
          ),
          jobs.updateOne(
            { _id: job._id },
            {
              $set: {
                jobControlRecoveryConsumedMs: settled.chargedActiveMs,
              },
            },
          ),
        ]);
        await ensureOrchestrationIndexes(db);

        const storeClock = await db.command({ hello: 1 }) as {
          localTime?: unknown;
        };
        assert.ok(storeClock.localTime instanceof Date);
        const futureSettlement = new Date(Math.min(
          settled.expiresAt.getTime() - 1,
          storeClock.localTime.getTime() + 5_000,
        ));
        assert.ok(
          futureSettlement.getTime() > storeClock.localTime.getTime(),
        );
        await Promise.all([
          reservations.updateOne(
            { _id: owner.budgetReservationId },
            { $set: { settledAt: futureSettlement } },
          ),
          activations.updateOne(
            { _id: owner.activationId },
            { $set: { committedAt: futureSettlement } },
          ),
        ]);
        assert.equal(await commitStopControlRecoveryActivation(
          client,
          db,
          replayInput,
        ), null);
        await Promise.all([
          reservations.updateOne(
            { _id: owner.budgetReservationId },
            { $set: { settledAt: settled.settledAt } },
          ),
          activations.updateOne(
            { _id: owner.activationId },
            { $set: { committedAt: committed.committedAt } },
          ),
        ]);
        assert.equal(
          (await commitStopControlRecoveryActivation(
            client,
            db,
            replayInput,
          ))?.deduped,
          true,
        );
      },
    );

    await check(
      'PENDING crash has one successor and stale owner cannot commit',
      async () => {
        const job = await pendingStop('pending-crash');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await expireOwner(owner.activationId);
        const reaped = await Promise.all([
          reapExpiredStopControlRecoveries(client, db),
          reapExpiredStopControlRecoveries(client, db),
        ]);
        assert.equal(reaped.reduce((sum, value) => sum + value, 0), 1);
        const current = await jobs.findOne({ _id: job._id });
        assert.ok(current?.activeActivationId);
        assert.notEqual(current.activeActivationId, owner.activationId);
        assert.equal(current.stopControlRecoveryAttempt, 2);
        const [oldActivation, oldReservation, successor] =
          await Promise.all([
            activations.findOne({ _id: owner.activationId }),
            reservations.findOne({ _id: owner.budgetReservationId }),
            activations.findOne({ _id: current.activeActivationId }),
          ]);
        assert.equal(oldActivation?.lifecycle, 'ABANDONED');
        assertReservationConservation(oldReservation);
        assert.equal(oldReservation.state, 'EXPIRED');
        assert.equal(successor?.lifecycle, 'PENDING');
        await Promise.all([
          reservations.updateOne(
            { _id: owner.budgetReservationId },
            {
              $set: {
                chargedActiveMs: 1,
                refundedMs: oldReservation.allotmentMs - 1,
              },
            },
          ),
          jobs.updateOne(
            { _id: job._id },
            { $set: { jobControlRecoveryConsumedMs: 1 } },
          ),
        ]);
        await assert.rejects(
          () => ensureOrchestrationIndexes(db),
          /invalid control reservation/,
        );
        await Promise.all([
          reservations.updateOne(
            { _id: owner.budgetReservationId },
            {
              $set: {
                chargedActiveMs: oldReservation.chargedActiveMs,
                refundedMs: oldReservation.refundedMs,
              },
            },
          ),
          jobs.updateOne(
            { _id: job._id },
            {
              $set: {
                jobControlRecoveryConsumedMs:
                  oldReservation.chargedActiveMs,
              },
            },
          ),
        ]);
        await ensureOrchestrationIndexes(db);
        assert.equal(await runStopControlRecoveryActivation(
          client,
          db,
          current.activeActivationId,
        ).then((entry) => entry?.reduction.status), 'terminalized');
      },
    );

    await check(
      'RUNNING crash charges once, fences stale handle and recovers',
      async () => {
        const job = await pendingStop('running-crash');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        const leaseOwner = 'stop-control:test:lost-running';
        const lease = await claimStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          leaseTtlMs: 30_000,
        });
        assert.ok(lease);
        assert.equal(await startStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          activationFence: lease.activationFence,
        }), true);
        await expireOwner(owner.activationId);
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 1);
        assert.equal(await commitStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner,
          activationFence: lease.activationFence,
        }), null);
        const current = await jobs.findOne({ _id: job._id });
        assert.ok(current?.activeActivationId);
        const oldReservation = await reservations.findOne({
          _id: owner.budgetReservationId,
        });
        assertReservationConservation(oldReservation);
        assert.equal(oldReservation.state, 'SETTLED');
        assert.equal(oldReservation.settlementReason, 'ABANDONED');
        assert.ok(oldReservation.chargedActiveMs >= 0);
        const recovered = await runStopControlRecoveryActivation(
          client,
          db,
          current.activeActivationId,
        );
        assert.equal(recovered?.reduction.status, 'terminalized');
      },
    );

    await check(
      'three lost owners leave one FAILED owner and one durable alert',
      async () => {
        const job = await pendingStop('bounded-exhaustion');
        let owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        for (let attempt = 1; attempt <= 3; attempt++) {
          await expireOwner(owner.activationId);
          assert.equal(await reapExpiredStopControlRecoveries(
            client,
            db,
          ), 1);
          const current = await jobs.findOne({ _id: job._id });
          if (attempt < 3) {
            assert.ok(current?.activeActivationId);
            assert.notEqual(current.activeActivationId, owner.activationId);
            const successor = await activations.findOne({
              _id: current.activeActivationId,
            });
            assert.ok(successor?.budgetReservationId);
            owner = {
              jobId: job._id,
              activationId: successor._id,
              budgetReservationId: successor.budgetReservationId,
              created: true,
            };
          } else {
            assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
            const failed = await activations.findOne({
              _id: current?.activeActivationId ?? '',
            });
            assert.equal(failed?.lifecycle, 'FAILED');
            assert.equal(failed?.reasonCode, 'stop_control_recovery_exhausted');
          }
        }
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'stop_control_recovery_exhausted',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'JobTerminal',
        }), 0);
      },
    );

    await check(
      'reserve exhaustion is visible, idempotent and never opens business work',
      async () => {
        const job = await pendingStop('reserve-exhaustion');
        await jobs.updateOne(
          { _id: job._id },
          {
            $set: {
              jobControlRecoveryConsumedMs:
                CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs,
            },
          },
        );
        assert.equal(await ensureStopControlRecovery(
          client,
          db,
          job._id,
        ), null);
        assert.equal(await ensureStopControlRecovery(
          client,
          db,
          job._id,
        ), null);
        const current = await jobs.findOne({ _id: job._id });
        assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(current?.activeActivationId, null);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'control_recovery_reserve_exhausted',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'LaneWakeRequested',
          state: 'PENDING',
        }), 0);
      },
    );

    await check(
      'invalid job policy is quarantined once without minting an owner',
      async () => {
        const job = await pendingStop('policy-invalid');
        await jobs.updateOne(
          { _id: job._id },
          {
            $set: {
              jobControlRecoveryReserveMs:
                CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs + 1,
            },
          },
        );
        assert.equal(await ensureStopControlRecovery(
          client,
          db,
          job._id,
        ), null);
        assert.equal(await ensureStopControlRecovery(
          client,
          db,
          job._id,
        ), null);
        const current = await jobs.findOne({ _id: job._id });
        assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(
          current?.terminalBarrierBlocker,
          'control_recovery_policy_invalid',
        );
        assert.equal(current?.terminalBarrierNextCheckAt, null);
        assert.equal(current?.activeActivationId, null);
        assert.equal(await activations.countDocuments({
          jobId: job._id,
          controlSubtype: 'STOP_TERMINAL',
        }), 0);
        assert.equal(await reservations.countDocuments({
          jobId: job._id,
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'control_recovery_policy_invalid',
        }), 1);
      },
    );

    await check(
      'invalid policy on a current owner settles and quarantines before claim',
      async () => {
        const job = await pendingStop('active-policy-invalid');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await jobs.updateOne(
          { _id: job._id },
          {
            $set: {
              jobControlRecoveryReserveMs:
                CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs + 1,
            },
          },
        );
        assert.equal(await claimStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner: 'stop-control:test:policy-invalid',
        }), null);
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 0);
        const [current, failed, reservation] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(
          current?.terminalBarrierBlocker,
          'control_recovery_policy_invalid',
        );
        assert.equal(current?.jobControlRecoveryReservedMs, 0);
        assert.equal(failed?.lifecycle, 'FAILED');
        assert.equal(failed?.reasonCode, 'control_recovery_policy_invalid');
        assertReservationConservation(reservation);
        assert.equal(reservation.state, 'SETTLED');
        assert.equal(reservation.settlementReason, 'FAILED');
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'control_recovery_policy_invalid',
        }), 1);
      },
    );

    await check(
      'invalid current-owner state is quarantined without a drain write loop',
      async () => {
        const job = await pendingStop('state-invalid-no-hot-loop');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await db.collection<{
          _id: string;
          stopControlRecoveryState: string;
        }>(COLLECTIONS.jobs).updateOne(
          { _id: job._id },
          { $set: { stopControlRecoveryState: 'CORRUPT_STATE' } },
        );
        await drainStopControlRecovery(client, db);
        const [current, failed, reservation] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(
          current?.terminalBarrierBlocker,
          'control_recovery_policy_invalid',
        );
        assert.equal(failed?.lifecycle, 'FAILED');
        assert.equal(failed?.reasonCode, 'control_recovery_policy_invalid');
        assertReservationConservation(reservation);
        const failedAt = failed.updatedAt.getTime();
        await drainStopControlRecovery(client, db);
        assert.equal(
          (await activations.findOne({
            _id: owner.activationId,
          }))?.updatedAt.getTime(),
          failedAt,
        );
      },
    );

    await check(
      'invalid orphan budget is abandoned without unsafe accounting retries',
      async () => {
        const job = await pendingStop('orphan-policy-invalid');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await jobs.updateOne(
          { _id: job._id },
          {
            $set: {
              activeActivationId: null,
              jobControlRecoveryConsumedMs: -1,
            },
          },
        );
        await expireOwner(owner.activationId);
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 1);
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 0);
        const [abandoned, reservation] = await Promise.all([
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.equal(abandoned?.lifecycle, 'ABANDONED');
        assert.equal(abandoned?.activeSlot, false);
        assertReservationConservation(reservation);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'control_recovery_policy_invalid',
        }), 1);
      },
    );

    await check(
      'stable STOP markers quarantine a corrupt activation kind',
      async () => {
        const job = await pendingStop('activation-kind-invalid');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await activations.updateOne(
          { _id: owner.activationId },
          { $set: { kind: 'BUSINESS' } },
        );
        await drainStopControlRecovery(client, db);
        const [current, failed, reservation] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(
          current?.terminalBarrierBlocker,
          'stop_control_recovery_authority_mismatch',
        );
        assert.equal(failed?.lifecycle, 'FAILED');
        assert.equal(
          failed?.reasonCode,
          'stop_control_recovery_authority_mismatch',
        );
        assertReservationConservation(reservation);
        assert.equal(reservation.settlementReason, 'FAILED');
        assert.equal(await reapExpiredActivationsToControlRecovery(
          client,
          db,
        ), 0);
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 0);
      },
    );

    await check(
      'topology appearing before commit blocks and refunds without a leak',
      async () => {
        const job = await pendingStop('unsupported-race');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await edges.insertOne({
          _id: `edge:${job._id}`,
          jobId: job._id,
          parentTaskId: `parent:${job._id}`,
          childTaskId: `child:${job._id}`,
          completionMode: 'REQUIRED',
          lifecycle: 'ACTIVE',
          createdAt: new Date(),
        });
        const committed = await runStopControlRecoveryActivation(
          client,
          db,
          owner.activationId,
        );
        assert.equal(committed?.reduction.status, 'blocked');
        assert.equal(
          committed?.reduction.blocker,
          'dispatch_edge_present',
        );
        const [current, activation, reservation] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.equal(current?.terminalOutcome, null);
        assert.equal(current?.terminalBarrierMode, 'BLOCKED_UNSUPPORTED');
        assert.equal(current?.activeActivationId, null);
        assert.equal(current?.jobControlRecoveryReservedMs, 0);
        assert.equal(activation?.lifecycle, 'COMMITTED');
        assertReservationConservation(reservation);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
          'payload.blocker': 'dispatch_edge_present',
        }), 1);
      },
    );

    await check(
      'payload/hash corruption cannot claim and is immediately quarantined',
      async () => {
        const job = await pendingStop('payload-corrupt');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              reducerPayloadHash: 'corrupt',
            },
          },
        );
        assert.equal(await claimStopControlRecoveryActivation(client, db, {
          activationId: owner.activationId,
          leaseOwner: 'stop-control:test:corrupt',
        }), null);
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 0);
        const current = await jobs.findOne({ _id: job._id });
        const failed = await activations.findOne({
          _id: current?.activeActivationId ?? '',
        });
        assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(failed?.lifecycle, 'FAILED');
        assert.equal(
          failed?.reasonCode,
          'stop_control_recovery_authority_mismatch',
        );
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
        }), 1);
      },
    );

    await check(
      'corrupt payload kind stays isolated and specialized reaper settles it',
      async () => {
        const job = await pendingStop('payload-kind-corrupt');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await activations.updateOne(
          { _id: owner.activationId },
          {
            $set: {
              controlSubtype: null,
              'reducerPayload.kind': 'CORRUPT_STOP_KIND',
            },
          },
        );
        await expireOwner(owner.activationId);
        assert.equal(
          await reapExpiredActivationsToControlRecovery(client, db),
          0,
          'generic PR-36 reaper cannot steal a stable STOP envelope',
        );
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 1);
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 0);
        const [current, failed, reservation] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(current?.jobControlRecoveryReservedMs, 0);
        assert.equal(failed?.lifecycle, 'FAILED');
        assert.equal(
          failed?.reasonCode,
          'stop_control_recovery_payload_invalid',
        );
        assertReservationConservation(reservation);
        assert.equal(reservation.state, 'SETTLED');
        assert.equal(reservation.settlementReason, 'FAILED');
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'stop_control_recovery_payload_invalid',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'ControlRecoveryRequested',
        }), 0);
        assert.equal(await events.countDocuments({
          jobId: job._id,
          type: { $in: [
            'LaneControlRecoveryStarted',
            'LaneControlRecoveryFailed',
          ] },
        }), 0);
      },
    );

    await check(
      'malformed reservation quarantines once without reaper livelock',
      async () => {
        const job = await pendingStop('reservation-corrupt');
        const owner = await ensureStopControlRecovery(client, db, job._id);
        assert.ok(owner);
        await reservations.updateOne(
          { _id: owner.budgetReservationId },
          { $set: { policyVersion: 999 } },
        );
        await expireOwner(owner.activationId);
        assert.equal(
          await reapExpiredActivationsToControlRecovery(client, db),
          0,
        );
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 1);
        assert.equal(await reapExpiredStopControlRecoveries(client, db), 0);
        const [current, failed, reservation] = await Promise.all([
          jobs.findOne({ _id: job._id }),
          activations.findOne({ _id: owner.activationId }),
          reservations.findOne({ _id: owner.budgetReservationId }),
        ]);
        assert.equal(current?.stopControlRecoveryState, 'EXHAUSTED');
        assert.equal(
          current?.terminalBarrierBlocker,
          'stop_control_recovery_reservation_invalid',
        );
        assert.equal(failed?.lifecycle, 'FAILED');
        assert.equal(
          failed?.reasonCode,
          'stop_control_recovery_reservation_invalid',
        );
        assert.equal(reservation?.state, 'RESERVED');
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'stop_control_recovery_reservation_invalid',
        }), 1);
      },
    );

    await check(
      'two terminal reconcilers converge on one terminal/event/outbox',
      async () => {
        const job = await pendingStop('two-reconcilers');
        const counts = await Promise.all([
          reconcilePendingFlatTerminals(client, db),
          reconcilePendingFlatTerminals(client, db),
        ]);
        assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
        assert.equal((await jobs.findOne({
          _id: job._id,
        }))?.terminalOutcome, 'CANCELLED');
        assert.equal(await events.countDocuments({
          jobId: job._id,
          type: 'JobTerminalized',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: job._id,
          type: 'JobTerminal',
        }), 1);
        const allReservations = await reservations.find({
          jobId: job._id,
        }).toArray();
        assert.equal(allReservations.length, 1);
        assertReservationConservation(allReservations[0] ?? null);
      },
    );
  } finally {
    await db.dropDatabase().catch(() => {});
    await store.close();
  }

  if (failures > 0) {
    console.error(
      `\n❌ e2e:orchestration-stop-control-recovery — `
      + `${failures} failure(s)`,
    );
    process.exit(1);
  }
  console.log(
    '\n✅ e2e:orchestration-stop-control-recovery — all assertions passed',
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(
    `e2e failed: ${(error as Error).stack ?? (error as Error).message}`,
  );
  process.exit(1);
});
