#!/usr/bin/env tsx
/**
 * GAP-CUTOVER-01 — the live-data evidence report.
 *
 * F6's definition of done is not "the code compiles". It is:
 *
 *   - every legacy row classified `drained-in-v1 | imported-to-v2 | terminal-legacy`;
 *   - no autonomous trigger fired zero times or twice.
 *
 * Both are questions about DATA THAT ALREADY EXISTS on a running system, not
 * about the new code paths, so they cannot be answered by a check script with
 * fixtures. This reads the real collections and answers them.
 *
 * READ-ONLY. It repairs nothing and starts nothing: a scheduled task row FIRES,
 * and restarting one may run an agent or an n8n workflow. Deciding that is the
 * operator's call — this report tells them what there is to decide about.
 *
 * Run: npm run audit:cutover
 */
import {
  findStoppedRecurrences,
  SCHEDULED_TASKS_COLLECTION,
  SCHEDULED_TASK_DISPATCHES_COLLECTION,
} from '../services/scheduled-task-store.js';
import { getDb } from '../lib/mongo.js';

const db = await getDb();

/**
 * Where a legacy row stands relative to the cutover.
 *
 *  - `terminal-legacy`  — it finished on the old lane; nothing to migrate.
 *  - `drained-in-v1`    — still running on the old lane. Not a fault; it must
 *                         simply be allowed to finish before that lane is
 *                         switched off. This is the number that must reach zero
 *                         before legacy can be removed.
 *  - `imported-to-v2`   — a durable job owns it now.
 */
type Classification = 'terminal-legacy' | 'drained-in-v1' | 'imported-to-v2';

interface Row { classification: Classification; count: number }

async function classify(
  collection: string,
  liveStatuses: string[],
  durableField: string,
): Promise<Row[]> {
  const col = db.collection(collection);
  const [importedToV2, drained, terminal] = await Promise.all([
    col.countDocuments({ [durableField]: { $exists: true } }),
    col.countDocuments({ status: { $in: liveStatuses }, [durableField]: { $exists: false } }),
    col.countDocuments({ status: { $nin: liveStatuses }, [durableField]: { $exists: false } }),
  ]);
  return [
    { classification: 'imported-to-v2', count: importedToV2 },
    { classification: 'drained-in-v1', count: drained },
    { classification: 'terminal-legacy', count: terminal },
  ];
}

function render(title: string, rows: Row[]): void {
  const total = rows.reduce((n, r) => n + r.count, 0);
  console.log(`\n${title}  (${total} row${total === 1 ? '' : 's'})`);
  for (const r of rows) {
    const flag = r.classification === 'drained-in-v1' && r.count > 0 ? '  ← must reach 0 before legacy is removed' : '';
    console.log(`  ${r.classification.padEnd(18)} ${String(r.count).padStart(5)}${flag}`);
  }
}

console.log('audit:cutover — GAP-CUTOVER-01 evidence (read-only)');

render('async_delegations', await classify('async_delegations', ['running'], 'v2JobId'));
render('automation_jobs', await classify('automation_jobs', ['queued', 'running'], 'v2JobId'));

// ── Autonomous triggers: neither zero nor twice ────────────────────────────
console.log('\nautonomous triggers — scheduled_tasks');

const tasks = db.collection(SCHEDULED_TASKS_COLLECTION);

// FIRED TWICE: two successors for one occurrence. Impossible under the unique
// index added with this work, so a non-zero count here is historical damage
// that predates it — worth seeing, since a doubled schedule keeps doubling.
const duplicateSuccessors = await tasks.aggregate([
  { $match: { succeedsTaskId: { $exists: true } } },
  { $group: { _id: { s: '$succeedsTaskId', k: '$succession' }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]).toArray();
console.log(`  duplicate successors        ${String(duplicateSuccessors.length).padStart(5)}`
  + (duplicateSuccessors.length ? '  ← a schedule is firing more than once' : ''));

// FIRED ZERO TIMES: a recurring chain with nothing pending and nothing running.
const stopped = await findStoppedRecurrences();
console.log(`  stopped recurrences         ${String(stopped.length).padStart(5)}`
  + (stopped.length ? '  ← a schedule silently stopped firing' : ''));
for (const s of stopped.slice(0, 10)) {
  console.log(`      chain ${s.chainId}  ${s.targetType}:${s.targetIdentifier}`
    + `  cron="${s.cronExpression}"  last ran ${s.completedAt?.toISOString() ?? 'unknown'}`);
  console.log(`        repair with: repairStoppedRecurrence('${s.taskId}')`);
}
if (stopped.length > 10) console.log(`      … and ${stopped.length - 10} more`);

// Occurrences currently in flight — the drain number for the trigger lane.
const [live, unlinked] = await Promise.all([
  tasks.countDocuments({ status: { $in: ['scheduled', 'leased', 'running'] } }),
  tasks.countDocuments({
    status: 'completed',
    'schedule.cronExpression': { $exists: true, $nin: [null, ''] },
    succeedsTaskId: { $exists: false },
  }),
]);
console.log(`  live occurrences            ${String(live).padStart(5)}`);
console.log(`  pre-succession occurrences  ${String(unlinked).padStart(5)}`
  + '  (completed before this work; unlinked by design, not a fault)');

// Dispatch dedupe coverage: WORKER_COMMAND targets deliberately have no
// idempotency key, so a retry there re-executes. Naming the number is the point.
const dispatches = db.collection(SCHEDULED_TASK_DISPATCHES_COLLECTION);
const [dispatchRows, workerCommandTasks] = await Promise.all([
  dispatches.countDocuments({}),
  tasks.countDocuments({ targetType: 'WORKER_COMMAND' }),
]);
console.log(`\n  dispatch records            ${String(dispatchRows).padStart(5)}`);
console.log(`  WORKER_COMMAND tasks        ${String(workerCommandTasks).padStart(5)}`
  + '  (no idempotency key by design — a retry re-executes)');

const blockers = duplicateSuccessors.length + stopped.length;
console.log(
  blockers === 0
    ? '\n✅ no autonomous trigger is firing zero or twice'
    : `\n⚠ ${blockers} trigger issue(s) to decide on — nothing was changed`,
);
process.exit(0);
