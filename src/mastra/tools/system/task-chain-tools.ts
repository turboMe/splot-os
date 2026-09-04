import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { META_AGENT_ID } from '../../config/agent-ids.js';
import {
  formatTaskChainContext,
  getTaskChainContext,
  saveTaskChainResult,
} from '../../services/task-chain-store.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

export const getChainContextTool = createTool({
  id: 'get_chain_context',
  description:
    'Reads durable context for a scheduled task chain. Use before continuing a multi-step scheduled chain so the next step can see prior results.',
  inputSchema: z.object({
    chainId: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional().default(20),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    chainId: z.string(),
    count: z.number(),
    context: z.string(),
    entries: z.array(z.record(z.string(), z.unknown())),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'get_chain_context',
    category: 'memory',
    risk: 'low',
    defaultAgentId: META_AGENT_ID,
    execute: async (input: { chainId: string; limit?: number }) => {
      try {
        const entries = await getTaskChainContext(input);
        return {
          success: true,
          chainId: input.chainId,
          count: entries.length,
          context: formatTaskChainContext(entries),
          entries: entries.map((entry) => ({
            ...entry,
            completedAt: entry.completedAt instanceof Date ? entry.completedAt.toISOString() : entry.completedAt,
            expiresAt: entry.expiresAt instanceof Date ? entry.expiresAt.toISOString() : entry.expiresAt,
          })),
        };
      } catch (error) {
        return {
          success: false,
          chainId: input.chainId,
          count: 0,
          context: '',
          entries: [],
          error: (error as Error).message,
        };
      }
    },
  }),
});

export const saveChainResultTool = createTool({
  id: 'save_chain_result',
  description:
    'Writes a durable result for a scheduled task chain step. Use after a step finishes so later scheduled steps can read the outcome.',
  inputSchema: z.object({
    chainId: z.string().min(1),
    stepName: z.string().min(1),
    scheduledTaskId: z.string().min(1).optional(),
    status: z.enum(['completed', 'failed']).optional().default('completed'),
    result: z.unknown().optional(),
    error: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    ttlMs: z.number().int().min(60_000).max(90 * 24 * 3600 * 1000).optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    chainId: z.string(),
    taskId: z.string().optional(),
    stepName: z.string(),
    status: z.string().optional(),
    resultPreview: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'save_chain_result',
    category: 'memory',
    risk: 'medium',
    defaultAgentId: META_AGENT_ID,
    redactInputFields: ['result', 'metadata'],
    execute: async (input: {
      chainId: string;
      stepName: string;
      scheduledTaskId?: string;
      status?: 'completed' | 'failed';
      result?: unknown;
      error?: string;
      metadata?: Record<string, unknown>;
      ttlMs?: number;
    }) => {
      try {
        const entry = await saveTaskChainResult({
          chainId: input.chainId,
          stepName: input.stepName,
          taskId: input.scheduledTaskId ?? `${input.chainId}:${input.stepName}`,
          status: input.status ?? 'completed',
          result: input.result,
          error: input.error,
          metadata: input.metadata,
          ttlMs: input.ttlMs,
        });

        return {
          success: true,
          chainId: entry.chainId,
          taskId: entry.taskId,
          stepName: entry.stepName,
          status: entry.status,
          resultPreview: entry.resultPreview,
        };
      } catch (error) {
        return {
          success: false,
          chainId: input.chainId,
          stepName: input.stepName,
          error: (error as Error).message,
        };
      }
    },
  }),
});
