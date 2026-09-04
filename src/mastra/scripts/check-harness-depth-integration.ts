import assert from 'node:assert/strict';

import type { Agent } from '@mastra/core/agent';
import { AUTOMATION_ARCHITECT_AGENT_ID } from '../config/agent-ids.js';
import { setRunDepth, disposeRunDepth } from '../services/depth-controller.js';
import { generateWithHarness, type HarnessContextBuilderInput } from '../services/generate-with-harness.js';
import { runWithHarnessExecutionContext } from '../services/harness-execution-context.js';
import { withToolEnvelope } from '../services/harness-tool-envelope.js';

type GenerateCall = {
  prompt: string;
  options: Record<string, any>;
};

class FakeAgent {
  calls: GenerateCall[] = [];

  async generate(prompt: string, options: Record<string, any> = {}): Promise<{ text: string; steps: any[]; finishReason: string }> {
    this.calls.push({ prompt, options });

    if (prompt.includes('trigger-depth-upgrade') && typeof options.onStepFinish === 'function') {
      await options.onStepFinish({
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'fake_tool', args: { attempt: 1 } },
          { toolCallId: 'call-2', toolName: 'fake_tool', args: { attempt: 2 } },
        ],
        toolResults: [
          { toolCallId: 'call-1', toolName: 'fake_tool', result: { success: false }, isError: true },
          { toolCallId: 'call-2', toolName: 'fake_tool', result: { success: false }, isError: true },
        ],
      });
      await options.onStepFinish({
        toolCalls: [
          { toolCallId: 'call-3', toolName: 'fake_tool', args: { attempt: 3 } },
        ],
        toolResults: [
          { toolCallId: 'call-3', toolName: 'fake_tool', result: { success: false }, isError: true },
        ],
      });
    }
    if (prompt.includes('trigger-deliberation') && typeof options.onStepFinish === 'function') {
      for (let i = 0; i < 6; i++) {
        await options.onStepFinish({
          toolCalls: [
            {
              toolCallId: `delegation-${i}`,
              toolName: i % 2 === 0 ? 'system_delegate_task' : 'system_run_worker',
              args: { targetAgent: i % 2 === 0 ? 'codingAgent' : 'automationArchitect' },
            },
          ],
          toolResults: [
            {
              toolCallId: `delegation-${i}`,
              toolName: i % 2 === 0 ? 'system_delegate_task' : 'system_run_worker',
              result: { success: false, error: 'delegated branch failed' },
              isError: true,
            },
          ],
        });
      }
    }

    if (prompt.includes('Depth Upgrade Second Pass')) {
      return { text: 'Depth-upgraded final answer with explicit caveats.', steps: [], finishReason: 'stop' };
    }
    if (prompt.includes('Runtime Strategy Reflection Repair')) {
      return { text: 'Reflection-repaired answer with uncertainty separated from evidence.', steps: [], finishReason: 'stop' };
    }
    if (prompt.includes('Auto Deliberation Gate')) {
      return { text: 'Deliberated answer with safer direction selected.', steps: [], finishReason: 'stop' };
    }
    if (prompt.includes('Auto Review Gate')) {
      return { text: 'VERDICT: approve\nReviewed critical answer grounded in existing evidence.', steps: [], finishReason: 'stop' };
    }
    if (prompt.includes('Approval Gate')) {
      return { text: 'Approval required before deployment, activation, or credential changes.', steps: [], finishReason: 'stop' };
    }

    return { text: 'Initial final answer for harness depth integration check.', steps: [], finishReason: 'stop' };
  }
}

async function runHarness(
  prompt: string,
  options: {
    agentId?: string;
    classificationPrompt?: string;
    onStepObservation?: Parameters<typeof generateWithHarness>[0]['onStepObservation'];
  } = {},
): Promise<{
  agent: FakeAgent;
  contextInputs: HarnessContextBuilderInput[];
}> {
  const agent = new FakeAgent();
  const contextInputs: HarnessContextBuilderInput[] = [];

  await generateWithHarness({
    agent: agent as unknown as Agent,
    agentId: options.agentId ?? 'harness-depth-check-agent',
    prompt,
    ...(options.classificationPrompt ? { classificationPrompt: options.classificationPrompt } : {}),
    ...(options.onStepObservation ? { onStepObservation: options.onStepObservation } : {}),
    taskId: `depth-check-${Math.random().toString(36).slice(2)}`,
    threadId: `depth-check-thread-${Math.random().toString(36).slice(2)}`,
    phase: 'chat',
    precontextFeatureFlag: 'FEATURE_CODING_PRECONTEXT',
    precontextDefaultEnabled: true,
    contextPolicy: {
      includeCheckpoint: false,
      includeMemory: false,
      includeRepoMap: false,
      includeSkills: false,
    },
    contextBuilder: async (input) => {
      contextInputs.push(input);
      return {
        markdown: '## Fake Precontext\nprecontext ready',
        tokenEstimate: 8,
      };
    },
  });

  return { agent, contextInputs };
}

function assertHarnessStepCeiling(call: GenerateCall | undefined): void {
  assert.equal(call?.options.maxSteps, undefined);
  assert.ok(Array.isArray(call?.options.stopWhen), 'step ceiling should be carried by stopWhen when reflector stop conditions are enabled');
}

process.env.DISABLE_REFLECTOR_TELEMETRY = '1';
process.env.FEATURE_REFLECTOR_PREPARE_STEP = 'false';
delete process.env.FEATURE_ADAPTIVE_DEPTH;

