#!/usr/bin/env tsx
/**
 * Test: Validates Splot OS Voice Transcription handler with Google Gemini (gemini-2.5-flash)
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import { handleSplotVoiceTranscribe } from '../services/splot-router.js';

// Helper to create valid PCM WAV header & audio buffer
function createSilentWavBuffer(sampleRate = 16000, durationSec = 0.5): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

// Mock Hono/Mastra context
function createMockContext(body: any) {
  return {
    req: {
      json: async () => body,
    },
    json: (data: any, status = 200) => ({
      status,
      data,
      async json() {
        return data;
      },
    }),
  };
}

async function runTests() {
  console.log('[CheckSplotVoiceTranscribe] Starting Google Gemini Voice Transcription tests...');

  // 1. Validate API Key presence
  const apiKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim();

  assert.ok(apiKey, 'Google API key must be present in environment (GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY)');
  console.log('✅ 1. Google API key detected in environment');

  // 2. Validate missing payload validation (400 Bad Request)
  const emptyCtx = createMockContext({});
  const emptyRes: any = await handleSplotVoiceTranscribe(emptyCtx);
  assert.equal(emptyRes.status, 400, 'Empty payload should return 400 status');
  assert.equal(emptyRes.data.success, false, 'Empty payload should return success: false');
  console.log('✅ 2. Empty payload correctly rejected with 400 Bad Request');

  // 3. Test real Gemini transcription call with audio WAV payload
  const wavBuf = createSilentWavBuffer(16000, 0.6);
  const base64Audio = wavBuf.toString('base64');

  const validCtx = createMockContext({
    audioBase64: `data:audio/wav;base64,${base64Audio}`,
    mimeType: 'audio/wav',
  });

  const validRes: any = await handleSplotVoiceTranscribe(validCtx);
  assert.equal(validRes.status, 200, `Valid payload should return 200 status (got ${validRes.status}: ${JSON.stringify(validRes.data)})`);
  assert.equal(validRes.data.success, true, 'Transcription should return success: true');
  assert.equal(typeof validRes.data.text, 'string', 'Transcription should return text string');
  assert.equal(validRes.data.model, 'gemini-2.5-flash', 'Transcription should report gemini-2.5-flash model');
  assert.ok(typeof validRes.data.durationMs === 'number' && validRes.data.durationMs > 0, 'Duration should be a positive number');

  console.log(`✅ 3. Gemini 2.5 Flash transcription executed in ${validRes.data.durationMs}ms (Response text: "${validRes.data.text}")`);

  console.log('🎉 All Splot OS Voice Transcription tests passed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
