import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  CapabilityCatalog,
  type ExecutionCapability,
} from '../services/capability-catalog.js';
import {
  UNIFIED_CAPABILITY_SHELF_META_NAMES,
  UNIFIED_CAPABILITY_SHELF_LEGACY_ALIASES,
  UnifiedCapabilityShelfProcessor,
} from '../processors/unified-capability-shelf.js';
import {
  getCapabilityShelfProfile,
  CAPABILITY_SHELF_PROFILES,
} from '../config/capability-shelf-profiles.js';

function fakeTool(id: string, description = `${id} description`) {
  return createTool({
    id,
    description,
    inputSchema: z.object({ query: z.string().optional() }),
    outputSchema: z.object({ ok: z.boolean(), result: z.string().optional() }),
    execute: async () => ({ ok: true, result: `executed ${id}` }),
  });
}

function fakeSkillCapability(name: string, description: string, procedure: string, category = 'test'): ExecutionCapability {
  return {
    type: 'skill',
    id: `skill:${name}`,
    name,
    description,
    category,
    keywords: [name, category],
    allowedTools: ['git_status_tool'],
    procedure,
    embedding: [0.9, 0.1, 0.0],
  };
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

async function runTests() {
  console.log('🧪 [TEST 1/7] CapabilityCatalog hybrid indexing and retrieval...');
  {
    const tools: Record<string, any> = {
      git_diff_tool: fakeTool('git_diff_tool', 'Show changes in git repository worktree and staging'),
      web_search_tool: fakeTool('web_search_tool', 'Search the web for current market news and research'),
      lead_finder_tool: fakeTool('lead_finder_tool', 'Find B2B sales leads and CRM contact data'),
    };

    const skills: ExecutionCapability[] = [
      fakeSkillCapability('menu-recon', 'Analyze restaurant menu structure and pricing', '1. Fetch menu\n2. Calculate margins\n3. Format report', 'gastro'),
      fakeSkillCapability('code-refactor', 'Refactor TypeScript modules with clean architecture', '1. Plan changes\n2. Apply AST transforms', 'coding'),
    ];

    const catalog = new CapabilityCatalog({
      tools,
      skills,
      embeddingsEnabled: false,
    });

    const resultsGit = await catalog.search('git changes diff worktree', { topK: 3 });
    assert.ok(resultsGit.length > 0, 'Should return results for git query');
    assert.strictEqual(resultsGit[0].capability.id, 'git_diff_tool', 'Top result should be git_diff_tool');

    const resultsMenu = await catalog.search('restaurant menu margins gastro', { topK: 3 });
    assert.ok(resultsMenu.length > 0, 'Should return results for menu query');
    assert.strictEqual(resultsMenu[0].capability.name, 'menu-recon', 'Top result should be menu-recon skill');
    console.log('  ✓ Catalog search and scoring passed');
  }

  console.log('🧪 [TEST 2/7] UnifiedCapabilityShelfProcessor Step 0 Preselection...');
  {
    const tools: Record<string, any> = {
      menu_scraper: fakeTool('menu_scraper', 'Scrapes restaurant menu data'),
      git_status_tool: fakeTool('git_status_tool', 'Shows git status'),
    };

    const skills: ExecutionCapability[] = [
      fakeSkillCapability('menu-recon', 'Analyze restaurant menu items', '1. Parse menu\n2. Synthesize', 'gastro'),
    ];

    const catalog = new CapabilityCatalog({ tools, skills, embeddingsEnabled: false });

    const processor = new UnifiedCapabilityShelfProcessor({
      agentId: 'chef-agent',
      catalog,
      skillsDir: [],
    });

    const state: Record<string, unknown> = {};
    const messageList = messageListStub();

    await processor.processInputStep({
      messages: [{
        id: 'msg-1',
        role: 'user',
        content: { format: 2, parts: [{ type: 'text', text: 'Zrób audyt menu dla tej restauracji' }] },
        createdAt: new Date(),
      }],
      messageList,
      stepNumber: 0,
      steps: [],
      systemMessages: [],
      state,
      model: 'test-model',
      tools,
      activeTools: ['menu_scraper'],
    } as any);

    // Verify that menu-recon was preselected and injected into system messages
    assert.ok(messageList.system.length > 0, 'System message should contain active skill');
    assert.ok(messageList.system[0].includes('<active-skill id="menu-recon"'), 'Should inject <active-skill> tag');
    assert.ok(messageList.system[0].includes('1. Parse menu'), 'Should contain skill procedure');
    console.log('  ✓ Step 0 preselection and skill injection passed');
  }

  console.log('🧪 [TEST 3/7] Domain Pinning for narrow/creative agents...');
  {
    const profile = getCapabilityShelfProfile('design-agent');
    assert.strictEqual(profile.preserveConfiguredToolsAsCore, true, 'design-agent must have preserveConfiguredToolsAsCore: true');

    const creativeTools: Record<string, any> = {
      generate_image: fakeTool('generate_image', 'Generate UI designs and images'),
      analyze_palette: fakeTool('analyze_palette', 'Analyze color palette'),
      create_storyboard: fakeTool('create_storyboard', 'Storyboard video frames'),
    };

    const catalog = new CapabilityCatalog({ tools: creativeTools, skills: [], embeddingsEnabled: false });

    const processor = new UnifiedCapabilityShelfProcessor({
      agentId: 'design-agent',
      catalog,
      skillsDir: [],
    });

    const state: Record<string, unknown> = {};
    const messageList = messageListStub();

    const initialActive = Object.keys(creativeTools);
    const stepRes = await processor.processInputStep({
      messages: [{
        id: 'msg-1',
        role: 'user',
        content: { format: 2, parts: [{ type: 'text', text: 'Stwórz mockup strony logowania' }] },
        createdAt: new Date(),
      }],
      messageList,
      stepNumber: 0,
      steps: [],
      systemMessages: [],
      state,
      model: 'test-model',
      tools: creativeTools,
      activeTools: initialActive,
    } as any);

    const resultActive = stepRes?.activeTools;

    // Check that ALL original tools are preserved AND meta-tools are added
    assert.ok(resultActive?.includes('generate_image'), 'generate_image must remain active');
    assert.ok(resultActive?.includes('analyze_palette'), 'analyze_palette must remain active');
    assert.ok(resultActive?.includes('create_storyboard'), 'create_storyboard must remain active');
    assert.ok(resultActive?.includes('capability_search'), 'capability_search meta-tool must be added');
    assert.ok(resultActive?.includes('capability_load'), 'capability_load meta-tool must be added');
    console.log('  ✓ Domain Pinning keeps 100% core tools active');
  }

  console.log('🧪 [TEST 4/7] Dynamic Shelf & Auto-LRU for Hub Agents...');
  {
    const hubTools: Record<string, any> = {
      core_read: fakeTool('core_read', 'Core file reader'),
      tool_a: fakeTool('tool_a', 'Specialist tool A'),
      tool_b: fakeTool('tool_b', 'Specialist tool B'),
      tool_c: fakeTool('tool_c', 'Specialist tool C'),
      tool_d: fakeTool('tool_d', 'Specialist tool D'),
    };

    const catalog = new CapabilityCatalog({ tools: hubTools, skills: [], embeddingsEnabled: false });

    const processor = new UnifiedCapabilityShelfProcessor({
      agentId: 'test-hub',
      profile: {
        agentId: 'test-hub',
        coreTools: ['core_read'],
        maxActive: 2,
        initialTopK: 0,
        preserveConfiguredToolsAsCore: false,
      },
      catalog,
      skillsDir: [],
    });

    const state: Record<string, unknown> = {};
    const messageList = messageListStub();

    // Step 0: Initial state should have core_read + meta-tools
    let stepRes = await processor.processInputStep({
      messages: [{ id: 'm1', role: 'user', content: { format: 2, parts: [{ type: 'text', text: 'test' }] }, createdAt: new Date() }],
      messageList,
      stepNumber: 0,
      steps: [],
      systemMessages: [],
      state,
      model: 'test',
      tools: hubTools,
      activeTools: Object.keys(hubTools),
    } as any);

    let active = stepRes?.activeTools;
    assert.ok(active?.includes('core_read'), 'core_read must be in initial active tools');

    // Simulate model calling capability_load for tool_a and tool_b
    const loadTool = stepRes?.tools?.capability_load as any;

    await loadTool.execute({ capabilityId: 'tool_a' });
    await loadTool.execute({ capabilityId: 'tool_b' });

    // Step 1: active should have core_read, tool_a, tool_b
    stepRes = await processor.processInputStep({
      messages: [{ id: 'm2', role: 'user', content: { format: 2, parts: [{ type: 'text', text: 'test' }] }, createdAt: new Date() }],
      messageList,
      stepNumber: 1,
      steps: [],
      systemMessages: [],
      state,
      model: 'test',
      tools: hubTools,
      activeTools: active!,
    } as any);
    active = stepRes?.activeTools;

    assert.ok(active?.includes('tool_a'), 'tool_a should be active');
    assert.ok(active?.includes('tool_b'), 'tool_b should be active');

    // Now load tool_c -> tool_a was least recently used, so it should be evicted
    await loadTool.execute({ capabilityId: 'tool_c' });

    stepRes = await processor.processInputStep({
      messages: [{ id: 'm3', role: 'user', content: { format: 2, parts: [{ type: 'text', text: 'test' }] }, createdAt: new Date() }],
      messageList,
      stepNumber: 2,
      steps: [],
      systemMessages: [],
      state,
      model: 'test',
      tools: hubTools,
      activeTools: active!,
    } as any);
    active = stepRes?.activeTools;

    assert.ok(active?.includes('tool_c'), 'tool_c should be active');
    assert.ok(active?.includes('tool_b'), 'tool_b should be active (more recent)');
    assert.ok(!active?.includes('tool_a'), 'tool_a should be evicted due to maxActive=3');
    assert.ok(active?.includes('core_read'), 'core_read must NEVER be evicted');
    console.log('  ✓ Auto-LRU properly bounds tool slots and protects core tools');
  }

  console.log('🧪 [TEST 5/7] Backward Compatibility Aliases...');
  {
    const state: Record<string, unknown> = {};
    const tools: Record<string, any> = {
      search_leads: fakeTool('search_leads', 'Search leads'),
    };
    const skills: ExecutionCapability[] = [
      fakeSkillCapability('lead-scoring', 'Score leads', '1. Score', 'sales'),
    ];
    const catalog = new CapabilityCatalog({ tools, skills, embeddingsEnabled: false });

    const processor = new UnifiedCapabilityShelfProcessor({
      agentId: 'sales-agent',
      catalog,
      skillsDir: [],
    });

    const stepRes = await processor.processInputStep({
      messages: [{ id: 'm1', role: 'user', content: { format: 2, parts: [{ type: 'text', text: 'test' }] }, createdAt: new Date() }],
      messageList: messageListStub(),
      stepNumber: 0,
      steps: [],
      systemMessages: [],
      state,
      model: 'test',
      tools,
      activeTools: Object.keys(tools),
    } as any);

    const metaTools = stepRes?.tools as any;

    // Verify all 9 backward compatible aliases are registered
    for (const alias of UNIFIED_CAPABILITY_SHELF_LEGACY_ALIASES) {
      assert.ok(metaTools[alias], `Legacy alias ${alias} must exist in metaTools`);
    }

    // Test calling legacy `skill_load`
    const legacySkillLoad = metaTools.skill_load;
    const loadResult = await legacySkillLoad.execute({ name: 'lead-scoring' });
    assert.ok(loadResult.success, 'Legacy skill_load should succeed');
    assert.deepStrictEqual(loadResult.loaded, ['lead-scoring']);

    // Test calling legacy `search_tools`
    const legacyToolSearch = metaTools.search_tools;
    const searchResult = await legacyToolSearch.execute({ query: 'leads' });
    assert.ok(searchResult.results.length > 0, 'Legacy search_tools should return results');
    console.log('  ✓ All 9 backward compatible aliases operate transparently');
  }

  console.log('🧪 [TEST 6/7] Capability Shelf Profiles Integrity...');
  {
    const knownAgents = [
      'coding-agent',
      'researcher-agent',
      'marketing-agent',
      'automation-architect',
      'n8n-mcp-engineer',
      'chef-agent',
      'content-agent',
      'hunt-agent',
      'knowledge-agent',
      'capability-smith',
      'code-review-agent',
      'performance-review-agent',
      'security-review-agent',
      'design-agent',
      'writer-agent',
      'filmmaker-agent',
      'musician-agent',
    ];

    for (const agentId of knownAgents) {
      const profile = getCapabilityShelfProfile(agentId);
      assert.ok(profile, `Profile must exist for ${agentId}`);
      assert.ok(profile.maxActive >= 4, `maxActive for ${agentId} must be at least 4`);
      if (['design-agent', 'writer-agent', 'filmmaker-agent', 'musician-agent', 'chef-agent'].includes(agentId)) {
        assert.strictEqual(profile.preserveConfiguredToolsAsCore, true, `${agentId} must have preserveConfiguredToolsAsCore: true`);
      }
    }
    console.log(`  ✓ All ${knownAgents.length} agent profiles verified with proper domain rules`);
  }

  console.log('🧪 [TEST 7/7] Codebase Agent Definitions Integrity...');
  {
    const agentFiles = [
      'coding-agent.ts',
      'researcher-agent.ts',
      'marketing-agent.ts',
      'design-agent.ts',
      'writer-agent.ts',
      'film-agent.ts',
      'musician-agent.ts',
      'automation-architect.ts',
      'n8n-mcp-engineer.ts',
      'chef-agent.ts',
      'content-agent.ts',
      'hunt-agent.ts',
      'knowledge-agent.ts',
      'capability-smith.ts',
      'code-review-agent.ts',
      'performance-review-agent.ts',
      'security-review-agent.ts',
    ];

    for (const filename of agentFiles) {
      const fullPath = `/projekty/mastra-agentic-environment/agentic-agents/src/mastra/agents/${filename}`;
      const content = readFileSync(fullPath, 'utf8');

      // Check processor attachment
      assert.ok(
        content.includes('createUnifiedCapabilityShelfProcessor'),
        `${filename} must use createUnifiedCapabilityShelfProcessor`,
      );

      // Check that legacy processors are NOT used
      assert.ok(
        !content.includes('createTransientToolShelfProcessor'),
        `${filename} must not use obsolete createTransientToolShelfProcessor`,
      );
      assert.ok(
        !content.includes('createTransientSkillShelfProcessor'),
        `${filename} must not use obsolete createTransientSkillShelfProcessor`,
      );

      // Check that manual skill_search / skill_load are not hardcoded in tools
      assert.ok(
        !content.includes('skill_search: skillSearchTool'),
        `${filename} must not hardcode skill_search: skillSearchTool`,
      );
      assert.ok(
        !content.includes('skill_load: skillLoadTool'),
        `${filename} must not hardcode skill_load: skillLoadTool`,
      );
    }
    console.log(`  ✓ All ${agentFiles.length} agent files verified: unified processor attached and zero legacy duplicates`);
  }

  console.log('\n============================================================');
  console.log('🎉 ALL 7 TEST SUITES PASSED — UNIFIED CAPABILITY SHELF VERIFIED');
  console.log('============================================================');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
