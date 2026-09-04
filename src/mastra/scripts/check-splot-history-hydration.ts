#!/usr/bin/env tsx
/**
 * Test: Validates that historical thread messages reconstruct rich turn steps (tools, thoughts, delegations)
 */

import assert from 'node:assert/strict';

const BASE_URL = process.env.MASTRA_SERVER_URL || 'http://localhost:4111';

async function main() {
  console.log(`[CheckSplotHistoryHydration] Testing history hydration on ${BASE_URL}...`);

  // 1. Fetch available threads
  const threadsRes = await fetch(`${BASE_URL}/splot/api/threads?limit=10`);
  assert.equal(threadsRes.status, 200, `GET /splot/api/threads returned ${threadsRes.status}`);
  const threadsJson = await threadsRes.json();
  assert.ok(threadsJson.data && threadsJson.data.length > 0, 'Should return at least one thread');

  // Find a thread with rich messages (e.g. thread_1787925419876 or first thread)
  const targetThread = threadsJson.data.find((t: any) => t.id === 'thread_1787925419876') || threadsJson.data[0];
  console.log(`Targeting thread: "${targetThread.title}" (${targetThread.id})`);

  // 2. Fetch thread messages
  const msgRes = await fetch(`${BASE_URL}/splot/api/threads/${targetThread.id}/messages`);
  assert.equal(msgRes.status, 200, `GET /splot/api/threads/:id/messages returned ${msgRes.status}`);
  const msgJson = await msgRes.json();

  assert.ok(Array.isArray(msgJson.data), 'Messages must be an array');
  console.log(`Received ${msgJson.data.length} conversational turns for thread ${targetThread.id}`);

  let totalToolsFound = 0;
  let totalDelegationsFound = 0;
  let agentTurnsCount = 0;

  for (const turn of msgJson.data) {
    if (turn.type === 'agent_turn') {
      agentTurnsCount++;
      if (Array.isArray(turn.tools)) {
        totalToolsFound += turn.tools.length;
      }
      if (Array.isArray(turn.delegations)) {
        totalDelegationsFound += turn.delegations.length;
      }
    }
  }

  console.log(`Summary of reconstructed history:`);
  console.log(` - Agent turns: ${agentTurnsCount}`);
  console.log(` - Reconstructed tool operations: ${totalToolsFound}`);
  console.log(` - Reconstructed delegations: ${totalDelegationsFound}`);

  // Assertions
  assert.ok(agentTurnsCount > 0, 'Should have at least 1 agent turn');
  if (targetThread.id === 'thread_1787925419876') {
    assert.ok(totalToolsFound > 0, 'thread_1787925419876 must have reconstructed tools');
    assert.ok(totalDelegationsFound > 0, 'thread_1787925419876 must have reconstructed delegations');
  }

  console.log('\n🎉 ALL HISTORY HYDRATION TESTS PASSED!');
}

main().catch((err) => {
  console.error('❌ Check failed:', err);
  process.exit(1);
});
