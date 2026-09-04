/**
 * `program-coverage-manifest/v1` schema + validator (plan §14.3).
 *
 * Machine-readable source of truth for migration coverage: every architecture
 * contract, feasibility gap and baseline finding, plus the entity sets (agents,
 * tools, …) with their expected counts. The validator enforces structural
 * integrity so "what is built / what remains" is checkable, not just prose (§33).
 */
import { z } from 'zod';

export const IMPLEMENTATION_STATES = [
  'planned', 'implemented', 'verified', 'canary', 'production', 'deferred', 'not_applicable',
] as const;
export type ImplementationState = (typeof IMPLEMENTATION_STATES)[number];

export const coverageRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  implementationState: z.enum(IMPLEMENTATION_STATES),
  wave: z.string().optional(),
  /** Tier-2 gate activation metadata required by plan §15.7.1. */
  firstConsumerCapability: z.string().min(1).optional(),
  activatingWave: z.string().min(1).optional(),
  gateIds: z.array(z.string()).default([]),
  testCaseIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type CoverageRecord = z.infer<typeof coverageRecordSchema>;

export const entitySetSchema = z.object({
  entityType: z.string().min(1),
  expectedCount: z.number().int().nonnegative(),
  migratedCount: z.number().int().nonnegative().default(0),
  ids: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type EntitySet = z.infer<typeof entitySetSchema>;

export const coverageManifestSchema = z.object({
  schemaVersion: z.literal('program-coverage-manifest/v1'),
  generatedAt: z.string().datetime(),
  contracts: z.array(coverageRecordSchema),
  gaps: z.array(coverageRecordSchema),
  failures: z.array(coverageRecordSchema),
  entitySets: z.array(entitySetSchema),
});
export type CoverageManifest = z.infer<typeof coverageManifestSchema>;
/** Authoring type — schema defaults (gateIds/testCaseIds/…) are optional on input. */
export type CoverageManifestInput = z.input<typeof coverageManifestSchema>;

export interface ValidationIssue { level: 'error' | 'warn'; message: string }

/** Structural validation beyond the schema. Errors fail the gate; warns inform. */
export function validateManifest(m: CoverageManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allRecords = [...m.contracts, ...m.gaps, ...m.failures];
  const tier2Contracts = new Set([
    'ORC-DISPATCH-EDGE-01',
    'ORC-ATTACHED-01',
    'ORC-SPECULATION-01',
  ]);

  const dupCheck = (records: CoverageRecord[], label: string) => {
    const seen = new Set<string>();
    for (const r of records) {
      if (seen.has(r.id)) issues.push({ level: 'error', message: `duplicate ${label} id: ${r.id}` });
      seen.add(r.id);
    }
  };
  dupCheck(m.contracts, 'contract');
  dupCheck(m.gaps, 'gap');
  dupCheck(m.failures, 'failure');

  // A built contract must be backed by a test and a gate.
  for (const c of m.contracts) {
    if ((c.implementationState === 'implemented' || c.implementationState === 'verified')) {
      if (c.testCaseIds.length === 0) issues.push({ level: 'error', message: `contract ${c.id} is ${c.implementationState} but has no testCaseIds` });
      if (c.gateIds.length === 0) issues.push({ level: 'error', message: `contract ${c.id} is ${c.implementationState} but has no gateIds` });
      if (c.evidenceIds.length === 0) issues.push({ level: 'error', message: `contract ${c.id} is ${c.implementationState} but has no evidenceIds` });
    }
    if (tier2Contracts.has(c.id)) {
      if (!c.firstConsumerCapability || !c.activatingWave) {
        issues.push({ level: 'error', message: `Tier-2 contract ${c.id} must declare firstConsumerCapability and activatingWave` });
      }
    }
  }

  // Placeholder evidence is not evidence. This catches stale `<pending>` entries
  // instead of allowing the prose log and machine-readable manifest to diverge.
  for (const r of allRecords) {
    if (r.evidenceIds.some((id) => /^<[^>]+>$/.test(id.trim()))) {
      issues.push({ level: 'error', message: `${r.id} contains placeholder evidenceIds` });
    }
  }

  // A verified gap must carry evidence.
  for (const g of m.gaps) {
    if (g.implementationState === 'verified' && g.evidenceIds.length === 0) {
      issues.push({ level: 'error', message: `gap ${g.id} is verified but has no evidenceIds` });
    }
  }

  // Entity-set completeness is a warning until baseline import is done.
  for (const s of m.entitySets) {
    if (s.ids.length > 0 && s.ids.length !== s.expectedCount) {
      issues.push({ level: 'warn', message: `${s.entityType}: ${s.ids.length} ids listed vs expectedCount ${s.expectedCount}` });
    }
    if (s.migratedCount > s.expectedCount) {
      issues.push({ level: 'error', message: `${s.entityType}: migratedCount ${s.migratedCount} > expectedCount ${s.expectedCount}` });
    }
  }

  return issues;
}

export function countByState(records: CoverageRecord[]): Record<ImplementationState, number> {
  const out = Object.fromEntries(IMPLEMENTATION_STATES.map((s) => [s, 0])) as Record<ImplementationState, number>;
  for (const r of records) out[r.implementationState]++;
  return out;
}
