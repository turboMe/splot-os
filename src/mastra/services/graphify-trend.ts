/**
 * Graphify Trend & Snapshot Retention (Phase 2 — Stream C).
 *
 * Extracts lightweight micro-summaries (~1KB per record) into append-only
 * `trend.jsonl` instead of retaining unbounded raw daily `graph.json` snapshots (~25MB/day).
 * Enforces retention policy on old snapshot directories.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { graphPath, readGraphBuiltAtCommit, runGraphifyGodNodes } from './graphify.js';

export interface GraphGodNodeSummary {
  label: string;
  edges: number;
}

export interface GraphTrendEntry {
  date: string;
  commit: string;
  nodes: number;
  links: number;
  communities: number;
  top_god_nodes: GraphGodNodeSummary[];
}

export function defaultTrendPath(): string {
  return process.env.GRAPHIFY_TREND_PATH
    || resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', 'graphify-out', 'trend.jsonl');
}

export function defaultGraphifyOutDir(): string {
  return resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', 'graphify-out');
}

/**
 * Calculate god nodes directly from in-memory parsed graph data as a fail-safe.
 */
export function calculateGodNodesFromData(nodes: any[], links: any[], topCount = 10): GraphGodNodeSummary[] {
  const counts = new Map<string, number>();
  const labelMap = new Map<string, string>();

  for (const n of nodes || []) {
    if (n && n.id) {
      counts.set(n.id, 0);
      labelMap.set(n.id, n.label || n.id);
    }
  }

  for (const l of links || []) {
    if (l && l.source && l.target) {
      counts.set(l.source, (counts.get(l.source) || 0) + 1);
      counts.set(l.target, (counts.get(l.target) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topCount)
    .map(([id, edges]) => ({
      label: labelMap.get(id) || id,
      edges,
    }));
}

/**
 * Extract a compact trend summary object from a graph.json file.
 */
export async function extractGraphTrendSummary(options?: {
  graphPath?: string;
  topCount?: number;
  date?: string;
  commit?: string;
}): Promise<GraphTrendEntry | null> {
  const targetGraph = options?.graphPath ?? graphPath();
  if (!existsSync(targetGraph)) return null;

  try {
    const raw = readFileSync(targetGraph, 'utf8');
    const parsed = JSON.parse(raw);

    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    const links = Array.isArray(parsed.links) ? parsed.links : [];

    const communitySet = new Set<any>();
    for (const n of nodes) {
      if (n && n.community !== undefined && n.community !== null) {
        communitySet.add(n.community);
      }
    }

    const commit = options?.commit
      || parsed.built_at_commit
      || readGraphBuiltAtCommit(targetGraph)
      || 'unknown';

    const date = options?.date || new Date().toISOString().slice(0, 10);

    // Try CLI god-nodes first if inspecting main active graph, else compute from data
    let topGodNodes: GraphGodNodeSummary[] = [];
    const topCount = options?.topCount ?? 10;

    if (targetGraph === graphPath()) {
      try {
        const gnResult = await runGraphifyGodNodes({ top: topCount });
        if (gnResult.available && gnResult.nodes.length > 0) {
          topGodNodes = gnResult.nodes.map((n) => ({ label: n.label, edges: n.edges }));
        }
      } catch {
        // Fallback to in-data calculation
      }
    }

    if (topGodNodes.length === 0) {
      topGodNodes = calculateGodNodesFromData(nodes, links, topCount);
    }

    return {
      date,
      commit,
      nodes: nodes.length,
      links: links.length,
      communities: communitySet.size,
      top_god_nodes: topGodNodes,
    };
  } catch {
    return null;
  }
}

/**
 * Read all entries from trend.jsonl.
 */
export function readGraphTrendEntries(trendFilePath?: string): GraphTrendEntry[] {
  const target = trendFilePath ?? defaultTrendPath();
  if (!existsSync(target)) return [];

  try {
    const lines = readFileSync(target, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
    const entries: GraphTrendEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip corrupted line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Append a single trend record to trend.jsonl if not duplicate.
 */
export function appendGraphTrendEntry(
  entry: GraphTrendEntry,
  trendFilePath?: string,
): { appended: boolean; reason?: string } {
  const target = trendFilePath ?? defaultTrendPath();
  try {
    mkdirSync(dirname(target), { recursive: true });

    if (existsSync(target)) {
      const existing = readGraphTrendEntries(target);
      const last = existing[existing.length - 1];
      if (last && last.date === entry.date && last.commit === entry.commit) {
        return { appended: false, reason: 'identical latest entry already present' };
      }
    }

    appendFileSync(target, JSON.stringify(entry) + '\n', 'utf8');
    return { appended: true };
  } catch (err) {
    return { appended: false, reason: (err as Error).message };
  }
}

/**
 * Record the current active graph state into trend.jsonl.
 */
export async function recordCurrentGraphTrend(options?: {
  graphPath?: string;
  trendFilePath?: string;
  topCount?: number;
}): Promise<{ ok: boolean; entry?: GraphTrendEntry; reason?: string }> {
  const summary = await extractGraphTrendSummary(options);
  if (!summary) {
    return { ok: false, reason: 'Failed to extract summary from graph.json' };
  }

  const res = appendGraphTrendEntry(summary, options?.trendFilePath);
  return { ok: res.appended, entry: summary, reason: res.reason };
}

/**
 * Backfill historical trend entries from existing daily snapshot directories.
 */
export async function backfillGraphTrendFromSnapshots(options?: {
  baseDir?: string;
  trendFilePath?: string;
}): Promise<{ processed: number; added: number }> {
  const base = options?.baseDir ?? defaultGraphifyOutDir();
  const trendPath = options?.trendFilePath ?? defaultTrendPath();
  if (!existsSync(base)) return { processed: 0, added: 0 };

  const dateDirs = readdirSync(base)
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .sort();

  const existing = readGraphTrendEntries(trendPath);
  const existingKeys = new Set(existing.map((e) => `${e.date}:${e.commit}`));
  const existingDates = new Set(existing.map((e) => e.date));

  let processed = 0;
  let added = 0;
  const newEntries: GraphTrendEntry[] = [...existing];

  for (const d of dateDirs) {
    const snapGraph = join(base, d, 'graph.json');
    if (!existsSync(snapGraph)) continue;
    processed++;

    if (existingDates.has(d)) continue; // date already recorded

    const summary = await extractGraphTrendSummary({
      graphPath: snapGraph,
      date: d,
    });

    if (summary && !existingKeys.has(`${summary.date}:${summary.commit}`)) {
      newEntries.push(summary);
      existingKeys.add(`${summary.date}:${summary.commit}`);
      added++;
    }
  }

  if (added > 0) {
    // Sort chronologically by date
    newEntries.sort((a, b) => a.date.localeCompare(b.date));
    mkdirSync(dirname(trendPath), { recursive: true });
    const content = newEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(trendPath, content, 'utf8');
  }

  return { processed, added };
}

/**
 * Retain only recent daily snapshots (default 7 days). Removes older snapshot dirs.
 */
export function pruneGraphSnapshots(options?: {
  baseDir?: string;
  retentionDays?: number;
  nowDate?: string;
}): { pruned: string[]; kept: string[] } {
  const base = options?.baseDir ?? defaultGraphifyOutDir();
  if (!existsSync(base)) return { pruned: [], kept: [] };

  const retentionDays = options?.retentionDays
    ?? (process.env.GRAPH_RETENTION_DAYS ? parseInt(process.env.GRAPH_RETENTION_DAYS, 10) : 7);

  const referenceDate = options?.nowDate ? new Date(options.nowDate) : new Date();
  const cutoffMs = referenceDate.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffDateStr = new Date(cutoffMs).toISOString().slice(0, 10);

  const dateDirs = readdirSync(base)
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .sort();

  const pruned: string[] = [];
  const kept: string[] = [];

  for (const dir of dateDirs) {
    if (dir < cutoffDateStr) {
      const fullPath = join(base, dir);
      try {
        rmSync(fullPath, { recursive: true, force: true });
        pruned.push(dir);
      } catch {
        // failed to remove
      }
    } else {
      kept.push(dir);
    }
  }

  return { pruned, kept };
}
