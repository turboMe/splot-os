#!/usr/bin/env tsx
/**
 * import-baseline-tools — generate the tool-surface coverage records from the
 * baseline package (plan §14.1). Reads the 309-record tool inventory and writes
 * a compact coverage file that the coverage manifest tracks toward migration.
 *
 *   npm run import:baseline-tools
 *
 * effectClass is intentionally NOT guessed in bulk — it is assigned per tool at
 * migration time (§14.1); we carry the raw signals (category, destructive,
 * abort-signal support) and a `disposition` that starts at `planned`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(here, '../../../ideas/meta-agent-orchestration-baseline-results/67e6eed4-f256-47d2-8017-899eaf9e5edf/tool-inventory.json');
const OUT = resolve(here, '../orchestration/coverage/tool-surfaces.json');

interface BaselineTool {
  toolId: string;
  category: string;
  expectedDurationClass: string;
  destructive: boolean;
  acceptsAbortSignal: boolean | null;
  forwardsAbortSignal: boolean | null;
  implementationFile: string;
  usedByAgents?: string[];
}

interface ToolSurfaceRecord {
  toolId: string;
  category: string;
  durationClass: string;
  destructive: boolean;
  acceptsAbortSignal: boolean | null;
  forwardsAbortSignal: boolean | null;
  implementationFile: string;
  usedByAgentCount: number;
  effectClass: string | null;   // assigned per-tool at migration time
  disposition: 'planned' | 'migrated' | 'retired' | 'quarantined';
  wave: string | null;
}

function main(): void {
  const inv = JSON.parse(readFileSync(BASELINE, 'utf8')) as BaselineTool[];
  if (!Array.isArray(inv)) throw new Error('tool-inventory.json is not an array');

  const seen = new Set<string>();
  const records: ToolSurfaceRecord[] = inv.map((t) => {
    if (seen.has(t.toolId)) throw new Error(`duplicate toolId in baseline: ${t.toolId}`);
    seen.add(t.toolId);
    return {
      toolId: t.toolId,
      category: t.category,
      durationClass: t.expectedDurationClass,
      destructive: !!t.destructive,
      acceptsAbortSignal: t.acceptsAbortSignal ?? null,
      forwardsAbortSignal: t.forwardsAbortSignal ?? null,
      implementationFile: t.implementationFile,
      usedByAgentCount: Array.isArray(t.usedByAgents) ? t.usedByAgents.length : 0,
      effectClass: null,
      disposition: 'planned',
      wave: null,
    };
  });

  records.sort((a, b) => a.toolId.localeCompare(b.toolId));
  const doc = { schemaVersion: 'tool-surfaces/v1', source: '67e6eed4-f256-47d2-8017-899eaf9e5edf', count: records.length, records };
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);

  // quick summary
  const byCat: Record<string, number> = {};
  let destructiveN = 0, acceptsAbort = 0;
  for (const r of records) {
    byCat[r.category] = (byCat[r.category] ?? 0) + 1;
    if (r.destructive) destructiveN++;
    if (r.acceptsAbortSignal === true) acceptsAbort++;
  }
  console.log(`import:baseline-tools → ${records.length} tool surfaces → ${OUT.replace(process.cwd() + '/', '')}`);
  console.log(`  categories: ${Object.entries(byCat).map(([c, n]) => `${c}=${n}`).join('  ')}`);
  console.log(`  destructive=${destructiveN}  acceptsAbortSignal=true: ${acceptsAbort}/${records.length}`);
}

main();
