import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../../lib/mongo.js';
import { normalizeConnectionKeys, validateWorkflow } from '../validation/workflow-validator.js';
import { normalizeNodeParameters } from '../composer/graph-synthesizer.js';
import { getCredentialFromRegistry } from '../credentials/credential-registry.js';
import { getRuntimeTopology } from '../../../config/runtime-topology.js';
import type { RepairChange, RepairResult, TestFinding } from './test-types.js';
import type { ValidationResult } from '../validation/validation-types.js';
import { withToolEnvelope } from '../../../services/harness-tool-envelope.js';

const MAX_ATTEMPTS = 3;

export const repairWorkflowTool = createTool({
  id: 'architect_repair_workflow',
  description:
    'Attempts to minimally adapt workflow to errors from validate_workflow / test_workflow. Maximum 3 attempts per automationId. Does not generate workflow from scratch — only patches.',
  inputSchema: z.object({
    automationId: z.string(),
    workflow: z.any().describe('Current workflow JSON to repair'),
    findings: z
      .array(
        z.object({
          severity: z.enum(['error', 'warning', 'info']),
          nodeName: z.string().optional(),
          message: z.string(),
          suggestedFix: z.string().optional(),
        }),
      )
      .optional()
      .describe('Findings from validate_workflow or test_workflow'),
    attempt: z.number().int().min(1).max(MAX_ATTEMPTS).describe('Attempt number (1-3)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    automationId: z.string(),
    attempt: z.number(),
    patchedWorkflow: z.any().optional(),
    changes: z.array(
      z.object({
        nodeName: z.string().optional(),
        field: z.string(),
        reason: z.string(),
      }),
    ),
    remainingIssues: z.array(
      z.object({
        severity: z.enum(['error', 'warning', 'info']),
        nodeName: z.string().optional(),
        message: z.string(),
        suggestedFix: z.string().optional(),
      }),
    ),
    stopReason: z.string().optional(),
    message: z.string(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_repair_workflow',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['workflow'],
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'test_automation' as const, // treat repair as part of test loop
      target: input.automationId,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    const { automationId, attempt } = context;
    const db = await getDb();

    // Server-side guard: count past repair_attempt events.
    const pastAttempts = await db
      .collection('automation_events')
      .countDocuments({ automationId, type: 'repair_attempt' });
    if (pastAttempts >= MAX_ATTEMPTS) {
      return {
        success: false,
        automationId,
        attempt,
        changes: [],
        remainingIssues: [],
        stopReason: 'max_attempts_reached',
        message: `Max ${MAX_ATTEMPTS} repair attempts reached for ${automationId}. Requires manual intervention.`,
      };
    }

    const result = applyRepairs(context.workflow, context.findings ?? []);

    // Re-validate after patching to compute remaining issues for both deploy
    // draft validation and strict mock-test validation.
    const postWorkflow = result.patchedWorkflow ?? context.workflow;
    const draftValidation = validateWorkflow(postWorkflow, 'draft');
    const strictValidation = validateWorkflow(postWorkflow, 'strict');
    const remaining = dedupeFindings([
      ...result.remainingIssues,
      ...validationResultToRepairFindings(draftValidation),
      ...validationResultToRepairFindings(strictValidation),
    ]);

    await db.collection('automation_events').insertOne({
      automationId,
      type: 'repair_attempt',
      data: { attempt, changes: result.changes, remainingCount: remaining.length },
      createdAt: new Date(),
    });

    const success = result.changes.length > 0 && !remaining.some((issue) => issue.severity === 'error');

    return {
      success,
      automationId,
      attempt,
      patchedWorkflow: result.patchedWorkflow,
      changes: result.changes,
      remainingIssues: remaining,
      stopReason: result.stopReason,
      message: success
        ? `Workflow repaired (attempt ${attempt}/${MAX_ATTEMPTS}). Use deploy_automation to save the patch.`
        : result.changes.length === 0
          ? `No changes possible to apply automatically: ${describeRepairStop(result)}.`
          : `Workflow partially repaired (changes: ${result.changes.length}), but errors remain. Retry or manual intervention required.`,
    };
    }
  }),
});

export function applyRepairs(
  workflow: any,
  findings: { severity: string; nodeName?: string; message: string; suggestedFix?: string }[],
): RepairResult {
  const changes: RepairChange[] = [];

  if (!workflow || typeof workflow !== 'object') {
    return { success: false, changes, remainingIssues: [], stopReason: 'invalid_workflow_input' };
  }

  const patched = JSON.parse(JSON.stringify(workflow));
  const nodes: any[] = Array.isArray(patched.nodes) ? patched.nodes : [];
  const connectionRepairRequested = hasConnectionRepairSignal(findings);
  const topology = getRuntimeTopology();
  const mastraBase = topology.mastraApiUrlForN8n.replace(/\/$/, '');

  // 1. Always force inactive
  if (patched.active !== false) {
    patched.active = false;
    changes.push({ field: 'active', reason: 'Forced active=false (drafts must not auto-activate).' });
  }

  // 2. Always ensure settings.executionOrder
  if (!patched.settings || typeof patched.settings !== 'object') {
    patched.settings = { executionOrder: 'v1' };
    changes.push({ field: 'settings', reason: 'Added missing settings.executionOrder=v1.' });
  } else if (patched.settings.executionOrder !== 'v1') {
    patched.settings.executionOrder = 'v1';
    changes.push({ field: 'settings.executionOrder', reason: 'Forced settings.executionOrder=v1.' });
  }

  // 3. Per-node patches
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const params = node.parameters ?? {};

    // 3a. Telegram credential injection
    if (
      (node.type === 'n8n-nodes-base.telegram' || node.type === 'n8n-nodes-base.telegramTrigger') &&
      !node.credentials?.telegramApi
    ) {
      const cred = getCredentialFromRegistry('telegram');
      if (cred) {
        node.credentials = { ...(node.credentials ?? {}), telegramApi: { id: cred.id, name: cred.name } };
        changes.push({
          nodeName: node.name,
          field: 'credentials.telegramApi',
          reason: `Injected credential from registry (id=${cred.id}).`,
        });
      }
    }

    // 3b. Telegram empty chatId
    if (node.type === 'n8n-nodes-base.telegram' && (!params.chatId || params.chatId === '')) {
      const chatId = process.env.N8N_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        node.parameters = { ...params, chatId };
        changes.push({ nodeName: node.name, field: 'parameters.chatId', reason: 'Filled from N8N_TELEGRAM_CHAT_ID.' });
      }
    }

    // 3c. Mongo credential injection
    if (node.type === 'n8n-nodes-base.mongoDb' && !node.credentials?.mongoDb) {
      const cred = getCredentialFromRegistry('mongo');
      if (cred) {
        node.credentials = { ...(node.credentials ?? {}), mongoDb: { id: cred.id, name: cred.name } };
        changes.push({
          nodeName: node.name,
          field: 'credentials.mongoDb',
          reason: `Injected credential from registry (id=${cred.id}).`,
        });
      }
    }

    // 3d. Gmail credential injection / normalization
    if (node.type === 'n8n-nodes-base.gmail' || node.type === 'n8n-nodes-base.gmailTrigger') {
      if (node.credentials?.googleGmailOAuth2Api) {
        node.credentials.gmailOAuth2 = node.credentials.googleGmailOAuth2Api;
        delete node.credentials.googleGmailOAuth2Api;
        changes.push({
          nodeName: node.name,
          field: 'credentials.gmailOAuth2',
          reason: 'Normalized legacy googleGmailOAuth2Api to gmailOAuth2.',
        });
      }
      if (!node.credentials?.gmailOAuth2) {
        const cred = getCredentialFromRegistry('gmail');
        if (cred) {
          node.credentials = { ...(node.credentials ?? {}), [cred.n8nCredentialType]: { id: cred.id, name: cred.name } };
          changes.push({
            nodeName: node.name,
            field: `credentials.${cred.n8nCredentialType}`,
            reason: `Injected credential from registry (id=${cred.id}).`,
          });
        }
      }
    }

    // 3e. Replace localhost:3000 (legacy) with mastra API base
    const replaced = replaceInDeep(node.parameters, 'http://localhost:3000', mastraBase);
    if (replaced.changed) {
      node.parameters = replaced.value;
      changes.push({
        nodeName: node.name,
        field: 'parameters.*',
        reason: `Replaced legacy http://localhost:3000 with ${mastraBase}.`,
      });
    }

    // 3f. Replace af-mongodb in local-host-network mode
    if (topology.mode === 'local-host-network') {
      const mongoFix = replaceInDeep(node.parameters, 'af-mongodb', topology.mongoHostForN8n.split(':')[0]);
      if (mongoFix.changed) {
        node.parameters = mongoFix.value;
        changes.push({
          nodeName: node.name,
          field: 'parameters.*',
          reason: `Replaced af-mongodb with ${topology.mongoHostForN8n.split(':')[0]} (local-host-network).`,
        });
      }
    }

    // 3h. Canonical parameter normalization (Gmail message flattening, subject injection, Mongo DB/operation, Telegram chatId)
    const normalizedParams = normalizeNodeParameters(node.type, node.parameters);
    if (JSON.stringify(normalizedParams) !== JSON.stringify(node.parameters || {})) {
      node.parameters = normalizedParams;
      changes.push({
        nodeName: node.name,
        field: 'parameters',
        reason: 'Normalized node parameters to match n8n canonical contracts (e.g. subject, flattened message).',
      });
    }

    // 3g. Ensure unique name (rename duplicates by appending suffix)
    // Handled at workflow level below.
  }

  // 4. Deduplicate node names (rare but validation flags it)
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node?.name) continue;
    if (seen.has(node.name)) {
      const newName = `${node.name}_${Math.random().toString(36).slice(2, 6)}`;
      changes.push({ nodeName: node.name, field: 'name', reason: `Changed to ${newName} (duplicate).` });
      node.name = newName;
    }
    seen.add(node.name);
  }

  // 5. Normalize n8n connections from node.id/quoted refs to node.name.
  for (const reason of normalizeConnectionKeys(patched)) {
    changes.push({ field: 'connections', reason: `connection_id_to_name_repair: ${reason}` });
  }

  const draftValidation = validateWorkflow(patched, 'draft');
  const strictValidation = validateWorkflow(patched, 'strict');
  const connectionIssues = collectConnectionIssues(patched);
  const graphIssues = collectGraphIssues([...draftValidation.errors, ...strictValidation.errors]);
  const unsupportedVarsIssues = collectUnsupportedVarsIssues([...draftValidation.errors, ...strictValidation.errors]);
  const remainingIssues = dedupeFindings([
    ...connectionIssues.map((issue) => connectionIssueToFinding(issue, nodes)),
    ...graphIssues,
    ...unsupportedVarsIssues,
  ]);

  let stopReason: string | undefined;
  if (connectionIssues.length > 0 && (connectionRepairRequested || changes.some((change) => change.field === 'connections'))) {
    stopReason = 'manual_connection_mapping_required';
  } else if (graphIssues.length > 0 && connectionRepairRequested) {
    stopReason = 'connection_graph_repair_required';
  } else if (unsupportedVarsIssues.length > 0) {
    stopReason = 'unsupported_n8n_vars';
  } else if (changes.length === 0) {
    stopReason = 'no_changes_possible';
  }

  return {
    success: changes.length > 0,
    patchedWorkflow: patched,
    changes,
    remainingIssues,
    stopReason,
  };
}

