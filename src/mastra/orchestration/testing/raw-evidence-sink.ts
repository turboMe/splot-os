/**
 * Controlled raw-evidence helpers for the partial G0 test runtime.
 *
 * The child retains bounded, normalized bytes in its signed V2 report. The
 * strict parent gate independently captures process output, materializes every
 * required artifact in a private root, reads the files back, and only then
 * accepts the artifact set. The root path and cleanup capability never enter
 * child-controlled evidence.
 */
import {
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { BSON, type Db } from 'mongodb';

export const RAW_EVIDENCE_TRANSFORM_POLICY_VERSION =
  'g0-raw-evidence-transform/v1' as const;
export const RAW_EVIDENCE_SNAPSHOT_VERSION =
  'g0-anonymized-mongo-snapshot/v1' as const;
export const RAW_EVIDENCE_ARTIFACT_SET_VERSION =
  'g0-materialized-artifact-set/v1' as const;
export const RAW_EVIDENCE_CLEANUP_VERSION =
  'g0-artifact-root-cleanup/v1' as const;

export const REQUIRED_RAW_EVIDENCE = [
  {
    artifactId: 'normalized-summary',
    kind: 'normalizedSummary',
    relativeName: 'normalized-summary.json',
    mediaType: 'application/json',
    maxBytes: 64 * 1024,
  },
  {
    artifactId: 'stdout',
    kind: 'stdout',
    relativeName: 'stdout.log',
    mediaType: 'text/plain; charset=utf-8',
    maxBytes: 1024 * 1024,
  },
  {
    artifactId: 'stderr',
    kind: 'stderr',
    relativeName: 'stderr.log',
    mediaType: 'text/plain; charset=utf-8',
    maxBytes: 1024 * 1024,
  },
  {
    artifactId: 'trace-event-log',
    kind: 'trace',
    relativeName: 'trace-event-log.ndjson',
    mediaType: 'application/x-ndjson',
    maxBytes: 2 * 1024 * 1024,
  },
  {
    artifactId: 'db-snapshot',
    kind: 'dbSnapshot',
    relativeName: 'db-snapshot.json',
    mediaType: 'application/json',
    maxBytes: 4 * 1024 * 1024,
  },
] as const;

export type RequiredRawEvidenceDeclaration = (typeof REQUIRED_RAW_EVIDENCE)[number];
export type RequiredRawEvidenceKind = RequiredRawEvidenceDeclaration['kind'];
export type RequiredRawEvidenceId = RequiredRawEvidenceDeclaration['artifactId'];

export const RAW_EVIDENCE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export const RAW_EVIDENCE_MAX_TRACE_EVENTS = 10_000;
export const RAW_EVIDENCE_MAX_SNAPSHOT_DOCUMENTS = 50_000;
export const RAW_EVIDENCE_CAPTURE_MAX_BYTES_PER_STREAM = 1024 * 1024;

const BASE64URL_OR_EMPTY_RE = /^[A-Za-z0-9_-]*$/;
const SAFE_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const SAFE_COLLECTION_RE = /^orch_[A-Za-z0-9_]{1,120}$/;
const SECRET_ASSIGNMENT_RE =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|authorization)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/iu;
const AUTH_SCHEME_SECRET_RE =
  /\b(?:authorization\s*["']?\s*[:=]\s*["']?\s*)?(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/iu;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface RawEvidenceArtifactInput {
  artifactId: RequiredRawEvidenceId;
  kind: RequiredRawEvidenceKind;
  mediaType: RequiredRawEvidenceDeclaration['mediaType'];
  content: string | Uint8Array;
}

export interface RetainedRawEvidenceArtifact {
  artifactId: RequiredRawEvidenceId;
  kind: RequiredRawEvidenceKind;
  relativeName: RequiredRawEvidenceDeclaration['relativeName'];
  mediaType: RequiredRawEvidenceDeclaration['mediaType'];
  byteSize: number;
  contentHash: `sha256:${string}`;
  contentBase64url: string;
  transformPolicyVersion: typeof RAW_EVIDENCE_TRANSFORM_POLICY_VERSION;
  retentionStatus: 'BUNDLE_RETAINED';
  readBackRequired: true;
}

export interface QuarantinedRawEvidenceArtifact {
  artifactId: RequiredRawEvidenceId;
  kind: RequiredRawEvidenceKind;
  relativeName: RequiredRawEvidenceDeclaration['relativeName'];
  mediaType: RequiredRawEvidenceDeclaration['mediaType'];
  observedByteSize: number;
  transformPolicyVersion: typeof RAW_EVIDENCE_TRANSFORM_POLICY_VERSION;
  retentionStatus: 'QUARANTINED_SECRET';
  quarantineCode: 'SECRET_DETECTED';
  readBackRequired: false;
}

export type RawEvidenceArtifactDescriptor =
  | RetainedRawEvidenceArtifact
  | QuarantinedRawEvidenceArtifact;

export interface RetainRawEvidenceArtifactsResult {
  artifacts: RawEvidenceArtifactDescriptor[];
  artifactEvidenceStatus: 'COMPLETE' | 'INCOMPLETE' | 'QUARANTINED';
  secretScanStatus: 'PASS' | 'FAILED' | 'NOT_RUN';
  totalRetainedBytes: number;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function declarationFor(
  artifactId: string,
  kind: string,
  mediaType: string,
): RequiredRawEvidenceDeclaration {
  const declaration = REQUIRED_RAW_EVIDENCE.find((entry) =>
    entry.artifactId === artifactId
    && entry.kind === kind
    && entry.mediaType === mediaType);
  if (!declaration) throw new TypeError('raw evidence does not match the fixed artifact profile');
  return declaration;
}

function inputBytes(content: string | Uint8Array): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf8')
    : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

/** Normalize process/text framing without redacting or truncating content. */
export function normalizeRawEvidenceText(content: string | Uint8Array): Buffer {
  const bytes = inputBytes(content);
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new TypeError('raw evidence is not canonical UTF-8');
  }
  return Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf8');
}

function hasSecret(bytes: Uint8Array, secretCanaries: readonly string[]): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const canary of secretCanaries) {
    if (canary.length >= 4 && buffer.includes(Buffer.from(canary, 'utf8'))) return true;
  }
  let text: string;
  try {
    text = UTF8_DECODER.decode(buffer);
  } catch {
    return true;
  }
  return SECRET_ASSIGNMENT_RE.test(text) || AUTH_SCHEME_SECRET_RE.test(text);
}

