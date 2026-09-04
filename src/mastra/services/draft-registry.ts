/**
 * DraftRegistry — indeks magazynu draftów (DraftsStore) w MongoDB.
 *
 * Zastępuje martwy `delta-indexer.ts` (celował w nieistniejącą bazę gastro_bridge).
 * Skanuje FS `.drafts/<data>/<task>/<draftId>/{draft.md, draft.meta.json}` i upsertuje
 * znormalizowane rekordy do `agentforge.drafts`. FS pozostaje źródłem prawdy treści;
 * Mongo to indeks do szybkich list/filtrów (kalendarz, kanał, status).
 *
 * Obsługiwane typy (tworzone przez workflowy):
 *   - cold-email         (producer-hunt / automation outreach)  → channel "email"
 *   - linkedin-post      (weekly-content / contentAgent)         → channel "linkedin"
 *   - instagram-caption  (weekly-content / contentAgent)         → channel "instagram"
 *   - tiktok-script      (contentAgent)                          → channel "tiktok"
 *
 * Plan: ideas/dashboard-operacyjny-plan.md
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../lib/mongo.js';
import { CRM_STATUS_SENT as CRM_SENT_STATUS } from '../config/crm-statuses.js';
import type { DraftMetadata } from '../lib/drafts-store.js';

export type DraftChannel = 'email' | 'linkedin' | 'instagram' | 'tiktok' | 'other';

export interface WorkspaceDraft {
  draftId: string;
  taskId: string;
  channel: DraftChannel;
  type: string;
  language: string;
  status: string;
  title: string;
  body: string;
  charCount: number;
  limit: number;
  scheduledFor?: string | null;
  weekStarting?: string | null;
  imagePrompt?: string | null;
  gmailDraftId?: string | null;
  enrichment?: unknown;
  hashtags?: string[];
  rationale?: string | null;
  filePath: string;
  bodyHash: string;
  agentId?: string;
  createdAt?: string | null;
  updatedAt: string;
  meta: DraftMetadata;
}

/** Limity znaków per typ (miękkie progi UI). */
export const CHANNEL_LIMITS: Record<string, number> = {
  'linkedin-post': 3000,
  'instagram-caption': 2200,
  'tiktok-script': 2200,
  'cold-email': 5000,
};

function channelFromType(type: string): DraftChannel {
  if (type === 'cold-email' || type === 'email') return 'email';
  if (type.startsWith('linkedin')) return 'linkedin';
  if (type.startsWith('instagram')) return 'instagram';
  if (type.startsWith('tiktok')) return 'tiktok';
  return 'other';
}

function titleFromMeta(meta: DraftMetadata): string {
  return (
    meta.topic ||
    (meta as any).subject ||
    meta.company ||
    `${meta.type} (${meta.draftId})`
  );
}

function hashBody(body: string): string {
  return createHash('sha1').update(body).digest('hex');
}

import { getDraftsDir } from '../config/workspace-paths.js';

