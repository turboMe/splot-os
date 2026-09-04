import type {
  AutomationCapability,
  AutomationPattern,
  AutomationSpec,
  PatternKnowledgeCard,
} from './types.js';

export type CapabilityEvidence = {
  capability: AutomationCapability;
  source: 'spec' | 'request' | 'pattern' | 'workflow' | 'node' | 'credential';
  detail?: string;
};

export type CapabilityCoverageRecommendation =
  | 'use_pattern'
  | 'delegate_mcp'
  | 'compose_workflow_json'
  | 'block';

export type CapabilityCoverageResult = {
  ok: boolean;
  score: number;
  required: AutomationCapability[];
  actual: AutomationCapability[];
  forbidden: AutomationCapability[];
  forbiddenActual: AutomationCapability[];
  missingRequired: AutomationCapability[];
  warnings: string[];
  recommendation: CapabilityCoverageRecommendation;
  evidence: CapabilityEvidence[];
};

const CRITICAL_CAPABILITIES = new Set<AutomationCapability>([
  'sideEffect.db.write',
  'operation.mongo.insert',
  'operation.mongo.update',
  'sideEffect.message.send',
  'sideEffect.email.send',
  'operation.http.post',
  'operation.webhook.respond',
]);

const SERVICE_ALIASES: Array<{ pattern: RegExp; capabilities: AutomationCapability[] }> = [
  { pattern: /\b(mastra api|agentforge api|agentforge crm|crm api)\b/i, capabilities: ['service.mastraApi'] },
  { pattern: /\b(ollama|llm|local model|local llm)\b/i, capabilities: ['service.ollama'] },
  { pattern: /\b(mongo|mongodb|database|db|baza danych)\b/i, capabilities: ['service.mongo'] },
  { pattern: /\b(telegram|tg)\b/i, capabilities: ['service.telegram'] },
  { pattern: /\b(gmail)\b/i, capabilities: ['service.gmail'] },
  { pattern: /\b(google sheets|sheet|spreadsheet|arkusz)\b/i, capabilities: ['service.googleSheets'] },
];

const CAPABILITY_TERMS: Record<AutomationCapability, string[]> = {
  'trigger.manual': ['manual trigger'],
  'trigger.webhook': ['webhook', 'http endpoint', 'api endpoint'],
  'trigger.schedule': ['schedule', 'cron'],
  'trigger.telegram': ['telegram trigger'],
  'trigger.gmail': ['gmail trigger', 'email trigger'],
  'node.code': ['code node', 'function node'],
  'node.respondToWebhook': ['respond to webhook'],
  'node.httpRequest': ['http request', 'http node', 'api call'],
  'node.mongoDb': ['mongo', 'mongodb'],
  'node.telegram': ['telegram'],
  'node.gmail': ['gmail'],
  'node.googleSheets': ['google sheets', 'spreadsheet', 'arkusz'],
  'service.mastraApi': ['mastra api', 'agentforge api', 'agentforge crm'],
  'service.ollama': ['ollama', 'local llm'],
  'service.mongo': ['mongo', 'mongodb', 'database', 'db', 'baza danych'],
  'service.telegram': ['telegram'],
  'service.gmail': ['gmail'],
  'service.googleSheets': ['google sheets', 'spreadsheet', 'arkusz'],
  'operation.webhook.receive': ['receive webhook', 'webhook'],
  'operation.webhook.respond': ['respond to webhook', 'webhook response'],
  'operation.payload.validate': ['validate payload', 'walidacja'],
  'operation.mongo.insert': ['mongo insert', 'mongodb insert', 'database write'],
  'operation.mongo.find': ['mongo find', 'mongodb read', 'database read'],
  'operation.mongo.update': ['mongo update', 'mongodb update'],
  'operation.http.post': ['http post', 'http request', 'post to api', 'api call'],
  'operation.telegram.send': ['telegram send', 'telegram alert'],
  'operation.gmail.send': ['gmail send', 'email send'],
  'operation.googleSheets.append': ['google sheets append', 'add row'],
  'sideEffect.db.write': ['database write', 'db write', 'mongo insert'],
  'sideEffect.message.send': ['send message', 'alert', 'notification'],
  'sideEffect.email.send': ['send email', 'email send'],
  'runtime.publicWebhook': ['public webhook'],
  'runtime.localMongo': ['local mongo'],
  'runtime.localMastraApi': ['local mastra api'],
  'runtime.localOllama': ['local ollama'],
};

