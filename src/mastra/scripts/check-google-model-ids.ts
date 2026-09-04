#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import { models, resolveModelId, type ModelKey } from '../config/model-manifest.js';
import { getModelPricing } from '../lib/model-pricing.js';

const stableModels = {
  'gemini-3.7-flash': 'google/gemini-3.7-flash',
  'gemini-3.6-flash': 'google/gemini-3.6-flash',
  'gemini-3.5-flash': 'google/gemini-3.5-flash',
  'gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
} as const satisfies Partial<Record<ModelKey, string>>;

for (const [alias, expectedId] of Object.entries(stableModels)) {
  assert.equal(resolveModelId(alias as keyof typeof stableModels), expectedId);
  assert.ok(!expectedId.endsWith('-preview'), `${alias} must use the stable GA endpoint`);
  assert.equal(getModelPricing(expectedId).provider, 'google');
}

assert.equal(models['gemini-flash-latest'], 'google/gemini-flash-latest');
assert.equal(models['gemini-flash-lite-latest'], 'google/gemini-flash-lite-latest');

assert.deepEqual(getModelPricing(models['gemini-3.7-flash']), {
  inputPer1M: 0.75,
  outputPer1M: 3.75,
  provider: 'google',
});
assert.deepEqual(getModelPricing(models['gemini-3.5-flash-lite']), {
  inputPer1M: 0.3,
  outputPer1M: 2.5,
  provider: 'google',
});

console.log('✅ Google Gemini 3.7/3.6/3.5 manifest IDs and pricing are valid');
