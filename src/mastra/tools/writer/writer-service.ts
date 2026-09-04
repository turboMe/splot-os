import { randomUUID } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { getDb, ensureWriterIndexes } from './db';
import { generateEmbedding, cosineSimilarity } from '../../lib/embedder';
import type { ContinuityIssue, WriterContinuityState } from './continuity-validator';
import { countForbiddenWriterEmDashes } from './anti-slop.js';
import { claimSuccessfulWorkerRunReceipt } from '../system/worker-run-receipts.js';

const embeddingService = {
  async generate(text: string): Promise<{ embedding: number[] }> {
    return { embedding: await generateEmbedding(text) };
  },
  cosineSimilarity,
};

export const WRITER_PROJECT_TYPES = ['fiction', 'article', 'blog', 'report'] as const;
export type WriterProjectType = typeof WRITER_PROJECT_TYPES[number];

export const WRITER_PIPELINE_STATUSES = [
  'intake',
  'detect',
  'setup_project',
  'world_build',
  'research',
  'source_verify',
  'claim_plan',
  'outline',
  'scene_drafts',
  'chronicler_pass',
  'section_write',
  'claim_verify',
  'critic_gate',
  'revision',
  'polish',
  'render',
  'done',
] as const;
export type WriterProjectStatus = typeof WRITER_PIPELINE_STATUSES[number];

export type WriterDeliverableLanguage = string;
export type WriterAutonomyMode = 'checkpointed' | 'full_auto';
export type WriterTaskMode = 'quick_write' | 'edit' | 'outline_only' | 'continue_project' | 'full_project';
export type WriterDial = 1 | 2 | 3 | 4 | 5;

export interface WriterStyleProfile {
  directness: WriterDial;
  warmth: WriterDial;
  personality: WriterDial;
  density: WriterDial;
  evidence: WriterDial;
  polish: WriterDial;
  rhythm?: WriterDial;
  formality?: WriterDial;
  sampleSource?: 'user_sample' | 'project_brief' | 'manual' | 'inferred';
  voiceSample?: string;
  signatureMarkers?: string[];
}

export interface WriterCanonPolicy {
  authorityOrder: Array<'user_brief' | 'story_bible' | 'outline' | 'runtime_continuity' | 'notes' | 'memory'>;
  allowContradictionsOnlyWithRevision: boolean;
}

