#!/usr/bin/env tsx
/**
 * check:workspace-lsp (A11) — `lsp: true` on codeWorkspace was declared and
 * wired (`lsp_inspect` tool, `docs/MIGRACJA-DOMENY-CODING.md` A11) but never
 * exercised on its own: nothing ever proved the real
 * `typescript-language-server` process actually starts, indexes this repo,
 * and answers. Every other coding-domain claim in that inventory has a "✅
 * dowód" line from a real run; this one had none.
 *
 * NOT a fixture: `createWorkspaceTools(codeWorkspace)` spawns the real
 * language server against the real repo on disk and asks it real questions.
 * Slower than a unit check (LSP startup + indexing), on purpose — a mocked
 * hover response would prove nothing about whether the server actually
 * starts.
 *
 * Run: npx tsx src/mastra/scripts/check-workspace-lsp.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspaceTools } from '@mastra/core/workspace';
import { AGENTIC_AGENTS_REPO, codeWorkspace } from '../workspaces/code-workspace.js';

/**
 * Find the 1-based line holding `needle`, instead of hard-coding it.
 *
 * These probes used to pin literal line numbers. That made the check a tripwire
 * for ANY edit above the probed symbol: on 2026-08-24 a one-line deletion in
 * `pipeline-phase-tools.ts` (dropping `system_request_approval` from a phase
 * list ~40 lines higher) shifted `resolvePhaseTools` from 472 to 471, so hover
 * landed on the function BODY and the check reported a broken language server
 * when the language server was fine. Worse, it sits at line 90 of a 193-line
 * gate, so the failure stopped `check:all` and everything below it silently
 * stopped running.
 */
function lineOf(relativePath: string, needle: string): number {
  const source = readFileSync(join(AGENTIC_AGENTS_REPO, relativePath), 'utf8');
  const index = source.split('\n').findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `probe anchor vanished from ${relativePath}: ${needle}`);
  return index + 1;
}

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

console.log('check:workspace-lsp');

const tools = await createWorkspaceTools(codeWorkspace);

await check('lsp_inspect is actually exposed by the real workspace (not just configured)', () => {
  assert.ok(tools['lsp_inspect'], 'codeWorkspace must expose the renamed lsp_inspect tool (WORKSPACE_TOOLS.LSP.LSP_INSPECT)');
});

await check('hover on a real, known function returns its REAL signature and JSDoc from the live server', async () => {
  const result = await tools['lsp_inspect'].execute({
    path: 'src/mastra/config/pipeline-phase-tools.ts',
    line: lineOf('src/mastra/config/pipeline-phase-tools.ts', 'export function resolvePhaseTools('),
    match: 'export function <<<resolvePhaseTools(agentKey: string, phase: string | null): string[] | null {',
  }, {} as never);
  const hoverText = (result as { hover?: { value?: string } }).hover?.value ?? '';
  assert.match(
    hoverText,
    /function resolvePhaseTools\(agentKey: string, phase: string \| null\): string\[\] \| null/,
    'hover must return the REAL inferred signature, not a placeholder',
  );
  assert.match(hoverText, /FAIL-OPEN/, 'hover must carry the real JSDoc, not just a bare type');
});

await check('definition on a real call site resolves to a real, specific location in this repo', async () => {
  const result = await tools['lsp_inspect'].execute({
    path: 'src/mastra/services/generate-with-harness.ts',
    line: lineOf('src/mastra/services/generate-with-harness.ts', 'return translateToolIdsToKeys(resolvePhaseTools('),
    match: 'return translateToolIdsToKeys(<<<resolvePhaseTools(input.agentId, input.phase), idToKey);',
  }, {} as never);
  const definitions = (result as { definition?: Array<{ location?: string; preview?: string }> }).definition ?? [];
  assert.ok(definitions.length > 0, 'a real call site must resolve at least one definition location');
  const [first] = definitions;
  assert.match(
    first.location ?? '',
    /generate-with-harness\.ts|pipeline-phase-tools\.ts/,
    // Either the import binding (same file) or the true declaration is a
    // legitimate "go to definition" answer — tsserver's own choice, not this
    // workspace's. What matters is that it named a REAL file in this repo.
    `definition must point at a real file in this repo, got: ${JSON.stringify(first)}`,
  );
  assert.ok((first.preview ?? '').length > 0, 'definition must include a non-empty source preview');
});

await check('an unresolvable symbol fails gracefully — no result, no crash', async () => {
  const result = await tools['lsp_inspect'].execute({
    path: 'src/mastra/config/pipeline-phase-tools.ts',
    line: lineOf('src/mastra/config/pipeline-phase-tools.ts', 'export function resolvePhaseTools('),
    match: 'export function resolvePhaseTools(<<<totallyMadeUpParamXyz123: string, phase: string | null): string[] | null {',
  }, {} as never);
  // No throw is the assertion; a garbage cursor position must not crash the tool.
  assert.ok(result, 'the tool must return SOMETHING (possibly empty groups), never throw, on an unresolvable position');
});

if (failures > 0) {
  console.error(`\n❌ check:workspace-lsp — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\n✅ check:workspace-lsp — the real typescript-language-server starts, indexes this repo, and answers hover/definition');
process.exit(0);
