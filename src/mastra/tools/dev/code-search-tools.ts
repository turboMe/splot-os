/**
 * Semantic Code Search (Phase 5 — Code Search)
 *
 * Embedding-based code search using Tree-sitter AST-aware chunking
 * and the existing embedder infrastructure (Ollama/Google).
 *
 * Multi-repo capable: searches use the same SQLite DB per-repo
 * as the repo-indexer. Pass repoPath to search any indexed repo.
 *
 * Uses existing:
 *   - lib/embedder.ts → generateEmbedding(), cosineSimilarity()
 *   - services/repo-indexer.ts → SQLite DB, symbol data
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { EMBEDDING_MODEL_ID, generateEmbedding, cosineSimilarity } from '../../lib/embedder.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';
import { compactHarnessOutput } from '../../services/harness-output-compactor.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { getRepoIndexer } from '../../services/repo-indexer.js';
import { touchCurrentRunLiveness } from '../../services/run-budget.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface CodeChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string;
  kindDetail: string;
  signature: string;
  parentSymbol?: string;
  neighborSymbols: string[];
  readHint: string;
  content: string;
  hash: string;
}

interface SearchResult {
  file: string;
  startLine: number;
  endLine: number;
  symbol: string;
  kind: string;
  signature: string;
  neighborSymbols: string[];
  snippet: string;
  score: number;
  readHint: string;
}

type SearchMode = 'semantic' | 'literal' | 'hybrid';

interface SearchCodeOptions {
  query: string;
  repoPath: string;
  topK?: number;
  scope?: string;
  mode?: SearchMode;
  pathsOnly?: boolean;
  maxRegions?: number;
  maxSnippetChars?: number;
}

// ── Multi-Repo DB Registry ──────────────────────────────────────────────────

const _dbs = new Map<string, Database.Database>();

function getDb(repoPath: string): Database.Database {
  const existing = _dbs.get(repoPath);
  if (existing) return existing;

  const dbPath = resolve(repoPath, '.mastra', 'repo-index.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Ensure code_chunks table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      symbol_name TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      signature TEXT DEFAULT '',
      kind_detail TEXT DEFAULT '',
      parent_symbol TEXT DEFAULT '',
      neighbor_symbols TEXT DEFAULT '',
      read_hint TEXT DEFAULT '',
      embedding_model TEXT,
      embedding BLOB,
      UNIQUE(file_path, start_line, end_line)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON code_chunks(content_hash);
  `);

  const columns = db.prepare('PRAGMA table_info(code_chunks)').all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'embedding_model')) {
    db.exec('ALTER TABLE code_chunks ADD COLUMN embedding_model TEXT');
  }
  if (!columns.some((col) => col.name === 'search_text')) {
    db.exec("ALTER TABLE code_chunks ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((col) => col.name === 'signature')) {
    db.exec("ALTER TABLE code_chunks ADD COLUMN signature TEXT DEFAULT ''");
  }
  if (!columns.some((col) => col.name === 'kind_detail')) {
    db.exec("ALTER TABLE code_chunks ADD COLUMN kind_detail TEXT DEFAULT ''");
  }
  if (!columns.some((col) => col.name === 'parent_symbol')) {
    db.exec("ALTER TABLE code_chunks ADD COLUMN parent_symbol TEXT DEFAULT ''");
  }
  if (!columns.some((col) => col.name === 'neighbor_symbols')) {
    db.exec("ALTER TABLE code_chunks ADD COLUMN neighbor_symbols TEXT DEFAULT ''");
  }
  if (!columns.some((col) => col.name === 'read_hint')) {
    db.exec("ALTER TABLE code_chunks ADD COLUMN read_hint TEXT DEFAULT ''");
  }

  _dbs.set(repoPath, db);
  return db;
}

// ── Chunk Extraction ─────────────────────────────────────────────────────────

async function extractChunksFromIndex(repoPath: string): Promise<CodeChunk[]> {
  const db = getDb(repoPath);
  await getRepoIndexer(repoPath).index();

  const symbols = db.prepare(`
    SELECT file_path, name, line, end_line, signature, kind_detail, parent_symbol
    FROM symbols
    WHERE kind = 'def' AND line >= 0
    ORDER BY file_path, line, name
  `).all() as Array<{
    file_path: string;
    name: string;
    line: number;
    end_line?: number | null;
    signature?: string | null;
    kind_detail?: string | null;
    parent_symbol?: string | null;
  }>;

  const chunks: CodeChunk[] = [];
  const byFile = new Map<string, typeof symbols>();

  for (const sym of symbols) {
    if (!byFile.has(sym.file_path)) byFile.set(sym.file_path, []);
    byFile.get(sym.file_path)!.push(sym);
  }

  for (const [filePath, fileSyms] of byFile) {
    let lines: string[] = [];
    try {
      lines = (await readFile(resolve(repoPath, filePath), 'utf-8')).split('\n');
    } catch {
      continue;
    }

    for (let i = 0; i < fileSyms.length; i++) {
      const sym = fileSyms[i];
      const nextSym = fileSyms[i + 1];
      const startLine = Math.max(1, sym.line + 1);
      const inferredEndLine = nextSym ? Math.max(startLine, nextSym.line) : Math.min(lines.length, startLine + 80);
      const indexedEndLine = typeof sym.end_line === 'number' && sym.end_line >= sym.line
        ? sym.end_line + 1
        : inferredEndLine;
      const endLine = Math.max(startLine, Math.min(lines.length, indexedEndLine));
      const signature = (sym.signature ?? '').trim() || firstNonEmpty(lines.slice(startLine - 1, endLine)) || sym.name;
      const kindDetail = (sym.kind_detail ?? '').trim() || inferKindFromSignature(signature);
      const neighborSymbols = [
        fileSyms[i - 1]?.name,
        fileSyms[i + 1]?.name,
      ].filter(Boolean) as string[];
      const region = lines.slice(startLine - 1, endLine).join('\n');
      const content = [
        filePath,
        kindDetail,
        sym.name,
        sym.parent_symbol ? `parent: ${sym.parent_symbol}` : '',
        signature,
        neighborSymbols.length > 0 ? `neighbors: ${neighborSymbols.join(', ')}` : '',
        truncate(region, 8000),
      ].filter(Boolean).join('\n');
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

      chunks.push({
        filePath,
        startLine,
        endLine,
        symbolName: sym.name,
        kindDetail,
        signature,
        parentSymbol: sym.parent_symbol ?? undefined,
        neighborSymbols,
        readHint: `Read ${filePath}:${startLine}-${endLine}`,
        content,
        hash,
      });
    }
  }

  return chunks;
}

// ── Embedding Generation ─────────────────────────────────────────────────────

/**
 * How many chunks one CALL may embed before it answers with what it has.
 *
 * Measured on the coding canary, 2026-08-12: a cold cache in this repository
 * meant the first `code_search` sat inside ONE tool call embedding the whole
 * tree at ~10 chunks/s. Nothing was wrong with it — the counter climbed 1410 →
 * 2711 while it ran — but a tool call emits no liveness event, so the watchdog
 * saw eight minutes of silence and cut the attempt. The retry began the same
 * warm-up again. THREE attempts, THREE timeouts, zero output, job FAILED.
 *
 * A search is a question, not an indexing job. So a call does a bounded slice of
 * the warm-up, answers from whatever is embedded by then, and says the index is
 * still warming. The cache is durable, so the next call continues where this one
 * stopped and the answers get better instead of the run dying.
 */
