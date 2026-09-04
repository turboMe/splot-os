import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';

export const writeDebateArtifactTool = createTool({
  id: 'deliberation_write_artifact',
  description: 'Write a debate artifact file to disk under /artifacts/debates/{date}/{slug}/.',
  inputSchema: z.object({
    slug: z.string().describe('Task slug for folder name (kebab-case)'),
    fileName: z.enum([
      '01-debate-notes.md',
      '02-decision-brief.md',
      '03-implementation-plan.md',
      '04-risk-register.md',
      '05-agent-task-briefs.md',
      'metadata.json'
    ]),
    content: z.string().describe('File content to write'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const artifactsRoot = path.resolve(AGENTIC_AGENTS_REPO, 'artifacts', 'debates', dateStr, input.slug);
      
      await fs.mkdir(artifactsRoot, { recursive: true });
      
      const filePath = path.resolve(artifactsRoot, input.fileName);
      await fs.writeFile(filePath, input.content, 'utf-8');
      
      return {
        success: true,
        path: filePath,
      };
    } catch (err: any) {
      return {
        success: false,
        path: '',
        error: err.message || 'Unknown error occurred while writing artifact.',
      };
    }
  },
});
