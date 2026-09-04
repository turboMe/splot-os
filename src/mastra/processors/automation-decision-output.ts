/**
 * Processor: AutomationDecisionOutputProcessor
 *
 * Persists structured Automation Architect decisions to shared_memory so meta
 * and other agents can recover status without parsing the full conversation.
 */

import { createHash } from 'crypto';

import type { ProcessOutputResultArgs, ProcessorMessageResult } from '@mastra/core/processors';
import { BaseProcessor } from '@mastra/core/processors';
import { AUTOMATION_ARCHITECT_AGENT_ID } from '../config/agent-ids.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';

export type AutomationDecisionMemory = {
  automationId?: string;
  workflowId?: string;
  workflowName?: string;
  jobId?: string;
  status?: string;
  riskVerdict?: string;
  riskScore?: number;
  lastTestStatus?: string;
  activationAllowed?: boolean;
  summary: string;
};

const DECISION_STATUSES = new Set([
  'blocked',
  'draft_created',
  'tested',
  'active',
  'manual_review_required',
]);

export class AutomationDecisionOutputProcessor extends BaseProcessor<'automation-decision-output'> {
  readonly id = 'automation-decision-output' as const;
  readonly name = 'Automation Decision Output Processor';
  readonly description =
    'Persists Automation Architect deploy/test/activation decisions to shared_memory.';

  processOutputResult(args: ProcessOutputResultArgs): ProcessorMessageResult {
    const { result, messages } = args;
    const decision = extractAutomationDecision(result as any);
    if (!decision) return messages;

    void persistAutomationDecision(decision, {
      tokenUsage: (result as any).usage,
    });

    return messages;
  }
}

export const automationDecisionOutputProcessor = new AutomationDecisionOutputProcessor();

export async function persistAutomationDecision(
  decision: AutomationDecisionMemory,
  opts: { tokenUsage?: unknown } = {},
): Promise<void> {
  const hydrated = await hydrateDecisionFromDb(decision);
  const finalDecision = {
    ...decision,
    ...hydrated,
    summary: redactSecrets(hydrated.summary ?? decision.summary).text.slice(0, 900),
  };

  if (!isWorthPersisting(finalDecision)) return;

  const db = await getDb();
  const now = new Date();
  const key = [
    'automation-decision',
    finalDecision.automationId ?? finalDecision.workflowId ?? finalDecision.jobId ?? hash(finalDecision.summary),
    now.toISOString().slice(0, 16),
  ].join('-');
  const ttl = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

  await db.collection('shared_memory').updateOne(
    { key },
    {
      $setOnInsert: {
        id: key,
        key,
        type: 'automation_decision',
        sourceAgent: AUTOMATION_ARCHITECT_AGENT_ID,
        automationId: finalDecision.automationId,
        workflowId: finalDecision.workflowId,
        workflowName: finalDecision.workflowName,
        jobId: finalDecision.jobId,
        status: finalDecision.status,
        riskVerdict: finalDecision.riskVerdict,
        riskScore: finalDecision.riskScore,
        lastTestStatus: finalDecision.lastTestStatus,
        activationAllowed: finalDecision.activationAllowed,
        summary: finalDecision.summary,
        content: finalDecision.summary,
        tokenUsage: opts.tokenUsage,
        createdAt: now,
        expiresAt: ttl,
      },
    },
    { upsert: true },
  );
}

function extractAutomationDecision(result: any): AutomationDecisionMemory | null {
  const structured = extractFromToolResults(result);
  if (structured) return structured;

  const text = typeof result?.text === 'string' ? result.text : '';
  if (!text) return null;
  return extractFromText(text);
}

function extractFromToolResults(result: any): AutomationDecisionMemory | null {
  const toolResults = collectToolResults(result);
  for (const toolResult of toolResults) {
    const toolName = String(toolResult.toolName ?? toolResult.toolId ?? '');
    const value = toolResult.result ?? toolResult.output;
    const normalized = normalizeToolResult(value);
    if (!normalized) continue;

    if (
      toolName.includes('architect_execute_automation_request') ||
      toolName.includes('architect_get_automation_job') ||
      toolName.includes('architect_start_automation_job') ||
      normalized.automationId ||
      normalized.workflowId ||
      normalized.jobId
    ) {
      if (normalized.status === 'queued' || normalized.status === 'running') continue;
      return normalized;
    }
  }
  return null;
}

function collectToolResults(result: any): any[] {
  const out: any[] = [];
  if (Array.isArray(result?.toolResults)) out.push(...result.toolResults);
  if (Array.isArray(result?.steps)) {
    for (const step of result.steps) {
      if (Array.isArray(step?.toolResults)) out.push(...step.toolResults);
    }
  }
  return out;
}

function normalizeToolResult(value: unknown): AutomationDecisionMemory | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, any>;
  const result = record.result && typeof record.result === 'object'
    ? record.result as Record<string, any>
    : record;
  const status = String(result.status ?? result.goldenPathStatus ?? '').trim();
  const hasDecisionStatus = DECISION_STATUSES.has(status);
  const risk = result.risk && typeof result.risk === 'object' ? result.risk : undefined;
  const lastTest = result.lastTest && typeof result.lastTest === 'object' ? result.lastTest : undefined;

  if (!hasDecisionStatus && !result.automationId && !result.workflowId && !result.jobId) {
    return null;
  }

  return {
    automationId: stringOrUndefined(result.automationId),
    workflowId: stringOrUndefined(result.workflowId),
    workflowName: stringOrUndefined(result.workflowName),
    jobId: stringOrUndefined(result.jobId),
    status: hasDecisionStatus ? status : stringOrUndefined(result.status),
    riskVerdict: stringOrUndefined(result.riskVerdict ?? risk?.verdict),
    riskScore: numberOrUndefined(result.riskScore ?? risk?.score),
    lastTestStatus: stringOrUndefined(result.lastTestStatus ?? lastTest?.status),
    activationAllowed: inferActivationAllowed({
      status,
      riskVerdict: stringOrUndefined(result.riskVerdict ?? risk?.verdict),
      text: result.message ?? result.resultPreview ?? '',
    }),
    summary: summarizeDecision(result),
  };
}

