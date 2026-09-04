#!/usr/bin/env tsx
/**
 * check:automation-patterns
 *
 * Smoke test wszystkich executable patternow:
 *  - generuje minimalny AutomationSpec dla pattern.requiredInputs
 *  - wywoluje pattern.build(spec)
 *  - sprawdza ze workflow nie jest pusty (>=1 node, >=1 connection lub trigger-only)
 *  - uruchamia validateWorkflow w trybie 'draft'
 *  - raportuje per-pattern: missing values, missing credentials, unknown nodes,
 *    forbidden fallbacki, security issues
 *
 *   npm run check:automation-patterns
 *
 * Exit code 0 = wszystkie passed, 1 = co najmniej jeden failed.
 */
import 'dotenv/config';
import { automationPatterns } from '../tools/architect/pattern-catalog.js';
import { validateWorkflow } from '../tools/architect/validation/workflow-validator.js';
import type { AutomationPattern, AutomationSpec } from '../tools/architect/types.js';
import { deriveWorkflowCapabilities } from '../tools/architect/capability-coverage.js';

type Result = {
  patternId: string;
  patternName: string;
  executable: boolean;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  reason: string;
  details: string[];
};

function buildMinimalSpec(pattern: AutomationPattern): AutomationSpec {
  const inputs = pattern.requiredInputs.map((alias) => ({
    name: alias,
    type: aliasToType(alias),
    required: true,
    description: `smoke-test value for ${alias}`,
    value: aliasToValue(alias),
    aliases: [alias],
  })) as AutomationSpec['inputs'];

  return {
    id: `smoke-${pattern.id}`,
    requestId: `smoke-${pattern.id}`,
    name: `Smoke Test: ${pattern.name}`,
    description: `Smoke test of pattern ${pattern.id}`,
    goal: 'Validate that pattern produces a deployable workflow JSON.',
    trigger: { type: 'manual' },
    inputs,
    steps: [],
    riskLevel: pattern.risk,
    requiresApproval: pattern.forbiddenWithoutApproval,
  };
}

function aliasToType(alias: string): 'string' | 'number' | 'boolean' | 'url' | 'secret' | 'json' {
  const a = alias.toLowerCase();
  if (a.includes('url') || a.includes('endpoint') || a === 'rssurl') return 'url';
  if (a.includes('keyword') || a.includes('topic') || a === 'urls') return 'string';
  return 'string';
}

function aliasToValue(alias: string): unknown {
  const a = alias.toLowerCase();
  if (a.includes('crm') || a.includes('agentforge')) return 'http://localhost:4111/api/crm/leads';
  if (a.includes('url') || a.includes('endpoint')) return 'https://smoke.test/feed';
  if (a === 'urls') return ['https://smoke.test/a', 'https://smoke.test/b'];
  if (a.includes('keyword')) return 'smoke,test';
  if (a.includes('topic')) return 'smoke,test';
  if (a === 'path') return 'smoke-test';
  if (a === 'prompt') return 'smoke test prompt';
  if (a === 'tasktype') return 'smoke';
  return 'smoke-value';
}

const results: Result[] = [];

