/**
 * Graphify integration (Etap 8 — code impact map).
 *
 * Thin, safe wrapper around the local `graphify` CLI (github Graphify-Labs,
 * PyPI `graphifyy`). Spike verdict (ideas/e8-graphify-plan.md §5a): the precise
 * structural commands (`affected`, `explain`, `god-nodes`) are the value — not
 * fuzzy NL query. `affected` gives complete transitive impact of a symbol in
 * ~400 tokens vs ~14k to read the touching files (measured).
 *
 * This module owns ONLY the read path (`affected`). Graph building is a
 * lifecycle concern (npm run graph:build / graph:update), not a tool call.
 *
 * Fail-soft: if the CLI or the graph is missing, callers get a structured
 * "unavailable" result and fall back to code_search/repo_map — never a throw.
 */

import { execFile } from 'node:child_process';
import { existsSync, openSync, fstatSync, readSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 20_000;

export type AffectedEdge = { label: string; relation: string; file: string; line: number };

export type AffectedResult =
  | { available: true; symbol: string; depth: number; relations: string[]; affected: AffectedEdge[]; raw: string; staleness?: string }
  | { available: false; reason: string; hint: string };

export function isGraphifyEnabled(): boolean {
  return isHarnessFeatureEnabled('FEATURE_GRAPHIFY', true);
}

/** Path to the graphify executable (override with GRAPHIFY_BIN). */
export function graphifyBin(): string {
  if (process.env.GRAPHIFY_BIN) return process.env.GRAPHIFY_BIN;
  const homeVenv = resolve(process.env.HOME || '', '.venvs', 'graphify', 'bin', 'graphify');
  if (existsSync(homeVenv)) return homeVenv;
  return 'graphify';
}

/** Path to the built graph (override with GRAPHIFY_GRAPH). */
export function graphPath(): string {
  return process.env.GRAPHIFY_GRAPH
    || resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', 'graphify-out', 'graph.json');
}

/**
 * Read the commit hash at which the graph was built (`built_at_commit`).
 * Fast tail-read first (the 24MB graph.json has metadata near the end),
 * with safe fallback to full read. Fail-soft.
 */
export function readGraphBuiltAtCommit(filePath?: string): string | undefined {
  const g = filePath ?? graphPath();
  if (!existsSync(g)) return undefined;
  try {
    const fd = openSync(g, 'r');
    const stat = fstatSync(fd);
    const size = stat.size;
    const bufSize = Math.min(65536, size);
    const buf = Buffer.alloc(bufSize);
    readSync(fd, buf, 0, bufSize, Math.max(0, size - bufSize));
    closeSync(fd);
    const text = buf.toString('utf8');
    const match = text.match(/"built_at_commit":\s*"([a-f0-9]{40})"/i);
    if (match) return match[1];

    // Fallback: search the whole file if small enough
    if (size < 10 * 1024 * 1024) {
      const full = readFileSync(g, 'utf8');
      const m = full.match(/"built_at_commit":\s*"([a-f0-9]{40})"/i);
      if (m) return m[1];
    }
  } catch {
    // Fail-soft
  }
  return undefined;
}

/**
 * Check freshness of the graph against current git HEAD.
 * Returns human-readable staleness status.
 */
export async function getGraphStaleness(options?: {
  graphPath?: string;
  cwd?: string;
}): Promise<string> {
  const targetGraph = options?.graphPath ?? graphPath();
  if (!existsSync(targetGraph)) {
    return 'graph not found';
  }
  const builtCommit = readGraphBuiltAtCommit(targetGraph);
  if (!builtCommit) {
    return 'graph built_at_commit unknown';
  }

  const repoCwd = options?.cwd ?? AGENTIC_AGENTS_REPO;
  try {
    const { stdout: headStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoCwd,
      timeout: 5_000,
    });
    const headCommit = headStdout.trim();
    if (!headCommit) return 'git status unavailable';

    if (headCommit === builtCommit) {
      return 'graph up to date (built at HEAD)';
    }

    try {
      const { stdout: countStdout } = await execFileAsync(
        'git',
        ['rev-list', '--count', `${builtCommit}..HEAD`],
        { cwd: repoCwd, timeout: 5_000 },
      );
      const count = parseInt(countStdout.trim(), 10);
      if (!Number.isNaN(count) && count >= 0) {
        return `graph built at ${builtCommit.slice(0, 7)}, HEAD is ${count} commit${count === 1 ? '' : 's'} ahead — may miss the ${count} most recent change${count === 1 ? '' : 's'}`;
      }
    } catch {
      // Fallback if rev-list fails
    }

    return `graph built at ${builtCommit.slice(0, 7)}, HEAD is ${headCommit.slice(0, 7)} (mismatch)`;
  } catch {
    return 'git status unavailable';
  }
}

