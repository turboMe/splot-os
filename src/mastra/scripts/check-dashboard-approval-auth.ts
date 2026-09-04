#!/usr/bin/env tsx
/**
 * check:dashboard-approval-auth — Z35: POST /dashboard/approvals/:id/approve
 * had no authorization at all.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * Any request that could reach the port could flip a pending approval to
 * `approved` — no token, no session, no check of any kind. An approved
 * permit is what lets `capability_attach` add a new MCP server,
 * `coding_apply_patch` merge into the live repo, or a paid tool like
 * `film_generate` actually run. `securityReviewAgent` flagged this live
 * (BLOCK verdict, 2026-08-17) as the third finding in a review of a different
 * file that same day, and it was left unfixed pending an owner decision on
 * the dashboard's threat model (`docs/MIGRACJA-DOMENY-CODING.md` §Z35).
 *
 * WHAT THE FIX IS: `checkDashboardApprovalAuth` (lib/dashboard-auth.ts),
 * wired into the route in index.ts. Deliberately opt-in — matching every
 * other security-relevant flag in this project — so shipping this does not
 * silently lock the operator out of their own local dashboard the moment it
 * lands. Setting `DASHBOARD_APPROVAL_TOKEN` is the owner's decision to make;
 * this only makes that decision enforceable once made.
 *
 * Run: npx tsx src/mastra/scripts/check-dashboard-approval-auth.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkDashboardApprovalAuth,
  isDashboardApprovalAuthEnabled,
} from '../lib/dashboard-auth.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

/** Run `fn` with DASHBOARD_APPROVAL_TOKEN set to `value` (or deleted), then restore it exactly. */
function withToken<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.DASHBOARD_APPROVAL_TOKEN;
  if (value === undefined) delete process.env.DASHBOARD_APPROVAL_TOKEN;
  else process.env.DASHBOARD_APPROVAL_TOKEN = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.DASHBOARD_APPROVAL_TOKEN;
    else process.env.DASHBOARD_APPROVAL_TOKEN = original;
  }
}

console.log('check:dashboard-approval-auth');

// ── 1. Unconfigured = today's exact behaviour (open), not a new lockout ────

check('no token configured -> isDashboardApprovalAuthEnabled() is false', () => {
  withToken(undefined, () => {
    assert.equal(isDashboardApprovalAuthEnabled(), false);
  });
});

check('no token configured -> any request is allowed, even with no header at all', () => {
  withToken(undefined, () => {
    assert.deepEqual(checkDashboardApprovalAuth(undefined), { ok: true });
    assert.deepEqual(checkDashboardApprovalAuth('garbage'), { ok: true });
  });
});

check('a blank/whitespace token is treated as unconfigured, not as an empty secret', () => {
  withToken('   ', () => {
    assert.equal(isDashboardApprovalAuthEnabled(), false);
    assert.deepEqual(checkDashboardApprovalAuth(undefined), { ok: true });
  });
});

// ── 2. Once configured, this is a REAL gate, not decoration ────────────────

check('token configured -> isDashboardApprovalAuthEnabled() is true', () => {
  withToken('s3cr3t-token', () => {
    assert.equal(isDashboardApprovalAuthEnabled(), true);
  });
});

check('token configured -> missing Authorization header is rejected (401)', () => {
  withToken('s3cr3t-token', () => {
    const result = checkDashboardApprovalAuth(undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 401);
  });
});

check('token configured -> a header without the Bearer prefix is rejected', () => {
  withToken('s3cr3t-token', () => {
    const result = checkDashboardApprovalAuth('s3cr3t-token');
    assert.equal(result.ok, false);
  });
});

check('token configured -> the WRONG bearer token is rejected', () => {
  withToken('s3cr3t-token', () => {
    const result = checkDashboardApprovalAuth('Bearer wrong-token');
    assert.equal(result.ok, false);
  });
});

check('token configured -> a token that is a PREFIX of the real one is still rejected', () => {
  // Guards against a naive `startsWith`-style compare instead of full equality.
  withToken('s3cr3t-token', () => {
    const result = checkDashboardApprovalAuth('Bearer s3cr3t');
    assert.equal(result.ok, false);
  });
});

check('token configured -> the CORRECT bearer token is accepted', () => {
  withToken('s3cr3t-token', () => {
    assert.deepEqual(checkDashboardApprovalAuth('Bearer s3cr3t-token'), { ok: true });
  });
});

check('token configured -> outer whitespace around the presented token is tolerated (HTTP header framing, not part of the secret)', () => {
  withToken('s3cr3t-token', () => {
    assert.deepEqual(checkDashboardApprovalAuth('Bearer s3cr3t-token  '), { ok: true });
    assert.deepEqual(checkDashboardApprovalAuth('Bearer   s3cr3t-token'), { ok: true });
  });
});

check('token configured -> a single differing character ANYWHERE in the token is rejected, not just at the edges', () => {
  withToken('s3cr3t-token', () => {
    const result = checkDashboardApprovalAuth('Bearer s3cr3t-tokeX');
    assert.equal(result.ok, false);
  });
});

// ── 3. FALSIFY: prove the pre-fix world really would have let this through ─

check('FALSIFIED: an unauthenticated route handler would have accepted this call unconditionally', () => {
  // What the route did before the fix: nothing gated it at all — the
  // Mongo update ran on any request. There is no old function left to call
  // here (the whole point is that none existed), so the falsification is
  // structural: prove the check function is what the route now imports.
  const src = readFileSync('src/mastra/index.ts', 'utf8');
  assert.match(src, /checkDashboardApprovalAuth/,
    'the approve route must actually import and call the auth check, not just have it exist unused nearby');
  const routeIdx = src.indexOf("registerApiRoute('/dashboard/approvals/:id/approve'");
  const authIdx = src.indexOf('checkDashboardApprovalAuth', routeIdx);
  assert.ok(routeIdx !== -1 && authIdx !== -1 && authIdx > routeIdx && authIdx - routeIdx < 400,
    'the auth check must run inside THIS route\'s handler, close to its start — not merely imported somewhere in the file');
});

console.log(failures === 0 ? '\n✅ check:dashboard-approval-auth — all assertions passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