export function deriveSpecCapabilities(spec: AutomationSpec, request?: string): CapabilityEvidence[] {
  const evidence: CapabilityEvidence[] = [];

  switch (spec.trigger?.type) {
    case 'manual':
      pushEvidence(evidence, 'trigger.manual', 'spec', 'trigger.type=manual');
      break;
    case 'schedule':
      pushEvidence(evidence, 'trigger.schedule', 'spec', 'trigger.type=schedule');
      break;
    case 'webhook':
      pushEvidence(evidence, 'trigger.webhook', 'spec', 'trigger.type=webhook');
      pushEvidence(evidence, 'operation.webhook.receive', 'spec', 'trigger.type=webhook');
      break;
    case 'email':
      pushEvidence(evidence, 'trigger.gmail', 'spec', 'trigger.type=email');
      pushEvidence(evidence, 'service.gmail', 'spec', 'trigger.type=email');
      break;
    default:
      break;
  }

  for (const service of spec.externalServices ?? []) {
    pushServiceCapabilities(evidence, service, 'spec');
  }

  for (const credential of spec.credentialsNeeded ?? []) {
    pushServiceCapabilities(evidence, credential.service, 'credential');
  }

  const textSegments = [
    request,
    spec.name,
    spec.description,
    spec.goal,
    spec.trigger?.webhook?.expectedPayloadDescription,
    ...(spec.successCriteria ?? []),
    ...(spec.missingConfig ?? []).map((item) => `${item.key} ${item.description}`),
    ...(spec.steps ?? []).map((step) => [
      step.name,
      step.purpose,
      step.actionType,
      step.expectedInput,
      step.expectedOutput,
    ].filter(Boolean).join(' ')),
  ].filter((value): value is string => Boolean(value));

  for (const segment of textSegments) {
    evidence.push(...deriveRequestCapabilities(segment));
  }

  for (const step of spec.steps ?? []) {
    const stepText = [
      step.name,
      step.purpose,
      step.actionType,
      step.expectedInput,
      step.expectedOutput,
    ].filter(Boolean).join(' ');
    pushStepCapabilities(evidence, step.actionType, stepText);
  }

  const hasMongo = hasCapability(evidence, 'service.mongo');
  if (spec.dataPolicy?.writesExternalData && hasMongo) {
    pushEvidence(evidence, 'sideEffect.db.write', 'spec', 'dataPolicy.writesExternalData + Mongo');
  }
  if (spec.dataPolicy?.sendsMessages) {
    pushEvidence(evidence, 'sideEffect.message.send', 'spec', 'dataPolicy.sendsMessages');
  }

  return dedupeEvidence(evidence);
}

