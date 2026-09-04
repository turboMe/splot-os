import { compactHarnessOutput } from './harness-output-compactor.js';
import { AUTOMATION_ARCHITECT_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import type { ToolEnvelopeMetadata } from './harness-tool-envelope.js';

type AutomationCompactionMetadata = ToolEnvelopeMetadata & {
  agentId?: string;
  toolId: string;
};

type CompactAutomationResultOptions = {
  previewBytes?: number;
  maxGenericArrayItems?: number;
};

type CompactedArraySummary = {
  path: string;
  originalCount: number;
  returnedCount: number;
};

type SummaryContext = {
  arrays: CompactedArraySummary[];
  maxGenericArrayItems: number;
};

type DiagnosticError = {
  path: string;
  message: string;
  severity?: string;
  code?: string;
};

type FailedStepSummary = {
  name?: string;
  status?: string;
  message?: string;
};

const DEFAULT_STRUCTURED_PREVIEW_BYTES = 4000;
const DEFAULT_GENERIC_ARRAY_ITEMS = 8;
const MAX_STRING_CHARS = 1200;
const MAX_DIAGNOSTIC_STRING_CHARS = 300;

/**
 * Store the full automation tool result as a harness artifact when it is too
 * large, then return a compact structure to the model. Scalars and contract
 * fields stay intact; high-volume arrays and nested diagnostic data are
 * shortened with counts recorded under `outputCompaction`.
 */
export async function compactAutomationResultForModel<T>(
  output: T,
  metadata: AutomationCompactionMetadata,
  options: CompactAutomationResultOptions = {},
): Promise<T> {
  const fullText = stringify(output);
  const compaction = await compactHarnessOutput({
    text: fullText,
    kind: 'tool_output',
    taskId: metadata.taskId,
    subtaskId: metadata.subtaskId,
    agentId: canonicalizeRuntimeAgentId(metadata.agentId) ?? AUTOMATION_ARCHITECT_AGENT_ID,
    threadId: metadata.threadId,
    runId: metadata.runId,
    turnId: metadata.turnId,
    toolId: metadata.toolId,
    previewBytes: options.previewBytes ?? DEFAULT_STRUCTURED_PREVIEW_BYTES,
    metadata: { scope: 'automation_model_output' },
  });

  if (!compaction.truncated || !output || typeof output !== 'object') {
    return output;
  }

  const ctx: SummaryContext = {
    arrays: [],
    maxGenericArrayItems: options.maxGenericArrayItems ?? DEFAULT_GENERIC_ARRAY_ITEMS,
  };
  const summarized = summarizeValue(output, '$', ctx);

  if (!summarized || typeof summarized !== 'object' || Array.isArray(summarized)) {
    return output;
  }

  return {
    ...(summarized as Record<string, unknown>),
    ...(buildAutomationDiagnosticSummary(output) ?? {}),
    outputArtifactId: compaction.fullTextArtifactId,
    outputTruncated: true,
    originalBytes: compaction.originalBytes,
    previewBytes: compaction.previewBytes,
    outputCompaction: {
      artifactId: compaction.fullTextArtifactId,
      originalBytes: compaction.originalBytes,
      previewBytes: compaction.previewBytes,
      compactedArrays: ctx.arrays,
    },
  } as T;
}

function buildAutomationDiagnosticSummary(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output)) return undefined;

  const failedStep = findFailedStep(output.steps);
  const topErrors = collectTopErrors(output).slice(0, 5);
  const failureClass = classifyAutomationFailure(output, failedStep, topErrors);
  const recoveryStrategies = summarizeRecoveryStrategies(output.recoveryStrategies);
  const nextAction = nextActionForFailure(failureClass, output, failedStep, topErrors);

  const summary: Record<string, unknown> = {};
  const status = stringValue(output.status);
  if (status) summary.status = status;
  if (typeof output.success === 'boolean') summary.success = output.success;
  if (failureClass) summary.failureClass = failureClass;
  if (failedStep) summary.failedStep = failedStep;
  if (topErrors.length > 0) summary.topErrors = topErrors;
  if (recoveryStrategies.length > 0) summary.recoveryStrategies = recoveryStrategies;
  if (nextAction) summary.nextAction = nextAction;

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function findFailedStep(value: unknown): FailedStepSummary | undefined {
  if (!Array.isArray(value)) return undefined;

  const step = [...value]
    .reverse()
    .find((entry) => isRecord(entry) && ['failed', 'blocked'].includes(stringValue(entry.status) ?? ''));
  if (!isRecord(step)) return undefined;

  return {
    name: stringValue(step.name),
    status: stringValue(step.status),
    message: stringValue(step.message),
  };
}

