/**
 * design_write_deliverable — the step designAgent was missing.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Every other domain agent owns a tool that PERSISTS its deliverable —
 * `chef_document_write_section`, `hunt_doc_write_section`,
 * `deliberation_write_artifact`, `music_write_lyrics`. designAgent had none, and
 * the consequences were not subtle:
 *
 *  - `run_worker` is text-in/text-out with NO tools, so a design worker's HTML
 *    comes back as a string and dies in the tool result;
 *  - every design tool that emits a file — `design_render_video`,
 *    `design_export_pdf`, `design_export_pptx`, `design_gen_thumbs` — requires an
 *    `htmlPath`/`slidesDir` that ALREADY EXISTS on disk;
 *  - so the pipeline was decapitated at step one, and `pipeline.md`'s rule that
 *    "generated user deliverables must be written into the active project
 *    directory" named an operation the agent could not perform.
 *
 * Live evidence (V2 canary, job_8def3acb): the run produced 2316 chars of real
 * output, had nowhere to put it, and the job committed the 316-char tail —
 * "Now let me verify the design renders correctly:" plus the framework's
 * completion report. The prototype existed only inside the transcript.
 *
 * ONE CALL, TWO DESTINATIONS — DELIBERATELY
 * -----------------------------------------
 * The file and the Artifact Store entry are written by the same call because
 * they serve two different readers and splitting them across two tool calls
 * means the model can do half the job:
 *
 *  - the FILE is what `design_render_video` / `design_export_pdf` consume, so
 *    the returned `path` is the input to the rest of the design pipeline;
 *  - the ARTIFACT is what the orchestrator reads — `findArtifactIds` treats a
 *    document write inside a run as that run's deliverable, which is what stops
 *    an agent's post-delivery narration from being committed as the answer.
 */
import { createTool } from '@mastra/core/tools';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { z } from 'zod';
import { putArtifact } from '../../services/artifact-store.js';
import { resolveWorkspacePath } from './design-tools.js';

/** Where design deliverables live, matching the `design-work/...` tool defaults. */
const DESIGN_WORK_ROOT = 'design-work';

/**
 * A caller-supplied relative path, or an error explaining the refusal.
 *
 * `fileName` carries a subpath (`slides/01-cover.html`) because decks are
 * multi-file by default, and that is exactly what makes traversal reachable —
 * hence an explicit check rather than trusting the join.
 */
function safeRelativePath(fileName: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = fileName.trim().replace(/^\/+/, '');
  if (trimmed.length === 0) return { ok: false, error: 'fileName is empty.' };
  if (isAbsolute(fileName)) {
    return { ok: false, error: `fileName must be relative to the project folder, got "${fileName}".` };
  }
  const normalized = normalize(trimmed);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return { ok: false, error: `fileName must stay inside the project folder, got "${fileName}".` };
  }
  return { ok: true, value: normalized };
}

/** Kebab-case, filesystem-safe, never empty. */
function safeSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'design';
}

export const designWriteDeliverableTool = createTool({
  id: 'design_write_deliverable',
  description:
    'Write a design deliverable (HTML prototype, slide, CSS, JS, SVG, notes) to the project folder AND register it ' +
    'as the run\'s artifact. This is the ONLY way your work leaves the conversation — text you merely print is lost. ' +
    'Returns the absolute `path`, which is what design_render_video / design_export_pdf / design_export_pptx take as ' +
    'their htmlPath / slidesDir input. Call it once per file, and call it BEFORE you describe or verify the result.',
  inputSchema: z.object({
    slug: z.string().min(1).describe('Project folder name in kebab-case, e.g. "gastrobridge-landing". Reuse the same slug for every file of one deliverable.'),
    fileName: z.string().min(1).describe('File name relative to the project folder, e.g. "index.html" or "slides/01-cover.html".'),
    content: z.string().min(1).describe('Full file content. For an HTML prototype this is the complete document, starting at <!DOCTYPE html>.'),
    type: z.enum(['document', 'media_ref']).default('document')
      .describe('Artifact type: "document" for HTML/CSS/notes source, "media_ref" when the file points at rendered media.'),
    title: z.string().optional().describe('Human-readable name of the deliverable.'),
    summary: z.string().max(300).optional().describe('≤300 chars: what this file is. This is what the next reader sees by default.'),
    laneId: z.string().optional().describe('Task Ledger lane, when working inside one.'),
    isPrimary: z.boolean().default(true)
      .describe('True for the file that IS the deliverable (the prototype, the deck index). False for supporting files, so the primary one stays the run result.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string().describe('Absolute path — pass this to the render/export tools.'),
    relativePath: z.string(),
    bytes: z.number(),
    ref: z.object({ id: z.string(), type: z.string(), summary: z.string() }).optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const relCheck = safeRelativePath(input.fileName);
    if (!relCheck.ok) {
      return { success: false, path: '', relativePath: '', bytes: 0, error: relCheck.error };
    }

    const relativePath = join(DESIGN_WORK_ROOT, safeSlug(input.slug), relCheck.value);
    let absolutePath: string;
    try {
      // Same guard the rest of the design toolset uses: never write into the
      // read-only huashu-design source repo.
      absolutePath = resolveWorkspacePath(relativePath);
    } catch (error) {
      return { success: false, path: '', relativePath, bytes: 0, error: (error as Error).message };
    }

    // Belt and braces: the slug is sanitised and the subpath is traversal-checked,
    // but the resolved target is verified to sit under the work root regardless.
    const workRoot = resolve(process.cwd(), DESIGN_WORK_ROOT);
    const escape = relative(workRoot, absolutePath);
    if (escape.startsWith('..') || isAbsolute(escape)) {
      return {
        success: false,
        path: '',
        relativePath,
        bytes: 0,
        error: `Refusing to write outside ${DESIGN_WORK_ROOT}/ (resolved to ${absolutePath}).`,
      };
    }

    try {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, input.content, 'utf8');
    } catch (error) {
      return { success: false, path: '', relativePath, bytes: 0, error: (error as Error).message };
    }

    const bytes = Buffer.byteLength(input.content, 'utf8');

    // Supporting files are written but NOT registered: the orchestrator takes the
    // last artifact a run stored as its deliverable, so registering a stylesheet
    // after the prototype would hand the user the stylesheet.
    if (!input.isPrimary) {
      return { success: true, path: absolutePath, relativePath, bytes };
    }

    try {
      const ref = await putArtifact({
        // Zod's `.default()` fills this at parse time, but the execute signature
        // is still typed as optional — restate the default rather than assert.
        type: input.type ?? 'document',
        content: input.content,
        summary: input.summary,
        title: input.title ?? relativePath,
        laneId: input.laneId,
        producedBy: 'designAgent',
      });
      return { success: true, path: absolutePath, relativePath, bytes, ref };
    } catch (error) {
      // The file landed, which is the part the render/export tools need. Report
      // the store failure instead of pretending the handoff is registered.
      return {
        success: true,
        path: absolutePath,
        relativePath,
        bytes,
        error: `File written, but the Artifact Store rejected it: ${(error as Error).message}`,
      };
    }
  },
});
