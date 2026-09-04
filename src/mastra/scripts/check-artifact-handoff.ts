#!/usr/bin/env tsx
/**
 * F7 — what a step STORED must reach the next step, by reference.
 *
 * The sequence machinery already told the successor "Artefakty (pełna treść pod
 * tymi id)". That offer was empty for every run ever made, and the emptiness had
 * TWO independent causes, either of which alone was enough:
 *
 *  1. **Nothing filled it.** `harnessCallerFactory` computed the run's artifact
 *     ids (to decide whether the deliverable was a stored document) and then
 *     dropped them: `ModelCaller` returned `{ text, fromArtifact }` with no
 *     channel for references at all.
 *  2. **The reader looked for the wrong key.** `readUpstreamResults` mapped
 *     `a.id` while `artifactRefSchema` has always called it `artifactId`, so it
 *     would have discarded every reference even once they were sent.
 *
 * Both stayed invisible because the existing multi-step gate hand-fed
 * `upstream: [{ artifacts: ['art-1'] }]` and asserted the PROMPT rendered it.
 * That proved the renderer and nothing else — a test written from an idea of the
 * data rather than from data any producer actually emits. So this file starts at
 * the producer boundary and ends at what the next worker is handed, with the
 * real validator and a real replica set in between.
 *
 * Measured consequence when broken: a design step stored an 18 KB document and
 * handed its successor a 2 000-char excerpt with no way to reach the rest.
 *
 * Run: npx tsx src/mastra/scripts/check-artifact-handoff.ts
 */
import assert from 'node:assert/strict';

import { connectReplicaSetOrSkip } from './lib/replica-set.js';
import { countForbiddenWriterEmDashes } from '../tools/writer/anti-slop.js';

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

console.log('check:artifact-handoff');

const REF = {
  artifactId: 'art-c0554a3b-c497-4cdd-8f43-3b40f78270ff',
  type: 'document',
  summary: 'brief wizualny restauracji',
  hash: 'a'.repeat(64),
};

// ── 1. The producer boundary carries references ────────────────────────────
const { modelResultToProducer } = await import('../orchestration/execution/gateway.js');
const { validateProducerResult } = await import('../orchestration/contracts/result-envelope.js');

await check('bounded_text keeps the artifacts a run stored', async () => {
  // `bounded_text` is the mode every harness capability uses: the deliverable IS
  // free text. That is exactly why the references were easy to lose here — the
  // text looks like the whole answer.
  const producer = modelResultToProducer(
    { ok: true, text: 'Brief gotowy.', artifacts: [REF], durationMs: 1 },
    'bounded_text',
  ) as Record<string, unknown>;

  assert.equal(producer.status, 'ok');
  assert.deepEqual(producer.artifacts, [REF], 'the envelope must carry what the run stored');
});

await check('a run that stored nothing sends no empty array', () => {
  const producer = modelResultToProducer(
    { ok: true, text: 'Sama proza.', durationMs: 1 },
    'bounded_text',
  ) as Record<string, unknown>;
  assert.ok(!('artifacts' in producer),
    'absent, not []: the validator rejects values that do not survive a JSON round trip, '
    + 'and the schema defaults an absent field cleanly');
});

await check('the carried shape SURVIVES the real producer validator', () => {
  // The one that matters: an earlier envelope change passed every unit test and
  // then failed live with `invalid_result`, because the test asserted against a
  // stand-in reader instead of this function.
  const verdict = validateProducerResult(modelResultToProducer(
    { ok: true, text: 'Brief gotowy.', artifacts: [REF], durationMs: 1 },
    'bounded_text',
  ));
  assert.ok(verdict.ok, `the validator must accept it: ${JSON.stringify(verdict)}`);
  const value = (verdict as { value: { artifacts?: unknown[] } }).value;
  assert.deepEqual(value.artifacts, [REF], 'and must not strip the references on the way through');
});

await check('the contract keys references by artifactId, not id', () => {
  // Pins the exact disagreement that made the reader silently discard everything.
  // If someone "fixes" the schema to `id`, this fails instead of going quiet.
  const verdict = validateProducerResult({
    status: 'ok',
    data: { text: 'x' },
    artifacts: [{ id: 'art-1', type: 'document' }],
  });
  assert.ok(!verdict.ok, 'a reference keyed `id` must be rejected, not accepted and then dropped');
});

// ── 2. LIVE: from the producer envelope to the next worker's context ────────
const store = await connectReplicaSetOrSkip({
  dbName: `arthandoff_${Date.now()}`,
  section: 'artifact handoff',
});
if (!store) process.exit(failures === 0 ? 0 : 1);

const { client, db } = store;
const {
  ensureOrchestrationIndexes, acceptStartCommand, planJob, spawnChildTasks,
  drainLane, runToQuiescence,
} = await import('../orchestration/store/index.js');
await ensureOrchestrationIndexes(db);

