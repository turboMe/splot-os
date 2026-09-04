#!/usr/bin/env tsx
/**
 * check:coding-state-round-trips — the three memories a coding task keeps
 * between steps actually persist: the checkpoint, the soft-interrupt queue, and
 * the file-activity ledger.
 *
 * WHY ROUND TRIPS AND NOT UNIT TESTS
 * -----------------------------------
 * Each of these is a write in one place and a read in another, with nothing in
 * between that can fail loudly. A broken one is silent by construction: the
 * writer returns normally, the reader finds nothing, and the agent simply
 * behaves as though it has no memory.
 *
 * That is not hypothetical. `appendToCheckpoint` ran `updateOne({ taskId }, …)`
 * with NO upsert, and `saveCheckpoint` — the only writer that upserts — has zero
 * callers outside its module. So the document was never created, every append
 * matched nothing, and `context-assembler` read an empty checkpoint on every
 * task since it shipped. Measured: 0 documents in `context_checkpoints` after a
 * successful-looking append.
 *
 * Each check writes with the REAL function, reads with the REAL reader, and
 * cleans up after itself.
 *
 * Run: npx tsx src/mastra/scripts/check-coding-state-round-trips.ts
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getDb } from '../lib/mongo.js';

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

console.log('check:coding-state-round-trips');

const db = await getDb();
const MARK = `chk-state-${randomUUID().slice(0, 8)}`;

// ── D2: the checkpoint ───────────────────────────────────────────────────────
await check('D2: a checkpoint survives its FIRST append, with no prior document', async () => {
  const { appendToCheckpoint, loadCheckpoint, formatCheckpointForPrompt, deleteCheckpoint } =
    await import('../services/context-checkpoint.js');
  const taskId = `${MARK}-cp`;
  try {
    await appendToCheckpoint(taskId, {
      decision: 'chose variant B',
      fileModified: 'src/probe.ts',
      nextStep: 'write the test',
    });

    const stored = await db.collection('context_checkpoints').countDocuments({ taskId });
    assert.equal(stored, 1,
      'the first append must CREATE the checkpoint — without upsert it matched nothing and '
      + 'every task ran with no memory at all');

    const loaded = await loadCheckpoint(taskId);
    assert.ok(loaded, 'and the reader must find it');
    assert.deepEqual((loaded as { decisionsLog?: string[] }).decisionsLog, ['chose variant B']);
    assert.deepEqual((loaded as { filesModified?: string[] }).filesModified, ['src/probe.ts']);

    // A second append must accumulate, not replace.
    await appendToCheckpoint(taskId, { decision: 'reverted to A' });
    const again = await loadCheckpoint(taskId);
    assert.deepEqual((again as { decisionsLog?: string[] }).decisionsLog,
      ['chose variant B', 'reverted to A'], 'appends accumulate — that is the point of a log');

    // And it has to render into something a run can actually resume from.
    const prompt = formatCheckpointForPrompt(again as never);
    assert.match(prompt, /chose variant B/, 'the prompt block must carry the decisions');
  } finally {
    await deleteCheckpoint(taskId).catch(() => undefined);
    await db.collection('context_checkpoints').deleteMany({ taskId });
  }
});

// ── C4: the soft-interrupt queue ─────────────────────────────────────────────
await check('C4: a queued message is claimable by the agent it was addressed to', async () => {
  const { queuePendingMessage, takePendingMessages, hasUrgentInterrupt } =
    await import('../services/pending-message-queue.js');
  const taskId = `${MARK}-msg`;
  try {
    const id = await queuePendingMessage({
      taskId, targetAgentId: 'codingAgent', source: 'file_activity',
      content: 'the background task finished', urgent: false,
    } as never);
    assert.ok(id, 'queueing must return the message id');

    const taken = await takePendingMessages({ taskId, agentId: 'codingAgent' } as never);
    assert.equal(taken.length, 1, 'the addressee must be able to claim it');
    assert.match(String(taken[0]!.content), /background task finished/);

    // Claimed once: a second consumer must not get the same message.
    const again = await takePendingMessages({ taskId, agentId: 'codingAgent' } as never);
    assert.equal(again.length, 0, 'a claimed message must not be handed out twice');

    assert.equal(await hasUrgentInterrupt({ taskId, agentId: 'codingAgent' } as never), false,
      'a non-urgent message must not read as an interrupt');
  } finally {
    await db.collection('pending_user_messages').deleteMany({ taskId });
  }
});

await check('C4: an URGENT message is visible as an interrupt', async () => {
  const { queuePendingMessage, hasUrgentInterrupt } = await import('../services/pending-message-queue.js');
  const taskId = `${MARK}-urgent`;
  try {
    await queuePendingMessage({
      taskId, targetAgentId: 'codingAgent', source: 'user',
      content: 'stop and read this', urgent: true,
    } as never);
    assert.equal(await hasUrgentInterrupt({ taskId, agentId: 'codingAgent' } as never), true,
      'an urgent message must be detectable WITHOUT claiming it — that is what lets a run '
      + 'check cheaply between steps');
  } finally {
    await db.collection('pending_user_messages').deleteMany({ taskId });
  }
});

// ── D3: the file-activity ledger ─────────────────────────────────────────────
await check('D3: two agents on one file in one task produce a warning', async () => {
  const previous = process.env.FEATURE_FILE_ACTIVITY_LEDGER;
  process.env.FEATURE_FILE_ACTIVITY_LEDGER = 'true';
  const { recordFileActivity, getFileActivityWarning } = await import('../services/file-activity.js');
  const taskId = `${MARK}-file`;
  const file = 'src/mastra/probe-d3.ts';
  try {
    await recordFileActivity({ taskId, agentId: 'codingAgent', file, op: 'patch', summary: 'author writes' });

    const warning = await getFileActivityWarning({
      taskId, agentId: 'codeReviewAgent', file, op: 'patch', summary: 'reviewer writes too',
    });
    assert.ok(warning, 'a second agent touching the same file must be warned');

    // And it must stay quiet for the agent that made the edit itself, or the
    // warning becomes noise every agent learns to ignore.
    const self = await getFileActivityWarning({
      taskId, agentId: 'codingAgent', file, op: 'patch', summary: 'same agent again',
    });
    assert.equal(self, '', 'an agent must not be warned about its own edit');
  } finally {
    if (previous === undefined) delete process.env.FEATURE_FILE_ACTIVITY_LEDGER;
    else process.env.FEATURE_FILE_ACTIVITY_LEDGER = previous;
    await db.collection('file_activity').deleteMany({ taskId });
    await db.collection('pending_user_messages').deleteMany({ taskId });
  }
});

await check('nothing this gate wrote is left behind', async () => {
  for (const [collection, field] of [
    ['context_checkpoints', 'taskId'],
    ['pending_user_messages', 'taskId'],
    ['file_activity', 'taskId'],
  ] as const) {
    const left = await db.collection(collection).countDocuments({ [field]: { $regex: `^${MARK}` } });
    assert.equal(left, 0, `${collection} still holds rows from this gate`);
  }
});

if (failures > 0) {
  console.error(`\n❌ check:coding-state-round-trips — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:coding-state-round-trips — checkpoint, interrupts and file ledger all persist');
process.exit(0);
