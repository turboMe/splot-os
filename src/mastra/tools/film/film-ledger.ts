import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { FilmService } from './film-service.js';
import { filmGenerationRunSchema } from '../../lib/film-schemas.js';

export const filmAppendGenerationRunTool = createTool({
  id: 'film_append_generation_run',
  description:
    'Appends or updates a Seedance generation-run ledger row. film_generate calls this automatically; use manually only for recovered/imported runs.',
  inputSchema: filmGenerationRunSchema,
  execute: async (context) => {
    try {
      const film = new FilmService();
      const run = await film.appendGenerationRun(context);
      return { success: true, run };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const filmListGenerationRunsTool = createTool({
  id: 'film_list_generation_runs',
  description: 'Lists generation-run ledger rows for a film project.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (context) => {
    try {
      const film = new FilmService();
      const runs = await film.listGenerationRuns(context.projectId, context.limit);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
