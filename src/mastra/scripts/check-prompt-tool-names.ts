#!/usr/bin/env tsx
/**
 * check:prompt-tool-names — a prompt may only name tools the model can call.
 *
 * WHY THIS EXISTS
 * ---------------
 * Mastra names a tool after the KEY of the agent's `tools` object, not after
 * `createTool({ id })`. The two are usually different spellings of the same
 * thing (`worktreeDiffTool` vs `coding_worktree_diff`), and the codebase already
 * knows this — `ORCHESTRATION-V2.md` §"id ≠ the name the runtime reports"
 * documents it, and `pipeline-phase-tools.ts` carries an id→key translator for
 * `activeTools`.
 *
 * Nobody applied it to the PROMPTS. Measured 2026-08-12 on `codeReviewAgent`:
 * its instructions open with *"`coding_worktree_diff` — **Use this first**"*, and
 * `listTools()` returns `worktreeDiffTool`. Six of its eleven tool references
 * named something that does not exist. The agent still works, because a model
 * will usually find the near-match in its tool registry — which is exactly why
 * this survived: it degrades into extra turns and occasional wrong picks rather
 * than a visible error.
 *
 * WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
 * --------------------------------------------------
 * It does NOT try to decide which backticked words in a prompt are tool names —
 * that guess would fire on `taskId`, `npm run build` and every file path. It
 * inverts the question: a backticked token is only interesting when it IS a
 * registered tool id somewhere in this codebase. Then one of two things must be
 * true — the agent exposes it under that exact name, or the prompt is naming
 * something the model cannot call.
 *
 * Source-text based, like `check:agent-board-sync`, rather than instantiating
 * agents: importing `coding-agent.ts` blocks on the MCP sidecar at module load.
 *
 * Run: npx tsx src/mastra/scripts/check-prompt-tool-names.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS_DIR = 'src/mastra/agents';
const TOOLS_ROOT = 'src/mastra/tools';
const WORKSPACES_DIR = 'src/mastra/workspaces';
const PROMPTS_DIR = 'src/mastra/prompts';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

/** Every `.ts` under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** The block between the first `{` after `marker` and its matching `}`. */
function braceBlock(source: string, marker: RegExp): string | null {
  const start = source.search(marker);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

// ── 1. The tool vocabulary: export variable → registered id ──────────────────

const varToId = new Map<string, string>();
const knownIds = new Set<string>();
for (const file of walk(TOOLS_ROOT)) {
  const source = readFileSync(file, 'utf8');
  for (const m of source.matchAll(/export const (\w+)\s*(?::[^=]+)?=\s*createTool\(\{/g)) {
    const varName = m[1]!;
    const idMatch = source.slice(m.index!).match(/id:\s*'([^']+)'/);
    if (!idMatch) continue;
    varToId.set(varName, idMatch[1]!);
    knownIds.add(idMatch[1]!);
  }
}

// Workspace tools are named explicitly in the workspace definition, and those
// names ARE what the model sees — they are legitimate references in any prompt
// belonging to an agent with that workspace.
const workspaceToolNames = new Set<string>();
for (const file of walk(WORKSPACES_DIR)) {
  for (const m of readFileSync(file, 'utf8').matchAll(/name:\s*'([a-z_]+)'/g)) {
    workspaceToolNames.add(m[1]!);
  }
}

console.log('check:prompt-tool-names');
console.log(`  (vocabulary: ${knownIds.size} registered tool ids, ${workspaceToolNames.size} workspace tool names)`);

// ── 2. Each agent: the names its model will actually see ─────────────────────

type AgentInfo = {
  file: string;
  /** Keys of the `tools` object — what Mastra reports as tool names. */
  toolKeys: Set<string>;
  /** `...spread` entries: an unknown, so references are not judged against them. */
  hasSpread: boolean;
  /** Prompt paths passed to loadPrompt(). */
  prompts: string[];
  hasWorkspace: boolean;
};

const agents: AgentInfo[] = [];
for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const file = join(AGENTS_DIR, entry.name);
  const source = readFileSync(file, 'utf8');

  const toolsBlock = braceBlock(source, /\n\s{2}tools:\s*\{/);
  if (toolsBlock === null) continue;

  const toolKeys = new Set<string>();
  let hasSpread = false;
  for (const line of toolsBlock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.length === 0) continue;
    if (/^\.\.\./.test(trimmed)) { hasSpread = true; continue; }
    const alias = trimmed.match(/^([A-Za-z_][\w]*)\s*:/);
    if (alias) { toolKeys.add(alias[1]!); continue; }
    const shorthand = trimmed.match(/^([A-Za-z_][\w]*)\s*,?$/);
    if (shorthand) toolKeys.add(shorthand[1]!);
  }

  const prompts = [...source.matchAll(/loadPrompt\('([^']+)'\)/g)].map((m) => m[1]!);
  agents.push({
    file,
    toolKeys,
    hasSpread,
    prompts,
    hasWorkspace: /\n\s{2}workspace:/.test(source),
  });
}

// ── 3. The assertion ─────────────────────────────────────────────────────────

/**
 * The name a prompt may use for a tool the agent holds: its KEY. When the key is
 * an export variable, the id it registers is the spelling the prompt must NOT
 * use, because the runtime never reports it.
 */
function reachableNames(agent: AgentInfo): Set<string> {
  const names = new Set(agent.toolKeys);
  if (agent.hasWorkspace) for (const n of workspaceToolNames) names.add(n);
  return names;
}

type Finding = { agent: string; prompt: string; named: string; reachableAs?: string };
const findings: Finding[] = [];

for (const agent of agents) {
  const reachable = reachableNames(agent);
  // id → the key this agent actually exposes it under, when it holds the tool.
  const idToKey = new Map<string, string>();
  for (const key of agent.toolKeys) {
    const id = varToId.get(key);
    if (id) idToKey.set(id, key);
  }

  for (const promptPath of agent.prompts) {
    let text: string;
    try {
      text = readFileSync(join(PROMPTS_DIR, `${promptPath}.md`), 'utf8');
    } catch {
      continue; // a prompt that does not resolve is check:house-style's problem
    }
    const named = new Set([...text.matchAll(/`([a-z][a-z0-9_]{3,})`/g)].map((m) => m[1]!));
    for (const token of named) {
      if (!knownIds.has(token)) continue;      // not a tool name at all
      if (reachable.has(token)) continue;      // exposed under exactly this name
      findings.push({
        agent: agent.file.split('/').pop()!.replace('.ts', ''),
        prompt: promptPath,
        named: token,
        ...(idToKey.has(token) ? { reachableAs: idToKey.get(token)! } : {}),
      });
    }
  }
}

/**
 * The prompts held to this contract today.
 *
 * A DIRECTORY, not a list of agent names, so the frontier is a real boundary
 * rather than a second roster to keep in sync. The first measurement found the
 * defect in eight agents across four domains — fixing all of them means renaming
 * tool keys on `automationArchitect`, `researcherAgent` and `crmAgent`, which
 * have already passed a canary, and reshaping verified work as a side effect of
 * a different task is how a migration loses its baseline. So the coding domain
 * (the one being migrated) is gated now, and every other domain is printed as a
 * backlog with its numbers. Widening this array is a deliberate act with its own
 * fix and its own commit.
 */
const GATED_PROMPT_PREFIXES = ['coding/'];
const gated = (f: Finding) => GATED_PROMPT_PREFIXES.some((p) => f.prompt.startsWith(p));

const held = findings.filter((f) => f.reachableAs);
const absent = findings.filter((f) => !f.reachableAs);

check(`no prompt in [${GATED_PROMPT_PREFIXES.join(', ')}] names a tool its agent holds under a DIFFERENT runtime name`, () => {
  const bad = held.filter(gated);
  if (bad.length === 0) return;
  const lines = bad.map((f) => `      ${f.agent} (${f.prompt}): prompt says \`${f.named}\`, runtime reports \`${f.reachableAs}\``);
  assert.fail(
    `${bad.length} unreachable tool reference(s) — the model is told to call a name that does not exist:\n${lines.join('\n')}`,
  );
});

// Dangling references are NOT gated, in either domain, and that is deliberate:
// a prompt may legitimately name a tool the agent does not hold in order to
// FORBID it — `n8nMcpEngineer` is told in so many words never to deploy or
// activate. Telling a prohibition from a dead instruction needs the sentence
// around it, and a gate that guesses would be one whose failures look like its
// findings. Printed instead, so a human reads them once.
if (absent.length > 0) {
  console.log(`\n  ⚠ ${absent.length} reference(s) to a tool the agent does NOT hold — check each: prohibition, or dead instruction?`);
  for (const f of absent) console.log(`      ${f.agent} (${f.prompt}): \`${f.named}\``);
}

const backlog = held.filter((f) => !gated(f));
if (backlog.length > 0) {
  const byAgent = new Map<string, number>();
  for (const f of backlog) byAgent.set(f.agent, (byAgent.get(f.agent) ?? 0) + 1);
  console.log(`\n  ⚠ BACKLOG — ${backlog.length} unreachable reference(s) outside the gated prompts:`);
  for (const [agent, count] of [...byAgent].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${agent}: ${count}`);
  }
  console.log('      Fixing these renames tool keys on canary-verified agents — owner decision, not a drive-by.');
}

check('the vocabulary itself was found (a silent empty scan proves nothing)', () => {
  assert.ok(knownIds.size > 50, `expected the tool scan to find a real vocabulary, got ${knownIds.size}`);
  assert.ok(agents.length > 10, `expected to find the agent roster, got ${agents.length}`);
  assert.ok(workspaceToolNames.has('execute_command'), 'workspace tool names were not picked up');
});

if (failures > 0) {
  console.error(`\n❌ check:prompt-tool-names — ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ check:prompt-tool-names — every tool a prompt names is one the model can actually call (${agents.length} agents)`);
process.exit(0);
