/**
 * The best deliverable a run produced, recorded AS IT HAPPENS.
 *
 * WHY THIS CANNOT BE READ OFF THE FINAL RESPONSE
 * ---------------------------------------------
 * `generateWithHarness` makes SEVERAL `generate` calls (reflection repair, depth
 * upgrade, auto-deliberation) and keeps the last one. Mastra returns that call's
 * steps, not the run's — so a run with fourteen steps of real work can hand back
 * `steps=1` whose only text is the framework's completion report, and every
 * earlier step is unreachable from the object the caller holds.
 *
 * Measured on the security-review canary (2026-08-17): `securityReviewAgent`
 * made 43 tool calls, read the right files, and produced a 5790-character review
 * — the goal scorer saw it and passed. The job then FAILED with
 * `run produced no deliverable`, because the final response's only step was
 * `#### Completion Check Results`. Nothing was wrong with the work; it was
 * unreachable.
 *
 * This is the same lesson the artifact tracker already learned (`run-artifacts.ts`):
 * do not recover a fact about a run from an object the framework may reshape —
 * record it at the moment of the event.
 */
import { isFrameworkArtifactText } from './harness-output-text.js';

/** runId → the longest non-framework step text seen so far. */
const byRun = new Map<string, string>();

/** Bounded so a long-lived process cannot accumulate runs forever. */
const MAX_TRACKED_RUNS = 200;

/**
 * Offer a step's text as a deliverable candidate.
 *
 * LONGEST wins rather than latest: an agent that delivers and then says "let me
 * verify that" would otherwise commit the sentence instead of the work, which is
 * exactly what `designAgent` did before `harness-output-text.ts` existed.
 */
export function recordRunStepText(runId: string | undefined, text: unknown): void {
  if (!runId || typeof text !== 'string') return;
  const trimmed = text.trim();
  if (trimmed.length === 0 || isFrameworkArtifactText(trimmed)) return;

  const previous = byRun.get(runId) ?? '';
  if (trimmed.length <= previous.length) return;

  if (!byRun.has(runId) && byRun.size >= MAX_TRACKED_RUNS) {
    // Drop the oldest insertion; Map preserves insertion order.
    const oldest = byRun.keys().next().value;
    if (oldest !== undefined) byRun.delete(oldest);
  }
  byRun.set(runId, trimmed);
}

/** The best candidate this run produced, or '' when it produced none. */
export function bestRunStepText(runId: string | undefined): string {
  return (runId && byRun.get(runId)) || '';
}

/** Release a finished run's candidate. Safe to call more than once. */
export function forgetRunStepTexts(runId: string | undefined): void {
  if (runId) byRun.delete(runId);
}
