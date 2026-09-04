/**
 * Unified Capability Catalog (Smart Capability Shelf)
 *
 * Unified semantic and lexical registry for Tools and Skills:
 *   1. Normalizes Tools (JSON Schema / Zod) and Skills (Markdown SOPs) into ExecutionCapability objects.
 *   2. Indexes capabilities with hybrid embeddings (BGE-M3 / Google / Ollama) + lexical BM25.
 *   3. Provides fast in-memory hybrid search (0.7 cosine similarity + 0.3 BM25).
 *   4. Persists embedding cache to disk (.mastra/capability-cache.json) for instant startup.
 */

import { readdir, readFile, stat, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative, basename, extname, dirname } from 'path';
import { createHash } from 'crypto';
import { parseFrontmatter } from '../lib/yaml-frontmatter.js';
import { generateEmbedding, cosineSimilarity, type EmbeddingVector, EMBEDDING_MODEL_ID } from '../lib/embedder.js';

export type CapabilityType = 'tool' | 'skill';

export interface ExecutionCapability {
  id: string;                      // e.g. 'tavilyExtractTool' or 'menu-recon'
  name: string;                    // unique human-readable name
  type: CapabilityType;            // 'tool' | 'skill'
  description: string;             // concise text used for semantic matching
  category?: string;               // e.g. 'search', 'coding', 'automation', 'media'
  keywords?: string[];             // additional keyword tags
  allowedTools?: string[];         // for skills: recommended tools
  procedure?: string;              // for skills: Markdown procedure body
  toolHandle?: any;                // for tools: Mastra Tool instance
  embedding?: EmbeddingVector;     // vector embedding
  bundle?: string;                 // bundle name if part of a workflow pack
  tags?: string[];                 // additional tags
  filePath?: string;               // source file if loaded from disk
  hash?: string;                   // hash of content for cache invalidation
}

export interface CapabilitySearchResult {
  capability: ExecutionCapability;
  score: number;
  matchType: 'hybrid' | 'vector' | 'lexical';
}

export interface SearchOptions {
  type?: 'all' | 'tool' | 'skill';
  category?: string;
  topK?: number;
  minScore?: number;
  scopeIds?: string[];             // filter to only consider these capability IDs
  lexicalOnly?: boolean;          // skip generating embedding; fast BM25 search
}

interface SerializedCacheItem {
  hash: string;
  embedding: EmbeddingVector;
}

interface SerializedDiskCache {
  version: number;
  modelId: string;
  items: Record<string, SerializedCacheItem>;
}

export interface CapabilityCatalogOptions {
  cachePath?: string;
  tools?: Record<string, any>;
  skills?: Array<{
    id?: string;
    name: string;
    description?: string;
    category?: string;
    keywords?: string[];
    allowedTools?: string[];
    procedure?: string;
    filePath?: string;
  }>;
  embeddingsEnabled?: boolean;
}

export class CapabilityCatalog {
  private capabilities: Map<string, ExecutionCapability> = new Map();
  private cache: Map<string, SerializedCacheItem> = new Map();
  private initialized = false;
  private isBuildingEmbeddings = false;
  private cachePath: string;

  constructor(options: CapabilityCatalogOptions = {}) {
    this.cachePath = options.cachePath || join(process.cwd(), '.mastra', 'capability-cache.json');
    if (options.tools) {
      for (const [id, tool] of Object.entries(options.tools)) {
        this.registerTool(id, tool);
      }
    }
    if (options.skills) {
      for (const sk of options.skills) {
        const id = sk.id || sk.name;
        this.registerSkill(id, sk.procedure || '', {
          name: sk.name,
          description: sk.description,
          category: sk.category,
          keywords: sk.keywords,
          allowedTools: sk.allowedTools,
          filePath: sk.filePath,
        });
      }
    }
  }