function validateTrace(bytes: Uint8Array): void {
  const text = UTF8_DECODER.decode(bytes);
  if (text.length === 0) throw new TypeError('trace event log cannot be empty');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length > RAW_EVIDENCE_MAX_TRACE_EVENTS) {
    throw new RangeError('trace event count exceeds the fixed limit');
  }
  for (let index = 0; index < lines.length; index++) {
    let event: unknown;
    try {
      event = JSON.parse(lines[index]!);
    } catch {
      throw new TypeError('trace event log is not canonical NDJSON');
    }
    if (
      !event
      || typeof event !== 'object'
      || Array.isArray(event)
      || (event as Record<string, unknown>).sequence !== index + 1
    ) {
      throw new TypeError('trace event sequence is not contiguous');
    }
  }
}

function validateSnapshot(bytes: Uint8Array): void {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    throw new TypeError('database snapshot is not valid UTF-8 JSON');
  }
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || (snapshot as Record<string, unknown>).schemaVersion !== RAW_EVIDENCE_SNAPSHOT_VERSION
    || !Array.isArray((snapshot as Record<string, unknown>).collections)
  ) {
    throw new TypeError('database snapshot does not match the anonymized snapshot contract');
  }
}

function validateKindPayload(
  declaration: RequiredRawEvidenceDeclaration,
  bytes: Uint8Array,
): void {
  if (declaration.kind === 'trace') validateTrace(bytes);
  if (declaration.kind === 'dbSnapshot') validateSnapshot(bytes);
  if (
    declaration.kind === 'normalizedSummary'
    || declaration.kind === 'dbSnapshot'
  ) {
    try {
      JSON.parse(UTF8_DECODER.decode(bytes));
    } catch {
      throw new TypeError(`${declaration.kind} must be valid UTF-8 JSON`);
    }
  }
}

/**
 * Retain real bounded bytes inside the signed child bundle. Secret-bearing
 * bytes are represented only by a non-publishable quarantine descriptor.
 */