await check('LIVE: step 2 receives the id of what step 1 stored', async () => {
  const accepted = await acceptStartCommand(client, db, {
    resourceId: 'res_arthandoff', conversationId: 'conv_1', goal: 'brief a potem opis',
    commandId: `cmd_${Date.now()}`, payload: { goal: 'brief a potem opis' },
  });
  const jobId = accepted.jobId;
  const parentTaskId = (await planJob(client, db, jobId))!.taskId;
  await spawnChildTasks(client, db, {
    jobId,
    parentTaskId,
    children: [
      { goal: 'zrób brief wizualny', capability: 'designAgent' },
      { goal: 'opisz brief słowami', capability: 'writerAgent', after: 0 },
    ],
  });

  const seen = new Map<string, unknown>();
  await runToQuiescence(client, db, drainLane, ((ctx: {
    capability?: string | null; jobId: string; upstream?: unknown;
  }) => {
    if (ctx.jobId !== jobId) return { status: 'ok', data: {} };
    seen.set(ctx.capability ?? 'none', ctx.upstream);
    // The design step answers exactly as the fixed caller now does: the text it
    // said, PLUS a reference to the document it wrote.
    return ctx.capability === 'designAgent'
      ? { status: 'ok', data: { text: 'Brief gotowy.' }, summary: 'brief', artifacts: [REF] }
      : { status: 'ok', data: { text: 'opisane' }, summary: 'opis' };
  }) as never);

  const forWriter = seen.get('writerAgent') as Array<Record<string, unknown>> | undefined;
  assert.ok(forWriter && forWriter.length === 1, 'the writer must receive its predecessor');
  assert.deepEqual(
    forWriter[0].artifacts, [REF.artifactId],
    'the stored document must arrive as a fetchable id — this is the assertion that '
    + 'fails when the reader keys off `id` instead of `artifactId`',
  );
});

await check('LIVE: and it reaches the PROMPT the successor actually reads', async () => {
  // A context field nothing renders is a field the agent never sees. Same route
  // the lane uses, fed from the context the previous check proved is real.
  const { capabilityRoute } = await import('../orchestration/execution/registry-worker.js');
  const route = capabilityRoute({ resolve: (n) => n, defaultAgentId: 'writerAgent' });
  const decision = route({
    attemptId: 'a', taskId: 't', jobId: 'j', attemptNumber: 1,
    businessOperationCutoffAt: new Date(), workDeadlineAt: new Date(), hardDeadlineAt: new Date(),
    goal: 'opisz brief', jobGoal: 'brief a potem opis', taskGoal: 'opisz brief',
    instructions: [], capability: 'writerAgent',
    upstream: [{
      taskId: 'prev', capability: 'designAgent', goal: 'zrób brief',
      status: 'ok', summary: 'brief', artifacts: [REF.artifactId], preview: 'Brief gotowy.',
    }],
  } as never);
  assert.ok(decision, 'the route must resolve');
  assert.match(decision!.prompt, new RegExp(REF.artifactId),
    'the successor is told the id it can fetch the full document with');
});

// ── 3. Is the artifact the DELIVERABLE, or a record OF one? ────────────────
//
// Both answers are right, for different capabilities, and getting it backwards
// is visible to the user either way:
//  - designAgent's brief IS the file; its prose is a note about the work, so the
//    artifact must replace it (measured: 906 chars of narration vs 18 KB of HTML);
//  - automationArchitect's product is a deployed workflow, and once the Golden
//    Path started recording that workflow, substitution turned a readable
//    "deployed X, id Y, inactive, risk 15" into 3 601 chars of raw JSON.
//
// The fake here is the AGENT — the boundary that would call a model. The caller,
// the harness and the artifact store are real, and the artifact is really written,
// because the thing under test is what the caller does with a stored artifact.
const { putArtifact } = await import('../services/artifact-store.js');
const { harnessCallerFactory } = await import('../orchestration/execution/harness-agent-caller.js');

const AGENT_SAID = 'Wdrożone. workflowId X6dT4, nieaktywny.';
const ARTIFACT_BODY = '{"nodes":[{"name":"Webhook"}],"connections":{}}';

class StoringAgent {
  async generate(): Promise<unknown> {
    // Inside the harness run, so `putArtifact` attributes this to it exactly as a
    // real tool call would — no id is passed by hand anywhere in this test.
    await putArtifact({
      type: 'automation_workflow',
      content: ARTIFACT_BODY,
      producedBy: 'check-artifact-handoff',
      summary: 'workflow zapisany przez run',
    });
    return { text: AGENT_SAID, steps: [], finishReason: 'stop', toolCalls: [], toolResults: [] };
  }
}

async function callerResultFor(agentId: string): Promise<{
  text: string; fromArtifact?: boolean; artifacts?: Array<{ artifactId: string }>;
}> {
  const now = Date.now();
  const caller = harnessCallerFactory({
    agent: new StoringAgent() as never,
    agentId,
    ctx: {
      attemptId: `att-${agentId}-${now}`, taskId: `task-${now}`, jobId: `job-${now}`,
      attemptNumber: 1,
      businessOperationCutoffAt: new Date(now + 600_000),
      workDeadlineAt: new Date(now + 540_000),
      hardDeadlineAt: new Date(now + 900_000),
      goal: 'zbuduj automatyzację',
    } as never,
  } as never);
  return await caller({ prompt: 'zbuduj automatyzację', signal: new AbortController().signal }) as never;
}

