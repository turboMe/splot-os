#!/usr/bin/env tsx
import 'dotenv/config';

import { randomUUID } from 'crypto';

import { buildAutomationPrecontext } from '../services/automation-precontext.js';
import {
  getAutomationJob,
  listAutomationJobs,
  markStaleAutomationJobs,
} from '../services/automation-job-manager.js';
import { getAsyncDelegation, startAsyncDelegation } from '../services/async-delegation.js';
import { startAutomationRequest } from '../tools/system/start-automation-request.js';
import { checkPendingUpdatesTool } from '../tools/system/check-pending-updates.js';
import { queuePendingMessage, takePendingMessages } from '../services/pending-message-queue.js';
import { automationDecisionOutputProcessor } from '../processors/automation-decision-output.js';
import { classifyToolError } from '../services/harness-tool-envelope.js';
import { getDb, closeDb } from '../lib/mongo.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  CODING_AGENT_ID,
  META_AGENT_ID,
} from '../config/agent-ids.js';

const unsafeWorkflow = {
  name: 'Autonomy Check Unsafe Function',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'manual',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'unsafe',
      name: 'Unsafe Function',
      type: 'n8n-nodes-base.function',
      typeVersion: 1,
      position: [220, 0],
      parameters: {
        functionCode: "return [{ json: { out: $helpers.executeCommandSync('cat /etc/passwd').toString() } }];",
      },
    },
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Unsafe Function', type: 'main', index: 0 }]],
    },
  },
};

