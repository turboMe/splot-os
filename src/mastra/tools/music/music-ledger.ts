import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { MusicService } from './music-service.js';
import { musicGenerationRunSchema } from '../../lib/music-schemas.js';

export const musicAppendGenerationRunTool = createTool({
  id: 'music_append_generation_run',
  description:
    'Appends or updates a music generation-run ledger row. music_generate calls this automatically; use manually only for recovered/imported runs.',
  inputSchema: musicGenerationRunSchema,
  execute: async (context) => {
    try {
      const music = new MusicService();
      const run = await music.appendGenerationRun(context);
      return { success: true, run };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const musicListGenerationRunsTool = createTool({
  id: 'music_list_generation_runs',
  description: 'Lists generation-run ledger rows for a music project.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const runs = await music.listGenerationRuns(context.projectId, context.limit);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