/** Wykrywa katalog .drafts. Priorytet: DRAFTS_PATH → getDraftsDir() → znana lokalizacja → cwd. */
async function resolveDraftsDir(): Promise<string | null> {
  const candidates = [
    process.env.DRAFTS_PATH,
    getDraftsDir(),
    '/projekty/mastra-agentic-environment/agentic-agents/src/mastra/public/.drafts',
    path.resolve(process.cwd(), 'src/mastra/public/.drafts'),
    path.resolve(process.cwd(), '.drafts'),
    path.resolve(process.cwd(), 'public/.drafts'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Rekurencyjnie znajduje wszystkie foldery zawierające draft.meta.json. */
async function findDraftFolders(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasMeta = entries.some((e) => e.isFile() && e.name === 'draft.meta.json');
    if (hasMeta) {
      out.push(dir);
      return; // folder draftu — nie schodzimy głębiej
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
  }
  await walk(root);
  return out;
}

function buildDraft(meta: DraftMetadata, body: string, filePath: string, updatedAt: string): WorkspaceDraft {
  const charCount = typeof meta.charCount === 'number' ? meta.charCount : body.length;
  return {
    draftId: meta.draftId,
    taskId: meta.taskId,
    channel: channelFromType(meta.type),
    type: meta.type,
    language: meta.language,
    status: meta.status ?? 'draft',
    title: titleFromMeta(meta),
    body,
    charCount,
    limit: CHANNEL_LIMITS[meta.type] ?? 0,
    scheduledFor: meta.scheduledFor ?? null,
    weekStarting: meta.weekStarting ?? null,
    imagePrompt: meta.imagePrompt ?? null,
    gmailDraftId: meta.gmailDraftId ?? null,
    enrichment: meta.enrichment ?? null,
    hashtags: meta.hashtags ?? [],
    rationale: meta.rationale ?? null,
    filePath,
    bodyHash: hashBody(body),
    agentId: meta.agentId,
    createdAt: meta.createdAt ?? null,
    updatedAt,
    meta,
  };
}

/**
 * Skanuje FS i upsertuje wszystkie drafty do agentforge.drafts.
 * Zwraca liczbę zindeksowanych draftów.
 */
export async function reindexDrafts(): Promise<{ indexed: number; dir: string | null }> {
  const dir = await resolveDraftsDir();
  if (!dir) return { indexed: 0, dir: null };

  const db = await getDb();
  const coll = db.collection('drafts');
  await coll.createIndex({ draftId: 1 }, { unique: true }).catch(() => {});
  await coll.createIndex({ channel: 1, status: 1 }).catch(() => {});
  await coll.createIndex({ scheduledFor: 1 }).catch(() => {});

  const folders = await findDraftFolders(dir);
  let indexed = 0;

  for (const folder of folders) {
    try {
      const [metaRaw, body] = await Promise.all([
        fs.readFile(path.join(folder, 'draft.meta.json'), 'utf-8'),
        fs.readFile(path.join(folder, 'draft.md'), 'utf-8').catch(() => ''),
      ]);
      const meta = JSON.parse(metaRaw) as DraftMetadata;
      if (!meta.draftId) continue;
      const fileStat = await fs.stat(path.join(folder, 'draft.md')).catch(() => null);
      const updatedAt = fileStat ? fileStat.mtime.toISOString() : new Date().toISOString();
      const draft = buildDraft(meta, body, folder, updatedAt);

      await coll.updateOne(
        { draftId: draft.draftId },
        { $set: draft },
        { upsert: true },
      );
      indexed++;
    } catch {
      continue;
    }
  }
  return { indexed, dir };
}

export interface ListDraftsOptions {
  channel?: DraftChannel | string;
  status?: string;
  segment?: string;
  search?: string;
  language?: string;
  week?: string;
  limit?: number;
}

/** Lista draftów z rejestru. */
export async function listDrafts(opts: ListDraftsOptions = {}): Promise<WorkspaceDraft[]> {
  const db = await getDb();
  const coll = db.collection('drafts');

  const filter: Record<string, any> = {};
  if (opts.channel) filter.channel = opts.channel;
  if (opts.status) filter.status = opts.status;
  if (opts.segment) {
    filter.$or = [
      { 'meta.segment': opts.segment },
      { type: opts.segment },
    ];
  }
  if (opts.language) filter.language = opts.language;
  if (opts.week) filter.weekStarting = opts.week;
  if (opts.search) {
    filter.$or = [
      { title: { $regex: opts.search, $options: 'i' } },
      { body: { $regex: opts.search, $options: 'i' } },
      { 'meta.company': { $regex: opts.search, $options: 'i' } },
      { 'meta.sourceContact': { $regex: opts.search, $options: 'i' } },
      { 'enrichment.email': { $regex: opts.search, $options: 'i' } },
    ];
  }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const docs = await coll
    .find(filter, { projection: { _id: 0 } })
    .sort({ createdAt: -1, updatedAt: -1, scheduledFor: -1 })
    .limit(limit)
    .toArray();
  return docs as unknown as WorkspaceDraft[];
}

export async function getDraft(draftId: string): Promise<WorkspaceDraft | null> {
  const db = await getDb();
  const doc = await db.collection('drafts').findOne(
    { $or: [{ draftId }, { gmailDraftId: draftId }] },
    { projection: { _id: 0 } },
  );
  return (doc as unknown as WorkspaceDraft) ?? null;
}

export interface UpsertGmailDraftInput {
  gmailDraftId: string;
  account?: 'gastrobridge' | 'personal';
  to: string;
  subject: string;
  body: string;
  html?: string;
  threadId?: string;
  status?: string;
  attachments?: Array<{ filename: string; path?: string }>;
  agentId?: string;
  segment?: string;
  enrichment?: unknown;
}

export function inferDraftSegment(to: string, subject: string, body: string, account?: string): string {
  const combined = `${to} ${subject} ${body}`.toLowerCase();
  if (combined.includes('ai solutions') || combined.includes('agentic') || combined.includes('engineer') || combined.includes('programist') || combined.includes('software') || combined.includes('developer')) {
    if (combined.includes('.is') || combined.includes('iceland') || combined.includes('reykjavik')) return 'career_it_is';
    return 'career_it_pl';
  }
  if (combined.includes('chef') || combined.includes('kuch') || combined.includes('szef') || combined.includes('gastronom') || combined.includes('restaurac') || combined.includes('hospitality')) {
    if (combined.includes('.is') || combined.includes('iceland') || combined.includes('reykjavik')) return 'career_chef_is';
    return 'career_chef_pl';
  }
  if (combined.includes('gastrobridge') || account === 'gastrobridge') {
    return 'supplier_gb';
  }
  if (combined.includes('automatyzac') || combined.includes('n8n') || combined.includes('flowmint')) {
    return 'automation';
  }
  return 'other';
}

function detectDraftLanguage(text: string): 'pl' | 'en' {
  const sample = text.toLowerCase();
  if (/[ąćęłńóśźż]/.test(sample) || sample.includes('dzień dobry') || sample.includes('pozdrawiam') || sample.includes('aplikacja')) {
    return 'pl';
  }
  return 'en';
}

/**
 * Automatyczna rejestracja draftu z Gmaila w bazie MongoDB i rejestrze Splot OS.
 */
export async function upsertDraftFromGmail(input: UpsertGmailDraftInput): Promise<WorkspaceDraft> {
  const db = await getDb();
  const coll = db.collection('drafts');
  const now = new Date().toISOString();

  const segment = input.segment || inferDraftSegment(input.to, input.subject, input.body, input.account);
  const lang = detectDraftLanguage(`${input.subject} ${input.body}`);
  const draftId = `gmail-${input.gmailDraftId}`;

  const meta: DraftMetadata = {
    draftId,
    taskId: `gmail-${input.account || 'personal'}-${now.slice(0, 10)}`,
    type: 'cold-email',
    language: lang,
    topic: input.subject,
    company: input.to,
    segment,
    sourceContact: input.to,
    gmailDraftId: input.gmailDraftId,
    createdAt: now,
    agentId: input.agentId || 'marketingAgent',
    status: input.status || 'draft',
    enrichment: input.enrichment || { email: input.to, account: input.account || 'personal', attachments: input.attachments },
    llm: { provider: 'google', model: 'gmail-sync', costUsd: 0 },
  };

  const draftDoc: WorkspaceDraft = {
    draftId,
    taskId: meta.taskId,
    channel: 'email',
    type: 'cold-email',
    language: lang,
    status: input.status || 'draft',
    title: input.subject || `Draft do ${input.to}`,
    body: input.body,
    charCount: input.body.length,
    limit: CHANNEL_LIMITS['cold-email'] ?? 5000,
    scheduledFor: null,
    weekStarting: null,
    imagePrompt: null,
    gmailDraftId: input.gmailDraftId,
    enrichment: meta.enrichment,
    hashtags: [],
    rationale: `Draft e-mail do ${input.to} (${segment})`,
    filePath: '',
    bodyHash: hashBody(input.body),
    agentId: meta.agentId,
    createdAt: now,
    updatedAt: now,
    meta,
  };

  await coll.updateOne(
    { $or: [{ draftId }, { gmailDraftId: input.gmailDraftId }] },
    { $set: draftDoc },
    { upsert: true },
  );

  return draftDoc;
}

/**
 * Synchronizuje szkice bezpośrednio z API obu kont Gmail (personal i gastrobridge).
 */
export async function syncGmailDrafts(): Promise<{ synced: number; accounts: string[]; errors: string[] }> {
  const accounts: Array<'personal' | 'gastrobridge'> = ['personal', 'gastrobridge'];
  let synced = 0;
  const errors: string[] = [];

  const { GmailService } = await import('../tools/google/gmail.js');

  for (const acc of accounts) {
    try {
      const gmail = await GmailService.create(acc);
      const draftsList = await gmail.listDrafts(50);
      for (const draftItem of draftsList) {
        if (!draftItem.id) continue;
        try {
          const detail = await gmail.getDraft(draftItem.id);
          if (detail && detail.to && detail.body) {
            await upsertDraftFromGmail({
              gmailDraftId: draftItem.id,
              account: acc,
              to: detail.to,
              subject: detail.subject || '(Bez tematu)',
              body: detail.body,
              threadId: detail.threadId || undefined,
            });
            synced++;
          }
        } catch (err: any) {
          errors.push(`[${acc}] Błąd draftu ${draftItem.id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      errors.push(`[${acc}] Błąd pobierania listy draftów: ${err.message}`);
    }
  }

  return { synced, accounts, errors };
}

/**
 * Wysyła draft przez Gmail API i aktualizuje status na 'sent' w bazie i CRM.
 * Przed wysyłką upewnia się, że treść w chmurze Gmail jest w 100% zaktualizowana do najnowszej wersji z Splot OS.
 */
export async function sendDraftById(draftId: string): Promise<{
  success: boolean;
  draftId: string;
  /** Whether the send left a trace in the CRM, and how. */
  crmAction?: 'updated' | 'created' | 'skipped_no_recipient';
  error?: string;
}> {
  const db = await getDb();
  const draft = await getDraft(draftId);
  if (!draft) {
    return { success: false, draftId, error: `Nie znaleziono draftu: ${draftId}` };
  }

  let gmailDraftId = draft.gmailDraftId || draft.draftId.replace(/^gmail-/, '');
  const account = (draft.meta as any)?.enrichment?.account || (draft.meta as any)?.account || 'personal';
  const recipientEmail = (draft.meta as any)?.enrichment?.email || draft.meta?.sourceContact;
  const attachments = (draft.meta as any)?.enrichment?.attachments || (draft.meta as any)?.attachments;

  try {
    const { GmailService } = await import('../tools/google/gmail.js');
    const gmail = await GmailService.create(account);

    // 1. Zsynchronizuj najnowszą treść z Splot OS do Gmaila przed wysyłką
    if (gmailDraftId && draft.body) {
      try {
        const updatedId = await gmail.updateDraft({
          draftId: gmailDraftId,
          to: recipientEmail || '',
          subject: draft.title,
          body: draft.body,
          attachments,
        });
        if (updatedId) gmailDraftId = updatedId;
      } catch (syncWarn) {
        console.warn('[sendDraftById] Update before send warning:', syncWarn);
      }
    }

    // 2. Fizyczna wysyłka
    await gmail.sendDraft(gmailDraftId);

    const now = new Date().toISOString();
    await db.collection('drafts').updateOne(
      { $or: [{ draftId }, { gmailDraftId }] },
      { $set: { status: 'sent', sentAt: now, updatedAt: now } },
    );

    // 3. Odbij wysyłkę w CRM.
    //
    // Dwie rzeczy były tu zepsute. Po pierwsze status: `contacted` nie istniał
    // w żadnym słowniku, więc lead po wysyłce wypadał ze wszystkich kolumn
    // kanbana i znikał z tablicy. Po drugie `updateOne` bez upserta po cichu
    // nie robił nic, gdy leada nie było — z siedmiu wysłanych maili dwa nie
    // zostawiły w CRM ŻADNEGO śladu. To nie jest kosmetyka: dedup ofert pyta
    // właśnie CRM, więc mail bez wpisu to mail, który jutro wyjdzie drugi raz.
    let crmAction: 'updated' | 'created' | 'skipped_no_recipient' = 'skipped_no_recipient';
    if (recipientEmail && recipientEmail.includes('@')) {
      const nowDate = new Date();
      const history = {
        timestamp: nowDate,
        action: 'email_sent',
        description: `Wysłano email przez Splot OS: "${draft.title}"`,
        agentId: 'splot-outreach',
      } as any;

      const res = await db.collection('leads').updateOne(
        { email: recipientEmail },
        {
          $set: { status: CRM_SENT_STATUS, lastInteractionAt: nowDate, updatedAt: nowDate },
          $push: { history },
        },
      );
      crmAction = 'updated';

      if (res.matchedCount === 0) {
        // Wysyłka jest faktem — CRM ma go odzwierciedlać, nawet gdy nikt
        // wcześniej nie założył leada. Nazwa z domeny, segment 'other', wpis
        // oznaczony jako założony automatycznie, żeby dało się go odróżnić.
        const domain = recipientEmail.split('@')[1] ?? recipientEmail;
        await db.collection('leads').insertOne({
          id: randomUUID(),
          companyName: domain,
          email: recipientEmail,
          contactName: null,
          phone: null,
          segment: 'other',
          region: null,
          website: null,
          linkedIn: null,
          tags: ['auto-created'],
          status: CRM_SENT_STATUS,
          metadata: { autoCreatedFrom: 'splot-outreach', draftId: draft.draftId },
          history: [history],
          createdAt: nowDate,
          updatedAt: nowDate,
          lastInteractionAt: nowDate,
        } as any);
        crmAction = 'created';
        console.warn(
          `[sendDraftById] Wysłano do ${recipientEmail}, ale nie było leada w CRM — założono nowy.`,
        );
      }
    } else {
      console.warn(`[sendDraftById] Draft ${draftId} wysłany bez rozpoznanego adresata — brak wpisu w CRM.`);
    }

    return { success: true, draftId, crmAction };
  } catch (err: any) {
    return { success: false, draftId, error: `Błąd wysyłki Gmail: ${err.message}` };
  }
}

/**
 * Usuwa draft z Gmaila i z bazy danych.
 */
export async function deleteDraftById(draftId: string): Promise<{ success: boolean; error?: string }> {
  const db = await getDb();
  const draft = await getDraft(draftId);
  if (!draft) {
    return { success: false, error: 'Draft nie istnieje' };
  }

  const gmailDraftId = draft.gmailDraftId || draft.draftId.replace(/^gmail-/, '');
  const account = (draft.meta as any)?.enrichment?.account || 'personal';

  try {
    if (gmailDraftId) {
      const { GmailService } = await import('../tools/google/gmail.js');
      const gmail = await GmailService.create(account);
      await gmail.deleteDraft(gmailDraftId).catch(() => {});
    }
  } catch {}

  await db.collection('drafts').deleteOne({ $or: [{ draftId }, { gmailDraftId }] });
  return { success: true };
}

/**
 * Edycja treści draftu. Zapisuje ZARÓWNO do FS/MongoDB JAK I aktualizuje szkic w Gmail API.
 */
export async function updateDraftBody(
  draftId: string,
  body: string,
): Promise<WorkspaceDraft | null> {
  const existing = await getDraft(draftId);
  if (!existing) return null;

  if (existing.filePath) {
    await fs.writeFile(path.join(existing.filePath, 'draft.md'), body, 'utf-8').catch(() => {});
    try {
      const metaPath = path.join(existing.filePath, 'draft.meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as DraftMetadata;
      meta.charCount = body.length;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {}
  }

  const db = await getDb();
  const now = new Date().toISOString();
  let finalGmailDraftId = existing.gmailDraftId;

  // Zaktualizuj szkic bezpośrednio w Gmail API
  if (existing.gmailDraftId) {
    try {
      const { GmailService } = await import('../tools/google/gmail.js');
      const account = (existing.meta as any)?.enrichment?.account || (existing.meta as any)?.account || 'personal';
      const gmail = await GmailService.create(account);
      const updatedId = await gmail.updateDraft({
        draftId: existing.gmailDraftId,
        to: (existing.meta as any)?.enrichment?.email || existing.meta?.sourceContact || '',
        subject: existing.title,
        body,
        attachments: (existing.meta as any)?.enrichment?.attachments || (existing.meta as any)?.attachments,
      });
      if (updatedId) finalGmailDraftId = updatedId;
    } catch (gmailErr) {
      console.warn('[updateDraftBody] Błąd aktualizacji szkicu w Gmail API:', gmailErr);
    }
  }

  await db.collection('drafts').updateOne(
    { $or: [{ draftId }, { gmailDraftId: existing.gmailDraftId || draftId }] },
    { $set: { body, charCount: body.length, bodyHash: hashBody(body), gmailDraftId: finalGmailDraftId, updatedAt: now } },
  );

  return getDraft(draftId);
}

/** Zmiana statusu draftu (draft → approved → scheduled → sent → discarded). */
export async function setDraftStatus(draftId: string, status: string): Promise<WorkspaceDraft | null> {
  const existing = await getDraft(draftId);
  if (!existing) return null;
  const db = await getDb();
  const now = new Date().toISOString();
  await db
    .collection('drafts')
    .updateOne(
      { $or: [{ draftId }, { gmailDraftId: existing.gmailDraftId || draftId }] },
      { $set: { status, updatedAt: now } },
    );
  if (existing.filePath) {
    try {
      const metaPath = path.join(existing.filePath, 'draft.meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as DraftMetadata;
      meta.status = status;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {}
  }
  return getDraft(draftId);
}

/** Drafty social pogrupowane po tygodniu/dacie publikacji (do kalendarza). */
export async function getDraftsCalendar(): Promise<Record<string, WorkspaceDraft[]>> {
  const drafts = await listDrafts({ limit: 1000 });
  const social = drafts.filter(
    (d) => d.channel === 'linkedin' || d.channel === 'instagram' || d.channel === 'tiktok',
  );
  const byWeek: Record<string, WorkspaceDraft[]> = {};
  for (const d of social) {
    const key = d.weekStarting || (d.scheduledFor ? d.scheduledFor.slice(0, 10) : 'unscheduled');
    (byWeek[key] ??= []).push(d);
  }
  return byWeek;
}

