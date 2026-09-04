#!/usr/bin/env tsx
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync('src/mastra/index.ts', 'utf8');

assert.ok(
  indexSource.includes("registerApiRoute('/deploy/automation-architect/generate'"),
  'missing automation architect generate wrapper route',
);
assert.ok(indexSource.includes('threadId and resourceId are required'), 'wrapper must require threadId/resourceId');
assert.ok(indexSource.includes('memory:') && indexSource.includes('thread: threadId') && indexSource.includes('resource: resourceId'), 'wrapper must map threadId/resourceId to memory options');
assert.ok(
  !indexSource.includes('requestContext.set(MASTRA_THREAD_ID_KEY, threadId)')
    && !indexSource.includes('requestContext.set(MASTRA_RESOURCE_ID_KEY, resourceId)'),
  'wrapper must not mint trusted pending-message authority from caller-controlled body fields',
);

if (/^(true|1|yes|on)$/i.test(process.env.RUN_AGENT_MEMORY_THREAD_LIVE ?? '')) {
  const baseUrl = (process.env.MASTRA_STUDIO_URL || 'http://localhost:4111').replace(/\/$/, '');
  const threadId = `memory-thread-check-${Date.now()}`;
  const resourceId = 'local-user';
  const response = await fetch(`${baseUrl}/deploy/automation-architect/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId,
      resourceId,
      maxSteps: 1,
      prompt: 'Reply with exactly: memory-thread-ok. Do not call tools.',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const json = await response.json().catch(() => ({}));
  assert.ok(response.ok, `live wrapper returned ${response.status}: ${JSON.stringify(json)}`);
  assert.equal(json.threadId, threadId, 'wrapper response should echo threadId');
  assert.equal(json.resourceId, resourceId, 'wrapper response should echo resourceId');
  assert.ok(!/ObservationalMemory requires threadId/i.test(JSON.stringify(json)), 'wrapper must not trigger missing threadId error');
  console.log('agent generate memory thread live check passed');
} else {
  console.log('agent generate memory thread static check passed');
  console.log('live check skipped (set RUN_AGENT_MEMORY_THREAD_LIVE=true)');
}
