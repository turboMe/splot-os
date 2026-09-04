#!/usr/bin/env tsx
/**
 * F6 cutover — durable dispatch for async delegation.
 *
 * This is the first mechanism whose EXECUTION moves off the legacy lane, so the
 * tests are about the two things a cutover can get wrong invisibly:
 *
 *  1. **It must never quietly change who does the work.** Legacy delegation
 *     already names its target. The durable path has a router whose fallback is
 *     "use the default agent", so an unroutable name must be refused BEFORE
 *     anything is accepted — otherwise `delegate_task(targetAgent:'chefAgent')`
 *     ends up answered by researcherAgent and the answer looks fine.
 *  2. **It must never quietly lose a result.** Legacy's contract is not a jobId,
 *     it is a pending message arriving in the caller's thread and a row reaching
 *     a terminal status. Execution moved; that contract did not.
 *
 * Plus the fail-open property that makes the flag safe: anything this path
 * cannot serve falls back to legacy rather than disappearing.
 *
 * The result-shape assertions are built from what `store/queries.ts` ACTUALLY
 * returns (`error` is `{code,message}`, `summary` is nullable), not from a guess
 * about what a result looks like — the class of bug that produced a green test
 * and `[object Object]` in production three times in this project.
 *
 * Sections 1-2 are deterministic. Section 3 drives a real replica set and SKIPs
 * without one. Section 4 additionally needs the MAIN application database
 * (pending messages live there, not in the V2 store) and cleans up after itself.
 *
 * Run: npx tsx src/mastra/scripts/check-durable-delegation.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  configureDurableDelegation,
  dispatchDurableDelegation,
  durableDelegationEnabled,
  durableJobOwner,
  runDelegationCompletionBridge,
  __resetDurableDelegation,
  type DurableJobResult,
  type DurableJobSnapshot,
} from '../services/durable-delegation.js';
import { connectReplicaSetOrSkip, skipSectionOrFail } from './lib/replica-set.js';

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

const TEST_DATABASE = `durdel_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

function withFlags<T>(flags: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(flags).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(flags)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const ON = { FEATURE_ORCHESTRATION_V2: 'true', FEATURE_ORCHESTRATION_V2_DELEGATION: 'true' };
const OFF = { FEATURE_ORCHESTRATION_V2: 'true', FEATURE_ORCHESTRATION_V2_DELEGATION: undefined };

const request = (over: Record<string, string> = {}) => ({
  delegationId: `del_${randomUUID()}`,
  agentId: 'chefAgent',
  prompt: 'plan a tasting menu',
  callerAgentId: 'metaAgent',
  callerThreadId: 'conv_1',
  ...over,
});

/** A composition that records what it was asked to accept. */
function recordingConfig(over: Record<string, unknown> = {}) {
  const accepted: Array<Record<string, unknown>> = [];
  return {
    accepted,
    cfg: {
      resolveCapability: (id: string) => (id === 'chefAgent' ? 'chefAgent' : null),
      getStore: async () => ({ client: {} as never, db: {} as never }),
      accept: async (_c: never, _d: never, input: Record<string, unknown>) => {
        accepted.push(input);
        return { jobId: `job_${accepted.length}` };
      },
      readStatus: async () => null,
      readResult: async () => null,
      ...over,
    } as never,
  };
}

console.log('check:durable-delegation');

// ── 1. Fail-open: anything unserved stays on the legacy lane ────────────────
await check('the flag off means the legacy lane, untouched', async () => {
  const { cfg, accepted } = recordingConfig();
  configureDurableDelegation(cfg);
  const result = await withFlags(OFF, () => dispatchDurableDelegation(request()));
  assert.equal(result, null, 'flag off must not route');
  assert.equal(accepted.length, 0, 'and must not accept anything either');
});

await check('the master V2 flag alone is not enough', async () => {
  const { cfg } = recordingConfig();
  configureDurableDelegation(cfg);
  const result = await withFlags(
    { FEATURE_ORCHESTRATION_V2: undefined, FEATURE_ORCHESTRATION_V2_DELEGATION: 'true' },
    () => dispatchDurableDelegation(request()),
  );
  assert.equal(result, null, 'the cutover must not outlive the substrate it depends on');
});