export function deriveRequestCapabilities(request?: string): CapabilityEvidence[] {
  const evidence: CapabilityEvidence[] = [];
  const text = normalizeText(request);
  if (!text) return evidence;

  pushServiceCapabilities(evidence, text, 'request');

  // "No public webhook" is the single most common way a scheduled automation is
  // described, and without the negation guard every such request demanded a
  // webhook trigger it explicitly ruled out. Mongo/Telegram/Gmail/Sheets below
  // already honour the guard; webhook was the outlier.
  const webhookForbidden = isNegatedCapabilityMention(text, 'trigger.webhook');
  if (!webhookForbidden && /\b(webhook|http endpoint|api endpoint)\b/.test(text)) {
    pushEvidence(evidence, 'trigger.webhook', 'request', 'webhook endpoint mentioned');
    pushEvidence(evidence, 'operation.webhook.receive', 'request', 'webhook endpoint mentioned');
  }
  if (/\b(respond|response|return json|reply json|zwr[oó]c|odpowiedz|odpowied[zź])\b/.test(text) && /webhook|endpoint|http/.test(text)) {
    pushEvidence(evidence, 'operation.webhook.respond', 'request', 'webhook response mentioned');
  }
  if (/\b(validate|validation|walidacj|sprawd[zź]|verify|required field|email)\b/.test(text)) {
    pushEvidence(evidence, 'operation.payload.validate', 'request', 'validation mentioned');
  }
  if (mentionsOutboundHttpPost(text)) {
    pushEvidence(evidence, 'operation.http.post', 'request', 'HTTP POST mentioned');
  }

  const mongoForbidden = isNegatedCapabilityMention(text, 'service.mongo');
  const telegramForbidden = isNegatedCapabilityMention(text, 'service.telegram');
  const gmailForbidden = isNegatedCapabilityMention(text, 'service.gmail');
  const googleSheetsForbidden = isNegatedCapabilityMention(text, 'service.googleSheets');
  const mentionsMongo = /\b(mongo|mongodb)\b/.test(text) && !mongoForbidden;
  const mentionsDb = /\b(database|db|baza danych|kolekcj|collection)\b/.test(text) && !mongoForbidden;
  const mentionsWrite = /\b(insert|save|store|persist|write|create|append|zapisz|zapis|dodaj|utw[oó]rz)\b/.test(text);
  const mentionsUpdate = /\b(update|upsert|modify|aktualiz)\b/.test(text);
  // A read verb only implies a Mongo find when it is ACTUALLY NEAR the store.
  // Matching bare `read`/`search` anywhere in the request made "RSS read" and
  // "Google News search" demand `operation.mongo.find` from write-only digest
  // workflows, so every such build reported a phantom coverage gap.
  const dbTerm = '(?:mongo|mongodb|database|baza danych|kolekcj\\w*|collection)';
  const readVerb = '(?:find|lookup|query|read|search|znajd[zź]|wyszuk\\w*|pobierz|odczyt\\w*)';
  const mentionsFind = new RegExp(
    `\\b${dbTerm}\\b[^.\\n;,]{0,40}\\b${readVerb}\\b|\\b${readVerb}\\b[^.\\n;,]{0,40}\\b${dbTerm}\\b`,
  ).test(text);

  if (mentionsMongo) pushEvidence(evidence, 'service.mongo', 'request', 'MongoDB mentioned');
  if ((mentionsMongo || mentionsDb) && mentionsWrite) {
    pushEvidence(evidence, 'operation.mongo.insert', 'request', 'database write/insert mentioned');
    pushEvidence(evidence, 'sideEffect.db.write', 'request', 'database write/insert mentioned');
  }
  if ((mentionsMongo || mentionsDb) && mentionsUpdate) {
    pushEvidence(evidence, 'operation.mongo.update', 'request', 'database update mentioned');
    pushEvidence(evidence, 'sideEffect.db.write', 'request', 'database update mentioned');
  }
  if ((mentionsMongo || mentionsDb) && mentionsFind) {
    pushEvidence(evidence, 'operation.mongo.find', 'request', 'database read/find mentioned');
  }

  if (!telegramForbidden && /\b(telegram|slack|discord|message|wiadom[oś]c|powiadom)\b/.test(text) && /\b(send|notify|alert|wy[sś]lij|powiadom)\b/.test(text)) {
    pushEvidence(evidence, 'sideEffect.message.send', 'request', 'message send mentioned');
    if (/\btelegram\b/.test(text)) pushEvidence(evidence, 'operation.telegram.send', 'request', 'Telegram send mentioned');
  }
  if (!gmailForbidden && /\b(gmail|email|e-mail|mail)\b/.test(text) && /\b(send|draft|wy[sś]lij|odpowiedz)\b/.test(text)) {
    pushEvidence(evidence, 'sideEffect.email.send', 'request', 'email send mentioned');
    pushEvidence(evidence, 'operation.gmail.send', 'request', 'email send mentioned');
  }
  if (!googleSheetsForbidden && /\b(google sheets|sheet|spreadsheet|arkusz)\b/.test(text) && /\b(append|add row|dodaj wiersz|zapisz)\b/.test(text)) {
    pushEvidence(evidence, 'operation.googleSheets.append', 'request', 'Google Sheets append mentioned');
  }

  return dedupeEvidence(evidence);
}

