import { AutomationSpec } from '../types.js';
import { getInputString, codeNode, settings, getN8nConfig } from './helpers.js';

export function buildWebhookCommandRouterToAgentForge(spec: AutomationSpec): any {
  const path = getInputString(
    spec,
    ['path', 'webhook'],
    'agentforge-command'
  );

  const cfg = getN8nConfig();
  const taskEndpoint = getInputString(
    spec,
    ['endpoint', 'agentforge', 'queue'],
    cfg.agentForgeTaskEndpoint
  );

  return {
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path,
          responseMode: 'responseNode',
          options: {}
        },
        id: 'webhook_trigger',
        name: 'Webhook Trigger',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [200, 300]
      },
      codeNode(
        'Route Command',
        `
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope;
const command = String(payload.command || payload.type || '').toLowerCase();

let taskType = 'general.task';
let prompt = payload.prompt || payload.message || payload.text || '';

if (command.includes('marketing')) {
  taskType = 'marketing.task';
}

if (command.includes('research')) {
  taskType = 'research.task';
}

if (command.includes('crm') || command.includes('lead')) {
  taskType = 'crm.task';
}

if (!prompt) {
  return [{
    json: {
      ok: false,
      error: 'Missing prompt/message/text',
      receivedAt: new Date().toISOString()
    }
  }];
}

return [{
  json: {
    ok: true,
    taskType,
    prompt,
    source: 'n8n-webhook-command-router',
    raw: payload,
    createdAt: new Date().toISOString()
  }
}];
        `.trim(),
        450,
        300
      ),
      {
        parameters: {
          method: 'POST',
          url: taskEndpoint,
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify($json) }}',
          options: {}
        },
        id: 'send_to_agentforge_queue',
        name: 'Send to AgentForge Queue',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [700, 300]
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify({ ok: true, queued: true, taskType: $json.taskType }) }}',
          options: {}
        },
        id: 'respond_to_webhook',
        name: 'Respond to Webhook',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [950, 300]
      }
    ],
    connections: {
      'Webhook Trigger': {
        main: [[{ node: 'Route Command', type: 'main', index: 0 }]]
      },
      'Route Command': {
        main: [[{ node: 'Send to AgentForge Queue', type: 'main', index: 0 }]]
      },
      'Send to AgentForge Queue': {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
