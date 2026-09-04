/**
 * Log-only policy layer for coding harness tool actions.
 *
 * The first rollout is intentionally non-blocking. Decisions record what the
 * harness would allow, warn about, or block once enforcement is enabled, while
 * `effectiveAllow` remains true in log-only mode.
 */

import { randomUUID } from 'crypto';
import { isAbsolute, normalize, relative, resolve, sep } from 'path';

import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../config/agent-ids.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { classifyCommand, normalizeCommand } from '../workspaces/command-safety.js';
import { checkPathInsideRoot } from '../lib/path-containment.js';
import { logHarnessEvent } from './harness-events.js';
import { classifyBrowserTargetForRun, isTier1Element } from '../config/browser-surfaces.js';

export type HarnessPolicyAction =
  | 'read_file'
  | 'write_file'
  | 'run_command'
  | 'apply_patch'
  | 'network'
  | 'git'
  | 'approval'
  | 'memory_write'
  // ── Automation Architect actions ──
  | 'deploy_automation'
  | 'activate_automation'
  | 'test_automation'
  | 'compose_automation'
  // ── Computer Use & Browser Substrate actions ──
  // `browser:navigate` / `browser:interact` are wired to real Playwright MCP
  // tool calls (see `services/browser-tool-policy-wrapper.ts`) — target-scoped
  // via `classifyBrowserTargetForRun`. `computer_use:*` and `browser:session_auth`
  // are forward-looking scaffolding for the deferred GUI computer-use substrate
  // (CU-3(b)); no caller invokes them yet.
  | 'computer_use:input'
  | 'computer_use:screen'
  | 'computer_use:clipboard'
  | 'browser:navigate'
  | 'browser:interact'
  | 'browser:evaluate'
  | 'browser:session_auth';

export type HarnessPolicyRisk = 'low' | 'medium' | 'high';
export type HarnessPolicySeverity = 'info' | 'warning' | 'block';
export type HarnessPolicyMode = 'off' | 'log_only' | 'enforce';

export type HarnessPolicyRequest = {
  runId?: string;
  turnId?: string;
  taskId?: string;
  subtaskId?: string;
  threadId?: string;
  agentId: string;
  toolId?: string;
  action: HarnessPolicyAction;
  target?: string;
  command?: string;
  riskHint?: HarnessPolicyRisk;
};

export type HarnessPolicyDecision = {
  id: string;
  allow: boolean;
  effectiveAllow: boolean;
  requiresApproval: boolean;
  severity: HarnessPolicySeverity;
  reason: string;
  approvalType?: string;
  matchedRule: string;
  enforcementMode: HarnessPolicyMode;
  enforced: boolean;
};

type CodingTaskScope = {
  artifactExists: boolean;
  worktreePath?: string;
};

const DEFAULT_POLICY_MODE: HarnessPolicyMode = 'log_only';

export function getHarnessPolicyMode(): HarnessPolicyMode {
  if (!isHarnessFeatureEnabled('FEATURE_HARNESS_POLICY', true)) return 'off';

  const requestedMode = process.env.HARNESS_POLICY_MODE?.trim().toLowerCase();
  if (requestedMode === 'off' || requestedMode === 'disabled') return 'off';
  if (requestedMode === 'enforce' || requestedMode === 'enforced') return 'enforce';
  return DEFAULT_POLICY_MODE;
}

export async function evaluateAndLogHarnessPolicy(
  request: HarnessPolicyRequest,
): Promise<HarnessPolicyDecision> {
  const enforcementMode = getHarnessPolicyMode();
  const baseDecision = enforcementMode === 'off'
    ? allowDecision('policy_disabled', 'Harness policy is disabled.')
    : await safeEvaluatePolicy(request);

  const decision = applyEnforcementMode(baseDecision, enforcementMode);
  if (enforcementMode !== 'off') {
    await logPolicyDecision(request, decision);
  }

  return decision;
}

function applyEnforcementMode(
  decision: Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>,
  enforcementMode: HarnessPolicyMode,
): HarnessPolicyDecision {
  const enforced = enforcementMode === 'enforce' && !decision.allow;
  return {
    ...decision,
    id: randomUUID(),
    enforcementMode,
    enforced,
    effectiveAllow: enforcementMode === 'enforce' ? decision.allow : true,
  };
}

