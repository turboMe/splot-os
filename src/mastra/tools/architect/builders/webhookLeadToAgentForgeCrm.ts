import { AutomationSpec } from '../types.js';
import { getInputString, codeNode, telegramSendNode, settings, getN8nConfig } from './helpers.js';

export function buildWebhookLeadToAgentForgeCrm(spec: AutomationSpec): any {
  const path = getInputString(
    spec,
    ['path', 'webhook'],
    'new-lead'
  );

  const cfg = getN8nConfig();
  const crmEndpoint = getInputString(
    spec,
    ['crm', 'endpoint', 'agentforge'],
    cfg.agentForgeCrmEndpoint
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
        'Normalize Lead',
        `
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope;

const lead = {
  name: payload.name || payload.fullName || payload.companyName || 'Unknown',
  email: payload.email || payload.contactEmail || null,
  company: payload.company || payload.companyName || null,
  phone: payload.phone || null,
  source: payload.source || 'n8n-webhook',
  message: payload.message || payload.text || '',
  raw: payload,
  receivedAt: new Date().toISOString()
};

return [{
  json: {
    lead,
    telegramMessage:
      '*New Lead Received*\\n\\n' +
      '*Name:* ' + lead.name + '\\n' +
      '*Company:* ' + (lead.company || 'n/a') + '\\n' +
      '*Email:* ' + (lead.email || 'n/a') + '\\n' +
      '*Source:* ' + lead.source
  }
}];
        `.trim(),
        450,
        300
      ),
      {
        parameters: {
          method: 'POST',
          url: crmEndpoint,
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ lead: $json.lead }) }}',
          options: {}
        },
        id: 'send_to_agentforge_crm',
        name: 'Send to AgentForge CRM',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [700, 300]
      },
      telegramSendNode('Telegram Alert', 950, 300),
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify({ ok: true, received: true }) }}',
          options: {}
        },
        id: 'respond_to_webhook',
        name: 'Respond to Webhook',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1200, 300]
      }
    ],
    connections: {
      'Webhook Trigger': {
        main: [[{ node: 'Normalize Lead', type: 'main', index: 0 }]]
      },
      'Normalize Lead': {
        main: [[{ node: 'Send to AgentForge CRM', type: 'main', index: 0 }]]
      },
      'Send to AgentForge CRM': {
        main: [[{ node: 'Telegram Alert', type: 'main', index: 0 }]]
      },
      'Telegram Alert': {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
