import { createTool } from '@mastra/core/tools';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveFilmSkillsRoot(): string {
  const candidates = [
    process.env.FILM_SKILL_ROOT,
    process.env.FILM_SKILLS_ROOT,
    join(process.cwd(), 'src/mastra/_skills/film'),
    join(process.cwd(), 'agentic-agents/src/mastra/_skills/film'),
    resolve(__dirname, '../../_skills/film'),
    resolve(__dirname, '../_skills/film'),
    resolve(__dirname, '../../../src/mastra/_skills/film'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);

  const root = candidates.find((candidate) => existsSync(candidate));
  if (!root) {
    throw new Error(`Film skills root not found. Tried: ${candidates.join(', ')}`);
  }
  return root;
}

function safeResolveUnder(root: string, relativePath: string): string {
  const normalized = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const target = resolve(root, normalized);
  const rootWithSep = root.endsWith('/') ? root : `${root}/`;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`Refusing to load path outside film skills root: ${relativePath}`);
  }
  return target;
}

function candidatePaths(root: string, kind: 'skill' | 'reference' | 'data' | 'example', name: string): string[] {
  const clean = name.replace(/^\[(skill|ref):|]$/g, '').replace(/\.md$/i, '');
  if (kind === 'skill') {
    return [
      safeResolveUnder(root, `skills/${clean}/SKILL.md`),
      safeResolveUnder(root, `skills/${clean}.md`),
    ];
  }
  if (kind === 'reference') {
    return [
      safeResolveUnder(root, `references/${clean}.md`),
      safeResolveUnder(root, `references/${clean}`),
    ];
  }
  if (kind === 'data') {
    return [
      safeResolveUnder(root, `data/${clean}`),
      safeResolveUnder(root, `data/${clean}.json`),
      safeResolveUnder(root, `data/${clean}.jsonl`),
    ];
  }
  return [
    safeResolveUnder(root, `examples/${clean}`),
    safeResolveUnder(root, `examples/${clean}.md`),
    safeResolveUnder(root, `examples/${clean}.json`),
  ];
}

async function listFiles(root: string, dir: string): Promise<string[]> {
  const full = safeResolveUnder(root, dir);
  if (!existsSync(full)) return [];
  const entries = await readdir(full, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, rel));
    } else {
      files.push(rel.replace(/\\/g, '/'));
    }
  }
  return files;
}

export const filmLoadReferenceTool = createTool({
  id: 'film_load_reference',
  description:
    'Loads a Seedance film skill/reference/data/example file from src/mastra/_skills/film. Use for [skill:x] and [ref:y] routing.',
  inputSchema: z.object({
    kind: z.enum(['skill', 'reference', 'data', 'example']),
    name: z.string().min(1).describe('Skill/ref/data/example name, e.g. seedance-sequence, api-status, vocab/zh.'),
    maxChars: z.number().int().min(500).max(40000).default(16000),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string().optional(),
    content: z.string().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const root = resolveFilmSkillsRoot();
      const target = candidatePaths(root, context.kind, context.name).find((path) => existsSync(path));
      if (!target) {
        return {
          success: false,
          error: `Film ${context.kind} not found: ${context.name}`,
        };
      }
      const info = await stat(target);
      if (!info.isFile()) {
        return { success: false, error: `Film ${context.kind} is not a file: ${context.name}` };
      }
      const raw = await readFile(target, 'utf-8');
      const content = raw.slice(0, context.maxChars);
      return {
        success: true,
        path: relative(root, target).replace(/\\/g, '/'),
        content,
        truncated: raw.length > content.length,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const filmSearchReferenceTool = createTool({
  id: 'film_search_reference',
  description:
    'Searches Seedance film skill/reference filenames and short content snippets under src/mastra/_skills/film.',
  inputSchema: z.object({
    query: z.string().min(2),
    kind: z.enum(['skill', 'reference', 'data', 'example', 'all']).default('all'),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      kind: z.string(),
      path: z.string(),
      score: z.number(),
      snippet: z.string(),
    })),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const root = resolveFilmSkillsRoot();
      const dirs = context.kind === 'all'
        ? ['skills', 'references', 'data', 'examples']
        : [`${context.kind}s`.replace('reference', 'reference')];
      const normalizedDirs = dirs.map((dir) => (dir === 'skill' ? 'skills' : dir));
      const terms = context.query.toLowerCase().split(/\s+/).filter(Boolean);
      const results: Array<{ kind: string; path: string; score: number; snippet: string }> = [];

      for (const dir of normalizedDirs) {
        const actualDir = dir === 'references' || dir === 'skills' || dir === 'data' || dir === 'examples'
          ? dir
          : context.kind === 'reference'
            ? 'references'
            : context.kind === 'skill'
              ? 'skills'
              : context.kind === 'example'
                ? 'examples'
                : 'data';
        for (const path of await listFiles(root, actualDir)) {
          const full = safeResolveUnder(root, path);
          const text = await readFile(full, 'utf-8').catch(() => '');
          const haystack = `${path}\n${text.slice(0, 2000)}`.toLowerCase();
          const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
          if (score <= 0) continue;
          const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 280);
          results.push({
            kind: path.split('/')[0] ?? 'film',
            path,
            score,
            snippet,
          });
        }
      }

      results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return { success: true, results: results.slice(0, context.limit) };
    } catch (error) {
      return { success: false, results: [], error: (error as Error).message };
    }
  },
});
