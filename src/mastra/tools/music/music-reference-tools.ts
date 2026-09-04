import { createTool } from '@mastra/core/tools';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

type MusicReferenceKind = 'skill' | 'reference' | 'data' | 'example';

function resolveMusicSkillsRoot(): string {
  const candidates = [
    process.env.MUSIC_SKILLS_ROOT,
    join(process.cwd(), 'src/mastra/_skills/music'),
    join(process.cwd(), 'agentic-agents/src/mastra/_skills/music'),
    resolve(__dirname, '../../_skills/music'),
    resolve(__dirname, '../_skills/music'),
    resolve(__dirname, '../../../src/mastra/_skills/music'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);

  const root = candidates.find((candidate) => existsSync(candidate));
  if (!root) {
    throw new Error(`Music skills root not found. Tried: ${candidates.join(', ')}`);
  }
  return resolve(root);
}

function safeResolveUnder(root: string, relativePath: string): string {
  const cleanRoot = resolve(root);
  const normalized = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const target = resolve(cleanRoot, normalized);
  const rootWithSep = cleanRoot.endsWith('/') ? cleanRoot : `${cleanRoot}/`;
  if (target !== cleanRoot && !target.startsWith(rootWithSep)) {
    throw new Error(`Refusing to load path outside music skills root: ${relativePath}`);
  }
  return target;
}

function cleanName(name: string): string {
  return name
    .trim()
    .replace(/^\[(skill|ref|data|example):/i, '')
    .replace(/]$/g, '')
    .replace(/\.md$/i, '')
    .replace(/\.jsonl?$/i, '');
}

function candidatePaths(root: string, kind: MusicReferenceKind, name: string): string[] {
  const clean = cleanName(name);
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
      safeResolveUnder(root, `data/${clean}.md`),
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

function dirsForKind(kind: MusicReferenceKind | 'all'): string[] {
  if (kind === 'all') return ['skills', 'references', 'data', 'examples'];
  if (kind === 'skill') return ['skills'];
  if (kind === 'reference') return ['references'];
  if (kind === 'example') return ['examples'];
  return ['data'];
}

export const musicLoadReferenceTool = createTool({
  id: 'music_load_reference',
  description:
    'Loads a music skill/reference/data/example file from src/mastra/_skills/music. Use for [skill:x] and [ref:y] routing in the musician domain.',
  inputSchema: z.object({
    kind: z.enum(['skill', 'reference', 'data', 'example']),
    name: z.string().min(1).describe('Skill/ref/data/example name, e.g. style-prompt-engineer, grammar/surface-grammar-adapter, genres/synthwave.'),
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
      const root = resolveMusicSkillsRoot();
      const target = candidatePaths(root, context.kind, context.name).find((path) => existsSync(path));
      if (!target) {
        return {
          success: false,
          error: `Music ${context.kind} not found: ${context.name}`,
        };
      }
      const info = await stat(target);
      if (!info.isFile()) {
        return { success: false, error: `Music ${context.kind} is not a file: ${context.name}` };
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

export const musicSearchReferenceTool = createTool({
  id: 'music_search_reference',
  description:
    'Searches music skill/reference filenames and short content snippets under src/mastra/_skills/music.',
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
      const root = resolveMusicSkillsRoot();
      const kind = context.kind ?? 'all';
      const terms = context.query.toLowerCase().split(/\s+/).filter(Boolean);
      const results: Array<{ kind: string; path: string; score: number; snippet: string }> = [];

      for (const dir of dirsForKind(kind)) {
        for (const path of await listFiles(root, dir)) {
          const full = safeResolveUnder(root, path);
          const text = await readFile(full, 'utf-8').catch(() => '');
          const haystack = `${path}\n${text.slice(0, 2000)}`.toLowerCase();
          const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
          if (score <= 0) continue;
          const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 280);
          results.push({
            kind: path.split('/')[0] ?? 'music',
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