export function deriveForbiddenCapabilities(request?: string): CapabilityEvidence[] {
  const evidence: CapabilityEvidence[] = [];
  const text = normalizeText(request);
  if (!text) return evidence;

  const groups: Array<{ capabilities: AutomationCapability[]; terms: string[]; detail: string }> = [
    {
      capabilities: ['service.mongo', 'node.mongoDb', 'operation.mongo.insert', 'operation.mongo.update', 'sideEffect.db.write'],
      terms: ['mongo', 'mongodb', 'database', 'db', 'baza danych'],
      detail: 'MongoDB/database forbidden',
    },
    {
      capabilities: ['service.telegram', 'node.telegram', 'operation.telegram.send', 'sideEffect.message.send'],
      terms: ['telegram', 'tg'],
      detail: 'Telegram forbidden',
    },
    {
      capabilities: ['service.gmail', 'node.gmail', 'operation.gmail.send', 'sideEffect.email.send'],
      terms: ['gmail'],
      detail: 'Gmail forbidden',
    },
    {
      capabilities: ['node.httpRequest', 'operation.http.post'],
      terms: ['http request', 'http node', 'api call', 'external api'],
      detail: 'Outbound HTTP/API call forbidden',
    },
    {
      capabilities: ['service.googleSheets', 'node.googleSheets', 'operation.googleSheets.append'],
      terms: ['google sheets', 'spreadsheet', 'arkusz'],
      detail: 'Google Sheets forbidden',
    },
  ];

  for (const group of groups) {
    if (!group.terms.some((term) => isNegatedTermMention(text, term))) continue;
    for (const capability of group.capabilities) {
      pushEvidence(evidence, capability, 'request', group.detail);
    }
  }

  return dedupeEvidence(evidence);
}

export function derivePatternCapabilities(pattern: AutomationPattern): CapabilityEvidence[] {
  const evidence: CapabilityEvidence[] = [];

  for (const capability of pattern.capabilities?.supported ?? []) {
    pushEvidence(evidence, capability, 'pattern', `${pattern.id}.capabilities.supported`);
  }

  if (pattern.knowledgeCard) {
    evidence.push(...deriveKnowledgeCardCapabilities(pattern.knowledgeCard, pattern.id));
  }

  for (const credential of pattern.requiredCredentials ?? []) {
    pushServiceCapabilities(evidence, credential, 'credential');
  }

  if ((pattern.capabilities?.supported ?? []).length === 0) {
    const text = [
      pattern.name,
      pattern.description,
      ...(pattern.supportedIntents ?? []),
    ].join(' ');
    evidence.push(...deriveRequestCapabilities(text).map((item) => ({
      ...item,
      source: 'pattern' as const,
      detail: `${pattern.id}: ${item.detail ?? item.capability}`,
    })));
  }

  return dedupeEvidence(evidence);
}

