import { AutomationSpec } from '../types.js';
import {
  getInputString,
  codeNode,
  telegramSendNode,
  settings,
  nodeId,
  ollamaChatNode,
  agentForgePostNode,
  getN8nConfig
} from './helpers.js';

/**
 * Universal Scraper with AI Extraction pattern.
 * Fetches HTML, cleans it, extracts leads via local LLM, and saves to CRM.
 */
export function buildAiScraperToCrm(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  const targetUrl = getInputString(
    spec,
    ['url', 'target', 'website'],
    'https://www.olx.pl/rolnictwo/'
  );

  const goal = spec.goal || 'Extract leads from agricultural listings.';

  return {
    nodes: [
      {
        parameters: {
          rule: {
            interval: [
              {
                field: 'hours',
                minutes: 1
              }
            ]
          }
        },
        id: 'schedule_trigger',
        name: 'Schedule',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.1,
        position: [100, 300]
      },
      {
        parameters: {
          url: targetUrl,
          options: {}
        },
        id: 'fetch_page',
        name: 'Fetch Page',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [300, 300]
      },
      {
        parameters: {
          operation: 'extractHtmlContent',
          dataPropertyName: 'data',
          extractionValues: {
            values: [
              {
                key: 'main_content',
                cssSelector: 'body',
                returnValue: 'text',
                returnArray: false
              }
            ]
          },
          options: {}
        },
        id: 'extract_html',
        name: 'Clean HTML',
        type: 'n8n-nodes-base.html',
        typeVersion: 1,
        position: [500, 300]
      },
      codeNode(
        'Prepare for AI',
        `
// Clean up text to save tokens
const text = ($json.main_content || "").slice(0, 8000);
return {
  json: {
    prompt: \`Analyze the following website content and extract all offers/listings related to: ${goal}.

CONTENT:
\${text}

Rules:
1. Return ONLY JSON - a list of objects.
2. Each object must have: name (company/person name), contact (phone/email if present), product (assortment), location, source_url (if present).
3. If there are no offers, return an empty list [].
4. Skip ads and navigation menus.\`
  }
};
        `.trim(),
        700,
        300
      ),
      ollamaChatNode('Ollama Extract', 900, 300, 'You are a web scraping and data extraction expert. Respond only with clean JSON code.'),
      codeNode(
        'Parse AI Response',
        `
try {
  const content = $json.message.content;
  const cleanJson = content.replace(/\\\`\\\`\\\`json/g, '').replace(/\\\`\\\`\\\`/g, '').trim();
  const leads = JSON.parse(cleanJson);
  
  if (!Array.isArray(leads)) return [];
  
  return leads.map(l => ({
    json: {
      ...l,
      status: 'research_needed',
      tags: ['auto-source', 'scraper'],
      telegramMessage: \`*New Lead Found via Scraper*\\n\\n*Name:* \${l.name}\\n*Product:* \${l.product}\\n*Contact:* \${l.contact || 'N/A'}\`
    }
  }));
} catch (e) {
  return [];
}
        `.trim(),
        1100,
        300
      ),
      agentForgePostNode('Save to CRM', cfg.agentForgeCrmEndpoint, 1300, 200),
      telegramSendNode('Telegram Alert', 1300, 400)
    ],
    connections: {
      'Schedule': {
        main: [[{ node: 'Fetch Page', type: 'main', index: 0 }]]
      },
      'Fetch Page': {
        main: [[{ node: 'Clean HTML', type: 'main', index: 0 }]]
      },
      'Clean HTML': {
        main: [[{ node: 'Prepare for AI', type: 'main', index: 0 }]]
      },
      'Prepare for AI': {
        main: [[{ node: 'Ollama Extract', type: 'main', index: 0 }]]
      },
      'Ollama Extract': {
        main: [[{ node: 'Parse AI Response', type: 'main', index: 0 }]]
      },
      'Parse AI Response': {
        main: [[{ node: 'Save to CRM', type: 'main', index: 0 }, { node: 'Telegram Alert', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
