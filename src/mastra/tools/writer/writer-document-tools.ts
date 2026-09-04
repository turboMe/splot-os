import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { createHash } from 'node:crypto';
import { WriterService, type WriterSection } from './writer-service';
import { countForbiddenWriterEmDashes } from './anti-slop.js';
import { getWriterBooksDir } from '../../config/workspace-paths.js';

export const WRITER_DOCS_DIR = getWriterBooksDir();

const CANONICAL_SECTIONS = [
  'brief',
  'outline',
  'manuscript',
  'sources',
  'claims',
  'continuity',
  'audits',
  'notes',
] as const;
type SectionAnchor = typeof CANONICAL_SECTIONS[number];

const SECTION_TITLES: Record<'pl' | 'en', Record<SectionAnchor, string>> = {
  pl: {
    brief: 'Brief',
    outline: 'Plan',
    manuscript: 'Manuskrypt',
    sources: 'Zrodla',
    claims: 'Twierdzenia',
    continuity: 'Ciaglosc',
    audits: 'Audyty jakosci',
    notes: 'Notatki robocze',
  },
  en: {
    brief: 'Brief',
    outline: 'Outline',
    manuscript: 'Manuscript',
    sources: 'Sources',
    claims: 'Claims',
    continuity: 'Continuity',
    audits: 'Quality Audits',
    notes: 'Working Notes',
  },
};

const SECTION_PLACEHOLDER = '_(pending)_';
const ANCHOR_PATTERN = /^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;
const documentMutationTails = new Map<string, Promise<void>>();

async function withWriterDocumentMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = documentMutationTails.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  documentMutationTails.set(projectId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (documentMutationTails.get(projectId) === tail) documentMutationTails.delete(projectId);
  }
}

function writerContentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function changedCharacterCount(previous: string | null, current: string): number {
  if (previous === null) return current.length;
  let prefix = 0;
  const shared = Math.min(previous.length, current.length);
  while (prefix < shared && previous[prefix] === current[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix
    && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return (previous.length - prefix - suffix) + (current.length - prefix - suffix);
}

function forbiddenEmDashError(...values: Array<string | undefined>): string | null {
  const count = values.reduce(
    (sum, value) => sum + countForbiddenWriterEmDashes(value ?? ''),
    0,
  );
  return count > 0
    ? `Forbidden U+2014 em dash found ${count} time(s). Replace it with sentence punctuation, a comma, a colon, or parentheses.`
    : null;
}

export interface WriterDocumentInitParams {
  projectId: string;
  title: string;
  deliverableLanguage?: string;
}

export interface WriterDocumentWriteParams {
  projectId: string;
  anchor: string;
  content: string;
  mode?: 'replace' | 'append';
  title?: string;
  /** Internal/testing escape hatch. The registered tool never exposes it. */
  invalidateCurrentSnapshot?: boolean;
}

export interface WriterDocumentSnapshotParams {
  projectId: string;
  title?: string;
  version?: number;
  persistDb?: boolean;
}

function safeProjectId(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid projectId.');
  return safeId;
}

function assertInsideDocsDir(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  if (resolved !== WRITER_DOCS_DIR && !resolved.startsWith(WRITER_DOCS_DIR + path.sep)) {
    throw new Error('Access denied: attempt to escape the Writer documents directory.');
  }
}

export function writerProjectDir(projectId: string): string {
  const dir = path.resolve(WRITER_DOCS_DIR, safeProjectId(projectId));
  assertInsideDocsDir(dir);
  return dir;
}

export function writerManuscriptPath(projectId: string): string {
  const filePath = path.resolve(writerProjectDir(projectId), 'manuscript.md');
  assertInsideDocsDir(filePath);
  return filePath;
}

function writerSnapshotsDir(projectId: string): string {
  const dir = path.resolve(writerProjectDir(projectId), 'snapshots');
  assertInsideDocsDir(dir);
  return dir;
}

function writerExportsDir(projectId: string): string {
  const dir = path.resolve(writerProjectDir(projectId), 'exports');
  assertInsideDocsDir(dir);
  return dir;
}

function startMarker(anchor: string): string {
  return `<!-- section:${anchor} start -->`;
}

function endMarker(anchor: string): string {
  return `<!-- section:${anchor} end -->`;
}

function languageKey(language: string | undefined): 'pl' | 'en' {
  return language === 'en' ? 'en' : 'pl';
}

function titleFor(anchor: string, language: string | undefined): string {
  const lang = languageKey(language);
  if (anchor in SECTION_TITLES[lang]) return SECTION_TITLES[lang][anchor as SectionAnchor];
  if (anchor.startsWith('chapter:')) return `${lang === 'pl' ? 'Rozdzial' : 'Chapter'}: ${anchor.slice('chapter:'.length).replace(/-/g, ' ')}`;
  if (anchor.startsWith('scene:')) return `${lang === 'pl' ? 'Scena' : 'Scene'}: ${anchor.slice('scene:'.length).replace(/-/g, ' ')}`;
  if (anchor.startsWith('section:')) return `${lang === 'pl' ? 'Sekcja' : 'Section'}: ${anchor.slice('section:'.length).replace(/-/g, ' ')}`;
  return anchor.replace(/-/g, ' ');
}

function buildSkeleton(params: WriterDocumentInitParams): string {
  const lang = languageKey(params.deliverableLanguage);
  const lines: string[] = [];
  lines.push(`# ${params.title}`);
  lines.push('');
  lines.push(`<!-- writer-book projectId:${params.projectId} language:${params.deliverableLanguage ?? 'pl'} -->`);
  lines.push(lang === 'pl'
    ? '> Dokument generowany przyrostowo przez writerAgent. Edytuj recznie tylko poza znacznikami sekcji.'
    : '> Document generated incrementally by writerAgent. Edit manually only outside section markers.');
  lines.push('');

  for (const anchor of CANONICAL_SECTIONS) {
    lines.push(`## ${SECTION_TITLES[lang][anchor]}`);
    lines.push(startMarker(anchor));
    lines.push(SECTION_PLACEHOLDER);
    lines.push(endMarker(anchor));
    lines.push('');
  }
  return lines.join('\n');
}

export function getWriterDocumentSectionBody(doc: string, anchor: string): string {
  const start = startMarker(anchor);
  const end = endMarker(anchor);
  const startIdx = doc.indexOf(start);
  const endIdx = doc.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return '';
  const body = doc.slice(startIdx + start.length, endIdx).trim();
  return body === SECTION_PLACEHOLDER ? '' : body;
}

interface MarkdownHeadingBlock {
  level: number;
  title: string;
  content: string;
}

function normalizeHeading(value: string): string {
  return value
    .replace(/[*_`~]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function headingWithoutOrdinal(value: string): string {
  return normalizeHeading(value)
    .replace(/^(?:(?:rozdzial|chapter|czesc|part)\s+)?(?:\d+|[ivxlcdm]+)\s*[.::\-–—]+\s*/i, '')
    .trim();
}

function headingOrder(value: string): number | null {
  const match = normalizeHeading(value).match(
    /^(?:(?:rozdzial|chapter|czesc|part)\s+)?(\d+)\b/i,
  );
  if (!match?.[1]) return null;
  const order = Number(match[1]);
  return Number.isSafeInteger(order) ? order : null;
}

/** Split Markdown into heading-owned blocks, keeping nested subsections with their parent. */
function markdownHeadingBlocks(markdown: string): MarkdownHeadingBlock[] {
  const matches = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)];
  return matches.map((match, index) => {
    const level = match[1]?.length ?? 1;
    const start = (match.index ?? 0) + match[0].length;
    const next = matches.slice(index + 1).find((candidate) => (
      (candidate[1]?.length ?? 1) <= level
    ));
    const end = next?.index ?? markdown.length;
    return {
      level,
      title: match[2]?.trim() ?? '',
      content: `${match[0]}${markdown.slice(start, end)}`.trim(),
    };
  });
}

function fallbackSectionContent(
  section: WriterSection,
  blocks: MarkdownHeadingBlock[],
): string {
  const sectionTitle = normalizeHeading(section.title);
  // A manuscript commonly starts with an H1 carrying the book title. Prefer
  // chapter-level headings so a final chapter named like the book is not mapped
  // to the entire manuscript (captured live with "Przypływ").
  const chapterBlocks = blocks.filter((block) => block.level >= 2);
  const candidates = chapterBlocks.length > 0 ? chapterBlocks : blocks;
  const byTitle = candidates.find((block) => (
    headingWithoutOrdinal(block.title) === sectionTitle
  ));
  if (byTitle) return byTitle.content;

  const byOrder = candidates.find((block) => headingOrder(block.title) === section.order);
  return byOrder?.content ?? '';
}

/**
 * The Markdown document is the actual manuscript. Section rows carry ordering
 * and IDs, but agents may write chapter text only through the document tool.
 * Hydrate those rows before continuity checks so validators inspect the text
 * that will be delivered to the user.
 */
export function hydrateWriterSectionsFromDocument(
  sections: WriterSection[],
  document: string,
): WriterSection[] {
  const manuscript = getWriterDocumentSectionBody(document, 'manuscript') || document;
  const headingBlocks = markdownHeadingBlocks(manuscript);
  return sections.map((section) => {
    const documentContent = getWriterDocumentSectionBody(document, section.anchor)
      || fallbackSectionContent(section, headingBlocks);
    return {
      ...section,
      content: documentContent || section.content,
    };
  });
}

export function replaceWriterSection(doc: string, anchor: string, content: string, language?: string, title?: string): string {
  const start = startMarker(anchor);
  const end = endMarker(anchor);
  const startIdx = doc.indexOf(start);
  const endIdx = doc.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return `${doc.trimEnd()}\n\n## ${title ?? titleFor(anchor, language)}\n${start}\n${content.trim()}\n${end}\n`;
  }
  const before = doc.slice(0, startIdx + start.length);
  const after = doc.slice(endIdx);
  return `${before}\n${content.trim()}\n${after}`;
}

function documentLanguage(doc: string): string {
  const match = doc.match(/<!--\s*writer-book\s+[^>]*language:([a-zA-Z-]+)[^>]*-->/);
  return match?.[1] ?? 'pl';
}

function markdownToHtml(markdown: string, title: string): string {
  const cleaned = markdown.replace(/<!--\s*section:[a-z0-9:-]+\s+(start|end)\s*-->/gi, '');
  const body = micromark(cleaned, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.62; color: #1f2933; max-width: 860px; margin: 48px auto; padding: 0 24px; }
  h1 { font-size: 2rem; line-height: 1.2; margin-bottom: 1rem; }
  h2 { font-size: 1.35rem; margin-top: 2rem; border-bottom: 1px solid #d5d9df; padding-bottom: 0.25rem; }
  h3 { font-size: 1.1rem; margin-top: 1.5rem; }
  blockquote { border-left: 3px solid #b8c0cc; margin-left: 0; padding-left: 1rem; color: #52606d; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #d5d9df; padding: 0.4rem 0.55rem; text-align: left; vertical-align: top; }
  code { background: #f3f4f6; padding: 0.1rem 0.25rem; border-radius: 4px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function writerDocumentInitUnlocked(params: WriterDocumentInitParams): Promise<{
  success: boolean;
  path?: string;
  created?: boolean;
  sections?: string[];
  error?: string;
}> {
  try {
    const punctuationError = forbiddenEmDashError(params.title);
    if (punctuationError) return { success: false, error: punctuationError };
    await fs.mkdir(writerProjectDir(params.projectId), { recursive: true });
    const filePath = writerManuscriptPath(params.projectId);
    try {
      await fs.access(filePath);
      return { success: true, path: filePath, created: false, sections: [...CANONICAL_SECTIONS] };
    } catch {
      // Create the document below.
    }
    await fs.writeFile(filePath, buildSkeleton(params), 'utf-8');
    return { success: true, path: filePath, created: true, sections: [...CANONICAL_SECTIONS] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function writerDocumentInit(params: WriterDocumentInitParams) {
  return withWriterDocumentMutation(params.projectId, () => writerDocumentInitUnlocked(params));
}

async function writerDocumentWriteSectionUnlocked(params: WriterDocumentWriteParams): Promise<{
  success: boolean;
  path?: string;
  anchor?: string;
  mode?: string;
  changed?: boolean;
  contentHash?: string;
  error?: string;
}> {
  try {
    if (!ANCHOR_PATTERN.test(params.anchor)) {
      return { success: false, error: 'Invalid section anchor.' };
    }
    const punctuationError = forbiddenEmDashError(params.content, params.title);
    if (punctuationError) return { success: false, error: punctuationError };
    const filePath = writerManuscriptPath(params.projectId);
    const doc = await fs.readFile(filePath, 'utf-8');
    const mode = params.mode ?? 'replace';
    const existing = mode === 'append' ? getWriterDocumentSectionBody(doc, params.anchor) : '';
    const nextContent = existing ? `${existing}\n\n${params.content.trim()}` : params.content;
    const updated = replaceWriterSection(doc, params.anchor, nextContent, documentLanguage(doc), params.title);
    const changed = updated !== doc;
    if (changed) {
      // Invalidate the reviewed snapshot BEFORE mutating the deliverable. If
      // Mongo is unavailable, fail closed and keep the reviewed file intact.
      if (params.invalidateCurrentSnapshot !== false) {
        const writer = new WriterService();
        await writer.invalidateCurrentManuscript(params.projectId);
      }
      await fs.writeFile(filePath, updated, 'utf-8');
    }
    return {
      success: true,
      path: filePath,
      anchor: params.anchor,
      mode,
      changed,
      contentHash: writerContentHash(updated),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function writerDocumentWriteSection(params: WriterDocumentWriteParams) {
  return withWriterDocumentMutation(params.projectId, () => writerDocumentWriteSectionUnlocked(params));
}

export async function writerDocumentRead(projectId: string): Promise<{
  success: boolean;
  path?: string;
  content?: string;
  error?: string;
}> {
  try {
    const filePath = writerManuscriptPath(projectId);
    const content = await fs.readFile(filePath, 'utf-8');
    return { success: true, path: filePath, content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function writerDocumentSnapshotUnlocked(params: WriterDocumentSnapshotParams): Promise<{
  success: boolean;
  path?: string;
  version?: number;
  manuscriptId?: string;
  contentHash?: string;
  contentLength?: number;
  changedSincePrevious?: boolean;
  changedCharacters?: number;
  error?: string;
}> {
  try {
    const filePath = writerManuscriptPath(params.projectId);
    const content = await fs.readFile(filePath, 'utf-8');
    const punctuationError = forbiddenEmDashError(content, params.title);
    if (punctuationError) return { success: false, error: punctuationError };
    const contentHash = writerContentHash(content);
    const writer = new WriterService();
    const previous = params.persistDb === false
      ? null
      : await writer.getCurrentManuscript(params.projectId);
    const previousContent = typeof previous?.content === 'string' ? previous.content : null;
    const changedSincePrevious = previousContent !== content;
    const changedCharacters = changedCharacterCount(previousContent, content);
    if (params.persistDb !== false && previous && !changedSincePrevious) {
      return {
        success: true,
        path: previous.path ?? filePath,
        version: previous.version,
        manuscriptId: previous.id,
        contentHash,
        contentLength: content.length,
        changedSincePrevious: false,
        changedCharacters: 0,
      };
    }
    let version: number;
    let manuscriptId: string | undefined;
    if (params.persistDb !== false) {
      // Allocate the version inside the Mongo snapshot transaction before
      // deriving the archive path. Multi-instance writers therefore cannot
      // race on the same vNNNN.md filename.
      const manuscript = await writer.saveManuscriptSnapshot({
        projectId: params.projectId,
        title: params.title ?? params.projectId,
        format: 'markdown',
        content,
        version: params.version,
        isCurrent: true,
      });
      version = manuscript.version;
      manuscriptId = manuscript.id;
    } else {
      version = params.version ?? 1;
    }
    const snapshotDir = writerSnapshotsDir(params.projectId);
    await fs.mkdir(snapshotDir, { recursive: true });
    const snapshotPath = path.resolve(snapshotDir, `v${String(version).padStart(4, '0')}.md`);
    assertInsideDocsDir(snapshotPath);
    await fs.writeFile(snapshotPath, content, 'utf-8');

    if (manuscriptId) await writer.setManuscriptPath(params.projectId, manuscriptId, snapshotPath);
    return {
      success: true,
      path: snapshotPath,
      version,
      manuscriptId,
      contentHash,
      contentLength: content.length,
      changedSincePrevious,
      changedCharacters,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function writerDocumentSnapshot(params: WriterDocumentSnapshotParams) {
  return withWriterDocumentMutation(params.projectId, () => writerDocumentSnapshotUnlocked(params));
}

/**
 * Selects a persisted snapshot as the actual manuscript. Revision decisions use
 * this instead of merely advising the model which version to keep.
 */
async function writerDocumentActivateSnapshotUnlocked(params: {
  projectId: string;
  manuscriptId: string;
}): Promise<{
  success: boolean;
  manuscriptId?: string;
  path?: string;
  contentHash?: string;
  error?: string;
}> {
  const writer = new WriterService();
  const filePath = writerManuscriptPath(params.projectId);
  let previousContent: string | undefined;
  try {
    const manuscript = await writer.getManuscript(params.manuscriptId);
    if (!manuscript || manuscript.projectId !== params.projectId) {
      return { success: false, error: 'Snapshot does not belong to this Writer project.' };
    }
    if (typeof manuscript.content !== 'string' || manuscript.content.length === 0) {
      return { success: false, error: 'Snapshot has no persisted manuscript content.' };
    }
    const punctuationError = forbiddenEmDashError(manuscript.content, manuscript.title);
    if (punctuationError) {
      return { success: false, error: `Cannot activate snapshot: ${punctuationError}` };
    }

    previousContent = await fs.readFile(filePath, 'utf-8').catch(() => undefined);
    await fs.writeFile(filePath, manuscript.content, 'utf-8');
    try {
      await writer.markCurrentManuscript(params.projectId, params.manuscriptId);
    } catch (error) {
      if (previousContent !== undefined) {
        await fs.writeFile(filePath, previousContent, 'utf-8').catch(() => undefined);
      }
      throw error;
    }
    return {
      success: true,
      manuscriptId: manuscript.id,
      path: filePath,
      contentHash: writerContentHash(manuscript.content),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function writerDocumentActivateSnapshot(params: {
  projectId: string;
  manuscriptId: string;
}) {
  return withWriterDocumentMutation(params.projectId, () => writerDocumentActivateSnapshotUnlocked(params));
}

/**
 * Mirrors an already-selected transactional snapshot into manuscript.md.
 * Unlike writerDocumentActivateSnapshot this never writes DB authority again;
 * a filesystem failure therefore leaves the project at `revision`, where the
 * file-vs-current completion check fails closed.
 */
async function writerDocumentSyncSelectedSnapshotUnlocked(params: {
  projectId: string;
  manuscriptId: string;
}): Promise<{
  success: boolean;
  manuscriptId?: string;
  path?: string;
  contentHash?: string;
  error?: string;
}> {
  try {
    const writer = new WriterService();
    const [project, manuscript] = await Promise.all([
      writer.getProject(params.projectId),
      writer.getManuscript(params.manuscriptId),
    ]);
    if (
      !project
      || project.currentManuscriptId !== params.manuscriptId
      || !manuscript
      || manuscript.projectId !== params.projectId
      || !manuscript.isCurrent
    ) {
      return { success: false, error: 'Snapshot is no longer the selected current Writer manuscript.' };
    }
    if (typeof manuscript.content !== 'string' || manuscript.content.length === 0) {
      return { success: false, error: 'Selected snapshot has no persisted manuscript content.' };
    }
    const punctuationError = forbiddenEmDashError(manuscript.content, manuscript.title);
    if (punctuationError) return { success: false, error: `Cannot sync snapshot: ${punctuationError}` };
    const filePath = writerManuscriptPath(params.projectId);
    await fs.writeFile(filePath, manuscript.content, 'utf-8');
    return {
      success: true,
      manuscriptId: manuscript.id,
      path: filePath,
      contentHash: writerContentHash(manuscript.content),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function writerDocumentSyncSelectedSnapshot(params: {
  projectId: string;
  manuscriptId: string;
}) {
  return withWriterDocumentMutation(
    params.projectId,
    () => writerDocumentSyncSelectedSnapshotUnlocked(params),
  );
}

export async function writerDocumentExport(params: {
  projectId: string;
  format: 'markdown' | 'html';
  title?: string;
}): Promise<{
  success: boolean;
  path?: string;
  format?: string;
  error?: string;
}> {
  try {
    const filePath = writerManuscriptPath(params.projectId);
    const markdown = await fs.readFile(filePath, 'utf-8');
    const punctuationError = forbiddenEmDashError(markdown, params.title);
    if (punctuationError) return { success: false, error: `Cannot export: ${punctuationError}` };
    const exportsDir = writerExportsDir(params.projectId);
    await fs.mkdir(exportsDir, { recursive: true });

    if (params.format === 'markdown') {
      const outputPath = path.resolve(exportsDir, 'final.md');
      assertInsideDocsDir(outputPath);
      await fs.writeFile(outputPath, markdown, 'utf-8');
      return { success: true, path: outputPath, format: 'markdown' };
    }

    const h1 = markdown.match(/^#\s+(.+)$/m);
    const title = params.title ?? h1?.[1]?.trim() ?? params.projectId;
    const html = markdownToHtml(markdown, title);
    const outputPath = path.resolve(exportsDir, 'final.html');
    assertInsideDocsDir(outputPath);
    await fs.writeFile(outputPath, html, 'utf-8');
    return { success: true, path: outputPath, format: 'html' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export const writerDocumentInitTool = createTool({
  id: 'writer_document_init',
  description:
    'Creates the writer project manuscript file with anchored sections. Idempotent; does not overwrite an existing manuscript.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID'),
    title: z.string().describe('Document title'),
    deliverableLanguage: z.string().optional().default('pl').describe('Language of the final deliverable; defaults to pl.'),
  }),
  execute: async (context) => writerDocumentInit(context),
});

export const writerDocumentWriteSectionTool = createTool({
  id: 'writer_document_write_section',
  description:
    'Writes or updates one anchored manuscript section. Use repeatedly while drafting chapters, scenes, article sections, sources, claims, continuity notes, and audits.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID'),
    anchor: z
      .string()
      .regex(ANCHOR_PATTERN, 'Anchor must be lowercase letters/digits/hyphens, optionally with a type prefix like chapter:.')
      .describe('Section anchor, e.g. outline, manuscript, chapter:01, scene:opening, section:methods.'),
    content: z.string().describe('Markdown content to write.'),
    mode: z.enum(['replace', 'append']).optional().default('replace'),
    title: z.string().optional().describe('Optional heading for dynamic sections.'),
  }),
  execute: async (context) => writerDocumentWriteSection(context),
});

export const writerDocumentReadTool = createTool({
  id: 'writer_document_read',
  description: 'Reads the current writer manuscript markdown file.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID'),
  }),
  execute: async (context) => writerDocumentRead(context.projectId),
});

export const writerDocumentSnapshotTool = createTool({
  id: 'writer_document_snapshot',
  description:
    'Saves the current manuscript as a versioned snapshot and records it in writer_manuscripts. Use before/after major audit and revision passes.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID'),
    title: z.string().optional().describe('Snapshot title'),
    version: z.number().int().min(1).optional().describe('Explicit version; omit to auto-increment from DB.'),
  }),
  execute: async (context) => writerDocumentSnapshot(context),
});

export const writerDocumentExportTool = createTool({
  id: 'writer_document_export',
  description: 'Exports the current manuscript to exports/final.md or exports/final.html.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID'),
    format: z.enum(['markdown', 'html']).default('markdown'),
    title: z.string().optional().describe('HTML title override.'),
  }),
  execute: async (context) => writerDocumentExport({ ...context, format: context.format ?? 'markdown' }),
});

export { CANONICAL_SECTIONS as WRITER_CANONICAL_DOCUMENT_SECTIONS };
