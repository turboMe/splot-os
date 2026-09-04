#!/usr/bin/env tsx
/**
 * A checkpoint that waits for a human must say what it does when there is none.
 *
 * Domain pipelines are written for a supervised session, where "present this and
 * end the turn awaiting go-ahead" is exactly right. Run in the background, the
 * same sentence means **stop forever** — and it stops after the thinking, before
 * the work the domain exists to do.
 *
 * This is invisible to every other test, because it is not a code defect. It cost
 * us two agents before anyone read a document rather than a status:
 *
 *  - `contentAgent` delivered a Content Pack with TWO of eight sections filled,
 *    stranded at `checkpoint_strategy`;
 *  - `chefAgent` committed "Projekt utworzony. Uzupełniam profil…" as COMPLETED,
 *    stranded at `checkpoint_profile`.
 *
 * So: any pipeline that can stop for a human must also state what happens when
 * nobody is watching. The gate does not dictate the answer — some checkpoints
 * SHOULD still stop, because they guard effects outside the document (`ship`
 * saves drafts and creates calendar reminders). It only requires that the
 * question be answered somewhere the agent will read.
 *
 * Run: npx tsx src/mastra/scripts/check-headless-checkpoints.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const PROMPTS = 'src/mastra/prompts';

/** Wording that halts a turn to wait for a person. */
const WAITS_FOR_HUMAN = /HARD CHECKPOINT|HUMAN GATE|await approval|await go-ahead|end the turn and await|awaiting go-ahead|Await approval/i;

/**
 * Wording that tells the agent what to do with no human present.
 *
 * Matched loosely on purpose: this gate should push authors to answer the
 * question, not to phrase it a particular way.
 */
const ANSWERS_HEADLESS = /^##+ .*(background run|headless|w tle)/im;

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

console.log('check:headless-checkpoints');

const domains = readdirSync(PROMPTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(`${PROMPTS}/${name}/pipeline.md`))
  .sort();

assert.ok(domains.length > 0, 'no domain pipelines found — the gate would pass vacuously');

for (const domain of domains) {
  const source = readFileSync(`${PROMPTS}/${domain}/pipeline.md`, 'utf8');
  const waits = WAITS_FOR_HUMAN.test(source);
  const answers = ANSWERS_HEADLESS.test(source);

  if (!waits) {
    console.log(`  · ${domain} — no human checkpoint, nothing to answer`);
    continue;
  }
  check(`${domain} says what its checkpoint means with nobody watching`, () => {
    assert.ok(
      answers,
      `${PROMPTS}/${domain}/pipeline.md stops for a human but never says what a background run should do. `
      + 'Add a "## Background runs" section stating, per checkpoint, whether it proceeds (and records its '
      + 'assumptions) or still stops (and delivers what it has). A checkpoint that guards an effect OUTSIDE '
      + 'the document — shipping, sending, publishing — should still stop.',
    );
  });
}

if (failures > 0) {
  console.error(`\n❌ check:headless-checkpoints — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:headless-checkpoints — every human gate says what it does when nobody is there');
process.exit(0);
