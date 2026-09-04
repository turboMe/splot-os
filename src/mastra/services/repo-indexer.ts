/**
 * Repository Indexer Service (Phase 5 — Repo Map)
 *
 * Tree-sitter based AST indexer inspired by Aider's repo-map algorithm.
 * Extracts symbol definitions and references, builds a dependency graph,
 * and uses Personalized PageRank to rank files by relevance to a query.
 *
 * Pipeline: SCAN → DIFF → PARSE → EXTRACT → GRAPH → RANK → RENDER
 *
 * Storage: better-sqlite3 (WAL mode) for incremental re-indexing.
 * Graph:   graphology + graphology-metrics for PageRank.
 */

import { createHash } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, relative, extname, join, sep } from 'path';
import Database from 'better-sqlite3';
import { MultiDirectedGraph } from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank.js';

// Bound require for optional native modules (tree-sitter) — keeps graceful
// degradation while avoiding a FREE require() that would make the ESM bundle
// ambiguous (ERR_AMBIGUOUS_MODULE_SYNTAX) under `mastra build`.
const require = createRequire(import.meta.url);

// ── Types ────────────────────────────────────────────────────────────────────

export interface SymbolTag {
  filePath: string;
  name: string;
  kind: 'def' | 'ref';
  line: number;
  endLine?: number;
  kindDetail?: string;
  parentSymbol?: string;
  signature?: string;
}

export interface FileOutlineSymbol {
  name: string;
  kind: string;
  signature: string;
  startLine: number;
  endLine: number;
  parentSymbol?: string;
}

export interface FileOutline {
  file: string;
  language: string;
  totalLines: number;
  symbols: FileOutlineSymbol[];
}

export interface RepoMapOptions {
  /** Max tokens for the generated map text (approximate) */
  maxTokens?: number;
  /** Files currently being edited (get higher personalization) */
  focusFiles?: string[];
  /** Mentioned identifiers (boost relevance) */
  mentionedIdents?: string[];
  /** Query string to contextualize ranking */
  query?: string;
}

interface FileRecord {
  path: string;
  hash: string;
  language: string;
  size_bytes: number;
  last_indexed: number;
}

// ── Language Support ─────────────────────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.py': 'python',
};

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.mastra',
  '.turbo', 'coverage', '__pycache__', '.cache', '.duckdb',
  'chrome_profile_notebooklm',
]);

const IGNORE_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);

const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip huge files

// ── Multi-Repo Registry ──────────────────────────────────────────────────────
// Each unique rootPath gets its own RepoIndexer instance with separate DB.

const _instances = new Map<string, RepoIndexer>();

/**
 * Get or create a RepoIndexer for a specific repository root.
 * Each repo gets its own SQLite DB at `<rootPath>/.mastra/repo-index.db`.
 *
 * @param rootPath - Absolute path to the repository root (required on first call)
 */
export function getRepoIndexer(rootPath?: string): RepoIndexer {
  if (!rootPath) {
    // Return first instance if called without args (backward-compat)
    if (_instances.size > 0) return _instances.values().next().value!;
    throw new Error('[RepoIndexer] Not initialized. Call getRepoIndexer(rootPath) first.');
  }

  const existing = _instances.get(rootPath);
  if (existing) return existing;

  const instance = new RepoIndexer(rootPath);
  _instances.set(rootPath, instance);
  return instance;
}

/**
 * List all registered indexer instances (for diagnostics).
 */
export function listIndexedRepos(): Array<{ path: string; }> {
  return Array.from(_instances.keys()).map((path) => ({ path }));
}

// ── Main Class ───────────────────────────────────────────────────────────────

export class RepoIndexer {
  private db: Database.Database;
  private rootPath: string;
  private parser: any = null;
  private languages: Record<string, any> = {};
  private initialized = false;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    const dbPath = resolve(rootPath, '.mastra', 'repo-index.db');
    
