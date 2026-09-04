import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { MongoClient } from 'mongodb';
import { getRuntimeTopology } from '../../config/runtime-topology.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

export const runtimeCheckTool = createTool({
  id: 'architect_runtime_check',
  description: 'Checks the readiness of the runtime environment for n8n automations.',
  inputSchema: z.object({
    requiresPublicWebhook: z.boolean().optional(),
    requiresMastraApi: z.boolean().optional(),
    requiresOllama: z.boolean().optional(),
    requiresMongo: z.boolean().optional(),
    requiresTelegram: z.boolean().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    topology: z.any(),
    checks: z.array(
      z.object({
        key: z.string(),
        ok: z.boolean(),
        severity: z.enum(['info', 'warning', 'blocker']),
        message: z.string(),
      }),
    ),
    missingConfig: z.array(
      z.object({
        key: z.string(),
        required: z.boolean(),
        description: z.string(),
      }),
    ),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_runtime_check',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    policy: () => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    const topology = getRuntimeTopology();
    const checks: any[] = [];
    const missingConfig: any[] = [];
    let overallOk = true;

    // 1. n8n health check
    try {
      const response = await fetch(`${topology.n8nRestBaseUrl}/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        checks.push({ key: 'n8n', ok: true, severity: 'info', message: 'n8n API is reachable' });
      } else {
        checks.push({ key: 'n8n', ok: false, severity: 'blocker', message: `n8n returned status ${response.status}` });
        overallOk = false;
      }
    } catch (e) {
      checks.push({ key: 'n8n', ok: false, severity: 'blocker', message: `Could not reach n8n at ${topology.n8nRestBaseUrl}` });
      overallOk = false;
    }

    // 2. n8n API Key check
    if (!process.env.N8N_API_KEY) {
      missingConfig.push({ key: 'N8N_API_KEY', required: true, description: 'Required for n8n API communication' });
      overallOk = false;
    }

    // 3. Mastra API check from the URL that gets baked into n8n workflows.
    if (context.requiresMastraApi) {
      const mastraBase = topology.mastraApiUrlForN8n.replace(/\/$/, '');
      try {
        const response = await fetch(`${mastraBase}/api`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.status < 500) {
          checks.push({ key: 'mastra_api', ok: true, severity: 'info', message: `Mastra API is reachable at ${mastraBase}` });
        } else {
          checks.push({
            key: 'mastra_api',
            ok: false,
            severity: 'blocker',
            message: `Mastra API returned status ${response.status} at ${mastraBase}`,
          });
          overallOk = false;
        }
      } catch {
        checks.push({
          key: 'mastra_api',
          ok: false,
          severity: 'blocker',
          message: `Could not reach Mastra API at ${mastraBase}`,
        });
        overallOk = false;
      }
    }

    // 4. Public Webhook check
    if (context.requiresPublicWebhook) {
      const isPublic =
        topology.n8nPublicWebhookBaseUrl &&
        !topology.n8nPublicWebhookBaseUrl.includes('localhost') &&
        !topology.n8nPublicWebhookBaseUrl.includes('127.0.0.1');

      if (!isPublic) {
        checks.push({
          key: 'public_webhook',
          ok: false,
          severity: 'blocker',
          message: 'Public webhook URL is missing or points to localhost',
        });
        missingConfig.push({
          key: 'N8N_PUBLIC_WEBHOOK_BASE_URL',
          required: true,
          description: 'Required for external webhooks',
        });
        overallOk = false;
      } else {
        checks.push({ key: 'public_webhook', ok: true, severity: 'info', message: 'Public webhook URL is configured' });
      }
    }

    // 5. Ollama check
    if (context.requiresOllama) {
      try {
        const response = await fetch(`${topology.ollamaBaseUrlForN8n}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          checks.push({ key: 'ollama', ok: true, severity: 'info', message: 'Ollama is reachable' });
        } else {
          checks.push({
            key: 'ollama',
            ok: false,
            severity: 'blocker',
            message: `Ollama returned status ${response.status}`,
          });
          overallOk = false;
        }
      } catch (e) {
        checks.push({
          key: 'ollama',
          ok: false,
          severity: 'blocker',
          message: `Could not reach Ollama at ${topology.ollamaBaseUrlForN8n}`,
        });
        overallOk = false;
      }
    }

    // 6. Mongo check
    if (context.requiresMongo) {
      const client = new MongoClient(topology.mongoUriForMastra, { serverSelectionTimeoutMS: 3000 });
      try {
        await client.connect();
        await client.db(topology.mongoDbName).command({ ping: 1 });
        checks.push({
          key: 'mongo',
          ok: true,
          severity: 'info',
          message: `MongoDB is reachable; n8n host hint is ${topology.mongoHostForN8n}`,
        });
      } catch {
        checks.push({
          key: 'mongo',
          ok: false,
          severity: 'blocker',
          message: `Could not reach MongoDB at ${topology.mongoUriForMastra}`,
        });
        overallOk = false;
      } finally {
        await client.close().catch(() => {});
      }
    }

    // 7. Telegram check
    if (context.requiresTelegram) {
      if (!process.env.N8N_TELEGRAM_CHAT_ID && !process.env.TELEGRAM_CHAT_ID) {
        missingConfig.push({ key: 'N8N_TELEGRAM_CHAT_ID', required: true, description: 'Required for Telegram alerts' });
        overallOk = false;
      } else {
        checks.push({ key: 'telegram', ok: true, severity: 'info', message: 'Telegram chat ID is configured' });
      }
    }

    return {
      ok: overallOk,
      topology,
      checks,
      missingConfig,
    };
    }
  }),
});
