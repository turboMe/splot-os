import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { ChefService } from './chef-service';
import { withDocumentLock } from '../../lib/document-write-lock.js';
import { getMenuBooksDir } from '../../config/workspace-paths.js';

// ─── Menu Book directory configuration ───────────────────────────────────────
const CHEF_DOCS_DIR = getMenuBooksDir();

// Canonical Menu Book sections (order = order in the document)
const CANONICAL_SECTIONS = [
  'overview',
  'profile',
  'recon',
  'menu',
  'recipes',
  'pairings',
  'allergens',
  'notes',
] as const;
type SectionAnchor = typeof CANONICAL_SECTIONS[number];

// NOTE: section titles below are part of the deliverable artifact (the Menu Book is written
// for a Polish restaurant client), so they stay in Polish to match the document language.
const SECTION_TITLES: Record<SectionAnchor, string> = {
  overview: 'Przegląd',
  profile: 'Profil klienta',
  recon: 'Rozpoznanie (menu + opinie)',
  menu: 'Menu',
  recipes: 'Karty technologiczne',
  pairings: 'Pairingi',
  allergens: 'Macierz alergenów',
  notes: 'Notatki robocze',
};

const SECTION_PLACEHOLDER = '_(do uzupełnienia)_';

// Anchor validation: canonical sections OR dynamic sub-sections like
// `recipe:short-rib`, `research-brief`, `concept`, `menu-card`, `insights`, `appendix`.
const ANCHOR_PATTERN = /^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;

/** Human-readable title for any anchor (canonical, recipe:<slug>, or plan §5 ids). */
function titleFor(anchor: string): string {
  if (anchor in SECTION_TITLES) return SECTION_TITLES[anchor as SectionAnchor];
  if (anchor.startsWith('recipe:')) {
    const slug = anchor.slice('recipe:'.length).replace(/-/g, ' ');
    return `Receptura: ${slug}`;
  }
  // Plan narrative-section titles — also part of the Polish deliverable artifact.
  const planTitles: Record<string, string> = {
    title: 'Tytuł',
    'research-brief': 'Brief researchu',
    concept: 'Koncept',
    'menu-card': 'Karta menu',
    'allergen-matrix': 'Macierz alergenów',
    insights: 'Insighty z opinii',
    appendix: 'Aneks',
  };
  return planTitles[anchor] ?? anchor;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns a safe Menu Book file path for a project (path-traversal guard). */
function bookPath(projectId: string): string {
  // projectId is a UUID; strip everything but safe characters
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid projectId.');
  const filePath = path.resolve(CHEF_DOCS_DIR, `${safeId}.md`);
  if (!filePath.startsWith(CHEF_DOCS_DIR + path.sep)) {
    throw new Error('Access denied: attempt to escape the Menu Book directory.');
  }
  return filePath;
}

function startMarker(anchor: string): string {
  return `<!-- section:${anchor} start -->`;
}
function endMarker(anchor: string): string {
  return `<!-- section:${anchor} end -->`;
}

/** Builds an empty Menu Book skeleton with anchored sections. */
function buildSkeleton(title: string, projectId: string): string {
  const lines: string[] = [];
  lines.push(`# 📖 Księga Menu — ${title}`);
  lines.push('');
  lines.push(`<!-- chef-book projectId:${projectId} -->`);
  lines.push(`> Dokument generowany przyrostowo przez chefAgent. Nie edytuj ręcznie sekcji między znacznikami.`);
  lines.push('');
  for (const anchor of CANONICAL_SECTIONS) {
    lines.push(`## ${SECTION_TITLES[anchor]}`);
    lines.push(startMarker(anchor));
    lines.push(SECTION_PLACEHOLDER);
    lines.push(endMarker(anchor));
    lines.push('');
  }
  return lines.join('\n');
}

/** Returns the current section body (between anchors) or '' if missing/placeholder. */
function getSectionBody(doc: string, anchor: string): string {
  const start = startMarker(anchor);
  const end = endMarker(anchor);
  const startIdx = doc.indexOf(start);
  const endIdx = doc.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return '';
  const body = doc.slice(startIdx + start.length, endIdx).trim();
  return body === SECTION_PLACEHOLDER ? '' : body;
}

/** Replaces a section's content in the document (idempotent upsert by anchor). */
/**
 * Strip section markers out of content before it is written.
 *
 * Same guard as the Content Pack writer, for the same reason: the markers ARE
 * the structure, `indexOf` finds the first one, so content carrying a marker
 * splices a second boundary into the book and every later write aims at the
 * wrong place. Seen live in a Content Pack — two `distribution` sections, the
 * first one empty, and the status tool reporting the section missing while its
 * content sat further down. The Menu Book is written the same way, so it is
 * exposed the same way.
 *
 * Stripped, not rejected: the content is real work.
 */
function stripSectionMarkers(content: string): string {
  return content.replace(/<!--\s*section:[a-z0-9:-]+\s+(?:start|end)\s*-->/gi, '').trimEnd();
}

function replaceSection(doc: string, anchor: string, content: string): string {
  const start = startMarker(anchor);
  const end = endMarker(anchor);
  content = stripSectionMarkers(content);
  const startIdx = doc.indexOf(start);
  const endIdx = doc.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    // Section doesn't exist (e.g. dynamic recipe:<slug>) — append at the end with a heading.
    return (
      doc.trimEnd() +
      `\n\n## ${titleFor(anchor)}\n${start}\n${content.trim()}\n${end}\n`
    );
  }
  const before = doc.slice(0, startIdx + start.length);
  const after = doc.slice(endIdx);
  return `${before}\n${content.trim()}\n${after}`;
}