export interface WriterProject {
  id: string;
  name: string;
  type: WriterProjectType;
  status: WriterProjectStatus;
  brief: string;
  deliverableLanguage: WriterDeliverableLanguage;
  workingLanguage: 'en';
  autonomyMode: WriterAutonomyMode;
  taskMode: WriterTaskMode;
  styleProfile: WriterStyleProfile;
  canonPolicy: WriterCanonPolicy;
  outlineVersion: number;
  manuscriptVersions: string[];
  currentManuscriptId?: string;
  /** Increments whenever an input to the final review contract changes. */
  reviewRevision: number;
  /** Increments for every persisted audit and fences concurrent finalization. */
  auditRevision: number;
  documentPath?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

export type WriterSectionKind = 'chapter' | 'scene' | 'section' | 'outline' | 'appendix' | 'notes';
export type WriterSectionStatus = 'planned' | 'drafted' | 'revised' | 'accepted' | 'archived';

export interface WriterSection {
  id: string;
  projectId: string;
  order: number;
  kind: WriterSectionKind;
  anchor: string;
  title: string;
  content?: string;
  summary?: string;
  status: WriterSectionStatus;
  wordCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WriterManuscript {
  id: string;
  projectId: string;
  version: number;
  title: string;
  format: 'markdown' | 'html';
  path?: string;
  content?: string;
  wordCount: number;
  auditIds: string[];
  isCurrent: boolean;
  createdAt: Date;
}

export interface WriterSource {
  id: string;
  projectId: string;
  url?: string;
  title: string;
  publisher?: string;
  author?: string;
  publishedAt?: string;
  accessedAt: string;
  extractedFacts: string[];
  reliability: 'high' | 'medium' | 'low' | 'unknown';
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WriterClaim {
  id: string;
  projectId: string;
  text: string;
  status: 'planned' | 'supported' | 'unsupported' | 'conflicting' | 'dropped';
  sourceIds: string[];
  sectionId?: string;
  risk: 'low' | 'medium' | 'high';
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WriterAudit {
  id: string;
  projectId: string;
  manuscriptId?: string;
  /** Project review contract revision evaluated by this audit. */
  reviewRevision: number;
  /** Monotonic per-project sequence assigned in the audit transaction. */
  auditRevision: number;
  kind: 'slop' | 'continuity' | 'claim' | 'critic' | 'reader' | 'polish' | 'revision';
  score?: number;
  ok?: boolean;
  summary?: string;
  issues?: Array<ContinuityIssue | Record<string, unknown>>;
  raw?: unknown;
  provenance?: 'deterministic' | 'worker' | 'manual';
  workerRunId?: string;
  workerOutputHash?: string;
  createdAt: Date;
}

export type SaveWriterAuditInput = Omit<
  WriterAudit,
  'id' | 'createdAt' | 'reviewRevision' | 'auditRevision' | 'workerOutputHash'
> & {
  /** Exact system_run_worker output; hashed against its one-use receipt. */
  workerOutput?: string;
  /** Revision captured before a deterministic audit read its inputs. */
  expectedReviewRevision?: number;
  /** Internal revision-decision path: atomically select this snapshot with the audit. */
  activateManuscriptId?: string;
  /** Current snapshot captured before the atomic revision decision. */
  expectedCurrentManuscriptId?: string;
};

export interface WriterNote {
  id: string;
  projectId?: string;
  type: 'research' | 'style' | 'feedback' | 'idea' | 'canon' | 'general';
  topic?: string;
  content: string;
  embedding?: number[];
  createdAt: Date;
  expiresAt?: Date;
}

export interface ClaimVerificationSummary {
  total: number;
  supported: number;
  unsupported: number;
  conflicting: number;
  highRiskUnsupported: number;
  ok: boolean;
}

type NewWriterSource = Omit<WriterSource, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'accessedAt' | 'extractedFacts' | 'reliability'> & {
  id?: string;
  accessedAt?: string;
  extractedFacts?: string[];
  reliability?: WriterSource['reliability'];
};
type NewWriterClaim = Omit<WriterClaim, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'sourceIds'> & {
  id?: string;
  sourceIds?: string[];
};

function defaultStyleProfile(overrides: Partial<WriterStyleProfile> = {}): WriterStyleProfile {
  return {
    directness: 3,
    warmth: 3,
    personality: 3,
    density: 3,
    evidence: 3,
    polish: 4,
    rhythm: 3,
    formality: 3,
    sampleSource: 'inferred',
    ...overrides,
  };
}

function defaultCanonPolicy(): WriterCanonPolicy {
  return {
    authorityOrder: ['user_brief', 'story_bible', 'outline', 'runtime_continuity', 'notes', 'memory'],
    allowContradictionsOnlyWithRevision: true,
  };
}

function countWords(text: string | undefined): number {
  return (text?.match(/[\p{L}\p{N}'-]+/gu) ?? []).length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Merge persisted writer state without turning Dates into `{}` or arrays into
 * sparse object maps. Only plain records are recursive; all other values are
 * replaced atomically.
 */
export function mergeWriterState<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result: Record<string, any> = { ...target };
  for (const key of Object.keys(source)) {
    const sourceValue = (source as Record<string, any>)[key];
    const targetValue = result[key];
    if (isPlainRecord(sourceValue) && isPlainRecord(targetValue)) {
      result[key] = mergeWriterState(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }
  return result as T;
}

const PROTECTED_PROJECT_PATCH_FIELDS = new Set([
  'id',
  'status',
  'currentManuscriptId',
  'manuscriptVersions',
  'reviewRevision',
  'auditRevision',
  'createdAt',
  'updatedAt',
]);

function flattenWriterProjectPatch(
  prefix: string,
  value: unknown,
  output: Record<string, unknown>,
): void {
  if (value === undefined) return;
  if (isPlainRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flattenWriterProjectPatch(`${prefix}.${key}`, nested, output);
    }
    return;
  }
  output[prefix] = value;
}

export function buildWriterProjectSetPatch(updates: Partial<WriterProject>): Record<string, unknown> {
  const output: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(updates)) {
    if (PROTECTED_PROJECT_PATCH_FIELDS.has(key)) {
      throw new Error(`Writer project field ${key} requires its dedicated authority-safe operation.`);
    }
    flattenWriterProjectPatch(key, value, output);
  }
  return output;
}

export interface WriterCompletionGateResult {
  ok: boolean;
  blockers: string[];
}

function auditTime(audit: WriterAudit): number {
  const createdAt = audit.createdAt instanceof Date ? audit.createdAt : new Date(audit.createdAt);
  const timestamp = createdAt.getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareAuditsNewestFirst(left: WriterAudit, right: WriterAudit): number {
  const leftRevision = Number.isInteger(left.auditRevision) ? left.auditRevision : undefined;
  const rightRevision = Number.isInteger(right.auditRevision) ? right.auditRevision : undefined;
  if (leftRevision !== undefined || rightRevision !== undefined) {
    if (leftRevision === undefined) return 1;
    if (rightRevision === undefined) return -1;
    if (leftRevision !== rightRevision) return rightRevision - leftRevision;
  }
  return auditTime(right) - auditTime(left);
}

function isCompositeQualityGateAudit(audit: WriterAudit): boolean {
  if (audit.kind !== 'critic' || !audit.raw || typeof audit.raw !== 'object') return false;
  const raw = audit.raw as { gate?: unknown; summary?: unknown; checks?: unknown };
  return audit.provenance === 'deterministic' && raw.gate === 'writer_quality_gate_v1' && Boolean(
    raw.summary && typeof raw.summary === 'object' && raw.checks && typeof raw.checks === 'object',
  );
}

function hasRequiredCompositeQualityPolicy(
  audit: WriterAudit,
  deliverableLanguage: WriterDeliverableLanguage,
): boolean {
  if (!audit.raw || typeof audit.raw !== 'object') return false;
  const policy = (audit.raw as { policy?: unknown }).policy;
  if (!policy || typeof policy !== 'object') return false;
  const value = policy as { language?: unknown; minSlopScore?: unknown };
  return value.language === deliverableLanguage
    && typeof value.minSlopScore === 'number'
    && value.minSlopScore >= 80;
}

function isAuthorizedGreenWriterGateAudit(
  audit: WriterAudit,
  project: Pick<WriterProject, 'deliverableLanguage'>,
): boolean {
  if (audit.ok !== true) return false;
  if (audit.kind === 'slop') return true;
  if (audit.kind === 'critic') {
    if (isCompositeQualityGateAudit(audit)) {
      return audit.provenance === 'deterministic'
        && hasRequiredCompositeQualityPolicy(audit, project.deliverableLanguage);
    }
    return audit.provenance === 'worker' && Boolean(audit.workerRunId);
  }
  if (audit.kind === 'reader' || audit.kind === 'polish') {
    return audit.provenance === 'worker' && Boolean(audit.workerRunId);
  }
  return audit.provenance === 'deterministic';
}

type VerifiedWorkerAuditKind = 'critic' | 'reader' | 'polish';

const VERIFIED_WORKER_AUDITS: Record<VerifiedWorkerAuditKind, {
  preset: 'writer_critic' | 'writer_reader' | 'writer_polisher';
  action: 'critic' | 'reader' | 'polisher';
}> = {
  critic: { preset: 'writer_critic', action: 'critic' },
  reader: { preset: 'writer_reader', action: 'reader' },
  polish: { preset: 'writer_polisher', action: 'polisher' },
};

function isVerifiedWorkerAuditKind(kind: WriterAudit['kind']): kind is VerifiedWorkerAuditKind {
  return kind === 'critic' || kind === 'reader' || kind === 'polish';
}

function parseWorkerJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  const parsed = JSON.parse(fenced);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Worker review must be one JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function evaluateWriterWorkerReview(
  kind: VerifiedWorkerAuditKind,
  output: string,
): { ok: boolean; score: number; raw: Record<string, unknown> } {
  const raw = parseWorkerJson(output);
  if (kind === 'critic') {
    const score = typeof raw.score === 'number' ? raw.score : -1;
    const briefCompliance = raw.briefCompliance && typeof raw.briefCompliance === 'object'
      ? raw.briefCompliance as { checked?: unknown; violations?: unknown }
      : undefined;
    const checked = Array.isArray(briefCompliance?.checked) ? briefCompliance.checked : [];
    const violations = Array.isArray(briefCompliance?.violations) ? briefCompliance.violations : undefined;
    return {
      ok: raw.overallVerdict === 'pass'
        && score >= 80 && score <= 100
        && checked.length > 0
        && violations?.length === 0,
      score: Math.max(0, Math.min(100, score)),
      raw,
    };
  }
  if (kind === 'reader') {
    const engagement = typeof raw.engagementScore === 'number' ? raw.engagementScore : -1;
    const flow = typeof raw.flowScore === 'number' ? raw.flowScore : -1;
    const score = Math.round((engagement + flow) / 2);
    return {
      ok: raw.recommendation === 'continue'
        && engagement >= 70 && engagement <= 100
        && flow >= 70 && flow <= 100,
      score: Math.max(0, Math.min(100, score)),
      raw,
    };
  }
  const ready = raw.finalReadiness === 'ready'
    && (raw.riskLevel === 'low' || raw.riskLevel === 'medium');
  return { ok: ready, score: ready ? 100 : 0, raw };
}

/**
 * Pure completion policy used both by the service and the domain regression
 * check. Quick writes and partial edits stay lightweight; a full project may
 * only become `done` after its deterministic and multi-perspective gates pass.
 */
export function evaluateWriterCompletionGate(
  project: Pick<
    WriterProject,
    'taskMode' | 'type' | 'deliverableLanguage' | 'currentManuscriptId' | 'reviewRevision'
  >,
  audits: WriterAudit[],
): WriterCompletionGateResult {
  if (project.taskMode !== 'full_project') return { ok: true, blockers: [] };

  const ordered = [...audits].sort(compareAuditsNewestFirst);
  const latest = (predicate: (audit: WriterAudit) => boolean): WriterAudit | undefined => ordered.find(predicate);
  const forCurrentManuscript = (audit: WriterAudit): boolean => (
    Boolean(project.currentManuscriptId) && audit.manuscriptId === project.currentManuscriptId
  );
  const currentReviewRevision = project.reviewRevision ?? 0;
  const forCurrentContract = (audit: WriterAudit): boolean => (
    (audit.reviewRevision ?? 0) === currentReviewRevision
  );
  const blockers: string[] = [];
  const requirePassing = (
    label: string,
    select: (audit: WriterAudit) => boolean,
    validate: (audit: WriterAudit) => boolean,
  ): void => {
    const audit = latest(select);
    if (!audit) blockers.push(`${label}: missing audit`);
    else if (!validate(audit)) blockers.push(`${label}: latest audit is not an authorized green result`);
  };

  requirePassing(
    'deterministic quality gate',
    (audit) => forCurrentManuscript(audit) && forCurrentContract(audit) && isCompositeQualityGateAudit(audit),
    (audit) => audit.ok === true
      && audit.provenance === 'deterministic'
      && hasRequiredCompositeQualityPolicy(audit, project.deliverableLanguage),
  );
  requirePassing(
    'independent critic review',
    (audit) => forCurrentManuscript(audit)
      && forCurrentContract(audit)
      && audit.kind === 'critic'
      && !isCompositeQualityGateAudit(audit),
    (audit) => audit.ok === true && audit.provenance === 'worker' && Boolean(audit.workerRunId),
  );
  requirePassing(
    'reader review',
    (audit) => forCurrentManuscript(audit) && forCurrentContract(audit) && audit.kind === 'reader',
    (audit) => audit.ok === true && audit.provenance === 'worker' && Boolean(audit.workerRunId),
  );
  requirePassing(
    'polish review',
    (audit) => forCurrentManuscript(audit) && forCurrentContract(audit) && audit.kind === 'polish',
    (audit) => audit.ok === true && audit.provenance === 'worker' && Boolean(audit.workerRunId),
  );

  if (project.type === 'fiction') {
    requirePassing(
      'continuity gate',
      (audit) => forCurrentManuscript(audit) && forCurrentContract(audit) && audit.kind === 'continuity',
      (audit) => audit.ok === true && audit.provenance === 'deterministic',
    );
  } else {
    requirePassing(
      'claim gate',
      (audit) => forCurrentManuscript(audit) && forCurrentContract(audit) && audit.kind === 'claim',
      (audit) => audit.ok === true && audit.provenance === 'deterministic',
    );
  }

  const latestRevision = latest((audit) => audit.kind === 'revision');
  if (latestRevision && (
    latestRevision.provenance !== 'deterministic'
    || latestRevision.ok !== true
    || !forCurrentManuscript(latestRevision)
    || !forCurrentContract(latestRevision)
  )) {
    blockers.push('revision decision: latest decision was not durably applied');
  }

  return { ok: blockers.length === 0, blockers };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class WriterService {
  private db: Db | null = null;
  private static indexesEnsured = false;

  private async getDb(): Promise<Db> {
    if (!this.db) {
      this.db = await getDb();
      if (!WriterService.indexesEnsured) {
        await ensureWriterIndexes(this.db).catch((err) =>
          console.warn('[WriterService] Index creation skipped:', err.message),
        );
        WriterService.indexesEnsured = true;
      }
    }
    return this.db;
  }

  async createProject(params: {
    id?: string;
    name: string;
    brief: string;
    type: WriterProjectType;
    deliverableLanguage?: WriterDeliverableLanguage;
    autonomyMode?: WriterAutonomyMode;
    taskMode?: WriterTaskMode;
    styleProfile?: Partial<WriterStyleProfile>;
    createdBy?: string;
  }): Promise<WriterProject> {
    const db = await this.getDb();
    const now = new Date();
    const project: WriterProject = {
      id: params.id || randomUUID(),
      name: params.name,
      type: params.type,
      status: 'intake',
      brief: params.brief,
      deliverableLanguage: params.deliverableLanguage ?? 'pl',
      workingLanguage: 'en',
      autonomyMode: params.autonomyMode ?? 'checkpointed',
      taskMode: params.taskMode ?? 'full_project',
      styleProfile: defaultStyleProfile(params.styleProfile),
      canonPolicy: defaultCanonPolicy(),
      outlineVersion: 0,
      manuscriptVersions: [],
      reviewRevision: 0,
      auditRevision: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
    };

    await db.collection<WriterProject>('writer_projects').insertOne(project);
    await db.collection<WriterContinuityState>('writer_continuity').updateOne(
      { projectId: project.id },
      { $set: { projectId: project.id, updatedAt: now } },
      { upsert: true },
    );
    return project;
  }

  async getProject(projectId: string): Promise<WriterProject | null> {
    const db = await this.getDb();
    return db.collection<WriterProject>('writer_projects').findOne({ id: projectId });
  }

  async listProjects(filter?: { status?: WriterProjectStatus; type?: WriterProjectType }, limit = 20): Promise<WriterProject[]> {
    const db = await this.getDb();
    const query: Record<string, unknown> = {};
    if (filter?.status) query.status = filter.status;
    if (filter?.type) query.type = filter.type;
    return db.collection<WriterProject>('writer_projects')
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Invalidates every audit made against the previous brief/style/ledger state.
   * Callers that mutate dependent collections pass a transaction session, so
   * the new revision and new dependency state become visible atomically.
   */
  private async bumpReviewRevision(
    projectId: string,
    suppliedDb?: Db,
    session?: ClientSession,
  ): Promise<void> {
    const db = suppliedDb ?? await this.getDb();
    const now = new Date();
    const updated = await db.collection<WriterProject>('writer_projects').updateOne(
      { id: projectId },
      [{
        $set: {
          reviewRevision: { $add: [{ $ifNull: ['$reviewRevision', 0] }, 1] },
          status: { $cond: [{ $eq: ['$status', 'done'] }, 'revision', '$status'] },
          updatedAt: now,
        },
      }],
      { session },
    );
    if (updated.matchedCount !== 1) throw new Error(`Writer project ${projectId} not found`);
  }

  async updateProject(projectId: string, updates: Partial<WriterProject>): Promise<WriterProject> {
    const db = await this.getDb();
    const patch = buildWriterProjectSetPatch(updates);
    const literalPatch = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, { $literal: value }]),
    );
    const updated = await db.collection<WriterProject>('writer_projects').findOneAndUpdate(
      { id: projectId },
      [{
        $set: {
          ...literalPatch,
          reviewRevision: { $add: [{ $ifNull: ['$reviewRevision', 0] }, 1] },
          status: { $cond: [{ $eq: ['$status', 'done'] }, 'revision', '$status'] },
        },
      }],
      { returnDocument: 'after' },
    );
    if (!updated) throw new Error(`Writer project ${projectId} not found`);
    return updated;
  }

  async updateProjectStatus(projectId: string, status: WriterProjectStatus): Promise<void> {
    if (!WRITER_PIPELINE_STATUSES.includes(status)) {
      throw new Error(`Invalid writer project status: ${status}`);
    }
    const project = await this.getProject(projectId);
    if (!project) throw new Error(`Writer project ${projectId} not found`);
    const db = await this.getDb();
    if (status === 'done') {
      if (project.taskMode === 'full_project') {
        const current = await this.getCurrentManuscript(projectId);
        const { writerDocumentRead } = await import('./writer-document-tools.js');
        const document = await writerDocumentRead(projectId);
        if (
          !current
          || !project.currentManuscriptId
          || current.id !== project.currentManuscriptId
          || typeof current.content !== 'string'
          || !document.success
          || document.content !== current.content
        ) {
          throw new Error(
            'Cannot mark full writer project as done. Snapshot the exact current manuscript, then rerun all final gates.',
          );
        }
      }
      const completionAudits = await this.listAudits(projectId, 100);
      const latestRevision = await db.collection<WriterAudit>('writer_audits').findOne(
        { projectId, kind: 'revision' },
        { sort: { auditRevision: -1, createdAt: -1 } },
      );
      if (latestRevision && !completionAudits.some((audit) => audit.id === latestRevision.id)) {
        completionAudits.push(latestRevision);
      }
      const completion = evaluateWriterCompletionGate(project, completionAudits);
      if (!completion.ok) {
        throw new Error(
          `Cannot mark full writer project as done. Resolve and rerun: ${completion.blockers.join('; ')}. ` +
          'Keep the project at critic_gate or revision and return the best artifact with explicit caveats.',
        );
      }
    }
    const expectedReviewRevision = project.reviewRevision ?? 0;
    const expectedAuditRevision = project.auditRevision ?? 0;
    const statusUpdate = await db.collection<WriterProject>('writer_projects').updateOne(
      status === 'done' && project.taskMode === 'full_project'
        ? {
            id: projectId,
            currentManuscriptId: project.currentManuscriptId,
            $expr: {
              $and: [
                { $eq: [{ $ifNull: ['$reviewRevision', 0] }, expectedReviewRevision] },
                { $eq: [{ $ifNull: ['$auditRevision', 0] }, expectedAuditRevision] },
              ],
            },
          }
        : { id: projectId },
      { $set: { status, updatedAt: new Date() } },
    );
    if (statusUpdate.matchedCount !== 1) {
      throw new Error(
        'Cannot finalize Writer project because its manuscript, review contract, or audits changed during finalization. Rerun all final gates.',
      );
    }
  }

  async upsertSection(params: {
    id?: string;
    projectId: string;
    order: number;
    kind: WriterSectionKind;
    anchor: string;
    title: string;
    content?: string;
    summary?: string;
    status?: WriterSectionStatus;
  }): Promise<WriterSection> {
    const emDashCount = countForbiddenWriterEmDashes([
      params.title,
      params.content ?? '',
      params.summary ?? '',
    ].join('\n'));
    if (emDashCount > 0) {
      throw new Error(
        `Forbidden U+2014 em dash found ${emDashCount} time(s). Rewrite the section without that punctuation.`,
      );
    }
    const db = await this.getDb();
    const now = new Date();
    const section: WriterSection = {
      id: params.id ?? randomUUID(),
      projectId: params.projectId,
      order: params.order,
      kind: params.kind,
      anchor: params.anchor,
      title: params.title,
      content: params.content,
      summary: params.summary,
      status: params.status ?? 'drafted',
      wordCount: countWords(params.content),
      createdAt: now,
      updatedAt: now,
    };

    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const existing = await db.collection<WriterSection>('writer_sections').findOne(
          { id: section.id },
          { projection: { projectId: 1 }, session },
        );
        if (existing && existing.projectId !== params.projectId) {
          throw new Error(`Writer section ${section.id} belongs to another project.`);
        }
        await this.bumpReviewRevision(params.projectId, db, session);
        await db.collection<WriterSection>('writer_sections').updateOne(
          { id: section.id, projectId: params.projectId },
          { $set: section },
          { upsert: true, session },
        );
      });
    } finally {
      await session.endSession();
    }
    return section;
  }

  async listSections(projectId: string): Promise<WriterSection[]> {
    const db = await this.getDb();
    return db.collection<WriterSection>('writer_sections')
      .find({ projectId })
      .sort({ order: 1 })
      .toArray();
  }

  async getLatestManuscriptVersion(projectId: string): Promise<number> {
    const db = await this.getDb();
    const latest = await db.collection<WriterManuscript>('writer_manuscripts')
      .findOne({ projectId }, { sort: { version: -1 }, projection: { version: 1 } });
    return latest?.version ?? 0;
  }

  async saveManuscriptSnapshot(params: {
    projectId: string;
    title: string;
    format: 'markdown' | 'html';
    path?: string;
    content?: string;
    version?: number;
    auditIds?: string[];
    isCurrent?: boolean;
  }): Promise<WriterManuscript> {
    const db = await this.getDb();
    const now = new Date();
    const manuscriptId = randomUUID();
    let manuscript: WriterManuscript | undefined;
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const project = await db.collection<WriterProject>('writer_projects').findOne(
          { id: params.projectId },
          { projection: { id: 1 }, session },
        );
        if (!project) throw new Error(`Writer project ${params.projectId} not found`);
        const latest = params.version === undefined
          ? await db.collection<WriterManuscript>('writer_manuscripts').findOne(
              { projectId: params.projectId },
              { sort: { version: -1 }, projection: { version: 1 }, session },
            )
          : undefined;
        const version = params.version ?? ((latest?.version ?? 0) + 1);
        manuscript = {
          id: manuscriptId,
          projectId: params.projectId,
          version,
          title: params.title,
          format: params.format,
          path: params.path,
          content: params.content,
          wordCount: countWords(params.content),
          auditIds: params.auditIds ?? [],
          isCurrent: params.isCurrent ?? true,
          createdAt: now,
        };

        const projectUpdate = manuscript.isCurrent
          ? await db.collection<WriterProject>('writer_projects').updateOne(
              { id: params.projectId },
              [{
                $set: {
                  currentManuscriptId: manuscript.id,
                  status: { $cond: [{ $eq: ['$status', 'done'] }, 'revision', '$status'] },
                  updatedAt: now,
                  manuscriptVersions: {
                    $concatArrays: [{ $ifNull: ['$manuscriptVersions', []] }, [manuscript.id]],
                  },
                },
              }],
              { session },
            )
          : await db.collection<WriterProject>('writer_projects').updateOne(
              { id: params.projectId },
              {
                $set: { updatedAt: now },
                $push: { manuscriptVersions: manuscript.id } as any,
              },
              { session },
            );
        if (projectUpdate.matchedCount !== 1) {
          throw new Error(`Writer project ${params.projectId} disappeared while saving its snapshot`);
        }
        if (manuscript.isCurrent) {
          await db.collection<WriterManuscript>('writer_manuscripts').updateMany(
            { projectId: params.projectId, isCurrent: true },
            { $set: { isCurrent: false } },
            { session },
          );
        }
        await db.collection<WriterManuscript>('writer_manuscripts').insertOne(manuscript, { session });
      });
    } finally {
      await session.endSession();
    }
    if (!manuscript) throw new Error(`Writer snapshot for ${params.projectId} did not commit`);
    return manuscript;
  }

