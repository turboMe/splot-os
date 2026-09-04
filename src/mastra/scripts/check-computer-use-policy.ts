#!/usr/bin/env tsx
/**
 * check:computer-use-policy — verifies harness policy contracts for browser
 * and computer-use actions.
 *
 * Every distinct decision branch is checked once, in `enforce` mode (the
 * operationally meaningful one). A small representative subset is ALSO
 * checked in `log_only` mode to prove the one property that must hold across
 * modes: `severity`, `requiresApproval` and `allow` are IDENTICAL in both —
 * only `effectiveAllow` differs. A previous defect class in this codebase let
 * `log_only` silently report a different verdict than `enforce` would have
 * made, which is indistinguishable from "the policy doesn't actually check
 * this." Kept small deliberately: each case is a real Mongo telemetry write
 * (`evaluateAndLogHarnessPolicy` → `logHarnessEvent`), and this script runs
 * inside `check:all`.
 */
import assert from 'node:assert/strict';
import { evaluateAndLogHarnessPolicy, HarnessPolicyAction, HarnessPolicyMode } from '../services/harness-policy.js';
import { registerRunStartedPort } from '../config/browser-surfaces.js';

console.log('check:computer-use-policy');

interface TestCase {
  action: HarnessPolicyAction;
  target?: string;
  command?: string;
  runId?: string;
  expectedAllow: boolean;
  expectedRequiresApproval: boolean;
  expectedApprovalTypePrefix?: string;
  expectedSeverity: 'info' | 'warning' | 'block';
}

registerRunStartedPort('run-started-5173', 5173);

// One case per distinct decision branch. `allow` reflects `allowDecision`
// (true) vs `requireApprovalDecision`/`blockDecision` (both false) — mode
// only changes `effectiveAllow`, never `allow` itself.
const allBranches: TestCase[] = [
  // Forward-looking CU-3(b) scaffolding — no caller invokes these yet.
  { action: 'computer_use:input', expectedAllow: false, expectedRequiresApproval: true, expectedApprovalTypePrefix: 'computer_use_input', expectedSeverity: 'block' },
  { action: 'computer_use:screen', expectedAllow: true, expectedRequiresApproval: false, expectedSeverity: 'info' },
  { action: 'computer_use:clipboard', expectedAllow: false, expectedRequiresApproval: true, expectedApprovalTypePrefix: 'computer_use_clipboard', expectedSeverity: 'warning' },
  { action: 'browser:session_auth', expectedAllow: false, expectedRequiresApproval: true, expectedApprovalTypePrefix: 'browser_session_auth', expectedSeverity: 'block' },
  { action: 'browser:evaluate', expectedAllow: false, expectedRequiresApproval: true, expectedApprovalTypePrefix: 'browser_evaluate', expectedSeverity: 'warning' },

  // browser:navigate — always allowed; classification is telemetry only.
  { action: 'browser:navigate', target: 'http://localhost:5173/', runId: 'run-started-5173', expectedAllow: true, expectedRequiresApproval: false, expectedSeverity: 'info' },

  // browser:interact — target-scoped, the actual fix. One case per class.
  { action: 'browser:interact', target: 'http://localhost:5173/', runId: 'run-started-5173', expectedAllow: true, expectedRequiresApproval: false, expectedSeverity: 'info' },
  { action: 'browser:interact', target: 'http://localhost:5173/', runId: 'run-that-never-started-5173', expectedAllow: false, expectedRequiresApproval: true, expectedApprovalTypePrefix: 'browser_interact_external', expectedSeverity: 'warning' },
  { action: 'browser:interact', target: 'http://localhost:4111/agents', runId: 'run-started-5173', expectedAllow: false, expectedRequiresApproval: true, expectedApprovalTypePrefix: 'browser_interact_live_surface', expectedSeverity: 'warning' },
  { action: 'browser:interact', target: 'http://169.254.169.254/', runId: 'run-started-5173', expectedAllow: false, expectedRequiresApproval: false, expectedSeverity: 'block' },
  // Tier-1 element blocks EVEN inside the agent's own started sandbox.
  { action: 'browser:interact', target: 'http://localhost:5173/login', command: 'type into input[type=password]', runId: 'run-started-5173', expectedAllow: false, expectedRequiresApproval: false, expectedSeverity: 'block' },
];

// Representative subset checked in BOTH modes: one allow, one
// requires-approval, one hard block — enough to prove effectiveAllow is the
// only thing that moves between modes.
const crossModeSubset: TestCase[] = [
  allBranches.find((c) => c.action === 'browser:navigate')!,
  allBranches.find((c) => c.action === 'browser:evaluate')!,
  allBranches.find((c) => c.command)!, // tier-1 block
];

async function checkOne(mode: HarnessPolicyMode, tc: TestCase): Promise<void> {
  const decision = await evaluateAndLogHarnessPolicy({
    agentId: 'coding-agent',
    action: tc.action,
    target: tc.target,
    command: tc.command,
    runId: tc.runId,
  });

  const label = `${tc.action}${tc.target ? ` (${tc.target})` : ''}`;
  assert.equal(decision.allow, tc.expectedAllow, `[${mode}] ${label}: allow`);
  assert.equal(decision.requiresApproval, tc.expectedRequiresApproval, `[${mode}] ${label}: requiresApproval`);
  assert.equal(decision.severity, tc.expectedSeverity, `[${mode}] ${label}: severity`);
  if (tc.expectedApprovalTypePrefix) {
    assert.ok(
      decision.approvalType?.startsWith(tc.expectedApprovalTypePrefix),
      `[${mode}] ${label}: approvalType "${decision.approvalType}" should start with "${tc.expectedApprovalTypePrefix}"`,
    );
  }
  const expectedEffectiveAllow = mode === 'enforce' ? tc.expectedAllow : true;
  assert.equal(decision.effectiveAllow, expectedEffectiveAllow, `[${mode}] ${label}: effectiveAllow`);
  console.log(`  ✓ [${mode}] ${label} → allow=${decision.allow} requiresApproval=${decision.requiresApproval} severity=${decision.severity} effectiveAllow=${decision.effectiveAllow}`);
}

async function main(): Promise<void> {
  process.env.HARNESS_POLICY_MODE = 'enforce';
  await Promise.all(allBranches.map((tc) => checkOne('enforce', tc)));

  process.env.HARNESS_POLICY_MODE = 'log_only';
  await Promise.all(crossModeSubset.map((tc) => checkOne('log_only', tc)));

  console.log(`\n✅ check:computer-use-policy — ${allBranches.length} branches verified in enforce, ${crossModeSubset.length} cross-checked against log_only`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
