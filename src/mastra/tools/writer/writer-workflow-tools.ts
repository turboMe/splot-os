import { createHash } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { auditSlop, countForbiddenWriterEmDashes } from './anti-slop.js';
import { validateContinuity } from './continuity-validator.js';
import {
  WriterService,
  type ClaimVerificationSummary,
  type WriterClaim,
  type WriterProject,
  type WriterSource,
} from './writer-service.js';
import type { WorkerTaskSpecInput } from '../system/worker-task-spec.js';
import { issueWorkerReviewRequest } from '../system/worker-run-receipts.js';

const sourceCardSchema = z.object({
  id: z.string().optional(),
  url: z.string().optional(),
  title: z.string().min(1),
  publisher: z.string().optional(),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  accessedAt: z.string().optional(),
  extractedFacts: z.array(z.string()).optional().default([]),
  reliability: z.enum(['high', 'medium', 'low', 'unknown']).optional().default('unknown'),
  notes: z.string().optional(),
});

const researchClaimSchema = z.object({
  id: z.string().optional(),
  text: z.string().min(1),
  status: z.enum(['planned', 'supported', 'unsupported', 'conflicting', 'dropped']).optional(),
  sourceIds: z.array(z.string()).optional().default([]),
  sourceRefs: z.array(z.string()).optional().default([]),
  sectionId: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  notes: z.string().optional(),
});

const qualitySummarySchema = z.object({
  ok: z.boolean(),
  slopScore: z.number().min(0).max(100).optional(),
  continuityCritical: z.number().int().min(0).optional(),
  continuityHigh: z.number().int().min(0).optional(),
  highRiskUnsupported: z.number().int().min(0).optional(),
  conflictingClaims: z.number().int().min(0).optional(),
  blockingIssueCount: z.number().int().min(0).optional(),
});

type SourceCardInput = z.input<typeof sourceCardSchema>;
type ResearchClaimInput = z.input<typeof researchClaimSchema>;
type QualitySummaryInput = z.infer<typeof qualitySummarySchema>;

export interface WriterQualityCheckSelection {
  includeSlop: boolean;
  includeContinuity: boolean;
  includeClaims: boolean;
}

export function resolveWriterQualityChecks(
  project: Pick<WriterProject, 'taskMode' | 'type'>,
  requested: Partial<WriterQualityCheckSelection> = {},
): WriterQualityCheckSelection {
  const fullProject = project.taskMode === 'full_project';
  return {
    includeSlop: fullProject || (requested.includeSlop ?? true),
    includeContinuity:
      (fullProject && project.type === 'fiction') ||
      (requested.includeContinuity ?? project.type === 'fiction'),
    includeClaims:
      (fullProject && project.type !== 'fiction') ||
      (requested.includeClaims ?? project.type !== 'fiction'),
  };
}

type NormalizedSourceCard = Omit<SourceCardInput, 'id' | 'extractedFacts' | 'reliability'> & {
  id: string;
  extractedFacts: string[];
  reliability: WriterSource['reliability'];
};

export interface ResearchDelegationPlan {
  targetAgent: 'researcherAgent';
  callerAgentId: 'writerAgent';
  taskSpec: WorkerTaskSpecInput;
  nextStep: string;
}

export interface BuildResearchTaskSpecParams {
  projectId: string;
  projectName?: string;
  projectBrief?: string;
  projectType?: string;
  deliverableLanguage?: string;
  researchGoal: string;
  questions?: string[];
  expectedSourceCount?: number;
  focus?: string;
}

export interface NormalizedResearchLedgers {
  sources: NormalizedSourceCard[];
  claims: Array<Omit<ResearchClaimInput, 'sourceRefs' | 'status' | 'risk'> & {
    status: WriterClaim['status'];
    sourceIds: string[];
    risk: WriterClaim['risk'];
  }>;
  sourceIdMap: Record<string, string>;
  unresolvedSourceRefs: string[];
}

export interface RevisionDecision {
  decision: 'accept_revision' | 'keep_previous' | 'needs_human_review';
  netImprovement: number;
  beforePenalty: number;
  afterPenalty: number;
  reasons: string[];
}

type WorkerReviewRole = 'critic' | 'reader' | 'muse' | 'chronicler' | 'polisher';
const COMPLETION_REVIEW_ROLES = new Set<WorkerReviewRole>(['critic', 'reader', 'polisher']);

export function authoritativeWriterReviewModifierError(params: {
  role: WorkerReviewRole;
  focus?: string;
  sectionRefs?: string[];
  previousFindings?: string;
}): string | null {
  if (!COMPLETION_REVIEW_ROLES.has(params.role)) return null;
  if (
    Boolean(params.focus?.trim())
    || (params.sectionRefs?.length ?? 0) > 0
    || Boolean(params.previousFindings?.trim())
  ) {
    return (
      'Final critic, reader, and polisher receipts must review the whole current manuscript ' +
      'with the canonical brief; focus, sectionRefs, and previousFindings are advisory-only modifiers.'
    );
  }
  return null;
}

