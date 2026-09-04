/**
 * Graphify Precontext Auto-Injection (Phase 2 — Stream A).
 *
 * Automatically injects reverse-dependency impact analysis ("Blast Radius")
 * into coding and review passive precontext for high-fanout files/symbols.
 *
 * Constraints & Guarantees:
 * - Feature-flagged: FEATURE_GRAPHIFY_PRECONTEXT (default true).
 * - Bounded cost: EXACTLY ONE graph query per precontext assembly.
 * - Selective injection: silently suppressed if 0 dependents or file has no graph node.
 * - Time-budgeted: bounded with fail-soft timeout (default 900ms).
 */

import { existsSync, readFileSync } from 'node:fs';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { graphPath, runGraphifyAffected, type AffectedEdge } from './graphify.js';

export interface GraphifyPrecontextResult {
  markdown: string;
  count: number;
  targetFile?: string;
  targetSymbol?: string;
  staleness?: string;
  suppressedReason?: string;
}

/**
 * Normalizes any file path (absolute, relative, workspace-scoped) to repo-relative path.
 */
export function normalizeRepoRelativePath(p: string): string {
  let normalized = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  const idx = normalized.indexOf('src/mastra/');
  if (idx >= 0) {
    return normalized.slice(idx);
  }
  normalized = normalized.replace(/^agentic-agents\//, '');
  if (normalized.startsWith('src/mastra/')) return normalized;
  if (normalized.startsWith('mastra/')) return `src/${normalized}`;
  return `src/mastra/${normalized}`;
}

/**
 * Maps a file path to its corresponding node in graph.json.
 *
 * Investigation Decision (A.0):
 * In graphify's AST graph, every source file is indexed with `source_file` (e.g. `src/mastra/...`).
 * File-level nodes have `source_location: 'L1'` or `file_type: 'code'`, while export/function
 * nodes also carry `source_file`. We resolve the file node ID to query reverse-dependencies
 * (`imports_from`, `calls`, `re_exports`) across the entire repository.
 * If no confident node match is found, we fail-soft and suppress the section without guessing.
 */
export function resolveFileToNodeInGraph(
  filePath: string,
  nodes: any[],
): { nodeId: string; label: string; exact: boolean } | null {
  const norm = normalizeRepoRelativePath(filePath);
  const rawClean = filePath.replace(/\\/g, '/').replace(/^\.?\//, '');

  // 1. Exact match on source_file with L1 (whole-file node)
  const fileNode = nodes.find(
    (n: any) =>
      (n.source_file === norm || n.source_file === rawClean) &&
      (n.source_location === 'L1' || n.file_type === 'code') &&
      !n.id?.includes('__'),
  );
  if (fileNode && fileNode.id) {
    return { nodeId: fileNode.id, label: fileNode.label || fileNode.id, exact: true };
  }

  // 2. Fallback: match any primary node located in this source file
  const anyNodeInFile = nodes.find(
    (n: any) =>
      (n.source_file === norm || n.source_file === rawClean) && n.id && !n.id.includes('__'),
  );
  if (anyNodeInFile && anyNodeInFile.id) {
    return { nodeId: anyNodeInFile.id, label: anyNodeInFile.label || anyNodeInFile.id, exact: false };
  }

  return null;
}

/**
 * Select the most significant target file from the input candidate list.
 */
export function pickPrimaryTargetFile(files: string[]): string | undefined {
  if (!files || files.length === 0) return undefined;
  const valid = files.map((f) => f.trim()).filter((f) => f.length > 0);
  if (valid.length === 0) return undefined;

  // Prefer TypeScript/JavaScript files in src/mastra
  const srcFile = valid.find((f) => f.includes('src/mastra/') && /\.(ts|js|tsx|jsx)$/.test(f));
  if (srcFile) return srcFile;

  const codeFile = valid.find((f) => /\.(ts|js|tsx|jsx|py)$/.test(f));
  if (codeFile) return codeFile;

  return valid[0];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Perform auto-injection lookup of reverse dependencies for the primary target file.
 * Returns formatted markdown if dependents exist, or silent empty result if 0 or unavailable.
 */
export async function tryInjectGraphifyBlastRadius(
  files: string[] | undefined,
  options?: {
    timeoutMs?: number;
    depth?: number;
    maxEdgesShown?: number;
  },
): Promise<GraphifyPrecontextResult> {
  if (!isHarnessFeatureEnabled('FEATURE_GRAPHIFY_PRECONTEXT', true)) {
    return { markdown: '', count: 0, suppressedReason: 'FEATURE_GRAPHIFY_PRECONTEXT_disabled' };
  }
  if (!isHarnessFeatureEnabled('FEATURE_GRAPHIFY', true)) {
    return { markdown: '', count: 0, suppressedReason: 'FEATURE_GRAPHIFY_disabled' };
  }

  const targetFile = pickPrimaryTargetFile(files || []);
  if (!targetFile) {
    return { markdown: '', count: 0, suppressedReason: 'no_target_files' };
  }

  const gp = graphPath();
  if (!existsSync(gp)) {
    return { markdown: '', count: 0, targetFile, suppressedReason: 'graph_not_found' };
  }

  let nodeMatch: { nodeId: string; label: string; exact: boolean } | null = null;
  try {
    const raw = readFileSync(gp, 'utf8');
    const parsed = JSON.parse(raw);
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    nodeMatch = resolveFileToNodeInGraph(targetFile, nodes);
  } catch (err) {
    return { markdown: '', count: 0, targetFile, suppressedReason: `graph_parse_failed:${(err as Error).message}` };
  }

  if (!nodeMatch) {
    // If no node exists for file, do not guess — suppress cleanly.
    return { markdown: '', count: 0, targetFile, suppressedReason: 'no_node_in_graph' };
  }

  const timeoutMs = options?.timeoutMs ?? 900;
  const depth = options?.depth ?? 2;
  const maxEdges = options?.maxEdgesShown ?? 12;

  try {
    const affectedRes = await withTimeout(
      runGraphifyAffected({ symbol: nodeMatch.nodeId, depth, timeoutMs }),
      timeoutMs,
      'graphify_timeout',
    );

    if (!affectedRes.available) {
      return {
        markdown: '',
        count: 0,
        targetFile,
        targetSymbol: nodeMatch.label,
        suppressedReason: `affected_unavailable:${affectedRes.reason}`,
      };
    }

    const count = affectedRes.affected.length;
    if (count === 0) {
      // 0 dependents -> silent, do not clutter precontext
      return {
        markdown: '',
        count: 0,
        targetFile,
        targetSymbol: nodeMatch.label,
        staleness: affectedRes.staleness,
        suppressedReason: 'zero_affected_dependents',
      };
    }

    const edgesToShow = affectedRes.affected.slice(0, maxEdges);
    const edgeLines = edgesToShow.map(
      (e: AffectedEdge) => `- ${e.label} [${e.relation}] ${e.file}:L${e.line}`,
    );

    if (count > maxEdges) {
      edgeLines.push(`- ... and ${count - maxEdges} more dependent locations`);
    }

    const stalenessInfo = affectedRes.staleness ? ` (${affectedRes.staleness})` : '';
    const markdown = [
      `### Blast Radius (auto)`,
      `Target: \`${targetFile}\` (symbol: \`${nodeMatch.label}\`)${stalenessInfo}`,
      `Direct & transitive reverse dependencies (${count} dependent${count === 1 ? '' : 's'}):`,
      ...edgeLines,
    ].join('\n');

    return {
      markdown,
      count,
      targetFile,
      targetSymbol: nodeMatch.label,
      staleness: affectedRes.staleness,
    };
  } catch (err) {
    return {
      markdown: '',
      count: 0,
      targetFile,
      targetSymbol: nodeMatch.label,
      suppressedReason: `graphify_failed:${(err as Error).message}`,
    };
  }
}
