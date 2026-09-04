#!/usr/bin/env tsx
/**
 * Nightly skill cycle + weekly curator (Etap 6, IDEALSYSTEMMASTERPLAN §5).
 *
 * Run from cron-runner (03:00 distillation, Sunday 04:00 curation) or manually:
 *   npm run skill:nightly     # distill pending candidates on the manifest model
 *   npm run skill:curator     # stale/archive/repair pass
 *
 * Distillation runs on infrastructure.skillDistiller from model-manifest.ts.
 * The morning report is written to the Task Ledger as an ephemeral lane.
 */
import 'dotenv/config';
import { Agent } from '@mastra/core/agent';
import { infrastructure, resolveModelId } from '../config/model-manifest.js';
import { ensureDefaultGateways } from '../lib/gateway-registry.js';
import { getSkillRegistry } from '../services/skill-registry.js';
import { runDistillationCycle, isDistillationEnabled } from '../services/skill-distiller.js';
import { runCurator, listOpenRepairTasks } from '../services/skill-stats.js';
import { ledgerRecordEphemeral } from '../services/task-ledger.js';

ensureDefaultGateways();

const SKILLS_DIR = process.env.MASTRA_SKILLS_DIR
  ? process.env.MASTRA_SKILLS_DIR
  : new URL('../_skills', import.meta.url).pathname;

/** Build a text-generate function backed by the manifest's distillation model
 *  (infrastructure.skillDistiller — change it there to swap the nightly model). */
export function buildLocalGenerate(): (prompt: string) => Promise<string> {
  const modelId = resolveModelId(infrastructure.skillDistiller);
  return async (prompt: string) => {
    const agent = new Agent({
      id: `skill-distiller-${Date.now()}`,
      name: 'Skill Distiller',
      instructions: 'You distill successful task trajectories into reusable skills. Output STRICT JSON only.',
      model: modelId,
    });
    const result = await agent.generate(prompt);
    return (result.text ?? '').trim();
  };
}

export async function runNightlySkillCycle(): Promise<void> {
  if (!isDistillationEnabled()) {
    console.log('[skill-nightly] disabled (FEATURE_SKILL_DISTILLATION=false)');
    return;
  }
  console.log('[skill-nightly] 🌙 distilling pending candidates on local model');
  const result = await runDistillationCycle(buildLocalGenerate(), { limit: 30 });
  console.log(`[skill-nightly] processed=${result.processed} activated=${result.activated} quarantined=${result.quarantined}`);

  // Refresh registry so freshly-activated skills become searchable.
  await getSkillRegistry().initialize(SKILLS_DIR).catch(() => undefined);

  await ledgerRecordEphemeral({
    source: 'cron',
    sourceId: `skill-nightly-${Date.now()}`,
    goal: 'nightly skill distillation',
    outcome: 'done',
    milestone: `distilled ${result.activated} skill(s), ${result.quarantined} quarantined (of ${result.processed} candidates): ${result.skills.join(', ') || 'none'}`,
  });
}

export async function runWeeklyCurator(): Promise<void> {
  console.log('[skill-curator] 🧹 weekly curation pass');
  await getSkillRegistry().initialize(SKILLS_DIR).catch(() => undefined);
  const registry = getSkillRegistry();
  const report = await runCurator({ skillFilePathResolver: (name) => registry.filePath(name) });
  const repairs = await listOpenRepairTasks();
  console.log(`[skill-curator] stale=${report.markedStale.length} archived=${report.archived.length} repairs=${report.repairQueued.length}`);

  await ledgerRecordEphemeral({
    source: 'cron',
    sourceId: `skill-curator-${Date.now()}`,
    goal: 'weekly skill curation',
    outcome: 'done',
    milestone: `stale=${report.markedStale.length} archived=${report.archived.length} repair-queued=${report.repairQueued.length} (open repairs: ${repairs.length})`,
  });
}

// CLI entry
const mode = process.argv[2];
const isMain = process.argv[1]?.endsWith('skill-nightly-cycle.ts');
if (isMain) {
  const run = mode === 'curator' ? runWeeklyCurator() : runNightlySkillCycle();
  run.then(() => process.exit(0)).catch((err) => {
    console.error('[skill-nightly] failed:', err);
    process.exit(1);
  });
}
