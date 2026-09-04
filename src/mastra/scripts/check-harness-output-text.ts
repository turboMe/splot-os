#!/usr/bin/env tsx
/**
 * A run's DELIVERABLE is not simply its last text.
 *
 * Live failure this pins: `chefAgent` finished a V2 job whose committed result
 * was the framework's own scoring report —
 *
 *     #### Completion Check Results … Score: 1 ✅ … ✅ The task is complete.
 *
 * — because Mastra injects that after the final `isTaskComplete` iteration and
 * every consumer reads "the output" from `response.text`. The job was SUCCEEDED
 * and the user got a status line where a menu should have been.
 *
 * The tests pull in two directions on purpose, because the matcher sits between
 * two failures of unequal cost: missing a framework artifact merely restores the
 * old behaviour, while discarding a genuine deliverable destroys work silently.
 * So the "must NOT be treated as an artifact" cases matter more than the others.
 *
 * Run: npx tsx src/mastra/scripts/check-harness-output-text.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

import {
  extractDeliverableText,
  isFrameworkArtifactText,
} from '../services/harness-output-text.js';
import {
  recordRunStepText,
  bestRunStepText,
  forgetRunStepTexts,
} from '../services/run-deliverables.js';

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

/** Verbatim from the canary log. */
const SCORER_REPORT = '#### Completion Check Results\n\nOverall: ✅ COMPLETE\nDuration: 7ms\n\n'
  + '**Goal Completion Scorer** (goal-completion)\nScore: 1 ✅\nReason: complete — substantive '
  + 'final output (709 chars) closed generic harness GoalContract; no negative evidence present\n\n'
  + '✅ The task is complete.';

const MENU = '## Menu degustacyjne\n\n1. Tatar z buraka…';

console.log('check:harness-output-text');

check('LIVE REGRESSION: the scorer report is recognized as framework output', () => {
  assert.equal(isFrameworkArtifactText(SCORER_REPORT), true);
});

check('LIVE REGRESSION: the deliverable is taken from the step before it', () => {
  const response = {
    text: SCORER_REPORT,
    steps: [{ text: MENU }, { text: SCORER_REPORT }],
  };
  assert.equal(extractDeliverableText(response), MENU, 'the menu, not the status line');
});

check('a run with no artifact is unchanged', () => {
  assert.equal(extractDeliverableText({ text: MENU, steps: [{ text: MENU }] }), MENU);
  assert.equal(extractDeliverableText('plain string'), 'plain string');
});

check('a deliverable that MENTIONS completion checks is kept', () => {
  // The expensive direction: over-matching would silently destroy real work.
  const essay = 'Raport z audytu\n\nSekcja 3 opisuje Completion Check Results i sposób oceniania.';
  assert.equal(isFrameworkArtifactText(essay), false);
  assert.equal(extractDeliverableText({ text: essay }), essay);
});

check('similar-but-different headings are not swept up', () => {
  for (const text of [
    '## Completion of the project plan',
    'Results of the completion survey',
    '#### Checklist Results',
    MENU,
  ]) {
    assert.equal(isFrameworkArtifactText(text), false, `must be kept: ${text.slice(0, 40)}`);
  }
});

check('markdown framing around the report does not hide it', () => {
  assert.equal(isFrameworkArtifactText(`> ${SCORER_REPORT}`), true);
  assert.equal(isFrameworkArtifactText(`**${SCORER_REPORT}`), true);
  assert.equal(isFrameworkArtifactText(`\n\n${SCORER_REPORT}`), true);
});

check('when EVERY candidate is framework output the result is empty, not the report', () => {
  // An empty result fails the attempt visibly; the report would look like success.
  const response = { text: SCORER_REPORT, steps: [{ text: SCORER_REPORT }] };
  assert.equal(extractDeliverableText(response), '');
  assert.equal(extractDeliverableText({ text: SCORER_REPORT }), '');
});

