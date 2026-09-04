/**
 * A human approval that can be spent exactly once.
 *
 * Extracted from `capability-build.ts`, where it was written for the promote
 * gate, because a second consumer now needs the identical guarantee: merging an
 * agent's worktree into the repository this system runs from. Two copies of a
 * permit rule is how one of them ends up merely *inspecting* the token instead of
 * spending it, and an inspected token is a standing grant nobody agreed to.
 *
 * The whole property lives in one `findOneAndUpdate`: claiming and consuming are
 * the same write, so the permit cannot be observed as available and then used
 * twice — not by a retry, not by a second run, not by an agent that kept a token
 * from an earlier turn.
 *
 * `already_used` is a distinct outcome from `pending` on purpose. The operator
 * needs to know a permit was SPENT, not that one is awaited; the two look
 * identical from the outside and mean opposite things.
 */
import { getDb } from '../lib/mongo.js';

export type PermitOutcome =
  | 'approved' | 'pending' | 'rejected' | 'missing' | 'already_used'
  | 'wrong_task' | 'wrong_tool';

export type ConsumePermitInput = {
  /** The approvals-collection id the human approved. */
  token: string;
  /** Who is spending it — recorded so a spent permit names its consumer. */
  consumerId: string;
  /** What it was spent ON (a commit, a branch, a workflow id). */
  subject: string;
  /**
   * Field prefix, so different consumers do not fight over one stamp. The
   * capability build path has stamped `promoteConsumedBy` since it shipped, and
   * changing that would silently re-open every permit it already spent.
   */
  stampPrefix?: string;
  /**
   * Name of the field recording WHAT the permit was spent on.
   *
   * Explicit rather than derived, because the stamp is durable data: the build
   * path has written `promoteConsumedCommit` since it shipped, and deriving a
   * new name from the prefix silently orphans every permit already stamped.
   * `check:capability-build-lease` asserts the field by name and caught exactly
   * that when this helper was first extracted.
   */
  subjectField?: string;
  /**
   * The task this permit is being spent FOR, checked against the task the human
   * saw when they approved it.
   *
   * Needed once merging began honouring an explicitly supplied task id. Without
   * it, a permit approved for "merge the worktree of task A" would spend equally
   * well on task B's branch: the human's answer would be reused for a question
   * they were never asked. An approval that records no task is left unbound —
   * the capability build path has always worked that way, and inventing a
   * binding for it would reject permits that are perfectly valid.
   */
  forTaskId?: string;
  /**
   * The tool this permit is being spent BY, checked against the tool the human
   * approved.
   *
   * Found by `securityReviewAgent` reviewing this file (E9 canary, 2026-08-17):
   * the CAS filter bound a token to `id` + `status` + "not yet stamped", and
   * nothing else. So an approval a human granted for a low-risk action — say a
   * mail draft — would spend just as well on `coding_apply_patch` and a merge
   * into the live repository. The human answered a different question than the
   * one the token ended up authorising.
   *
   * An approval that records no tool is left unbound, for the same reason the
   * task binding is: rejecting those would break permits that are perfectly
   * valid.
   */
  forTool?: string;
};

/** The task a human was actually looking at when they approved, if any. */
function approvalTaskId(approval: Record<string, unknown>): string | undefined {
  const direct = approval.taskId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const args = approval.args as Record<string, unknown> | undefined;
  const inArgs = args?.taskId;
  return typeof inArgs === 'string' && inArgs.length > 0 ? inArgs : undefined;
}

export async function consumeOneTimePermit(input: ConsumePermitInput): Promise<PermitOutcome> {
  const prefix = input.stampPrefix ?? 'promote';
  const consumedBy = `${prefix}ConsumedBy`;
  const subjectField = input.subjectField ?? `${prefix}ConsumedSubject`;
  const db = await getDb();
  const approvals = db.collection('approvals');

  // Binding is checked before the claim, and that is safe: which task an
  // approval names is written once at creation and never changes, so there is
  // nothing here for a concurrent writer to race. Single-spend still lives
  // entirely in the CAS below.
  if (input.forTaskId || input.forTool) {
    const existing = await approvals.findOne({ id: input.token });
    if (input.forTaskId) {
      const boundTo = existing ? approvalTaskId(existing) : undefined;
      if (boundTo && boundTo !== input.forTaskId) return 'wrong_task';
    }
    if (input.forTool) {
      const approvedTool = typeof existing?.tool === 'string' ? existing.tool : undefined;
      if (approvedTool && approvedTool !== input.forTool) return 'wrong_tool';
    }
  }

  // ONE spend, across ALL consumers.
  //
  // The stamp is per `stampPrefix`, so `promote` writes `promoteConsumedBy` and
  // the merge gate writes `liveMergeConsumedBy` — and the same token could be
  // burned once by each. "Exactly once" held per consumer, not globally, which
  // is not what a human granting one approval believes they are granting. Also
  // found by `securityReviewAgent` reviewing this file.
  //
  // The prefixed stamps stay exactly as they were (they are durable data, and
  // `check:capability-build-lease` asserts them by name); `permitConsumedBy` is
  // added alongside as the shared marker the filter tests.
  const consumed = await approvals.findOneAndUpdate(
    {
      id: input.token,
      status: 'approved',
      [consumedBy]: { $exists: false },
      permitConsumedBy: { $exists: false },
    },
    {
      $set: {
        [consumedBy]: input.consumerId,
        [`${prefix}ConsumedAt`]: new Date(),
        [subjectField]: input.subject,
        permitConsumedBy: input.consumerId,
        permitConsumedAt: new Date(),
        permitConsumedByTool: input.forTool ?? null,
      },
    },
    { returnDocument: 'after' },
  );
  if (consumed) return 'approved';

  // The CAS failed. Read once more to say WHY — "nobody approved this" and
  // "somebody already spent it" need different answers from the operator.
  const approval = await approvals.findOne({ id: input.token });
  if (!approval) return 'missing';
  if (approval[consumedBy] || approval.permitConsumedBy) return 'already_used';
  const status = String(approval.status ?? '');
  if (status === 'rejected' || status === 'denied') return 'rejected';
  return 'pending';
}

/** One sentence an agent or an operator can act on, per outcome. */
export function describePermitOutcome(outcome: PermitOutcome, token: string): string {
  switch (outcome) {
    case 'approved': return `approval ${token} accepted and spent`;
    case 'already_used': return `approval ${token} was already spent — a NEW human approval is required`;
    case 'rejected': return `approval ${token} was rejected by a human`;
    case 'missing': return `approval ${token} does not exist`;
    case 'pending': return `approval ${token} is still awaiting a human`;
    case 'wrong_task': return `approval ${token} was granted for a DIFFERENT task — `
      + 'a human approved one piece of work, and this is another one. Request a new approval.';
    case 'wrong_tool': return `approval ${token} was granted for a DIFFERENT action — `
      + 'the human approved one tool and this is another. Request a new approval.';
  }
}
