import { randomUUID } from 'crypto';

import { CODING_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { logHarnessEvent } from './harness-events.js';
import { compactHarnessOutput } from './harness-output-compactor.js';
import { getHarnessExecutionContext } from './harness-execution-context.js';
import { evaluateAndLogHarnessPolicy } from './harness-policy.js';
import type { HarnessPolicyDecision, HarnessPolicyRequest } from './harness-policy.js';
import { getEffectiveProfile } from './depth-controller.js';

export type ToolEnvelopeCategory =
  | 'file'
  | 'shell'
  | 'memory'
  | 'search'
  | 'git'
  | 'approval'
  | 'network'
  | 'other';

export type ToolEnvelopeRisk = 'low' | 'medium' | 'high';
export type ToolExecutionStatus = 'started' | 'completed' | 'failed' | 'blocked';

export type ToolEnvelopeMetadata = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  runId?: string;
  turnId?: string;
};

export type ToolExecutionDoc = ToolEnvelopeMetadata & {
  id: string;
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  status: ToolExecutionStatus;
  policyDecision?: ToolExecutionPolicySummary | ToolExecutionPolicySummary[];
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
  durationMs?: number;
  errorClass?: string;
  errorMessage?: string;
  fileActivityIds?: string[];
  createdAt: Date;
  completedAt?: Date;
  expiresAt: Date;
};

export type ToolExecutionPolicySummary = Pick<
  HarnessPolicyDecision,
  | 'id'
  | 'allow'
  | 'effectiveAllow'
  | 'requiresApproval'
  | 'severity'
  | 'reason'
  | 'approvalType'
  | 'matchedRule'
  | 'enforcementMode'
  | 'enforced'
>;

type ToolEnvelopeConfig<TInput, TOutput> = {
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  defaultAgentId?: string;
  redactInputFields?: string[];
  redactOutputFields?: string[];
  inputPreviewMaxChars?: number;
  outputPreviewMaxChars?: number;
  metadata?: (input: TInput) => ToolEnvelopeMetadata;
  /**
   * Last chance to correct the model's arguments before ANYTHING reads them.
   *
   * Runs ahead of the policy evaluation, the telemetry preview and the tool body,
   * so all three see one version of the truth. That ordering is the whole point:
   * the coding tools take a `taskId` that decides which worktree gets written,
   * and resolving it inside `execute` alone would leave the policy scoping its
   * path check against whatever the model happened to type.
   */
  normalizeInput?: (input: TInput) => TInput;
  modelOutput?: (
    output: TOutput,
    input: TInput,
    metadata: ToolEnvelopeMetadata & { agentId: string; runId?: string; toolId: string },
  ) => TOutput | Promise<TOutput>;
  policy?: (
    input: TInput,
    metadata: ToolEnvelopeMetadata & { agentId: string; runId?: string },
  ) =>
    | HarnessPolicyRequest
    | HarnessPolicyRequest[]
    | undefined
    | Promise<HarnessPolicyRequest | HarnessPolicyRequest[] | undefined>;
  execute: (
    input: TInput,
    metadata?: ToolEnvelopeMetadata & { agentId: string; runId?: string; toolId: string },
  ) => Promise<TOutput>;
};

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_PREVIEW_CHARS = 1000;