check('LIVE REGRESSION: a report APPENDED to real output is cut off the end', () => {
  // The report does not always replace the answer. On chef's first completing
  // run it was glued onto the end of the agent's narration, so a start-anchored
  // check saw a legitimate deliverable and kept the framework text with it.
  const narration = 'Rozpoczynam projekt menu.\nMenu v3 gotowe.';
  const combined = `${narration}\n${SCORER_REPORT}`;
  assert.equal(extractDeliverableText({ text: combined }), narration);
  assert.equal(isFrameworkArtifactText(combined), false, 'it is not wholly an artifact');
});

check('LIVE REGRESSION: the report glued on with NO newline is still cut', () => {
  // designAgent's canary, verbatim shape: the framework block was appended
  // directly onto the end of the agent's sentence, so a newline-anchored strip
  // let the whole report through as if it were the deliverable.
  const glued = `Now let me verify the design renders correctly:${SCORER_REPORT}`;
  assert.equal(extractDeliverableText({ text: glued }), 'Now let me verify the design renders correctly:');
});

check('nothing before the marker is ever lost', () => {
  assert.equal(extractDeliverableText({ text: MENU }), MENU);
  const mentions = 'Menu.\nSekcja o Completion Check Results w środku zdania.';
  assert.equal(extractDeliverableText({ text: mentions }), mentions, 'an inline mention is not a tail');
});

check('legacy fallbacks still work', () => {
  assert.match(
    extractDeliverableText({ toolResults: [{ toolName: 'search', result: { hits: 2 } }] }),
    /\[search\]/,
  );
  assert.equal(extractDeliverableText({ output: 'from output field' }), 'from output field');
  assert.equal(extractDeliverableText(undefined), '');
});

check('LIVE REGRESSION: artifacts stored by the run are found', () => {
  // designAgent stored a prototype and then narrated, so the text was the wrong
  // place to look. The id is a fact of THIS run: artifact_put returned it here.
  const { findArtifactIds } = require('../services/harness-output-text.js');
  const id = 'art-11111111-2222-3333-4444-555555555555';
  const response = { toolResults: [{ toolName: 'artifact_put', result: { success: true, ref: { id, type: 'document' } } }] };
  assert.deepEqual(findArtifactIds(response), [id]);
  assert.deepEqual(findArtifactIds({ text: 'no artifacts here' }), []);
  assert.deepEqual(findArtifactIds(undefined), []);
});

check('LIVE REGRESSION: an artifact the run only READ is not its deliverable', () => {
  // The first version scanned the whole response for art-… ids, so a design job
  // that looked something up committed an unrelated research document about a
  // bakery. Handing the user someone else's work is worse than narration.
  const { findArtifactIds } = require('../services/harness-output-text.js');
  const readId = 'art-99999999-8888-7777-6666-555555555555';
  const wroteId = 'art-11111111-2222-3333-4444-555555555555';
  assert.deepEqual(
    findArtifactIds({ toolResults: [{ toolName: 'artifact_get', result: { id: readId, content: 'someone else' } }] }),
    [],
    'a read must never be mistaken for a product',
  );
  assert.deepEqual(
    findArtifactIds({ toolResults: [
      { toolName: 'artifact_list', result: { items: [{ id: readId }] } },
      { toolName: 'artifact_put', result: { ref: { id: wroteId } } },
    ] }),
    [wroteId],
    'only what this run wrote counts',
  );
});

check('LIVE REGRESSION: a domain agent\'s own writer counts as a document write', () => {
  // designAgent has no `artifact_put` — it persists through
  // `design_write_deliverable`, which writes the file AND registers the artifact.
  // While the selector recognised only `artifact_put`, the design canary had no
  // reachable path to a deliverable at all: the run produced 2316 chars, stored
  // none of them, and the job committed "Now let me verify the design renders
  // correctly:".
  const { findArtifactIds } = require('../services/harness-output-text.js');
  const id = 'art-33333333-4444-5555-6666-777777777777';
  assert.deepEqual(
    findArtifactIds({ toolResults: [
      { toolName: 'design_write_deliverable', result: { success: true, path: '/x/index.html', ref: { id, type: 'document' } } },
    ] }),
    [id],
    'the design writer must be recognised as producing the run\'s document',
  );
});

