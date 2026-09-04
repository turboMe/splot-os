import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { okResult, errorResult, storyboardSchema, type Storyboard } from './video-types.js';
import { ensureVideoProjectStructure, YOUTUBE_PROJECTS_ROOT, VIDEO_REMOTION_DIR } from './video-runner.js';

export const videoGenerateStoryboardTool = createTool({
  id: 'video_generate_storyboard',
  description:
    'Saves, validates, and registers a declarative video storyboard blueprint (storyboard.json) with segments, camera layouts, kinetic captions, overlays, and SFX cues.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier, e.g. "ep-01" or "video-1"'),
    storyboard: storyboardSchema.describe('Complete declarative storyboard structure'),
  }),
  execute: async (context) => {
    try {
      const { projectPath, workDir } = await ensureVideoProjectStructure(context.projectFolder);

      // Validate schema
      const validatedStoryboard = storyboardSchema.parse(context.storyboard);

      const targetPath = path.join(workDir, 'storyboard.json');
      await fs.writeFile(targetPath, JSON.stringify(validatedStoryboard, null, 2), 'utf-8');

      return okResult({
        projectFolder: context.projectFolder,
        storyboardPath: targetPath,
        segmentsCount: validatedStoryboard.segments.length,
        language: validatedStoryboard.language,
        aspectRatio: validatedStoryboard.aspectRatio,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});

export const videoGetStoryboardTool = createTool({
  id: 'video_get_storyboard',
  description: 'Reads the active declarative storyboard blueprint (storyboard.json) for a video project.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier, e.g. "ep-01" or "video-1"'),
  }),
  execute: async (context) => {
    try {
      const { workDir } = await ensureVideoProjectStructure(context.projectFolder);
      const targetPath = path.join(workDir, 'storyboard.json');

      if (!existsSync(targetPath)) {
        return errorResult(`Storyboard not found at ${targetPath}. Generate one first.`);
      }

      const content = await fs.readFile(targetPath, 'utf-8');
      const storyboard = JSON.parse(content);

      return okResult({
        projectFolder: context.projectFolder,
        storyboard,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});
