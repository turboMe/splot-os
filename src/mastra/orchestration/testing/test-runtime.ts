/**
 * Test-owned Mongo runtime foundation for deterministic orchestration suites.
 *
 * The public manifest is evidence metadata, not deletion authority. Destructive
 * cleanup is reachable only through the opaque owner returned by
 * `createTestRuntimeOwner`. That owner keeps a separate 256-bit capability in
 * memory and proves possession against an immutable, HMAC-authenticated marker
 * written as the first collection in the exact random database.
 *
 * This remains a partial G0 sandbox. The strict parent gate may bind the signed
 * manifest to a parent-owned workspace, listening sockets, a trusted Linux
 * process group and a Node-level egress guard. Kernel/cgroup containment,
 * OS-level default-deny networking remains a later test-runtime increment. The
 * strict gate supplies a parent-minted Mongo allocation that is journaled
 * before workload release, so a later gate can authenticate and reclaim an
 * exact database after a crash.
 */
import {
  createPublicKey,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fstatSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db, MongoClient } from 'mongodb';
import { z } from 'zod';
import {
  RAW_EVIDENCE_TOTAL_MAX_BYTES,
  RAW_EVIDENCE_TRANSFORM_POLICY_VERSION,
  REQUIRED_RAW_EVIDENCE,
  captureAnonymizedMongoSnapshot,
  retainRawEvidenceArtifacts,
  validateRetainedRawEvidenceArtifact,
  type RawEvidenceArtifactDescriptor,
  type RawEvidenceArtifactInput,
  type RequiredRawEvidenceId,
} from './raw-evidence-sink.js';
import {
  TEST_RUNTIME_PARENT_SOURCE_ENV,
  TEST_RUNTIME_RESOURCE_CONTRACT_ENV,
  TEST_RUNTIME_WORKSPACE_ENV,
  parseRuntimeResourceContractEnv,
  testRuntimeResourceContractSchema,
  type TestRuntimeResourceContract,
} from './runtime-resource-contract.js';

export const TEST_RUNTIME_MANIFEST_VERSION = 'g0-test-runtime-manifest/v3' as const;
export const TEST_RUNTIME_OWNER_COLLECTION_VERSION = 'g0-mongo-owner-collection/v1' as const;
export const TEST_RUNTIME_OWNER_MARKER_VERSION = 'g0-mongo-owner-marker/v1' as const;
export const TEST_RUNTIME_OWNERSHIP_RECEIPT_VERSION = 'g0-mongo-ownership-receipt/v1' as const;
export const TEST_CLEANUP_VERIFICATION_VERSION = 'g0-test-cleanup-verification/v1' as const;
export const TEST_EVIDENCE_REPORT_VERSION = 'g0-test-evidence-report/v3' as const;
export const TEST_EVIDENCE_VERIFIER_VERSION = 'g0-evidence-verifier/v1' as const;
export const TEST_EVIDENCE_ATTESTATION_VERSION = 'g0-evidence-attestation/v1' as const;
export const TEST_EVIDENCE_BUNDLE_VERSION = 'g0-test-evidence-bundle/v3' as const;
export const TEST_EVIDENCE_BUNDLE_MAX_BYTES = 12 * 1024 * 1024;
export const TEST_RUNTIME_DB_PREFIX = 'orch_g0_v1_' as const;
export const TEST_RUNTIME_OWNER_COLLECTION = '__g0_run_owner' as const;
export const MONGO_OWNER_ALLOCATION_VERSION = 'g0-mongo-owner-allocation/v1' as const;
export const TEST_RUNTIME_MONGO_OWNER_ALLOCATION_SYMBOL =
  'g0.mongo-owner-allocation/v1' as const;

const OWNER_MARKER_ID = 'owner';
const RUN_ID_PREFIX = 'g0run_';
const RUN_TOKEN_RE = /^[a-f0-9]{32}$/;
const RUN_ID_RE = /^g0run_[a-f0-9]{32}$/;
const PARENT_CHALLENGE_RE = /^[a-f0-9]{64}$/;
const SAFE_DB_RE = /^orch_g0_v1_[a-f0-9]{32}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const HMAC_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const PROJECT_SOURCE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const hmacSha256Schema = z.string().regex(HMAC_RE) as z.ZodType<
  `hmac-sha256:${string}`
>;

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalize(value: unknown, seen = new Set<object>()): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError('canonical JSON rejects cyclic values');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('canonical JSON rejects sparse arrays');
        }
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === 'length') continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || descriptor.get || descriptor.set || !descriptor.enumerable) {
          throw new TypeError('canonical JSON rejects accessor or non-index array properties');
        }
      }
      return value.map((entry) => canonicalize(entry, seen));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON accepts only plain objects');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('canonical JSON rejects symbol keys');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null) as Record<string, CanonicalJson>;
    for (const key of Object.keys(descriptors).sort()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new TypeError('canonical JSON rejects prototype-sensitive keys');
      }
      const descriptor = descriptors[key]!;
      if (descriptor.get || descriptor.set || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('canonical JSON rejects accessors and non-enumerable properties');
      }
      output[key] = canonicalize(descriptor.value, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

/** Stable integrity hash. It is intentionally not treated as cleanup authority. */
export function hashCanonicalValue(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function decodeCanonicalBase64url(
  input: string,
  expectedLength: number,
): Buffer {
  if (!BASE64URL_RE.test(input)) throw new TypeError('invalid canonical base64url');
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.length !== expectedLength || bytes.toString('base64url') !== input) {
    throw new TypeError('invalid canonical base64url');
  }
  return bytes;
}

function parseEd25519PublicKey(input: string): KeyObject {
  const der = decodeCanonicalBase64url(input, 44);
  const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new TypeError('invalid evidence public key');
  const canonicalDer = publicKey.export({ format: 'der', type: 'spki' });
  if (
    !Buffer.isBuffer(canonicalDer)
    || canonicalDer.length !== der.length
    || !timingSafeEqual(canonicalDer, der)
  ) {
    throw new TypeError('non-canonical evidence public key');
  }
  return publicKey;
}

function validateMongoHosts(hosts: string): string[] {
  if (!hosts || /[\s\u0000-\u001f"'`#$]/.test(hosts)) {
    throw new TypeError('Mongo topology URI has an unsafe host list');
  }
  const canonicalHosts = hosts.split(',').map((host) => host.toLowerCase()).sort();
  for (const host of canonicalHosts) {
    const validIpv6 = /^\[[0-9a-f:.]+\](?::[0-9]{1,5})?$/.test(host);
    const validDns = /^[a-z0-9._-]+(?::[0-9]{1,5})?$/.test(host);
    if (!validIpv6 && !validDns) throw new TypeError('Mongo topology URI has an invalid host');
    const portMatch = host.match(/:([0-9]{1,5})$/);
    if (portMatch && Number(portMatch[1]) > 65_535) {
      throw new TypeError('Mongo topology URI has an invalid port');
    }
  }
  return canonicalHosts;
}

const topologyDescriptorSchema = z.object({
  scheme: z.enum(['mongodb', 'mongodb+srv']),
  endpointSetHash: z.string().regex(SHA256_RE),
  declaredReplicaSetHash: z.string().regex(SHA256_RE).optional(),
  tlsMode: z.enum(['ENABLED', 'DISABLED', 'UNSPECIFIED']),
  directConnection: z.enum(['ENABLED', 'DISABLED', 'UNSPECIFIED']),
}).strict();
export type SanitizedMongoTopologyDescriptor = z.infer<typeof topologyDescriptorSchema>;

/**
 * Convert a Mongo URI into a public descriptor containing no URI, userinfo,
 * database path, host names, replica-set name, fragment or arbitrary query.
 */
export function describeMongoTopologyUri(rawUri: string): SanitizedMongoTopologyDescriptor {
  const trimmed = rawUri.trim();
  const schemeMatch = /^(mongodb(?:\+srv)?):\/\//i.exec(trimmed);
  if (!schemeMatch) throw new TypeError('Mongo topology URI must use a supported scheme');
  const scheme = schemeMatch[1]!.toLowerCase() as 'mongodb' | 'mongodb+srv';
  const remainder = trimmed.slice(schemeMatch[0].length);
  const authorityEndCandidates = [remainder.indexOf('/'), remainder.indexOf('?'), remainder.indexOf('#')]
    .filter((index) => index >= 0);
  const authorityEnd = authorityEndCandidates.length > 0
    ? Math.min(...authorityEndCandidates)
    : remainder.length;
  const authority = remainder.slice(0, authorityEnd);
  const suffix = remainder.slice(authorityEnd);
  if (suffix.includes('@')) throw new TypeError('Mongo topology URI is malformed');
  const credentialSeparator = authority.lastIndexOf('@');
  const hosts = validateMongoHosts(authority.slice(credentialSeparator + 1));

  const queryIndex = trimmed.indexOf('?');
  const fragmentIndex = trimmed.indexOf('#');
  const rawQuery = queryIndex >= 0
    ? trimmed.slice(queryIndex + 1, fragmentIndex > queryIndex ? fragmentIndex : undefined)
    : '';
  let replicaSet: string | undefined;
  let tlsMode: SanitizedMongoTopologyDescriptor['tlsMode'] = 'UNSPECIFIED';
  let directConnection: SanitizedMongoTopologyDescriptor['directConnection'] = 'UNSPECIFIED';
  for (const [rawName, rawValue] of new URLSearchParams(rawQuery)) {
    const name = rawName.toLowerCase();
    if (name === 'replicaset' && /^[A-Za-z0-9._-]{1,128}$/.test(rawValue)) {
      replicaSet = rawValue;
    } else if ((name === 'tls' || name === 'ssl') && /^(true|false)$/i.test(rawValue)) {
      tlsMode = rawValue.toLowerCase() === 'true' ? 'ENABLED' : 'DISABLED';
    } else if (name === 'directconnection' && /^(true|false)$/i.test(rawValue)) {
      directConnection = rawValue.toLowerCase() === 'true' ? 'ENABLED' : 'DISABLED';
    }
  }

  return topologyDescriptorSchema.parse({
    scheme,
    endpointSetHash: hashCanonicalValue(hosts),
    ...(replicaSet ? { declaredReplicaSetHash: sha256Text(replicaSet) } : {}),
    tlsMode,
    directConnection,
  });
}

function privateMongoSecretCanaries(rawUri: string): string[] {
  const canaries = new Set<string>();
  const add = (value: string) => {
    if (value.length >= 4) canaries.add(value);
    try {
      const decoded = decodeURIComponent(value);
      if (decoded.length >= 4) canaries.add(decoded);
    } catch {
      // Malformed percent-encoding is rejected by topology parsing elsewhere.
    }
  };
  add(rawUri.trim());
  const schemeEnd = rawUri.indexOf('://');
  if (schemeEnd < 0) return [];
  const remainder = rawUri.slice(schemeEnd + 3);
  const authorityEndCandidates = [remainder.indexOf('/'), remainder.indexOf('?'), remainder.indexOf('#')]
    .filter((index) => index >= 0);
  const authorityEnd = authorityEndCandidates.length > 0
    ? Math.min(...authorityEndCandidates)
    : remainder.length;
  const authority = remainder.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    for (const part of authority.slice(0, at).split(':')) add(part);
  }
  const suffix = remainder.slice(authorityEnd);
  const pathEndCandidates = [suffix.indexOf('?'), suffix.indexOf('#')].filter((index) => index >= 0);
  const pathEnd = pathEndCandidates.length > 0 ? Math.min(...pathEndCandidates) : suffix.length;
  const databasePath = suffix.slice(0, pathEnd).replace(/^\/+/, '');
  if (databasePath) add(databasePath);

  const queryIndex = rawUri.indexOf('?');
  const fragmentIndex = rawUri.indexOf('#');
  const query = queryIndex >= 0
    ? rawUri.slice(queryIndex + 1, fragmentIndex > queryIndex ? fragmentIndex : undefined)
    : '';
  const publicTopologyKeys = new Set(['replicaset', 'tls', 'ssl', 'directconnection']);
  for (const [name, value] of new URLSearchParams(query)) {
    if (!publicTopologyKeys.has(name.toLowerCase())) add(value);
  }
  if (fragmentIndex >= 0) add(rawUri.slice(fragmentIndex + 1));
  return [...canaries];
}

const sourceIdentitySchema = z.object({
  commitSha: z.string().regex(COMMIT_SHA_RE),
  commitTreeSha: z.string().regex(COMMIT_SHA_RE),
  worktreeState: z.enum(['CLEAN', 'DIRTY']),
}).strict();
export type TestRuntimeSourceIdentity = z.infer<typeof sourceIdentitySchema>;

function sourceIdentityFromParentGateEnv(
  raw: string | undefined,
): TestRuntimeSourceIdentity | undefined {
  if (raw === undefined) return undefined;
  if (
    process.env.ORCHESTRATION_G0_GATE !== 'true'
    || !process.env.ORCHESTRATION_G0_PARENT_CHALLENGE
  ) {
    throw new TestRuntimeStateError(
      'parent source identity is accepted only inside the strict challenged gate',
    );
  }
  if (Buffer.byteLength(raw, 'utf8') > 4 * 1024) {
    throw new TestRuntimeStateError('parent source identity exceeds the fixed environment limit');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new TestRuntimeStateError('parent source identity is not valid JSON');
  }
  return sourceIdentitySchema.parse(candidate);
}

export const testRuntimeEffectiveConfigSchema = z.object({
  executionProfile: z.literal('DETERMINISTIC'),
  runtimeKind: z.enum(['CONTRACT_CHECK', 'DIRECT', 'LOOPBACK_HTTP', 'BACKGROUND_SERVICE']),
  storeKind: z.literal('MONGODB_REPLICA_SET'),
  workerFixtureIds: z.array(z.enum(['OK', 'INVALID_OUTPUT'])).max(8),
  laneCount: z.number().int().min(1).max(64).optional(),
  retryLimit: z.number().int().min(0).max(100).optional(),
  requestedPort: z.literal(0).optional(),
  laneTickMs: z.number().int().min(1).max(60_000).optional(),
  reconcileTickMs: z.number().int().min(1).max(60_000).optional(),
}).strict();
export type TestRuntimeEffectiveConfig = z.infer<typeof testRuntimeEffectiveConfigSchema>;

/** Resolve pinned source identity without a shell or network-enabled runner. */
export function readGitSourceIdentity(cwd = process.cwd()): TestRuntimeSourceIdentity {
  const run = (args: readonly string[]) => execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 1024 * 1024,
  }).trim().toLowerCase();
  return sourceIdentitySchema.parse({
    commitSha: run(['rev-parse', 'HEAD']),
    commitTreeSha: run(['rev-parse', 'HEAD^{tree}']),
    worktreeState: run(['status', '--porcelain=v1']) === '' ? 'CLEAN' : 'DIRTY',
  });
}

