/**
 * Truthfulness guard for the Meta Front's reply (§4.1).
 *
 * The front is the only thing the user sees, and it reports on work it does not
 * do. Two failures on the capability-routing canary showed that its reply cannot
 * simply be trusted through:
 *
 *  - asked to write an article, it answered **"started it, ID `job_coffee_article`"**
 *    without ever calling the tool. No such job exists. The user is told work is
 *    underway and waits for something that will never happen — the worst failure
 *    mode this layer has, because it is indistinguishable from success;
 *  - given a longer, more specific request, it returned an **empty string** twice
 *    in a row. The user gets a blank reply and no reason.
 *
 * Both are properties of the model (`gemini-3.1-flash-lite`, chosen for latency),
 * so they will recur with any model under load. But both are also DETECTABLE
 * here, cheaply and without heuristics about meaning: this turn knows exactly
 * which job ids its own tool calls returned, and a job id in the text that is not
 * among them was invented.
 *
 * The guard therefore checks facts, never style: it does not judge whether the
 * answer is good, only whether it claims something that did not happen.
 */

/** Job ids as minted by the store (`job_<uuid>`), matched loosely on purpose. */
const JOB_ID_IN_TEXT = /\bjob_[A-Za-z0-9][A-Za-z0-9_-]*/g;

export type FrontReplyVerdict =
  | { ok: true }
  | { ok: false; reason: 'empty'; detail: string }
  | { ok: false; reason: 'fabricated_job_id'; detail: string };

/**
 * Job ids this turn actually produced.
 *
 * Read out of the tool results by pattern rather than by walking a typed shape:
 * the guard must keep working when the framework changes its result envelope,
 * and over-collecting here can only ever make the check more permissive in a
 * direction that is already true (an id that appears in a tool result IS real).
 */
export function collectRealJobIds(toolResults: unknown): Set<string> {
  let serialized: string;
  try {
    serialized = JSON.stringify(toolResults ?? []);
  } catch {
    return new Set();
  }
  return new Set(serialized.match(JOB_ID_IN_TEXT) ?? []);
}

/** Does this reply claim anything that did not happen? */
export function auditFrontReply(text: string, realJobIds: Set<string>): FrontReplyVerdict {
  if (text.trim().length === 0) {
    return { ok: false, reason: 'empty', detail: 'the model returned no text at all' };
  }
  const claimed = text.match(JOB_ID_IN_TEXT) ?? [];
  const invented = claimed.filter((id) => !realJobIds.has(id));
  if (invented.length > 0) {
    return {
      ok: false,
      reason: 'fabricated_job_id',
      detail: `reply claims ${invented.join(', ')}, this turn created ${
        realJobIds.size > 0 ? [...realJobIds].join(', ') : 'nothing'
      }`,
    };
  }
  return { ok: true };
}

/**
 * Promises to notify the user, which the front cannot keep.
 *
 * There is no push channel. "I'll let you know when it's done" leaves the user
 * waiting for a message that never arrives — the same shape of harm as a
 * fabricated job id, just slower to notice. `meta-front/base.md` forbids it in
 * plain terms and the model still did it on the design canary:
 *
 *     "Gdy praca się zakończy, poinformuję Cię o tym i udostępnię gotowy plik."
 *
 * DELIBERATELY NOT PART OF `auditFrontReply`. That verdict can end in
 * `FRONT_REPLY_FALLBACK` ("nothing was started"), which would be FALSE here —
 * the job usually did start, and the only thing wrong is the promise. Replacing
 * a true report with a false one to punish a bad sentence is a worse outcome
 * than the sentence. So this is a correction-only signal: nudge once, then
 * deliver whatever the model said.
 *
 * Matched in both languages the front speaks, and negation-aware, because
 * "nie poinformuję Cię automatycznie" is the CORRECT thing to say.
 */
// ⚠️ `\p{L}` boundaries with the `u` flag, NOT `\b`. `\b` is defined by ASCII
// `\w`, so it does not exist after `ę` or `ć` — `/poinformuję\b/` silently never
// matches, which is exactly the sentence this guard exists to catch.
const NOTIFY_PROMISE_PATTERNS: RegExp[] = [
  /(?<!\p{L})(?:poinformuję|powiadomię|dam\s+znać|odezwę\s+się|wrócę\s+do\s+ciebie)(?!\p{L})/iu,
  /(?<!\p{L})(?:I(?:'|\s+wi)ll\s+(?:let\s+you\s+know|notify|inform|update|ping|tell\s+you)|will\s+get\s+back\s+to\s+you)(?!\p{L})/iu,
];

/** Negations that make the same verbs a correct statement rather than a promise. */
const NEGATION_NEARBY = /(?<!\p{L})(?:nie|nigdy|cannot|can't|won't|will\s+not|unable)(?!\p{L})/iu;

/**
 * The promise this reply makes and cannot keep, or null.
 *
 * Returns the offending fragment rather than a boolean so the correction can
 * quote it — a model told which sentence was wrong rewrites that sentence,
 * while one told "you did something wrong" tends to rewrite everything.
 */
export function findUnkeepablePromise(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?\n])/)) {
    for (const pattern of NOTIFY_PROMISE_PATTERNS) {
      const match = pattern.exec(sentence);
      if (!match) continue;
      // Look only at what precedes the verb: "nie poinformuję" is fine,
      // "poinformuję Cię, gdy nie będzie błędów" is not.
      if (NEGATION_NEARBY.test(sentence.slice(0, match.index))) continue;
      return sentence.trim();
    }
  }
  return null;
}

/** Ask for the same answer without the promise, naming the sentence at fault. */
export function promiseCorrectionPrompt(promise: string, originalMessage: string): string {
  return [
    `Your previous reply promised to contact the user later: "${promise}"`,
    'You have NO way to reach them — there is no push channel, and nothing will send that message.',
    '',
    'Say the same thing again, keeping every fact (including any job id you reported),',
    'but replace the promise with an invitation to ask, in the user\'s language.',
    '',
    `The user's message was: ${originalMessage}`,
  ].join('\n');
}

/**
 * What to tell the model when its reply failed the audit.
 *
 * A correction rather than a rewrite: the front owns the wording and the
 * language the user is speaking, so the fix has to come from it. Only if a
 * corrected attempt fails too does the caller fall back to a fixed message.
 */
export function correctionPrompt(verdict: FrontReplyVerdict, originalMessage: string): string {
  const problem = verdict.ok
    ? ''
    : verdict.reason === 'empty'
      ? 'Your previous reply was EMPTY. The user saw a blank message.'
      : `Your previous reply mentioned a job id that does not exist (${verdict.detail}). `
        + 'You cannot invent a job id: it only exists if orchestration_start_job returned it.';
  return [
    problem,
    '',
    'Answer the user again, now. If the request needs work done, actually CALL',
    'orchestration_start_job and report the id it returns. If you did not start anything,',
    'say so plainly rather than implying you did.',
    '',
    `The user's message was: ${originalMessage}`,
  ].join('\n');
}

/**
 * Last resort, when even the corrected attempt fails the audit.
 *
 * Deliberately says only what is certainly true — that nothing was started —
 * because the alternative is passing on a claim we have just proven false.
 * Bilingual because the front follows the user's language and this text does not
 * get to choose.
 */
export const FRONT_REPLY_FALLBACK =
  'Nie udało mi się przyjąć tego zlecenia i nic nie zostało uruchomione — spróbuj napisać to jeszcze raz.\n'
  + '(I could not accept this request and nothing was started — please try sending it again.)';
