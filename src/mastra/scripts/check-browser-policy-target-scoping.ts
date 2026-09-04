#!/usr/bin/env tsx
/**
 * check:browser-policy-target-scoping — the 12 test vectors from
 * ideas/plan-wdrozenia-skilli-2026-08-26.md §5.4a, verbatim. Three of them
 * obtain the specific bugs a plausible-looking classifier would have:
 *
 *   #1  localhost:4111, started by THIS run → still own_live_data (nadrzędność:
 *       a known production surface is never trusted just because this run
 *       happens to have launched something there)
 *   #5  localhost:5173, NOT started by this run → external, not own_workspace
 *       (a port is "mine" only while I hold it — a leftover dev server from
 *       yesterday gets no special trust)
 *   #11 localhost:5173, started by this run, but the target element is a
 *       password field → blocked regardless of workspace ownership
 */
import assert from 'node:assert/strict';
import {
  classifyBrowserTarget,
  isTier1Element,
  type BrowserTargetClass,
} from '../config/browser-surfaces.js';

console.log('check:browser-policy-target-scoping');

const vectors: Array<{
  url: string;
  runStartedPorts: number[];
  expected: BrowserTargetClass;
  note: string;
}> = [
  { url: 'http://localhost:4111/agents', runStartedPorts: [4111], expected: 'own_live_data', note: 'mastra slot A (live) — nadrzędność nawet gdy TEN run go wystartował' },
  { url: 'http://localhost:4222/health', runStartedPorts: [], expected: 'own_live_data', note: 'mastra slot B (staging)' },
  { url: 'http://localhost:5678/workflow/12', runStartedPorts: [5678], expected: 'own_live_data', note: 'n8n' },
  { url: 'http://localhost:5173/', runStartedPorts: [5173], expected: 'own_workspace', note: 'port wystartowany przez TEN run' },
  { url: 'http://localhost:5173/', runStartedPorts: [], expected: 'external', note: 'port z poprzedniej sesji — nie jest własny na zawsze' },
  { url: 'http://127.0.0.1:5173/', runStartedPorts: [5173], expected: 'own_workspace', note: '127.0.0.1 == localhost' },
  { url: 'http://[::1]:5173/', runStartedPorts: [5173], expected: 'own_workspace', note: 'IPv6 loopback == localhost' },
  { url: 'https://gastrobridge.pl/kontakt', runStartedPorts: [5173], expected: 'external', note: 'zewnętrzny host' },
  { url: 'file:///etc/passwd', runStartedPorts: [], expected: 'blocked', note: 'protokół inny niż http/https' },
  { url: 'nie-jest-urlem', runStartedPorts: [], expected: 'external', note: 'nie parsuje się jako host+port → fail do external' },
  { url: 'http://169.254.169.254/computeMetadata/v1/', runStartedPorts: [], expected: 'blocked', note: 'cloud instance metadata IP' },
  { url: 'http://192.168.1.1/admin', runStartedPorts: [], expected: 'blocked', note: 'RFC1918 prywatna podsieć' },
];

for (const [idx, v] of vectors.entries()) {
  const result = classifyBrowserTarget(v.url, new Set(v.runStartedPorts));
  assert.equal(
    result,
    v.expected,
    `Wektor #${idx + 1} (${v.note}): "${v.url}" z runStartedPorts=${JSON.stringify(v.runStartedPorts)} — oczekiwano "${v.expected}", otrzymano "${result}"`,
  );
  console.log(`  ✓ #${idx + 1} ${v.url} [ports=${JSON.stringify(v.runStartedPorts)}] → ${result} (${v.note})`);
}

// Wektor #11 z planu: własna piaskownica NIE oznacza wolno wpisać hasło.
assert.equal(
  classifyBrowserTarget('http://localhost:5173/login', new Set([5173])),
  'own_workspace',
  'target sam w sobie jest own_workspace',
);
assert.equal(
  isTier1Element('input[type=password]'),
  true,
  'ale element jest tier-1 i musi być zablokowany NIEZALEŻNIE od klasy celu — sprawdzane osobno w harness-policy.ts',
);
console.log('  ✓ #11 password field → tier-1 (blokowane niezależnie od klasy celu w harness-policy.ts)');

assert.equal(
  isTier1Element('input[autocomplete="cc-number"]'),
  true,
  'pole numeru karty jest tier-1',
);
console.log('  ✓ #12 credit card field → tier-1 (blokowane niezależnie od klasy celu)');

console.log(`\n✅ check:browser-policy-target-scoping — all ${vectors.length + 2} vectors passed`);
process.exit(0);
