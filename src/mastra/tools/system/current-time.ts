/**
 * system.current_time — Returns the current UTC timestamp in ISO 8601 format.
 *
 * Prevents model hallucination of non-existent datetime tools (e.g. "isoformat").
 * Lightweight, no external dependencies.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const currentTimeTool = createTool({
  id: 'system_current_time',
  description:
    'Returns the current date and time in ISO 8601 format (UTC). Use this whenever you need a timestamp for logging, diagnostics, or reports.',

  inputSchema: z.object({}),

  outputSchema: z.object({
    iso: z.string().describe('Current UTC time in ISO 8601 format'),
    unix: z.number().describe('Unix timestamp in milliseconds'),
  }),

  execute: async () => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      unix: now.getTime(),
    };
  },
});
