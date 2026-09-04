#!/usr/bin/env tsx
/**
 * check:skill-distill-roundtrip — Etap 6 (IDEALSYSTEMMASTERPLAN §5).
 *
 * Deterministic, LLM-free proof of the distillation roundtrip:
 *   candidate → distiller (injected deterministic writer) → SKILL.md →
 *   registry picks it up → loadable/searchable → mini-eval gates quality.
 *
 * The model call is injected, so no tokens are burned and the result is stable.
 *   - shouldDistill trigger predicate (tool calls / recovery / correction)
 *   - recordDistillationCandidate persists a pending candidate
 *   - a GOOD skill → activated → written to _skills/auto → new registry loads it
 *   - a GARBAGE skill (no steps / secret) → quarantined, NOT in the pool
 *   - secrets are redacted out of the written skill
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDb } from '../lib/mongo.js';
import { SkillRegistry } from '../services/skill-registry.js';
import {
  shouldDistill,
  recordDistillationCandidate,
  distillCandidate,
  miniEvalSkill,
  listPendingCandidates,
  AUTO_SKILLS_DIR,
  QUARANTINE_DIR,
  CANDIDATES_COLLECTION,
  type DistillationCandidate,
  type DistilledSkill,
} from '../services/skill-distiller.js';

const TAG = `distill-check-${Date.now()}`;
const GOOD_NAME = `${TAG}-good`;
const BAD_NAME = `${TAG}-bad`;
let failures = 0;

function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures += 1; console.error(`  ✗ ${name}: ${(err as Error).message}`); });
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection(CANDIDATES_COLLECTION).deleteMany({ candidateId: { $regex: TAG } }).catch(() => undefined);
  await rm(resolve(AUTO_SKILLS_DIR, `${GOOD_NAME}.md`), { force: true }).catch(() => undefined);
  await rm(resolve(QUARANTINE_DIR, `${BAD_NAME}.md`), { force: true }).catch(() => undefined);
}

async function main(): Promise<void> {
  process.env.FEATURE_SKILL_DISTILLATION = 'true';
  console.log('check:skill-distill-roundtrip');

  await ok('shouldDistill: triggers on tool calls / recovery / correction, not otherwise', () => {
    assert.equal(shouldDistill({ toolCallCount: 6 }).trigger, 'tool_calls');
    assert.equal(shouldDistill({ recovered: true }).trigger, 'recovery');
    assert.equal(shouldDistill({ userCorrected: true }).trigger, 'user_correction');
    assert.equal(shouldDistill({ toolCallCount: 2 }).distill, false);
  });

  await ok('recordDistillationCandidate persists a pending candidate', async () => {
    const id = await recordDistillationCandidate({
      taskId: `${TAG}-task`,
      agentId: 'automationArchitect',
      goal: 'Deploy a webhook→validate→respond workflow with idempotent retries',
      toolCallCount: 7,
      lessons: ['Always MCP-validate node typeVersions before compose'],
      resultSummary: 'Deployed inactive workflow after MCP validation.',
    });
    assert.ok(id, 'candidate id returned');
    // Look the record up directly instead of hoping it lands inside a window of
    // listPendingCandidates(): that query sorts oldest-first, so once the queue
    // holds more pending candidates than the limit, a freshly written one is
    // never in the page and this assertion fails for reasons unrelated to the
    // code under test. (Seen for real at 57 pending vs a limit of 50.)
    const db = await getDb();
    const stored = await db.collection('distillation_candidates').findOne({ candidateId: id });
    assert.ok(stored, 'candidate persisted');
    assert.equal(stored?.status, 'pending', 'candidate is pending');
    // The listing itself must still only ever surface pending candidates.
    const pending = await listPendingCandidates(50);
    assert.ok(pending.every((c) => c.status === 'pending'), 'listing returns only pending candidates');
  });

  await ok('below-threshold task does NOT record a candidate', async () => {
    const id = await recordDistillationCandidate({
      goal: 'trivial', toolCallCount: 1, lessons: [],
    });
    assert.equal(id, undefined);
  });

  await ok('GOOD skill → activated, written, loadable by a fresh registry', async () => {
    const candidate: DistillationCandidate = {
      candidateId: `${TAG}-c-good`, goal: 'Deploy idempotent n8n webhook', trigger: 'tool_calls',
      toolCallCount: 7, lessons: ['MCP-validate first'], status: 'pending', createdAt: new Date(),
    };
    const writer = async (): Promise<DistilledSkill> => ({
      name: GOOD_NAME,
      description: 'Deploy an idempotent n8n webhook workflow with MCP-validated node typeVersions and retry-safe design.',
      category: 'n8n',
      keywords: ['n8n', 'webhook', 'idempotent', 'deploy'],
      body: '# Steps\n1. MCP-validate node typeVersions.\n2. Compose the workflow JSON.\n3. Risk-score and deploy inactive.\n4. Mock-test the webhook.\n\n## Pitfalls\n- Never skip MCP validation.',
    });
    const res = await distillCandidate(candidate, writer);
    assert.equal(res.activated, true, `should activate: ${res.eval.reasons.join(', ')}`);
    assert.equal(res.skillName, GOOD_NAME);

    // A fresh registry pointed at the auto dir must load it (searchable pool).
    const registry = new SkillRegistry();
    await registry.initialize(AUTO_SKILLS_DIR);
    const loaded = await registry.load(GOOD_NAME);
    assert.ok(loaded, 'auto-distilled skill is loadable');
    assert.match(loaded!.procedure, /MCP-validate/);
    assert.ok(registry.list().some((m) => m.name === GOOD_NAME), 'skill is in the searchable pool');
  });

  await ok('GARBAGE skill → quarantined, NOT activated', async () => {
    const candidate: DistillationCandidate = {
      candidateId: `${TAG}-c-bad`, goal: 'x', trigger: 'recovery', status: 'pending', createdAt: new Date(), lessons: [],
    };
    const writer = async (): Promise<DistilledSkill> => ({
      name: BAD_NAME, description: 'too short', category: 'auto', keywords: [], body: 'no steps here',
    });
    const res = await distillCandidate(candidate, writer);
    assert.equal(res.activated, false, 'garbage must be quarantined');
    assert.ok(res.eval.reasons.length > 0);
  });

  await ok('mini-eval flags residual secrets', () => {
    const withSecret: DistilledSkill = {
      name: 'leaky-skill', description: 'A skill that leaked a credential into its steps somehow here.',
      category: 'auto', keywords: ['x'],
      body: '# Steps\n1. Use the AWS key ' + 'AKIA' + 'IOSFODNN7EXAMPLE to authenticate.\n2. Done.',
    };
    const result = miniEvalSkill(withSecret);
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some((r) => /secret/i.test(r)), 'secret detected by mini-eval');
  });

  await cleanup();

  await ok('a skill description written as a YAML block scalar survives parsing', async () => {
    // Measured: 45 of 826 skills write their description as a folded block
    // (`description: >-` with the text on the lines below). The frontmatter
    // parser took the INDICATOR as the value, so `skill_search` answered
    // `"description": ">-"` for every one of them — and the description is
    // exactly what an agent reads to decide which methodology to load. Search
    // worked, ranking worked, and the answer was unusable.
    const { parseFrontmatter } = await import('../lib/yaml-frontmatter.js');

    const folded = parseFrontmatter([
      '---',
      'name: stride-dread',
      'description: >-',
      '  STRIDE threat-classification methodology.',
      '  Use it for changes touching auth or trust boundaries.',
      'keywords: [security, stride]',
      '---',
      '# body',
    ].join('\n'));
    assert.equal(
      folded.metadata.description,
      'STRIDE threat-classification methodology. Use it for changes touching auth or trust boundaries.',
      'a folded block joins its lines with spaces');
    assert.deepEqual(folded.metadata.keywords, ['security', 'stride'],
      'and the key AFTER the block must still be parsed — a block that swallowed the rest of '
      + 'the frontmatter would be worse than the bug it replaced');
    assert.match(folded.body, /# body/, 'the body must survive too');

    const literal = parseFrontmatter([
      '---', 'steps: |', '  first', '  second', 'name: x', '---', 'body',
    ].join('\n'));
    assert.equal(literal.metadata.steps, 'first\nsecond', 'a literal block preserves newlines');
    assert.equal(literal.metadata.name, 'x');

    const plain = parseFrontmatter(['---', 'description: just a line', '---', 'b'].join('\n'));
    assert.equal(plain.metadata.description, 'just a line', 'a plain value is untouched');
  });

  await ok('no shipped skill still describes itself as a YAML indicator', async () => {
    // The corpus itself, not a fixture: a skill that fails this is invisible to
    // the agent choosing between methodologies.
    const { readdirSync, statSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { parseFrontmatter } = await import('../lib/yaml-frontmatter.js');
    const bad: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.md')) {
          const desc = parseFrontmatter(readFileSync(full, 'utf-8')).metadata.description;
          if (typeof desc === 'string' && /^[>|][-+]?$/.test(desc.trim())) bad.push(full);
        }
      }
    };
    walk('src/mastra/_skills');
    assert.deepEqual(bad.slice(0, 5), [],
      `${bad.length} skills describe themselves as a YAML indicator`);
  });

  if (failures > 0) {
    console.error(`\n❌ check:skill-distill-roundtrip — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:skill-distill-roundtrip — all assertions passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ check:skill-distill-roundtrip crashed:', err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