const resourcesSchema = z.object({
  mongoDatabases: z.array(z.string().regex(SAFE_DB_RE)).length(1),
  runtimeResources: testRuntimeResourceContractSchema,
  artifactEvidence: z.object({
    retentionMode: z.literal('SIGNED_BUNDLE_WITH_PARENT_READBACK'),
    transformPolicyVersion: z.literal(RAW_EVIDENCE_TRANSFORM_POLICY_VERSION),
    requiredArtifactIds: z.tuple([
      z.literal('normalized-summary'),
      z.literal('stdout'),
      z.literal('stderr'),
      z.literal('trace-event-log'),
      z.literal('db-snapshot'),
    ]),
    totalMaxBytes: z.literal(RAW_EVIDENCE_TOTAL_MAX_BYTES),
  }).strict(),
}).strict();

const evidenceVerifierSchema = z.object({
  schemaVersion: z.literal(TEST_EVIDENCE_VERIFIER_VERSION),
  algorithm: z.literal('Ed25519'),
  keyId: z.string().regex(SHA256_RE),
  publicKeySpkiDerBase64url: z.string().regex(BASE64URL_RE).length(59),
}).strict().superRefine((value, context) => {
  try {
    const key = parseEd25519PublicKey(value.publicKeySpkiDerBase64url);
    const der = key.export({ format: 'der', type: 'spki' });
    if (!Buffer.isBuffer(der) || value.keyId !== sha256Bytes(der)) {
      context.addIssue({ code: 'custom', path: ['keyId'], message: 'keyId does not match public key' });
    }
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['publicKeySpkiDerBase64url'],
      message: 'invalid Ed25519 SPKI key',
    });
  }
});
type TestEvidenceVerifierV1 = z.infer<typeof evidenceVerifierSchema>;

function evidenceVerifierFor(publicKey: KeyObject): TestEvidenceVerifierV1 {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(der)) throw new TypeError('evidence public key export failed');
  return evidenceVerifierSchema.parse({
    schemaVersion: TEST_EVIDENCE_VERIFIER_VERSION,
    algorithm: 'Ed25519',
    keyId: sha256Bytes(der),
    publicKeySpkiDerBase64url: der.toString('base64url'),
  });
}

