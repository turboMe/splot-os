#!/usr/bin/env tsx
/**
 * Test: Validates real-time Server-Sent Events (SSE) streaming on POST /splot/api/chat
 */

import assert from 'node:assert/strict';

const BASE_URL = process.env.MASTRA_SERVER_URL || 'http://localhost:4111';

async function main() {
  console.log(`[CheckSplotStreaming] Testing POST /splot/api/chat with SSE on ${BASE_URL}...`);

  const testThreadId = `test_stream_${Date.now()}`;
  const prompt = 'Podaj jedną krótką poradę dla programisty w jednym zdaniu.';

  const startTime = Date.now();
  const res = await fetch(`${BASE_URL}/splot/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      agentId: 'crmAgent',
      threadId: testThreadId,
      message: prompt,
      resourceId: 'crmAgent',
    }),
  });

  assert.equal(res.status, 200, `POST /splot/api/chat returned status ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  assert.ok(contentType.includes('text/event-stream'), `Expected text/event-stream, got ${contentType}`);

  console.log('✅ 1. Connected to SSE stream with status 200 and Content-Type: text/event-stream');

  const reader = res.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const eventsReceived: string[] = [];
  let firstEventTime: number | null = null;
  let finalPayload: any = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    if (firstEventTime === null) {
      firstEventTime = Date.now() - startTime;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const block of parts) {
      if (!block.trim()) continue;

      let eventName = 'message';
      let dataStr = '';

      const lines = block.split('\n');
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          dataStr += line.substring(5).trim();
        }
      }

      if (dataStr) {
        eventsReceived.push(eventName);
        try {
          const parsed = JSON.parse(dataStr);
          if (eventName === 'finish') {
            finalPayload = parsed;
          }
          if (eventName === 'error') {
            console.error('⚠️ Received error event from server:', parsed);
          }
        } catch {}
      }
    }
  }

  console.log(`✅ 2. Time to first SSE chunk: ${firstEventTime}ms`);
  console.log(`✅ 3. Events received in sequence: ${eventsReceived.join(' -> ')}`);
  
  assert.ok(eventsReceived.includes('init'), 'Stream must emit "init" event');
  assert.ok(eventsReceived.includes('finish'), 'Stream must emit "finish" event');
  assert.ok(finalPayload && finalPayload.success, 'Finish event must contain successful payload');
  assert.ok(finalPayload.text && finalPayload.text.length > 0, 'Finish event must return agent response text');

  console.log(`✅ 4. Agent response received: "${finalPayload.text.trim().substring(0, 60)}..."`);
  console.log('\n🎉 ALL SSE STREAMING TESTS PASSED!');
}

main().catch((err) => {
  console.error('❌ Check failed:', err);
  process.exit(1);
});
