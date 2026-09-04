#!/usr/bin/env tsx
/**
 * check:v2-learning-loop — work done on V2 feeds the skill corpus, the same way
 * legacy delegations always have.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `recordDistillationCandidate` had exactly two callers: `delegate-task.ts` —
 * the LEGACY delegation tool — and the capability build path. The durable
 * orchestration path had none. So every job that ran through V2 taught the
 * system nothing, and the more work moved onto V2, the less it learned.
 *
 * Nothing failed. There is no error, no warning, no failing test; the corpus
 * simply stops growing, and the absence is only noticeable months later when
 * someone asks why no skills have been distilled since the cutover. That is why
 * it needs a gate rather than a note.
 *
 * WHAT SUPPLIES THE EVIDENCE, AND WHY IT IS DIFFERENT FROM LEGACY
 * ---------------------------------------------------------------
 * Legacy reads `lessons` out of a result envelope the sub-agent emits. V2 does
 * not parse an envelope at all (`parseResultEnvelope` has no caller anywhere in
 * `orchestration/`). So the V2 evidence is what the run DID: how many tools it
 * called, and whether it recovered after a tool error — both already recognised
 * by `shouldDistill`. This supplies existing triggers; it does not invent a rule.
 *
 * Run: npx tsx src/mastra/scripts/check-v2-learning-loop.ts
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shouldDistill } from '../services/skill-distiller.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:v2-learning-loop');

const CALLER = 'src/mastra/orchestration/execution/harness-agent-caller.ts';
const src = readFileSync(CALLER, 'utf-8');

/** Code with comments stripped — prose about a fix is not the fix. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

await check('the V2 execution path records a distillation candidate at all', () => {
  assert.match(code, /recordDistillationCandidate\(/,
    'the durable path must feed the learning loop — this was its only missing caller');
});

await check('it records on SUCCESS, not on every exit', () => {
  // Recording a failed run as a skill candidate would teach the corpus how to
  // fail. The call must sit on the successful return.
  const callAt = code.indexOf('recordDistillationCandidate(');
  const successReturn = code.indexOf('return {\n      text,', callAt);
  assert.ok(successReturn > callAt,
    'the record must be immediately before the successful return');
  const between = code.slice(callAt, successReturn);
  assert.ok(!/throw |return \{\s*error/.test(between),
    'nothing may divert between deciding to record and returning success');
});

await check('the evidence is gathered DURING the run, not guessed afterwards', () => {
  // Tool-call counts cannot be recovered from the final response: the harness
  // makes several `generate` calls and returns the last, so a run with 45 events
  // can report `steps=1, toolCalls=0`. The counters must be fed by the step
  // observer.
  const observerAt = code.indexOf('onStepObservation:');
  assert.ok(observerAt > 0, 'the caller must observe steps');
  const observerBody = code.slice(observerAt, observerAt + 700);
  assert.match(observerBody, /toolCalls\.length/,
    'tool calls must be counted as they happen');
  assert.match(observerBody, /isError/,
    'and a recovery after a tool error is the other trigger shouldDistill knows');
});

await check('EVERY agent is observed, not just the one that needed it first', () => {
  // The defect this caught, on the first live run after the hook was added: the
  // step observer existed ONLY inside `agentId === 'writerAgent' && progressPolicy`,
  // and the counters were put inside it. A codingAgent run that made 19 real tool
  // calls reported toolCalls=0. Nothing failed and the wiring assertions above
  // were satisfied — they proved the counters were connected to a hook that this
  // agent was never handed.
  const observerAt = code.indexOf('onStepObservation:');
  // What comes immediately before it must not be a conditional spread that
  // narrows who gets the hook at all.
  const preamble = code.slice(Math.max(0, observerAt - 300), observerAt);
  assert.ok(!/\.\.\.\(\s*args\.agentId ===/.test(preamble),
    'the observer must not sit inside an agent-specific spread — that is how it '
    + 'became invisible to every agent but the writer');

  // The writer-specific work may still be conditional, but INSIDE the hook.
  const hookBody = code.slice(observerAt, observerAt + 900);
  const countAt = hookBody.indexOf('toolCallsThisRun');
  const writerGuardAt = hookBody.search(/args\.agentId === 'writerAgent'/);
  assert.ok(countAt >= 0, 'the hook must count');
  if (writerGuardAt >= 0) {
    assert.ok(countAt < writerGuardAt,
      'counting must happen BEFORE any agent-specific early return, or it is '
      + 'conditional again by another route');
  }
});

await check('the counters it passes are ones shouldDistill actually acts on', () => {
  // A caller can pass perfectly good evidence under a field the predicate does
  // not read, and nothing anywhere would say so.
  const callAt = code.indexOf('recordDistillationCandidate(');
  const callBody = code.slice(callAt, callAt + 500);
  assert.match(callBody, /toolCallCount:/, 'tool count must be passed');
  assert.match(callBody, /recovered:/, 'recovery must be passed');

  // And the predicate must genuinely fire on them.
  assert.equal(shouldDistill({ toolCallCount: 50 }).distill, true,
    'a tool-heavy run must be a candidate');
  assert.equal(shouldDistill({ recovered: true }).distill, true,
    'a recovery must be a candidate');
  assert.equal(shouldDistill({ toolCallCount: 0, recovered: false }).distill, false,
    'and a trivial run must not be — otherwise every job floods the queue');
});

await check('the decision is visible in the log, whichever way it goes', () => {
  // "No candidate recorded" and "the hook never ran" are indistinguishable from
  // the outside. Measured: a COMPLETED job produced nothing, and only a tool
  // count pulled from telemetry showed it was 4 calls against a threshold of 5,
  // rather than a dead hook. Without the line, the next person re-derives that.
  const callAt = code.indexOf('recordDistillationCandidate(');
  const before = code.slice(Math.max(0, callAt - 400), callAt);
  assert.match(before, /distillation evidence/,
    'the run must state the evidence it gathered, so a silent skip is legible');
  assert.match(before, /toolCalls=/, 'including the count the threshold is compared against');
});

await check('bookkeeping cannot fail a finished job', () => {
  const callAt = code.indexOf('recordDistillationCandidate(');
  const tail = code.slice(callAt, callAt + 700);
  assert.match(code.slice(Math.max(0, callAt - 20), callAt), /void\s*$/,
    'the call must be fire-and-forget — a slow distiller must not extend the run');
  assert.match(tail, /\.catch\(/,
    'and a throwing distiller must not turn a finished job into a failed one');
});

await check('LEGACY is untouched: its own caller is still there', () => {
  // The V2 hook is an addition. If this ever fails, delegation stopped learning
  // in exchange for orchestration learning, which is not the trade.
  const legacy = readFileSync('src/mastra/tools/system/delegate-task.ts', 'utf-8');
  assert.match(legacy, /recordDistillationCandidate\(/,
    'the legacy delegation path must keep feeding the corpus too');
});

await check('CORPUS: the gates do not teach the system about their own fixtures', async () => {
  // Measured 2026-08-17: 1290 candidates, of which ~1114 (86%) were gate residue
  // — 918 copies of one smoke-test goal, one per `check:all` since the build path
  // started recording candidates. Both gates HAD cleanup lists; neither knew
  // about this collection, because the lists predate the recording.
  //
  // The cost is not a stray row. The distiller spends model calls on whatever is
  // queued, so a corpus that is seven-eighths fixture turns the learning loop
  // into a machine for re-learning `echo`.
  const { getDb } = await import('../lib/mongo.js');
  const db = await getDb();
  const residue = await db.collection('distillation_candidates').countDocuments({
    goal: { $regex: 'smoke-test the build pipeline|chk-buildlease-|chk-build-|checkgate-' },
  });
  assert.equal(residue, 0,
    `${residue} gate fixtures are sitting in the production learning corpus — `
    + 'the gate that created them must delete them');
});

await check('and both build gates know this collection exists', () => {
  for (const gate of [
    'src/mastra/scripts/check-capability-build-gates.ts',
    'src/mastra/scripts/check-capability-build-lease.ts',
  ]) {
    assert.match(readFileSync(gate, 'utf-8'), /distillation_candidates/,
      `${gate}: a gate that drives the build path records a candidate, so its `
      + 'cleanup must name this collection');
  }
});

if (failures > 0) {
  console.error(`\n❌ check:v2-learning-loop — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:v2-learning-loop — durable jobs feed the skill corpus');
process.exit(0);