const MAX_EMBEDS_PER_CALL = 400;

export async function ensureCodeChunks(
  repoPath: string,
  options: { embed: boolean },
): Promise<{ embedded: number; cached: number; deferred: number; total: number }> {
  const db = getDb(repoPath);
  const chunks = await extractChunksFromIndex(repoPath);

  let embedded = 0;
  let cached = 0;
  let deferred = 0;

  const getExisting = db.prepare(
    'SELECT id, content_hash, embedding_model, embedding FROM code_chunks WHERE file_path = ? AND start_line = ? AND end_line = ?',
  );
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO code_chunks
      (
        file_path, start_line, end_line, symbol_name, content_hash, search_text,
        signature, kind_detail, parent_symbol, neighbor_symbols, read_hint,
        embedding_model, embedding
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateMetadata = db.prepare(`
    UPDATE code_chunks
    SET
      symbol_name = ?,
      content_hash = ?,
      search_text = ?,
      signature = ?,
      kind_detail = ?,
      parent_symbol = ?,
      neighbor_symbols = ?,
      read_hint = ?
    WHERE file_path = ? AND start_line = ? AND end_line = ?
  `);

  const validKeys = new Set(chunks.map((chunk) => chunkKey(chunk.filePath, chunk.startLine, chunk.endLine)));
  const existingRows = db.prepare(
    'SELECT file_path, start_line, end_line FROM code_chunks',
  ).all() as Array<{ file_path: string; start_line: number; end_line: number }>;
  const deleteChunk = db.prepare('DELETE FROM code_chunks WHERE file_path = ? AND start_line = ? AND end_line = ?');
  for (const row of existingRows) {
    if (!validKeys.has(chunkKey(row.file_path, row.start_line, row.end_line))) {
      deleteChunk.run(row.file_path, row.start_line, row.end_line);
    }
  }

  for (const chunk of chunks) {
    const existing = getExisting.get(chunk.filePath, chunk.startLine, chunk.endLine) as
      | { id: number; content_hash: string; embedding_model?: string | null; embedding?: Buffer | null }
      | undefined;

    if (
      existing &&
      existing.content_hash === chunk.hash &&
      existing.embedding_model === EMBEDDING_MODEL_ID &&
      existing.embedding
    ) {
      updateMetadata.run(
        chunk.symbolName,
        chunk.hash,
        chunk.content,
        chunk.signature,
        chunk.kindDetail,
        chunk.parentSymbol ?? '',
        chunk.neighborSymbols.join(', '),
        chunk.readHint,
        chunk.filePath,
        chunk.startLine,
        chunk.endLine,
      );
      cached++;
      continue;
    }

    let embeddingBuffer: Buffer | null = null;
    let embeddingModel: string | null = null;

    if (options.embed && embedded >= MAX_EMBEDS_PER_CALL) {
      // Budget spent. Store the chunk WITHOUT an embedding so its metadata is
      // searchable now and the next call picks it up — dropping it entirely
      // would make the warm-up restart from the same place every time.
      deferred++;
    } else if (options.embed && chunk.content.length >= 8) {
      try {
        // A tool that is working says so. `touchCurrentRunLiveness` exists for
        // exactly this and, until this line, had no callers anywhere in the
        // codebase — built, exported, and never wired, so every long tool call
        // was indistinguishable from a hang.
        touchCurrentRunLiveness();
        const embedding = await generateEmbedding(chunk.content);
        embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);
        embeddingModel = EMBEDDING_MODEL_ID;
        embedded++;
      } catch (err) {
        console.warn(`[CodeSearch] Failed to embed ${chunk.filePath}:${chunk.symbolName}:`, (err as Error).message);
      }
    }

    upsert.run(
      chunk.filePath,
      chunk.startLine,
      chunk.endLine,
      chunk.symbolName,
      chunk.hash,
      chunk.content,
      chunk.signature,
      chunk.kindDetail,
      chunk.parentSymbol ?? '',
      chunk.neighborSymbols.join(', '),
      chunk.readHint,
      embeddingModel,
      embeddingBuffer,
    );
  }

  if (deferred > 0) {
    console.log(
      `[CodeSearch] index warming: embedded ${embedded} this call, ${deferred} still to do `
      + `(cache is durable — the next search continues from here)`,
    );
  }
  return { embedded, cached, deferred, total: chunks.length };
}

