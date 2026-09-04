import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { Skill, SkillMetadata, SkillSearchResult } from '../services/skill-registry.js';
import {
  TRANSIENT_SKILL_SHELF_META_TOOL_NAMES,
  TransientSkillShelfProcessor,
} from '../processors/transient-skill-shelf.js';
import { intersectTransientActiveTools } from '../processors/transient-tool-shelf.js';

function skill(name: string, procedure: string, category = 'test'): Skill {
  return {
    metadata: {
      name,
      description: `${name} procedure`,
      category,
      keywords: [name, category],
      allowedTools: ['ordinary_tool'],
      successRate: 0.9,
      totalUses: 4,
    },
    procedure,
    filePath: `/fake/${name}.md`,
    embedding: [1, 0],
  };
}

function fakeRegistry(skills: Skill[]) {
  const byName = new Map(skills.map((entry) => [entry.metadata.name, entry]));
  return {
    async search(query: string, opts: { category?: string; topK?: number } = {}): Promise<SkillSearchResult[]> {
      const candidates = opts.category
        ? skills.filter((entry) => entry.metadata.category === opts.category)
        : skills;
      return candidates
        .filter((entry) => `${entry.metadata.name} ${entry.metadata.description} ${entry.metadata.category}`.toLowerCase().includes(query.toLowerCase()))
        .slice(0, opts.topK ?? 5)
        .map((entry, index) => ({ ...entry, score: 0.95 - index * 0.05 }));
    },
    async load(name: string): Promise<Skill | null> {
      return byName.get(name) ?? null;
    },
    list(): SkillMetadata[] {
      return skills.map((entry) => entry.metadata);
    },
    categories(): Record<string, number> {
      return skills.reduce<Record<string, number>>((counts, entry) => {
        const category = entry.metadata.category ?? 'general';
        counts[category] = (counts[category] ?? 0) + 1;
        return counts;
      }, {});
    },
  };
}

function fakeTool(id: string) {
  return createTool({
    id,
    description: id,
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => ({ ok: true }),
  });
}

function messageListStub() {
  const system: string[] = [];
  return {
    system,
    addSystem(value: string) {
      system.push(value);
    },
  };
}

const legacyTools = {
  ordinary_tool: fakeTool('ordinary_tool'),
  skill_search: fakeTool('skill_search'),
  skill_load: fakeTool('skill_load'),
};

function stepArgs(state: Record<string, unknown>, stepNumber: number) {
  return {
    messages: [{
      id: 'message-1',
      role: 'user',
      content: { format: 2, parts: [{ type: 'text', text: 'Use a security procedure.' }] },
      createdAt: new Date(),
    }],
    messageList: messageListStub(),
    stepNumber,
    steps: [],
    systemMessages: [],
    state,
    model: 'test/model',
    tools: legacyTools,
    activeTools: Object.keys(legacyTools),
    retryCount: 0,
    abort: (reason?: string) => {
      throw new Error(reason ?? 'aborted');
    },
  } as never;
}