/**
 * Parse `graphify affected` stdout into structured edges. Pure — unit-tested.
 * Expected lines:
 *   Affected nodes for transitionLane()
 *   Relations: calls, indirect_call, references, ...
 *   Depth: 2
 *   - <label> [<relation>] <file>:L<line>
 */
export function parseAffectedOutput(stdout: string): { relations: string[]; depth: number; affected: AffectedEdge[] } {
  const lines = (stdout ?? '').split(/\r?\n/);
  let relations: string[] = [];
  let depth = 0;
  const affected: AffectedEdge[] = [];

  const lineRe = /^-\s+(.+?)\s+\[([^\]]+)\]\s+(.+?):L(\d+)\s*$/;
  for (const line of lines) {
    const rel = line.match(/^Relations:\s*(.+)$/i);
    if (rel) { relations = rel[1]!.split(',').map((s) => s.trim()).filter(Boolean); continue; }
    const d = line.match(/^Depth:\s*(\d+)/i);
    if (d) { depth = Number(d[1]); continue; }
    const m = line.match(lineRe);
    if (m) affected.push({ label: m[1]!.trim(), relation: m[2]!.trim(), file: m[3]!.trim(), line: Number(m[4]) });
  }
  return { relations, depth, affected };
}

// ── explain ────────────────────────────────────────────────────────────────

export type ExplainConnection = { direction: 'in' | 'out'; node: string; relation: string; tag: string };
export type ExplainResult =
  | { available: true; node: string; id?: string; source?: string; type?: string; community?: string; degree?: number; connections: ExplainConnection[]; raw: string; staleness?: string }
  | { available: false; reason: string; hint: string };

/** Pure parser for `graphify explain` output. */
export function parseExplainOutput(stdout: string): Omit<Extract<ExplainResult, { available: true }>, 'available' | 'raw'> {
  const lines = (stdout ?? '').split(/\r?\n/);
  let node = '';
  let id: string | undefined;
  let source: string | undefined; let type: string | undefined; let community: string | undefined; let degree: number | undefined;
  const connections: ExplainConnection[] = [];
  const connRe = /^\s*(<--|-->)\s+(.+?)\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s*$/;
  for (const line of lines) {
    const n = line.match(/^Node:\s*(.+)$/); if (n) { node = n[1]!.trim(); continue; }
    // The graph's internal id. `affected` resolves ONLY by id, so this is the
    // bridge between a symbol a human types and a query the CLI can answer.
    const i = line.match(/^\s*ID:\s*(\S+)/); if (i) { id = i[1]!.trim(); continue; }
    const s = line.match(/^\s*Source:\s*(.+)$/); if (s) { source = s[1]!.trim(); continue; }
    const t = line.match(/^\s*Type:\s*(.+)$/); if (t) { type = t[1]!.trim(); continue; }
    const c = line.match(/^\s*Community:\s*(.+)$/); if (c) { community = c[1]!.trim(); continue; }
    const d = line.match(/^\s*Degree:\s*(\d+)/); if (d) { degree = Number(d[1]); continue; }
    const m = line.match(connRe);
    if (m) connections.push({ direction: m[1] === '-->' ? 'out' : 'in', node: m[2]!.trim(), relation: m[3]!.trim(), tag: m[4]!.trim() });
  }
  return { node, source, type, community, degree, connections, ...(id ? { id } : {}) };
}

