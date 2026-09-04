/**
 * Owned deterministic provider stubs for the G0 test-owned runtime (§19.1
 * "stuby Google, Gmail, Calendar, n8n, Firecrawl, Playwright, MCP i media",
 * §19.3 provider fault fixtures).
 *
 * A suite must never reach a real external provider (§26: "brak realnych
 * Google/Gmail/n8n/Firecrawl/Playwright/media effects"). This registry hands out
 * deterministic, seed-derived responses for a declared set of providers and
 * supports the §19.3 fault modes (Retry-After / rate limit, hung connect, hung
 * body, polling). Dispatch is fail-closed: a request to a provider that is not
 * in the closed enum, or that this run did not declare and stub, throws instead
 * of silently reaching out. A fail-closed ledger reconciles an authenticated
 * request/response log against the registry: any unstubbed access or any
 * response that is not the exact deterministic one the registry would produce is
 * `ESCAPED`, exactly as the side-effect and fault ledgers fail closed.
 *
 * Determinism is the whole point, so there is no real I/O here — the fault modes
 * describe latency/retry envelopes as data, and it is the consuming suite that
 * decides whether to actually wait.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hashCanonicalValue } from './test-runtime.js';

export const PROVIDER_STUB_REGISTRY_VERSION = 'g0-provider-stub-registry/v1' as const;
export const PROVIDER_STUB_LEDGER_VERSION = 'g0-provider-stub-ledger/v1' as const;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const SAFE_OP_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_HUNG_MS = 60_000;
const MAX_POLL_ATTEMPTS = 16;

/** Closed enum of stubbable providers (§19.1). */
export const PROVIDER_STUB_KINDS = [
  'GOOGLE',
  'GMAIL',
  'CALENDAR',
  'N8N',
  'FIRECRAWL',
  'PLAYWRIGHT',
  'MCP',
  'MEDIA',
] as const;
export type ProviderStubKind = (typeof PROVIDER_STUB_KINDS)[number];

/** Closed enum of response modes, including the §19.3 fault fixtures. */
export const PROVIDER_RESPONSE_MODES = [
  'OK',
  'EMPTY',
  'MALFORMED',
  'RATE_LIMITED',
  'HUNG_CONNECT',
  'HUNG_BODY',
  'POLLING',
] as const;
export type ProviderResponseMode = (typeof PROVIDER_RESPONSE_MODES)[number];

const FAULT_MODES = new Set<ProviderResponseMode>([
  'RATE_LIMITED',
  'HUNG_CONNECT',
  'HUNG_BODY',
  'POLLING',
]);

export const providerStubRequestSchema = z.object({
  provider: z.enum(PROVIDER_STUB_KINDS),
  operation: z.string().regex(SAFE_OP_RE),
  requestId: z.string().regex(REQUEST_ID_RE),
});
export type ProviderStubRequest = z.infer<typeof providerStubRequestSchema>;

export const providerStubResponseSchema = z.object({
  provider: z.enum(PROVIDER_STUB_KINDS),
  operation: z.string().regex(SAFE_OP_RE),
  requestId: z.string().regex(REQUEST_ID_RE),
  mode: z.enum(PROVIDER_RESPONSE_MODES),
  /**
   * Whether the response claims a real external effect. A genuine owned stub
   * always sets this false; the ledger independently classifies any logged
   * `true` (from a buggy or foreign stub) as an escape.
   */
  external: z.boolean(),
  /** Deterministic canned body digest; the body itself stays bounded. */
  bodyHash: z.string().regex(SHA256_RE),
  retryAfterMs: z.number().int().min(0).max(MAX_RETRY_AFTER_MS),
  hungMs: z.number().int().min(0).max(MAX_HUNG_MS),
  pollAttempts: z.number().int().min(0).max(MAX_POLL_ATTEMPTS),
});
export type ProviderStubResponse = z.infer<typeof providerStubResponseSchema>;