await check('no composition root means the legacy lane, not a crash', async () => {
  __resetDurableDelegation();
  const result = await withFlags(ON, () => dispatchDurableDelegation(request()));
  assert.equal(result, null);
});

await check('a store that will not answer falls back instead of throwing', async () => {
  // A delegating agent must never see "orchestration is down" — its work has a
  // lane that always exists.
  const { cfg } = recordingConfig({
    getStore: async () => { throw new Error('mongo unreachable'); },
  });
  configureDurableDelegation(cfg);
  const result = await withFlags(ON, () => dispatchDurableDelegation(request()));
  assert.equal(result, null);
});

// ── 2. The closed set decides, BEFORE anything is accepted ─────────────────
await check('SECURITY: an unroutable target is refused, not substituted', async () => {
  // The router's own fallback is the DEFAULT agent. If the check happened there,
  // legacy asking for codingAgent would be answered by researcherAgent and
  // nothing would say so — the exact failure this ordering exists to prevent.
  const { cfg, accepted } = recordingConfig();
  configureDurableDelegation(cfg);
  for (const target of ['codingAgent', 'musicianAgent', 'chefagent', 'nonesuch', '']) {
    const result = await withFlags(ON, () => dispatchDurableDelegation(request({ agentId: target })));
    assert.equal(result, null, `${target} must not route durably`);
  }
  assert.equal(accepted.length, 0, 'a refused target must leave NO accepted job behind');
});

await check('a routable target is accepted with the capability PINNED', async () => {
  const { cfg, accepted } = recordingConfig();
  configureDurableDelegation(cfg);
  const req = request();
  const result = await withFlags(ON, () => dispatchDurableDelegation(req));
  assert.ok(result, 'chefAgent is routable');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].capability, 'chefAgent', 'the target must be frozen, never re-derived');
  assert.equal(accepted[0].goal, req.prompt);
});

await check('the delegationId IS the idempotency key', async () => {
  // A retried delegation must resume the SAME job, not start a second run of
  // work that may already be halfway through.
  const { cfg, accepted } = recordingConfig();
  configureDurableDelegation(cfg);
  const req = request();
  await withFlags(ON, () => dispatchDurableDelegation(req));
  await withFlags(ON, () => dispatchDurableDelegation(req));
  assert.equal(accepted.length, 2, 'both calls reach the boundary');
  assert.equal(accepted[0].commandId, accepted[1].commandId, 'with one key, so the boundary dedupes');
  assert.match(String(accepted[0].commandId), /^delegation:del_/);
});

await check('the owner key has ONE definition, shared with the durable-job tools', async () => {
  // Not cosmetic: a delegated job keyed differently from what
  // `orchestration_get_job` derives is a job the caller can never see or answer,
  // and owner scoping makes "not yours" indistinguishable from "does not exist",
  // so nothing would report the mistake.
  const { cfg, accepted } = recordingConfig();
  configureDurableDelegation(cfg);
  await withFlags(ON, () => dispatchDurableDelegation(request({ callerAgentId: 'metaAgent' })));
  assert.equal(accepted[0].resourceId, durableJobOwner('metaAgent'));
  const toolSource = await import('node:fs/promises').then((fs) => fs.readFile(
    new URL('../tools/system/orchestration-job-tools.ts', import.meta.url), 'utf8',
  ));
  assert.match(toolSource, /durableJobOwner\(agentId\)/,
    'the tools must CALL the shared owner function, not re-template the same string');
});

await check('durableDelegationEnabled reflects both flags', () => {
  assert.equal(withFlags(ON, durableDelegationEnabled), true);
  assert.equal(withFlags(OFF, durableDelegationEnabled), false);
});

// ── 3. The pin is durable and the lane obeys it ────────────────────────────
const {
  ensureOrchestrationIndexes, acceptStartCommand,
  runLaneForJob, COLLECTIONS,
} = await import('../orchestration/store/index.js');

const store = await connectReplicaSetOrSkip({
  dbName: TEST_DATABASE,
  section: 'check:durable-delegation durability section',
});