check('LIVE CAPTURE: the runtime reports the tool KEY, not the tool id', () => {
  // Verbatim from `agent.generate()` — not hand-written. Every synthetic test in
  // this file used `toolName: 'artifact_put'`, which the runtime never emits, so
  // the whole artifact path passed its tests while returning [] in production for
  // every run that ever executed. The design canary proved it: 34 KB prototype
  // in the Artifact Store, and the job committed the agent's next sentence.
  const { findArtifactIds } = require('../services/harness-output-text.js');
  const captured = [{
    type: 'tool-result',
    runId: 'cd94df6d-24fe-45ab-ba2e-6450d218b81a',
    from: 'AGENT',
    payload: {
      args: { slug: 'probe-shape', fileName: 'probe.html', isPrimary: true },
      toolCallId: 'call_00_REPaIYF4TynjVUg2vCzQ7521',
      toolName: 'designWriteDeliverableTool',
      result: {
        success: true,
        path: '/repo/design-work/probe-shape/probe.html',
        ref: { id: 'art-572ecd38-dc43-4f26-9b63-ad5923a7946a', type: 'document', summary: 'probe' },
      },
    },
  }];
  assert.deepEqual(
    findArtifactIds({ toolResults: captured }),
    ['art-572ecd38-dc43-4f26-9b63-ad5923a7946a'],
    'a real captured tool result must yield its artifact id',
  );
});

check('every writer is matchable under BOTH its id and its registry key', () => {
  // The runtime reports keys; prompts and docs use ids. A writer listed under
  // only one spelling is a writer that silently never matches.
  const source = readFileSync('src/mastra/services/harness-output-text.ts', 'utf8');
  const listed = source.match(/ARTIFACT_WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const ids = names.filter((n) => n.includes('_'));
  const keys = names.filter((n) => !n.includes('_'));
  assert.ok(ids.length > 0 && keys.length > 0, 'both spellings must be present');
  assert.equal(ids.length, keys.length, `every id needs its registry key: ids=${ids} keys=${keys}`);
  for (const id of ids) {
    // artifact_put → artifactPutTool
    const expected = id.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()) + 'Tool';
    assert.ok(keys.includes(expected), `${id} is listed but its runtime key ${expected} is not`);
  }
});