await check('for a document producer the artifact REPLACES the prose', async () => {
  const out = await callerResultFor('designAgent');
  assert.equal(out.fromArtifact, true, 'the stored file is the deliverable, the narration is not');
  assert.match(out.text, /"nodes"/, 'the artifact content must be what travels');
  assert.ok((out.artifacts?.length ?? 0) > 0, 'and the reference travels with it');
});

await check('for a side-effect capability the artifact is ATTACHED, not substituted', async () => {
  const out = await callerResultFor('automationArchitect');
  assert.ok(!out.fromArtifact,
    'the report is the deliverable here — the workflow JSON is the reference');
  assert.equal(out.text.trim(), AGENT_SAID,
    'the user must get the readable report, not the raw definition');
  assert.ok((out.artifacts?.length ?? 0) > 0,
    'the reference must STILL travel — attaching it is the whole point');
});

// ── 4. A run may not claim an artifact it did not store ────────────────────
//
// Measured twice on the marketing canary: real work done, then
// "[Artifact_ID: Follow_up_Procedure_Log]" with `producer.artifacts` empty. The
// orchestrator knows the ids, so the claim is checkable rather than a matter of
// taste — and asking the model again is not a fix, it is the same request that
// already failed.
const { auditArtifactClaims } = await import('../orchestration/execution/artifact-claim-guard.js');

await check('a report that invents an artifact id is corrected, not trusted', () => {
  const audit = auditArtifactClaims('Zrobione.\n\n[Artifact_ID: Follow_up_Procedure_Log]', []);
  assert.equal(audit.claimedWithoutStoring, true);
  assert.match(audit.text, /weryfikacja systemu/, 'the reader must see the correction');
  assert.match(audit.text, /nie zapisał żadnego artefaktu/);
  assert.match(audit.text, /^Zrobione\./, 'the real work must survive — only the claim is corrected');
});

await check('an id that looks like ours but was never stored is named', () => {
  const audit = auditArtifactClaims(
    `Gotowe, artefakt ${REF.artifactId} zapisany.`,
    ['art-99999999-1111-2222-3333-444444444444'],
  );
  assert.deepEqual(audit.unbackedIds, [REF.artifactId]);
  assert.match(audit.text, /zapisane artefakty tego runu: art-99999999/,
    'the correction states what IS true, not merely that something is wrong');
});

await check('a TRUTHFUL report is left exactly as written', () => {
  // The direction that matters most: a guard that annotates correct work would be
  // worse than no guard, because the annotation is what the user reads.
  const text = `Wdrożone. Artifact ID: ${REF.artifactId}.`;
  const audit = auditArtifactClaims(text, [REF.artifactId]);
  assert.equal(audit.text, text);
  assert.equal(audit.unbackedIds.length, 0);
  assert.equal(audit.claimedWithoutStoring, false);
});

await check('a writer deliverable with an em-dash is normalized, NOT thrown away', async () => {
  // Measured on the seven-agent sieve run: a 150-word story came back with one
  // em-dash, the attempt failed, the retry failed identically, and the job ended
  // FAILED with nothing to show. The ban was already in writer's own prompts three
  // times and in the global house style, so asking again had been exhausted — and
  // a failed attempt is RETRIED, so the model regenerates a manuscript over one
  // character.
  const now = Date.now();
  class DashAgent {
    async generate(): Promise<unknown> {
      return {
        text: 'Piekarnia budziła się o świcie — mąka wisiała w powietrzu.',
        steps: [], finishReason: 'stop', toolCalls: [], toolResults: [],
      };
    }
  }
  const caller = harnessCallerFactory({
    agent: new DashAgent() as never,
    agentId: 'writerAgent',
    ctx: {
      attemptId: `att-writer-${now}`, taskId: `task-${now}`, jobId: `job-${now}`,
      attemptNumber: 1,
      businessOperationCutoffAt: new Date(now + 600_000),
      workDeadlineAt: new Date(now + 540_000),
      hardDeadlineAt: new Date(now + 900_000),
      goal: 'napisz opowiadanie',
    } as never,
  } as never);
  const out = await caller({
    prompt: 'napisz opowiadanie',
    signal: new AbortController().signal,
  }) as { text: string };
  assert.equal(countForbiddenWriterEmDashes(out.text), 0, 'the dash must be gone');
  assert.match(out.text, /o świcie - mąka/, 'and the story must survive, not the run fail');
});

await check('prose that merely mentions artifacts is not a claim', () => {
  // The marker set is narrow on purpose: an agent discussing its artifacts, or a
  // document containing the word, must not trip this.
  const prose = 'Artefakty pipeline’u przechowujemy w Mongo, a raport opisuje ich rolę.';
  assert.equal(auditArtifactClaims(prose, []).text, prose);
});

await client.close();
console.log(failures === 0 ? '\nOK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