export function retainRawEvidenceArtifacts(
  inputs: readonly RawEvidenceArtifactInput[],
  secretCanaries: readonly string[],
): RetainRawEvidenceArtifactsResult {
  const sorted = [...inputs].sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1]!.artifactId === sorted[index]!.artifactId) {
      throw new TypeError('raw evidence contains a duplicate artifact');
    }
  }

  let totalRetainedBytes = 0;
  let quarantined = false;
  const artifacts = sorted.map((input): RawEvidenceArtifactDescriptor => {
    const declaration = declarationFor(input.artifactId, input.kind, input.mediaType);
    const bytes = normalizeRawEvidenceText(input.content);
    if (bytes.byteLength > declaration.maxBytes) {
      throw new RangeError(`${declaration.artifactId} exceeds its fixed byte limit`);
    }
    validateKindPayload(declaration, bytes);
    if (hasSecret(bytes, secretCanaries)) {
      quarantined = true;
      return {
        artifactId: declaration.artifactId,
        kind: declaration.kind,
        relativeName: declaration.relativeName,
        mediaType: declaration.mediaType,
        observedByteSize: bytes.byteLength,
        transformPolicyVersion: RAW_EVIDENCE_TRANSFORM_POLICY_VERSION,
        retentionStatus: 'QUARANTINED_SECRET',
        quarantineCode: 'SECRET_DETECTED',
        readBackRequired: false,
      };
    }
    totalRetainedBytes += bytes.byteLength;
    if (totalRetainedBytes > RAW_EVIDENCE_TOTAL_MAX_BYTES) {
      throw new RangeError('raw evidence exceeds the aggregate byte limit');
    }
    return {
      artifactId: declaration.artifactId,
      kind: declaration.kind,
      relativeName: declaration.relativeName,
      mediaType: declaration.mediaType,
      byteSize: bytes.byteLength,
      contentHash: sha256(bytes),
      contentBase64url: bytes.toString('base64url'),
      transformPolicyVersion: RAW_EVIDENCE_TRANSFORM_POLICY_VERSION,
      retentionStatus: 'BUNDLE_RETAINED',
      readBackRequired: true,
    };
  });

  const retainedIds = new Set(
    artifacts
      .filter((artifact): artifact is RetainedRawEvidenceArtifact =>
        artifact.retentionStatus === 'BUNDLE_RETAINED')
      .map((artifact) => artifact.artifactId),
  );
  const complete = artifacts.length === REQUIRED_RAW_EVIDENCE.length
    && REQUIRED_RAW_EVIDENCE.every((entry) => retainedIds.has(entry.artifactId));
  return {
    artifacts,
    artifactEvidenceStatus: quarantined
      ? 'QUARANTINED'
      : complete
        ? 'COMPLETE'
        : 'INCOMPLETE',
    secretScanStatus: artifacts.length === 0
      ? 'NOT_RUN'
      : quarantined
        ? 'FAILED'
        : 'PASS',
    totalRetainedBytes,
  };
}

export function validateRetainedRawEvidenceArtifact(
  input: unknown,
): input is RetainedRawEvidenceArtifact {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const artifact = input as Partial<RetainedRawEvidenceArtifact>;
  let declaration: RequiredRawEvidenceDeclaration;
  try {
    declaration = declarationFor(
      String(artifact.artifactId ?? ''),
      String(artifact.kind ?? ''),
      String(artifact.mediaType ?? ''),
    );
  } catch {
    return false;
  }
  if (
    artifact.relativeName !== declaration.relativeName
    || artifact.transformPolicyVersion !== RAW_EVIDENCE_TRANSFORM_POLICY_VERSION
    || artifact.retentionStatus !== 'BUNDLE_RETAINED'
    || artifact.readBackRequired !== true
    || typeof artifact.contentBase64url !== 'string'
    || !BASE64URL_OR_EMPTY_RE.test(artifact.contentBase64url)
    || typeof artifact.byteSize !== 'number'
    || !Number.isInteger(artifact.byteSize)
    || artifact.byteSize < 0
    || artifact.byteSize > declaration.maxBytes
    || typeof artifact.contentHash !== 'string'
  ) {
    return false;
  }
  const bytes = Buffer.from(artifact.contentBase64url, 'base64url');
  if (
    bytes.toString('base64url') !== artifact.contentBase64url
    || bytes.byteLength !== artifact.byteSize
    || sha256(bytes) !== artifact.contentHash
  ) {
    return false;
  }
  try {
    validateKindPayload(declaration, bytes);
  } catch {
    return false;
  }
  return true;
}

export function retainedArtifactBytes(artifact: RetainedRawEvidenceArtifact): Buffer {
  if (!validateRetainedRawEvidenceArtifact(artifact)) {
    throw new TypeError('retained artifact bytes failed independent validation');
  }
  return Buffer.from(artifact.contentBase64url, 'base64url');
}

