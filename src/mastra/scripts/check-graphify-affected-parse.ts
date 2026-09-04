#!/usr/bin/env tsx
/**
 * check:graphify-affected-parse — Etap 8.
 *
 * Deterministic assertions on the Graphify integration WITHOUT requiring the
 * CLI or a built graph:
 *   - parseAffectedOutput correctly structures real `graphify affected` output
 *     (captured from the spike on this repo — transitionLane);
 *   - relations + depth headers are parsed;
 *   - non-result lines are ignored;
 *   - runGraphifyAffected fail-soft: FEATURE off → unavailable with a hint;
 *     missing graph → unavailable with a build hint (never throws).
 *
 * The live path (real CLI + graph) is a manual/integration check, not CI —
 * `npm run graph:build && graphify affected …`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseAffectedOutput, runGraphifyAffected,
  parseExplainOutput, parseGodNodesOutput,
} from '../services/graphify.js';

let failures = 0;
function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures += 1; console.error(`  ✗ ${name}: ${(err as Error).message}`); });
}

// Real output captured from the spike (graphify affected transitionLane).
const SAMPLE = `Affected nodes for transitionLane()
Relations: calls, indirect_call, references, imports, imports_from, re_exports
Depth: 2
- check-ledger-claims-conflict.ts [imports] scripts/check-ledger-claims-conflict.ts:L1
- main() [calls] scripts/check-ledger-claims-conflict.ts:L44
- ledgerTransitionBySource() [calls] services/task-ledger.ts:L492
- ledger-tools.ts [imports] tools/system/ledger-tools.ts:L1
- async-delegation.ts [imports] services/async-delegation.ts:L1
- executeDelegation() [calls] services/async-delegation.ts:L192
- automation-job-manager.ts [imports] services/automation-job-manager.ts:L1
- executeAutomationJob() [calls] services/automation-job-manager.ts:L259`;

async function main(): Promise<void> {
  console.log('check:graphify-affected-parse');

  await ok('parses relations + depth headers', () => {
    const p = parseAffectedOutput(SAMPLE);
    assert.deepEqual(p.relations, ['calls', 'indirect_call', 'references', 'imports', 'imports_from', 're_exports']);
    assert.equal(p.depth, 2);
  });

  await ok('parses each affected edge (label, relation, file, line)', () => {
    const p = parseAffectedOutput(SAMPLE);
    assert.equal(p.affected.length, 8);
    const first = p.affected[0]!;
    assert.equal(first.label, 'check-ledger-claims-conflict.ts');
    assert.equal(first.relation, 'imports');
    assert.equal(first.file, 'scripts/check-ledger-claims-conflict.ts');
    assert.equal(first.line, 1);
    const callEdge = p.affected.find((e) => e.label === 'executeAutomationJob()');
    assert.ok(callEdge);
    assert.equal(callEdge!.relation, 'calls');
    assert.equal(callEdge!.file, 'services/automation-job-manager.ts');
    assert.equal(callEdge!.line, 259);
  });

  await ok('ignores noise / empty input', () => {
    assert.equal(parseAffectedOutput('').affected.length, 0);
    assert.equal(parseAffectedOutput('random\nlines\nno edges').affected.length, 0);
  });

  await ok('parseExplainOutput: node meta + directed connections', () => {
    const sample = `Node: openLane()
  ID:        services_task_ledger_openlane
  Source:    src/mastra/services/task-ledger.ts L165
  Type:      code
  Community: task-ledger.ts
  Degree:    10

Connections (10):
  --> getDb() [calls] [EXTRACTED]
  <-- task-ledger.ts [contains] [EXTRACTED]
  <-- ledgerOpenLane() [calls] [EXTRACTED]`;
    const p = parseExplainOutput(sample);
    assert.equal(p.node, 'openLane()');
    assert.equal(p.source, 'src/mastra/services/task-ledger.ts L165');
    assert.equal(p.community, 'task-ledger.ts');
    assert.equal(p.degree, 10);
    assert.equal(p.connections.length, 3);
    const out = p.connections.find((c) => c.direction === 'out');
    assert.equal(out?.node, 'getDb()');
    assert.equal(out?.relation, 'calls');
    assert.equal(p.connections.filter((c) => c.direction === 'in').length, 2);
  });

  await ok('parseGodNodesOutput: rank/label/edges', () => {
    const sample = `God nodes (most connected):
  1. getDb() - 338 edges
  2. Genre Presets - 249 edges
  3. logHarnessEvent() - 56 edges`;
    const g = parseGodNodesOutput(sample);
    assert.equal(g.length, 3);
    assert.deepEqual(g[0], { rank: 1, label: 'getDb()', edges: 338 });
    assert.equal(g[2]!.label, 'logHarnessEvent()');
  });

  await ok('fail-soft when FEATURE_GRAPHIFY=false', async () => {
    process.env.FEATURE_GRAPHIFY = 'false';
    const res = await runGraphifyAffected({ symbol: 'transitionLane' });
    assert.equal(res.available, false);
    if (!res.available) assert.match(res.reason, /FEATURE_GRAPHIFY/);
    process.env.FEATURE_GRAPHIFY = 'true';
  });

  await ok('fail-soft when graph is missing (never throws)', async () => {
    process.env.FEATURE_GRAPHIFY = 'true';
    process.env.GRAPHIFY_GRAPH = '/nonexistent/graphify-out/graph.json';
    const res = await runGraphifyAffected({ symbol: 'transitionLane' });
    assert.equal(res.available, false);
    if (!res.available) assert.match(res.hint, /graph:build|code_search/);
    delete process.env.GRAPHIFY_GRAPH;
  });

  // ── "not found" must never look like "nothing depends on it" ─────────────────
  await ok('an unresolved symbol is NOT reported as zero dependents', () => {
    // Measured against the real CLI and graph: `affected getDb` printed
    // `No unique node match for getDb` on stdout with exit code 0, the parser saw
    // no edge lines, and the tool answered "0 nodes depend on getDb" — for a
    // symbol whose own `explain` reports degree 396.
    //
    // For an impact-analysis tool that is the worst shape a failure can take: it
    // says "nothing depends on this, safe to change" when it never looked.
    const unresolved = parseAffectedOutput('No unique node match for getDb\n');
    assert.deepEqual(unresolved.affected, [], 'the parser itself has nothing to find — that part was right');

    // The DECISION must not come from the edge count alone. The success header is
    // the structural signal, chosen over the error sentence so the check does not
    // depend on the CLI's wording.
    const src = readFileSync('src/mastra/services/graphify.ts', 'utf-8');
    const at = src.indexOf('export async function runGraphifyAffected');
    const body = src.slice(at, src.indexOf('\nexport ', at + 10));
    assert.match(body, /Affected nodes for/,
      'the runner must confirm the CLI actually resolved the node');
    assert.match(body, /available: false/,
      'and an unresolved symbol must be reported as unavailable, not as an empty answer');
    assert.match(body, /runGraphifyExplain/,
      'and it must first try to resolve the name the way a human would — `affected` '
      + 'takes only the graph id, which nobody knows before asking');
  });

  await ok('the explain parser captures the node id the retry needs', () => {
    const parsed = parseExplainOutput([
      'Node: getDb()',
      '  ID:        lib_mongo_getdb',
      '  Source:    src/mastra/lib/mongo.ts L26',
      '  Degree:    396',
    ].join('\n'));
    assert.equal((parsed as { id?: string }).id, 'lib_mongo_getdb',
      'without the id the auto-resolution has nothing to retry with');
  });

  // ── G1: Freshness and staleness detection ──────────────────────────────────
  await ok('readGraphBuiltAtCommit extracts SHA-1 from graph', async () => {
    const { readGraphBuiltAtCommit } = await import('../services/graphify.js');
    const commit = readGraphBuiltAtCommit();
    if (commit) {
      assert.match(commit, /^[a-f0-9]{40}$/i, 'must be a 40-character git commit SHA');
    }
  });

  await ok('getGraphStaleness accurately reflects HEAD vs older commits', async () => {
    const { getGraphStaleness } = await import('../services/graphify.js');
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // 1. Missing graph
    const missingStatus = await getGraphStaleness({ graphPath: '/nonexistent/graph.json' });
    assert.equal(missingStatus, 'graph not found');

    // 2. Exact HEAD commit
    const { stdout: headSha } = await execFileAsync('git', ['rev-parse', 'HEAD']);
    const tempExactGraph = resolve(tmpdir(), `test-graph-exact-${Date.now()}.json`);
    writeFileSync(tempExactGraph, JSON.stringify({ built_at_commit: headSha.trim() }));
    try {
      const statusExact = await getGraphStaleness({ graphPath: tempExactGraph });
      assert.equal(statusExact, 'graph up to date (built at HEAD)');
    } finally {
      unlinkSync(tempExactGraph);
    }

    // 3. Older commit (HEAD~1)
    const { stdout: prevSha } = await execFileAsync('git', ['rev-parse', 'HEAD~1']);
    const tempOlderGraph = resolve(tmpdir(), `test-graph-older-${Date.now()}.json`);
    writeFileSync(tempOlderGraph, JSON.stringify({ built_at_commit: prevSha.trim() }));
    try {
      const statusOlder = await getGraphStaleness({ graphPath: tempOlderGraph });
      assert.match(statusOlder, /HEAD is 1 commit ahead — may miss the 1 most recent change$/);
    } finally {
      unlinkSync(tempOlderGraph);
    }
  });

  await ok('graphify tools declare staleness in outputSchema', async () => {
    const { graphifyAffectedTool, graphifyExplainTool, graphifyGodNodesTool } = await import('../tools/dev/graphify-tools.js');
    assert.ok((graphifyAffectedTool as any).outputSchema.shape.staleness, 'graphify_affected must have staleness in outputSchema');
    assert.ok((graphifyExplainTool as any).outputSchema.shape.staleness, 'graphify_explain must have staleness in outputSchema');
    assert.ok((graphifyGodNodesTool as any).outputSchema.shape.staleness, 'graphify_god_nodes must have staleness in outputSchema');
  });


  if (failures > 0) {
    console.error(`\n❌ check:graphify-affected-parse — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:graphify-affected-parse — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error('❌ crashed:', err); process.exit(1); });