  /**
   * Register a Mastra Tool or custom tool function into the catalog.
   */
  registerTool(
    id: string,
    tool: any,
    metadata?: Partial<Omit<ExecutionCapability, 'id' | 'type' | 'toolHandle'>>,
  ): ExecutionCapability {
    const name = metadata?.name || id;
    const description = metadata?.description || tool.description || `Tool: ${id}`;
    const category = metadata?.category || 'general';
    const keywords = metadata?.keywords || [];
    const bundle = metadata?.bundle;

    const contentForHash = `${id}|${name}|${description}|${keywords.join(',')}`;
    const hash = createHash('sha256').update(contentForHash).digest('hex').slice(0, 16);

    const cap: ExecutionCapability = {
      id,
      name,
      type: 'tool',
      description,
      category,
      keywords,
      bundle,
      tags: metadata?.tags,
      toolHandle: tool,
      hash,
    };

    // Check if we have a cached embedding
    const cached = this.cache.get(`tool:${id}`);
    if (cached && cached.hash === hash) {
      cap.embedding = cached.embedding;
    }

    this.capabilities.set(id, cap);
    return cap;
  }

  /**
   * Register a procedural Markdown Skill into the catalog.
   */
  registerSkill(
    id: string,
    procedure: string,
    metadata?: Partial<Omit<ExecutionCapability, 'id' | 'type' | 'procedure'>>,
  ): ExecutionCapability {
    const name = metadata?.name || id;
    const description = metadata?.description || `Skill procedure for ${name}`;
    const category = metadata?.category || 'general';
    const keywords = metadata?.keywords || [];
    const allowedTools = metadata?.allowedTools || [];
    const bundle = metadata?.bundle;

    const contentForHash = `${id}|${name}|${description}|${procedure.slice(0, 1000)}|${keywords.join(',')}`;
    const hash = createHash('sha256').update(contentForHash).digest('hex').slice(0, 16);

    const cap: ExecutionCapability = {
      id,
      name,
      type: 'skill',
      description,
      category,
      keywords,
      allowedTools,
      procedure,
      bundle,
      tags: metadata?.tags,
      filePath: metadata?.filePath,
      hash,
    };

    // Check if we have a cached embedding
    const cached = this.cache.get(`skill:${id}`);
    if (cached && cached.hash === hash) {
      cap.embedding = cached.embedding;
    }

    this.capabilities.set(id, cap);
    return cap;
  }

  /**
   * Batch register multiple tools from a tools dictionary.
   */
  registerToolsRecord(tools: Record<string, any>, defaultCategory?: string): void {
    for (const [id, tool] of Object.entries(tools)) {
      if (!tool) continue;
      this.registerTool(id, tool, { category: defaultCategory });
    }
  }

  /**
   * Load cache from disk if available and valid for the current embedding model.
   */
  private async loadDiskCache(): Promise<void> {
    try {
      if (existsSync(this.cachePath)) {
        const raw = await readFile(this.cachePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          // Handle versioned schema
          if (parsed.version === 1 && typeof parsed.items === 'object' && parsed.items !== null) {
            if (parsed.modelId === EMBEDDING_MODEL_ID) {
              for (const [k, v] of Object.entries(parsed.items)) {
                const item = v as SerializedCacheItem;
                if (item && item.hash && Array.isArray(item.embedding)) {
                  this.cache.set(k, item);
                }
              }
            } else {
              // Model changed — clear cache to regenerate with new vector dimensions
              this.cache.clear();
            }
          } else {
            // Unversioned fallback
            for (const [k, v] of Object.entries(parsed)) {
              const item = v as SerializedCacheItem;
              if (item && item.hash && Array.isArray(item.embedding)) {
                this.cache.set(k, item);
              }
            }
          }
        }
      }
    } catch {
      // Non-critical cache read failure - continue with in-memory state
    }
  }

