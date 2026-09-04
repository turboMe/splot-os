/**
 * WorkspaceService — warstwa danych dla Dashboardu Operacyjnego GastroBridge.
 *
 * Scala 3 źródła w spójny kontrakt dla frontu:
 *  - agentforge.leads        → CRM (znormalizowane, mapper bez ruszania danych źródłowych)
 *  - rss_intelligence.*      → Idea Inbox (content_signals) + feed (rss_articles)
 *  - FS .drafts (DraftsStore) → drafty (email + social) — przez draft-registry.ts
 *
 * Zasada: surowe dane zostają nietknięte. Mapper produkuje kształt dla UI.
 * Plan: ideas/dashboard-operacyjny-plan.md
 */
import path from 'node:path';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { Db } from 'mongodb';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { getDb, getRssDb } from '../lib/mongo.js';
import {
  CRM_STATUSES,
  DEFAULT_CRM_STATUS,
  type CrmStatus,
} from '../config/crm-statuses.js';
import {
  getMenuBooksDir,
  getContentPacksDir,
  getDesignOutputDir,
  getWriterBooksDir,
} from '../config/workspace-paths.js';
import {
  WriterService,
  type WriterAudit,
  type WriterClaim,
  type WriterProject,
  type WriterProjectStatus,
  type WriterProjectType,
} from '../tools/writer/writer-service.js';
import {
  WRITER_DOCS_DIR,
  writerManuscriptPath,
  writerProjectDir,
} from '../tools/writer/writer-document-tools.js';
import {
  FilmService,
  type FilmPipelineStatus,
  type FilmProjectRecord,
} from '../tools/film/film-service.js';
import type { FilmGenerationRun } from '../lib/film-schemas.js';
import {
  MusicService,
  type MusicPipelineStatus,
  type MusicProjectRecord,
} from '../tools/music/music-service.js';
import type { MusicGenerationRun } from '../lib/music-schemas.js';

// ── Typy znormalizowane ──────────────────────────────────────────────────────

export type LeadSegment =
  | 'supplier_gb'
  | 'restaurant_gb'
  | 'automation'
  | 'web_dev'
  | 'gastro_consulting'
  | 'career_it_pl'
  | 'career_it_is'
  | 'career_chef_pl'
  | 'career_chef_is'
  | 'gastro-producer'
  | 'automation-prospect'
  | 'other';

/**
 * Kolumny Kanban — z config/crm-statuses.ts, nie z lokalnej kopii.
 *
 * Ta lista i enum narzędzi CRM były dwiema różnymi listami, więc lead ze
 * statusem spoza tej jednej nie miał kolumny i znikał z tablicy.
 */
export const LEAD_STATUSES = CRM_STATUSES;
export type LeadStatus = CrmStatus;

export interface WorkspaceLead {
  id: string;
  companyName: string;
  segment: LeadSegment;
  status: string;
  source: string | null;
  region: string | null;
  contact: {
    email?: string | null;
    phone?: string | null;
    name?: string | null;
    linkedIn?: string | null;
    website?: string | null;
  };
  details: {
    olx?: {
      url?: string;
      title?: string;
      price?: string;
      city?: string;
      categoryId?: number;
      isBusiness?: boolean;
      description?: string;
    };
    automation?: {
      qualityScore?: number;
      useCaseIdea?: string;
      estimatedHoursSaved?: number;
      sourceUrl?: string;
    };
  };
  draft: {
    gmailDraftId?: string | null;
    subject?: string | null;
    body?: string | null;
  } | null;
  history: Array<{
    timestamp?: string;
    action?: string;
    description?: string;
    agentId?: string;
  }>;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  lastInteractionAt: string | null;
}

