#!/usr/bin/env tsx
/**
 * check:meta-prompt-size — Etap 2 (IDEALSYSTEMMASTERPLAN).
 *
 * Guards the Etap 2 token win against regrowth. Baseline (E0, 2026-07-20):
 *   - prompts/meta/base.md            : 35,568 chars (hand-kept roster inside)
 *   - delegate-task tool description  :  5,944 chars
 *   → combined static burden ≈ 41.5k chars ≈ 10.4k tokens EVERY meta turn.
 *
 * After E2 (roster generated from Agent Board, description slimmed):
 *   - loaded meta/base (include resolved) ≈ 29k chars
 *   - delegate-task description           ≈ 1.1k chars
 *
 * Limits below allow ~10% headroom over the post-E2 state. If this check
 * fails, content crept back into the prompt — move it into Agent Board cards
 * (agent_board_get serves it on demand) instead of raising the limit.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPrompt } from '../lib/prompt-loader.js';

const MAX_LOADED_BASE_CHARS = 33_000;
const MAX_DELEGATE_DESC_CHARS = 2_000;
const E0_BASELINE_COMBINED = 41_512;

async function main() {
  console.log('check:meta-prompt-size');

  const loadedBase = await loadPrompt('meta/base');
  const delegateSource = readFileSync('src/mastra/tools/system/delegate-task.ts', 'utf8');
  const desc = delegateSource.match(/description: `([\s\S]*?)`,\n  inputSchema/)?.[1] ?? '';
  assert.ok(desc.length > 0, 'could not extract delegate-task description');

  const combined = loadedBase.length + desc.length;
  const reduction = 1 - combined / E0_BASELINE_COMBINED;

  console.log(`  loaded meta/base: ${loadedBase.length} chars (limit ${MAX_LOADED_BASE_CHARS})`);
  console.log(`  delegate-task description: ${desc.length} chars (limit ${MAX_DELEGATE_DESC_CHARS})`);
  console.log(`  combined: ${combined} chars vs E0 baseline ${E0_BASELINE_COMBINED} → −${(reduction * 100).toFixed(1)}%`);

  assert.ok(loadedBase.length <= MAX_LOADED_BASE_CHARS,
    `meta/base grew past ${MAX_LOADED_BASE_CHARS} chars — move content into Agent Board cards, don't raise the limit`);
  assert.ok(desc.length <= MAX_DELEGATE_DESC_CHARS,
    `delegate-task description grew past ${MAX_DELEGATE_DESC_CHARS} chars — roster belongs on the Agent Board`);
  assert.ok(reduction >= 0.25,
    `combined static prompt burden must stay ≥25% below E0 baseline (currently −${(reduction * 100).toFixed(1)}%)`);

  console.log('\n✅ check:meta-prompt-size — within limits');
  process.exit(0);
}

main().catch((err) => { console.error('❌ check:meta-prompt-size failed:', (err as Error).message); process.exit(1); });