export function withToolEnvelope<TInput, TOutput>(
  config: ToolEnvelopeConfig<TInput, TOutput>,
): (input: TInput) => Promise<TOutput> {
  return async (rawInput: TInput): Promise<TOutput> => {
    // Before the flag check too: a normalizer corrects an authority field, and
    // that correction cannot be something the envelope flag switches off.
    const input = config.normalizeInput ? config.normalizeInput(rawInput) : rawInput;

    if (!isHarnessFeatureEnabled('FEATURE_TOOL_ENVELOPE', true)) {
      return config.execute(input, {
        agentId: canonicalizeRuntimeAgentId(config.defaultAgentId) ?? CODING_AGENT_ID,
        toolId: config.toolId,
      });
    }

    const startedAt = Date.now();
    const executionId = randomUUID();
    const activeHarnessContext = getHarnessExecutionContext() ?? {};
    const metadata = {
      ...activeHarnessContext,
      ...extractToolMetadata(input),
      ...(config.metadata?.(input) ?? {}),
    };
    const agentId = canonicalizeRuntimeAgentId(metadata.agentId ?? config.defaultAgentId) ?? CODING_AGENT_ID;
    const runId = metadata.runId ?? metadata.taskId;
    const inputPreview = buildToolPreview(input, {
      redactFields: config.redactInputFields,
      maxChars: config.inputPreviewMaxChars ?? DEFAULT_PREVIEW_CHARS,
    });
    const policyDecision = await evaluateToolPolicy(config, input, { ...metadata, agentId, runId });

    await recordToolStarted({
      id: executionId,
      metadata: { ...metadata, agentId, runId },
      toolId: config.toolId,
      category: config.category,
      risk: config.risk,
      policyDecision,
      inputPreview,
    });

    try {
      const depthApprovalBlockReason = getDepthApprovalBlockReason(config, policyDecision, runId, agentId);
      if (depthApprovalBlockReason) {
        throw new Error(depthApprovalBlockReason);
      }

      if (hasEnforcedPolicyBlock(policyDecision)) {
        const blocked = firstBlockedPolicyDecision(policyDecision);
        throw new Error(blocked?.reason ?? `Policy blocked tool execution: ${config.toolId}`);
      }

      const output = await config.execute(input, {
        ...metadata,
        agentId,
        runId,
        toolId: config.toolId,
      });
      const durationMs = Date.now() - startedAt;
      const outputCompaction = await compactToolOutput(output, config, {
        ...metadata,
        agentId,
        runId,
        toolId: config.toolId,
      });
      const outputPreview = outputCompaction.preview;
      const outputArtifactId = extractOutputArtifactId(output) ?? outputCompaction.outputArtifactId;
      const success = isSuccessfulToolOutput(output);
      const errorMessage = success ? undefined : extractOutputErrorMessage(output);
      const errorClass = success ? undefined : classifyToolError({
        category: config.category,
        output,
        errorMessage,
      });
      const status: ToolExecutionStatus = success
        ? 'completed'
        : errorClass === 'policy_blocked' || errorClass === 'approval_required'
          ? 'blocked'
          : 'failed';

      await recordToolFinished({
        id: executionId,
        metadata: { ...metadata, agentId, runId },
        toolId: config.toolId,
        category: config.category,
        risk: config.risk,
        status,
        policyDecision,
        inputPreview,
        outputPreview,
        outputArtifactId,
        durationMs,
        errorClass,
        errorMessage,
      });

      return await buildModelOutput(config, output, input, {
        ...metadata,
        agentId,
        runId,
        toolId: config.toolId,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const err = error as Error;
      const policyBlocked = hasEnforcedPolicyBlock(policyDecision);
      const errorClass = policyBlocked ? 'policy_blocked' : classifyThrownToolError(err);

      await recordToolFinished({
        id: executionId,
        metadata: { ...metadata, agentId, runId },
        toolId: config.toolId,
        category: config.category,
        risk: config.risk,
        status: policyBlocked || errorClass === 'approval_required' ? 'blocked' : 'failed',
        policyDecision,
        inputPreview,
        durationMs,
        errorClass,
        errorMessage: err.message,
      });

      throw error;
    }
  };
}

async function evaluateToolPolicy<TInput, TOutput>(
  config: ToolEnvelopeConfig<TInput, TOutput>,
  input: TInput,
  metadata: ToolEnvelopeMetadata & { agentId: string; runId?: string },
): Promise<ToolExecutionPolicySummary | ToolExecutionPolicySummary[] | undefined> {
  if (!config.policy) return undefined;

  const requestOrRequests = await config.policy(input, metadata);
  if (!requestOrRequests) return undefined;

  const requests = Array.isArray(requestOrRequests) ? requestOrRequests : [requestOrRequests];
  const decisions = await Promise.all(
    requests.map((request) =>
      evaluateAndLogHarnessPolicy({
        ...request,
        agentId: request.agentId ?? metadata.agentId,
        runId: request.runId ?? metadata.runId,
        turnId: request.turnId ?? metadata.turnId,
        threadId: request.threadId ?? metadata.threadId,
        taskId: request.taskId ?? metadata.taskId,
        subtaskId: request.subtaskId ?? metadata.subtaskId,
        toolId: request.toolId ?? config.toolId,
        riskHint: request.riskHint ?? config.risk,
      }),
    ),
  );

  const summaries = decisions.map(toPolicySummary);
  return summaries.length === 1 ? summaries[0] : summaries;
}

function toPolicySummary(decision: HarnessPolicyDecision): ToolExecutionPolicySummary {
  return {
    id: decision.id,
    allow: decision.allow,
    effectiveAllow: decision.effectiveAllow,
    requiresApproval: decision.requiresApproval,
    severity: decision.severity,
    reason: decision.reason,
    approvalType: decision.approvalType,
    matchedRule: decision.matchedRule,
    enforcementMode: decision.enforcementMode,
    enforced: decision.enforced,
  };
}

function hasEnforcedPolicyBlock(
  decision: ToolExecutionPolicySummary | ToolExecutionPolicySummary[] | undefined,
): boolean {
  return Boolean(firstBlockedPolicyDecision(decision));
}

function firstBlockedPolicyDecision(
  decision: ToolExecutionPolicySummary | ToolExecutionPolicySummary[] | undefined,
): ToolExecutionPolicySummary | undefined {
  if (!decision) return undefined;
  const decisions = Array.isArray(decision) ? decision : [decision];
  return decisions.find((entry) => !entry.effectiveAllow);
}

function getDepthApprovalBlockReason<TInput, TOutput>(
  config: ToolEnvelopeConfig<TInput, TOutput>,
  decision: ToolExecutionPolicySummary | ToolExecutionPolicySummary[] | undefined,
  runId?: string,
  agentId?: string,
): string | undefined {
  if (!runId) return undefined;
  const profile = getEffectiveProfile(runId, agentId);
  if (!profile.requireApproval) return undefined;
  if (config.category === 'approval') return undefined;

  const decisions = decision
    ? Array.isArray(decision) ? decision : [decision]
    : [];
  const policyRequiresApproval = decisions.some((entry) => entry.requiresApproval);
  const highRiskTool = config.risk === 'high';
  if (!policyRequiresApproval && !highRiskTool) return undefined;

  return [
    `Depth profile "${profile.level}" requires explicit approval before high-risk tool execution.`,
    `Blocked tool: ${config.toolId}.`,
    `Approval reason: ${policyRequiresApproval ? 'policy requires approval' : 'tool risk is high'}.`,
  ].join(' ');
}

export function buildToolPreview(
  value: unknown,
  options: { redactFields?: string[]; maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_PREVIEW_CHARS;
  const serialized = stringifyToolValue(value, options.redactFields, {
    maxStringChars: 4000,
    maxArrayItems: 25,
    maxDepth: 6,
  });

  const safeText = redactSecrets(serialized).text;
  return truncate(safeText, maxChars);
}

async function compactToolOutput<TInput, TOutput>(
  output: TOutput,
  config: ToolEnvelopeConfig<TInput, TOutput>,
  metadata: ToolEnvelopeMetadata & { agentId: string; runId?: string; toolId: string },
): Promise<{ preview: string; outputArtifactId?: string }> {
  const text = redactSecrets(
    stringifyToolValue(output, config.redactOutputFields ?? config.redactInputFields, {
      maxStringChars: 50_000,
      maxArrayItems: 1000,
      maxDepth: 10,
    }),
  ).text;

  const compaction = await compactHarnessOutput({
    text,
    kind: 'tool_output',
    taskId: metadata.taskId,
    subtaskId: metadata.subtaskId,
    agentId: metadata.agentId,
    threadId: metadata.threadId,
    runId: metadata.runId,
    turnId: metadata.turnId,
    toolId: metadata.toolId,
    previewBytes: config.outputPreviewMaxChars ?? DEFAULT_PREVIEW_CHARS,
    metadata: {
      category: config.category,
      risk: config.risk,
    },
  });

  return {
    preview: compaction.preview,
    outputArtifactId: compaction.fullTextArtifactId,
  };
}

async function buildModelOutput<TInput, TOutput>(
  config: ToolEnvelopeConfig<TInput, TOutput>,
  output: TOutput,
  input: TInput,
  metadata: ToolEnvelopeMetadata & { agentId: string; runId?: string; toolId: string },
): Promise<TOutput> {
  if (!config.modelOutput) return output;

  try {
    return await config.modelOutput(output, input, metadata);
  } catch (error) {
    console.warn(
      `[ToolEnvelope] modelOutput compaction failed for ${config.toolId}:`,
      (error as Error).message,
    );
    return output;
  }
}

export function classifyToolError(input: {
  category: ToolEnvelopeCategory;
  output?: unknown;
  errorMessage?: string;
}): string {
  const structuredClass = classifyStructuredToolOutput(input.output);
  if (structuredClass) return structuredClass;

  const text = [
    input.errorMessage,
    extractOutputText(input.output),
  ].filter(Boolean).join('\n').toLowerCase();

  if (isWorkflowValidationText(text)) return 'workflow_validation';
  if (isToolInputContractText(text)) return 'tool_input_contract';
  if (isRuntimePreflightText(text)) return 'runtime_preflight';
  if (isRiskBlockedText(text)) return 'risk_blocked';
  if (/approval/.test(text)) return 'approval_required';
  if (isPolicyBlockedText(text)) return 'policy_blocked';
  if (/timeout|timed out|etimedout/.test(text)) return 'timeout';
  if (/validation|invalid|required|wymagan/.test(text)) return 'workflow_validation';
  if (input.category === 'shell' && hasNonZeroExitCode(input.output)) return 'command_failed';
  if (/exit code|test zwrocil bledy|command failed|failed/.test(text)) return 'command_failed';
  if (/conflict|konflikt/.test(text)) return 'file_conflict';
  return 'unknown';
}

function classifyThrownToolError(error: Error): string {
  const message = error.message.toLowerCase();
  if (isWorkflowValidationText(message)) return 'workflow_validation';
  if (isToolInputContractText(message)) return 'tool_input_contract';
  if (isRuntimePreflightText(message)) return 'runtime_preflight';
  if (isRiskBlockedText(message)) return 'risk_blocked';
  if (/approval/.test(message)) return 'approval_required';
  if (isPolicyBlockedText(message)) return 'policy_blocked';
  if (/timeout|timed out|etimedout/.test(message)) return 'timeout';
  if (/validation|invalid|required|wymagan/.test(message)) return 'workflow_validation';
  if (/conflict|konflikt/.test(message)) return 'file_conflict';
  return error.name || 'unknown';
}

function classifyStructuredToolOutput(output: unknown): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const record = output as Record<string, any>;
  const explicitFailureClass = stringValue(record.failureClass);
  if (explicitFailureClass) return explicitFailureClass;

  const validation = record.validation;
  if (validation && typeof validation === 'object') {
    const errors = Array.isArray(validation.errors) ? validation.errors : [];
    const securityIssues = Array.isArray(validation.securityIssues) ? validation.securityIssues : [];
    if (securityIssues.length > 0) return 'security_validation';
    if (errors.length > 0) return 'workflow_validation';
  }

  const risk = record.risk;
  if (risk && typeof risk === 'object' && stringValue(risk.verdict) === 'block') {
    return 'risk_blocked';
  }
  if (risk && typeof risk === 'object' && stringValue(risk.verdict) === 'review') {
    return 'approval_required';
  }

  if (Array.isArray(record.missingConfig) && record.missingConfig.length > 0) {
    return 'runtime_preflight';
  }

  const failedStep = Array.isArray(record.steps)
    ? [...record.steps].reverse().find((step) => step?.status === 'failed' || step?.status === 'blocked')
    : undefined;
  const failedStepName = stringValue(failedStep?.name);
  const failedStepMessage = stringValue(failedStep?.message);
  const stepText = [failedStepName, failedStepMessage].filter(Boolean).join('\n').toLowerCase();
  if (failedStepName === 'runtime_check' || isRuntimePreflightText(stepText)) return 'runtime_preflight';
  if (failedStepName === 'risk_score' || isRiskBlockedText(stepText)) return 'risk_blocked';
  if (failedStepName?.startsWith('validate_') || isWorkflowValidationText(stepText)) return 'workflow_validation';

  const text = extractOutputText(output)?.toLowerCase() ?? '';
  if (isWorkflowValidationText(text)) return 'workflow_validation';
  if (isToolInputContractText(text)) return 'tool_input_contract';
  if (isRuntimePreflightText(text)) return 'runtime_preflight';
  if (isRiskBlockedText(text)) return 'risk_blocked';
  if (/approval/.test(text)) return 'approval_required';
  if (isPolicyBlockedText(text)) return 'policy_blocked';
  return undefined;
}

function isWorkflowValidationText(text: string): boolean {
  return /workflow validation|draft validation|activation validation|validate_workflow|validation blocked deploy|mock test failed/.test(text);
}

function isToolInputContractText(text: string): boolean {
  return /object is required|is required for mode=|missing required|input contract|invalid input|schema validation|invalid_arguments|invalid arguments/.test(text);
}

function isRuntimePreflightText(text: string): boolean {
  return /runtime check|runtime checks|runtime requirements|runtime preflight|n8n is not reachable|mongodb is not reachable|ollama is not reachable|public webhook/.test(text);
}

function isRiskBlockedText(text: string): boolean {
  return /risk score|risk verdict|risk block|blocked by risk|deploy blocked by risk/.test(text);
}

function isPolicyBlockedText(text: string): boolean {
  return /policy|allowlist|approval required|not allowed|disallowed|forbidden by policy|policy blocked/.test(text);
}

/**
 * Identity fields the CALLER put in the tool arguments — absent keys omitted.
 *
 * This used to return every key unconditionally, so a tool invoked without an
 * explicit `agentId` produced `{ agentId: undefined }`, and spreading that OVER
 * the harness context erased the real one. The fallback chain then landed on
 * `CODING_AGENT_ID`, so telemetry recorded a `codeReviewAgent` reading a diff as
 * `codingAgent` doing it — measured on the review canary, where every one of the
 * reviewer's calls was filed under the author.
 *
 * Nothing failed, which is what makes it expensive: it makes the record of WHO
 * DID WHAT wrong, and every later diagnosis reads that record.
 */
function extractToolMetadata(input: unknown): ToolEnvelopeMetadata {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  const metadata: ToolEnvelopeMetadata = {};
  const taskId = stringValue(record.taskId);
  const subtaskId = stringValue(record.subtaskId);
  const agentId = stringValue(record.agentId);
  const threadId = stringValue(record.threadId);
  const runId = stringValue(record.runId);
  const turnId = stringValue(record.turnId);
  if (taskId !== undefined) metadata.taskId = taskId;
  if (subtaskId !== undefined) metadata.subtaskId = subtaskId;
  if (agentId !== undefined) metadata.agentId = agentId;
  if (threadId !== undefined) metadata.threadId = threadId;
  if (runId !== undefined) metadata.runId = runId;
  if (turnId !== undefined) metadata.turnId = turnId;
  return metadata;
}

function stringifyToolValue(
  value: unknown,
  redactFields: string[] | undefined,
  limits: { maxStringChars: number; maxArrayItems: number; maxDepth: number },
): string {
  const redactedFieldSet = new Set((redactFields ?? []).map((field) => field.toLowerCase()));
  try {
    return typeof value === 'string'
      ? value
      : JSON.stringify(redactStructuredValue(value, redactedFieldSet, limits));
  } catch {
    return String(value);
  }
}

function redactStructuredValue(
  value: unknown,
  redactedFields: Set<string>,
  limits: { maxStringChars: number; maxArrayItems: number; maxDepth: number },
  depth = 0,
): unknown {
  if (depth > limits.maxDepth) return '[Max depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value, limits.maxStringChars);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, limits.maxArrayItems)
      .map((entry) => redactStructuredValue(entry, redactedFields, limits, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (redactedFields.has(key.toLowerCase())) {
      out[key] = typeof entry === 'string'
        ? `[redacted:${entry.length} chars]`
        : '[redacted]';
    } else {
      out[key] = redactStructuredValue(entry, redactedFields, limits, depth + 1);
    }
  }
  return out;
}

function isSuccessfulToolOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object') return true;
  const success = (output as Record<string, unknown>).success;
  return success !== false;
}

function extractOutputErrorMessage(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const record = output as Record<string, unknown>;
  return stringValue(record.error) ?? stringValue(record.message);
}

function extractOutputText(output: unknown): string | undefined {
  if (!output) return undefined;
  if (typeof output === 'string') return output;
  if (typeof output !== 'object') return String(output);
  const record = output as Record<string, unknown>;
  return [
    stringValue(record.error),
    stringValue(record.message),
    stringValue(record.output),
  ].filter(Boolean).join('\n');
}

function hasNonZeroExitCode(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const exitCode = (output as Record<string, unknown>).exitCode;
  return typeof exitCode === 'number' && exitCode !== 0;
}

function extractOutputArtifactId(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const record = output as Record<string, unknown>;
  return stringValue(record.outputArtifactId) ?? stringValue(record.fullTextArtifactId);
}

async function recordToolStarted(input: {
  id: string;
  metadata: ToolEnvelopeMetadata & { agentId: string };
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  policyDecision?: ToolExecutionPolicySummary | ToolExecutionPolicySummary[];
  inputPreview?: string;
}): Promise<void> {
  const now = new Date();
  const doc: ToolExecutionDoc = {
    id: input.id,
    ...input.metadata,
    toolId: input.toolId,
    category: input.category,
    risk: input.risk,
    status: 'started',
    policyDecision: input.policyDecision,
    inputPreview: input.inputPreview,
    createdAt: now,
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
  };

  await insertToolExecution(doc);
  await logHarnessEvent({
    type: 'tool_call_started',
    agentId: input.metadata.agentId,
    runId: input.metadata.runId,
    turnId: input.metadata.turnId,
    threadId: input.metadata.threadId,
    taskId: input.metadata.taskId,
    subtaskId: input.metadata.subtaskId,
    feature: 'tool_envelope',
    toolId: input.toolId,
    status: 'pending',
    input: input.inputPreview,
    data: {
      executionId: input.id,
      category: input.category,
      risk: input.risk,
      policyDecision: input.policyDecision,
    },
  });
}

async function recordToolFinished(input: {
  id: string;
  metadata: ToolEnvelopeMetadata & { agentId: string };
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  status: ToolExecutionStatus;
  policyDecision?: ToolExecutionPolicySummary | ToolExecutionPolicySummary[];
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
  durationMs: number;
  errorClass?: string;
  errorMessage?: string;
}): Promise<void> {
  const completedAt = new Date();
  await updateToolExecution({
    id: input.id,
    metadata: input.metadata,
    toolId: input.toolId,
    category: input.category,
    risk: input.risk,
    status: input.status,
    policyDecision: input.policyDecision,
    inputPreview: input.inputPreview,
    outputPreview: input.outputPreview,
    outputArtifactId: input.outputArtifactId,
    durationMs: input.durationMs,
    errorClass: input.errorClass,
    errorMessage: input.errorMessage,
    completedAt,
  });

  await logHarnessEvent({
    type: input.status === 'completed' ? 'tool_call_completed' : 'tool_call_failed',
    agentId: input.metadata.agentId,
    runId: input.metadata.runId,
    turnId: input.metadata.turnId,
    threadId: input.metadata.threadId,
    taskId: input.metadata.taskId,
    subtaskId: input.metadata.subtaskId,
    feature: 'tool_envelope',
    toolId: input.toolId,
    status: input.status === 'completed' ? 'success' : 'error',
    output: input.outputPreview,
    errorMessage: input.errorMessage,
    durationMs: input.durationMs,
    data: {
      executionId: input.id,
      category: input.category,
      risk: input.risk,
      toolStatus: input.status,
      policyDecision: input.policyDecision,
      errorClass: input.errorClass,
      outputArtifactId: input.outputArtifactId,
    },
  });
}

async function insertToolExecution(doc: ToolExecutionDoc): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<ToolExecutionDoc>('tool_executions').insertOne(doc);
  } catch (error) {
    console.warn('[ToolEnvelope] Failed to insert tool execution:', (error as Error).message);
  }
}

