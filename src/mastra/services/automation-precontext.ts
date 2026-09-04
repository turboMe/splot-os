/**
 * Automation-specific passive pre-context.
 *
 * This is intentionally compact and non-authoritative. Current tool results
 * always win over this context, especially runtime and credential checks.
 */

import { getRuntimeTopology } from '../config/runtime-topology.js';
import {
  agentIdFieldFilter,
  AUTOMATION_ARCHITECT_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../config/agent-ids.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { recallKnowledge, type RecallResult } from '../lib/failure-brain.js';
import { tokenEstimate } from './harness-events.js';
import { compactHarnessOutput } from './harness-output-compactor.js';
import { getCredentialFromRegistry } from '../tools/architect/credentials/credential-registry.js';
import { PATTERN_CATALOG } from '../tools/architect/pattern-catalog.js';
import type { AutomationPattern } from '../tools/architect/types.js';

export type AutomationPrecontextInput = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  userPrompt: string;
  maxTokens?: number;
  automationId?: string;
  workflowId?: string;
  patternId?: string;
};

export type AutomationPrecontextResult = {
  markdown: string;
  tokenEstimate: number;
  runtimeIncluded: boolean;
  healthIncluded: boolean;
  credentialCount: number;
  patternCount: number;
  failureCaseCount: number;
  activeAutomationIncluded: boolean;
  pendingUpdateCount: number;
  suppressedReasons: string[];
  artifactId?: string;
};

type RuntimeHealthSummary = {
  toolId: string;
  status?: string;
  createdAt?: Date;
  outputPreview?: string;
};

type AutomationStateSummary = {
  automationId?: string;
  workflowId?: string;
  name?: string;
  status?: string;
  riskVerdict?: string;
  riskScore?: number;
  lastTestStatus?: string;
  repairAttempts?: number;
  updatedAt?: Date;
};

type PendingAutomationUpdate = {
  id: string;
  source: string;
  urgent: boolean;
  createdAt?: Date;
  content: string;
  metadata?: Record<string, unknown>;
};

const DEFAULT_MAX_TOKENS = 1800;
const CREDENTIAL_SERVICES = ['telegram', 'mongo', 'gmail', 'httpHeaderAuth'] as const;

