/**
 * Execution Gateway — bounded model call (plan §12, §10, §11).
 *
 * This is where a worker turns an attempt into real model work under the
 * ExecutionBudget contract (PR-1). The gateway derives an AbortSignal from the
 * operation's business cutoff (and forwards a parent budget signal), calls an INJECTED
 * `ModelCaller`, and maps the outcome onto a producer envelope:
 *  - a deadline hit → `timed_out` (cooperative cancel, dogfooding GAP-MODEL-ABORT-01)
 *  - a parent abort → `cancelled`
 *  - a provider error → `failed`
 *  - success → the model's text, which the A boundary validates (structured
 *    envelope → ok/partial; prose/malformed → invalid_result, never a false ok).
 *
 * The `ModelCaller` is injected so tests are deterministic and a live variant
 * (Ollama via the exact AI-SDK path the spike validated) plugs in unchanged.
 */
import type { WorkerContext, WorkerFixture } from '../store/worker.js';
import type {
  AttemptProgressDecision,
  AttemptProgressMilestone,
} from '../contracts/execution-budget.js';
import type { ProducerArtifactRef } from '../contracts/result-envelope.js';

export type ModelProgressMilestone = AttemptProgressMilestone;
export type ProgressReportResult = AttemptProgressDecision;

export interface ModelCallArgs {
  prompt: string;
  /** The clean user/task intent, without operational wrappers such as headless output rules. */
  classificationPrompt?: string;
  signal: AbortSignal;
  /** Available only when this call has an earned-time policy. */
  reportProgress?: (milestone: ModelProgressMilestone) => Promise<ProgressReportResult>;
}
/**
 * `fromArtifact` marks text the run STORED as a document, as opposed to text it
 * merely said. The distinction is not cosmetic: for a capability whose declared
 * deliverable is a ref (a Menu Book, a rendered file), prose is never the
 * product, so the boundary needs to tell the two apart without judging meaning.
 */
export type ModelCaller = (args: ModelCallArgs) => Promise<{
  text: string;
  fromArtifact?: boolean;
  /**
   * What this run STORED, as references the next step can fetch in full.
   *
   * Without this the successor's prompt gets a 2 000-char preview and nothing
   * else — a design step handed the next agent an excerpt of an 18 KB document
   * with no way to reach the rest, while the prompt builder was already offering
   * "pełna treść pod tymi id" for an array nobody ever filled.
   */
  artifacts?: ProducerArtifactRef[];
}>;

/** Bounded time for an already-started Mongo progress CAS to return its result. */
const PROGRESS_REPORT_RESPONSE_GRACE_MS = 1_000;

export interface BoundedCallResult {
  ok: boolean;
  text?: string;
  /** The text came from an artifact this run stored — see `ModelCaller`. */
  fromArtifact?: boolean;
  /** References to what the run stored, for the next step — see `ModelCaller`. */
  artifacts?: ProducerArtifactRef[];
  reason?: 'deadline' | 'aborted' | 'error';
  durationMs: number;
  error?: string;
  progressExtensions?: number;
}

/**
 * Run a model call bounded by an absolute operation deadline. The composed signal
 * aborts at the deadline or when the parent budget aborts; the caller must honor
 * it (validated feasible by GAP-MODEL-ABORT-01).
 */