async function safeEvaluatePolicy(
  request: HarnessPolicyRequest,
): Promise<Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>> {
  try {
    return await evaluatePolicy(request);
  } catch (error) {
    return allowDecision(
      'policy_evaluation_failed',
      `Policy evaluation failed and was treated as log-only allow: ${(error as Error).message}`,
      'warning',
    );
  }
}

async function evaluatePolicy(
  request: HarnessPolicyRequest,
): Promise<Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>> {
  switch (request.action) {
    case 'read_file':
      return evaluateReadFilePolicy(request);
    case 'write_file':
      return evaluateWriteFilePolicy(request);
    case 'run_command':
      return evaluateCommandPolicy(request);
    case 'apply_patch':
      return requireApprovalDecision(
        'apply_patch_requires_approval',
        'Applying a worktree patch mutates the live repository and should require approval.',
        'merge_live_repo',
        'warning',
      );
    case 'network':
      return requireApprovalDecision(
        'network_requires_approval',
        'Network access should require approval before enforcement mode is enabled.',
        'network',
      );
    case 'git':
      return requireApprovalDecision(
        'git_mutation_requires_approval',
        'Git mutation should require approval before enforcement mode is enabled.',
        'git_mutation',
      );
    case 'approval':
    case 'memory_write':
      return allowDecision(`${request.action}_allowed`, `${request.action} is allowed and logged.`);
    // ── Automation Architect actions ──
    case 'deploy_automation':
      if (isAutomationArchitectRequest(request)) {
        return allowDecision(
          'automation_architect_deploy_allowed',
          'Automation Architect deploys through deterministic ownership, validation and risk guardrails; no separate dashboard approval is required.',
          'warning',
        );
      }
      return requireApprovalDecision(
        'deploy_automation_requires_approval',
        'Deploying an n8n workflow modifies the automation runtime and should require approval.',
        'deploy_automation',
        'warning',
      );
    case 'activate_automation':
      if (isAutomationArchitectRequest(request)) {
        return allowDecision(
          'automation_architect_activation_allowed',
          'Automation Architect may activate only the explicitly requested Mastra-managed workflow after validation and hard risk checks.',
          'warning',
        );
      }
      return requireApprovalDecision(
        'activate_automation_requires_approval',
        'Activating a workflow enables live execution of external-facing automation and should require approval.',
        'activate_automation',
        'warning',
      );
    case 'test_automation':
      return allowDecision(
        'test_automation_allowed',
        'Testing a workflow in mock/real mode is allowed and logged.',
        'warning',
      );
    case 'compose_automation':
      return allowDecision('compose_automation_allowed', 'Composing workflow JSON is a read-only operation.');
    // ── Computer Use & Browser Substrate actions ──
    case 'computer_use:input':
      return requireApprovalDecision(
        'computer_use_input_requires_approval',
        'Direct OS keyboard/mouse input requires approval.',
        'computer_use_input',
        'block',
      );
    case 'computer_use:screen':
      return allowDecision('computer_use_screen_allowed', 'Screen inspection/capture is allowed and logged.', 'info');
    case 'computer_use:clipboard':
      return requireApprovalDecision(
        'computer_use_clipboard_requires_approval',
        'Clipboard access requires approval.',
        'computer_use_clipboard',
        'warning',
      );
    case 'browser:navigate':
      // Navigation alone does not mutate anything; it establishes the target
      // classification that the FOLLOWING interaction is judged against. Always
      // allowed, but the classification is surfaced in the reason for telemetry.
      return allowDecision(
        `browser_navigate_${classifyBrowserTargetForRun(request.target ?? '', request.runId)}`,
        `Navigation to ${safeText(request.target ?? '(no target)')} classified as ${classifyBrowserTargetForRun(request.target ?? '', request.runId)}.`,
        'info',
      );
    case 'browser:interact': {
      if (isTier1Element(request.command)) {
        return blockDecision(
          'browser_interact_tier1_element',
          `Tier-1 element (credential/payment/OTP/CAPTCHA field) is a hand-off, never an agent action: ${safeText(request.command ?? '')}`,
        );
      }
      const targetClass = classifyBrowserTargetForRun(request.target ?? '', request.runId);
      if (targetClass === 'blocked') {
        return blockDecision(
          'browser_interact_blocked_target',
          `Interaction target is a blocked SSRF/metadata/non-http surface: ${safeText(request.target ?? '')}`,
        );
      }
      if (targetClass === 'own_workspace') {
        return allowDecision(
          'browser_interact_own_workspace',
          `Interacting with a port this run started (${safeText(request.target ?? '')}).`,
          'info',
        );
      }
      const approvalType = targetClass === 'own_live_data' ? 'browser_interact_live_surface' : 'browser_interact_external';
      return requireApprovalDecision(
        `${approvalType}_requires_approval`,
        targetClass === 'own_live_data'
          ? `Interacting with a known live/production surface requires approval: ${safeText(request.target ?? '')}`
          : `Interacting with an external or unregistered target requires approval: ${safeText(request.target ?? '')}`,
        approvalType,
        'warning',
      );
    }
    case 'browser:evaluate':
      return requireApprovalDecision(
        'browser_evaluate_requires_approval',
        'Browser JavaScript evaluation is a high-risk action requiring approval.',
        'browser_evaluate',
        'warning',
      );
    case 'browser:session_auth':
      return requireApprovalDecision(
        'browser_session_auth_requires_approval',
        'Browser session authentication / login action requires approval.',
        'browser_session_auth',
        'block',
      );
  }
}

