#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = {
  agentIds: read('src/mastra/config/agent-ids.ts'),
  modelManifest: read('src/mastra/config/model-manifest.ts'),
  mcp: read('src/mastra/mcp.ts'),
  engineer: read('src/mastra/agents/n8n-mcp-engineer.ts'),
  prompt: read('src/mastra/prompts/automation/n8n-mcp-engineer.md'),
  automationPrompt: read('src/mastra/prompts/automation/base.md'),
  delegateTask: read('src/mastra/tools/system/delegate-task.ts'),
  index: read('src/mastra/index.ts'),
  envExample: read('.env.example'),
};

const allowedTools = [
  'tools_documentation',
  'search_nodes',
  'get_node',
  'search_templates',
  'get_template',
  'validate_node',
  'validate_workflow',
];

const forbiddenTools = [
  'n8n_create_workflow',
  'n8n_update_full_workflow',
  'n8n_update_partial_workflow',
  'n8n_delete_workflow',
  'n8n_activate_workflow',
  'n8n_deploy_template',
  'n8n_manage_credentials',
  'n8n_autofix_workflow',
  'n8n_test_workflow',
  'n8n_executions',
];

assert(files.agentIds.includes("N8N_MCP_ENGINEER_AGENT_ID = 'n8nMcpEngineer'"), 'missing runtime agent id');
assert(files.agentIds.includes("N8N_MCP_ENGINEER_MASTRA_AGENT_ID = 'n8n-mcp-engineer'"), 'missing Mastra agent id');
assert(files.modelManifest.includes('n8nMcpEngineer:'), 'missing model assignment');
assert(files.index.includes("import { n8nMcpEngineer } from './agents/n8n-mcp-engineer'"), 'missing index import');
assert(files.index.includes('n8nMcpEngineer,'), 'missing Mastra agent registration');

assert(files.mcp.includes("'n8n-mcp'"), 'n8n MCP server not configured');
assert(files.mcp.includes("N8N_MCP_MODE ?? 'readonly'"), 'n8n MCP default mode must be readonly');
assert(files.mcp.includes("n8nMcpMode === 'management'"), 'management mode should be explicit');
assert(files.mcp.includes("args: ['-y', 'n8n-mcp']"), 'n8n MCP should run through npx -y n8n-mcp');

for (const toolName of allowedTools) {
  assert(files.engineer.includes(`'${toolName}'`), `engineer allowlist missing ${toolName}`);
  assert(files.prompt.includes(`\`${toolName}\``), `engineer prompt missing ${toolName}`);
  assert(files.automationPrompt.includes(`- \`${toolName}\``), `automation prompt missing ${toolName}`);
}

for (const toolName of forbiddenTools) {
  assert(!files.engineer.includes(`'${toolName}'`), `engineer implementation must not allow ${toolName}`);
  assert(files.prompt.includes(`\`${toolName}\``), `engineer prompt should explicitly forbid ${toolName}`);
}

assert(files.delegateTask.includes('n8nMcpEngineer: N8N_MCP_ENGINEER_AGENT_ID'), 'delegate registry missing n8nMcpEngineer');
// Etap 2: the enum derives from the Agent Board — assert the derivation and the card.
assert(files.delegateTask.includes('targetAgent: z.enum(AGENT_BOARD_IDS)'), 'delegate enum must derive from AGENT_BOARD_IDS');
{
  const agentBoardSource = read('src/mastra/config/agent-board.ts');
  assert(agentBoardSource.includes('n8nMcpEngineer: {'), 'agent board missing n8nMcpEngineer card');
}
assert(files.delegateTask.includes("callerAgentId !== AUTOMATION_ARCHITECT_AGENT_ID"), 'caller guard missing for n8nMcpEngineer');
assert(files.delegateTask.includes('n8n_mcp_engineer_caller_not_allowed'), 'caller guard error missing');
assert(files.delegateTask.includes('n8n_mcp_engineer_async_not_supported'), 'async guard missing');
assert(files.delegateTask.includes("toolId: 'system_delegate_task'"), 'delegate task must use tool envelope logging');
assert(files.delegateTask.includes('evaluateN8nMcpEngineerDelegationContract'), 'delegate task missing n8n MCP handoff contract');
assert(files.delegateTask.includes('n8n_mcp_handoff_missing_evidence'), 'delegate task missing MCP handoff evidence failure');
assert(files.delegateTask.includes("contract: 'n8n_mcp_handoff'"), 'delegate task missing MCP handoff event marker');
assert(files.delegateTask.includes('N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS'), 'delegate task missing n8n MCP delegation max steps env');
assert(files.engineer.includes('n8n_mcp_validate_workflow_schema_mismatch'), 'engineer missing validate_workflow schema mismatch wrapper');
assert(files.engineer.includes('mcp_output_schema_mismatch'), 'engineer missing validate_workflow schema mismatch status');
assert(files.engineer.includes('N8N_MCP_VALIDATE_WORKFLOW_MODE'), 'engineer missing validate_workflow mode env');
assert(files.engineer.includes('n8n_mcp_validate_workflow_advisory_mode'), 'engineer missing validate_workflow advisory mode');

