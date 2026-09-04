/**
 * Hunt pipeline state-machine tools (Phase 2).
 * Mirror of the content/chef state tools (start / get / list / set_status). These give the
 * huntAgent resumable, auditable state across the pipeline phases (intake → … → done).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { HuntService, HUNT_PIPELINE_STATUSES } from './hunt-service.js';

export const huntStartRunTool = createTool({
  id: 'hunt_start_run',
  description:
    'Starts a new hunt run (a batch of leads for one free-form intent). Creates the run in status ' +
    '"intake" and returns its ID. Call once at the start of a hunt, right after parsing the HuntBrief ' +
    'in intake. Pass the resolved market + outputLanguage (from hunt_get_market_pack) and marketDegraded ' +
    'so the Hunt Report can flag a degraded foreign market.',
  inputSchema: z.object({
    name: z.string().describe('Run name, e.g. "Goat-cheese producers — Dolnośląskie (5)".'),
    brief: z.string().describe('The original free-form intent for this hunt.'),
    targetKind: z.enum(['supplier', 'restaurant']).default('supplier').describe('What we are hunting. Phase 2: "supplier".'),
    region: z.string().optional().describe('Target region for scoring, e.g. "Dolnośląskie".'),
    market: z.string().default('pl').describe('Market locale (Market Pack). Default "pl".'),
    outputLanguage: z.string().optional().describe('Email/output language. Defaults to the market language.'),
    count: z.number().int().min(1).max(200).optional().describe('How many qualified, drafted leads to deliver.'),
    marketDegraded: z.boolean().optional().describe('true when the active Market Pack is degraded (best-effort).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    run: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const hunt = new HuntService();
      const run = await hunt.createRun({
        name: context.name,
        brief: context.brief,
        targetKind: context.targetKind,
        region: context.region,
        market: context.market,
        outputLanguage: context.outputLanguage,
        count: context.count,
        marketDegraded: context.marketDegraded,
      });
      return { success: true, run };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const huntGetRunTool = createTool({
  id: 'hunt_get_run',
  description: 'Fetches a hunt run with its brief, target kind, market, count and current pipeline status.',
  inputSchema: z.object({
    runId: z.string().describe('Hunt run UUID.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    run: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const hunt = new HuntService();
      const run = await hunt.getRun(context.runId);
      if (!run) return { success: false, error: `Hunt run ${context.runId} not found.` };
      return { success: true, run };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const huntListRunsTool = createTool({
  id: 'hunt_list_runs',
  description: 'Lists hunt runs with their statuses. Optionally filter by pipeline status. Use to resume an in-flight hunt.',
  inputSchema: z.object({
    status: z.enum(HUNT_PIPELINE_STATUSES).optional().describe('Filter by pipeline status.'),
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    runs: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const hunt = new HuntService();
      const runs = await hunt.listRuns(
        context.status ? { status: context.status } : undefined,
        context.limit ?? 10,
      );
      return {
        success: true,
        count: runs.length,
        runs: runs.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          targetKind: r.targetKind,
          region: r.region,
          market: r.market,
          count: r.count,
          updatedAt: r.updatedAt,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const huntSetRunStatusTool = createTool({
  id: 'hunt_set_run_status',
  description:
    'Sets the run status in the pipeline state machine. Call on EVERY phase change so the run is ' +
    'resumable and auditable. Statuses: intake, discover, score, enrich, extract_email, draft, ' +
    'assemble, checkpoint_review, ship, done.',
  inputSchema: z.object({
    runId: z.string().describe('Hunt run UUID.'),
    status: z.enum(HUNT_PIPELINE_STATUSES).describe('New pipeline phase status.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    runId: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const hunt = new HuntService();
      const run = await hunt.getRun(context.runId);
      if (!run) return { success: false, error: `Hunt run ${context.runId} not found.` };
      await hunt.updateRunStatus(context.runId, context.status);
      return { success: true, runId: context.runId, status: context.status };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const huntStateTools = {
  huntStartRunTool,
  huntGetRunTool,
  huntListRunsTool,
  huntSetRunStatusTool,
};