function isAutomationArchitectRequest(request: HarnessPolicyRequest): boolean {
  return canonicalizeRuntimeAgentId(request.agentId) === AUTOMATION_ARCHITECT_AGENT_ID;
}

async function evaluateReadFilePolicy(
  request: HarnessPolicyRequest,
): Promise<Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>> {
  const target = request.target?.trim();
  if (!target) {
    return blockDecision('read_target_missing', 'Read action did not include a target path.');
  }

  const scope = await getCodingTaskScope(request.taskId);
  const rootPath = scope.worktreePath ?? AGENTIC_AGENTS_REPO;
  const pathCheck = checkPathInsideRoot(target, rootPath);
  if (!pathCheck.inside) {
    return blockDecision('read_outside_workspace', `Read target is outside coding workspace: ${safeText(target)}`);
  }

  if (isBlockedRepoPath(pathCheck.relativePath)) {
    return blockDecision('read_blocked_path', `Read target is blocked by policy: ${pathCheck.relativePath}`);
  }

  return allowDecision('read_workspace_file', `Read target is inside ${scope.worktreePath ? 'task worktree' : 'repo workspace'}.`);
}

async function evaluateWriteFilePolicy(
  request: HarnessPolicyRequest,
): Promise<Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>> {
  const target = request.target?.trim();
  if (!target) {
    return blockDecision('write_target_missing', 'Write action did not include a target path.');
  }

  const scope = await getCodingTaskScope(request.taskId);
  if (!request.taskId) {
    return blockDecision('write_missing_task', 'Write action did not include taskId; task worktree cannot be verified.');
  }
  if (!scope.artifactExists) {
    return blockDecision('write_missing_artifact', `Task artifact does not exist for ${request.taskId}.`);
  }
  if (!scope.worktreePath) {
    return blockDecision(
      'write_without_worktree',
      `Write would target the live repository for ${request.taskId}. Run coding_init_worktree first.`,
    );
  }

  const pathCheck = checkPathInsideRoot(target, scope.worktreePath);
  if (!pathCheck.inside) {
    return blockDecision('write_outside_worktree', `Write target is outside task worktree: ${safeText(target)}`);
  }
  if (isBlockedRepoPath(pathCheck.relativePath)) {
    return blockDecision('write_blocked_path', `Write target is blocked by policy: ${pathCheck.relativePath}`);
  }

  return allowDecision('write_task_worktree', 'Write target is inside the task worktree.');
}

/**
 * One classification, shared with the workspace approval gate and with
 * `coding_run_test` (`workspaces/command-safety.ts`). It used to be a private
 * copy here, and the copies had drifted: `npm run build`, `npx vitest` and
 * `node --check` were allowed by this file and SUSPENDED by the workspace, while
 * `npm run check:all` was denied here and permitted by one of the two lists
 * inside `coding_run_test`.
 */
function evaluateCommandPolicy(
  request: HarnessPolicyRequest,
): Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'> {
  const command = normalizeCommand(request.command ?? '');
  if (!command) {
    return blockDecision('command_missing', 'Command action did not include a command.');
  }

  switch (classifyCommand(command)) {
    case 'destructive':
      return requireApprovalDecision(
        'destructive_command_requires_approval',
        `Destructive command requires approval: ${safeText(command)}`,
        'destructive_command',
        'block',
      );
    case 'git_mutation':
      return requireApprovalDecision(
        'git_mutation_requires_approval',
        `Git mutation requires approval: ${safeText(command)}`,
        'git_mutation',
      );
    case 'package_install':
      return requireApprovalDecision(
        'package_install_requires_approval',
        `Package install/update requires approval: ${safeText(command)}`,
        'package_install',
      );
    case 'network':
      return requireApprovalDecision(
        'network_command_requires_approval',
        `Network command requires approval: ${safeText(command)}`,
        'network',
      );
    case 'read_only':
      return allowDecision('readonly_command_allowed', 'Read-only command is allowed.');
    case 'safe_verification':
      return allowDecision('verification_command_allowed', 'Verification command is allowed.');
    default:
      return requireApprovalDecision(
        'unknown_command_requires_approval',
        `Unknown command should require approval before enforcement mode is enabled: ${safeText(command)}`,
        'unknown_command',
      );
  }
}