// ── Helpery ──────────────────────────────────────────────────────────────────

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function countWordsWs(text: string | undefined): number {
  return (text?.match(/[\p{L}\p{N}'-]+/gu) ?? []).length;
}

function detectSegment(doc: Record<string, any>): LeadSegment {
  const seg = String(doc.segment ?? '').toLowerCase().trim();
  if (seg === 'supplier_gb' || seg === 'supplier' || seg === 'producer' || seg === 'gastro-producer' || seg === 'gastro' || doc.supplierType) {
    return 'supplier_gb';
  }
  if (seg === 'restaurant_gb' || seg === 'restaurant' || seg === 'horeca_restaurant') {
    return 'restaurant_gb';
  }
  if (seg === 'automation' || seg === 'automation-prospect' || String(doc.source ?? '').toLowerCase().includes('automation')) {
    return 'automation';
  }
  if (seg === 'web_dev' || seg === 'web-dev' || seg === 'web') {
    return 'web_dev';
  }
  if (seg === 'gastro_consulting' || seg === 'consulting') {
    return 'gastro_consulting';
  }
  if (seg === 'career_it_pl') return 'career_it_pl';
  if (seg === 'career_it_is') return 'career_it_is';
  if (seg === 'career_chef_pl') return 'career_chef_pl';
  if (seg === 'career_chef_is') return 'career_chef_is';

  const md = doc.metadata ?? {};
  if (md.olx_url || md.olx_title || String(doc.source ?? '').toLowerCase().includes('olx')) {
    return 'supplier_gb';
  }
  return 'other';
}

/** Mapper: surowy lead → kształt dla UI. Nie modyfikuje źródła. */
export function normalizeLead(doc: Record<string, any>): WorkspaceLead {
  const md = (doc.metadata ?? {}) as Record<string, any>;
  const segment = detectSegment(doc);

  const details: WorkspaceLead['details'] = {};
  if (md.olx_url || md.olx_title) {
    details.olx = {
      url: str(md.olx_url) ?? undefined,
      title: str(md.olx_title) ?? undefined,
      price: str(md.olx_price) ?? undefined,
      city: str(md.olx_city) ?? undefined,
      categoryId: typeof md.olx_category_id === 'number' ? md.olx_category_id : undefined,
      isBusiness: typeof md.is_business === 'boolean' ? md.is_business : undefined,
      description: str(md.olx_description) ?? undefined,
    };
  }
  if (md.quality_score != null || md.use_case_idea || md.estimated_hours_saved != null) {
    details.automation = {
      qualityScore: typeof md.quality_score === 'number' ? md.quality_score : undefined,
      useCaseIdea: str(md.use_case_idea) ?? undefined,
      estimatedHoursSaved:
        typeof md.estimated_hours_saved === 'number' ? md.estimated_hours_saved : undefined,
      sourceUrl: str(md.source_url) ?? undefined,
    };
  }

  const draftMeta = md.draft ?? null;
  const draft =
    draftMeta || md.gmailDraftId
      ? {
          gmailDraftId: str(draftMeta?.gmailDraftId) ?? str(md.gmailDraftId),
          subject: str(draftMeta?.subject),
          body: str(draftMeta?.body),
        }
      : null;

  const history = Array.isArray(doc.history)
    ? doc.history.map((h: any) => ({
        timestamp: toIso(h?.timestamp) ?? undefined,
        action: str(h?.action) ?? undefined,
        description: str(h?.description) ?? undefined,
        agentId: str(h?.agentId) ?? undefined,
      }))
    : [];

  return {
    id: String(doc.id ?? doc._id ?? ''),
    companyName: str(doc.companyName) ?? '(bez nazwy)',
    segment,
    status: str(doc.status) ?? DEFAULT_CRM_STATUS,
    source: str(doc.source),
    region: str(doc.region),
    contact: {
      email: str(doc.email),
      phone: str(doc.phone),
      name: str(doc.contactName),
      linkedIn: str(doc.linkedIn),
      website: str(doc.website),
    },
    details,
    draft,
    history,
    tags: Array.isArray(doc.tags) ? doc.tags.filter((t: any) => typeof t === 'string') : [],
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
    lastInteractionAt: toIso(doc.lastInteractionAt),
  };
}

// ── CRM: zapytania ───────────────────────────────────────────────────────────

export interface ListLeadsOptions {
  status?: string;
  segment?: string;
  source?: string;
  region?: string;
  q?: string;
  limit?: number;
  skip?: number;
}

export async function listLeads(opts: ListLeadsOptions = {}): Promise<{
  data: WorkspaceLead[];
  total: number;
}> {
  const db = await getDb();
  const filter: Record<string, any> = {};
  if (opts.status) filter.status = opts.status;
  if (opts.source) filter.source = opts.source;
  if (opts.region) filter.region = opts.region;
  if (opts.q) {
    filter.$or = [
      { companyName: { $regex: opts.q, $options: 'i' } },
      { email: { $regex: opts.q, $options: 'i' } },
      { 'metadata.olx_title': { $regex: opts.q, $options: 'i' } },
    ];
  }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const skip = Math.max(opts.skip ?? 0, 0);

  const cursor = db
    .collection('leads')
    .find(filter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const [docs, total] = await Promise.all([
    cursor.toArray(),
    db.collection('leads').countDocuments(filter),
  ]);

  let data = docs.map((d) => normalizeLead(d as Record<string, any>));
  // Segment filtr stosujemy po normalizacji (segment bywa wyliczany).
  if (opts.segment) data = data.filter((l) => l.segment === opts.segment);

  return { data, total };
}

export async function getLead(id: string): Promise<WorkspaceLead | null> {
  const db = await getDb();
  const doc = await db.collection('leads').findOne({ id });
  return doc ? normalizeLead(doc as Record<string, any>) : null;
}

/** Zmiana statusu i/lub tagów. Każda zmiana dopisuje wpis do history[]. */
export async function updateLead(
  id: string,
  patch: { status?: string; tags?: string[]; note?: string },
): Promise<WorkspaceLead | null> {
  const db = await getDb();
  const now = new Date();
  const set: Record<string, any> = { updatedAt: now, lastInteractionAt: now };
  const historyEntries: any[] = [];

  if (patch.status) {
    set.status = patch.status;
    historyEntries.push({
      timestamp: now,
      action: 'status_changed',
      description: `Status → ${patch.status}`,
      agentId: 'dashboard',
    });
  }
  if (Array.isArray(patch.tags)) {
    set.tags = patch.tags;
    historyEntries.push({
      timestamp: now,
      action: 'tags_updated',
      description: `Tagi: ${patch.tags.join(', ') || '(brak)'}`,
      agentId: 'dashboard',
    });
  }
  if (patch.note && patch.note.trim()) {
    historyEntries.push({
      timestamp: now,
      action: 'note',
      description: patch.note.trim(),
      agentId: 'dashboard',
    });
  }

  const update: Record<string, any> = { $set: set };
  if (historyEntries.length) update.$push = { history: { $each: historyEntries } };

  const res = await db
    .collection('leads')
    .findOneAndUpdate({ id }, update, { returnDocument: 'after' });
  const doc = (res as any)?.value ?? res;
  return doc ? normalizeLead(doc as Record<string, any>) : null;
}

export interface LeadStats {
  total: number;
  byStatus: Record<string, number>;
  bySegment: Record<string, number>;
  byRegion: Record<string, number>;
  bySource: Record<string, number>;
}

export async function getLeadStats(): Promise<LeadStats> {
  const db = await getDb();
  const docs = await db
    .collection('leads')
    .find({}, { projection: { status: 1, segment: 1, region: 1, source: 1, metadata: 1 } })
    .toArray();

  const stats: LeadStats = {
    total: docs.length,
    byStatus: {},
    bySegment: {},
    byRegion: {},
    bySource: {},
  };
  for (const d of docs) {
    const status = (d as any).status ?? '(brak)';
    const segment = detectSegment(d as Record<string, any>);
    const region = (d as any).region ?? '(brak)';
    const source = (d as any).source ?? '(brak)';
    stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
    stats.bySegment[segment] = (stats.bySegment[segment] ?? 0) + 1;
    stats.byRegion[region] = (stats.byRegion[region] ?? 0) + 1;
    stats.bySource[source] = (stats.bySource[source] ?? 0) + 1;
  }
  return stats;
}

// ── Content: Idea Inbox (sygnały) + feed ────────────────────────────────────

export interface ListSignalsOptions {
  used?: boolean;
  category?: string;
  language?: string;
  q?: string;
  limit?: number;
}

export async function listContentSignals(opts: ListSignalsOptions = {}): Promise<any[]> {
  const db = await getRssDb();
  const filter: Record<string, any> = {};
  if (opts.category) filter.category = opts.category;
  if (opts.language) filter.language = opts.language;
  if (opts.used === false) {
    filter.$or = [{ usedInTasks: { $exists: false } }, { usedInTasks: { $size: 0 } }];
  } else if (opts.used === true) {
    filter['usedInTasks.0'] = { $exists: true };
  }
  if (opts.q) {
    filter.title = { $regex: opts.q, $options: 'i' };
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const docs = await db
    .collection('content_signals')
    .find(filter, { projection: { _id: 0 } })
    .sort({ 'scores.relevance': -1, publishedAt: -1 })
    .limit(limit)
    .toArray();

  return docs.map((d: any) => ({
    signalId: d.signalId,
    title: d.title,
    summary: d.summary,
    whyItMatters: d.whyItMatters,
    contentAngles: d.contentAngles ?? [],
    hooks: d.hooks ?? [],
    scores: d.scores ?? {},
    tags: d.tags ?? [],
    category: d.category,
    source: d.sourceName ?? d.source,
    url: d.canonicalUrl ?? d.url,
    language: d.language,
    publishedAt: toIso(d.publishedAt),
    used: Array.isArray(d.usedInTasks) && d.usedInTasks.length > 0,
  }));
}

export async function getContentSignal(id: string): Promise<any | null> {
  const db = await getRssDb();
  const d = await db.collection('content_signals').findOne({ signalId: id }, { projection: { _id: 0 } });
  return d ?? null;
}

export interface ListArticlesOptions {
  category?: string;
  source?: string;
  q?: string;
  limit?: number;
  skip?: number;
}

export async function listArticles(opts: ListArticlesOptions = {}): Promise<{ data: any[]; total: number }> {
  const db = await getRssDb();
  const filter: Record<string, any> = {};
  if (opts.category) filter.category = opts.category;
  if (opts.source) filter.source = opts.source;
  if (opts.q) filter.title = { $regex: opts.q, $options: 'i' };

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const skip = Math.max(opts.skip ?? 0, 0);
  const coll = db.collection('rss_articles');
  const [docs, total] = await Promise.all([
    coll
      .find(filter, { projection: { _id: 0, guid: 1, title: 1, description: 1, link: 1, source: 1, category: 1, pubDate: 1, tags_ai: 1, relevance_score: 1 } })
      .sort({ pubDate: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    coll.countDocuments(filter),
  ]);
  return { data: docs, total };
}

// ── Chef (read-only) ────────────────────────────────────────────────────────

export async function listChefProjects(): Promise<any[]> {
  const db = await getDb();
  return db
    .collection('chef_projects')
    .find({}, { projection: { _id: 0 } })
    .sort({ updatedAt: -1 })
    .toArray();
}

export async function listChefMenus(projectId: string): Promise<any[]> {
  const db = await getDb();
  return db
    .collection('chef_menus')
    .find({ projectId }, { projection: { _id: 0 } })
    .sort({ version: -1 })
    .toArray();
}

// Menu Books live on disk as Markdown (+ rendered PDF) at CHEF_DOCS_DIR/<projectId>.{md,pdf}.
const CHEF_DOCS_DIR = getMenuBooksDir();

/** Path-traversal-guarded absolute path inside CHEF_DOCS_DIR for a given extension. */
function chefDocPath(projectId: string, ext: 'md' | 'pdf'): string | null {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  const filePath = path.resolve(CHEF_DOCS_DIR, `${safeId}.${ext}`);
  if (!filePath.startsWith(CHEF_DOCS_DIR + path.sep)) return null;
  return filePath;
}

/** Reads the on-disk Menu Book (Markdown) for a project. */
export async function getChefBook(
  projectId: string,
): Promise<{ projectId: string; path: string; content: string } | null> {
  const filePath = chefDocPath(projectId, 'md');
  if (!filePath) return null;
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return { projectId: projectId.replace(/[^a-zA-Z0-9_-]/g, ''), path: filePath, content };
  } catch {
    return null;
  }
}

/** Absolute path to a project's rendered PDF if it exists on disk, else null. */
export async function getChefPdfPath(projectId: string): Promise<string | null> {
  const filePath = chefDocPath(projectId, 'pdf');
  if (!filePath) return null;
  try {
    await fsp.stat(filePath);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Lists chef projects that have an on-disk Menu Book, enriched with deliverable
 * flags (hasBook / hasPdf + pdf size & mtime) for the workspace-ui "Księgi Menu" tab.
 */
export async function listChefBooks(): Promise<any[]> {
  const projects = await listChefProjects();
  const out: any[] = [];
  for (const p of projects) {
    const id = p.id || p.projectId;
    if (!id) continue;
    const mdPath = chefDocPath(id, 'md');
    const pdfPath = chefDocPath(id, 'pdf');
    let hasBook = false;
    let mdUpdatedAt: string | undefined;
    let hasPdf = false;
    let pdfBytes = 0;
    let pdfUpdatedAt: string | undefined;
    if (mdPath) {
      try {
        const st = await fsp.stat(mdPath);
        hasBook = true;
        mdUpdatedAt = st.mtime.toISOString();
      } catch { /* no book on disk */ }
    }
    if (pdfPath) {
      try {
        const st = await fsp.stat(pdfPath);
        hasPdf = true;
        pdfBytes = st.size;
        pdfUpdatedAt = st.mtime.toISOString();
      } catch { /* no pdf yet */ }
    }
    if (!hasBook && !hasPdf) continue;
    out.push({
      id,
      name: p.name,
      status: p.status,
      profile: p.profile,
      updatedAt: p.updatedAt,
      hasBook,
      hasPdf,
      pdfBytes,
      mdUpdatedAt,
      pdfUpdatedAt,
    });
  }
  return out;
}

export async function deleteChefProject(
  projectId: string,
  opts: { deleteFiles?: boolean } = { deleteFiles: true },
): Promise<{ deletedProject: boolean; deletedFiles: number }> {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return { deletedProject: false, deletedFiles: 0 };
  const db = await getDb();
  let deletedFiles = 0;

  if (opts.deleteFiles !== false) {
    const menuDir = getMenuBooksDir();
    const files = [
      path.join(menuDir, `${safeId}.md`),
      path.join(menuDir, `${safeId}.pdf`),
    ];
    for (const f of files) {
      try {
        await fsp.unlink(f);
        deletedFiles++;
      } catch {
        // ignore
      }
    }
    const subDir = path.join(menuDir, safeId);
    try {
      if (await fsp.stat(subDir).then(() => true, () => false)) {
        await fsp.rm(subDir, { recursive: true, force: true });
        deletedFiles++;
      }
    } catch {
      // ignore
    }
  }

  const projRes = await db.collection('chef_projects').deleteOne({
    $or: [{ id: safeId }, { projectId: safeId }, { id: projectId }],
  });
  await db.collection('chef_menus').deleteMany({
    $or: [{ projectId: safeId }, { projectId }],
  }).catch(() => undefined);
  await db.collection('approvals').deleteMany({
    $or: [{ 'args.projectId': safeId }, { 'args.projectId': projectId }],
  }).catch(() => undefined);

  return {
    deletedProject: Boolean(projRes.deletedCount) || deletedFiles > 0,
    deletedFiles,
  };
}

// ── Content Agent (read-only) ────────────────────────────────────────────────
// Mirrors the chef read path: content_projects (Mongo, pipeline state) + the
// Content Pack (on-disk Markdown working doc at CONTENT_DOCS_DIR/<projectId>.md).

const CONTENT_DOCS_DIR = getContentPacksDir();

export async function listContentProjects(): Promise<any[]> {
  const db = await getDb();
  return db
    .collection('content_projects')
    .find({}, { projection: { _id: 0 } })
    .sort({ updatedAt: -1 })
    .toArray();
}

/** Reads the on-disk Content Pack (Markdown) for a project. Path-traversal guarded. */
export async function getContentPack(
  projectId: string,
): Promise<{ projectId: string; path: string; content: string } | null> {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  const filePath = path.resolve(CONTENT_DOCS_DIR, `${safeId}.md`);
  if (!filePath.startsWith(CONTENT_DOCS_DIR + path.sep)) return null;
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return { projectId: safeId, path: filePath, content };
  } catch {
    return null;
  }
}

export async function deleteContentProject(
  projectId: string,
  opts: { deleteFiles?: boolean } = { deleteFiles: true },
): Promise<{ deletedProject: boolean; deletedFiles: number }> {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return { deletedProject: false, deletedFiles: 0 };
  const db = await getDb();
  let deletedFiles = 0;

  if (opts.deleteFiles !== false) {
    const contentDir = getContentPacksDir();
    const mdFile = path.join(contentDir, `${safeId}.md`);
    try {
      await fsp.unlink(mdFile);
      deletedFiles++;
    } catch {
      // ignore
    }
    const subDir = path.join(contentDir, safeId);
    try {
      if (await fsp.stat(subDir).then(() => true, () => false)) {
        await fsp.rm(subDir, { recursive: true, force: true });
        deletedFiles++;
      }
    } catch {
      // ignore
    }
  }

  const projRes = await db.collection('content_projects').deleteOne({
    $or: [{ id: safeId }, { projectId: safeId }, { id: projectId }],
  });

  return {
    deletedProject: Boolean(projRes.deletedCount) || deletedFiles > 0,
    deletedFiles,
  };
}

// ── Writer Agent (read-only) ────────────────────────────────────────────────
// Mirrors the chef/content workspace pattern: WriterService owns project truth,
// this service only aggregates Mongo state + the on-disk manuscript for UI.

export interface WriterWorkspaceProjectListOptions {
  status?: WriterProjectStatus;
  type?: WriterProjectType;
  limit?: number;
}

export interface WriterDocumentPreview {
  projectId: string;
  path: string;
  projectDir: string;
  content: string;
  preview: string;
  wordCount: number;
  bytes: number;
  updatedAt: string;
}

export interface WriterAuditSummary {
  total: number;
  latest?: WriterAudit;
  latestSlopScore?: number;
  latestContinuityOk?: boolean;
  latestClaimOk?: boolean;
  latestCriticVerdict?: string;
  latestRevisionDecision?: string;
  blockingCount: number;
}

/** Absolute path to a project's rendered PDF if it exists on disk, else null. */
export async function getWriterPdfPath(projectId: string): Promise<string | null> {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  try {
    const projectDir = writerProjectDir(projectId);
    const candidates = [
      path.join(projectDir, `${safeId}.pdf`),
      path.join(projectDir, 'manuscript.pdf'),
      path.join(projectDir, 'manuscript', `${safeId}.pdf`),
      path.join(projectDir, 'manuscript', 'manuscript.pdf'),
      path.join(projectDir, 'exports', `${safeId}.pdf`),
    ];
    for (const c of candidates) {
      try {
        await fsp.stat(c);
        return c;
      } catch {
        // continue
      }
    }
    // Scan directory and manuscript/ subfolder for any .pdf
    const entries = await fsp.readdir(projectDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
        return path.join(projectDir, e.name);
      }
    }
    const manDir = path.join(projectDir, 'manuscript');
    try {
      const manEntries = await fsp.readdir(manDir, { withFileTypes: true });
      for (const e of manEntries) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
          return path.join(manDir, e.name);
        }
      }
    } catch {
      // no manuscript dir
    }
  } catch {
    // ignore
  }
  return null;
}

/** Absolute path to a project's pre-rendered standalone HTML if it exists on disk, else null. */
export async function getWriterStandaloneHtmlPath(projectId: string): Promise<string | null> {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  try {
    const projectDir = writerProjectDir(projectId);
    const candidates = [
      path.join(projectDir, `${safeId}.html`),
      path.join(projectDir, 'manuscript', `${safeId}.html`),
      path.join(projectDir, 'exports', `${safeId}.html`),
    ];
    for (const c of candidates) {
      try {
        await fsp.stat(c);
        return c;
      } catch {
        // continue
      }
    }
    const manDir = path.join(projectDir, 'manuscript');
    const manEntries = await fsp.readdir(manDir, { withFileTypes: true });
    for (const e of manEntries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.html')) {
        return path.join(manDir, e.name);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function normalizeWriterProjectCard(
  project: WriterProject,
  document: WriterDocumentPreview | null,
  auditSummary?: WriterAuditSummary,
  hasPdf = false,
  hasStandaloneHtml = false,
): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    status: project.status,
    deliverableLanguage: project.deliverableLanguage,
    autonomyMode: project.autonomyMode,
    taskMode: project.taskMode,
    currentManuscriptId: project.currentManuscriptId,
    updatedAt: toIso(project.updatedAt),
    createdAt: toIso(project.createdAt),
    documentPath: document?.path,
    projectDir: document?.projectDir ?? writerProjectDir(project.id),
    hasDocument: Boolean(document),
    hasPdf,
    hasStandaloneHtml,
    documentUpdatedAt: document?.updatedAt,
    wordCount: document?.wordCount ?? 0,
    auditSummary,
  };
}

function summarizeWriterClaims(claims: WriterClaim[]): Record<string, number | boolean> {
  const unsupported = claims.filter((claim) => claim.status === 'unsupported' || claim.sourceIds.length === 0);
  const conflicting = claims.filter((claim) => claim.status === 'conflicting');
  const highRiskUnsupported = unsupported.filter((claim) => claim.risk === 'high').length;
  return {
    total: claims.length,
    supported: claims.filter((claim) => claim.status === 'supported' && claim.sourceIds.length > 0).length,
    unsupported: unsupported.length,
    conflicting: conflicting.length,
    highRiskUnsupported,
    ok: highRiskUnsupported === 0 && conflicting.length === 0,
  };
}

export async function getWriterAuditSummary(projectId: string): Promise<WriterAuditSummary> {
  const writer = new WriterService();
  const audits = await writer.listAudits(projectId, 50);
  const latestSlop = audits.find((audit) => audit.kind === 'slop');
  const latestContinuity = audits.find((audit) => audit.kind === 'continuity');
  const latestClaim = audits.find((audit) => audit.kind === 'claim');
  const latestCritic = audits.find((audit) => audit.kind === 'critic');
  const latestRevision = audits.find((audit) => audit.kind === 'revision');
  return {
    total: audits.length,
    latest: audits[0],
    latestSlopScore: latestSlop?.score,
    latestContinuityOk: latestContinuity?.ok,
    latestClaimOk: latestClaim?.ok,
    latestCriticVerdict: typeof (latestCritic?.raw as any)?.overallVerdict === 'string'
      ? (latestCritic?.raw as any).overallVerdict
      : latestCritic?.ok === undefined ? undefined : latestCritic.ok ? 'pass' : 'review',
    latestRevisionDecision: typeof (latestRevision?.raw as any)?.decision?.decision === 'string'
      ? (latestRevision?.raw as any).decision.decision
      : latestRevision?.summary,
    blockingCount: audits.filter((audit) => audit.ok === false).length,
  };
}

export async function getWriterDocumentPreview(
  projectId: string,
  maxPreviewChars = 12_000,
): Promise<WriterDocumentPreview | null> {
  try {
    const filePath = writerManuscriptPath(projectId);
    const [content, stat] = await Promise.all([
      fsp.readFile(filePath, 'utf-8'),
      fsp.stat(filePath),
    ]);
    return {
      projectId: projectId.replace(/[^a-zA-Z0-9_-]/g, ''),
      path: filePath,
      projectDir: writerProjectDir(projectId),
      content,
      preview: content.slice(0, maxPreviewChars),
      wordCount: countWordsWs(content),
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export async function listWriterProjects(opts: WriterWorkspaceProjectListOptions = {}): Promise<any[]> {
  const writer = new WriterService();
  const projects = await writer.listProjects(
    opts.status || opts.type ? { status: opts.status, type: opts.type } : undefined,
    opts.limit ?? 50,
  );
  return Promise.all(projects.map(async (project) => {
    const [document, auditSummary, pdfPath, standaloneHtmlPath] = await Promise.all([
      getWriterDocumentPreview(project.id, 1_000),
      getWriterAuditSummary(project.id).catch(() => ({ total: 0, blockingCount: 0 })),
      getWriterPdfPath(project.id).catch(() => null),
      getWriterStandaloneHtmlPath(project.id).catch(() => null),
    ]);
    return normalizeWriterProjectCard(
      project,
      document,
      auditSummary as WriterAuditSummary,
      Boolean(pdfPath),
      Boolean(standaloneHtmlPath),
    );
  }));
}

export async function listWriterDocuments(opts: WriterWorkspaceProjectListOptions = {}): Promise<any[]> {
  const projects = await listWriterProjects(opts);
  return projects.filter((project) => project.hasDocument || project.currentManuscriptId);
}

export async function getWriterProject(projectId: string): Promise<WriterProject | null> {
  const writer = new WriterService();
  return writer.getProject(projectId);
}

export async function getWriterProjectBundle(projectId: string): Promise<any | null> {
  const writer = new WriterService();
  const project = await writer.getProject(projectId);
  if (!project) return null;
  const [sections, continuity, sources, claims, audits, manuscript, document, pdfPath, standaloneHtmlPath] = await Promise.all([
    writer.listSections(project.id),
    writer.getContinuity(project.id),
    writer.listSources(project.id),
    writer.listClaims(project.id),
    writer.listAudits(project.id, 25),
    writer.getCurrentManuscript(project.id),
    getWriterDocumentPreview(project.id),
    getWriterPdfPath(project.id).catch(() => null),
    getWriterStandaloneHtmlPath(project.id).catch(() => null),
  ]);
  const auditSummary = await getWriterAuditSummary(project.id).catch(() => ({ total: 0, blockingCount: 0 }));
  const hasPdf = Boolean(pdfPath);
  const hasStandaloneHtml = Boolean(standaloneHtmlPath);
  return {
    project: normalizeWriterProjectCard(
      project,
      document,
      auditSummary as WriterAuditSummary,
      hasPdf,
      hasStandaloneHtml,
    ),
    rawProject: project,
    sections,
    continuity,
    sources,
    claims,
    claimSummary: summarizeWriterClaims(claims),
    audits,
    auditSummary,
    manuscript,
    document,
    hasPdf,
    pdfPath: pdfPath || undefined,
    pdfUrl: hasPdf ? `/ws/writer/projects/${encodeURIComponent(project.id)}/pdf` : undefined,
    hasStandaloneHtml,
    standaloneHtmlPath: standaloneHtmlPath || undefined,
    standaloneHtmlUrl: hasStandaloneHtml ? `/ws/writer/projects/${encodeURIComponent(project.id)}/standalone-html` : undefined,
  };
}

export async function getWriterManuscript(manuscriptId: string): Promise<any | null> {
  const writer = new WriterService();
  return writer.getManuscript(manuscriptId);
}

export async function deleteWriterProject(
  projectId: string,
  opts: { deleteFiles?: boolean } = { deleteFiles: true },
): Promise<{ deletedProject: boolean; deletedFiles: number }> {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return { deletedProject: false, deletedFiles: 0 };
  const db = await getDb();
  let deletedFiles = 0;

  if (opts.deleteFiles !== false) {
    const writerDir = getWriterBooksDir();
    const subDir = path.join(writerDir, safeId);
    try {
      if (await fsp.stat(subDir).then(() => true, () => false)) {
        await fsp.rm(subDir, { recursive: true, force: true });
        deletedFiles++;
      }
    } catch {
      // ignore
    }
  }

  const projRes = await db.collection('writer_projects').deleteOne({
    $or: [{ id: safeId }, { id: projectId }],
  });
  await Promise.all([
    db.collection('writer_manuscripts').deleteMany({ projectId: safeId }).catch(() => undefined),
    db.collection('writer_sections').deleteMany({ projectId: safeId }).catch(() => undefined),
    db.collection('writer_audits').deleteMany({ projectId: safeId }).catch(() => undefined),
    db.collection('writer_claims').deleteMany({ projectId: safeId }).catch(() => undefined),
    db.collection('writer_continuity').deleteMany({ projectId: safeId }).catch(() => undefined),
    db.collection('writer_notes').deleteMany({ projectId: safeId }).catch(() => undefined),
    db.collection('writer_sources').deleteMany({ projectId: safeId }).catch(() => undefined),
  ]);

  return {
    deletedProject: Boolean(projRes.deletedCount) || deletedFiles > 0,
    deletedFiles,
  };
}

// ── Filmmaker Agent (read-only) ─────────────────────────────────────────────
// Mirrors writer/chef/content workspace tabs: FilmService owns project truth,
// while this service prepares dashboard cards, run ledgers, and safe media URLs.

export interface FilmWorkspaceProjectListOptions {
  status?: FilmPipelineStatus;
  limit?: number;
}

function filmAssetRoots(): string[] {
  const roots = new Set<string>();
  const repoRoot = process.env.AGENTIC_AGENTS_REPO || '/projekty/mastra-agentic-environment/agentic-agents';
  const configured = process.env.FILM_OUTPUT_DIR || 'film-work';
  roots.add(path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(process.cwd(), configured));
  if (!path.isAbsolute(configured)) roots.add(path.resolve(repoRoot, configured));
  roots.add(path.resolve(repoRoot, 'src/mastra/public/film-work'));
  roots.add(path.resolve(repoRoot, 'src/mastra/public/film-output'));
  return [...roots];
}

function safeFilmAssetPath(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const candidate = !path.isAbsolute(filePath) && filePath.startsWith('projekty/')
    ? `/${filePath}`
    : filePath;
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(process.cwd(), candidate);
  for (const root of filmAssetRoots()) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  return null;
}

function filmRunPreviewUrl(run: FilmGenerationRun): string | undefined {
  return safeFilmAssetPath(run.video_path)
    ? `/ws/filmmaker/runs/${encodeURIComponent(run.run_id)}/video`
    : undefined;
}

function normalizeFilmRun(run: FilmGenerationRun): Record<string, unknown> {
  return {
    runId: run.run_id,
    projectId: run.project_id,
    clipId: run.clip_id,
    surface: run.surface,
    provider: run.provider,
    modelId: run.model_id,
    promptVersion: run.prompt_version,
    inputMode: run.input_mode,
    referenceTags: run.reference_tags,
    resultStatus: run.result_status,
    isSyntheticFixture: run.is_synthetic_fixture,
    taskId: run.task_id,
    prompt: run.prompt,
    videoPath: run.video_path,
    lastFramePath: run.last_frame_path,
    outputUrl: run.output_url,
    error: run.error,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    videoUrl: filmRunPreviewUrl(run),
    hasVideo: Boolean(filmRunPreviewUrl(run)),
  };
}

function latestGeneratedFilmRun(runs: FilmGenerationRun[]): FilmGenerationRun | undefined {
  return runs.find((run) => run.result_status === 'generated' && safeFilmAssetPath(run.video_path))
    ?? runs.find((run) => safeFilmAssetPath(run.video_path))
    ?? runs[0];
}

function normalizeFilmProjectCard(
  project: FilmProjectRecord,
  runs: FilmGenerationRun[] = [],
): Record<string, unknown> {
  const clips = project.state?.clips ?? [];
  const generatedRuns = runs.filter((run) => run.result_status === 'generated');
  const latestRun = latestGeneratedFilmRun(runs);
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    projectMode: project.state?.project_mode,
    surface: project.state?.surface,
    story: project.state?.story,
    clipCount: clips.length,
    acceptedClipCount: clips.filter((clip) => (
      clip.status === 'accepted' || clip.status === 'accepted_with_deviation'
    )).length,
    generatedRunCount: generatedRuns.length,
    runCount: runs.length,
    paidGenerationApproved: project.paidGenerationApproved,
    currentClipId: project.state?.current_clip_id,
    updatedAt: toIso(project.updatedAt) ?? project.state?.updated_at ?? null,
    createdAt: toIso(project.createdAt),
    latestRun: latestRun ? normalizeFilmRun(latestRun) : null,
    latestVideoUrl: latestRun ? filmRunPreviewUrl(latestRun) : undefined,
  };
}

export async function listFilmProjects(opts: FilmWorkspaceProjectListOptions = {}): Promise<any[]> {
  const film = new FilmService();
  const projects = await film.listProjects(
    opts.status ? { status: opts.status } : {},
    opts.limit ?? 50,
  );
  return Promise.all(projects.map(async (project) => {
    const runs = await film.listGenerationRuns(project.id, 20).catch(() => []);
    return normalizeFilmProjectCard(project, runs);
  }));
}

export async function getFilmProjectBundle(projectId: string): Promise<any | null> {
  const film = new FilmService();
  const project = await film.getProject(projectId);
  if (!project) return null;
  const [runs, canon] = await Promise.all([
    film.listGenerationRuns(project.id, 100).catch(() => []),
    film.getCanon(project.id).catch(() => null),
  ]);
  return {
    project: normalizeFilmProjectCard(project, runs),
    rawProject: project,
    clips: project.state?.clips ?? [],
    beats: project.state?.beats ?? [],
    references: project.state?.reference_registry ?? [],
    canon,
    runs: runs.map(normalizeFilmRun),
  };
}

export async function getFilmRunVideoPath(runId: string): Promise<string | null> {
  const db = await getDb();
  const run = await db.collection<FilmGenerationRun>('film_generation_runs').findOne({ run_id: runId });
  return safeFilmAssetPath(run?.video_path);
}

export async function getFilmReferenceImagePath(projectId: string, tag: string): Promise<string | null> {
  if (!tag) return null;
  const film = new FilmService();
  const project = await film.getProject(projectId);
  const refs = project?.state?.reference_registry ?? [];
  const ref = refs.find((item) => item.tag === tag);
  return safeFilmAssetPath(ref?.path);
}

export async function deleteFilmProject(
  projectId: string,
  opts: { deleteFiles?: boolean } = {},
): Promise<{ deletedRuns: number; deletedFiles: number; deletedProject: boolean }> {
  const db = await getDb();
  const runs = await db.collection<FilmGenerationRun>('film_generation_runs')
    .find({ project_id: projectId })
    .toArray();
  let deletedFiles = 0;

  if (opts.deleteFiles) {
    for (const run of runs) {
      const safe = safeFilmAssetPath(run.video_path);
      if (!safe) continue;
      try {
        await fsp.unlink(safe);
        deletedFiles += 1;
      } catch {
        // Deleting dashboard records should not fail because an output file is already gone.
      }
    }
  }

  const runRes = await db.collection<FilmGenerationRun>('film_generation_runs').deleteMany({ project_id: projectId });
  const projectRes = await db.collection<FilmProjectRecord>('film_projects').deleteOne({ id: projectId });
  await db.collection('approvals').deleteMany({ 'args.projectId': projectId }).catch(() => undefined);

  return {
    deletedRuns: runRes.deletedCount ?? 0,
    deletedFiles,
    deletedProject: Boolean(projectRes.deletedCount),
  };
}

// ── Musician Agent (read-only project state + generated audio previews) ─────
// Mirrors the filmmaker tab: MusicService owns project truth, while this service
// prepares dashboard cards, run ledgers, and safe media URLs for the audio player.

export interface MusicWorkspaceProjectListOptions {
  status?: MusicPipelineStatus;
  limit?: number;
}

function musicAssetRoots(): string[] {
  const roots = new Set<string>();
  const repoRoot = process.env.AGENTIC_AGENTS_REPO || '/projekty/mastra-agentic-environment/agentic-agents';
  const configured = process.env.MUSIC_OUTPUT_DIR || 'music-work';
  roots.add(path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(process.cwd(), configured));
  if (!path.isAbsolute(configured)) roots.add(path.resolve(repoRoot, configured));
  roots.add(path.resolve(repoRoot, 'src/mastra/public/music-work'));
  roots.add(path.resolve(repoRoot, 'music-work'));
  return [...roots];
}

function safeMusicAssetPath(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const candidate = !path.isAbsolute(filePath) && filePath.startsWith('projekty/')
    ? `/${filePath}`
    : filePath;
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(process.cwd(), candidate);
  for (const root of musicAssetRoots()) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  return null;
}

function musicRunPreviewUrl(run: MusicGenerationRun): string | undefined {
  return safeMusicAssetPath(run.audio_path)
    ? `/ws/musician/runs/${encodeURIComponent(run.run_id)}/audio`
    : undefined;
}

function normalizeMusicRun(run: MusicGenerationRun): Record<string, unknown> {
  return {
    runId: run.run_id,
    projectId: run.project_id,
    trackId: run.track_id,
    surface: run.surface,
    provider: run.provider,
    modelId: run.model_id,
    promptVersion: run.prompt_version,
    inputMode: run.input_mode,
    referenceTags: run.reference_tags,
    resultStatus: run.result_status,
    isSyntheticFixture: run.is_synthetic_fixture,
    taskId: run.task_id,
    prompt: run.prompt,
    audioPath: run.audio_path,
    outputUrl: run.output_url,
    lengthMs: run.length_ms,
    error: run.error,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    audioUrl: musicRunPreviewUrl(run),
    hasAudio: Boolean(musicRunPreviewUrl(run)),
  };
}

function latestGeneratedMusicRun(runs: MusicGenerationRun[]): MusicGenerationRun | undefined {
  return runs.find((run) => run.result_status === 'generated' && safeMusicAssetPath(run.audio_path))
    ?? runs.find((run) => safeMusicAssetPath(run.audio_path))
    ?? runs[0];
}

function normalizeMusicProjectCard(
  project: MusicProjectRecord,
  runs: MusicGenerationRun[] = [],
): Record<string, unknown> {
  const tracks = project.state?.tracks ?? [];
  const generatedRuns = runs.filter((run) => run.result_status === 'generated');
  const latestRun = latestGeneratedMusicRun(runs);
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    projectMode: project.state?.project_mode,
    surface: project.state?.surface,
    trackCount: tracks.length,
    acceptedTrackCount: tracks.filter((track) => track.status === 'accepted').length,
    generatedRunCount: generatedRuns.length,
    runCount: runs.length,
    paidGenerationApproved: project.paidGenerationApproved,
    currentTrackId: project.state?.current_track_id,
    updatedAt: toIso(project.updatedAt) ?? project.state?.updated_at ?? null,
    createdAt: toIso(project.createdAt),
    latestRun: latestRun ? normalizeMusicRun(latestRun) : null,
    latestAudioUrl: latestRun ? musicRunPreviewUrl(latestRun) : undefined,
  };
}

export async function listMusicProjects(opts: MusicWorkspaceProjectListOptions = {}): Promise<any[]> {
  const music = new MusicService();
  const projects = await music.listProjects(
    opts.status ? { status: opts.status } : {},
    opts.limit ?? 50,
  );
  return Promise.all(projects.map(async (project) => {
    const runs = await music.listGenerationRuns(project.id, 20).catch(() => []);
    return normalizeMusicProjectCard(project, runs);
  }));
}

export async function getMusicProjectBundle(projectId: string): Promise<any | null> {
  const music = new MusicService();
  const project = await music.getProject(projectId);
  if (!project) return null;
  const runs = await music.listGenerationRuns(project.id, 100).catch(() => []);
  return {
    project: normalizeMusicProjectCard(project, runs),
    rawProject: project,
    tracks: project.state?.tracks ?? [],
    runs: runs.map(normalizeMusicRun),
  };
}

export async function getMusicRunAudioPath(runId: string): Promise<string | null> {
  const db = await getDb();
  const run = await db.collection<MusicGenerationRun>('music_generation_runs').findOne({ run_id: runId });
  return safeMusicAssetPath(run?.audio_path);
}

export async function deleteMusicProject(
  projectId: string,
  opts: { deleteFiles?: boolean } = {},
): Promise<{ deletedRuns: number; deletedFiles: number; deletedProject: boolean }> {
  const db = await getDb();
  const runs = await db.collection<MusicGenerationRun>('music_generation_runs')
    .find({ project_id: projectId })
    .toArray();
  let deletedFiles = 0;

  if (opts.deleteFiles) {
    for (const run of runs) {
      const safe = safeMusicAssetPath(run.audio_path);
      if (!safe) continue;
      try {
        await fsp.unlink(safe);
        deletedFiles += 1;
      } catch {
        // Deleting dashboard records should not fail because an output file is already gone.
      }
    }
  }

  const runRes = await db.collection<MusicGenerationRun>('music_generation_runs').deleteMany({ project_id: projectId });
  const projectRes = await db.collection<MusicProjectRecord>('music_projects').deleteOne({ id: projectId });
  await db.collection('approvals').deleteMany({ 'args.projectId': projectId }).catch(() => undefined);

  return {
    deletedRuns: runRes.deletedCount ?? 0,
    deletedFiles,
    deletedProject: Boolean(projectRes.deletedCount),
  };
}

// ── Design Agent (read-only filesystem projects + preview assets) ───────────
// designAgent is filesystem-first: it writes HTML prototypes/decks, rendered media,
// exported PDFs/PPTX files and image assets. There is no project DB yet, so the
// dashboard indexes the known output roots and exposes only discovered project dirs.

export type DesignAssetKind =
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'pptx'
  | 'support';

interface DesignFileEntry {
  absolutePath: string;
  relativePath: string;
  name: string;
  extension: string;
  bytes: number;
  updatedAt: string | null;
}

export interface DesignWorkspaceAsset {
  id: string;
  name: string;
  kind: DesignAssetKind;
  extension: string;
  relativePath: string;
  path: string;
  url: string;
  bytes: number;
  updatedAt: string | null;
  previewable: boolean;
  primary: boolean;
}

export interface DesignWorkspaceProject {
  id: string;
  name: string;
  type: string;
  projectDir: string;
  relativeProjectDir: string;
  artifactCount: number;
  htmlCount: number;
  imageCount: number;
  mediaCount: number;
  exportCount: number;
  supportCount: number;
  updatedAt: string | null;
  previewAsset: DesignWorkspaceAsset | null;
}

export interface DesignWorkspaceBundle {
  project: DesignWorkspaceProject;
  assets: DesignWorkspaceAsset[];
  supportFiles: DesignWorkspaceAsset[];
}

export interface DesignWorkspaceListOptions {
  limit?: number;
}

const DESIGN_ASSET_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.mp4',
  '.webm',
  '.mov',
  '.mp3',
  '.wav',
  '.ogg',
  '.pdf',
  '.pptx',
  '.css',
  '.js',
  '.mjs',
  '.jsx',
  '.json',
  '.txt',
  '.md',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

const DESIGN_DISPLAY_KINDS = new Set<DesignAssetKind>([
  'html',
  'image',
  'video',
  'audio',
  'pdf',
  'pptx',
]);

const DESIGN_IGNORE_DIRS = new Set([
  '.git',
  '.mastra',
  '.next',
  '.turbo',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'storage',
  'chrome_profile_notebooklm',
  '_external',
]);

function agenticAgentsRepoRoot(): string {
  return path.resolve(
    process.env.AGENTIC_AGENTS_REPO
      || '/projekty/mastra-agentic-environment/agentic-agents',
  );
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function pathIsDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fsp.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

function unixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

function encodeDesignPath(relativePath: string): string {
  return relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function designRootToken(projectRoot: string): string {
  return crypto
    .createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 16);
}

function designAssetUrl(projectRoot: string, relativePath: string): string {
  const token = designRootToken(projectRoot);
  return `/ws/design/assets/${encodeURIComponent(token)}/${encodeDesignPath(relativePath)}`;
}

function prettifyDesignName(value: string): string {
  const cleaned = value
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Design project';
  return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function designAssetKind(filePath: string): DesignAssetKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg'].includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.pptx') return 'pptx';
  return 'support';
}

function designAssetPriority(asset: DesignWorkspaceAsset): number {
  const rel = asset.relativePath.toLowerCase();
  const name = asset.name.toLowerCase();
  if (rel === 'index.html' || name === 'index.html') return 0;
  if (asset.kind === 'html' && rel.includes('/index.html')) return 1;
  if (asset.kind === 'html') return 2;
  if (asset.kind === 'video') return 3;
  if (asset.kind === 'pdf') return 4;
  if (asset.kind === 'image' && rel.includes('screenshot')) return 5;
  if (asset.kind === 'image') return 6;
  if (asset.kind === 'audio') return 7;
  if (asset.kind === 'pptx') return 8;
  return 20;
}

function isDesignAssetPreviewable(kind: DesignAssetKind): boolean {
  return kind !== 'support' && kind !== 'pptx';
}

function designProjectType(assets: DesignWorkspaceAsset[]): string {
  if (assets.some((asset) => asset.kind === 'video')) return 'animation/video';
  if (assets.some((asset) => asset.kind === 'pptx' || asset.kind === 'pdf')) return 'deck/export';
  if (assets.some((asset) => asset.kind === 'html')) return 'prototype/html';
  if (assets.some((asset) => asset.kind === 'image')) return 'image assets';
  if (assets.some((asset) => asset.kind === 'audio')) return 'audio/narration';
  return 'support files';
}

async function readHtmlTitleSafe(filePath: string): Promise<string | null> {
  if (designAssetKind(filePath) !== 'html') return null;
  try {
    const handle = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(80_000);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        ?.replace(/\s+/g, ' ')
        .trim();
      return title || null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function collectDesignFiles(
  projectRoot: string,
  opts: { maxDepth?: number; maxFiles?: number } = {},
): Promise<DesignFileEntry[]> {
  const maxDepth = opts.maxDepth ?? 8;
  const maxFiles = opts.maxFiles ?? 600;
  const files: DesignFileEntry[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth < 0 || files.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DESIGN_IGNORE_DIRS.has(entry.name)) await visit(abs, depth - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!DESIGN_ASSET_EXTENSIONS.has(ext)) continue;
      try {
        const st = await fsp.stat(abs);
        files.push({
          absolutePath: abs,
          relativePath: unixRel(projectRoot, abs),
          name: entry.name,
          extension: ext.replace(/^\./, ''),
          bytes: st.size,
          updatedAt: toIso(st.mtime),
        });
      } catch {
        // Skip files that disappear while the dashboard is indexing.
      }
    }
  }

  await visit(projectRoot, maxDepth);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function projectHasDesignFiles(projectRoot: string): Promise<boolean> {
  const files = await collectDesignFiles(projectRoot, { maxDepth: 5, maxFiles: 1 });
  return files.length > 0;
}

function designOutputRoots(): string[] {
  const repoRoot = agenticAgentsRepoRoot();
  const roots = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate || !candidate.trim()) return;
    roots.add(path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(process.cwd(), candidate));
    if (!path.isAbsolute(candidate)) roots.add(path.resolve(repoRoot, candidate));
  };

  add(getDesignOutputDir());
  add(process.env.DESIGN_OUTPUT_DIR);
  add('design-work');
  add('src/mastra/public/design-work');
  return [...roots];
}

async function discoverDesignDemoProjectRoots(): Promise<string[]> {
  const repoRoot = agenticAgentsRepoRoot();
  const found = new Set<string>();
  const maxDepth = 6;

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth < 0) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DESIGN_IGNORE_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (abs.includes(`${path.sep}src${path.sep}mastra${path.sep}assets${path.sep}design${path.sep}`)) continue;
      if (entry.name === 'design-demos') {
        if (await projectHasDesignFiles(abs)) found.add(path.dirname(abs));
        continue;
      }
      await visit(abs, depth - 1);
    }
  }

  if (await pathIsDirectory(repoRoot)) await visit(repoRoot, maxDepth);
  return [...found];
}

async function discoverDesignProjectRoots(): Promise<string[]> {
  const roots = new Set<string>();

  for (const outputRoot of designOutputRoots()) {
    if (!(await pathIsDirectory(outputRoot))) continue;
    const rootEntries = await fsp.readdir(outputRoot, { withFileTypes: true }).catch(() => []);
    const rootFiles = rootEntries.some((entry) => (
      entry.isFile() && DESIGN_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ));
    if (rootFiles) roots.add(outputRoot);

    for (const entry of rootEntries) {
      if (!entry.isDirectory() || DESIGN_IGNORE_DIRS.has(entry.name)) continue;
      const candidate = path.join(outputRoot, entry.name);
      if (await projectHasDesignFiles(candidate)) roots.add(candidate);
    }
  }

  for (const projectRoot of await discoverDesignDemoProjectRoots()) {
    roots.add(projectRoot);
  }

  return [...roots].sort();
}

function normalizeDesignAsset(entry: DesignFileEntry, projectRoot: string): DesignWorkspaceAsset {
  const kind = designAssetKind(entry.absolutePath);
  return {
    id: entry.relativePath,
    name: entry.name,
    kind,
    extension: entry.extension,
    relativePath: entry.relativePath,
    path: entry.absolutePath,
    url: designAssetUrl(projectRoot, entry.relativePath),
    bytes: entry.bytes,
    updatedAt: entry.updatedAt,
    previewable: isDesignAssetPreviewable(kind),
    primary: false,
  };
}

async function buildDesignProjectBundle(projectRoot: string): Promise<DesignWorkspaceBundle | null> {
  const files = await collectDesignFiles(projectRoot);
  if (!files.length) return null;

  const allAssets = files.map((file) => normalizeDesignAsset(file, projectRoot));
  const displayAssets = allAssets
    .filter((asset) => DESIGN_DISPLAY_KINDS.has(asset.kind))
    .sort((a, b) => {
      const priorityDelta = designAssetPriority(a) - designAssetPriority(b);
      if (priorityDelta !== 0) return priorityDelta;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
  if (!displayAssets.length) return null;

  const primary = displayAssets[0] ?? null;
  if (primary) primary.primary = true;

  const htmlTitle = primary?.kind === 'html' ? await readHtmlTitleSafe(primary.path) : null;
  const repoRoot = agenticAgentsRepoRoot();
  const relativeProjectDir = isPathInside(repoRoot, projectRoot)
    ? unixRel(repoRoot, projectRoot) || '.'
    : projectRoot;
  const updatedAt = allAssets
    .map((asset) => asset.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const mediaCount = displayAssets.filter((asset) => asset.kind === 'video' || asset.kind === 'audio').length;
  const exportCount = displayAssets.filter((asset) => asset.kind === 'pdf' || asset.kind === 'pptx').length;
  const project: DesignWorkspaceProject = {
    id: designRootToken(projectRoot),
    name: htmlTitle || prettifyDesignName(path.basename(projectRoot)),
    type: designProjectType(displayAssets),
    projectDir: projectRoot,
    relativeProjectDir,
    artifactCount: displayAssets.length,
    htmlCount: displayAssets.filter((asset) => asset.kind === 'html').length,
    imageCount: displayAssets.filter((asset) => asset.kind === 'image').length,
    mediaCount,
    exportCount,
    supportCount: allAssets.length - displayAssets.length,
    updatedAt,
    previewAsset: primary ? { ...primary } : null,
  };

  return {
    project,
    assets: displayAssets,
    supportFiles: allAssets.filter((asset) => !DESIGN_DISPLAY_KINDS.has(asset.kind)),
  };
}

export async function listDesignProjects(opts: DesignWorkspaceListOptions = {}): Promise<DesignWorkspaceProject[]> {
  const projectRoots = await discoverDesignProjectRoots();
  const bundles = await Promise.all(projectRoots.map((root) => buildDesignProjectBundle(root).catch(() => null)));
  return bundles
    .filter((bundle): bundle is DesignWorkspaceBundle => Boolean(bundle))
    .map((bundle) => bundle.project)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, Math.max(1, opts.limit ?? 100));
}

export async function getDesignProjectBundle(projectId: string): Promise<DesignWorkspaceBundle | null> {
  const projectRoots = await discoverDesignProjectRoots();
  const root = projectRoots.find((candidate) => designRootToken(candidate) === projectId);
  if (!root) return null;
  return buildDesignProjectBundle(root);
}

export async function getDesignAssetPath(rootToken: string, relativePath: string): Promise<string | null> {
  if (!rootToken || !relativePath) return null;
  const projectRoots = await discoverDesignProjectRoots();
  const root = projectRoots.find((candidate) => designRootToken(candidate) === rootToken);
  if (!root) return null;
  const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = path.resolve(root, normalizedRel);
  if (!isPathInside(root, candidate)) return null;
  const ext = path.extname(candidate).toLowerCase();
  if (!DESIGN_ASSET_EXTENSIONS.has(ext)) return null;
  try {
    const st = await fsp.stat(candidate);
    return st.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

export function getDesignAssetContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js' || ext === '.mjs' || ext === '.jsx') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.ttf') return 'font/ttf';
  if (ext === '.otf') return 'font/otf';
  return 'application/octet-stream';
}

export async function deleteDesignProject(
  projectId: string,
  opts: { deleteFiles?: boolean } = { deleteFiles: true },
): Promise<{ deletedProject: boolean; deletedFiles: number }> {
  if (!projectId) return { deletedProject: false, deletedFiles: 0 };
  const db = await getDb();
  let deletedFiles = 0;

  if (opts.deleteFiles !== false) {
    const projectRoots = await discoverDesignProjectRoots();
    const root = projectRoots.find((candidate) => designRootToken(candidate) === projectId);
    if (root) {
      try {
        await fsp.rm(root, { recursive: true, force: true });
        deletedFiles++;
      } catch {
        // ignore
      }
    }
    // Also check direct path in getDesignOutputDir()
    const directDir = path.join(getDesignOutputDir(), projectId);
    try {
      if (await fsp.stat(directDir).then(() => true, () => false)) {
        await fsp.rm(directDir, { recursive: true, force: true });
        deletedFiles++;
      }
    } catch {
      // ignore
    }
  }

  const projRes = await db.collection('design_projects').deleteOne({
    $or: [{ id: projectId }],
  }).catch(() => ({ deletedCount: 0 }));

  return {
    deletedProject: Boolean(projRes?.deletedCount) || deletedFiles > 0,
    deletedFiles,
  };
}

// ── Branded Markdown → HTML engine (workspace-ui rich render) ────────────────
// Themeable document renderer shared by contentAgent (Content Packs) and chefAgent
// (Menu Books): cover header, sticky sidebar nav, per-section colour-coded cards,
// GFM tables (.table-scroll), dark prompt blocks, print CSS. The two agents differ
// only by theme (CSS vars + per-section gradients) and section metadata.

type SectionMeta = { cls: string; emoji: string };

function escapeHtmlWs(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders one section body (Markdown) to HTML and applies the redesign polish. */
function renderSectionBody(md: string): string {
  // Drop any nested anchor/marker comments so they never leak into the output.
  const cleaned = md
    .replace(/<!--\s*section:[a-z0-9:-]+\s+(start|end)\s*-->/gi, '')
    .replace(/<!--\s*(content-pack|chef-book|writer-book)[^>]*-->/gi, '')
    .trim();
  let html = micromark(cleaned, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false,
  });
  // Demote headings two levels so the card H2 stays the section title
  // (# → h3, ## → h4, ### → h5). Process deepest-first to avoid re-shifting.
  html = html
    .replace(/<(\/?)h4(\s|>)/g, '<$1h6$2')
    .replace(/<(\/?)h3(\s|>)/g, '<$1h5$2')
    .replace(/<(\/?)h2(\s|>)/g, '<$1h4$2')
    .replace(/<(\/?)h1(\s|>)/g, '<$1h3$2');
  // Wrap GFM tables for horizontal scroll, matching the redesign.
  html = html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, '</table></div>');
  // Inline-code-only blockquotes (`> \`prompt\``) → dark prompt blocks.
  html = html.replace(
    /<blockquote>\s*<p><code>([\s\S]*?)<\/code><\/p>\s*<\/blockquote>/g,
    '<pre class="prompt-block"><code>$1</code></pre>',
  );
  // Dark prompt blocks for fenced code too.
  html = html.replace(/<pre>/g, '<pre class="prompt-block">');
  return html;
}

interface BrandedDocOpts {
  markdown: string;
  defaultTitle: string;
  h1EmojiStrip: RegExp; // strips the leading emoji from the parsed H1
  coverEmoji: string;
  eyebrow: string;
  coverNote: string;
  emptyHeading: string;
  emptyBody: string;
  themeVars: string; // :root overrides for this agent's palette
  sectionCss: string; // per-section >h2 gradient rules
  sectionMeta: Record<string, SectionMeta>;
  fallbackMeta: (key: string) => SectionMeta; // for dynamic keys (e.g. recipe:slug)
}

/** Core engine: parses anchored sections and emits a self-contained branded HTML doc. */
function brandedDocHtml(o: BrandedDocOpts): string {
  const h1Match = o.markdown.match(/^#\s+(.+)$/m);
  const title = (h1Match ? h1Match[1] : o.defaultTitle).replace(o.h1EmojiStrip, '').trim();

  const sectionRe =
    /##\s+(.+?)\s*\n\s*<!--\s*section:([a-z0-9:-]+)\s+start\s*-->([\s\S]*?)<!--\s*section:\2\s+end\s*-->/gi;
  const sections: { key: string; titleText: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(o.markdown)) !== null) {
    sections.push({ titleText: m[1].trim(), key: m[2].toLowerCase(), body: m[3] });
  }

  // Fallback for standard Markdown documents (novels, chapters, articles without comment tags)
  if (sections.length === 0 && o.markdown.trim().length > 0) {
    const h2Matches = Array.from(o.markdown.matchAll(/^##\s+([^\n]+)$/gm));
    if (h2Matches.length > 0) {
      if (h2Matches[0].index! > 0) {
        const introText = o.markdown.slice(0, h2Matches[0].index!).replace(/^#\s+[^\n]+/m, '').trim();
        if (introText.length > 0) {
          sections.push({ titleText: 'Wprowadzenie', key: 'intro', body: introText });
        }
      }
      for (let i = 0; i < h2Matches.length; i++) {
        const cur = h2Matches[i];
        const heading = cur[1].trim();
        const startIdx = cur.index! + cur[0].length;
        const endIdx = i + 1 < h2Matches.length ? h2Matches[i + 1].index! : o.markdown.length;
        const sectionBody = o.markdown.slice(startIdx, endIdx).trim();
        const key = heading
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '') || `sec-${i + 1}`;
        sections.push({ titleText: heading, key, body: sectionBody });
      }
    } else {
      const bodyText = o.markdown.replace(/^#\s+[^\n]+/m, '').trim();
      if (bodyText.length > 0) {
        sections.push({ titleText: title || 'Manuskrypt', key: 'manuscript', body: bodyText });
      }
    }
  }

  const metaOf = (key: string): SectionMeta => o.sectionMeta[key] || o.fallbackMeta(key);
  const idOf = (key: string) => 'sec-' + key.replace(/:/g, '-');

  const navLinks = sections
    .map((s) => {
      const meta = metaOf(s.key);
      return `<a href="#${idOf(s.key)}">${meta.emoji} ${escapeHtmlWs(s.titleText)}</a>`;
    })
    .join('');

  const body = sections
    .map((s) => {
      const meta = metaOf(s.key);
      return `<section class="content-section ${meta.cls}"><h2 id="${idOf(s.key)}">${meta.emoji} ${escapeHtmlWs(s.titleText)}</h2>
${renderSectionBody(s.body)}</section>`;
    })
    .join('\n');

  const empty = sections.length === 0
    ? `<section class="content-section"><h2>${o.emptyHeading}</h2><p>${o.emptyBody}</p></section>`
    : '';

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtmlWs(title)}</title>
<style>
:root{--bg:#eef2ef;--surface:#fff;--surface-soft:#f7faf8;--ink:#17211c;--muted:#66736c;--line:#dbe4df;--brand:#198754;--brand-dark:#0e5f3a;--shadow:0 14px 34px rgba(21,38,29,.08);--radius:18px;--cover-grad:radial-gradient(circle at 84% 20%,rgba(70,224,149,.22),transparent 28%),linear-gradient(135deg,#101814 0%,#1d2d25 58%,#0f6c40 140%);--cover-accent:#4ee293;--eyebrow-ink:#dff7e9;--code-bg:#e8efeb;--code-ink:#174b31;--th-bg:#223129;--quote-bg:#f2faf5;--quote-border:#cfe4d8;--quote-ink:#304239;--sb-hover-bg:#e9f6ef;--row-even:#f8faf9;--strong-ink:#14251c;--head-default:linear-gradient(135deg,#17211c,#25352d);${o.themeVars}}
*{box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.68;font-size:15px;}
a{color:var(--brand-dark);text-underline-offset:3px;}
a:hover{color:var(--brand);}
.cover{position:relative;overflow:hidden;padding:54px 40px 46px;color:#fff;background:var(--cover-grad);}
.cover-inner{max-width:1180px;margin:0 auto;position:relative;z-index:1;}
.eyebrow{display:inline-flex;gap:8px;align-items:center;margin-bottom:16px;padding:7px 12px;border:1px solid rgba(255,255,255,.22);border-radius:999px;color:var(--eyebrow-ink);background:rgba(255,255,255,.06);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;}
.cover h1{margin:0;max-width:900px;font-size:clamp(28px,4vw,48px);line-height:1.1;letter-spacing:-.03em;}
.cover-note{max-width:780px;margin-top:22px;padding:13px 16px;border:1px solid rgba(255,255,255,.16);border-left:4px solid var(--cover-accent);border-radius:12px;background:rgba(0,0,0,.16);color:#dfe9e3;font-size:13px;}
.cover-note p{margin:0;}
.layout{max-width:1280px;margin:0 auto;display:grid;grid-template-columns:240px minmax(0,1fr);gap:26px;padding:30px 22px 64px;}
.sidebar-inner{position:sticky;top:18px;padding:16px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.9);box-shadow:0 10px 28px rgba(21,38,29,.06);}
.sidebar-title{margin:0 0 10px;color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;}
.sidebar a{display:block;margin:3px 0;padding:8px 10px;border-radius:9px;color:#334139;text-decoration:none;font-size:13px;line-height:1.35;}
.sidebar a:hover{background:var(--sb-hover-bg);color:var(--brand-dark);}
.document{min-width:0;}
.content-section{margin:0 0 26px;padding:30px 34px 36px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow);scroll-margin-top:18px;}
.content-section>h2{margin:-30px -34px 26px;padding:22px 28px;border-radius:var(--radius) var(--radius) 0 0;color:#fff;background:var(--head-default);font-size:clamp(22px,2.6vw,30px);line-height:1.2;letter-spacing:-.02em;}
${o.sectionCss}
h3{margin:26px 0 12px;font-size:21px;line-height:1.3;letter-spacing:-.015em;}
h4{margin:24px 0 10px;font-size:18px;line-height:1.35;}
h5{margin:20px 0 8px;font-size:16px;line-height:1.4;}
p{margin:0 0 14px;}
ul,ol{margin:10px 0 18px;padding-left:1.45rem;}
li{margin:6px 0;}
li::marker{color:var(--brand);font-weight:800;}
strong{color:var(--strong-ink);}
hr{border:0;height:1px;margin:28px 0;background:linear-gradient(90deg,transparent,var(--line) 15%,var(--line) 85%,transparent);}
blockquote{margin:18px 0;padding:16px 18px;border:1px solid var(--quote-border);border-left:5px solid var(--brand);border-radius:12px;background:var(--quote-bg);color:var(--quote-ink);}
blockquote p:last-child{margin-bottom:0;}
.table-scroll{width:100%;overflow-x:auto;margin:18px 0 26px;border:1px solid var(--line);border-radius:13px;}
table{width:100%;min-width:680px;border-collapse:collapse;background:#fff;font-size:13px;}
th,td{padding:12px 13px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);text-align:left;vertical-align:top;}
th:last-child,td:last-child{border-right:0;}
tr:last-child td{border-bottom:0;}
th{position:sticky;top:0;z-index:1;color:#fff;background:var(--th-bg);font-weight:750;}
tbody tr:nth-child(even){background:var(--row-even);}
code{padding:.12em .38em;border-radius:5px;background:var(--code-bg);color:var(--code-ink);font-family:"SFMono-Regular",Consolas,monospace;font-size:.9em;}
pre.prompt-block{position:relative;overflow-x:auto;margin:14px 0 24px;padding:18px;border-radius:13px;background:#111915;color:#d9eee2;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);}
pre.prompt-block code{padding:0;background:transparent;color:inherit;white-space:pre-wrap;}
@media(max-width:940px){.layout{grid-template-columns:1fr;}.sidebar-inner{position:static;display:flex;gap:6px;overflow-x:auto;padding:10px;}.sidebar-title{display:none;}.sidebar a{white-space:nowrap;background:#f2f6f4;}.content-section{padding:24px 20px 30px;}.content-section>h2{margin:-24px -20px 22px;padding:20px;}}
@media print{body{background:#fff;font-size:10.5pt;}.cover{padding:30px 26px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.sidebar{display:none;}.layout{display:block;max-width:none;padding:16px 0;}.content-section{break-inside:avoid-page;box-shadow:none;margin:0 0 16px;}.table-scroll{overflow:visible;}table{min-width:0;}}
</style>
</head>
<body>
<header class="cover"><div class="cover-inner">
<div class="eyebrow">${o.eyebrow}</div>
<h1>${o.coverEmoji} ${escapeHtmlWs(title)}</h1>
<div class="cover-note"><p>${o.coverNote}</p></div>
</div></header>
<div class="layout">
<aside class="sidebar"><nav class="sidebar-inner"><p class="sidebar-title">Nawigacja</p>${navLinks}</nav></aside>
<main class="document">
${body}${empty}
</main>
</div>
</body>
</html>`;
}

// ── contentAgent theme (Content Packs — green) ───────────────────────────────
const PACK_SECTIONS: Record<string, SectionMeta> = {
  brief: { cls: 'section-brief', emoji: '📋' },
  research: { cls: 'section-research', emoji: '🔎' },
  strategy: { cls: 'section-strategy', emoji: '🧭' },
  linkedin: { cls: 'section-linkedin', emoji: '💼' },
  instagram: { cls: 'section-instagram', emoji: '📸' },
  tiktok: { cls: 'section-tiktok', emoji: '🎬' },
  'image-briefs': { cls: 'section-images', emoji: '🎨' },
  images: { cls: 'section-images', emoji: '🎨' },
  distribution: { cls: 'section-distribution', emoji: '📅' },
};

const PACK_SECTION_CSS = `.section-brief>h2{background:linear-gradient(135deg,#143524,#1e6c45);}
.section-research>h2{background:linear-gradient(135deg,#183039,#236477);}
.section-strategy>h2{background:linear-gradient(135deg,#2b2840,#5d4c86);}
.section-linkedin>h2{background:linear-gradient(135deg,#123851,#0a66c2);}
.section-instagram>h2{background:linear-gradient(135deg,#5d1b50,#b42f77);}
.section-tiktok>h2{background:linear-gradient(135deg,#161b1d,#303b3f);}
.section-images>h2{background:linear-gradient(135deg,#3d2b20,#8a5a33);}
.section-distribution>h2{background:linear-gradient(135deg,#30351c,#748224);}`;

/** Converts the on-disk Content Pack Markdown into a self-contained branded HTML doc. */
export function contentPackMarkdownToHtml(markdown: string): string {
  return brandedDocHtml({
    markdown,
    defaultTitle: 'Content Pack',
    h1EmojiStrip: /^📣\s*/,
    coverEmoji: '📣',
    eyebrow: 'GastroBridge · contentAgent',
    coverNote: 'Wygenerowane przyrostowo przez contentAgent. Nie edytuj treści między znacznikami sekcji.',
    emptyHeading: '📣 Content Pack',
    emptyBody: 'Ten Content Pack nie ma jeszcze wypełnionych sekcji.',
    themeVars: '',
    sectionCss: PACK_SECTION_CSS,
    sectionMeta: PACK_SECTIONS,
    fallbackMeta: () => ({ cls: '', emoji: '•' }),
  });
}

/** Reads the Content Pack and returns it as a branded standalone HTML document. */
export async function getContentPackHtml(
  projectId: string,
): Promise<{ projectId: string; html: string } | null> {
  const pack = await getContentPack(projectId);
  if (!pack) return null;
  return { projectId: pack.projectId, html: contentPackMarkdownToHtml(pack.content) };
}

// ── chefAgent theme (Menu Books — warm charcoal/gold "kitchen") ──────────────
const BOOK_SECTIONS: Record<string, SectionMeta> = {
  overview: { cls: 'section-overview', emoji: '📋' },
  profile: { cls: 'section-profile', emoji: '👤' },
  recon: { cls: 'section-recon', emoji: '🔎' },
  menu: { cls: 'section-menu', emoji: '🍽️' },
  recipes: { cls: 'section-recipes', emoji: '📑' },
  pairings: { cls: 'section-pairings', emoji: '🍷' },
  allergens: { cls: 'section-allergens', emoji: '⚠️' },
  notes: { cls: 'section-notes', emoji: '📝' },
};

const BOOK_THEME_VARS =
  '--bg:#f3efe9;--surface:#fff;--surface-soft:#faf7f2;--ink:#211b14;--muted:#736a5e;--line:#e4ddd1;--brand:#b8860b;--brand-dark:#8a5a1a;--cover-grad:radial-gradient(circle at 84% 20%,rgba(224,178,70,.22),transparent 28%),linear-gradient(135deg,#1a1410 0%,#2d2419 58%,#6c4a0f 140%);--cover-accent:#e2b34e;--eyebrow-ink:#f7e9cf;--code-bg:#efeae0;--code-ink:#6b4b17;--th-bg:#312822;--quote-bg:#faf5ec;--quote-border:#e4d8c0;--quote-ink:#42382b;--sb-hover-bg:#f6efe2;--row-even:#faf9f7;--strong-ink:#241c12;--head-default:linear-gradient(135deg,#211b14,#352b22);';

const BOOK_SECTION_CSS = `.section-overview>h2{background:linear-gradient(135deg,#143524,#1e6c45);}
.section-profile>h2{background:linear-gradient(135deg,#2b2840,#5d4c86);}
.section-recon>h2{background:linear-gradient(135deg,#183039,#236477);}
.section-menu>h2{background:linear-gradient(135deg,#5a3d12,#b8860b);}
.section-recipes>h2{background:linear-gradient(135deg,#3a1c1c,#7a2e2e);}
.section-pairings>h2{background:linear-gradient(135deg,#3d1430,#7a1f4a);}
.section-allergens>h2{background:linear-gradient(135deg,#5a2f12,#b4622f);}
.section-notes>h2{background:linear-gradient(135deg,#30351c,#5a5424);}`;

/** Converts the on-disk Menu Book Markdown into a self-contained branded HTML doc. */
export function chefBookMarkdownToHtml(markdown: string): string {
  return brandedDocHtml({
    markdown,
    defaultTitle: 'Księga Menu',
    h1EmojiStrip: /^📖\s*/,
    coverEmoji: '📖',
    eyebrow: 'GastroBridge · chefAgent',
    coverNote: 'Wygenerowane przyrostowo przez chefAgent. Nie edytuj ręcznie sekcji między znacznikami.',
    emptyHeading: '📖 Księga Menu',
    emptyBody: 'Ta Księga Menu nie ma jeszcze wypełnionych sekcji.',
    themeVars: BOOK_THEME_VARS,
    sectionCss: BOOK_SECTION_CSS,
    sectionMeta: BOOK_SECTIONS,
    // Dynamic sub-sections (recipe:slug, plan §5 ids) fall back to the recipes card.
    fallbackMeta: (key) =>
      key.startsWith('recipe:')
        ? { cls: 'section-recipes', emoji: '🍳' }
        : { cls: 'section-notes', emoji: '•' },
  });
}

/** Reads the Menu Book and returns it as a branded standalone HTML document. */
export async function getChefBookHtml(
  projectId: string,
): Promise<{ projectId: string; html: string } | null> {
  const book = await getChefBook(projectId);
  if (!book) return null;
  return { projectId: book.projectId, html: chefBookMarkdownToHtml(book.content) };
}

// ── writerAgent theme (Manuscripts — ink/teal/indigo editor) ────────────────
const WRITER_SECTIONS: Record<string, SectionMeta> = {
  brief: { cls: 'section-brief', emoji: '📋' },
  outline: { cls: 'section-outline', emoji: '🧭' },
  manuscript: { cls: 'section-manuscript', emoji: '✍️' },
  sources: { cls: 'section-sources', emoji: '🔎' },
  claims: { cls: 'section-claims', emoji: '✅' },
  continuity: { cls: 'section-continuity', emoji: '🧵' },
  audits: { cls: 'section-audits', emoji: '🧪' },
  notes: { cls: 'section-notes', emoji: '📝' },
};

const WRITER_THEME_VARS =
  '--bg:#eef2f6;--surface:#fff;--surface-soft:#f7f9fc;--ink:#17202a;--muted:#637083;--line:#dce4ee;--brand:#167a7f;--brand-dark:#115f63;--cover-grad:radial-gradient(circle at 84% 20%,rgba(88,166,255,.20),transparent 28%),linear-gradient(135deg,#111827 0%,#1f2937 58%,#0f766e 140%);--cover-accent:#67e8f9;--eyebrow-ink:#dff9fb;--code-bg:#e9f2f5;--code-ink:#115f63;--th-bg:#1f2937;--quote-bg:#f1f8fa;--quote-border:#cfe6ec;--quote-ink:#2f404c;--sb-hover-bg:#e7f5f6;--row-even:#f8fafc;--strong-ink:#111827;--head-default:linear-gradient(135deg,#17202a,#243244);';

const WRITER_SECTION_CSS = `.section-brief>h2{background:linear-gradient(135deg,#17202a,#2f4057);}
.section-outline>h2{background:linear-gradient(135deg,#253044,#5d6f96);}
.section-manuscript>h2{background:linear-gradient(135deg,#104e5f,#167a7f);}
.section-sources>h2{background:linear-gradient(135deg,#183039,#236477);}
.section-claims>h2{background:linear-gradient(135deg,#143524,#1e6c45);}
.section-continuity>h2{background:linear-gradient(135deg,#3a2558,#6b4f9c);}
.section-audits>h2{background:linear-gradient(135deg,#5a2f12,#b4622f);}
.section-notes>h2{background:linear-gradient(135deg,#30351c,#5a5424);}`;

/** Converts the on-disk writer manuscript Markdown into a branded standalone HTML doc. */
export function writerDocumentMarkdownToHtml(markdown: string): string {
  return brandedDocHtml({
    markdown,
    defaultTitle: 'Writer Manuscript',
    h1EmojiStrip: /^✍️\s*/,
    coverEmoji: '✍️',
    eyebrow: 'GastroBridge · writerAgent',
    coverNote: 'Wygenerowane przyrostowo przez writerAgent. Sekcje manuskryptu, źródeł, claimów i audytów są aktualizowane przez narzędzia domenowe.',
    emptyHeading: '✍️ Writer Manuscript',
    emptyBody: 'Ten manuskrypt nie ma jeszcze wypełnionych sekcji.',
    themeVars: WRITER_THEME_VARS,
    sectionCss: WRITER_SECTION_CSS,
    sectionMeta: WRITER_SECTIONS,
    fallbackMeta: (key) => {
      if (key.startsWith('chapter:') || key.startsWith('chapter-') || key.startsWith('rozdzial'))
        return { cls: 'section-manuscript', emoji: '📖' };
      if (key.startsWith('scene:') || key.startsWith('scene-'))
        return { cls: 'section-manuscript', emoji: '🎬' };
      if (key.startsWith('section:') || key.startsWith('section-') || key.startsWith('czesc'))
        return { cls: 'section-outline', emoji: '§' };
      if (key.includes('spis') || key.includes('toc'))
        return { cls: 'section-outline', emoji: '🧭' };
      if (key.includes('wstep') || key.includes('intro') || key.includes('wprowadzenie'))
        return { cls: 'section-brief', emoji: '📋' };
      return { cls: 'section-notes', emoji: '•' };
    },
  });
}

/** Reads the writer manuscript and returns it as a branded standalone HTML document. */
export async function getWriterDocumentHtml(
  projectId: string,
): Promise<{ projectId: string; html: string } | null> {
  const document = await getWriterDocumentPreview(projectId);
  if (!document) return null;
  return { projectId: document.projectId, html: writerDocumentMarkdownToHtml(document.content) };
}

export type { Db };
