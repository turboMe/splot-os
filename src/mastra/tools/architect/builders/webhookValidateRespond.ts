import { AutomationSpec } from '../types.js';
import { getInputString, codeNode, settings } from './helpers.js';

export function buildWebhookValidateRespond(spec: AutomationSpec): any {
  const path = getInputString(
    spec,
    ['path', 'webhook'],
    'agentforge-webhook'
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
        'Validate Payload',
        `
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope;

const errors = [];

if (!payload.type) {
  errors.push('Missing required field: type');
}

if (!payload.message && !payload.text && !payload.payload) {
  errors.push('Missing message/text/payload');
}

if (errors.length > 0) {
  return [{
    json: {
      ok: false,
      errors,
      receivedAt: new Date().toISOString()
    }
  }];
}

return [{
  json: {
    ok: true,
    type: payload.type,
    message: payload.message || payload.text || '',
    payload,
    receivedAt: new Date().toISOString()
  }
}];
        `.trim(),
        450,
        300
      ),
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ $json }}',
          options: {}
        },
        id: 'respond_to_webhook',
        name: 'Respond to Webhook',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [700, 300]
      }
    ],
    connections: {
      'Webhook Trigger': {
        main: [[{ node: 'Validate Payload', type: 'main', index: 0 }]]
      },
      'Validate Payload': {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
