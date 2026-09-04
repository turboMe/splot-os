/**
 * Diagnostic script: check what tools codingAgent resolves at runtime.
 * Run with: npx tsx src/mastra/scripts/diagnose-agent-tools.ts
 */
import { codingAgent } from '../agents/coding-agent.js';

async function diagnose() {
  console.log('=== CodingAgent Tool Diagnostics ===\n');

  // 1. Check agent basic config
  console.log(`Agent ID: ${codingAgent.id}`);
  console.log(`Agent Name: ${codingAgent.name}`);
  console.log(`Model: ${JSON.stringify((codingAgent as any).__model ?? 'default')}`);

  // 2. Assigned tools (from `tools: { ... }` in agent config)
  const assignedTools = (codingAgent as any).__toolset || (codingAgent as any).tools || {};
  const assignedNames = Object.keys(assignedTools);
  console.log(`\nAssigned Tools (${assignedNames.length}): ${assignedNames.join(', ')}`);

  // 3. Workspace
  const workspace = (codingAgent as any).__workspace ?? (codingAgent as any)._workspace;
  console.log(`\nWorkspace: ${workspace ? `id=${workspace.id}, name=${workspace.name}` : 'NONE'}`);

  // 4. Try to get workspace tools
  if (workspace) {
    try {
      const { createWorkspaceTools } = await import('@mastra/core/workspace');
      const wsTools = await createWorkspaceTools(workspace, {
        requestContext: {},
        workspace,
      });
      const wsNames = Object.keys(wsTools);
      console.log(`Workspace Tools (${wsNames.length}): ${wsNames.join(', ')}`);
    } catch (e) {
      console.log(`Workspace Tools ERROR: ${(e as Error).message}`);
    }
  }

  // 5. Try to get full tool list from convertTools
  try {
    const fullTools = await (codingAgent as any).convertTools({
      runId: 'diagnostic',
      threadId: 'diagnostic',
      resourceId: 'diagnostic',
    });
    const fullNames = Object.keys(fullTools);
    console.log(`\nFull Resolved Tools (${fullNames.length}):`);
    fullNames.forEach(n => console.log(`  - ${n}`));
  } catch (e) {
    console.log(`\nFull Resolved Tools ERROR: ${(e as Error).message}`);
  }

  // 6. Check getToolsForExecution (what agent.generate() actually uses)
  try {
    const execTools = await (codingAgent as any).getToolsForExecution({
      runId: 'diagnostic',
      threadId: 'diagnostic',
      resourceId: 'diagnostic',
    });
    const execNames = Object.keys(execTools);
    console.log(`\nTools for Execution (${execNames.length}):`);
    execNames.forEach(n => console.log(`  - ${n}`));
  } catch (e) {
    console.log(`\nTools for Execution ERROR: ${(e as Error).message}`);
  }

  console.log('\n=== Diagnostics Complete ===');
}

diagnose().catch(console.error);
