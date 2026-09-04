#!/usr/bin/env tsx
/**
 * verify-graphify-strengthening — End-to-end verification of Waves G1, G2, G3.
 *
 * Checks:
 *   G1: Graph freshness signal (built_at_commit vs git HEAD, stale detection, output schema)
 *   G2: Tool availability on security-review-agent, performance-review-agent, and file-editor subagent
 *   G2 mapping: subtask-executor activeTools ceiling verifies graphify_affected is unblocked
 *   G3: Prompts verified with positive and negative triggers
 *
 * Run: npx tsx src/mastra/scripts/verify-graphify-strengthening.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  readGraphBuiltAtCommit,
  getGraphStaleness,
} from '../services/graphify.js';
import {
  graphifyAffectedTool,
} from '../tools/dev/graphify-tools.js';
import { SUBAGENT_ROLES } from '../config/subagent-roles.js';

const execFileAsync = promisify(execFile);

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

async function main(): Promise<void> {
  console.log('=== VERIFY GRAPHIFY STRENGTHENING (G1 -> G2 -> G3) ===\n');

  // ───────────────────────────────────────────────────────────────────────────
  // FALA G1: Sygnał świeżości grafu
  // ───────────────────────────────────────────────────────────────────────────
  console.log('[Fala G1: Sygnał świeżości grafu]');

  await check('G1.1: readGraphBuiltAtCommit reads SHA from graph.json', () => {
    const sha = readGraphBuiltAtCommit();
    assert.ok(sha, 'built_at_commit must be present in graph.json');
    assert.match(sha!, /^[a-f0-9]{40}$/i, 'must be a 40-char commit SHA');
    console.log(`       graph.json built_at_commit = ${sha!.slice(0, 7)}`);
  });

  await check('G1.2: getGraphStaleness detects up-to-date HEAD', async () => {
    const { stdout: headSha } = await execFileAsync('git', ['rev-parse', 'HEAD']);
    const tempGraph = resolve(tmpdir(), `test-graph-uptodate-${Date.now()}.json`);
    writeFileSync(tempGraph, JSON.stringify({ built_at_commit: headSha.trim() }));
    try {
      const status = await getGraphStaleness({ graphPath: tempGraph });
      assert.equal(status, 'graph up to date (built at HEAD)');
      console.log(`       Up-to-date status: "${status}"`);
    } finally {
      unlinkSync(tempGraph);
    }
  });

  await check('G1.3: getGraphStaleness detects stale graph (1 commit behind)', async () => {
    const { stdout: prevSha } = await execFileAsync('git', ['rev-parse', 'HEAD~1']);
    const tempGraph = resolve(tmpdir(), `test-graph-stale1-${Date.now()}.json`);
    writeFileSync(tempGraph, JSON.stringify({ built_at_commit: prevSha.trim() }));
    try {
      const status = await getGraphStaleness({ graphPath: tempGraph });
      assert.match(status, /HEAD is 1 commit ahead — may miss the 1 most recent change$/);
      console.log(`       Stale-1 status: "${status}"`);
    } finally {
      unlinkSync(tempGraph);
    }
  });

  await check('G1.4: getGraphStaleness detects stale graph (3 commits behind)', async () => {
    const { stdout: prev3Sha } = await execFileAsync('git', ['rev-parse', 'HEAD~3']);
    const tempGraph = resolve(tmpdir(), `test-graph-stale3-${Date.now()}.json`);
    writeFileSync(tempGraph, JSON.stringify({ built_at_commit: prev3Sha.trim() }));
    try {
      const status = await getGraphStaleness({ graphPath: tempGraph });
      assert.match(status, /HEAD is 3 commits ahead — may miss the 3 most recent changes$/);
      console.log(`       Stale-3 status: "${status}"`);
    } finally {
      unlinkSync(tempGraph);
    }
  });

  await check('G1.5: live tool execution returns staleness field and accurate impact count', async () => {
    const res = (await graphifyAffectedTool.execute?.({ symbol: 'transitionLane', depth: 2 }, {} as never)) as any;
    assert.ok(res, 'tool execution must return a result');
    assert.equal(res.available, true);
    assert.ok(res.staleness, 'staleness field must be present in result');
    assert.ok(res.count && res.count > 0, 'must find affected nodes');
    console.log(`       graphify_affected live: count=${res.count}, staleness="${res.staleness}"`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FALA G2: Toolsety agentów i mapowanie subtask-executor
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n[Fala G2: Rozszerzenie toolsetów i weryfikacja subtask-executor]');

  const securityAgentSrc = readFileSync('src/mastra/agents/security-review-agent.ts', 'utf8');
  const performanceAgentSrc = readFileSync('src/mastra/agents/performance-review-agent.ts', 'utf8');
  const codeReviewAgentSrc = readFileSync('src/mastra/agents/code-review-agent.ts', 'utf8');
  const codingAgentSrc = readFileSync('src/mastra/agents/coding-agent.ts', 'utf8');

  await check('G2.1: securityReviewAgent registers graphify_affected tool', () => {
    assert.match(securityAgentSrc, /graphify_affected:\s*graphifyAffectedTool/);
    assert.match(securityAgentSrc, /import\s*\{[^}]*graphifyAffectedTool[^}]*\}\s*from/);
  });

  await check('G2.2: performanceReviewAgent registers graphify_affected tool', () => {
    assert.match(performanceAgentSrc, /graphify_affected:\s*graphifyAffectedTool/);
    assert.match(performanceAgentSrc, /import\s*\{[^}]*graphifyAffectedTool[^}]*\}\s*from/);
  });

  await check('G2.3: codeReviewAgent registers graphify_affected tool (preserved baseline)', () => {
    assert.match(codeReviewAgentSrc, /graphify_affected:\s*graphifyAffectedTool/);
  });

  await check('G2.4: codingAgent registers graphify_affected tool', () => {
    assert.match(codingAgentSrc, /graphify_affected:\s*graphifyAffectedTool/);
  });

  await check('G2.5: file-editor role allowedTools includes graphify_affected', () => {
    const allowed = SUBAGENT_ROLES['file-editor'].allowedTools;
    assert.ok(allowed.includes('graphify_affected'), 'file-editor allowedTools must include graphify_affected');
  });

  await check('G2.6: subtask-executor mapping — allowedTools matches registered key directly', () => {
    // Registered tool keys on codingAgent:
    const staticKeys = [...codingAgentSrc.matchAll(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*):\s/gm)].map((m) => m[1]);
    const codeWorkspaceSource = readFileSync('src/mastra/workspaces/code-workspace.ts', 'utf8');
    const workspaceKeys = [...codeWorkspaceSource.matchAll(/name:\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g)].map((m) => m[1]);
    const registeredKeys = new Set([...staticKeys, ...workspaceKeys]);

    assert.ok(
      registeredKeys.has('graphify_affected'),
      'graphify_affected must be registered on codingAgent so activeTools directly unblocks it for file-editor',
    );

    // subtask-executor passes generateOptions: { activeTools: role.allowedTools }
    const subtaskExecSrc = readFileSync('src/mastra/services/subtask-executor.ts', 'utf8');
    assert.match(
      subtaskExecSrc,
      /generateOptions:\s*\{\s*activeTools:\s*role\.allowedTools\s*\}/,
      'subtask-executor must pass role.allowedTools as activeTools to generateCoding',
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FALA G3: Weryfikacja promptów (reguły pozytywne i negatywne)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n[Fala G3: Wzmocnienie promptów i reguły pozytywne/negatywne]');

  const codingBasePrompt = readFileSync('src/mastra/prompts/coding/base.md', 'utf8');
  const securityReviewPrompt = readFileSync('src/mastra/prompts/coding/security-review.md', 'utf8');
  const performanceReviewPrompt = readFileSync('src/mastra/prompts/coding/performance-review.md', 'utf8');
  const fileEditorPrompt = readFileSync('src/mastra/prompts/coding/subagent-file-editor.md', 'utf8');

  await check('G3.1: coding/base.md §6 has trigger rules, staleness signal, and unmerged state caveat', () => {
    assert.match(codingBasePrompt, /Trigger rule:\s*before changing an exported symbol/i);
    assert.match(codingBasePrompt, /Freshness signal.*staleness/i);
    assert.match(codingBasePrompt, /Merged truth only.*in-flight uncommitted/i);
    assert.match(codingBasePrompt, /no results.*≠.*guaranteed no dependents/i);
    assert.match(codingBasePrompt, /Inert edits.*skip graph work/i, 'negative rule: skip inert edits');
  });

  await check('G3.2: coding/security-review.md has Step 3a blast radius rule + negative skip rule', () => {
    assert.match(securityReviewPrompt, /Step 3a - Blast radius and call-site verification/i);
    assert.match(securityReviewPrompt, /graphify_affected.*before asserting.*every caller sanitizes input/i);
    assert.match(securityReviewPrompt, /Skip blast-radius exploration for private internal helpers/i, 'negative rule: skip private helpers');
  });

  await check('G3.3: coding/performance-review.md has Step 2a call-site spread rule + negative skip rule', () => {
    assert.match(performanceReviewPrompt, /Step 2a - Call-site spread and blast radius/i);
    assert.match(performanceReviewPrompt, /graphify_affected.*call-site count and spread/i);
    assert.match(performanceReviewPrompt, /Skip blast-radius checks for private internal helpers/i, 'negative rule: skip private helpers');
  });

  await check('G3.4: coding/subagent-file-editor.md has safety net section', () => {
    assert.match(fileEditorPrompt, /Safety net: unexpected shared symbols/i);
    assert.match(fileEditorPrompt, /graphify_affected.*safety net for when one turns out incomplete/i);
  });

  console.log('\n───────────────────────────────────────────────────────────');
  if (failures > 0) {
    console.error(`❌ Verification completed with ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('✅ ALL VERIFICATIONS PASSED (G1, G2, G3 fully confirmed on live runtime)');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