export async function buildAutomationPrecontext(
  input: AutomationPrecontextInput,
): Promise<AutomationPrecontextResult> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const suppressedReasons: string[] = [];
  const identifiers = extractAutomationIdentifiers(input);

  const [health, failureCases, automationState, pendingUpdates] = await Promise.all([
    tryLatestRuntimeHealth(suppressedReasons),
    tryFailureCases(input.userPrompt, suppressedReasons),
    tryActiveAutomationState(identifiers, suppressedReasons),
    tryPendingAutomationUpdates({ ...input, ...identifiers }, suppressedReasons),
  ]);

  const topology = getRuntimeTopology();
  const credentials = CREDENTIAL_SERVICES.map((service) => {
    const credential = getCredentialFromRegistry(service);
    return {
      service,
      status: credential ? 'configured' : 'missing',
      name: credential?.name,
      n8nCredentialType: credential?.n8nCredentialType,
    };
  });
  const patterns = selectPatternCandidates(input.userPrompt, input.patternId, 5);
  const abstractMatches = selectPatternCandidates(input.userPrompt, input.patternId, 5, true)
    .filter((entry) => entry.pattern.executable === false);

  const sections: string[] = [];
  sections.push('### Runtime Topology');
  sections.push([
    `mode: ${topology.mode}`,
    `mastraStudioUrl: ${topology.mastraStudioUrl}`,
    `mastraApiUrlForN8n: ${topology.mastraApiUrlForN8n}`,
    `n8nRestBaseUrl: ${topology.n8nRestBaseUrl}`,
    `n8nPublicWebhookBaseUrl: ${topology.n8nPublicWebhookBaseUrl ?? '(not configured)'}`,
    `ollamaBaseUrlForN8n: ${topology.ollamaBaseUrlForN8n}`,
    `mongoHostForN8n: ${topology.mongoHostForN8n}`,
    `mongoDbName: ${topology.mongoDbName}`,
  ].join('\n'));
  sections.push('');

  sections.push('### n8n Runtime Health');
  if (health) {
    sections.push([
      `lastKnownTool: ${health.toolId}`,
      `lastKnownStatus: ${health.status ?? 'unknown'}`,
      health.createdAt ? `checkedAt: ${health.createdAt.toISOString()}` : '',
      health.outputPreview ? `preview: ${truncateLine(health.outputPreview, 500)}` : '',
    ].filter(Boolean).join('\n'));
  } else {
    sections.push('No recent health result found. Refresh with architect_runtime_check before deploy/test decisions.');
  }
  sections.push('');

  sections.push('### Credential Registry');
  sections.push(credentials
    .map((entry) => [
      `- ${entry.service}: ${entry.status}`,
      entry.name ? `name="${entry.name}"` : '',
      entry.n8nCredentialType ? `type=${entry.n8nCredentialType}` : '',
    ].filter(Boolean).join(' '))
    .join('\n'));
  sections.push('Credential status here is a summary only. Resolver/validator still has authority before deploy.');
  sections.push('');

  sections.push('### Pattern Candidates');
  if (patterns.length > 0) {
    sections.push(patterns.map(({ pattern, score }) =>
      `- ${pattern.id}: ${pattern.name} score=${score.toFixed(2)} executable=${pattern.executable !== false} risk=${pattern.risk} maturity=${pattern.maturity ?? 'tested'}`,
    ).join('\n'));
  } else {
    sections.push('No strong local pattern candidates found from lexical pre-scan. Use architect_match_pattern for semantic matching.');
  }
  if (abstractMatches.length > 0) {
    sections.push(`Abstract pattern matches exist (${abstractMatches.length}); use them only as reasoning context, not compose/deploy inputs.`);
  }
  sections.push('');

  sections.push('### Known Failure Cases');
  if (failureCases.length > 0) {
    sections.push(formatFailureCases(failureCases));
  } else {
    sections.push('No similar failure_case was found in system_knowledge.');
  }
  sections.push('');

  if (automationState) {
    sections.push('### Active Automation State');
    sections.push([
      automationState.automationId ? `automationId: ${automationState.automationId}` : '',
      automationState.workflowId ? `workflowId: ${automationState.workflowId}` : '',
      automationState.name ? `name: ${automationState.name}` : '',
      automationState.status ? `status: ${automationState.status}` : '',
      automationState.riskVerdict ? `riskVerdict: ${automationState.riskVerdict}` : '',
      automationState.riskScore !== undefined ? `riskScore: ${automationState.riskScore}` : '',
      automationState.lastTestStatus ? `lastTest: ${automationState.lastTestStatus}` : '',
      automationState.repairAttempts !== undefined ? `repairAttempts: ${automationState.repairAttempts}` : '',
      automationState.updatedAt ? `updatedAt: ${automationState.updatedAt.toISOString()}` : '',
    ].filter(Boolean).join('\n'));
    sections.push('');
  }

  sections.push('### Pending Automation Updates');
  if (pendingUpdates.length > 0) {
    sections.push(pendingUpdates.map((update) =>
      `- ${update.id} source=${update.source} urgent=${update.urgent}: ${truncateLine(update.content, 300)}`,
    ).join('\n'));
  } else {
    sections.push('No pending automation job/delegation updates found for this thread or automation id.');
  }
  sections.push('');

  sections.push('Use this passive context only as orientation. Current tool results, approval checks, runtime_check, credential resolver and validator have priority.');

  const rawMarkdown = [
    '## Automation Passive Context',
    '',
    sections.join('\n'),
  ].join('\n');
  const safeMarkdown = redactSecrets(rawMarkdown).text;
  const compacted = await compactHarnessOutput({
    text: safeMarkdown,
    kind: 'memory_context',
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    threadId: input.threadId,
    agentId: canonicalizeRuntimeAgentId(input.agentId) ?? AUTOMATION_ARCHITECT_AGENT_ID,
    toolId: 'automation_precontext',
    previewBytes: Math.max(1600, maxTokens * 4),
    metadata: { scope: 'automation_precontext' },
  });
  const markdown = compacted.preview;

  return {
    markdown,
    tokenEstimate: tokenEstimate(markdown),
    runtimeIncluded: true,
    healthIncluded: Boolean(health),
    credentialCount: credentials.length,
    patternCount: patterns.length,
    failureCaseCount: failureCases.length,
    activeAutomationIncluded: Boolean(automationState),
    pendingUpdateCount: pendingUpdates.length,
    suppressedReasons,
    artifactId: compacted.fullTextArtifactId,
  };
}

async function tryLatestRuntimeHealth(
  suppressedReasons: string[],
): Promise<RuntimeHealthSummary | null> {
  try {
    const db = await getDb();
    const doc = await db.collection('tool_executions')
      .find({
        toolId: { $in: ['architect_runtime_check', 'n8n_health'] },
        status: { $in: ['completed', 'failed', 'blocked'] },
      })
      .sort({ createdAt: -1 })
      .limit(1)
      .next() as RuntimeHealthSummary | null;
    return doc;
  } catch (error) {
    suppressedReasons.push(`runtime_health_unavailable:${(error as Error).message}`);
    return null;
  }
}

