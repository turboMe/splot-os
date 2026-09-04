import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { auditSlop } from './anti-slop.js';
import { validateContinuity } from './continuity-validator.js';
import {
  WriterService,
  WRITER_PIPELINE_STATUSES,
  WRITER_PROJECT_TYPES,
  type WriterDial,
  type WriterSection,
  type WriterStyleProfile,
} from './writer-service.js';

const writerDialSchema = z.number().int().min(1).max(5).transform((value) => value as WriterDial);

const writerStyleProfileSchema = z.object({
  directness: writerDialSchema.optional(),
  warmth: writerDialSchema.optional(),
  personality: writerDialSchema.optional(),
  density: writerDialSchema.optional(),
  evidence: writerDialSchema.optional(),
  polish: writerDialSchema.optional(),
  rhythm: writerDialSchema.optional(),
  formality: writerDialSchema.optional(),
  sampleSource: z.enum(['user_sample', 'project_brief', 'manual', 'inferred']).optional(),
  voiceSample: z.string().optional(),
  signatureMarkers: z.array(z.string()).optional(),
});

const continuityCharacterSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  status: z.enum(['alive', 'dead', 'missing', 'unknown']).optional(),
  lastSeenSectionId: z.string().optional(),
  deathSectionId: z.string().optional(),
  notes: z.string().optional(),
});

const continuityTimelineSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  order: z.number().optional(),
  date: z.string().optional(),
  sectionId: z.string().optional(),
});

const continuityPromiseSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(['open', 'paid_off', 'dropped']),
  setupSectionId: z.string().optional(),
  payoffSectionId: z.string().optional(),
  setupOrder: z.number().optional(),
  payoffOrder: z.number().optional(),
});

const continuityQuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(['open', 'answered', 'dropped']),
  openedSectionId: z.string().optional(),
  answeredSectionId: z.string().optional(),
  openedOrder: z.number().optional(),
  answeredOrder: z.number().optional(),
});

export const writerContinuityPatchSchema = z.object({
  characters: z.array(continuityCharacterSchema).optional(),
  timeline: z.array(continuityTimelineSchema).optional(),
  promises: z.array(continuityPromiseSchema).optional(),
  questions: z.array(continuityQuestionSchema).optional(),
  glossary: z.array(z.object({ term: z.string().min(1), definition: z.string().min(1) })).optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined), {
  message: 'Provide at least one continuity array to update.',
});

async function hydrateContinuitySections(projectId: string, sections: WriterSection[]): Promise<WriterSection[]> {
  const { hydrateWriterSectionsFromDocument, writerDocumentRead } = await import('./writer-document-tools.js');
  const document = await writerDocumentRead(projectId);
  if (!document.success || document.content === undefined) {
    throw new Error(document.error ?? 'Unable to read writer manuscript for continuity validation.');
  }
  return hydrateWriterSectionsFromDocument(sections, document.content);
}

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}'-]+/gu) ?? []).length;
}

function avgSentenceLength(text: string): number {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) return 0;
  return Number((countWords(text) / sentences.length).toFixed(2));
}

