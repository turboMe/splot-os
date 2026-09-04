import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { cutSegmentSchema, okResult, errorResult } from './video-types.js';
import { ensureVideoProjectStructure, runVideoScript } from './video-runner.js';

export const videoGenerateCutsTool = createTool({
  id: 'video_generate_cuts',
  description:
    'Saves or updates the cuts.json plan for a video project specifying which time segments to keep or discard.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier, e.g. "video-1"'),
    clipId: z.string().default('master').describe('Clip or file identifier'),
    cuts: z.array(cutSegmentSchema).describe('List of segments to keep with startMs and endMs'),
    notes: z.string().optional().describe('Notes or context regarding cut decisions'),
  }),
  execute: async (context) => {
    try {
      const { projectPath, workDir } = await ensureVideoProjectStructure(context.projectFolder);
      const cutsFilePath = path.join(workDir, 'cuts.json');

      let cutsData: Record<string, unknown> = {};
      try {
        cutsData = JSON.parse(await fs.readFile(cutsFilePath, 'utf-8'));
      } catch {
        cutsData = {};
      }

      const clipId = context.clipId || 'master';
      cutsData[clipId] = {
        updatedAt: new Date().toISOString(),
        notes: context.notes || 'Auto-generated cuts by SPLOT OS filmmakerAgent',
        keeps: context.cuts.map((c) => [c.startMs / 1000, c.endMs / 1000]),
      };

      await fs.writeFile(cutsFilePath, JSON.stringify(cutsData, null, 2), 'utf-8');

      return okResult({
        projectFolder: context.projectFolder,
        cutsFilePath,
        clipId,
        segmentsCount: context.cuts.length,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});

export const videoRenderCutsTool = createTool({
  id: 'video_render_cuts',
  description:
    'Renders the jump-cut edited master video from cuts.json and outputs master_cut.mp4 and edited-transcript.json.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier, e.g. "video-1"'),
    style: z.enum(['tight', 'natural', 'snappy']).default('tight').describe('Pause compression style'),
    mode: z.enum(['preview', 'final']).default('preview').describe('Render mode: preview (fast 720p) or final (4K60 10-bit)'),
  }),
  execute: async (context) => {
    try {
      const style = context.style || 'tight';
      const mode = context.mode || 'preview';
      const args: string[] = [context.projectFolder, '--style', style, '--mode', mode];
      const output = await runVideoScript('render_cuts.py', args);


      const { projectPath, workDir } = await ensureVideoProjectStructure(context.projectFolder);
      const editedTranscriptPath = path.join(workDir, 'edited-transcript.json');
      const referenceMasterCut = path.join(projectPath, 'reference', 'master.mp4');

      let editedWordsCount = 0;
      try {
        const trData = JSON.parse(await fs.readFile(editedTranscriptPath, 'utf-8'));
        editedWordsCount = (trData.words || []).length;
      } catch {
        // file may be generated at custom path
      }

      return okResult({
        projectFolder: context.projectFolder,
        style: context.style,
        mode: context.mode,
        editedTranscriptPath,
        referenceMasterCut,
        wordsCount: editedWordsCount,
        logs: output.stdout,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});
