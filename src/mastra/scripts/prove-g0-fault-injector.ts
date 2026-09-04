/**
 * Live proof for the G0 fault injector (§19.1/§19.2/§20.3).
 *
 * A scheduled fault is not a mock: this drives the real Mongo owner against the
 * local ephemeral rs0, injects the fault the seed-derived schedule declares at
 * its exact wired lifecycle point, and proves the crash-window outcome plus the
 * fail-closed ledger accounting end-to-end.
 *
 * Flow (kind `MONGO_DROP_CRASH_BEFORE_VERIFY`):
 * 1. claim a real owned database and write a business document;
 * 2. run cleanup with the scheduled fault injected right after the drop and
 *    before verification, so the destructive effect lands but the owner "crashes"
 *    before confirming it;
 * 3. prove the database is really gone, then let a fresh cleanup recover it as
 *    `ALREADY_ABSENT` — the drop was applied exactly once, never re-applied;
 * 4. reconcile the authenticated fault-event log against the schedule and prove
 *    the ledger is `ACCOUNTED`, while a rogue or forbidden event would `ESCAPE`.
 *
 * Safety envelope: Linux; localhost:27018 single-node rs0 only; only the exact
 * database this run minted is ever written or dropped.
 */
import assert from 'node:assert/strict';
import {
  bindMongoTestDatabase,
  createTestRuntimeOwner,
  hashCanonicalValue,
} from '../orchestration/testing/test-runtime.js';
import {
  openMongoOrphanJournalClient,
} from '../orchestration/testing/mongo-orphan-journal.js';
import {
  FAULT_KIND_TO_RUNTIME_POINT,
  deriveFaultLedger,
  deriveFaultSchedule,
  type FaultEvent,
  type FaultSchedule,
  type ScheduledFault,
} from '../orchestration/testing/fault-injector.js';

const PROOF_VERSION = 'g0-fault-injector-live-proof/v1';
const SUITE_ID = 'proof:g0-fault-injector';
const BUSINESS_COLLECTION = 'proof_business';
const DEFAULT_MONGO_URI = 'mongodb://localhost:27018/?replicaSet=rs0';
const TARGET_KIND = 'MONGO_DROP_CRASH_BEFORE_VERIFY' as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSingleNodeLocalHello(hello: unknown, replicaSet: string): void {
  assert.ok(isRecord(hello), 'Mongo hello result is not an object');
  assert.equal(hello.isWritablePrimary, true, 'Mongo fixture is not writable primary');
  assert.equal(hello.setName, replicaSet, 'Mongo fixture replica-set name differs');
  assert.ok(Array.isArray(hello.hosts), 'Mongo hello lacks replica-set hosts');
  assert.equal(hello.hosts.length, 1, 'proof requires a single-node replica set');
  assert.match(
    String(hello.hosts[0]),
    /^(?:localhost|127\.0\.0\.1):27018$/i,
    'proof requires the local ephemeral rs0 member',
  );
}

/**
 * Deterministically find a one-fault schedule whose single fault is the target
 * kind. `activeBudget: 1` always yields exactly one fault, so we only vary the
 * seed until the closed-enum draw lands on the drop crash point.
 */
function scheduleForTargetKind(challengeHash: `sha256:${string}`): {
  schedule: FaultSchedule;
  fault: ScheduledFault;
} {
  for (let seed = 0; seed < 100_000; seed += 1) {
    const schedule = deriveFaultSchedule({
      seed,
      suiteId: SUITE_ID,
      challengeHash,
      activeBudget: 1,
    });
    const fault = schedule.faults[0];
    if (fault && fault.kind === TARGET_KIND) return { schedule, fault };
  }
  throw new Error(`no seed produced a ${TARGET_KIND} schedule`);
}

async function databaseExists(
  client: import('mongodb').MongoClient,
  dbName: string,
): Promise<boolean> {
  const listing = await client.db('admin').command({ listDatabases: 1, nameOnly: true });
  const databases = isRecord(listing) && Array.isArray(listing.databases)
    ? listing.databases
    : [];
  return databases.some((entry) => isRecord(entry) && entry.name === dbName);
}

