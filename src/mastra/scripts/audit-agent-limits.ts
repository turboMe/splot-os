#!/usr/bin/env tsx
/**
 * Limits audit — the three budgets that decide whether an agent can finish.
 *
 * A run is bounded in three independent dimensions, and every one of them is
 * configured somewhere else:
 *
 *   STEPS    the agent's own `defaultOptions.maxSteps`   (src/mastra/agents/*)
 *   WINDOW   the V2 attempt cap, per capability          (config/capability-routing)
 *   TIME     the depth profile's timeout + liveness      (services/depth-controller)
 *
 * Nothing reconciles them, which is how `chefAgent` came to declare 150 steps,
 * be handed 40 by the depth profile, burn its entire 894s attempt window and
 * return nothing — a failure indistinguishable from a timeout, which is why
 * three earlier investigations went past it.
 *
 * This script derives the matrix FROM THE CODE and flags collisions. Run it
 * after touching any limit:
 *
 *   npx tsx src/mastra/scripts/audit-agent-limits.ts
 */
import { readFileSync } from 'node:fs';

import { agentBoard } from '../config/agent-board.js';
import { buildCapabilityRegistry } from '../config/capability-routing.js';

const DEPTH_SOURCE = readFileSync('src/mastra/services/depth-controller.ts', 'utf8');

function profileValue(level: string, field: string): number | undefined {
  const block = new RegExp(`${level}:\\s*\\{[\\s\\S]*?\\n  \\},`).exec(DEPTH_SOURCE)?.[0];
  const raw = block ? new RegExp(`${field}:\\s*([0-9_]+)`).exec(block)?.[1] : undefined;
  return raw ? Number(raw.replaceAll('_', '')) : undefined;
}

const LEVELS = ['fast', 'standard', 'deep', 'critical'] as const;

/** Board id → agent source file. */
/**
 * agentId → source filename. Exported because a SECOND audit needs the same
 * answer, and two copies of this map is how one of them starts reporting
 * defects that are really its own lookup failing — see `declaredMaxSteps`.
 */
export const AGENT_SOURCES: Record<string, string> = {
  marketingAgent: 'marketing-agent', salesAgent: 'sales-agent', analyticsAgent: 'analytics-agent',
  automationArchitect: 'automation-architect', n8nMcpEngineer: 'n8n-mcp-engineer',
  knowledgeAgent: 'knowledge-agent', crmAgent: 'crm-agent', codingAgent: 'coding-agent',
  deliberationAgent: 'deliberation-agent', researcherAgent: 'researcher-agent',
  chefAgent: 'chef-agent', contentAgent: 'content-agent', huntAgent: 'hunt-agent',
  designAgent: 'design-agent', writerAgent: 'writer-agent', filmmakerAgent: 'film-agent',
  capabilitySmith: 'capability-smith', musicianAgent: 'musician-agent',
  codeReviewAgent: 'code-review-agent', securityReviewAgent: 'security-review-agent',
  performanceReviewAgent: 'performance-review-agent',
};

/**
 * The ceiling an agent declares for itself, read from its source.
 *
 * Static on purpose: importing eighteen agent modules pulls their whole tool,
 * skill and embedding graph into the process, which makes an audit too slow to
 * run habitually — and habit is the entire point of one. The declaration is a
 * literal in the file, so reading it is not an approximation.
 */
export function declaredMaxSteps(agentId: string): number | undefined {
  const file = AGENT_SOURCES[agentId];
  // A source this audit cannot read must STOP it, never become a finding. The
  // first run of this script mapped `filmmakerAgent` to a file that does not
  // exist (it lives in `film-agent.ts`) and duly reported "declares no
  // maxSteps" — a defect that was not there, in the same shape as the six that
  // were. An audit whose failures look like its findings is worse than none.
  if (!file) throw new Error(`no source mapped for ${agentId} — update AGENT_SOURCES`);
  let source: string;
  try {
    source = readFileSync(`src/mastra/agents/${file}.ts`, 'utf8');
  } catch {
    throw new Error(`cannot read src/mastra/agents/${file}.ts for ${agentId}`);
  }
  const raw = /defaultOptions:\s*\{[^}]*maxSteps:\s*([0-9_]+)/.exec(source)?.[1];
  return raw ? Number(raw.replaceAll('_', '')) : undefined;
}