async function main() {
  process.env.FEATURE_AUTOMATION_PRECONTEXT = 'true';
  process.env.FEATURE_SOFT_INTERRUPTS = 'true';
  process.env.FEATURE_BACKGROUND_TASKS = 'true';
  process.env.N8N_CREDENTIAL_TELEGRAM_ID = process.env.N8N_CREDENTIAL_TELEGRAM_ID || 'check-secret-credential-id';

  const classificationWorkflowValidation = checkToolErrorClassification();
  const structuredInputContract = await checkStructuredInputContract();
  const metaDirectComplexWorkflowBlock = await checkMetaDirectComplexWorkflowBlock();

  const db = await getDb();
  const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
  const automationId = `check-autonomy-${suffix}`;
  const threadId = `check-autonomy-thread-${suffix}`;
  let jobId: string | undefined;
  let pendingArchitectId: string | undefined;
  let pendingMetaId: string | undefined;
  let legacyPendingId: string | undefined;
  let legacyAliasJobId: string | undefined;
  let staleJobId: string | undefined;
  let asyncDelegationId: string | undefined;
  let asyncPendingId: string | undefined;
  let asyncArtifactId: string | undefined;

  try {
    const precontext = await buildAutomationPrecontext({
      agentId: AUTOMATION_ARCHITECT_AGENT_ID,
      threadId,
      userPrompt: 'Build a Telegram automation and avoid previous n8n failure cases.',
      automationId,
    });
    assert(precontext.markdown.includes('Runtime Topology'), 'pre-context missing Runtime Topology');
    assert(precontext.markdown.includes('Credential Registry'), 'pre-context missing Credential Registry');
    assert(!precontext.markdown.includes('check-secret-credential-id'), 'pre-context leaked credential id');

    pendingArchitectId = await queuePendingMessage({
      threadId,
      targetAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
      source: 'automation_job',
      content: 'architect-only update',
      metadata: { automationId, type: 'automation_job_result' },
    });
    pendingMetaId = await queuePendingMessage({
      threadId,
      targetAgentId: META_AGENT_ID,
      source: 'automation_job',
      content: 'meta-only update',
      metadata: { automationId, type: 'automation_job_result' },
    });
    await queuePendingMessage({
      threadId: `${threadId}-foreign`,
      targetAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
      source: 'automation_job',
      content: 'foreign-thread architect update',
      metadata: { automationId, type: 'automation_job_result' },
    });

    const scopedPrecontext = await buildAutomationPrecontext({
      agentId: AUTOMATION_ARCHITECT_AGENT_ID,
      threadId,
      userPrompt: 'Read only the updates scoped to this automation thread.',
      automationId,
    });
    assert(
      scopedPrecontext.pendingUpdateCount === 1,
      `pre-context widened pending scope: ${scopedPrecontext.pendingUpdateCount}`,
    );
    assert(
      scopedPrecontext.markdown.includes('architect-only update'),
      'pre-context omitted the exact-thread architect update',
    );
    assert(
      !scopedPrecontext.markdown.includes('meta-only update')
        && !scopedPrecontext.markdown.includes('foreign-thread architect update'),
      'pre-context disclosed a foreign target or thread update',
    );

    const architectMessages = await takePendingMessages({
      threadId,
      agentId: AUTOMATION_ARCHITECT_AGENT_ID,
      limit: 10,
    });
    assert(architectMessages.some((message) => message.id === pendingArchitectId), 'architect did not receive its pending update');
    assert(!architectMessages.some((message) => message.id === pendingMetaId), 'architect consumed meta-agent pending update');
    const metaStillPending = await db.collection('pending_user_messages').findOne({ id: pendingMetaId, status: 'pending' });
    assert(Boolean(metaStillPending), 'meta-agent pending update was consumed by the wrong agent');

    legacyPendingId = `legacy-pending-${suffix}`;
    await db.collection('pending_user_messages').insertOne({
      id: legacyPendingId,
      threadId,
      targetAgentId: AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
      source: 'automation_job',
      content: 'legacy architect update',
      urgent: false,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      metadata: { automationId, type: 'automation_job_result' },
    });
    const legacyAliasMessages = await takePendingMessages({
      threadId,
      agentId: AUTOMATION_ARCHITECT_AGENT_ID,
      limit: 10,
    });
    assert(
      legacyAliasMessages.some((message) => message.id === legacyPendingId),
      'canonical automationArchitect did not consume legacy automation-architect pending update',
    );

    legacyAliasJobId = `legacy-alias-job-${suffix}`;
    await db.collection('automation_jobs').insertOne({
      jobId: legacyAliasJobId,
      automationId: `${automationId}-legacy-alias`,
      targetAgentId: AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
      returnToAgentId: AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
      status: 'completed',
      inputPreview: '{}',
      resultPreview: 'legacy alias job',
      startedAt: new Date(),
      completedAt: new Date(),
      lastHeartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const aliasJobs = await listAutomationJobs({
      returnToAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
      limit: 20,
    });
    assert(
      aliasJobs.some((record) => record.jobId === legacyAliasJobId),
      'canonical automationArchitect did not list legacy automation-architect automation job',
    );

    const asyncThreadId = `${threadId}-async`;
    const longAsyncResult = `async-result-${'x'.repeat(1800)}`;
    const fakeAgent = {
      generate: async () => ({ text: longAsyncResult }),
    } as any;
    ({ delegationId: asyncDelegationId } = await startAsyncDelegation({
      agent: fakeAgent,
      agentId: CODING_AGENT_ID,
      prompt: 'Return a long async regression payload.',
      callerThreadId: asyncThreadId,
      callerAgentId: META_AGENT_ID,
      returnToAgentId: META_AGENT_ID,
      returnToThreadId: asyncThreadId,
    }));
    const asyncDelegation = await waitForAsyncDelegation(asyncDelegationId, 10_000);
    assert(asyncDelegation.status === 'completed', `unexpected async delegation status: ${asyncDelegation.status}`);
    assert(asyncDelegation.resultPreview?.endsWith('...'), 'async delegation did not keep a compact result preview');
    assert(Boolean(asyncDelegation.resultArtifactId), 'async delegation did not persist a full result artifact');
    assert(asyncDelegation.fullResultAvailable === true, 'async delegation did not mark full result availability');
    asyncArtifactId = asyncDelegation.resultArtifactId;

    const pendingAsyncResult = await db.collection('pending_user_messages').findOne({
      threadId: asyncThreadId,
      targetAgentId: META_AGENT_ID,
      source: 'background_task',
      status: 'pending',
      'metadata.delegationId': asyncDelegationId,
    });
    assert(Boolean(pendingAsyncResult), 'async delegation did not queue a pending result');
    asyncPendingId = pendingAsyncResult?.id;
    assert(
      pendingAsyncResult?.content.includes(`**Full result artifact:** ${asyncArtifactId}`),
      'async pending result did not expose the full result artifact id',
    );

    const pendingToolResult = await (checkPendingUpdatesTool as any).execute(
      {},
      {
        agent: {
          agentId: META_AGENT_ID,
          threadId: asyncThreadId,
          resourceId: `check-autonomy-owner-${suffix}`,
        },
        requestContext: {
          get: (key: string) => {
            if (key === 'mastra__threadId') return asyncThreadId;
            if (key === 'mastra__resourceId') return `check-autonomy-owner-${suffix}`;
            return undefined;
          },
        },
      },
    );
    const asyncUpdate = pendingToolResult.updates.find((update: any) => update.metadata?.delegationId === asyncDelegationId);
    assert(Boolean(asyncUpdate), 'checkPendingUpdates did not return the async delegation result');
    assert(
      asyncUpdate.metadata?.resultArtifactId === asyncArtifactId,
      'checkPendingUpdates dropped async result artifact metadata',
    );
    assert(
      asyncUpdate.metadata?.fullResultAvailable === true,
      'checkPendingUpdates dropped full result availability metadata',
    );

    const job = await startAutomationRequest({
      mode: 'workflow_json',
      automationId,
      workflow: unsafeWorkflow,
      callerAgentId: META_AGENT_ID,
      callerThreadId: threadId,
      returnToAgentId: META_AGENT_ID,
      returnToThreadId: threadId,
      wake: true,
    });
    assert(job.executionMode === 'job', 'system_start_automation_request did not start a durable job');
    assert(job.returnToAgentId === META_AGENT_ID, 'structured automation request did not preserve returnToAgentId');
    jobId = job.jobId;

    const persistedJob = await db.collection('automation_jobs').findOne({ jobId });
    assert(Boolean(persistedJob), 'automation_jobs record was not persisted');

    const completedJob = await waitForJob(jobId, 90_000);
    assert(completedJob.status === 'completed' || completedJob.status === 'failed', `unexpected job status: ${completedJob.status}`);
    assert(completedJob.resultPreview || completedJob.error, 'job has no result preview or error');

    const pendingJobResult = await db.collection('pending_user_messages').findOne({
      targetAgentId: META_AGENT_ID,
      source: 'automation_job',
      status: 'pending',
      'metadata.jobId': jobId,
    });
    assert(Boolean(pendingJobResult), 'automation job completion did not queue pending update');

    const failureEvent = await db.collection('automation_events').findOne({
      automationId,
      type: 'failure_case',
    });
    assert(Boolean(failureEvent), 'Golden Path failure did not write automation_events.failure_case');

    automationDecisionOutputProcessor.processOutputResult({
      result: {
        text: [
          `AutomationId: ${automationId}`,
          'WorkflowId: wf-check-autonomy',
          'Status: blocked',
          'Risk: block 90',
          'Last test: failed',
        ].join('\n'),
        usage: {},
      },
      messages: [],
      systemMessages: [],
    } as any);

    const decision = await waitForSharedDecision(automationId, 10_000);
    assert(decision?.type === 'automation_decision', 'automation decision was not written to shared_memory');

    staleJobId = `stale-check-${suffix}`;
    await db.collection('automation_jobs').insertOne({
      jobId: staleJobId,
      automationId: `${automationId}-stale`,
      targetAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
      status: 'running',
      inputPreview: '{}',
      startedAt: new Date(Date.now() - 120_000),
      lastHeartbeatAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const marked = await markStaleAutomationJobs({ staleAfterMs: 1_000 });
    assert(marked >= 1, 'stale automation job was not marked stale');

    console.log('automation-autonomy check passed');
    console.log('metaStructuredWorkflowJson=passed');
    console.log(`classificationWorkflowValidation=${classificationWorkflowValidation}`);
    console.log(`structuredInputContract=${structuredInputContract}`);
    console.log(`metaDirectComplexWorkflowBlock=${metaDirectComplexWorkflowBlock}`);
    console.log('asyncFullResultArtifact=passed');
    console.log(`precontextTokens=${precontext.tokenEstimate}`);
    console.log(`jobId=${jobId}, jobStatus=${completedJob.status}`);
    console.log(`decisionKey=${decision.key}`);
  } finally {
    await cleanup({
      automationId,
      threadId,
      jobId,
      pendingArchitectId,
      pendingMetaId,
      legacyPendingId,
      legacyAliasJobId,
      staleJobId,
      asyncDelegationId,
      asyncPendingId,
      asyncArtifactId,
    });
    await closeDb();
  }
}

async function waitForJob(jobId: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await getAutomationJob(jobId);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for automation job ${jobId}`);
}

async function waitForAsyncDelegation(delegationId: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const delegation = await getAsyncDelegation(delegationId);
    if (delegation && delegation.status !== 'running') return delegation;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for async delegation ${delegationId}`);
}

async function waitForSharedDecision(automationId: string, timeoutMs: number): Promise<any> {
  const started = Date.now();
  const db = await getDb();
  while (Date.now() - started < timeoutMs) {
    const decision = await db.collection('shared_memory').findOne({
      type: 'automation_decision',
      sourceAgent: AUTOMATION_ARCHITECT_AGENT_ID,
      automationId,
    });
    if (decision) return decision;
    await sleep(250);
  }
  return null;
}

async function cleanup(input: {
  automationId: string;
  threadId: string;
  jobId?: string;
  pendingArchitectId?: string;
  pendingMetaId?: string;
  legacyPendingId?: string;
  legacyAliasJobId?: string;
  staleJobId?: string;
  asyncDelegationId?: string;
  asyncPendingId?: string;
  asyncArtifactId?: string;
}) {
  const db = await getDb();
  await Promise.allSettled([
    db.collection('pending_user_messages').deleteMany({
      $or: [
        { threadId: input.threadId },
        { id: { $in: [input.pendingArchitectId, input.pendingMetaId, input.legacyPendingId, input.asyncPendingId].filter(Boolean) } },
        { 'metadata.automationId': input.automationId },
      ],
    }),
    db.collection('automation_jobs').deleteMany({
      $or: [
        { automationId: input.automationId },
        { jobId: { $in: [input.jobId, input.staleJobId, input.legacyAliasJobId].filter(Boolean) } },
      ],
    }),
    db.collection('automation_events').deleteMany({ automationId: input.automationId }),
    db.collection('automation_requests').deleteMany({ automationId: input.automationId }),
    db.collection('automation_workflow_snapshots').deleteMany({ automationId: input.automationId }),
    db.collection('shared_memory').deleteMany({ type: 'automation_decision', automationId: input.automationId }),
    db.collection('system_knowledge').deleteMany({ content: { $regex: input.automationId } }),
    db.collection('async_delegations').deleteMany({
      delegationId: { $in: [input.asyncDelegationId].filter(Boolean) },
    }),
    db.collection('harness_artifacts').deleteMany({
      id: { $in: [input.asyncArtifactId].filter(Boolean) },
    }),
    // The unsafe-workflow deploy attempt opens a task_ledger lane for
    // automationArchitect that correctly ends up state=failed (the deploy was
    // meant to be rejected) — but nothing ever closed it, so every run left a
    // permanent "failed" scar the dashboard reads as a real agent failure.
    db.collection('task_ledger').deleteMany({
      threadId: { $in: [input.threadId, `${input.threadId}-async`] },
    }),
  ]);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkToolErrorClassification(): string {
  const workflowValidationClass = classifyToolError({
    category: 'network',
    output: {
      success: false,
      status: 'blocked',
      message: 'Workflow validation blocked deploy.',
      validation: {
        errors: [{ message: 'Connection references unknown source node: RSS Aggregator' }],
        securityIssues: [],
        warnings: [],
        missingCredentials: [],
        missingConfig: [],
      },
      steps: [
        {
          name: 'validate_draft',
          status: 'blocked',
          message: 'Draft validation blocked deploy.',
        },
      ],
    },
  });
  assert(
    workflowValidationClass === 'workflow_validation',
    `Workflow validation blocked deploy classified as ${workflowValidationClass}`,
  );

  const policyClass = classifyToolError({
    category: 'network',
    output: {
      success: false,
      message: 'Policy blocked tool execution: architect_deploy_automation',
    },
  });
  assert(policyClass === 'policy_blocked', `policy marker classified as ${policyClass}`);

  const contractClass = classifyToolError({
    category: 'network',
    errorMessage: 'workflow object is required for mode=workflow_json.',
  });
  assert(contractClass === 'tool_input_contract', `tool input contract classified as ${contractClass}`);

  return 'passed';
}

async function checkStructuredInputContract(): Promise<string> {
  let message = '';
  try {
    await startAutomationRequest({
      mode: 'workflow_json',
      callerAgentId: META_AGENT_ID,
      executionMode: 'job',
    } as any);
  } catch (error) {
    message = (error as Error).message;
  }

  assert(
    message.includes('workflow object is required for mode=workflow_json.'),
    `workflow_json contract was not rejected before job creation: ${message || 'no error'}`,
  );
  return 'passed';
}

async function checkMetaDirectComplexWorkflowBlock(): Promise<string> {
  const workflow = {
    name: 'Meta Direct Complex Workflow Block',
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'manual', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'set1', name: 'Set 1', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: {} },
      { id: 'set2', name: 'Set 2', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [400, 0], parameters: {} },
      { id: 'mongo', name: 'Mongo Save', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3, position: [600, 0], parameters: {} },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Set 1', type: 'main', index: 0 }]] },
      'Set 1': { main: [[{ node: 'Set 2', type: 'main', index: 0 }]] },
      'Set 2': { main: [[{ node: 'Mongo Save', type: 'main', index: 0 }]] },
    },
  };
  const beforeCount = await (await getDb()).collection('automation_jobs').countDocuments({});
  const result = await startAutomationRequest({
    mode: 'workflow_json',
    callerAgentId: META_AGENT_ID,
    executionMode: 'job',
    workflow,
    workflowName: workflow.name,
  });
  const afterCount = await (await getDb()).collection('automation_jobs').countDocuments({});

  assert(result.success === false, 'Meta direct complex workflow_json should be blocked');
  assert(result.error === 'meta_direct_complex_workflow_blocked', `unexpected direct block error: ${result.error}`);
  assert(afterCount === beforeCount, 'Meta direct complex workflow block should not create automation_jobs records');
  return 'passed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