// ── Search ───────────────────────────────────────────────────────────────────

async function searchCode(options: SearchCodeOptions): Promise<SearchResult[]> {
  const repoPath = options.repoPath;
  const mode = options.mode ?? 'semantic';
  const limit = clampNumber(options.maxRegions ?? options.topK ?? 10, 1, 25);
  const maxSnippetChars = clampNumber(options.maxSnippetChars ?? 800, 0, 4000);
  const db = getDb(repoPath);

  await ensureCodeChunks(repoPath, { embed: mode !== 'literal' });

  const queryEmbedding = mode === 'literal' ? undefined : await generateEmbedding(options.query);

  let sql = `
    SELECT
      file_path, start_line, end_line, symbol_name, signature, kind_detail,
      parent_symbol, neighbor_symbols, read_hint, search_text, embedding
    FROM code_chunks
    WHERE 1 = 1
  `;
  const params: any[] = [];
  if (mode !== 'literal') {
    sql += ' AND embedding IS NOT NULL AND embedding_model = ?';
    params.push(EMBEDDING_MODEL_ID);
  }
  if (options.scope) {
    sql += ' AND file_path LIKE ?';
    params.push(`${options.scope}%`);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    file_path: string;
    start_line: number;
    end_line: number;
    symbol_name: string;
    signature?: string | null;
    kind_detail?: string | null;
    parent_symbol?: string | null;
    neighbor_symbols?: string | null;
    read_hint?: string | null;
    search_text?: string | null;
    embedding?: Buffer | null;
  }>;

  const scored: SearchResult[] = [];
  for (const row of rows) {
    const semanticScore = queryEmbedding && row.embedding
      ? cosineSimilarity(
          queryEmbedding,
          Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)),
        )
      : 0;
    const literalScore = mode === 'semantic'
      ? 0
      : scoreLiteralMatch(options.query, {
          filePath: row.file_path,
          symbolName: row.symbol_name,
          signature: row.signature ?? '',
          searchText: row.search_text ?? '',
        });
    const score = mode === 'hybrid'
      ? (semanticScore * 0.75) + (literalScore * 0.25)
      : mode === 'literal'
        ? literalScore
        : semanticScore;

    scored.push({
      file: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      symbol: row.symbol_name,
      kind: row.kind_detail || 'definition',
      signature: row.signature || row.symbol_name,
      neighborSymbols: splitNeighborSymbols(row.neighbor_symbols),
      snippet: '',
      score,
      readHint: row.read_hint || `Read ${row.file_path}:${row.start_line}-${row.end_line}`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, limit);

  if (options.pathsOnly) {
    return topResults;
  }

  for (const result of topResults) {
    try {
      const absPath = resolve(repoPath, result.file);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, result.startLine - 1);
      const end = Math.min(lines.length, result.endLine);
      result.snippet = truncate(lines.slice(start, end).join('\n'), maxSnippetChars);
    } catch {
      result.snippet = '(file not readable)';
    }
  }

  return topResults;
}

