import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { okResult, errorResult } from './video-types.js';
import { runVideoScript, ensureVideoProjectStructure } from './video-runner.js';

export const videoBakeMasterTool = createTool({
  id: 'video_bake_master',
  description:
    'Composites Remotion TSX shots (cutaways, overlays, split screens), SFX cues, and background music onto the master talking-head cut into a final 4K video.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier, e.g. "video-1"'),
    timelineJsonPath: z.string().optional().describe('Optional custom path to timeline.json (default: <project>/work/timeline.json)'),
    endSeconds: z.number().optional().describe('Optional preview render duration cutoff in seconds'),
    keepTempSegments: z.boolean().default(false).describe('Keep intermediate frame/render segments'),
  }),
  execute: async (context) => {
    try {
      const { workDir, outputDir, projectPath } = await ensureVideoProjectStructure(context.projectFolder);
      const timelinePath = context.timelineJsonPath || path.join(workDir, 'timeline.json');

      const args = [timelinePath];
      if (context.endSeconds) {
        args.push('--end', String(context.endSeconds));
      }
      if (context.keepTempSegments) {
        args.push('--keep');
      }

      const output = await runVideoScript('bake.py', args);

      // Link or copy output to /projekty/splot-projects/youtube-agent/output/<project>/
      const bakedCandidates = [
        path.join(workDir, 'final_baked_4k.mp4'),
        path.join(projectPath, 'final_baked_4k.mp4'),
        path.join(workDir, 'master_cut.mp4'),
      ];
      let finalBakedPath: string | undefined;
      for (const cand of bakedCandidates) {
        try {
          await fs.access(cand);
          const dest = path.join(outputDir, path.basename(cand));
          await fs.copyFile(cand, dest);
          finalBakedPath = dest;
          break;
        } catch {}
      }

      return okResult({
        projectFolder: context.projectFolder,
        timelinePath,
        finalBakedPath,
        outputDir,
        logs: output.stdout,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});