  /**
   * Save cache to disk with model ID and version header.
   */
  private async saveDiskCache(): Promise<void> {
    try {
      const dir = dirname(this.cachePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      const items: Record<string, SerializedCacheItem> = {};
      for (const [k, v] of this.cache.entries()) {
        items[k] = v;
      }
      const payload: SerializedDiskCache = {
        version: 1,
        modelId: EMBEDDING_MODEL_ID,
        items,
      };
      await writeFile(this.cachePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      // Non-critical cache save failure
    }
  }

  /**
   * Scan directories for skills (*.md or SKILL.md) and load them into catalog.
   * Dynamically tracks file paths and prunes removed skill files.
   */
  async scanSkillsDirectory(skillsDir: string | string[]): Promise<number> {
    await this.loadDiskCache();
    const dirs = Array.isArray(skillsDir) ? skillsDir : [skillsDir];
    let count = 0;
    const scannedPaths = new Set<string>();

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const files = await this.findMarkdownFiles(dir);
      for (const file of files) {
        try {
          scannedPaths.add(file);
          const content = await readFile(file, 'utf-8');
          const { metadata, body } = parseFrontmatter(content);

          let name = metadata.name;
          if (!name) {
            const base = basename(file, extname(file));
            name = base.toLowerCase() === 'skill' ? basename(dirname(file)) : base;
          }

          const description = metadata.description || body.slice(0, 300).replace(/^[#\s]+/, '').trim();
          const category = metadata.category || relative(dir, dirname(file)).split('/')[0] || 'general';
          const keywords = Array.isArray(metadata.keywords)
            ? metadata.keywords
            : Array.isArray(metadata.tags)
              ? metadata.tags
              : [];
          const allowedTools = Array.isArray(metadata.allowedTools) ? metadata.allowedTools : [];

          this.registerSkill(name, body, {
            name,
            description,
            category,
            keywords,
            allowedTools,
            filePath: file,
          });
          count++;
        } catch {
          // Ignore parse errors on individual skill files
        }
      }
    }

    // Prune deleted skills that were loaded from scanned directories
    for (const [id, cap] of this.capabilities.entries()) {
      if (cap.type === 'skill' && cap.filePath && !scannedPaths.has(cap.filePath)) {
        this.capabilities.delete(id);
        this.cache.delete(`skill:${id}`);
      }
    }

    return count;
  }

  private async findMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        results.push(...(await this.findMarkdownFiles(fullPath)));
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        results.push(fullPath);
      }
    }

    return results;
  }

  /**
   * Ensure embeddings exist for all registered items.
   * Runs gracefully in background: if embedding generator is offline, items will fall back to lexical BM25.
   */
  async buildEmbeddingsIndex(opts: { force?: boolean } = {}): Promise<void> {
    if (this.isBuildingEmbeddings && !opts.force) {
      return;
    }
    this.isBuildingEmbeddings = true;

    try {
      const unindexed: ExecutionCapability[] = [];

      for (const cap of this.capabilities.values()) {
        if (!opts.force && cap.embedding && cap.embedding.length > 0) continue;
        unindexed.push(cap);
      }

      if (unindexed.length === 0) {
        this.initialized = true;
        return;
      }

      let cacheUpdated = false;
      for (const cap of unindexed) {
        try {
          const textToEmbed = `${cap.name}: ${cap.description}. Keywords: ${(cap.keywords || []).join(', ')}`;
          const vector = await generateEmbedding(textToEmbed);
          cap.embedding = vector;
          this.cache.set(`${cap.type}:${cap.id}`, {
            hash: cap.hash || '',
            embedding: vector,
          });
          cacheUpdated = true;
        } catch {
          // Embedder offline or failed — fallback will use lexical scoring
        }
      }

      if (cacheUpdated) {
        await this.saveDiskCache();
      }

      this.initialized = true;
    } finally {
      this.isBuildingEmbeddings = false;
    }
  }

