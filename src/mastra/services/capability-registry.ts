/**
 * Capability Registry — the system's record of external capabilities it has
 * discovered, trialed, and attached (Etap 7, IDEALSYSTEMMASTERPLAN §4 — CGP).
 *
 * Lifecycle of a capability (MCP server):
 *   discovered → sandboxed → awaiting_approval → attached
 *                    ↘ quarantined (failed trial)      ↘ rejected (human said no)
 *
 * HARD RULE: secret VALUES are NEVER stored here. The registry records only the
 * NAMES of env vars a capability needs (with isSecret flags from the MCP
 * Registry entry). Real values live in .env under those documented names and
 * are injected only at attach time — after human approval.
 */

import { randomUUID } from 'crypto';
import { getDb } from '../lib/mongo.js';

export type CapabilityStatus =
  | 'discovered'
  | 'sandboxed'
  | 'awaiting_approval'
  | 'attached'
  // BUILD path (E7-BUILD): we wrote the tool ourselves, so there is nothing to
  // sandbox or approve for attachment — the code passed tsc + check:all and was
  // merged. 'built' is terminal until a human promotes it onto the live process.
  | 'built'
  | 'rejected'
  | 'quarantined';

export type CapabilityEnvVar = {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
};

export type CapabilityPackage = {
  registryType: string;          // npm | pypi | oci …
  identifier: string;            // package name
  version?: string;
  runtimeHint?: string;          // npx | uvx | docker …
  runtimeArguments?: string[];
  envVars: CapabilityEnvVar[];
  transport?: string;            // stdio | streamable-http
};

export type CapabilityRemote = {
  type: string;                  // streamable-http | sse
  url: string;
  headers?: CapabilityEnvVar[];  // header names (values may be secret)
};

export type SandboxReport = {
  ok: boolean;
  toolCount?: number;
  toolNames?: string[];
  durationMs: number;
  error?: string;
  at: Date;
};

export type CapabilityRecord = {
  capabilityId: string;
  /** Registry name, e.g. "io.github.someone/weather" */
  registryName: string;
  description: string;
  source: 'mcp-registry' | 'manual';
  version?: string;
  repositoryUrl?: string;
  package?: CapabilityPackage;
  remotes?: CapabilityRemote[];
  status: CapabilityStatus;
  /** Autonomy tier — E10 will add promotion; every new capability starts shadow. */
  tier: 'shadow' | 'propose' | 'auto';
  gapDescription?: string;       // the capability gap this was discovered for
  sandboxReport?: SandboxReport;
  approvalId?: string;
  attachedAt?: Date;
  statusHistory: Array<{ at: Date; from: CapabilityStatus | null; to: CapabilityStatus; note?: string }>;
  createdAt: Date;
  updatedAt: Date;
};

const COLLECTION = 'capabilities';

const VALID_TRANSITIONS: Record<CapabilityStatus, CapabilityStatus[]> = {
  discovered: ['sandboxed', 'built', 'quarantined', 'rejected'],
  sandboxed: ['awaiting_approval', 'quarantined', 'rejected'],
  awaiting_approval: ['attached', 'rejected'],
  attached: ['rejected', 'quarantined'],
  // A built capability lives in the merged code. It reaches 'attached' only via
  // an approved promote (E7-BUILD step 6), never on its own.
  built: ['attached', 'rejected', 'quarantined'],
  rejected: [],
  quarantined: ['sandboxed', 'built'], // a fixed capability may be re-trialed or rebuilt
};

let indexEnsured: Promise<void> | null = null;
async function ensureIndexes(): Promise<void> {
  indexEnsured ??= (async () => {
    const db = await getDb();
    const col = db.collection<CapabilityRecord>(COLLECTION);
    await col.createIndex({ capabilityId: 1 }, { unique: true });
    await col.createIndex({ registryName: 1 });
    await col.createIndex({ status: 1 });
  })().catch((err) => {
    indexEnsured = null;
    console.warn('[CapabilityRegistry] ensureIndexes failed:', (err as Error).message);
  }) as Promise<void>;
  await indexEnsured;
}

/** Upsert a discovered capability (idempotent on registryName). */
export async function recordDiscoveredCapability(input: {
  registryName: string;
  description: string;
  version?: string;
  repositoryUrl?: string;
  package?: CapabilityPackage;
  remotes?: CapabilityRemote[];
  gapDescription?: string;
}): Promise<CapabilityRecord> {
  await ensureIndexes();
  const db = await getDb();
  const col = db.collection<CapabilityRecord>(COLLECTION);
  const existing = await col.findOne({ registryName: input.registryName });
  const now = new Date();
  if (existing) {
    await col.updateOne(
      { capabilityId: existing.capabilityId },
      { $set: { description: input.description, version: input.version, package: input.package, remotes: input.remotes, updatedAt: now } },
    );
    return { ...existing, ...input, updatedAt: now } as CapabilityRecord;
  }
  const record: CapabilityRecord = {
    capabilityId: `cap-${randomUUID()}`,
    registryName: input.registryName,
    description: input.description,
    source: 'mcp-registry',
    version: input.version,
    repositoryUrl: input.repositoryUrl,
    package: input.package,
    remotes: input.remotes,
    status: 'discovered',
    tier: 'shadow',
    gapDescription: input.gapDescription,
    statusHistory: [{ at: now, from: null, to: 'discovered' }],
    createdAt: now,
    updatedAt: now,
  };
  await col.insertOne(record);
  return record;
}