export interface ProcessOutputCaptureResult {
  stdout: Buffer;
  stderr: Buffer;
}

export interface ProcessOutputCapture {
  stop(): ProcessOutputCaptureResult;
}

let activeOutputCapture = false;

/**
 * Tee exact child stdout/stderr while retaining a bounded copy. Evidence
 * publication must happen only after `stop()`.
 */
export function startBoundedProcessOutputCapture(
  maxBytesPerStream = RAW_EVIDENCE_CAPTURE_MAX_BYTES_PER_STREAM,
): ProcessOutputCapture {
  if (activeOutputCapture) throw new Error('a process output capture is already active');
  if (!Number.isInteger(maxBytesPerStream) || maxBytesPerStream < 0) {
    throw new TypeError('invalid process output capture limit');
  }
  activeOutputCapture = true;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflowed = false;
  let stopped = false;

  function capture(
    chunks: Buffer[],
    currentBytes: number,
    chunk: unknown,
    encoding?: BufferEncoding,
  ): number {
    const bytes = typeof chunk === 'string'
      ? Buffer.from(chunk, encoding ?? 'utf8')
      : ArrayBuffer.isView(chunk)
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.from(String(chunk), 'utf8');
    if (currentBytes + bytes.byteLength > maxBytesPerStream) {
      overflowed = true;
      return currentBytes;
    }
    chunks.push(Buffer.from(bytes));
    return currentBytes + bytes.byteLength;
  }

  (process.stdout.write as unknown as (...args: unknown[]) => boolean) = function (
    chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ): boolean {
    stdoutBytes = capture(
      stdoutChunks,
      stdoutBytes,
      chunk,
      typeof encodingOrCallback === 'string' ? encodingOrCallback as BufferEncoding : undefined,
    );
    return originalStdoutWrite(
      chunk as never,
      encodingOrCallback as never,
      callback as never,
    );
  };
  (process.stderr.write as unknown as (...args: unknown[]) => boolean) = function (
    chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ): boolean {
    stderrBytes = capture(
      stderrChunks,
      stderrBytes,
      chunk,
      typeof encodingOrCallback === 'string' ? encodingOrCallback as BufferEncoding : undefined,
    );
    return originalStderrWrite(
      chunk as never,
      encodingOrCallback as never,
      callback as never,
    );
  };

  return Object.freeze({
    stop(): ProcessOutputCaptureResult {
      if (stopped) throw new Error('process output capture was already stopped');
      stopped = true;
      process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
      process.stderr.write = originalStderrWrite as typeof process.stderr.write;
      activeOutputCapture = false;
      if (overflowed) throw new RangeError('process output exceeded the fixed capture limit');
      return {
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.concat(stderrChunks, stderrBytes),
      };
    },
  });
}

type SnapshotScalar =
  | null
  | boolean
  | number
  | string
  | SnapshotScalar[]
  | { [key: string]: SnapshotScalar };

function pseudonym(key: Uint8Array, value: string): string {
  return `hmac-sha256:${createHmac('sha256', key).update(value).digest('hex')}`;
}