for (const pattern of automationPatterns) {
  const isExecutable = pattern.executable !== false;

  if (!isExecutable) {
    results.push({
      patternId: pattern.id,
      patternName: pattern.name,
      executable: false,
      status: 'skip',
      reason: `abstract (maturity=${pattern.maturity ?? 'draft'})`,
      details: [],
    });
    continue;
  }

  try {
    const spec = buildMinimalSpec(pattern);
    const built = pattern.build(spec);
    const workflow = {
      name: `Smoke - ${pattern.name}`,
      nodes: built?.nodes ?? [],
      connections: built?.connections ?? {},
      settings: built?.settings ?? { executionOrder: 'v1' },
      active: false,
    };

    const validation = validateWorkflow(workflow, 'draft');
    const details: string[] = [];

    if (validation.nodeCount === 0) {
      results.push({
        patternId: pattern.id,
        patternName: pattern.name,
        executable: true,
        status: 'fail',
        reason: 'builder returned empty workflow (no nodes)',
        details,
      });
      continue;
    }

    if (validation.errors.length > 0) {
      validation.errors.forEach((e) => details.push(`error: ${e.nodeName ?? '-'} :: ${e.message}`));
    }
    if (validation.securityIssues.length > 0) {
      validation.securityIssues.forEach((s) => details.push(`security: ${s.nodeName ?? '-'} :: ${s.message}`));
    }
    // Missing credentials sa stanem srodowiska (.env), nie bugiem patternu —
    // raportujemy jako WARN. FAIL tylko dla bugow strukturalnych w builderze.
    const missingCredCount = validation.missingCredentials.filter((c) => c.required).length;
    if (missingCredCount > 0) {
      validation.missingCredentials
        .filter((c) => c.required)
        .forEach((c) => details.push(`missing-cred (env): ${c.service}`));
    }
	    if (validation.warnings.length > 0) {
	      validation.warnings.slice(0, 3).forEach((w) => details.push(`warn: ${w.nodeName ?? '-'} :: ${w.message}`));
	    }

	    const capabilityContradictions = explicitCapabilityContradictions(pattern, workflow);
	    capabilityContradictions.forEach((item) => details.push(`coverage: ${item}`));

	    const hasStructuralErrors =
	      validation.errors.length > 0 ||
	      validation.securityIssues.length > 0 ||
	      capabilityContradictions.length > 0;
    const hasNonCredWarnings = validation.warnings.length > 0 || missingCredCount > 0;
    const status: Result['status'] = hasStructuralErrors ? 'fail' : hasNonCredWarnings ? 'warn' : 'ok';

    results.push({
      patternId: pattern.id,
      patternName: pattern.name,
      executable: true,
      status,
      reason: hasStructuralErrors
        ? `${validation.errors.length} errors, ${validation.securityIssues.length} security`
        : hasNonCredWarnings
          ? `${validation.warnings.length} warns, ${missingCredCount} env-cred (nodes=${validation.nodeCount})`
          : `clean draft (nodes=${validation.nodeCount}, connections=${validation.connectionCount})`,
      details,
    });
  } catch (err) {
    results.push({
      patternId: pattern.id,
      patternName: pattern.name,
      executable: true,
      status: 'fail',
      reason: `build threw: ${(err as Error).message}`,
      details: [],
    });
  }
}

function explicitCapabilityContradictions(pattern: AutomationPattern, workflow: any): string[] {
  const supported = pattern.capabilities?.supported ?? [];
  if (supported.length === 0) return [];

  const actual = new Set(deriveWorkflowCapabilities(workflow).map((item) => item.capability));
  return supported
    .filter((capability) => mustBeWorkflowObservable(capability))
    .filter((capability) => !actual.has(capability))
    .map((capability) => `declared ${capability}, but workflow evidence did not contain it`);
}

function mustBeWorkflowObservable(capability: string): boolean {
  return capability.startsWith('node.') ||
    capability.startsWith('operation.') ||
    capability.startsWith('sideEffect.') ||
    capability === 'trigger.webhook' ||
    capability === 'trigger.manual' ||
    capability === 'trigger.schedule' ||
    capability === 'service.mongo' ||
    capability === 'service.telegram' ||
    capability === 'service.gmail' ||
    capability === 'service.googleSheets' ||
    capability === 'service.mastraApi' ||
    capability === 'service.ollama';
}

const symbol = (s: Result['status']) => (s === 'ok' ? '✓' : s === 'warn' ? '!' : s === 'skip' ? '-' : '✗');
const color = (s: Result['status']) =>
  s === 'ok' ? '\x1b[32m' : s === 'warn' ? '\x1b[33m' : s === 'fail' ? '\x1b[31m' : '\x1b[90m';
const reset = '\x1b[0m';

console.log(`Pattern smoke tests (${results.length} patterns):\n`);
for (const r of results) {
  console.log(`  ${color(r.status)}${symbol(r.status)}${reset} ${r.patternId.padEnd(50)} ${r.reason}`);
  for (const d of r.details) console.log(`     ${d}`);
}

const failed = results.filter((r) => r.status === 'fail').length;
const warns = results.filter((r) => r.status === 'warn').length;
const skipped = results.filter((r) => r.status === 'skip').length;
const passed = results.filter((r) => r.status === 'ok').length;

console.log(
  `\n${color('ok')}${passed} passed${reset}, ${color('warn')}${warns} warnings${reset}, ${color('fail')}${failed} failed${reset}, ${skipped} skipped (abstract)`,
);

if (failed > 0) process.exit(1);
