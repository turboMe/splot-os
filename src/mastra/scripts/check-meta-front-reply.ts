#!/usr/bin/env tsx
/**
 * The Meta Front's reply must not claim things that did not happen.
 *
 * Both failures pinned here were seen live, on the capability-routing canary,
 * with the shipped model:
 *
 *  1. the front reported "started it, ID `job_coffee_article`" having never
 *     called the tool. Nothing existed. The user waits forever for work that was
 *     never queued — and this is the failure that looks EXACTLY like success,
 *     which is why it is detected structurally rather than hoped away in a prompt;
 *  2. the front returned an empty string, twice in a row, for one particular
 *     phrasing. A blank reply with no reason.
 *
 * The audit checks facts, never quality: a job id in the text that this turn's
 * tool calls did not return was invented, and empty text is no answer.
 *
 * Run: npx tsx src/mastra/scripts/check-meta-front-reply.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  auditFrontReply,
  collectRealJobIds,
  correctionPrompt,
  findUnkeepablePromise,
  FRONT_REPLY_FALLBACK,
} from '../services/meta-front-reply.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const REAL = 'job_5687d191-4a6e-4d93-9f85-ba74db6794c3';

console.log('check:meta-front-reply');

check('a reply reporting the job it really started passes', () => {
  const ids = collectRealJobIds([{ toolName: 'orchestration_start_job', result: { jobId: REAL } }]);
  assert.deepEqual(auditFrontReply(`Przyjąłem zlecenie, ID: \`${REAL}\`.`, ids), { ok: true });
});

check('LIVE REGRESSION: an invented job id is caught', () => {
  // The exact shape of the live failure: plausible sentence, no tool call.
  const verdict = auditFrontReply('Zacząłem pracę. ID zadania: `job_coffee_article`', collectRealJobIds([]));
  assert.equal(verdict.ok, false);
  assert.equal((verdict as { reason: string }).reason, 'fabricated_job_id');
});

check('an id that is real but not THIS turn\'s is still not claimable', () => {
  const ids = collectRealJobIds([{ result: { jobId: REAL } }]);
  const verdict = auditFrontReply('Pracuję nad job_00000000-0000-0000-0000-000000000000.', ids);
  assert.equal(verdict.ok, false, 'the guard is per-turn — it can only vouch for what it saw');
});

check('LIVE REGRESSION: an empty reply is caught', () => {
  for (const blank of ['', '   ', '\n\n']) {
    const verdict = auditFrontReply(blank, collectRealJobIds([]));
    assert.equal(verdict.ok, false);
    assert.equal((verdict as { reason: string }).reason, 'empty');
  }
});

check('ordinary conversation with no job id passes untouched', () => {
  // The guard must not make the front unable to just talk.
  assert.deepEqual(auditFrontReply('Cześć! W czym mogę pomóc?', collectRealJobIds([])), { ok: true });
  assert.deepEqual(
    auditFrontReply('Nic dziś nie uruchamiałem.', collectRealJobIds([])),
    { ok: true },
  );
});

check('job ids are found wherever the framework puts them in a tool result', () => {
  // Read by pattern, not by a typed path: over-collecting can only ever admit
  // ids that ARE real, while a shape change would otherwise reject true replies.
  const nested = [{ output: { data: { job: { jobId: REAL } } } }];
  assert.ok(collectRealJobIds(nested).has(REAL));
  assert.equal(collectRealJobIds(undefined).size, 0);
  assert.equal(collectRealJobIds({ circular: 'not json-able but must not throw' }).size, 0);
});

check('the correction tells the model exactly what it got wrong', () => {
  const verdict = auditFrontReply('ID: job_fake', collectRealJobIds([]));
  const prompt = correctionPrompt(verdict, 'Napisz artykuł o kawie.');
  assert.match(prompt, /does not exist/);
  assert.match(prompt, /orchestration_start_job/, 'and what to do instead');
  assert.match(prompt, /Napisz artykuł o kawie\./, 'and repeats the request being answered');
  assert.match(correctionPrompt(auditFrontReply('', new Set()), 'x'), /EMPTY/);
});

check('the last-resort message claims nothing that was not proven', () => {
  assert.ok(!FRONT_REPLY_FALLBACK.includes('job_'), 'it must not carry an id');
  assert.match(FRONT_REPLY_FALLBACK, /nic nie zostało uruchomione/);
  assert.match(FRONT_REPLY_FALLBACK, /nothing was started/, 'the front follows the user\'s language, this text cannot');
});

check('the endpoint audits, corrects once, and falls back — not just logs', () => {
  const source = readFileSync('src/mastra/index.ts', 'utf8');
  const route = source.slice(source.indexOf("'/v2/front/messages'"), source.indexOf("'/dashboard/orchestration/jobs'"));
  assert.match(route, /auditFrontReply/, 'the reply must be audited before it is returned');
  assert.match(route, /correctionPrompt/, 'and corrected once');
  assert.match(route, /FRONT_REPLY_FALLBACK/, 'and never delivered when it fails twice');
});

check('LIVE REGRESSION: a promise to notify is caught', () => {
  // Verbatim from the design canary, with the rule already in the prompt.
  const live = 'Przyjąłem zlecenie. Twój projekt jest w realizacji jako `job_45d67017`.\n\n'
    + 'Gdy praca się zakończy, poinformuję Cię o tym i udostępnię gotowy plik.';
  assert.match(String(findUnkeepablePromise(live)), /poinformuję/, 'the offending sentence is returned, not a boolean');
  assert.ok(findUnkeepablePromise("I'll let you know when it's done."), 'English too');
  assert.equal(
    findUnkeepablePromise('Zlecenie przyjęte, job_abc. Zapytaj mnie o status, kiedy chcesz.'),
    null,
    'the correct phrasing must not be flagged',
  );
});

check('saying it CANNOT notify is not a promise to notify', () => {
  assert.equal(findUnkeepablePromise('Nie poinformuję Cię automatycznie — zapytaj o status.'), null);
  assert.equal(findUnkeepablePromise('I cannot notify you; ask me for the status.'), null);
});

check('a promise NEVER routes to the "nothing was started" fallback', () => {
  // The job did start. Trading a bad sentence for a false statement is worse
  // than the sentence, so this class corrects and then delivers regardless.
  const source = readFileSync('src/mastra/index.ts', 'utf8');
  const route = source.slice(source.indexOf("'/v2/front/messages'"), source.indexOf("'/dashboard/orchestration/jobs'"));
  assert.match(route, /findUnkeepablePromise/, 'the endpoint must check for the promise');
  const promiseIdx = route.indexOf('findUnkeepablePromise');
  const guard = route.slice(promiseIdx);
  assert.ok(
    !/FRONT_REPLY_FALLBACK/.test(guard.slice(0, guard.indexOf('return c.json'))),
    'the promise path must not reach the fallback message',
  );
});

check('the promise rewrite is audited against BOTH turns\' job ids', () => {
  // The rewrite repeats an id minted by the FIRST turn; checking it against only
  // the retry's own tool results would condemn a true statement as fabricated.
  const source = readFileSync('src/mastra/index.ts', 'utf8');
  const route = source.slice(source.indexOf("'/v2/front/messages'"), source.indexOf("'/dashboard/orchestration/jobs'"));
  const guard = route.slice(route.indexOf('findUnkeepablePromise'));
  assert.match(guard, /collectRealJobIds\(reply\.toolResults\)/, 'the first turn\'s ids must count');
  assert.match(guard, /collectRealJobIds\(retry\.toolResults\)/, 'and the retry\'s');
});

if (failures > 0) {
  console.error(`\n❌ check:meta-front-reply — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:meta-front-reply — the front cannot report work it did not start');
process.exit(0);
