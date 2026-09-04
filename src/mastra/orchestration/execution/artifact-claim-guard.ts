/**
 * A run may not claim an artifact it did not store.
 *
 * WHY THIS IS A GUARD AND NOT A PROMPT RULE
 * -----------------------------------------
 * The headless contract already asks side-effect capabilities to save their
 * product and name the id. Measured on the marketing canary, twice: the run did
 * the real work — a CRM interaction, a calendar booking, both verified at the
 * source — and then ended with `[Artifact_ID: Follow_up_Procedure_Log]` while
 * `producer.artifacts` was empty. A second round produced a softer version of the
 * same thing, hedged into "artifact created in the system (or registered
 * accordingly)".
 *
 * Asking again is not the fix. The orchestrator KNOWS what the run stored, to the
 * id, because `run-artifacts` records each write at the moment it happens. So a
 * claim is checkable, not a matter of taste, and the same reasoning that gave the
 * meta front its truthfulness guard applies here: audit the answer against the
 * run's own record.
 *
 * WHY IT ANNOTATES RATHER THAN FAILS
 * ----------------------------------
 * Failing the attempt would be the wrong tool entirely. These are capabilities
 * whose product is an effect in the world; a failed attempt is re-run, and a
 * re-run repeats the effect. That is the exact harm `GAP-SIDE-EFFECT-RESULT-01`
 * was opened for. The work happened and the report is mostly true — what is false
 * is one sentence, so one sentence is what gets corrected, by the runtime, in the
 * result the user reads.
 */

/** Our own artifact id shape. Anything matching this is a checkable claim. */
const ARTIFACT_ID_PATTERN = /\bart-[0-9a-fA-F]{8}-[0-9a-fA-F-]{4,}\b/g;

/**
 * Claim markers seen live, kept NARROW on purpose.
 *
 * A loose match ("artifact", "artefakt") would fire on an agent discussing
 * artifacts in prose, and a guard that cries wolf gets ignored — or worse,
 * annotates a correct report. These two shapes are how a run announces an id it
 * believes it produced.
 */
const CLAIM_MARKERS = [
  /\bArtifact[_ ]?ID\s*[:=]/i,
  /\b(?:artefakt|artifact)\s+(?:o\s+)?(?:id|identyfikatorze)\b/i,
];

export interface ArtifactClaimAudit {
  /** The text to commit — annotated when a claim was not backed. */
  text: string;
  /** Ids the run claimed that it never stored. */
  unbackedIds: string[];
  /** True when a claim marker appeared with nothing stored at all. */
  claimedWithoutStoring: boolean;
}

/**
 * Compare what the run SAID it produced against what it actually stored.
 *
 * `storedIds` comes from the run's own write record, never from the model.
 */
export function auditArtifactClaims(text: string, storedIds: string[]): ArtifactClaimAudit {
  const stored = new Set(storedIds);
  const mentioned = [...text.matchAll(ARTIFACT_ID_PATTERN)].map((m) => m[0]);
  const unbackedIds = [...new Set(mentioned.filter((id) => !stored.has(id)))];
  const claimedWithoutStoring = storedIds.length === 0
    && CLAIM_MARKERS.some((marker) => marker.test(text));

  if (unbackedIds.length === 0 && !claimedWithoutStoring) {
    return { text, unbackedIds: [], claimedWithoutStoring: false };
  }

  // Appended, never substituted: the rest of the report is the run's real work
  // and the user needs it. The correction states what IS true, so a reader can
  // act on the difference without re-checking the whole thing.
  const truth = storedIds.length > 0
    ? `zapisane artefakty tego runu: ${storedIds.join(', ')}`
    : 'ten run nie zapisał żadnego artefaktu';
  const detail = unbackedIds.length > 0
    ? ` Niepotwierdzone identyfikatory: ${unbackedIds.join(', ')}.`
    : '';
  return {
    text: `${text}\n\n[weryfikacja systemu] Powyższy raport powołuje się na artefakt bez pokrycia — `
      + `${truth}.${detail}`,
    unbackedIds,
    claimedWithoutStoring,
  };
}