async function updateToolExecution(input: {
  id: string;
  metadata: ToolEnvelopeMetadata & { agentId: string };
  toolId: string;
  category: ToolEnvelopeCategory;
  risk: ToolEnvelopeRisk;
  status: ToolExecutionStatus;
  policyDecision?: ToolExecutionPolicySummary | ToolExecutionPolicySummary[];
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
  durationMs: number;
  errorClass?: string;
  errorMessage?: string;
  completedAt: Date;
}): Promise<void> {
  try {
    const db = await getDb();
    const set: Partial<ToolExecutionDoc> = {
      status: input.status,
      policyDecision: input.policyDecision,
      outputPreview: input.outputPreview,
      outputArtifactId: input.outputArtifactId,
      durationMs: input.durationMs,
      errorClass: input.errorClass,
      errorMessage: input.errorMessage,
      completedAt: input.completedAt,
    };

    await db.collection<ToolExecutionDoc>('tool_executions').updateOne(
      { id: input.id },
      {
        $setOnInsert: {
          id: input.id,
          ...input.metadata,
          toolId: input.toolId,
          category: input.category,
          risk: input.risk,
          inputPreview: input.inputPreview,
          createdAt: input.completedAt,
          expiresAt: new Date(input.completedAt.getTime() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
        },
        $set: set,
      },
      { upsert: true },
    );
  } catch (error) {
    console.warn('[ToolEnvelope] Failed to update tool execution:', (error as Error).message);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

// ── Post-hoc workspace tool logging ──────────────────────────────────────
// Workspace tools from @mastra/core bypass withToolEnvelope. This function
// logs them after execution via the onStepFinish hook in coding-harness.

const WORKSPACE_TOOL_META: Record<string, { category: ToolEnvelopeCategory; risk: ToolEnvelopeRisk }> = {
  view: { category: 'file', risk: 'low' },
  write_file: { category: 'file', risk: 'medium' },
  find_files: { category: 'file', risk: 'low' },
  search_content: { category: 'search', risk: 'low' },
  workspace_search: { category: 'search', risk: 'low' },
  index_content: { category: 'search', risk: 'low' },
  lsp_inspect: { category: 'other', risk: 'low' },
  execute_command: { category: 'shell', risk: 'medium' },
  mastra_workspace_read_file: { category: 'file', risk: 'low' },
  mastra_workspace_write_file: { category: 'file', risk: 'medium' },
  mastra_workspace_list_files: { category: 'file', risk: 'low' },
  mastra_workspace_grep: { category: 'search', risk: 'low' },
  mastra_workspace_execute_command: { category: 'shell', risk: 'medium' },
  mastra_workspace_search: { category: 'search', risk: 'low' },
};

type PolicyAction = import('./harness-policy.js').HarnessPolicyAction;

function mapToolToPolicyAction(toolId: string): PolicyAction | undefined {
  if (toolId === 'view' || toolId === 'mastra_workspace_read_file') return 'read_file';
  if (toolId === 'write_file' || toolId === 'mastra_workspace_write_file') return 'write_file';
  if (toolId === 'execute_command' || toolId === 'mastra_workspace_execute_command') return 'run_command';
  return undefined;
}

export function isWorkspaceTool(toolName: string): boolean {
  return toolName in WORKSPACE_TOOL_META;
}

export async function logPostHocToolExecution(input: {
  toolCallId: string;
  toolId: string;
  args: unknown;
  result: unknown;
  isError?: boolean;
  agentId: string;
  runId?: string;
  turnId?: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
}): Promise<void> {
  if (!isHarnessFeatureEnabled('FEATURE_TOOL_ENVELOPE', true)) return;

  const executionId = randomUUID();
  const now = new Date();
  const meta = WORKSPACE_TOOL_META[input.toolId] ?? { category: 'other' as const, risk: 'low' as const };
  const inputPreview = buildToolPreview(input.args, { maxChars: DEFAULT_PREVIEW_CHARS });
  const outputPreview = buildToolPreview(input.result, { maxChars: DEFAULT_PREVIEW_CHARS });
  const status: ToolExecutionStatus = input.isError ? 'failed' : 'completed';

  // Policy evaluation (post-hoc / log-only — tool already executed)
  let policyDecision: ToolExecutionPolicySummary | undefined;
  const policyAction = mapToolToPolicyAction(input.toolId);
  if (policyAction) {
    const args = (input.args && typeof input.args === 'object') ? input.args as Record<string, unknown> : {};
    const decision = await evaluateAndLogHarnessPolicy({
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      toolId: input.toolId,
      action: policyAction,
      target: stringValue(args.path) ?? stringValue(args.filePath),
      command: stringValue(args.command),
      riskHint: meta.risk,
    });
    policyDecision = toPolicySummary(decision);
  }

  const doc: ToolExecutionDoc = {
    id: executionId,
    agentId: input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    toolId: input.toolId,
    category: meta.category,
    risk: meta.risk,
    status,
    policyDecision,
    inputPreview,
    outputPreview,
    createdAt: now,
    completedAt: now,
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
  };

  await insertToolExecution(doc);
  await logHarnessEvent({
    type: status === 'completed' ? 'tool_call_completed' : 'tool_call_failed',
    agentId: input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: 'tool_envelope',
    toolId: input.toolId,
    status: status === 'completed' ? 'success' : 'error',
    input: inputPreview,
    output: outputPreview,
    data: {
      executionId,
      category: meta.category,
      risk: meta.risk,
      toolStatus: status,
      policyDecision,
      postHoc: true,
    },
  });
}
