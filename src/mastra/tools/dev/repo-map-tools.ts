/**
 * Repo Map Tools (Phase 5 — Repo Indexing)
 *
 * Provides agents with ranked structural maps of ANY repository.
 * Uses Tree-sitter AST + PageRank to show the most relevant
 * symbols, files, and their signatures for a given task.
 *
 * Multi-repo capable: agents can index their own repo, external
 * projects (/projekty/agent-projects/), or any workspace path.
 *
 * Think of it as "GPS for the codebase" — instead of blindly
 * exploring files, the agent gets a pre-ranked overview.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getRepoIndexer, listIndexedRepos } from '../../services/repo-indexer.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

// ── Default repo path ────────────────────────────────────────────────────────
// Used when repoPath is omitted — points to the agent's own codebase.

const DEFAULT_REPO = AGENTIC_AGENTS_REPO;

// ── repo.map — Ranked repository structure ──────────────────────────────────

export const repoMapTool = createTool({
  id: 'repo_map',
  description:
    'Get a ranked structural map of a repository showing the most relevant files and symbols ' +
    'for a given task. Uses AST parsing and PageRank to prioritize files by dependency importance. ' +
    'Use this BEFORE reading individual files to understand which files are most relevant. ' +
    'By default indexes the agent\'s own codebase. Pass repoPath to index ANY repository.',
  inputSchema: z.object({
    query: z.string().describe(
      'What you are looking for or working on (e.g., "authentication middleware", "error handling in subtask executor")',
    ),
    repoPath: z.string().optional().describe(
      'Absolute path to the repository root to index. Defaults to the agent\'s own codebase. ' +
      'Use this to index external projects (e.g., /projekty/agent-projects/my-app or /projekty/splot-projects/some-repo).',
    ),
    focusFiles: z.array(z.string()).optional().describe(
      'Files you are currently editing — these will boost related files in the ranking',
    ),
    mentionedIdents: z.array(z.string()).optional().describe(
      'Specific identifiers (function/class names) to boost in the ranking',
    ),
    maxTokens: z.number().optional().default(2048).describe(
      'Token budget for the generated map (default: 2048)',
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    map: z.string().optional(),
    stats: z.object({
      files: z.number(),
      symbols: z.number(),
      definitions: z.number(),
      references: z.number(),
    }).optional(),
    repoPath: z.string().optional(),
    indexDuration: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'repo_map',
    category: 'search',
    risk: 'low',
    outputPreviewMaxChars: 4000,
    execute: async (context) => {
    try {
      const targetRepo = context.repoPath || DEFAULT_REPO;
      const indexer = getRepoIndexer(targetRepo);

      // Ensure index is fresh (incremental — only re-indexes changed files)
      const indexResult = await indexer.index();

      // Generate ranked map
      const map = indexer.getRepoMap({
        query: context.query,
        focusFiles: context.focusFiles,
        mentionedIdents: context.mentionedIdents,
        maxTokens: context.maxTokens,
      });

      const stats = indexer.getStats();

      return {
        success: true,
        map,
        stats,
        repoPath: targetRepo,
        indexDuration: `${indexResult.durationMs}ms (${indexResult.indexed} files re-indexed)`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Repo indexer error: ${(error as Error).message}`,
      };
    }
    },
  }),
});

// ── repo.stats — Index statistics ───────────────────────────────────────────

export const repoStatsTool = createTool({
  id: 'repo_stats',
  description:
    'Get statistics about a repository index: number of files, symbols, definitions, references. ' +
    'Also lists all currently indexed repositories. Pass repoPath for a specific repo.',
  inputSchema: z.object({
    repoPath: z.string().optional().describe(
      'Absolute path to repository. If omitted, shows stats for the default (agent) repo AND lists all indexed repos.',
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    stats: z.object({
      files: z.number(),
      symbols: z.number(),
      definitions: z.number(),
      references: z.number(),
    }).optional(),
    repoPath: z.string().optional(),
    indexedRepos: z.array(z.object({ path: z.string() })).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const targetRepo = context.repoPath || DEFAULT_REPO;
      const indexer = getRepoIndexer(targetRepo);
      const stats = indexer.getStats();
      return {
        success: true,
        stats,
        repoPath: targetRepo,
        indexedRepos: listIndexedRepos(),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ── repo.reindex — Force full re-index ──────────────────────────────────────

export const repoReindexTool = createTool({
  id: 'repo_reindex',
  description:
    'Force a full re-index of a repository. Only needed if the index seems stale. ' +
    'Normal incremental indexing happens automatically with repo.map. ' +
    'Pass repoPath to reindex a specific repository.',
  inputSchema: z.object({
    repoPath: z.string().optional().describe(
      'Absolute path to repository to re-index. Defaults to the agent\'s own codebase.',
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    repoPath: z.string().optional(),
    indexed: z.number().optional(),
    removed: z.number().optional(),
    total: z.number().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const targetRepo = context.repoPath || DEFAULT_REPO;
      const indexer = getRepoIndexer(targetRepo);
      const result = await indexer.index();
      return {
        success: true,
        repoPath: targetRepo,
        indexed: result.indexed,
        removed: result.removed,
        total: result.total,
        durationMs: result.durationMs,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
