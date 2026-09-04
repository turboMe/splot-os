/**
 * Artifact Store — typed documents agents exchange instead of chat transcripts
 * (Etap 3, IDEALSYSTEMMASTERPLAN A2 warstwa 2 — the MetaGPT SOP pattern).
 *
 * The next agent's prompt receives ONLY `summary (≤300 chars) + id`; full
 * content is fetched on demand via artifact_get. This is the main token-saving
 * mechanism in multi-agent sequences.
 *
 * Storage follows the proven harness-output-compactor split: small content
 * inline in Mongo `artifacts`, large content as a file under
 * MASTRA_ARTIFACT_DIR (.mastra/artifacts by default) with an index record in
 * Mongo. Secrets are redacted on write. TTL 90 days (the Etap 6 curator will
 * take over lifecycle).
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

import { ARTIFACT_TYPES, type ArtifactRef, type ArtifactType } from '../config/artifact-types.js';
import { noteRunArtifact } from './run-artifacts.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';

export type ArtifactRecord = {
  id: string;
  type: ArtifactType;
  laneId?: string;
  producedBy: string;
  schemaVersion: number;
  storage: 'mongo' | 'file';
  /** Present when storage=mongo. */
  content?: string;
  /** Present when storage=file. */
  filePath?: string;
  uri: string;
  title?: string;
  summary: string;
  bytes: number;
  sha256: string;
  createdAt: Date;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
};

export type PutArtifactInput = {
  type: ArtifactType;
  content: string;
  /** ≤300 chars; auto-derived from content head when omitted. */
  summary?: string;
  producedBy: string;
  laneId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

const COLLECTION = 'artifacts';
const SUMMARY_MAX = 1000;
const MONGO_MAX_BYTES = 512 * 1024;
const TTL_DAYS = 90;

import { getArtifactsDir } from '../config/workspace-paths.js';

function artifactDir(): string {
  return getArtifactsDir();
}

function deriveSummary(content: string, summary?: string): string {
  const base = (summary ?? content).replace(/\s+/g, ' ').trim();
  return base.length > SUMMARY_MAX ? `${base.slice(0, SUMMARY_MAX - 1)}…` : base;
}

export function toRef(record: Pick<ArtifactRecord, 'id' | 'type' | 'summary'>): ArtifactRef {
  return { id: record.id, type: record.type, summary: record.summary };
}

export async function putArtifact(input: PutArtifactInput): Promise<ArtifactRef> {
  const safeContent = redactSecrets(input.content ?? '').text;
  const bytes = Buffer.byteLength(safeContent, 'utf8');
  const id = `art-${randomUUID()}`;
  const now = new Date();
  const storage: ArtifactRecord['storage'] = bytes <= MONGO_MAX_BYTES ? 'mongo' : 'file';

  const record: ArtifactRecord = {
    id,
    type: input.type,
    laneId: input.laneId,
    producedBy: input.producedBy,
    schemaVersion: 1,
    storage,
    uri: storage === 'mongo' ? `mongo://artifacts/${id}` : '',
    title: input.title,
    summary: deriveSummary(safeContent, input.summary),
    bytes,
    sha256: createHash('sha256').update(safeContent).digest('hex'),
    createdAt: now,
    expiresAt: new Date(now.getTime() + TTL_DAYS * 24 * 3600 * 1000),
    metadata: input.metadata,
  };

  if (storage === 'mongo') {
    record.content = safeContent;
  } else {
    const dir = artifactDir();
    await mkdir(dir, { recursive: true });
    const filePath = resolve(dir, `${id}.md`);
    await writeFile(filePath, safeContent, 'utf8');
    record.filePath = filePath;
    record.uri = `file://${filePath}`;
  }

  const db = await getDb();
  await db.collection<ArtifactRecord>(COLLECTION).insertOne(record);
  // Attribute the write to the run that made it, NOW — the store keeps no runId,
  // and every attempt to recover this fact later from the response object has
  // failed on live traffic (see `run-artifacts.ts`). Recorded after the insert so
  // only a document that really exists is ever claimed.
  noteRunArtifact(record.id);
  return toRef(record);
}

export async function getArtifact(
  id: string,
  opts: { includeContent?: boolean } = {},
): Promise<(ArtifactRecord & { content?: string }) | null> {
  const db = await getDb();
  const record = await db.collection<ArtifactRecord>(COLLECTION).findOne({ id });
  if (!record) return null;
  if (opts.includeContent !== false && record.storage === 'file' && record.filePath) {
    try {
      record.content = await readFile(record.filePath, 'utf8');
    } catch {
      record.content = undefined;
    }
  }
  if (opts.includeContent === false) {
    delete record.content;
  }
  return record;
}

export async function listArtifacts(
  opts: { laneId?: string; type?: ArtifactType; producedBy?: string; limit?: number } = {},
): Promise<ArtifactRecord[]> {
  const db = await getDb();
  const filter: Record<string, unknown> = {};
  if (opts.laneId) filter.laneId = opts.laneId;
  if (opts.type) filter.type = opts.type;
  if (opts.producedBy) filter.producedBy = opts.producedBy;
  return db.collection<ArtifactRecord>(COLLECTION)
    .find(filter, { projection: { content: 0 } })
    .sort({ createdAt: -1 })
    .limit(opts.limit ?? 20)
    .toArray();
}

/**
 * Render artifact references for a brief: summary + id only — full content
 * NEVER travels in prompts (hard rule 2 of A2).
 */
export async function renderArtifactRefsForBrief(
  refs: Array<{ artifactId: string; name?: string }>,
): Promise<string[]> {
  const lines: string[] = [];
  for (const ref of refs) {
    const record = await getArtifact(ref.artifactId, { includeContent: false });
    if (!record) {
      lines.push(`- ${ref.name ?? ref.artifactId} (artifact): MISSING — id ${ref.artifactId} not found`);
      continue;
    }
    lines.push(
      `- ${ref.name ?? record.title ?? record.type} (artifact ${record.type}, id: ${record.id}, ${record.bytes} bytes): ` +
      `${record.summary} → full content: artifact_get("${record.id}")`,
    );
  }
  return lines;
}

export { ARTIFACT_TYPES };
