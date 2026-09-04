#!/usr/bin/env tsx
/**
 * check:subagent-roles-enforced (J7, owner decision 2026-08-23) — the three
 * things "OŻYWIĆ I DOMKNĄĆ" actually asked for, each with a real defect
 * behind it (Z5, docs/MIGRACJA-DOMENY-CODING.md):
 *
 *   1. `role.promptTemplate` was declared, never read (`git log -S
 *      promptTemplate` = zero commits) — `buildScopedPrompt` built its own
 *      ad-hoc header instead of the real `subagent-*.md` files, which carry
 *      a "What You Do NOT Do" boundary, a JSON response contract, and
 *      security boundaries the ad-hoc version never had.
 *   2. `role.allowedTools` was printed as a bulleted list and nothing else —
 *      a terminal subagent could still call `coding_write_file_tracked`,
 *      the exact boundary its own role description promised it would not
 *      cross. Fixing this ALSO surfaced that the list used a `workspace_*`
 *      tool-name prefix that never matched any real registered key — a
 *      restriction built on names that don't exist restricts nothing.
 *   3. Model routing for terminal/qa (smart-router.ts) is covered by
 *      check:repair-model-floor, not repeated here.
 *
 * Run: npx tsx src/mastra/scripts/check-subagent-roles-enforced.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SUBAGENT_ROLES } from '../config/subagent-roles.js';
import { buildScopedPrompt } from '../services/subtask-executor.js';
import { TransientToolShelfProcessor } from '../processors/transient-tool-shelf.js';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('check:subagent-roles-enforced');

// ── 1. Prompt templates: the REAL file content reaches the prompt ─────────

function fakeSubtask(id: string, type: string) {
  return { id, type, dependencies: [], targetFiles: ['src/mastra/index.ts'], description: 'test' } as never;
}
const fakeContext = { previousResults: [] } as never;

await check('file-editor gets its real template content, not the old ad-hoc header', async () => {
  const prompt = await buildScopedPrompt(
    fakeSubtask('t1', 'edit'), 'task-check', fakeContext, SUBAGENT_ROLES['file-editor'], null, 'src',
  );
  assert.match(prompt, /You must NOT|What You Do NOT Do/i, 'the real template\'s boundary section must reach the prompt');
  assert.match(prompt, /Response Format|response format/i, 'the real template\'s JSON contract must reach the prompt');
  assert.match(prompt, /Security and trust boundaries|Security Boundaries/i, 'the real template\'s security section must reach the prompt');
});

await check('terminal gets ITS OWN distinct template, not file-editor\'s', async () => {
  const prompt = await buildScopedPrompt(
    fakeSubtask('t2', 'test'), 'task-check', fakeContext, SUBAGENT_ROLES['terminal'], null, 'src',
  );
  assert.match(prompt, /allowed command prefixes|Allowed Commands/i, 'terminal\'s own command-whitelist section must be present');
  assert.doesNotMatch(prompt, /primary editing tool/, 'terminal must not receive file-editor\'s template');
});

await check('terminal is not told to use a write tool it is not allowed to call', async () => {
  const prompt = await buildScopedPrompt(
    fakeSubtask('t3', 'test'), 'task-check', fakeContext, SUBAGENT_ROLES['terminal'], null, 'src',
  );
  assert.doesNotMatch(
    prompt,
    /Use coding_write_file_tracked/,
    'a role without coding_write_file_tracked in allowedTools must not be instructed to call it',
  );
});

await check('a missing template degrades to the inline header instead of losing the subtask', async () => {
  const brokenRole = { ...SUBAGENT_ROLES['file-editor'], promptTemplate: 'coding/does-not-exist-xyz' };
  const prompt = await buildScopedPrompt(
    fakeSubtask('t4', 'edit'), 'task-check', fakeContext, brokenRole, null, 'src',
  );
  assert.match(prompt, /Role: File Editor SubAgent/, 'must fall back to the inline role header, not throw');
});

// ── 2. allowedTools names are real registered keys, not stale prefixes ────

const codingAgentSource = readFileSync('src/mastra/agents/coding-agent.ts', 'utf8');
// Registered tool KEYS are the object keys in `tools: { key: toolHandle }` —
// PLUS the workspace tools merged in at generate-time via `workspace: codeWorkspace`
// (code-workspace.ts's renamed WORKSPACE_TOOLS entries), which never appear as
// keys in coding-agent.ts's own static object at all.
const staticKeys = [...codingAgentSource.matchAll(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*):\s/gm)].map((m) => m[1]);
const codeWorkspaceSource = readFileSync('src/mastra/workspaces/code-workspace.ts', 'utf8');
const workspaceKeys = [...codeWorkspaceSource.matchAll(/name:\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g)].map((m) => m[1]);
const registeredKeys = new Set([...staticKeys, ...workspaceKeys]);

await check('every file-editor/terminal/qa allowedTools name is a real codingAgent tool key', () => {
  // Two exclusions, both pre-existing and out of THIS session's scope:
  // - researcher's whole allowedTools list (browser_*, search_web) — its role
  //   is not reachable through codingAgent at all today (Phase F2).
  // - qa's browser_* entries specifically — Playwright MCP was never wired to
  //   codingAgent's own toolset either (same Phase F2), so qa keeps the rest
  //   of its list enforced (view/find_files/search_content/lsp_inspect/
  //   coding_run_test/artifact tools) while those five stay documentation of
  //   intent, same status as `promptTemplate` before this session — known,
  //   named, not this fix's job to wire up.
  for (const roleId of ['file-editor', 'terminal', 'qa'] as const) {
    for (const toolName of SUBAGENT_ROLES[roleId].allowedTools) {
      if (toolName.startsWith('browser_')) continue;
      assert.ok(
        registeredKeys.has(toolName),
        `${roleId}.allowedTools names '${toolName}', which is not a key in codingAgent's tools object — `
        + 'a restriction built on a name that does not exist restricts nothing',
      );
    }
  }
});

await check('every role can still report its result (has coding_get_artifact + coding_update_artifact)', () => {
  for (const roleId of ['file-editor', 'terminal', 'qa'] as const) {
    const tools = SUBAGENT_ROLES[roleId].allowedTools;
    assert.ok(tools.includes('coding_get_artifact'), `${roleId} must be able to read its own artifact`);
    assert.ok(tools.includes('coding_update_artifact'), `${roleId} must be able to report what it did`);
  }
});

// ── 3. The restriction is REAL: a loaded-but-forbidden tool never becomes callable ──

function shelfTool(id: string) {
  return createTool({
    id,
    description: `fake ${id}`,
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => ({ ok: true }),
  });
}

function shelfStepArgs(state: Record<string, unknown>, stepNumber: number, activeTools?: string[]) {
  const system: string[] = [];
  return {
    messages: [{ id: 'm1', role: 'user', content: { format: 2, parts: [{ type: 'text', text: 'run tests' }] }, createdAt: new Date() }],
    messageList: { system, addSystem: (v: string) => system.push(v) },
    stepNumber,
    steps: [],
    systemMessages: [],
    state,
    model: 'test/model',
    tools: {
      artifact_put: shelfTool('artifact_put'),
      artifact_get: shelfTool('artifact_get'),
      coding_get_artifact: shelfTool('coding_get_artifact'),
      system_request_approval: shelfTool('system_request_approval'),
      skill_search: shelfTool('skill_search'),
      skill_load: shelfTool('skill_load'),
      repo_map: shelfTool('repo_map'),
      code_search: shelfTool('code_search'),
      view: shelfTool('view'),
      find_files: shelfTool('find_files'),
      search_content: shelfTool('search_content'),
      coding_run_test: shelfTool('coding_run_test'),
      coding_update_artifact: shelfTool('coding_update_artifact'),
      coding_write_file_tracked: shelfTool('coding_write_file_tracked'),
    },
    activeTools,
    retryCount: 0,
    abort: (reason?: string) => { throw new Error(reason ?? 'aborted'); },
  } as never;
}

await check('LIVE MECHANISM: a terminal subtask cannot make coding_write_file_tracked callable, even via load_tool', async () => {
  const previousFlag = process.env.FEATURE_INTERIM_TOOL_SHELF;
  const previousAgents = process.env.INTERIM_TOOL_SHELF_AGENTS;
  process.env.FEATURE_INTERIM_TOOL_SHELF = 'true';
  process.env.INTERIM_TOOL_SHELF_AGENTS = '*';
  try {
    const processor = new TransientToolShelfProcessor({ agentId: 'coding-agent' });
    const state: Record<string, unknown> = {};

    // Step 0: the top-level generateOptions.activeTools ceiling this session
    // wired into subtask-executor.ts — exactly what executeSubtask() now passes.
    const step0 = await processor.processInputStep(
      shelfStepArgs(state, 0, SUBAGENT_ROLES['terminal'].allowedTools),
    ) as any;

    // The shelf can still FIND the tool — its descriptors come from the full
    // static tool map, not from the restriction. Finding is not calling.
    const searchResult = await step0.tools.search_tools.execute({ query: 'write file' }, {} as never);
    assert.ok(
      searchResult.results.some((r: { name: string }) => r.name === 'coding_write_file_tracked'),
      'search_tools must still be able to find a real tool outside the role — restriction is not concealment',
    );

    // The model "successfully" loads it...
    const loadResult = await step0.tools.load_tool.execute({ toolName: 'coding_write_file_tracked' }, {} as never);
    assert.equal(loadResult.success, true, 'load_tool itself has no restriction awareness — it just manages the shelf slot');

    // ...but on the NEXT step, with the framework passing back what step 0
    // actually computed as activeTools, the loaded tool must not be present.
    const step1 = await processor.processInputStep(
      shelfStepArgs(state, 1, step0.activeTools),
    ) as any;
    assert.ok(
      !step1.activeTools.includes('coding_write_file_tracked'),
      'coding_write_file_tracked must never become callable for a role whose allowedTools excludes it, '
      + 'even after a "successful" load_tool call',
    );
    assert.ok(
      step1.activeTools.includes('coding_run_test'),
      'the restriction must not be all-or-nothing — coding_run_test IS in terminal\'s allowedTools and must survive',
    );
  } finally {
    if (previousFlag === undefined) delete process.env.FEATURE_INTERIM_TOOL_SHELF;
    else process.env.FEATURE_INTERIM_TOOL_SHELF = previousFlag;
    if (previousAgents === undefined) delete process.env.INTERIM_TOOL_SHELF_AGENTS;
    else process.env.INTERIM_TOOL_SHELF_AGENTS = previousAgents;
  }
});

// ── 4. The wiring itself: subtask-executor.ts must actually pass the restriction ──

const subtaskExecutorSource = readFileSync('src/mastra/services/subtask-executor.ts', 'utf8');
await check('executeSubtask actually passes role.allowedTools as generateOptions.activeTools', () => {
  assert.match(
    subtaskExecutorSource,
    /generateOptions:\s*\{\s*activeTools:\s*role\.allowedTools\s*\}/,
    'the enforcement must be wired into the real generateCoding() call, not merely exist as a helper nobody calls',
  );
});

if (failures > 0) {
  console.error(`\n❌ check:subagent-roles-enforced — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\n✅ check:subagent-roles-enforced — real templates load, allowedTools names are real, and the restriction actually holds');
process.exit(0);
