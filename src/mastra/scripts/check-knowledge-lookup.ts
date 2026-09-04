/**
 * Verification script for Knowledge Lookup Tool and Knowledge Base Taxonomy.
 * Run with: npx tsx src/mastra/scripts/check-knowledge-lookup.ts
 */
import assert from 'node:assert/strict';
import { knowledgeLookupTool } from '../tools/knowledge/knowledge-lookup-tool.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, (err as Error).message);
    failed++;
  }
}

async function run() {
  console.log('=== Testing Knowledge Base & knowledge_lookup Tool ===');

  await test('1. Root INDEX.md read', async () => {
    const res = await (knowledgeLookupTool.execute as any)({ path: 'INDEX.md' }, {} as any);
    assert.equal(res.success, true, 'Should succeed reading root INDEX.md');
    assert.ok(res.content.includes('GŁÓWNA MAPA WIEDZY SYSTEMU'), 'Content should contain title');
    assert.ok(res.availableSections && res.availableSections.length > 0, 'Should have availableSections');
  });

  await test('2. Personal INDEX.md read', async () => {
    const res = await (knowledgeLookupTool.execute as any)({ path: 'personal/INDEX.md' }, {} as any);
    assert.equal(res.success, true);
    assert.ok(res.content.includes('REJESTR WIEDZY OSOBISTEJ'));
  });

  await test('3. Business INDEX.md read', async () => {
    const res = await (knowledgeLookupTool.execute as any)({ path: 'business/INDEX.md' }, {} as any);
    assert.equal(res.success, true);
    assert.ok(res.content.includes('REJESTR WIEDZY BIZNESOWEJ'));
  });

  await test('4. Core Anchor YAML read', async () => {
    const res = await (knowledgeLookupTool.execute as any)({ path: 'personal/identity/core-anchor.yaml' }, {} as any);
    assert.equal(res.success, true);
    assert.ok(res.content.includes('Alex Doe'));
    assert.ok(res.content.includes('+1 (555) 019-2834'));
    assert.ok(res.content.includes('no_invented_linkedin: true'));
  });

  await test('5. Sliced IT grounding read with section filtering', async () => {
    const res = await (knowledgeLookupTool.execute as any)({
      path: 'personal/identity/grounding-it-ai.md',
      section: 'Profil Zawodowy w Jednym Zdaniu',
    }, {} as any);
    assert.equal(res.success, true);
    assert.ok(res.content.includes('AI Solutions Engineer'));
    assert.ok(!res.content.includes('## Kluczowe Kompetencje'), 'Should only return the target section');
  });

  await test('6. Path containment security (reject path traversal)', async () => {
    const res = await (knowledgeLookupTool.execute as any)({ path: '../../../etc/passwd' }, {} as any);
    assert.equal(res.success, false);
    assert.match(res.error, /traversal|denied/i);
  });

  await test('7. Fail-soft with helpful suggestions on non-existent file', async () => {
    const res = await (knowledgeLookupTool.execute as any)({ path: 'unknown-document.md' }, {} as any);
    assert.equal(res.success, false);
    assert.ok(res.availableFiles && res.availableFiles.length > 0, 'Should list available files');
  });

  console.log(`
========================================`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test run failed:', e);
  process.exit(1);
});
