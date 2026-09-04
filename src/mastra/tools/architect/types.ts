/**
 * Automation Architect type definitions.
 *
 * Ported from jarvis-dashboard-agent/packages/automation-architect/src/types
 * and patterns/patternTypes.ts. Consolidated into a single local file so the
 * tools/architect tree is self-contained (no @af/... workspace imports).
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type AutomationSpec = {
  id: string;
  requestId: string;
  name: string;
  description: string;
  goal: string;
  trigger: {
    type: 'manual' | 'schedule' | 'webhook' | 'email' | 'external_event';
    schedule?: {
      frequency: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly';
      time?: string;
      timezone: string;
      cron?: string;
    };
    webhook?: {
      method: 'GET' | 'POST';
      expectedPayloadDescription: string;
    };
  };
  inputs: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'url' | 'secret' | 'json';
    required: boolean;
    description: string;
    value?: unknown;
    defaultValue?: unknown;
    source?: 'user' | 'env' | 'runtime' | 'derived' | 'placeholder';
    aliases?: string[];
  }>;
  steps: Array<{
    id: string;
    name: string;
    purpose: string;
    actionType: 'read' | 'transform' | 'condition' | 'notify' | 'write' | 'send' | 'delete' | 'execute';
    expectedInput?: string;
    expectedOutput?: string;
    failureBehavior?: 'stop' | 'continue' | 'retry' | 'notify_user';
  }>;
  externalServices?: string[];
  credentialsNeeded?: Array<{
    service: string;
    credentialName?: string;
    required: boolean;
    notes?: string;
  }>;
  dataPolicy?: {
    readsExternalData?: boolean;
    writesExternalData?: boolean;
    sendsMessages?: boolean;
    touchesCustomerData?: boolean;
    touchesProductionDb?: boolean;
    usesPaidApi?: boolean;
    usesFileSystem?: boolean;
    usesShellCommand?: boolean;
  };
  successCriteria?: string[];
  riskLevel?: RiskLevel;
  requiresApproval?: boolean;
  missingConfig?: Array<{
    key: string;
    description: string;
    required: boolean;
  }>;
};

export type AutomationPatternRisk = RiskLevel;

export type PatternMaturity = 'draft' | 'tested' | 'production';

export type AutomationCapability =
  | 'trigger.manual'
  | 'trigger.webhook'
  | 'trigger.schedule'
  | 'trigger.telegram'
  | 'trigger.gmail'
  | 'node.code'
  | 'node.respondToWebhook'
  | 'node.httpRequest'
  | 'node.mongoDb'
  | 'node.telegram'
  | 'node.gmail'
  | 'node.googleSheets'
  | 'service.mastraApi'
  | 'service.ollama'
  | 'service.mongo'
  | 'service.telegram'
  | 'service.gmail'
  | 'service.googleSheets'
  | 'operation.webhook.receive'
  | 'operation.webhook.respond'
  | 'operation.payload.validate'
  | 'operation.mongo.insert'
  | 'operation.mongo.find'
  | 'operation.mongo.update'
  | 'operation.http.post'
  | 'operation.telegram.send'
  | 'operation.gmail.send'
  | 'operation.googleSheets.append'
  | 'sideEffect.db.write'
  | 'sideEffect.message.send'
  | 'sideEffect.email.send'
  | 'runtime.publicWebhook'
  | 'runtime.localMongo'
  | 'runtime.localMastraApi'
  | 'runtime.localOllama';

export type AutomationPatternCapabilities = {
  supported: AutomationCapability[];
  excluded?: AutomationCapability[];
  requiredForSuccess?: AutomationCapability[];
  notes?: string[];
};

export type AutomationPattern = {
  id: string;
  name: string;
  description: string;
  risk: AutomationPatternRisk;
  supportedIntents: string[];
  requiredInputs: string[];
  requiredCredentials: string[];
  forbiddenWithoutApproval: boolean;
  /**
   * Whether this pattern produces a deployable n8n workflow JSON.
   * `false` = abstract / knowledge-only — usable as RAG context but
   * `compose_workflow` and `match_pattern` will refuse to return it.
   * Defaults to `true` if omitted — only set `false` explicitly for
   * abstract / pattern-card-only entries.
   */
  executable?: boolean;
  /**
   * Lifecycle stage. `production` patterns are smoke-tested and safe;
   * `tested` passed validation but not deployed often; `draft` is WIP.
   * Defaults to `tested` if omitted (legacy).
   */
  maturity?: PatternMaturity;
  /**
   * Whether the pattern works on n8n Community Edition (no enterprise
   * features). Defaults to `true`.
   */
  n8nCommunityCompatible?: boolean;
  capabilities?: AutomationPatternCapabilities;
  build: (spec: AutomationSpec) => any;
  knowledgeCard?: PatternKnowledgeCard;
};

export type PatternKnowledgeCard = {
  id: string;
  name: string;
  intentExamples: string[];
  useWhen: string[];
  avoidWhen: string[];
  preferredModel?: 'gemma4-26b' | 'qwen35b' | 'gemini';
  risk: RiskLevel;
  nodes: string[];
  credentials: string[];
  approvalRequired: boolean;
  testingStrategy: string[];
  commonFailures: string[];
  fallbackStrategy?: string[];
};

export type StoredAutomationPattern = Omit<AutomationPattern, 'build' | 'knowledgeCard'> & {
  builderId: string;
  embedding?: number[];
  embeddingModel?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AutomationDecisionRule = {
  id: string;
  rule: string;
  reason: string;
};

export type ModelChoice = {
  provider: 'ollama' | 'gemini_gateway';
  model: string;
  reason: string;
};