const WORKER_PRESETS: Record<WorkerReviewRole, 'writer_critic' | 'writer_reader' | 'writer_muse' | 'writer_chronicler' | 'writer_polisher'> = {
  critic: 'writer_critic',
  reader: 'writer_reader',
  muse: 'writer_muse',
  chronicler: 'writer_chronicler',
  polisher: 'writer_polisher',
};

const WORKER_OUTPUT_SCHEMAS: Record<WorkerReviewRole, string> = {
  critic: JSON.stringify({
    overallVerdict: 'pass|revise|block',
    score: '0-100',
    briefCompliance: {
      checked: ['explicit brief invariant and where it was checked'],
      violations: [{ constraint: 'violated invariant', location: 'chapter/section', evidence: 'specific evidence' }],
    },
    findings: [{
      severity: 'low|medium|high|critical',
      area: 'voice|structure|continuity|factual_integrity|style|reader_experience',
      location: 'section/chapter/paragraph reference',
      issue: 'specific problem',
      whyItMatters: 'effect on the reader or contract',
      suggestedFix: 'actionable direction, not a full rewrite',
    }],
    strengths: ['specific strength'],
    revisionPriorities: ['highest leverage fix first'],
  }),
  reader: JSON.stringify({
    readerProfile: 'short description',
    engagementScore: '0-100',
    flowScore: '0-100',
    confusionPoints: [{
      location: 'section/chapter/paragraph reference',
      confusion: 'what the reader cannot infer',
      likelyReaction: 'how the reader feels',
    }],
    highEngagementMoments: ['specific moment'],
    dropOffRisks: ['specific risk'],
    questionsRaised: ['reader question'],
    payoffsFelt: ['payoff that lands'],
    recommendation: 'continue|revise|block',
  }),
  muse: JSON.stringify({
    alternatives: [{
      angle: 'name of option',
      rationale: 'why it may improve the work',
      tradeoffs: ['risk or cost'],
      sampleMove: 'short example or structural move',
    }],
    strongestOption: 'option name',
    doNotUse: ['idea that would violate brief, canon, or factual constraints'],
  }),
  chronicler: JSON.stringify({
    continuityPatch: {
      characters: [{ id: 'character-id', name: 'name', aliases: [], status: 'alive|dead|missing|unknown', lastSeenSectionId: 'writer section id', deathSectionId: 'writer section id when applicable', notes: 'durable facts' }],
      timeline: [{ id: 'event-id', label: 'event', order: 1, date: 'story date if explicit', sectionId: 'writer section id' }],
      promises: [{ id: 'promise-id', text: 'obligation', status: 'open|paid_off|dropped', setupSectionId: 'writer section id', payoffSectionId: 'writer section id when applicable', setupOrder: 1, payoffOrder: 4 }],
      questions: [{ id: 'question-id', text: 'story question', status: 'open|answered|dropped', openedSectionId: 'writer section id', answeredSectionId: 'writer section id when applicable', openedOrder: 1, answeredOrder: 4 }],
      glossary: [{ term: 'term', definition: 'stable definition' }],
    },
    newCanon: ['durable fact to persist'],
    possibleConflicts: [{
      severity: 'low|medium|high|critical',
      issue: 'potential canon conflict',
      affectedEntity: 'character/place/timeline/promise',
    }],
  }),
  polisher: JSON.stringify({
    summary: 'what the polish changes',
    riskLevel: 'low|medium|high',
    changes: [{
      location: 'section/chapter/paragraph reference',
      issue: 'style or clarity issue',
      suggestedReplacement: 'replacement text or precise instruction',
      reason: 'why this improves the text',
    }],
    doNotChange: ['meaning/citation/canon item to preserve'],
    finalReadiness: 'ready|needs_revision|blocked',
  }),
};

function stableWriterId(prefix: string, projectId: string, value: string): string {
  const hash = createHash('sha1')
    .update(`${projectId}:${value}`)
    .digest('hex')
    .slice(0, 18);
  return `${prefix}_${hash}`;
}

function addAlias(map: Map<string, string>, key: string | undefined, value: string): void {
  const normalized = key?.trim();
  if (normalized) map.set(normalized, value);
}

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}'-]+/gu) ?? []).length;
}

function qualityPenalty(summary: QualitySummaryInput): number {
  const slopPenalty = summary.slopScore === undefined ? 0 : Math.max(0, 100 - summary.slopScore);
  return (
    slopPenalty +
    (summary.continuityCritical ?? 0) * 45 +
    (summary.continuityHigh ?? 0) * 30 +
    (summary.highRiskUnsupported ?? 0) * 45 +
    (summary.conflictingClaims ?? 0) * 35 +
    (summary.blockingIssueCount ?? 0) * 20
  );
}

function summarizeClaimVerification(summary: ClaimVerificationSummary): string {
  if (summary.ok) return 'Claim verification passed.';
  return [
    `Claim verification blocked: ${summary.highRiskUnsupported} high-risk unsupported claim(s)`,
    `${summary.conflicting} conflicting claim(s)`,
    `${summary.unsupported} total unsupported claim(s)`,
  ].join(', ') + '.';
}

