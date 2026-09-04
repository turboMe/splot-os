/** Deterministic Mastra provider-boundary proof; no external/live model calls. */
import assert from 'node:assert/strict';

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

import type { Skill, SkillMetadata, SkillSearchResult } from '../services/skill-registry.js';
import { createTransientSkillShelfProcessor } from '../processors/transient-skill-shelf.js';

function makeSkill(name: string, marker: string): Skill {
  return {
    metadata: { name, description: `${name} test skill`, category: 'test', keywords: [name] },
    procedure: `${marker}: follow this deterministic procedure.`,
    filePath: `/fake/${name}.md`,
    embedding: [1, 0],
  };
}

const skills = [makeSkill('alpha-skill', 'ALPHA_MARKER'), makeSkill('beta-skill', 'BETA_MARKER')];
const registry = {
  async search(): Promise<SkillSearchResult[]> {
    return skills.map((entry, index) => ({ ...entry, score: 0.9 - index * 0.1 }));
  },
  async load(name: string): Promise<Skill | null> {
    return skills.find((entry) => entry.metadata.name === name) ?? null;
  },
  list(): SkillMetadata[] {
    return skills.map((entry) => entry.metadata);
  },
  categories(): Record<string, number> {
    return { test: skills.length };
  },
};

const legacySkillTool = (id: string) => createTool({
  id,
  description: `Legacy ${id} rollback surface`,
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

function stopResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: 'stop' as const,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    warnings: [],
  };
}

const previousFlag = process.env.FEATURE_INTERIM_SKILL_SHELF;
const previousAgents = process.env.INTERIM_SKILL_SHELF_AGENTS;
const previousEnvelope = process.env.FEATURE_TOOL_ENVELOPE;
process.env.FEATURE_INTERIM_SKILL_SHELF = 'true';
process.env.INTERIM_SKILL_SHELF_AGENTS = '*';
process.env.FEATURE_TOOL_ENVELOPE = 'false';

try {
  let call = 0;
  const offeredPerCall: string[][] = [];
  const model = new MockLanguageModelV3({
    modelId: 'mock-skill-shelf',
    doGenerate: (async (options: any) => {
      call += 1;
      const offered = Array.isArray(options.tools)
        ? options.tools.map((tool: any) => tool.name).filter(Boolean)
        : [];
      offeredPerCall.push(offered);
      for (const name of ['skill_search', 'skill_load', 'skill_list_active', 'skill_swap', 'skill_release']) {
        assert.ok(offered.includes(name), `${name} must be serialized on call ${call}`);
      }
      const prompt = JSON.stringify(options.prompt ?? options.messages ?? []);

      if (call === 1) {
        assert.ok(!prompt.includes('ALPHA_MARKER'));
        return {
          content: [{ type: 'tool-call' as const, toolCallId: 'load-alpha', toolName: 'skill_load', input: JSON.stringify({ skillName: 'alpha-skill' }) }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      if (call === 2) {
        assert.ok(prompt.includes('ALPHA_MARKER'), 'loaded procedure must reach the next provider call');
        return {
          content: [{ type: 'tool-call' as const, toolCallId: 'swap-beta', toolName: 'skill_swap', input: JSON.stringify({ releaseSkillNames: ['alpha-skill'], loadSkillNames: ['beta-skill'] }) }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      if (call === 3) {
        assert.ok(prompt.includes('BETA_MARKER'));
        assert.ok(!prompt.includes('ALPHA_MARKER'), 'swapped-out procedure must disappear');
        return {
          content: [{ type: 'tool-call' as const, toolCallId: 'release-beta', toolName: 'skill_release', input: JSON.stringify({ skillNames: ['beta-skill'] }) }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      assert.ok(!prompt.includes('BETA_MARKER'), 'released procedure must disappear on the next provider call');
      return stopResult('skill shelf complete');
    }) as any,
  });

  const agent = new Agent({
    id: 'skill-shelf-e2e',
    name: 'skill-shelf-e2e',
    instructions: 'Follow the deterministic test provider.',
    model: model as any,
    tools: {
      skill_search: legacySkillTool('skill_search'),
      skill_load: legacySkillTool('skill_load'),
    },
    inputProcessors: [createTransientSkillShelfProcessor({
      agentId: 'skill-shelf-e2e',
      registry,
      onSkillLoaded: async () => undefined,
      profile: { maxActive: 2, maxActiveChars: 4_000, searchTopK: 5, minScore: 0 },
    })],
  });

  const result = await agent.generate('Exercise the request-scoped skill shelf.', { maxSteps: 6 });
  assert.equal(result.text, 'skill shelf complete');
  assert.equal(offeredPerCall.length, 4);
  console.log('✅ transient skill shelf provider E2E passed (MockLanguageModelV3; no live model)');
} finally {
  if (previousFlag === undefined) delete process.env.FEATURE_INTERIM_SKILL_SHELF;
  else process.env.FEATURE_INTERIM_SKILL_SHELF = previousFlag;
  if (previousAgents === undefined) delete process.env.INTERIM_SKILL_SHELF_AGENTS;
  else process.env.INTERIM_SKILL_SHELF_AGENTS = previousAgents;
  if (previousEnvelope === undefined) delete process.env.FEATURE_TOOL_ENVELOPE;
  else process.env.FEATURE_TOOL_ENVELOPE = previousEnvelope;
}
