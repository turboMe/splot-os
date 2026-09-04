/**
 * What a run STORED, recorded when it stores it.
 *
 * WHY NOT READ IT OFF THE RESPONSE
 * --------------------------------
 * `findArtifactIds` answers the same question by scanning the response's
 * `toolResults`, and that approach has now failed twice for two unrelated
 * reasons, both found only on live traffic:
 *
 *  1. it matched the tool's registered `id` (`artifact_put`) while Mastra's step
 *     history reports the tool-object KEY (`artifactPutTool`), so it returned
 *     nothing for every run ever made;
 *  2. once that was fixed, a design run wrote a 10 KB prototype and still
 *     committed prose, because the harness makes SEVERAL `generate` calls and the
 *     returned response was the last one — `steps=1, toolCalls=0, toolResults=0`.
 *     The write happened in an earlier call whose response was discarded.
 *
 * Both are the same mistake in different clothes: inferring a fact about the run
 * from an object the framework is free to reshape. The writer knows it wrote.
 * Recording it at that moment is not a heuristic, survives any number of
 * intermediate `generate` calls, and cannot be broken by a renamed field.
 *
 * Scoped by `runId` from the harness execution context — the same
 * AsyncLocalStorage that already carries the abort signal into tools, because
 * "tools execute deep inside the model loop and never receive harness
 * arguments".
 */
import { getHarnessExecutionContext } from './harness-execution-context.js';

/** Insertion-ordered ids per run; a run that stores several finished with the last. */
const _runArtifacts = new Map<string, string[]>();

// Same defensive bound as the run-budget registry: a leaked entry (missed clear)
// must not grow the map forever.
const MAX_ENTRIES = 1_000;

/**
 * Record that the current run produced an artifact.
 *
 * Silently does nothing outside a harness run — a direct tool call from a test
 * or a script has no run to attribute the write to, and inventing one would be
 * worse than recording nothing.
 */
export function noteRunArtifact(artifactId: string, runId?: string): void {
  const id = runId ?? getHarnessExecutionContext()?.runId;
  if (!id || !artifactId) {
    // An unattributed write is invisible to the orchestrator, and invisible is
    // exactly how this class of bug has hidden every time: chefAgent stored a
    // 6 KB Menu Book and its job still committed 581 chars of narration. Say so,
    // rather than leaving another silent gap to be diagnosed by guesswork.
    if (artifactId) {
      console.warn(
        `[artifacts] ${artifactId} was stored OUTSIDE any harness run — no run to attribute it to, `
        + 'so no job can commit it as its deliverable',
      );
    }
    return;
  }
  const existing = _runArtifacts.get(id);
  if (existing) {
    if (!existing.includes(artifactId)) existing.push(artifactId);
    return;
  }
  _runArtifacts.set(id, [artifactId]);
  if (_runArtifacts.size > MAX_ENTRIES) {
    const oldest = _runArtifacts.keys().next().value;
    if (oldest !== undefined) _runArtifacts.delete(oldest);
  }
}

/** Artifacts this run stored, oldest first. Empty when it stored none. */
export function getRunArtifacts(runId: string): string[] {
  return [...(_runArtifacts.get(runId) ?? [])];
}

/** Drop a finished run's record. */
export function clearRunArtifacts(runId: string): void {
  _runArtifacts.delete(runId);
}