function inferStyleProfile(sample: string, base: Partial<WriterStyleProfile> = {}): Partial<WriterStyleProfile> {
  const avg = avgSentenceLength(sample);
  const directness = avg <= 14 ? 4 : avg <= 22 ? 3 : 2;
  const density = avg >= 24 ? 5 : avg >= 17 ? 4 : 3;
  const evidence = /\b(?:according to|study|source|data|badanie|zrodlo|dane|raport)\b/i.test(sample) ? 4 : 3;
  const warmth = /\b(?:we|you|reader|czytelnik|ty|my)\b/i.test(sample) ? 4 : 3;
  const personality = /[!?]|["“”]|(?:I|ja)\b/.test(sample) ? 4 : 3;
  const signatureMarkers = Array.from(
    new Set(
      (sample.match(/\b[\p{L}][\p{L}'-]{7,}\b/gu) ?? [])
        .slice(0, 20)
        .map((word) => word.toLowerCase()),
    ),
  ).slice(0, 10);

  return {
    directness,
    warmth,
    personality,
    density,
    evidence,
    polish: 4,
    rhythm: avg <= 12 || avg >= 24 ? 4 : 3,
    formality: /\b(?:therefore|however|ponadto|niemniej|zatem)\b/i.test(sample) ? 4 : 3,
    sampleSource: 'user_sample',
    voiceSample: sample.slice(0, 2000),
    signatureMarkers,
    ...base,
  };
}

export const writerStartProjectTool = createTool({
  id: 'writer_start_project',
  description:
    'Starts a writer project for fiction, article, blog, or report work. Stores language, autonomy mode, task mode, and style profile. Call once at the start of a writing project.',
  inputSchema: z.object({
    id: z.string().optional().describe('Optional English kebab-case project slug, e.g. "flowmint-microservices-article".'),
    name: z.string().describe('Project name, e.g. "AI agents article" or "Dark fantasy novella".'),
    brief: z.string().describe('Original user brief and constraints.'),
    type: z.enum(WRITER_PROJECT_TYPES).describe('Project type.'),
    deliverableLanguage: z.string().optional().default('pl').describe('Final deliverable language; defaults to pl.'),
    autonomyMode: z.enum(['checkpointed', 'full_auto']).optional().default('checkpointed'),
    taskMode: z
      .enum(['quick_write', 'edit', 'outline_only', 'continue_project', 'full_project'])
      .optional()
      .default('full_project'),
    styleProfile: writerStyleProfileSchema.optional(),
    createdBy: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    project: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.createProject({
        id: context.id,
        name: context.name,
        brief: context.brief,
        type: context.type,
        deliverableLanguage: context.deliverableLanguage,
        autonomyMode: context.autonomyMode,
        taskMode: context.taskMode,
        styleProfile: context.styleProfile as Partial<WriterStyleProfile> | undefined,
        createdBy: context.createdBy,
      });
      return { success: true, project };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerGetProjectTool = createTool({
  id: 'writer_get_project',
  description: 'Retrieves a writer project with its status, language, autonomy mode, task mode, and style profile.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    project: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };
      return { success: true, project };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerListProjectsTool = createTool({
  id: 'writer_list_projects',
  description: 'Lists writer projects with their statuses. Use to resume in-flight writing work.',
  inputSchema: z.object({
    status: z.enum(WRITER_PIPELINE_STATUSES).optional().describe('Filter by pipeline status.'),
    type: z.enum(WRITER_PROJECT_TYPES).optional().describe('Filter by project type.'),
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    projects: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const projects = await writer.listProjects(
        context.status || context.type ? { status: context.status, type: context.type } : undefined,
        context.limit ?? 10,
      );
      return {
        success: true,
        count: projects.length,
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          type: project.type,
          status: project.status,
          deliverableLanguage: project.deliverableLanguage,
          autonomyMode: project.autonomyMode,
          taskMode: project.taskMode,
          currentManuscriptId: project.currentManuscriptId,
          updatedAt: project.updatedAt,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerSetProjectStatusTool = createTool({
  id: 'writer_set_project_status',
  description:
    'Sets the writer project status in the pipeline state machine. Full projects cannot enter done until deterministic quality plus critic, reader, polish, and continuity/claim audits are green.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    status: z.enum(WRITER_PIPELINE_STATUSES).describe('New pipeline phase status.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    projectId: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };
      await writer.updateProjectStatus(context.projectId, context.status);
      return { success: true, projectId: context.projectId, status: context.status };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerUpdateStyleProfileTool = createTool({
  id: 'writer_update_style_profile',
  description: 'Updates a project style profile: voice dials, sample source, voice sample, and signature markers.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    styleProfile: writerStyleProfileSchema.describe('Partial style profile update.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    styleProfile: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const updated = await writer.updateProject(context.projectId, {
        styleProfile: context.styleProfile,
      } as any);
      return { success: true, styleProfile: updated.styleProfile };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerAnalyzeStyleSampleTool = createTool({
  id: 'writer_analyze_style_sample',
  description:
    'Derives a style profile from a user-provided sample and stores it on the writer project. Deterministic first pass; later workers can refine it.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    sample: z.string().min(100).describe('Writing sample to analyze.'),
    overrides: writerStyleProfileSchema.optional().describe('Optional manual dial overrides.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    styleProfile: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const styleProfile = inferStyleProfile(
        context.sample,
        context.overrides as Partial<WriterStyleProfile> | undefined,
      );
      const updated = await writer.updateProject(context.projectId, { styleProfile } as any);
      return { success: true, styleProfile: updated.styleProfile };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerUpsertSectionTool = createTool({
  id: 'writer_upsert_section',
  description:
    'Creates or updates a logical writer section (chapter, scene, article section, outline, appendix). Pair with writer_document_write_section for the actual markdown artifact.',
  inputSchema: z.object({
    id: z.string().optional().describe('Existing section UUID when updating.'),
    projectId: z.string().describe('Writer project UUID.'),
    order: z.number().int().min(0).describe('Section order in the project.'),
    kind: z.enum(['chapter', 'scene', 'section', 'outline', 'appendix', 'notes']),
    anchor: z.string().describe('Document anchor, e.g. chapter:01 or section:methods.'),
    title: z.string(),
    content: z.string().optional(),
    summary: z.string().optional(),
    status: z.enum(['planned', 'drafted', 'revised', 'accepted', 'archived']).optional().default('drafted'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    section: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const section = await writer.upsertSection(context);
      return { success: true, section };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerListSectionsTool = createTool({
  id: 'writer_list_sections',
  description: 'Lists project sections in order. Use before continuation so new writing respects existing structure.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    sections: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const sections = await writer.listSections(context.projectId);
      return { success: true, count: sections.length, sections };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerUpdateContinuityTool = createTool({
  id: 'writer_update_continuity',
  description:
    'Patches fiction canon/runtime continuity: characters, timeline, promises, questions, and glossary. Use chronicler output here after each drafted scene/chapter.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    patch: writerContinuityPatchSchema.describe(
      'Canonical partial continuity state. Use text (not question), paid_off (not resolved), label (not event), and real writer section IDs.',
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    continuity: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const continuity = await writer.upsertContinuity(context.projectId, context.patch as any);
      return { success: true, continuity };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerGetContinuityTool = createTool({
  id: 'writer_get_continuity',
  description: 'Retrieves fiction canon/runtime continuity for a project.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    continuity: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const continuity = await writer.getContinuity(context.projectId);
      return { success: true, continuity };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerValidateContinuityTool = createTool({
  id: 'writer_validate_continuity',
  description:
    'Runs deterministic fiction continuity validation against current continuity state and the actual anchored Markdown section text. Saves a continuity audit when saveAudit is true.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    saveAudit: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.any().optional(),
    auditId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };
      const expectedReviewRevision = project.reviewRevision ?? 0;
      const [continuity, storedSections] = await Promise.all([
        writer.getContinuity(context.projectId),
        writer.listSections(context.projectId),
      ]);
      const sections = await hydrateContinuitySections(context.projectId, storedSections);
      const result = validateContinuity(
        continuity ?? { projectId: context.projectId },
        sections.map((section) => ({
          id: section.id,
          order: section.order,
          title: section.title,
          summary: section.summary,
          content: section.content,
        })),
      );
      let auditId: string | undefined;
      if (context.saveAudit ?? true) {
        const currentManuscript = await writer.getCurrentManuscript(context.projectId);
        const audit = await writer.saveAudit({
          projectId: context.projectId,
          expectedReviewRevision,
          manuscriptId: currentManuscript?.id,
          kind: 'continuity',
          provenance: 'deterministic',
          ok: result.ok,
          score: result.ok ? 100 : Math.max(0, 100 - result.criticalCount * 30 - result.highCount * 15),
          summary: result.ok ? 'Continuity validation passed.' : `Continuity validation found ${result.issues.length} issue(s).`,
          issues: result.issues.map((issue) => ({ ...issue })),
          raw: result,
        });
        auditId = audit.id;
      }
      return { success: true, result, auditId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerAddSourcesTool = createTool({
  id: 'writer_add_sources',
  description:
    'Adds source cards to the project source ledger. Use for structured results returned by researcherAgent before writing factual sections.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    sources: z.array(z.object({
      id: z.string().optional(),
      url: z.string().optional(),
      title: z.string(),
      publisher: z.string().optional(),
      author: z.string().optional(),
      publishedAt: z.string().optional(),
      accessedAt: z.string().optional(),
      extractedFacts: z.array(z.string()).optional().default([]),
      reliability: z.enum(['high', 'medium', 'low', 'unknown']).optional().default('unknown'),
      notes: z.string().optional(),
    })).min(1),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    sources: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const sources = await writer.addSources(context.projectId, context.sources);
      return { success: true, count: sources.length, sources };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerListSourcesTool = createTool({
  id: 'writer_list_sources',
  description: 'Lists source cards for a factual writer project.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    sources: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const sources = await writer.listSources(context.projectId);
      return { success: true, count: sources.length, sources };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerUpsertClaimsTool = createTool({
  id: 'writer_upsert_claims',
  description:
    'Adds or updates factual claims and their source coverage. Use before claim verification and before finalizing factual deliverables.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    claims: z.array(z.object({
      id: z.string().optional(),
      text: z.string(),
      status: z.enum(['planned', 'supported', 'unsupported', 'conflicting', 'dropped']),
      sourceIds: z.array(z.string()).optional().default([]),
      sectionId: z.string().optional(),
      risk: z.enum(['low', 'medium', 'high']),
      notes: z.string().optional(),
    })).min(1),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    claims: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const claims = await writer.upsertClaims(context.projectId, context.claims);
      return { success: true, count: claims.length, claims };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerListClaimsTool = createTool({
  id: 'writer_list_claims',
  description: 'Lists factual claims for a project, optionally filtered by status or risk.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    status: z.enum(['planned', 'supported', 'unsupported', 'conflicting', 'dropped']).optional(),
    risk: z.enum(['low', 'medium', 'high']).optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    claims: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const claims = await writer.listClaims(context.projectId, { status: context.status, risk: context.risk });
      return { success: true, count: claims.length, claims };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerVerifyClaimsTool = createTool({
  id: 'writer_verify_claims',
  description:
    'Verifies claim ledger coverage. Blocks finalization when high-risk unsupported or conflicting claims remain.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    saveAudit: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    summary: z.any().optional(),
    auditId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const project = await writer.getProject(context.projectId);
      if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };
      const expectedReviewRevision = project.reviewRevision ?? 0;
      const summary = await writer.verifyClaims(context.projectId);
      let auditId: string | undefined;
      if (context.saveAudit ?? true) {
        const currentManuscript = await writer.getCurrentManuscript(context.projectId);
        const audit = await writer.saveAudit({
          projectId: context.projectId,
          expectedReviewRevision,
          manuscriptId: currentManuscript?.id,
          kind: 'claim',
          provenance: 'deterministic',
          ok: summary.ok,
          score: summary.ok ? 100 : Math.max(0, 100 - summary.highRiskUnsupported * 30 - summary.conflicting * 20),
          summary: summary.ok
            ? 'Claim verification passed.'
            : `Claim verification blocked finalization: ${summary.highRiskUnsupported} high-risk unsupported, ${summary.conflicting} conflicting.`,
          raw: summary,
        });
        auditId = audit.id;
      }
      return { success: true, summary, auditId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerAuditSlopTool = createTool({
  id: 'writer_audit_slop',
  description:
    'Runs deterministic anti-slop and rhythm checks on text. Use before polish and finalization. Optionally saves a slop audit.',
  inputSchema: z.object({
    projectId: z.string().optional().describe('Writer project UUID, required when saveAudit is true.'),
    manuscriptId: z.string().optional(),
    text: z.string().describe('Text to audit.'),
    language: z.string().optional().default('pl').describe('Text language.'),
    saveAudit: z.boolean().optional().default(false),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.any().optional(),
    auditId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      let expectedReviewRevision: number | undefined;
      if (context.saveAudit) {
        if (!context.projectId) return { success: false, error: 'projectId is required when saveAudit=true.' };
        const writer = new WriterService();
        const project = await writer.getProject(context.projectId);
        if (!project) return { success: false, error: `Writer project ${context.projectId} not found.` };
        expectedReviewRevision = project.reviewRevision ?? 0;
      }
      const result = auditSlop(context.text, context.language ?? 'pl');
      let auditId: string | undefined;
      if (context.saveAudit) {
        const writer = new WriterService();
        const audit = await writer.saveAudit({
          projectId: context.projectId!,
          expectedReviewRevision,
          manuscriptId: context.manuscriptId,
          kind: 'slop',
          provenance: 'deterministic',
          ok: result.score >= 80,
          score: result.score,
          summary: `Slop audit score: ${result.score}. Issues: ${result.issues.length}.`,
          issues: result.issues.map((issue) => ({ ...issue })),
          raw: result,
        });
        auditId = audit.id;
      }
      return { success: true, result, auditId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerSaveAuditTool = createTool({
  id: 'writer_save_audit',
  description:
    'Saves a Writer audit. Passing critic/reader/polish audits require the successful system_run_worker workerRunId and its exact output; manual fallbacks must use ok=false.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    manuscriptId: z.string().optional(),
    kind: z.enum(['slop', 'continuity', 'claim', 'critic', 'reader', 'polish', 'revision']),
    score: z.number().min(0).max(100).optional(),
    ok: z.boolean().optional(),
    summary: z.string().optional(),
    issues: z.array(z.record(z.string(), z.any())).optional(),
    raw: z.any().optional(),
    workerRunId: z.string().optional().describe('workerRunId returned by the exact system_run_worker review.'),
    workerOutput: z.string().optional().describe('Exact, unedited system_run_worker output used to verify and consume its one-use receipt.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    audit: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const audit = await writer.saveAudit(context);
      return { success: true, audit };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerListAuditsTool = createTool({
  id: 'writer_list_audits',
  description: 'Lists recent audits for a writer project.',
  inputSchema: z.object({
    projectId: z.string().describe('Writer project UUID.'),
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    audits: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const audits = await writer.listAudits(context.projectId, context.limit ?? 10);
      return { success: true, count: audits.length, audits };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerAddNoteTool = createTool({
  id: 'writer_add_note',
  description:
    'Saves a reusable writer note: research, style, feedback, idea, canon, or general. Use for durable project knowledge that should outlive the chat.',
  inputSchema: z.object({
    content: z.string().min(1).describe('Note body.'),
    type: z.enum(['research', 'style', 'feedback', 'idea', 'canon', 'general']).optional().default('general'),
    topic: z.string().optional().describe('Short topic label.'),
    projectId: z.string().optional().describe('Writer project UUID, if tied to a project.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    type: z.string().optional(),
    topic: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const note = await writer.addNote({
        content: context.content,
        type: context.type,
        topic: context.topic,
        projectId: context.projectId,
      });
      return { success: true, id: note.id, type: note.type, topic: note.topic };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerSearchNotesTool = createTool({
  id: 'writer_search_notes',
  description: 'Searches writer notes semantically with regex fallback. Use before continuing a project or drafting in an established style.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search query.'),
    projectId: z.string().optional().describe('Limit to a specific project.'),
    limit: z.number().int().min(1).max(25).optional().default(5),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    notes: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const writer = new WriterService();
      const notes = await writer.searchNotes(context.query, context.projectId, context.limit ?? 5);
      return { success: true, count: notes.length, notes };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const writerTools = {
  writerStartProjectTool,
  writerGetProjectTool,
  writerListProjectsTool,
  writerSetProjectStatusTool,
  writerUpdateStyleProfileTool,
  writerAnalyzeStyleSampleTool,
  writerUpsertSectionTool,
  writerListSectionsTool,
  writerUpdateContinuityTool,
  writerGetContinuityTool,
  writerValidateContinuityTool,
  writerAddSourcesTool,
  writerListSourcesTool,
  writerUpsertClaimsTool,
  writerListClaimsTool,
  writerVerifyClaimsTool,
  writerAuditSlopTool,
  writerSaveAuditTool,
  writerListAuditsTool,
  writerAddNoteTool,
  writerSearchNotesTool,
};
