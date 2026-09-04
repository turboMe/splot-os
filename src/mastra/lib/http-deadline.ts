/**
 * Per-request HTTP deadlines (ideas/liveness-budget-plan.md L3).
 *
 * A `fetch` without a signal can hang forever on a stalled TCP connection. That
 * is bad on its own, but it is fatal under liveness budgeting: a hung request
 * emits no steps and no tool results, so the run looks idle to the watchdog
 * while the underlying socket is never released. Worse, a polling loop shaped
 * like `while (Date.now() < deadline)` never re-checks its own deadline — the
 * documented 600s poll budget silently becomes infinite (audit K11).
 *
 * `fetchWithDeadline` guarantees every request carries a bound, and composes it
 * with any caller-supplied signal so cancellation still propagates downward.
 */

/** Requests should be far shorter than any run budget; this is a backstop. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface FetchWithDeadlineOptions extends RequestInit {
  /** Hard bound for this single request. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * `fetch` that can never hang indefinitely.
 *
 * The per-request timeout is combined with `init.signal` (when present) rather
 * than replacing it, so an external abort — a cancelled run, a parent deadline —
 * still cancels the request, and the timeout only adds an upper bound.
 */
export async function fetchWithDeadline(
  url: string,
  options: FetchWithDeadlineOptions = {},
): Promise<Response> {
  const { timeoutMs, signal, ...init } = options;
  const effectiveTimeoutMs = timeoutMs && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
  return fetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
}

/**
 * Remaining time until `deadlineTs`, clamped so a caller never passes a
 * non-positive timeout into `fetchWithDeadline` (which would be treated as
 * "use the default" and silently outlive the deadline).
 *
 * Returns `undefined` once the deadline has passed, so the caller can stop
 * rather than issue a request it has no budget for.
 */
export function remainingRequestBudgetMs(
  deadlineTs: number,
  now: number = Date.now(),
): number | undefined {
  const remaining = deadlineTs - now;
  return remaining > 0 ? remaining : undefined;
}