const unsignedManifestSchema = z.object({
  schemaVersion: z.literal(TEST_RUNTIME_MANIFEST_VERSION),
  scope: z.literal('MONGO_ARTIFACT_AND_RUNTIME_RESOURCE_FOUNDATION'),
  suiteId: z.string().regex(SAFE_ID_RE),
  runId: z.string().regex(RUN_ID_RE),
  dbName: z.string().regex(SAFE_DB_RE),
  topology: topologyDescriptorSchema,
  source: sourceIdentitySchema,
  effectiveConfig: testRuntimeEffectiveConfigSchema,
  configHash: z.string().regex(SHA256_RE),
  parentChallengeHash: z.string().regex(SHA256_RE).optional(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  createdAt: z.string().datetime(),
  resources: resourcesSchema,
  evidenceVerifier: evidenceVerifierSchema,
}).strict();

export const testRuntimeManifestV2Schema = unsignedManifestSchema.extend({
  manifestHash: z.string().regex(SHA256_RE),
}).strict();
export type TestRuntimeManifestV2 = z.infer<typeof testRuntimeManifestV2Schema>;
/** V3 primary names; V2 aliases above remain source-compatible for older checks. */
export const testRuntimeManifestV3Schema = testRuntimeManifestV2Schema;
export type TestRuntimeManifestV3 = TestRuntimeManifestV2;

export interface CreateTestRuntimeOwnerInput {
  suiteId: string;
  topologyUri: string;
  effectiveConfig: TestRuntimeEffectiveConfig;
  seed?: number;
  createdAt?: Date;
}

export interface CreateTestRuntimeOwnerForContractCheckInput
  extends CreateTestRuntimeOwnerInput {
  source: TestRuntimeSourceIdentity;
  parentChallenge?: string;
  runtimeResources?: TestRuntimeResourceContract;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: string[];
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
}

function manifestUnsigned(manifest: TestRuntimeManifestV2): Omit<TestRuntimeManifestV2, 'manifestHash'> {
  const { manifestHash: _manifestHash, ...unsigned } = manifest;
  return unsigned;
}

export function validateTestRuntimeManifest(input: unknown): ValidationResult<TestRuntimeManifestV2> {
  const parsed = testRuntimeManifestV2Schema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const manifest = parsed.data;
  const issues: string[] = [];
  const token = manifest.runId.slice(RUN_ID_PREFIX.length);
  if (!RUN_TOKEN_RE.test(token) || manifest.dbName !== `${TEST_RUNTIME_DB_PREFIX}${token}`) {
    issues.push('dbName is not the exact internally derived database');
  }
  if (
    manifest.resources.mongoDatabases.length !== 1
    || manifest.resources.mongoDatabases[0] !== manifest.dbName
  ) {
    issues.push('resources.mongoDatabases must contain only the owned database');
  }
  if (hashCanonicalValue(manifest.effectiveConfig) !== manifest.configHash) {
    issues.push('configHash does not match the sanitized effective config');
  }
  if (
    canonicalJson(manifest.resources.artifactEvidence.requiredArtifactIds)
    !== canonicalJson(REQUIRED_RAW_EVIDENCE.map((entry) => entry.artifactId))
  ) {
    issues.push('artifact evidence profile does not match the fixed required set');
  }
  if (
    manifest.resources.runtimeResources.mode === 'PARENT_GUARDED_V1'
    && manifest.parentChallengeHash === undefined
  ) {
    issues.push('parent-guarded runtime resources require a bound parent challenge');
  }
  if (hashCanonicalValue(manifestUnsigned(manifest)) !== manifest.manifestHash) {
    issues.push('manifestHash does not match manifest contents');
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: manifest, issues: [] };
}

export class TestRuntimeManifestError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid test runtime manifest: ${issues.join('; ')}`);
    this.name = 'TestRuntimeManifestError';
  }
}

export function parseTestRuntimeManifest(input: unknown): TestRuntimeManifestV2 {
  const validation = validateTestRuntimeManifest(input);
  if (!validation.ok || !validation.value) throw new TestRuntimeManifestError(validation.issues);
  return validation.value;
}

export class ForeignTestResourceError extends Error {
  constructor() {
    super('refusing operation on a non-owned test resource');
    this.name = 'ForeignTestResourceError';
  }
}

export class TestRuntimeTopologyError extends Error {
  constructor() {
    super('test runtime requires the expected writable Mongo replica-set topology');
    this.name = 'TestRuntimeTopologyError';
  }
}

export class TestRuntimeOwnershipError extends Error {
  constructor() {
    super('Mongo test ownership proof is absent, invalid or stale');
    this.name = 'TestRuntimeOwnershipError';
  }
}

export class TestRuntimeCleanupLeakError extends Error {
  constructor() {
    super('cleanup verification found an owned Mongo database still present');
    this.name = 'TestRuntimeCleanupLeakError';
  }
}

export class TestRuntimeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestRuntimeStateError';
  }
}

interface MongoTopologyIdentity {
  setNameHash: `sha256:${string}`;
  memberSetHash: `sha256:${string}`;
  maxWireVersion: number;
}

const topologyIdentitySchema = z.object({
  setNameHash: z.string().regex(SHA256_RE),
  memberSetHash: z.string().regex(SHA256_RE),
  maxWireVersion: z.number().int().nonnegative(),
}).strict();

const ownerMarkerSchema = z.object({
  _id: z.literal(OWNER_MARKER_ID),
  schemaVersion: z.literal(TEST_RUNTIME_OWNER_MARKER_VERSION),
  runId: z.string().regex(RUN_ID_RE),
  dbName: z.string().regex(SAFE_DB_RE),
  topologyFingerprint: z.string().regex(SHA256_RE),
  collectionEpochFingerprint: z.string().regex(SHA256_RE),
  createdAt: z.string().datetime(),
  proof: z.string().regex(HMAC_RE),
  state: z.enum(['ACTIVE', 'CLEANUP_CLAIMED', 'RECLAIM_CLAIMED']),
  cleanupClaimedAt: z.string().datetime().optional(),
  reclaimClaimIdHash: z.string().regex(SHA256_RE).optional(),
  reclaimFence: z.number().int().min(1).optional(),
  reclaimClaimedAt: z.string().datetime().optional(),
}).strict().superRefine((marker, context) => {
  if (marker.state === 'ACTIVE') {
    if (marker.cleanupClaimedAt !== undefined) {
      context.addIssue({ code: 'custom', path: ['cleanupClaimedAt'], message: 'ACTIVE marker cannot be cleanup-claimed' });
    }
    if (
      marker.reclaimClaimIdHash !== undefined
      || marker.reclaimFence !== undefined
      || marker.reclaimClaimedAt !== undefined
    ) {
      context.addIssue({ code: 'custom', path: ['reclaimClaimIdHash'], message: 'ACTIVE marker cannot be reclaim-claimed' });
    }
  } else if (marker.state === 'CLEANUP_CLAIMED') {
    if (marker.cleanupClaimedAt === undefined) {
      context.addIssue({ code: 'custom', path: ['cleanupClaimedAt'], message: 'cleanup-claimed marker needs timestamp' });
    }
    if (
      marker.reclaimClaimIdHash !== undefined
      || marker.reclaimFence !== undefined
      || marker.reclaimClaimedAt !== undefined
    ) {
      context.addIssue({ code: 'custom', path: ['reclaimClaimIdHash'], message: 'cleanup claim cannot carry a reclaim claim' });
    }
  } else {
    if (marker.cleanupClaimedAt !== undefined) {
      context.addIssue({ code: 'custom', path: ['cleanupClaimedAt'], message: 'reclaim claim cannot carry a cleanup claim' });
    }
    if (
      marker.reclaimClaimIdHash === undefined
      || marker.reclaimFence === undefined
      || marker.reclaimClaimedAt === undefined
    ) {
      context.addIssue({ code: 'custom', path: ['reclaimClaimIdHash'], message: 'reclaim-claimed marker needs claim identity hash and timestamp' });
    }
  }
});
export type MongoOwnerMarker = z.infer<typeof ownerMarkerSchema>;

export const mongoOwnerAllocationSchema = z.object({
  schemaVersion: z.literal(MONGO_OWNER_ALLOCATION_VERSION),
  suiteId: z.string().regex(SAFE_ID_RE),
  parentChallengeHash: z.string().regex(SHA256_RE),
  runId: z.string().regex(RUN_ID_RE),
  dbName: z.string().regex(SAFE_DB_RE),
  topologyDescriptorHash: z.string().regex(SHA256_RE),
  topologyFingerprint: z.string().regex(SHA256_RE),
  createdAt: z.string().datetime(),
  cleanupCapabilityBase64url: z.string().regex(BASE64URL_RE).length(43),
  collectionProof: hmacSha256Schema,
}).strict().superRefine((allocation, context) => {
  if (
    allocation.runId.slice(RUN_ID_PREFIX.length)
    !== allocation.dbName.slice(TEST_RUNTIME_DB_PREFIX.length)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['dbName'],
      message: 'Mongo allocation run and database tokens must match',
    });
  }
});
export type MongoOwnerAllocationV1 = z.infer<typeof mongoOwnerAllocationSchema>;

interface MongoDatabaseOps {
  observeTopology(): Promise<MongoTopologyIdentity>;
  listCollectionNames(): Promise<string[]>;
  createOwnerCollection(collectionProof: `hmac-sha256:${string}`): Promise<`sha256:${string}`>;
  ownerCollectionEpochFingerprint(
    collectionProof: `hmac-sha256:${string}`,
  ): Promise<`sha256:${string}`>;
  createOwnerMarker(marker: MongoOwnerMarker): Promise<void>;
  readOwnerMarker(): Promise<unknown | null>;
  claimOwnerMarker(marker: MongoOwnerMarker): Promise<boolean>;
  databaseExists(): Promise<boolean>;
  dropDatabase(): Promise<void>;
}

declare const mongoHandleBrand: unique symbol;
export interface MongoTestDatabaseHandle {
  readonly databaseName: string;
  readonly [mongoHandleBrand]: true;
}

const mongoHandleOps = new WeakMap<object, MongoDatabaseOps>();
const mongoHandleDatabases = new WeakMap<object, Db>();

function registerMongoHandle(databaseName: string, ops: MongoDatabaseOps): MongoTestDatabaseHandle {
  const handle = Object.freeze({ databaseName }) as MongoTestDatabaseHandle;
  mongoHandleOps.set(handle, ops);
  return handle;
}

function exactMongoHandle(handle: MongoTestDatabaseHandle, expectedDbName: string): MongoDatabaseOps {
  const ops = mongoHandleOps.get(handle);
  if (!ops || handle.databaseName !== expectedDbName || !SAFE_DB_RE.test(handle.databaseName)) {
    throw new ForeignTestResourceError();
  }
  return ops;
}

function topologyIdentityFromHello(helloInput: unknown): MongoTopologyIdentity {
  if (!helloInput || typeof helloInput !== 'object') throw new TestRuntimeTopologyError();
  const hello = helloInput as Record<string, unknown>;
  if (
    hello.isWritablePrimary !== true
    || typeof hello.setName !== 'string'
    || !/^[A-Za-z0-9._-]{1,128}$/.test(hello.setName)
    || !Number.isInteger(hello.maxWireVersion)
    || Number(hello.maxWireVersion) < 0
  ) {
    throw new TestRuntimeTopologyError();
  }
  const members = [
    ...(Array.isArray(hello.hosts) ? hello.hosts : []),
    ...(Array.isArray(hello.passives) ? hello.passives : []),
    ...(Array.isArray(hello.arbiters) ? hello.arbiters : []),
  ];
  if (members.length === 0 && typeof hello.me === 'string') members.push(hello.me);
  if (
    members.length === 0
    || members.some((member) => typeof member !== 'string' || member.length === 0)
  ) {
    throw new TestRuntimeTopologyError();
  }
  const canonicalMembers = [...new Set(members as string[])].map((member) => member.toLowerCase()).sort();
  return topologyIdentitySchema.parse({
    setNameHash: sha256Text(hello.setName),
    memberSetHash: hashCanonicalValue(canonicalMembers),
    maxWireVersion: Number(hello.maxWireVersion),
  }) as MongoTopologyIdentity;
}

function ownerCollectionValidator(collectionProof: `hmac-sha256:${string}`) {
  return {
    $jsonSchema: {
      bsonType: 'object',
      description: `${TEST_RUNTIME_OWNER_COLLECTION_VERSION}:${collectionProof}`,
    },
  } as const;
}

function ownerCollectionEpochFromInfo(
  input: unknown,
  expectedCollectionProof: `hmac-sha256:${string}`,
): `sha256:${string}` {
  if (!input || typeof input !== 'object') throw new TestRuntimeOwnershipError();
  if ((input as Record<string, unknown>).type !== 'collection') {
    throw new TestRuntimeOwnershipError();
  }
  const options = (input as Record<string, unknown>).options;
  if (!options || typeof options !== 'object') throw new TestRuntimeOwnershipError();
  const optionRecord = options as Record<string, unknown>;
  if (
    optionRecord.validationLevel !== 'strict'
    || optionRecord.validationAction !== 'error'
  ) {
    throw new TestRuntimeOwnershipError();
  }
  const validator = optionRecord.validator;
  try {
    if (
      canonicalJson(validator)
      !== canonicalJson(ownerCollectionValidator(expectedCollectionProof))
    ) {
      throw new TestRuntimeOwnershipError();
    }
  } catch (error) {
    if (error instanceof TestRuntimeOwnershipError) throw error;
    throw new TestRuntimeOwnershipError();
  }
  const info = (input as Record<string, unknown>).info;
  if (!info || typeof info !== 'object') throw new TestRuntimeOwnershipError();
  const uuid = (info as Record<string, unknown>).uuid;
  if (!uuid || typeof uuid !== 'object' || typeof (uuid as { toString?: unknown }).toString !== 'function') {
    throw new TestRuntimeOwnershipError();
  }
  const rawEpoch = (uuid as { toString(encoding: 'hex'): string }).toString('hex').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(rawEpoch)) throw new TestRuntimeOwnershipError();
  return sha256Text(rawEpoch);
}

/**
 * Bind an exact MongoClient/Db pair. The returned handle contains no callbacks;
 * its operations live in a private WeakMap, so a structural lookalike cannot
 * redirect cleanup to another target.
 */
export function bindMongoTestDatabase(client: MongoClient, db: Db): MongoTestDatabaseHandle {
  const dbName = db.databaseName;
  if (db.client !== client || !SAFE_DB_RE.test(dbName)) throw new ForeignTestResourceError();
  const collection = db.collection<MongoOwnerMarker>(TEST_RUNTIME_OWNER_COLLECTION);
  async function ownerCollectionEpochFingerprint(
    collectionProof: `hmac-sha256:${string}`,
  ): Promise<`sha256:${string}`> {
    const rows = await db.listCollections(
      { name: TEST_RUNTIME_OWNER_COLLECTION },
      { nameOnly: false },
    ).toArray();
    if (rows.length !== 1 || rows[0]?.name !== TEST_RUNTIME_OWNER_COLLECTION) {
      throw new TestRuntimeOwnershipError();
    }
    return ownerCollectionEpochFromInfo(rows[0], collectionProof);
  }
  const handle = registerMongoHandle(dbName, {
    async observeTopology() {
      const hello = await client.db('admin').command({ hello: 1 });
      return topologyIdentityFromHello(hello);
    },
    async listCollectionNames() {
      const rows = await db.listCollections({}, { nameOnly: true }).toArray();
      return rows.map((row) => row.name).sort();
    },
    async createOwnerCollection(collectionProof) {
      await db.createCollection(TEST_RUNTIME_OWNER_COLLECTION, {
        validator: ownerCollectionValidator(collectionProof),
        validationLevel: 'strict',
        validationAction: 'error',
        writeConcern: { w: 'majority' },
      });
      return ownerCollectionEpochFingerprint(collectionProof);
    },
    ownerCollectionEpochFingerprint,
    async createOwnerMarker(marker) {
      await collection.insertOne(marker, { writeConcern: { w: 'majority' } });
    },
    async readOwnerMarker() {
      return collection.findOne({ _id: OWNER_MARKER_ID });
    },
    async claimOwnerMarker(marker) {
      const result = await collection.updateOne(
        {
          _id: OWNER_MARKER_ID,
          schemaVersion: marker.schemaVersion,
          runId: marker.runId,
          dbName: marker.dbName,
          topologyFingerprint: marker.topologyFingerprint,
          createdAt: marker.createdAt,
          proof: marker.proof,
          state: 'ACTIVE',
          cleanupClaimedAt: { $exists: false },
        },
        [{
          $set: {
            state: 'CLEANUP_CLAIMED',
            cleanupClaimedAt: {
              $dateToString: {
                date: '$$NOW',
                format: '%Y-%m-%dT%H:%M:%S.%LZ',
              },
            },
          },
        }],
        { writeConcern: { w: 'majority' } },
      );
      return result.modifiedCount === 1;
    },
    async databaseExists() {
      const result = await client.db('admin').command({
        listDatabases: 1,
        nameOnly: true,
        filter: { name: dbName },
      }) as { databases?: Array<{ name?: unknown }> };
      if (
        !Array.isArray(result.databases)
        || result.databases.some((entry) => !entry || typeof entry.name !== 'string')
      ) {
        throw new TestRuntimeStateError('Mongo database absence could not be proven');
      }
      return result.databases.some((entry) => entry.name === dbName);
    },
    async dropDatabase() {
      await db.dropDatabase({ writeConcern: { w: 'majority' } });
    },
  });
  mongoHandleDatabases.set(handle, db);
  return handle;
}

export const TEST_RUNTIME_FAULT_POINTS = [
  'afterMongoOwnerCollection',
  'beforeMongoOwnerMarker',
  'afterMongoOwnerMarker',
  'beforeMongoCleanupClaim',
  'afterMongoCleanupClaim',
  'afterMongoDropBeforeVerification',
] as const;
export type TestRuntimeFaultPoint = (typeof TEST_RUNTIME_FAULT_POINTS)[number];

export interface TestRuntimeFaultContext {
  runId: string;
  dbName: string;
}

export type TestRuntimeFaultHooks = Partial<Record<
  TestRuntimeFaultPoint,
  (context: TestRuntimeFaultContext) => void | Promise<void>
>>;

function validateFaultHooks(hooks: TestRuntimeFaultHooks | undefined): void {
  if (!hooks) return;
  const allowed = new Set<string>(TEST_RUNTIME_FAULT_POINTS);
  for (const [key, value] of Object.entries(hooks)) {
    if (!allowed.has(key) || typeof value !== 'function') {
      throw new TestRuntimeStateError('unknown or invalid test-runtime fault hook');
    }
  }
}

const ownershipReceiptSchema = z.object({
  schemaVersion: z.literal(TEST_RUNTIME_OWNERSHIP_RECEIPT_VERSION),
  resourceKind: z.literal('mongoDatabase'),
  resourceId: z.string().regex(SAFE_DB_RE),
  runId: z.string().regex(RUN_ID_RE),
  topologyFingerprint: z.string().regex(SHA256_RE),
  collectionEpochFingerprint: z.string().regex(SHA256_RE),
  ownershipProofHash: z.string().regex(SHA256_RE),
  ownedAt: z.string().datetime(),
}).strict();
export type MongoOwnershipReceiptV1 = z.infer<typeof ownershipReceiptSchema>;

export const cleanupVerificationV1Schema = z.object({
  schemaVersion: z.literal(TEST_CLEANUP_VERIFICATION_VERSION),
  resourceKind: z.literal('mongoDatabase'),
  resourceId: z.string().regex(SAFE_DB_RE),
  runId: z.string().regex(RUN_ID_RE),
  topologyFingerprint: z.string().regex(SHA256_RE),
  collectionEpochFingerprint: z.string().regex(SHA256_RE),
  outcome: z.enum(['CLEANED', 'CLEANED_AFTER_AMBIGUOUS_DROP', 'ALREADY_ABSENT']),
  verifiedAbsent: z.literal(true),
  checkedAt: z.string().datetime(),
}).strict();
export type CleanupVerificationV1 = z.infer<typeof cleanupVerificationV1Schema>;

function markerHmacPayload(marker: Pick<
  MongoOwnerMarker,
  'schemaVersion' | 'runId' | 'dbName' | 'topologyFingerprint' | 'collectionEpochFingerprint' | 'createdAt'
>): Record<string, string> {
  return {
    schemaVersion: marker.schemaVersion,
    runId: marker.runId,
    dbName: marker.dbName,
    topologyFingerprint: marker.topologyFingerprint,
    collectionEpochFingerprint: marker.collectionEpochFingerprint,
    createdAt: marker.createdAt,
  };
}

function collectionHmacPayload(input: {
  runId: string;
  dbName: string;
  topologyFingerprint: string;
  createdAt: string;
}): Record<string, string> {
  return {
    schemaVersion: TEST_RUNTIME_OWNER_COLLECTION_VERSION,
    runId: input.runId,
    dbName: input.dbName,
    topologyFingerprint: input.topologyFingerprint,
    createdAt: input.createdAt,
  };
}

function createMarkerProof(capability: Buffer, marker: ReturnType<typeof markerHmacPayload>): `hmac-sha256:${string}` {
  return `hmac-sha256:${createHmac('sha256', capability).update(canonicalJson(marker)).digest('hex')}`;
}

function proofsEqual(left: string, right: string): boolean {
  if (!HMAC_RE.test(left) || !HMAC_RE.test(right)) return false;
  const leftBytes = Buffer.from(left.slice('hmac-sha256:'.length), 'hex');
  const rightBytes = Buffer.from(right.slice('hmac-sha256:'.length), 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function topologyFingerprint(identity: MongoTopologyIdentity): `sha256:${string}` {
  return hashCanonicalValue(topologyIdentitySchema.parse(identity));
}

function allocationCapability(allocation: MongoOwnerAllocationV1): Buffer {
  const capability = Buffer.from(allocation.cleanupCapabilityBase64url, 'base64url');
  if (
    capability.byteLength !== 32
    || capability.toString('base64url') !== allocation.cleanupCapabilityBase64url
  ) {
    throw new TestRuntimeOwnershipError();
  }
  const expectedCollectionProof = createMarkerProof(
    capability,
    collectionHmacPayload({
      runId: allocation.runId,
      dbName: allocation.dbName,
      topologyFingerprint: allocation.topologyFingerprint,
      createdAt: allocation.createdAt,
    }),
  );
  if (!proofsEqual(expectedCollectionProof, allocation.collectionProof)) {
    throw new TestRuntimeOwnershipError();
  }
  return capability;
}

export function createMongoOwnerAllocation(input: {
  suiteId: string;
  parentChallenge: string;
  topologyUri: string;
  topologyHello: unknown;
  createdAt?: Date;
}): MongoOwnerAllocationV1 {
  if (!PARENT_CHALLENGE_RE.test(input.parentChallenge)) {
    throw new TypeError('Mongo owner allocation requires a fresh parent challenge');
  }
  const topology = describeMongoTopologyUri(input.topologyUri);
  const fingerprint = topologyFingerprint(topologyIdentityFromHello(input.topologyHello));
  const createdAtDate = input.createdAt ?? new Date();
  if (!Number.isFinite(createdAtDate.getTime())) {
    throw new TypeError('Mongo owner allocation createdAt must be finite');
  }
  const token = randomBytes(16).toString('hex');
  const capability = randomBytes(32);
  const runId = `${RUN_ID_PREFIX}${token}`;
  const dbName = `${TEST_RUNTIME_DB_PREFIX}${token}`;
  return mongoOwnerAllocationSchema.parse({
    schemaVersion: MONGO_OWNER_ALLOCATION_VERSION,
    suiteId: input.suiteId,
    parentChallengeHash: sha256Text(input.parentChallenge),
    runId,
    dbName,
    topologyDescriptorHash: hashCanonicalValue(topology),
    topologyFingerprint: fingerprint,
    createdAt: createdAtDate.toISOString(),
    cleanupCapabilityBase64url: capability.toString('base64url'),
    collectionProof: createMarkerProof(
      capability,
      collectionHmacPayload({
        runId,
        dbName,
        topologyFingerprint: fingerprint,
        createdAt: createdAtDate.toISOString(),
      }),
    ),
  });
}

export function mongoTopologyFingerprintFromHello(
  hello: unknown,
): `sha256:${string}` {
  return topologyFingerprint(topologyIdentityFromHello(hello));
}

export function mongoOwnerCollectionEpochFingerprint(
  collectionInfo: unknown,
  collectionProof: `hmac-sha256:${string}`,
): `sha256:${string}` {
  return ownerCollectionEpochFromInfo(collectionInfo, collectionProof);
}

function assertTopologyMatchesManifest(
  manifest: TestRuntimeManifestV2,
  identity: MongoTopologyIdentity,
): `sha256:${string}` {
  if (
    manifest.topology.scheme !== 'mongodb'
    || manifest.topology.endpointSetHash !== identity.memberSetHash
    || (
      manifest.topology.declaredReplicaSetHash
      && manifest.topology.declaredReplicaSetHash !== identity.setNameHash
    )
  ) {
    throw new TestRuntimeTopologyError();
  }
  return topologyFingerprint(identity);
}

function parseAndVerifyMarker(
  input: unknown,
  expected: MongoOwnerMarker,
  capability: Buffer,
): MongoOwnerMarker {
  const parsed = ownerMarkerSchema.safeParse(input);
  if (!parsed.success) throw new TestRuntimeOwnershipError();
  const marker = parsed.data;
  const expectedProof = createMarkerProof(capability, markerHmacPayload(marker));
  if (
    marker._id !== expected._id
    || marker.schemaVersion !== expected.schemaVersion
    || marker.runId !== expected.runId
    || marker.dbName !== expected.dbName
    || marker.topologyFingerprint !== expected.topologyFingerprint
    || marker.collectionEpochFingerprint !== expected.collectionEpochFingerprint
    || marker.createdAt !== expected.createdAt
    || !proofsEqual(marker.proof, expected.proof)
    || !proofsEqual(marker.proof, expectedProof)
  ) {
    throw new TestRuntimeOwnershipError();
  }
  return marker;
}

export function verifyMongoOwnerMarkerForAllocation(input: {
  marker: unknown;
  allocation: MongoOwnerAllocationV1;
  collectionEpochFingerprint: `sha256:${string}`;
}): MongoOwnerMarker {
  const allocation = mongoOwnerAllocationSchema.parse(input.allocation);
  const capability = allocationCapability(allocation);
  const markerBase = {
    _id: OWNER_MARKER_ID,
    schemaVersion: TEST_RUNTIME_OWNER_MARKER_VERSION,
    runId: allocation.runId,
    dbName: allocation.dbName,
    topologyFingerprint: allocation.topologyFingerprint,
    collectionEpochFingerprint: input.collectionEpochFingerprint,
    createdAt: allocation.createdAt,
  } as const;
  const expected = ownerMarkerSchema.parse({
    ...markerBase,
    proof: createMarkerProof(capability, markerHmacPayload(markerBase)),
    state: 'ACTIVE',
  });
  return parseAndVerifyMarker(input.marker, expected, capability);
}

export function createReclaimClaimedMongoOwnerMarker(input: {
  allocation: MongoOwnerAllocationV1;
  collectionEpochFingerprint: `sha256:${string}`;
  reclaimClaimId: string;
  reclaimFence: number;
  reclaimClaimedAt: Date;
}): MongoOwnerMarker {
  const allocation = mongoOwnerAllocationSchema.parse(input.allocation);
  const capability = allocationCapability(allocation);
  const markerBase = {
    _id: OWNER_MARKER_ID,
    schemaVersion: TEST_RUNTIME_OWNER_MARKER_VERSION,
    runId: allocation.runId,
    dbName: allocation.dbName,
    topologyFingerprint: allocation.topologyFingerprint,
    collectionEpochFingerprint: input.collectionEpochFingerprint,
    createdAt: allocation.createdAt,
  } as const;
  return ownerMarkerSchema.parse({
    ...markerBase,
    proof: createMarkerProof(capability, markerHmacPayload(markerBase)),
    state: 'RECLAIM_CLAIMED',
    reclaimClaimIdHash: hashCanonicalValue(input.reclaimClaimId),
    reclaimFence: input.reclaimFence,
    reclaimClaimedAt: input.reclaimClaimedAt.toISOString(),
  });
}

export function parseMongoOwnerMarker(input: unknown): MongoOwnerMarker {
  return ownerMarkerSchema.parse(input);
}

export interface ClaimMongoDatabaseOptions {
  faultHooks?: TestRuntimeFaultHooks;
}

export interface CleanupMongoDatabaseOptions {
  faultHooks?: TestRuntimeFaultHooks;
  now?: () => Date;
}

export interface TestRuntimeOwner {
  readonly manifest: TestRuntimeManifestV2;
  readonly databaseName: string;
  claimMongoDatabase(
    handle: MongoTestDatabaseHandle,
    options?: ClaimMongoDatabaseOptions,
  ): Promise<MongoOwnershipReceiptV1>;
  cleanupMongoDatabase(
    handle: MongoTestDatabaseHandle,
    options?: CleanupMongoDatabaseOptions,
  ): Promise<CleanupVerificationV1>;
  captureMongoDatabaseSnapshot(handle: MongoTestDatabaseHandle): Promise<void>;
  createEvidenceReport(input: CreateOwnerTestEvidenceReportInput): TestEvidenceReportV2;
}

/**
 * Mint an opaque owner. The cleanup capability never enters the manifest,
 * evidence, logs or returned receipts.
 */
function createTestRuntimeOwnerWithSource(
  input: CreateTestRuntimeOwnerForContractCheckInput,
  parentAllocation?: MongoOwnerAllocationV1,
  requireParentAllocation = false,
): TestRuntimeOwner {
  const effectiveConfig = testRuntimeEffectiveConfigSchema.parse(input.effectiveConfig);
  const runtimeResources = testRuntimeResourceContractSchema.parse(
    input.runtimeResources
      ?? parseRuntimeResourceContractEnv(
        process.env[TEST_RUNTIME_RESOURCE_CONTRACT_ENV],
      ),
  );
  const allocation = parentAllocation === undefined
    ? undefined
    : mongoOwnerAllocationSchema.parse(parentAllocation);
  const token = allocation?.runId.slice(RUN_ID_PREFIX.length)
    ?? randomBytes(16).toString('hex');
  const runId = allocation?.runId ?? `${RUN_ID_PREFIX}${token}`;
  const dbName = allocation?.dbName ?? `${TEST_RUNTIME_DB_PREFIX}${token}`;
  const cleanupCapability = allocation === undefined
    ? randomBytes(32)
    : allocationCapability(allocation);
  const snapshotPseudonymKey = randomBytes(32);
  const evidenceKeyPair = generateKeyPairSync('ed25519');
  const secretCanaries = [
    ...privateMongoSecretCanaries(input.topologyUri),
    ...(allocation
      ? [
          allocation.cleanupCapabilityBase64url,
          allocation.collectionProof,
        ]
      : []),
    ...(process.env[TEST_RUNTIME_WORKSPACE_ENV]
      ? [process.env[TEST_RUNTIME_WORKSPACE_ENV]!]
      : []),
  ];
  const parentChallenge = input.parentChallenge;
  if (parentChallenge !== undefined && !PARENT_CHALLENGE_RE.test(parentChallenge)) {
    throw new TypeError('invalid parent gate challenge');
  }
  if (runtimeResources.mode === 'PARENT_GUARDED_V1' && parentChallenge === undefined) {
    throw new TypeError('parent-guarded runtime resources require a fresh parent challenge');
  }
  if (
    requireParentAllocation
    && runtimeResources.mode === 'PARENT_GUARDED_V1'
    && allocation === undefined
  ) {
    throw new TestRuntimeOwnershipError();
  }
  if (
    allocation
    && (
      runtimeResources.mode !== 'PARENT_GUARDED_V1'
      || parentChallenge === undefined
      || allocation.suiteId !== input.suiteId
      || allocation.parentChallengeHash !== sha256Text(parentChallenge)
      || allocation.topologyDescriptorHash
        !== hashCanonicalValue(describeMongoTopologyUri(input.topologyUri))
      || (
        input.createdAt !== undefined
        && input.createdAt.toISOString() !== allocation.createdAt
      )
    )
  ) {
    throw new TestRuntimeOwnershipError();
  }
  const unsigned = unsignedManifestSchema.parse({
    schemaVersion: TEST_RUNTIME_MANIFEST_VERSION,
    scope: 'MONGO_ARTIFACT_AND_RUNTIME_RESOURCE_FOUNDATION',
    suiteId: input.suiteId,
    runId,
    dbName,
    topology: describeMongoTopologyUri(input.topologyUri),
    source: sourceIdentitySchema.parse(input.source),
    effectiveConfig,
    configHash: hashCanonicalValue(effectiveConfig),
    ...(parentChallenge ? { parentChallengeHash: sha256Text(parentChallenge) } : {}),
    seed: input.seed ?? randomBytes(4).readUInt32BE(0),
    createdAt: allocation?.createdAt ?? (input.createdAt ?? new Date()).toISOString(),
    resources: {
      mongoDatabases: [dbName],
      runtimeResources,
      artifactEvidence: {
        retentionMode: 'SIGNED_BUNDLE_WITH_PARENT_READBACK',
        transformPolicyVersion: RAW_EVIDENCE_TRANSFORM_POLICY_VERSION,
        requiredArtifactIds: REQUIRED_RAW_EVIDENCE.map((entry) => entry.artifactId),
        totalMaxBytes: RAW_EVIDENCE_TOTAL_MAX_BYTES,
      },
    },
    evidenceVerifier: evidenceVerifierFor(evidenceKeyPair.publicKey),
  });
  const manifest = deepFreeze(testRuntimeManifestV2Schema.parse({
    ...unsigned,
    manifestHash: hashCanonicalValue(unsigned),
  }));

  let expectedMarker: MongoOwnerMarker | undefined;
  let ownerCollectionCandidate: {
    topologyFingerprint: `sha256:${string}`;
    collectionEpochFingerprint: `sha256:${string}`;
    collectionProof: `hmac-sha256:${string}`;
  } | undefined;
  let expectedCollectionProof: `hmac-sha256:${string}` | undefined;
  let ownershipReceipt: MongoOwnershipReceiptV1 | undefined;
  let claimInFlight: Promise<MongoOwnershipReceiptV1> | undefined;
  let claimHandleInFlight: MongoTestDatabaseHandle | undefined;
  let cleanupVerified = false;
  let cleanupClaimAcquired = false;
  let cleanupInFlight: Promise<CleanupVerificationV1> | undefined;
  let cleanupHandleInFlight: MongoTestDatabaseHandle | undefined;
  let cleanupVerification: CleanupVerificationV1 | undefined;
  let cleanupFailureObserved = false;
  let snapshotBytes: Buffer | undefined;
  let snapshotFailureObserved = false;
  let snapshotInFlight: Promise<void> | undefined;
  let snapshotHandleInFlight: MongoTestDatabaseHandle | undefined;
  let evidenceFinalized = false;

  const context = { runId: manifest.runId, dbName: manifest.dbName };

  function finalizeOwnershipReceipt(marker: MongoOwnerMarker): MongoOwnershipReceiptV1 {
    const receipt = deepFreeze(ownershipReceiptSchema.parse({
      schemaVersion: TEST_RUNTIME_OWNERSHIP_RECEIPT_VERSION,
      resourceKind: 'mongoDatabase',
      resourceId: manifest.dbName,
      runId: manifest.runId,
      topologyFingerprint: marker.topologyFingerprint,
      collectionEpochFingerprint: marker.collectionEpochFingerprint,
      ownershipProofHash: hashCanonicalValue(marker.proof),
      ownedAt: manifest.createdAt,
    }));
    ownershipReceipt = receipt;
    return receipt;
  }

  function finalizeCleanupVerification(
    input: z.input<typeof cleanupVerificationV1Schema>,
  ): CleanupVerificationV1 {
    const verification = deepFreeze(cleanupVerificationV1Schema.parse(input));
    cleanupVerification = verification;
    return verification;
  }

  async function readOrRecoverPartialMarker(
    ops: MongoDatabaseOps,
  ): Promise<unknown | null> {
    const persisted = await ops.readOwnerMarker();
    if (
      persisted !== null
      || ownershipReceipt
      || !expectedMarker
      || !ownerCollectionCandidate
      || !expectedCollectionProof
    ) {
      return persisted;
    }
    const collections = await ops.listCollectionNames();
    if (
      collections.length !== 1
      || collections[0] !== TEST_RUNTIME_OWNER_COLLECTION
      || await ops.ownerCollectionEpochFingerprint(expectedCollectionProof)
        !== ownerCollectionCandidate.collectionEpochFingerprint
    ) {
      throw new ForeignTestResourceError();
    }
    try {
      await ops.createOwnerMarker(expectedMarker);
    } catch {
      // An ambiguous majority write is accepted only if the exact secret-backed
      // marker became visible. A true pre-write failure remains a refusal.
      parseAndVerifyMarker(
        await ops.readOwnerMarker(),
        expectedMarker,
        cleanupCapability,
      );
    }
    return ops.readOwnerMarker();
  }

  async function performClaim(
    handle: MongoTestDatabaseHandle,
    options: ClaimMongoDatabaseOptions = {},
  ): Promise<MongoOwnershipReceiptV1> {
    validateFaultHooks(options.faultHooks);
    const ops = exactMongoHandle(handle, manifest.dbName);
    const identity = await ops.observeTopology();
    const fingerprint = assertTopologyMatchesManifest(manifest, identity);
    if (allocation && allocation.topologyFingerprint !== fingerprint) {
      throw new TestRuntimeTopologyError();
    }

    if (expectedMarker) {
      if (expectedMarker.topologyFingerprint !== fingerprint) throw new TestRuntimeTopologyError();
      if (!expectedCollectionProof) throw new TestRuntimeOwnershipError();
      if (
        await ops.ownerCollectionEpochFingerprint(expectedCollectionProof)
        !== expectedMarker.collectionEpochFingerprint
      ) {
        throw new TestRuntimeOwnershipError();
      }
      const marker = parseAndVerifyMarker(
        await readOrRecoverPartialMarker(ops),
        expectedMarker,
        cleanupCapability,
      );
      if (marker.state !== 'ACTIVE' && !cleanupClaimAcquired) {
        throw new TestRuntimeOwnershipError();
      }
      const collections = await ops.listCollectionNames();
      if (
        collections.length !== 1
        || collections[0] !== TEST_RUNTIME_OWNER_COLLECTION
      ) {
        throw new ForeignTestResourceError();
      }
      return ownershipReceipt ?? finalizeOwnershipReceipt(marker);
    }

    const collections = await ops.listCollectionNames();
    if (collections.length !== 0) throw new ForeignTestResourceError();

    const collectionProof = allocation?.collectionProof ?? createMarkerProof(
      cleanupCapability,
      collectionHmacPayload({
        runId: manifest.runId,
        dbName: manifest.dbName,
        topologyFingerprint: fingerprint,
        createdAt: manifest.createdAt,
      }),
    );
    expectedCollectionProof = collectionProof;
    let collectionEpochFingerprint: `sha256:${string}`;
    try {
      collectionEpochFingerprint = await ops.createOwnerCollection(collectionProof);
    } catch (createError) {
      try {
        // Resolve only a true timeout-after-create: a foreign NamespaceExists
        // collection lacks this run's unguessable validator proof.
        collectionEpochFingerprint = await ops.ownerCollectionEpochFingerprint(collectionProof);
      } catch {
        throw createError;
      }
    }
    ownerCollectionCandidate = {
      topologyFingerprint: fingerprint,
      collectionEpochFingerprint,
      collectionProof,
    };
    await options.faultHooks?.afterMongoOwnerCollection?.(context);
    const markerBase = {
      _id: OWNER_MARKER_ID,
      schemaVersion: TEST_RUNTIME_OWNER_MARKER_VERSION,
      runId: manifest.runId,
      dbName: manifest.dbName,
      topologyFingerprint: fingerprint,
      collectionEpochFingerprint,
      createdAt: manifest.createdAt,
    } as const;
    expectedMarker = ownerMarkerSchema.parse({
      ...markerBase,
      proof: createMarkerProof(cleanupCapability, markerHmacPayload(markerBase)),
      state: 'ACTIVE',
    });

    await options.faultHooks?.beforeMongoOwnerMarker?.(context);
    await readOrRecoverPartialMarker(ops);
    await options.faultHooks?.afterMongoOwnerMarker?.(context);

    const postClaimCollections = await ops.listCollectionNames();
    if (
      postClaimCollections.length !== 1
      || postClaimCollections[0] !== TEST_RUNTIME_OWNER_COLLECTION
    ) {
      throw new ForeignTestResourceError();
    }

    return finalizeOwnershipReceipt(expectedMarker);
  }

  async function performCleanup(
    handle: MongoTestDatabaseHandle,
    options: CleanupMongoDatabaseOptions,
  ): Promise<CleanupVerificationV1> {
    validateFaultHooks(options.faultHooks);
    const ops = exactMongoHandle(handle, manifest.dbName);
    const ownershipCandidate = expectedMarker ?? ownerCollectionCandidate;
    if (!ownershipCandidate || !expectedCollectionProof) {
      throw new TestRuntimeStateError('Mongo database was not successfully claimed by this owner');
    }

    if (cleanupVerified) {
      if (await ops.databaseExists()) throw new TestRuntimeCleanupLeakError();
      return finalizeCleanupVerification({
        schemaVersion: TEST_CLEANUP_VERIFICATION_VERSION,
        resourceKind: 'mongoDatabase',
        resourceId: manifest.dbName,
        runId: manifest.runId,
        topologyFingerprint: ownershipCandidate.topologyFingerprint,
        collectionEpochFingerprint: ownershipCandidate.collectionEpochFingerprint,
        outcome: 'ALREADY_ABSENT',
        verifiedAbsent: true,
        checkedAt: (options.now?.() ?? new Date()).toISOString(),
      });
    }

    if (!(await ops.databaseExists())) {
      if (!cleanupClaimAcquired) {
        throw new TestRuntimeOwnershipError();
      }
      cleanupVerified = true;
      return finalizeCleanupVerification({
        schemaVersion: TEST_CLEANUP_VERIFICATION_VERSION,
        resourceKind: 'mongoDatabase',
        resourceId: manifest.dbName,
        runId: manifest.runId,
        topologyFingerprint: ownershipCandidate.topologyFingerprint,
        collectionEpochFingerprint: ownershipCandidate.collectionEpochFingerprint,
        outcome: 'ALREADY_ABSENT',
        verifiedAbsent: true,
        checkedAt: (options.now?.() ?? new Date()).toISOString(),
      });
    }

    const identity = await ops.observeTopology();
    const currentFingerprint = assertTopologyMatchesManifest(manifest, identity);
    if (currentFingerprint !== ownershipCandidate.topologyFingerprint) {
      throw new TestRuntimeTopologyError();
    }
    if (
      await ops.ownerCollectionEpochFingerprint(expectedCollectionProof)
      !== ownershipCandidate.collectionEpochFingerprint
    ) {
      throw new TestRuntimeOwnershipError();
    }

    if (!expectedMarker) {
      const collections = await ops.listCollectionNames();
      if (
        collections.length !== 1
        || collections[0] !== TEST_RUNTIME_OWNER_COLLECTION
        || await ops.readOwnerMarker() !== null
      ) {
        throw new ForeignTestResourceError();
      }
      const recoveryMarkerBase = {
        _id: OWNER_MARKER_ID,
        schemaVersion: TEST_RUNTIME_OWNER_MARKER_VERSION,
        runId: manifest.runId,
        dbName: manifest.dbName,
        topologyFingerprint: ownershipCandidate.topologyFingerprint,
        collectionEpochFingerprint: ownershipCandidate.collectionEpochFingerprint,
        createdAt: manifest.createdAt,
      } as const;
      expectedMarker = ownerMarkerSchema.parse({
        ...recoveryMarkerBase,
        proof: createMarkerProof(cleanupCapability, markerHmacPayload(recoveryMarkerBase)),
        state: 'ACTIVE',
      });
    }
    const cleanupMarker = expectedMarker;
    let marker = parseAndVerifyMarker(
      await readOrRecoverPartialMarker(ops),
      cleanupMarker,
      cleanupCapability,
    );
    if (!ownershipReceipt) {
      const collections = await ops.listCollectionNames();
      if (
        collections.length !== 1
        || collections[0] !== TEST_RUNTIME_OWNER_COLLECTION
      ) {
        throw new ForeignTestResourceError();
      }
      finalizeOwnershipReceipt(marker);
    }
    await options.faultHooks?.beforeMongoCleanupClaim?.(context);
    if (marker.state === 'ACTIVE') {
      const claimed = await ops.claimOwnerMarker(cleanupMarker);
      if (!claimed) throw new TestRuntimeOwnershipError();
      cleanupClaimAcquired = true;
    } else if (!cleanupClaimAcquired) {
      // Without a crash-persistent private journal, a pre-claimed public marker
      // cannot be distinguished from a foreign write. Same-owner retries after
      // our own successful CAS retain this in-memory fact and may resume.
      throw new TestRuntimeOwnershipError();
    }
    await options.faultHooks?.afterMongoCleanupClaim?.(context);

    let dropFailed = false;
    try {
      await ops.dropDatabase();
    } catch {
      dropFailed = true;
    }
    await options.faultHooks?.afterMongoDropBeforeVerification?.(context);
    if (await ops.databaseExists()) throw new TestRuntimeCleanupLeakError();

    cleanupVerified = true;
    return finalizeCleanupVerification({
      schemaVersion: TEST_CLEANUP_VERIFICATION_VERSION,
      resourceKind: 'mongoDatabase',
      resourceId: manifest.dbName,
      runId: manifest.runId,
      topologyFingerprint: cleanupMarker.topologyFingerprint,
      collectionEpochFingerprint: cleanupMarker.collectionEpochFingerprint,
      outcome: dropFailed ? 'CLEANED_AFTER_AMBIGUOUS_DROP' : 'CLEANED',
      verifiedAbsent: true,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
    });
  }

  async function assertActiveSnapshotOwnership(
    ops: MongoDatabaseOps,
  ): Promise<void> {
    if (!expectedMarker || !expectedCollectionProof || !ownershipReceipt) {
      throw new TestRuntimeStateError('database snapshot requires a completed ownership claim');
    }
    const identity = await ops.observeTopology();
    const fingerprint = assertTopologyMatchesManifest(manifest, identity);
    if (
      fingerprint !== expectedMarker.topologyFingerprint
      || ownershipReceipt.topologyFingerprint !== expectedMarker.topologyFingerprint
      || ownershipReceipt.collectionEpochFingerprint
        !== expectedMarker.collectionEpochFingerprint
      || await ops.ownerCollectionEpochFingerprint(expectedCollectionProof)
        !== expectedMarker.collectionEpochFingerprint
    ) {
      throw new TestRuntimeOwnershipError();
    }
    const marker = parseAndVerifyMarker(
      await ops.readOwnerMarker(),
      expectedMarker,
      cleanupCapability,
    );
    if (marker.state !== 'ACTIVE') throw new TestRuntimeOwnershipError();
  }

  async function performSnapshot(handle: MongoTestDatabaseHandle): Promise<void> {
    const ops = exactMongoHandle(handle, manifest.dbName);
    if (
      !ownershipReceipt
      || cleanupInFlight
      || cleanupClaimAcquired
      || cleanupVerified
      || cleanupFailureObserved
    ) {
      throw new TestRuntimeStateError('database snapshot requires active owned state before cleanup');
    }
    const db = mongoHandleDatabases.get(handle);
    if (!db) throw new TestRuntimeStateError('database snapshot requires a real bound Mongo handle');
    if (snapshotBytes) return;
    await assertActiveSnapshotOwnership(ops);
    const candidate = await captureAnonymizedMongoSnapshot({
      db,
      expectedDatabaseName: manifest.dbName,
      runId: manifest.runId,
      pseudonymKey: snapshotPseudonymKey,
      epoch: new Date(manifest.createdAt),
    });
    await assertActiveSnapshotOwnership(ops);
    snapshotBytes = candidate;
  }

  return Object.freeze({
    manifest,
    databaseName: manifest.dbName,
    claimMongoDatabase(
      handle: MongoTestDatabaseHandle,
      options: ClaimMongoDatabaseOptions = {},
    ) {
      if (evidenceFinalized) {
        throw new TestRuntimeStateError('test runtime is sealed after evidence finalization');
      }
      exactMongoHandle(handle, manifest.dbName);
      validateFaultHooks(options.faultHooks);
      if (claimInFlight) {
        if (handle !== claimHandleInFlight) {
          throw new TestRuntimeStateError('concurrent claim used a different database handle');
        }
        return claimInFlight;
      }
      const operation = performClaim(handle, options);
      claimInFlight = operation;
      claimHandleInFlight = handle;
      void operation.finally(() => {
        if (claimInFlight === operation) {
          claimInFlight = undefined;
          claimHandleInFlight = undefined;
        }
      }).catch(() => {
        // The original promise carries the result.
      });
      return operation;
    },
    cleanupMongoDatabase(
      handle: MongoTestDatabaseHandle,
      options: CleanupMongoDatabaseOptions = {},
    ) {
      if (evidenceFinalized) {
        throw new TestRuntimeStateError('test runtime is sealed after evidence finalization');
      }
      exactMongoHandle(handle, manifest.dbName);
      validateFaultHooks(options.faultHooks);
      if (snapshotInFlight) {
        cleanupFailureObserved = true;
        throw new TestRuntimeStateError('Mongo cleanup cannot overlap database snapshot capture');
      }
      if (cleanupInFlight) {
        if (handle !== cleanupHandleInFlight) {
          throw new TestRuntimeStateError('concurrent cleanup used a different database handle');
        }
        return cleanupInFlight;
      }
      const operation = performCleanup(handle, options).catch((error: unknown) => {
        cleanupFailureObserved = true;
        throw error;
      });
      cleanupInFlight = operation;
      cleanupHandleInFlight = handle;
      void operation.finally(() => {
        if (cleanupInFlight === operation) {
          cleanupInFlight = undefined;
          cleanupHandleInFlight = undefined;
        }
      }).catch(() => {
        // The original promise carries the error; this branch only observes the
        // promise returned by finally and prevents an unhandled rejection.
      });
      return operation;
    },
    captureMongoDatabaseSnapshot(handle: MongoTestDatabaseHandle) {
      if (evidenceFinalized) {
        throw new TestRuntimeStateError('test runtime is sealed after evidence finalization');
      }
      exactMongoHandle(handle, manifest.dbName);
      if (snapshotInFlight) {
        if (handle !== snapshotHandleInFlight) {
          throw new TestRuntimeStateError('concurrent snapshot used a different database handle');
        }
        return snapshotInFlight;
      }
      const operation = performSnapshot(handle).catch((error: unknown) => {
        snapshotFailureObserved = true;
        throw error;
      });
      snapshotInFlight = operation;
      snapshotHandleInFlight = handle;
      void operation.finally(() => {
        if (snapshotInFlight === operation) {
          snapshotInFlight = undefined;
          snapshotHandleInFlight = undefined;
        }
      }).catch(() => {
        // The caller observes the original snapshot error.
      });
      return operation;
    },
    createEvidenceReport(input: CreateOwnerTestEvidenceReportInput) {
      if (evidenceFinalized) {
        throw new TestRuntimeStateError('test evidence was already finalized');
      }
      if (claimInFlight || cleanupInFlight || snapshotInFlight) {
        throw new TestRuntimeStateError('cannot finalize evidence during an ownership operation');
      }
      const report = buildOwnerEvidenceReport({
        manifest,
        input,
        ownershipReceipt,
        cleanupVerification,
        cleanupFailureObserved,
        snapshotBytes,
        snapshotFailureObserved,
        secretCanaries,
        evidencePrivateKey: evidenceKeyPair.privateKey,
      });
      evidenceFinalized = true;
      return report;
    },
  });
}

const consumedParentMongoAllocations = new Set<string>();

function consumeParentMongoOwnerAllocation(): MongoOwnerAllocationV1 | undefined {
  const allocationSymbol = Symbol.for(TEST_RUNTIME_MONGO_OWNER_ALLOCATION_SYMBOL);
  const bridge = (globalThis as Record<symbol, unknown>)[allocationSymbol];
  if (bridge === undefined) return undefined;
  if (
    process.env.ORCHESTRATION_G0_GATE !== 'true'
    || !process.env.ORCHESTRATION_G0_PARENT_CHALLENGE
    || typeof bridge !== 'function'
  ) {
    throw new TestRuntimeOwnershipError();
  }
  let candidate: unknown;
  try {
    candidate = (bridge as () => unknown)();
  } catch {
    throw new TestRuntimeOwnershipError();
  }
  const allocation = mongoOwnerAllocationSchema.parse(candidate);
  allocationCapability(allocation);
  if (consumedParentMongoAllocations.has(allocation.runId)) {
    throw new TestRuntimeOwnershipError();
  }
  consumedParentMongoAllocations.add(allocation.runId);
  return allocation;
}

/**
 * Production-facing test owner constructor. Source identity is always read by
 * the runtime itself; callers cannot assert a clean commit.
 */
export function createTestRuntimeOwner(input: CreateTestRuntimeOwnerInput): TestRuntimeOwner {
  const parentSource = sourceIdentityFromParentGateEnv(
    process.env[TEST_RUNTIME_PARENT_SOURCE_ENV],
  );
  return createTestRuntimeOwnerWithSource({
    ...input,
    parentChallenge: process.env.ORCHESTRATION_G0_PARENT_CHALLENGE,
    source: parentSource ?? readGitSourceIdentity(PROJECT_SOURCE_ROOT),
  }, consumeParentMongoOwnerAllocation(), true);
}

/** @internal Deterministic source injection for the Mongo-free contract check. */
export function createTestRuntimeOwnerForContractCheck(
  input: CreateTestRuntimeOwnerForContractCheckInput,
): TestRuntimeOwner {
  return createTestRuntimeOwnerWithSource(input);
}

/**
 * Mongo-free handle used only by the contract check. It cannot be configured
 * with a destructive callback and therefore cannot redirect cleanup.
 */
export interface InMemoryMongoTestHarness {
  readonly handle: MongoTestDatabaseHandle;
  inspect(): {
    exists: boolean;
    collectionNames: string[];
    marker: unknown | null;
    dropCalls: number;
    claimCalls: number;
  };
  seedForeignCollection(name?: string): void;
  replaceMarker(marker: unknown | null): void;
  mutateMarker(mutator: (marker: Record<string, unknown>) => void): void;
  setTopology(identity: {
    setName: string;
    members: string[];
    maxWireVersion?: number;
    isWritablePrimary?: boolean;
  }): void;
  setDropBehavior(behavior: 'NORMAL' | 'TIMEOUT_AFTER_DROP' | 'NO_EFFECT'): void;
  simulateExternalDrop(): void;
  setClaimBehavior(behavior: 'NORMAL' | 'LOSE_CAS'): void;
  setCollectionCreateBehavior(
    behavior: 'NORMAL' | 'TIMEOUT_AFTER_CREATE' | 'FOREIGN_NAMESPACE_EXISTS',
  ): void;
}

export function createInMemoryMongoTestHarness(
  databaseName: string,
  initialTopology: {
    setName?: string;
    members?: string[];
    maxWireVersion?: number;
    isWritablePrimary?: boolean;
  } = {},
): InMemoryMongoTestHarness {
  if (!SAFE_DB_RE.test(databaseName)) throw new ForeignTestResourceError();
  let exists = false;
  let collectionNames: string[] = [];
  let marker: unknown | null = null;
  let collectionEpochFingerprint: `sha256:${string}` | undefined;
  let collectionProof: `hmac-sha256:${string}` | undefined;
  let dropCalls = 0;
  let claimCalls = 0;
  let dropBehavior: 'NORMAL' | 'TIMEOUT_AFTER_DROP' | 'NO_EFFECT' = 'NORMAL';
  let claimBehavior: 'NORMAL' | 'LOSE_CAS' = 'NORMAL';
  let collectionCreateBehavior:
    | 'NORMAL'
    | 'TIMEOUT_AFTER_CREATE'
    | 'FOREIGN_NAMESPACE_EXISTS' = 'NORMAL';
  let topology = {
    setName: initialTopology.setName ?? 'rs0',
    members: initialTopology.members ?? ['db-a:27017'],
    maxWireVersion: initialTopology.maxWireVersion ?? 21,
    isWritablePrimary: initialTopology.isWritablePrimary ?? true,
  };

  const handle = registerMongoHandle(databaseName, {
    async observeTopology() {
      return topologyIdentityFromHello({
        setName: topology.setName,
        hosts: topology.members,
        maxWireVersion: topology.maxWireVersion,
        isWritablePrimary: topology.isWritablePrimary,
      });
    },
    async listCollectionNames() {
      return [...collectionNames].sort();
    },
    async createOwnerCollection(nextCollectionProof) {
      if (exists || collectionNames.length > 0 || collectionEpochFingerprint) {
        throw new Error('owner collection already exists');
      }
      exists = true;
      collectionNames = [TEST_RUNTIME_OWNER_COLLECTION];
      collectionProof = collectionCreateBehavior === 'FOREIGN_NAMESPACE_EXISTS'
        ? `hmac-sha256:${'f'.repeat(64)}`
        : nextCollectionProof;
      collectionEpochFingerprint = hashCanonicalValue({
        databaseName,
        nonce: randomBytes(16).toString('hex'),
      });
      if (collectionCreateBehavior === 'FOREIGN_NAMESPACE_EXISTS') {
        throw new Error('simulated foreign NamespaceExists race');
      }
      if (collectionCreateBehavior === 'TIMEOUT_AFTER_CREATE') {
        throw new Error('simulated ambiguous create timeout');
      }
      return collectionEpochFingerprint;
    },
    async ownerCollectionEpochFingerprint(expectedCollectionProof) {
      if (
        !collectionEpochFingerprint
        || !collectionNames.includes(TEST_RUNTIME_OWNER_COLLECTION)
        || !collectionProof
        || !proofsEqual(collectionProof, expectedCollectionProof)
      ) {
        throw new TestRuntimeOwnershipError();
      }
      return collectionEpochFingerprint;
    },
    async createOwnerMarker(nextMarker) {
      if (
        marker !== null
        || collectionNames.length !== 1
        || collectionNames[0] !== TEST_RUNTIME_OWNER_COLLECTION
      ) {
        throw new Error('duplicate or non-first marker');
      }
      marker = structuredClone(nextMarker);
    },
    async readOwnerMarker() {
      return marker === null ? null : structuredClone(marker);
    },
    async claimOwnerMarker(expected) {
      claimCalls++;
      if (claimBehavior === 'LOSE_CAS') return false;
      const parsed = ownerMarkerSchema.safeParse(marker);
      if (
        !parsed.success
        || parsed.data.state !== 'ACTIVE'
        || parsed.data.runId !== expected.runId
        || parsed.data.dbName !== expected.dbName
        || parsed.data.proof !== expected.proof
      ) {
        return false;
      }
      marker = {
        ...parsed.data,
        state: 'CLEANUP_CLAIMED',
        cleanupClaimedAt: new Date().toISOString(),
      };
      return true;
    },
    async databaseExists() {
      return exists;
    },
    async dropDatabase() {
      dropCalls++;
      if (dropBehavior === 'NO_EFFECT') return;
      exists = false;
      marker = null;
      collectionNames = [];
      collectionEpochFingerprint = undefined;
      collectionProof = undefined;
      if (dropBehavior === 'TIMEOUT_AFTER_DROP') throw new Error('simulated ambiguous timeout');
    },
  });

  return {
    handle,
    inspect: () => ({
      exists,
      collectionNames: [...collectionNames],
      marker: marker === null ? null : structuredClone(marker),
      dropCalls,
      claimCalls,
    }),
    seedForeignCollection(name = 'foreign_data') {
      exists = true;
      collectionNames = [name];
      collectionEpochFingerprint = name === TEST_RUNTIME_OWNER_COLLECTION
        ? hashCanonicalValue({
          databaseName,
          foreignNonce: randomBytes(16).toString('hex'),
        })
        : undefined;
      collectionProof = name === TEST_RUNTIME_OWNER_COLLECTION
        ? `hmac-sha256:${'e'.repeat(64)}`
        : undefined;
    },
    replaceMarker(nextMarker) {
      marker = nextMarker === null ? null : structuredClone(nextMarker);
    },
    mutateMarker(mutator) {
      if (!marker || typeof marker !== 'object') throw new Error('marker is absent');
      const nextMarker = structuredClone(marker) as Record<string, unknown>;
      mutator(nextMarker);
      marker = nextMarker;
    },
    setTopology(identity) {
      topology = {
        setName: identity.setName,
        members: [...identity.members],
        maxWireVersion: identity.maxWireVersion ?? 21,
        isWritablePrimary: identity.isWritablePrimary ?? true,
      };
    },
    setDropBehavior(behavior) {
      dropBehavior = behavior;
    },
    simulateExternalDrop() {
      exists = false;
      marker = null;
      collectionNames = [];
      collectionEpochFingerprint = undefined;
      collectionProof = undefined;
    },
    setClaimBehavior(behavior) {
      claimBehavior = behavior;
    },
    setCollectionCreateBehavior(behavior) {
      collectionCreateBehavior = behavior;
    },
  };
}

export const TEST_EXECUTION_STATUSES = ['PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN'] as const;
export const TARGET_INVARIANT_STATUSES = ['HOLDS', 'VIOLATED', 'UNKNOWN'] as const;
export const CLEANUP_STATUSES = ['CLEANUP_VERIFIED', 'CLEANUP_FAILED', 'NOT_RUN'] as const;
export const SECRET_SCAN_STATUSES = ['PASS', 'FAILED', 'NOT_RUN'] as const;

const retainedEvidenceArtifactSchema = z.object({
  artifactId: z.enum([
    'normalized-summary',
    'stdout',
    'stderr',
    'trace-event-log',
    'db-snapshot',
  ]),
  kind: z.enum(['normalizedSummary', 'stdout', 'stderr', 'trace', 'dbSnapshot']),
  relativeName: z.enum([
    'normalized-summary.json',
    'stdout.log',
    'stderr.log',
    'trace-event-log.ndjson',
    'db-snapshot.json',
  ]),
  mediaType: z.enum([
    'application/json',
    'text/plain; charset=utf-8',
    'application/x-ndjson',
  ]),
  byteSize: z.number().int().nonnegative().max(RAW_EVIDENCE_TOTAL_MAX_BYTES),
  contentHash: z.string().regex(SHA256_RE),
  contentBase64url: z.string().regex(/^[A-Za-z0-9_-]*$/).max(6 * 1024 * 1024),
  transformPolicyVersion: z.literal(RAW_EVIDENCE_TRANSFORM_POLICY_VERSION),
  retentionStatus: z.literal('BUNDLE_RETAINED'),
  readBackRequired: z.literal(true),
}).strict();

const quarantinedEvidenceArtifactSchema = z.object({
  artifactId: z.enum([
    'normalized-summary',
    'stdout',
    'stderr',
    'trace-event-log',
    'db-snapshot',
  ]),
  kind: z.enum(['normalizedSummary', 'stdout', 'stderr', 'trace', 'dbSnapshot']),
  relativeName: z.enum([
    'normalized-summary.json',
    'stdout.log',
    'stderr.log',
    'trace-event-log.ndjson',
    'db-snapshot.json',
  ]),
  mediaType: z.enum([
    'application/json',
    'text/plain; charset=utf-8',
    'application/x-ndjson',
  ]),
  observedByteSize: z.number().int().nonnegative().max(RAW_EVIDENCE_TOTAL_MAX_BYTES),
  transformPolicyVersion: z.literal(RAW_EVIDENCE_TRANSFORM_POLICY_VERSION),
  retentionStatus: z.literal('QUARANTINED_SECRET'),
  quarantineCode: z.literal('SECRET_DETECTED'),
  readBackRequired: z.literal(false),
}).strict();

const evidenceArtifactSchema = z.discriminatedUnion('retentionStatus', [
  retainedEvidenceArtifactSchema,
  quarantinedEvidenceArtifactSchema,
]);

const evidenceCaseSchema = z.object({
  caseId: z.string().regex(SAFE_ID_RE),
  testExecutionStatus: z.enum(TEST_EXECUTION_STATUSES),
  targetInvariantStatus: z.enum(TARGET_INVARIANT_STATUSES),
  artifactIds: z.array(z.string().regex(SAFE_ID_RE)),
}).strict();

const unsignedEvidenceReportSchema = z.object({
  schemaVersion: z.literal(TEST_EVIDENCE_REPORT_VERSION),
  scope: z.literal('MONGO_ARTIFACT_AND_RUNTIME_RESOURCE_FOUNDATION'),
  runId: z.string().regex(RUN_ID_RE),
  manifestHash: z.string().regex(SHA256_RE),
  source: sourceIdentitySchema,
  configHash: z.string().regex(SHA256_RE),
  seed: z.number().int().min(0).max(0xffff_ffff),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  testExecutionStatus: z.enum(TEST_EXECUTION_STATUSES),
  targetInvariantStatus: z.enum(TARGET_INVARIANT_STATUSES),
  cleanupStatus: z.enum(CLEANUP_STATUSES),
  secretScanStatus: z.enum(SECRET_SCAN_STATUSES),
  artifactEvidenceStatus: z.enum(['COMPLETE', 'INCOMPLETE', 'QUARANTINED']),
  artifactSetHash: z.string().regex(SHA256_RE),
  artifactTotalBytes: z.number().int().nonnegative().max(RAW_EVIDENCE_TOTAL_MAX_BYTES),
  foundationValidationStatus: z.enum(['PASS', 'FAIL']),
  qualificationStatus: z.literal('NOT_QUALIFIED'),
  cases: z.array(evidenceCaseSchema).length(1),
  artifacts: z.array(evidenceArtifactSchema).max(REQUIRED_RAW_EVIDENCE.length),
  ownership: z.array(ownershipReceiptSchema).max(1),
  cleanup: z.array(cleanupVerificationV1Schema).max(1),
}).strict();

const evidenceAttestationSchema = z.object({
  schemaVersion: z.literal(TEST_EVIDENCE_ATTESTATION_VERSION),
  algorithm: z.literal('Ed25519'),
  keyId: z.string().regex(SHA256_RE),
  signatureBase64url: z.string().regex(BASE64URL_RE).length(86),
}).strict();

export const testEvidenceReportV2Schema = unsignedEvidenceReportSchema.extend({
  reportHash: z.string().regex(SHA256_RE),
  attestation: evidenceAttestationSchema,
}).strict();

export type EvidenceCaseV2 = z.infer<typeof evidenceCaseSchema>;
export type EvidenceArtifactV2 = RawEvidenceArtifactDescriptor;
export type TestEvidenceReportV2 = z.infer<typeof testEvidenceReportV2Schema>;
export const testEvidenceReportV3Schema = testEvidenceReportV2Schema;
export type TestEvidenceReportV3 = TestEvidenceReportV2;

export const testEvidenceBundleV2Schema = z.object({
  schemaVersion: z.literal(TEST_EVIDENCE_BUNDLE_VERSION),
  manifest: testRuntimeManifestV2Schema,
  report: testEvidenceReportV2Schema,
}).strict();
export type TestEvidenceBundleV2 = z.infer<typeof testEvidenceBundleV2Schema>;
export const testEvidenceBundleV3Schema = testEvidenceBundleV2Schema;
export type TestEvidenceBundleV3 = TestEvidenceBundleV2;

export type OwnerEvidenceArtifactInput = RawEvidenceArtifactInput;
export type OwnerEvidenceCaseInput = Omit<EvidenceCaseV2, 'artifactIds'>;

export interface CreateOwnerTestEvidenceReportInput {
  createdAt: Date;
  completedAt: Date;
  cases: readonly OwnerEvidenceCaseInput[];
  artifacts?: readonly OwnerEvidenceArtifactInput[];
}

function uniqueSorted<T>(
  values: readonly T[],
  key: (value: T) => string | number,
  label: string,
): T[] {
  const output = [...values].sort((left, right) => String(key(left)).localeCompare(String(key(right))));
  for (let index = 1; index < output.length; index++) {
    if (key(output[index - 1]!) === key(output[index]!)) {
      throw new TypeError(`${label} contains a duplicate declaration`);
    }
  }
  return output;
}

function isCanonicallySorted<T>(values: readonly T[], key: (value: T) => string | number): boolean {
  const keys = values.map(key);
  return keys.every(
    (entry, index) => index === 0 || String(keys[index - 1]).localeCompare(String(entry)) < 0,
  );
}

function aggregateExecutionStatus(cases: readonly EvidenceCaseV2[]): typeof TEST_EXECUTION_STATUSES[number] {
  if (cases.some((entry) => entry.testExecutionStatus === 'FAILED')) return 'FAILED';
  if (cases.some((entry) => entry.testExecutionStatus === 'BLOCKED')) return 'BLOCKED';
  if (cases.some((entry) => entry.testExecutionStatus === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASSED';
}

function aggregateInvariantStatus(cases: readonly EvidenceCaseV2[]): typeof TARGET_INVARIANT_STATUSES[number] {
  if (cases.some((entry) => entry.targetInvariantStatus === 'VIOLATED')) return 'VIOLATED';
  if (cases.some((entry) => entry.targetInvariantStatus === 'UNKNOWN')) return 'UNKNOWN';
  return 'HOLDS';
}

function evidenceUnsigned(
  report: TestEvidenceReportV2,
): Omit<TestEvidenceReportV2, 'reportHash' | 'attestation'> {
  const {
    reportHash: _reportHash,
    attestation: _attestation,
    ...unsigned
  } = report;
  return unsigned;
}

function evidenceAttestationPayload(manifestHash: string, reportHash: string): Buffer {
  return Buffer.from(canonicalJson({
    domain: 'G0_TEST_EVIDENCE_REPORT_V3',
    manifestHash,
    reportHash,
  }), 'utf8');
}

function foundationValidationStatusFor(input: {
  testExecutionStatus: typeof TEST_EXECUTION_STATUSES[number];
  targetInvariantStatus: typeof TARGET_INVARIANT_STATUSES[number];
  cleanupStatus: typeof CLEANUP_STATUSES[number];
  secretScanStatus: typeof SECRET_SCAN_STATUSES[number];
  artifactEvidenceStatus: 'COMPLETE' | 'INCOMPLETE' | 'QUARANTINED';
  source: TestRuntimeSourceIdentity;
  ownershipCount: number;
}): 'PASS' | 'FAIL' {
  return (
    input.testExecutionStatus === 'PASSED'
    && input.targetInvariantStatus === 'HOLDS'
    && input.cleanupStatus === 'CLEANUP_VERIFIED'
    && input.secretScanStatus === 'PASS'
    && input.artifactEvidenceStatus === 'COMPLETE'
    && input.source.worktreeState === 'CLEAN'
    && input.ownershipCount === 1
  ) ? 'PASS' : 'FAIL';
}

function buildOwnerEvidenceReport(
  state: {
    manifest: TestRuntimeManifestV2;
    input: CreateOwnerTestEvidenceReportInput;
    ownershipReceipt?: MongoOwnershipReceiptV1;
    cleanupVerification?: CleanupVerificationV1;
    cleanupFailureObserved: boolean;
    snapshotBytes?: Buffer;
    snapshotFailureObserved: boolean;
    secretCanaries: readonly string[];
    evidencePrivateKey: KeyObject;
  },
): TestEvidenceReportV2 {
  const manifest = parseTestRuntimeManifest(state.manifest);
  const caseInputs = uniqueSorted(state.input.cases, (entry) => entry.caseId, 'evidence cases');
  const callerArtifacts = uniqueSorted(
    state.input.artifacts ?? [],
    (artifact) => artifact.artifactId,
    'artifacts',
  );
  if (callerArtifacts.some((artifact) => artifact.kind === 'dbSnapshot')) {
    throw new TestRuntimeStateError('database snapshot evidence can only be minted by the owner');
  }
  const retained = retainRawEvidenceArtifacts(
    [
      ...callerArtifacts,
      ...(state.snapshotBytes
        ? [{
          artifactId: 'db-snapshot' as const,
          kind: 'dbSnapshot' as const,
          mediaType: 'application/json' as const,
          content: state.snapshotBytes,
        }]
        : []),
    ],
    state.secretCanaries,
  );
  const artifacts = retained.artifacts.map((artifact) => evidenceArtifactSchema.parse(artifact));
  const artifactIds = artifacts.map((artifact) => artifact.artifactId).sort();
  const cases = caseInputs.map((entry) => ({
    ...entry,
    artifactIds,
  }));
  const ownership = state.ownershipReceipt ? [state.ownershipReceipt] : [];
  const cleanupStatus: typeof CLEANUP_STATUSES[number] = state.cleanupFailureObserved
    ? 'CLEANUP_FAILED'
    : state.cleanupVerification
      ? 'CLEANUP_VERIFIED'
      : 'NOT_RUN';
  const cleanup = cleanupStatus === 'CLEANUP_VERIFIED' && state.cleanupVerification
    ? [state.cleanupVerification]
    : [];
  const secretScanStatus: typeof SECRET_SCAN_STATUSES[number] = retained.secretScanStatus;
  const artifactEvidenceStatus = state.snapshotFailureObserved
    ? 'INCOMPLETE' as const
    : retained.artifactEvidenceStatus;
  const testExecutionStatus = aggregateExecutionStatus(cases);
  const targetInvariantStatus = aggregateInvariantStatus(cases);
  const unsigned = unsignedEvidenceReportSchema.parse({
    schemaVersion: TEST_EVIDENCE_REPORT_VERSION,
    scope: manifest.scope,
    runId: manifest.runId,
    manifestHash: manifest.manifestHash,
    source: manifest.source,
    configHash: manifest.configHash,
    seed: manifest.seed,
    createdAt: state.input.createdAt.toISOString(),
    completedAt: state.input.completedAt.toISOString(),
    testExecutionStatus,
    targetInvariantStatus,
    cleanupStatus,
    secretScanStatus,
    foundationValidationStatus: foundationValidationStatusFor({
      testExecutionStatus,
      targetInvariantStatus,
      cleanupStatus,
      secretScanStatus,
      artifactEvidenceStatus,
      source: manifest.source,
      ownershipCount: ownership.length,
    }),
    qualificationStatus: 'NOT_QUALIFIED',
    cases,
    artifacts,
    artifactEvidenceStatus,
    artifactSetHash: hashCanonicalValue(artifacts),
    artifactTotalBytes: retained.totalRetainedBytes,
    ownership,
    cleanup,
  });
  const reportHash = hashCanonicalValue(unsigned);
  const signature = signBytes(
    null,
    evidenceAttestationPayload(manifest.manifestHash, reportHash),
    state.evidencePrivateKey,
  );
  const report = deepFreeze(testEvidenceReportV2Schema.parse({
    ...unsigned,
    reportHash,
    attestation: {
      schemaVersion: TEST_EVIDENCE_ATTESTATION_VERSION,
      algorithm: 'Ed25519',
      keyId: manifest.evidenceVerifier.keyId,
      signatureBase64url: signature.toString('base64url'),
    },
  }));
  const validation = validateTestEvidenceReport(report, manifest);
  if (!validation.ok) throw new TestRuntimeManifestError(validation.issues);
  return report;
}

export function validateTestEvidenceReport(
  input: unknown,
  manifestInput?: unknown,
): ValidationResult<TestEvidenceReportV2> {
  const parsed = testEvidenceReportV2Schema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const report = parsed.data;
  const issues: string[] = [];
  if (new Date(report.completedAt).getTime() < new Date(report.createdAt).getTime()) {
    issues.push('completedAt must not precede createdAt');
  }
  if (!isCanonicallySorted(report.cases, (entry) => entry.caseId)) {
    issues.push('cases must be unique and canonically sorted');
  }
  if (!isCanonicallySorted(report.artifacts, (artifact) => artifact.artifactId)) {
    issues.push('artifacts must be unique and canonically sorted');
  }
  for (const entry of report.cases) {
    if (!isCanonicallySorted(entry.artifactIds, (artifactId) => artifactId)) {
      issues.push(`case ${entry.caseId} artifactIds must be unique and canonically sorted`);
    }
  }

  const artifactIds = new Set<string>(report.artifacts.map((artifact) => artifact.artifactId));
  const referencedArtifactIds = new Set(report.cases.flatMap((entry) => entry.artifactIds));
  for (const artifactId of referencedArtifactIds) {
    if (!artifactIds.has(artifactId)) issues.push(`case references unknown artifact ${artifactId}`);
  }
  for (const artifactId of artifactIds) {
    if (!referencedArtifactIds.has(artifactId)) issues.push(`orphan artifact ${artifactId}`);
  }

  const retainedArtifacts = report.artifacts.filter((artifact) =>
    artifact.retentionStatus === 'BUNDLE_RETAINED');
  for (const artifact of retainedArtifacts) {
    if (!validateRetainedRawEvidenceArtifact(artifact)) {
      issues.push(`artifact ${artifact.artifactId} does not retain valid read-back bytes`);
    }
  }
  const expectedArtifactStatus = report.artifacts.some((artifact) =>
    artifact.retentionStatus === 'QUARANTINED_SECRET')
    ? 'QUARANTINED'
    : retainedArtifacts.length === REQUIRED_RAW_EVIDENCE.length
      && REQUIRED_RAW_EVIDENCE.every((required) =>
        retainedArtifacts.some((artifact) => artifact.artifactId === required.artifactId))
      ? 'COMPLETE'
      : 'INCOMPLETE';
  if (report.artifactEvidenceStatus !== expectedArtifactStatus) {
    issues.push('artifactEvidenceStatus does not match retained artifact bytes');
  }
  const expectedSecretScanStatus = report.artifacts.length === 0
    ? 'NOT_RUN'
    : expectedArtifactStatus === 'QUARANTINED'
      ? 'FAILED'
      : 'PASS';
  if (report.secretScanStatus !== expectedSecretScanStatus) {
    issues.push('secretScanStatus does not match artifact quarantine state');
  }
  const expectedArtifactBytes = retainedArtifacts.reduce(
    (total, artifact) => total + artifact.byteSize,
    0,
  );
  if (report.artifactTotalBytes !== expectedArtifactBytes) {
    issues.push('artifactTotalBytes does not match retained byte sizes');
  }
  if (report.artifactSetHash !== hashCanonicalValue(report.artifacts)) {
    issues.push('artifactSetHash does not match artifact descriptors and bytes');
  }

  const expectedExecution = aggregateExecutionStatus(report.cases);
  const expectedInvariant = aggregateInvariantStatus(report.cases);
  if (report.testExecutionStatus !== expectedExecution) {
    issues.push('testExecutionStatus does not match case execution statuses');
  }
  if (report.targetInvariantStatus !== expectedInvariant) {
    issues.push('targetInvariantStatus does not match case invariant statuses');
  }
  const expectedFoundationStatus = foundationValidationStatusFor({
    ...report,
    ownershipCount: report.ownership.length,
  });
  if (report.foundationValidationStatus !== expectedFoundationStatus) {
    issues.push('foundationValidationStatus does not match independent statuses');
  }
  if (
    report.cleanupStatus === 'CLEANUP_VERIFIED'
    && (report.cleanup.length !== 1 || report.ownership.length !== 1)
  ) {
    issues.push('CLEANUP_VERIFIED requires one ownership and one cleanup receipt');
  }
  if (
    report.cleanupStatus !== 'CLEANUP_VERIFIED'
    && report.cleanup.length !== 0
  ) {
    issues.push('non-verified cleanup status cannot carry a success receipt');
  }
  if (hashCanonicalValue(evidenceUnsigned(report)) !== report.reportHash) {
    issues.push('reportHash does not match report contents');
  }

  if (manifestInput === undefined) {
    issues.push('BOUND_MANIFEST_REQUIRED');
  } else {
    try {
      const manifest = parseTestRuntimeManifest(manifestInput);
      if (report.runId !== manifest.runId) issues.push('report runId does not match manifest');
      if (report.manifestHash !== manifest.manifestHash) issues.push('report manifestHash does not match manifest');
      if (report.source.commitSha !== manifest.source.commitSha) issues.push('report source does not match manifest');
      if (report.source.commitTreeSha !== manifest.source.commitTreeSha) issues.push('report tree does not match manifest');
      if (report.source.worktreeState !== manifest.source.worktreeState) issues.push('report worktree state does not match manifest');
      if (report.configHash !== manifest.configHash) issues.push('report configHash does not match manifest');
      if (report.seed !== manifest.seed) issues.push('report seed does not match manifest');
      if (report.attestation.keyId !== manifest.evidenceVerifier.keyId) {
        issues.push('report attestation key does not match manifest');
      }
      for (const receipt of [...report.ownership, ...report.cleanup]) {
        if (receipt.runId !== manifest.runId || receipt.resourceId !== manifest.dbName) {
          issues.push('receipt references a foreign database or run');
        }
      }
      if (
        report.ownership.length === 1
        && report.cleanup.length === 1
        && (
          report.ownership[0]!.topologyFingerprint !== report.cleanup[0]!.topologyFingerprint
          || report.ownership[0]!.collectionEpochFingerprint
            !== report.cleanup[0]!.collectionEpochFingerprint
        )
      ) {
        issues.push('ownership and cleanup fingerprints differ');
      }
      const publicKey = parseEd25519PublicKey(
        manifest.evidenceVerifier.publicKeySpkiDerBase64url,
      );
      const signature = decodeCanonicalBase64url(
        report.attestation.signatureBase64url,
        64,
      );
      if (
        !verifyBytes(
          null,
          evidenceAttestationPayload(manifest.manifestHash, report.reportHash),
          publicKey,
          signature,
        )
      ) {
        issues.push('report attestation signature is invalid');
      }
    } catch {
      issues.push('bound manifest or report attestation is invalid');
    }
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: report, issues: [] };
}

export function validateTestEvidenceBundle(
  input: unknown,
): ValidationResult<TestEvidenceBundleV2> {
  const parsed = testEvidenceBundleV2Schema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const validation = validateTestEvidenceReport(parsed.data.report, parsed.data.manifest);
  return validation.ok
    ? { ok: true, value: parsed.data, issues: [] }
    : { ok: false, issues: validation.issues };
}

/**
 * Publish an authenticated bundle. The strict gate supplies a pre-opened
 * parent-owned fd 3; the child never receives a writable filesystem path.
 * Outside gate mode the bundle is emitted to stdout after output capture stops.
 */
export function publishTestEvidenceBundle(
  input: unknown,
  gateHandoffFd?: number,
): TestEvidenceBundleV2 {
  const validation = validateTestEvidenceBundle(input);
  if (!validation.ok || !validation.value) {
    throw new TestRuntimeManifestError(validation.issues);
  }
  const bundle = deepFreeze(validation.value);
  const serialized = Buffer.from(JSON.stringify(bundle), 'utf8');
  if (serialized.byteLength > TEST_EVIDENCE_BUNDLE_MAX_BYTES) {
    throw new TestRuntimeStateError('test evidence bundle exceeds the fixed handoff limit');
  }
  if (gateHandoffFd !== undefined) {
    if (gateHandoffFd !== 3) {
      throw new TestRuntimeStateError('strict-gate evidence must use inherited fd 3');
    }
    const stat = fstatSync(gateHandoffFd);
    if (
      (!stat.isFIFO() && !stat.isSocket())
      || stat.size !== 0
    ) {
      throw new TestRuntimeStateError('invalid strict-gate evidence handoff descriptor');
    }
    writeFileSync(gateHandoffFd, serialized);
  } else {
    console.log(JSON.stringify({ g0EvidenceBundle: bundle }));
  }
  return bundle;
}
