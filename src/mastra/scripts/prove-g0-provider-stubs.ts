/**
 * Deterministic end-to-end proof for the G0 provider stubs (§19.1/§19.3).
 *
 * There is no real endpoint to reach — that is the invariant — so this exercises
 * the whole registry deterministically: it stubs every provider, dispatches a
 * corpus of requests, proves the responses are byte-stable on replay and that
 * every fault-mode envelope stays bounded, reconciles the entire request/response
 * log through the fail-closed ledger (`STUBBED`), and proves that both an
 * unstubbed access and a claimed external effect escape.
 */
import assert from 'node:assert/strict';
import {
  PROVIDER_RESPONSE_MODES,
  PROVIDER_STUB_KINDS,
  UnstubbedProviderError,
  createProviderStubRegistry,
  deriveProviderStubLedger,
  dispatchProviderStub,
  providerResponseIsFaultMode,
  type ProviderStubExchange,
  type ProviderStubKind,
} from '../orchestration/testing/provider-stubs.js';

const PROOF_VERSION = 'g0-provider-stubs-live-proof/v1';
const SEED = 0x5eed_1234 >>> 0;
const OPERATIONS = ['read', 'write', 'poll', 'search'];
const REQUESTS_PER_PROVIDER = 64;

async function runProof(): Promise<void> {
  const registry = createProviderStubRegistry({ seed: SEED, providers: PROVIDER_STUB_KINDS });
  assert.equal(registry.declared.length, PROVIDER_STUB_KINDS.length, 'every provider must be declared');

  const exchanges: ProviderStubExchange[] = [];
  const observedModes = new Set<string>();
  for (const provider of PROVIDER_STUB_KINDS as readonly ProviderStubKind[]) {
    for (let i = 0; i < REQUESTS_PER_PROVIDER; i += 1) {
      const operation = OPERATIONS[i % OPERATIONS.length]!;
      const request = { provider, operation, requestId: `${provider.toLowerCase()}-${i}` };
      const response = dispatchProviderStub(registry, request);
      // Deterministic: a replay is byte-identical.
      assert.deepEqual(dispatchProviderStub(registry, request), response, 'dispatch is not deterministic');
      assert.equal(response.external, false, 'an owned stub claimed an external effect');
      // Fault-mode envelopes stay bounded, and only fault modes carry them.
      if (response.mode === 'RATE_LIMITED') assert.ok(response.retryAfterMs >= 100 && response.retryAfterMs <= 60_000);
      if (response.mode === 'HUNG_CONNECT' || response.mode === 'HUNG_BODY') assert.ok(response.hungMs >= 100 && response.hungMs <= 60_000);
      if (response.mode === 'POLLING') assert.ok(response.pollAttempts >= 2 && response.pollAttempts <= 16);
      assert.equal(
        providerResponseIsFaultMode(response),
        (['RATE_LIMITED', 'HUNG_CONNECT', 'HUNG_BODY', 'POLLING'] as string[]).includes(response.mode),
      );
      observedModes.add(response.mode);
      exchanges.push({ request, response });
    }
  }
  assert.equal(observedModes.size, PROVIDER_RESPONSE_MODES.length, 'the corpus did not exercise every response mode');

  // The whole authenticated log reconciles as fully stubbed and loopback.
  const ledger = deriveProviderStubLedger({ registry, exchanges });
  assert.equal(ledger.containmentStatus, 'STUBBED', 'a legitimate provider corpus escaped');
  assert.equal(ledger.summary.stubbed, exchanges.length);
  assert.equal(ledger.summary.unstubbed, 0);
  assert.equal(ledger.summary.external, 0);
  assert.equal(ledger.summary.nondeterministic, 0);

  // Fail-closed dispatch: a provider this run did not declare throws instead of
  // reaching out. Prove it against a registry that stubs only a subset.
  const partial = createProviderStubRegistry({ seed: SEED, providers: ['GMAIL', 'MCP'] });
  assert.throws(
    () => dispatchProviderStub(partial, { provider: 'FIRECRAWL', operation: 'scrape', requestId: 'x' }),
    UnstubbedProviderError,
  );

  // Fail-closed ledger: an unstubbed access and a claimed external effect escape.
  const gmail = { provider: 'GMAIL' as const, operation: 'read', requestId: 'esc-1' };
  const gmailResponse = dispatchProviderStub(partial, gmail);
  const unstubbed = deriveProviderStubLedger({
    registry: partial,
    exchanges: [{ request: { ...gmail, provider: 'FIRECRAWL' }, response: { ...gmailResponse, provider: 'FIRECRAWL' } }],
  });
  assert.equal(unstubbed.containmentStatus, 'ESCAPED');
  const external = deriveProviderStubLedger({
    registry: partial,
    exchanges: [{ request: gmail, response: { ...gmailResponse, external: true } }],
  });
  assert.equal(external.containmentStatus, 'ESCAPED');

  console.log(JSON.stringify({
    schemaVersion: PROOF_VERSION,
    status: 'PASSED',
    registry: {
      seed: registry.seed,
      declaredProviders: registry.declared.length,
      declaredSetHash: registry.declaredSetHash,
    },
    corpus: {
      exchanges: exchanges.length,
      providers: PROVIDER_STUB_KINDS.length,
      modesExercised: observedModes.size,
    },
    ledger: {
      containmentStatus: ledger.containmentStatus,
      stubbed: ledger.summary.stubbed,
      sourceExchangeLogHash: ledger.sourceExchangeLogHash,
    },
    failClosed: {
      unstubbedDispatchThrows: true,
      unstubbedLedgerEscapes: unstubbed.containmentStatus === 'ESCAPED',
      externalEffectLedgerEscapes: external.containmentStatus === 'ESCAPED',
    },
  }));
}

await runProof();
