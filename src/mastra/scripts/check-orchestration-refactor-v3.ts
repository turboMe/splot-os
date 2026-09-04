import { getSkillRegistry } from '../services/skill-registry.js';
import { resolveExecutionModel, EXECUTION_TIERS } from '../config/model-capabilities.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { metaAgent } from '../agents/meta-agent.js';
import { marketingAgent } from '../agents/marketing-agent.js';
import { salesAgent } from '../agents/sales-agent.js';
import { analyticsAgent } from '../agents/analytics-agent.js';

import { crmAgent } from '../agents/crm-agent.js';
import { executionTierPresets } from '../config/model-manifest.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('🚀 Running Orchestration & Delegation Refactor V3 Tests');
  console.log('======================================================\n');

  // ── 1. Skill Registry & Metadata Tests ─────────────────────────
  console.log('1️⃣ Testing Skill Registry & Tier Metadata...');
  const skillRegistry = getSkillRegistry();
  await skillRegistry.initialize(undefined, { skipEmbeddings: true });
  const allSkills = skillRegistry.getAllSkills();
  assert(allSkills.length > 0, 'Skill registry loaded skills from disk', `Total: ${allSkills.length}`);

  const leadQualifier = skillRegistry.getSkill('consulting-lead-qualifier');
  assert(leadQualifier !== undefined, 'consulting-lead-qualifier is registered');
  assert(leadQualifier?.metadata?.recommendedTier === 'fast', 'consulting-lead-qualifier has recommendedTier: fast');
  assert(leadQualifier?.metadata?.handoffCapable === true, 'consulting-lead-qualifier has handoffCapable: true');

  const chefAuditor = skillRegistry.getSkill('consulting-chef-auditor');
  assert(chefAuditor !== undefined, 'consulting-chef-auditor is registered');
  assert(chefAuditor?.metadata?.recommendedTier === 'balanced', 'consulting-chef-auditor has recommendedTier: balanced');

  const fastSkills = skillRegistry.getSkillsForTier('fast');
  assert(fastSkills.length >= 50, 'getSkillsForTier("fast") returns mass tagged skills', `Found: ${fastSkills.length}`);

  const proSkills = skillRegistry.getSkillsForTier('pro');
  assert(proSkills.length >= 40, 'getSkillsForTier("pro") returns pro tier skills', `Found: ${proSkills.length}`);

  // ── 2. Model Capabilities & Tier Resolution Tests ─────────────
  console.log('\n2️⃣ Testing Model Capabilities & Dynamic Tier Resolution...');
  assert(executionTierPresets.fast.primary !== undefined, 'executionTierPresets has fast preset');
  assert(executionTierPresets.balanced.primary !== undefined, 'executionTierPresets has balanced preset');
  assert(executionTierPresets.pro.primary !== undefined, 'executionTierPresets has pro preset');
  assert(executionTierPresets.private.primary !== undefined, 'executionTierPresets has private preset (Ollama)');

  const fastResolved = resolveExecutionModel({ requestedTier: 'fast' });
  assert(typeof fastResolved === 'string' && fastResolved.length > 0, 'Explicit fast tier resolves to cloud model', `Resolved: ${fastResolved}`);

  const proResolved = resolveExecutionModel({ requestedTier: 'pro' });
  assert(typeof proResolved === 'string' && proResolved.length > 0, 'Explicit pro tier resolves to cloud model', `Resolved: ${proResolved}`);

  const privateResolved = resolveExecutionModel({ requestedTier: 'private' });
  assert(typeof privateResolved === 'string' && privateResolved.includes('qwen') || privateResolved.includes('gemma') || privateResolved.includes('ollama'), 'Explicit private tier resolves to local Ollama model', `Resolved: ${privateResolved}`);

  const skillBasedFast = resolveExecutionModel({ skills: ['consulting-lead-qualifier'] });
  assert(typeof skillBasedFast === 'string', 'Skill-based fast tier resolution works', `Resolved: ${skillBasedFast}`);

  const skillBasedBalanced = resolveExecutionModel({ skills: ['consulting-chef-auditor'] });
  assert(typeof skillBasedBalanced === 'string', 'Skill-based balanced tier resolution works', `Resolved: ${skillBasedBalanced}`);

  // ── 3. Tool Schema & Contracts Tests ──────────────────────────
  console.log('\n3️⃣ Testing Tool Schemas (runWorkerTool & delegateTaskTool)...');
  const runWorkerShape = runWorkerTool.inputSchema ? Object.keys((runWorkerTool.inputSchema as any).shape || {}) : [];
  assert(runWorkerShape.includes('modelTier'), 'runWorkerTool schema includes modelTier');
  assert(runWorkerShape.includes('skills'), 'runWorkerTool schema includes skills');
  assert(runWorkerShape.includes('inputArtifactIds'), 'runWorkerTool schema includes inputArtifactIds');
  assert(runWorkerShape.includes('taskBrief'), 'runWorkerTool schema includes taskBrief');

  const delegateTaskShape = delegateTaskTool.inputSchema ? Object.keys((delegateTaskTool.inputSchema as any).shape || {}) : [];
  assert(delegateTaskShape.includes('modelTier'), 'delegateTaskTool schema includes modelTier');
  assert(delegateTaskShape.includes('skills'), 'delegateTaskTool schema includes skills');
  assert(delegateTaskShape.includes('inputArtifactIds'), 'delegateTaskTool schema includes inputArtifactIds');
  assert(delegateTaskShape.includes('taskBrief'), 'delegateTaskTool schema includes taskBrief');

  // ── 4. Domain Agent Tooling Tests ─────────────────────────────
  console.log('\n4️⃣ Testing Domain Agent Tool Armoring...');
  const marketingTools = Object.keys(await (marketingAgent as any).getToolsForExecution({}));
  assert(marketingTools.includes('runWorkerTool'), 'marketingAgent has runWorkerTool', `Tools: ${marketingTools.join(', ')}`);
  assert(marketingTools.includes('delegateTaskTool'), 'marketingAgent has delegateTaskTool');
  assert(marketingTools.includes('artifactPutTool'), 'marketingAgent has artifactPutTool');

  const salesTools = Object.keys(await (salesAgent as any).getToolsForExecution({}));
  assert(salesTools.includes('runWorkerTool'), 'salesAgent has runWorkerTool', `Tools: ${salesTools.join(', ')}`);
  assert(salesTools.includes('delegateTaskTool'), 'salesAgent has delegateTaskTool');
  assert(salesTools.includes('createLeadTool'), 'salesAgent has createLeadTool');
  assert(salesTools.includes('updateLeadTool'), 'salesAgent has updateLeadTool');
  assert(salesTools.includes('knowledgeLookupTool'), 'salesAgent has knowledgeLookupTool');

  const crmTools = Object.keys(await (crmAgent as any).getToolsForExecution({}));
  assert(crmTools.includes('searchLeadsTool'), 'crmAgent has searchLeadsTool', `Tools: ${crmTools.join(', ')}`);
  assert(crmTools.includes('createLeadTool'), 'crmAgent has createLeadTool');
  assert(crmTools.includes('updateLeadTool'), 'crmAgent has updateLeadTool');
  assert(crmTools.includes('updateStatusTool'), 'crmAgent has updateStatusTool');
  assert(crmTools.includes('addInteractionTool'), 'crmAgent has addInteractionTool');
  assert(crmTools.includes('recordEmailDraftTool'), 'crmAgent has recordEmailDraftTool');
  assert(crmTools.includes('runWorkerTool'), 'crmAgent has runWorkerTool');
  assert(crmTools.includes('delegateTaskTool'), 'crmAgent has delegateTaskTool');
  assert(crmTools.includes('artifactPutTool'), 'crmAgent has artifactPutTool');

  const analyticsTools = Object.keys(await (analyticsAgent as any).getToolsForExecution({}));
  assert(analyticsTools.includes('runWorkerTool'), 'analyticsAgent has runWorkerTool', `Tools: ${analyticsTools.join(', ')}`);
  assert(analyticsTools.includes('delegateTaskTool'), 'analyticsAgent has delegateTaskTool');
  assert(analyticsTools.includes('artifactPutTool'), 'analyticsAgent has artifactPutTool');

  // ── 5. Skinny Meta Orchestrator Tests ─────────────────────────
  console.log('\n5️⃣ Testing Skinny Meta Orchestrator (Anti-Hoarding)...');
  const metaTools = Object.keys(await (metaAgent as any).getToolsForExecution({}));
  assert(metaTools.includes('delegateTaskTool'), 'metaAgent has delegateTaskTool');
  assert(metaTools.includes('runWorkerTool'), 'metaAgent has runWorkerTool');
  assert(metaTools.includes('artifactPutTool'), 'metaAgent has artifactPutTool');
  assert(metaTools.includes('skillSearchTool'), 'metaAgent has skillSearchTool');
  assert(metaTools.includes('ledgerStatusTool'), 'metaAgent has ledgerStatusTool');
  assert(metaTools.includes('knowledgeLookupTool'), 'metaAgent has knowledgeLookupTool for identity/business grounding');

  assert(!metaTools.includes('searchLeadsTool'), 'metaAgent does NOT hoard CRM searchLeadsTool');
  assert(!metaTools.includes('codeSearchTool'), 'metaAgent does NOT hoard codeSearchTool');
  assert(!metaTools.includes('repoMapTool'), 'metaAgent does NOT hoard repoMapTool');
  assert(!metaTools.includes('worktreeDiffTool'), 'metaAgent does NOT hoard worktreeDiffTool');
  assert(!metaTools.includes('telegramSendFileTool'), 'metaAgent does NOT hoard telegramSendFileTool');

  console.log('\n======================================================');
  console.log(`🏁 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled error during test execution:', err);
  process.exit(1);
});
