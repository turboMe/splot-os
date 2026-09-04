/**
 * Which task a coding tool is operating on — decided by the RUN, not by the model.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every worktree, artifact and ledger tool in this domain takes a `taskId`, and
 * that id decides which worktree gets written and which artifact gets mutated.
 * It is an authority field in the sense §4.2 means: *"Pole autorytetu nigdy nie
 * pochodzi z treści modelu"* — the same rule that made `delegate-task` take the
 * caller's identity from the run after a model could impersonate any agent by
 * typing a different name.
 *
 * Legacy got away with passing it as a tool argument because a workflow step
 * always wrote the id into the prompt first ("## Identyfikator zadania: …") and
 * the model copied it back. V2 does not: `promptFor` is `goal + upstream +
 * headless contract`, with no identifier anywhere, so a coding agent running as a
 * durable job would have to INVENT one. It would then get a worktree and an
 * artifact keyed to a number nothing else knows — work that succeeds and is
 * unreachable, which is worse than work that fails.
 *
 * So the run wins. The model's value is kept only as the fallback for callers
 * that legitimately have no harness context (a direct tool invocation, a test),
 * and a disagreement is logged rather than silently resolved: it means either the
 * model invented an id or a caller is passing the wrong one, and both are worth
 * seeing.
 */
import { getHarnessExecutionContext } from '../../services/harness-execution-context.js';

/** Remembered per (run, supplied) pair so one run logs a disagreement once. */
const reportedTaskScopes = new Set<string>();
const reportedSubtaskScopes = new Set<string>();

/**
 * The V2 thread carries the JOB, and the job is the unit of coding work.
 *
 * A V2 job may be a SEQUENCE — write the patch, then review it — and each step is
 * its own task with its own id. Scoping a worktree to the step id would give the
 * reviewer a different scope than the author, so it would look for the diff under
 * an id no artifact was ever written to and report "no active worktree" on work
 * that exists.
 *
 * Legacy already answers this: `repo-maintenance-workflow` passes ONE `taskId`
 * through diagnose, patch, review and merge, and `delegate-task` uses one id per
 * delegation. The legacy notion of "task" maps onto a V2 JOB, not a V2 task — so
 * that is what the scope follows.
 */
const V2_JOB_THREAD_PREFIX = 'orch-v2-job:';

function jobScopeFromThread(threadId: string | undefined): string | undefined {
  if (!threadId?.startsWith(V2_JOB_THREAD_PREFIX)) return undefined;
  const jobId = threadId.slice(V2_JOB_THREAD_PREFIX.length).trim();
  return jobId.length > 0 ? jobId : undefined;
}

export function resolveCodingTaskId(supplied?: string): string | undefined {
  const ctx = getHarnessExecutionContext();
  // The job when there is one (V2, possibly multi-step); the task otherwise
  // (legacy, where the caller's taskId already IS the unit of work).
  const fromRun = jobScopeFromThread(ctx?.threadId) ?? ctx?.taskId?.trim();
  const fromModel = supplied?.trim();

  if (!fromRun) return fromModel || undefined;
  if (fromModel && fromModel !== fromRun) {
    const key = `${fromRun}::${fromModel}`;
    if (!reportedTaskScopes.has(key)) {
      reportedTaskScopes.add(key);
      console.warn(
        `[coding] task scope taken from the run: ${fromRun} (the call said ${fromModel})`,
      );
    }
  }
  return fromRun;
}

/**
 * Which parallel subtask made a coding change — decided by the run too.
 *
 * `executeSubtask` already gives `subtaskId` to `generateCoding`, and the harness
 * publishes it through `HarnessExecutionContext`. Requiring the model to copy
 * that fact into every tool call made attribution probabilistic: an omitted
 * argument still wrote the file, but `artifact.filesChanged` recorded it as
 * nobody's work. Once the reader filters per subtask, that false negative means
 * `no_files_changed` → retry → expensive-model escalation and possibly the same
 * edit twice.
 *
 * The harness value therefore wins. The explicit argument remains a fallback
 * for legitimate direct tool calls that have no harness context.
 */
export function resolveCodingSubtaskId(supplied?: string): string | undefined {
  const fromRun = getHarnessExecutionContext()?.subtaskId?.trim();
  const fromModel = supplied?.trim();

  if (!fromRun) return fromModel || undefined;
  if (fromModel && fromModel !== fromRun) {
    const key = `${fromRun}::${fromModel}`;
    if (!reportedSubtaskScopes.has(key)) {
      reportedSubtaskScopes.add(key);
      console.warn(
        `[coding] subtask scope taken from the run: ${fromRun} (the call said ${fromModel})`,
      );
    }
  }
  return fromRun;
}

