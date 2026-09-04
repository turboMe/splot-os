/**
 * Context Assembler (Phase 5 — Smart Context Assembly)
 *
 * Unifies all context sources into a single, token-budgeted prompt section
 * for injection into subtask prompts. Each source has a priority-weighted
 * token allocation.
 *
 * Sources:
 *   1. Repo Map (structural awareness — highest priority)
 *   2. Semantic Code Search (relevant code snippets)
 *   3. Checkpoint State (session continuity)
 *
 * Token Budget Allocation:
 *   - 45% → Repo Map (ranked AST symbols)
 *   - 35% → Relevant Code (semantic search snippets)
 *   - 20% → Checkpoint State (session resume context)
 */

import { getRepoIndexer } from './repo-indexer.js';
import { loadCheckpoint, formatCheckpointForPrompt } from './context-checkpoint.js';
import { formatGoalForPrompt, getActiveContractForTask, getGoalContract } from './goal-tracker.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AssembledContext {
  repoMap: string;
  relevantCode: string;
  checkpoint: string;
  totalTokensEstimate: number;
}

export interface AssembleOptions {
  /** Task description for contextual ranking */
  description: string;
  /** Absolute repository root used by repo-indexer and code-search cache */
  repoPath: string;
  /** Files being targeted by this subtask */
  targetFiles: string[];
  /** Task ID for checkpoint lookup */
  taskId?: string;
  /** Explicit GoalContract ID for goal-aware precontext */
  goalContractId?: string;
  /** Total token budget for assembled context (default: 4096) */
  tokenBudget?: number;
  /** Mentioned identifiers to boost in repo map */
  mentionedIdents?: string[];
  /** Include AST/PageRank repo map (default: true) */
  includeRepoMap?: boolean;
  /** Include semantic code locations (default: true) */
  includeRelevantCode?: boolean;
  /** Include checkpoint state when taskId is present (default: true) */
  includeCheckpoint?: boolean;
  /** Include active GoalContract state when available (default: true) */
  includeGoalContract?: boolean;
}

// ── Token Estimation ─────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough approximation: ~4 chars per token for code
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... (truncated to fit token budget)';
}

// ── Main Assembler ───────────────────────────────────────────────────────────