/**
 * Mastra's own default when nothing declares one (`__text`/`__stream` in
 * `@mastra/core`). Read from the shipped runtime, not assumed: an agent with no
 * declaration is not unbounded, it is capped at five — which is below the tool
 * count of several agents on this roster.
 */
const MASTRA_DEFAULT_MAX_STEPS = 5;

function main(): void {
  console.log('audit:agent-limits\n');

  console.log('DEPTH PROFILES (services/depth-controller.ts)');
  console.log('  level      steps   timeout    idle       hardCap');
  for (const level of LEVELS) {
    const steps = profileValue(level, 'maxSteps');
    if (steps === undefined) continue;
    const fmt = (ms: number | undefined) => (ms === undefined ? '—' : `${Math.round(ms / 1000)}s`);
    console.log(
      `  ${level.padEnd(10)} ${String(steps).padStart(5)}   ${fmt(profileValue(level, 'timeoutMs')).padEnd(9)}`
      + `  ${fmt(profileValue(level, 'idleTimeoutMs')).padEnd(9)}  ${fmt(profileValue(level, 'hardCapMs'))}`,
    );
  }
  const deepSteps = profileValue('deep', 'maxSteps') ?? 0;
  const criticalSteps = profileValue('critical', 'maxSteps') ?? deepSteps;
  const deepestProfile = Math.max(deepSteps, criticalSteps);

  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  const findings: string[] = [];

  console.log('\nPER AGENT');
  console.log('  agent                 steps   latency    V2 window   verdict');
  for (const id of Object.keys(agentBoard).sort()) {
    const card = agentBoard[id]!;
    const steps = declaredMaxSteps(id);
    const windowMs = registry.attemptCapMsFor(id);
    const window = windowMs ? `${Math.round(windowMs / 1000)}s` : '—';

    let verdict = 'ok';
    if (steps === undefined) {
      // Not "unbounded" — see MASTRA_DEFAULT_MAX_STEPS. Outside the harness this
      // agent is silently capped at five, whatever its toolset looks like.
      verdict = `NO DECLARATION → harness: profile · bare: ${MASTRA_DEFAULT_MAX_STEPS}`;
      findings.push(
        `${id}: declares no maxSteps. Under the harness the depth profile owns the ceiling; `
        + `everywhere else Mastra's own default of ${MASTRA_DEFAULT_MAX_STEPS} does, which nobody chose.`,
      );
    } else if (steps > deepestProfile) {
      verdict = `needs ${steps} > profile ${deepestProfile} → RAISED`;
    } else if (steps < deepestProfile) {
      // This USED to read "its own limit is decorative", which was wrong in a way
      // that invited someone to delete the declaration. It is decorative only
      // under the harness. On every other path it is the ONLY ceiling there is,
      // and removing it drops the agent back to five steps — for marketingAgent,
      // five steps against twenty-three tools.
      verdict = `${steps} · harness: profile ${deepestProfile} wins · bare: ${steps}`;
    }

    // A long pipeline needs both room to think and time to run. Steps without
    // window is the chef failure; window without steps is the mirror image.
    if (steps !== undefined && steps > deepestProfile && windowMs !== undefined && windowMs <= 300_000) {
      findings.push(
        `${id}: ${steps} steps declared inside a ${window} window. The two bounds measure different `
        + 'things and could disagree — but this is LATENT, not observed. Settle it with real run '
        + 'durations before moving either number: a ceiling changed on shallow samples is a guess with '
        + 'extra steps. (2026-08-10: researcher\'s 12 completed runs took 1-11s against that 300s '
        + 'window, so neither bound has ever come close to binding.)',
      );
    }

    console.log(
      `  ${id.padEnd(20)} ${String(steps ?? '—').padStart(5)}   ${card.latencyClass.padEnd(9)}`
      + `  ${window.padEnd(10)}  ${verdict}`,
    );
  }

  console.log('\nFINDINGS');
  if (findings.length === 0) {
    console.log('  none — steps, window and profile agree for every agent.');
  } else {
    for (const finding of findings) console.log(`  • ${finding}`);
  }
  console.log(
    '\nRULE IN FORCE: the harness may RAISE a step ceiling to what the agent declares,'
    + '\nnever lower it below (services/generate-with-harness.ts → stepCeilingFor).',
  );
}

try { main(); } catch (error) { console.error(`audit failed: ${(error as Error).message}`); process.exit(1); }
