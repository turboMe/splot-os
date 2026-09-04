/**
 * Artifact types — the vocabulary of inter-agent handoffs (Etap 3, A2).
 *
 * Every handoff between agents names the artifact type it produces/consumes.
 * The Agent Board cards (config/agent-board.ts) declare outputArtifacts per
 * agent; TaskBrief v2 (worker-task-spec) and Plays (Etap 4) reference these.
 */

export const ARTIFACT_TYPES = [
  'research_report',
  'action_plan',
  'decision_memo',
  'diff_patch',
  'review_report',
  'content_pack',
  'lead_batch',
  'menu_book_ref',
  'media_ref',
  'document',
  'analysis_report',
  'automation_workflow',
  'crm_update',
  'email_draft',
  'specialist_dossier',
] as const;

export type ArtifactType = typeof ARTIFACT_TYPES[number];

export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** Reference passed between agents INSTEAD of content. */
export type ArtifactRef = {
  id: string;
  type: ArtifactType;
  /** ≤300 chars — the only part that travels in prompts. */
  summary: string;
};
