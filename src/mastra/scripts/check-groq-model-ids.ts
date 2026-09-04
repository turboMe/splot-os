#!/usr/bin/env tsx
/**
 * Groq model IDs must survive the gateway's ID reconstruction.
 *
 * Why this exists: Groq namespaces models (`openai/gpt-oss-120b`,
 * `qwen/qwen3.6-27b`). The gateway derives its model list from the manifest by stripping the
 * `custom-groq/groq/` prefix — and an earlier version stripped everything up to
 * the LAST slash instead, silently turning `qwen/qwen3.6-27b` into
 * `qwen3.6-27b`, a model that does not exist. The failure mode was a provider
 * marked `api_unreachable` at startup rather than an obvious error, which is
 * exactly the kind of thing that rots unnoticed.
 *
 * This is a pure string/shape check — no network, so it runs in check:all. The
 * live counterpart is `npm run probe:worker-presets`, which asks the real API.
 *
 * Run: npx tsx src/mastra/scripts/check-groq-model-ids.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { models, workerPresets } from '../config/model-manifest.js';
import { modelRegistry } from '../config/model-capabilities.js';

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

const GROQ_PREFIX = 'custom-groq/groq/';
const PRODUCTION_WORKER_MODELS = new Set([
  'groq-gpt-oss-20b',
  'groq-gpt-oss-120b',
]);
const groqEntries = Object.entries(models)
  .filter(([, fullId]) => String(fullId).startsWith('custom-groq/'));

console.log('check:groq-model-ids');

check('every Groq entry uses the custom-groq/groq/ prefix exactly', () => {
  assert.ok(groqEntries.length > 0, 'expected at least one Groq model in the manifest');
  for (const [alias, fullId] of groqEntries) {
    assert.ok(
      String(fullId).startsWith(GROQ_PREFIX),
      `${alias} must start with ${GROQ_PREFIX}, got ${fullId}`,
    );
  }
});

check('a namespaced model keeps its namespace after prefix stripping', () => {
  // The exact regression: `lastIndexOf('/')` would drop the vendor namespace and
  // produce an ID Groq does not serve.
  for (const [alias, fullId] of groqEntries) {
    const apiId = String(fullId).slice(GROQ_PREFIX.length);
    assert.ok(apiId.length > 0, `${alias} resolves to an empty API id`);
    assert.ok(
      !apiId.startsWith('/') && !apiId.includes('//'),
      `${alias} resolves to a malformed API id: ${apiId}`,
    );
    const naive = String(fullId).slice(String(fullId).lastIndexOf('/') + 1);
    if (apiId.includes('/')) {
      assert.notEqual(
        apiId,
        naive,
        `${alias} is namespaced, so the naive last-slash split would corrupt it — this test exists to keep the correct split`,
      );
    }
  }
});

check('the capability registry points at manifest IDs, not hand-typed strings', () => {
  // A capability row with a stale literal would advertise a model that routing
  // can never resolve.
  const known = new Set(Object.values(models).map(String));
  const groqRows = modelRegistry.filter((row) => row.modelId.startsWith('custom-groq/'));
  assert.ok(groqRows.length > 0, 'expected Groq rows in the capability registry');
  for (const row of groqRows) {
    assert.ok(known.has(row.modelId), `${row.name} uses an id absent from the manifest: ${row.modelId}`);
  }
});

check('each active Groq model has exactly one capability row', () => {
  for (const alias of PRODUCTION_WORKER_MODELS) {
    const modelId = models[alias as keyof typeof models];
    const rows = modelRegistry.filter((row) => row.modelId === modelId);
    assert.equal(rows.length, 1, `${alias} must have exactly one capability row, got ${rows.length}`);
  }
});

check('every system.run_worker preset uses a production Groq model', () => {
  for (const [preset, alias] of Object.entries(workerPresets)) {
    assert.ok(
      PRODUCTION_WORKER_MODELS.has(alias),
      `${preset} points at ${alias}; expected a production Groq worker model`,
    );
  }
});

check('decommissioned Groq Llama ids are absent from the inventory', () => {
  const fullIds = new Set<string>(Object.values(models));
  assert.ok(!fullIds.has('custom-groq/groq/llama-3.3-70b-versatile'));
  assert.ok(!fullIds.has('custom-groq/groq/llama-3.1-8b-instant'));
});

check('the Meta prompt does not hardcode preset model names', () => {
  const prompt = readFileSync('src/mastra/prompts/meta/base.md', 'utf8');
  assert.ok(prompt.includes('mapping is owned by `config/model-manifest.ts`'));
  assert.ok(!prompt.includes('| preset | Model |'));
  for (const preset of Object.keys(workerPresets)) {
    assert.ok(prompt.includes(`\`${preset}\``), `Meta prompt is missing worker preset ${preset}`);
  }
  for (const staleModel of ['gemma4:26b', 'qwen3-coder:30b', 'qwen3.5-abliterated:35b']) {
    assert.ok(!prompt.includes(staleModel), `Meta prompt still advertises stale model ${staleModel}`);
  }
});

check('Groq capability rows gate on GROQ_API_KEY, not another provider key', () => {
  // These models were previously gated on OPENROUTER_API_KEY, so they claimed to
  // be available whenever an unrelated provider happened to be configured.
  //
  // Scoped per ROW: a fixed character window runs past the row's closing brace
  // into the next (non-Groq) entry and reports its key as a Groq bug.
  const source = readFileSync('src/mastra/config/model-capabilities.ts', 'utf8');
  const rows = source.split(/\n\s*\{\s*\n/);
  const groqRows = rows.filter((row) => row.includes("models['groq-"));
  assert.ok(groqRows.length > 0, 'expected Groq rows in the capability source');
  for (const row of groqRows) {
    const body = row.slice(0, row.indexOf('},') === -1 ? row.length : row.indexOf('},'));
    const alias = /models\['(groq-[^']+)'\]/.exec(body)?.[1] ?? 'unknown';
    const gate = /available:\s*!!process\.env\.([A-Z_]+)/.exec(body)?.[1];
    assert.equal(
      gate,
      'GROQ_API_KEY',
      `${alias} is gated on ${gate ?? 'nothing'} — availability would be wrong whenever only one provider key is set`,
    );
  }
});

if (failures > 0) {
  console.error(`\n❌ check:groq-model-ids — ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ check:groq-model-ids — ${groqEntries.length} Groq ids resolve to well-formed API ids`);
process.exit(0);