    // Ensure .mastra directory exists
    mkdirSync(resolve(rootPath, '.mastra'), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        last_indexed INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL DEFAULT -1,
        end_line INTEGER NOT NULL DEFAULT -1,
        kind_detail TEXT DEFAULT '',
        parent_symbol TEXT DEFAULT '',
        signature TEXT DEFAULT '',
        UNIQUE(file_path, name, kind, line)
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
    `);

    const symbolColumns = this.db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>;
    const columnNames = new Set(symbolColumns.map((col) => col.name));
    let requiresSymbolReindex = false;

    if (!columnNames.has('end_line')) {
      this.db.exec('ALTER TABLE symbols ADD COLUMN end_line INTEGER NOT NULL DEFAULT -1');
      requiresSymbolReindex = true;
    }
    if (!columnNames.has('kind_detail')) {
      this.db.exec("ALTER TABLE symbols ADD COLUMN kind_detail TEXT DEFAULT ''");
      requiresSymbolReindex = true;
    }
    if (!columnNames.has('parent_symbol')) {
      this.db.exec("ALTER TABLE symbols ADD COLUMN parent_symbol TEXT DEFAULT ''");
      requiresSymbolReindex = true;
    }

    if (requiresSymbolReindex) {
      this.db.exec('DELETE FROM symbols; DELETE FROM files;');
    }
  }

  // ── Tree-sitter Lazy Init ────────────────────────────────────────────────

  private async ensureParser(): Promise<void> {
    if (this.initialized) return;

    try {
      const Parser = require('tree-sitter');
      this.parser = new Parser();

      // Load grammars
      try {
        const tsLang = require('tree-sitter-typescript');
        this.languages['typescript'] = tsLang.typescript;
        this.languages['tsx'] = tsLang.tsx;
      } catch (e) {
        console.warn('[RepoIndexer] tree-sitter-typescript not available:', (e as Error).message);
      }

      try {
        this.languages['javascript'] = require('tree-sitter-javascript');
      } catch (e) {
        console.warn('[RepoIndexer] tree-sitter-javascript not available:', (e as Error).message);
      }

      this.initialized = true;
      console.log(`[RepoIndexer] Initialized with languages: ${Object.keys(this.languages).join(', ')}`);
    } catch (e) {
      console.error('[RepoIndexer] Tree-sitter init failed:', (e as Error).message);
      this.initialized = true; // Don't retry
    }
  }

  // ── Step 1: SCAN — Walk workspace, compute file hashes ───────────────────

  private async scanFiles(): Promise<Map<string, { hash: string; size: number; language: string }>> {
    const files = new Map<string, { hash: string; size: number; language: string }>();

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip vendored submodules / nested repos: a directory with its own
          // .git is a separate project and would pollute this repo's index. It
          // can still be searched directly by passing its path as repoPath.
          if (existsSync(join(fullPath, '.git'))) continue;
          await walk(fullPath);
          continue;
        }

        if (!entry.isFile()) continue;
        if (IGNORE_FILES.has(entry.name)) continue;

        const ext = extname(entry.name);
        const language = LANGUAGE_MAP[ext];
        if (!language) continue;

        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > MAX_FILE_SIZE) continue;

          const content = await readFile(fullPath, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
          const relPath = relative(this.rootPath, fullPath);

          files.set(relPath, { hash, size: fileStat.size, language });
        } catch {
          // Skip unreadable files
        }
      }
    };

    await walk(this.rootPath);
    return files;
  }

  // ── Step 2: DIFF — Compare with cached hashes ─────────────────────────────

  private diffFiles(scanned: Map<string, { hash: string; size: number; language: string }>): {
    changed: string[];
    removed: string[];
  } {
    const getFile = this.db.prepare('SELECT hash FROM files WHERE path = ?');
    const allPaths = this.db.prepare('SELECT path FROM files').all() as { path: string }[];

    const changed: string[] = [];
    const currentPaths = new Set<string>();

    for (const [path, info] of scanned) {
      currentPaths.add(path);
      const cached = getFile.get(path) as FileRecord | undefined;
      if (!cached || cached.hash !== info.hash) {
        changed.push(path);
      }
    }

    const removed = allPaths
      .map((r) => r.path)
      .filter((p) => !currentPaths.has(p));

    return { changed, removed };
  }

  // ── Step 3-4: PARSE + EXTRACT — Tree-sitter AST → symbol tags ────────────

  private async extractSymbols(filePath: string, language: string): Promise<SymbolTag[]> {
    if (!this.parser || !this.languages[language]) return [];

    const absPath = resolve(this.rootPath, filePath);
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      return [];
    }

    const tags: SymbolTag[] = [];

    try {
      this.parser.setLanguage(this.languages[language]);
      const tree = this.parser.parse(content);

      // Walk AST and extract definitions + references
      const walkNode = (node: any, parentSymbol?: string): void => {
        const type = node.type;
        let nextParentSymbol = parentSymbol;

        // ── Definitions ──
        const kindDetail = this.definitionKindDetail(node, language);
        if (kindDetail) {
          const nameNode = this.findNameNode(node);
          if (nameNode) {
            const sig = this.extractSignature(node, content);
            const name = nameNode.text;
            tags.push({
              filePath,
              name,
              kind: 'def',
              line: node.startPosition.row,
              endLine: node.endPosition.row,
              kindDetail,
              parentSymbol,
              signature: sig,
            });
            nextParentSymbol = name;
          }
        }

        // ── References (identifiers) ──
        if (type === 'identifier' || type === 'property_identifier' || type === 'type_identifier') {
          const name = node.text;
          // Filter out common noise (keywords, short names, built-ins)
          if (name.length >= 3 && !this.isBuiltIn(name)) {
            tags.push({
              filePath,
              name,
              kind: 'ref',
              line: node.startPosition.row,
            });
          }
        }

        // Recurse children
        for (let i = 0; i < node.childCount; i++) {
          walkNode(node.child(i), nextParentSymbol);
        }
      };

      walkNode(tree.rootNode);
      return tags;
    } catch {
      return this.extractSymbolsFallback(filePath, content);
    }
  }

  private extractSymbolsFallback(filePath: string, content: string): SymbolTag[] {
    const tags: SymbolTag[] = [];
    const patterns = [
      { regex: /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kindDetail: 'function' },
      { regex: /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kindDetail: 'function' },
      { regex: /\bexport\s+const\s+([A-Za-z_$][\w$]*)/, kindDetail: 'variable' },
      { regex: /\bconst\s+([A-Za-z_$][\w$]*)\s*=/, kindDetail: 'variable' },
      { regex: /\bexport\s+class\s+([A-Za-z_$][\w$]*)/, kindDetail: 'class' },
      { regex: /\bclass\s+([A-Za-z_$][\w$]*)/, kindDetail: 'class' },
      { regex: /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/, kindDetail: 'interface' },
      { regex: /\binterface\s+([A-Za-z_$][\w$]*)/, kindDetail: 'interface' },
      { regex: /\bexport\s+type\s+([A-Za-z_$][\w$]*)/, kindDetail: 'type' },
      { regex: /\btype\s+([A-Za-z_$][\w$]*)/, kindDetail: 'type' },
      { regex: /\bexport\s+enum\s+([A-Za-z_$][\w$]*)/, kindDetail: 'enum' },
      { regex: /\benum\s+([A-Za-z_$][\w$]*)/, kindDetail: 'enum' },
    ];

    content.split('\n').forEach((line, index) => {
      for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        const name = match?.[1];
        if (!name || this.isBuiltIn(name)) continue;
        tags.push({
          filePath,
          name,
          kind: 'def',
          line: index,
          endLine: index,
          kindDetail: pattern.kindDetail,
          signature: line.trim().slice(0, 200),
        });
        break;
      }
    });

    return tags;
  }

  private definitionKindDetail(node: any, _language: string): string | undefined {
    switch (node.type) {
      case 'function_declaration':
        return 'function';
      case 'function_signature':
        return 'function_signature';
      case 'method_definition':
        return 'method';
      case 'class_declaration':
        return 'class';
      case 'interface_declaration':
        return 'interface';
      case 'type_alias_declaration':
        return 'type';
      case 'enum_declaration':
        return 'enum';
      case 'variable_declarator': {
        const value = node.childForFieldName('value');
        if (!value) return 'variable';
        if (value.type === 'arrow_function' || value.type === 'function' || value.type === 'function_declaration') {
          return 'function';
        }
        if (value.type === 'class' || value.type === 'class_declaration') return 'class';
        return 'variable';
      }
      default:
        return undefined;
    }
  }

  private findNameNode(node: any): any {
    // Try direct 'name' field
    const nameField = node.childForFieldName('name');
    if (nameField) return nameField;

    // For export statements, look deeper
    if (node.type === 'export_statement') {
      const declaration = node.childForFieldName('declaration');
      if (declaration) return this.findNameNode(declaration);
    }

    // For variable declarators, the name is the first child
    if (node.type === 'variable_declarator') {
      const first = node.child(0);
      if (first && (first.type === 'identifier' || first.type === 'type_identifier')) {
        return first;
      }
    }

    return null;
  }

  private extractSignature(node: any, _content: string): string {
    // Get the first line of the node as signature
    const startRow = node.startPosition.row;
    const endRow = Math.min(startRow + 2, node.endPosition.row);
    const text = node.text || '';
    const lines = text.split('\n').slice(0, endRow - startRow + 1);
    return lines.join(' ').slice(0, 200).trim();
  }

  private isBuiltIn(name: string): boolean {
    const builtIns = new Set([
      'undefined', 'null', 'true', 'false', 'this', 'super',
      'console', 'window', 'document', 'global', 'process',
      'Error', 'Promise', 'Array', 'Object', 'String', 'Number',
      'Boolean', 'Map', 'Set', 'Date', 'RegExp', 'Math', 'JSON',
      'require', 'module', 'exports', 'import', 'export', 'default',
      'const', 'let', 'var', 'function', 'class', 'interface', 'type',
      'async', 'await', 'return', 'throw', 'new', 'typeof', 'instanceof',
    ]);
    return builtIns.has(name);
  }

  // ── Step 5: Persist to SQLite ─────────────────────────────────────────────

  private persistTags(filePath: string, tags: SymbolTag[], fileInfo: { hash: string; size: number; language: string }): void {
    const upsertFile = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, hash, language, size_bytes, last_indexed)
      VALUES (?, ?, ?, ?, ?)
    `);