async function readCurrentManuscript(projectId: string): Promise<string> {
  const { writerDocumentRead } = await import('./writer-document-tools.js');
  const result = await writerDocumentRead(projectId);
  if (!result.success || result.content === undefined) {
    throw new Error(result.error ?? 'Unable to read writer manuscript.');
  }
  return result.content;
}

export function buildResearchTaskSpec(params: BuildResearchTaskSpecParams): ResearchDelegationPlan {
  const sourceCount = params.expectedSourceCount ?? 8;
  const questions = params.questions?.filter(Boolean) ?? [];

  const taskSpec: WorkerTaskSpecInput = {
    goal: params.researchGoal,
    context: [
      `Writer project: ${params.projectName ?? params.projectId}`,
      `Project type: ${params.projectType ?? 'factual writing'}`,
      `Project brief: ${params.projectBrief ?? '(not provided)'}`,
      params.focus ? `Research focus: ${params.focus}` : undefined,
      'Return facts for a writer source ledger and claim ledger. Do not write the article/report.',
    ].filter(Boolean).join('\n'),
    inputs: [
      { name: 'projectId', value: params.projectId, source: 'runtime' },
      { name: 'researchGoal', value: params.researchGoal, source: 'derived' },
      { name: 'questions', value: questions, source: 'derived' },
    ],
    outputContract: {
      format: 'json',
      schema: JSON.stringify({
        researchSummary: 'short synthesis of what the sources establish',
        sources: [{
          id: 'stable local source key like source-1',
          url: 'canonical URL when available',
          title: 'source title',
          publisher: 'publisher or organization',
          author: 'author when available',
          publishedAt: 'ISO date or source-visible date when available',
          accessedAt: 'ISO date if known',
          extractedFacts: ['fact explicitly supported by this source'],
          reliability: 'high|medium|low|unknown',
          notes: 'conflicts, limitations, or caveats',
        }],
        claims: [{
          text: 'claim the writer may use',
          status: 'supported|unsupported|conflicting|planned|dropped',
          sourceIds: ['source-1'],
          risk: 'low|medium|high',
          notes: 'why this claim is safe or risky',
        }],
        conflicts: [{
          topic: 'conflicting point',
          sourceIds: ['source-1', 'source-2'],
          explanation: 'what conflicts and how to handle it',
        }],
      }),
      example: '{"researchSummary":"...","sources":[{"id":"source-1","title":"...","url":"...","extractedFacts":["..."],"reliability":"high"}],"claims":[{"text":"...","status":"supported","sourceIds":["source-1"],"risk":"medium"}],"conflicts":[]}',
    },
    scope: {
      inScope: [
        'Search and deep-read current/public sources relevant to the goal.',
        `Return about ${sourceCount} source cards unless the topic needs fewer high-quality sources.`,
        'Extract source-supported facts and candidate claims for the writer claim ledger.',
        'Flag conflicts, low-quality sources, and missing evidence.',
      ],
      outOfScope: [
        'Do not draft the final article, report, chapter, or prose deliverable.',
        'Do not invent publication dates, authors, URLs, citations, or statistics.',
        'Do not omit source URLs when a public source has one.',
      ],
    },
    successCriteria: [
      'Every high-risk factual claim has at least one source id or is marked unsupported/conflicting.',
      'Every source card includes title, publisher when available, extracted facts, and reliability.',
      'Conflicting evidence is explicitly identified instead of silently resolved.',
      'The result is valid JSON matching the requested shape.',
    ],
    constraints: {
      language: 'en',
      tone: 'research memo',
      maxLength: 'Keep source cards concise; prioritize evidence quality over prose.',
      avoid: ['snippet-only evidence', 'fabricated citations', 'unsourced statistics'],
    },
    tools: ['Tavily search/extract', 'Playwright', 'Firecrawl when configured'],
    effort: 'thorough',
  };

  return {
    targetAgent: 'researcherAgent',
    callerAgentId: 'writerAgent',
    taskSpec,
    nextStep: 'Call system_delegate_task with targetAgent=researcherAgent and this taskSpec, then pass the JSON result to writer_ingest_research_result.',
  };
}

