#!/usr/bin/env tsx
/**
 * check:automation-finalize-lever — when the force-report lever may close a run.
 *
 * `finalize-on-deliverable` exists because the architect did not know when to
 * stop: it would keep churning after a workflow was already delivered. The lever
 * fixes that by forcing a final report once a terminal deliverable is latched.
 *
 * The gap this check closes: `tested` is latched by a MOCK pass exactly as it is
 * by a real-credentials pass — the Golden Path's own success message reads
 * "deployed as inactive draft and passed mock test", and its `lastTest.mode` is
 * typed `'mock'` because that path never runs anything else. So a brief whose
 * definition of done demanded "an end-to-end test against real credentials and
 * real data" was finalized on structural validation alone, and the run closed
 * naming the real test as a "next step" it never took (observed 2026-08-24,
 * automationArchitect, workflow 9w40oeYIdZ343PM2).
 *
 * The fix must NOT re-open the over-iteration hole: with no brief asking for
 * more, a mock-tested deliverable still finalizes. Both directions are asserted.
 *
 * Run: npx tsx src/mastra/scripts/check-automation-finalize-lever.ts
 */
import assert from 'node:assert/strict';

import {
  briefRequiresRealTest,
  shouldForceAutomationReport,
} from '../services/mcp-handoff-state.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

console.log('check:automation-finalize-lever');

// Verbatim definition-of-done from the brief that was finalized on a mock.
const REAL_TEST_BRIEF =
  'Build, deploy and end-to-end test an n8n workflow named "Mastra Agent Health Digest". '
  + 'Do NOT activate it. You ran an end-to-end test against real credentials and real data, '
  + 'and the digest content is correct — the numbers must match what is actually in agent_runs.';

const PLAIN_BRIEF = 'Build and deploy an inactive n8n workflow that posts a daily digest to Telegram.';

// ── The regression ───────────────────────────────────────────────────────────

check('a mock pass does NOT finalize a brief that asked for a real end-to-end test', () => {
  assert.equal(shouldForceAutomationReport('tested', REAL_TEST_BRIEF, 'mock'), false);
});

check('a real-credentials pass DOES finalize that same brief', () => {
  assert.equal(shouldForceAutomationReport('tested', REAL_TEST_BRIEF, 'real_credentials'), true);
});

// ── The over-iteration guard must survive ────────────────────────────────────

check('a mock pass still finalizes when the brief did not ask for a real run', () => {
  assert.equal(shouldForceAutomationReport('tested', PLAIN_BRIEF, 'mock'), true);
});

check('an unknown test mode keeps the previous behaviour', () => {
  // Callers that cannot say how the test ran must not silently stop finalizing —
  // that would reintroduce the churn this lever was built to stop.
  assert.equal(shouldForceAutomationReport('tested', REAL_TEST_BRIEF, undefined), true);
});

check('active always finalizes, draft_created never does', () => {
  assert.equal(shouldForceAutomationReport('active', REAL_TEST_BRIEF, 'mock'), true);
  assert.equal(shouldForceAutomationReport('draft_created', PLAIN_BRIEF, 'real_credentials'), false);
  assert.equal(shouldForceAutomationReport(null, PLAIN_BRIEF, 'real_credentials'), false);
});

check('a brief wanting activation still blocks the lever (pre-existing rule intact)', () => {
  assert.equal(
    shouldForceAutomationReport('tested', 'Build the workflow and activate it.', 'real_credentials'),
    false,
  );
});

// ── The predicate itself ─────────────────────────────────────────────────────

check('briefRequiresRealTest recognises the ways a real run is asked for', () => {
  for (const prompt of [
    'run an end-to-end test with real credentials',
    'test it e2e before reporting',
    'wykonaj test na prawdziwych danych',
    'uruchom to na żywo i pokaż wynik',
    'verify with a live run against the database',
  ]) {
    assert.equal(briefRequiresRealTest(prompt), true, `should require a real test: ${prompt}`);
  }
});

check('briefRequiresRealTest does not fire on a plain build brief', () => {
  for (const prompt of [
    PLAIN_BRIEF,
    'Deploy it as an inactive draft and report the workflowId.',
    'Validate the node schemas and stop.',
  ]) {
    assert.equal(briefRequiresRealTest(prompt), false, `should NOT require a real test: ${prompt}`);
  }
});

check('an explicit mock-only brief overrides the real-test wording', () => {
  assert.equal(
    briefRequiresRealTest('Run an end-to-end structural check, mock only — do not execute.'),
    false,
  );
});

if (failures > 0) {
  console.error(`\n❌ check:automation-finalize-lever — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\n✅ check:automation-finalize-lever — a mock cannot close a brief that asked for a real run, and the over-iteration guard still holds');
process.exit(0);
