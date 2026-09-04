/**
 * Tool: architect.risk_score
 * Analyzes n8n workflow JSON for security and risk.
 * Returns risk score, findings list, and verdict (approve/review/block).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { compactAutomationResultForModel } from '../../services/automation-output-compaction.js';
import { TRIGGER_TYPES, FORBIDDEN_NODE_TYPES } from './validation/node-registry.js';

// ── Forbidden node types that immediately raise risk ───────────────────────
// Sourced from node-registry.ts's FORBIDDEN_NODE_TYPES — the same list the
// Golden Path's forbidden_node_policy gate enforces at deploy time (see
// automation-golden-path.ts). This used to be a separately hand-maintained
// list here that drifted from node-registry.ts (missing readWriteFile and
// executeSsh), so validateWorkflowTool/riskScoringTool could hand back a
// clean "risk low, verdict approve" for a workflow the Golden Path would
// then hard-block on deploy with no approval override. Keep this a single
// source of truth so the two never disagree again.
const CRITICAL_NODE_TYPES = new Set<string>(FORBIDDEN_NODE_TYPES);
// Not policy-forbidden, but warrants review (can invoke arbitrary sub-workflows).
const REVIEW_ONLY_NODE_TYPES = new Set(['n8n-nodes-base.executeWorkflow']);

const HIGH_RISK_PATTERNS = [
  { pattern: /eval\s*\(/, label: 'eval() in code node' },
  { pattern: /new Function\s*\(/, label: 'new Function() in code node' },
  { pattern: /require\s*\(\s*['"]child_process/, label: 'child_process import' },
  { pattern: /require\s*\(\s*['"]fs/, label: 'fs module import' },
  { pattern: /process\.env\s*\[/, label: 'dynamic env access' },
  { pattern: /\$\$secret|apiKey|api_key|password|passwd|token/i, label: 'possible hardcoded secret' },
  { pattern: /Bearer\s+[A-Za-z0-9+/]{20,}/, label: 'hardcoded Bearer token' },
  { pattern: /[A-Za-z0-9]{32,}/, label: 'possible hardcoded key (long string)' },
];

const CRITICAL_CODE_PATTERNS = [
  { pattern: /\$helpers\.executeCommand(?:Sync)?\s*\(/, label: '$helpers.executeCommand* in code/function node' },
];

const MEDIUM_RISK_PATTERNS = [
  { pattern: /\$json\..*\$\$/, label: 'unsanitized user input in expression' },
  { pattern: /http:\/\/(?!localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i, label: 'plain HTTP to external host' },
  { pattern: /\*\s+\*\s+\*\s+\*\s+\*/, label: 'cron every minute (rate limit concern)' },
];

interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  code: string;
  message: string;
  location?: string;
}

function scoreFromSeverity(sev: Finding['severity']): number {
  return { critical: 80, high: 30, medium: 15, low: 5, info: 0 }[sev];
}

