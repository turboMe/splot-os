/**
 * P3 (delegation-depth-hardening) — checks for the delegation salvage digest.
 *
 * Uses a synthetic delegation thread (inserted + cleaned up) shaped exactly
 * like live `mastra_messages` rows (content = JSON string with parts). As a
 * bonus, when the LIVE Finnsson failure thread is still present, verifies the
 * digest recovers real scraped facts from it.
 *
 * Requires Mongo (MONGODB_URI). Run:
 *   npx tsx src/mastra/scripts/check-delegation-salvage.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getDb } from '../lib/mongo.js';
import { buildDelegationSalvageDigest } from '../tools/system/delegation-salvage.js';

const LIVE_FAILURE_THREAD = 'delegation-62aaf8a9-76ad-42c5-9e3e-d57566b85a6a';

const db = await getDb();
const collection = db.collection('mastra_messages');
const threadId = `check-salvage-${randomUUID()}`;

function makeMessage(role: string, parts: unknown[], at: Date) {
  return {
    id: randomUUID(),
    thread_id: threadId,
    resourceId: 'check-salvage',
    role,
    type: 'v2',
    createdAt: at,
    content: JSON.stringify({ format: 2, parts }),
  };
}

try {
  // ── Synthetic fixture: 1 user brief + assistant turn with tool results ──
  await collection.insertMany([
    makeMessage('user', [{ type: 'text', text: 'GOAL: research the menu of Restaurant X.' }], new Date('2026-07-21T10:00:00Z')),
    makeMessage('assistant', [
      { type: 'reasoning', reasoning: '', details: [{ type: 'text', text: 'internal reasoning — must NOT leak into digest' }] },
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolCallId: 'call-1',
          toolName: 'firecrawl_scrape',
          args: { url: 'https://restaurant-x.example/menu' },
          result: { markdown: 'MENU: Ribeye steak 5900 ISK, Beef cheek 4200 ISK, opening hours 11:30-21:00' },
        },
      },
      { type: 'text', text: 'Scraped the menu page — found 2 steak dishes with prices.' },
    ], new Date('2026-07-21T10:01:00Z')),
    makeMessage('assistant', [
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolCallId: 'call-2',
          toolName: 'search_web',
          args: { query: 'Restaurant X reviews' },
          result: { results: [{ title: 'Great steaks', content: 'Rated 4.4 of 5 on TripAdvisor' }] },
        },
      },
    ], new Date('2026-07-21T10:02:00Z')),
  ] as any[]);

  const digest = await buildDelegationSalvageDigest(threadId);
  assert.equal(digest.found, true, 'synthetic thread should be found');
  assert.equal(digest.messagesCount, 3, `expected 3 messages, got ${digest.messagesCount}`);
  assert.equal(digest.toolResultsCount, 2, `expected 2 tool results, got ${digest.toolResultsCount}`);
  assert.ok(digest.digest.includes('Ribeye steak 5900 ISK'), 'digest must contain scraped menu data');
  assert.ok(digest.digest.includes('4.4 of 5'), 'digest must contain review data');
  assert.ok(digest.digest.includes('firecrawl_scrape'), 'digest must name the tool');
  assert.ok(digest.digest.includes('found 2 steak dishes'), 'digest must contain assistant notes');
  assert.ok(!digest.digest.includes('must NOT leak'), 'reasoning must not leak into digest');
  assert.ok(digest.digest.length <= 25_000, `digest must stay bounded, got ${digest.digest.length} chars`);

  // Unknown thread → found: false, no throw.
  const missing = await buildDelegationSalvageDigest(`check-salvage-missing-${randomUUID()}`);
  assert.equal(missing.found, false, 'unknown thread → found=false');

  // ── Bonus: live Finnsson failure thread (skip silently when purged) ──
  const liveCount = await collection.countDocuments({ thread_id: LIVE_FAILURE_THREAD });
  if (liveCount > 0) {
    const live = await buildDelegationSalvageDigest(LIVE_FAILURE_THREAD);
    assert.equal(live.found, true);
    assert.ok(
      /finnsson/i.test(live.digest),
      'live thread digest should recover Finnsson research data',
    );
    console.log(`Live-thread bonus check passed (${live.toolResultsCount} tool results recovered).`);
  } else {
    console.log('Live failure thread not present — bonus check skipped.');
  }

  console.log('DelegationSalvage checks passed.');
} finally {
  await collection.deleteMany({ thread_id: threadId });
}

process.exit(0);