// ── god-nodes ────────────────────────────────────────────────────────────────

export type GodNode = { rank: number; label: string; edges: number };
export type GodNodesResult =
  | { available: true; nodes: GodNode[]; raw: string; staleness?: string }
  | { available: false; reason: string; hint: string };

/** Pure parser for `graphify god-nodes` output. */
export function parseGodNodesOutput(stdout: string): GodNode[] {
  const nodes: GodNode[] = [];
  const re = /^\s*(\d+)\.\s+(.+?)\s+-\s+(\d+)\s+edges\s*$/;
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    const m = line.match(re);
    if (m) nodes.push({ rank: Number(m[1]), label: m[2]!.trim(), edges: Number(m[3]) });
  }
  return nodes;
}

async function binAvailable(): Promise<boolean> {
  try {
    await execFileAsync(graphifyBin(), ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reverse-dependency impact of a symbol: what calls/imports/references it
 * (transitively, to `depth`). Fail-soft.
 */
export async function runGraphifyAffected(input: {
  symbol: string;
  depth?: number;
  timeoutMs?: number;
}): Promise<AffectedResult> {
  if (!isGraphifyEnabled()) {
    return { available: false, reason: 'FEATURE_GRAPHIFY=false', hint: 'Enable the flag or use code_search/repo_map.' };
  }
  const g = graphPath();
  if (!existsSync(g)) {
    return {
      available: false,
      reason: `graph not found at ${g}`,
      hint: 'Build it once: `npm run graph:build` (then `npm run graph:update` after code changes). Meanwhile use code_search/repo_map.',
    };
  }
  if (!(await binAvailable())) {
    return {
      available: false,
      reason: `graphify CLI not runnable (${graphifyBin()})`,
      hint: 'Install: `pipx install graphifyy==0.9.22` (or set GRAPHIFY_BIN). Meanwhile use code_search/repo_map.',
    };
  }

  const depth = Math.max(1, Math.min(4, input.depth ?? 2));
  try {
    const { stdout } = await execFileAsync(
      graphifyBin(),
      ['affected', input.symbol, '--graph', g, '--depth', String(depth)],
      { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed = parseAffectedOutput(stdout);

    // Did the CLI actually FIND the node?
    //
    // `affected` resolves by the graph's internal id and answers a name it
    // cannot pin down with `No unique node match for <symbol>` — on stdout, exit
    // code 0. Parsed naively that is zero edges, and the tool reported
    // "0 nodes depend on getDb" for a symbol whose own `explain` shows degree
    // 396. For an impact-analysis tool that is the worst possible failure: it
    // says "nothing depends on this, safe to change" when it never looked.
    //
    // Detected on the SUCCESS header rather than on the error sentence, so the
    // check does not depend on the CLI's exact wording.
    const resolved = /^Affected nodes for /m.test(stdout);
    if (!resolved) {
      // Resolve the name the way a human would: `explain` accepts it and prints
      // the id, so ask once and retry. This is what makes the tool usable at all
      // — nobody knows an id like `lib_mongo_getdb` before asking.
      const explained = await runGraphifyExplain({ symbol: input.symbol, timeoutMs: input.timeoutMs });
      const nodeId = explained.available ? explained.id : undefined;
      if (!nodeId) {
        return {
          available: false,
          reason: `graphify could not identify a unique node for "${input.symbol}"`,
          hint: 'Use graphify_explain to find the exact node (its ID line), then pass that id. '
            + 'A qualified name usually disambiguates.',
        };
      }
      const retry = await execFileAsync(
        graphifyBin(),
        ['affected', nodeId, '--graph', g, '--depth', String(depth)],
        { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      const reparsed = parseAffectedOutput(retry.stdout);
      const staleness = await getGraphStaleness({ graphPath: g });
      return {
        available: true, symbol: input.symbol, depth,
        relations: reparsed.relations, affected: reparsed.affected, raw: retry.stdout,
        staleness,
      };
    }

    const staleness = await getGraphStaleness({ graphPath: g });
    return { available: true, symbol: input.symbol, depth, relations: parsed.relations, affected: parsed.affected, raw: stdout, staleness };
  } catch (err) {
    return {
      available: false,
      reason: `graphify affected failed: ${(err as Error).message.slice(0, 200)}`,
      hint: 'Rebuild the graph (`npm run graph:update`) or use code_search/repo_map.',
    };
  }
}

/** Shared preflight: FEATURE flag, graph file, CLI runnable. */
async function graphifyPreflight(): Promise<{ ok: true } | { ok: false; reason: string; hint: string }> {
  if (!isGraphifyEnabled()) return { ok: false, reason: 'FEATURE_GRAPHIFY=false', hint: 'Enable the flag or use code_search/repo_map.' };
  const g = graphPath();
  if (!existsSync(g)) return { ok: false, reason: `graph not found at ${g}`, hint: 'Build it: `npm run graph:build`. Meanwhile use code_search/repo_map.' };
  if (!(await binAvailable())) return { ok: false, reason: `graphify CLI not runnable (${graphifyBin()})`, hint: 'Install graphifyy or set GRAPHIFY_BIN. Meanwhile use code_search/repo_map.' };
  return { ok: true };
}

/** Node details + neighbors (who imports/calls it, what it calls). Fail-soft. */
export async function runGraphifyExplain(input: { symbol: string; timeoutMs?: number }): Promise<ExplainResult> {
  const pre = await graphifyPreflight();
  if (!pre.ok) return { available: false, reason: pre.reason, hint: pre.hint };
  try {
    const { stdout } = await execFileAsync(
      graphifyBin(), ['explain', input.symbol, '--graph', graphPath()],
      { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    const staleness = await getGraphStaleness();
    return { available: true, ...parseExplainOutput(stdout), raw: stdout, staleness };
  } catch (err) {
    return { available: false, reason: `graphify explain failed: ${(err as Error).message.slice(0, 200)}`, hint: 'Rebuild the graph or use code_search.' };
  }
}

/** Most-connected nodes (architectural hubs). Fail-soft. */
export async function runGraphifyGodNodes(input: { top?: number; timeoutMs?: number } = {}): Promise<GodNodesResult> {
  const pre = await graphifyPreflight();
  if (!pre.ok) return { available: false, reason: pre.reason, hint: pre.hint };
  const top = Math.max(1, Math.min(50, input.top ?? 12));
  try {
    const { stdout } = await execFileAsync(
      graphifyBin(), ['god-nodes', '--graph', graphPath(), '--top', String(top)],
      { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    const staleness = await getGraphStaleness();
    return { available: true, nodes: parseGodNodesOutput(stdout), raw: stdout, staleness };
  } catch (err) {
    return { available: false, reason: `graphify god-nodes failed: ${(err as Error).message.slice(0, 200)}`, hint: 'Rebuild the graph or use repo_map.' };
  }
}

export {
  extractGraphTrendSummary,
  readGraphTrendEntries,
  appendGraphTrendEntry,
  recordCurrentGraphTrend,
  backfillGraphTrendFromSnapshots,
  pruneGraphSnapshots,
  type GraphTrendEntry,
  type GraphGodNodeSummary,
} from './graphify-trend.js';

export {
  tryInjectGraphifyBlastRadius,
  resolveFileToNodeInGraph,
  pickPrimaryTargetFile,
  normalizeRepoRelativePath,
  type GraphifyPrecontextResult,
} from './graphify-precontext.js';


