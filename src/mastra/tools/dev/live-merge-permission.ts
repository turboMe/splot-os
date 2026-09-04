/**
 * May this run merge a worktree into the repository the system runs from?
 *
 * WHAT WAS ACTUALLY TRUE BEFORE THIS FILE
 * ---------------------------------------
 * `coding_apply_patch` describes itself as *"Requires approval"* and had no
 * approval check of any kind: it ran `git add && git commit && git merge` into
 * `AGENTIC_AGENTS_REPO` the moment a model called it. The only gate anywhere near
 * it was the harness policy's `apply_patch_requires_approval`, which
 * `HARNESS_POLICY_MODE=log_only` (the configured default, and the value in `.env`)
 * turns into a log line.
 *
 * The flags the owner reaches for — `AUTOHEAL_AUTO_PROMOTE`, `DEPLOY_AUTO_SWAP` —
 * gate `mergeWorktreeToLive()` inside `repo-maintenance-workflow`, a DIFFERENT
 * path. So the workflow asked permission and the tool did not, and the tool is
 * the one an agent can call on its own.
 *
 * WHAT THIS CHANGES, AND WHAT IT DOES NOT
 * ---------------------------------------
 * It grants exactly the permissions legacy already grants, and makes the tool
 * enforce them instead of describing them:
 *
 *   1. an AUTOHEAL task (`heal-*`) with `AUTOHEAL_AUTO_PROMOTE=true` — the
 *      self-healing lane, where the supervisor owns promotion and a human gate
 *      would stop the loop it exists to run unattended;
 *   2. any task carrying an `approvalToken` a human approved — the same one-time
 *      permit the capability BUILD path spends before it promotes, so an agent
 *      writing itself a new tool merges through a permit rather than a flag.
 *
 * Anything else is refused, and refused the way `coding_run_test` and `bg_task`
 * refuse: a returned message the model can read and act on. Never a suspension —
 * a background run has nobody to answer it, which is the defect this domain has
 * already paid for once (the merge that never landed because `execute_command`
 * suspended waiting for a human).
 */
import { isAutohealTask } from '../../services/autoheal-repair-lane.js';
import { consumeOneTimePermit, describePermitOutcome } from '../../services/one-time-permit.js';

export type MergePermission =
  | { allowed: true; via: 'autoheal_auto_promote' | 'approval_token'; note: string }
  | { allowed: false; reason: string };

export function autohealAutoPromoteEnabled(): boolean {
  return process.env.AUTOHEAL_AUTO_PROMOTE === 'true';
}

export async function resolveLiveMergePermission(input: {
  taskId: string;
  approvalToken?: string;
  branchName: string;
  /**
   * The task THIS run owns, when it owns one.
   *
   * Needed because merging began honouring an explicitly named task, to support
   * the human-gated shape (build and ask → approve → merge in a later job). That
   * is safe for the token grant, which is bound to what a human approved — but
   * the autoheal grant is bound to nothing but a `heal-` prefix. Without this, a
   * run inside `heal-A` could name `heal-B` and, under AUTOHEAL_AUTO_PROMOTE,
   * merge a branch no supervisor asked it to touch. The flag grants a lane the
   * right to promote ITS OWN work, and that is what this enforces.
   */
  runTaskId?: string;
}): Promise<MergePermission> {
  const autohealOwnsIt = input.runTaskId === undefined || input.runTaskId === input.taskId;
  if (isAutohealTask(input.taskId) && autohealAutoPromoteEnabled() && autohealOwnsIt) {
    return {
      allowed: true,
      via: 'autoheal_auto_promote',
      note: `autoheal task under AUTOHEAL_AUTO_PROMOTE — the supervisor owns promotion`,
    };
  }

  if (input.approvalToken) {
    // Spent, not inspected. A token that survives its use is a standing grant.
    const outcome = await consumeOneTimePermit({
      token: input.approvalToken,
      consumerId: input.taskId,
      subject: input.branchName,
      stampPrefix: 'liveMerge',
      // The permit is for the work the human looked at, not for whichever branch
      // a later run names.
      forTaskId: input.taskId,
      // And for THIS tool: an approval granted for something else must not
      // authorise a merge into the live repository.
      forTool: 'coding_apply_patch',
    });
    if (outcome === 'approved') {
      return {
        allowed: true,
        via: 'approval_token',
        note: `approval ${input.approvalToken} spent on ${input.branchName}`,
      };
    }
    return { allowed: false, reason: describePermitOutcome(outcome, input.approvalToken) };
  }

  if (isAutohealTask(input.taskId) && autohealAutoPromoteEnabled() && !autohealOwnsIt) {
    return {
      allowed: false,
      reason:
        `AUTOHEAL_AUTO_PROMOTE lets a repair lane promote its OWN work, and this run owns `
        + `${input.runTaskId}, not ${input.taskId}. Merging another lane's branch needs an `
        + 'approvalToken a human granted for that task.',
    };
  }

  return {
    allowed: false,
    reason:
      'Merging into the live repository needs either an autoheal task with '
      + 'AUTOHEAL_AUTO_PROMOTE=true, or an `approvalToken` a human approved '
      + '(system_request_approval → /dashboard/approvals). '
      + 'The work is NOT lost: it stays on the task branch, and the diff is '
      + 'readable with coding_worktree_diff.',
  };
}
