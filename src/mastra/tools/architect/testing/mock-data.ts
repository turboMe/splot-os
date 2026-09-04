import { TRIGGER_TYPES } from '../validation/node-registry.js';

/**
 * Generates a synthetic payload suitable for the workflow's trigger type.
 * Used in mock test mode and as a default for manual test instructions.
 */
export function generateMockPayload(workflow: any): { triggerType: string; payload: any; instructions: string[] } {
  const nodes: any[] = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const trigger = nodes.find((n) => isTriggerNode(n.type));

  if (!trigger) {
    return {
      triggerType: 'unknown',
      payload: {},
      instructions: ['Workflow nie ma znanego trigger node — uruchom manualnie z n8n UI.'],
    };
  }

  switch (trigger.type) {
    case 'n8n-nodes-base.webhook':
      return mockWebhook(trigger);
    case 'n8n-nodes-base.scheduleTrigger':
    case 'n8n-nodes-base.cron':
      return {
        triggerType: trigger.type,
        payload: {},
        instructions: [
          `Schedule trigger — n8n nie pozwala wymusic uruchomienia z REST.`,
          `Otworz workflow w n8n UI i kliknij "Execute Workflow" zeby przetestowac manualnie.`,
        ],
      };
    case 'n8n-nodes-base.rssFeedReadTrigger':
      return {
        triggerType: trigger.type,
        payload: {},
        instructions: [
          `RSS trigger polls feedUrl=${trigger.parameters?.feedUrl ?? '<missing>'}.`,
          `Otworz workflow w n8n UI i kliknij "Execute Workflow" albo poczekaj na polling triggera.`,
        ],
      };
    case 'n8n-nodes-base.telegramTrigger':
      return {
        triggerType: trigger.type,
        payload: {
          message: { text: '/test', chat: { id: process.env.N8N_TELEGRAM_CHAT_ID || 'mock-chat' } },
        },
        instructions: [
          `Telegram trigger — wyslij testowa wiadomosc do bota: ${process.env.TELEGRAM_BOT_TOKEN ? 'token jest ustawiony' : 'BRAK TELEGRAM_BOT_TOKEN'}.`,
        ],
      };
    case 'n8n-nodes-base.gmailTrigger':
      return {
        triggerType: trigger.type,
        payload: {},
        instructions: [`Gmail trigger — wyslij testowy email i poczekaj az polling go wykryje.`],
      };
    case 'n8n-nodes-base.errorTrigger':
      return {
        triggerType: trigger.type,
        payload: {
          execution: { id: 'mock-exec-id', error: { message: 'mock error', stack: '' } },
          workflow: { id: 'mock-wf-id', name: 'mock workflow' },
        },
        instructions: [`Error trigger — uruchom manualnie inny workflow tak zeby zwrocil blad.`],
      };
    case 'n8n-nodes-base.formTrigger':
      return {
        triggerType: trigger.type,
        payload: { formData: { name: 'Test User', email: 'test@example.local' } },
        instructions: [`Form trigger — otworz publiczny URL formularza i wyslij.`],
      };
    case 'n8n-nodes-base.executeWorkflowTrigger':
      return {
        triggerType: trigger.type,
        payload: { input: 'mock' },
        instructions: [`Execute Workflow Trigger — wywolywany z innego workflowu, nie testuj samodzielnie.`],
      };
    case 'n8n-nodes-base.manualTrigger':
      return {
        triggerType: trigger.type,
        payload: {},
        instructions: [`Manual trigger — kliknij "Execute Workflow" w n8n UI.`],
      };
    default:
      return {
        triggerType: trigger.type ?? 'unknown',
        payload: {},
        instructions: [`Nieznany trigger type: ${trigger.type}. Test manualnie z n8n UI.`],
      };
  }
}

function mockWebhook(trigger: any): { triggerType: string; payload: any; instructions: string[] } {
  const path = trigger.parameters?.path ?? '<unknown-path>';
  const method = String(trigger.parameters?.httpMethod ?? trigger.parameters?.method ?? 'POST').toUpperCase();
  const publicBase = process.env.N8N_PUBLIC_WEBHOOK_BASE_URL;
  const localBase = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
  const isPublic = publicBase && !publicBase.includes('localhost') && !publicBase.includes('replace-me');
  const baseUrl = isPublic ? publicBase : localBase;

  return {
    triggerType: 'n8n-nodes-base.webhook',
    payload: {
      test: true,
      message: 'mock webhook payload',
      timestamp: new Date().toISOString(),
    },
    instructions: [
      `Webhook URL (test): ${baseUrl}/webhook-test/${path}`,
      `Webhook URL (production, po activate): ${baseUrl}/webhook/${path}`,
      `Wywolaj: curl -X ${method} -H "Content-Type: application/json" -d '{"test":true}' ${baseUrl}/webhook-test/${path}`,
    ],
  };
}

function isTriggerNode(type: string): boolean {
  if (!type) return false;
  return TRIGGER_TYPES.has(type) || type.endsWith('Trigger');
}