async function getCodingTaskScope(taskId: string | undefined): Promise<CodingTaskScope> {
  if (!taskId) return { artifactExists: false };
  const db = await getDb();
  const artifact = await db.collection('code_task_artifacts').findOne(
    { taskId },
    { projection: { worktreePath: 1 } },
  );

  return {
    artifactExists: Boolean(artifact),
    worktreePath: typeof artifact?.worktreePath === 'string' && artifact.worktreePath.trim()
      ? artifact.worktreePath
      : undefined,
  };
}

function allowDecision(
  matchedRule: string,
  reason: string,
  severity: HarnessPolicySeverity = 'info',
): Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'> {
  return {
    allow: true,
    requiresApproval: false,
    severity,
    reason,
    matchedRule,
  };
}

function requireApprovalDecision(
  matchedRule: string,
  reason: string,
  approvalType: string,
  severity: HarnessPolicySeverity = 'warning',
): Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'> {
  return {
    allow: false,
    requiresApproval: true,
    severity,
    reason,
    approvalType,
    matchedRule,
  };
}

function blockDecision(
  matchedRule: string,
  reason: string,
): Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'> {
  return {
    allow: false,
    requiresApproval: false,
    severity: 'block',
    reason,
    matchedRule,
  };
}


function isBlockedRepoPath(relativePath: string): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  return (
    normalizedPath === '.' ||
    normalizedPath === '.git' ||
    normalizedPath.startsWith('.git/') ||
    normalizedPath === 'node_modules' ||
    normalizedPath.startsWith('node_modules/') ||
    normalizedPath === '.env' ||
    normalizedPath.startsWith('.env.')
  );
}



async function logPolicyDecision(
  request: HarnessPolicyRequest,
  decision: HarnessPolicyDecision,
): Promise<void> {
  // Name the event after what ACTUALLY happened, not after the advisory verdict.
  // Under `log_only` a disallowed call still runs (`effectiveAllow` stays true),
  // and emitting `policy_blocked` for it made an un-enforced flag indistinguishable
  // from a real guardrail: the FX run of 2026-08-24 logged ~20 `policy_blocked`
  // shell calls (`cat /proc/<n8n>/environ`, `sudo -n cat`, `docker exec …`) that
  // every one of them executed, and the dashboard counted them as "Policy blocks".
  const eventType = decision.allow
    ? 'policy_allowed'
    : decision.effectiveAllow ? 'policy_flagged' : 'policy_blocked';
  await logHarnessEvent({
    type: eventType,
    agentId: request.agentId,
    runId: request.runId,
    turnId: request.turnId,
    threadId: request.threadId,
    taskId: request.taskId,
    subtaskId: request.subtaskId,
    feature: 'harness_policy',
    toolId: request.toolId,
    status: decision.effectiveAllow ? 'success' : 'error',
    input: policyPreview(request),
    errorMessage: decision.effectiveAllow ? undefined : decision.reason,
    data: {
      decisionId: decision.id,
      action: request.action,
      target: request.target ? safeText(request.target) : undefined,
      command: request.command ? safeText(request.command) : undefined,
      riskHint: request.riskHint,
      allow: decision.allow,
      effectiveAllow: decision.effectiveAllow,
      requiresApproval: decision.requiresApproval,
      severity: decision.severity,
      reason: decision.reason,
      approvalType: decision.approvalType,
      matchedRule: decision.matchedRule,
      enforcementMode: decision.enforcementMode,
      enforced: decision.enforced,
    },
  });
}

function policyPreview(request: HarnessPolicyRequest): string {
  const target = request.command ?? request.target ?? '';
  return safeText(`${request.action}${target ? `: ${target}` : ''}`, 500);
}

function safeText(text: string, maxLength = 300): string {
  const redacted = redactSecrets(text).text;
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}
