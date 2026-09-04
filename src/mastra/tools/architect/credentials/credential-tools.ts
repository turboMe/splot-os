import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { resolveCredentials } from './credential-resolver.js';
import { withToolEnvelope } from '../../../services/harness-tool-envelope.js';

export const resolveCredentialsTool = createTool({
  id: 'architect_resolve_credentials',
  description: 'Maps required services to credential references in n8n.',
  inputSchema: z.object({
    required: z.array(
      z.object({
        service: z.string(),
        required: z.boolean(),
        credentialName: z.string().optional(),
      }),
    ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    credentials: z.record(
      z.string(),
      z.object({
        service: z.string(),
        n8nCredentialType: z.string(),
        id: z.string(),
        name: z.string(),
      }),
    ),
    missing: z.array(
      z.object({
        service: z.string(),
        required: z.boolean(),
        setupHint: z.string(),
      }),
    ),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_resolve_credentials',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    policy: () => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      riskHint: 'low' as const,
    }),
    execute: async (context) => {
      return resolveCredentials(context.required);
    },
  }),
});
