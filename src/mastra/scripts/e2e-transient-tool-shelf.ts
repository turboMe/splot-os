/**
 * Deterministic provider-boundary proof for the transient tool shelf.
 * Verifies the real Mastra loop serializes a bounded schema set, applies load
 * on the next step, applies release on the next step, and restores the full
 * static payload when the feature flag is disabled.
 */
import assert from 'node:assert/strict';

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

import { createTransientToolShelfProcessor } from '../processors/transient-tool-shelf.js';

const TARGET = 'tool_37';

function makeTools() {
  return Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
    const key = `tool_${String(index).padStart(2, '0')}`;
    const tool = createTool({
      id: key,
      description: `Capability ${key}. ${'Detailed provider schema description for realistic token pressure. '.repeat(4)}`,
      inputSchema: z.object({
        query: z.string().describe('Primary query or payload for this capability'),
        options: z.object({
          locale: z.string().optional(),
          limit: z.number().int().positive().optional(),
          includeMetadata: z.boolean().optional(),
        }).optional(),
      }),
      outputSchema: z.object({ ok: z.boolean(), key: z.string() }),
      execute: async () => ({ ok: true, key }),
    });
    return [key, tool];
  }));
}

function stopResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: 'stop' as const,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    warnings: [],
  };
}

async function captureBaseline(tools: ReturnType<typeof makeTools>): Promise<number> {
  process.env.FEATURE_INTERIM_TOOL_SHELF = 'false';
  let payloadChars = 0;
  const model = new MockLanguageModelV3({
    modelId: 'mock-tool-shelf-baseline',
    doGenerate: (async (options: any) => {
      assert.equal(options.tools?.length, 40, 'rollback must restore all static tool schemas');
      payloadChars = JSON.stringify(options.tools ?? []).length;
      return stopResult('baseline');
    }) as any,
  });
  const agent = new Agent({
    id: 'tool-shelf-e2e',
    name: 'tool-shelf-e2e',
    instructions: 'Test agent.',
    model: model as any,
    tools,
    inputProcessors: [createTransientToolShelfProcessor({
      agentId: 'tool-shelf-e2e',
      profile: { coreTools: ['tool_00'], corePatterns: [], initialTopK: 2, maxActive: 4, searchTopK: 5 },
    })],
  });
  await agent.generate('Prepare a bounded task.', { maxSteps: 2 });
  return payloadChars;
}

async function captureShelfRun(tools: ReturnType<typeof makeTools>) {
  process.env.FEATURE_INTERIM_TOOL_SHELF = 'true';
  const offeredPerCall: string[][] = [];
  const payloadCharsPerCall: number[] = [];
  let call = 0;

  const model = new MockLanguageModelV3({
    modelId: 'mock-tool-shelf-active',
    doGenerate: (async (options: any) => {
      call += 1;
      const offered = Array.isArray(options.tools)
        ? options.tools.map((tool: any) => tool.name).filter(Boolean)
        : [];
      offeredPerCall.push(offered);
      payloadCharsPerCall.push(JSON.stringify(options.tools ?? []).length);

      if (call === 1) {
        assert.ok(!offered.includes(TARGET), 'target must begin on the shelf');
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: 'load-target',
            toolName: 'load_tool',
            input: JSON.stringify({ toolName: TARGET }),
          }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      if (call === 2) {
        assert.ok(offered.includes(TARGET), 'loaded target must be serialized on the next call');
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: 'use-target',
            toolName: TARGET,
            input: JSON.stringify({ query: 'test' }),
          }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      if (call === 3) {
        assert.ok(offered.includes(TARGET), 'used target must remain active until explicitly released');
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: 'release-target',
            toolName: 'release_tools',
            input: JSON.stringify({ toolNames: [TARGET] }),
          }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      assert.ok(!offered.includes(TARGET), 'released target must disappear on the next call');
      return stopResult('shelf complete');
    }) as any,
  });

  const agent = new Agent({
    id: 'tool-shelf-e2e',
    name: 'tool-shelf-e2e',
    instructions: 'Use the tool shelf as directed by the scripted provider.',
    model: model as any,
    tools,
    inputProcessors: [createTransientToolShelfProcessor({
      agentId: 'tool-shelf-e2e',
      profile: { coreTools: ['tool_00'], corePatterns: [], initialTopK: 2, maxActive: 4, searchTopK: 5 },
    })],
  });
  const result = await agent.generate('Prepare a bounded task.', { maxSteps: 6 });
  assert.equal(result.text, 'shelf complete');
  return { offeredPerCall, payloadCharsPerCall };
}

const previousFlag = process.env.FEATURE_INTERIM_TOOL_SHELF;
const previousAgents = process.env.INTERIM_TOOL_SHELF_AGENTS;
try {
  process.env.INTERIM_TOOL_SHELF_AGENTS = '*';
  const tools = makeTools();
  const baselineChars = await captureBaseline(tools);
  const active = await captureShelfRun(tools);
  const initialChars = active.payloadCharsPerCall[0] ?? Number.POSITIVE_INFINITY;
  const reduction = 1 - initialChars / baselineChars;

  assert.ok(baselineChars > 0, 'baseline provider payload must be captured');
  assert.ok(reduction >= 0.7, `expected >=70% provider tool-definition reduction, got ${(reduction * 100).toFixed(1)}%`);
  assert.ok(active.offeredPerCall[0]?.includes('search_tools'));
  assert.ok(active.offeredPerCall[0]?.includes('load_tool'));
  assert.ok(active.offeredPerCall[0]?.includes('release_tools'));

  console.log('✅ transient tool shelf provider E2E passed');
  console.log(`   • baseline tool-definition payload: ${baselineChars} chars`);
  console.log(`   • initial shelf payload: ${initialChars} chars`);
  console.log(`   • reduction: ${(reduction * 100).toFixed(1)}%`);
  console.log(`   • offered per call: ${JSON.stringify(active.offeredPerCall)}`);
} finally {
  if (previousFlag === undefined) delete process.env.FEATURE_INTERIM_TOOL_SHELF;
  else process.env.FEATURE_INTERIM_TOOL_SHELF = previousFlag;
  if (previousAgents === undefined) delete process.env.INTERIM_TOOL_SHELF_AGENTS;
  else process.env.INTERIM_TOOL_SHELF_AGENTS = previousAgents;
}
