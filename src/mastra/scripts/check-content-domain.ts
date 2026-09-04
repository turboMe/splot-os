#!/usr/bin/env tsx
/**
 * The Content Pack must come out COMPLETE, and its structure must survive being
 * written to.
 *
 * Two live failures, both on real background runs:
 *
 *  1. A pack with `brief` and `strategy` filled and the other SIX sections left
 *     as `_(to be filled)_`. Not a bug in the tools — the pipeline's state 4 is a
 *     HARD CHECKPOINT that says "present this to the user and end the turn
 *     awaiting go-ahead". Headless there is nobody to answer, so the agent stops
 *     forever, after the thinking and before the work the domain exists for.
 *
 *  2. Once it did run to the end, the pack came out with TWO `image-briefs` and
 *     TWO `distribution` sections. The markers are the document's structure and
 *     `replaceSection` finds them with `indexOf` — the first occurrence — so a
 *     section body carrying a marker splices in a second boundary. The visible
 *     damage is worse than the mess: `content_doc_status` reads the FIRST
 *     `distribution`, the empty placeholder, and reports the section missing
 *     while 1436 chars of it sit further down the file.
 *
 * Run: npx tsx src/mastra/scripts/check-content-domain.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Statically imported, NOT `require` inside an async callback: `check` is sync,
// so a rejected promise would be swallowed and the test would print a green tick
// having asserted nothing. A vacuously passing test is worse than no test.
import { CANONICAL_SECTIONS } from '../tools/content/content-document-tools.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('check:content-domain');

const contentTools = readFileSync('src/mastra/tools/content/content-document-tools.ts', 'utf8');
const chefTools = readFileSync('src/mastra/tools/chef/chef-document-tools.ts', 'utf8');
const contentPipeline = readFileSync('src/mastra/prompts/content/pipeline.md', 'utf8');
const chefPipeline = readFileSync('src/mastra/prompts/chef/pipeline.md', 'utf8');

check('LIVE REGRESSION: a section body cannot smuggle in a second boundary', () => {
  assert.ok(Array.isArray(CANONICAL_SECTIONS) && CANONICAL_SECTIONS.length === 8,
    'the pack has eight canonical sections');
  // Both writers must strip markers out of content before writing it.
  for (const [label, source] of [['content', contentTools], ['chef', chefTools]] as const) {
    assert.match(source, /function stripSectionMarkers/, `${label} must strip section markers`);
    assert.match(
      source,
      /content = stripSectionMarkers\(content\)/,
      `${label} must apply the strip INSIDE replaceSection, so every path is covered`,
    );
  }
});

check('the stripper removes markers and keeps the writing', () => {
  // Rebuilt from the corrupted pack: the body carried a foreign end marker.
  const source = contentTools;
  const body = /function stripSectionMarkers\(content: string\): string \{\s*return content\.replace\(([\s\S]*?)\);/
    .exec(source)?.[1] ?? '';
  const pattern = /\/(.+)\/([gimsuy]*)/.exec(body.split(',')[0] ?? '');
  assert.ok(pattern, 'the strip must be a regex replace');
  const re = new RegExp(pattern[1]!, pattern[2]!);
  const dirty = 'Technical notes here\n<!-- section:tiktok end -->\n\n## Image Briefs';
  const cleaned = dirty.replace(re, '');
  assert.ok(!/<!--\s*section:/.test(cleaned), `markers must be gone, got: ${cleaned}`);
  assert.match(cleaned, /Technical notes here/, 'the real content must survive');
  assert.match(cleaned, /## Image Briefs/, 'ordinary markdown is untouched');
});

check('LIVE REGRESSION: the hard checkpoints do not strand a background run', () => {
  // A checkpoint that waits for approval nobody can give is a permanent stop.
  assert.match(contentPipeline, /Background runs/i,
    'content/pipeline.md must say what the checkpoints mean headless');
  assert.match(contentPipeline, /checkpoint_strategy/,
    'and name the one that must NOT stop');
  assert.match(chefPipeline, /Background runs/i,
    'chef/pipeline.md must too — it has the same collision');
  assert.match(chefPipeline, /checkpoint_profile/, 'naming its own checkpoints');
});

check('the checkpoint that guards an EFFECT still stops', () => {
  // `ship` saves drafts and creates calendar reminders — real effects outside the
  // document. Removing every checkpoint would trade one failure for a worse one.
  const section = contentPipeline.slice(contentPipeline.indexOf('Background runs'));
  assert.match(section, /checkpoint_review/, 'the shipping checkpoint must be addressed');
  assert.match(
    section,
    /DO STOP|stop, deliver|leave `ship` undone/i,
    'and it must still stop the run rather than ship unattended',
  );
});

if (failures > 0) {
  console.error(`\n❌ check:content-domain — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:content-domain — the pack comes out whole, and writing it cannot corrupt it');
process.exit(0);
