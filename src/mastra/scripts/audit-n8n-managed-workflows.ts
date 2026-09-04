#!/usr/bin/env tsx
import 'dotenv/config';

import { getDb, closeDb } from '../lib/mongo.js';
import { N8nService } from '../tools/n8n/client.js';
import { validateWorkflow } from '../tools/architect/validation/workflow-validator.js';

const DEFAULT_WORKFLOW_IDS = [
  'XjRwjBPesto0419e',
  'h3fvQ0xzuZcZz0Hs',
];

type AuditRecord = {
  workflowId: string;
  automationId?: string;
  workflowName?: string;
  managedBy?: string;
  requestStatus?: string;
  lastTestStatus?: string;
  n8nActive?: boolean;
  nodeCount?: number;
  connectionCount?: number;
  strictValid?: boolean;
  triggerCount?: number;
  orphanNodeCount?: number;
  disconnectedComponentCount?: number;
  disconnectedGraph?: boolean;
  lastTestLikelyFalsePositive?: boolean;
  statusMismatchReason?: string;
  backfillEligible?: boolean;
  backfillApplied?: boolean;
  error?: string;
};

async function main() {
  const { workflowIds, apply } = parseArgs(process.argv.slice(2));
  const db = await getDb();
  const n8n = new N8nService();
  const audits: AuditRecord[] = [];

  try {
    for (const workflowId of workflowIds) {
      audits.push(await auditWorkflow({ workflowId, apply, db, n8n }));
    }
  } finally {
    await closeDb();
  }

  renderSummary(audits, apply);

  if (audits.some((audit) => audit.error)) {
    process.exitCode = 1;
  }
}

async function auditWorkflow(input: {
  workflowId: string;
  apply: boolean;
  db: Awaited<ReturnType<typeof getDb>>;
  n8n: N8nService;
}): Promise<AuditRecord> {
  const { workflowId, apply, db, n8n } = input;

  try {
    const request = await db.collection('automation_requests').findOne({ n8nWorkflowId: workflowId });
    const workflow = await n8n.getWorkflow(workflowId);
    const validation = validateWorkflow(workflow, 'strict');
    const disconnectedGraph = isDisconnectedGraph(validation);
    const requestStatus = stringOrUndefined(request?.status);
    const lastTestStatus = stringOrUndefined(request?.lastTest?.status);
    const lastTestLikelyFalsePositive = lastTestStatus === 'passed' && disconnectedGraph;
    const statusMismatchReason = detectStatusMismatch({
      requestStatus,
      lastTestStatus,
      n8nActive: workflow.active === true,
      disconnectedGraph,
    });
    const backfillEligible = Boolean(
      request?.managedBy === 'mastra'
      && requestStatus === 'tested'
      && disconnectedGraph,
    );

    let backfillApplied = false;
    if (apply && backfillEligible && request?.automationId) {
      const now = new Date();
      await db.collection('automation_requests').updateOne(
        { automationId: request.automationId, n8nWorkflowId: workflowId },
        {
          $set: {
            status: 'manual_review_required',
            updatedAt: now,
            graphValidationBackfillAt: now,
          },
        },
      );
      await db.collection('automation_events').insertOne({
        automationId: request.automationId,
        type: 'graph_validation_backfill',
        data: {
          workflowId,
          previousStatus: requestStatus,
          nextStatus: 'manual_review_required',
          lastTestStatus,
          connectionCount: validation.connectionCount,
          orphanNodeCount: validation.orphanNodeCount,
          disconnectedComponents: validation.disconnectedComponents,
          strictValid: validation.valid,
        },
        createdAt: now,
      });
      backfillApplied = true;
    }

    return {
      workflowId,
      automationId: stringOrUndefined(request?.automationId),
      workflowName: workflow.name,
      managedBy: stringOrUndefined(request?.managedBy),
      requestStatus,
      lastTestStatus,
      n8nActive: workflow.active === true,
      nodeCount: validation.nodeCount,
      connectionCount: validation.connectionCount,
      strictValid: validation.valid,
      triggerCount: validation.triggerCount,
      orphanNodeCount: validation.orphanNodeCount,
      disconnectedComponentCount: validation.disconnectedComponents.length,
      disconnectedGraph,
      lastTestLikelyFalsePositive,
      statusMismatchReason,
      backfillEligible,
      backfillApplied,
    };
  } catch (error) {
    return {
      workflowId,
      error: (error as Error).message,
    };
  }
}

function parseArgs(args: string[]): { workflowIds: string[]; apply: boolean } {
  const apply = args.includes('--apply');
  const workflowIds = args.filter((arg) => !arg.startsWith('--'));
  return {
    workflowIds: workflowIds.length > 0 ? workflowIds : DEFAULT_WORKFLOW_IDS,
    apply,
  };
}

function isDisconnectedGraph(validation: ReturnType<typeof validateWorkflow>): boolean {
  return validation.orphanNodeCount > 0 || validation.disconnectedComponents.length > 0;
}

function detectStatusMismatch(input: {
  requestStatus?: string;
  lastTestStatus?: string;
  n8nActive: boolean;
  disconnectedGraph: boolean;
}): string | undefined {
  if (!input.requestStatus) return 'automation_requests record missing';
  if (input.requestStatus === 'tested' && input.disconnectedGraph) {
    return 'status=tested but strict graph validation is disconnected';
  }
  if (input.requestStatus === 'draft_created' && input.lastTestStatus === 'passed') {
    return 'lastTest.status=passed but status=draft_created';
  }
  if (input.requestStatus === 'active' && !input.n8nActive) {
    return 'status=active but n8n workflow is inactive';
  }
  if (input.requestStatus !== 'active' && input.n8nActive) {
    return `status=${input.requestStatus} but n8n workflow is active`;
  }
  return undefined;
}

function renderSummary(audits: AuditRecord[], apply: boolean): void {
  console.log(`n8n managed workflow audit (${apply ? 'apply' : 'read-only'})`);
  for (const audit of audits) {
    console.log('');
    console.log(`workflowId=${audit.workflowId}`);
    if (audit.error) {
      console.log(`error=${audit.error}`);
      continue;
    }
    console.log(`automationId=${audit.automationId ?? 'missing'}`);
    console.log(`name=${audit.workflowName ?? 'missing'}`);
    console.log(`managedBy=${audit.managedBy ?? 'missing'}`);
    console.log(`status=${audit.requestStatus ?? 'missing'}`);
    console.log(`lastTest=${audit.lastTestStatus ?? 'missing'}`);
    console.log(`n8nActive=${String(audit.n8nActive)}`);
    console.log(`nodes=${audit.nodeCount}, connections=${audit.connectionCount}`);
    console.log(`strictValid=${String(audit.strictValid)}, triggers=${audit.triggerCount}, orphanNodes=${audit.orphanNodeCount}, disconnectedComponents=${audit.disconnectedComponentCount}`);
    console.log(`disconnectedGraph=${String(audit.disconnectedGraph)}`);
    console.log(`lastTestLikelyFalsePositive=${String(audit.lastTestLikelyFalsePositive)}`);
    console.log(`statusMismatch=${audit.statusMismatchReason ?? 'none'}`);
    console.log(`backfillEligible=${String(audit.backfillEligible)}, backfillApplied=${String(audit.backfillApplied)}`);
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

main().catch(async (error) => {
  console.error((error as Error).message);
  await closeDb();
  process.exit(1);
});