export function normalizeResearchLedgers(
  projectId: string,
  sources: SourceCardInput[],
  claims: ResearchClaimInput[],
): NormalizedResearchLedgers {
  const sourceIdAliases = new Map<string, string>();
  const normalizedSources = sources.map((source, index) => {
    const sourceKey = source.url ?? source.title ?? source.id ?? `source-${index + 1}`;
    const id = source.id?.startsWith('wsrc_')
      ? source.id
      : stableWriterId('wsrc', projectId, sourceKey);

    addAlias(sourceIdAliases, source.id, id);
    addAlias(sourceIdAliases, source.url, id);
    addAlias(sourceIdAliases, source.title, id);
    addAlias(sourceIdAliases, String(index + 1), id);
    addAlias(sourceIdAliases, `source-${index + 1}`, id);

    return {
      ...source,
      id,
      extractedFacts: source.extractedFacts ?? [],
      reliability: source.reliability ?? 'unknown',
    };
  });

  const unresolvedSourceRefs = new Set<string>();
  const normalizedClaims = claims.map((claim) => {
    const refs = [...(claim.sourceIds ?? []), ...(claim.sourceRefs ?? [])];
    const sourceIds = Array.from(new Set(refs.map((ref) => {
      const resolved = sourceIdAliases.get(ref) ?? (ref.startsWith('wsrc_') ? ref : undefined);
      if (!resolved) unresolvedSourceRefs.add(ref);
      return resolved;
    }).filter((id): id is string => Boolean(id))));

    const risk = claim.risk ?? (sourceIds.length === 0 ? 'high' : 'medium');
    const status = claim.status ?? (sourceIds.length > 0 ? 'supported' : 'unsupported');
    const unresolved = refs.filter((ref) => !sourceIdAliases.has(ref) && !ref.startsWith('wsrc_'));
    const notes = unresolved.length > 0
      ? [claim.notes, `Unresolved source refs: ${unresolved.join(', ')}`].filter(Boolean).join('\n')
      : claim.notes;

    return {
      id: claim.id,
      text: claim.text,
      status,
      sourceIds,
      sectionId: claim.sectionId,
      risk,
      notes,
    };
  });

  return {
    sources: normalizedSources,
    claims: normalizedClaims,
    sourceIdMap: Object.fromEntries(sourceIdAliases.entries()),
    unresolvedSourceRefs: [...unresolvedSourceRefs],
  };
}

export function buildWriterWorkerTaskSpec(params: {
  role: WorkerReviewRole;
  project: Pick<
    WriterProject,
    'id' | 'name' | 'type' | 'brief' | 'deliverableLanguage' | 'styleProfile' | 'reviewRevision'
  >;
  manuscriptText: string;
  focus?: string;
  sectionRefs?: string[];
  previousFindings?: string;
}): { preset: typeof WORKER_PRESETS[WorkerReviewRole]; taskSpec: WorkerTaskSpecInput } {
  const preset = WORKER_PRESETS[params.role];
  const focus = params.focus ?? `${params.role} pass`;
  const sectionRefs = params.sectionRefs?.length ? params.sectionRefs.join(', ') : 'whole manuscript';

  const taskSpec: WorkerTaskSpecInput = {
    goal: `Run a ${params.role} pass for "${params.project.name}" and return only structured JSON.`,
    context: [
      `Project id: ${params.project.id}`,
      `Project type: ${params.project.type}`,
      `Deliverable language: ${params.project.deliverableLanguage}`,
      `Brief: ${params.project.brief}`,
      `Focus: ${focus}`,
      `Sections: ${sectionRefs}`,
      params.previousFindings ? `Previous findings to consider:\n${params.previousFindings}` : undefined,
      `Style profile: ${JSON.stringify(params.project.styleProfile ?? {})}`,
    ].filter(Boolean).join('\n'),
    inputs: [
      // Never silently truncate a receipt-bound review. The receipt is bound to
      // the full current snapshot, so the worker must receive that same text.
      { name: 'manuscriptText', value: params.manuscriptText, source: 'runtime' },
    ],
    outputContract: {
      format: 'json',
      schema: WORKER_OUTPUT_SCHEMAS[params.role],
    },
    scope: {
      inScope: [
        'Evaluate only the supplied manuscript text and project contract.',
        'Treat every explicit brief constraint, including negative and reveal-timing constraints, as a blocking invariant.',
        'Return structured JSON matching the schema.',
        'Make findings specific enough for writerAgent to persist as audits or continuity updates.',
      ],
      outOfScope: [
        'Do not write a full replacement manuscript.',
        'Do not invent facts, citations, or canon.',
        'Do not change the deliverable language.',
      ],
    },
    successCriteria: [
      'Output is parseable JSON and contains no prose outside JSON.',
      'Findings cite concrete locations or sections when possible.',
      'Recommendations preserve project brief, language, canon, sources, and claim coverage.',
      'No recommendation moves a constrained reveal, mention, object, fact, or payoff into an earlier forbidden section.',
    ],
    constraints: {
      language: 'en',
      tone: 'direct expert review',
      maxLength: 'Prefer concise findings; do not exceed the requested schema.',
      avoid: ['generic praise', 'full rewrites', 'unsupported factual additions'],
    },
    correlation: {
      domain: 'writer',
      entityId: params.project.id,
      action: params.role,
      contractRevision: params.project.reviewRevision ?? 0,
    },
    effort: params.role === 'muse' ? 'medium' : 'thorough',
  };

  return { preset, taskSpec };
}

export function decideRevision(before: QualitySummaryInput, after: QualitySummaryInput): RevisionDecision {
  const beforePenalty = qualityPenalty(before);
  const afterPenalty = qualityPenalty(after);
  const netImprovement = Number((beforePenalty - afterPenalty).toFixed(2));
  const reasons: string[] = [];

  if (after.ok && !before.ok) reasons.push('Revision resolves all blocking quality gates.');
  if (netImprovement > 0) reasons.push(`Revision improves quality penalty by ${netImprovement}.`);
  if (netImprovement < 0) reasons.push(`Revision regresses quality penalty by ${Math.abs(netImprovement)}.`);
  if (!after.ok) reasons.push('Revision still has blocking quality issues.');
  if (after.slopScore !== undefined && before.slopScore !== undefined && after.slopScore < before.slopScore) {
    reasons.push('Revision lowers the anti-slop score.');
  }

  if (after.ok && netImprovement >= 0) {
    return { decision: 'accept_revision', netImprovement, beforePenalty, afterPenalty, reasons };
  }
  if (netImprovement < 0) {
    return { decision: 'keep_previous', netImprovement, beforePenalty, afterPenalty, reasons };
  }
  return { decision: 'needs_human_review', netImprovement, beforePenalty, afterPenalty, reasons };
}