type ConnectionIssue = {
  kind: 'unknown_source' | 'unknown_target' | 'missing_target';
  sourceName?: string;
  ref?: string;
};

function hasConnectionRepairSignal(findings: { message: string; suggestedFix?: string }[]): boolean {
  const text = findings.map((finding) => `${finding.message} ${finding.suggestedFix ?? ''}`).join('\n').toLowerCase();
  return /connection|not reachable|disconnected|trigger path|orphan/.test(text);
}

function collectConnectionIssues(workflow: any): ConnectionIssue[] {
  const nodes: any[] = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const nodeNames = new Set(nodes.map((node) => node?.name).filter((name): name is string => typeof name === 'string' && name.length > 0));
  const connections = workflow?.connections && typeof workflow.connections === 'object' && !Array.isArray(workflow.connections)
    ? workflow.connections
    : {};
  const issues: ConnectionIssue[] = [];

  for (const [sourceName, sourceConnections] of Object.entries(connections)) {
    if (!nodeNames.has(sourceName)) {
      issues.push({ kind: 'unknown_source', sourceName });
    }

    const main = (sourceConnections as any)?.main;
    if (!Array.isArray(main)) continue;

    for (const outputGroup of main) {
      if (!Array.isArray(outputGroup)) continue;
      for (const conn of outputGroup) {
        if (!conn || typeof conn !== 'object' || !conn.node) {
          issues.push({ kind: 'missing_target', sourceName });
        } else if (typeof conn.node === 'string' && !nodeNames.has(conn.node)) {
          issues.push({ kind: 'unknown_target', sourceName, ref: conn.node });
        }
      }
    }
  }

  return issues;
}

