import assert from 'node:assert/strict';

import type { Agent } from '@mastra/core/agent';
import { MongoClient } from 'mongodb';
import { installMetaAgentHarness, mentionsDelegationOrLedger } from '../services/meta-harness.js';

type GenerateCall = {
  prompt: string;
  options: Record<string, any>;
};

class FakeMetaAgent {
  calls: GenerateCall[] = [];
  readonly configuredProcessor = { id: 'fake-meta-configured-processor' };
  processorContexts: unknown[] = [];

  async listConfiguredInputProcessors(requestContext?: unknown): Promise<unknown[]> {
    this.processorContexts.push(requestContext);
    return [this.configuredProcessor];
  }

  async generate(prompt: string, options: Record<string, any> = {}): Promise<{ text: string; steps: any[]; finishReason: string }> {
    this.calls.push({ prompt, options });

    if (prompt.includes('Auto Review Gate')) {
      return { text: 'VERDICT: approve\nReviewed root meta answer.', steps: [], finishReason: 'stop' };
    }
    if (prompt.includes('Approval Gate')) {
      return { text: 'Approval required before deployment, activation, or credential changes.', steps: [], finishReason: 'stop' };
    }

    return { text: 'Initial root meta answer.', steps: [], finishReason: 'stop' };
  }
}

process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

assert.equal(mentionsDelegationOrLedger('Jaki jest status delegacji?'), true);
assert.equal(mentionsDelegationOrLedger('Sprawdź Task Ledger.'), true);
assert.equal(mentionsDelegationOrLedger('Jaka jest pogoda w Reykjavíku?'), false);

const fake = new FakeMetaAgent();
const runId = `meta-root-harness-check-${Date.now()}`;
const wrapped = installMetaAgentHarness(fake as unknown as Agent) as unknown as {
  generate: (prompt: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

await wrapped.generate(
  [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'TRYB TESTOWY / DRY RUN. Audit przed deployem workflow z credentialami. Nie deployuj i nie aktywuj.',
        },
      ],
    },
  ],
  {
    taskId: runId,
    runId,
    memory: {
      thread: 'meta-root-thread-check',
      resource: 'meta-root-user-check',
    },
    maxSteps: 99,
    requestContext: { source: 'meta-harness-regression' },
  },
);

assert.ok(fake.calls.length >= 2, 'meta harness did not call underlying agent');
assert.match(fake.calls[0]?.prompt ?? '', /## Execution Depth/);
assert.match(fake.calls[0]?.prompt ?? '', /Level: critical/);
assert.equal(fake.calls[0]?.options.maxSteps, undefined);
assert.ok(Array.isArray(fake.calls[0]?.options.stopWhen), 'meta harness should carry the step ceiling through stopWhen');
assert.equal(fake.calls[0]?.options.memory?.thread, 'meta-root-thread-check');
assert.equal(fake.calls[0]?.options.memory?.resource, 'meta-root-user-check');
assert.ok(
  fake.calls[0]?.options.inputProcessors?.includes(fake.configuredProcessor),
  'meta harness must preserve configured processors while appending the abort fence',
);
assert.deepEqual(
  (fake.processorContexts[0] as any)?.all ?? fake.processorContexts[0],
  { source: 'meta-harness-regression' },
  'dynamic processors must receive the original requestContext',
);
assert.ok(
  fake.calls[0]?.options.inputProcessors?.some(
    (processor: { id?: string }) => processor.id === 'harness-abort-tool-fence',
  ),
  'meta harness must append the abort fence after its configured processors',
);
assert.ok(fake.calls.some((call) => call.prompt.includes('Auto Review Gate')), 'critical meta run skipped auto review');
assert.ok(fake.calls.some((call) => call.prompt.includes('Approval Gate')), 'critical meta run skipped approval gate');

const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentforge', {
  serverSelectionTimeoutMS: 3000,
});
await client.connect();
const db = client.db();

const run = await db.collection('agent_runs').findOne({ runId });
assert.equal(run?.status, 'completed');
assert.ok(run?.completedAt, 'completed meta run is missing completedAt');

const completedEvent = await db.collection('agent_run_events').findOne({ runId, type: 'run_completed' });
assert.ok(completedEvent, 'meta run is missing run_completed event');
assert.ok(completedEvent.artifactId || completedEvent.data?.outputArtifactId, 'run_completed event is missing output artifact id');

const artifact = await db.collection('harness_artifacts').findOne({ runId, kind: 'llm_output' });
assert.ok(artifact, 'meta run is missing full llm_output artifact');
assert.match(String(artifact.content ?? ''), /Approval required|Initial root meta answer|Reviewed root meta answer/);

await client.close();

console.log('Meta harness wrapper checks passed.');
process.exit(0);
