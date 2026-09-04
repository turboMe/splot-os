#!/usr/bin/env tsx
/**
 * check:coding-domain (Z8) — coding was the biggest domain in this project
 * (86 inventory positions, `docs/MIGRACJA-DOMENY-CODING.md`) and the only one
 * of nine without a domain gate: analytics, content, crm, deliberation,
 * design, filmmaker, musician and writer all have one, coding and review did
 * not. The individual mechanisms are already covered by narrow behavioral
 * gates (check:coding-task-scope, check:live-merge-permission,
 * check:external-project-isolation, check:coding-delegation-repo-path, …) —
 * this is the structural gate those never were: is the domain wired into the
 * rest of the system as a whole, the way every other domain gate proves for
 * its own domain.
 *
 * Deliberately source-reading + a few real imports, matching the established
 * domain-gate pattern (see check-crm-domain.ts / check-musician-domain.ts) —
 * no LLM, no live server, no Mongo.
 *
 * Run: npx tsx src/mastra/scripts/check-coding-domain.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { gateRunsInOrder } from './lib/gate-steps.js';
import { agentModelSequences, resolveModelId } from '../config/model-manifest.js';
import { agentBoard } from '../config/agent-board.js';
import { CODING_AGENT_ID, CODE_REVIEW_AGENT_ID } from '../config/agent-ids.js';
import { SUBAGENT_ROLES } from '../config/subagent-roles.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('check:coding-domain');

const CODING_DOMAIN_AGENTS = ['codingAgent', 'codeReviewAgent', 'securityReviewAgent', 'performanceReviewAgent'] as const;

// ── Files present ────────────────────────────────────────────────────────────

const requiredFiles = [
  'src/mastra/agents/coding-agent.ts',
  'src/mastra/agents/code-review-agent.ts',
  'src/mastra/agents/security-review-agent.ts',
  'src/mastra/agents/performance-review-agent.ts',
  'src/mastra/prompts/coding/base.md',
  'src/mastra/prompts/coding/review.md',
];
check('required domain files are present and non-empty', () => {
  for (const file of requiredFiles) {
    const text = readFileSync(file, 'utf8');
    assert.ok(text.trim().length > 50, `${file} should be present and non-empty`);
  }
});

// ── Agent identity: the two real, live IDs and the two string-literal ones ──

check('CODING_AGENT_ID and CODE_REVIEW_AGENT_ID resolve to the runtime keys', () => {
  assert.equal(CODING_AGENT_ID, 'codingAgent');
  assert.equal(CODE_REVIEW_AGENT_ID, 'codeReviewAgent');
});

// ── Model manifest: every domain agent has a resolvable primary model ──────

check('every coding-domain agent has a resolvable model assignment', () => {
  for (const agentId of CODING_DOMAIN_AGENTS) {
    const sequence = (agentModelSequences as Record<string, { primary: string }>)[agentId];
    assert.ok(sequence?.primary, `${agentId} must have a primary model in agentModelSequences`);
    const resolved = resolveModelId(sequence.primary as never);
    assert.ok(resolved && resolved.length > 0, `${agentId}'s primary model must resolve to a real model id`);
  }
});

// ── maxSteps: Mastra defaults to 5 for anything that doesn't declare it ────
// (mastra_default_maxsteps.md — marketingAgent shipped with 23 tools and a
// silent 5-step ceiling before anyone declared this explicitly.)

const agentSources: Record<(typeof CODING_DOMAIN_AGENTS)[number], string> = {
  codingAgent: readFileSync('src/mastra/agents/coding-agent.ts', 'utf8'),
  codeReviewAgent: readFileSync('src/mastra/agents/code-review-agent.ts', 'utf8'),
  securityReviewAgent: readFileSync('src/mastra/agents/security-review-agent.ts', 'utf8'),
  performanceReviewAgent: readFileSync('src/mastra/agents/performance-review-agent.ts', 'utf8'),
};

check('every coding-domain agent declares maxSteps explicitly (no silent Mastra default-5)', () => {
  for (const agentId of CODING_DOMAIN_AGENTS) {
    assert.match(
      agentSources[agentId],
      /maxSteps:\s*\d+/,
      `${agentId} must declare defaultOptions.maxSteps explicitly`,
    );
  }
});

// ── Agent Board: cards exist, reviewers are internal, the author is not ────

check('Agent Board carries a card for all four coding-domain agents', () => {
  for (const agentId of CODING_DOMAIN_AGENTS) {
    assert.ok(agentId in agentBoard, `Agent Board must have a card for ${agentId}`);
    assert.equal(agentBoard[agentId as keyof typeof agentBoard]?.id, agentId);
  }
});

check('the three reviewers are internal (unreachable from meta directly); the author is not', () => {
  for (const reviewer of ['codeReviewAgent', 'securityReviewAgent', 'performanceReviewAgent'] as const) {
    assert.equal(
      (agentBoard[reviewer] as { internal?: boolean }).internal,
      true,
      `${reviewer} must be marked internal — reviewers are reached via delegateToReviewer, not meta routing`,
    );
  }
  assert.notEqual(
    (agentBoard.codingAgent as { internal?: boolean }).internal,
    true,
    'codingAgent must stay externally delegable from meta',
  );
});

// ── Tool boundary: a reviewer can never write; the author can ──────────────
// This is THE safety property Z2/E1 exist to prove — a reviewer that could
// call the same write/merge tools as the author would make its own verdict
// meaningless (reviewing something it could itself have changed).

const WRITE_TOOL_MARKERS = [
  'coding_write_file_tracked',
  'coding_apply_patch',
  'coding_init_worktree',
  'coding_accept_all',
  'coding_reject_all',
];

check('codingAgent registers the write/worktree tools a reviewer must never have', () => {
  for (const marker of WRITE_TOOL_MARKERS) {
    assert.ok(
      agentSources.codingAgent.includes(marker),
      `codingAgent must register ${marker} — it owns implementation, reviewers do not`,
    );
  }
});

check('no reviewer registers a write/worktree tool', () => {
  for (const reviewer of ['codeReviewAgent', 'securityReviewAgent', 'performanceReviewAgent'] as const) {
    for (const marker of WRITE_TOOL_MARKERS) {
      assert.equal(
        agentSources[reviewer].includes(marker),
        false,
        `${reviewer} must not register ${marker} — a reviewer that can write cannot give an independent verdict`,
      );
    }
    assert.ok(
      agentSources[reviewer].includes('coding_submit_review') || agentSources[reviewer].includes('submitReviewTool'),
      `${reviewer} must record its verdict through the review tool`,
    );
  }
});

check('all coding-domain agents and file-editor role register graphify_affected', () => {
  for (const agentId of CODING_DOMAIN_AGENTS) {
    assert.ok(
      agentSources[agentId].includes('graphify_affected') || agentSources[agentId].includes('graphifyAffectedTool'),
      `${agentId} must register graphify_affected for impact analysis`,
    );
  }
  assert.ok(
    SUBAGENT_ROLES['file-editor'].allowedTools.includes('graphify_affected'),
    'file-editor role must include graphify_affected in allowedTools',
  );
});

// ── Meta delegation wiring: all four IDs actually reach delegate-task.ts ───

const delegateTaskSource = readFileSync('src/mastra/tools/system/delegate-task.ts', 'utf8');
check('delegate-task.ts names all four coding-domain agents', () => {
  for (const agentId of CODING_DOMAIN_AGENTS) {
    assert.ok(delegateTaskSource.includes(agentId), `delegate-task.ts must mention ${agentId}`);
  }
  assert.match(delegateTaskSource, /cannot delegate recursively to itself/, 'self-delegation guard must exist');
});

// ── index.ts: all four are actually imported and registered ────────────────

const indexSource = readFileSync('src/mastra/index.ts', 'utf8');
check('index.ts imports and registers all four coding-domain agents', () => {
  for (const agentId of CODING_DOMAIN_AGENTS) {
    assert.match(
      indexSource,
      new RegExp(`import \\{ ${agentId} \\}`),
      `index.ts must import ${agentId}`,
    );
    assert.match(
      indexSource,
      new RegExp(`\\b${agentId},`),
      `index.ts must register ${agentId} in the agents map`,
    );
  }
});

// ── Tool shelf: the coding profile exists and can actually reach the write tools ──

check('the coding-agent tool-shelf profile has room for its own write tools', () => {
  const profileSource = readFileSync('src/mastra/config/transient-tool-shelf-profiles.ts', 'utf8');
  assert.match(profileSource, /'coding-agent':\s*\{/, 'a coding-agent shelf profile must be registered');
  const match = profileSource.match(/'coding-agent':\s*\{[\s\S]*?maxActive:\s*(\d+)/);
  assert.ok(match, 'coding-agent profile must declare maxActive');
  const maxActive = Number(match![1]);
  assert.ok(
    maxActive >= 5,
    `coding-agent maxActive (${maxActive}) must fit at least the 5 worktree tools codingAgent loads together `
    + '(coding_init_worktree, coding_apply_patch, coding_remove_worktree, coding_run_test, coding_create_artifact)',
  );
});

// ── Gate registration ───────────────────────────────────────────────────────

const packageSource = readFileSync('package.json', 'utf8');
check('package scripts run the coding-domain gate directly and from check:all', () => {
  assert.ok(packageSource.includes('"check:coding-domain"'));
  assert.ok(
    gateRunsInOrder(['check:coding-delegation-repo-path', 'check:coding-domain']),
    'check:all must run the coding-domain gate right after the delegation repo-path check',
  );
});

if (failures > 0) {
  console.error(`\n❌ check:coding-domain — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\n✅ check:coding-domain — identity, models, step ceilings, board cards, write/review boundary, delegation and gate wiring hold');