export const writerPrepareResearchDelegationTool = createTool({
  id: 'writer_prepare_research_delegation',
  description:
    'Builds a structured system_delegate_task contract for researcherAgent. Use before factual article/report research, then ingest the returned JSON with writer_ingest_research_result.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    researchGoal: z.string().min(10).describe('One-sentence research objective.'),
    questions: z.array(z.string()).optional().default([]),
    expectedSourceCount: z.number().int().min(1).max(30).optional().default(8),
    focus: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    targetAgent: z.literal('researcherAgent').optional(),
    callerAgentId: z.literal('writerAgent').optional(),
    taskSpec: z.any().optional(),
    nextStep: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };

      const plan = buildResearchTaskSpec({
        projectId: project.id,
        projectName: project.name,
        projectBrief: project.brief,
        projectType: project.type,
        deliverableLanguage: project.deliverableLanguage,
        researchGoal: context.researchGoal,
        questions: context.questions ?? [],
        expectedSourceCount: context.expectedSourceCount ?? 8,
        focus: context.focus,
      });
      return { success: true, ...plan };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerIngestResearchResultTool = createTool({
  id: 'writer_ingest_research_result',
  description:
    'Normalizes researcherAgent JSON into writer source and claim ledgers, writes an optional research note, and saves a claim audit summary.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    researchSummary: z.string().optional(),
    sources: z.array(sourceCardSchema).optional().default([]),
    claims: z.array(researchClaimSchema).optional().default([]),
    rawResult: z.any().optional().describe('Optional full researcher output for audit traceability.'),
    saveAudit: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    sourceCount: z.number().optional(),
    claimCount: z.number().optional(),
    sourceIds: z.array(z.string()).optional(),
    unresolvedSourceRefs: z.array(z.string()).optional(),
    claimSummary: z.any().optional(),
    auditId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };

      const normalized = normalizeResearchLedgers(
        context.projectId,
        context.sources ?? [],
        context.claims ?? [],
      );
      const savedSources = normalized.sources.length > 0
        ? await writer.addSources(context.projectId, normalized.sources)
        : [];
      const savedClaims = normalized.claims.length > 0
        ? await writer.upsertClaims(context.projectId, normalized.claims)
        : [];

      if (context.researchSummary) {
        await writer.addNote({
          projectId: context.projectId,
          type: 'research',
          topic: 'researcherAgent summary',
          content: context.researchSummary,
        });
      }

      const auditProject = await writer.getProject(context.projectId);
      if (!auditProject) return { success: false, error: `Writer project ${context.projectId} not found.` };
      const expectedReviewRevision = auditProject.reviewRevision ?? 0;
      const claimSummary = await writer.verifyClaims(context.projectId);
      let auditId: string | undefined;
      if (context.saveAudit ?? true) {
        const audit = await writer.saveAudit({
          projectId: context.projectId,
          expectedReviewRevision,
          kind: 'claim',
          provenance: 'deterministic',
          ok: claimSummary.ok,
          score: claimSummary.ok
            ? 100
            : Math.max(0, 100 - claimSummary.highRiskUnsupported * 30 - claimSummary.conflicting * 20),
          summary: `Research ingest saved ${savedSources.length} source(s) and ${savedClaims.length} claim(s). ${summarizeClaimVerification(claimSummary)}`,
          raw: {
            researchSummary: context.researchSummary,
            claimSummary,
            sourceIdMap: normalized.sourceIdMap,
            unresolvedSourceRefs: normalized.unresolvedSourceRefs,
            rawResult: context.rawResult,
          },
        });
        auditId = audit.id;
      }

      return {
        success: true,
        sourceCount: savedSources.length,
        claimCount: savedClaims.length,
        sourceIds: savedSources.map((source) => source.id),
        unresolvedSourceRefs: normalized.unresolvedSourceRefs,
        claimSummary,
        auditId,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerPrepareWorkerReviewTool = createTool({
  id: 'writer_prepare_worker_review',
  description:
    'Builds a structured system_run_worker taskSpec for writer_critic, writer_reader, writer_muse, writer_chronicler, or writer_polisher.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    role: z.enum(['critic', 'reader', 'muse', 'chronicler', 'polisher']),
    manuscriptText: z.string().optional().describe('Optional exact copy of current manuscript.md. A mismatch is rejected; omit to read durable current content.'),
    focus: z.string().optional(),
    sectionRefs: z.array(z.string()).optional().default([]),
    previousFindings: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    preset: z.string().optional(),
    taskSpec: z.any().optional(),
    nextStep: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const modifierError = authoritativeWriterReviewModifierError(context);
      if (modifierError) return { success: false, error: modifierError };
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };
      const currentManuscript = await readCurrentManuscript(context.projectId);
      if (context.manuscriptText !== undefined && context.manuscriptText !== currentManuscript) {
        return {
          success: false,
          error: 'manuscriptText must exactly match the current durable manuscript; activate/write the intended version first.',
        };
      }
      const manuscriptText = currentManuscript;
      const currentSnapshot = await writer.getCurrentManuscript(context.projectId);
      if (!currentSnapshot || currentSnapshot.content !== currentManuscript) {
        return {
          success: false,
          error: 'Snapshot the current durable manuscript before preparing an independent review.',
        };
      }

      const prepared = buildWriterWorkerTaskSpec({
        role: context.role,
        project,
        manuscriptText,
        focus: context.focus,
        sectionRefs: context.sectionRefs ?? [],
        previousFindings: context.previousFindings,
      });
      const issued = await issueWorkerReviewRequest({
        preset: prepared.preset,
        correlation: {
          domain: 'writer',
          entityId: context.projectId,
          action: context.role,
          subjectId: currentSnapshot.id,
          contractRevision: project.reviewRevision ?? 0,
        },
        taskSpec: prepared.taskSpec,
      });

      return {
        success: true,
        preset: prepared.preset,
        taskSpec: issued.taskSpec,
        nextStep: `Call system_run_worker with preset=${prepared.preset} and this exact taskSpec. For critic/reader/polisher, pass its workerRunId and exact unedited output to writer_save_audit. Persist chronicler findings with writer_update_continuity.`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerQualityGateTool = createTool({
  id: 'writer_quality_gate',
  description:
    'Runs the deterministic writer quality gate: anti-slop, continuity, and claim verification as applicable. Full projects cannot disable their mandatory checks. Saves audits and returns blocking issues.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    manuscriptId: z.string().optional(),
    text: z.string().optional().describe('Optional text to audit. If omitted, current manuscript.md is read.'),
    language: z.string().optional(),
    includeSlop: z.boolean().optional().default(true),
    includeContinuity: z.boolean().optional(),
    includeClaims: z.boolean().optional(),
    minSlopScore: z.number().min(0).max(100).optional().default(80),
    saveAudit: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    ok: z.boolean().optional(),
    summary: z.any().optional(),
    checks: z.any().optional(),
    blockingIssues: z.array(z.any()).optional(),
    auditIds: z.array(z.string()).optional(),
    manuscriptId: z.string().optional(),
    wordCount: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };
      const expectedReviewRevision = project.reviewRevision ?? 0;
      if (
        project.taskMode === 'full_project'
        && context.language !== undefined
        && context.language !== project.deliverableLanguage
      ) {
        return {
          success: false,
          error: `Full-project quality gates must use deliverableLanguage=${project.deliverableLanguage}.`,
        };
      }
      const minSlopScore = context.minSlopScore ?? 80;
      if (project.taskMode === 'full_project' && minSlopScore < 80) {
        return { success: false, error: 'Full-project quality gates require minSlopScore >= 80.' };
      }

      const selectedChecks = resolveWriterQualityChecks(project, {
        includeSlop: context.includeSlop,
        includeContinuity: context.includeContinuity,
        includeClaims: context.includeClaims,
      });
      const { includeSlop, includeContinuity, includeClaims } = selectedChecks;
      const language = context.language ?? project.deliverableLanguage;
      const text = context.text ?? (includeSlop ? await readCurrentManuscript(context.projectId) : '');
      const currentSnapshot = await writer.getCurrentManuscript(context.projectId);
      const auditManuscriptId = context.manuscriptId ?? currentSnapshot?.id;
      if (project.taskMode === 'full_project') {
        if (!currentSnapshot || currentSnapshot.content !== text) {
          return {
            success: false,
            error: 'Snapshot the exact current manuscript before running the full-project quality gate.',
          };
        }
        if (context.manuscriptId && context.manuscriptId !== currentSnapshot.id) {
          return { success: false, error: 'manuscriptId is stale; it is not the current snapshot.' };
        }
      }
      const blockingIssues: Array<Record<string, unknown>> = [];
      const auditIds: string[] = [];
      const checks: Record<string, unknown> = {};

      if (includeSlop) {
        const slop = auditSlop(text, language);
        checks.slop = slop;
        if (slop.score < minSlopScore) {
          blockingIssues.push({
            kind: 'slop',
            severity: 'high',
            message: `Anti-slop score ${slop.score} is below threshold ${minSlopScore}.`,
          });
        }
        if (context.saveAudit ?? true) {
          const audit = await writer.saveAudit({
            projectId: context.projectId,
            expectedReviewRevision,
            manuscriptId: auditManuscriptId,
            kind: 'slop',
            provenance: 'deterministic',
            ok: slop.score >= minSlopScore,
            score: slop.score,
            summary: `Slop audit score: ${slop.score}. Issues: ${slop.issues.length}.`,
            issues: slop.issues.map((issue) => ({ ...issue })),
            raw: slop,
          });
          auditIds.push(audit.id);
        }
      }
      // This is a hard Writer output constraint, not an optional slop check.
      // `includeSlop:false` may trim a requested audit mode but cannot waive it.
      const emDashCount = countForbiddenWriterEmDashes(text);
      checks.punctuation = { forbiddenEmDashCount: emDashCount };
      if (emDashCount > 0) {
        blockingIssues.push({
          kind: 'forbidden_punctuation',
          severity: 'high',
          message: `The manuscript contains ${emDashCount} forbidden U+2014 em dash character(s).`,
        });
      }

      if (includeContinuity) {
        const [continuity, storedSections, manuscriptText] = await Promise.all([
          writer.getContinuity(context.projectId),
          writer.listSections(context.projectId),
          readCurrentManuscript(context.projectId),
        ]);
        const { hydrateWriterSectionsFromDocument } = await import('./writer-document-tools.js');
        const sections = hydrateWriterSectionsFromDocument(storedSections, manuscriptText);
        const continuityResult = validateContinuity(
          continuity ?? { projectId: context.projectId },
          sections.map((section) => ({
            id: section.id,
            order: section.order,
            title: section.title,
            summary: section.summary,
            content: section.content,
          })),
        );
        checks.continuity = continuityResult;
        const continuityCoverageIssues: Array<Record<string, unknown>> = [];
        if (project.taskMode === 'full_project') {
          const draftedSections = sections.filter((section) => countWords(section.content ?? '') > 0);
          const characterCount = Array.isArray(continuity?.characters) ? continuity.characters.length : 0;
          const timelineCount = Array.isArray(continuity?.timeline) ? continuity.timeline.length : 0;
          if (draftedSections.length === 0) {
            continuityCoverageIssues.push({
              kind: 'continuity_coverage',
              severity: 'critical',
              message: 'No drafted writer sections could be hydrated from the delivered manuscript.',
            });
          }
          if (characterCount === 0 || timelineCount === 0) {
            continuityCoverageIssues.push({
              kind: 'continuity_coverage',
              severity: 'high',
              message: `Full fiction continuity requires characters and timeline entries (found ${characterCount}/${timelineCount}).`,
            });
          }
        }
        if (!continuityResult.ok) {
          blockingIssues.push({
            kind: 'continuity',
            severity: continuityResult.criticalCount > 0 ? 'critical' : 'high',
            message: `Continuity gate found ${continuityResult.criticalCount} critical and ${continuityResult.highCount} high issue(s).`,
          });
        }
        blockingIssues.push(...continuityCoverageIssues);
        const continuityOk = continuityResult.ok && continuityCoverageIssues.length === 0;
        if (context.saveAudit ?? true) {
          const audit = await writer.saveAudit({
            projectId: context.projectId,
            expectedReviewRevision,
            manuscriptId: auditManuscriptId,
            kind: 'continuity',
            provenance: 'deterministic',
            ok: continuityOk,
            score: continuityOk
              ? 100
              : Math.max(
                0,
                100 - continuityResult.criticalCount * 30 - continuityResult.highCount * 15 - continuityCoverageIssues.length * 20,
              ),
            summary: continuityOk
              ? 'Continuity validation passed.'
              : `Continuity validation found ${continuityResult.issues.length + continuityCoverageIssues.length} issue(s).`,
            issues: [...continuityResult.issues.map((issue) => ({ ...issue })), ...continuityCoverageIssues],
            raw: { ...continuityResult, coverageIssues: continuityCoverageIssues },
          });
          auditIds.push(audit.id);
        }
      }

      if (includeClaims) {
        const claimSummary = await writer.verifyClaims(context.projectId);
        checks.claims = claimSummary;
        const missingClaimLedger = project.taskMode === 'full_project' && claimSummary.total === 0;
        if (!claimSummary.ok || missingClaimLedger) {
          blockingIssues.push({
            kind: 'claim',
            severity: 'critical',
            message: missingClaimLedger
              ? 'Full factual project has no claim ledger; absence of evidence cannot pass as verified.'
              : summarizeClaimVerification(claimSummary),
          });
        }
        const claimOk = claimSummary.ok && !missingClaimLedger;
        if (context.saveAudit ?? true) {
          const audit = await writer.saveAudit({
            projectId: context.projectId,
            expectedReviewRevision,
            manuscriptId: auditManuscriptId,
            kind: 'claim',
            provenance: 'deterministic',
            ok: claimOk,
            score: claimOk
              ? 100
              : Math.max(0, 100 - claimSummary.highRiskUnsupported * 30 - claimSummary.conflicting * 20),
            summary: missingClaimLedger
              ? 'Claim verification blocked: the full factual project has no claim ledger.'
              : summarizeClaimVerification(claimSummary),
            raw: { ...claimSummary, missingClaimLedger },
          });
          auditIds.push(audit.id);
        }
      }

      const slopScore = (checks.slop as { score?: number } | undefined)?.score;
      const continuityResult = checks.continuity as { criticalCount?: number; highCount?: number } | undefined;
      const claimSummary = checks.claims as ClaimVerificationSummary | undefined;
      const ok = blockingIssues.length === 0;
      const summary: QualitySummaryInput = {
        ok,
        slopScore,
        continuityCritical: continuityResult?.criticalCount ?? 0,
        continuityHigh: continuityResult?.highCount ?? 0,
        highRiskUnsupported: claimSummary?.highRiskUnsupported ?? 0,
        conflictingClaims: claimSummary?.conflicting ?? 0,
        blockingIssueCount: blockingIssues.length,
      };

      if (context.saveAudit ?? true) {
        const audit = await writer.saveAudit({
          projectId: context.projectId,
          expectedReviewRevision,
          manuscriptId: auditManuscriptId,
          kind: 'critic',
          provenance: 'deterministic',
          ok,
          score: Math.max(0, 100 - qualityPenalty(summary)),
          summary: ok
            ? 'Writer quality gate passed.'
            : `Writer quality gate blocked on ${blockingIssues.length} issue(s).`,
          issues: blockingIssues,
          raw: {
            gate: 'writer_quality_gate_v1',
            policy: { language, minSlopScore },
            summary,
            checks,
          },
        });
        auditIds.push(audit.id);
      }

      return {
        success: true,
        ok,
        summary,
        checks,
        blockingIssues,
        auditIds,
        manuscriptId: auditManuscriptId,
        wordCount: countWords(text),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerRevisionDecisionTool = createTool({
  id: 'writer_revision_decision',
  description:
    'Compares persisted before/after snapshots and quality summaries, then durably selects the accepted snapshot or restores the previous one.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    beforeManuscriptId: z.string().describe('Persisted snapshot id captured before the revision.'),
    afterManuscriptId: z.string().describe('Persisted snapshot id captured after the revision.'),
    before: qualitySummarySchema,
    after: qualitySummarySchema,
    saveAudit: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    decision: z.enum(['accept_revision', 'keep_previous', 'needs_human_review']).optional(),
    netImprovement: z.number().optional(),
    beforePenalty: z.number().optional(),
    afterPenalty: z.number().optional(),
    reasons: z.array(z.string()).optional(),
    auditId: z.string().optional(),
    selectedManuscriptId: z.string().optional(),
    restoredPrevious: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };
      const expectedReviewRevision = project.reviewRevision ?? 0;
      if (project.taskMode === 'full_project' && context.saveAudit === false) {
        return {
          success: false,
          error: 'A full-project revision decision must persist its audit; saveAudit=false is not allowed.',
        };
      }
      const decision = decideRevision(context.before, context.after);
      const selectedManuscriptId = decision.decision === 'needs_human_review'
        ? undefined
        : decision.decision === 'accept_revision'
        ? context.afterManuscriptId
        : context.beforeManuscriptId;
      const restoredPrevious = decision.decision === 'keep_previous';
      const persistAudit = context.saveAudit ?? true;
      if (selectedManuscriptId && persistAudit && !project.currentManuscriptId) {
        return {
          success: false,
          ...decision,
          error: 'Snapshot the current pre-decision manuscript before applying a revision decision.',
        };
      }

      let auditId: string | undefined;
      if (persistAudit) {
        const auditManuscriptId = selectedManuscriptId ?? context.afterManuscriptId;
        const selectedPenalty = decision.decision === 'keep_previous'
          ? decision.beforePenalty
          : decision.afterPenalty;
        const audit = await writer.saveAudit({
          projectId: context.projectId,
          expectedReviewRevision,
          activateManuscriptId: selectedManuscriptId,
          expectedCurrentManuscriptId: selectedManuscriptId
            ? project.currentManuscriptId
            : undefined,
          manuscriptId: auditManuscriptId,
          kind: 'revision',
          provenance: 'deterministic',
          ok: decision.decision !== 'needs_human_review' && Boolean(selectedManuscriptId),
          score: Math.max(0, Math.min(100, 100 - selectedPenalty)),
          summary: `Revision decision: ${decision.decision}. Net improvement: ${decision.netImprovement}.`,
          issues: decision.reasons.map((reason) => ({ reason })),
          raw: {
            before: context.before,
            after: context.after,
            beforeManuscriptId: context.beforeManuscriptId,
            afterManuscriptId: context.afterManuscriptId,
            selectedManuscriptId,
            restoredPrevious,
            decision,
          },
        });
        auditId = audit.id;
      }

      if (selectedManuscriptId) {
        const {
          writerDocumentActivateSnapshot,
          writerDocumentSyncSelectedSnapshot,
        } = await import('./writer-document-tools.js');
        const activated = persistAudit
          ? await writerDocumentSyncSelectedSnapshot({
              projectId: context.projectId,
              manuscriptId: selectedManuscriptId,
            })
          : await writerDocumentActivateSnapshot({
          projectId: context.projectId,
          manuscriptId: selectedManuscriptId,
            });
        if (!activated.success) {
          return {
            success: false,
            ...decision,
            auditId,
            selectedManuscriptId,
            restoredPrevious,
            error: activated.error,
          };
        }
      }

      return {
        success: true,
        ...decision,
        auditId,
        selectedManuscriptId,
        restoredPrevious,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerWorkflowTools = {
  writerPrepareResearchDelegationTool,
  writerIngestResearchResultTool,
  writerPrepareWorkerReviewTool,
  writerQualityGateTool,
  writerRevisionDecisionTool,
};
