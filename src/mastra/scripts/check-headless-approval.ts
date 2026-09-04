#!/usr/bin/env tsx
/**
 * check:headless-approval — a run nobody can answer is never offered a tool that
 * stops to ask.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * Mastra answers `requireApproval` by SUSPENDING the agent
 * (`finishReason: 'suspended'`). In a supervised session that is the feature. In
 * a durable background job there is no resumer, so the run stops, the lease
 * expires, and the job records a timeout — with nothing anywhere saying that a
 * tool asked a question. Measured on the autoheal loop before this: the coding
 * agent improvised `cd <worktree> && git merge` through `execute_command`, the
 * gate correctly demanded approval, the run suspended, and the merge never
 * landed. The workaround at the time was to take the merge away from the model
 * (`repo-maintenance.ts` §mergeWorktreeToLive); this is the general fix.
 *
 * WHY AN ALLOWLIST HAS TO BE COMPLETE
 * -----------------------------------
 * `activeTools` names what MAY be called, so withholding one tool means naming
 * every other. Workspace tools are merged into a request separately and do NOT
 * appear in `agent.listTools()`, so an allowlist built from the assigned tools
 * alone would silently strip `view`, `find_files` and `lsp_inspect` — a
 * capability loss wearing a safety measure's clothes. Both halves are asserted.
 *
 * WHAT IS FAKED: the agent, and only the agent. `prepareStep` is the real
 * function from `generateWithHarness`, invoked exactly as Mastra invokes it.
 *
 * Run: npx tsx src/mastra/scripts/check-headless-approval.ts
 */
import assert from 'node:assert/strict';

import type { Agent } from '@mastra/core/agent';
import { generateWithHarness } from '../services/generate-with-harness.js';
import { APPROVAL_SUSPENDING_WORKSPACE_TOOLS } from '../workspaces/code-workspace.js';

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

console.log('check:headless-approval');

const ASSIGNED = ['coding_init_worktree', 'coding_run_test', 'bg_task'];
const WORKSPACE = ['view', 'find_files', 'search_content', 'lsp_inspect', 'execute_command'];

/** Captures what the harness asks Mastra to do before each step. */
type Captured = { activeTools?: string[] };

function fakeAgent(opts: { assigned?: string[]; workspace?: string[] } = {}) {
  const captured: Captured[] = [];
  const agent = {
    async listTools() {
      return Object.fromEntries((opts.assigned ?? ASSIGNED).map((n) => [n, { id: n }]));
    },
    async listWorkspaceTools() {
      return Object.fromEntries((opts.workspace ?? WORKSPACE).map((n) => [n, { id: n }]));
    },
    async generate(_prompt: string, options: Record<string, any> = {}) {
      // Mastra calls prepareStep before every step; call it exactly once, the
      // same way, so the REAL logic runs inside this check.
      if (typeof options.prepareStep === 'function') {
        const result = await options.prepareStep({ stepNumber: 0, steps: [], systemMessages: [] });
        captured.push((result ?? {}) as Captured);
      }
      return { text: 'gotowe', steps: [], finishReason: 'stop', toolCalls: [], toolResults: [] };
    },
  };
  return { agent: agent as unknown as Agent, captured };
}

async function run(headless: boolean, agent: Agent): Promise<void> {
  await generateWithHarness({
    agent,
    agentId: 'codingAgent',
    prompt: 'sprawdź, czy typecheck przechodzi',
    phase: 'chat',
    headless,
    timeoutMs: 30_000,
  });
}

await check('the declaration itself names the tool that actually suspends', () => {
  assert.ok(APPROVAL_SUSPENDING_WORKSPACE_TOOLS.includes('execute_command'),
    'execute_command is the one with a conditional requireApproval gate');
  assert.ok(APPROVAL_SUSPENDING_WORKSPACE_TOOLS.includes('write_file'),
    'write_file is configured requireApproval: true unconditionally');
});

await check('HEADLESS: the suspending tool is withheld and everything else survives', async () => {
  const { agent, captured } = fakeAgent();
  await run(true, agent);
  assert.ok(captured.length > 0, 'prepareStep must have run — otherwise this check proves nothing');
  const active = captured[0]!.activeTools;
  assert.ok(Array.isArray(active), 'a headless run must narrow activeTools');
  assert.ok(!active!.includes('execute_command'), 'the suspending tool must be gone');
  // The half that matters just as much: nothing else may disappear with it.
  for (const kept of ['view', 'find_files', 'search_content', 'lsp_inspect']) {
    assert.ok(active!.includes(kept), `${kept} is read-only and must survive the withholding`);
  }
  for (const kept of ASSIGNED) {
    assert.ok(active!.includes(kept), `${kept} is an assigned tool and must survive`);
  }
  // The non-suspending routes to a shell stay, so "no" is available instead of a hang.
  assert.ok(active!.includes('coding_run_test') && active!.includes('bg_task'),
    'both refusing shells must remain, or withholding becomes a capability loss');
});

