#!/usr/bin/env tsx
/**
 * Can this agent hand over what it promises?
 *
 * `audit:agent-limits` answers "how much may an agent do". Nothing answered
 * "can it do this at all", and that gap cost four canaries.
 *
 * `designAgent`'s Agent Board card declares `outputArtifacts: ['media_ref',
 * 'document']` — a `media_ref` IS a pointer to a file — while the agent
 * registered no tool that wrote anything. `run_worker` is text-in/text-out with
 * no tools, and every design tool that emits a file (`design_render_video`,
 * `design_export_pdf`, `design_export_pptx`) takes an `htmlPath`/`slidesDir`
 * that must already exist. So the pipeline was severed at step one.
 *
 * The symptom was indistinguishable from a selection bug: the job COMPLETED with
 * 316 chars of narration over 2316 chars of real output. Three rounds went into
 * the deliverable SELECTOR — each finding a genuine bug, none of them this one —
 * because a path that is unreachable and a path that is mispicked look the same
 * from outside.
 *
 * THE INVARIANT
 * -------------
 * An agent whose declared output is a FILE must register a tool the orchestrator
 * recognises as a document write. Prose agents are exempt on purpose: for
 * `researcherAgent` or `analyticsAgent` the response text IS the product, and
 * requiring a writer there would be ceremony. `media_ref` is the sharp case —
 * a reference to a file cannot exist without something that wrote the file.
 *
 * Run: npx tsx src/mastra/scripts/check-deliverable-capability.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentBoard } from '../config/agent-board.js';
import { SIDE_EFFECT_PRODUCT_CAPABILITIES } from '../config/capability-routing.js';

const AGENTS_DIR = 'src/mastra/agents';
const TOOLS_DIR = 'src/mastra/tools';

/**
 * Board id → agent source file.
 *
 * Duplicated from `audit-agent-limits` deliberately: that script's own first run
 * mapped `filmmakerAgent` to a file that does not exist and reported the
 * unreadable source as a finding — a defect that was not there, in the same
 * shape as six that were. Both scripts therefore treat an unreadable source as a
 * hard stop, and keeping the maps independent means a wrong entry cannot be
 * copied silently into both.
 */
const AGENT_SOURCES: Record<string, string> = {
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

/** Output artifact types that cannot exist unless something wrote a file. */
const FILE_SHAPED_ARTIFACTS = new Set(['media_ref']);

/** Every `.ts` under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Exported tool constant → the tool id it registers.
 *
 * Agents list tools by their VARIABLE name (`artifactPutTool`) while the
 * orchestrator matches on the tool ID (`artifact_put`), so the check has to
 * cross the two namespaces or it would compare nothing to nothing and pass.
 */
function buildToolIdMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of sourceFiles(TOOLS_DIR)) {
    const source = readFileSync(file, 'utf8');
    const pattern = /export const (\w+)\s*=\s*createTool\(\{([\s\S]{0,400}?)\bid:\s*'([^']+)'/g;
    for (const match of source.matchAll(pattern)) {
      map.set(match[1]!, match[3]!);
    }
  }
  return map;
}

/**
 * The body of the agent's `tools: { … }` literal.
 *
 * Brace-matched rather than "everything after the marker": over-including would
 * count a tool that is imported but never registered, and for a gate a false
 * PASS is the expensive direction — it is exactly the state designAgent was in.
 */
function toolsBlock(source: string, agentId: string): string {
  // Two registration forms exist. Inline (`tools: { … }`) is the common one;
  // `marketingAgent` builds a shared `const marketingTools = { … }` and passes it
  // by name because it is a factory for eight sibling agents.
  let start = source.indexOf('tools: {');
  if (start < 0) {
    const named = /tools:\s*(\w+)\s*,/.exec(source)?.[1];
    if (!named) throw new Error(`${agentId}: no \`tools\` registration found in its source`);
    start = source.indexOf(`const ${named} = {`);
    if (start < 0) throw new Error(`${agentId}: registers \`tools: ${named}\`, whose declaration is not in this file`);
  }
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${agentId}: unbalanced braces in its \`tools\` block`);
}