    const deleteSymbols = this.db.prepare('DELETE FROM symbols WHERE file_path = ?');
    const insertSymbol = this.db.prepare(`
      INSERT OR IGNORE INTO symbols
        (file_path, name, kind, line, end_line, kind_detail, parent_symbol, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      upsertFile.run(filePath, fileInfo.hash, fileInfo.language, fileInfo.size, Date.now());
      deleteSymbols.run(filePath);

      // Deduplicate refs per file (keep unique name+kind)
      const seen = new Set<string>();
      for (const tag of tags) {
        const key = `${tag.name}:${tag.kind}:${tag.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        insertSymbol.run(
          filePath,
          tag.name,
          tag.kind,
          tag.line,
          tag.endLine ?? tag.line,
          tag.kindDetail ?? '',
          tag.parentSymbol ?? '',
          tag.signature ?? '',
        );
      }
    });

    transaction();
  }

  private removeFile(filePath: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  // ── Main: Full Index (SCAN → DIFF → PARSE → PERSIST) ─────────────────────

  async index(): Promise<{ indexed: number; removed: number; total: number; durationMs: number }> {
    const start = Date.now();
    
    try {
      await this.ensureParser();
    } catch (e) {
      console.error('[RepoIndexer] ensureParser failed:', (e as Error).stack);
      throw e;
    }

    // 1. SCAN
    let scanned: Map<string, { hash: string; size: number; language: string }>;
    try {
      scanned = await this.scanFiles();
    } catch (e) {
      console.error('[RepoIndexer] scanFiles failed:', (e as Error).stack);
      throw e;
    }

    // 2. DIFF
    let changed: string[];
    let removed: string[];
    try {
      ({ changed, removed } = this.diffFiles(scanned));
    } catch (e) {
      console.error('[RepoIndexer] diffFiles failed:', (e as Error).stack);
      throw e;
    }

    // 3-4. PARSE + EXTRACT + PERSIST
    for (const filePath of changed) {
      const info = scanned.get(filePath)!;
      try {
        const tags = await this.extractSymbols(filePath, info.language);
        this.persistTags(filePath, tags, info);
      } catch (e) {
        console.warn(`[RepoIndexer] Failed to index file ${filePath}:`, (e as Error).message);
      }
    }

    // Clean removed files
    for (const filePath of removed) {
      this.removeFile(filePath);
    }

    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM files').get() as any).cnt;
    const durationMs = Date.now() - start;

    if (changed.length > 0 || removed.length > 0) {
      console.log(
        `[RepoIndexer] Indexed ${changed.length} changed, removed ${removed.length}, total ${total} files in ${durationMs}ms`,
      );
    }

    return { indexed: changed.length, removed: removed.length, total, durationMs };
  }

  // ── Step 6: RANK — Build graph + PageRank ─────────────────────────────────

  getRepoMap(options: RepoMapOptions = {}): string {
    const { maxTokens = 2048, focusFiles = [], mentionedIdents = [], query } = options;

    // Get all symbols from index
    const allDefs = this.db.prepare(
      'SELECT file_path, name, line, signature FROM symbols WHERE kind = ?'
    ).all('def') as Array<{ file_path: string; name: string; line: number; signature: string }>;

    const allRefs = this.db.prepare(
      'SELECT file_path, name FROM symbols WHERE kind = ?'
    ).all('ref') as Array<{ file_path: string; name: string }>;

    if (allDefs.length === 0) return '(no symbols indexed)';

    // Build definition → files mapping
    const defines = new Map<string, Set<string>>();
    const defSignatures = new Map<string, string>(); // name → signature

    for (const def of allDefs) {
      if (!defines.has(def.name)) defines.set(def.name, new Set());
      defines.get(def.name)!.add(def.file_path);
      if (def.signature && !defSignatures.has(def.name)) {
        defSignatures.set(def.name, def.signature);
      }
    }

    // Build reference → files mapping
    const references = new Map<string, string[]>();
    for (const ref of allRefs) {
      if (!references.has(ref.name)) references.set(ref.name, []);
      references.get(ref.name)!.push(ref.file_path);
    }

    // ── Build directed graph ──
    const graph: any = new MultiDirectedGraph();

    // Get all file paths
    const allFiles = this.db.prepare('SELECT path FROM files').all() as { path: string }[];
    for (const f of allFiles) {
      if (!graph.hasNode(f.path)) graph.addNode(f.path);
    }

    // Common identifiers between defs and refs
    const commonIdents = [...defines.keys()].filter((id) => references.has(id));

    for (const ident of commonIdents) {
      const definers = defines.get(ident)!;
      const refs = references.get(ident) ?? [];

      // Weight multiplier for relevant identifiers
      let mul = 1.0;
      if (mentionedIdents.includes(ident)) mul *= 10;
      if ((ident.includes('_') || /[A-Z]/.test(ident)) && ident.length >= 8) mul *= 5;
      if (ident.startsWith('_')) mul *= 0.1;
      if (definers.size > 5) mul *= 0.1;

      // Count references per file
      const refCounts = new Map<string, number>();
      for (const ref of refs) {
        refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
      }

      for (const [referencer, count] of refCounts) {
        for (const definer of definers) {
          let weight = mul * Math.sqrt(count);
          // Boost edges from focus files
          if (focusFiles.includes(referencer)) weight *= 50;

          try {
            graph.addEdge(referencer, definer, { weight, ident });
          } catch {
            // Duplicate edge — OK in multi-graph
          }
        }
      }
    }

    // ── Personalization vector ──
    const personalization: Record<string, number> = {};
    const basePersonalization = 100 / Math.max(allFiles.length, 1);

    for (const f of focusFiles) {
      const relF = relative(this.rootPath, resolve(this.rootPath, f));
      if (graph.hasNode(relF)) {
        personalization[relF] = basePersonalization * 10;
      }
    }

    // Boost files matching query terms
    if (query) {
      const queryTerms = query.toLowerCase().split(/\s+/);
      for (const f of allFiles) {
        const pathLower = f.path.toLowerCase();
        if (queryTerms.some((t) => pathLower.includes(t))) {
          personalization[f.path] = (personalization[f.path] ?? 0) + basePersonalization * 5;
        }
      }
    }

    // ── Run PageRank ──
    let ranked: Record<string, number>;
    try {
      ranked = pagerank(graph, {
        alpha: 0.85,
        maxIterations: 100,
        tolerance: 1e-6,
        ...(Object.keys(personalization).length > 0 ? { personalization } : {}),
      } as any);
    } catch {
      // Fallback: alphabetical
      ranked = {};
      for (const f of allFiles) ranked[f.path] = 1;
    }

    // ── Step 7: RENDER — Format as text within token budget ──
    return this.renderMap(ranked, defSignatures, allDefs, focusFiles, maxTokens);
  }

  private renderMap(
    ranked: Record<string, number>,
    defSignatures: Map<string, string>,
    allDefs: Array<{ file_path: string; name: string; line: number; signature: string }>,
    focusFiles: string[],
    maxTokens: number,
  ): string {
    // Sort files by rank
    const sortedFiles = Object.entries(ranked)
      .sort((a, b) => b[1] - a[1])
      .filter(([path]) => !focusFiles.includes(path)) // Exclude files already in context
      .map(([path]) => path);

    // Build map text with token budget (approx 4 chars per token)
    const charBudget = maxTokens * 4;
    const lines: string[] = [];
    let totalChars = 0;

    for (const filePath of sortedFiles) {
      if (totalChars >= charBudget) break;

      const fileDefs = allDefs
        .filter((d) => d.file_path === filePath)
        .sort((a, b) => a.line - b.line);

      if (fileDefs.length === 0) {
        const line = filePath;
        lines.push(line);
        totalChars += line.length + 1;
        continue;
      }

      // File header
      const header = `\n${filePath}:`;
      lines.push(header);
      totalChars += header.length + 1;

      // Symbol signatures (deduplicated)
      const seenSymbols = new Set<string>();
      for (const def of fileDefs) {
        if (seenSymbols.has(def.name)) continue;
        seenSymbols.add(def.name);

        const sig = def.signature
          ? `  │ ${def.signature.slice(0, 100)}`
          : `  │ ${def.name}`;

        if (totalChars + sig.length + 1 > charBudget) break;
        lines.push(sig);
        totalChars += sig.length + 1;
      }
    }

    return lines.join('\n');
  }

  // ── File Outline ─────────────────────────────────────────────────────────

  async getFileOutline(filePath: string, maxSymbols = 200): Promise<FileOutline> {
    await this.ensureParser();

    const relPath = this.normalizeRepoFilePath(filePath);
    const absPath = resolve(this.rootPath, relPath);
    const content = await readFile(absPath, 'utf-8');
    const language = LANGUAGE_MAP[extname(relPath)] ?? '';
    const totalLines = content.split('\n').length;

    const tags = await this.extractSymbols(relPath, language);
    const symbols = tags
      .filter((tag) => tag.kind === 'def')
      .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, maxSymbols))
      .map((tag) => ({
        name: tag.name,
        kind: tag.kindDetail || 'definition',
        signature: tag.signature ?? tag.name,
        startLine: tag.line + 1,
        endLine: Math.max(tag.line, tag.endLine ?? tag.line) + 1,
        parentSymbol: tag.parentSymbol,
      }));

    return {
      file: relPath,
      language,
      totalLines,
      symbols,
    };
  }

  private normalizeRepoFilePath(filePath: string): string {
    const root = resolve(this.rootPath);
    const absPath = resolve(root, filePath);
    if (absPath !== root && !absPath.startsWith(root + sep)) {
      throw new Error(`File is outside repository: ${filePath}`);
    }
    return relative(root, absPath);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats(): { files: number; symbols: number; definitions: number; references: number } {
    const files = (this.db.prepare('SELECT COUNT(*) as cnt FROM files').get() as any).cnt;
    const symbols = (this.db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as any).cnt;
    const definitions = (this.db.prepare("SELECT COUNT(*) as cnt FROM symbols WHERE kind = 'def'").get() as any).cnt;
    const references = (this.db.prepare("SELECT COUNT(*) as cnt FROM symbols WHERE kind = 'ref'").get() as any).cnt;
    return { files, symbols, definitions, references };
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }
}
