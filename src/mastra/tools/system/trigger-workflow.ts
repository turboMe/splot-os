/**
 * System tool: trigger a Mastra workflow by ID.
 * Replaces: BullMQ job enqueue from jarvis queue.ts.
 * Uses execution context.mastra instead of direct import to avoid circular dependency.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const triggerWorkflowTool = createTool({
  id: 'workflow_trigger',
  description: 'Triggers a registered Mastra workflow by its ID. Use this when you want to start a domain workflow (producer-hunt, weekly-content, morning-briefing, etc.) instead of executing all steps manually.',
  inputSchema: z.object({
    workflowId: z.string().describe('Workflow ID, e.g. "producer-hunt", "weekly-content", "morning-briefing", "weekly-report"'),
    payload: z.record(z.string(), z.unknown()).optional().describe('Input data for the workflow (inputData)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    runId: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context, executionContext) => {
    try {
      const mastra = executionContext?.mastra;
      if (!mastra) {
        return { success: false, error: 'Mastra instance not available in execution context.' };
      }

      let workflow: any;
      try {
        workflow = (mastra as any).getWorkflow(context.workflowId);
      } catch {
        return { success: false, error: `Workflow "${context.workflowId}" does not exist or failed to load.` };
      }

      if (!workflow) {
        return { success: false, error: `Workflow "${context.workflowId}" not found.` };
      }

      const run = await workflow.createRun();
      const result = await run.start({ inputData: context.payload ?? {} });

      return {
        success: (result as any).status !== 'failed',
        runId: run.runId as string,
        status: (result as any).status ?? 'started',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