export async function getCapability(capabilityId: string): Promise<CapabilityRecord | null> {
  const db = await getDb();
  return db.collection<CapabilityRecord>(COLLECTION).findOne({ capabilityId });
}

export async function listCapabilities(
  opts: { status?: CapabilityStatus; limit?: number } = {},
): Promise<CapabilityRecord[]> {
  const db = await getDb();
  const filter = opts.status ? { status: opts.status } : {};
  return db.collection<CapabilityRecord>(COLLECTION)
    .find(filter).sort({ updatedAt: -1 }).limit(opts.limit ?? 50).toArray();
}

/** Validated status transition (throws on illegal move — tests rely on this). */
export async function transitionCapability(
  capabilityId: string,
  to: CapabilityStatus,
  opts: { note?: string; sandboxReport?: SandboxReport; approvalId?: string } = {},
): Promise<CapabilityRecord> {
  const record = await getCapability(capabilityId);
  if (!record) throw new Error(`Capability not found: ${capabilityId}`);
  if (!VALID_TRANSITIONS[record.status].includes(to)) {
    throw new Error(`Illegal capability transition ${record.status} → ${to} (${record.registryName})`);
  }
  const now = new Date();
  const set: Record<string, unknown> = { status: to, updatedAt: now };
  if (opts.sandboxReport) set.sandboxReport = opts.sandboxReport;
  if (opts.approvalId) set.approvalId = opts.approvalId;
  if (to === 'attached') set.attachedAt = now;
  const db = await getDb();
  await db.collection<CapabilityRecord>(COLLECTION).updateOne(
    { capabilityId },
    { $set: set, $push: { statusHistory: { at: now, from: record.status, to, note: opts.note } } },
  );
  return { ...record, ...set, status: to } as CapabilityRecord;
}

// ── Capability gaps (emitted by harness hook) ────────────────────────────────

export type CapabilityGap = {
  gapId: string;
  agentId: string;
  description: string;           // what the agent said it couldn't do (truncated)
  taskId?: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolvedByCapabilityId?: string;
  createdAt: Date;
};

const GAPS_COLLECTION = 'capability_gaps';

export async function recordCapabilityGap(input: {
  agentId: string;
  description: string;
  taskId?: string;
}): Promise<string | undefined> {
  try {
    const db = await getDb();
    const gap: CapabilityGap = {
      gapId: `gap-${randomUUID()}`,
      agentId: input.agentId,
      description: input.description.slice(0, 500),
      taskId: input.taskId,
      status: 'open',
      createdAt: new Date(),
    };
    await db.collection<CapabilityGap>(GAPS_COLLECTION).insertOne(gap);
    return gap.gapId;
  } catch (err) {
    console.warn('[CapabilityRegistry] recordGap failed:', (err as Error).message);
    return undefined;
  }
}

export async function listOpenCapabilityGaps(limit = 20): Promise<CapabilityGap[]> {
  const db = await getDb();
  return db.collection<CapabilityGap>(GAPS_COLLECTION)
    .find({ status: 'open' }).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function getCapabilityGap(gapId: string): Promise<CapabilityGap | null> {
  const db = await getDb();
  return db.collection<CapabilityGap>(GAPS_COLLECTION).findOne({ gapId });
}

/**
 * Close a gap once a capability answers it. Fail-soft: a build that succeeded
 * must not be reported as failed just because the bookkeeping write did not land.
 */
export async function resolveCapabilityGap(
  gapId: string,
  capabilityId: string,
): Promise<boolean> {
  try {
    const db = await getDb();
    const result = await db.collection<CapabilityGap>(GAPS_COLLECTION).updateOne(
      { gapId, status: 'open' },
      { $set: { status: 'resolved', resolvedByCapabilityId: capabilityId } },
    );
    return result.modifiedCount === 1;
  } catch (err) {
    console.warn('[CapabilityRegistry] resolveGap failed:', (err as Error).message);
    return false;
  }
}

/**
 * Register a capability the system BUILT for itself (E7-BUILD), as opposed to one
 * discovered in the MCP registry. Lands in 'built' + tier 'shadow': the code is
 * merged and gate-verified, but nothing is live until a human promotes it.
 */
export async function recordBuiltCapability(input: {
  name: string;
  description: string;
  gapDescription?: string;
  /** Where the capability lives now — branch/commit the build merged. */
  repositoryUrl?: string;
}): Promise<CapabilityRecord> {
  await ensureIndexes();
  const db = await getDb();
  const col = db.collection<CapabilityRecord>(COLLECTION);
  const now = new Date();
  const record: CapabilityRecord = {
    capabilityId: `cap-${randomUUID()}`,
    registryName: input.name,
    description: input.description,
    source: 'manual',
    repositoryUrl: input.repositoryUrl,
    status: 'built',
    tier: 'shadow',
    gapDescription: input.gapDescription,
    statusHistory: [{ at: now, from: null, to: 'built', note: 'built by capability build pipeline' }],
    createdAt: now,
    updatedAt: now,
  };
  await col.insertOne(record);
  return record;
}

export { COLLECTION as CAPABILITIES_COLLECTION, GAPS_COLLECTION };
