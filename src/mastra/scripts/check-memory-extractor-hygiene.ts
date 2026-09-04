#!/usr/bin/env tsx
/**
 * check:memory-extractor-hygiene — what the extractor is allowed to assert into
 * `system_knowledge`.
 *
 * `system_knowledge` is not a log. `memoryRecallTool` presents it to agents as
 * knowledge — `prompt_rule` literally as "prompt optimization insights" — so
 * anything filed here is read back as guidance and acted on. Two patterns were
 * filing things that were never guidance, and there was no check on this file at
 * all. Measured 2026-08-24 on the live database:
 *
 *  - 119 of 124 `prompt_rule` records were "Costly delegation: <agent> (<n>s) …
 *    Consider splitting task or reducing prompt size" — one per delegation over
 *    60s, which in this system is nearly every real delegation. Sixteen of them
 *    named `n8nMcpEngineer`, discouraging the single handoff that grounds n8n
 *    node schemas, while the architect was hallucinating typeVersions for want
 *    of exactly that handoff.
 *  - 4 `tool_contract` records at confidence 0.9–1.0 named `deployAutomationTool`,
 *    `activateAutomationTool` and `executeAutomationRequestTool` as contract
 *    violators because the depth gate had asked for approval — the gate working
 *    as designed, recorded as the three Golden Path tools being broken.
 *
 * Run: npx tsx src/mastra/scripts/check-memory-extractor-hygiene.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isPolicyGateMessage } from '../services/memory-extractor.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

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

console.log('check:memory-extractor-hygiene');

// ── A policy gate is not a defect ────────────────────────────────────────────

check('the depth gate\'s real wording is recognised as a policy gate', () => {
  // Verbatim from the records that reached system_knowledge. The adverb between
  // "requires" and "approval" is what slipped past the previous adjacent-words
  // form, so this exact string is the regression.
  assert.equal(
    isPolicyGateMessage('Depth profile "critical" requires explicit approval before high-risk tool execution. Blocked tool: a'),
    true,
  );
});

check('the plain approval wordings still match', () => {
  for (const message of [
    'This action requires approval before it can run.',
    'Deploy needs an approvalToken to proceed.',
    'activation was blocked pending review',
    'awaiting user decision',
    'pending approval from the operator',
  ]) {
    assert.equal(isPolicyGateMessage(message), true, `should be a policy gate: ${message}`);
  }
});

check('a genuine tool defect is NOT mistaken for a policy gate', () => {
  for (const message of [
    'ENOENT: no such file or directory, open \'/tmp/n8n_workflow.json\'',
    'Tool input validation failed for artifactPutTool: subtaskId is required',
    'n8n updateWorkflow failed (400): request/body/settings must NOT have additional properties',
    'This model is currently experiencing high demand.',
  ]) {
    assert.equal(isPolicyGateMessage(message), false, `should NOT be a policy gate: ${message}`);
  }
});

// Deliberately NOT asserted: that an approval mention in a *later* sentence
// cannot launder an unrelated failure out of recall. The predicate scans the
// whole message, so "The tool crashed. Separately, deploys require approval."
// reads as a gate. Distinguishing the sentence a message is ABOUT is beyond a
// regex, and the original form had the same property — tightening it here would
// trade a rare false positive for false NEGATIVES, i.e. real gates going back
// into failure learning, which is the bug this check exists to prevent.
// `errorMessage` values in practice are a single clause. Revisit only if a
// multi-sentence message is ever observed being swallowed.

// ── Latency is telemetry, not knowledge ──────────────────────────────────────

const extractorSourceRaw = readFileSync(
  join(AGENTIC_AGENTS_REPO, 'src/mastra/services/memory-extractor.ts'),
  'utf8',
);

/**
 * Comments explain why a pattern was removed and necessarily quote it, so scan
 * CODE only — otherwise the tombstone documenting the fix trips the guard that
 * enforces it.
 */
const extractorSource = extractorSourceRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

check('no extractor runs on delegation duration again', () => {
  // Guarding the SHAPE, not the old name: any future "slow delegation → advice"
  // pattern would reintroduce the same 96%-noise bucket.
  const orchestrator = extractorSource.slice(extractorSource.indexOf('export async function extractKnowledge'));
  const active = orchestrator
    .split('\n')
    .filter((line) => /^\s*total \+= await extract/.test(line));
  assert.ok(active.length > 0, 'the orchestrator must still run some extractors');
  assert.ok(
    !active.some((line) => /costly|duration|latenc|slow/i.test(line)),
    `no duration-based extractor may be wired in, got:\n${active.join('\n')}`,
  );
});

check('nothing files a prompt_rule advising to split a delegation', () => {
  assert.ok(
    !/Consider splitting task/i.test(extractorSource),
    'the "Consider splitting task or reducing prompt size" advice must not come back — '
    + 'it discouraged the n8nMcpEngineer handoff the architect depends on',
  );
});

check('the tool_contract extractor filters policy gates', () => {
  const start = extractorSource.indexOf('async function extractToolErrorPatterns');
  const end = extractorSource.indexOf('async function', start + 10);
  const body = extractorSource.slice(start, end);
  assert.match(
    body,
    /isPolicyGateMessage/,
    'extractToolErrorPatterns must skip policy-gate messages, like extractDirectFailures does',
  );
});

if (failures > 0) {
  console.error(`\n❌ check:memory-extractor-hygiene — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\n✅ check:memory-extractor-hygiene — policy gates stay out of failure/contract learning, latency stays out of recall');
process.exit(0);
