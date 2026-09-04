#!/usr/bin/env tsx
/**
 * check:orchestration-coverage — validate program-coverage-manifest/v1 and print
 * a machine-readable migration progress report (plan §14.3). In check:all.
 *
 * Errors (duplicate ids, a built contract without a test/gate/evidence, placeholder
 * evidence, missing Tier-2 activation metadata, migratedCount > expectedCount)
 * fail the gate; warns inform.
 */
import assert from 'node:assert/strict';
import {
  coverageManifestSchema, validateManifest, countByState, programCoverageManifest,
  loadToolSurfaces, validateToolSurfaces, summarizeToolSurfaces,
  type CoverageRecord,
} from '../orchestration/coverage/index.js';

function line(label: string, records: CoverageRecord[]): string {
  const c = countByState(records);
  const parts = (Object.entries(c) as [string, number][]).filter(([, n]) => n > 0).map(([s, n]) => `${s}=${n}`);
  return `  ${label.padEnd(10)} (${records.length}): ${parts.join('  ')}`;
}

console.log('check:orchestration-coverage');

const parsed = coverageManifestSchema.safeParse(programCoverageManifest);
if (!parsed.success) {
  console.error(`  ✗ schema invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  process.exit(1);
}
const m = parsed.data;

const issues = validateManifest(m);

// Negative guards: stale placeholders and missing Tier-2 activation metadata must
// fail locally instead of silently drifting from the plan.
const placeholderFixture = structuredClone(m);
placeholderFixture.contracts[0]!.evidenceIds = ['<pending>'];
assert.ok(
  validateManifest(placeholderFixture).some((i) => i.level === 'error' && i.message.includes('placeholder evidenceIds')),
  'placeholder evidence must fail validation',
);
const tier2Fixture = structuredClone(m);
const tier2 = tier2Fixture.contracts.find((c) => c.id === 'ORC-DISPATCH-EDGE-01')!;
delete tier2.firstConsumerCapability;
assert.ok(
  validateManifest(tier2Fixture).some((i) => i.level === 'error' && i.message.includes('firstConsumerCapability')),
  'Tier-2 activation metadata must fail closed',
);

// Tool surfaces (generated from baseline via `npm run import:baseline-tools`).
const tools = loadToolSurfaces();
const toolIssues = validateToolSurfaces(tools, 309);
const toolSummary = summarizeToolSurfaces(tools);
issues.push(...toolIssues);

const errors = issues.filter((i) => i.level === 'error');
const warns = issues.filter((i) => i.level === 'warn');

console.log('\n  Contracts / GAPs / Findings:');
console.log(line('contracts', m.contracts));
console.log(line('gaps', m.gaps));
console.log(line('failures', m.failures));

console.log('\n  Entity sets (migrated / expected):');
for (const s of m.entitySets) {
  const flag = s.migratedCount === 0 ? '·' : s.migratedCount === s.expectedCount ? '✓' : '~';
  console.log(`  ${flag} ${s.entityType.padEnd(26)} ${s.migratedCount}/${s.expectedCount}${s.ids.length && s.ids.length !== s.expectedCount ? `  (${s.ids.length} listed)` : ''}`);
}

console.log('\n  Tool surfaces (309 baseline, imported):');
console.log(`    disposition: ${Object.entries(toolSummary.byDisposition).map(([d, n]) => `${d}=${n}`).join('  ')}`);
console.log(`    category:    ${Object.entries(toolSummary.byCategory).map(([c, n]) => `${c}=${n}`).join('  ')}`);
console.log(`    destructive=${toolSummary.destructive}  acceptsAbortSignal=true: ${toolSummary.acceptsAbortTrue}/${tools.count}`);

if (warns.length) {
  console.log('\n  Warnings:');
  for (const w of warns) console.log(`  ⚠ ${w.message}`);
}

if (errors.length) {
  console.error('\n  Errors:');
  for (const e of errors) console.error(`  ✗ ${e.message}`);
  console.error(`\n❌ check:orchestration-coverage — ${errors.length} error(s)`);
  process.exit(1);
}

console.log('\n✅ check:orchestration-coverage — manifest valid');
process.exit(0);