check('the write/read rule holds for every writer, not just artifact_put', () => {
  // The rule that earned a tool its place in the set is "it WRITES". A future
  // reader added by name would resurrect the bakery bug for a new agent.
  const source = readFileSync('src/mastra/services/harness-output-text.ts', 'utf8');
  const listed = source.match(/ARTIFACT_WRITE_TOOLS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
  assert.ok(listed.length > 0, 'the write-tool set must be declared as a literal list');
  for (const reader of ['artifact_get', 'artifact_list', 'coding_read_worktree_file']) {
    assert.ok(!listed.includes(reader), `${reader} reads — it must never be a deliverable source`);
  }
});

check('the newest artifact is the one a run finished with', () => {
  const { findArtifactIds } = require('../services/harness-output-text.js');
  const first = 'art-aaaaaaaa-1111-1111-1111-111111111111';
  const last = 'art-bbbbbbbb-2222-2222-2222-222222222222';
  const ids = findArtifactIds({ toolResults: [
    { toolName: 'artifact_put', result: { ref: { id: first } } },
    { toolName: 'artifact_put', result: { ref: { id: last } } },
  ] });
  assert.deepEqual(ids, [first, last], 'order must be preserved so the caller can take the last');
});

check('LIVE REGRESSION: a write is recorded when it happens, not read off the response', () => {
  // The harness makes several `generate` calls and returns the LAST one. On the
  // liveness canary that last response was `steps=1, toolCalls=0, toolResults=0`
  // — a follow-up reflection — while the 10 KB prototype had been written in an
  // earlier call whose response was already discarded. Scanning any single
  // response cannot see that; the writer recording itself can.
  const { noteRunArtifact, getRunArtifacts, clearRunArtifacts } = require('../services/run-artifacts.js');
  const runId = 'attempt_test_run';
  clearRunArtifacts(runId);
  noteRunArtifact('art-aaaaaaaa-0000-0000-0000-000000000001', runId);
  noteRunArtifact('art-bbbbbbbb-0000-0000-0000-000000000002', runId);
  noteRunArtifact('art-aaaaaaaa-0000-0000-0000-000000000001', runId); // duplicate write
  assert.deepEqual(
    getRunArtifacts(runId),
    ['art-aaaaaaaa-0000-0000-0000-000000000001', 'art-bbbbbbbb-0000-0000-0000-000000000002'],
    'insertion order is kept and duplicates collapse — the caller takes the LAST as the deliverable',
  );
  clearRunArtifacts(runId);
  assert.deepEqual(getRunArtifacts(runId), [], 'a finished run leaves nothing behind');
  assert.deepEqual(getRunArtifacts('never-seen'), [], 'an unknown run is empty, not an error');
});

check('a write outside any run is attributed to nobody', () => {
  // A direct call from a script or test has no run to attribute to. Inventing
  // one would let a stray write become some job's deliverable.
  const { noteRunArtifact, getRunArtifacts } = require('../services/run-artifacts.js');
  noteRunArtifact('art-cccccccc-0000-0000-0000-000000000003');
  assert.deepEqual(getRunArtifacts(''), [], 'no run id, no attribution');
});

check('the store records the write itself, and the V2 caller reads that first', () => {
  const store = readFileSync('src/mastra/services/artifact-store.ts', 'utf8');
  assert.match(store, /noteRunArtifact\(record\.id\)/, 'putArtifact must record the write');
  const insertIdx = store.indexOf('insertOne(record)');
  const noteIdx = store.indexOf('noteRunArtifact(record.id)');
  assert.ok(insertIdx > 0 && noteIdx > insertIdx, 'only a document that really exists may be claimed');

  const caller = readFileSync('src/mastra/orchestration/execution/harness-agent-caller.ts', 'utf8');
  const recordedIdx = caller.indexOf('getRunArtifacts(');
  const scanIdx = caller.indexOf('findArtifactIds(result.response)');
  assert.ok(recordedIdx > 0 && recordedIdx < scanIdx, 'the recorded fact must be preferred over the response scan');
});

check('the V2 caller prefers a stored artifact over the run\'s prose', () => {
  const caller = readFileSync('src/mastra/orchestration/execution/harness-agent-caller.ts', 'utf8');
  assert.match(caller, /findArtifactIds/, 'it must look for artifacts');
  assert.match(caller, /getArtifact/, 'and fetch the content');
  // Match the PROPERTY, not the formatting. This assertion used to look for the
  // literal `return { text: fullResponseText`, and broke the moment the return
  // was wrapped and split across lines — while the ordering it was meant to
  // protect was completely intact. A test that fails on a reformat, and would
  // pass on a reordering that kept the string, is guarding the wrong thing.
  const artifactIndex = Math.min(
    ...['findArtifactIds', 'getRunArtifacts']
      .map((needle) => caller.indexOf(needle, caller.indexOf('createHarnessAgentCaller')))
      .filter((i) => i >= 0),
  );
  const textIndex = caller.indexOf('fullResponseText(result.response');
  assert.ok(textIndex > 0, 'the text fallback must still exist');
  assert.ok(
    artifactIndex < textIndex,
    `the artifact lookup (${artifactIndex}) must run BEFORE the text fallback (${textIndex})`,
  );
});

check('LIVE REGRESSION: the deliverable survives a follow-up pass that produces none', () => {
  // Captured by the empty-deliverable diagnostic on a chef run:
  //   response.text=269ch/framework steps=1 stepTexts=[269ch/framework] toolResults=0
  // ...after 45 activity events. `response` is reassigned by up to three
  // follow-up passes, each a fresh generate, and the last one carried only the
  // framework's completion report — while the menu sat in an overwritten
  // response. The harness must therefore keep the best deliverable it saw.
  const harness = readFileSync('src/mastra/services/generate-with-harness.ts', 'utf8');
  const remembers = harness.match(/rememberDeliverable\(response\)/g) ?? [];
  assert.ok(
    remembers.length >= 4,
    `every pass that can replace the response must be followed by a remember, found ${remembers.length}`,
  );
  // Three sources, in this order. The third exists because the first two can
  // BOTH come up empty while the run did real work: the harness keeps only the
  // last `generate`, so a run with fourteen steps can return `steps=1` whose one
  // text is the completion report. Measured on the security-review canary —
  // 43 tool calls, a 5790-character review the goal scorer passed, and a job
  // that failed with `run produced no deliverable`.
  // Anchored on the ASSIGNMENT, not on the type declaration of the same name.
  const assignedAt = harness.indexOf('deliverableText: extractDeliverableText');
  assert.ok(assignedAt > 0, 'the deliverable must be assigned from the extractor');
  const chain = harness.slice(assignedAt, assignedAt + 280);
  assert.match(chain, /extractDeliverableText\(response\)/,
    'the final response wins when it has a deliverable');
  assert.match(chain, /bestDeliverable/,
    'the best of the earlier passes comes next');
  assert.match(chain, /bestRunStepText\(runId\)/,
    'and what the STEPS said is the last resort — the only source that survives '
    + 'the harness keeping just the final generate');
  assert.ok(
    chain.indexOf('extractDeliverableText') < chain.indexOf('bestDeliverable')
    && chain.indexOf('bestDeliverable') < chain.indexOf('bestRunStepText'),
    'the order matters: a fresher, more complete answer must win over a remembered one',
  );

  const caller = readFileSync('src/mastra/orchestration/execution/harness-agent-caller.ts', 'utf8');
  assert.match(
    caller,
    /result\.deliverableText \|\| result\.outputPreview/,
    'the V2 caller must prefer the full deliverable over the 1000-char preview',
  );
});

check('BOTH readers of the run output go through this — not response.text', () => {
  // The V2 caller freezes its value into the durable result, so a direct field
  // read there would reintroduce the bug for exactly the path that hit it.
  const harness = readFileSync('src/mastra/services/generate-with-harness.ts', 'utf8');
  assert.match(harness, /extractDeliverableText/, 'the harness must use the selector');
  const caller = readFileSync('src/mastra/orchestration/execution/harness-agent-caller.ts', 'utf8');
  assert.match(caller, /extractDeliverableText/, 'and so must the V2 caller');
  assert.ok(
    !/const text = \(response as Record<string, unknown>\)\.text/.test(caller),
    'the V2 caller must not read response.text directly any more',
  );
});


check('BEHAVIOUR: a step text survives when the final response keeps only the report', () => {
  // The mechanism, exercised rather than asserted on shape. This is what the
  // security-review canary needed: 43 tool calls, a real review in the steps,
  // and a final `generate` whose single step was `#### Completion Check Results`.
  // Statically imported: this gate's `check` helper is SYNCHRONOUS, so an async
  // callback's rejection never reaches its try/catch and the check prints ✓
  // whatever happens. Written that way once here, and it took a direct
  // experiment to notice — a check that cannot fail is the thing this whole
  // suite exists to prevent.
  const runId = `chk-deliv-${Date.now()}`;
  try {
    recordRunStepText(runId, 'Verdict: APPROVE. The permit is spent in one CAS, so it cannot be reused.');
    // LONGER than the deliverable on purpose: otherwise the length rule below
    // would be what protects it, and the framework filter would be untested.
    recordRunStepText(runId,
      `#### Completion Check Results\n\nOverall: ✅ COMPLETE\n${'Scorer detail. '.repeat(30)}`);
    assert.match(bestRunStepText(runId), /Verdict: APPROVE/,
      'framework text must never displace real work, however long the report is');

    // Longest wins, not latest: an agent that delivers and then says "let me
    // verify that" must not commit the sentence instead of the work.
    recordRunStepText(runId, 'Now let me verify.');
    assert.match(bestRunStepText(runId), /Verdict: APPROVE/,
      'a short follow-up remark must not replace the deliverable');

    const longer = `Verdict: APPROVE. ${'Detailed finding. '.repeat(20)}`;
    recordRunStepText(runId, longer);
    assert.equal(bestRunStepText(runId), longer.trim(), 'a fuller answer does replace it');
  } finally {
    forgetRunStepTexts(runId);
  }
  assert.equal(bestRunStepText(runId), '', 'a finished run releases its candidate');
});

if (failures > 0) {
  console.error(`\n❌ check:harness-output-text — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:harness-output-text — a run returns what it produced, not what the framework said about it');
process.exit(0);
