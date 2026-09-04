/**
 * Writer-specific evidence for earned attempt time.
 *
 * A generic tool call is activity, not necessarily progress. This classifier is
 * deliberately narrow: first rollout accepts only successful DB-persisted
 * manuscript snapshots. The store deduplicates the returned
 * content fingerprint, so replaying the same write cannot keep a run alive.
 */
import type { HarnessStepObservation } from '../../services/generate-with-harness.js';
import type { ModelProgressMilestone } from './gateway.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTool(value: string, ...names: string[]): boolean {
  const canonical = canonicalToolName(value);
  return names.some((name) => canonical === canonicalToolName(name));
}

function successfulResult(
  observation: HarnessStepObservation,
  toolCallId: string,
  toolName: string,
): Record<string, unknown> | undefined {
  const result = observation.toolResults.find((candidate) => (
    (toolCallId.length > 0 && candidate.toolCallId === toolCallId)
    || (toolCallId.length === 0 && canonicalToolName(candidate.toolName) === canonicalToolName(toolName))
  ));
  if (!result || result.isError) return undefined;
  const record = asRecord(result.result);
  if (!record || record.success !== true) return undefined;
  return record;
}

function durableManuscriptMilestone(
  toolName: string,
  result: Record<string, unknown>,
): ModelProgressMilestone | undefined {
  const contentHash = typeof result.contentHash === 'string'
    ? result.contentHash.toLowerCase()
    : '';
  if (!/^[a-f0-9]{64}$/.test(contentHash)) return undefined;

  if (isTool(toolName, 'writer_document_snapshot', 'writerDocumentSnapshotTool')) {
    // A filesystem-only snapshot is not durable orchestration evidence. The DB
    // manuscript identity proves this tool persisted the content state.
    if (
      result.success !== true
      || typeof result.manuscriptId !== 'string'
      || result.changedSincePrevious !== true
      || typeof result.changedCharacters !== 'number'
      || result.changedCharacters < 256
      || typeof result.contentLength !== 'number'
      || result.contentLength < 1_000
    ) return undefined;
    return {
      kind: 'writer_snapshot_saved',
      // A repeated snapshot gets a fresh manuscriptId/version, but identical
      // content must never buy a second extension. Shared with document writes.
      fingerprint: `writer-content:${contentHash}`,
    };
  }
  return undefined;
}

/**
 * Return every trustworthy candidate in call order. The caller submits them to
 * the durable dedupe boundary until at most one is accepted; otherwise a replay
 * in the first parallel call could hide a later genuinely new document hash.
 */
export function detectWriterProgressCandidates(
  observation: HarnessStepObservation,
): ModelProgressMilestone[] {
  const milestones: ModelProgressMilestone[] = [];
  for (const call of observation.toolCalls) {
    const result = successfulResult(observation, call.toolCallId, call.toolName);
    if (!result) continue;
    const milestone = durableManuscriptMilestone(call.toolName, result);
    if (milestone) milestones.push(milestone);
  }
  return milestones;
}

/** Compatibility helper for callers that need only the first candidate. */
export function detectWriterProgress(
  observation: HarnessStepObservation,
): ModelProgressMilestone | undefined {
  return detectWriterProgressCandidates(observation)[0];
}
