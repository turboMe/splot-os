#!/usr/bin/env tsx
/**
 * A Menu Book cannot be declared finished while dishes have no recipe.
 *
 * Why this exists: `qa_final` and the "Phase-Exit Check" were only ever
 * sentences in `prompts/chef/pipeline.md`. Nothing enforced them, and the model
 * under V2 simply did not honour them — measured 2026-08-19, five of the ten
 * most recent `done` projects were incomplete, one carrying 63 dishes and zero
 * recipes. The rule now lives in `chef_set_project_status`.
 *
 * This gate drives the REAL tool against a REAL project and asserts the
 * OUTCOME (refused / allowed, and the DB status that resulted) rather than the
 * presence of a string in the source. A previous session shipped a gate that
 * asserted a string and declared a behavioural guarantee it never measured; the
 * string was there and the defect ran anyway.
 *
 * Needs Mongo. Creates one throwaway project and removes it in `finally`.
 * Run: npx tsx src/mastra/scripts/check-chef-completeness-gate.ts
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';

import { ChefService } from '../tools/chef/chef-service.js';
import { chefSetProjectStatusTool } from '../tools/chef/chef-tools.js';
import {
  chefDocumentInitTool,
  chefDocumentWriteSectionTool,
  bookPath,
} from '../tools/chef/chef-document-tools.js';

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

const call = (tool: unknown, input: Record<string, unknown>): Promise<any> =>
  (tool as any).execute(input);

/** Call the tool exactly the way the agent runtime does. */
async function setStatus(projectId: string, status: string): Promise<any> {
  return (chefSetProjectStatusTool as any).execute({ projectId, status });
}

async function main(): Promise<void> {
  console.log('check:chef-completeness-gate');

  const chef = new ChefService();
  const db = await (chef as any).getDb();
  let projectId: string | null = null;

  try {
    const { project } = await chef.createProject({
      name: '[gate] chef completeness — throwaway',
      establishmentType: 'bistro',
      createdBy: 'check:chef-completeness-gate',
    });
    projectId = project.id;

    await chef.saveMenu({
      projectId,
      version: 1,
      title: '[gate] menu',
      narrative: '',
      sections: [
        {
          name: 'Dania główne',
          dishes: [
            { name: 'Halibut z koprem', description: '', ingredients: [], techniques: [] },
            // Diacritics + mixed case + padding: the coverage match must be by
            // normalized name, or a present recipe reads as missing.
            { name: '  Jagnięcina  Z  Warzywami  ', description: '', ingredients: [], techniques: [] },
          ],
        },
      ],
    } as any);

    // ── One dish covered, one not → the gate must refuse ──
    await chef.saveRecipe({
      projectId,
      dishName: 'Halibut z koprem',
      yield: { amount: 4, unit: 'porcji' },
      components: [],
      serviceSteps: [],
    } as any);

    const refused = await setStatus(projectId, 'done');
    check('refuses done while a dish has no recipe', () => {
      assert.equal(refused.success, false, `expected refusal, got ${JSON.stringify(refused)}`);
    });
    check('names the dish that is actually missing', () => {
      assert.match(String(refused.error), /Jagnięcina/i);
    });
    check('does not name a dish that already has a recipe', () => {
      assert.doesNotMatch(String(refused.error), /Halibut/i);
    });
    const afterRefusal = await chef.getProject(projectId);
    check('project status is unchanged after a refusal', () => {
      assert.notEqual(afterRefusal?.status, 'done', 'status was written despite the refusal');
    });

    // ── A non-final transition is never gated ──
    const midway = await setStatus(projectId, 'recipes');
    check('a non-final transition still passes freely', () => {
      assert.equal(midway.success, true, JSON.stringify(midway));
    });

    // ── Cover the second dish → the gate must now allow ──
    await chef.saveRecipe({
      projectId,
      // Deliberately NOT byte-identical to the menu entry.
      dishName: 'Jagnięcina z warzywami',
      yield: { amount: 4, unit: 'porcji' },
      components: [],
      serviceSteps: [],
    } as any);

    // ── Mongo is now complete, but the DELIVERABLE is not ──
    // This is the live 2026-08-19 failure: every recipe stored, and a book whose
    // `recipes` section was never compiled. Coverage alone must not open `done`.
    const stillBlocked = await setStatus(projectId, 'done');
    check('refuses done while the Menu Book is unpublishable', () => {
      assert.equal(stillBlocked.success, false, `expected refusal, got ${JSON.stringify(stillBlocked)}`);
    });
    check('says what is wrong with the book', () => {
      assert.match(String(stillBlocked.error), /Menu Book is not publishable|empty section|no recipe cards/i);
    });

    // ── Fill the book, then it may close ──
    await call(chefDocumentInitTool, { projectId, title: '[gate] book' });
    for (const anchor of ['overview', 'profile', 'recon', 'menu', 'recipes', 'pairings', 'allergens', 'notes']) {
      const r = await call(chefDocumentWriteSectionTool, {
        projectId,
        anchor,
        content: `Treść sekcji ${anchor} wypełniona na potrzeby bramy.`,
        mode: 'replace',
      });
      assert.ok(r?.success, `write_section(${anchor}) failed: ${JSON.stringify(r)}`);
    }

    const allowed = await setStatus(projectId, 'done');
    check('allows done once dishes AND the book are complete', () => {
      assert.equal(allowed.success, true, `expected success, got ${JSON.stringify(allowed)}`);
    });
    const afterSuccess = await chef.getProject(projectId);
    check('the allowed transition really persisted', () => {
      assert.equal(afterSuccess?.status, 'done');
    });
  } finally {
    if (projectId) {
      await fs.rm(bookPath(projectId), { force: true });
      await db.collection('chef_projects').deleteMany({ id: projectId });
      await db.collection('chef_menus').deleteMany({ projectId });
      await db.collection('chef_recipes').deleteMany({ projectId });
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`❌ check:chef-completeness-gate — ${failures} failed`);
    process.exit(1);
  }
  console.log('✅ check:chef-completeness-gate — an incomplete Menu Book cannot be declared done');
  process.exit(0);
}

main().catch((err) => {
  console.error('check:chef-completeness-gate crashed:', err);
  process.exit(1);
});
