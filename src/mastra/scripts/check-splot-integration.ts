#!/usr/bin/env tsx
/**
 * Verification Test: Validates all /splot/api/* endpoints on the running Mastra server (http://localhost:4111)
 */

import assert from 'node:assert/strict';

const BASE_URL = process.env.MASTRA_API_URL || 'http://localhost:4111';

async function runTests() {
  console.log(`[CheckSplotIntegration] Testing endpoints on ${BASE_URL}...`);

  // 1. Test /splot UI route
  const uiRes = await fetch(`${BASE_URL}/splot`);
  assert.equal(uiRes.status, 200, `GET /splot returned ${uiRes.status}`);
  const uiHtml = await uiRes.text();
  assert.ok(uiHtml.includes('Splot OS'), 'GET /splot should render Splot OS');
  console.log('✅ 1. GET /splot UI rendered successfully');

  // 2. Test /splot/api/threads
  const threadsRes = await fetch(`${BASE_URL}/splot/api/threads?limit=10`);
  assert.equal(threadsRes.status, 200, `GET /splot/api/threads returned ${threadsRes.status}`);
  const threadsJson = await threadsRes.json();
  assert.ok(Array.isArray(threadsJson.data), 'Threads response should contain data array');
  console.log(`✅ 2. GET /splot/api/threads returned ${threadsJson.data.length} threads from MongoDB`);

  // 3. Test /splot/api/threads/:id/messages if threads exist
  if (threadsJson.data.length > 0) {
    const firstThread = threadsJson.data[0];
    const msgsRes = await fetch(`${BASE_URL}/splot/api/threads/${encodeURIComponent(firstThread.id)}/messages`);
    assert.equal(msgsRes.status, 200, `GET /splot/api/threads/${firstThread.id}/messages returned ${msgsRes.status}`);
    const msgsJson = await msgsRes.json();
    assert.ok(Array.isArray(msgsJson.data), 'Messages response should contain data array');
    console.log(`✅ 3. GET /splot/api/threads/${firstThread.id}/messages returned ${msgsJson.data.length} messages`);
  }

  // 4. Test /splot/api/inspectors/memory
  const memRes = await fetch(`${BASE_URL}/splot/api/inspectors/memory`);
  assert.equal(memRes.status, 200, `GET /splot/api/inspectors/memory returned ${memRes.status}`);
  const memJson = await memRes.json();
  assert.ok(Array.isArray(memJson.data?.rules), 'Memory rules should be an array');
  assert.ok(memJson.data?.stats?.totalRules >= 0, 'Memory stats totalRules should be non-negative');
  console.log(`✅ 4. GET /splot/api/inspectors/memory returned ${memJson.data.rules.length} rules (Total in DB: ${memJson.data.stats.totalRules})`);

  // 5. Test /splot/api/inspectors/ledger
  const ledgerRes = await fetch(`${BASE_URL}/splot/api/inspectors/ledger`);
  assert.equal(ledgerRes.status, 200, `GET /splot/api/inspectors/ledger returned ${ledgerRes.status}`);
  const ledgerJson = await ledgerRes.json();
  assert.ok(Array.isArray(ledgerJson.data?.lanes), 'Ledger lanes should be an array');
  assert.ok(Array.isArray(ledgerJson.data?.events), 'Ledger events should be an array');
  console.log(`✅ 5. GET /splot/api/inspectors/ledger returned ${ledgerJson.data.lanes.length} lanes & ${ledgerJson.data.events.length} events`);

  // 6. Test /splot/api/inspectors/artifacts
  const artRes = await fetch(`${BASE_URL}/splot/api/inspectors/artifacts`);
  assert.equal(artRes.status, 200, `GET /splot/api/inspectors/artifacts returned ${artRes.status}`);
  const artJson = await artRes.json();
  assert.ok(Array.isArray(artJson.data), 'Artifacts response should contain data array');
  console.log(`✅ 6. GET /splot/api/inspectors/artifacts returned ${artJson.data.length} artifacts`);

  // 7. Test /splot/api/orchestration/overview
  const orchRes = await fetch(`${BASE_URL}/splot/api/orchestration/overview`);
  assert.equal(orchRes.status, 200, `GET /splot/api/orchestration/overview returned ${orchRes.status}`);
  const orchJson = await orchRes.json();
  assert.ok(orchJson.data?.kpis, 'Orchestration overview should contain KPIs');
  console.log(`✅ 7. GET /splot/api/orchestration/overview returned KPIs:`, orchJson.data.kpis);

  // 8. Test /splot/api/evaluations/summary
  const evalsRes = await fetch(`${BASE_URL}/splot/api/evaluations/summary`);
  assert.equal(evalsRes.status, 200, `GET /splot/api/evaluations/summary returned ${evalsRes.status}`);
  const evalsJson = await evalsRes.json();
  assert.ok(Array.isArray(evalsJson.data?.rows), 'Evaluations should contain rows');
  console.log(`✅ 8. GET /splot/api/evaluations/summary returned ${evalsJson.data.rows.length} scorer rows`);

  // 9. Test /splot/api/chat with crmAgent
  console.log('Testing POST /splot/api/chat with crmAgent...');
  const chatRes = await fetch(`${BASE_URL}/splot/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: 'crmAgent',
      threadId: `test_splot_verification_${Date.now()}`,
      message: 'Ile mamy leadów w bazie?',
      resourceId: 'test-verifier',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  assert.equal(chatRes.status, 200, `POST /splot/api/chat returned ${chatRes.status}`);
  const chatJson = await chatRes.json();
  assert.ok(chatJson.success, 'Chat response should indicate success');
  assert.ok(typeof chatJson.text === 'string' && chatJson.text.length > 0, 'Chat response should have text');
  console.log(`✅ 9. POST /splot/api/chat executed successfully with crmAgent (${chatJson.elapsedMs}ms)`);
  console.log(`   Response snippet: "${chatJson.text.substring(0, 100)}..."`);
  console.log(`   Steps returned: ${chatJson.steps?.length || 0}`);

  console.log('\n🎉 ALL SPLOT INTEGRATION TESTS PASSED!');
}

runTests().catch(err => {
  console.error('[CheckSplotIntegration] ❌ Test failed:', err);
  process.exit(1);
});
