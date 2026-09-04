#!/usr/bin/env tsx
/**
 * check:result-envelope-parse — Etap 3 (IDEALSYSTEMMASTERPLAN).
 *
 * Deterministic assertions on the ResultEnvelope parser:
 *   - fenced ```json result_envelope``` block parses (with prose around it)
 *   - trailing bare JSON with valid status parses
 *   - prose replies fall back to { status: ok, parsed: false, raw preserved }
 *   - invalid status / malformed JSON → fallback, never a throw
 *   - artifacts + lessons default to []; stripEnvelopeBlock removes the fence
 */
import assert from 'node:assert/strict';
import { parseResultEnvelope, stripEnvelopeBlock } from '../services/result-envelope.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:result-envelope-parse');

const fencedReply = [
  'I finished the research. Key findings are in the artifact.',
  '',
  '```json result_envelope',
  JSON.stringify({
    status: 'ok',
    artifacts: [{ id: 'art-123', type: 'research_report', summary: 'Menu analysis of restaurant X' }],
    lessons: ['Full-page extraction beats snippets for menu recon'],
    followup: 'Consider a reputation recon next',
  }),
  '```',
].join('\n');

check('fenced envelope parses with artifacts + lessons', () => {
  const env = parseResultEnvelope(fencedReply);
  assert.equal(env.parsed, true);
  assert.equal(env.status, 'ok');
  assert.equal(env.artifacts[0]?.id, 'art-123');
  assert.equal(env.lessons.length, 1);
  assert.equal(env.followup, 'Consider a reputation recon next');
  assert.ok(env.raw.includes('I finished the research'), 'raw preserved');
});

check('```result_envelope fence variant parses too', () => {
  const env = parseResultEnvelope('Done.\n```result_envelope\n{"status":"partial","artifacts":[],"lessons":["x"]}\n```');
  assert.equal(env.parsed, true);
  assert.equal(env.status, 'partial');
});

check('trailing bare JSON with status parses', () => {
  const env = parseResultEnvelope('Report done.\n{"status":"blocked_needs_approval","artifacts":[],"lessons":[]}');
  assert.equal(env.parsed, true);
  assert.equal(env.status, 'blocked_needs_approval');
});

check('prose reply → fallback ok envelope, raw preserved', () => {
  const prose = 'Here is my long analysis of the market. Everything went fine.';
  const env = parseResultEnvelope(prose);
  assert.equal(env.parsed, false);
  assert.equal(env.status, 'ok');
  assert.deepEqual(env.artifacts, []);
  assert.deepEqual(env.lessons, []);
  assert.equal(env.raw, prose);
});

check('invalid status → fallback, no throw', () => {
  const env = parseResultEnvelope('x\n```json result_envelope\n{"status":"weird"}\n```');
  assert.equal(env.parsed, false);
  assert.equal(env.status, 'ok');
});

check('malformed JSON → fallback, no throw', () => {
  const env = parseResultEnvelope('x\n```json result_envelope\n{status: broken\n```');
  assert.equal(env.parsed, false);
});

check('empty/undefined input → fallback', () => {
  assert.equal(parseResultEnvelope('').status, 'ok');
  assert.equal(parseResultEnvelope(undefined as unknown as string).status, 'ok');
});

check('stripEnvelopeBlock removes the fence, keeps prose', () => {
  const stripped = stripEnvelopeBlock(fencedReply);
  assert.ok(stripped.includes('I finished the research'));
  assert.ok(!stripped.includes('result_envelope'));
});

check('trailing JSON that is NOT an envelope stays prose fallback', () => {
  const env = parseResultEnvelope('Result:\n{"foo": 1}');
  assert.equal(env.parsed, false);
});

if (failures > 0) {
  console.error(`\n❌ check:result-envelope-parse — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:result-envelope-parse — all assertions passed');
process.exit(0);
