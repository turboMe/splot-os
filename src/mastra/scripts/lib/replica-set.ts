/**
 * One place where a script decides whether its durability section can run —
 * and whether "cannot run" is allowed to stay silent.
 *
 * The hole this closes: every durability section used to open with its own
 * `MONGODB_URI_SPIKE_RS ?? 'mongodb://localhost:27018/?replicaSet=rs0'` and
 * print `⚠ SKIP` when nothing answered. `npm run check:all` never starts that
 * ephemeral replica set and the container runs with `--rm`, so the gate exited
 * 0 while five sections had not executed a single assertion.
 *
 * Two rules:
 *
 *  1. LOOK WHERE THE MACHINE ACTUALLY HAS ONE. The ephemeral spike on :27018
 *     stays the first choice (isolated, and the historical default), but the
 *     real single-node `rs0` behind `MONGODB_URI_V2` (:27017) is tried next —
 *     the same replica set `check:durable-job-tools` and
 *     `check:dashboard-orchestration` have always used. Every caller passes a
 *     throwaway database name and drops it; the application database is never
 *     touched.
 *
 *  2. `REQUIRE_RS=1` TURNS A SKIP INTO A FAILURE. `check:all` sets it, so the
 *     gate fails loudly instead of reporting green on assertions that never
 *     ran. Without the flag the skip stays a skip, so a developer with no
 *     Docker and no local Mongo still runs every deterministic section.
 *
 * An explicit `MONGODB_URI_SPIKE_RS` is honoured as the ONLY candidate: when an
 * operator names a server, silently retargeting a different one would hide the
 * very mistake they need to see.
 */
import type { V2Store } from '../../orchestration/store/connect.js';

/** The isolated spike replica set (`npm run spike:mongo-rs:up`). */
export const EPHEMERAL_RS_URI = 'mongodb://localhost:27018/?replicaSet=rs0';
const LOCAL_RS_URI = 'mongodb://localhost:27017/?replicaSet=rs0';

/** How long a single candidate gets to answer `hello` before we move on. */
const PROBE_TIMEOUT_MS = 2_500;

/** `check:all` sets this; nothing may be skipped under it. */
export function replicaSetRequired(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.REQUIRE_RS ?? '').trim().toLowerCase());
}

/**
 * The replica sets worth trying, in order, deduplicated.
 * Exported so the preflight can report exactly what the checks will do.
 */
export function replicaSetCandidates(): string[] {
  const explicit = process.env.MONGODB_URI_SPIKE_RS?.trim();
  if (explicit) return [explicit];
  return [...new Set([EPHEMERAL_RS_URI, process.env.MONGODB_URI_V2?.trim(), LOCAL_RS_URI]
    .filter((uri): uri is string => Boolean(uri)))];
}

/** Redact credentials before a URI reaches a log line. */
export function safeUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//***@');
}

export interface ReplicaSetProbe {
  uri: string;
  ok: boolean;
  /** Why this candidate is unusable — connection error, or "not a replica set". */
  reason?: string;
  setName?: string;
}

/**
 * Ask one candidate whether it is a usable replica set.
 *
 * `hello` alone is not enough: a standalone answers it happily and then fails
 * mid-test on the first transaction, which reads as a broken assertion rather
 * than a missing prerequisite. A usable server reports a `setName`.
 */
export async function probeReplicaSet(uri: string): Promise<ReplicaSetProbe> {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: PROBE_TIMEOUT_MS });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 }) as { setName?: string };
    if (!hello.setName) {
      return { uri, ok: false, reason: 'reachable, but a standalone — transactions need a replica set' };
    }
    return { uri, ok: true, setName: hello.setName };
  } catch (error) {
    return { uri, ok: false, reason: (error as Error).message };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export interface ReplicaSetLookup {
  uri?: string;
  setName?: string;
  probes: ReplicaSetProbe[];
}

/** First candidate that answers as a replica set, plus what every candidate said. */
export async function findReplicaSet(): Promise<ReplicaSetLookup> {
  const probes: ReplicaSetProbe[] = [];
  for (const candidate of replicaSetCandidates()) {
    const probe = await probeReplicaSet(candidate);
    probes.push(probe);
    if (probe.ok) return { uri: probe.uri, setName: probe.setName, probes };
  }
  return { probes };
}

/** The actionable half of every message this module prints. */
function howToFix(): string {
  return 'start one with `npm run spike:mongo-rs:up`, or point MONGODB_URI_V2 at a replica set';
}

function describe(probes: ReplicaSetProbe[]): string {
  return probes.map((p) => `      - ${safeUri(p.uri)} → ${p.reason ?? 'unusable'}`).join('\n');
}

/**
 * Refuse to skip `section` when `REQUIRE_RS=1`, otherwise let it be skipped.
 *
 * Exits the process (code 1) rather than returning a value the caller could
 * forget to act on — an unexecuted assertion must never be able to reach the
 * gate's exit code as a success.
 */
export function skipSectionOrFail(section: string, reason: string, fix: string): void {
  if (replicaSetRequired()) {
    console.error(`  ✗ ${section} cannot be skipped: REQUIRE_RS=1 and ${reason}`);
    console.error(`    fix: ${fix}`);
    process.exit(1);
  }
  console.log(`  ⚠ SKIP ${section} — ${reason}. fix: ${fix}`);
}

/**
 * The URI of a usable replica set, or `null` when the section may be skipped.
 *
 * For callers that need the URI itself (`configureV2Mount`) rather than a
 * connection. Under `REQUIRE_RS=1` it never returns `null` — it exits 1 first.
 */
export async function replicaSetUriOrSkip(section = 'this check'): Promise<string | null> {
  const found = await findReplicaSet();
  if (found.uri) return found.uri;

  if (replicaSetRequired()) {
    console.error(`  ✗ ${section} cannot be skipped: REQUIRE_RS=1 and no MongoDB replica set answered.`);
    console.error(`    tried:\n${describe(found.probes)}`);
    console.error(`    fix: ${howToFix()}`);
    process.exit(1);
  }

  const tried = found.probes.map((p) => safeUri(p.uri)).join(', ');
  console.log(`  ⚠ SKIP ${section} — no replica set at ${tried}. Run: npm run spike:mongo-rs:up`);
  return null;
}

export interface ConnectOptions {
  /** Throwaway database name. Callers drop it; never pass the application database. */
  dbName: string;
  /** What is being skipped, for the log line. Defaults to the whole script. */
  section?: string;
}

/**
 * Connect to a replica set for a durability section.
 *
 * Returns `null` only when the section may legitimately be skipped. Under
 * `REQUIRE_RS=1` it never returns `null` — it exits 1 first.
 */
export async function connectReplicaSetOrSkip(opts: ConnectOptions): Promise<V2Store | null> {
  const uri = await replicaSetUriOrSkip(opts.section);
  if (!uri) return null;

  const { connectV2Store } = await import('../../orchestration/store/connect.js');
  return connectV2Store({ uri, dbName: opts.dbName });
}
