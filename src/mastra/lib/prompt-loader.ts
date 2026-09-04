/**
 * Loads prompts from src/mastra/prompts/<path>.md
 * Usage: await loadPrompt('meta/base') → string
 * Prompts can be edited without rebuild (just hot-reload the file).
 */
import { readFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve prompts root - handles both:
 * - Source: src/mastra/lib/../prompts  (__dirname = src/mastra/lib)
 * - Bundled: .mastra/output/  (__dirname = .mastra/output → ../../src/mastra/prompts)
 */
function resolvePromptsRoot(): string {
  // Candidate paths in priority order
  const candidates = [
    resolve(__dirname, '../prompts'),                    // source: src/mastra/lib/../prompts
    resolve(__dirname, '../../src/mastra/prompts'),      // bundle: .mastra/output/../../src/mastra/prompts
    join(process.cwd(), 'src', 'mastra', 'prompts'),    // fallback from CWD
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

const PROMPTS_ROOT = resolvePromptsRoot();

/**
 * Resolve `{{include:relative/path.md}}` directives (Etap 2 — generated
 * roster). Paths are relative to the INCLUDING file's directory. One level of
 * nesting is enough for generated sections; deeper nesting resolves
 * recursively with a small depth cap for safety.
 */
async function resolveIncludes(content: string, baseDir: string, depth = 0): Promise<string> {
  if (depth > 3) return content;
  const pattern = /\{\{include:\s*([^}]+?)\s*\}\}/g;
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    parts.push(content.slice(lastIndex, match.index));
    const includePath = resolve(baseDir, match[1]!);
    try {
      const included = await readFile(includePath, 'utf-8');
      parts.push(await resolveIncludes(included, dirname(includePath), depth + 1));
    } catch {
      parts.push(`<!-- include missing: ${match[1]} — run npm run build:agent-board -->`);
    }
    lastIndex = match.index! + match[0].length;
  }
  parts.push(content.slice(lastIndex));
  return parts.join('');
}

/**
 * The house style, appended to every agent prompt — the ONE place it lives.
 *
 * It was a per-agent rule before, stated three separate times inside
 * `writerAgent`'s own prompts and nowhere else, so every other agent was free to
 * produce em-dashes. That is how a rule meant to be universal turns into a rule
 * about one agent: not by decision, but by nobody adding it to the eleventh
 * prompt. The loader is the only point every prompt-driven agent passes through
 * on BOTH engines, legacy and V2, so it is where a universal rule belongs.
 *
 * Fragments are excluded: `shared/` and `_generated/` are pulled INTO other
 * prompts, and appending there would repeat the rule inside the file that already
 * carries it.
 */
const HOUSE_STYLE_PROMPT = 'shared/house-style.md';
const FRAGMENT_PREFIXES = ['shared/', '_generated/'];
let houseStyleCache: Promise<string> | undefined;

function isFragment(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\.\//, '');
  return FRAGMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

async function houseStyle(): Promise<string> {
  houseStyleCache ??= readFile(resolve(PROMPTS_ROOT, HOUSE_STYLE_PROMPT), 'utf-8')
    // A missing style file must not take down every agent in the system. It is a
    // constraint on output, not a precondition for running.
    .catch(() => '');
  return houseStyleCache;
}

/** The prompt as written, includes resolved, WITHOUT the house style. */
async function readPromptFile(relativePath: string): Promise<string> {
  const filePath = resolve(PROMPTS_ROOT, relativePath.endsWith('.md') ? relativePath : `${relativePath}.md`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return await resolveIncludes(raw, dirname(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Prompt not found: ${filePath}. Create it in src/mastra/prompts/${relativePath}.md`);
    }
    throw err;
  }
}

export async function loadPrompt(relativePath: string): Promise<string> {
  const resolved = await readPromptFile(relativePath);
  if (isFragment(relativePath)) return resolved;
  const style = await houseStyle();
  return style ? `${resolved}\n\n${style}` : resolved;
}

/**
 * Combine multiple prompts into one system prompt.
 * Each section is separated by a double newline.
 */
export async function combinePrompts(...paths: string[]): Promise<string> {
  // Read the parts WITHOUT the style and append it once, rather than mapping
  // `loadPrompt`: `huntAgent` combines two prompts, and the same rule stated
  // twice in one system prompt is noise that teaches a model the section is
  // boilerplate.
  const parts = await Promise.all(paths.map(readPromptFile));
  const style = await houseStyle();
  return [...parts, ...(style ? [style] : [])].join('\n\n');
}

/**
 * Inject dynamic context into a prompt string.
 * Appends a ## Context section with JSON.
 */
export function withContext(prompt: string, context: Record<string, unknown>): string {
  return `${prompt}\n\n## Aktywny kontekst\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;
}
