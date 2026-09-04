import { AutomationSpec } from '../types.js';
import { getInputArray, codeNode, telegramSendNode, settings } from './helpers.js';

export function buildMultiUrlMonitorToTelegram(spec: AutomationSpec): any {
  const urls = getInputArray(
    spec,
    ['urls', 'websites', 'pages', 'competitors'],
    ['https://example.com']
  );

  const keywords = getInputArray(
    spec,
    ['keyword', 'keywords', 'phrases'],
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
      codeNode(
        'Build URL List',
        `
const urls = ${JSON.stringify(urls)};
return urls.map(url => ({
  json: {
    url,
    checkedAt: new Date().toISOString()
  }
}));
        `.trim(),
        450,
        300
      ),
      {
        parameters: {
          url: '={{ $json.url }}',
          options: {}
        },
        id: 'http_request',
        name: 'HTTP Request',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [700, 300]
      },
      codeNode(
        'Find Matches',
        `
const keywords = ${JSON.stringify(keywords)}.map(k => k.toLowerCase());

return items
  .map(item => {
    const url = item.json.url || item.pairedItem?.item?.json?.url || 'unknown';
    const body = JSON.stringify(item.json || {});
    const lower = body.toLowerCase();
    const matchedKeywords = keywords.filter(k => lower.includes(k));

    if (matchedKeywords.length === 0) {
      return null;
    }

    return {
      json: {
        url,
        matchedKeywords,
        checkedAt: new Date().toISOString(),
        telegramMessage:
          '*Competitor Monitor Match*\\n\\n' +
          '*URL:* ' + url + '\\n' +
          '*Matched:* ' + matchedKeywords.join(', ') + '\\n' +
          '*Checked:* ' + new Date().toISOString()
      }
    };
  })
  .filter(Boolean);
        `.trim(),
        950,
        300
      ),
      telegramSendNode('Telegram Send', 1200, 300)
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Build URL List', type: 'main', index: 0 }]]
      },
      'Build URL List': {
        main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]]
      },
      'HTTP Request': {
        main: [[{ node: 'Find Matches', type: 'main', index: 0 }]]
      },
      'Find Matches': {
        main: [[{ node: 'Telegram Send', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
