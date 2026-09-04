#!/usr/bin/env tsx
/**
 * Test: Validates thread filtering on /splot/api/threads (excludes internal delegation/system threads)
 */

import assert from 'node:assert/strict';

const BASE_URL = process.env.MASTRA_SERVER_URL || 'http://localhost:4111';

async function main() {
  console.log(`[CheckSplotThreadFiltering] Testing /splot/api/threads on ${BASE_URL}...`);

  // 1. Test clean default user thread list
  const res = await fetch(`${BASE_URL}/splot/api/threads?limit=50`);
  assert.equal(res.status, 200, `GET /splot/api/threads returned ${res.status}`);

  const json = await res.json();
  assert.ok(Array.isArray(json.data), 'data should be an array of threads');

  console.log(`Checking ${json.data.length} threads for clean user-only filtering...`);
  
  for (const thread of json.data) {
    const isInternal = /^(delegation-|async-delegation-|orch-v2-|subtask-|scheduled-task-|test_|test-)/.test(thread.id);
    assert.ok(
      !isInternal,
      `Internal system/test thread "${thread.id}" should NOT appear in default user thread list!`,
    );
  }
  console.log('✅ 1. Default /splot/api/threads returned ONLY user conversation threads (0 internal system threads leak)');

  // 2. Test includeSystem=true flag
  const sysRes = await fetch(`${BASE_URL}/splot/api/threads?limit=50&includeSystem=true`);
  assert.equal(sysRes.status, 200, `GET /splot/api/threads?includeSystem=true returned ${sysRes.status}`);

  const sysJson = await sysRes.json();
  assert.ok(Array.isArray(sysJson.data), 'data should be an array');
  console.log(`✅ 2. GET /splot/api/threads?includeSystem=true returned ${sysJson.data.length} total threads (including system)`);

  console.log('\n🎉 ALL THREAD FILTERING TESTS PASSED!');
}

main().catch((err) => {
  console.error('❌ Check failed:', err);
  process.exit(1);
});