export class UnstubbedProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`provider "${provider}" is not stubbed for this run`);
    this.name = 'UnstubbedProviderError';
  }
}

export interface ProviderStubRegistry {
  readonly registryVersion: typeof PROVIDER_STUB_REGISTRY_VERSION;
  readonly seed: number;
  readonly declared: readonly ProviderStubKind[];
  readonly declaredSetHash: `sha256:${string}`;
}

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e37_79b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function seededGenerator(seed: number, ...parts: string[]): () => number {
  const digest = hashCanonicalValue({ seed, parts });
  return splitmix32(parseInt(digest.slice('sha256:'.length, 'sha256:'.length + 8), 16));
}

/**
 * Create a deterministic stub registry for a declared provider set. The declared
 * set is normalized (deduplicated, ordered) and hashed so evidence can bind the
 * run to exactly the providers it stubbed.
 */
export function createProviderStubRegistry(input: {
  seed: number;
  providers: readonly ProviderStubKind[];
}): ProviderStubRegistry {
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff) {
    throw new TypeError('provider stub seed must be a uint32');
  }
  const allowed = new Set<string>(PROVIDER_STUB_KINDS);
  for (const provider of input.providers) {
    if (!allowed.has(provider)) throw new TypeError(`unknown provider kind: ${provider}`);
  }
  const declared = [...new Set(input.providers)].sort() as ProviderStubKind[];
  return {
    registryVersion: PROVIDER_STUB_REGISTRY_VERSION,
    seed: input.seed,
    declared,
    declaredSetHash: hashCanonicalValue({ version: PROVIDER_STUB_REGISTRY_VERSION, declared }),
  };
}

export function isProviderStubbed(
  registry: ProviderStubRegistry,
  provider: string,
): provider is ProviderStubKind {
  return (registry.declared as readonly string[]).includes(provider);
}

/**
 * Resolve a request against the registry. Fail-closed: a provider outside the
 * closed enum or not declared for this run throws `UnstubbedProviderError`
 * rather than falling through to a real call. The response is a pure function of
 * `(seed, provider, operation, requestId)`.
 */
export function dispatchProviderStub(
  registry: ProviderStubRegistry,
  rawRequest: ProviderStubRequest,
): ProviderStubResponse {
  const request = providerStubRequestSchema.parse(rawRequest);
  if (!isProviderStubbed(registry, request.provider)) {
    throw new UnstubbedProviderError(request.provider);
  }
  const next = seededGenerator(
    registry.seed,
    request.provider,
    request.operation,
    request.requestId,
  );
  const mode = PROVIDER_RESPONSE_MODES[next() % PROVIDER_RESPONSE_MODES.length]!;
  const retryAfterMs = mode === 'RATE_LIMITED' ? 100 + (next() % (MAX_RETRY_AFTER_MS - 100)) : 0;
  const hungMs = mode === 'HUNG_CONNECT' || mode === 'HUNG_BODY'
    ? 100 + (next() % (MAX_HUNG_MS - 100))
    : 0;
  const pollAttempts = mode === 'POLLING' ? 2 + (next() % (MAX_POLL_ATTEMPTS - 2)) : 0;
  const bodyHash = createHash('sha256')
    .update(`g0-provider-body/${registry.seed}/${request.provider}/${request.operation}/${request.requestId}/${mode}`)
    .digest('hex');
  return providerStubResponseSchema.parse({
    provider: request.provider,
    operation: request.operation,
    requestId: request.requestId,
    mode,
    external: false,
    bodyHash: `sha256:${bodyHash}`,
    retryAfterMs,
    hungMs,
    pollAttempts,
  });
}

export function providerResponseIsFaultMode(response: ProviderStubResponse): boolean {
  return FAULT_MODES.has(response.mode);
}

// --- fail-closed provider-stub ledger ---

export const providerStubExchangeSchema = z.object({
  request: providerStubRequestSchema,
  response: providerStubResponseSchema,
});
export type ProviderStubExchange = z.infer<typeof providerStubExchangeSchema>;

