import { readFile } from 'fs/promises';
import { isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';

import { getRuntimeTopology } from '../config/runtime-topology.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../config/agent-ids.js';
import { getDb } from '../lib/mongo.js';
import { N8nService } from '../tools/n8n/client.js';
import { getPatternById } from '../tools/architect/pattern-catalog.js';
import type { AutomationCapability, AutomationSpec } from '../tools/architect/types.js';
import {
  criticalMissingCapabilities,
  evaluateWorkflowCoverage,
  type CapabilityCoverageResult,
} from '../tools/architect/capability-coverage.js';
import {
  normalizeConnectionKeys,
  validateWorkflow,
} from '../tools/architect/validation/workflow-validator.js';
import { FORBIDDEN_NODE_TYPES } from '../tools/architect/validation/node-registry.js';
import type { ValidationFinding, ValidationResult } from '../tools/architect/validation/validation-types.js';
import { analyzeWorkflow } from '../tools/architect/risk-scoring.js';
import { getCredentialFromRegistry } from '../tools/architect/credentials/credential-registry.js';
import { generateMockPayload } from '../tools/architect/testing/mock-data.js';
import { applyRepairs } from '../tools/architect/testing/repair-workflow.js';
import type { RepairResult, TestFinding } from '../tools/architect/testing/test-types.js';
import { preserveExistingNodeCredentials } from '../tools/architect/workflow-write-helpers.js';
import {
  recordAutomationGoldenPathFailure,
  recordAutomationGoldenPathRecovery,
} from './automation-failure-learning.js';
import { isMcpHandoffFailed, mcpHandoffGateEnabled, hasSuccessfulMcpHandoff, markAutomationDeliverable } from './mcp-handoff-state.js';
import { synthesizeN8nWorkflow, type WorkflowGraphSpec } from '../tools/architect/composer/graph-synthesizer.js';

// WS-J — node types we have validated configs for (local pattern builders + the
// credential registry + standard control-flow/data nodes). Anything OUTSIDE this
// set (e.g. googleSheets, slack, notion) is "non-core": the architect tends to
// GUESS its typeVersion/params (the googleSheets v2-vs-v4 lottery), so the Golden
// Path requires a real n8n MCP handoff before deploying it.
const CORE_NODE_TYPES = new Set<string>([
  'webhook', 'respondToWebhook', 'code', 'httpRequest', 'scheduleTrigger', 'manualTrigger',
  'errorTrigger', 'formTrigger', 'if', 'switch', 'merge', 'set', 'noOp', 'filter',
  'splitInBatches', 'aggregate', 'itemLists', 'html', 'rssFeedRead', 'rssFeedReadTrigger',
  'dateTime', 'sort', 'limit', 'removeDuplicates', 'editFields', 'stopAndError', 'wait',
  'mongoDb', 'telegram', 'telegramTrigger', 'gmail', 'gmailTrigger', 'emailSend', 'emailReadImap',
]);

const FORBIDDEN_NODE_TYPE_SET = new Set<string>(FORBIDDEN_NODE_TYPES);

function shortNodeType(type: string): string {
  return type
    .replace(/^n8n-nodes-base\./, '')
    .replace(/^@n8n\/n8n-nodes-langchain\./, 'langchain.');
}

/** Forbidden node types present in the workflow, returned as readable short names. */
function forbiddenNodeTypes(workflow: any): string[] {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const found = new Set<string>();
  for (const node of nodes) {
    const type = typeof node?.type === 'string' ? node.type : '';
    if (type && FORBIDDEN_NODE_TYPE_SET.has(type)) found.add(shortNodeType(type));
  }
  return [...found];
}

/** WS-J — distinct non-core node types present in the workflow. */
function nonCoreNodeTypes(workflow: any): string[] {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const found = new Set<string>();
  for (const n of nodes) {
    const type = typeof n?.type === 'string' ? n.type : '';
    if (!type) continue;
    // Forbidden nodes are policy violations, not unfamiliar nodes. They must
    // never be presented as candidates for MCP validation.
    if (FORBIDDEN_NODE_TYPE_SET.has(type)) continue;
    const short = shortNodeType(type);
    if (!CORE_NODE_TYPES.has(short)) found.add(short);
  }
  return [...found];
}

/** Early forbidden-node gate mode. Downstream validation remains fail-closed. */
function getForbiddenNodeGateMode(): 'off' | 'warn' | 'block' {
  const raw = (process.env.FORBIDDEN_NODE_GATE_MODE ?? 'block').toLowerCase();
  return raw === 'off' || raw === 'warn' ? raw : 'block';
}

/** WS-J gate mode. Default `block` (force MCP for non-core nodes). */
function getNodeValidationGateMode(): 'off' | 'warn' | 'block' {
  const raw = (process.env.NODE_VALIDATION_GATE_MODE ?? 'block').toLowerCase();
  return raw === 'off' || raw === 'warn' ? raw : 'block';
}

export type AutomationGoldenPathMode = 'pattern' | 'workflow_file' | 'workflow_json' | 'graph_spec';

export type AutomationGoldenPathStatus =
  | 'blocked'
  | 'draft_created'
  | 'tested'
  | 'active'
  | 'manual_review_required';

export type AutomationGoldenPathStepStatus = 'success' | 'warning' | 'blocked' | 'failed' | 'skipped';

export type AutomationGoldenPathStep = {
  name: string;
  status: AutomationGoldenPathStepStatus;
  message: string;
  data?: Record<string, unknown>;
};

export type AutomationRecoveryStrategy = {
  name: string;
  outcome: 'attempted' | 'succeeded' | 'failed' | 'blocked' | 'not_applicable';
  reason: string;
  changes?: unknown[];
};

export type AutomationGoldenPathInput = {
  mode: AutomationGoldenPathMode;
  request?: string;
  patternId?: string;
  spec?: AutomationSpec;
  workflow?: unknown;
  graphSpec?: WorkflowGraphSpec;
  workflowFilePath?: string;
  workflowName?: string;
  workflowId?: string;
  automationId?: string;
  /** Legacy dashboard token for non-Architect direct callers. */
  approvalToken?: string;
  activate?: boolean;
  allowDraftWithMissingCredentials?: boolean;
  requiresPublicWebhook?: boolean;
};

export type AutomationGoldenPathResult = {
  success: boolean;
  status: AutomationGoldenPathStatus;
  failureClass?: string;
  automationId: string;
  workflowId?: string;
  workflowName?: string;
  operation?: 'create' | 'update';
  message: string;
  steps: AutomationGoldenPathStep[];
  validation?: ValidationResult;
  risk?: ReturnType<typeof analyzeWorkflow> & { verdict: 'approve' | 'review' | 'block' };
  coverage?: CapabilityCoverageResult;
  lastTest?: {
    mode: 'mock';
    status: 'passed' | 'failed';
    findings: TestFinding[];
    testPlan: string[];
  };
  missingConfig?: unknown[];
  missingCredentials?: unknown[];
  recoveryStrategies?: AutomationRecoveryStrategy[];
  repairAttempts: number;
  error?: string;
};

type AutomationGoldenPathTestResult = NonNullable<AutomationGoldenPathResult['lastTest']>;

type RuntimeRequirements = {
  requiresPublicWebhook: boolean;
  requiresMastraApi: boolean;
  requiresOllama: boolean;
  requiresMongo: boolean;
  requiresTelegram: boolean;
};

const SAFE_FILE_ROOTS = [
  process.env.ARCHITECT_WORKFLOW_ROOT ?? '/projekty/splot-projects/n8n_workflows',
  '/tmp',
  process.cwd(),
];

/**
 * Observation and cancellation for a running Golden Path (F6 cutover).
 *
 * Both hang off the SAME place — the step boundary — because that is the only
 * point where this pipeline is in a known, describable state. Between steps it
 * is inside an n8n call or a validator and neither reporting nor stopping there
 * would be safe or meaningful.
 */
export interface AutomationGoldenPathControl {
  /**
   * Trusted runtime identity, supplied by the tool/job wrapper rather than by
   * model input. Automation Architect uses the user's current request (or its
   * delegated brief) as authority and therefore does not wait on the separate
   * dashboard approval collection. Other direct callers keep the legacy gate.
   */
  actorAgentId?: string;
  /**
   * Cooperative stop. Checked at every step boundary, and a stop BEFORE
   * `deploy_inactive` means nothing was written to n8n.
   *
   * This is what makes cancel real. Until now cancellation only suppressed the
   * RESULT: the pipeline kept running, kept deploying and kept repairing after
   * the operator said stop, and the only visible effect was that nobody was told
   * what it did.
   */
  signal?: AbortSignal;
  /**
   * Called as each step lands, so progress is durable somewhere outside this
   * closure. Best-effort by contract: a checkpoint that cannot be written must
   * never fail the build it was only describing.
   */
  onStep?: (step: AutomationGoldenPathStep) => void;
}

/** Thrown at a step boundary when the caller asked to stop. */
export class AutomationGoldenPathCancelled extends Error {
  constructor(readonly lastStep: string) {
    super(`Golden Path cancelled after step ${lastStep}`);
    this.name = 'AutomationGoldenPathCancelled';
  }
}

/**
 * Store the workflow this path just deployed, so the run has a fetchable product.
 *
 * Never fails the deploy: the workflow is already live in n8n by the time this
 * runs, and losing the record of it is worse reported than thrown — a throw here
 * would turn a successful deployment into a failed job.
 */
async function recordDeployedWorkflowArtifact(args: {
  workflow: unknown;
  workflowId: string;
  workflowName: string;
  operation: string;
}): Promise<void> {
  if (!args.workflow) return;
  try {
    // Imported lazily for the same reason the V2 caller does it: `artifact-store`
    // pulls the legacy Mongo client at load, and this module is reached from paths
    // that should not drag it in on import.
    const { putArtifact } = await import('./artifact-store.js');
    await putArtifact({
      type: 'automation_workflow',
      content: JSON.stringify(args.workflow, null, 2),
      producedBy: AUTOMATION_ARCHITECT_AGENT_ID,
      title: args.workflowName,
      summary:
        `n8n workflow ${args.workflowName} (${args.operation}), id ${args.workflowId}, `
        + 'deployed inactive by the Golden Path',
      metadata: { workflowId: args.workflowId, operation: args.operation, active: false },
    });
  } catch (error) {
    console.warn(
      `[golden-path] workflow ${args.workflowId} was deployed but NOT recorded as an artifact: `
      + `${(error as Error).message}`,
    );
  }
}

export async function executeAutomationGoldenPath(
  input: AutomationGoldenPathInput,
  control: AutomationGoldenPathControl = {},
): Promise<AutomationGoldenPathResult> {
  const dashboardApprovalExempt =
    canonicalizeRuntimeAgentId(control.actorAgentId) === AUTOMATION_ARCHITECT_AGENT_ID;
  let automationId = input.automationId || randomUUID();
  const steps: AutomationGoldenPathStep[] = [];
  let workflowId = input.workflowId;
  let workflowName: string | undefined;
  let deployedWorkflow: any;
  let operation: 'create' | 'update' | undefined;
  let repairAttempts = 0;
  const recoveryStrategies: AutomationRecoveryStrategy[] = [];

  const pushStep = (
    name: string,
    status: AutomationGoldenPathStepStatus,
    message: string,
    data?: Record<string, unknown>,
  ) => {
    const step: AutomationGoldenPathStep = { name, status, message, data };
    steps.push(step);
    // Checkpoint first, THEN honour a stop: the step that just completed is a
    // fact, and a cancellation arriving now must not erase the record of it.
    // Whoever resumes or audits this run needs to know the pipeline reached
    // here — especially when "here" is already past `deploy_inactive`.
    try { control.onStep?.(step); } catch { /* observation must never fail the build */ }
    if (control.signal?.aborted) throw new AutomationGoldenPathCancelled(name);
  };

  const finalize = async (result: AutomationGoldenPathResult): Promise<AutomationGoldenPathResult> => {
    result.recoveryStrategies = [...recoveryStrategies];
    if (result.success) {
      await recordAutomationGoldenPathRecovery({ input, result }).catch((error) => {
        console.warn('[AutomationGoldenPath] recovery learning failed:', (error as Error).message);
      });
    } else {
      await recordAutomationGoldenPathFailure({ input, result }).catch((error) => {
        console.warn('[AutomationGoldenPath] failure learning failed:', (error as Error).message);
      });
    }
    return result;
  };

  try {
    let workflow = await resolveWorkflowInput(input);
    workflowName = input.workflowName || workflow.name;
    pushStep('resolve_workflow', 'success', `Workflow resolved: ${workflowName ?? '(unnamed)'}`);

    // Policy violations must be classified before coverage and non-core node
    // validation. MCP can explain an unfamiliar node, but it cannot legalize
    // executeCommand, filesystem, or SSH access.
    const forbiddenGateMode = getForbiddenNodeGateMode();
    const forbidden = forbiddenNodeTypes(workflow);
    if (forbiddenGateMode !== 'off') {
      pushStep(
        'forbidden_node_policy',
        forbidden.length === 0
          ? 'success'
          : forbiddenGateMode === 'block'
            ? 'blocked'
            : 'warning',
        forbidden.length === 0
          ? 'Workflow contains no forbidden node types.'
          : `Workflow uses forbidden node types: ${forbidden.join(', ')}.`,
        { forbiddenNodeTypes: forbidden, mode: forbiddenGateMode },
      );
    }
    if (forbidden.length > 0 && forbiddenGateMode === 'block') {
      recoveryStrategies.push({
        name: 'replace_forbidden_nodes',
        outcome: 'blocked',
        reason: 'Remove or replace forbidden nodes with allowed equivalents. MCP cannot validate or authorize these nodes.',
      });
      return await finalize(buildResult({
        success: false,
        status: 'blocked',
        failureClass: 'forbidden_nodes',
        automationId,
        workflowId,
        workflowName,
        message:
          `Workflow uses FORBIDDEN nodes (${forbidden.join(', ')}). These nodes are prohibited by policy and cannot be deployed or validated via MCP. `
          + 'Replace external API/command access with httpRequest or an allowed Code node; replace file persistence with Code plus MongoDB/Google Sheets. '
          + 'Recompose without forbidden nodes and rerun. Do not delegate to n8nMcpEngineer and do not retry unchanged.',
        steps,
        repairAttempts,
      }));
    }

    const coverage = evaluateWorkflowCoverage({
      spec: input.spec,
      request: input.request,
      workflow,
    });
    const coverageMode = getCoverageGateMode();
    const coverageBlocks = shouldBlockCoverage(input, coverage, coverageMode);
    pushStep(
      'coverage_check',
      coverageMode === 'off'
        ? 'skipped'
        : coverage.ok
          ? 'success'
          : coverageBlocks
            ? 'blocked'
            : 'warning',
      coverage.ok
        ? `Capability coverage passed (score=${coverage.score}).`
        : `Capability coverage gap: ${coverage.missingRequired.join(', ') || 'unknown'}.`,
      {
        mode: coverageMode,
        score: coverage.score,
        required: coverage.required,
        actual: coverage.actual,
        missingRequired: coverage.missingRequired,
        recommendation: coverage.recommendation,
        warnings: coverage.warnings,
      },
    );
    if (coverageBlocks) {
      recoveryStrategies.push(
        {
          name: 'delegate_to_n8n_mcp_engineer',
          outcome: 'blocked',
          reason: 'Required n8n capability is missing from the selected workflow; use read-only MCP discovery/validation before retrying.',
        },
        {
          name: 'select_more_specific_pattern',
          outcome: 'not_applicable',
          reason: 'Retry with a pattern whose capability metadata covers the missing requirements.',
        },
        {
          name: 'compose_custom_workflow_json_then_rerun_golden_path',
          outcome: 'not_applicable',
          reason: 'Compose a custom workflow candidate that includes the missing capabilities, then rerun Golden Path.',
        },
      );
      return await finalize(buildResult({
        success: false,
        status: 'blocked',
        failureClass: 'pattern_coverage_gap',
        automationId,
        workflowId,
        workflowName,
        message: `Pattern coverage gap blocked deploy: ${coverage.missingRequired.join(', ')}.`,
        steps,
        coverage,
        repairAttempts,
      }));
    }

    // WS-G — fail-closed on a failed MCP handoff in this run. If the architect
    // delegated to n8nMcpEngineer for node validation and that handoff failed (and
    // was not resolved by a later successful handoff), the node configs are
    // UNVALIDATED — refuse to deploy instead of shipping guessed node types /
    // typeVersions. The architect must obtain a real MCP handoff or report blocked.
    // (Flag is set/cleared in delegate-task, keyed by this architect run.)
    if (mcpHandoffGateEnabled() && isMcpHandoffFailed()) {
      pushStep('mcp_handoff_gate', 'blocked', 'A required n8n MCP handoff failed for this run; node configs are unvalidated.');
      recoveryStrategies.push({
        name: 'rerun_successful_mcp_handoff',
        outcome: 'blocked',
        reason: 'Re-delegate to n8nMcpEngineer and obtain a handoff backed by real MCP tool calls (search_nodes/get_node/validate_node) before deploying, or report blocked.',
      });
      return await finalize(buildResult({
        success: false,
        status: 'blocked',
        failureClass: 'mcp_handoff_failed',
        automationId,
        workflowId,
        workflowName,
        message: 'Deploy blocked: a required n8n MCP handoff failed (unvalidated node configs). Obtain a successful MCP handoff or report blocked.',
        steps,
        coverage,
        repairAttempts,
      }));
    }

    // WS-J — non-core node gate. Require a real (WS-F verified) n8n MCP handoff
    // before deploying a workflow that uses node types outside CORE_NODE_TYPES,
    // instead of trusting the architect's guessed typeVersion/params.
    const nodeGateMode = getNodeValidationGateMode();
    if (nodeGateMode !== 'off') {
      const nonCore = nonCoreNodeTypes(workflow);
      if (nonCore.length > 0 && !hasSuccessfulMcpHandoff()) {
        pushStep(
          'node_validation',
          nodeGateMode === 'block' ? 'blocked' : 'warning',
          `Non-core node types not validated via n8n MCP this run: ${nonCore.join(', ')}.`,
          { nonCoreNodeTypes: nonCore, mode: nodeGateMode },
        );
        if (nodeGateMode === 'block') {
          recoveryStrategies.push({
            name: 'validate_non_core_nodes_via_mcp',
            outcome: 'blocked',
            reason: `Delegate to n8nMcpEngineer to validate node types (${nonCore.join(', ')}) with get_node/validate_node (confirm typeVersion + parameters), then rerun Golden Path. Do not guess node configs.`,
          });
          return await finalize(buildResult({
            success: false,
            status: 'blocked',
            failureClass: 'node_validation_required',
            automationId,
            workflowId,
            workflowName,
            message: `Deploy blocked: workflow uses node types outside the validated set (${nonCore.join(', ')}) and no n8n MCP validation happened this run. Delegate to n8nMcpEngineer to validate them, then rerun Golden Path.`,
            steps,
            coverage,
            repairAttempts,
          }));
        }
      } else {
        pushStep(
          'node_validation',
          'success',
          nonCore.length
            ? `Non-core node types covered by a successful MCP handoff: ${nonCore.join(', ')}.`
            : 'All node types are in the validated core set.',
        );
      }
    }

    const runtime = await checkRuntime(inferRuntimeRequirements(workflow, input, coverage.required));
    pushStep('runtime_check', runtime.ok ? 'success' : 'blocked', runtime.message, { checks: runtime.checks });
    if (!runtime.ok) {
      recoveryStrategies.push({
        name: 'runtime_preflight',
        outcome: 'blocked',
        reason: 'Runtime requirements failed before workflow deploy.',
      });
      return await finalize(buildResult({
        success: false,
        status: 'blocked',
        automationId,
        workflowId,
        workflowName,
        message: runtime.message,
        steps,
        coverage,
        repairAttempts,
        missingConfig: runtime.missingConfig,
      }));
    }

    const normalizationWarnings = normalizeWorkflowForDeploy(workflow);
    if (normalizationWarnings.length > 0) {
      pushStep('normalize_workflow', 'warning', 'Workflow normalized before validation.', {
        warnings: normalizationWarnings,
      });
    } else {
      pushStep('normalize_workflow', 'success', 'Workflow normalization complete.');
    }

    let draftValidation = validateWorkflow(workflow, 'draft');
    if (normalizationWarnings.length > 0) {
      draftValidation.warnings = [
        ...draftValidation.warnings,
        ...normalizationWarnings.map((message) => ({ message, severity: 'warning' as const })),
      ];
    }
    let blocksDeploy = blocksDraftDeploy(draftValidation, input);

    pushStep('validate_draft', blocksDeploy ? 'blocked' : 'success',
      blocksDeploy ? 'Draft validation blocked deploy.' : 'Draft validation passed.', {
        errors: draftValidation.errors.length,
        securityIssues: draftValidation.securityIssues.length,
        missingCredentials: draftValidation.missingCredentials.length,
        missingConfig: draftValidation.missingConfig.length,
      });

    if (blocksDeploy) {
      const draftRepair = await repairDraftBeforeDeploy({
        automationId,
        workflow,
        validation: draftValidation,
        attempt: repairAttempts + 1,
        allowDraftWithMissingCredentials: input.allowDraftWithMissingCredentials,
      });
      repairAttempts += draftRepair.attempts;
      const draftRepairStrategy = selectValidationRecoveryStrategy(draftValidation, draftRepair.stopReason);
      recoveryStrategies.push({
        name: draftRepairStrategy,
        outcome: draftRepair.succeeded ? 'succeeded' : draftRepair.changed ? 'failed' : 'not_applicable',
        reason: draftRepair.message,
        changes: draftRepair.changes,
      });
      pushStep(
        'strategy_retry',
        draftRepair.succeeded ? 'success' : draftRepair.changed ? 'warning' : 'failed',
        draftRepair.message,
        { strategy: draftRepairStrategy, stopReason: draftRepair.stopReason, changes: draftRepair.changes },
      );

      if (draftRepair.workflow && draftRepair.validation) {
        workflow = draftRepair.workflow;
        draftValidation = draftRepair.validation;
        blocksDeploy = blocksDraftDeploy(draftValidation, input);
        pushStep(
          'validate_draft_retry',
          blocksDeploy ? 'blocked' : 'success',
          blocksDeploy ? 'Draft validation still blocks deploy after retry.' : 'Draft validation passed after retry.',
          {
            errors: draftValidation.errors.length,
            securityIssues: draftValidation.securityIssues.length,
            missingCredentials: draftValidation.missingCredentials.length,
            missingConfig: draftValidation.missingConfig.length,
          },
        );
      }
    }

    if (blocksDeploy) {
      return await finalize(buildResult({
        success: false,
        status: 'blocked',
        automationId,
        workflowId,
        workflowName,
        message: 'Workflow validation blocked deploy.',
        steps,
        coverage,
        validation: draftValidation,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      }));
    }

    const risk = withVerdict(analyzeWorkflow(workflow));
    pushStep('risk_score', risk.verdict === 'block' ? 'blocked' : risk.verdict === 'review' ? 'warning' : 'success',
      `Risk score=${risk.score}, verdict=${risk.verdict}.`, { findings: risk.findings });

    if (risk.verdict === 'block') {
      recoveryStrategies.push({
        name: 'risk_reduction',
        outcome: 'blocked',
        reason: `Risk verdict block at score ${risk.score}; automatic bypass is not allowed.`,
      });
      return await finalize(buildResult({
        success: false,
        status: 'blocked',
        automationId,
        workflowId,
        workflowName,
        message: `Deploy blocked by risk score ${risk.score}.`,
        steps,
        coverage,
        validation: draftValidation,
        risk,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      }));
    }

    if (risk.verdict === 'review' && !dashboardApprovalExempt && !input.approvalToken) {
      recoveryStrategies.push({
        name: 'approval_gate',
        outcome: 'blocked',
        reason: `Risk verdict review at score ${risk.score}; approvalToken required.`,
      });
      return await finalize(buildResult({
        success: false,
        status: 'blocked',
        automationId,
        workflowId,
        workflowName,
        message: `Deploy requires approvalToken (risk score=${risk.score}).`,
        steps,
        coverage,
        validation: draftValidation,
        risk,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      }));
    }

    const deployed = await deployWorkflow({
      automationId,
      workflow,
      workflowId,
      approvalToken: input.approvalToken,
      dashboardApprovalExempt,
      validation: draftValidation,
      risk,
    });
    automationId = deployed.automationId;
    workflowId = deployed.workflowId;
    workflowName = deployed.workflowName;
    deployedWorkflow = deployed.workflow;
    operation = deployed.operation;
    pushStep('deploy_inactive', 'success', deployed.message, { workflowId, operation: deployed.operation });

    // Record the deployed workflow as an artifact, HERE, at the moment it exists.
    //
    // The run that dispatches this Golden Path has a product — a workflow living
    // in n8n — and no way to hand it to the next step, because the agent itself
    // never holds the JSON: it calls this path once and reports. Asking the model
    // to `artifact_put` afterwards makes durability depend on the model choosing
    // to comply, and on the automationArchitect canary it did not: one tool call,
    // a good report, `producer.artifacts` empty.
    //
    // Recording it where the write happens is the same rule this project already
    // learned twice — a fact about a run must be written when the event occurs,
    // not recovered later from an object the framework may reshape. Inside a
    // harness run `putArtifact` attributes this to the run automatically; outside
    // one (the durable automation job) it stores the artifact and says so.
    await recordDeployedWorkflowArtifact({
      workflow: deployedWorkflow,
      workflowId,
      workflowName,
      operation: deployed.operation,
    });

    await syncAutomationStatus({ automationId, workflowId });

    let test = await runMockTest(automationId, workflowId, deployedWorkflow);
    pushStep(
      'mock_test',
      test.status === 'passed' ? 'success' : 'failed',
      test.status === 'passed' ? 'Mock test passed.' : 'Mock test failed.',
      { findings: test.findings },
    );

    while (test.status !== 'passed' && repairAttempts < 3) {
      repairAttempts += 1;
      const strategyName = selectMockTestRecoveryStrategy(test.findings);
      recoveryStrategies.push({
        name: strategyName,
        outcome: 'attempted',
        reason: `Mock test failed; attempting repair ${repairAttempts}/3.`,
      });
      const repair = await repairAndRedeploy({
        automationId,
        workflowId,
        workflow: deployedWorkflow,
        findings: test.findings,
        attempt: repairAttempts,
        approvalToken: input.approvalToken,
        dashboardApprovalExempt,
      });

      pushStep(
        'repair_workflow',
        repair.success ? 'success' : repair.changed ? 'warning' : 'failed',
        repair.message,
        { attempt: repairAttempts, strategy: repair.strategyName ?? strategyName, stopReason: repair.stopReason, changes: repair.changes },
      );
      recoveryStrategies[recoveryStrategies.length - 1] = {
        name: repair.strategyName ?? strategyName,
        outcome: repair.success ? 'succeeded' : repair.changed ? 'failed' : 'not_applicable',
        reason: repair.message,
        changes: repair.changes,
      };

      if (!repair.changed || !repair.workflow) {
        break;
      }

      deployedWorkflow = repair.workflow;
      test = await runMockTest(automationId, workflowId, deployedWorkflow);
      pushStep(
        'mock_test_retry',
        test.status === 'passed' ? 'success' : 'failed',
        test.status === 'passed' ? 'Mock test passed after repair.' : 'Mock test still failed after repair.',
        { attempt: repairAttempts, findings: test.findings },
      );
    }

    if (test.status !== 'passed') {
      await markAutomationStatus(automationId, 'manual_review_required', workflowId);
      return await finalize(buildResult({
        success: false,
        status: 'manual_review_required',
        automationId,
        workflowId,
        workflowName,
        operation,
        message: 'Workflow deployed but mock test did not pass after repair attempts.',
        steps,
        coverage,
        validation: draftValidation,
        risk,
        lastTest: test,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      }));
    }

    if (input.activate) {
      const activation = await activateIfAllowed({
        automationId,
        workflowId,
        approvalToken: input.approvalToken,
        dashboardApprovalExempt,
      });
      pushStep('activate', activation.success ? 'success' : 'blocked', activation.message, activation.data);
      await syncAutomationStatus({ automationId, workflowId });

      return await finalize(buildResult({
        success: activation.success,
        status: activation.success ? 'active' : 'tested',
        automationId,
        workflowId,
        workflowName,
        operation,
        message: activation.success
          ? 'Workflow deployed, tested, and activated.'
          : 'Workflow deployed and tested, but activation was blocked.',
        steps,
        coverage,
        validation: draftValidation,
        risk,
        lastTest: test,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      }));
    }

    await markAutomationStatus(automationId, 'tested', workflowId);
    await syncAutomationStatus({ automationId, workflowId });

    return await finalize(buildResult({
      success: true,
      status: 'tested',
      automationId,
      workflowId,
      workflowName,
      operation,
      message: 'Workflow deployed as inactive draft and passed mock test.',
      steps,
      coverage,
      validation: draftValidation,
      risk,
      lastTest: test,
      repairAttempts,
      missingConfig: draftValidation.missingConfig,
      missingCredentials: draftValidation.missingCredentials,
    }));
  } catch (error) {
    // A cancellation is NOT a failure of the build, and reporting it as one
    // would teach the failure-learning corpus that the operator's stop button is
    // a defect. It also must not re-enter `pushStep` — that would throw again on
    // the still-aborted signal and lose the result entirely.
    if (error instanceof AutomationGoldenPathCancelled) {
      steps.push({
        name: 'cancelled',
        status: 'skipped',
        message: error.message,
        data: { lastStep: error.lastStep, deployed: Boolean(workflowId) },
      });
      return buildResult({
        success: false,
        status: 'blocked',
        failureClass: 'cancelled',
        automationId,
        workflowId,
        workflowName,
        operation,
        // Whether n8n was touched is the one thing the operator must be told:
        // stopping before `deploy_inactive` leaves nothing behind, stopping
        // after it leaves an inactive draft that somebody has to look at.
        message: workflowId
          ? `Cancelled after ${error.lastStep}; an inactive draft already exists in n8n (${workflowId}).`
          : `Cancelled after ${error.lastStep}; nothing was deployed.`,
        steps,
        repairAttempts,
        error: error.message,
      });
    }
    pushStep('golden_path_failed', 'failed', (error as Error).message);
    return await finalize(buildResult({
      success: false,
      status: 'blocked',
      automationId,
      workflowId,
      workflowName,
      message: 'Automation Golden Path failed before completion.',
      steps,
      repairAttempts,
      error: (error as Error).message,
    }));
  }
}

export async function syncAutomationStatus(input: {
  automationId?: string;
  workflowId?: string;
}): Promise<{ synced: boolean; status?: AutomationGoldenPathStatus; n8nActive?: boolean; message: string }> {
  const db = await getDb();
  const query = input.automationId
    ? { automationId: input.automationId }
    : input.workflowId
      ? { n8nWorkflowId: input.workflowId }
      : null;

  if (!query) return { synced: false, message: 'automationId or workflowId is required.' };

  const existing = await db.collection('automation_requests').findOne(query);
  if (!existing?.n8nWorkflowId && !input.workflowId) {
    return { synced: false, message: 'Automation has no n8n workflow id.' };
  }

  const workflowId = input.workflowId || existing?.n8nWorkflowId;
  if (!workflowId) return { synced: false, message: 'Automation has no n8n workflow id.' };

  const n8n = new N8nService();
  const workflow = await n8n.getWorkflow(workflowId);
  const n8nActive = workflow.active === true;
  const lastTestPassed = existing?.lastTest?.status === 'passed';
  const currentStatus = existing?.status as AutomationGoldenPathStatus | undefined;
  const status: AutomationGoldenPathStatus = n8nActive
    ? 'active'
    : currentStatus === 'manual_review_required'
      ? 'manual_review_required'
      : lastTestPassed || currentStatus === 'tested'
        ? 'tested'
        : 'draft_created';

  await db.collection('automation_requests').updateOne(
    { n8nWorkflowId: workflowId },
    {
      $set: {
        status,
        n8nActive,
        lastN8nSyncAt: new Date(),
        lastKnownWorkflow: workflow,
        updatedAt: new Date(),
        ...(n8nActive && currentStatus !== 'active' ? { activationDetectedAt: new Date() } : {}),
      },
    },
    { upsert: false },
  );

  return { synced: true, status, n8nActive, message: `Synced workflow ${workflowId}: status=${status}.` };
}

async function resolveWorkflowInput(input: AutomationGoldenPathInput): Promise<any> {
  if (input.mode === 'pattern') {
    if (!input.patternId) throw new Error('patternId is required for mode=pattern.');
    if (!input.spec) throw new Error('spec is required for mode=pattern.');
    const pattern = getPatternById(input.patternId);
    if (!pattern) throw new Error(`Pattern not found: ${input.patternId}.`);
    if (pattern.executable === false) {
      throw new Error(`Pattern ${input.patternId} is abstract and cannot be deployed.`);
    }
    const built = pattern.build(input.spec);
    return {
      name: input.workflowName ?? input.spec.name,
      nodes: built?.nodes ?? [],
      connections: built?.connections ?? {},
      settings: built?.settings ?? { executionOrder: 'v1' },
      active: false,
    };
  }

  if (input.mode === 'workflow_file') {
    if (!input.workflowFilePath) throw new Error('workflowFilePath is required for mode=workflow_file.');
    const filePath = resolveWorkflowFilePath(input.workflowFilePath);
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  if (input.mode === 'graph_spec') {
    if (!input.graphSpec || typeof input.graphSpec !== 'object') {
      throw new Error('graphSpec object is required for mode=graph_spec.');
    }
    const synthesized = synthesizeN8nWorkflow({
      ...input.graphSpec,
      name: input.workflowName ?? input.graphSpec.name,
    });
    return synthesized;
  }

  if (!input.workflow || typeof input.workflow !== 'object' || Array.isArray(input.workflow)) {
    throw new Error('workflow object is required for mode=workflow_json.');
  }

  return JSON.parse(JSON.stringify(input.workflow));
}

function resolveWorkflowFilePath(filePath: string): string {
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(process.cwd(), filePath);
  const allowed = SAFE_FILE_ROOTS.some((root) => {
    const rel = relative(resolve(root), resolved);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });

  if (!allowed) {
    throw new Error(`Workflow file path is outside allowed roots: ${SAFE_FILE_ROOTS.join(', ')}`);
  }

  return resolved;
}

function normalizeWorkflowForDeploy(workflow: any): string[] {
  const warnings: string[] = [];
  warnings.push(...normalizeConnectionKeys(workflow));

  if (!workflow.settings || typeof workflow.settings !== 'object') {
    workflow.settings = { executionOrder: 'v1' };
    warnings.push('Added settings.executionOrder=v1.');
  } else if (workflow.settings.executionOrder !== 'v1') {
    workflow.settings.executionOrder = 'v1';
    warnings.push('Forced settings.executionOrder=v1.');
  }

  if (workflow.active !== false) {
    workflow.active = false;
    warnings.push('Forced active=false.');
  }

  const nodes: any[] = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  for (const node of nodes) {
    const credentialType = credentialTypeForNode(node.type);
    if (!credentialType) continue;

    const registry = getCredentialFromRegistry(credentialType.service);
    if (!registry) continue;

    const current = node.credentials?.[credentialType.n8nCredentialType];
    if (!node.credentials) node.credentials = {};

    if (!current || typeof current === 'string') {
      node.credentials[credentialType.n8nCredentialType] = { id: registry.id, name: registry.name };
      warnings.push(`Credential normalized for ${node.name || node.type}: ${credentialType.n8nCredentialType}.`);
    }
  }

  return warnings;
}

function credentialTypeForNode(nodeType: string | undefined): { service: string; n8nCredentialType: string } | null {
  switch (nodeType) {
    case 'n8n-nodes-base.telegram':
    case 'n8n-nodes-base.telegramTrigger':
      return { service: 'telegram', n8nCredentialType: 'telegramApi' };
    case 'n8n-nodes-base.mongoDb':
      return { service: 'mongo', n8nCredentialType: 'mongoDb' };
    case 'n8n-nodes-base.gmail':
    case 'n8n-nodes-base.gmailTrigger':
      return { service: 'gmail', n8nCredentialType: 'gmailOAuth2' };
    default:
      return null;
  }
}

function inferRuntimeRequirements(
  workflow: any,
  input: AutomationGoldenPathInput,
  requiredCapabilities: AutomationCapability[] = [],
): RuntimeRequirements {
  const nodes: any[] = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const serialized = JSON.stringify(workflow ?? {}).toLowerCase();
  const required = new Set(requiredCapabilities);
  return {
    requiresPublicWebhook:
      input.requiresPublicWebhook === true ||
      required.has('runtime.publicWebhook') ||
      (input.activate === true && nodes.some((node) => node.type === 'n8n-nodes-base.webhook')),
    requiresMastraApi:
      required.has('service.mastraApi') ||
      required.has('runtime.localMastraApi') ||
      serialized.includes('localhost:4111') ||
      serialized.includes('mastra'),
    requiresOllama:
      required.has('service.ollama') ||
      required.has('runtime.localOllama') ||
      serialized.includes('ollama') ||
      serialized.includes('11434'),
    requiresMongo:
      required.has('service.mongo') ||
      required.has('runtime.localMongo') ||
      required.has('operation.mongo.insert') ||
      required.has('operation.mongo.update') ||
      required.has('operation.mongo.find') ||
      nodes.some((node) => node.type === 'n8n-nodes-base.mongoDb') ||
      serialized.includes('mongodb'),
    requiresTelegram:
      required.has('service.telegram') ||
      required.has('operation.telegram.send') ||
      nodes.some((node) => String(node.type ?? '').includes('telegram')),
  };
}

function getCoverageGateMode(): 'off' | 'warn' | 'block' {
  if (/^(0|false|no|off)$/i.test(process.env.FEATURE_AUTOMATION_COVERAGE_GATE ?? '')) {
    return 'off';
  }
  if (/^(1|true|yes|on)$/i.test(process.env.FEATURE_AUTOMATION_COVERAGE_GATE ?? '')) {
    return 'block';
  }
  const mode = (process.env.AUTOMATION_COVERAGE_GATE_MODE ?? 'warn').toLowerCase();
  return mode === 'off' || mode === 'warn' || mode === 'block' ? mode : 'warn';
}

function shouldBlockCoverage(
  input: AutomationGoldenPathInput,
  coverage: CapabilityCoverageResult,
  mode: 'off' | 'warn' | 'block',
): boolean {
  if (mode !== 'block') return false;
  if (coverage.ok) return false;

  const minScoreRaw = Number(process.env.AUTOMATION_COVERAGE_MIN_SCORE ?? 1);
  const minScore = Number.isFinite(minScoreRaw) ? minScoreRaw : 1;
  const criticalMissing = criticalMissingCapabilities(coverage);
  const belowMinScore = coverage.score < minScore;
  const hasCriticalGap = criticalMissing.length > 0 || belowMinScore;

  if (!hasCriticalGap) return false;
  if (input.mode === 'pattern') return true;

  const hasExplicitRequestContract = Boolean(input.spec || input.request?.trim());
  return hasExplicitRequestContract && criticalMissing.length > 0;
}

async function checkRuntime(requirements: RuntimeRequirements): Promise<{
  ok: boolean;
  message: string;
  checks: Array<{ key: string; ok: boolean; message: string }>;
  missingConfig: Array<{ key: string; required: boolean; description: string }>;
}> {
  const topology = getRuntimeTopology();
  const checks: Array<{ key: string; ok: boolean; message: string }> = [];
  const missingConfig: Array<{ key: string; required: boolean; description: string }> = [];
  let ok = true;

  const n8n = new N8nService();
  const n8nOk = await n8n.getHealth();
  checks.push({ key: 'n8n', ok: n8nOk, message: n8nOk ? 'n8n reachable.' : 'n8n is not reachable.' });
  if (!n8nOk) ok = false;

  if (!process.env.N8N_API_KEY) {
    missingConfig.push({ key: 'N8N_API_KEY', required: true, description: 'Required for n8n API calls.' });
    ok = false;
  }

  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    checks.push({ key: 'mongo', ok: true, message: 'MongoDB reachable.' });
  } catch {
    checks.push({ key: 'mongo', ok: false, message: 'MongoDB is not reachable.' });
    ok = false;
  }

  if (requirements.requiresPublicWebhook) {
    const publicUrl = topology.n8nPublicWebhookBaseUrl;
    const publicOk = Boolean(publicUrl && !publicUrl.includes('localhost') && !publicUrl.includes('127.0.0.1'));
    checks.push({
      key: 'public_webhook',
      ok: publicOk,
      message: publicOk ? 'Public webhook base URL configured.' : 'Public webhook URL missing or local.',
    });
    if (!publicOk) {
      ok = false;
      missingConfig.push({
        key: 'N8N_PUBLIC_WEBHOOK_BASE_URL',
        required: true,
        description: 'Required before activating public webhooks.',
      });
    }
  }

  if (requirements.requiresOllama) {
    const ollamaOk = await fetch(`${topology.ollamaBaseUrlForN8n}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    }).then((res) => res.ok).catch(() => false);
    checks.push({ key: 'ollama', ok: ollamaOk, message: ollamaOk ? 'Ollama reachable.' : 'Ollama is not reachable.' });
    if (!ollamaOk) ok = false;
  }

  if (requirements.requiresMastraApi) {
    const mastraOk = await fetch(`${topology.mastraApiUrlForN8n.replace(/\/$/, '')}/api`, {
      signal: AbortSignal.timeout(3000),
    }).then((res) => res.status < 500).catch(() => false);
    checks.push({
      key: 'mastra_api',
      ok: mastraOk,
      message: mastraOk ? 'Mastra API reachable.' : 'Mastra API is not reachable.',
    });
    if (!mastraOk) ok = false;
  }

  if (requirements.requiresTelegram && !process.env.N8N_TELEGRAM_CHAT_ID && !process.env.TELEGRAM_CHAT_ID) {
    missingConfig.push({
      key: 'N8N_TELEGRAM_CHAT_ID',
      required: true,
      description: 'Required for Telegram send nodes.',
    });
    ok = false;
  }

  return {
    ok,
    checks,
    missingConfig,
    message: ok ? 'Runtime checks passed.' : 'Runtime checks blocked automation deployment.',
  };
}

function withVerdict(result: ReturnType<typeof analyzeWorkflow>): ReturnType<typeof analyzeWorkflow> & {
  verdict: 'approve' | 'review' | 'block';
} {
  return {
    ...result,
    verdict: result.score >= 80 ? 'block' : result.score >= 20 ? 'review' : 'approve',
  };
}

function blocksDraftDeploy(validation: ValidationResult, input: AutomationGoldenPathInput): boolean {
  const hasRequiredMissingCredentials = validation.missingCredentials.some((credential) => credential.required);
  return (
    validation.errors.length > 0 ||
    validation.securityIssues.length > 0 ||
    (input.allowDraftWithMissingCredentials === false && hasRequiredMissingCredentials)
  );
}

async function repairDraftBeforeDeploy(input: {
  automationId: string;
  workflow: any;
  validation: ValidationResult;
  attempt: number;
  allowDraftWithMissingCredentials?: boolean;
}): Promise<{
  attempts: number;
  changed: boolean;
  succeeded: boolean;
  workflow?: any;
  validation?: ValidationResult;
  changes: unknown[];
  remainingIssues?: TestFinding[];
  stopReason?: string;
  message: string;
}> {
  if (input.attempt > 3) {
    return {
      attempts: 0,
      changed: false,
      succeeded: false,
      changes: [],
      message: 'Draft repair skipped: max repair attempts already reached.',
    };
  }

  const findings = validationToFindings(input.validation);
  const repaired = applyRepairs(input.workflow, findings);
  const attempts = repaired.changes.length > 0 ? 1 : 0;

  if (attempts > 0) {
    const db = await getDb();
    await db.collection('automation_events').insertOne({
      automationId: input.automationId,
      type: 'repair_attempt',
      data: {
        stage: 'draft_validation',
        attempt: input.attempt,
        changes: repaired.changes,
      },
      createdAt: new Date(),
    });
  }

  if (!repaired.patchedWorkflow || repaired.changes.length === 0) {
    return {
      attempts,
      changed: false,
      succeeded: false,
      changes: repaired.changes,
      remainingIssues: repaired.remainingIssues,
      stopReason: repaired.stopReason,
      message: `No deterministic draft repair was possible: ${describeRepairResult(repaired)}.`,
    };
  }

  const normalizationWarnings = normalizeWorkflowForDeploy(repaired.patchedWorkflow);
  const nextValidation = validateWorkflow(repaired.patchedWorkflow, 'draft');
  if (normalizationWarnings.length > 0) {
    nextValidation.warnings = [
      ...nextValidation.warnings,
      ...normalizationWarnings.map((message) => ({ message, severity: 'warning' as const })),
    ];
  }

  const hasRequiredMissingCredentials = nextValidation.missingCredentials.some((credential) => credential.required);
  const stillBlocked =
    nextValidation.errors.length > 0 ||
    nextValidation.securityIssues.length > 0 ||
    (input.allowDraftWithMissingCredentials === false && hasRequiredMissingCredentials);
  return {
    attempts,
    changed: true,
    succeeded: !stillBlocked,
    workflow: repaired.patchedWorkflow,
    validation: nextValidation,
    changes: repaired.changes,
    remainingIssues: repaired.remainingIssues,
    stopReason: repaired.stopReason,
    message: stillBlocked
      ? `Draft repair changed the workflow, but draft validation still blocks deploy: ${describeRepairResult(repaired)}.`
      : 'Draft repair resolved blocking validation issues before deploy.',
  };
}

function selectValidationRecoveryStrategy(validation: ValidationResult, stopReason?: string): string {
  return selectRecoveryStrategy(validationToFindings(validation), stopReason);
}

function selectMockTestRecoveryStrategy(findings: TestFinding[], stopReason?: string): string {
  return selectRecoveryStrategy(findings, stopReason);
}

function selectRecoveryStrategy(findings: TestFinding[], stopReason?: string): string {
  if (stopReason === 'manual_connection_mapping_required') return 'manual_connection_mapping_required';
  if (stopReason === 'connection_graph_repair_required') return 'connection_graph_repair';
  if (stopReason === 'unsupported_n8n_vars') return 'unsupported_n8n_vars_rewrite';

  const text = findings.map((finding) => `${finding.message} ${finding.suggestedFix ?? ''}`).join('\n').toLowerCase();
  if (/connection references unknown source|references unknown target|missing target node/.test(text)) {
    return 'connection_id_to_name_repair';
  }
  if (/not reachable|disconnected|trigger path|no trigger node/.test(text)) return 'connection_graph_repair';
  if (/\$vars/.test(text)) return 'unsupported_n8n_vars_rewrite';
  if (/credential|chatid|telegram|gmail|mongo/.test(text)) return 'credential_or_config_repair';
  if (/localhost:3000|af-mongodb|\$vars|executionorder|active=false/.test(text)) return 'runtime_topology_repair';
  if (/security|auth|webhook/.test(text)) return 'security_repair_or_escalation';
  return 'structural_workflow_repair';
}

function describeRepairResult(result: RepairResult): string {
  const issue = result.remainingIssues[0];
  if (issue) return `${result.stopReason ?? 'remaining_issues'}: ${issue.message}`;
  return result.stopReason ?? 'no_changes_possible';
}

async function deployWorkflow(input: {
  automationId: string;
  workflow: any;
  workflowId?: string;
  approvalToken?: string;
  dashboardApprovalExempt: boolean;
  validation: ValidationResult;
  risk: ReturnType<typeof analyzeWorkflow> & { verdict: 'approve' | 'review' | 'block' };
}): Promise<{
  automationId: string;
  workflowId: string;
  workflowName: string;
  operation: 'create' | 'update';
  workflow: any;
  message: string;
}> {
  const db = await getDb();
  const n8n = new N8nService();
  let workflowId = input.workflowId;
  let operation: 'create' | 'update' = workflowId ? 'update' : 'create';
  let automationId = input.automationId;
  let existingOwner: any;

  if (!workflowId) {
    const expectedName = ensureMastraName(input.workflow.name);
    const existing = await n8n.listWorkflows();
    const match = existing.find((workflow) => workflow.name === expectedName || workflow.name === input.workflow.name);
    if (match) {
      const owner = await db.collection('automation_requests').findOne(
        { n8nWorkflowId: match.id },
        { sort: { createdAt: 1 } },
      );
      if (!owner || owner.managedBy !== 'mastra') {
        throw new Error(`Workflow name already exists but is not Mastra-managed: ${match.name} (${match.id}).`);
      }
      existingOwner = owner;
      workflowId = match.id;
      operation = 'update';
    }
  }

  if (workflowId) {
    existingOwner = existingOwner ?? await db.collection('automation_requests').findOne(
      { n8nWorkflowId: workflowId },
      { sort: { createdAt: 1 } },
    );
    if (existingOwner && existingOwner.managedBy !== 'mastra') {
      throw new Error(`Workflow ${workflowId} is not managed by Mastra.`);
    }
    if (existingOwner?.automationId && existingOwner.automationId !== automationId) {
      automationId = existingOwner.automationId;
    }
  }

  if (!input.dashboardApprovalExempt && input.risk.verdict === 'review' && input.approvalToken) {
    const approval = await db.collection('approvals').findOne({ id: input.approvalToken });
    if (!approval || approval.status !== 'approved') {
      throw new Error(`Invalid or unapproved approvalToken: ${input.approvalToken}`);
    }
  }

  let workflowForWrite = input.workflow;
  if (workflowId) {
    const existingWorkflow = await n8n.getWorkflow(workflowId).catch(() => null);
    if (existingWorkflow) {
      workflowForWrite = preserveExistingNodeCredentials(workflowForWrite, existingWorkflow);
    }
  }

  const payload = {
    ...workflowForWrite,
    name: ensureMastraName(workflowForWrite.name),
    active: false,
    settings: workflowForWrite.settings || { executionOrder: 'v1' },
  };

  let saved: any;
  if (workflowId) {
    saved = await n8n.updateWorkflow(workflowId, payload);
  } else {
    saved = await n8n.createWorkflow(payload);
    workflowId = saved.id;
  }

  if (!workflowId) throw new Error('n8n did not return a workflow id.');

  await db.collection('automation_requests').updateOne(
    { automationId },
    {
      $set: {
        automationId,
        n8nWorkflowId: workflowId,
        name: payload.name,
        status: 'draft_created',
        riskScore: input.risk.score,
        riskVerdict: input.risk.verdict,
        validation: input.validation,
        managedBy: 'mastra',
        lastSnapshot: payload,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  await db.collection('automation_workflow_snapshots').insertOne({
    automationId,
    n8nWorkflowId: workflowId,
    version: new Date().toISOString(),
    workflow: payload,
    createdAt: new Date(),
  }).catch(() => undefined);

  const workflow = await n8n.getWorkflow(workflowId);
  return {
    automationId,
    workflowId,
    workflowName: payload.name,
    operation,
    workflow,
    message: `Workflow ${operation === 'create' ? 'created' : 'updated'} as inactive draft (${workflowId}).`,
  };
}

async function runMockTest(
  automationId: string,
  workflowId: string,
  workflow: any,
): Promise<AutomationGoldenPathTestResult> {
  const validation = validateWorkflow(workflow, 'strict');
  const findings = validationToFindings(validation);
  const mock = generateMockPayload(workflow);
  const status = validation.valid ? 'passed' : 'failed';
  const db = await getDb();

  await db.collection('automation_events').insertOne({
    automationId,
    type: 'test_run',
    data: { mode: 'mock', status, findings },
    createdAt: new Date(),
  });
  await db.collection('automation_requests').updateOne(
    { automationId },
    {
      $set: {
        lastTest: { mode: 'mock', status, findings, workflowId, at: new Date() },
        updatedAt: new Date(),
      },
    },
  );

  return {
    mode: 'mock',
    status,
    findings,
    testPlan: [`Trigger detected: ${mock.triggerType}`, ...mock.instructions],
  };
}

function validationToFindings(validation: ValidationResult): TestFinding[] {
  const out: TestFinding[] = [];
  const add = (severity: 'error' | 'warning' | 'info', item: ValidationFinding, prefix = '') => {
    out.push({
      severity,
      nodeName: item.nodeName,
      message: `${prefix}${item.message}`,
    });
  };
  validation.errors.forEach((item) => add('error', item));
  validation.securityIssues.forEach((item) => add('error', item, '[security] '));
  validation.warnings.forEach((item) => add('warning', item));
  validation.missingCredentials.forEach((item) => {
    out.push({
      severity: item.required ? 'error' : 'warning',
      message: `Missing credential: ${item.service}`,
      suggestedFix: item.setupHint,
    });
  });
  validation.missingConfig.forEach((item) => {
    out.push({
      severity: item.required ? 'error' : 'warning',
      message: `Missing config: ${item.key}`,
      suggestedFix: item.description,
    });
  });
  return out;
}

async function repairAndRedeploy(input: {
  automationId: string;
  workflowId: string;
  workflow: any;
  findings: TestFinding[];
  attempt: number;
  approvalToken?: string;
  dashboardApprovalExempt: boolean;
}): Promise<{
  success: boolean;
  changed: boolean;
  changes: unknown[];
  workflow?: any;
  message: string;
  stopReason?: string;
  strategyName?: string;
}> {
  const db = await getDb();
  const repaired = applyRepairs(input.workflow, input.findings);
  const strategyName = selectMockTestRecoveryStrategy(input.findings, repaired.stopReason);

  await db.collection('automation_events').insertOne({
    automationId: input.automationId,
    type: 'repair_attempt',
    data: { attempt: input.attempt, strategyName, stopReason: repaired.stopReason, changes: repaired.changes },
    createdAt: new Date(),
  });

  if (!repaired.patchedWorkflow || repaired.changes.length === 0) {
    return {
      success: false,
      changed: false,
      changes: [],
      stopReason: repaired.stopReason,
      strategyName,
      message: `No deterministic repair was possible: ${describeRepairResult(repaired)}.`,
    };
  }

  normalizeWorkflowForDeploy(repaired.patchedWorkflow);
  const validation = validateWorkflow(repaired.patchedWorkflow, 'draft');
  if (validation.errors.length > 0 || validation.securityIssues.length > 0) {
    return {
      success: false,
      changed: true,
      changes: repaired.changes,
      workflow: repaired.patchedWorkflow,
      stopReason: repaired.stopReason,
      strategyName,
      message: `Repair produced workflow that still fails draft validation: ${describeRepairResult(repaired)}.`,
    };
  }

  const risk = withVerdict(analyzeWorkflow(repaired.patchedWorkflow));
  if (
    risk.verdict === 'block'
    || (risk.verdict === 'review' && !input.dashboardApprovalExempt && !input.approvalToken)
  ) {
    return {
      success: false,
      changed: true,
      changes: repaired.changes,
      workflow: repaired.patchedWorkflow,
      stopReason: repaired.stopReason,
      strategyName,
      message: `Repair blocked by risk verdict=${risk.verdict}.`,
    };
  }

  const deployed = await deployWorkflow({
    automationId: input.automationId,
    workflowId: input.workflowId,
    workflow: repaired.patchedWorkflow,
    approvalToken: input.approvalToken,
    dashboardApprovalExempt: input.dashboardApprovalExempt,
    validation,
    risk,
  });

  return {
    success: true,
    changed: true,
    changes: repaired.changes,
    workflow: deployed.workflow,
    stopReason: repaired.stopReason,
    strategyName,
    message: `Repair attempt ${input.attempt} deployed.`,
  };
}

async function activateIfAllowed(input: {
  automationId: string;
  workflowId: string;
  approvalToken?: string;
  dashboardApprovalExempt: boolean;
}): Promise<{ success: boolean; message: string; data?: Record<string, unknown> }> {
  const db = await getDb();
  const automation = await db.collection('automation_requests').findOne({ automationId: input.automationId });
  if (!automation || automation.managedBy !== 'mastra') {
    return { success: false, message: 'Activation blocked: automation is not Mastra-managed.' };
  }

  const n8n = new N8nService();
  const workflow = await n8n.getWorkflow(input.workflowId);
  const validation = validateWorkflow(workflow, 'activation');
  const risk = withVerdict(analyzeWorkflow(workflow));
  const reasons = activationReasons(workflow, risk.score);

  if (!validation.valid || validation.securityIssues.length > 0) {
    return {
      success: false,
      message: 'Activation blocked: validation failed.',
      data: { validation },
    };
  }

  if (risk.verdict === 'block') {
    return {
      success: false,
      message: `Activation blocked: risk score=${risk.score}.`,
      data: { risk },
    };
  }

  if (
    !input.dashboardApprovalExempt
    && (risk.verdict === 'review' || reasons.length > 0)
    && !input.approvalToken
  ) {
    return {
      success: false,
      message: `Activation requires approval: ${reasons.join('; ') || `risk score ${risk.score}`}`,
      data: { risk, reasons },
    };
  }

  if (!input.dashboardApprovalExempt && input.approvalToken) {
    const approval = await db.collection('approvals').findOne({ id: input.approvalToken });
    if (!approval || approval.status !== 'approved') {
      return { success: false, message: `Invalid or unapproved approvalToken: ${input.approvalToken}` };
    }
  }

  await n8n.activateWorkflow(input.workflowId);
  await db.collection('automation_requests').updateOne(
    { automationId: input.automationId },
    {
      $set: {
        status: 'active',
        activatedAt: new Date(),
        updatedAt: new Date(),
        activationRisk: risk,
        activationValidation: validation,
      },
    },
  );

  return { success: true, message: `Workflow activated (${input.workflowId}).`, data: { risk } };
}

function activationReasons(workflow: any, score: number): string[] {
  const reasons: string[] = [];
  const nodes: any[] = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  if (score >= 20) reasons.push(`risk score ${score} requires review`);

  for (const node of nodes) {
    const type = String(node.type || '');
    const params = node.parameters || {};
    if (['n8n-nodes-base.emailSend', 'n8n-nodes-base.gmail', 'n8n-nodes-base.slack', 'n8n-nodes-base.mongoDb'].includes(type)) {
      reasons.push(`node ${node.name || type} can write/send external data`);
    }
    if (type === 'n8n-nodes-base.httpRequest') {
      const method = String(params.method || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        reasons.push(`HTTP node ${node.name || type} uses method ${method}`);
      }
    }
    if (type === 'n8n-nodes-base.webhook' && (params.authentication || 'none') === 'none') {
      reasons.push(`webhook ${node.name || type} has no authentication`);
    }
  }

  return [...new Set(reasons)];
}

async function markAutomationStatus(
  automationId: string,
  status: AutomationGoldenPathStatus,
  workflowId?: string,
): Promise<void> {
  const db = await getDb();
  await db.collection('automation_requests').updateOne(
    { automationId },
    {
      $set: {
        status,
        ...(workflowId ? { n8nWorkflowId: workflowId } : {}),
        updatedAt: new Date(),
      },
    },
  );
}

function ensureMastraName(name: string): string {
  return name?.startsWith('Mastra - ') ? name : `Mastra - ${name || 'Untitled Automation'}`;
}

function buildResult(input: Omit<AutomationGoldenPathResult, 'operation'> & {
  operation?: 'create' | 'update';
}): AutomationGoldenPathResult {
  // WS-C-hard — a deployable deliverable exists (workflow reached tested/draft/active).
  // Latch it run-scoped so the Strategy Reflector converges and finalizes instead of
  // letting the architect churn/hang on execute_automation_request after success.
  if (
    (input.status === 'tested' || input.status === 'draft_created' || input.status === 'active')
    && input.workflowId
  ) {
    markAutomationDeliverable(input.status, {
      automationId: input.automationId,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      message: input.message,
      riskScore: input.risk?.score,
      riskVerdict: input.risk?.verdict,
      missingConfig: input.missingConfig,
      missingCredentials: input.missingCredentials,
      // `lastTest.mode` is typed `'mock'` because this path only ever mock-tests
      // — its own success message says "deployed as inactive draft and passed
      // mock test". Passing it through is what lets the finalize lever decline to
      // close a run whose brief asked for a real end-to-end execution.
      testMode: input.lastTest?.mode,
    });
  }
  return {
    success: input.success,
    status: input.status,
    failureClass: input.failureClass,
    automationId: input.automationId,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    operation: input.operation,
    message: input.message,
    steps: input.steps,
	    validation: input.validation,
	    risk: input.risk,
	    coverage: input.coverage,
	    lastTest: input.lastTest,
    missingConfig: input.missingConfig,
    missingCredentials: input.missingCredentials,
    recoveryStrategies: input.recoveryStrategies,
    repairAttempts: input.repairAttempts,
    error: input.error,
  };
}