await check('SUPERVISED: the same agent keeps the tool', async () => {
  const { agent, captured } = fakeAgent();
  await run(false, agent);
  assert.ok(captured.length > 0, 'prepareStep must have run');
  const active = captured[0]!.activeTools;
  assert.ok(
    active === undefined || active.includes('execute_command'),
    'a session with a human in it must not lose the approval path',
  );
});

await check('FAIL-OPEN: an agent whose tools cannot be enumerated is not silently shrunk', async () => {
  // An incomplete allowlist removes tools instead of removing the hazard, so the
  // harness must decline to build one rather than build a wrong one.
  const { agent, captured } = fakeAgent({ assigned: [], workspace: [] });
  await run(true, agent);
  assert.ok(captured.length > 0, 'prepareStep must have run');
  assert.equal(captured[0]!.activeTools, undefined,
    'with nothing enumerated the run must stay unrestricted, and say so in the log');
});

await check('a headless agent with no workspace is left alone', async () => {
  // Most capabilities have no workspace at all; withholding must be a no-op for
  // them rather than an allowlist that pins them to today's tool set.
  const { agent, captured } = fakeAgent({ workspace: [] });
  await run(true, agent);
  const active = captured[0]!.activeTools;
  assert.equal(active, undefined,
    'nothing suspends, so nothing is withheld — and no allowlist is imposed');
});

// ── Who did what: identity comes from the RUN, not from missing arguments ────
await check('ATTRIBUTION: an absent agentId argument does not erase the run identity', async () => {
  // Measured on the review canary: every tool call the REVIEWER made was filed
  // under `codingAgent`. `extractToolMetadata` returned `{ agentId: undefined }`
  // for a tool invoked without one, spreading that over the harness context
  // erased the real value, and the fallback chain ends at CODING_AGENT_ID.
  // Nothing failed — which is why it is expensive: it makes the record of who
  // did what wrong, and every later diagnosis reads that record.
  const { withToolEnvelope } = await import('../services/harness-tool-envelope.js');
  const { runWithHarnessExecutionContext } = await import('../services/harness-execution-context.js');

  let seen: string | undefined;
  const tool = withToolEnvelope<{ note: string }, { success: boolean }>({
    toolId: 'attribution_probe',
    category: 'other',
    risk: 'low',
    execute: async (_input, metadata) => {
      seen = metadata?.agentId;
      return { success: true };
    },
  });

  await runWithHarnessExecutionContext(
    { agentId: 'codeReviewAgent', runId: 'run-attr', taskId: 'task-attr' },
    async () => { await tool({ note: 'no agentId in the arguments' }); },
  );
  assert.equal(seen, 'codeReviewAgent',
    'the run knows who is executing; an argument that was never passed must not overwrite it');

  // And an explicit argument still wins, because a caller acting on behalf of
  // another agent is a real case (the workflow steps do exactly that).
  await runWithHarnessExecutionContext(
    { agentId: 'codeReviewAgent', runId: 'run-attr-2' },
    async () => { await tool({ note: 'x', agentId: 'codingAgent' } as never); },
  );
  assert.equal(seen, 'codingAgent', 'an explicit caller identity must still be honoured');
});


await check('ATTRIBUTION: a delegation is filed under the agent that made it', async () => {
  // Same family as the check above, one layer out. `system_delegate_task` takes
  // `callerAgentId` with `.default(META_AGENT_ID)`, and `resolveDelegationCaller`
  // already prefers the RUN's identity over that default — but the telemetry
  // block used the raw declared value, so execution and the record disagreed.
  //
  // Measured on a V2 canary: codingAgent delegated to researcherAgent, the run
  // logged `caller identity taken from the run: codingAgent (the call declared
  // meta-agent)`, and `tool_executions` filed it under meta-agent. It briefly
  // read as the agent fabricating a delegation it never made.
  const { resolveDelegationCaller } = await import('../tools/system/delegate-task.js');
  const { runWithHarnessExecutionContext } = await import('../services/harness-execution-context.js');

  await runWithHarnessExecutionContext({ agentId: 'codingAgent', runId: 'r-del' }, async () => {
    assert.equal(resolveDelegationCaller(undefined), 'codingAgent',
      'an omitted caller must resolve to the run, not to the schema default');
    assert.equal(resolveDelegationCaller('meta-agent'), 'codingAgent',
      'and the default value must not win over the run either');
  });

  // Outside a run there is nothing better than the declared value.
  assert.equal(resolveDelegationCaller('meta-agent'), 'meta-agent',
    'a caller with no run context keeps what it declared');

  // And the telemetry block must use the resolver, not the raw field.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/mastra/tools/system/delegate-task.ts', 'utf-8');
  const at = src.indexOf('metadata: (input: any) => ({');
  const block = src.slice(at, at + 1400).replace(/\/\/.*$/gm, '');
  assert.match(block, /agentId: resolveDelegationCaller\(/,
    'the recorded identity must be the resolved one — otherwise the log of who did '
    + 'what is wrong, and every later diagnosis reads it');
});

if (failures > 0) {
  console.error(`\n❌ check:headless-approval — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:headless-approval — a background run cannot be stopped by a tool asking for approval');
process.exit(0);