function firstNonEmpty(lines: string[]): string {
  return lines.find((line) => line.trim().length > 0)?.trim().slice(0, 200) ?? '';
}

function inferKindFromSignature(signature: string): string {
  const lower = signature.toLowerCase();
  if (/\bclass\b/.test(lower)) return 'class';
  if (/\binterface\b/.test(lower)) return 'interface';
  if (/\btype\b/.test(lower)) return 'type';
  if (/\benum\b/.test(lower)) return 'enum';
  if (/\bfunction\b|=>/.test(lower)) return 'function';
  if (/\bconst\b|\blet\b|\bvar\b/.test(lower)) return 'variable';
  return 'definition';
}

function scoreLiteralMatch(query: string, candidate: {
  filePath: string;
  symbolName: string;
  signature: string;
  searchText: string;
}): number {
  const text = candidate.searchText.toLowerCase();
  const filePath = candidate.filePath.toLowerCase();
  const symbolName = candidate.symbolName.toLowerCase();
  const signature = candidate.signature.toLowerCase();
  const terms = query.toLowerCase().split(/[^a-z0-9_$]+/).filter((term) => term.length >= 2);
  if (terms.length === 0) return 0;

  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 1 / terms.length;
    if (filePath.includes(term)) score += 0.25 / terms.length;
    if (symbolName.includes(term)) score += 0.2 / terms.length;
    if (signature.includes(term)) score += 0.1 / terms.length;
  }

  const normalizedQuery = terms.join('');
  const dashedQuery = terms.join('-');
  if (text.includes(query.toLowerCase())) score += 0.5;
  if (filePath.includes(dashedQuery) || filePath.replace(/[^a-z0-9_$]+/g, '').includes(normalizedQuery)) score += 0.75;
  if (symbolName.includes(normalizedQuery)) score += 0.5;

  return score;
}

function splitNeighborSymbols(value?: string | null): string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function chunkKey(filePath: string, startLine: number, endLine: number): string {
  return `${filePath}:${startLine}:${endLine}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... (truncated)` : text;
}

// ── Tool: code.search ────────────────────────────────────────────────────────

