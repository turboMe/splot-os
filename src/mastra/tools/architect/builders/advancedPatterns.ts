import { AutomationSpec } from '../types.js';
import {
  codeNode,
  ollamaChatNode,
  telegramSendNode,
  telegramTriggerNode,
  gmailTriggerNode,
  agentForgePostNode,
  settings,
  getInputString,
  getN8nConfig,
} from './helpers.js';

/**
 * 2. Pattern: Error Workflow -> Ollama Explanation -> Telegram -> Memory
 */
export function buildErrorWorkflowOllamaTelegramMemory(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      {
        parameters: {},
        id: 'error_trigger',
        name: 'Error Trigger',
        type: 'n8n-nodes-base.errorTrigger',
        typeVersion: 1,
        position: [200, 300]
      },
      codeNode(
        'Normalize Error',
        `
const error = items[0]?.json || {};

return [{
  json: {
    type: 'n8n_error',
    workflowName: error.workflow?.name || error.workflowName || 'unknown',
    workflowId: error.workflow?.id || error.workflowId || 'unknown',
    executionId: error.execution?.id || error.executionId || 'unknown',
    nodeName: error.node?.name || error.nodeName || 'unknown',
    errorMessage: error.error?.message || error.message || JSON.stringify(error).slice(0, 1000),
    rawError: error,
    occurredAt: new Date().toISOString()
  }
}];
        `.trim(),
        450,
        300
      ),
      codeNode(
        'Build Error Explanation Prompt',
        `
const payload = JSON.stringify($json).slice(0, 9000);

return [{
  json: {
    ...$json,
    ollamaRequest: {
      model: '${cfg.defaultLocalModel}',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You are an n8n workflow debugger. Explain the error in practical terms. Return ONLY valid JSON: {summary:string, likelyCause:string, affectedNode:string, severity:"low"|"medium"|"high", nextSteps:string[]}.'
        },
        {
          role: 'user',
          content: payload
        }
      ]
    }
  }
}];
        `.trim(),
        700,
        300
      ),
      ollamaChatNode('Ollama Explain Error', 950, 300),
      codeNode(
        'Normalize Error Explanation',
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
  summary: raw.slice(0, 800),
  likelyCause: 'Could not parse structured model output',
  affectedNode: $json.nodeName || 'unknown',
  severity: 'medium',
  nextSteps: ['Open the failed execution in n8n', 'Inspect the failed node input/output']
};

return [{
  json: {
    type: 'n8n_error_analysis',
    workflowName: $json.workflowName,
    workflowId: $json.workflowId,
    executionId: $json.executionId,
    nodeName: $json.nodeName,
    errorMessage: $json.errorMessage,
    analysis: parsed,
    createdAt: new Date().toISOString(),
    telegramMessage:
      '*n8n Workflow Error*\\n\\n' +
      '*Workflow:* ' + ($json.workflowName || 'unknown') + '\\n' +
      '*Node:* ' + (parsed.affectedNode || $json.nodeName || 'unknown') + '\\n' +
      '*Severity:* ' + parsed.severity + '\\n\\n' +
      '*Summary:* ' + parsed.summary + '\\n\\n' +
      '*Likely cause:* ' + parsed.likelyCause + '\\n\\n' +
      '*Next steps:*\\n- ' + (parsed.nextSteps || []).join('\\n- ')
  }
}];
        `.trim(),
        1200,
        300
      ),
      agentForgePostNode(
        'Save Error to Memory',
        cfg.agentForgeMemoryEndpoint,
        1450,
        300
      ),
      telegramSendNode('Telegram Error Alert', 1700, 300)
    ],
    connections: {
      'Error Trigger': {
        main: [[{ node: 'Normalize Error', type: 'main', index: 0 }]]
      },
      'Normalize Error': {
        main: [[{ node: 'Build Error Explanation Prompt', type: 'main', index: 0 }]]
      },
      'Build Error Explanation Prompt': {
        main: [[{ node: 'Ollama Explain Error', type: 'main', index: 0 }]]
      },
      'Ollama Explain Error': {
        main: [[{ node: 'Normalize Error Explanation', type: 'main', index: 0 }]]
      },
      'Normalize Error Explanation': {
        main: [[{ node: 'Save Error to Memory', type: 'main', index: 0 }]]
      },
      'Save Error to Memory': {
        main: [[{ node: 'Telegram Error Alert', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 3. Pattern: RSS/HTTP -> Deduplication -> Mongo/Memory -> Telegram
 */
export function buildRssDedupToMemoryTelegram(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  const rssUrl = getInputString(spec, ['rss', 'feed', 'url'], 'https://n8n.io/blog/rss.xml');

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
        position: [200, 300]
      },
      codeNode(
        'Build Fingerprints',
        `
return items.map(item => {
  const title = item.json.title || '';
  const link = item.json.link || '';
  const pubDate = item.json.pubDate || item.json.isoDate || '';
  const fingerprintSource = [title, link, pubDate].join('|');

  let hash = 0;
  for (let i = 0; i < fingerprintSource.length; i++) {
    hash = ((hash << 5) - hash) + fingerprintSource.charCodeAt(i);
    hash |= 0;
  }

  return {
    json: {
      title,
      link,
      pubDate,
      fingerprint: 'rss_' + Math.abs(hash),
      sourceUrl: ${JSON.stringify(rssUrl)},
      checkedAt: new Date().toISOString()
    }
  };
});
        `.trim(),
        450,
        300
      ),
      agentForgePostNode(
        'Check Dedup in Memory',
        `${cfg.agentForgeMemoryEndpoint}/dedup/check`,
        700,
        300
      ),
      codeNode(
        'Filter New Items',
        `
return items
  .map(item => {
    const alreadySeen = item.json.alreadySeen === true || item.json.exists === true;

    if (alreadySeen) return null;

    return {
      json: {
        ...item.json,
        type: 'rss_item_seen',
        telegramMessage:
          '*New RSS Item*\\n\\n' +
          '*Title:* ' + (item.json.title || 'n/a') + '\\n' +
          '*Link:* ' + (item.json.link || 'n/a')
      }
    };
  })
  .filter(Boolean);
        `.trim(),
        950,
        300
      ),
      agentForgePostNode(
        'Save New Fingerprint',
        `${cfg.agentForgeMemoryEndpoint}/dedup/save`,
        1200,
        300
      ),
      telegramSendNode('Telegram Send', 1450, 300)
    ],
    connections: {
      'RSS Read': {
        main: [[{ node: 'Build Fingerprints', type: 'main', index: 0 }]]
      },
      'Build Fingerprints': {
        main: [[{ node: 'Check Dedup in Memory', type: 'main', index: 0 }]]
      },
      'Check Dedup in Memory': {
        main: [[{ node: 'Filter New Items', type: 'main', index: 0 }]]
      },
      'Filter New Items': {
        main: [[{ node: 'Save New Fingerprint', type: 'main', index: 0 }]]
      },
      'Save New Fingerprint': {
        main: [[{ node: 'Telegram Send', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 4. Pattern: Telegram Task Triage -> Ollama -> Queue Routing
 */
export function buildTelegramTaskTriageToAgentForgeQueue(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      telegramTriggerNode('Telegram Trigger', 200, 300, 1.2),
      codeNode(
        'Normalize Telegram Task',
        `
const msg = items[0]?.json?.message || items[0]?.json || {};
const text = String(msg.text || '').trim();

if (!text || text.startsWith('/ignore')) {
  return [];
}

return [{
  json: {
    rawText: text,
    source: 'telegram',
    receivedAt: new Date().toISOString(),
    ollamaRequest: {
      model: '${cfg.defaultLocalModel}',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'Classify the user task for an agent system. Return ONLY valid JSON: {queue:"meta"|"marketing"|"automation"|"crm"|"research", priority:"low"|"medium"|"high", taskType:string, cleanedPrompt:string, reason:string}.'
        },
        {
          role: 'user',
          content: text
        }
      ]
    }
  }
}];
        `.trim(),
        450,
        300
      ),
      ollamaChatNode('Ollama Classify Task', 700, 300),
      codeNode(
        'Build Queue Payload',
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
const classification = safeJson(raw) || {
  queue: 'meta',
  priority: 'medium',
  taskType: 'general',
  cleanedPrompt: $json.rawText,
  reason: 'Fallback classification'
};

return [{
  json: {
    taskType: classification.taskType,
    queue: classification.queue,
    priority: classification.priority,
    prompt: classification.cleanedPrompt,
    source: 'telegram_triage',
    classification,
    createdAt: new Date().toISOString(),
    telegramMessage:
      '*Task routed*\\n\\n' +
      '*Queue:* ' + classification.queue + '\\n' +
      '*Priority:* ' + classification.priority + '\\n' +
      '*Type:* ' + classification.taskType + '\\n\\n' +
      '*Reason:* ' + classification.reason
  }
}];
        `.trim(),
        950,
        300
      ),
      agentForgePostNode(
        'Send to AgentForge Queue',
        cfg.agentForgeTaskEndpoint,
        1200,
        300
      ),
      telegramSendNode('Telegram Confirmation', 1450, 300)
    ],
    connections: {
      'Telegram Trigger': {
        main: [[{ node: 'Normalize Telegram Task', type: 'main', index: 0 }]]
      },
      'Normalize Telegram Task': {
        main: [[{ node: 'Ollama Classify Task', type: 'main', index: 0 }]]
      },
      'Ollama Classify Task': {
        main: [[{ node: 'Build Queue Payload', type: 'main', index: 0 }]]
      },
      'Build Queue Payload': {
        main: [[{ node: 'Send to AgentForge Queue', type: 'main', index: 0 }]]
      },
      'Send to AgentForge Queue': {
        main: [[{ node: 'Telegram Confirmation', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 5. Pattern: Human Approval Gate (Request)
 */
export function buildApprovalRequestToTelegram(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'approval-request',
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
        'Create Approval Token',
        `
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope;
const token = 'appr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

return [{
  json: {
    approvalToken: token,
    action: payload.action || 'unknown_action',
    risk: payload.risk || 'medium',
    summary: payload.summary || payload.description || 'Approval requested',
    details: payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
    telegramMessage:
      '*Approval Required*\\n\\n' +
      '*Action:* ' + (payload.action || 'unknown') + '\\n' +
      '*Risk:* ' + (payload.risk || 'medium') + '\\n\\n' +
      '*Summary:*\\n' + (payload.summary || payload.description || 'No summary') + '\\n\\n' +
      'Approve:\\n\`/approve ' + token + '\`\\n\\n' +
      'Reject:\\n\`/reject ' + token + '\`'
  }
}];
        `.trim(),
        450,
        300
      ),
      agentForgePostNode(
        'Save Approval Request',
        cfg.agentForgeApprovalEndpoint,
        700,
        300
      ),
      telegramSendNode('Telegram Approval Request', 950, 300),
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify({ ok: true, approvalToken: $json.approvalToken }) }}',
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
        main: [[{ node: 'Create Approval Token', type: 'main', index: 0 }]]
      },
      'Create Approval Token': {
        main: [[{ node: 'Save Approval Request', type: 'main', index: 0 }]]
      },
      'Save Approval Request': {
        main: [[{ node: 'Telegram Approval Request', type: 'main', index: 0 }]]
      },
      'Telegram Approval Request': {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 5. Pattern: Human Approval Gate (Router)
 */
export function buildTelegramApprovalRouter(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      telegramTriggerNode('Telegram Trigger', 200, 300, 1.2),
      codeNode(
        'Parse Approval Command',
        `
const msg = items[0]?.json?.message || items[0]?.json || {};
const text = String(msg.text || '').trim();

const approveMatch = text.match(/^\\/approve\\s+(.+)$/i);
const rejectMatch = text.match(/^\\/reject\\s+(.+)$/i);

if (!approveMatch && !rejectMatch) {
  return [];
}

return [{
  json: {
    approvalToken: approveMatch?.[1] || rejectMatch?.[1],
    decision: approveMatch ? 'approved' : 'rejected',
    decidedAt: new Date().toISOString(),
    source: 'telegram'
  }
}];
        `.trim(),
        450,
        300
      ),
      agentForgePostNode(
        'Resolve Approval',
        `${cfg.agentForgeApprovalEndpoint}/resolve`,
        700,
        300
      ),
      codeNode(
        'Build Confirmation',
        `
return [{
  json: {
    telegramMessage:
      '*Approval ' + ($json.decision || 'updated') + '*\\n\\n' +
      '*Token:* ' + ($json.approvalToken || 'unknown')
  }
}];
        `.trim(),
        950,
        300
      ),
      telegramSendNode('Telegram Confirmation', 1200, 300)
    ],
    connections: {
      'Telegram Trigger': {
        main: [[{ node: 'Parse Approval Command', type: 'main', index: 0 }]]
      },
      'Parse Approval Command': {
        main: [[{ node: 'Resolve Approval', type: 'main', index: 0 }]]
      },
      'Resolve Approval': {
        main: [[{ node: 'Build Confirmation', type: 'main', index: 0 }]]
      },
      'Build Confirmation': {
        main: [[{ node: 'Telegram Confirmation', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 6. Pattern: Ollama Model Health Check
 */
export function buildOllamaModelHealthCheck(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      {
        parameters: {
          rule: {
            interval: [
              {
                field: 'cronExpression',
                expression: '*/30 * * * *'
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
          url: `${cfg.ollamaBaseUrl}/api/tags`,
          options: {}
        },
        id: 'ollama_tags',
        name: 'Ollama Tags',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [450, 300]
      },
      codeNode(
        'Check Required Models',
        `
const models = ($json.models || []).map(m => m.name);
const required = [
  '${cfg.defaultLocalModel}',
  '${cfg.reasoningLocalModel}'
];

const missing = required.filter(model => !models.includes(model));

if (missing.length === 0) {
  return [];
}

return [{
  json: {
    models,
    missing,
    telegramMessage:
      '*Ollama Model Health Alert*\\n\\n' +
      '*Missing models:*\\n- ' + missing.join('\\n- ') + '\\n\\n' +
      '*Available:*\\n- ' + models.join('\\n- ')
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
        main: [[{ node: 'Ollama Tags', type: 'main', index: 0 }]]
      },
      'Ollama Tags': {
        main: [[{ node: 'Check Required Models', type: 'main', index: 0 }]]
      },
      'Check Required Models': {
        main: [[{ node: 'Telegram Alert', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 7. Pattern: Local LLM Quality Evaluator
 */
export function buildLocalModelQualityEvaluator(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'model-quality-eval',
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
        'Build Evaluation Items',
        `
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope;
const prompt = payload.prompt || payload.task || payload.text || '';

if (!prompt) return [];

return [
  {
    json: {
      candidateModel: '${cfg.defaultLocalModel}',
      prompt,
      ollamaRequest: {
        model: '${cfg.defaultLocalModel}',
        stream: false,
        messages: [
          { role: 'system', content: 'Answer the user task practically.' },
          { role: 'user', content: prompt }
        ]
      }
    }
  },
  {
    json: {
      candidateModel: '${cfg.reasoningLocalModel}',
      prompt,
      ollamaRequest: {
        model: '${cfg.reasoningLocalModel}',
        stream: false,
        messages: [
          { role: 'system', content: 'Answer the user task with deep reasoning and implementation detail.' },
          { role: 'user', content: prompt }
        ]
      }
    }
  }
];
        `.trim(),
        450,
        300
      ),
      {
        parameters: {
          method: 'POST',
          url: `${cfg.ollamaBaseUrl}/api/chat`,
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify($json.ollamaRequest) }}',
          options: {}
        },
        id: 'run_candidates',
        name: 'Run Candidate Models',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [700, 300]
      },
      codeNode(
        'Build Judge Prompt',
        `
const candidates = items.map(item => ({
  model: item.json.candidateModel,
  answer: item.json.message?.content || item.json.response || JSON.stringify(item.json)
}));

return [{
  json: {
    candidates,
    ollamaRequest: {
      model: '${cfg.reasoningLocalModel}',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You are an evaluator of local LLM answers. Return ONLY valid JSON: {winner:string, scores:object, reason:string, bestUseCase:string}.'
        },
        {
          role: 'user',
          content: JSON.stringify(candidates).slice(0, 16000)
        }
      ]
    }
  }
}];
        `.trim(),
        950,
        300
      ),
      {
        parameters: {
          method: 'POST',
          url: `${cfg.ollamaBaseUrl}/api/chat`,
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify($json.ollamaRequest) }}',
          options: {}
        },
        id: 'judge_models',
        name: 'Judge Models',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [1200, 300]
      },
      codeNode(
        'Normalize Evaluation',
        `
const judge = $json.message?.content || $json.response || JSON.stringify($json);

return [{
  json: {
    type: 'model_quality_evaluation',
    judgeResult: judge,
    createdAt: new Date().toISOString(),
    telegramMessage:
      '*Local Model Evaluation*\\n\\n' +
      judge.slice(0, 3500)
  }
}];
        `.trim(),
        1450,
        300
      ),
      agentForgePostNode(
        'Save Evaluation Memory',
        cfg.agentForgeMemoryEndpoint,
        1700,
        300
      ),
      telegramSendNode('Telegram Result', 1950, 300)
    ],
    connections: {
      'Webhook Trigger': {
        main: [[{ node: 'Build Evaluation Items', type: 'main', index: 0 }]]
      },
      'Build Evaluation Items': {
        main: [[{ node: 'Run Candidate Models', type: 'main', index: 0 }]]
      },
      'Run Candidate Models': {
        main: [[{ node: 'Build Judge Prompt', type: 'main', index: 0 }]]
      },
      'Build Judge Prompt': {
        main: [[{ node: 'Judge Models', type: 'main', index: 0 }]]
      },
      'Judge Models': {
        main: [[{ node: 'Normalize Evaluation', type: 'main', index: 0 }]]
      },
      'Normalize Evaluation': {
        main: [[{ node: 'Save Evaluation Memory', type: 'main', index: 0 }]]
      },
      'Save Evaluation Memory': {
        main: [[{ node: 'Telegram Result', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 11. Pattern: Workflow Self-Documentation
 */
export function buildWorkflowDocumentation(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      codeNode(
        'Generate Documentation',
        `
return [{
  json: {
    type: 'workflow_documentation',
    name: ${JSON.stringify(spec.name)},
    goal: ${JSON.stringify(spec.goal)},
    trigger: ${JSON.stringify(spec.trigger.type)},
    risk: ${JSON.stringify(spec.riskLevel)},
    createdBy: 'automation-architect',
    createdAt: new Date().toISOString(),
    documentation: {
      description: ${JSON.stringify(spec.description)},
      steps: ${JSON.stringify(spec.steps)},
      externalServices: ${JSON.stringify(spec.externalServices)}
    }
  }
}];
        `.trim(),
        200,
        300
      ),
      agentForgePostNode(
        'Save Documentation to Memory',
        cfg.agentForgeMemoryEndpoint,
        450,
        300
      )
    ],
    connections: {
      'Generate Documentation': {
        main: [[{ node: 'Save Documentation to Memory', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 15. Pattern: Draft-Only Email Assistant
 */
export function buildDraftOnlyEmailAssistant(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      gmailTriggerNode('Gmail Trigger', 200, 300, 1),
      codeNode(
        'Normalize Email',
        `
const msg = items[0]?.json || {};
return [{
  json: {
    from: msg.from,
    subject: msg.subject,
    body: msg.text || msg.html,
    receivedAt: msg.date
  }
}];
        `.trim(),
        450,
        300
      ),
      codeNode(
        'Build Draft Prompt',
        `
return [{
  json: {
    ...$json,
    ollamaRequest: {
      model: '${cfg.reasoningLocalModel}',
      messages: [
        {
          role: 'system',
          content: 'You are a professional email assistant. Draft a reply to the user email. Be helpful and concise.'
        },
        { 
          role: 'user', 
          content: 'From: ' + $json.from + '\\nSubject: ' + $json.subject + '\\n\\n' + $json.body 
        }
      ]
    }
  }
}];
        `.trim(),
        700,
        300
      ),
      ollamaChatNode('Ollama Draft Reply', 950, 300),
      codeNode(
        'Prepare Draft Save',
        `
return [{
  json: {
    type: 'email_draft_proposal',
    originalSubject: $json.subject,
    originalFrom: $json.from,
    draftContent: $json.message?.content || $json.response,
    createdAt: new Date().toISOString(),
    telegramMessage:
      '*Email Draft Ready*\\n\\n' +
      '*From:* ' + $json.from + '\\n' +
      '*Subject:* ' + $json.subject + '\\n\\n' +
      '*Draft:*\\n' + ($json.message?.content || $json.response).slice(0, 3000)
  }
}];
        `.trim(),
        1200,
        300
      ),
      agentForgePostNode(
        'Save Draft to Memory',
        `${cfg.agentForgeMemoryEndpoint}/drafts`,
        1450,
        300
      ),
      telegramSendNode('Notify Telegram', 1700, 300)
    ],
    connections: {
      'Gmail Trigger': {
        main: [[{ node: 'Normalize Email', type: 'main', index: 0 }]]
      },
      'Normalize Email': {
        main: [[{ node: 'Build Draft Prompt', type: 'main', index: 0 }]]
      },
      'Build Draft Prompt': {
        main: [[{ node: 'Ollama Draft Reply', type: 'main', index: 0 }]]
      },
      'Ollama Draft Reply': {
        main: [[{ node: 'Prepare Draft Save', type: 'main', index: 0 }]]
      },
      'Prepare Draft Save': {
        main: [[{ node: 'Save Draft to Memory', type: 'main', index: 0 }]]
      },
      'Save Draft to Memory': {
        main: [[{ node: 'Notify Telegram', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 17. Pattern: AgentForge Daily Standup
 */
export function buildDailyStandup(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  return {
    nodes: [
      {
        parameters: {
          rule: {
            interval: [{ field: 'cronExpression', expression: '0 9 * * *' }]
          }
        },
        id: 'schedule_standup',
        name: 'Schedule Standup',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [200, 300]
      },
      {
        parameters: {
          method: 'GET',
          url: `${cfg.agentForgeMemoryEndpoint}/standup/context`,
          options: {}
        },
        id: 'fetch_context',
        name: 'Fetch Memory Context',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [450, 300]
      },
      codeNode(
        'Build Standup Prompt',
        `
return [{
  json: {
    ollamaRequest: {
      model: '${cfg.defaultLocalModel}',
      messages: [
        {
          role: 'system',
          content: 'You are the AgentForge Manager. Summarize the status of approvals, errors, and tasks. Return a concise daily standup for the Telegram chat.'
        },
        { 
          role: 'user', 
          content: 'Context: ' + JSON.stringify($json) 
        }
      ]
    }
  }
}];
        `.trim(),
        700,
        300
      ),
      ollamaChatNode('Ollama Summarize', 950, 300),
      telegramSendNode('Telegram Standup', 1200, 300)
    ],
    connections: {
      'Schedule Standup': {
        main: [[{ node: 'Fetch Memory Context', type: 'main', index: 0 }]]
      },
      'Fetch Memory Context': {
        main: [[{ node: 'Build Standup Prompt', type: 'main', index: 0 }]]
      },
      'Build Standup Prompt': {
        main: [[{ node: 'Ollama Summarize', type: 'main', index: 0 }]]
      },
      'Ollama Summarize': {
        main: [[{ node: 'Telegram Standup', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 23. Pattern: “Do Nothing” Safety Pattern
 */
export function buildRefusalPattern(spec: AutomationSpec): any {
  return {
    nodes: [
      codeNode(
        'Log Refusal',
        `
return [{
  json: {
    type: 'automation_refusal',
    reason: 'The request contains high-risk or prohibited operations.',
    originalRequest: ${JSON.stringify(spec.name)},
    riskLevel: ${JSON.stringify(spec.riskLevel)},
    telegramMessage:
      '⚠️ *Automation Blocked*\\n\\n' +
      'I cannot build the requested automation because it involves prohibited actions (e.g., destructive operations, shell commands, or mass messaging).\\n\\n' +
      'Please propose a safer alternative, such as a report-only or draft-only workflow.'
  }
}];
        `.trim(),
        200,
        300
      ),
      telegramSendNode('Telegram Refusal Alert', 450, 300)
    ],
    connections: {
      'Log Refusal': {
        main: [[{ node: 'Telegram Refusal Alert', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}

/**
 * 9. Pattern: Webhook -> Ollama JSON Normalizer -> Mongo-safe API
 */
export function buildWebhookOllamaJsonNormalizerToApi(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  const path = getInputString(spec, ['path', 'webhook'], 'json-normalize');

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
        'Build Normalization Prompt',
        `
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope;

return [{
  json: {
    rawPayload: payload,
    ollamaRequest: {
      model: '${cfg.defaultLocalModel}',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'Normalize incoming business data. Return ONLY valid JSON: {type:string, title:string, summary:string, entities:object, priority:"low"|"medium"|"high", recommendedAction:string, rawConfidence:number}.'
        },
        {
          role: 'user',
          content: JSON.stringify(payload).slice(0, 10000)
        }
      ]
    }
  }
}];
        `.trim(),
        450,
        300
      ),
      ollamaChatNode('Ollama Normalize JSON', 700, 300),
      codeNode(
        'Validate Normalized JSON',
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
const normalized = safeJson(raw);

if (!normalized || !normalized.type || !normalized.summary) {
  return [{
    json: {
      ok: false,
      error: 'Invalid normalized JSON',
      rawModelOutput: raw.slice(0, 1000),
      telegramMessage:
        '*Normalization failed*\\n\\n' +
        raw.slice(0, 1500)
    }
  }];
}

return [{
  json: {
    ok: true,
    normalized,
    rawPayload: $json.rawPayload,
    createdAt: new Date().toISOString(),
    telegramMessage:
      '*Data normalized*\\n\\n' +
      '*Type:* ' + normalized.type + '\\n' +
      '*Priority:* ' + normalized.priority + '\\n' +
      '*Summary:* ' + normalized.summary + '\\n\\n' +
      '*Action:* ' + normalized.recommendedAction
  }
}];
        `.trim(),
        950,
        300
      ),
      agentForgePostNode(
        'Save Normalized Data',
        cfg.agentForgeMemoryEndpoint,
        1200,
        300
      ),
      telegramSendNode('Telegram Notify', 1450, 300),
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify({ ok: $json.ok, normalized: $json.normalized || null }) }}',
          options: {}
        },
        id: 'respond_to_webhook',
        name: 'Respond to Webhook',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1700, 300]
      }
    ],
    connections: {
      'Webhook Trigger': {
        main: [[{ node: 'Build Normalization Prompt', type: 'main', index: 0 }]]
      },
      'Build Normalization Prompt': {
        main: [[{ node: 'Ollama Normalize JSON', type: 'main', index: 0 }]]
      },
      'Ollama Normalize JSON': {
        main: [[{ node: 'Validate Normalized JSON', type: 'main', index: 0 }]]
      },
      'Validate Normalized JSON': {
        main: [[{ node: 'Save Normalized Data', type: 'main', index: 0 }]]
      },
      'Save Normalized Data': {
        main: [[{ node: 'Telegram Notify', type: 'main', index: 0 }]]
      },
      'Telegram Notify': {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
