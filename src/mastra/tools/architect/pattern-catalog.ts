/**
 * Automation pattern catalog.
 *
 * Ported verbatim from jarvis-dashboard-agent/packages/automation-architect/src/patterns/catalog.ts
 *
 * Pre-built n8n workflow templates that the AutomationArchitect can match
 * against an AutomationSpec. Each pattern has a `build(spec)` function
 * returning a deployable n8n workflow JSON (nodes + connections + settings).
 */
import type { AutomationSpec, AutomationPattern } from './types.js';
import type { AnyInput } from './builders/helpers.js';

// Import builders
import { buildRssKeywordToTelegram } from './builders/rssToTelegram.js';
import { buildScheduledHttpKeywordToTelegram } from './builders/scheduledHttpKeywordToTelegram.js';
import { buildMultiUrlMonitorToTelegram } from './builders/multiUrlMonitorToTelegram.js';
import { buildWebhookValidateRespond } from './builders/webhookValidateRespond.js';
import { buildWebhookLeadToAgentForgeCrm } from './builders/webhookLeadToAgentForgeCrm.js';
import { buildScheduledAgentForgeTask } from './builders/scheduledAgentForgeTask.js';
import { buildHttpHealthMonitorToTelegram } from './builders/httpHealthMonitorToTelegram.js';
import { buildWebhookCommandRouterToAgentForge } from './builders/webhookCommandRouterToAgentForge.js';
import { buildWebhookSecurityFilteredTelegram } from './builders/webhookSecurityFilteredTelegram.js';

import {
  buildTelegramToOllamaReply,
  buildTelegramModelRouter,
  buildTelegramAutomationRequestToAgentForge,
  buildRssOllamaClassifierToTelegram,
  buildCompetitorResearchToMemoryAndTelegram,
  buildTelegramRememberToMemory,
  buildDailyMemoryDigestToTelegram,
  buildN8nFailedExecutionExplainer,
  buildLocalLlmWithGeminiFallback,
  buildLeadWebhookOllamaExtractToCrm,
  buildPromptModelComparisonBench,
  buildWebhookIdempotencyGuard,
  buildTelegramMemorySearchOllamaAnswer,
  buildFormLeadQualifierToCrm,
  buildBatchUrlResearchDigest,
  buildAgentForgeBacklogPrioritizer
} from './builders/extendedPatterns.js';

import {
  buildErrorWorkflowOllamaTelegramMemory,
  buildRssDedupToMemoryTelegram,
  buildTelegramTaskTriageToAgentForgeQueue,
  buildApprovalRequestToTelegram,
  buildTelegramApprovalRouter,
  buildOllamaModelHealthCheck,
  buildLocalModelQualityEvaluator,
  buildWebhookOllamaJsonNormalizerToApi,
  buildWorkflowDocumentation,
  buildDraftOnlyEmailAssistant,
  buildDailyStandup,
  buildRefusalPattern
} from './builders/advancedPatterns.js';
import { buildAiScraperToCrm } from './builders/scraperPattern.js';

// Re-export commonly needed types so existing importers (pattern-rag, composer)
// can keep importing from this module.
export type {
  AutomationSpec,
  AutomationPattern,
  PatternKnowledgeCard,
  StoredAutomationPattern,
  AutomationDecisionRule,
  ModelChoice,
  RiskLevel,
} from './types.js';

/**
 * Registry of all supported automation patterns.
 */
