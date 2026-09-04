import { AutomationSpec } from '../types.js';
import {
  getInputString,
  getInputArray,
  codeNode,
  agentForgePostNode,
  telegramSendNode,
  telegramTriggerNode,
  ollamaChatNode,
  settings,
  getN8nConfig
} from './helpers.js';

/**
 * Pattern 1: Webhook Idempotency Guard
 * Prevents double processing of the same event.
 */
export function buildWebhookIdempotencyGuard(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  const path = getInputString(spec, ['path', 'webhook'], 'idempotent-event');

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
        'Build Idempotency Key',
        `
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope;

const rawKey =
  payload.id ||
  payload.eventId ||
  payload.message_id ||
  payload.email ||
  JSON.stringify(payload).slice(0, 1000);

let hash = 0;
for (let i = 0; i < rawKey.length; i++) {
  hash = ((hash << 5) - hash) + rawKey.charCodeAt(i);
  hash |= 0;
}

const idempotencyKey = 'event_' + Math.abs(hash);

return [{
  json: {
    idempotencyKey,
    payload,
    receivedAt: new Date().toISOString()
  }
}];
        `.trim(),
        450,
        300
      ),
      agentForgePostNode(
        'Check Idempotency',
        `${cfg.agentForgeMemoryEndpoint}/idempotency/check`,
        700,
        300
      ),
      codeNode(
        'Skip Duplicates',
        `
const alreadyProcessed =
  $json.alreadyProcessed === true ||
  $json.exists === true ||
  $json.duplicate === true;

if (alreadyProcessed) {
  return [{
    json: {
      ok: true,
      skipped: true,
      reason: 'Duplicate event',
      idempotencyKey: $json.idempotencyKey,
      telegramMessage:
        '*Duplicate event skipped*\\n\\n' +
        '*Key:* ' + $json.idempotencyKey
    }
  }];
}

return [{
  json: {
    ...$json,
    ok: true,
    skipped: false,
    shouldProcess: true
  }
}];
        `.trim(),
        950,
        300
      ),
      agentForgePostNode(
        'Mark Event Processed',
        `${cfg.agentForgeMemoryEndpoint}/idempotency/save`,
        1200,
        300
      ),
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify({ ok: true, skipped: $json.skipped || false, idempotencyKey: $json.idempotencyKey }) }}',
          options: {}
        },
        id: 'respond_to_webhook',
        name: 'Respond to Webhook',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1450, 300]
      }
    ],
    connections: {
      'Webhook Trigger': {
        main: [[{ node: 'Build Idempotency Key', type: 'main', index: 0 }]]
      },
      'Build Idempotency Key': {
        main: [[{ node: 'Check Idempotency', type: 'main', index: 0 }]]
      },
      'Check Idempotency': {
        main: [[{ node: 'Skip Duplicates', type: 'main', index: 0 }]]
      },
      'Skip Duplicates': {
        main: [[{ node: 'Mark Event Processed', type: 'main', index: 0 }]]
      },
      'Mark Event Processed': {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * Pattern 2: Telegram Memory Search -> Ollama Answer
 * Local RAG assistant via Telegram.
 */
export function buildTelegramMemorySearchOllamaAnswer(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      telegramTriggerNode('Telegram Trigger', 200, 300, 1.2),
      codeNode(
        'Parse Ask Command',
        `
const msg = items[0]?.json?.message || items[0]?.json || {};
const text = String(msg.text || '').trim();

if (!text.startsWith('/ask')) {
  return [];
}

const query = text.replace('/ask', '').trim();

if (!query) {
  return [{
    json: {
      telegramMessage: 'Usage: /ask <question for memory>'
    }
  }];
}

return [{
  json: {
    query,
    requestedAt: new Date().toISOString()
  }
}];
        `.trim(),
        450,
        300
      ),
      {
        parameters: {
          method: 'GET',
          url: `={{ "${cfg.agentForgeMemoryEndpoint}/search?q=" + encodeURIComponent($json.query) + "&limit=10" }}`,
          options: {}
        },
        id: 'search_memory',
        name: 'Search Memory',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [700, 300]
      },
      codeNode(
        'Build RAG Prompt',
        `
const query = $json.query || 'unknown query';
const memory = JSON.stringify($json).slice(0, 12000);

return [{
  json: {
    query,
    memory,
    ollamaRequest: {
      model: '${cfg.defaultLocalModel}',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You answer using only the provided AgentForge memory context. If the answer is not present, say that clearly. Answer in Polish unless the user asked otherwise.'
        },
        {
          role: 'user',
          content:
            'Question: ' + query + '\\n\\n' +
            'Memory context:\\n' + memory
        }
      ]
    }
  }
}];
        `.trim(),
        950,
        300
      ),
      ollamaChatNode('Ollama Memory Answer', 1200, 300),
      codeNode(
        'Build Telegram Answer',
        `
const answer = $json.message?.content || $json.response || JSON.stringify($json);

return [{
  json: {
    telegramMessage:
      '*Memory Answer*\\n\\n' +
      answer.slice(0, 3500)
  }
}];
        `.trim(),
        1450,
        300
      ),
      telegramSendNode('Telegram Send', 1700, 300)
    ],
    connections: {
      'Telegram Trigger': {
        main: [[{ node: 'Parse Ask Command', type: 'main', index: 0 }]]
      },
      'Parse Ask Command': {
        main: [[{ node: 'Search Memory', type: 'main', index: 0 }]]
      },
      'Search Memory': {
        main: [[{ node: 'Build RAG Prompt', type: 'main', index: 0 }]]
      },
      'Build RAG Prompt': {
        main: [[{ node: 'Ollama Memory Answer', type: 'main', index: 0 }]]
      },
      'Ollama Memory Answer': {
        main: [[{ node: 'Build Telegram Answer', type: 'main', index: 0 }]]
      },
      'Build Telegram Answer': {
        main: [[{ node: 'Telegram Send', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * Pattern 3: n8n Form -> Ollama Lead Qualification -> CRM -> Telegram
 * Formalized lead intake with local model scoring.
 */
export function buildFormLeadQualifierToCrm(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      {
        parameters: {
          formTitle: 'AgentForge Lead Intake',
          formDescription: 'Leave your details and describe what you need.',
          formFields: {
            values: [
              {
                fieldLabel: 'Name',
                fieldType: 'text',
                requiredField: true
              },
              {
                fieldLabel: 'Email',
                fieldType: 'email',
                requiredField: true
              },
              {
                fieldLabel: 'Company',
                fieldType: 'text',
                requiredField: false
              },
              {
                fieldLabel: 'Message',
                fieldType: 'textarea',
                requiredField: true
              }
            ]
          },
          options: {}
        },
        id: 'form_trigger',
        name: 'Form Trigger',
        type: 'n8n-nodes-base.formTrigger',
        typeVersion: 2,
        position: [200, 300]
      },
      codeNode(
        'Build Qualification Prompt',
        `
const lead = items[0]?.json || {};

return [{
  json: {
    rawLead: lead,
    ollamaRequest: {
      model: '${cfg.defaultLocalModel}',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'Qualify this inbound lead. Return ONLY valid JSON: {qualified:boolean, score:number, segment:string, pain:string, budgetSignal:string, urgency:"low"|"medium"|"high", recommendedNextStep:string, summary:string}.'
        },
        {
          role: 'user',
          content: JSON.stringify(lead)
        }
      ]
    }
  }
}];
        `.trim(),
        450,
        300
      ),
      ollamaChatNode('Ollama Qualify Lead', 700, 300),
      codeNode(
        'Normalize Lead Qualification',
        `
function safeJson(text) {
  try {
    const match = String(text).match(/\\{[\\s\\S]*\\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

const raw = $json.message?.content || $json.response || '';
const qualification = safeJson(raw) || {
  qualified: false,
  score: 0,
  segment: 'unknown',
  pain: 'unknown',
  budgetSignal: 'unknown',
  urgency: 'medium',
  recommendedNextStep: 'Manual review',
  summary: raw.slice(0, 500)
};

return [{
  json: {
    type: 'qualified_lead',
    rawLead: $json.rawLead,
    qualification,
    createdAt: new Date().toISOString(),
    telegramMessage:
      '*New Lead Qualified*\\n\\n' +
      '*Qualified:* ' + qualification.qualified + '\\n' +
      '*Score:* ' + qualification.score + '\\n' +
      '*Segment:* ' + qualification.segment + '\\n' +
      '*Urgency:* ' + qualification.urgency + '\\n\\n' +
      '*Summary:* ' + qualification.summary + '\\n\\n' +
      '*Next:* ' + qualification.recommendedNextStep
  }
}];
        `.trim(),
        950,
        300
      ),
      agentForgePostNode('Save Lead to CRM', cfg.agentForgeCrmEndpoint, 1200, 300),
      telegramSendNode('Telegram Lead Alert', 1450, 300)
    ],
    connections: {
      'Form Trigger': {
        main: [[{ node: 'Build Qualification Prompt', type: 'main', index: 0 }]]
      },
      'Build Qualification Prompt': {
        main: [[{ node: 'Ollama Qualify Lead', type: 'main', index: 0 }]]
      },
      'Ollama Qualify Lead': {
        main: [[{ node: 'Normalize Lead Qualification', type: 'main', index: 0 }]]
      },
      'Normalize Lead Qualification': {
        main: [[{ node: 'Save Lead to CRM', type: 'main', index: 0 }]]
      },
      'Save Lead to CRM': {
        main: [[{ node: 'Telegram Lead Alert', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * Pattern 5: Batch URL Research with Loop Control
 * Processes multiple URLs with batching and aggregation.
 */
export function buildBatchUrlResearchDigest(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  const urls = getInputArray(
    spec,
    ['urls', 'pages', 'competitors'],
    ['https://example.com']
  );

  return {
    nodes: [
      {
        parameters: {
          rule: {
            interval: [
              {
                field: 'cronExpression',
                expression: '0 10 * * *'
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
        'Build URL Batch',
        `
const urls = ${JSON.stringify(urls)};

return urls.map(url => ({
  json: {
    url,
    createdAt: new Date().toISOString()
  }
}));
        `.trim(),
        450,
        300
      ),
      {
        parameters: {
          batchSize: 1,
          options: {}
        },
        id: 'loop_over_items',
        name: 'Loop Over Items',
        type: 'n8n-nodes-base.splitInBatches',
        typeVersion: 3,
        position: [700, 300]
      },
      {
        parameters: {
          url: '={{ $json.url }}',
          options: {}
        },
        id: 'fetch_url',
        name: 'Fetch URL',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [950, 300]
      },
      codeNode(
        'Build Research Prompt',
        `
const pageData = JSON.stringify($json).slice(0, 6000);

return [{
  json: {
    url: $json.url,
    ollamaRequest: {
      model: '${cfg.defaultLocalModel}',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'Summarize this page for a B2B SaaS founder. Return ONLY valid JSON: {url:string, summary:string, opportunities:string[], risks:string[], importance:number}.'
        },
        {
          role: 'user',
          content: pageData
        }
      ]
    }
  }
}];
        `.trim(),
        1200,
        300
      ),
      ollamaChatNode('Ollama Page Summary', 1450, 300),
      codeNode(
        'Normalize Page Summary',
        `
function safeJson(text) {
  try {
    const match = String(text).match(/\\{[\\s\\S]*\\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

const raw = $json.message?.content || $json.response || '';
const parsed = safeJson(raw) || {
  url: $json.url,
  summary: raw.slice(0, 800),
  opportunities: [],
  risks: [],
  importance: 0.5
};

return [{
  json: {
    type: 'url_research_summary',
    url: parsed.url || $json.url,
    summary: parsed.summary,
    opportunities: parsed.opportunities || [],
    risks: parsed.risks || [],
    importance: parsed.importance || 0.5,
    createdAt: new Date().toISOString()
  }
}];
        `.trim(),
        1700,
        300
      ),
      {
        parameters: {
          aggregate: 'aggregateAllItemData',
          destinationFieldName: 'researchItems',
          options: {}
        },
        id: 'aggregate_research',
        name: 'Aggregate Research',
        type: 'n8n-nodes-base.aggregate',
        typeVersion: 1,
        position: [1950, 300]
      },
      codeNode(
        'Build Telegram Digest',
        `
const items = $json.researchItems || [];

const digest = items
  .slice(0, 10)
  .map((item, index) => {
    return (
      (index + 1) + '. ' + (item.url || 'unknown') + '\\n' +
      String(item.summary || '').slice(0, 300)
    );
  })
  .join('\\n\\n');

return [{
  json: {
    telegramMessage:
      '*Batch Research Digest*\\n\\n' +
      digest.slice(0, 3500)
  }
}];
        `.trim(),
        2200,
        300
      ),
      telegramSendNode('Telegram Digest', 2450, 300)
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Build URL Batch', type: 'main', index: 0 }]]
      },
      'Build URL Batch': {
        main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]]
      },
      'Loop Over Items': {
        main: [[{ node: 'Fetch URL', type: 'main', index: 0 }]]
      },
      'Fetch URL': {
        main: [[{ node: 'Build Research Prompt', type: 'main', index: 0 }]]
      },
      'Build Research Prompt': {
        main: [[{ node: 'Ollama Page Summary', type: 'main', index: 0 }]]
      },
      'Ollama Page Summary': {
        main: [[{ node: 'Normalize Page Summary', type: 'main', index: 0 }]]
      },
      'Normalize Page Summary': {
        main: [[{ node: 'Aggregate Research', type: 'main', index: 0 }]]
      },
      'Aggregate Research': {
        main: [[{ node: 'Build Telegram Digest', type: 'main', index: 0 }]]
      },
      'Build Telegram Digest': {
        main: [[{ node: 'Telegram Digest', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * Pattern 10: AgentForge Queue Backlog Prioritizer
 * Daily system optimization of pending tasks.
 */
export function buildAgentForgeBacklogPrioritizer(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
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
          method: 'GET',
          url: `${cfg.agentForgeTaskEndpoint}/backlog`,
          options: {}
        },
        id: 'fetch_backlog',
        name: 'Fetch Backlog',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [450, 300]
      },
      codeNode(
        'Build Prioritization Prompt',
        `
const backlog = JSON.stringify($json).slice(0, 14000);

return [{
  json: {
    backlog,
    ollamaRequest: {
      model: '${cfg.reasoningLocalModel}',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You prioritize AgentForge tasks. Return ONLY valid JSON: {topTasks:[{id:string, priority:"low"|"medium"|"high", reason:string}], blockers:string[], recommendedFocus:string}.'
        },
        {
          role: 'user',
          content: backlog
        }
      ]
    }
  }
}];
        `.trim(),
        700,
        300
      ),
      ollamaChatNode('Ollama Prioritize Backlog', 950, 300),
      codeNode(
        'Normalize Priorities',
        `
function safeJson(text) {
  try {
    const match = String(text).match(/\\{[\\s\\S]*\\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

const raw = $json.message?.content || $json.response || '';
const parsed = safeJson(raw) || {
  topTasks: [],
  blockers: ['Could not parse model output'],
  recommendedFocus: raw.slice(0, 500)
};

return [{
  json: {
    type: 'backlog_prioritization',
    result: parsed,
    createdAt: new Date().toISOString(),
    telegramMessage:
      '*AgentForge Daily Priorities*\\n\\n' +
      '*Recommended focus:* ' + parsed.recommendedFocus + '\\n\\n' +
      '*Blockers:*\\n- ' + (parsed.blockers || []).join('\\n- ')
  }
}];
        `.trim(),
        1200,
        300
      ),
      agentForgePostNode(
        'Save Priorities',
        `${cfg.agentForgeTaskEndpoint}/priorities`,
        1450,
        300
      ),
      telegramSendNode('Telegram Priorities', 1700, 300)
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Fetch Backlog', type: 'main', index: 0 }]]
      },
      'Fetch Backlog': {
        main: [[{ node: 'Build Prioritization Prompt', type: 'main', index: 0 }]]
      },
      'Build Prioritization Prompt': {
        main: [[{ node: 'Ollama Prioritize Backlog', type: 'main', index: 0 }]]
      },
      'Ollama Prioritize Backlog': {
        main: [[{ node: 'Normalize Priorities', type: 'main', index: 0 }]]
      },
      'Normalize Priorities': {
        main: [[{ node: 'Save Priorities', type: 'main', index: 0 }]]
      },
      'Save Priorities': {
        main: [[{ node: 'Telegram Priorities', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * Pattern 6: Telegram -> Ollama Reply
 */
export function buildTelegramToOllamaReply(spec: AutomationSpec): any {
  return {
    nodes: [
      telegramTriggerNode('Telegram Trigger', 100, 300, 1),
      ollamaChatNode('Ollama Reply', 400, 300, 'Be a helpful assistant.'),
      telegramSendNode('Telegram Send', 700, 300)
    ],
    connections: {
      'Telegram Trigger': { main: [[{ node: 'Ollama Reply', type: 'main', index: 0 }]] },
      'Ollama Reply': { main: [[{ node: 'Telegram Send', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 7: Telegram Model Router
 */
export function buildTelegramModelRouter(spec: AutomationSpec): any {
  return {
    nodes: [
      telegramTriggerNode('Telegram Trigger', 100, 300, 1),
      codeNode('Router', 'return [{ json: { model: $json.message.text.includes("/fast") ? "gemma" : "qwen" } }];', 350, 300),
      ollamaChatNode('Ollama Process', 600, 300, 'Task'),
      telegramSendNode('Telegram Reply', 850, 300)
    ],
    connections: {
      'Telegram Trigger': { main: [[{ node: 'Router', type: 'main', index: 0 }]] },
      'Router': { main: [[{ node: 'Ollama Process', type: 'main', index: 0 }]] },
      'Ollama Process': { main: [[{ node: 'Telegram Reply', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 8: Telegram Automation Request -> AgentForge
 */
export function buildTelegramAutomationRequestToAgentForge(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      telegramTriggerNode('Telegram Trigger', 100, 300, 1),
      agentForgePostNode('Request Automation', cfg.agentForgeTaskEndpoint, 400, 300),
      telegramSendNode('Confirm Request', 700, 300)
    ],
    connections: {
      'Telegram Trigger': { main: [[{ node: 'Request Automation', type: 'main', index: 0 }]] },
      'Request Automation': { main: [[{ node: 'Confirm Request', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 9: RSS -> Ollama Classifier -> Telegram
 */
export function buildRssOllamaClassifierToTelegram(spec: AutomationSpec): any {
  const rssUrl = getInputString(spec, ['rssUrl', 'rss', 'feedUrl', 'url'], 'https://blog.n8n.io/rss/');
  return {
    nodes: [
      {
        parameters: { feedUrl: rssUrl },
        id: 'rss_trigger',
        name: 'RSS Trigger',
        type: 'n8n-nodes-base.rssFeedReadTrigger',
        typeVersion: 1,
        position: [100, 300]
      },
      ollamaChatNode('Classify Article', 400, 300, 'Classify this article.'),
      { parameters: { conditions: { string: [{ value1: '={{ $json.classification }}', value2: 'relevant' }] } }, id: 'if_relevant', name: 'If Relevant', type: 'n8n-nodes-base.if', typeVersion: 1, position: [650, 300] },
      telegramSendNode('Telegram Alert', 900, 200)
    ],
    connections: {
      'RSS Trigger': { main: [[{ node: 'Classify Article', type: 'main', index: 0 }]] },
      'Classify Article': { main: [[{ node: 'If Relevant', type: 'main', index: 0 }]] },
      'If Relevant': { main: [[{ node: 'Telegram Alert', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 10: Competitor Research -> Memory & Telegram
 */
export function buildCompetitorResearchToMemoryAndTelegram(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      { parameters: { path: 'research' }, id: 'webhook_trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [100, 300] },
      ollamaChatNode('Analyze Competitor', 400, 300, 'Research competitor.'),
      agentForgePostNode('Save Analysis', cfg.agentForgeMemoryEndpoint, 700, 300),
      telegramSendNode('Report Results', 1000, 300)
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'Analyze Competitor', type: 'main', index: 0 }]] },
      'Analyze Competitor': { main: [[{ node: 'Save Analysis', type: 'main', index: 0 }]] },
      'Save Analysis': { main: [[{ node: 'Report Results', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 11: Telegram Remember -> Memory
 */
export function buildTelegramRememberToMemory(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      telegramTriggerNode('Telegram Trigger', 100, 300, 1),
      agentForgePostNode('Remember Info', cfg.agentForgeMemoryEndpoint, 400, 300),
      telegramSendNode('Confirm Saved', 700, 300)
    ],
    connections: {
      'Telegram Trigger': { main: [[{ node: 'Remember Info', type: 'main', index: 0 }]] },
      'Remember Info': { main: [[{ node: 'Confirm Saved', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 12: Daily Memory Digest -> Telegram
 */
export function buildDailyMemoryDigestToTelegram(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      { parameters: { hour: 9 }, id: 'schedule_trigger', name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [100, 300] },
      { parameters: { method: 'GET', url: cfg.agentForgeMemoryEndpoint }, id: 'fetch_memory', name: 'Fetch Memory', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.1, position: [350, 300] },
      ollamaChatNode('Summarize Day', 600, 300, 'Summarize these memories.'),
      telegramSendNode('Send Digest', 850, 300)
    ],
    connections: {
      'Schedule Trigger': { main: [[{ node: 'Fetch Memory', type: 'main', index: 0 }]] },
      'Fetch Memory': { main: [[{ node: 'Summarize Day', type: 'main', index: 0 }]] },
      'Summarize Day': { main: [[{ node: 'Send Digest', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 13: n8n Failed Execution Explainer
 */
export function buildN8nFailedExecutionExplainer(spec: AutomationSpec): any {
  return {
    nodes: [
      { parameters: {}, id: 'error_trigger', name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [100, 300] },
      ollamaChatNode('Explain Failure', 400, 300, 'Explain why this workflow failed.'),
      telegramSendNode('Notify Admin', 700, 300)
    ],
    connections: {
      'Error Trigger': { main: [[{ node: 'Explain Failure', type: 'main', index: 0 }]] },
      'Explain Failure': { main: [[{ node: 'Notify Admin', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 14: Local LLM with Gemini Fallback
 */
export function buildLocalLlmWithGeminiFallback(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      { parameters: { path: 'llm' }, id: 'webhook_trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [100, 300] },
      ollamaChatNode('Local LLM', 350, 300, 'Try local first.'),
      { parameters: { conditions: { boolean: [{ value1: '={{ $json.success }}', value2: false }] } }, id: 'if_failed', name: 'If Failed', type: 'n8n-nodes-base.if', typeVersion: 1, position: [600, 300] },
      { parameters: { method: 'POST', url: cfg.geminiGatewayEndpoint }, id: 'gemini_fallback', name: 'Gemini Fallback', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.1, position: [850, 400] }
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'Local LLM', type: 'main', index: 0 }]] },
      'Local LLM': { main: [[{ node: 'If Failed', type: 'main', index: 0 }]] },
      'If Failed': { main: [[{ node: 'Gemini Fallback', type: 'main', index: 1 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 15: Lead Webhook Ollama Extract -> CRM
 */
export function buildLeadWebhookOllamaExtractToCrm(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      { parameters: { path: 'lead' }, id: 'webhook_trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [100, 300] },
      ollamaChatNode('Extract Lead Info', 400, 300, 'Extract lead details.'),
      agentForgePostNode('Save to CRM', cfg.agentForgeCrmEndpoint, 700, 300)
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'Extract Lead Info', type: 'main', index: 0 }]] },
      'Extract Lead Info': { main: [[{ node: 'Save to CRM', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}

/**
 * Pattern 16: Prompt Model Comparison Bench
 */
export function buildPromptModelComparisonBench(spec: AutomationSpec): any {
  return {
    nodes: [
      { parameters: { path: 'bench' }, id: 'webhook_trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [100, 300] },
      ollamaChatNode('Gemma Test', 400, 200, 'Gemma result.'),
      ollamaChatNode('Qwen Test', 400, 400, 'Qwen result.'),
      // typeVersion 3.2 with `combineByPosition`: this install dropped merge v1/v2
      // entirely (supports 3, 3.1, 3.2) and v3 renamed the combineBy value from
      // 'position' to 'combineByPosition'. The old v1 config deployed cleanly and
      // could never run.
      { parameters: { mode: 'combine', combineBy: 'combineByPosition', numberInputs: 2 }, id: 'merge_results', name: 'Merge Results', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [700, 300] },
      telegramSendNode('Compare Results', 950, 300)
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'Gemma Test', type: 'main', index: 0 }, { node: 'Qwen Test', type: 'main', index: 0 }]] },
      'Gemma Test': { main: [[{ node: 'Merge Results', type: 'main', index: 0 }]] },
      'Qwen Test': { main: [[{ node: 'Merge Results', type: 'main', index: 1 }]] },
      'Merge Results': { main: [[{ node: 'Compare Results', type: 'main', index: 0 }]] }
    },
    settings: settings()
  };
}
