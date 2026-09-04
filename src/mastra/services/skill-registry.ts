/**
 * Skill Registry (Phase 2.2)
 *
 * Manages the lifecycle of agent skills:
 *   1. Scans _skills/ directory for *.md files with YAML frontmatter
 *   2. Parses metadata (name, description, category, keywords, etc.)
 *   3. Generates embeddings for semantic search
 *   4. Provides search/load/report APIs
 *
 * Compatible with both existing skills (name, category, description, keywords)
 * and the extended agentskills.io format (allowedTools, minComplexity, etc.).
 *
 * Usage:
 *   import { getSkillRegistry } from './services/skill-registry.js';
 *   const registry = getSkillRegistry();
 *   await registry.initialize('./src/mastra/_skills');
 *
 *   const results = await registry.search('fix typescript error');
 *   const skill = await registry.load('git-conflict-resolver');
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, basename, extname } from 'path';
import { parseFrontmatter, updateFrontmatter } from '../lib/yaml-frontmatter.js';
import { generateEmbedding, cosineSimilarity } from '../lib/embedder.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskComplexity = 'trivial' | 'simple' | 'medium' | 'complex' | 'critical';
export type SkillModelTier = 'fast' | 'balanced' | 'pro' | 'private';

export interface SkillMetadata {
  /** Unique skill name (from frontmatter or derived from filename) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Category/domain (e.g., 'terminal', 'coding', 'n8n') */
  category?: string;
  /** Search keywords */
  keywords?: string[];
  /** Allowed tools for this skill */
  allowedTools?: string[];
  /** Minimum task complexity this skill handles */
  minComplexity?: TaskComplexity;
  /** Recommended execution model tier */
  recommendedTier?: SkillModelTier;
  /** Whether this skill prefers a local Ollama model if VRAM allows */
  preferLocal?: boolean;
  /** Whether the skill produces an artifact suitable for downstream handoff */
  handoffCapable?: boolean;
  /** Estimated token usage */
  estimatedTokens?: number;
  /** Expected output format */
  outputFormat?: string;
  /** Semantic tags for matching */
  tags?: string[];
  /** Skill version */
  version?: number;
  /** Feedback: success rate (0-1) */
  successRate?: number | null;
  /** Feedback: total uses */
  totalUses?: number;
  /** Feedback: last used timestamp */
  lastUsed?: string | null;
  /** Author */
  author?: string;
  /** Any extra metadata fields */
  [key: string]: any;
}

export interface Skill {
  metadata: SkillMetadata;
  /** Markdown body (without frontmatter) */
  procedure: string;
  /** Absolute path to the skill file */
  filePath: string;
  /** Embedding vector for semantic search */
  embedding: number[];
}

export interface SkillSearchResult extends Skill {
  /** Cosine similarity score */
  score: number;
}

