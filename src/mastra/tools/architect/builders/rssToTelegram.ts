import { AutomationSpec } from '../types.js';
import { getInputString, getInputArray, codeNode, telegramSendNode, settings } from './helpers.js';

/**
 * Enhanced RSS -> Keyword Filter -> Telegram pattern.
 */
export function buildRssKeywordToTelegram(spec: AutomationSpec): any {
  const rssUrl = getInputString(
    spec,
    ['rss', 'feed', 'url'],
    'https://n8n.io/blog/rss.xml'
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
          url: rssUrl
        },
        id: 'rss_read',
        name: 'RSS Read',
        type: 'n8n-nodes-base.rssFeedRead',
        typeVersion: 1,
        position: [250, 300]
      },
      codeNode(
        'Filter Keywords',
        `
const keywords = ${JSON.stringify(keywords)}.map(k => k.toLowerCase());

return items
  .map(item => {
    const title = String(item.json.title || '');
    const content = String(item.json.content || item.json.contentSnippet || item.json.description || '');
    const link = String(item.json.link || '');

    const haystack = [title, content, link].join(' ').toLowerCase();
    const matchedKeywords = keywords.filter(k => haystack.includes(k));

    if (matchedKeywords.length === 0) {
      return null;
    }

    return {
      json: {
        ...item.json,
        matchedKeywords,
        telegramMessage:
          '*New RSS Match Found*\\n\\n' +
          '*Title:* ' + title + '\\n' +
          '*Matched:* ' + matchedKeywords.join(', ') + '\\n' +
          '*Link:* ' + link
      }
    };
  })
  .filter(Boolean);
        `.trim(),
        500,
        300
      ),
      telegramSendNode('Telegram Send', 750, 300)
    ],
    connections: {
      'RSS Read': {
        main: [[{ node: 'Filter Keywords', type: 'main', index: 0 }]]
      },
      'Filter Keywords': {
        main: [[{ node: 'Telegram Send', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