function anonymizeBson(
  value: unknown,
  key: Uint8Array,
  epochMs: number,
  reserveOutputBytes: (byteCount: number) => void,
  seen = new Set<object>(),
): SnapshotScalar {
  const retainScalar = (output: SnapshotScalar): SnapshotScalar => {
    reserveOutputBytes(Buffer.byteLength(stableJson(output), 'utf8'));
    return output;
  };
  if (value === null || typeof value === 'boolean') return retainScalar(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('snapshot rejects non-finite numbers');
    return retainScalar({ $numberPseudonym: pseudonym(key, `number:${value}`) });
  }
  if (typeof value === 'string') {
    return retainScalar({ $pseudonym: pseudonym(key, value) });
  }
  if (typeof value === 'bigint') {
    return retainScalar({ $bigintPseudonym: pseudonym(key, `bigint:${value}`) });
  }
  if (value instanceof Date) {
    const offset = value.getTime() - epochMs;
    if (!Number.isFinite(offset)) throw new TypeError('snapshot rejects invalid dates');
    return retainScalar({ $relativeTimeMs: offset });
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return retainScalar({
      $bytes: { byteSize: bytes.byteLength, contentHash: sha256(bytes) },
    });
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError(`snapshot rejects unsupported ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError('snapshot rejects cyclic BSON');
  seen.add(value);
  try {
    const bsonType = (value as { _bsontype?: unknown })._bsontype;
    if (typeof bsonType === 'string') {
      const asString = typeof (value as { toString?: unknown }).toString === 'function'
        ? String((value as { toString(): unknown }).toString())
        : '';
      if (!asString || asString === '[object Object]') {
        throw new TypeError('snapshot rejects an unsupported BSON scalar');
      }
      return retainScalar({
        $bsonScalar: {
          typePseudonym: pseudonym(key, bsonType),
          valuePseudonym: pseudonym(key, asString),
        },
      });
    }
    if (Array.isArray(value)) {
      reserveOutputBytes(2 + Math.max(0, value.length - 1));
      return value.map((entry) =>
        anonymizeBson(entry, key, epochMs, reserveOutputBytes, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('snapshot accepts only BSON scalars and plain objects');
    }
    const output = Object.create(null) as Record<string, SnapshotScalar>;
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    reserveOutputBytes(2 + Math.max(0, entries.length - 1));
    for (const [nestedKey, nestedValue] of entries) {
      if (nestedKey === '__proto__' || nestedKey === 'constructor' || nestedKey === 'prototype') {
        throw new TypeError('snapshot rejects prototype-sensitive keys');
      }
      const outputKey = `$field:${pseudonym(key, nestedKey)}`;
      reserveOutputBytes(Buffer.byteLength(JSON.stringify(outputKey), 'utf8') + 1);
      output[outputKey] = anonymizeBson(
        nestedValue,
        key,
        epochMs,
        reserveOutputBytes,
        seen,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('stable JSON rejects non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('stable JSON rejects unsupported value');
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`;
}

export async function captureAnonymizedMongoSnapshot(input: {
  db: Db;
  expectedDatabaseName: string;
  runId: string;
  pseudonymKey: Uint8Array;
  epoch: Date;
}): Promise<Buffer> {
  if (input.db.databaseName !== input.expectedDatabaseName) {
    throw new TypeError('snapshot database does not match the owned database');
  }
  const declaration = REQUIRED_RAW_EVIDENCE.find((entry) => entry.kind === 'dbSnapshot')!;
  const runIdHash = sha256(Buffer.from(input.runId, 'utf8'));
  const databaseNameHash = sha256(Buffer.from(input.expectedDatabaseName, 'utf8'));
  let reservedOutputBytes = Buffer.byteLength(`${stableJson({
    schemaVersion: RAW_EVIDENCE_SNAPSHOT_VERSION,
    runIdHash,
    databaseNameHash,
    totalDocuments: RAW_EVIDENCE_MAX_SNAPSHOT_DOCUMENTS,
    collections: [],
  })}\n`, 'utf8');

  function reserveOutputBytes(byteCount: number): void {
    if (
      !Number.isSafeInteger(byteCount)
      || byteCount < 0
      || reservedOutputBytes + byteCount > declaration.maxBytes
    ) {
      throw new RangeError('snapshot exceeds its fixed working-set/output byte limit');
    }
    reservedOutputBytes += byteCount;
  }

  function assertBsonWorkingSetBound(value: unknown): void {
    let byteSize: number;
    try {
      byteSize = BSON.calculateObjectSize(value as Record<string, unknown>, {
        ignoreUndefined: false,
      });
    } catch {
      throw new TypeError('snapshot rejects a non-BSON document');
    }
    if (byteSize > declaration.maxBytes) {
      throw new RangeError('snapshot document exceeds its fixed working-set byte limit');
    }
  }

  const names: string[] = [];
  const seenNames = new Set<string>();
  const collectionCursor = input.db
    .listCollections({}, { nameOnly: true })
    .batchSize(1);
  for await (const row of collectionCursor) {
    const name = row.name;
    if (name === '__g0_run_owner') continue;
    if (
      typeof name !== 'string'
      || !SAFE_COLLECTION_RE.test(name)
      || seenNames.has(name)
    ) {
      throw new TypeError('snapshot found an unexpected collection');
    }
    const emptyCollection = stableJson({
      namePseudonym: pseudonym(input.pseudonymKey, `collection:${name}`),
      documentCount: RAW_EVIDENCE_MAX_SNAPSHOT_DOCUMENTS,
      documents: [],
      indexes: [],
    });
    reserveOutputBytes(
      Buffer.byteLength(emptyCollection, 'utf8') + (names.length === 0 ? 0 : 1),
    );
    seenNames.add(name);
    names.push(name);
  }
  names.sort();

  let totalDocuments = 0;
  const serializedCollections: string[] = [];
  for (const name of names) {
    const anonymizedCollectionName = pseudonym(input.pseudonymKey, `collection:${name}`);
    const serializedDocuments: string[] = [];
    let documentCount = 0;
    const remainingDocumentCapacity =
      RAW_EVIDENCE_MAX_SNAPSHOT_DOCUMENTS - totalDocuments;
    const documentCursor = input.db.collection(name)
      .find({})
      .limit(remainingDocumentCapacity + 1)
      .batchSize(1);
    for await (const doc of documentCursor) {
      totalDocuments++;
      documentCount++;
      if (totalDocuments > RAW_EVIDENCE_MAX_SNAPSHOT_DOCUMENTS) {
        throw new RangeError('snapshot document count exceeds the fixed limit');
      }
      assertBsonWorkingSetBound(doc);
      if (serializedDocuments.length > 0) reserveOutputBytes(1);
      const payloadStart = reservedOutputBytes;
      const anonymized = anonymizeBson(
        doc,
        input.pseudonymKey,
        input.epoch.getTime(),
        reserveOutputBytes,
      );
      const serialized = stableJson(anonymized);
      if (
        reservedOutputBytes - payloadStart
        !== Buffer.byteLength(serialized, 'utf8')
      ) {
        throw new Error('snapshot document budget accounting failed');
      }
      serializedDocuments.push(serialized);
    }

    serializedDocuments.sort((left, right) => left.localeCompare(right));
    const serializedIndexes: string[] = [];
    const indexCursor = input.db.collection(name).listIndexes().batchSize(1);
    for await (const index of indexCursor) {
      assertBsonWorkingSetBound(index);
      if (serializedIndexes.length > 0) reserveOutputBytes(1);
      const payloadStart = reservedOutputBytes;
      const normalizedIndex = anonymizeBson({
        key: Object.fromEntries(
          Object.entries(index.key ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ),
        unique: index.unique === true,
      }, input.pseudonymKey, input.epoch.getTime(), reserveOutputBytes);
      const serialized = stableJson(normalizedIndex);
      if (
        reservedOutputBytes - payloadStart
        !== Buffer.byteLength(serialized, 'utf8')
      ) {
        throw new Error('snapshot index budget accounting failed');
      }
      serializedIndexes.push(serialized);
    }
    serializedIndexes.sort((left, right) => left.localeCompare(right));
    serializedCollections.push(
      `{"documentCount":${documentCount},`
      + `"documents":[${serializedDocuments.join(',')}],`
      + `"indexes":[${serializedIndexes.join(',')}],`
      + `"namePseudonym":${JSON.stringify(anonymizedCollectionName)}}`,
    );
  }

  const bytes = Buffer.from(
    `{"collections":[${serializedCollections.join(',')}],`
    + `"databaseNameHash":${JSON.stringify(databaseNameHash)},`
    + `"runIdHash":${JSON.stringify(runIdHash)},`
    + `"schemaVersion":${JSON.stringify(RAW_EVIDENCE_SNAPSHOT_VERSION)},`
    + `"totalDocuments":${totalDocuments}}\n`,
    'utf8',
  );
  if (
    bytes.byteLength > declaration.maxBytes
    || bytes.byteLength > reservedOutputBytes
  ) {
    throw new RangeError('snapshot exceeds its fixed working-set/output byte limit');
  }
  return bytes;
}

export interface MaterializedArtifactSet {
  schemaVersion: typeof RAW_EVIDENCE_ARTIFACT_SET_VERSION;
  sessionId: string;
  artifactSetHash: `sha256:${string}`;
  totalByteSize: number;
  artifacts: Array<{
    artifactId: RequiredRawEvidenceId;
    kind: RequiredRawEvidenceKind;
    relativeName: RequiredRawEvidenceDeclaration['relativeName'];
    mediaType: RequiredRawEvidenceDeclaration['mediaType'];
    byteSize: number;
    contentHash: `sha256:${string}`;
    readBackVerified: true;
  }>;
}

export interface ArtifactRootCleanupVerification {
  schemaVersion: typeof RAW_EVIDENCE_CLEANUP_VERSION;
  sessionId: string;
  verifiedAbsent: true;
  artifactCount: number;
}

export interface ParentArtifactSession {
  materialize(artifacts: readonly RawEvidenceArtifactDescriptor[]): MaterializedArtifactSet;
  cleanup(): ArtifactRootCleanupVerification;
}

function assertPrivateRegularFile(path: string, expectedSize: number): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (stat.mode & 0o077) !== 0
    || stat.size !== expectedSize
  ) {
    throw new Error('materialized evidence file is not private and regular');
  }
}

function writeAtomicPrivateFile(root: string, relativeName: string, bytes: Buffer): string {
  if (basename(relativeName) !== relativeName || relativeName.includes('/') || relativeName.includes('\\')) {
    throw new TypeError('artifact relative name is not a fixed basename');
  }
  const finalPath = join(root, relativeName);
  const tempPath = join(root, `.${relativeName}.${randomBytes(8).toString('hex')}.partial`);
  let ownedIdentity: { dev: bigint; ino: bigint } | undefined;
  try {
    const fd = openSync(
      tempPath,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assertPrivateRegularFile(tempPath, bytes.byteLength);
    const tempStat = lstatSync(tempPath, { bigint: true });
    ownedIdentity = { dev: tempStat.dev, ino: tempStat.ino };
    if (existsSync(finalPath)) throw new Error('artifact final path already exists');
    renameSync(tempPath, finalPath);
    assertPrivateRegularFile(finalPath, bytes.byteLength);
    return finalPath;
  } catch (error) {
    if (existsSync(tempPath)) {
      const stat = lstatSync(tempPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) unlinkSync(tempPath);
    }
    if (ownedIdentity && existsSync(finalPath)) {
      const stat = lstatSync(finalPath, { bigint: true });
      if (
        stat.isFile()
        && !stat.isSymbolicLink()
        && stat.nlink === 1n
        && stat.dev === ownedIdentity.dev
        && stat.ino === ownedIdentity.ino
      ) {
        unlinkSync(finalPath);
      }
    }
    throw error;
  }
}

/**
 * Parent-only opaque session. Cleanup uses captured inode identity and the
 * internally generated root, never a path supplied by child evidence.
 */
export function createParentArtifactSession(input: {
  parentDirectory: string;
  sessionId: string;
}): ParentArtifactSession {
  if (!SAFE_SESSION_RE.test(input.sessionId)) throw new TypeError('invalid artifact session id');
  const parent = realpathSync(resolve(input.parentDirectory));
  const root = mkdtempSync(join(parent, `artifacts-${input.sessionId}-`));
  chmodSync(root, 0o700);
  const rootRealpath = realpathSync(root);
  if (dirname(rootRealpath) !== parent) throw new Error('artifact root escaped its parent');
  const rootStat = lstatSync(rootRealpath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
    throw new Error('artifact root is not a private directory');
  }

  let materialized: MaterializedArtifactSet | undefined;
  let cleaned = false;
  type OwnedArtifactFile = {
    dev: bigint;
    ino: bigint;
    size: number;
    contentHash: `sha256:${string}`;
  };
  const files = new Map<string, OwnedArtifactFile>();

  function assertRootIdentity(): void {
    const current = lstatSync(rootRealpath, { bigint: true });
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== BigInt(rootStat.dev)
      || current.ino !== BigInt(rootStat.ino)
      || (current.mode & 0o077n) !== 0n
    ) {
      throw new Error('artifact root identity changed');
    }
  }

  function assertOwnedArtifactFile(relativeName: string, expected: OwnedArtifactFile): void {
    const path = join(rootRealpath, relativeName);
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let stat;
    let bytes: Buffer;
    try {
      stat = fstatSync(fd, { bigint: true });
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (
      !stat.isFile()
      || stat.nlink !== 1n
      || stat.dev !== expected.dev
      || stat.ino !== expected.ino
      || stat.size !== BigInt(expected.size)
      || sha256(bytes) !== expected.contentHash
    ) {
      throw new Error('artifact cleanup refused a changed file');
    }
  }

  return Object.freeze({
    materialize(artifacts: readonly RawEvidenceArtifactDescriptor[]): MaterializedArtifactSet {
      if (cleaned || materialized) throw new Error('artifact session is not open');
      assertRootIdentity();
      const retained = [...artifacts]
        .filter((artifact): artifact is RetainedRawEvidenceArtifact =>
          artifact.retentionStatus === 'BUNDLE_RETAINED')
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
      if (
        retained.length !== REQUIRED_RAW_EVIDENCE.length
        || !REQUIRED_RAW_EVIDENCE.every((required, index) =>
          retained[index]?.artifactId === [...REQUIRED_RAW_EVIDENCE]
            .sort((left, right) => left.artifactId.localeCompare(right.artifactId))[index]?.artifactId)
      ) {
        throw new Error('materialized evidence is not the complete fixed profile');
      }
      let totalByteSize = 0;
      const descriptors = retained.map((artifact) => {
        const bytes = retainedArtifactBytes(artifact);
        totalByteSize += bytes.byteLength;
        if (totalByteSize > RAW_EVIDENCE_TOTAL_MAX_BYTES) {
          throw new RangeError('materialized evidence exceeds the aggregate byte limit');
        }
        const path = writeAtomicPrivateFile(rootRealpath, artifact.relativeName, bytes);
        const publishedStat = lstatSync(path, { bigint: true });
        files.set(artifact.relativeName, {
          dev: publishedStat.dev,
          ino: publishedStat.ino,
          size: bytes.byteLength,
          contentHash: artifact.contentHash,
        });
        const fd = openSync(
          path,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        let readBack: Buffer;
        let stat;
        try {
          stat = fstatSync(fd, { bigint: true });
          readBack = readFileSync(fd);
        } finally {
          closeSync(fd);
        }
        if (
          !stat.isFile()
          || stat.nlink !== 1n
          || (stat.mode & 0o077n) !== 0n
          || stat.size !== BigInt(bytes.byteLength)
          || sha256(readBack) !== artifact.contentHash
        ) {
          throw new Error('artifact read-back verification failed');
        }
        if (stat.dev !== publishedStat.dev || stat.ino !== publishedStat.ino) {
          throw new Error('artifact inode changed before read-back');
        }
        return {
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          relativeName: artifact.relativeName,
          mediaType: artifact.mediaType,
          byteSize: artifact.byteSize,
          contentHash: artifact.contentHash,
          readBackVerified: true as const,
        };
      });
      const unsigned = {
        schemaVersion: RAW_EVIDENCE_ARTIFACT_SET_VERSION,
        sessionId: input.sessionId,
        totalByteSize,
        artifacts: descriptors,
      };
      materialized = Object.freeze({
        ...unsigned,
        artifactSetHash: sha256(Buffer.from(stableJson(unsigned), 'utf8')),
      });
      return materialized;
    },
    cleanup(): ArtifactRootCleanupVerification {
      if (cleaned) {
        if (existsSync(rootRealpath)) throw new Error('cleaned artifact root reappeared');
        return {
          schemaVersion: RAW_EVIDENCE_CLEANUP_VERSION,
          sessionId: input.sessionId,
          verifiedAbsent: true,
          artifactCount: files.size,
        };
      }
      assertRootIdentity();
      const entries = readdirSync(rootRealpath).sort();
      if (entries.length !== files.size || entries.some((entry) => !files.has(entry))) {
        throw new Error('artifact root contains an unexpected entry');
      }
      for (const [relativeName, expected] of files) {
        assertOwnedArtifactFile(relativeName, expected);
      }
      for (const [relativeName, expected] of files) {
        assertOwnedArtifactFile(relativeName, expected);
        const path = join(rootRealpath, relativeName);
        unlinkSync(path);
      }
      rmdirSync(rootRealpath);
      if (existsSync(rootRealpath)) throw new Error('artifact root cleanup was not verified');
      cleaned = true;
      return {
        schemaVersion: RAW_EVIDENCE_CLEANUP_VERSION,
        sessionId: input.sessionId,
        verifiedAbsent: true,
        artifactCount: files.size,
      };
    },
  });
}

/** Parent-side comparison for the two independently captured process streams. */
export function processOutputMatchesArtifact(
  rawParentBytes: Uint8Array,
  artifact: RetainedRawEvidenceArtifact,
): boolean {
  if (artifact.kind !== 'stdout' && artifact.kind !== 'stderr') return false;
  const normalized = normalizeRawEvidenceText(rawParentBytes);
  return normalized.equals(retainedArtifactBytes(artifact));
}

/** Strict handoff descriptor: child writes only to the inherited parent FD. */
export function gateEvidenceFdFromEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value !== '3') throw new TypeError('strict gate evidence FD must be inherited as fd 3');
  return 3;
}