async function tryFailureCases(
  query: string,
  suppressedReasons: string[],
): Promise<RecallResult[]> {
  try {
    return await withTimeout(
      recallKnowledge(query, { type: 'failure_case', topK: 5, minScore: 0.30 }),
      1500,
      'failure_case_recall_timeout',
    );
  } catch (error) {
    suppressedReasons.push(`failure_cases_unavailable:${(error as Error).message}`);
    return [];
  }
}

async function tryActiveAutomationState(
  input: { automationId?: string; workflowId?: string },
  suppressedReasons: string[],
): Promise<AutomationStateSummary | null> {
  if (!input.automationId && !input.workflowId) return null;

  try {
    const db = await getDb();
    const doc = await db.collection('automation_requests').findOne(
      input.automationId
        ? { automationId: input.automationId }
        : { n8nWorkflowId: input.workflowId },
    ) as any;
    if (!doc) return null;

    return {
      automationId: doc.automationId,
      workflowId: doc.n8nWorkflowId,
      name: doc.name,
      status: doc.status,
      riskVerdict: doc.riskVerdict,
      riskScore: doc.riskScore,
      lastTestStatus: doc.lastTest?.status,
      repairAttempts: doc.repairAttempts,
      updatedAt: toDate(doc.updatedAt),
    };
  } catch (error) {
    suppressedReasons.push(`automation_state_unavailable:${(error as Error).message}`);
    return null;
  }
}

async function tryPendingAutomationUpdates(
  input: { threadId?: string },
  suppressedReasons: string[],
): Promise<PendingAutomationUpdate[]> {
  const threadId = input.threadId?.trim();
  if (!threadId) return [];

  try {
    const db = await getDb();
    return await db.collection('pending_user_messages')
      .find({
        status: 'pending',
        source: { $in: ['background_task', 'automation_job'] },
        threadId,
        targetAgentId: agentIdFieldFilter(AUTOMATION_ARCHITECT_AGENT_ID),
        expiresAt: { $type: 'date' },
        $expr: { $gt: ['$expiresAt', '$$NOW'] },
      })
      .sort({ urgent: -1, createdAt: 1 })
      .limit(5)
      .toArray() as unknown as PendingAutomationUpdate[];
  } catch {
    suppressedReasons.push('pending_updates_unavailable');
    return [];
  }
}

function selectPatternCandidates(
  prompt: string,
  preferredPatternId?: string,
  limit = 5,
  includeAbstract = false,
): Array<{ pattern: AutomationPattern; score: number }> {
  const queryTokens = tokenize(prompt);
  return PATTERN_CATALOG
    .filter((pattern) => includeAbstract || pattern.executable !== false)
    .map((pattern) => ({ pattern, score: scorePattern(pattern, queryTokens, preferredPatternId) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function scorePattern(
  pattern: AutomationPattern,
  queryTokens: Set<string>,
  preferredPatternId?: string,
): number {
  let score = preferredPatternId && pattern.id === preferredPatternId ? 4 : 0;
  const text = [
    pattern.id,
    pattern.name,
    pattern.description,
    pattern.supportedIntents.join(' '),
    pattern.requiredInputs.join(' '),
    pattern.requiredCredentials.join(' '),
  ].join(' ');
  for (const token of tokenize(text)) {
    if (queryTokens.has(token)) score += 1;
  }
  if (pattern.executable !== false) score += 0.25;
  if (pattern.maturity === 'production') score += 0.5;
  return score;
}

function formatFailureCases(items: RecallResult[]): string {
  return items.map((item) => [
    `- ${item.title} score=${item.score.toFixed(2)} confidence=${item.confidence}`,
    `  ${truncateLine(item.content, 360)}`,
  ].join('\n')).join('\n');
}

function extractAutomationIdentifiers(input: AutomationPrecontextInput): {
  automationId?: string;
  workflowId?: string;
} {
  const automationId = input.automationId
    ?? matchFirst(input.userPrompt, /\bautomationId[:=\s]+([A-Za-z0-9_-]{6,})\b/i);
  const workflowId = input.workflowId
    ?? matchFirst(input.userPrompt, /\bworkflowId[:=\s]+([A-Za-z0-9_-]{4,})\b/i);
  return { automationId, workflowId };
}

function matchFirst(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1];
}

function tokenize(text: string): Set<string> {
  const stop = new Set(['the', 'and', 'or', 'for', 'with', 'from', 'this', 'that', 'into', 'workflow', 'automation']);
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !stop.has(token)),
  );
}

function truncateLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}...` : oneLine;
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