export type ProviderStubLedgerEntryStatus =
  | 'STUBBED'
  | 'UNSTUBBED_ACCESS'
  | 'NONDETERMINISTIC'
  | 'EXTERNAL_EFFECT'
  | 'MISMATCHED_ECHO';

export interface ProviderStubLedgerEntry {
  provider: string;
  operation: string;
  requestId: string;
  status: ProviderStubLedgerEntryStatus;
  mode?: ProviderResponseMode;
}

export interface ProviderStubLedger {
  schemaVersion: typeof PROVIDER_STUB_LEDGER_VERSION;
  declaredSetHash: `sha256:${string}`;
  sourceExchangeLogHash: `sha256:${string}`;
  entries: ProviderStubLedgerEntry[];
  summary: {
    exchanges: number;
    stubbed: number;
    unstubbed: number;
    nondeterministic: number;
    external: number;
    mismatchedEcho: number;
  };
  containmentStatus: 'STUBBED' | 'ESCAPED';
}

export function hashProviderExchangeLog(
  exchanges: readonly ProviderStubExchange[],
): `sha256:${string}` {
  return hashCanonicalValue({
    version: PROVIDER_STUB_LEDGER_VERSION,
    exchanges: exchanges.map((exchange) => ({
      request: exchange.request,
      response: exchange.response,
    })),
  });
}

/**
 * Derive the fail-closed provider-stub ledger. Independent of the registry's own
 * bookkeeping: each logged exchange is re-dispatched against the registry, and
 * an unstubbed provider, a claimed external effect, an echo that does not match
 * the request, or any response byte that differs from the exact deterministic
 * one classifies the run `ESCAPED`.
 */
export function deriveProviderStubLedger(input: {
  registry: ProviderStubRegistry;
  exchanges: readonly ProviderStubExchange[];
}): ProviderStubLedger {
  const exchanges = input.exchanges.map((exchange) => providerStubExchangeSchema.parse(exchange));
  const entries: ProviderStubLedgerEntry[] = [];
  const summary = {
    exchanges: exchanges.length,
    stubbed: 0,
    unstubbed: 0,
    nondeterministic: 0,
    external: 0,
    mismatchedEcho: 0,
  };
  for (const { request, response } of exchanges) {
    const base = { provider: request.provider, operation: request.operation, requestId: request.requestId };
    if (!isProviderStubbed(input.registry, request.provider)) {
      summary.unstubbed += 1;
      entries.push({ ...base, status: 'UNSTUBBED_ACCESS' });
      continue;
    }
    if (
      response.provider !== request.provider
      || response.operation !== request.operation
      || response.requestId !== request.requestId
    ) {
      summary.mismatchedEcho += 1;
      entries.push({ ...base, status: 'MISMATCHED_ECHO', mode: response.mode });
      continue;
    }
    if (response.external !== false) {
      summary.external += 1;
      entries.push({ ...base, status: 'EXTERNAL_EFFECT', mode: response.mode });
      continue;
    }
    const expected = dispatchProviderStub(input.registry, request);
    if (hashCanonicalValue(expected) !== hashCanonicalValue(response)) {
      summary.nondeterministic += 1;
      entries.push({ ...base, status: 'NONDETERMINISTIC', mode: response.mode });
      continue;
    }
    summary.stubbed += 1;
    entries.push({ ...base, status: 'STUBBED', mode: response.mode });
  }
  const contained = summary.unstubbed === 0
    && summary.nondeterministic === 0
    && summary.external === 0
    && summary.mismatchedEcho === 0;
  return {
    schemaVersion: PROVIDER_STUB_LEDGER_VERSION,
    declaredSetHash: input.registry.declaredSetHash,
    sourceExchangeLogHash: hashProviderExchangeLog(exchanges),
    entries,
    summary,
    containmentStatus: contained ? 'STUBBED' : 'ESCAPED',
  };
}