export function analyzeWorkflow(workflowJson: unknown): { score: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let score = 0;

  // Must be an object
  if (typeof workflowJson !== 'object' || workflowJson === null || Array.isArray(workflowJson)) {
    findings.push({ severity: 'high', code: 'INVALID_JSON', message: 'Workflow JSON is not a plain object' });
    return { score: 30, findings };
  }

  const wf = workflowJson as Record<string, unknown>;

  // ── Structural checks ────────────────────────────────────────────────────
  if (!Array.isArray(wf.nodes)) {
    findings.push({ severity: 'medium', code: 'NO_NODES', message: 'Workflow has no nodes array' });
    score += 15;
  }
  if (!wf.connections || typeof wf.connections !== 'object') {
    findings.push({ severity: 'low', code: 'NO_CONNECTIONS', message: 'Workflow has no connections object' });
    score += 5;
  }
  if ((wf.settings as any)?.executionOrder !== 'v1') {
    findings.push({ severity: 'info', code: 'EXEC_ORDER', message: 'settings.executionOrder is not "v1"' });
  }

  // ── active: true check ───────────────────────────────────────────────────
  if ((wf as any).active === true) {
    findings.push({
      severity: 'medium',
      code: 'ACTIVE_ON_CREATE',
      message: 'Workflow has active:true — n8n API rejects this on creation',
    });
    score += 15;
  }

  const nodes = (Array.isArray(wf.nodes) ? wf.nodes : []) as Array<Record<string, unknown>>;

  // ── Node-level checks ────────────────────────────────────────────────────
  const nodeNames = new Set<string>();
  const nodeIds = new Set<string>();

  for (const node of nodes) {
    const nodeType = String(node.type ?? '');
    const nodeName = String(node.name ?? '');
    const nodeId = String(node.id ?? '');

    // Duplicate names
    if (nodeName && nodeNames.has(nodeName)) {
      findings.push({ severity: 'high', code: 'DUPLICATE_NODE_NAME', message: `Duplicate node name: "${nodeName}"`, location: nodeName });
      score += 30;
    }
    nodeNames.add(nodeName);

    if (nodeId && nodeIds.has(nodeId)) {
      findings.push({ severity: 'high', code: 'DUPLICATE_NODE_ID', message: `Duplicate node id: "${nodeId}"`, location: nodeName });
      score += 30;
    }
    nodeIds.add(nodeId);

    // Forbidden node types
    if (CRITICAL_NODE_TYPES.has(nodeType) || REVIEW_ONLY_NODE_TYPES.has(nodeType)) {
      const isCritical = CRITICAL_NODE_TYPES.has(nodeType);
      findings.push({
        severity: isCritical ? 'critical' : 'high',
        code: 'FORBIDDEN_NODE',
        message: `Forbidden node type: ${nodeType}`,
        location: nodeName,
      });
      score += isCritical ? 80 : 30;
    }

    // Missing required fields
    if (!node.id) {
      findings.push({ severity: 'low', code: 'MISSING_NODE_ID', message: `Node "${nodeName}" has no id`, location: nodeName });
      score += 5;
    }
    if (!node.typeVersion) {
      findings.push({ severity: 'low', code: 'MISSING_TYPE_VERSION', message: `Node "${nodeName}" has no typeVersion`, location: nodeName });
      score += 5;
    }
    if (!Array.isArray(node.position)) {
      findings.push({ severity: 'info', code: 'MISSING_POSITION', message: `Node "${nodeName}" has no position` });
    }

    // Scan code nodes for dangerous patterns
    if (nodeType.includes('code') || nodeType.includes('function')) {
      const code = JSON.stringify(node.parameters ?? '');
      for (const { pattern, label } of CRITICAL_CODE_PATTERNS) {
        if (pattern.test(code)) {
          findings.push({ severity: 'critical', code: 'CODE_EXECUTION_HELPER', message: `${label} detected`, location: nodeName });
          score += 80;
        }
      }
      for (const { pattern, label } of HIGH_RISK_PATTERNS) {
        if (pattern.test(code)) {
          findings.push({ severity: 'high', code: 'CODE_RISK', message: `${label} detected in code node`, location: nodeName });
          score += 30;
        }
      }
    }

    // Scan ALL parameters for credential/secret leakage
    const paramsStr = JSON.stringify(node.parameters ?? '');
    if (/Bearer\s+[A-Za-z0-9+/=]{20,}/.test(paramsStr)) {
      findings.push({ severity: 'critical', code: 'HARDCODED_TOKEN', message: `Hardcoded Bearer token in node parameters`, location: nodeName });
      score += 80;
    }
    for (const { pattern, label } of MEDIUM_RISK_PATTERNS) {
      if (pattern.test(paramsStr)) {
        findings.push({ severity: 'medium', code: 'MEDIUM_RISK', message: label, location: nodeName });
        score += 15;
      }
    }

    // Webhook nodes without auth
    if (nodeType === 'n8n-nodes-base.webhook') {
      const auth = (node.parameters as any)?.authentication;
      if (!auth || auth === 'none') {
        findings.push({
          severity: 'medium',
          code: 'WEBHOOK_NO_AUTH',
          message: `Public webhook "${nodeName}" has no authentication configured`,
          location: nodeName,
        });
        score += 15;
      }
    }
  }

  // ── No trigger node check ────────────────────────────────────────────────
  const hasTrigger = nodes.some((node) => TRIGGER_TYPES.has(String(node.type ?? '')));
  if (!hasTrigger && nodes.length > 0) {
    findings.push({ severity: 'medium', code: 'NO_TRIGGER', message: 'No trigger node detected — workflow cannot run automatically' });
    score += 10;
  }

  return { score: Math.min(score, 100), findings };
}

