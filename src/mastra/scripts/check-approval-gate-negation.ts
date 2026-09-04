#!/usr/bin/env tsx
/**
 * check:approval-gate-negation — a spec that DENIES a risk is not evidence of it.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `requiresApprovalGate` (generate-with-harness.ts) decided "high-risk action"
 * from a bare keyword test against `secret|sekret|database|credential|production|…`.
 * The Capability Gap Protocol's own spec template REQUIRES every build spec to
 * declare its secret/side-effect posture (`capability/base.md` Move 1: "Include
 * safety constraints … secret ENV VAR names if relevant"), so a spec that says
 * "zero secrets, read-only, no side effects" tripped the gate on the word
 * "secret" alone. Measured live 2026-08-22: capabilitySmith's build delegation
 * for a read-only regex checker — a spec that explicitly denied every risk in
 * the keyword list — got its final answer rewritten into a bogus "needs
 * approval" refusal, indistinguishable from a real block.
 *
 * WHAT THE FIX IS: a bounded lookback for a negation cue immediately before
 * the match (`no`/`zero`/`without`/`nie`/`bez`/…). Deliberately not real NLP —
 * it can only SUPPRESS a trigger, never add one, so a genuinely risky,
 * un-negated mention still fires exactly as before. This suite proves both
 * halves: the false positive is gone, and real positives are not.
 *
 * Run: npx tsx src/mastra/scripts/check-approval-gate-negation.ts
 */
import assert from 'node:assert/strict';
import { requiresApprovalGate } from '../services/generate-with-harness.js';

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

console.log('check:approval-gate-negation');

// ── 1. The exact false positive, verbatim from the live incident ──────────

const REAL_SPEC_EXCERPT =
  'Chcę nową capability: mały, deterministyczny checker, który skanuje pliki *.ts ' +
  'w podanym katalogu i zgłasza KAŻDE wystąpienie literału regex. ' +
  'Zero efektów ubocznych, zero sekretów, tylko odczyt plików i raport.';

check('a spec that explicitly denies secrets no longer trips the gate', () => {
  assert.equal(requiresApprovalGate(REAL_SPEC_EXCERPT, ''), false,
    'the exact live-incident text must no longer be misread as high-risk');
});

check('English phrasing of the same denial is also safe', () => {
  assert.equal(
    requiresApprovalGate('This tool has zero secrets and no database writes, read-only only.', ''),
    false,
  );
});

check('a denial can live in the OUTPUT, not just the prompt', () => {
  assert.equal(
    requiresApprovalGate('describe the tool', 'It requires no credential and touches no production system.'),
    false,
  );
});

// ── 2. Real positives must still fire — the fix must not blind the gate ───

check('an un-negated "secret" still fires', () => {
  assert.equal(requiresApprovalGate('Store the API secret in the .env file.', ''), true);
});

check('an un-negated "wyślij email" still fires', () => {
  assert.equal(
    requiresApprovalGate('Wyślij email do wszystkich klientów z linkiem promocyjnym.', ''),
    true,
  );
});

check('an un-negated "deploy to production" still fires', () => {
  assert.equal(requiresApprovalGate('Deploy this workflow to production now.', ''), true);
});

check('an un-negated "usuń" (delete) still fires', () => {
  assert.equal(requiresApprovalGate('Usuń rekord klienta z bazy produkcyjnej.', ''), true);
});

// ── 3. Negation only suppresses NEARBY risk words, not the whole text ─────

check('negating one risk word does not blind a later, real one', () => {
  // "zero sekretów" is negated; "wyślij email" two sentences later is not.
  const text = 'Zero sekretów w tym zadaniu. Osobno: wyślij email z podsumowaniem do klienta.';
  assert.equal(requiresApprovalGate(text, ''), true,
    'a negation must not suppress an unrelated, genuinely risky instruction further in the text');
});

check('a negation far outside the lookback window does not suppress a match', () => {
  const filler = 'x '.repeat(40); // pushes "secret" well past NEGATION_LOOKBACK_CHARS
  assert.equal(requiresApprovalGate(`no. ${filler}the secret is here`, ''), true,
    'a negation 80+ chars away must not reach across unrelated text');
});

// ── 4. Falsify: the OLD behaviour (no negation awareness) really did fire ──

check('FALSIFIED: the pre-fix bare-keyword test would have wrongly fired here', () => {
  const bareKeywordTest =
    /deploy|activate|aktyw|delete|usuń|usun|migrac|migration|credential|secret|sekret|production|produkc|payment|płatno|platno|send email|wyślij|wyslij|workflow activation|database|baza danych/i;
  assert.equal(bareKeywordTest.test(REAL_SPEC_EXCERPT), true,
    'sanity check: the old regex must actually match the live incident text, ' +
    'or this suite would be proving nothing');
});

console.log(failures === 0 ? '\n✅ check:approval-gate-negation — all assertions passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
