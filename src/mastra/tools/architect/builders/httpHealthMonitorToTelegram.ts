import { AutomationSpec } from '../types.js';
import { getInputString, codeNode, telegramSendNode, settings } from './helpers.js';
import { getRuntimeTopology } from '../../../config/runtime-topology.js';

export function buildHttpHealthMonitorToTelegram(spec: AutomationSpec): any {
  const defaultHealthUrl = getRuntimeTopology().mastraApiUrlForN8n;
  const url = getInputString(
    spec,
    ['url', 'endpoint', 'health'],
    defaultHealthUrl
  );

  const expectedText = getInputString(
    spec,
    ['expected', 'contains', 'text'],
    ''
  );

  return {
    nodes: [
      {
        parameters: {
          rule: {
            interval: [
              {
                field: 'cronExpression',
                expression: '*/15 * * * *'
              }
            ]
          }
        },
        id: 'schedule_trigger',
        name: 'Schedule Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [200, 300]
      },
      {
        parameters: {
          url,
          options: {}
        },
        id: 'http_request',
        name: 'HTTP Request',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [450, 300]
      },
      codeNode(
        'Check Health',
        `
const expectedText = ${JSON.stringify(expectedText)};
const body = JSON.stringify(items[0]?.json || {});
const isHealthy = expectedText
  ? body.includes(expectedText)
  : Boolean(body && body.length > 2);

if (isHealthy) {
  return [];
}

return [{
  json: {
    url: ${JSON.stringify(url)},
    checkedAt: new Date().toISOString(),
    telegramMessage:
      '*Health Check Failed*\\n\\n' +
      '*URL:* ${url}\\n' +
      '*Expected:* ' + (expectedText || 'non-empty response') + '\\n' +
      '*Checked:* ' + new Date().toISOString()
  }
}];
        `.trim(),
        700,
        300
      ),
      telegramSendNode('Telegram Alert', 950, 300)
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]]
      },
      'HTTP Request': {
        main: [[{ node: 'Check Health', type: 'main', index: 0 }]]
      },
      'Check Health': {
        main: [[{ node: 'Telegram Alert', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