export function deriveWorkflowCapabilities(workflow: any): CapabilityEvidence[] {
  const evidence: CapabilityEvidence[] = [];
  const nodes: any[] = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const serialized = safeJson(workflow).toLowerCase();

  for (const node of nodes) {
    const type = String(node?.type ?? '');
    const lowerType = type.toLowerCase();
    const name = String(node?.name ?? node?.id ?? type);
    const parameters = node?.parameters && typeof node.parameters === 'object' ? node.parameters : {};
    const nodeText = normalizeText([name, safeJson(parameters)].join(' '));
    const sourceDetail = `${name} (${type})`;

    if (type === 'n8n-nodes-base.manualTrigger') {
      pushEvidence(evidence, 'trigger.manual', 'node', sourceDetail);
    }
    if (type === 'n8n-nodes-base.webhook') {
      pushEvidence(evidence, 'trigger.webhook', 'node', sourceDetail);
      pushEvidence(evidence, 'operation.webhook.receive', 'node', sourceDetail);
    }
    if (lowerType.includes('scheduletrigger') || lowerType.includes('cron')) {
      pushEvidence(evidence, 'trigger.schedule', 'node', sourceDetail);
    }
    if (lowerType.includes('telegramtrigger')) {
      pushEvidence(evidence, 'trigger.telegram', 'node', sourceDetail);
      pushEvidence(evidence, 'service.telegram', 'node', sourceDetail);
    }
    if (lowerType.includes('gmailtrigger')) {
      pushEvidence(evidence, 'trigger.gmail', 'node', sourceDetail);
      pushEvidence(evidence, 'service.gmail', 'node', sourceDetail);
    }
    if (type === 'n8n-nodes-base.respondToWebhook') {
      pushEvidence(evidence, 'node.respondToWebhook', 'node', sourceDetail);
      pushEvidence(evidence, 'operation.webhook.respond', 'node', sourceDetail);
    }
    if (type === 'n8n-nodes-base.code' || type === 'n8n-nodes-base.function') {
      pushEvidence(evidence, 'node.code', 'node', sourceDetail);
      if (/\b(validate|validation|errors|required|walidacj|sprawd[zź])\b/.test(nodeText)) {
        pushEvidence(evidence, 'operation.payload.validate', 'node', sourceDetail);
      }
    }
    if (type === 'n8n-nodes-base.mongoDb') {
      pushEvidence(evidence, 'node.mongoDb', 'node', sourceDetail);
      pushEvidence(evidence, 'service.mongo', 'node', sourceDetail);
      const op = normalizeText(String(parameters.operation ?? parameters.operationType ?? ''));
      if (/\b(insert|create)\b/.test(op)) {
        pushEvidence(evidence, 'operation.mongo.insert', 'node', `${sourceDetail}: operation=${op}`);
        pushEvidence(evidence, 'sideEffect.db.write', 'node', `${sourceDetail}: operation=${op}`);
      } else if (/\b(update|upsert)\b/.test(op)) {
        pushEvidence(evidence, 'operation.mongo.update', 'node', `${sourceDetail}: operation=${op}`);
        pushEvidence(evidence, 'sideEffect.db.write', 'node', `${sourceDetail}: operation=${op}`);
      } else if (/\b(find|findone|get|read)\b/.test(op)) {
        pushEvidence(evidence, 'operation.mongo.find', 'node', `${sourceDetail}: operation=${op}`);
      }
    }
    if (type === 'n8n-nodes-base.httpRequest') {
      pushEvidence(evidence, 'node.httpRequest', 'node', sourceDetail);
      const method = normalizeText(String(parameters.method ?? parameters.requestMethod ?? 'GET'));
      if (method === 'post') {
        pushEvidence(evidence, 'operation.http.post', 'node', `${sourceDetail}: method=POST`);
      }
      const url = String(parameters.url ?? '');
      if (/localhost:4111|mastra|agentforge/i.test(url)) pushEvidence(evidence, 'service.mastraApi', 'node', sourceDetail);
      if (/localhost:11434|ollama/i.test(url)) pushEvidence(evidence, 'service.ollama', 'node', sourceDetail);
    }
    if (type === 'n8n-nodes-base.telegram' || lowerType.includes('telegram')) {
      pushEvidence(evidence, 'node.telegram', 'node', sourceDetail);
      pushEvidence(evidence, 'service.telegram', 'node', sourceDetail);
      if (type === 'n8n-nodes-base.telegram' || /\b(send|message|sendmessage|alert)\b/.test(nodeText)) {
        pushEvidence(evidence, 'operation.telegram.send', 'node', sourceDetail);
        pushEvidence(evidence, 'sideEffect.message.send', 'node', sourceDetail);
      }
    }
    if (type === 'n8n-nodes-base.gmail' || lowerType.includes('gmail')) {
      pushEvidence(evidence, 'node.gmail', 'node', sourceDetail);
      pushEvidence(evidence, 'service.gmail', 'node', sourceDetail);
      if (/\b(send|message|email)\b/.test(nodeText)) {
        pushEvidence(evidence, 'operation.gmail.send', 'node', sourceDetail);
        pushEvidence(evidence, 'sideEffect.email.send', 'node', sourceDetail);
      }
    }
    if (lowerType.includes('googlesheets') || lowerType.includes('googleSheets')) {
      pushEvidence(evidence, 'node.googleSheets', 'node', sourceDetail);
      pushEvidence(evidence, 'service.googleSheets', 'node', sourceDetail);
      if (/\b(append|add|row)\b/.test(nodeText)) {
        pushEvidence(evidence, 'operation.googleSheets.append', 'node', sourceDetail);
      }
    }
  }

  if (serialized.includes('localhost:4111') || serialized.includes('mastra')) {
    pushEvidence(evidence, 'runtime.localMastraApi', 'workflow', 'workflow references Mastra API');
  }
  if (serialized.includes('localhost:11434') || serialized.includes('ollama')) {
    pushEvidence(evidence, 'runtime.localOllama', 'workflow', 'workflow references Ollama');
  }
  if (serialized.includes('mongodb') || serialized.includes('mongo')) {
    pushEvidence(evidence, 'runtime.localMongo', 'workflow', 'workflow references MongoDB');
  }

  return dedupeEvidence(evidence);
}