if (store) {
  const { client, db } = store;
  await ensureOrchestrationIndexes(db);

  await check('SECURITY: a malformed pin is refused at the boundary, before any write', async () => {
    // A bad name frozen into an accepted job would fail every attempt forever,
    // and the accept is the last moment the caller still holds the error.
    for (const junk of ['chef Agent', 'chefAgent; rm -rf /', '../../etc/passwd', '', '1chefAgent', 'a'.repeat(65)]) {
      await assert.rejects(
        () => acceptStartCommand(client, db, {
          resourceId: 'res_pin', conversationId: 'conv_pin', goal: 'x',
          commandId: `cmd_${randomUUID()}`, payload: {}, capability: junk,
        }),
        /invalid capability pin/,
        `${JSON.stringify(junk)} must not be accepted as a pin`,
      );
    }
    assert.equal(await db.collection(COLLECTIONS.jobs).countDocuments({ resourceId: 'res_pin' }), 0);
  });

  await check('a pinned job freezes the pin onto the plan WITHOUT consulting the decider', async () => {
    const accepted = await acceptStartCommand(client, db, {
      resourceId: 'res_pin', conversationId: 'conv_a', goal: 'plan a tasting menu',
      commandId: `cmd_${randomUUID()}`, payload: { goal: 'plan a tasting menu' },
      capability: 'chefAgent',
    });
    let deciderCalls = 0;
    const wouldPickSomeoneElse = (async () => {
      deciderCalls++;
      return { kind: 'dispatch', attemptMode: 'SERIAL', capability: 'researcherAgent' };
    }) as never;
    await runLaneForJob(client, db, accepted.jobId, 50, undefined, { decide: wouldPickSomeoneElse } as never);
    const task = await db.collection<{ capability?: string | null }>(COLLECTIONS.tasks)
      .findOne({ jobId: accepted.jobId } as never);
    assert.equal(task?.capability, 'chefAgent', 'the producer named the specialist; the model may not overrule it');
    assert.equal(deciderCalls, 0, 'and asking a model who should do known work is a wasted call');
  });

  await check('the pin survives on the job — a restarted process replans to the same specialist', async () => {
    const accepted = await acceptStartCommand(client, db, {
      resourceId: 'res_pin', conversationId: 'conv_b', goal: 'plan a wedding menu',
      commandId: `cmd_${randomUUID()}`, payload: { goal: 'plan a wedding menu' },
      capability: 'chefAgent',
    });
    const job = await db.collection<{ requestedCapability?: string | null }>(COLLECTIONS.jobs)
      .findOne({ _id: accepted.jobId } as never);
    assert.equal(job?.requestedCapability, 'chefAgent', 'the pin must live in the durable aggregate');
  });

  await check('THE PIN IS REACHABLE FROM THE API, not just from the store', async () => {
    // Everything below this line worked, and no caller could use any of it: the
    // HTTP boundary never forwarded `capability`, so the word did not appear in
    // `handlers.ts` at all. Measured — a job submitted for `codingAgent` ran as
    // `deliberationAgent`, which then reported, correctly, that it had none of
    // the requested tools. The pin was validated, stored and honoured by a chain
    // whose first link was missing.
    const { createOrchestrationApi } = await import('../orchestration/http/handlers.js');
    const api = createOrchestrationApi(client, db);
    const response = await api.startCommand(
      { resourceId: 'res_http_pin', principalId: 'res_http_pin' },
      'conv_http_pin',
      {
        commandId: `cmd_${randomUUID()}`,
        goal: 'plan a wedding menu',
        capability: 'chefAgent',
        payload: { goal: 'plan a wedding menu' },
      },
    );
    const jobId = (response.body as { jobId?: string }).jobId;
    assert.ok(jobId, 'the command must have been accepted');
    const job = await db.collection<{ requestedCapability?: string | null }>(COLLECTIONS.jobs)
      .findOne({ _id: jobId } as never);
    assert.equal(job?.requestedCapability, 'chefAgent',
      'a capability named at the API must reach the durable aggregate — otherwise no caller '
      + 'can target an agent and every job is routed by a model reading the goal');
  });

  await check('an UNPINNED job is byte-identical to the pre-pin shape', async () => {
    // The cutover is additive: a job nobody pinned must not gain a field, so an
    // unopinionated plan hashes and reads exactly as it did before.
    const accepted = await acceptStartCommand(client, db, {
      resourceId: 'res_pin', conversationId: 'conv_c', goal: 'anything',
      commandId: `cmd_${randomUUID()}`, payload: {},
    });
    const job = await db.collection(COLLECTIONS.jobs).findOne({ _id: accepted.jobId } as never);
    assert.ok(job && !('requestedCapability' in job), 'absent, not null');
  });

  await check('an unpinned job still reaches the decider', async () => {
    const accepted = await acceptStartCommand(client, db, {
      resourceId: 'res_pin', conversationId: 'conv_d', goal: 'anything else',
      commandId: `cmd_${randomUUID()}`, payload: { n: 1 },
    });
    let deciderCalls = 0;
    const decider = (async () => {
      deciderCalls++;
      return { kind: 'dispatch', attemptMode: 'SERIAL', capability: 'researcherAgent' };
    }) as never;
    await runLaneForJob(client, db, accepted.jobId, 50, undefined, { decide: decider } as never);
    assert.ok(deciderCalls > 0, 'no pin means the lane decides, exactly as before');
    const task = await db.collection<{ capability?: string | null }>(COLLECTIONS.tasks)
      .findOne({ jobId: accepted.jobId } as never);
    assert.equal(task?.capability, 'researcherAgent');
  });

  // ── 4. The bridge keeps the legacy contract ──────────────────────────────
  // Pending messages and delegation rows live in the MAIN application database,
  // not the V2 store — no transaction can span them, which is exactly why the
  // bridge is a polled projection with an idempotency key.
  const { getDb } = await import('../lib/mongo.js');
  let main: Awaited<ReturnType<typeof getDb>> | undefined;
  try {
    main = await getDb();
    await main.command({ ping: 1 });
  } catch (error) {
    skipSectionOrFail(
      'check:durable-delegation bridge section',
      `the main database is unavailable (${(error as Error).message})`,
      'start it with `npm run mongo:up`',
    );
    main = undefined;
  }

  if (main) {
    const MARK = `chk_durdel_${Date.now()}`;
    const rows = main.collection('async_delegations');
    const messages = main.collection('pending_user_messages');
    const seed = async (over: Record<string, unknown> = {}): Promise<string> => {
      const delegationId = `${MARK}_${randomUUID()}`;
      await rows.insertOne({
        delegationId,
        targetAgent: 'chefAgent',
        taskDescription: 'plan a tasting menu',
        callerThreadId: `${MARK}_thread`,
        returnToAgentId: 'metaAgent',
        returnToThreadId: `${MARK}_thread`,
        status: 'running',
        dispatch: 'durable',
        startedAt: new Date(Date.now() - 5_000),
        v2JobId: `job_${delegationId}`,
        v2ResourceId: durableJobOwner('metaAgent'),
        ...over,
      });
      return delegationId;
    };
    const bridgeWith = (
      status: DurableJobSnapshot | null,
      result: DurableJobResult | null,
    ) => configureDurableDelegation({
      resolveCapability: () => null,
      getStore: async () => ({ client, db }),
      accept: async () => ({ jobId: 'unused' }),
      readStatus: async () => status,
      readResult: async () => result,
    } as never);
    const messagesFor = (delegationId: string) =>
      messages.find({ 'metadata.delegationId': delegationId }).toArray();

    await check('a COMPLETED job lands as a result in the caller thread', async () => {
      const delegationId = await seed();
      bridgeWith(
        { jobId: 'j', phase: 'TERMINAL', terminalOutcome: 'COMPLETED' },
        { status: 'ok', data: 'Menu: 5 courses.', summary: null, error: null },
      );
      await runDelegationCompletionBridge();
      const row = await rows.findOne({ delegationId });
      assert.equal(row?.status, 'completed');
      assert.equal(row?.v2TerminalOutcome, 'COMPLETED');
      const queued = await messagesFor(delegationId);
      assert.equal(queued.length, 1, 'the legacy contract is a pending message, and it must arrive');
      assert.equal(queued[0].threadId, `${MARK}_thread`);
      assert.equal(queued[0].targetAgentId, 'metaAgent');
      assert.match(String(queued[0].content), /Menu: 5 courses\./);
    });

    await check('the bridge is idempotent — a second pass adds nothing', async () => {
      const delegationId = await seed();
      bridgeWith(
        { jobId: 'j', phase: 'TERMINAL', terminalOutcome: 'COMPLETED' },
        { status: 'ok', data: 'once', summary: null, error: null },
      );
      await runDelegationCompletionBridge();
      // Re-open the row to simulate the crash window: message delivered, status
      // not yet moved. A re-run must not queue a second copy.
      await rows.updateOne({ delegationId }, { $set: { status: 'running' } });
      await runDelegationCompletionBridge();
      assert.equal((await messagesFor(delegationId)).length, 1,
        'a redelivered terminal must collapse, not duplicate into the agent\'s next turn');
    });

    await check('a FAILED job reports the real error, not "[object Object]"', async () => {
      // `JobResult.error` is `{code,message}`. Treating it as a string is the
      // shape-guess bug this project has shipped three times.
      const delegationId = await seed();
      bridgeWith(
        { jobId: 'j', phase: 'TERMINAL', terminalOutcome: 'FAILED' },
        { status: 'failed', data: null, summary: null, error: { code: 'no_route', message: 'capability chefAgent no longer resolves' } },
      );
      await runDelegationCompletionBridge();
      const row = await rows.findOne({ delegationId });
      assert.equal(row?.status, 'failed');
      assert.equal(row?.error, 'capability chefAgent no longer resolves');
      const queued = await messagesFor(delegationId);
      assert.equal(queued.length, 1);
      assert.ok(!String(queued[0].content).includes('[object Object]'), 'the caller must read a message, not a shape');
      assert.match(String(queued[0].content), /capability chefAgent no longer resolves/);
    });

    await check('a job still WORKING is left alone', async () => {
      const delegationId = await seed();
      bridgeWith({ jobId: 'j', phase: 'DISPATCHING', terminalOutcome: null }, null);
      assert.equal(await runDelegationCompletionBridge(), 0);
      assert.equal((await rows.findOne({ delegationId }))?.status, 'running');
      assert.equal((await messagesFor(delegationId)).length, 0);
    });

    await check('a job AWAITING A HUMAN is surfaced as a question, never as a result', async () => {
      // The class of failure this whole plan keeps hitting: a mechanism that
      // waits for a person, started where there is no person. Reporting the
      // parked job as a finished delegation would be a lie the caller acts on.
      const delegationId = await seed();
      bridgeWith(
        {
          jobId: 'j', phase: 'AWAITING_USER', terminalOutcome: null,
          openRequest: { requestId: 'req_1', kind: 'user', action: 'Which cuisine?' },
        },
        null,
      );
      assert.equal(await runDelegationCompletionBridge(), 0, 'a question is not a settlement');
      const row = await rows.findOne({ delegationId });
      assert.equal(row?.status, 'running', 'the delegation stays open');
      const queued = await messagesFor(delegationId);
      assert.equal(queued.length, 1);
      assert.match(String(queued[0].content), /Which cuisine\?/);
      assert.match(String(queued[0].content), /orchestration_answer_job_request/,
        'and it must tell the caller how to unblock it');
      // Asked once, not once per reconcile tick.
      await runDelegationCompletionBridge();
      await runDelegationCompletionBridge();
      assert.equal((await messagesFor(delegationId)).length, 1);
    });

    await check('a LEGACY-dispatched delegation is not touched by the bridge', async () => {
      const delegationId = await seed({ dispatch: 'legacy', v2JobId: undefined });
      await rows.updateOne({ delegationId }, { $unset: { v2JobId: '' } });
      bridgeWith({ jobId: 'j', phase: 'TERMINAL', terminalOutcome: 'COMPLETED' }, { status: 'ok', data: 'x' });
      await runDelegationCompletionBridge();
      assert.equal((await rows.findOne({ delegationId }))?.status, 'running',
        'the legacy lane owns its own completion');
      assert.equal((await messagesFor(delegationId)).length, 0);
    });

    await rows.deleteMany({ delegationId: { $regex: `^${MARK}` } });
    await messages.deleteMany({ threadId: `${MARK}_thread` });
  }

  await client.db(TEST_DATABASE).dropDatabase();
  await store.close();
}

__resetDurableDelegation();

console.log(failures === 0 ? '\n✅ check:durable-delegation passed' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