export const automationPatterns: AutomationPattern[] = [
  {
    id: 'rss-keyword-to-telegram',
    name: 'RSS Keyword Monitor to Telegram',
    description: 'Reads an RSS feed, filters items by keywords and sends matching items to Telegram.',
    risk: 'medium',
    supportedIntents: ['rss_monitoring', 'competitor_monitoring', 'blog_monitoring'],
    requiredInputs: ['rssUrl', 'keywords'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildRssKeywordToTelegram
  },
  {
    id: 'scheduled-http-keyword-to-telegram',
    name: 'Scheduled HTTP Keyword Monitor to Telegram',
    description: 'Checks a URL on a schedule and sends a Telegram alert when keywords are found.',
    risk: 'medium',
    supportedIntents: ['website_monitoring', 'keyword_monitoring', 'competitor_monitoring'],
    requiredInputs: ['url', 'keywords'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildScheduledHttpKeywordToTelegram
  },
  {
    id: 'multi-url-monitor-to-telegram',
    name: 'Multi URL Competitor Monitor',
    description: 'Checks multiple URLs and sends Telegram alerts for keyword matches.',
    risk: 'medium',
    supportedIntents: ['competitor_monitoring', 'multi_url_monitoring'],
    requiredInputs: ['urls', 'keywords'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildMultiUrlMonitorToTelegram
  },
  {
    id: 'webhook-validate-respond',
    name: 'Webhook Validate and Respond',
    description: 'Receives a webhook, validates payload and returns a JSON response.',
    risk: 'low',
    supportedIntents: ['webhook_endpoint', 'api_endpoint', 'test_endpoint'],
    requiredInputs: ['path'],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    capabilities: {
      supported: [
        'trigger.webhook',
        'operation.webhook.receive',
        'operation.payload.validate',
        'operation.webhook.respond',
        'node.code',
        'node.respondToWebhook'
      ],
      excluded: [
        'operation.mongo.insert',
        'operation.mongo.update',
        'sideEffect.db.write'
      ],
      notes: ['Generic webhook validation pattern. Does not persist data.']
    },
    build: buildWebhookValidateRespond
  },
  {
    id: 'webhook-lead-to-agentforge-crm',
    name: 'Webhook Lead to AgentForge CRM',
    description: 'Receives lead data, normalizes it, sends it to AgentForge CRM and alerts Telegram.',
    risk: 'high',
    supportedIntents: ['lead_capture', 'crm', 'sales_pipeline'],
    requiredInputs: ['path', 'crmEndpoint'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    capabilities: {
      supported: [
        'trigger.webhook',
        'operation.webhook.receive',
        'node.code',
        'node.httpRequest',
        'operation.http.post',
        'service.mastraApi',
        'node.telegram',
        'service.telegram',
        'operation.telegram.send',
        'sideEffect.message.send',
        'node.respondToWebhook',
        'operation.webhook.respond'
      ],
      excluded: [
        'operation.mongo.insert',
        'operation.mongo.update'
      ],
      notes: ['Sends leads to AgentForge CRM over HTTP; it does not insert directly into MongoDB.']
    },
    build: buildWebhookLeadToAgentForgeCrm
  },
  {
    id: 'scheduled-agentforge-task',
    name: 'Scheduled AgentForge Task',
    description: 'Creates a scheduled task and sends it to the AgentForge task endpoint.',
    risk: 'medium',
    supportedIntents: ['scheduled_agent_task', 'recurring_ai_task'],
    requiredInputs: ['taskType', 'prompt', 'endpoint'],
    requiredCredentials: [],
    forbiddenWithoutApproval: true,
    build: buildScheduledAgentForgeTask
  },
  {
    id: 'http-health-monitor-to-telegram',
    name: 'HTTP Health Monitor to Telegram',
    description: 'Checks service health and alerts Telegram if response does not match expectation.',
    risk: 'medium',
    supportedIntents: ['health_monitoring', 'uptime_monitoring'],
    requiredInputs: ['url'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildHttpHealthMonitorToTelegram
  },
  {
    id: 'webhook-command-router-to-agentforge',
    name: 'Webhook Command Router to AgentForge',
    description: 'Routes incoming webhook commands into AgentForge task queue.',
    risk: 'high',
    supportedIntents: ['command_router', 'agentforge_router', 'webhook_to_queue'],
    requiredInputs: ['path', 'taskEndpoint'],
    requiredCredentials: [],
    forbiddenWithoutApproval: true,
    build: buildWebhookCommandRouterToAgentForge
  },
  {
    id: 'webhook-security-filtered-telegram',
    name: 'Secure Webhook to Telegram',
    description: 'Receives secure webhook events and sends Telegram alerts after token validation.',
    risk: 'medium',
    supportedIntents: ['secure_webhook', 'alert_webhook'],
    requiredInputs: ['path'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildWebhookSecurityFilteredTelegram
  },
  {
    id: 'telegram-to-ollama-reply',
    name: 'Telegram to Ollama Reply',
    description: 'Receives Telegram messages, sends them to local Ollama and replies on Telegram.',
    risk: 'medium',
    supportedIntents: ['telegram_chatbot', 'local_llm_chat', 'telegram_llm'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramToOllamaReply
  },
  {
    id: 'telegram-model-router',
    name: 'Telegram Model Router',
    description: 'Routes Telegram commands to different local Ollama models depending on task type.',
    risk: 'medium',
    supportedIntents: ['model_router', 'telegram_model_router', 'local_model_selection'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramModelRouter
  },
  {
    id: 'telegram-automation-request-to-agentforge',
    name: 'Telegram Automation Request to AgentForge',
    description: 'Turns /automation Telegram commands into Automation Architect tasks.',
    risk: 'medium',
    supportedIntents: ['automation_request', 'telegram_to_automation_architect'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramAutomationRequestToAgentForge
  },
  {
    id: 'rss-ollama-classifier-to-telegram',
    name: 'RSS Ollama Classifier to Telegram',
    description: 'Reads RSS, classifies items with local Ollama and sends relevant items to Telegram.',
    risk: 'medium',
    supportedIntents: ['rss_classification', 'rss_monitoring', 'competitor_monitoring'],
    requiredInputs: ['rssUrl', 'topics'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildRssOllamaClassifierToTelegram
  },
  {
    id: 'competitor-research-to-memory-and-telegram',
    name: 'Competitor Research to Memory and Telegram',
    description: 'Fetches competitor pages, summarizes with local LLM, stores in AgentForge memory and sends digest.',
    risk: 'high',
    supportedIntents: ['competitor_research', 'market_research', 'business_intelligence'],
    requiredInputs: ['urls'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildCompetitorResearchToMemoryAndTelegram
  },
  {
    id: 'telegram-remember-to-memory',
    name: 'Telegram Remember to Memory',
    description: 'Saves /remember Telegram messages to AgentForge memory.',
    risk: 'medium',
    supportedIntents: ['memory_capture', 'telegram_memory', 'remember_command'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramRememberToMemory
  },
  {
    id: 'daily-memory-digest-to-telegram',
    name: 'Daily Memory Digest to Telegram',
    description: 'Fetches AgentForge memory, summarizes it with Ollama and sends daily Telegram digest.',
    risk: 'medium',
    supportedIntents: ['daily_digest', 'memory_digest', 'daily_summary'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildDailyMemoryDigestToTelegram
  },
  {
    id: 'n8n-failed-execution-explainer',
    name: 'n8n Failed Execution Explainer',
    description: 'Monitors failed n8n executions, explains them with Ollama and alerts Telegram.',
    risk: 'high',
    supportedIntents: ['n8n_monitoring', 'execution_monitoring', 'workflow_debugging'],
    requiredInputs: [],
    requiredCredentials: ['telegram', 'n8n_api_key'],
    forbiddenWithoutApproval: true,
    build: buildN8nFailedExecutionExplainer
  },
  {
    id: 'local-llm-with-gemini-fallback',
    name: 'Local LLM with Gemini Fallback',
    description: 'Uses local Ollama first and escalates to Gemini through AgentForge gateway only when needed.',
    risk: 'high',
    supportedIntents: ['llm_fallback', 'gemini_fallback', 'hard_reasoning'],
    requiredInputs: ['prompt'],
    requiredCredentials: ['gemini_gateway'],
    forbiddenWithoutApproval: true,
    build: buildLocalLlmWithGeminiFallback
  },
  {
    id: 'lead-webhook-ollama-extract-to-crm',
    name: 'Lead Webhook Ollama Extract to CRM',
    description: 'Receives lead payload, extracts structured lead data with Ollama, saves to CRM and alerts Telegram.',
    risk: 'high',
    supportedIntents: ['lead_capture', 'lead_extraction', 'crm_intake'],
    requiredInputs: ['path'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildLeadWebhookOllamaExtractToCrm
  },
  {
    id: 'prompt-model-comparison-bench',
    name: 'Prompt Model Comparison Bench',
    description: 'Runs the same prompt through multiple local models and sends comparison to Telegram.',
    risk: 'medium',
    supportedIntents: ['model_benchmark', 'prompt_testing', 'model_comparison'],
    requiredInputs: ['prompt'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildPromptModelComparisonBench
  },
  {
    id: 'error-workflow-ollama-telegram-memory',
    name: 'Error Workflow with Ollama Explanation',
    description: 'Centralized error handler that uses local Ollama to explain failures, alerts Telegram and saves to AgentForge memory.',
    risk: 'high',
    supportedIntents: ['error_handling', 'monitoring', 'workflow_debugging', 'system_alerts'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildErrorWorkflowOllamaTelegramMemory,
    knowledgeCard: {
      id: 'error-workflow-ollama-telegram-memory',
      name: 'Error Workflow -> Ollama Explanation -> Telegram -> Memory',
      intentExamples: ['n8n workflow monitoring', 'centralized error alerts', 'explain n8n errors with ai'],
      useWhen: ['workflow failures need explanation', 'real-time technical alerts are needed'],
      avoidWhen: ['simple workflows where internal n8n error handling is enough'],
      risk: 'high',
      nodes: ['Error Trigger', 'Code', 'HTTP Request', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Manually trigger an error in a linked workflow'],
      commonFailures: ['Ollama model not available', 'Missing Telegram chatId (set N8N_TELEGRAM_CHAT_ID in .env)'],
    }
  },
  {
    id: 'rss-dedup-memory-telegram',
    name: 'RSS with Smart Deduplication',
    description: 'Reads RSS feeds and uses AgentForge memory to ensure no duplicate items are processed or alerted.',
    risk: 'medium',
    supportedIntents: ['rss_monitoring', 'deduplication', 'competitor_monitoring'],
    requiredInputs: ['rssUrl'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildRssDedupToMemoryTelegram
  },
  {
    id: 'telegram-task-triage-agentforge-queue',
    name: 'Telegram Task Triage to Queue',
    description: 'Uses local Ollama to classify Telegram messages into task queues (marketing, research, etc.).',
    risk: 'medium',
    supportedIntents: ['task_triage', 'telegram_orchestration', 'agent_queue'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramTaskTriageToAgentForgeQueue
  },
  {
    id: 'approval-request-telegram',
    name: 'Approval Request Gate (Telegram)',
    description: 'Creates a secure approval token and asks for user confirmation via Telegram before proceeding.',
    risk: 'medium',
    supportedIntents: ['human_approval', 'approval_gate', 'security_gate'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildApprovalRequestToTelegram
  },
  {
    id: 'telegram-approval-router',
    name: 'Telegram Approval Router',
    description: 'Receives /approve and /reject commands from Telegram and resolves pending approval requests.',
    risk: 'medium',
    supportedIntents: ['approval_resolution', 'telegram_commands'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildTelegramApprovalRouter
  },
  {
    id: 'ollama-model-health-check',
    name: 'Ollama Model Health Check',
    description: 'Regularly checks if required local models are available in Ollama and alerts Telegram if missing.',
    risk: 'low',
    supportedIntents: ['health_check', 'system_monitoring', 'ollama_monitoring'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildOllamaModelHealthCheck
  },
  {
    id: 'local-model-quality-evaluator',
    name: 'Local Model Quality Evaluator',
    description: 'Benchmarks multiple local models on the same prompt and uses a judge model to evaluate winners.',
    risk: 'medium',
    supportedIntents: ['model_evaluation', 'benchmarking', 'llm_ops'],
    requiredInputs: ['prompt'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildLocalModelQualityEvaluator
  },
  {
    id: 'webhook-ollama-json-normalizer-api',
    name: 'Webhook Ollama JSON Normalizer',
    description: 'Receives raw data via webhook, uses Ollama to normalize it to structured JSON and saves to API.',
    risk: 'medium',
    supportedIntents: ['data_normalization', 'webhook_intake', 'structured_data'],
    requiredInputs: ['path'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildWebhookOllamaJsonNormalizerToApi
  },
  {
    id: 'workflow-documentation',
    name: 'Workflow Self-Documentation',
    description: 'Generates detailed documentation for the current workflow and saves it to AgentForge memory.',
    risk: 'low',
    supportedIntents: ['documentation', 'system_audit', 'observability'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    build: buildWorkflowDocumentation
  },
  {
    id: 'draft-only-email-assistant',
    name: 'Draft-Only Email Assistant',
    description: 'Monitors Gmail, drafts a reply using local LLM, and saves it as a proposal without sending.',
    risk: 'high',
    supportedIntents: ['email_assistant', 'draft_reply', 'gmail_automation'],
    requiredInputs: [],
    requiredCredentials: ['gmail', 'telegram'],
    forbiddenWithoutApproval: true,
    build: buildDraftOnlyEmailAssistant,
    knowledgeCard: {
      id: 'draft-only-email-assistant',
      name: 'Gmail -> Ollama -> Draft Proposal -> Telegram',
      intentExamples: ['help me reply to emails', 'create draft response on gmail', 'email assistant'],
      useWhen: ['user wants help with correspondence', 'security is priority (no auto-send)'],
      avoidWhen: ['immediate automatic response without human is required'],
      risk: 'high',
      nodes: ['Gmail Trigger', 'Code', 'Ollama', 'HTTP Request', 'Telegram'],
      credentials: ['Gmail', 'Telegram'],
      approvalRequired: true,
      testingStrategy: ['Send test email to yourself and check draft'],
      commonFailures: ['Missing Gmail API permissions', 'Ollama model too creative/informal'],
    }
  },
  {
    id: 'agentforge-daily-standup',
    name: 'AgentForge Daily Standup',
    description: 'Scheduled task that summarizes system status, tasks, and approvals for a Telegram report.',
    risk: 'medium',
    supportedIntents: ['daily_report', 'system_summary', 'standup'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildDailyStandup
  },
  {
    id: 'automation-refusal-safety',
    name: 'Safety Refusal Pattern',
    description: 'Used when a request involves prohibited or high-risk actions. Explains the risk and suggests alternatives.',
    risk: 'low',
    supportedIntents: ['prohibited_action', 'security_refusal', 'risk_mitigation'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildRefusalPattern,
    knowledgeCard: {
      id: 'automation-refusal-safety',
      name: 'Safety Refusal / "Do Nothing" Pattern',
      intentExamples: ['delete all data', 'send spam to 1000 people', 'use shell command'],
      useWhen: ['request is dangerous', 'request involves SSH/Shell/Data destruction'],
      avoidWhen: ['request is safe and can be accomplished otherwise'],
      risk: 'low',
      nodes: ['Code', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: false,
      testingStrategy: ['Ask to delete the database and check the response'],
      commonFailures: ['Too aggressive refusal to safe requests'],
    }
  },
  {
    id: 'webhook-idempotency-guard',
    name: 'Webhook Idempotency Guard',
    description: 'Prevents double processing of the same event using a unique idempotency key.',
    risk: 'medium',
    supportedIntents: [
      'webhook_deduplication',
      'idempotent_webhook',
      'safe_webhook'
    ],
    requiredInputs: ['path'],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    build: buildWebhookIdempotencyGuard,
    knowledgeCard: {
      id: 'webhook-idempotency-guard',
      name: 'Webhook Idempotency Guard',
      intentExamples: ['protect webhook against duplicates', 'webhook idempotency', 'idempotent webhook'],
      useWhen: ['webhooks from forms', 'webhooks from payments', 'webhooks from Telegram', 'lead capture'],
      avoidWhen: ['events are naturally unique and no retry risk'],
      risk: 'medium',
      nodes: ['Webhook', 'Code', 'HTTP Request (AgentForge)'],
      credentials: [],
      approvalRequired: false,
      testingStrategy: ['Send the same payload twice and check if the second was ignored'],
      commonFailures: ['Missing idempotency key in payload'],
    }
  },
  {
    id: 'telegram-memory-search-ollama-answer',
    name: 'Telegram Memory Search with Ollama Answer',
    description: 'Local memory assistant that searches AgentForge memory and answers via Ollama on Telegram.',
    risk: 'medium',
    supportedIntents: [
      'memory_search',
      'telegram_rag',
      'ask_memory'
    ],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramMemorySearchOllamaAnswer,
    knowledgeCard: {
      id: 'telegram-memory-search-ollama-answer',
      name: 'Telegram Memory Search -> Ollama Answer',
      intentExamples: ['/ask what do you know about...', 'search memory', 'find in agentforge'],
      useWhen: ['user wants to ask a question to their knowledge base/memory'],
      avoidWhen: ['knowledge from outside the system is required (use Gemini then)'],
      risk: 'medium',
      nodes: ['Telegram Trigger', 'HTTP Request', 'Ollama', 'Code'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Ask a question using /ask about something you saved earlier'],
      commonFailures: ['No search results (empty memory)', 'Ollama model hallucinates out of context'],
    }
  },
  {
    id: 'form-lead-qualifier-to-crm',
    name: 'Form Lead Qualifier to CRM',
    description: 'Captures leads via n8n form, qualifies them using local LLM, and saves to CRM.',
    risk: 'high',
    supportedIntents: [
      'lead_form',
      'lead_qualification',
      'inbound_sales'
    ],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildFormLeadQualifierToCrm,
    knowledgeCard: {
      id: 'form-lead-qualifier-to-crm',
      name: 'n8n Form -> Ollama Lead Qualification -> CRM',
      intentExamples: ['create lead form', 'contact form with qualification'],
      useWhen: ['quick lead form', 'landing page test', 'customer feedback'],
      avoidWhen: ['very complex form with client-side logic is required'],
      risk: 'high',
      nodes: ['Form Trigger', 'Ollama', 'HTTP Request (CRM)', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Fill out the form and check qualification score in CRM and Telegram alert'],
      commonFailures: ['Invalid JSON format from the qualifying model'],
    }
  },
  {
    id: 'batch-url-research-digest',
    name: 'Batch URL Research Digest',
    description: 'Processes multiple URLs with batching, summarizes each, and sends a daily digest.',
    risk: 'medium',
    supportedIntents: [
      'batch_research',
      'competitor_research',
      'url_research'
    ],
    requiredInputs: ['urls'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildBatchUrlResearchDigest,
    knowledgeCard: {
      id: 'batch-url-research-digest',
      name: 'Batch URL Research with Loop Control',
      intentExamples: ['do research on a list of URLs', 'analyze competition', 'batch research'],
      useWhen: ['processing multiple URLs at once', 'competitor analysis'],
      avoidWhen: ['single URL (use simpler researcher instead)'],
      risk: 'medium',
      nodes: ['Schedule', 'Split in Batches', 'HTTP Request', 'Ollama', 'Aggregate', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Provide 3 URLs and check if the digest arrives after aggregation'],
      commonFailures: ['IP blocking by external servers', 'Too large batch killing Ollama'],
    }
  },
  {
    id: 'agentforge-backlog-prioritizer',
    name: 'AgentForge Backlog Prioritizer',
    description: 'Daily task that prioritizes AgentForge backlog and reports focus areas to Telegram.',
    risk: 'medium',
    supportedIntents: [
      'backlog_prioritization',
      'daily_planning',
      'agent_task_prioritization'
    ],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildAgentForgeBacklogPrioritizer,
    knowledgeCard: {
      id: 'agentforge-backlog-prioritizer',
      name: 'AgentForge Queue Backlog Prioritizer',
      intentExamples: ['prioritize tasks', 'summarize backlog', 'what should I do today'],
      useWhen: ['system has many pending tasks and requires autonomous planning'],
      avoidWhen: ['user wants to manually control each task'],
      risk: 'medium',
      nodes: ['Schedule', 'HTTP Request (Backlog)', 'Ollama (Qwen)', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Add 5 tasks and check if the morning report sorted them logically'],
      commonFailures: ['No access to backlog API'],
    }
  },
  {
    id: 'execute-subworkflow-llm-json-normalizer',
    name: 'Reusable LLM JSON Normalizer Sub-workflow',
    description: 'Abstract pattern for centralizing LLM JSON validation logic into a sub-workflow.',
    risk: 'medium',
    supportedIntents: ['json_normalization', 'subworkflow_module'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'execute-subworkflow-llm-json-normalizer',
      name: 'Reusable LLM JSON Normalizer Sub-workflow',
      intentExamples: ['use sub-workflow to parse', 'normalize json via module'],
      useWhen: ['multiple workflows need validated JSON from LLM', 'you want to reduce prompt duplication'],
      avoidWhen: ['workflow is one-off and very simple'],
      risk: 'medium',
      nodes: ['Execute Workflow Trigger', 'Ollama', 'Code parser'],
      credentials: [],
      approvalRequired: false,
      testingStrategy: ['Call sub-workflow with invalid JSON and check if it fixed it'],
      commonFailures: ['Timeout when calling sub-workflow'],
    }
  },
  {
    id: 'llm-json-retry-guard',
    name: 'LLM JSON Retry Guard',
    description: 'Safety pattern that retries and repairs malformed LLM JSON output.',
    risk: 'medium',
    supportedIntents: ['safety_retry', 'json_repair'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'llm-json-retry-guard',
      name: 'LLM JSON Retry Guard',
      intentExamples: ['add retry to llm', 'repair json if broken'],
      useWhen: ['workflow depends on structured data', 'model often returns garbage'],
      avoidWhen: ['output is only for a human as text'],
      risk: 'medium',
      nodes: ['Ollama', 'Code (validator)', 'Ollama (repair)'],
      credentials: [],
      approvalRequired: false,
      testingStrategy: ['Force model to return invalid JSON and check if repair worked'],
      commonFailures: ['Infinite repair loop (requires retry limit)'],
    }
  },
  {
    id: 'cache-before-llm',
    name: 'Cache Before LLM',
    description: 'Optimization pattern that checks for existing results before calling expensive LLMs.',
    risk: 'medium',
    supportedIntents: ['optimization', 'caching'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'cache-before-llm',
      name: 'Cache Before LLM',
      intentExamples: ['add cache to llm', 'do not call llm if you already did'],
      useWhen: ['the same text can be analyzed multiple times', 'you use expensive Gemini'],
      avoidWhen: ['input changes every time'],
      risk: 'medium',
      nodes: ['Code (hash)', 'HTTP Request (Cache check)', 'Ollama/Gemini'],
      credentials: [],
      approvalRequired: false,
      testingStrategy: ['Send the same query twice and check logs (second should be cached)'],
      commonFailures: ['Too wide cache key (collisions)', 'Cache holds stale data'],
    }
  },
  {
    id: 'gemini-escalation-approval',
    name: 'Gemini Escalation Approval',
    description: 'Escalates tasks to cloud Gemini models only when necessary and approved.',
    risk: 'high',
    supportedIntents: ['escalation', 'high_precision'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: true,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'gemini-escalation-approval',
      name: 'Gemini Escalation Approval',
      intentExamples: ['use gemini instead of ollama', 'escalate to cloud'],
      useWhen: ['local model has low confidence', 'real-time knowledge required'],
      avoidWhen: ['private data must stay local'],
      risk: 'high',
      nodes: ['Condition', 'Request Approval', 'Gemini Gateway'],
      credentials: [],
      approvalRequired: true,
      testingStrategy: ['Try to force escalation and check if requested approval'],
      commonFailures: ['No escalation justification'],
    }
  },
  {
    id: 'workflow-drift-detector',
    name: 'Workflow Drift Detector',
    description: 'Monitors n8n workflows for manual changes compared to AgentForge snapshots.',
    risk: 'high',
    supportedIntents: ['drift_detection', 'audit'],
    requiredInputs: [],
    requiredCredentials: ['n8n_api_key'],
    forbiddenWithoutApproval: false,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'workflow-drift-detector',
      name: 'Workflow Drift Detector',
      intentExamples: ['check if someone edited n8n', 'detect changes in workflow'],
      useWhen: ['AgentForge creates workflow in n8n and you want update audit'],
      avoidWhen: ['n8n is only used manually'],
      risk: 'high',
      nodes: ['Schedule', 'n8n API', 'HTTP Request (Memory)', 'Code (diff)'],
      credentials: ['n8n_api_key'],
      approvalRequired: false,
      testingStrategy: ['Manually change a parameter in n8n and check if drift detector reported it'],
      commonFailures: ['Missing n8n API key'],
    }
  },
  {
    id: 'ai-scraper-to-crm',
    name: 'Universal AI Scraper to CRM',
    description: 'Fetches a URL, cleans HTML, extracts leads with AI and saves to CRM.',
    risk: 'high',
    supportedIntents: ['scraper', 'web_scraping', 'lead_generation', 'monitoring', 'olx', 'rhd'],
    requiredInputs: ['url'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildAiScraperToCrm,
    knowledgeCard: {
      id: 'ai-scraper-to-crm',
      name: 'HTTP Fetch -> HTML Clean -> AI Extraction -> CRM',
      intentExamples: ['scraper monitoring olx', 'download data from rhd registry', 'extract leads from web page'],
      useWhen: ['page has no API', 'smart text extraction is required', 'classified ads monitoring'],
      avoidWhen: ['page has RSS (use RSS Monitor)', 'page has official API'],
      risk: 'high',
      nodes: ['Schedule', 'HTTP Request', 'HTML', 'Ollama', 'Code', 'CRM', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Run manually for a known URL and check if AI extracted the fields'],
      commonFailures: ['Bot blocked by page', 'Too large page (LLM token limit exceeded)'],
    }
  }
];

/**
 * Alias for backwards-compatibility with consumers that use the PATTERN_CATALOG name.
 */
export const PATTERN_CATALOG: AutomationPattern[] = automationPatterns;

export function getPatternById(id: string): AutomationPattern | undefined {
  return automationPatterns.find(p => p.id === id);
}

export function scorePatternMatch(
  pattern: AutomationPattern,
  spec: AutomationSpec
): number {
  const text = [
    spec.name,
    spec.description,
    spec.goal,
    ...(spec.steps ?? []).map(s => `${s.name} ${s.purpose}`)
  ].join(' ').toLowerCase();

  let score = 0;

  // Intent match
  for (const intent of pattern.supportedIntents) {
    if (text.includes(intent.replace(/_/g, ' '))) {
      score += 20;
    }
  }

  // Input match
  for (const input of pattern.requiredInputs) {
    const exists = ((spec.inputs ?? []) as AnyInput[]).some(i =>
      i.name.toLowerCase().includes(input.toLowerCase())
    );

    if (exists) score += 10;
  }

  // Risk match
  if (pattern.risk === spec.riskLevel) {
    score += 5;
  }

  return score;
}

export function selectBestPattern(spec: AutomationSpec): AutomationPattern | null {
  const ranked = automationPatterns
    .filter(pattern => pattern.executable !== false)
    .map(pattern => ({
      pattern,
      score: scorePatternMatch(pattern, spec)
    }))
    .sort((a, b) => b.score - a.score);

  if (ranked[0]?.score > 0) {
    return ranked[0].pattern;
  }

  return null;
}

export function getExecutablePatterns(): AutomationPattern[] {
  return automationPatterns.filter(p => p.executable !== false);
}

export function getAbstractPatterns(): AutomationPattern[] {
  return automationPatterns.filter(p => p.executable === false);
}