function connectionIssueToFinding(issue: ConnectionIssue, nodes: any[]): TestFinding {
  const knownNodeNames = nodes
    .map((node) => node?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort((a, b) => a.localeCompare(b));
  const known = knownNodeNames.length > 0 ? ` Known node names: ${knownNodeNames.join(', ')}.` : '';

  if (issue.kind === 'unknown_source') {
    return {
      severity: 'error',
      message: `manual_connection_mapping_required: connection source "${issue.sourceName}" does not match any node.id or node.name after normalization.`,
      suggestedFix: `Map source "${issue.sourceName}" to one of workflow.nodes[*].name or remove the stale connection.${known}`,
    };
  }

  if (issue.kind === 'unknown_target') {
    return {
      severity: 'error',
      nodeName: issue.sourceName,
      message: `manual_connection_mapping_required: connection target "${issue.ref}" from "${issue.sourceName}" does not match any node.id or node.name after normalization.`,
      suggestedFix: `Map target "${issue.ref}" to one of workflow.nodes[*].name or remove the stale edge.${known}`,
    };
  }

  return {
    severity: 'error',
    nodeName: issue.sourceName,
    message: `manual_connection_mapping_required: connection from "${issue.sourceName}" has no target node.`,
    suggestedFix: `Add a target node name under connections["${issue.sourceName}"].main or remove the empty edge.${known}`,
  };
}

function collectGraphIssues(errors: { message: string; nodeName?: string }[]): TestFinding[] {
  return errors
    .filter((error) => /not reachable|disconnected|trigger path|no trigger node/i.test(error.message))
    .map((error) => ({
      severity: 'error' as const,
      nodeName: error.nodeName,
      message: `connection_graph_repair_required: ${error.message}`,
      suggestedFix: 'Connect every executable node to a trigger path, or model this workflow as a subworkflow with executeWorkflowTrigger.',
    }));
}

function collectUnsupportedVarsIssues(errors: { message: string; nodeName?: string }[]): TestFinding[] {
  return errors
    .filter((error) => /\$vars\.\*/i.test(error.message))
    .map((error) => ({
      severity: 'error' as const,
      nodeName: error.nodeName,
      message: `unsupported_n8n_vars: ${error.message}`,
      suggestedFix: 'n8n Community Edition does not support $vars.*. Replace it with an explicit value from runtime topology, env/config builder or n8n credential.',
    }));
}

function dedupeFindings(findings: TestFinding[]): TestFinding[] {
  const seen = new Set<string>();
  const out: TestFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.severity}|${finding.nodeName ?? ''}|${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function validationResultToRepairFindings(validation: ValidationResult): TestFinding[] {
  return [
    ...validation.errors.map((item) => ({ severity: 'error' as const, nodeName: item.nodeName, message: item.message })),
    ...validation.securityIssues.map((item) => ({ severity: 'error' as const, nodeName: item.nodeName, message: item.message })),
    ...validation.missingCredentials.map((item) => ({
      severity: item.required ? 'error' as const : 'warning' as const,
      message: `Missing credential: ${item.service}`,
      suggestedFix: item.setupHint,
    })),
    ...validation.missingConfig.map((item) => ({
      severity: item.required ? 'error' as const : 'warning' as const,
      message: `Missing config: ${item.key}`,
      suggestedFix: item.description,
    })),
  ];
}

function describeRepairStop(result: RepairResult): string {
  const issue = result.remainingIssues[0];
  if (issue) return `${result.stopReason ?? 'no_changes_possible'}: ${issue.message}`;
  return result.stopReason ?? 'no_changes_possible';
}

function replaceInDeep(value: unknown, search: string, replacement: string): { value: any; changed: boolean } {
  if (typeof value === 'string') {
    if (value.includes(search)) {
      return { value: value.split(search).join(replacement), changed: true };
    }
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = replaceInDeep(item, search, replacement);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = replaceInDeep(v, search, replacement);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}
