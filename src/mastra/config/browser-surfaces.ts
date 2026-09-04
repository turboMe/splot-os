/**
 * Browser & Computer-Use Target Scoping Policy.
 *
 * Classifies a URL a browser tool is about to navigate to or interact with,
 * so `harness-policy.ts` can decide whether the action needs approval without
 * the model reasoning about it turn by turn.
 *
 * The load-bearing invariant: **a loopback port is "own workspace" only while
 * THIS run holds it.** A dev server left over from a previous session, or a
 * generic port an attacker-controlled process happens to be squatting on, must
 * never be silently trusted just because it is `localhost`. Fail-closed default
 * for any unregistered loopback port is `external`, not `own_workspace`.
 *
 * Four known live/production surfaces are the opposite failure mode: no matter
 * which run started something there, they are never "own workspace" — verified
 * against `deploy.config.json` (slots A/B) and this repo's own prompts
 * (`automation/base.md §12`: "localhost:3000 ... is legacy Jarvis").
 */

export interface LoopbackSurface {
  port: number;
  label: string;
}

export const LIVE_LOOPBACK_SURFACES: readonly LoopbackSurface[] = [
  { port: 4111, label: 'mastra slot A (live)' },
  { port: 4222, label: 'mastra slot B (staging)' },
  { port: 5678, label: 'n8n' },
  { port: 3000, label: 'legacy Jarvis' },
];

/** Infra ports that are never a disposable sandbox, even on a loopback host. */
export const SENSITIVE_INFRA_PORTS: readonly number[] = [
  27017, 27018, 27019, 27020, 27021, // MongoDB (single-node + replica set members)
  6379,  // Redis
  11434, // Ollama
  2375, 2376, // Docker daemon (plain / TLS)
  9200,  // Elasticsearch
  5432,  // PostgreSQL
  3306,  // MySQL
];

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

export type BrowserTargetClass = 'own_workspace' | 'own_live_data' | 'external' | 'blocked';

const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.internal', 'instance-data']);

const BLOCKED_IP_REGEXES: RegExp[] = [
  /^169\.254\./,                      // link-local / cloud instance metadata (169.254.169.254)
  /^10\./,                            // RFC1918 class A
  /^192\.168\./,                      // RFC1918 class C
  /^172\.(1[6-9]|2\d|3[01])\./,       // RFC1918 class B
  /^0\./,                             // 0.0.0.0/8
  /^\[?fc00:/i,                       // IPv6 unique local
  /^\[?fe80:/i,                       // IPv6 link-local
];

/**
 * Classification is a pure function of the URL plus the run's OWN port
 * registry — no ambient state, no I/O, fully unit-testable.
 */
export function classifyBrowserTarget(
  rawUrl: string,
  runStartedPorts: ReadonlySet<number> = new Set(),
): BrowserTargetClass {
  if (!rawUrl || typeof rawUrl !== 'string') return 'blocked';
  const trimmed = rawUrl.trim();
  if (!trimmed) return 'blocked';

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  } catch {
    return 'blocked';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'blocked';

  const hostname = url.hostname.toLowerCase();

  if (METADATA_HOSTNAMES.has(hostname) || hostname.endsWith('.metadata.google.internal')) {
    return 'blocked';
  }

  if (!LOOPBACK_HOSTS.has(hostname)) {
    for (const pattern of BLOCKED_IP_REGEXES) {
      if (pattern.test(hostname)) return 'blocked';
    }
    return 'external';
  }

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);

  // Nadrzędne (superordinate): known live/production surfaces and sensitive
  // infra ports are NEVER own_workspace, regardless of who started them.
  if (LIVE_LOOPBACK_SURFACES.some((s) => s.port === port) || SENSITIVE_INFRA_PORTS.includes(port)) {
    return 'own_live_data';
  }

  if (runStartedPorts.has(port)) return 'own_workspace';

  // Fail-closed: an unregistered loopback port is treated as external. It may
  // be a leftover dev server from a previous session, or nothing this run has
  // any claim to — the port alone proves nothing.
  return 'external';
}

// ── Run-scoped port registry ────────────────────────────────────────────────
//
// "This run started it" has to be recorded somewhere, and the process this
// code runs in is long-lived and serves many runs over its lifetime — so the
// registry is bounded (oldest run evicted first) rather than growing forever.

const MAX_TRACKED_RUNS = 500;
const runPorts = new Map<string, Set<number>>();

export function registerRunStartedPort(runId: string | undefined, port: number): void {
  if (!runId || !Number.isInteger(port) || port <= 0) return;
  let ports = runPorts.get(runId);
  if (!ports) {
    if (runPorts.size >= MAX_TRACKED_RUNS) {
      const oldestKey = runPorts.keys().next().value;
      if (oldestKey !== undefined) runPorts.delete(oldestKey);
    }
    ports = new Set();
    runPorts.set(runId, ports);
  } else {
    // Re-insert to mark as most-recently-used for the simple insertion-order eviction above.
    runPorts.delete(runId);
    runPorts.set(runId, ports);
  }
  ports.add(port);
}

export function getRunStartedPorts(runId: string | undefined): ReadonlySet<number> {
  if (!runId) return new Set();
  return runPorts.get(runId) ?? new Set();
}

export function isRunStartedPort(runId: string | undefined, port: number): boolean {
  return getRunStartedPorts(runId).has(port);
}

/** Convenience wrapper composing the pure classifier with the run registry. */
export function classifyBrowserTargetForRun(rawUrl: string, runId: string | undefined): BrowserTargetClass {
  return classifyBrowserTarget(rawUrl, getRunStartedPorts(runId));
}

/** Best-effort port extraction from a shell command starting a dev server —
 *  used as a fallback when the caller does not explicitly declare the port. */
export function extractPortFromCommand(command: string): number | undefined {
  const patterns = [
    /--port[=\s]+(\d{2,5})\b/i,
    /-p[=\s]+(\d{2,5})\b/i,
    /\bPORT=(\d{2,5})\b/,
  ];
  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (match) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  }
  return undefined;
}

// ── Tier-1: elements that are never touched regardless of target classification ──
//
// Password fields, OTP/2FA codes, payment card fields, and CAPTCHA iframes are
// a hand-off, not an approval — the runtime never has authority to fill these
// in even inside the agent's own sandbox.

const TIER1_ELEMENT_PATTERNS: RegExp[] = [
  /type\s*=\s*["']?password/i,
  /autocomplete\s*=\s*["']?cc-/i,
  /autocomplete\s*=\s*["']?one-time-code/i,
  /\b(otp|totp|2fa|mfa|verification[_-]?code)\b/i,
  /recaptcha|hcaptcha|turnstile/i,
];

export function isTier1Element(description: string | undefined): boolean {
  if (!description) return false;
  return TIER1_ELEMENT_PATTERNS.some((pattern) => pattern.test(description));
}