  async getManuscript(manuscriptId: string): Promise<WriterManuscript | null> {
    const db = await this.getDb();
    return db.collection<WriterManuscript>('writer_manuscripts').findOne({ id: manuscriptId });
  }

  async setManuscriptPath(projectId: string, manuscriptId: string, snapshotPath: string): Promise<void> {
    const db = await this.getDb();
    const updated = await db.collection<WriterManuscript>('writer_manuscripts').updateOne(
      { id: manuscriptId, projectId },
      { $set: { path: snapshotPath } },
    );
    if (updated.matchedCount !== 1) {
      throw new Error(`Writer manuscript ${manuscriptId} does not belong to project ${projectId}`);
    }
  }

  async getCurrentManuscript(projectId: string): Promise<WriterManuscript | null> {
    const db = await this.getDb();
    return db.collection<WriterManuscript>('writer_manuscripts').findOne({ projectId, isCurrent: true });
  }

  async markCurrentManuscript(projectId: string, manuscriptId: string): Promise<void> {
    const db = await this.getDb();
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const target = await db.collection<WriterManuscript>('writer_manuscripts').findOne(
          { id: manuscriptId, projectId },
          { projection: { id: 1 }, session },
        );
        if (!target) throw new Error(`Writer manuscript ${manuscriptId} does not belong to project ${projectId}`);
        await db.collection<WriterManuscript>('writer_manuscripts').updateMany(
          { projectId, isCurrent: true, id: { $ne: manuscriptId } },
          { $set: { isCurrent: false } },
          { session },
        );
        const targetUpdate = await db.collection<WriterManuscript>('writer_manuscripts').updateOne(
          { id: manuscriptId, projectId },
          { $set: { isCurrent: true } },
          { session },
        );
        if (targetUpdate.matchedCount !== 1) {
          throw new Error(`Writer manuscript ${manuscriptId} disappeared during activation`);
        }
        const projectUpdate = await db.collection<WriterProject>('writer_projects').updateOne(
          { id: projectId },
          [{
            $set: {
              currentManuscriptId: manuscriptId,
              status: {
                $cond: [
                  { $and: [{ $eq: ['$status', 'done'] }, { $ne: ['$currentManuscriptId', manuscriptId] }] },
                  'revision',
                  '$status',
                ],
              },
              updatedAt: new Date(),
            },
          }],
          { session },
        );
        if (projectUpdate.matchedCount !== 1) throw new Error(`Writer project ${projectId} not found`);
      });
    } finally {
      await session.endSession();
    }
  }

  /**
   * A document edit makes the previously snapshotted/reviewed manuscript stale.
   * Clear that authority before writing the new bytes so a failed DB update can
   * never leave an unreviewed file advertised as the current final snapshot.
   */
  async invalidateCurrentManuscript(projectId: string): Promise<void> {
    const db = await this.getDb();
    const now = new Date();
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const projectUpdate = await db.collection<WriterProject>('writer_projects').updateOne(
          { id: projectId },
          [{
            $set: {
              currentManuscriptId: '$$REMOVE',
              status: { $cond: [{ $eq: ['$status', 'done'] }, 'revision', '$status'] },
              updatedAt: now,
            },
          }],
          { session },
        );
        if (projectUpdate.matchedCount !== 1) throw new Error(`Writer project ${projectId} not found`);
        await db.collection<WriterManuscript>('writer_manuscripts').updateMany(
          { projectId, isCurrent: true },
          { $set: { isCurrent: false } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  async upsertContinuity(projectId: string, patch: Partial<WriterContinuityState>): Promise<WriterContinuityState> {
    const db = await this.getDb();
    let next: WriterContinuityState | undefined;
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await db.collection<WriterContinuityState>('writer_continuity').findOne(
          { projectId },
          { session },
        );
        next = mergeWriterState<WriterContinuityState>(
          current ?? { projectId, updatedAt: new Date() },
          { ...patch, projectId, updatedAt: new Date() },
        );
        await this.bumpReviewRevision(projectId, db, session);
        await db.collection<WriterContinuityState>('writer_continuity').updateOne(
          { projectId },
          { $set: next },
          { upsert: true, session },
        );
      });
    } finally {
      await session.endSession();
    }
    if (!next) throw new Error(`Writer continuity update for ${projectId} did not commit`);
    return next;
  }

  async getContinuity(projectId: string): Promise<WriterContinuityState | null> {
    const db = await this.getDb();
    return db.collection<WriterContinuityState>('writer_continuity').findOne({ projectId });
  }

  async addSources(projectId: string, sources: NewWriterSource[]): Promise<WriterSource[]> {
    const db = await this.getDb();
    const now = new Date();
    const fullSources = sources.map((source) => ({
      ...source,
      id: source.id ?? randomUUID(),
      projectId,
      accessedAt: source.accessedAt ?? now.toISOString(),
      reliability: source.reliability ?? 'unknown',
      extractedFacts: source.extractedFacts ?? [],
      createdAt: now,
      updatedAt: now,
    } satisfies WriterSource));

    if (fullSources.length > 0) {
      const session = db.client.startSession();
      try {
        await session.withTransaction(async () => {
          for (const source of fullSources) {
            const existing = await db.collection<WriterSource>('writer_sources').findOne(
              { id: source.id },
              { projection: { projectId: 1 }, session },
            );
            if (existing && existing.projectId !== projectId) {
              throw new Error(`Writer source ${source.id} belongs to another project.`);
            }
          }
          await this.bumpReviewRevision(projectId, db, session);
          for (const source of fullSources) {
            await db.collection<WriterSource>('writer_sources').updateOne(
              { id: source.id, projectId },
              { $set: source },
              { upsert: true, session },
            );
          }
        });
      } finally {
        await session.endSession();
      }
    }
    return fullSources;
  }

  async listSources(projectId: string): Promise<WriterSource[]> {
    const db = await this.getDb();
    return db.collection<WriterSource>('writer_sources').find({ projectId }).sort({ updatedAt: -1 }).toArray();
  }

  async upsertClaims(projectId: string, claims: NewWriterClaim[]): Promise<WriterClaim[]> {
    const db = await this.getDb();
    const now = new Date();
    const fullClaims = claims.map((claim) => ({
      ...claim,
      id: claim.id ?? randomUUID(),
      projectId,
      sourceIds: claim.sourceIds ?? [],
      createdAt: now,
      updatedAt: now,
    } satisfies WriterClaim));

    if (fullClaims.length > 0) {
      const session = db.client.startSession();
      try {
        await session.withTransaction(async () => {
          for (const claim of fullClaims) {
            const existing = await db.collection<WriterClaim>('writer_claims').findOne(
              { id: claim.id },
              { projection: { projectId: 1 }, session },
            );
            if (existing && existing.projectId !== projectId) {
              throw new Error(`Writer claim ${claim.id} belongs to another project.`);
            }
          }
          await this.bumpReviewRevision(projectId, db, session);
          for (const claim of fullClaims) {
            await db.collection<WriterClaim>('writer_claims').updateOne(
              { id: claim.id, projectId },
              { $set: claim },
              { upsert: true, session },
            );
          }
        });
      } finally {
        await session.endSession();
      }
    }
    return fullClaims;
  }

  async listClaims(projectId: string, filter?: { status?: WriterClaim['status']; risk?: WriterClaim['risk'] }): Promise<WriterClaim[]> {
    const db = await this.getDb();
    const query: Record<string, unknown> = { projectId };
    if (filter?.status) query.status = filter.status;
    if (filter?.risk) query.risk = filter.risk;
    return db.collection<WriterClaim>('writer_claims').find(query).sort({ updatedAt: -1 }).toArray();
  }

  async verifyClaims(projectId: string): Promise<ClaimVerificationSummary> {
    const claims = await this.listClaims(projectId);
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

  async saveAudit(params: SaveWriterAuditInput): Promise<WriterAudit> {
    const db = await this.getDb();
    const projectForAudit = await db.collection<WriterProject>('writer_projects').findOne({
      id: params.projectId,
    });
    if (!projectForAudit) throw new Error(`Writer project ${params.projectId} not found`);
    const capturedReviewRevision = projectForAudit.reviewRevision ?? 0;
    if (
      params.expectedReviewRevision !== undefined
      && params.expectedReviewRevision !== capturedReviewRevision
    ) {
      throw new Error(
        'Writer review contract changed while the audit was running. Recompute the audit from current inputs.',
      );
    }
    const id = randomUUID();
    const {
      workerOutput,
      expectedReviewRevision: _expectedReviewRevision,
      activateManuscriptId,
      expectedCurrentManuscriptId,
      provenance: requestedProvenance,
      ...persisted
    } = params;
    let provenance: WriterAudit['provenance'] = requestedProvenance ?? 'manual';
    let verifiedRaw = persisted.raw;
    let verifiedScore = persisted.score;
    let verifiedOk = persisted.ok;
    let pendingWorkerClaim: Omit<
      Parameters<typeof claimSuccessfulWorkerRunReceipt>[0],
      'session'
    > | undefined;

    const hasWorkerEvidence = Boolean(persisted.workerRunId || workerOutput);
    if (activateManuscriptId && (
      persisted.kind !== 'revision'
      || activateManuscriptId !== persisted.manuscriptId
      || requestedProvenance !== 'deterministic'
    )) {
      throw new Error('Atomic manuscript activation is only valid for its deterministic revision audit.');
    }
    if (activateManuscriptId && !expectedCurrentManuscriptId) {
      throw new Error('Atomic revision activation requires expectedCurrentManuscriptId.');
    }
    const requiresCurrentManuscript = isVerifiedWorkerAuditKind(persisted.kind)
      || persisted.kind === 'revision';
    if (projectForAudit.taskMode === 'full_project' && requiresCurrentManuscript) {
      if (!persisted.manuscriptId) {
        throw new Error(`A full-project ${persisted.kind} audit requires the current manuscriptId.`);
      }
      if (!activateManuscriptId && projectForAudit.currentManuscriptId !== persisted.manuscriptId) {
        throw new Error(`The ${persisted.kind} review is stale; its manuscript is not current.`);
      }
    }
    if (isVerifiedWorkerAuditKind(persisted.kind) && hasWorkerEvidence) {
      if (requestedProvenance === 'deterministic') {
        throw new Error('A deterministic audit cannot also claim worker evidence.');
      }
      if (!persisted.workerRunId || !workerOutput) {
        throw new Error(
          `A ${persisted.kind} worker audit requires workerRunId and the exact system_run_worker output.`,
        );
      }
      if (!persisted.manuscriptId) {
        throw new Error(`A passing ${persisted.kind} audit requires the reviewed manuscriptId.`);
      }
      const currentManuscript = await this.getCurrentManuscript(persisted.projectId);
      if (!currentManuscript || currentManuscript.id !== persisted.manuscriptId) {
        throw new Error(`The ${persisted.kind} review is stale; its manuscript is not current.`);
      }
      const evaluated = evaluateWriterWorkerReview(persisted.kind, workerOutput);
      const expected = VERIFIED_WORKER_AUDITS[persisted.kind];
      pendingWorkerClaim = {
        workerRunId: persisted.workerRunId,
        preset: expected.preset,
        correlation: {
          domain: 'writer',
          entityId: persisted.projectId,
          action: expected.action,
          subjectId: persisted.manuscriptId,
          contractRevision: capturedReviewRevision,
        },
        output: workerOutput,
        consumedBy: id,
      };
      provenance = 'worker';
      verifiedRaw = evaluated.raw;
      verifiedScore = evaluated.score;
      verifiedOk = evaluated.ok;
    } else if (
      isVerifiedWorkerAuditKind(persisted.kind)
      && persisted.ok === true
      && requestedProvenance !== 'deterministic'
    ) {
      throw new Error(
        `A passing ${persisted.kind} audit requires workerRunId and the exact system_run_worker output.`,
      );
    }

    const audit: WriterAudit = {
      ...persisted,
      ok: verifiedOk,
      score: verifiedScore,
      raw: verifiedRaw,
      provenance,
      reviewRevision: capturedReviewRevision,
      auditRevision: 0,
      id,
      createdAt: new Date(),
    };
    const reopenDone = Boolean(audit.manuscriptId)
      && !isAuthorizedGreenWriterGateAudit(audit, projectForAudit);
    // Receipt consumption, audit persistence, and the project audit fence are
    // one authority change. A transient insert failure rolls all three back;
    // a concurrent dependency mutation or snapshot switch rejects the audit.
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        if (activateManuscriptId) {
          const target = await db.collection<WriterManuscript>('writer_manuscripts').findOne(
            { id: activateManuscriptId, projectId: persisted.projectId },
            { projection: { id: 1 }, session },
          );
          if (!target) {
            throw new Error(`Writer manuscript ${activateManuscriptId} does not belong to this project.`);
          }
          await db.collection<WriterManuscript>('writer_manuscripts').updateMany(
            { projectId: persisted.projectId, isCurrent: true, id: { $ne: activateManuscriptId } },
            { $set: { isCurrent: false } },
            { session },
          );
          const targetUpdate = await db.collection<WriterManuscript>('writer_manuscripts').updateOne(
            { id: activateManuscriptId, projectId: persisted.projectId },
            { $set: { isCurrent: true } },
            { session },
          );
          if (targetUpdate.matchedCount !== 1) {
            throw new Error(`Writer manuscript ${activateManuscriptId} disappeared during revision activation.`);
          }
        }
        const projectUpdate = await db.collection<WriterProject>('writer_projects').findOneAndUpdate(
          {
            id: persisted.projectId,
            ...(activateManuscriptId
              ? { currentManuscriptId: expectedCurrentManuscriptId }
              : persisted.manuscriptId
              ? { currentManuscriptId: persisted.manuscriptId }
              : {}),
            $expr: {
              $eq: [{ $ifNull: ['$reviewRevision', 0] }, capturedReviewRevision],
            },
          },
          [{
            $set: {
              auditRevision: { $add: [{ $ifNull: ['$auditRevision', 0] }, 1] },
              currentManuscriptId: activateManuscriptId ?? '$currentManuscriptId',
              status: activateManuscriptId
                ? 'revision'
                : reopenDone
                ? {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$status', 'done'] },
                          { $eq: ['$currentManuscriptId', audit.manuscriptId] },
                        ],
                      },
                      'revision',
                      '$status',
                    ],
                  }
                : '$status',
              updatedAt: audit.createdAt,
            },
          }],
          { returnDocument: 'after', session },
        );
        if (!projectUpdate) {
          throw new Error(
            'Writer review contract or current manuscript changed while saving the audit. Prepare and run a fresh review.',
          );
        }
        audit.auditRevision = projectUpdate.auditRevision ?? 0;
        if (pendingWorkerClaim) {
          const claimed = await claimSuccessfulWorkerRunReceipt({
            ...pendingWorkerClaim,
            session,
          });
          if (!claimed.ok) throw new Error(claimed.error);
          audit.workerOutputHash = claimed.outputHash;
        }
        await db.collection<WriterAudit>('writer_audits').insertOne(audit, { session });
      });
    } finally {
      await session.endSession();
    }
    return audit;
  }

  async listAudits(projectId: string, limit = 10): Promise<WriterAudit[]> {
    const db = await this.getDb();
    return db.collection<WriterAudit>('writer_audits')
      .find({ projectId })
      .sort({ auditRevision: -1, createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async addNote(params: {
    content: string;
    type?: WriterNote['type'];
    topic?: string;
    projectId?: string;
    expiresAt?: Date;
  }): Promise<WriterNote> {
    const db = await this.getDb();

    let embedding: number[] | undefined;
    try {
      const textToEmbed = `${params.topic ? params.topic + ': ' : ''}${params.content}`;
      const result = await embeddingService.generate(textToEmbed);
      embedding = result.embedding;
    } catch {
      // Embedding is optional; regex fallback keeps notes useful offline.
    }

    const note: WriterNote = {
      id: randomUUID(),
      projectId: params.projectId,
      type: params.type ?? 'general',
      topic: params.topic,
      content: params.content,
      embedding,
      createdAt: new Date(),
      expiresAt: params.expiresAt,
    };
    await db.collection<WriterNote>('writer_notes').insertOne(note);
    return note;
  }

  async searchNotes(query: string, projectId?: string, limit = 5): Promise<WriterNote[]> {
    const db = await this.getDb();

    try {
      const result = await embeddingService.generate(query);
      const queryEmbedding = result.embedding;
      const filter: Record<string, unknown> = { embedding: { $exists: true } };
      if (projectId) filter.projectId = projectId;

      const allNotes = await db.collection<WriterNote>('writer_notes').find(filter).toArray();
      const scored = allNotes
        .map((note) => ({
          note,
          score: embeddingService.cosineSimilarity(queryEmbedding, note.embedding!),
        }))
        .filter((entry) => entry.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length > 0) return scored.map((entry) => entry.note);
    } catch {
      // Embedding unavailable; fall through to regex search.
    }

    const safeQuery = escapeRegex(query);
    const filter: Record<string, unknown> = {
      $or: [
        { content: { $regex: safeQuery, $options: 'i' } },
        { topic: { $regex: safeQuery, $options: 'i' } },
      ],
    };
    if (projectId) filter.projectId = projectId;
    return db.collection<WriterNote>('writer_notes')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }
}