async function main(): Promise<void> {
  const previousFlag = process.env.FEATURE_INTERIM_SKILL_SHELF;
  const previousAgents = process.env.INTERIM_SKILL_SHELF_AGENTS;
  const previousEnvelope = process.env.FEATURE_TOOL_ENVELOPE;
  process.env.FEATURE_INTERIM_SKILL_SHELF = 'true';
  process.env.INTERIM_SKILL_SHELF_AGENTS = '*';
  process.env.FEATURE_TOOL_ENVELOPE = 'false';

  try {
    const alpha = skill('security-alpha', 'ALPHA PROCEDURE '.repeat(8), 'security');
    const beta = skill('security-beta', 'BETA PROCEDURE '.repeat(8), 'security');
    const oversized = skill('oversized', 'X'.repeat(700), 'security');
    const registry = fakeRegistry([alpha, beta, oversized]);
    const viewed: string[] = [];
    const processor = new TransientSkillShelfProcessor({
      agentId: 'test-agent',
      registry,
      onSkillLoaded: async (name) => { viewed.push(name); },
      profile: { maxActive: 2, maxActiveChars: 500, searchTopK: 5, minScore: 0 },
    });

    const stateA: Record<string, unknown> = {};
    const firstArgs = stepArgs(stateA, 0) as any;
    const first = await processor.processInputStep(firstArgs) as any;
    for (const name of TRANSIENT_SKILL_SHELF_META_TOOL_NAMES) {
      assert.ok(first.activeTools.includes(name), `${name} must remain visible`);
      assert.ok(first.tools[name], `${name} must be registered`);
    }
    assert.ok(firstArgs.messageList.system[0]?.includes('request-scoped skill shelf'));

    const search = await first.tools.skill_search.execute({ query: 'security', category: 'security' }, {} as never);
    assert.equal(search.success, true);
    assert.equal(search.results.length, 3);
    assert.equal(search.results[0]?.active, false);

    const loaded = await first.tools.skill_load.execute({ skillName: 'security-alpha' }, {} as never);
    assert.equal(loaded.success, true);
    assert.deepEqual(loaded.loaded, ['security-alpha']);
    assert.deepEqual(viewed, ['security-alpha'], 'activation must retain skill-view telemetry');
    assert.ok(!('procedure' in loaded), 'load result must not duplicate the full procedure');

    const secondArgs = stepArgs(stateA, 1) as any;
    const second = await processor.processInputStep(secondArgs) as any;
    assert.ok(secondArgs.messageList.system.join('\n').includes('ALPHA PROCEDURE'));
    const listed = await second.tools.skill_list_active.execute({}, {} as never);
    assert.equal(listed.active[0]?.name, 'security-alpha');
    assert.ok(listed.totalChars > 0);

    const oversizedLoad = await second.tools.skill_load.execute({ skillName: 'oversized' }, {} as never);
    assert.equal(oversizedLoad.success, false);
    assert.deepEqual(oversizedLoad.budgetRejected, ['oversized']);
    assert.deepEqual(oversizedLoad.active, ['security-alpha'], 'failed load must be atomic');

    const swapped = await second.tools.skill_swap.execute({
      releaseSkillNames: ['security-alpha'],
      loadSkillNames: ['security-beta'],
    }, {} as never);
    assert.equal(swapped.success, true);
    assert.deepEqual(swapped.released, ['security-alpha']);
    assert.deepEqual(swapped.loaded, ['security-beta']);
    assert.deepEqual(viewed, ['security-alpha', 'security-beta']);

    const thirdArgs = stepArgs(stateA, 2) as any;
    const third = await processor.processInputStep(thirdArgs) as any;
    const thirdSystem = thirdArgs.messageList.system.join('\n');
    assert.ok(thirdSystem.includes('BETA PROCEDURE'));
    assert.ok(!thirdSystem.includes('ALPHA PROCEDURE'));

    const rejectedSwap = await third.tools.skill_swap.execute({
      releaseSkillNames: ['security-beta'],
      loadSkillNames: ['missing'],
    }, {} as never);
    assert.equal(rejectedSwap.success, false);
    assert.deepEqual(rejectedSwap.active, ['security-beta'], 'failed swap must preserve the old shelf');

    const released = await third.tools.skill_release.execute({ skillNames: ['security-beta'] }, {} as never);
    assert.equal(released.success, true);
    assert.deepEqual(released.active, []);
    const fourthArgs = stepArgs(stateA, 3) as any;
    await processor.processInputStep(fourthArgs);
    assert.ok(!fourthArgs.messageList.system.join('\n').includes('BETA PROCEDURE'));

    const isolatedArgs = stepArgs({}, 0) as any;
    const isolated = await processor.processInputStep(isolatedArgs) as any;
    const isolatedList = await isolated.tools.skill_list_active.execute({}, {} as never);
    assert.deepEqual(isolatedList.active, [], 'skill state must not leak between requests');

    const constrained = intersectTransientActiveTools(first.tools, first.activeTools, ['ordinary_tool']);
    for (const name of TRANSIENT_SKILL_SHELF_META_TOOL_NAMES) {
      assert.ok(constrained?.includes(name), `${name} must survive harness/phase allowlists`);
    }

    process.env.FEATURE_INTERIM_SKILL_SHELF = 'false';
    const disabled = await processor.processInputStep(stepArgs({}, 0));
    assert.equal(disabled, undefined, 'off mode must leave legacy skill_search/skill_load untouched');

    const shelfAgentFiles = [
      'automation-architect.ts', 'capability-smith.ts', 'chef-agent.ts', 'code-review-agent.ts',
      'coding-agent.ts', 'content-agent.ts', 'design-agent.ts', 'film-agent.ts', 'hunt-agent.ts',
      'knowledge-agent.ts', 'marketing-agent.ts', 'musician-agent.ts', 'n8n-mcp-engineer.ts',
      'performance-review-agent.ts', 'researcher-agent.ts', 'security-review-agent.ts', 'writer-agent.ts',
    ];
    for (const file of shelfAgentFiles) {
      const source = readFileSync(`src/mastra/agents/${file}`, 'utf8');
      assert.ok(source.includes('createTransientSkillShelfProcessor'), `${file} must attach the Skill Shelf`);
      assert.ok(/skill_search\s*:/.test(source), `${file} must retain legacy skill_search for flag rollback`);
      assert.ok(/skill_load\s*:/.test(source), `${file} must retain legacy skill_load for flag rollback`);
      assert.ok(source.includes('shared/skill-shelf'), `${file} must compose the shared Skill Shelf prompt contract`);
    }

    const metaSource = readFileSync('src/mastra/agents/meta-agent.ts', 'utf8');
    assert.ok(!metaSource.includes('createTransientSkillShelfProcessor'), 'Meta must keep discovery-only skill routing');
    assert.ok(metaSource.includes('skillSearchTool'), 'Meta must retain direct skill discovery for worker routing');

    console.log('✅ transient skill shelf: semantic search contract, load/list/swap/release, budgets, isolation, composition and rollback verified');
  } finally {
    if (previousFlag === undefined) delete process.env.FEATURE_INTERIM_SKILL_SHELF;
    else process.env.FEATURE_INTERIM_SKILL_SHELF = previousFlag;
    if (previousAgents === undefined) delete process.env.INTERIM_SKILL_SHELF_AGENTS;
    else process.env.INTERIM_SKILL_SHELF_AGENTS = previousAgents;
    if (previousEnvelope === undefined) delete process.env.FEATURE_TOOL_ENVELOPE;
    else process.env.FEATURE_TOOL_ENVELOPE = previousEnvelope;
  }
}

await main();