export function evaluateCapabilityCoverage(
  required: CapabilityEvidence[],
  actual: CapabilityEvidence[],
  forbidden: CapabilityEvidence[] = [],
): CapabilityCoverageResult {
  const forbiddenCapabilities = uniqueCapabilities(forbidden);
  const forbiddenSet = new Set(forbiddenCapabilities);
  const requiredCapabilities = uniqueCapabilities(required).filter((capability) => !forbiddenSet.has(capability));
  const actualCapabilities = uniqueCapabilities(actual);
  const actualSet = new Set(actualCapabilities);
  const missingRequired = requiredCapabilities.filter((capability) => !actualSet.has(capability));
  const forbiddenActual = forbiddenCapabilities.filter((capability) => actualSet.has(capability));
  const missingCritical = missingRequired.filter(isCriticalCapability);
  const score = requiredCapabilities.length === 0
    ? 1
    : roundCoverage((requiredCapabilities.length - missingRequired.length) / requiredCapabilities.length);

  const warnings = [
    ...missingRequired.map((capability) =>
      `Missing required capability: ${capability}${isCriticalCapability(capability) ? ' (critical)' : ''}`,
    ),
    ...forbiddenActual.map((capability) => `Forbidden capability present: ${capability}`),
  ];

  const recommendation: CapabilityCoverageRecommendation = forbiddenActual.length > 0
    ? 'block'
    : missingCritical.length > 0
    ? 'delegate_mcp'
    : missingRequired.length > 0
      ? 'compose_workflow_json'
      : 'use_pattern';

  return {
    ok: missingRequired.length === 0 && forbiddenActual.length === 0,
    score,
    required: requiredCapabilities,
    actual: actualCapabilities,
    forbidden: forbiddenCapabilities,
    forbiddenActual,
    missingRequired,
    warnings,
    recommendation,
    evidence: dedupeEvidence([...required, ...actual, ...forbidden]),
  };
}

export function formatCoverageForModel(result: CapabilityCoverageResult): string {
  const missing = result.missingRequired.length > 0
    ? result.missingRequired.join(', ')
    : 'none';
  const forbiddenActual = result.forbiddenActual.length > 0
    ? result.forbiddenActual.join(', ')
    : 'none';
  return [
    `coverage.ok=${result.ok}`,
    `coverage.score=${result.score}`,
    `missingRequired=${missing}`,
    `forbiddenActual=${forbiddenActual}`,
    `recommendation=${result.recommendation}`,
  ].join('; ');
}

export function isCriticalCapability(capability: AutomationCapability): boolean {
  return CRITICAL_CAPABILITIES.has(capability);
}

export function criticalMissingCapabilities(result: CapabilityCoverageResult): AutomationCapability[] {
  return result.missingRequired.filter(isCriticalCapability);
}

export function evaluateWorkflowCoverage(input: {
  spec?: AutomationSpec;
  request?: string;
  workflow: any;
}): CapabilityCoverageResult {
  const required = input.spec
    ? deriveSpecCapabilities(input.spec, input.request)
    : deriveRequestCapabilities(input.request);
  const forbidden = deriveForbiddenCapabilities(input.request);
  const actual = deriveWorkflowCapabilities(input.workflow);
  return evaluateCapabilityCoverage(required, actual, forbidden);
}

export function evaluatePatternCoverage(input: {
  pattern: AutomationPattern;
  spec?: AutomationSpec;
  request?: string;
}): CapabilityCoverageResult {
  const required = input.spec
    ? deriveSpecCapabilities(input.spec, input.request)
    : deriveRequestCapabilities(input.request);
  const forbidden = deriveForbiddenCapabilities(input.request);
  const actual = derivePatternCapabilities(input.pattern);
  return evaluateCapabilityCoverage(required, actual, forbidden);
}