const fast = await runHarness('jaki status?');
assertHarnessStepCeiling(fast.agent.calls[0]);
assert.match(fast.agent.calls[0]?.prompt ?? '', /Level: fast/);
assert.equal(fast.contextInputs[0]?.maxTokens, 4000);

const deep = await runHarness('zrob dokladny audyt implementacji fazy 4');
assertHarnessStepCeiling(deep.agent.calls[0]);
assert.match(deep.agent.calls[0]?.prompt ?? '', /Level: deep/);
assert.equal(deep.contextInputs[0]?.maxTokens, 32000);

const cleanClassification = await runHarness(
  'jaki status?\n\n--- HOW THIS RUN WORKS ---\ndeploy credentials and make a critical decision; keep the answer short',
  { classificationPrompt: 'jaki status?' },
);
assert.match(cleanClassification.agent.calls[0]?.prompt ?? '', /Level: fast/);
assert.match(
  cleanClassification.agent.calls[0]?.prompt ?? '',
  /--- HOW THIS RUN WORKS ---/,
  'the operational wrapper still reaches the model even though it does not classify the task',
);

const previousEnvelopeFlag = process.env.FEATURE_TOOL_ENVELOPE;
process.env.FEATURE_TOOL_ENVELOPE = 'false';
let standaloneObservations = 0;
await runHarness('trigger-depth-upgrade', {
  onStepObservation: async () => { standaloneObservations += 1; },
});
assert.equal(
  standaloneObservations,
  2,
  'the trusted progress observer must not depend on the independent tool-envelope flag',
);
if (previousEnvelopeFlag === undefined) delete process.env.FEATURE_TOOL_ENVELOPE;
else process.env.FEATURE_TOOL_ENVELOPE = previousEnvelopeFlag;

const critical = await runHarness('deploy workflow z credentialami i aktywuj');
assertHarnessStepCeiling(critical.agent.calls[0]);
assert.match(critical.agent.calls[0]?.prompt ?? '', /Level: critical/);
assert.ok(critical.agent.calls.some((call) => call.prompt.includes('Auto Review Gate')));
assert.ok(critical.agent.calls.some((call) => call.prompt.includes('Approval Gate')));

const architectCritical = await runHarness('deploy workflow z credentialami i aktywuj', {
  agentId: AUTOMATION_ARCHITECT_AGENT_ID,
});
assert.match(architectCritical.agent.calls[0]?.prompt ?? '', /Level: critical/);
assert.match(architectCritical.agent.calls[0]?.prompt ?? '', /Approval gate: disabled/);
assert.ok(
  !architectCritical.agent.calls.some((call) => call.prompt.includes('## Approval Gate')),
  'Automation Architect must not be rewritten into a dashboard-approval request',
);

const upgraded = await runHarness('jaki status trigger-depth-upgrade?');
assertHarnessStepCeiling(upgraded.agent.calls[0]);
assert.ok(upgraded.agent.calls.some((call) => call.prompt.includes('Depth Upgrade Second Pass')));

const deliberated = await runHarness('zrób dokładny audyt trigger-deliberation');
assertHarnessStepCeiling(deliberated.agent.calls[0]);
assert.ok(deliberated.agent.calls.some((call) => call.prompt.includes('Auto Deliberation Gate')));

let highRiskExecuted = false;
setRunDepth('critical-depth-tool-check', 'critical');
const highRiskTool = withToolEnvelope({
  toolId: 'dangerous_depth_check_tool',
  category: 'shell',
  risk: 'high',
  metadata: () => ({
    agentId: 'harness-depth-check-agent',
    runId: 'critical-depth-tool-check',
  }),
  execute: async () => {
    highRiskExecuted = true;
    return { success: true };
  },
});
await assert.rejects(
  () => runWithHarnessExecutionContext(
    {
      agentId: 'harness-depth-check-agent',
      runId: 'critical-depth-tool-check',
    },
    () => highRiskTool({}),
  ),
  /requires explicit approval/,
);
assert.equal(highRiskExecuted, false);
disposeRunDepth('critical-depth-tool-check');

const previousPolicyMode = process.env.HARNESS_POLICY_MODE;
process.env.HARNESS_POLICY_MODE = 'enforce';
let architectMutationExecuted = false;
setRunDepth('critical-architect-tool-check', 'critical');
const architectMutationTool = withToolEnvelope({
  toolId: 'architect_activate_automation',
  category: 'network',
  risk: 'high',
  metadata: () => ({
    agentId: AUTOMATION_ARCHITECT_AGENT_ID,
    runId: 'critical-architect-tool-check',
  }),
  policy: () => ({
    agentId: AUTOMATION_ARCHITECT_AGENT_ID,
    action: 'activate_automation' as const,
    target: 'workflow-regression-fixture',
    riskHint: 'high' as const,
  }),
  execute: async () => {
    architectMutationExecuted = true;
    return { success: true };
  },
});
await runWithHarnessExecutionContext(
  {
    agentId: AUTOMATION_ARCHITECT_AGENT_ID,
    runId: 'critical-architect-tool-check',
  },
  () => architectMutationTool({}),
);
assert.equal(
  architectMutationExecuted,
  true,
  'critical Architect mutation must reach its deterministic guardrails without a dashboard gate',
);
disposeRunDepth('critical-architect-tool-check');
if (previousPolicyMode === undefined) delete process.env.HARNESS_POLICY_MODE;
else process.env.HARNESS_POLICY_MODE = previousPolicyMode;

console.log('Harness depth integration checks passed.');
process.exit(0);