export async function runBoundedModelCall(params: {
  deadlineAt: number;
  /** Current A-commit deadline; progress-report grace may never cross it. */
  workDeadlineAt?: number;
  callModel: ModelCaller;
  prompt: string;
  classificationPrompt?: string;
  parentSignal?: AbortSignal;
  /** Store-authoritative reporter; only its returned cutoff may re-arm the timer. */
  reportProgress?: (
    milestone: ModelProgressMilestone,
  ) => Promise<ProgressReportResult>;
}): Promise<BoundedCallResult> {
  const ac = new AbortController();
  const start = Date.now();
  let timedOut = false;
  let closed = false;
  let earnedDeadlineAt = params.deadlineAt;
  let earnedWorkDeadlineAt = params.workDeadlineAt ?? params.deadlineAt;
  let progressExtensions = 0;
  let progressReportsInFlight = 0;
  const activeDeadlineAt = (): number => earnedDeadlineAt;
  const timerDeadlineAt = (): number => (
    progressReportsInFlight > 0
      ? Math.min(
          earnedWorkDeadlineAt,
          activeDeadlineAt() + PROGRESS_REPORT_RESPONSE_GRACE_MS,
        )
      : activeDeadlineAt()
  );
  const remaining = Math.max(0, activeDeadlineAt() - start);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (): void => {
    if (timer) clearTimeout(timer);
    const waitMs = Math.max(0, timerDeadlineAt() - Date.now());
    timer = setTimeout(() => {
      // A progress report may have re-armed the logical deadline while an older
      // timer callback was already queued. Re-check before aborting.
      if (Date.now() < timerDeadlineAt()) {
        armDeadline();
        return;
      }
      timedOut = true;
      ac.abort(new Error('deadline'));
    }, waitMs);
  };
  armDeadline();
  const onParentAbort = () => ac.abort(new Error('parent_abort'));
  if (params.parentSignal) {
    if (params.parentSignal.aborted) ac.abort(new Error('parent_abort'));
    else params.parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  // Fail-before-work (§11.1): if already aborted (parent pre-abort) or the
  // deadline is already past, never invoke the provider.
  if (ac.signal.aborted || remaining === 0) {
    if (timer) clearTimeout(timer);
    params.parentSignal?.removeEventListener('abort', onParentAbort);
    return { ok: false, reason: remaining === 0 ? 'deadline' : 'aborted', durationMs: 0 };
  }

  // `ac.abort()` is the REAL cancel (cooperative callers stop). The race only
  // bounds the gateway's own latency so a non-cooperative caller cannot hang it
  // (§10.3) — that leaked call is exactly what process isolation contains
  // (GAP-WORKER-ISO-01).
  const abortRace = new Promise<never>((_, reject) => {
    if (ac.signal.aborted) reject(new Error('aborted'));
    else ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

  const reportProgress = params.reportProgress
    ? async (milestone: ModelProgressMilestone): Promise<ProgressReportResult> => {
        if (closed || ac.signal.aborted || Date.now() >= activeDeadlineAt()) {
          return {
            accepted: false,
            businessOperationCutoffAt: earnedDeadlineAt,
            workDeadlineAt: earnedDeadlineAt,
            hardDeadlineAt: earnedDeadlineAt,
            absoluteHardDeadlineAt: earnedDeadlineAt,
            extensionCount: progressExtensions,
            reason: closed ? 'closed' : 'stale_authority_or_cutoff',
          };
        }
        progressReportsInFlight += 1;
        armDeadline();
        try {
          const report = await params.reportProgress!(milestone);
          // The call or its authority may have closed while Mongo was replying.
          // Never let a late promise re-arm a cleared timer.
          if (closed || ac.signal.aborted) {
            return {
              ...report,
              accepted: false,
              reason: 'closed',
            };
          }
          if (report.reason !== 'stale_authority_or_cutoff' && report.reason !== 'closed') {
            // Mongo store time + owner/fence/CAS is the authority. Never add a
            // local duration here: after a restart or a slow round trip only
            // this exact returned instant is valid. A live duplicate is also an
            // idempotent resync after an accepted response may have been lost.
            // `max` prevents two concurrent replies moving the watchdog back.
            earnedDeadlineAt = Math.max(
              earnedDeadlineAt,
              report.businessOperationCutoffAt,
            );
            earnedWorkDeadlineAt = Math.max(
              earnedWorkDeadlineAt,
              report.workDeadlineAt,
            );
            progressExtensions = Math.max(progressExtensions, report.extensionCount);
          }
          if (report.reason === 'stale_authority_or_cutoff') {
            // Do not wait for the next heartbeat after the store has already
            // said this worker lost authority.
            ac.abort(new Error('attempt_authority_lost'));
          }
          return report;
        } finally {
          progressReportsInFlight = Math.max(0, progressReportsInFlight - 1);
          if (!closed && !ac.signal.aborted) armDeadline();
        }
      }
    : undefined;

  try {
    const { text, fromArtifact, artifacts } = await Promise.race([
      params.callModel({
        prompt: params.prompt,
        ...(params.classificationPrompt ? { classificationPrompt: params.classificationPrompt } : {}),
        signal: ac.signal,
        ...(reportProgress ? { reportProgress } : {}),
      }),
      abortRace,
    ]);
    return {
      ok: true,
      text,
      fromArtifact,
      // Omitted when empty rather than sent as `[]`: the producer validator
      // rejects values that do not survive a JSON round trip, and an absent
      // field defaults cleanly at the schema.
      ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
      durationMs: Date.now() - start,
      ...(params.reportProgress ? { progressExtensions } : {}),
    };
  } catch (err) {
    const errorCode = (err as { code?: unknown } | null)?.code;
    const livenessDeadline = errorCode === 'HARNESS_LIVENESS_HARD_CAP'
      || errorCode === 'HARNESS_LIVENESS_IDLE_TIMEOUT';
    const reason: BoundedCallResult['reason'] = timedOut || livenessDeadline
      ? 'deadline'
      : ac.signal.aborted
        ? 'aborted'
        : 'error';
    return {
      ok: false,
      reason,
      durationMs: Date.now() - start,
      error: (err as Error).message,
      ...(params.reportProgress ? { progressExtensions } : {}),
    };
  } finally {
    closed = true;
    if (timer) clearTimeout(timer);
    params.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export type ResultMode = 'structured' | 'bounded_text';

/**
 * Map a bounded call result to a producer-envelope input for the A boundary.
 * - `structured`: pass the model text through; the A boundary parses a JSON
 *   envelope (ok) or rejects prose (invalid_result).
 * - `bounded_text`: for read-only capabilities whose deliverable IS free text —
 *   the RUNTIME (not the model) wraps non-empty text as ok. Empty text is still a
 *   failure, so this is not a false-success fallback (§9.1 compatibility layer).
 */
export function modelResultToProducer(r: BoundedCallResult, mode: ResultMode = 'structured'): unknown {
  if (!r.ok) {
    if (r.reason === 'deadline') return { status: 'timed_out', error: { code: 'attempt_deadline', message: 'model call exceeded business cutoff' } };
    if (r.reason === 'aborted') return { status: 'cancelled', error: { code: 'aborted', message: 'model call aborted' } };
    return { status: 'failed', error: { code: 'provider_error', message: r.error ?? 'model error' } };
  }
  if (mode === 'bounded_text') {
    const text = (r.text ?? '').trim();
    if (!text) return { status: 'failed', error: { code: 'empty_output', message: 'agent returned no text' } };
    // `fromArtifact` travels with the result so FINAL_DECISION can apply a rule
    // about WHAT the deliverable is without re-reading the run.
    return {
      status: 'ok',
      data: r.fromArtifact ? { text, fromArtifact: true } : { text },
      summary: text.slice(0, 240),
      // Free text is the deliverable here, but a run may ALSO have stored files.
      // The successor gets a truncated preview of the text and the ids for the
      // rest; dropping them here is what left `producer.artifacts` empty forever.
      ...(r.artifacts && r.artifacts.length > 0 ? { artifacts: r.artifacts } : {}),
    };
  }
  return r.text;
}

/**
 * Build an async worker fixture that runs model work only inside the centrally
 * persisted business window. Payload freezing and A use the protected remainder
 * before `workDeadlineAt`; stop/cleanup retains the hard-deadline reserve.
 */
export function createModelWorker(params: {
  callModel: ModelCaller;
  buildPrompt: (ctx: WorkerContext) => string;
  resultMode?: ResultMode;
}): WorkerFixture {
  const mode = params.resultMode ?? 'structured';
  return async (ctx) => {
    // Model work is a business operation: it ends at the centrally persisted
    // business cutoff. The remaining window is reserved for payload-ready + A.
    const r = await runBoundedModelCall({
      deadlineAt: ctx.businessOperationCutoffAt.getTime(),
      callModel: params.callModel,
      prompt: params.buildPrompt(ctx),
    });
    return modelResultToProducer(r, mode);
  };
}
