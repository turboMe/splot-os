/**
 * Single source of truth for CRM lead statuses.
 *
 * There used to be three lists and they did not agree: the tool enum
 * (`CRM_STATUSES`), the workspace funnel (`LEAD_STATUSES`), and a hardcoded
 * copy inside the dashboard's JavaScript. The send path then wrote a fourth
 * value, `contacted`, that appeared in none of them — so a lead that had just
 * been emailed dropped out of every kanban column and vanished from the board
 * while the counter above it still counted 6. Nothing errored. The lead was
 * simply not drawn.
 *
 * One list, one label map, one alias table. The UI reads it over the API rather
 * than restating it, and anything unrecognised is rendered in its own column
 * instead of being silently discarded — a status nobody planned for is a thing
 * to look at, not a thing to hide.
 */

/** Canonical statuses, in funnel order. Kanban columns follow this order. */
export const CRM_STATUSES = [
  'research_needed',
  'research_enriched',
  'draft_gotowy',
  'followup_draft_gotowy',
  'sent',
  'wysłany_email_1',
  'wysłany_email_2',
  'wysłany_email_3',
  'odpowiedział',
  'zainteresowany',
  'zarejestrowany',
  'aktywny_klient',
  'brak_odpowiedzi',
  'opt-out',
] as const;

export type CrmStatus = (typeof CRM_STATUSES)[number];

export const CRM_STATUS_LABELS: Record<CrmStatus, string> = {
  research_needed: 'Do researchu',
  research_enriched: 'Wzbogacony',
  draft_gotowy: 'Draft gotowy',
  followup_draft_gotowy: 'Follow-up gotowy',
  sent: 'Wysłane',
  'wysłany_email_1': 'Wysłany #1',
  'wysłany_email_2': 'Wysłany #2',
  'wysłany_email_3': 'Wysłany #3',
  odpowiedział: 'Odpowiedział',
  zainteresowany: 'Zainteresowany',
  zarejestrowany: 'Zarejestrowany',
  aktywny_klient: 'Aktywny klient',
  brak_odpowiedzi: 'Brak odpowiedzi',
  'opt-out': 'Opt-out',
};

/**
 * Historical values that predate the canonical list, mapped to their meaning.
 *
 * `contacted` is the one that actually cost us: `sendDraftById` stamped it on
 * every lead it emailed. The rest come from the dashboard's old funnel and were
 * never written by any code path — they are here so that data restored from an
 * old backup lands somewhere sensible rather than in the unknown column.
 *
 * Deliberately absent: `parked`. "Wstrzymane" is not the same as `opt-out`, and
 * guessing an equivalence would quietly rewrite what someone meant. It falls
 * through to the unknown column, where it is visible and can be judged.
 */
export const CRM_STATUS_ALIASES: Record<string, CrmStatus> = {
  contacted: 'sent',
  new: 'research_needed',
  replied: 'odpowiedział',
  won: 'aktywny_klient',
  lost: 'brak_odpowiedzi',
};

export const DEFAULT_CRM_STATUS: CrmStatus = 'research_needed';

/** The status a delivered email puts a lead into. Named so no caller re-types it. */
export const CRM_STATUS_SENT: CrmStatus = 'sent';

/**
 * Statuses meaning "this lead has already been worked" — a draft exists, or
 * something was sent, or the relationship moved past outreach.
 *
 * This is the dedupe test for anything that generates outreach in bulk. Note
 * that it includes `brak_odpowiedzi` (we did write; they did not answer) and
 * `opt-out` (we must not write again). Only the two research states are absent,
 * because those are leads nothing has been produced for yet.
 */
export const CRM_ENGAGED_STATUSES: readonly CrmStatus[] = CRM_STATUSES.filter(
  (status) => status !== 'research_needed' && status !== 'research_enriched',
);

const CANONICAL = new Set<string>(CRM_STATUSES);

/** Canonical form of a stored status, or null when it is genuinely unknown. */
export function normalizeCrmStatus(status: string | null | undefined): CrmStatus | null {
  if (!status) return null;
  if (CANONICAL.has(status)) return status as CrmStatus;
  return CRM_STATUS_ALIASES[status] ?? null;
}

/** True when a lead in this status must not receive another generated draft. */
export function isEngagedCrmStatus(status: string | null | undefined): boolean {
  const canonical = normalizeCrmStatus(status);
  return canonical !== null && CRM_ENGAGED_STATUSES.includes(canonical);
}

export function crmStatusLabel(status: string): string {
  const canonical = normalizeCrmStatus(status);
  return canonical ? CRM_STATUS_LABELS[canonical] : status;
}