/** Checks which sections are filled (different from placeholder/empty). */
function sectionStatus(doc: string): { anchor: SectionAnchor; filled: boolean }[] {
  return CANONICAL_SECTIONS.map((anchor) => {
    const start = startMarker(anchor);
    const end = endMarker(anchor);
    const startIdx = doc.indexOf(start);
    const endIdx = doc.indexOf(end);
    let filled = false;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const body = doc.slice(startIdx + start.length, endIdx).trim();
      filled = body.length > 0 && body !== SECTION_PLACEHOLDER;
    }
    return { anchor, filled };
  });
}

/**
 * What is still missing from the Menu Book ON DISK, for the `done` gate.
 *
 * Coverage in Mongo is not the same thing as a finished deliverable, and the two
 * came apart on a live run 2026-08-19: the database held all fifteen recipes and
 * the delivered book was 12 KB with `recipes`, `allergens`, `pairings` and
 * `notes` empty, because `chef_export_menu_book` — the tool that FILLS those
 * sections — was never called. The project still closed as `done`.
 *
 * Returns human-readable gaps, empty when the book is publishable.
 */
export async function menuBookGaps(
  projectId: string,
  opts: { expectRecipes: boolean },
): Promise<string[]> {
  let doc: string;
  try {
    doc = await fs.readFile(bookPath(projectId), 'utf-8');
  } catch {
    return ['the Menu Book file does not exist (chef_document_init was never called)'];
  }

  const gaps: string[] = [];
  const empty = sectionStatus(doc).filter((s) => !s.filled).map((s) => s.anchor);
  if (empty.length > 0) {
    gaps.push(`empty section(s): ${empty.join(', ')}`);
  }
  // The recipe cards live either in the compiled `recipes` section or as
  // per-dish `recipe:<slug>` sections; either shape counts as delivered.
  if (opts.expectRecipes) {
    const compiled = getSectionBody(doc, 'recipes').length > 0;
    const perDish = /<!-- section:recipe:[a-z0-9-]+ start -->/.test(doc);
    if (!compiled && !perDish) {
      gaps.push('the book contains no recipe cards — call chef_export_menu_book to compile them in');
    }
  }
  return gaps;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export const chefDocumentInitTool = createTool({
  id: 'chef_document_init',
  description:
    'Creates the Menu Book (Markdown file) for a project with empty, anchored sections. Idempotent — if the file already exists, returns it without overwriting. Call once at the start of the BOOK phase.',
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
    title: z.string().optional().describe('Menu Book title (defaults to the project name from the DB)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string().optional(),
    created: z.boolean().optional().describe('true = newly created, false = already existed'),
    sections: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      await fs.mkdir(CHEF_DOCS_DIR, { recursive: true });
      const filePath = bookPath(context.projectId);

      // Idempotency — do not overwrite
      try {
        await fs.access(filePath);
        return {
          success: true,
          path: filePath,
          created: false,
          sections: [...CANONICAL_SECTIONS],
        };
      } catch {
        // doesn't exist — create it
      }

      let title = context.title;
      if (!title) {
        try {
          const chef = new ChefService();
          const project = await chef.getProject(context.projectId);
          title = project?.name || context.projectId;
        } catch {
          title = context.projectId;
        }
      }

      const skeleton = buildSkeleton(title, context.projectId);
      await fs.writeFile(filePath, skeleton, 'utf-8');
      return {
        success: true,
        path: filePath,
        created: true,
        sections: [...CANONICAL_SECTIONS],
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefDocumentWriteSectionTool = createTool({
  id: 'chef_document_write_section',
  description:
    'Writes or updates a single Menu Book section by its anchor. Idempotent — replaces the content between markers without duplicating. Call repeatedly as data matures. Canonical anchors: overview, profile, recon, menu, recipes, pairings, allergens, notes. Dynamic anchors: recipe:<slug> (e.g. recipe:short-rib) and plan sections (title, research-brief, concept, menu-card, allergen-matrix, insights, appendix). Append mode adds to existing content instead of overwriting — use it to build the document incrementally (e.g. successive recipes).',
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
    anchor: z
      .string()
      .regex(
        ANCHOR_PATTERN,
        'Anchor must match the pattern: lowercase letters/digits/hyphens, optionally with a type prefix like recipe: (e.g. recipe:short-rib).',
      )
      .describe(
        'Section anchor. Canonical: overview|profile|recon|menu|recipes|pairings|allergens|notes. Dynamic: recipe:<slug>, or plan sections.',
      ),
    content: z.string().describe('Section content (Markdown).'),
    mode: z
      .enum(['replace', 'append'])
      .optional()
      .default('replace')
      .describe(
        'replace = overwrite the whole section (default). append = add to existing content (for incremental building, e.g. successive recipes).',
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string().optional(),
    anchor: z.string().optional(),
    mode: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const filePath = bookPath(context.projectId);
    // The whole body is read-modify-write on ONE file, and the pipeline writes
    // recipe cards in parallel batches of 4-6. Without serialization every writer
    // in a batch reads the same document and the last one to finish wins, so the
    // rest of the batch is silently lost. Measured 2026-08-19 on a live run: 11
    // recipe sections written, 3 present in the file — exactly one survivor per
    // parallel batch, plus the one card that happened to be written on its own.
    return withDocumentLock(filePath, async () => {
      try {
        let doc: string;
        try {
          doc = await fs.readFile(filePath, 'utf-8');
        } catch {
          return {
            success: false,
            error: `Menu Book for project ${context.projectId} does not exist — call chef_document_init.`,
          };
        }
        const mode = context.mode ?? 'replace';
        let nextContent = context.content;
        if (mode === 'append') {
          const existing = getSectionBody(doc, context.anchor);
          nextContent = existing
            ? `${existing}\n\n${context.content.trim()}`
            : context.content;
        }
        const updated = replaceSection(doc, context.anchor, nextContent);
        await fs.writeFile(filePath, updated, 'utf-8');
        return { success: true, path: filePath, anchor: context.anchor, mode };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });
  },
});

export const chefDocumentStatusTool = createTool({
  id: 'chef_document_status',
  description:
    'Returns Menu Book progress: how many of the N canonical sections are filled and which are missing. Use it to track document completeness.',
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string().optional(),
    filled: z.number().optional(),
    total: z.number().optional(),
    sections: z
      .array(z.object({ anchor: z.string(), filled: z.boolean() }))
      .optional(),
    missing: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const filePath = bookPath(context.projectId);
      let doc: string;
      try {
        doc = await fs.readFile(filePath, 'utf-8');
      } catch {
        return {
          success: false,
          error: `Menu Book for project ${context.projectId} does not exist — call chef_document_init.`,
        };
      }
      const status = sectionStatus(doc);
      const filled = status.filter((s) => s.filled).length;
      return {
        success: true,
        path: filePath,
        filled,
        total: CANONICAL_SECTIONS.length,
        sections: status,
        missing: status.filter((s) => !s.filled).map((s) => s.anchor),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefDocumentRenderTool = createTool({
  id: 'chef_document_render',
  description:
    'Returns the full current Menu Book content (the whole Markdown file) for preview or export.',
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string().optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const filePath = bookPath(context.projectId);
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, path: filePath, content };
    } catch (err: any) {
      return {
        success: false,
        error: `Cannot read the Menu Book for project ${context.projectId}: ${err.message}`,
      };
    }
  },
});

// ─── PDF render (D-R1: headless Chromium) ────────────────────────────────────

/**
 * Strips the HTML section-anchor comments so they don't leak into the PDF, and
 * converts the Menu Book Markdown to a styled HTML document (GFM tables → real
 * <table>s, the BOM tables being the critical case for recipe cards).
 */
function bookMarkdownToHtml(markdown: string, title: string): string {
  // Remove the anchor markers and the "do not edit" warning line (artifact-only noise).
  const cleaned = markdown
    .replace(/<!--\s*section:[a-z0-9:-]+\s+(start|end)\s*-->/gi, '')
    .replace(/<!--\s*chef-book[^>]*-->/gi, '');

  const body = micromark(cleaned, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });

  // Print CSS tuned for A4 menu books: bordered BOM tables, readable headings,
  // page-break hygiene so recipe cards don't split mid-table.
  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "DejaVu Sans", "Liberation Sans", "Segoe UI", Arial, sans-serif;
    font-size: 11pt; line-height: 1.5; color: #1a1a1a; max-width: 100%;
  }
  h1 { font-size: 22pt; border-bottom: 2px solid #333; padding-bottom: 6px; }
  h2 { font-size: 15pt; margin-top: 1.6em; border-bottom: 1px solid #ccc; padding-bottom: 3px; page-break-after: avoid; }
  h3 { font-size: 12.5pt; margin-top: 1.2em; page-break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 10pt; page-break-inside: avoid; }
  th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-weight: 600; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-family: "DejaVu Sans Mono", monospace; font-size: 9.5pt; }
  blockquote { border-left: 3px solid #ccc; margin: 0.6em 0; padding: 0.2em 0 0.2em 1em; color: #555; }
  ul, ol { margin: 0.4em 0 0.4em 1.2em; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
  a { color: #1a5fb4; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Resolves the Chromium/Chrome binary (env override → common binaries). */
function chromeBinary(): string {
  return (
    process.env.CHEF_CHROME_BIN ||
    process.env.CHROME_BIN ||
    'google-chrome-stable'
  );
}

/** Spawns headless Chrome to print an HTML file to a PDF. Resolves on exit 0. */
function chromePrintToPdf(htmlPath: string, pdfPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ];
    const child = spawn(chromeBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) =>
      reject(
        new Error(
          `Failed to launch Chrome (${chromeBinary()}): ${err.message}. Set CHEF_CHROME_BIN to a Chromium/Chrome binary.`,
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Chrome exited with code ${code}. ${stderr.slice(0, 400)}`));
    });
  });
}

export const chefDocumentPdfTool = createTool({
  id: 'chef_document_pdf',
  description:
    'Renders the Menu Book (Markdown) to a print-ready PDF via headless Chromium. GFM tables become real bordered tables (recipe BOM tables, allergen matrix). Output goes next to the .md file as <projectId>.pdf unless outputPath is given. Call in the render phase, after the document is complete. Requires a Chrome/Chromium binary (env CHEF_CHROME_BIN, default google-chrome-stable).',
  inputSchema: z.object({
    projectId: z.string().describe('Menu project UUID'),
    title: z.string().optional().describe('PDF title (defaults to the H1 from the Menu Book or the project name)'),
    outputPath: z
      .string()
      .optional()
      .describe('Absolute output path for the PDF (default: <CHEF_DOCS_DIR>/<projectId>.pdf)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    pdfPath: z.string().optional(),
    bytes: z.number().optional().describe('Size of the generated PDF in bytes'),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    let htmlPath: string | undefined;
    try {
      const mdPath = bookPath(context.projectId);
      let markdown: string;
      try {
        markdown = await fs.readFile(mdPath, 'utf-8');
      } catch {
        return {
          success: false,
          error: `Menu Book for project ${context.projectId} does not exist — call chef_document_init.`,
        };
      }

      // Title: explicit → first H1 → project name fallback.
      let title = context.title;
      if (!title) {
        const h1 = markdown.match(/^#\s+(.+)$/m);
        title = h1 ? h1[1].trim() : context.projectId;
      }

      const html = bookMarkdownToHtml(markdown, title);

      // Write a sibling temp HTML (same safe directory as the book).
      const safeId = context.projectId.replace(/[^a-zA-Z0-9_-]/g, '');
      htmlPath = path.resolve(CHEF_DOCS_DIR, `.${safeId}.render.html`);
      await fs.writeFile(htmlPath, html, 'utf-8');

      const pdfPath = context.outputPath
        ? path.resolve(context.outputPath)
        : path.resolve(CHEF_DOCS_DIR, `${safeId}.pdf`);

      await chromePrintToPdf(htmlPath, pdfPath);

      const stat = await fs.stat(pdfPath);
      if (stat.size === 0) {
        return { success: false, error: 'Chrome produced an empty PDF (0 bytes).' };
      }
      return { success: true, pdfPath, bytes: stat.size };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      // Best-effort cleanup of the temp HTML.
      if (htmlPath) {
        try {
          await fs.unlink(htmlPath);
        } catch {
          /* ignore */
        }
      }
    }
  },
});

// Re-export helpers for chef_export_menu_book
export { bookPath, replaceSection, CANONICAL_SECTIONS };
