import { AutomationSpec } from '../types.js';
import { getRuntimeTopology } from '../../../config/runtime-topology.js';
import { getCredentialFromRegistry } from '../credentials/credential-registry.js';
import { infrastructure, resolveModelId } from '../../../config/model-manifest.js';

/**
 * Runtime configuration for n8n workflow generation.
 * Replaces $vars.* which is NOT available in n8n Community Edition.
 * Values are injected at workflow generation time from process.env.
 */
export interface N8nRuntimeConfig {
  telegramChatId: string;
  ollamaBaseUrl: string;
  defaultLocalModel: string;
  reasoningLocalModel: string;
  agentForgeTaskEndpoint: string;
  agentForgeMemoryEndpoint: string;
  agentForgeCrmEndpoint: string;
  agentForgeApprovalEndpoint: string;
  geminiGatewayEndpoint: string;
  webhookSharedSecret: string;
}

/**
 * Reads n8n config from environment variables and runtime topology.
 * Called at workflow generation time — values are baked into the workflow JSON.
 *
 * Default model names are sourced from model-manifest.ts (Single Source of Truth).
 * Env vars OLLAMA_DEFAULT_MODEL / OLLAMA_REASONING_MODEL override manifest defaults.
 */
export function getN8nConfig(): N8nRuntimeConfig {
  const topology = getRuntimeTopology();
  const mastraApiBase = topology.mastraApiUrlForN8n.replace(/\/$/, '');

  // Extract raw Ollama model name from manifest ID:
  // 'ollama/local/gemma4:26b' → 'gemma4:26b'
  const manifestDefault = resolveModelId(infrastructure.n8n.defaultModel).replace(/^ollama\/local\//, '');
  const manifestReasoning = resolveModelId(infrastructure.n8n.reasoningModel).replace(/^ollama\/local\//, '');

  return {
    telegramChatId: process.env.N8N_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '',
    ollamaBaseUrl: topology.ollamaBaseUrlForN8n,
    defaultLocalModel: process.env.OLLAMA_DEFAULT_MODEL || manifestDefault,
    reasoningLocalModel: process.env.OLLAMA_REASONING_MODEL || manifestReasoning,
    agentForgeTaskEndpoint: process.env.AGENTFORGE_TASK_ENDPOINT || `${mastraApiBase}/api/tasks`,
    agentForgeMemoryEndpoint: process.env.AGENTFORGE_MEMORY_ENDPOINT || `${mastraApiBase}/api/shared-memory`,
    agentForgeCrmEndpoint: process.env.AGENTFORGE_CRM_ENDPOINT || `${mastraApiBase}/api/crm`,
    agentForgeApprovalEndpoint: process.env.AGENTFORGE_APPROVAL_ENDPOINT || `${mastraApiBase}/api/approvals`,
    geminiGatewayEndpoint: process.env.GEMINI_GATEWAY_ENDPOINT || `${mastraApiBase}/api/agents/gemini`,
    webhookSharedSecret: process.env.WEBHOOK_SHARED_SECRET || process.env.JWT_SECRET || 'agentforge-dev',
  };
}

export type AnyInput = {
  name: string;
  type?: string;
  description?: string;
  value?: unknown;
  defaultValue?: unknown;
  url?: unknown;
  aliases?: string[];
};

export function findInput(spec: AutomationSpec, aliases: string[]): AnyInput | undefined {
  return (spec.inputs as AnyInput[]).find((input) => {
    const name = input.name.toLowerCase();
    const inputAliases = input.aliases || [];
    return aliases.some(
      (alias) => {
        const a = alias.toLowerCase();
        return name.includes(a) || a.includes(name) || inputAliases.some((al) => {
          const inputAlias = al.toLowerCase();
          return inputAlias.includes(a) || a.includes(inputAlias);
        });
      },
    );
  });
}

export function getInputString(
  spec: AutomationSpec,
  aliases: string[],
  fallback: string
): string {
  const input = findInput(spec, aliases);

  const raw =
    input?.value ??
    input?.defaultValue ??
    input?.url ??
    undefined;

  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }

  return fallback;
}

export function getInputArray(
  spec: AutomationSpec,
  aliases: string[],
  fallback: string[]
): string[] {
  const input = findInput(spec, aliases);

  const raw =
    input?.value ??
    input?.defaultValue ??
    undefined;

  if (Array.isArray(raw)) {
    return raw.map(String).map(v => v.trim()).filter(Boolean);
  }

  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
  }

  return fallback;
}

export function nodeId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function settings() {
  return {
    executionOrder: 'v1',
  };
}

export function telegramSendNode(name = 'Telegram Send', x = 700, y = 300) {
  const cfg = getN8nConfig();
  const cred = getCredentialFromRegistry('telegram');

  const node: any = {
    parameters: {
      chatId: cfg.telegramChatId,
      text: '={{ $json.telegramMessage }}',
      additionalFields: {
        parse_mode: 'Markdown',
      },
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1,
    position: [x, y],
  };

  if (cred) {
    node.credentials = {
      [cred.n8nCredentialType]: {
        id: cred.id,
        name: cred.name,
      },
    };
  }

  return node;
}

export function telegramTriggerNode(name = 'Telegram Trigger', x = 200, y = 300, typeVersion = 1.2) {
  const cred = getCredentialFromRegistry('telegram');
  const node: any = {
    parameters: {
      updates: ['message'],
      additionalFields: {},
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.telegramTrigger',
    typeVersion,
    position: [x, y],
  };

  if (cred) {
    node.credentials = {
      [cred.n8nCredentialType]: {
        id: cred.id,
        name: cred.name,
      },
    };
  }

  return node;
}

export function gmailTriggerNode(name = 'Gmail Trigger', x = 200, y = 300, typeVersion = 1) {
  const cred = getCredentialFromRegistry('gmail');
  const node: any = {
    parameters: {
      filters: {},
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.gmailTrigger',
    typeVersion,
    position: [x, y],
  };

  if (cred) {
    node.credentials = {
      [cred.n8nCredentialType]: {
        id: cred.id,
        name: cred.name,
      },
    };
  }

  return node;
}

export function codeNode(name: string, jsCode: string, x: number, y: number) {
  return {
    parameters: {
      jsCode
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [x, y]
  };
}

export function ollamaChatNode(name = 'Ollama Chat', x = 700, y = 300, systemPrompt?: string) {
  const cfg = getN8nConfig();
  const jsonBody = systemPrompt
    ? `={{ JSON.stringify({ model: '${cfg.defaultLocalModel}', stream: false, messages: [{ role: 'system', content: '${systemPrompt.replace(/'/g, "\\'")}' }, { role: 'user', content: JSON.stringify($json).slice(0, 5000) }] }) }}`
    : '={{ JSON.stringify($json.ollamaRequest) }}';

  return {
    parameters: {
      method: 'POST',
      url: `${cfg.ollamaBaseUrl}/api/chat`,
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody,
      options: {}
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [x, y]
  };
}

export function agentForgePostNode(
  name: string,
  endpointExpression: string,
  x: number,
  y: number
) {
  return {
    parameters: {
      method: 'POST',
      url: endpointExpression,
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json) }}',
      options: {}
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [x, y]
  };
}