  /**
   * Search capabilities by semantic similarity and lexical BM25 match.
   */
  async search(query: string, options: SearchOptions = {}): Promise<CapabilitySearchResult[]> {
    const {
      type = 'all',
      category,
      topK = 5,
      minScore = 0.15,
      scopeIds,
    } = options;

    if (!query || !query.trim()) {
      return [];
    }

    // Prepare candidate list
    const candidates: ExecutionCapability[] = [];
    for (const cap of this.capabilities.values()) {
      if (type !== 'all' && cap.type !== type) continue;
      if (category && cap.category !== category) continue;
      if (scopeIds && !scopeIds.includes(cap.id)) continue;
      candidates.push(cap);
    }

    if (candidates.length === 0) return [];

    // Try generating query embedding for semantic search unless lexicalOnly requested
    let queryEmbedding: EmbeddingVector | null = null;
    if (!options.lexicalOnly) {
      try {
        queryEmbedding = await generateEmbedding(query);
      } catch {
        queryEmbedding = null;
      }
    }

    const queryTokens = this.tokenize(query);
    const results: CapabilitySearchResult[] = [];

    for (const cap of candidates) {
      const bm25Score = this.calculateLexicalScore(queryTokens, cap);
      let vectorScore = 0;
      let hasVector = false;

      if (queryEmbedding && cap.embedding && cap.embedding.length > 0) {
        try {
          const sim = cosineSimilarity(queryEmbedding, cap.embedding);
          // normalize cosine sim from [-1, 1] to [0, 1]
          vectorScore = Math.max(0, (sim + 1) / 2);
          hasVector = true;
        } catch {
          hasVector = false;
        }
      }

      let finalScore: number;
      let matchType: 'hybrid' | 'vector' | 'lexical';

      if (hasVector) {
        // Hybrid: 70% semantic, 30% lexical
        finalScore = 0.7 * vectorScore + 0.3 * bm25Score;
        matchType = 'hybrid';
      } else {
        finalScore = bm25Score;
        matchType = 'lexical';
      }

      if (finalScore >= minScore) {
        results.push({
          capability: cap,
          score: finalScore,
          matchType,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Tokenize string into normalized terms.
   */
  private tokenize(text: string): string[] {
    const raw = text.toLowerCase();
    const withSpaces = raw.replace(/[^\p{L}\p{N}_\-\s]/gu, ' ');
    const splitBySpace = withSpaces.split(/\s+/).filter((t) => t.length > 1);
    const splitByPunct = withSpaces.replace(/[_\-]+/g, ' ').split(/\s+/).filter((t) => t.length > 1);
    return [...new Set([...splitBySpace, ...splitByPunct])];
  }

  /**
   * Calculate lexical match score [0, 1].
   */
  private calculateLexicalScore(queryTokens: string[], cap: ExecutionCapability): number {
    if (queryTokens.length === 0) return 0;

    const nameTokens = this.tokenize(cap.name);
    const idTokens = this.tokenize(cap.id);
    const descTokens = this.tokenize(cap.description);
    const keywordTokens = (cap.keywords || []).flatMap((k) => this.tokenize(k));

    let score = 0;
    for (const token of queryTokens) {
      if (idTokens.includes(token) || cap.id.toLowerCase() === token) {
        score += 1.0; // exact ID match
      } else if (nameTokens.includes(token)) {
        score += 0.8; // name match
      } else if (keywordTokens.includes(token)) {
        score += 0.6; // keyword match
      } else if (descTokens.includes(token)) {
        score += 0.3; // description match
      } else if (cap.description.toLowerCase().includes(token)) {
        score += 0.15; // substring match
      }
    }

    // Normalize by number of query tokens
    return Math.min(1.0, score / Math.max(1, queryTokens.length * 0.8));
  }

  /**
   * Get capability by ID.
   */
  get(id: string): ExecutionCapability | undefined {
    return this.capabilities.get(id);
  }

  /**
   * Check if capability exists.
   */
  has(id: string): boolean {
    return this.capabilities.has(id);
  }

  /**
   * Get all registered capabilities.
   */
  getAll(): ExecutionCapability[] {
    return Array.from(this.capabilities.values());
  }

  /**
   * Get count of registered capabilities.
   */
  size(): { tools: number; skills: number; total: number } {
    let tools = 0;
    let skills = 0;
    for (const cap of this.capabilities.values()) {
      if (cap.type === 'tool') tools++;
      else if (cap.type === 'skill') skills++;
    }
    return { tools, skills, total: this.capabilities.size };
  }

  /**
   * Clear catalog.
   */
  clear(): void {
    this.capabilities.clear();
    this.initialized = false;
  }
}

// ── Global Singleton Accessor ──────────────────────────────────────────────────

let globalCatalog: CapabilityCatalog | null = null;

export function getCapabilityCatalog(): CapabilityCatalog {
  if (!globalCatalog) {
    globalCatalog = new CapabilityCatalog();
  }
  return globalCatalog;
}