/** Tool ids the orchestrator accepts as "this run produced a document". */
function writeToolIds(): Set<string> {
  const source = readFileSync('src/mastra/services/harness-output-text.ts', 'utf8');
  const listed = /ARTIFACT_WRITE_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1];
  if (!listed) throw new Error('could not read ARTIFACT_WRITE_TOOLS from harness-output-text.ts');
  return new Set([...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
}

const toolIds = buildToolIdMap();
const writers = writeToolIds();
const failures: string[] = [];
const rows: Array<{ agent: string; declares: string; writers: string }> = [];

for (const [agentId, card] of Object.entries(agentBoard)) {
  const file = AGENT_SOURCES[agentId];
  if (!file) {
    failures.push(`${agentId}: on the Agent Board but missing from AGENT_SOURCES — this check cannot see it`);
    continue;
  }
  let source: string;
  try {
    source = readFileSync(`${AGENTS_DIR}/${file}.ts`, 'utf8');
  } catch {
    // An unreadable source STOPS the check; it never becomes a finding.
    failures.push(`${agentId}: cannot read ${AGENTS_DIR}/${file}.ts`);
    continue;
  }

  let block: string;
  try {
    block = toolsBlock(source, agentId);
  } catch (error) {
    failures.push((error as Error).message);
    continue;
  }

  const registered = [...block.matchAll(/\b(\w+Tool)\b/g)].map((m) => m[1]!);
  const registeredWriters = [...new Set(registered)]
    .map((name) => toolIds.get(name))
    .filter((id): id is string => typeof id === 'string' && writers.has(id));

  const fileShaped = card.outputArtifacts.filter((type) => FILE_SHAPED_ARTIFACTS.has(type));
  rows.push({
    agent: agentId,
    declares: card.outputArtifacts.join(', '),
    writers: registeredWriters.length > 0 ? registeredWriters.join(', ') : '—',
  });

  if (fileShaped.length > 0 && registeredWriters.length === 0) {
    failures.push(
      `${agentId}: declares ${fileShaped.join('/')} (a pointer to a FILE) but registers no tool that writes one. `
      + `Its work cannot leave the run — it will deliver prose about a file that does not exist. `
      + `Give it a writer whose id is in ARTIFACT_WRITE_TOOLS (see design_write_deliverable).`,
    );
  }
}

console.log('check:deliverable-capability\n');
const width = Math.max(...rows.map((r) => r.agent.length));
for (const row of rows) {
  const mark = row.writers === '—' ? ' ' : '✓';
  console.log(`  ${mark} ${row.agent.padEnd(width)}  declares: ${row.declares.padEnd(34)} writes via: ${row.writers}`);
}

// A capability told to save its product MUST own a tool that saves.
//
// The headless contract now instructs every `SIDE_EFFECT_PRODUCT_CAPABILITIES`
// entry to record what it produced with `artifact_put`, because its real work
// lands outside the conversation. Three of the seven did not have that tool when
// the list was written — marketing, sales and the MCP engineer were being told to
// call something that does not exist, which costs steps and teaches the model
// that the instructions are approximate.
//
// This is the designAgent defect in a new place: a promise made on an agent's
// behalf that its toolset cannot keep. The list and the toolsets are two
// statements of one fact, so they get checked against each other rather than
// maintained in parallel.
for (const capability of SIDE_EFFECT_PRODUCT_CAPABILITIES) {
  const row = rows.find((r) => r.agent === capability);
  if (!row) {
    failures.push(
      `${capability}: listed as a side-effect producer but not on the Agent Board — `
      + 'the contract would instruct an agent this check cannot see',
    );
    continue;
  }
  if (row.writers === '—') {
    failures.push(
      `${capability}: the headless contract tells it to save its product with artifact_put, `
      + 'and it owns no tool that writes an artifact',
    );
  }
}

if (failures.length > 0) {
  console.error('\n❌ check:deliverable-capability');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\n✅ check:deliverable-capability — every agent that promises a file can actually write one');
process.exit(0);
