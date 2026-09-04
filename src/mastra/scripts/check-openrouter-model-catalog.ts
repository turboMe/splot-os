#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import { models, resolveModelId } from '../config/model-manifest.js';
import {
  filterFreeOpenRouterModels,
  isFreeOpenRouterModel,
  toMastraOpenRouterModelId,
  type OpenRouterCatalogModel,
} from '../lib/openrouter-model-catalog.js';

const fixture: OpenRouterCatalogModel[] = [
  {
    id: 'openrouter/free',
    pricing: { prompt: '0', completion: '0' },
    context_length: 200_000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'structured_outputs'],
  },
  {
    // Promotional zero-price model intentionally has no :free suffix.
    id: 'stealth/ox-alpha',
    pricing: { prompt: 0, completion: 0 },
    context_length: 128_000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['tools'],
  },
  {
    id: 'vendor/misleading:free',
    pricing: { prompt: '0', completion: '0.1' },
    context_length: 128_000,
  },
  {
    id: 'vendor/expired-promo',
    pricing: { prompt: '0.0', completion: '0e0' },
    expiration_date: '2026-01-01T00:00:00Z',
    context_length: 128_000,
  },
];

assert.equal(isFreeOpenRouterModel(fixture[0]!), true);
assert.equal(isFreeOpenRouterModel(fixture[1]!), true, 'zero price must work without :free');
assert.equal(isFreeOpenRouterModel(fixture[2]!), false, 'suffix must not override non-zero pricing');

const free = filterFreeOpenRouterModels(fixture, { now: new Date('2026-08-21T00:00:00Z') });
assert.deepEqual(free.map((model) => model.id), ['openrouter/free', 'stealth/ox-alpha']);

const toolAndVision = filterFreeOpenRouterModels(fixture, {
  requiredParameters: ['tools', 'structured_outputs'],
  inputModalities: ['image'],
  minContextLength: 150_000,
  now: new Date('2026-08-21T00:00:00Z'),
});
assert.deepEqual(toolAndVision.map((model) => model.id), ['openrouter/free']);

assert.equal(toMastraOpenRouterModelId('stealth/ox-alpha'), 'openrouter/stealth/ox-alpha');
assert.equal(resolveModelId('openrouter-free-auto'), 'openrouter/openrouter/free');
assert.equal(models['or-gemini-3.7-flash'], 'openrouter/google/gemini-3.7-flash');
assert.equal(models['or-claude-sonnet-5'], 'openrouter/anthropic/claude-sonnet-5');
assert.equal(models['or-claude-opus-5'], 'openrouter/anthropic/claude-opus-5');

console.log('✅ OpenRouter manifest aliases and zero-price catalogue filtering are valid');
