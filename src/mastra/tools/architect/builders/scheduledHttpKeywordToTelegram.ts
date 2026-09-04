import { AutomationSpec } from '../types.js';
import { getInputString, getInputArray, codeNode, telegramSendNode, settings } from './helpers.js';

export function buildScheduledHttpKeywordToTelegram(spec: AutomationSpec): any {
  const url = getInputString(
    spec,
    ['url', 'website', 'page', 'endpoint'],
    'https://example.com'
  );

  const keywords = getInputArray(
    spec,
    ['keyword', 'keywords', 'phrase', 'phrases'],
    ['GastroBridge']
  );

  return {
    nodes: [
      {
        parameters: {
          rule: {
            interval: [
              {
                field: 'cronExpression',
                expression: '0 8 * * *'
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
        'Filter Page Keywords',
        `
const keywords = ${JSON.stringify(keywords)}.map(k => k.toLowerCase());

return items
  .map(item => {
    const body = JSON.stringify(item.json || {});
    const lower = body.toLowerCase();
    const matchedKeywords = keywords.filter(k => lower.includes(k));

    if (matchedKeywords.length === 0) {
      return null;
    }

    return {
      json: {
        sourceUrl: ${JSON.stringify(url)},
        matchedKeywords,
        checkedAt: new Date().toISOString(),
        telegramMessage:
          '*Keyword Match Found*\\n\\n' +
          '*URL:* ${url}\\n' +
          '*Matched:* ' + matchedKeywords.join(', ') + '\\n' +
          '*Checked:* ' + new Date().toISOString()
      }
    };
  })
  .filter(Boolean);
        `.trim(),
        700,
        300
      ),
      telegramSendNode('Telegram Send', 950, 300)
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]]
      },
      'HTTP Request': {
        main: [[{ node: 'Filter Page Keywords', type: 'main', index: 0 }]]
      },
      'Filter Page Keywords': {
        main: [[{ node: 'Telegram Send', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
