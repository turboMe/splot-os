#!/usr/bin/env tsx
/**
 * check:coding-task-scope — which task a coding tool operates on is decided by
 * the RUN, and the run's unit of work is the JOB.
 *
 * TWO PROPERTIES, AND THE SECOND ONE IS EASY TO GET WRONG
 * ------------------------------------------------------
 * 1. AUTHORITY. Every worktree, artifact and ledger tool takes a `taskId`, and
 *    that id decides which worktree gets written. §4.2's rule — an authority
 *    field never comes from model text — applies to it exactly as it applies to
 *    the caller identity that `delegate-task` learned to take from the run.
 *    Legacy got away with a tool argument because a workflow step wrote the id
 *    into the prompt first; V2's prompt is `goal + upstream + contract`, with no
 *    identifier anywhere, so a durable job would have INVENTED one.
 *
 * 2. GRANULARITY. A V2 job may be a SEQUENCE — write the patch, then review it —
 *    and each step is a separate task with its own id. Scoping to the step would
 *    hand the reviewer a different scope than the author: it would look for the
 *    diff under an id nothing was written to and report "no active worktree" for
 *    work that exists. Legacy already settles this — `repo-maintenance-workflow`
 *    threads ONE taskId through diagnose → patch → review → merge — so the legacy
 *    notion of "task" is a V2 JOB, not a V2 task.
 *
 * 3. CONTINUATION, which properties 1 and 2 broke. Merging is human-gated, so it
 *    arrives as a SECOND job: one job builds and asks, a human approves, the next
 *    job merges. Letting the run win there overrode the correct id the model had
 *    supplied and `coding_apply_patch` reported "no active worktree" for a
 *    worktree sitting on disk — the merge canary measured exactly this. So the
 *    rule splits by what the tool does: CREATION takes the run's scope (an
 *    invented id would key work nothing can find), operations on EXISTING work
 *    honour an explicit id, and the authority argument moves to the permit, which
 *    is now bound to the task the human actually approved.
 *
 * Run: npx tsx src/mastra/scripts/check-coding-task-scope.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runWithHarnessExecutionContext } from '../services/harness-execution-context.js';
import {
  resolveCodingTaskId,
  requireCodingTaskId,
  resolveExistingCodingTaskId,
} from '../tools/dev/coding-task-scope.js';

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

console.log('check:coding-task-scope');

await check('SECURITY: the run wins over whatever the model typed', async () => {
  await runWithHarnessExecutionContext({ taskId: 'task_real' }, async () => {
    assert.equal(resolveCodingTaskId('task_invented_by_model'), 'task_real');
    assert.equal(requireCodingTaskId('../../etc/passwd'), 'task_real');
  });
});

await check('GRANULARITY: two steps of ONE job share one scope', async () => {
  // The failure this prevents: author and reviewer are separate tasks, so a
  // step-scoped worktree is invisible to the reviewer.
  const author = await runWithHarnessExecutionContext(
    { taskId: 'task_step_write', threadId: 'orch-v2-job:job_abc' },
    async () => resolveCodingTaskId(),
  );
  const reviewer = await runWithHarnessExecutionContext(
    { taskId: 'task_step_review', threadId: 'orch-v2-job:job_abc' },
    async () => resolveCodingTaskId(),
  );
  assert.equal(author, 'job_abc');
  assert.equal(reviewer, 'job_abc');
  assert.equal(author, reviewer, 'the reviewer must see the worktree the author created');
});

await check('two DIFFERENT jobs never share a worktree', async () => {
  const a = await runWithHarnessExecutionContext(
    { taskId: 't1', threadId: 'orch-v2-job:job_one' }, async () => resolveCodingTaskId());
  const b = await runWithHarnessExecutionContext(
    { taskId: 't2', threadId: 'orch-v2-job:job_two' }, async () => resolveCodingTaskId());
  assert.notEqual(a, b, 'job isolation is the whole point of scoping to the job');
});

await check('LEGACY unchanged: without a V2 thread the taskId IS the unit of work', async () => {
  // `repo-maintenance-workflow` and `delegate-task` both pass one id per unit,
  // so legacy must resolve to exactly what it passed — byte for byte.
  await runWithHarnessExecutionContext({ taskId: 'heal-abc123' }, async () => {
    assert.equal(resolveCodingTaskId(), 'heal-abc123');
    assert.equal(resolveCodingTaskId('heal-abc123'), 'heal-abc123');
  });
  await runWithHarnessExecutionContext(
    { taskId: 'delegation-xyz', threadId: 'delegation-xyz' },
    async () => assert.equal(resolveCodingTaskId(), 'delegation-xyz'),
  );
});

await check('an autoheal task keeps its heal- prefix through the job scope', async () => {
  // `isAutohealTask` matches on the prefix, and the live-merge permission depends
  // on it — a scope that renamed the task would silently revoke that permission.
  const { isAutohealTask } = await import('../services/autoheal-repair-lane.js');
  await runWithHarnessExecutionContext({ taskId: 'heal-sig-1' }, async () => {
    assert.equal(isAutohealTask(requireCodingTaskId()), true);
  });
});

await check('no context and no argument is an ERROR, not an empty lookup', async () => {
  // An empty id reaches Mongo as a query matching nothing, and "no artifact for
  // ''" is a far worse message than the truth.
  assert.equal(resolveCodingTaskId(), undefined);
  assert.throws(() => requireCodingTaskId(), /No task id/);
  assert.equal(resolveCodingTaskId('explicit-from-caller'), 'explicit-from-caller');
});

await check('a malformed V2 thread falls back to the task rather than to nothing', async () => {
  await runWithHarnessExecutionContext(
    { taskId: 'task_fallback', threadId: 'orch-v2-job:' },
    async () => assert.equal(resolveCodingTaskId(), 'task_fallback'),
  );
});

// ── 3. Continuation across jobs, and the permit that keeps it honest ─────────
await check('CONTINUATION: a later job can act on an earlier job\'s worktree', async () => {
  // The merge canary: job 1 builds and asks for approval, a human approves, and
  // job 2 is told to merge. Job 2's run knows only its own id.
  await runWithHarnessExecutionContext(
    { agentId: 'codingAgent', runId: 'r', threadId: 'orch-v2-job:job_SECOND' },
    async () => {
      assert.equal(resolveExistingCodingTaskId('job_FIRST'), 'job_FIRST',
        'an explicitly named earlier job must be honoured, or human-gated merge cannot work');
      assert.equal(resolveExistingCodingTaskId(), 'job_SECOND',
        'with nothing supplied the run still decides');
      assert.equal(resolveExistingCodingTaskId('  '), 'job_SECOND',
        'blank is not a choice');
      // And creation is NOT affected: a fresh worktree belongs to this job.
      assert.equal(requireCodingTaskId('job_FIRST'), 'job_SECOND',
        'coding_init_worktree must not be steerable by model text');
    },
  );
});

await check('the merge tools take the continuation resolver, creation does not', async () => {
  const src = readFileSync('src/mastra/tools/dev/code-worktree.ts', 'utf-8');
  const initAt = src.indexOf("id: 'coding_init_worktree'");
  const removeAt = src.indexOf("id: 'coding_remove_worktree'");
  assert.ok(initAt >= 0 && removeAt > initAt);
  const initBody = src.slice(initAt, removeAt);
  assert.ok(/requireCodingTaskId\(rawContext\.taskId\)/.test(initBody)
    && !/requireExistingCodingTaskId/.test(initBody),
    'creating a worktree must keep the run-wins rule');
  const applyAt = src.indexOf("id: 'coding_apply_patch'");
  const applyBody = src.slice(applyAt, applyAt + 2000);
  assert.ok(/requireExistingCodingTaskId/.test(applyBody),
    'merging must honour a named earlier task, or a human-gated merge is unreachable');
});

await check('PERMIT: an approval granted for one task cannot be spent on another', async () => {
  // With an explicit id honoured, the permit is what stops it being abused: the
  // human approved a specific piece of work, and this is where that is enforced.
  const { consumeOneTimePermit } = await import('../services/one-time-permit.js');
  const { getDb } = await import('../lib/mongo.js');
  const db = await getDb();
  const approvals = db.collection('approvals');
  const token = `scope-check-${Date.now()}`;
  await approvals.insertOne({
    id: token, status: 'approved', taskId: 'job_APPROVED', tool: 'coding_apply_patch',
  });
  try {
    assert.equal(
      await consumeOneTimePermit({
        token, consumerId: 'job_OTHER', subject: 'task-job_OTHER',
        stampPrefix: 'liveMerge', forTaskId: 'job_OTHER',
      }),
      'wrong_task',
      'a permit must not answer a question the human was never asked');
    // Unspent — a refused attempt must not burn the human's approval.
    assert.equal((await approvals.findOne({ id: token }))?.liveMergeConsumedBy, undefined,
      'a rejected attempt must leave the permit usable for the task it was granted for');
    assert.equal(
      await consumeOneTimePermit({
        token, consumerId: 'job_APPROVED', subject: 'task-job_APPROVED',
        stampPrefix: 'liveMerge', forTaskId: 'job_APPROVED',
      }),
      'approved',
      'the task it WAS granted for must still go through');
  } finally {
    await approvals.deleteOne({ id: token });
  }
});

await check('PERMIT: an approval for one ACTION cannot authorise another', async () => {
  // Found by securityReviewAgent reviewing one-time-permit.ts (E9 canary):
  // the CAS filter bound a token to id + status + "not yet stamped" and nothing
  // else, so an approval a human granted for a low-risk action would spend just
  // as well on `coding_apply_patch` and a merge into the live repository.
  const { consumeOneTimePermit } = await import('../services/one-time-permit.js');
  const { getDb } = await import('../lib/mongo.js');
  const approvals = (await getDb()).collection('approvals');
  const token = `scope-tool-${Date.now()}`;
  await approvals.insertOne({
    id: token, status: 'approved', taskId: 'job_T', tool: 'gmail.send_draft',
  });
  try {
    assert.equal(
      await consumeOneTimePermit({
        token, consumerId: 'job_T', subject: 'task-job_T',
        stampPrefix: 'liveMerge', forTaskId: 'job_T', forTool: 'coding_apply_patch',
      }),
      'wrong_tool',
      'a mail approval must not authorise a merge');
    assert.equal((await approvals.findOne({ id: token }))?.permitConsumedBy, undefined,
      'and the refused attempt must leave the permit unspent');
    assert.equal(
      await consumeOneTimePermit({
        token, consumerId: 'job_T', subject: 'draft-1',
        stampPrefix: 'liveMerge', forTaskId: 'job_T', forTool: 'gmail.send_draft',
      }),
      'approved',
      'the action it WAS granted for must still go through');
  } finally {
    await approvals.deleteOne({ id: token });
  }
});

await check('PERMIT: one token is spent ONCE across all consumers, not once each', async () => {
  // Same review: the stamp is per `stampPrefix`, so `promote` and `liveMerge`
  // wrote different fields and the same token could be burned by each. "Exactly
  // once" held per consumer, which is not what a human granting one approval
  // believes they are granting.
  const { consumeOneTimePermit } = await import('../services/one-time-permit.js');
  const { getDb } = await import('../lib/mongo.js');
  const approvals = (await getDb()).collection('approvals');
  const token = `scope-once-${Date.now()}`;
  await approvals.insertOne({ id: token, status: 'approved' });
  try {
    assert.equal(
      await consumeOneTimePermit({ token, consumerId: 'build-1', subject: 'commit-abc', stampPrefix: 'promote' }),
      'approved', 'the first consumer spends it');
    assert.equal(
      await consumeOneTimePermit({ token, consumerId: 'job-1', subject: 'task-job-1', stampPrefix: 'liveMerge' }),
      'already_used',
      'a DIFFERENT consumer must not be able to spend the same approval again');
  } finally {
    await approvals.deleteOne({ id: token });
  }
});

await check('VISIBILITY: an overruled scope is reported to the model, not only logged', async () => {
  // Measured on the merge canary: an agent was told to write into an earlier
  // job's worktree, the run redirected the write into its own, the tool said
  // "success", and the agent then asked a HUMAN to approve merging a branch its
  // file was not on. One line on the server's stdout, nothing the actor could
  // see. Silence about a correction is how a confident false report is made.
  const { normalizeCodingScope, appendScopeNote, scopeOverrideNote } =
    await import('../tools/dev/coding-task-scope.js');

  await runWithHarnessExecutionContext(
    { agentId: 'codingAgent', runId: 'r', threadId: 'orch-v2-job:job_MINE' },
    async () => {
      const normalized = normalizeCodingScope({ taskId: 'job_THEIRS', path: 'a.ts' });
      assert.equal(normalized.taskId, 'job_MINE', 'the run still decides');
      const out = appendScopeNote({ success: true, message: 'Written.' }, normalized);
      assert.match(out.message, /job_THEIRS/, 'the id the model named must appear');
      assert.match(out.message, /job_MINE/, 'and so must the one it actually got');
      assert.match(out.message, /coding_apply_patch/,
        'and the way to reach the other worktree, or the note is a dead end');

      // Agreement is silent — a note on every call is noise that gets ignored.
      const agreed = normalizeCodingScope({ taskId: 'job_MINE', path: 'a.ts' });
      assert.equal(appendScopeNote({ success: true, message: 'Written.' }, agreed).message,
        'Written.', 'no disagreement, no note');
      const implicit = normalizeCodingScope({ path: 'a.ts' } as { taskId?: string; path: string });
      assert.equal(appendScopeNote({ success: true, message: 'Written.' }, implicit).message,
        'Written.', 'naming nothing is not a disagreement');
      assert.equal(scopeOverrideNote(undefined, 'job_MINE'), '');
    },
  );
});

await check('the creating tools are wired to report it', () => {
  for (const file of [
    'src/mastra/tools/dev/code-change-ledger.ts',
    'src/mastra/tools/dev/code-task-artifacts.ts',
  ]) {
    const src = readFileSync(file, 'utf-8');
    assert.ok(!/normalizeInput: \(input\) => \(\{ \.\.\.input, taskId: requireCodingTaskId/.test(src),
      `${file}: the bare normalizer drops the disagreement on the floor`);
    if (src.includes('normalizeCodingScope')) {
      assert.ok(src.includes('appendScopeNote'),
        `${file}: normalizing without reporting is the defect this check exists for`);
    }
  }
  const wt = readFileSync('src/mastra/tools/dev/code-worktree.ts', 'utf-8');
  assert.ok(wt.includes('${scopeNote}'),
    'coding_init_worktree must carry the note into its own message');
});

await check('CONTRACT: a tool whose scope the run owns must not REQUIRE it', async () => {
  // Measured on the first live autoheal cycle (G4, 2026-08-17). The model called
  // `coding_run_test` with `task_id` instead of `taskId`, zod rejected the call
  // before `normalizeInput` could supply the id from the run, and the subtask
  // executor recorded a model failure. Four in a row opened the circuit breaker
  // and escalated to a bigger local model — 13 GB of VRAM spent on a contract
  // defect. The model was behaving sensibly: V2 hands it no task id anywhere, so
  // requiring one leaves it inventing a value that the run then overrides.
  //
  // Legacy hid this completely, because the workflow writes the id into the
  // prompt first.
  const { readFileSync } = await import('node:fs');
  const offenders: string[] = [];
  for (const file of [
    'src/mastra/tools/dev/code-task-artifacts.ts',
    'src/mastra/tools/dev/code-change-ledger.ts',
    'src/mastra/tools/dev/code-worktree.ts',
  ]) {
    const src = readFileSync(file, 'utf-8');
    const marks = [...src.matchAll(/id: '(coding_[a-z_]+)'/g)];
    for (let i = 0; i < marks.length; i += 1) {
      const start = marks[i]!.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1]!.index ?? src.length) : src.length;
      const body = src.slice(start, end);
      const resolvesFromRun = /require(Existing)?CodingTaskId|normalizeCodingScope/.test(body);
      // The INPUT schema only. An OUTPUT that names the task is correct and must
      // stay required — the first version of this check scanned the whole tool
      // body, flagged four output schemas, and read exactly like a real finding.
      const inputAt = body.indexOf('inputSchema:');
      const outputAt = body.indexOf('outputSchema:');
      const inputBlock = inputAt < 0
        ? ''
        : body.slice(inputAt, outputAt > inputAt ? outputAt : body.length);
      const demandsIt = /taskId: z\.string\(\),/.test(inputBlock);
      if (resolvesFromRun && demandsIt) offenders.push(`${marks[i]![1]} (${file})`);
    }
  }
  assert.deepEqual(offenders, [],
    'these reject the call before the run can supply the id it already owns');
});

if (failures > 0) {
  console.error(`\n❌ check:coding-task-scope — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:coding-task-scope — the run decides the scope, and the scope is the job');
process.exit(0);