// ── Tool definition ────────────────────────────────────────────────────────
export const riskScoringTool = createTool({
  id: 'architect_risk_score',
  description: 'Analyzes n8n workflow (JSON) for security risk. Returns risk score (0-100), findings list, and verdict. ALWAYS run before deploying. A verdict of "block" or "review" requires using system.request_approval.',
  inputSchema: z.object({
    workflowJson: z.string().describe('n8n workflow as a JSON string (workflow object, not wrapper)'),
    workflowName: z.string().optional().describe('Workflow name (for logs)'),
  }),
  outputSchema: z.object({
    score: z.number().describe('Risk score 0-100 (0=no risk, 100=critical)'),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).describe('Risk level'),
    verdict: z.enum(['approve', 'review', 'block']).describe('Recommendation: approve=deploy OK, review=review required, block=blocked'),
    findings: z.array(z.object({
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      code: z.string(),
      message: z.string(),
      location: z.string().optional(),
    })),
    summary: z.string(),
    approvalRequired: z.boolean(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    outputCompaction: z.any().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_risk_score',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['workflowJson'],
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      target: input.workflowName,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(context.workflowJson);
    } catch {
      // LLMs (especially gemini-2.5-flash) sometimes emit Python-style
      // booleans/null inside the JSON string. Try a best-effort recovery
      // by translating the obvious tokens before failing the deploy.
      try {
        const sanitized = context.workflowJson
          .replace(/(:\s*)True(\s*[,}\]])/g, '$1true$2')
          .replace(/(:\s*)False(\s*[,}\]])/g, '$1false$2')
          .replace(/(:\s*)None(\s*[,}\]])/g, '$1null$2');
        parsed = JSON.parse(sanitized);
      } catch {
        return {
          score: 100,
          riskLevel: 'critical' as const,
          verdict: 'block' as const,
          findings: [{ severity: 'critical' as const, code: 'INVALID_JSON', message: 'Cannot parse workflow JSON' }],
          summary: 'Workflow JSON is invalid — cannot be parsed.',
          approvalRequired: true,
        };
      }
    }

    const { score, findings } = analyzeWorkflow(parsed);

    const riskLevel: 'low' | 'medium' | 'high' | 'critical' =
      score >= 80 ? 'critical' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';
    const verdict: 'approve' | 'review' | 'block' =
      score >= 80 ? 'block' : score >= 20 ? 'review' : 'approve';
    const approvalRequired = verdict !== 'approve';

    const criticalCount = findings.filter((f) => f.severity === 'critical').length;
    const highCount = findings.filter((f) => f.severity === 'high').length;
    const name = context.workflowName ? `"${context.workflowName}"` : 'Workflow';

    const summary =
      score === 0
        ? `${name} passed the analysis without concerns. Deploy allowed.`
        : `${name} received ${score}/100 risk points (${riskLevel}). ` +
          (criticalCount > 0 ? `${criticalCount} critical findings. ` : '') +
          (highCount > 0 ? `${highCount} high risk findings. ` : '') +
          (verdict === 'block' ? 'BLOCKED — repair required before deployment.' :
           verdict === 'review' ? 'Review and approval required before deployment.' :
           'Deployment allowed after review.');

    return { score, riskLevel, verdict, findings, summary, approvalRequired };
    },
    modelOutput: (output, _input, metadata) => compactAutomationResultForModel(output, metadata),
  }),
});