function collectTopErrors(output: Record<string, unknown>): DiagnosticError[] {
  const errors: DiagnosticError[] = [];
  const validation = recordValue(output.validation);
  const risk = recordValue(output.risk);
  const lastTest = recordValue(output.lastTest);

  pushDiagnosticError(errors, 'error', output.error);
  if (output.success === false) pushDiagnosticError(errors, 'message', output.message);

  pushDiagnosticArray(errors, 'validation.securityIssues', validation?.securityIssues);
  pushDiagnosticArray(errors, 'validation.errors', validation?.errors);
  pushDiagnosticArray(errors, 'validation.missingConfig', validation?.missingConfig);
  pushDiagnosticArray(errors, 'validation.missingCredentials', validation?.missingCredentials);
  pushDiagnosticArray(errors, 'missingConfig', output.missingConfig);
  pushDiagnosticArray(errors, 'missingCredentials', output.missingCredentials);
  pushDiagnosticArray(errors, 'risk.findings', risk?.findings);
  pushDiagnosticArray(errors, 'lastTest.findings', lastTest?.findings);

  if (Array.isArray(output.steps)) {
    for (const [index, step] of output.steps.entries()) {
      if (!isRecord(step)) continue;
      const status = stringValue(step.status);
      if (status !== 'failed' && status !== 'blocked') continue;
      pushDiagnosticError(errors, `steps[${index}]`, step, stringValue(step.name));
    }
  }

  return dedupeDiagnosticErrors(errors);
}

function pushDiagnosticArray(errors: DiagnosticError[], path: string, value: unknown): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => pushDiagnosticError(errors, `${path}[${index}]`, entry));
}

function pushDiagnosticError(
  errors: DiagnosticError[],
  path: string,
  value: unknown,
  fallback?: string,
): void {
  const record = recordValue(value);
  const message = record
    ? stringValue(record.message)
      ?? stringValue(record.reason)
      ?? stringValue(record.description)
      ?? stringValue(record.name)
    : stringValue(value);
  const text = message ?? fallback;
  if (!text) return;

  const severity = record ? stringValue(record.severity) : undefined;
  const code = record ? stringValue(record.code) ?? stringValue(record.type) : undefined;
  errors.push({
    path,
    message: truncate(text, MAX_DIAGNOSTIC_STRING_CHARS),
    ...(severity ? { severity } : {}),
    ...(code ? { code } : {}),
  });
}