async function runProof(): Promise<void> {
  const uri = process.env.MONGODB_URI_SPIKE_RS ?? DEFAULT_MONGO_URI;
  const challengeHash = hashCanonicalValue({ proof: PROOF_VERSION, suiteId: SUITE_ID });
  const { schedule, fault } = scheduleForTargetKind(challengeHash);
  assert.equal(FAULT_KIND_TO_RUNTIME_POINT[fault.kind], 'afterMongoDropBeforeVerification');

  const owner = createTestRuntimeOwner({
    suiteId: SUITE_ID,
    topologyUri: uri,
    effectiveConfig: {
      executionProfile: 'DETERMINISTIC',
      runtimeKind: 'DIRECT',
      storeKind: 'MONGODB_REPLICA_SET',
      workerFixtureIds: ['OK'],
    },
  });

  const opened = await openMongoOrphanJournalClient(uri);
  const client = opened.client;
  let dropAttempted = false;
  let cleanupRejected = false;
  try {
    const hello = await client.db('admin').command({ hello: 1 });
    assertSingleNodeLocalHello(hello, 'rs0');

    const db = client.db(owner.databaseName);
    await owner.claimMongoDatabase(bindMongoTestDatabase(client, db));
    await db.collection<{ _id: string; state: string }>(BUSINESS_COLLECTION).insertOne(
      { _id: 'live-proof', state: 'ACTIVE' },
      { writeConcern: { w: 'majority', wtimeoutMS: 3_000 }, timeoutMS: 3_000 },
    );
    assert.equal(await databaseExists(client, owner.databaseName), true, 'claimed database is not present');

    // Inject the scheduled fault at its exact wired point: the drop lands, then
    // the owner "crashes" before it can verify the drop.
    await assert.rejects(
      owner.cleanupMongoDatabase(bindMongoTestDatabase(client, client.db(owner.databaseName)), {
        faultHooks: {
          [FAULT_KIND_TO_RUNTIME_POINT[fault.kind]]: () => {
            dropAttempted = true;
            throw new Error('injected crash after drop before verification');
          },
        },
      }),
      /injected crash after drop before verification/,
    );
    cleanupRejected = true;
    assert.equal(dropAttempted, true, 'scheduled fault never fired at its point');
    assert.equal(
      await databaseExists(client, owner.databaseName),
      false,
      'drop-before-verify fault did not actually drop the database',
    );

    // A fresh cleanup recovers the interrupted state: the destructive effect was
    // already applied once, so recovery is idempotent and reports ALREADY_ABSENT.
    const recovered = await owner.cleanupMongoDatabase(
      bindMongoTestDatabase(client, client.db(owner.databaseName)),
    );
    assert.equal(recovered.outcome, 'ALREADY_ABSENT', 'recovery did not observe an idempotent drop');

    // The effect was applied exactly once and confirmed — an allowed §20.3
    // disposition for this crash window.
    const event: FaultEvent = {
      faultId: fault.faultId,
      kind: fault.kind,
      firedSequence: 1,
      observedDisposition: 'APPLIED_ONCE',
    };
    const ledger = deriveFaultLedger({ schedule, events: [event], mode: 'EXECUTED' });
    assert.equal(ledger.containmentStatus, 'ACCOUNTED', 'a legitimate scheduled fault escaped');
    assert.equal(ledger.summary.matched, 1);
    assert.equal(ledger.summary.unaccounted, 0);
    assert.equal(ledger.summary.rogue, 0);

    // The same ledger has teeth: an unscheduled firing or a forbidden §20.3
    // outcome must escape, even on this real run.
    const rogue = deriveFaultLedger({
      schedule,
      events: [{ faultId: `flt_${'e'.repeat(32)}`, kind: fault.kind, firedSequence: 1, observedDisposition: 'APPLIED_ONCE' }],
      mode: 'EXECUTED',
    });
    assert.equal(rogue.containmentStatus, 'ESCAPED', 'a rogue fault was not caught');
    const forbidden = deriveFaultLedger({
      schedule,
      events: [{ faultId: fault.faultId, kind: fault.kind, firedSequence: 1, observedDisposition: 'ORPHANED_ACCEPTED' }],
      mode: 'EXECUTED',
    });
    assert.equal(forbidden.containmentStatus, 'ESCAPED', 'a forbidden disposition was not caught');

    assert.equal(await databaseExists(client, owner.databaseName), false, 'proof left an orphaned database');

    console.log(JSON.stringify({
      schemaVersion: PROOF_VERSION,
      status: 'PASSED',
      topology: { replicaSet: 'rs0', member: 'localhost:27018' },
      schedule: {
        seed: schedule.seed,
        scheduleHash: schedule.scheduleHash,
        faultId: fault.faultId,
        kind: fault.kind,
        runtimePoint: FAULT_KIND_TO_RUNTIME_POINT[fault.kind],
        expectedDisposition: fault.expectedDisposition,
      },
      injection: {
        faultFiredAtPoint: dropAttempted,
        cleanupRejected,
        databaseDroppedByFault: true,
        recoveryOutcome: 'ALREADY_ABSENT',
        observedDisposition: event.observedDisposition,
      },
      ledger: {
        executed: { status: ledger.containmentStatus, matched: ledger.summary.matched, sourceEventLogHash: ledger.sourceEventLogHash },
        rogueEscapes: rogue.containmentStatus === 'ESCAPED',
        forbiddenEscapes: forbidden.containmentStatus === 'ESCAPED',
      },
      databaseAbsent: true,
    }));
  } finally {
    // Best-effort: never leave the minted database behind if the proof aborted
    // before its own drop landed.
    try {
      if (!cleanupRejected && await databaseExists(client, owner.databaseName)) {
        await client.db(owner.databaseName).dropDatabase({ writeConcern: { w: 'majority' } });
      }
    } catch {
      // Surfaced by the final absence assertion on a successful run; a failed
      // run already threw and retains nothing beyond one exact database.
    }
    await client.close().catch(() => {});
  }
}

await runProof();
