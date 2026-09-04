/**
 * Auth gate for dashboard actions that change state (Z35).
 *
 * `POST /dashboard/approvals/:id/approve` had no authorization at all — any
 * request that could reach the port could flip a pending approval to
 * `approved`, and an approved permit is what lets `capability_attach` add a
 * new MCP server, `coding_apply_patch` merge into the live repo, or a paid
 * tool like `film_generate` actually run. `securityReviewAgent` flagged this
 * live (BLOCK verdict, 2026-08-17) reviewing a different file the same day;
 * this was the third finding in that review and was left unfixed pending a
 * threat-model decision (`docs/MIGRACJA-DOMENY-CODING.md` §Z35).
 *
 * Deliberately opt-in, matching every other security-relevant flag in this
 * project (`AUTOHEAL_AUTO_PROMOTE`, `DEPLOY_AUTO_SWAP`, …): the dashboard is
 * local-only today, and forcing auth on by default would lock the operator
 * out of their own tool the moment this ships, with no announced way back in.
 * Setting `DASHBOARD_APPROVAL_TOKEN` in `.env` is the owner's decision to make
 * when the dashboard's exposure changes — this only makes that decision
 * actually enforceable once made, rather than inventing a new default.
 */

import { timingSafeEqual } from 'node:crypto';

export type DashboardAuthResult =
  | { ok: true }
  | { ok: false; status: 401; message: string };

/** True once the owner has opted in by setting a token. Unset = today's open behaviour. */
export function isDashboardApprovalAuthEnabled(): boolean {
  return Boolean(process.env.DASHBOARD_APPROVAL_TOKEN?.trim());
}

/**
 * Constant-time so a shared secret can't be recovered by timing a byte-by-byte
 * mismatch — the standard failure mode for `===` on a bearer token compare.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * `authorizationHeader` is the raw `Authorization` header value, expected as
 * `Bearer <token>`. Returns `{ ok: true }` both when auth is satisfied AND
 * when it is not yet configured — the caller does not need to branch on
 * `isDashboardApprovalAuthEnabled()` separately.
 */
export function checkDashboardApprovalAuth(authorizationHeader: string | undefined | null): DashboardAuthResult {
  const configuredToken = process.env.DASHBOARD_APPROVAL_TOKEN?.trim();
  if (!configuredToken) return { ok: true };

  const header = (authorizationHeader ?? '').trim();
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) {
    return { ok: false, status: 401, message: 'missing or malformed Authorization header (expected "Bearer <token>")' };
  }
  const presented = header.slice(prefix.length).trim();
  if (!presented || !safeEqual(presented, configuredToken)) {
    return { ok: false, status: 401, message: 'invalid approval token' };
  }
  return { ok: true };
}