/**
 * The same decision, for the tools whose schema requires the id.
 *
 * Throwing beats returning an empty string: an empty task id reaches Mongo as a
 * lookup that matches nothing, and "no artifact for ''" is a far worse error
 * message than the truth.
 */
export function requireCodingTaskId(supplied?: string): string {
  const resolved = resolveCodingTaskId(supplied);
  if (!resolved) {
    throw new Error(
      'No task id: neither the caller nor the run supplied one. '
      + 'A coding tool must know which task it is operating on.',
    );
  }
  return resolved;
}

/**
 * The scope for an operation on work that ALREADY EXISTS.
 *
 * `resolveCodingTaskId` lets the run win, and for CREATION that is right: an id
 * the model invented would key a worktree and an artifact to a number nothing
 * else knows, producing work that succeeds and is unreachable.
 *
 * For an operation on existing work the same rule is wrong, and the merge canary
 * proved it. A human approves a merge, then says "now merge it" — a SECOND job.
 * The model correctly named the first job's id, the run overrode it with the new
 * one, and `coding_apply_patch` reported "no active worktree" for a worktree that
 * was right there. The guard against orphaning had become a guard against
 * continuing.
 *
 * So an explicit id wins HERE, and the safety argument moves to where it belongs:
 * these tools all fail loudly on an id with no artifact behind it, and the one
 * that changes the world (`coding_apply_patch`) additionally requires a permit a
 * human approved FOR THAT id.
 */
export function resolveExistingCodingTaskId(supplied?: string): string | undefined {
  const fromModel = supplied?.trim();
  if (fromModel) return fromModel;
  return resolveCodingTaskId();
}

/** The same, for tools whose schema requires the id. */
export function requireExistingCodingTaskId(supplied?: string): string {
  const resolved = resolveExistingCodingTaskId(supplied);
  if (!resolved) {
    throw new Error(
      'No task id: neither the caller nor the run supplied one. '
      + 'A coding tool must know which task it is operating on.',
    );
  }
  return resolved;
}

/**
 * A sentence for the MODEL when the run overruled the id it named — empty when
 * they agree.
 *
 * The override was previously announced only on the server's stdout. Measured on
 * the merge canary: an agent was told to write into an earlier job's worktree,
 * the run correctly redirected the write into its own, the tool answered
 * "success", and the agent went on to request a human approval describing a
 * branch its file was not on. Nothing failed. The agent simply had a false
 * picture of the world and reported it confidently — which is the expensive kind
 * of wrong, because the human reading the approval has no way to see it either.
 *
 * A refusal would be worse: the write is legitimate and the run's scope is the
 * right place for it. What was missing is only that the actor be told.
 */
export function scopeOverrideNote(supplied: string | undefined, resolved: string): string {
  const named = supplied?.trim();
  if (!named || named === resolved) return '';
  return ` NOTE: you named task ${named}, but this run owns task ${resolved} and the work went`
    + ` there. To act on ${named}'s existing worktree use a tool that operates on existing work`
    + ' (coding_apply_patch, coding_worktree_diff, coding_read_worktree_file).';
}

/** Field the normalizer uses to carry the note from input-time to output-time. */
export const SCOPE_NOTE_FIELD = 'codingScopeNote';

/**
 * `normalizeInput` for a tool that CREATES work: resolve the scope from the run,
 * and remember whether that contradicted the caller.
 */
export function normalizeCodingScope<T extends { taskId?: string; subtaskId?: string }>(input: T): T {
  const resolved = requireCodingTaskId(input.taskId);
  const note = scopeOverrideNote(input.taskId, resolved);
  return {
    ...input,
    taskId: resolved,
    subtaskId: resolveCodingSubtaskId(input.subtaskId),
    ...(note ? { [SCOPE_NOTE_FIELD]: note } : {}),
  };
}

/** `modelOutput` counterpart: put the note where the model will actually read it. */
export function appendScopeNote<O extends { message?: string }>(output: O, input: unknown): O {
  const note = (input as Record<string, unknown> | undefined)?.[SCOPE_NOTE_FIELD];
  if (typeof note !== 'string' || note.length === 0) return output;
  return { ...output, message: `${output.message ?? ''}${note}`.trim() };
}