export const codeSearchTool = createTool({
  id: 'code_search',
  description:
    'Search across a codebase by semantic meaning, literal terms, or hybrid matching. ' +
    'Returns symbol names, signatures, line ranges, neighboring symbols, snippets, and read hints. ' +
    'Use when you need to find WHERE something is implemented or what code handles a concept. ' +
    'Pass repoPath to search any indexed repository.',
  inputSchema: z.object({
    query: z.string().describe(
      'Natural language description of what you are looking for (e.g., "error handling in subtask execution")',
    ),
    repoPath: z.string().optional().describe(
      'Absolute path to repository to search. Defaults to agent\'s own codebase.',
    ),
    topK: z.number().optional().default(10).describe('Number of results to return'),
    maxRegions: z.number().optional().describe('Alias for limiting returned code regions. Takes precedence over topK.'),
    mode: z.enum(['semantic', 'literal', 'hybrid']).optional().default('semantic').describe(
      'Search mode. semantic uses embeddings, literal uses text/path/signature matching, hybrid combines both.',
    ),
    pathsOnly: z.boolean().optional().default(false).describe('Return paths and read hints without snippets.'),
    maxSnippetChars: z.number().optional().default(800).describe('Maximum snippet characters per result.'),
    scope: z.string().optional().describe('Directory scope to limit search (e.g., "src/services")'),
    taskId: z.string().optional(),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      file: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      symbol: z.string(),
      kind: z.string(),
      signature: z.string(),
      neighborSymbols: z.array(z.string()),
      snippet: z.string(),
      score: z.number(),
      readHint: z.string(),
    })).optional(),
    repoPath: z.string().optional(),
    mode: z.enum(['semantic', 'literal', 'hybrid']).optional(),
    totalChunks: z.number().optional(),
    indexWarming: z.boolean().optional().describe('True when chunks are still being embedded — results are partial; search again for better coverage.'),
    chunksPendingEmbedding: z.number().optional(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'code_search',
    category: 'search',
    risk: 'low',
    outputPreviewMaxChars: 4000,
    execute: async (context) => {
    try {
      const targetRepo = context.repoPath || AGENTIC_AGENTS_REPO;
      const mode = context.mode ?? 'semantic';
      const results = await searchCode({
        query: context.query,
        repoPath: targetRepo,
        topK: context.topK,
        maxRegions: context.maxRegions,
        scope: context.scope,
        mode,
        pathsOnly: context.pathsOnly,
        maxSnippetChars: context.maxSnippetChars,
      });
      const db = getDb(targetRepo);
      const totalChunks = (
        mode === 'literal'
          ? db.prepare('SELECT COUNT(*) as cnt FROM code_chunks').get() as any
          : db.prepare('SELECT COUNT(*) as cnt FROM code_chunks WHERE embedding IS NOT NULL AND embedding_model = ?')
            .get(EMBEDDING_MODEL_ID) as any
      ).cnt;
      // A partially warm index gives thin results, and a model cannot tell that
      // from "this symbol does not exist" — so say it. The warm-up is bounded per
      // call (see MAX_EMBEDS_PER_CALL) and its cache is durable, so calling again
      // genuinely improves the answer instead of repeating the wait.
      const allChunks = (db.prepare('SELECT COUNT(*) as cnt FROM code_chunks').get() as any).cnt;
      const pending = mode === 'literal' ? 0 : Math.max(0, allChunks - totalChunks);
      const serializedResults = JSON.stringify(results, null, 2);
      const compaction = await compactHarnessOutput({
        text: serializedResults,
        kind: 'tool_output',
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId ?? 'codingAgent',
        threadId: context.threadId,
        runId: context.runId,
        turnId: context.turnId,
        toolId: 'code_search',
        previewBytes: 16 * 1024,
        metadata: {
          query: context.query,
          mode,
          scope: context.scope,
          resultCount: results.length,
        },
      });
      const returnedResults = compaction.truncated
        ? results.slice(0, 5).map((result) => ({
            ...result,
            snippet: truncate(result.snippet, 500),
          }))
        : results;

      return {
        success: true,
        results: returnedResults,
        repoPath: targetRepo,
        mode,
        totalChunks,
        ...(pending > 0 ? { indexWarming: true, chunksPendingEmbedding: pending } : {}),
        outputArtifactId: compaction.fullTextArtifactId,
        outputTruncated: compaction.truncated,
        originalBytes: compaction.originalBytes,
        previewBytes: compaction.previewBytes,
      };
    } catch (error) {
      return {
        success: false,
        error: `Code search error: ${(error as Error).message}`,
      };
    }
    },
  }),
});

// ── Tool: code.embed_stats ───────────────────────────────────────────────────

export const codeEmbedStatsTool = createTool({
  id: 'code_embed_stats',
  description: 'Get statistics about code embeddings for a repository.',
  inputSchema: z.object({
    repoPath: z.string().optional().describe(
      'Absolute path to repository. Defaults to agent\'s own codebase.',
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    stats: z.object({
      totalChunks: z.number(),
      embeddedChunks: z.number(),
      pendingChunks: z.number(),
    }).optional(),
    repoPath: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const targetRepo = context.repoPath || AGENTIC_AGENTS_REPO;
      const db = getDb(targetRepo);
      const total = (db.prepare('SELECT COUNT(*) as cnt FROM code_chunks').get() as any).cnt;
      const embedded = (
        db.prepare('SELECT COUNT(*) as cnt FROM code_chunks WHERE embedding IS NOT NULL AND embedding_model = ?')
          .get(EMBEDDING_MODEL_ID) as any
      ).cnt;
      return {
        success: true,
        stats: { totalChunks: total, embeddedChunks: embedded, pendingChunks: total - embedded },
        repoPath: targetRepo,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