export async function assembleContext(options: AssembleOptions): Promise<AssembledContext> {
  const {
    description,
    repoPath,
    targetFiles,
    taskId,
    goalContractId,
    tokenBudget = 4096,
    mentionedIdents = [],
    includeRepoMap = true,
    includeRelevantCode = true,
    includeCheckpoint = true,
    includeGoalContract = true,
  } = options;

  // Token allocation follows the original weights, normalized to enabled sources.
  const sourceWeights = [
    { key: 'repoMap', enabled: includeRepoMap, weight: 0.45 },
    { key: 'relevantCode', enabled: includeRelevantCode, weight: 0.35 },
    { key: 'checkpoint', enabled: (includeCheckpoint && !!taskId) || (includeGoalContract && (!!goalContractId || !!taskId)), weight: 0.20 },
  ];
  const totalWeight = sourceWeights
    .filter((source) => source.enabled)
    .reduce((sum, source) => sum + source.weight, 0);
  const budgetFor = (key: string) => {
    const source = sourceWeights.find((item) => item.key === key);
    if (!source?.enabled || totalWeight <= 0) return 0;
    return Math.floor(tokenBudget * (source.weight / totalWeight));
  };
  const repoMapBudget = budgetFor('repoMap');
  const relevantCodeBudget = budgetFor('relevantCode');
  const checkpointBudget = budgetFor('checkpoint');

  // ── 1. Repo Map (structural awareness) ──
  let repoMap = '';
  if (includeRepoMap && repoMapBudget > 0) {
    try {
      const indexer = getRepoIndexer(repoPath);
      // Ensure index is fresh (incremental)
      await indexer.index();
      repoMap = indexer.getRepoMap({
        query: description,
        focusFiles: targetFiles,
        mentionedIdents,
        maxTokens: repoMapBudget,
      });
    } catch (err) {
      repoMap = `(repo map unavailable: ${(err as Error).message})`;
    }
  }

  // ── 2. Relevant Code (semantic search) ──
  // NOTE: Semantic search uses the embedder configured in model-manifest.ts.
  // We attempt it but gracefully degrade if embedder is offline.
  let relevantCode = '';
  if (includeRelevantCode && relevantCodeBudget > 0) {
    try {
    // Dynamic import to avoid hard dependency on embedder availability
    const { EMBEDDING_MODEL_ID, generateEmbedding, cosineSimilarity } = await import('../lib/embedder.js');
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');

    const dbPath = resolve(repoPath, '.mastra', 'repo-index.db');

    let db: any;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      // DB doesn't exist yet
      db = null;
    }

    if (db) {
      const columns = db.prepare('PRAGMA table_info(code_chunks)').all() as Array<{ name: string }>;
      const hasEmbeddingModel = columns.some((col) => col.name === 'embedding_model');
      let rows: Array<{
        file_path: string;
        start_line: number;
        end_line: number;
        symbol_name: string;
        embedding: Buffer;
      }> = [];

      if (hasEmbeddingModel) {
        rows = db.prepare(
          `SELECT file_path, start_line, end_line, symbol_name, embedding
           FROM code_chunks
           WHERE embedding IS NOT NULL AND embedding_model = ?`,
        ).all(EMBEDDING_MODEL_ID) as typeof rows;
      }

      if (rows.length > 0) {
        const queryEmbedding = await generateEmbedding(description);
        const scored = rows.map((row) => {
          const chunkEmbedding = Array.from(
            new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
          );
          return {
            file: row.file_path,
            symbol: row.symbol_name,
            startLine: row.start_line,
            endLine: row.end_line,
            score: cosineSimilarity(queryEmbedding, chunkEmbedding),
          };
        });

        scored.sort((a, b) => b.score - a.score);
        const topResults = scored.slice(0, 5);

        const snippets = topResults.map(
          (r) => `  ${r.file}:${r.startLine} — ${r.symbol} (score: ${r.score.toFixed(3)})`,
        );
        relevantCode = snippets.join('\n');
      }

      db.close();
    }
    } catch {
      // Embedder offline or DB not ready — graceful degradation
      relevantCode = '';
    }
  }

  // ── 3. Checkpoint + GoalContract State (session continuity) ──
  let checkpoint = '';
  const checkpointSections: string[] = [];
  if (includeCheckpoint && taskId) {
    try {
      const cp = await loadCheckpoint(taskId);
      if (cp) {
        checkpointSections.push(formatCheckpointForPrompt(cp));
      }
    } catch {
      // Checkpoint unavailable — non-critical
    }
  }
  if (includeGoalContract && (goalContractId || taskId)) {
    try {
      const contract = goalContractId
        ? await getGoalContract(goalContractId)
        : taskId
          ? await getActiveContractForTask(taskId)
          : null;
      if (contract) {
        checkpointSections.push(formatGoalForPrompt(contract));
      }
    } catch {
      // GoalContract unavailable — non-critical
    }
  }
  checkpoint = checkpointSections.join('\n\n');

  // ── Truncate to budget ──
  repoMap = truncateToTokens(repoMap, repoMapBudget);
  relevantCode = truncateToTokens(relevantCode, relevantCodeBudget);
  checkpoint = truncateToTokens(checkpoint, checkpointBudget);

  const totalTokensEstimate =
    estimateTokens(repoMap) + estimateTokens(relevantCode) + estimateTokens(checkpoint);

  return {
    repoMap,
    relevantCode,
    checkpoint,
    totalTokensEstimate,
  };
}

/**
 * Format assembled context as a single prompt section for injection.
 * Only includes non-empty sections to save tokens.
 */
export function formatAssembledContext(ctx: AssembledContext): string {
  const sections: string[] = [];

  if (ctx.repoMap && ctx.repoMap.length > 20) {
    sections.push('## Repository Map (ranked by relevance)');
    sections.push('```');
    sections.push(ctx.repoMap);
    sections.push('```');
    sections.push('');
  }

  if (ctx.relevantCode && ctx.relevantCode.length > 10) {
    sections.push('## Relevant Code Locations');
    sections.push(ctx.relevantCode);
    sections.push('');
  }

  if (ctx.checkpoint && ctx.checkpoint.length > 10) {
    sections.push(ctx.checkpoint);
    sections.push('');
  }

  if (sections.length === 0) return '';

  return sections.join('\n');
}
