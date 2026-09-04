/**
 * audit-coding-generate — harness bypass guard.
 *
 * Scans *.ts files for direct `agent.generate()` AND `agent.stream()` calls that
 * bypass the harness gateway.
 *
 * HRN-001 (generate/stream parity): a call that reaches the model without the
 * harness skips every invariant the harness owns — depth profile, reflector,
 * liveness budget, pending-message consumption, tool envelopes. `.stream()` had
 * no guard at all, so a streaming path could bypass all of it silently. The plan
 * requires wave changes to hold "dla objętych falą ścieżek generate oraz stream",
 * which means neither entry point may be unguarded.
 *
 * Allowed:
 *   - coding-harness.ts itself (the gateway)
 *   - weekly-content.ts (marketing agents, not coding flow)
 *   - delegate-task.ts (only non-coding agents go through direct generate)
 *   - files with `// @harness-exempt` comment on the generate line
 *
 * Usage: npx tsx src/mastra/scripts/audit-coding-generate.ts
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(import.meta.dirname, '..');
// `orchestration` added 2026-07-29: the V2 registry worker reaches the model via
// its own bounded gateway, so it was structurally invisible to this guard — the
// exact blind spot that let the V2 path run agents with no depth/reflector/
// liveness profile at all. In scope now so it cannot drift back silently.
const SCAN_DIRS = ['workflows', 'services', 'tools', 'orchestration'];

// Files where direct .generate() is expected/allowed
const EXEMPT_FILES = new Set([
  'coding-harness.ts',        // the gateway itself
]);

// Files/directories that are NOT coding flow — skip entirely
// These use marketing/analytics/sales/knowledge agents, not codingAgent
const NON_CODING_PATTERNS = [
  'workflows/analytics/',
  'workflows/marketing/',
  'workflows/sales/',
  'workflows/producer-hunt',
  'workflows/automation-client-hunt',
  'workflows/weekly-content',
  'tools/system/run-worker.ts',  // generic worker — uses ad-hoc agents, not codingAgent
  // Contract metadata, not executable code: the `notes` prose quotes
  // `agent.generate(...)` when describing the tripwire finding, which the
  // regex cannot tell apart from a real call site.
  'orchestration/coverage/',
];

// Pattern: agent.generate( / agent.stream( — both reach the model.
const GENERATE_PATTERN = /\.generate\s*\(/;
const STREAM_PATTERN = /\.stream\s*\(/;
const HARNESS_EXEMPT_PATTERN = /@harness-exempt/;

interface Violation {
  file: string;
  line: number;
  content: string;
  kind: 'generate' | 'stream';
}

function scanDir(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          files.push(...scanDir(full));
        } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
          files.push(full);
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip missing dirs */ }
  return files;
}

function auditFile(filePath: string): Violation[] {
  const basename = filePath.split('/').pop() || '';
  if (EXEMPT_FILES.has(basename)) return [];

  // Skip non-coding workflow files entirely
  const relFromRoot = relative(ROOT, filePath);
  if (NON_CODING_PATTERNS.some((p) => relFromRoot.includes(p))) return [];

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  // Skip files that don't reference any agent
  if (!content.includes('Agent') && !content.includes('agent')) return [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Skip imports
    if (trimmed.startsWith('import ')) continue;

    // Check for .generate( / .stream( calls — both are model entry points.
    const isGenerate = GENERATE_PATTERN.test(line);
    const isStream = STREAM_PATTERN.test(line);
    if (isGenerate || isStream) {
      // Allow @harness-exempt annotation
      if (HARNESS_EXEMPT_PATTERN.test(line)) continue;

      // Allow generateCoding( calls — they're the harness
      if (line.includes('generateCoding')) continue;

      // Allow generateJsonWithRepair — marketing helper
      if (line.includes('generateJsonWithRepair')) continue;

      // Allow generate_image, generate_ prefixed non-agent calls
      if (/generate_\w+/.test(line)) continue;

      // Embedding services expose .generate() but never reach a chat model, so
      // the harness has nothing to own here.
      if (/embedding\w*\.generate\s*\(/i.test(line)) continue;

      // Non-agent `.stream(` uses: node streams, fetch bodies, MCP transports.
      // Narrow to calls that read like an agent handle, so the guard stays a
      // signal rather than noise.
      if (isStream && !isGenerate && !/\b(agent|worker|planner|model)\w*\.stream\s*\(/i.test(line)) continue;

      // This is a direct model call that should go through the harness
      const relPath = relative(ROOT, filePath);
      violations.push({
        file: relPath,
        line: i + 1,
        content: trimmed.slice(0, 120),
        kind: isStream && !isGenerate ? 'stream' : 'generate',
      });
    }
  }

  return violations;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const allFiles: string[] = [];
for (const dir of SCAN_DIRS) {
  allFiles.push(...scanDir(join(ROOT, dir)));
}

const allViolations: Violation[] = [];
for (const file of allFiles) {
  allViolations.push(...auditFile(file));
}

if (allViolations.length === 0) {
  console.log('✅ No direct agent.generate() calls found in coding flow.');
  console.log(`   Scanned ${allFiles.length} files in: ${SCAN_DIRS.join(', ')}`);
  process.exit(0);
} else {
  console.error(`❌ Found ${allViolations.length} direct agent.generate() call(s) bypassing generateCoding():\n`);
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.content}\n`);
  }
  console.error(`Fix: Replace with generateCoding({ agent, agentId, prompt, phase, ... })`);
  console.error(`Or add // @harness-exempt if intentional.`);
  process.exit(1);
}