// ── Skill Registry ───────────────────────────────────────────────────────────

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private skillsDir = '';

  /**
   * Scan _skills/ directory, parse frontmatter, build embedding index.
   * Handles nested directories (e.g., _skills/terminal/*.md, _skills/coding/*.md).
   * Ignores non-markdown files (JSON blocks, etc.).
   */
  async initialize(
    skillsDir?: string | string[],
    opts: { skipEmbeddings?: boolean } = {},
  ): Promise<void> {
    if (this.initialized && !skillsDir) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const targetDirs = skillsDir
        ? (Array.isArray(skillsDir) ? skillsDir : [skillsDir])
        : [
            process.env.MASTRA_SKILLS_DIR || join(process.cwd(), 'src/mastra/_skills'),
            join(process.cwd(), '../.agents/skills'),
            join(process.cwd(), '.agents/skills'),
          ].filter(Boolean);

      this.skillsDir = targetDirs[0] || '';
      this.skills.clear();

      const mdFiles: string[] = [];
      for (const dir of targetDirs) {
        try {
          const found = await this._findMarkdownFiles(dir);
          mdFiles.push(...found);
        } catch {
          // directory might not exist, skip gracefully
        }
      }
      console.log(`[SkillRegistry] Found ${mdFiles.length} skill files across directories`);

      const embeddingJobs: Array<{ name: string; metadata: SkillMetadata }> = [];

      for (const filePath of mdFiles) {
        try {
          const content = await readFile(filePath, 'utf-8');
          const { metadata: rawMeta, body } = parseFrontmatter(content);

          // Skip supporting files (reference docs, agent prompts, etc.)
          // that don't have proper skill frontmatter (name + description).
          if (!rawMeta.name && !rawMeta.description) {
            continue;
          }

          // Derive name from frontmatter or filename
          const name = rawMeta.name || basename(filePath, extname(filePath));

          // Derive category from parent directory
          const relPath = relative(this.skillsDir || process.cwd(), filePath);
          const category = rawMeta.category || relPath.split('/')[0] || 'general';

          const metadata: SkillMetadata = {
            name,
            description: rawMeta.description || '',
            category,
            keywords: Array.isArray(rawMeta.keywords) ? rawMeta.keywords : [],
            allowedTools: Array.isArray(rawMeta.allowedTools) ? rawMeta.allowedTools : undefined,
            minComplexity: rawMeta.minComplexity as TaskComplexity | undefined,
            recommendedTier: (rawMeta.recommendedTier || rawMeta.recommended_tier) as SkillModelTier | undefined,
            preferLocal: rawMeta.preferLocal ?? rawMeta.prefer_local,
            handoffCapable: rawMeta.handoffCapable ?? rawMeta.handoff_capable,
            estimatedTokens: rawMeta.estimatedTokens ? Number(rawMeta.estimatedTokens) : undefined,
            outputFormat: rawMeta.outputFormat,
            tags: Array.isArray(rawMeta.tags) ? rawMeta.tags : undefined,
            version: rawMeta.version ? Number(rawMeta.version) : undefined,
            successRate: rawMeta.success_rate != null ? Number(rawMeta.success_rate) : null,
            totalUses: rawMeta.total_uses ? Number(rawMeta.total_uses) : 0,
            lastUsed: rawMeta.last_used || null,
            author: rawMeta.author,
          };

          const skill: Skill = {
            metadata,
            procedure: body,
            filePath,
            embedding: [],
          };

          this.skills.set(name, skill);

          if (metadata.description) {
            embeddingJobs.push({ name, metadata });
          }
        } catch (err) {
          console.warn(`[SkillRegistry] Failed to parse ${filePath}:`, (err as Error).message);
        }
      }

      if (!opts.skipEmbeddings && process.env.SKIP_SKILL_EMBEDDINGS !== 'true') {
        await this._generateEmbeddingsWithLimit(embeddingJobs);
      }

      this.initialized = true;
      const withEmbeddings = [...this.skills.values()].filter(s => s.embedding.length > 0).length;
      console.log(`[SkillRegistry] Initialized: ${this.skills.size} skills, ${withEmbeddings} with embeddings`);
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  /**
   * Get all registered skills.
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get a single skill by name.
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Rejestruje lub przeładowuje pojedynczy plik skilla w locie (hot-reload).
   */
  async registerSingleSkillFile(filePath: string): Promise<Skill | undefined> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const { metadata: rawMeta, body } = parseFrontmatter(content);
      const name = rawMeta.name || basename(filePath, extname(filePath));
      const relPath = relative(this.skillsDir || process.cwd(), filePath);
      const category = rawMeta.category || relPath.split('/')[0] || 'general';

      const metadata: SkillMetadata = {
        name,
        description: rawMeta.description || '',
        category,
        keywords: Array.isArray(rawMeta.keywords) ? rawMeta.keywords : [],
        allowedTools: Array.isArray(rawMeta.allowedTools) ? rawMeta.allowedTools : undefined,
        minComplexity: rawMeta.minComplexity as TaskComplexity | undefined,
        recommendedTier: (rawMeta.recommendedTier || rawMeta.recommended_tier) as SkillModelTier | undefined,
        preferLocal: rawMeta.preferLocal ?? rawMeta.prefer_local,
        handoffCapable: rawMeta.handoffCapable ?? rawMeta.handoff_capable,
        estimatedTokens: rawMeta.estimatedTokens ? Number(rawMeta.estimatedTokens) : undefined,
        outputFormat: rawMeta.outputFormat,
        tags: Array.isArray(rawMeta.tags) ? rawMeta.tags : undefined,
        version: rawMeta.version ? Number(rawMeta.version) : undefined,
        successRate: rawMeta.success_rate != null ? Number(rawMeta.success_rate) : null,
        totalUses: rawMeta.total_uses ? Number(rawMeta.total_uses) : 0,
        lastUsed: rawMeta.last_used || null,
        author: rawMeta.author,
        ...rawMeta,
      };

      const skill: Skill = {
        metadata,
        procedure: body,
        filePath,
        embedding: [],
      };

      this.skills.set(name, skill);

      if (metadata.description && process.env.SKIP_SKILL_EMBEDDINGS !== 'true') {
        try {
          await this._generateSkillEmbedding(name, metadata);
        } catch (embErr) {
          console.warn(`[SkillRegistry] Single file embedding warning for ${name}:`, (embErr as Error).message);
        }
      }

      console.log(`[SkillRegistry] Hot-reloaded skill: ${name} (${filePath})`);
      return skill;
    } catch (err) {
      console.error(`[SkillRegistry] Failed to register single skill ${filePath}:`, (err as Error).message);
      return undefined;
    }
  }

  /**
   * Semantic search over registered skills.
   * Returns skills ranked by cosine similarity to the query.
   */
  async search(
    query: string,
    opts: { category?: string; topK?: number; minScore?: number } = {},
  ): Promise<SkillSearchResult[]> {
    const { category, topK = 5, minScore = 0.3 } = opts;

    if (!this.initialized) {
      await this.initialize(undefined, { skipEmbeddings: true });
    }

    if (this.skills.size === 0) {
      return [];
    }

    let candidates = [...this.skills.values()];
    if (category) {
      candidates = candidates.filter(s => s.metadata.category === category);
    }

    // Try semantic search first
    const withEmbeddings = candidates.filter(s => s.embedding.length > 0);

    if (withEmbeddings.length > 0) {
      const queryVec = await generateEmbedding(query);

      return withEmbeddings
        .map(skill => ({
          ...skill,
          score: cosineSimilarity(queryVec, skill.embedding),
        }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }

    // Fallback: keyword matching
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/);

    return candidates
      .map(skill => {
        const searchText = [
          skill.metadata.name,
          skill.metadata.description,
          ...(skill.metadata.keywords || []),
          ...(skill.metadata.tags || []),
        ].join(' ').toLowerCase();

        const matchCount = queryTerms.filter(t => searchText.includes(t)).length;
        const score = matchCount / queryTerms.length;

        return { ...skill, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Load a skill by name. Returns full skill with procedure.
   */
  async load(skillName: string): Promise<Skill | null> {
    if (!this.initialized) {
      await this.initialize(undefined, { skipEmbeddings: true });
    }
    const skill = this.skills.get(skillName);
    if (!skill) return null;

    // Re-read file to get latest content (in case frontmatter was updated)
    try {
      const content = await readFile(skill.filePath, 'utf-8');
      const { body } = parseFrontmatter(content);
      return { ...skill, procedure: body };
    } catch {
      return skill;
    }
  }

  /**
   * Get all skills matching a given execution tier.
   */
  getSkillsForTier(tier: SkillModelTier): Skill[] {
    return Array.from(this.skills.values()).filter(skill => {
      if (skill.metadata.recommendedTier) {
        return skill.metadata.recommendedTier === tier;
      }
      if (tier === 'fast') {
        return skill.metadata.minComplexity === 'trivial' || skill.metadata.minComplexity === 'simple';
      }
      if (tier === 'pro') {
        return skill.metadata.minComplexity === 'complex' || skill.metadata.minComplexity === 'critical';
      }
      return skill.metadata.minComplexity === 'medium';
    });
  }

  /**
   * Report skill usage result — updates success_rate in YAML frontmatter.
   * This creates a feedback loop: skills with low success_rate can be
   * improved or deprioritized.
   */
  async reportResult(
    skillName: string,
    success: boolean,
    notes?: string,
  ): Promise<{ updated: boolean; newSuccessRate: number | null }> {
    const skill = this.skills.get(skillName);
    if (!skill) return { updated: false, newSuccessRate: null };

    const totalUses = (skill.metadata.totalUses || 0) + 1;
    const previousRate = skill.metadata.successRate ?? 1.0;
    // Rolling average: blend old rate with new result
    const newSuccessRate = previousRate === null
      ? (success ? 1.0 : 0.0)
      : (previousRate * (totalUses - 1) + (success ? 1 : 0)) / totalUses;

    const roundedRate = Math.round(newSuccessRate * 100) / 100;

    try {
      await updateFrontmatter(skill.filePath, {
        success_rate: roundedRate,
        total_uses: totalUses,
        last_used: new Date().toISOString().split('T')[0],
      });

      // Update in-memory
      skill.metadata.successRate = roundedRate;
      skill.metadata.totalUses = totalUses;
      skill.metadata.lastUsed = new Date().toISOString().split('T')[0];

      return { updated: true, newSuccessRate: roundedRate };
    } catch (err) {
      console.warn(`[SkillRegistry] Failed to update ${skillName}:`, (err as Error).message);
      return { updated: false, newSuccessRate: roundedRate };
    }
  }

  /**
   * List all registered skills (metadata only, no procedure body).
   */
  list(opts: { category?: string } = {}): SkillMetadata[] {
    let skills = [...this.skills.values()];
    if (opts.category) {
      skills = skills.filter(s => s.metadata.category === opts.category);
    }
    return skills.map(s => s.metadata);
  }

  /** Absolute file path of a loaded skill (Etap 6 — curator archiving). */
  filePath(name: string): string | undefined {
    return this.skills.get(name)?.filePath;
  }

  /**
   * Get categories with skill counts.
   */
  categories(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const skill of this.skills.values()) {
      const cat = skill.metadata.category || 'general';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Lifecycle dirs skipped by the loader (Etap 6): quarantined (failed
   *  mini-eval) and archived (curated out) skills must never be searched. */
  private static readonly SKIP_DIRS = new Set(['quarantine', 'archive']);

  private async _findMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stats = await stat(fullPath);

        if (stats.isDirectory()) {
          if (SkillRegistry.SKIP_DIRS.has(entry)) continue;
          const nested = await this._findMarkdownFiles(fullPath);
          results.push(...nested);
        } else if (entry.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return results;
  }

  private async _generateSkillEmbedding(name: string, meta: SkillMetadata): Promise<void> {
    // Build searchable text from metadata
    const searchText = [
      meta.description,
      ...(meta.keywords || []),
      ...(meta.tags || []),
      meta.category,
    ].filter(Boolean).join('. ');

    const embedding = await generateEmbedding(searchText);
    const skill = this.skills.get(name);
    if (skill) {
      skill.embedding = embedding;
    }
  }

  private async _generateEmbeddingsWithLimit(
    jobs: Array<{ name: string; metadata: SkillMetadata }>,
  ): Promise<void> {
    const configured = Number(process.env.SKILL_EMBEDDING_CONCURRENCY);
    const concurrency = Number.isFinite(configured)
      ? Math.max(1, Math.min(4, configured))
      : 1;

    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        if (!job) continue;
        try {
          await this._generateSkillEmbedding(job.name, job.metadata);
        } catch (err) {
          console.warn(`[SkillRegistry] Embedding failed for ${job.name}:`, (err as Error).message);
        }
      }
    });

    await Promise.allSettled(workers);
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!_instance) {
    _instance = new SkillRegistry();
  }
  return _instance;
}
