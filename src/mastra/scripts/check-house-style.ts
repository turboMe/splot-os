#!/usr/bin/env tsx
/**
 * One house style, reaching every agent — not eleven copies and one omission.
 *
 * The em-dash ban existed before this: stated three times inside `writerAgent`'s
 * own prompts, and nowhere else. So `writerAgent` failed its own run over a
 * U+2014 while `huntAgent` put one in the subject line of an email that landed in
 * the owner's inbox. That is how a universal rule becomes a rule about one agent
 * — not by decision, but by nobody adding it to the next prompt.
 *
 * The rule now lives in `prompts/shared/house-style.md` and the LOADER appends it,
 * which is the only point every prompt-driven agent passes through on both
 * engines. This gate asserts the consequence rather than the mechanism: the text
 * is IN the instructions an agent actually receives.
 *
 * Run: npx tsx src/mastra/scripts/check-house-style.ts
 */
import assert from 'node:assert/strict';

import { loadPrompt, combinePrompts } from '../lib/prompt-loader.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('check:house-style');

/** Whatever wording the rule uses, these must be true of it. */
function assertCarriesRule(text: string, where: string): void {
  assert.match(text, /U\+2014/, `${where}: the rule must name the codepoint, not just show the glyph`);
  assert.match(text, /&mdash;/, `${where}: the HTML entity is the same character by another spelling`);
}

await check('a single-prompt agent receives the rule', async () => {
  const marketing = await loadPrompt('marketing/base');
  assertCarriesRule(marketing, 'marketing/base');
});

await check('a COMBINED-prompt agent receives it too, exactly once', async () => {
  // huntAgent — the one that put an em-dash in a real subject line. Two prompts
  // joined; the rule must arrive, and must not arrive twice.
  const hunt = await combinePrompts('hunt/domain', 'hunt/pipeline');
  assertCarriesRule(hunt, 'hunt');
  const occurrences = (hunt.match(/## Styl treści/g) ?? []).length;
  assert.equal(occurrences, 1, `the block must appear once, found ${occurrences}`);
});

await check('every prompt-driven agent instruction carries it', async () => {
  // The list is the point: a rule that reaches ten of eleven agents is the exact
  // state this gate exists to prevent from recurring.
  const instructionPrompts = [
    'marketing/base', 'sales/base', 'meta/base', 'meta-front/base',
    'analytics/base', 'automation/base', 'coding/base', 'capability/base',
    'deliberation/base', 'crm/pipeline', 'knowledge/notebooklm-agent',
    'lane-orchestrator/base',
  ];
  const missing: string[] = [];
  for (const path of instructionPrompts) {
    const text = await loadPrompt(path);
    if (!/U\+2014/.test(text)) missing.push(path);
  }
  assert.deepEqual(missing, [], `prompts reaching an agent without the house style: ${missing.join(', ')}`);
});

await check('fragments do NOT carry it — they are pulled into prompts that do', async () => {
  // Otherwise the rule is repeated inside the file that already states it.
  const fragment = await loadPrompt('shared/subagent-researcher');
  assert.ok(!/## Styl treści/.test(fragment),
    'a shared fragment must stay a fragment, or the rule multiplies inside one prompt');
});

await check('the rule states what to use INSTEAD', async () => {
  // A ban with no replacement gets worked around rather than followed — the model
  // needs the alternative in the same breath.
  const style = await loadPrompt('marketing/base');
  assert.match(style, /przecinek|dwukropek/,
    'the alternatives must travel with the prohibition');
});

console.log(failures === 0 ? '\nOK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