function deriveKnowledgeCardCapabilities(card: PatternKnowledgeCard, patternId: string): CapabilityEvidence[] {
  const evidence: CapabilityEvidence[] = [];
  for (const node of card.nodes ?? []) {
    const text = normalizeText(node);
    if (text.includes('webhook')) {
      pushEvidence(evidence, 'trigger.webhook', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
      pushEvidence(evidence, 'operation.webhook.receive', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
    }
    if (text.includes('respond')) {
      pushEvidence(evidence, 'node.respondToWebhook', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
      pushEvidence(evidence, 'operation.webhook.respond', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
    }
    if (text.includes('code') || text.includes('function')) {
      pushEvidence(evidence, 'node.code', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
    }
    if (text.includes('http')) {
      pushEvidence(evidence, 'node.httpRequest', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
    }
    if (text.includes('telegram')) {
      pushEvidence(evidence, 'node.telegram', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
      pushEvidence(evidence, 'service.telegram', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
    }
    if (text.includes('gmail')) {
      pushEvidence(evidence, 'node.gmail', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
      pushEvidence(evidence, 'service.gmail', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
    }
    if (text.includes('mongo')) {
      pushEvidence(evidence, 'node.mongoDb', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
      pushEvidence(evidence, 'service.mongo', 'pattern', `${patternId}.knowledgeCard.nodes=${node}`);
    }
  }
  return evidence;
}

function pushStepCapabilities(evidence: CapabilityEvidence[], actionType: string, stepText: string): void {
  const text = normalizeText(stepText);
  evidence.push(...deriveRequestCapabilities(text));
  if (actionType === 'write' && /\b(mongo|mongodb|database|db|baza danych)\b/.test(text)) {
    pushEvidence(evidence, 'sideEffect.db.write', 'spec', `step.actionType=${actionType}`);
  }
  if (actionType === 'send' && /\b(gmail|email|e-mail|mail)\b/.test(text)) {
    pushEvidence(evidence, 'sideEffect.email.send', 'spec', `step.actionType=${actionType}`);
  } else if (
    actionType === 'send' &&
    /\b(telegram|slack|discord|message|wiadomosc|powiadom|notify|alert)\b/.test(text)
  ) {
    pushEvidence(evidence, 'sideEffect.message.send', 'spec', `step.actionType=${actionType}`);
  }
  if (actionType === 'send' && /\b(webhook|http response|return json|respond|odpowiedz|zwroc)\b/.test(text)) {
    pushEvidence(evidence, 'operation.webhook.respond', 'spec', `step.actionType=${actionType}`);
  }
}

function pushServiceCapabilities(
  evidence: CapabilityEvidence[],
  serviceText: string,
  source: CapabilityEvidence['source'],
): void {
  const text = normalizeText(serviceText);
  if (!text) return;

  for (const alias of SERVICE_ALIASES) {
    if (!alias.pattern.test(text)) continue;
    for (const capability of alias.capabilities) {
      if (source === 'request' && isNegatedCapabilityMention(text, capability)) continue;
      pushEvidence(evidence, capability, source, serviceText);
    }
  }
}

function pushEvidence(
  evidence: CapabilityEvidence[],
  capability: AutomationCapability,
  source: CapabilityEvidence['source'],
  detail?: string,
): void {
  evidence.push({ capability, source, detail });
}

function hasCapability(evidence: CapabilityEvidence[], capability: AutomationCapability): boolean {
  return evidence.some((item) => item.capability === capability);
}

function uniqueCapabilities(evidence: CapabilityEvidence[]): AutomationCapability[] {
  return [...new Set(evidence.map((item) => item.capability))].sort();
}

function dedupeEvidence(evidence: CapabilityEvidence[]): CapabilityEvidence[] {
  const seen = new Set<string>();
  const deduped: CapabilityEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.capability}|${item.source}|${item.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function normalizeText(value?: string): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function mentionsOutboundHttpPost(text: string): boolean {
  if (!text) return false;
  if (/\b(post webhook|post http endpoint|post api endpoint|post endpoint|post webhook path|post webhook url)\b/.test(text)) {
    return false;
  }
  return (
    /\b(http post|post request|http request\s+post|post\s+http request)\b/.test(text) ||
    /\b(post|send|call|wy[sś]lij|wyslij)\b.{0,40}\b(to|do)\b.{0,40}\b(api|crm|url|external service|zewnetrznego api|zewnetrzny endpoint)\b/.test(text) ||
    /\b(api|crm|external service|zewnetrzne api)\b.{0,40}\b(post|send|call)\b/.test(text)
  );
}

function isNegatedCapabilityMention(text: string, capability: AutomationCapability): boolean {
  return (CAPABILITY_TERMS[capability] ?? []).some((term) => isNegatedTermMention(text, term));
}

function isNegatedTermMention(text: string, term: string): boolean {
  const escaped = escapeRegExp(normalizeText(term));
  return new RegExp(
    [
      `\\b(?:no|without|exclude|excluding|skip|avoid|forbid|forbidden|nie uzywaj|nie uzywac|bez|bez uzycia|zero)\\b[^.\\n;,]{0,50}\\b${escaped}\\b`,
      `\\b${escaped}\\b[^.\\n;,]{0,40}\\b(?:not required|forbidden|excluded|nie wymagane|nie jest wymagane|nie uzywaj|bez uzycia)\\b`,
    ].join('|'),
  ).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '';
  }
}

function roundCoverage(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
