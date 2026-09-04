/**
 * The output contract for an agent running as a durable job (plan F7, step 3b).
 *
 * Every specialist in this system was written for a conversation: someone reads
 * the reply, answers the question, asks for the next thing. Run as a V2 worker
 * none of that is true — the run's FINAL text is committed as the job's result
 * and that is all the user ever sees. The capability-routing canary showed
 * exactly what that mismatch produces, on the first two real jobs:
 *
 *  - `chefAgent`, asked for a tasting menu, replied "which cuisine? any dietary
 *    limits?" — a perfectly good conversational move, committed as the
 *    deliverable, and the job closed COMPLETED with a question inside it;
 *  - asked again in almost the same words, it invented a theme instead and
 *    delivered confidently. Inventing is WORSE than asking: the user gets a
 *    sure-footed answer to a question they did not ask;
 *  - `writerAgent` returned the reflector's commentary *about* the story
 *    ("finished, passes the anti-slop audit 100/100") rather than the story.
 *
 * None of these is a routing or substrate defect, and none is visible to a test
 * suite — they are the specialists behaving as designed in a mode they were
 * never told about. So they get told, in one place, for every capability.
 *
 * WHY THE MIDDLE PATH IS THE POINT
 * --------------------------------
 * "Ask when unsure" produces the first failure; "never ask" produces the second.
 * The contract asks for neither: decide, do the work, and STATE the assumptions.
 * A question is reserved for what only the user can supply, and it is structural
 * (`NEEDS_INPUT:`) so the Service can recognize it without a model in the loop.
 */

/** The one way a headless run may say "I cannot proceed without you". */
export const NEEDS_INPUT_MARKER = 'NEEDS_INPUT:';

/** Long enough for a real question, short enough not to be a deliverable. */
const MAX_QUESTION_CHARS = 1_000;

/** How far into the text the marker may appear before it is just prose about it. */
const MARKER_SEARCH_WINDOW = 400;

/**
 * The instructions appended to every headless run's prompt.
 *
 * Deliberately about the RUN, not about the agent: it is the same for chef,
 * writer and everything else, because what changed is the mode, not the craft.
 * `deliverable` is the only per-capability part, and it comes from the Agent
 * Board card rather than from a second description that could drift.
 */
export function buildHeadlessContract(
  opts: { deliverable?: string; sideEffectProduct?: boolean } = {},
): string {
  const expected = opts.deliverable?.trim();
  return [
    '--- HOW THIS RUN WORKS ---',
    'You are running as a background job. Nobody is reading this while it runs and nobody will',
    'reply to you. Your FINAL message is stored as the result and is the only thing the user',
    'will see.',
    '',
    // A background run has no other way to know. Without it, "next week" is
    // computed from whatever date the model last saw — on the marketing canary
    // that was an EXAMPLE inside a tool description, and the follow-up was booked
    // three months in the past, into a real calendar.
    `Today is ${new Date().toISOString().slice(0, 10)}. Compute every relative date ("next week",`,
    '"tomorrow", "in 3 days") from THAT, never from a date you saw in an example.',
    '',
    'Therefore:',
    expected
      ? `- End with the finished work itself (expected: ${expected}) — not a plan to do it, not a`
      : '- End with the finished work itself — not a plan to do it, not a',
    '  summary of having done it, and not a reflection on how it went. If you want to think out',
    '  loud, do it before the final message, never instead of it.',
    '- Missing detail is normal and is NOT a reason to stop. Choose sensible defaults, DO THE',
    '  WORK, and state the assumptions you made in one short line at the end. A finished',
    '  deliverable built on stated assumptions is far more useful than a question — and far more',
    '  honest than quietly inventing the answer and presenting it as what was asked for.',
    `- ONLY if the goal is genuinely impossible without something the user alone has (data you`,
    '  cannot obtain, a file you cannot find, a decision that is not yours to make), reply with',
    '  exactly:',
    `      ${NEEDS_INPUT_MARKER} <one question asking for everything you need at once>`,
    '  and nothing else. This stops the job and costs the user a round trip, so it is a last',
    '  resort, not a way to check in.',
    // Only for the capabilities whose product is an effect in the world. Their
    // real output lives in n8n, a mailbox, a CRM or a repository, and the run can
    // finish having done everything right while saying almost nothing — which is
    // indistinguishable from having done nothing. Measured: a deployed workflow,
    // an `empty_output` failure, and the same task started again.
    ...(opts.sideEffectProduct
      ? [
        '',
        'YOUR WORK LANDS OUTSIDE THIS CONVERSATION:',
        '- Before your final message, save the thing you produced with `artifact_put` (the',
        '  workflow JSON, the definition, the report). Writing it to a file is NOT enough —',
        '  a file is invisible to the job, and an unsaved product looks exactly like no work.',
        '- Then end with a SHORT report: what you changed in the outside world, the ids it',
        '  got (workflow id, record id, url), whether it is active, and the artefact id you',
        '  just saved. That report is the result the user sees.',
        '- Report ONLY what your tools actually returned. If a tool said the record already',
        '  existed, say "already existed" — not "created". If something was skipped, say it was',
        '  skipped. Nobody will re-check your work before acting on this report, so a claim you',
        '  did not verify is worse than an admission that you did not do it.',
      ]
      : []),
  ].join('\n');
}

/**
 * The question a headless run is blocked on, or `null` if it delivered.
 *
 * Structural on purpose: recognizing "this is a question, not a deliverable" by
 * reading the prose would put a model in the loop at the exact point where the
 * previous model already failed to notice. The marker must appear at the START
 * of the answer (a mention of it further down is the agent quoting its own
 * instructions, not invoking them).
 */
export function parseNeedsInput(text: string): string | null {
  const head = text.slice(0, MARKER_SEARCH_WINDOW);
  const index = head.indexOf(NEEDS_INPUT_MARKER);
  if (index === -1) return null;
  // Anything before the marker must be framing (whitespace, a fence, a heading
  // marker) — not content, which would mean the run answered AND asked.
  const before = head.slice(0, index).replace(/[\s`*#>_-]/g, '');
  if (before.length > 0) return null;

  const question = text
    .slice(index + NEEDS_INPUT_MARKER.length)
    // Models close the emphasis they opened (`` `NEEDS_INPUT:` ``, `**NEEDS_INPUT:**`),
    // so the closing fragment lands at the front of the question.
    .replace(/^[\s`*_]+/, '')
    .trim()
    .slice(0, MAX_QUESTION_CHARS)
    .trim();
  return question.length > 0 ? question : null;
}
