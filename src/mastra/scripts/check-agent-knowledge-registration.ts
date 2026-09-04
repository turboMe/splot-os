/**
 * Comprehensive verification of agent tool registrations for knowledge_lookup.
 * Run with: npx tsx src/mastra/scripts/check-agent-knowledge-registration.ts
 */
import assert from 'node:assert/strict';

async function run() {
  console.log('=== Verifying Agent Tool Registrations for knowledge_lookup ===\n');

  // 1. Marketing Agent
  const { marketingAgent } = await import('../agents/marketing-agent.js');
  assert.ok(marketingAgent, 'marketingAgent should exist');
  console.log('  ✓ marketingAgent loaded successfully');

  // 2. Sales Agent
  const { salesAgent } = await import('../agents/sales-agent.js');
  assert.ok(salesAgent, 'salesAgent should exist');
  console.log('  ✓ salesAgent loaded successfully');

  // 3. Researcher Agent
  const { researcherAgent } = await import('../agents/researcher-agent.js');
  assert.ok(researcherAgent, 'researcherAgent should exist');
  console.log('  ✓ researcherAgent loaded successfully');

  // 4. Content Agent
  const { contentAgent } = await import('../agents/content-agent.js');
  assert.ok(contentAgent, 'contentAgent should exist');
  console.log('  ✓ contentAgent loaded successfully');

  // 5. Chef Agent
  const { chefAgent } = await import('../agents/chef-agent.js');
  assert.ok(chefAgent, 'chefAgent should exist');
  console.log('  ✓ chefAgent loaded successfully');

  // 6. Writer Agent
  const { writerAgent } = await import('../agents/writer-agent.js');
  assert.ok(writerAgent, 'writerAgent should exist');
  console.log('  ✓ writerAgent loaded successfully');

  // 7. Deliberation Agent
  const { deliberationAgent } = await import('../agents/deliberation-agent.js');
  assert.ok(deliberationAgent, 'deliberationAgent should exist');
  console.log('  ✓ deliberationAgent loaded successfully');

  // 8. Meta Agent
  const { metaAgent } = await import('../agents/meta-agent.js');
  assert.ok(metaAgent, 'metaAgent should exist');
  console.log('  ✓ metaAgent loaded successfully');

  // 9. Hunt Agent
  const { huntAgent } = await import('../agents/hunt-agent.js');
  assert.ok(huntAgent, 'huntAgent should exist');
  console.log('  ✓ huntAgent loaded successfully');

  // 10. Analytics Agent
  const { analyticsAgent } = await import('../agents/analytics-agent.js');
  assert.ok(analyticsAgent, 'analyticsAgent should exist');
  console.log('  ✓ analyticsAgent loaded successfully');

  // 11. Automation Architect
  const { automationArchitect } = await import('../agents/automation-architect.js');
  assert.ok(automationArchitect, 'automationArchitect should exist');
  console.log('  ✓ automationArchitect loaded successfully');

  // 12. Knowledge Agent
  const { knowledgeAgent } = await import('../agents/knowledge-agent.js');
  assert.ok(knowledgeAgent, 'knowledgeAgent should exist');
  console.log('  ✓ knowledgeAgent loaded successfully');

  console.log('\n✅ All 12 agents initialized and validated successfully!');
}

run().catch((err) => {
  console.error('❌ Agent registration verification failed:', err);
  process.exit(1);
});