assert(files.automationPrompt.includes('delegate to `n8nMcpEngineer`'), 'automation prompt missing delegation instruction');
assert(files.automationPrompt.includes('callerAgentId: "automationArchitect"'), 'automation prompt missing callerAgentId instruction');
assert(files.automationPrompt.includes('Treat the returned workflow JSON as a candidate only'), 'automation prompt missing candidate-only rule');
assert(files.automationPrompt.includes('pattern_coverage_gap'), 'automation prompt missing pattern_coverage_gap instruction');
assert(files.automationPrompt.includes('coverage.ok=false'), 'automation prompt missing coverage.ok=false instruction');
assert(files.automationPrompt.includes('mcp_handoff_failed'), 'automation prompt missing MCP handoff fail-closed instruction');
assert(files.automationPrompt.includes('Do not compose, deploy, test, or activate'), 'automation prompt missing no-deploy-after-failed-MCP rule');
assert(files.automationPrompt.includes('missingCapabilities'), 'automation prompt missing missingCapabilities handoff field');
assert(files.prompt.includes('missingCapabilities'), 'MCP Engineer prompt missing missingCapabilities output field');
assert(files.prompt.includes('coverageNotes'), 'MCP Engineer prompt missing coverageNotes output field');

assert(files.envExample.includes('FEATURE_N8N_MCP=false'), 'env example missing feature flag');
assert(files.envExample.includes('N8N_MCP_MODE=readonly'), 'env example missing readonly mode');
assert(files.envExample.includes('N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS=20'), 'env example missing n8n MCP delegation max steps');
assert(files.envExample.includes('N8N_MCP_VALIDATE_WORKFLOW_MODE=advisory'), 'env example missing validate_workflow advisory mode');
assert(files.index.includes('n8nMcpEngineer,'), 'missing Mastra agent registration');
assert(read('package.json').includes('"start:built": "bash scripts/with-node.sh node --import dotenv/config .mastra/output/index.mjs"'), 'package missing env-aware built start script');

// ── Behaviour, not source text ────────────────────────────────────────────
//
// Everything above greps this repository. A grep proves the RULE IS WRITTEN, not
// that it holds — and this rule decides who may reach an internal helper.
//
// The caller identity now comes from the harness execution context rather than
// from the `callerAgentId` the model types, which closes two failures at once:
// the architect forgetting the field (its own prompt then makes it abandon the
// whole build with `mcp_handoff_failed`), and any other agent simply CLAIMING to
// be the architect.
//
// The DECISION is tested, not the tool: `delegateTaskTool.execute` pulls the whole
// agent graph and would start real delegation. A gate must not do that to prove a
// point — an earlier draft of this check hung for five minutes doing exactly it.
{
  const { runWithHarnessExecutionContext } = await import('../services/harness-execution-context.js');
  const { resolveDelegationCaller } = await import('../tools/system/delegate-task.js');
  const { META_AGENT_ID } = await import('../config/agent-ids.js');

  const impersonated = await runWithHarnessExecutionContext(
    { agentId: 'chefAgent' },
    async () => resolveDelegationCaller('automationArchitect'),
  );
  assert.equal(impersonated, 'chefAgent',
    'a claimed identity must lose to the agent the run is actually executing');

  const forgotten = await runWithHarnessExecutionContext(
    { agentId: 'automationArchitect' },
    async () => resolveDelegationCaller(undefined),
  );
  assert.equal(forgotten, 'automationArchitect',
    'the architect must be identified from the run even when the call omits callerAgentId');

  // Canonical RUNTIME ids, not board ids: `canonicalizeRuntimeAgentId` maps
  // `metaAgent` to `meta-agent`, and the guards compare canonical values.
  assert.equal(resolveDelegationCaller('metaAgent'), 'metaAgent',
    'outside a run there is no trusted context, so the declared value still stands');
  assert.equal(resolveDelegationCaller(undefined), META_AGENT_ID,
    'and the previous default is unchanged');
}

// A failed mandatory handoff must be readable AFTER the run, by explicit id.
//
// Every other reader in `mcp-handoff-state` resolves its key from the harness
// execution context, which exists only INSIDE the run. The caller that composes
// the result runs outside it, so without a keyed read it would always see "no
// failure" — the same trap that made `findArtifactIds` fail twice.
{
  const { runWithHarnessExecutionContext } = await import('../services/harness-execution-context.js');
  const {
    markMcpHandoffFailed, mcpHandoffFailedForRun, markAutomationDeliverable, automationDeliverableForRun,
  } = await import('../services/mcp-handoff-state.js');

  const runId = `check-handoff-${Date.now()}`;
  await runWithHarnessExecutionContext({ agentId: 'automationArchitect', runId }, async () => {
    markMcpHandoffFailed();
    markAutomationDeliverable('draft_created');
  });

  assert.equal(mcpHandoffFailedForRun(runId), true,
    'the failure must be readable from outside the run that recorded it');
  assert.equal(automationDeliverableForRun(runId), 'draft_created');
  assert.equal(mcpHandoffFailedForRun('some-other-run'), false, 'and must not leak across runs');
  assert.equal(mcpHandoffFailedForRun(undefined), false, 'no id, no claim');
}

console.log('n8n MCP Engineer static checks passed.');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}
