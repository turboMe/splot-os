import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  FILM_PIPELINE_STATUSES,
  FilmService,
  type FilmPipelineStatus,
} from './film-service.js';
import {
  filmGenerationModeSchema,
  filmProjectModeSchema,
  filmTakeReviewSchema,
} from '../../lib/film-schemas.js';

const filmPipelineStatusSchema = z.enum(FILM_PIPELINE_STATUSES);

function okResult<T extends Record<string, unknown>>(payload: T): T & { success: true } {
  return { success: true, ...payload };
}

function errorResult(error: unknown): { success: false; error: string } {
  return { success: false, error: (error as Error).message };
}

export const filmStartProjectTool = createTool({
  id: 'film_start_project',
  description:
    'Creates a Seedance film project state capsule with first clip skeleton. Use before planning/generating film clips.',
  inputSchema: z.object({
    projectId: z.string().optional(),
    name: z.string().min(1),
    projectMode: filmProjectModeSchema.default('standalone_clip'),
    storyObjective: z.string().min(1),
    logline: z.string().optional(),
    storyPromise: z.string().optional(),
    initialCondition: z.string().optional(),
    finalOutcome: z.string().optional(),
    targetDurationSec: z.number().positive().nullable().optional(),
    tone: z.string().optional(),
    medium: z.string().optional(),
    surface: z.record(z.string(), z.unknown()).optional(),
    clipBudgetSec: z.number().positive().nullable().optional(),
    promptBudget: z.number().int().positive().nullable().optional(),
  }),
  execute: async (context) => {
    try {
      const film = new FilmService();
      const project = await film.startProject({
        ...context,
        projectMode: context.projectMode ?? 'standalone_clip',
      });
      return okResult({ project });
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const filmGetProjectTool = createTool({
  id: 'film_get_project',
  description: 'Gets a Seedance film project state capsule by project id.',
  inputSchema: z.object({
    projectId: z.string().min(1),
  }),
  execute: async (context) => {
    try {
      const film = new FilmService();
      const project = await film.getProject(context.projectId);
      return project ? okResult({ project }) : { success: false, error: `Film project not found: ${context.projectId}` };
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const filmListProjectsTool = createTool({
  id: 'film_list_projects',
  description: 'Lists recent Seedance film projects, optionally filtered by pipeline status.',
  inputSchema: z.object({
    status: filmPipelineStatusSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (context) => {
    try {
      const film = new FilmService();
      const projects = await film.listProjects({ status: context.status as FilmPipelineStatus | undefined }, context.limit);
      return okResult({ projects });
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const filmSetProjectStatusTool = createTool({
  id: 'film_set_project_status',
  description:
    'Sets the filmmaker pipeline status. Call on every phase transition so the reflector can channel tools. Allowed statuses: intake, source_gate, mode_select, reference_map, prompt_build, generate, take_review, repair, deliver, done.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    status: filmPipelineStatusSchema,
  }),
  execute: async (context) => {
    try {
      const film = new FilmService();
      const project = await film.setProjectStatus(context.projectId, context.status);
      return okResult({ projectId: project.id, status: project.status, project });
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const filmUpsertClipTool = createTool({
  id: 'film_upsert_clip',
  description:
    'Creates or updates a clip contract inside a Seedance film project while preserving sequence lineage and continuity fields.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    clipId: z.string().optional(),
    parentClipId: z.string().nullable().optional(),
    sequenceIndex: z.number().int().min(1).optional(),
    promptVersion: z.string().optional(),
    generationMode: filmGenerationModeSchema.default('T2V'),
    sourceClipTag: z.string().nullable().optional(),
    status: z.enum(['planned', 'ready', 'generated', 'reviewed', 'accepted', 'accepted_with_deviation', 'repair', 'rejected']).optional(),
    narrativeJob: z.string().min(1),
    alreadyHappened: z.array(z.string()).default([]),
    thisClipOnly: z.array(z.string()).default([]),
    reservedForLater: z.array(z.string()).default([]),
    plannedStartState: z.record(z.string(), z.unknown()).default({}),
    plannedEndState: z.record(z.string(), z.unknown()).default({}),
    observedStartState: z.record(z.string(), z.unknown()).nullable().optional(),
    observedEndState: z.record(z.string(), z.unknown()).nullable().optional(),
    continuityLocks: z.array(z.unknown()).default([]),
    allowedChanges: z.array(z.unknown()).default([]),
    continuityBreaks: z.array(z.unknown()).default([]),
    acceptedDeviations: z.array(z.unknown()).default([]),
    transitionIn: z.string().default(''),
    transitionOut: z.string().default(''),
    openMotionVectors: z.array(z.unknown()).default([]),
    handoffRequirements: z.array(z.unknown()).default([]),
    extensionDepth: z.number().int().min(0).default(0),
    referenceRoles: z
      .array(z.object({
        tag: z.string().min(1),
        role: z.string().min(1),
        url: z.string().optional(),
        path: z.string().optional(),
        notes: z.string().optional(),
      }))
      .optional()
      .describe('Reference images/clips to persist in the project reference_registry (e.g. user-supplied first_frame/identity photo). Tags survive unchanged across clips and feed film_generate via the registry.'),
  }),
  execute: async (context) => {
    try {
      const film = new FilmService();
      const result = await film.upsertClip(context);
      return okResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const filmRecordTakeTool = createTool({
  id: 'film_record_take',
  description:
    'Records a generated take review. Accepted takes update canon; rejected takes cannot become continuation sources.',
  inputSchema: filmTakeReviewSchema,
  execute: async (context) => {
    try {
      const film = new FilmService();
      const result = await film.recordTake(context);
      return okResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const filmGetCanonTool = createTool({
  id: 'film_get_canon',
  description: 'Returns accepted clip canon and the last accepted observed end state for continuation prompts.',
  inputSchema: z.object({
    projectId: z.string().min(1),
  }),
  execute: async (context) => {
    try {
      const film = new FilmService();
      const canon = await film.getCanon(context.projectId);
      return okResult({ canon });
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const filmCompilePromptSpecTool = createTool({
  id: 'film_compile_prompt_spec',
  description:
    'Assembles a Seedance prompt-spec and golden markdown prompt from project state and clip contract.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    clipId: z.string().min(1),
    sequenceRelation: z.enum([
      'standalone',
      'sequence_first_clip',
      'seamless_continuation',
      'intentional_next_shot',
      'bridge_between_known_states',
      'repair_tail',
      'reanchor_after_drift',
    ]).optional(),
    openingStateSource: z.enum([
      'planned_start_state',
      'observed_end_state',
      'user_supplied_final_frame',
      'source_clip',
    ]).optional(),
    currentClipAction: z.string().optional(),
    endpoint: z.string().optional(),
    naturalLanguagePrompt: z.string().optional(),
    referenceRoles: z.array(z.unknown()).optional(),
  }),
  execute: async (context) => {
    try {
      const film = new FilmService();
      const result = await film.compilePromptSpec(context);
      return okResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
});