function extractFromText(text: string): AutomationDecisionMemory | null {
  const status = matchFirst(text, /\b(blocked|draft_created|tested|active|manual_review_required)\b/i)?.toLowerCase();
  const automationId = matchFirst(text, /\bautomationId[:\s`*]+([A-Za-z0-9_-]{6,})\b/i);
  const workflowId = matchFirst(text, /\bworkflowId[:\s`*]+([A-Za-z0-9_-]{4,})\b/i);
  const jobId = matchFirst(text, /\bjob id[:\s`*]+([A-Za-z0-9_-]{6,})\b/i)
    ?? matchFirst(text, /\bjobId[:\s`*]+([A-Za-z0-9_-]{6,})\b/i);
  const riskVerdict = matchFirst(text, /\brisk(?:Verdict)?[:\s`*]+(approve|review|block)\b/i)?.toLowerCase();
  const riskScoreRaw = matchFirst(text, /\brisk(?: score)?[:\s`*]+(?:approve|review|block)?\s*\(?([0-9]{1,3})\)?/i);
  const lastTestStatus = matchFirst(text, /\blast(?:\s+)?test[:\s`*]+(passed|failed)\b/i)?.toLowerCase();

  if (!status && !automationId && !workflowId && !jobId) return null;

  return {
    automationId,
    workflowId,
    jobId,
    status,
    riskVerdict,
    riskScore: riskScoreRaw ? Number(riskScoreRaw) : undefined,
    lastTestStatus,
    activationAllowed: inferActivationAllowed({ status, riskVerdict, text }),
    summary: summarizeText(text),
  };
}

async function hydrateDecisionFromDb(
  decision: AutomationDecisionMemory,
): Promise<Partial<AutomationDecisionMemory>> {
  try {
    const db = await getDb();
    let automation = null as any;

    if (decision.automationId) {
      automation = await db.collection('automation_requests').findOne({ automationId: decision.automationId });
    } else if (decision.workflowId) {
      automation = await db.collection('automation_requests').findOne({ n8nWorkflowId: decision.workflowId });
    } else if (decision.jobId) {
      const job = await db.collection('automation_jobs').findOne({ jobId: decision.jobId }) as any;
      if (job?.automationId) {
        automation = await db.collection('automation_requests').findOne({ automationId: job.automationId });
        return {
          jobId: decision.jobId,
          automationId: job.automationId,
          status: automation?.status ?? job.status,
          workflowId: automation?.n8nWorkflowId,
          workflowName: automation?.name,
          riskVerdict: automation?.riskVerdict,
          riskScore: automation?.riskScore,
          lastTestStatus: automation?.lastTest?.status,
          activationAllowed: inferActivationAllowed({
            status: automation?.status ?? job.status,
            riskVerdict: automation?.riskVerdict,
            text: job.resultPreview ?? '',
          }),
          summary: job.resultPreview ?? decision.summary,
        };
      }
    }

    if (!automation) return {};

    return {
      automationId: automation.automationId,
      workflowId: automation.n8nWorkflowId,
      workflowName: automation.name,
      status: automation.status,
      riskVerdict: automation.riskVerdict,
      riskScore: automation.riskScore,
      lastTestStatus: automation.lastTest?.status,
      activationAllowed: inferActivationAllowed({
        status: automation.status,
        riskVerdict: automation.riskVerdict,
        text: decision.summary,
      }),
    };
  } catch (error) {
    console.warn('[AutomationDecisionOutputProcessor] Hydration failed:', (error as Error).message);
    return {};
  }
}

function isWorthPersisting(decision: AutomationDecisionMemory): boolean {
  if (decision.status && DECISION_STATUSES.has(decision.status)) return true;
  return Boolean(decision.automationId || decision.workflowId || decision.jobId);
}

function summarizeDecision(result: Record<string, any>): string {
  return redactSecrets([
    result.workflowName ? `Workflow: ${result.workflowName}` : '',
    result.automationId ? `AutomationId: ${result.automationId}` : '',
    result.workflowId ? `WorkflowId: ${result.workflowId}` : '',
    result.jobId ? `JobId: ${result.jobId}` : '',
    result.status ? `Status: ${result.status}` : '',
    result.message ? `Message: ${result.message}` : '',
    result.risk ? `Risk: ${result.risk.verdict ?? result.riskVerdict} ${result.risk.score ?? result.riskScore}` : '',
    result.lastTest ? `Last test: ${result.lastTest.status}` : '',
    result.resultPreview ? String(result.resultPreview).slice(0, 700) : '',
  ].filter(Boolean).join('\n')).text.slice(0, 900);
}

function summarizeText(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, '');
  return redactSecrets(withoutCode.replace(/\s+/g, ' ').trim()).text.slice(0, 900);
}

function inferActivationAllowed(input: {
  status?: string;
  riskVerdict?: string;
  text?: string;
}): boolean | undefined {
  const text = (input.text ?? '').toLowerCase();
  if (input.status === 'active') return true;
  if (/\bactivation (blocked|requires approval|not allowed)\b/.test(text)) return false;
  if (input.status === 'blocked' || input.status === 'manual_review_required') return false;
  if (input.riskVerdict === 'block' || input.riskVerdict === 'review') return false;
  if (input.status === 'tested' && input.riskVerdict === 'approve') return true;
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function matchFirst(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1];
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
