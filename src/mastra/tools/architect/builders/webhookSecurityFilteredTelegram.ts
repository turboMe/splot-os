import { AutomationSpec } from '../types.js';
import { getInputString, codeNode, telegramSendNode, settings, getN8nConfig } from './helpers.js';

export function buildWebhookSecurityFilteredTelegram(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  const path = getInputString(
    spec,
    ['path', 'webhook'],
    'secure-alert'
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
        'Security Filter',
        `
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope;
const expectedToken = '${cfg.webhookSharedSecret}';

const providedToken =
  payload.token ||
  payload.secret ||
  payload.headers?.['x-agentforge-secret'] ||
  payload.headers?.['X-AgentForge-Secret'];

if (!expectedToken || providedToken !== expectedToken) {
  return [{
    json: {
      ok: false,
      statusCode: 403,
      error: 'Forbidden'
    }
  }];
}

return [{
  json: {
    ok: true,
    message: payload.message || payload.text || 'Secure webhook received',
    raw: payload,
    telegramMessage:
      '*Secure Webhook Alert*\\n\\n' +
      String(payload.message || payload.text || 'No message') + '\\n\\n' +
      '*Received:* ' + new Date().toISOString()
  }
}];
        `.trim(),
        450,
        300
      ),
      telegramSendNode('Telegram Alert', 700, 300),
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify({ ok: $json.ok }) }}',
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
        main: [[{ node: 'Security Filter', type: 'main', index: 0 }]]
      },
      'Security Filter': {
        main: [[{ node: 'Telegram Alert', type: 'main', index: 0 }]]
      },
      'Telegram Alert': {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