function dedupeDiagnosticErrors(errors: DiagnosticError[]): DiagnosticError[] {
  const seen = new Set<string>();
  const deduped: DiagnosticError[] = [];
  for (const error of errors) {
    const key = `${error.path}:${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(error);
  }
  return deduped;
}

function summarizeRecoveryStrategies(value: unknown): Array<{
  name?: string;
  outcome?: string;
  reason?: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map((entry) => {
    if (!isRecord(entry)) return { reason: truncate(String(entry), MAX_DIAGNOSTIC_STRING_CHARS) };
    return {
      name: stringValue(entry.name),
      outcome: stringValue(entry.outcome),
      reason: truncate(stringValue(entry.reason) ?? '', MAX_DIAGNOSTIC_STRING_CHARS) || undefined,
    };
  });
}

function classifyAutomationFailure(
  output: Record<string, unknown>,
  failedStep: FailedStepSummary | undefined,
  topErrors: DiagnosticError[],
): string | undefined {
  const explicit = stringValue(output.failureClass);
  if (explicit) return explicit;

  const validation = recordValue(output.validation);
  if (arrayValue(validation?.securityIssues).length > 0) return 'security_validation';
  if (arrayValue(validation?.errors).length > 0) return 'workflow_validation';

  const risk = recordValue(output.risk);
  const verdict = stringValue(risk?.verdict);
  if (verdict === 'block') return 'risk_blocked';
  if (verdict === 'review') return 'approval_required';

  if (arrayValue(output.missingConfig).length > 0) return 'runtime_preflight';

  const lastTest = recordValue(output.lastTest);
  if (stringValue(lastTest?.status) === 'failed') return 'mock_test_failed';

  const text = [
    failedStep?.name,
    failedStep?.message,
    stringValue(output.message),
    stringValue(output.error),
    ...topErrors.map((error) => error.message),
  ].filter(Boolean).join('\n').toLowerCase();

  if (isWorkflowValidationText(text)) return 'workflow_validation';
  if (isToolInputContractText(text)) return 'tool_input_contract';
  if (isRuntimePreflightText(text)) return 'runtime_preflight';
  if (isRiskBlockedText(text)) return 'risk_blocked';
  if (/approval/.test(text)) return 'approval_required';
  if (isPolicyBlockedText(text)) return 'policy_blocked';

  const status = stringValue(output.status);
  return output.success === false && status ? status : undefined;
}

function nextActionForFailure(
  failureClass: string | undefined,
  output: Record<string, unknown>,
  failedStep: FailedStepSummary | undefined,
  topErrors: DiagnosticError[],
): string | undefined {
  switch (failureClass) {
	    case 'tool_input_contract':
	      return 'Call the tool again with structured input that satisfies the mode-specific schema.';
	    case 'pattern_coverage_gap':
	      return 'Do not deploy this pattern as-is; delegate to n8nMcpEngineer or compose workflow_json that covers missing capabilities, then rerun Golden Path.';
	    case 'runtime_preflight':
    case 'missing_config':
      return 'Verify runtime topology and required env vars before composing or deploying.';
    case 'workflow_validation':
    case 'security_validation':
      return 'Repair the workflow draft and rerun validation before deploy.';
    case 'risk_blocked':
    case 'approval_required':
      return 'Request approval or redesign the workflow to reduce risk; do not bypass policy.';
    case 'mock_test_failed':
      return 'Classify mock findings, apply bounded repair, redeploy inactive, and retest.';
    case 'connection_validation':
      return 'Run connection repair or return manual_connection_mapping_required with missing source/target names.';
    case 'policy_blocked':
      return 'Follow the policy decision or request the required approval before retrying.';
    default:
      if (failedStep || topErrors.length > 0 || output.success === false) {
        return 'Use failedStep and topErrors before retrying the same automation request.';
      }
      return undefined;
  }
}

function isWorkflowValidationText(text: string): boolean {
  return /workflow validation|draft validation|activation validation|validate_workflow|validation blocked deploy|connection references unknown|references unknown target|disconnected|trigger path|mock test failed/.test(text);
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

function summarizeValue(value: unknown, path: string, ctx: SummaryContext, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value, MAX_STRING_CHARS);
  if (typeof value !== 'object') return value;
  if (depth > 5) return '[Max depth: full data in outputArtifactId]';

  if (Array.isArray(value)) {
    const limit = arrayLimitForPath(path, ctx.maxGenericArrayItems);
    const returned = value.slice(0, limit).map((entry, index) =>
      summarizeValue(entry, `${path}[${index}]`, ctx, depth + 1),
    );
    if (value.length > returned.length) {
      ctx.arrays.push({
        path,
        originalCount: value.length,
        returnedCount: returned.length,
      });
    }
    return returned;
  }

  if (isWorkflowLike(value)) {
    return summarizeWorkflow(value as Record<string, unknown>);
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = summarizeValue(entry, `${path}.${key}`, ctx, depth + 1);
  }
  return out;
}

function arrayLimitForPath(path: string, fallback: number): number {
  if (/\.(errors|securityIssues|missingCredentials|missingConfig|findings|warnings|changes|remainingIssues|recoveryStrategies)$/.test(path)) {
    return 12;
  }
  if (/\.steps$/.test(path)) return 20;
  if (/\.testPlan$/.test(path)) return 20;
  return fallback;
}

function isWorkflowLike(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.nodes) && Boolean(record.connections);
}

function summarizeWorkflow(workflow: Record<string, unknown>): Record<string, unknown> {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const connections = workflow.connections && typeof workflow.connections === 'object'
    ? Object.keys(workflow.connections as Record<string, unknown>).length
    : 0;

  return {
    name: workflow.name,
    id: workflow.id,
    active: workflow.active,
    nodeCount: nodes.length,
    connectionCount: connections,
    nodes: nodes.slice(0, 12).map((node) => {
      if (!node || typeof node !== 'object') return node;
      const record = node as Record<string, unknown>;
      return {
        id: record.id,
        name: record.name,
        type: record.type,
        typeVersion: record.typeVersion,
      };
    }),
    truncated: nodes.length > 12,
    message: 'Full workflow JSON is stored in outputArtifactId.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
