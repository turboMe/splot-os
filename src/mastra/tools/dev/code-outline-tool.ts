/**
 * Structural code outline for a single file.
 *
 * This is the cheap companion to semantic search: it gives the model the
 * symbol list and line ranges before it decides which regions to read.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logHarnessEvent } from '../../services/harness-events.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { getRepoIndexer } from '../../services/repo-indexer.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';

export const codeOutlineTool = createTool({
  id: 'code_outline',
  description:
    'Get a structural outline of one source file: functions, classes, interfaces, types, methods, ' +
    'line ranges, signatures, and parent symbols. Use this before reading a large file or when ' +
    'you need to jump directly to relevant regions.',
  inputSchema: z.object({
    file: z.string().describe('Repository-relative file path, for example "src/mastra/services/repo-indexer.ts".'),
    repoPath: z.string().optional().describe(
      'Absolute repository root. Defaults to the agent codebase.',
    ),
    maxSymbols: z.number().optional().default(200).describe('Maximum number of symbols to return.'),
    taskId: z.string().optional(),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    file: z.string().optional(),
    repoPath: z.string().optional(),
    language: z.string().optional(),
    totalLines: z.number().optional(),
    symbols: z.array(z.object({
      name: z.string(),
      kind: z.string(),
      signature: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      parentSymbol: z.string().optional(),
    })).optional(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'code_outline',
    category: 'search',
    risk: 'low',
    outputPreviewMaxChars: 4000,
    execute: async (context) => {
      try {
        const targetRepo = context.repoPath || AGENTIC_AGENTS_REPO;
        const outline = await getRepoIndexer(targetRepo).getFileOutline(
          context.file,
          context.maxSymbols,
        );

        await logHarnessEvent({
          type: 'code_outline_used',
          agentId: context.agentId ?? 'codingAgent',
          runId: context.runId ?? context.taskId,
          turnId: context.turnId,
          threadId: context.threadId,
          taskId: context.taskId,
          subtaskId: context.subtaskId,
          feature: 'code_outline',
          toolId: 'code_outline',
          status: 'success',
          data: {
            file: outline.file,
            repoPath: targetRepo,
            language: outline.language,
            totalLines: outline.totalLines,
            symbolCount: outline.symbols.length,
          },
        });

        return {
          success: true,
          repoPath: targetRepo,
          ...outline,
        };
      } catch (error) {
        return {
          success: false,
          error: `Code outline error: ${(error as Error).message}`,
        };
      }
    },
  }),
});
