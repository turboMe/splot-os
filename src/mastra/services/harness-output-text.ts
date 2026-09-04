/**
 * What a harness run actually PRODUCED, as opposed to whatever it said last.
 *
 * These are not the same thing, and the difference reached a user. On the
 * capability-routing canary `chefAgent` finished a job whose committed
 * deliverable was this:
 *
 *     #### Completion Check Results
 *     Overall: ✅ COMPLETE
 *     **Goal Completion Scorer** (goal-completion)  Score: 1 ✅
 *     ✅ The task is complete.
 *
 * No agent wrote that. It is the framework's own rendering of the
 * `isTaskComplete` scoring pass, injected into the message list after the final
 * iteration — so it lands in `response.text`, and every consumer that reads
 * "the run's output" from there gets a report ABOUT the work instead of the work.
 * The job was marked SUCCEEDED and the user got a status line where a menu
 * should have been.
 *
 * WHY A DENYLIST, AND WHY A NARROW ONE
 * ------------------------------------
 * There is no flag on the response saying "this text is mine, not the agent's",
 * so the only available signal is the shape of the text itself. That argues for
 * matching as little as possible: a *narrow* matcher that misses a new framework
 * artifact merely restores today's behaviour, while a broad one would silently
 * discard a genuine deliverable — much worse, and much harder to notice. So each
 * pattern here must correspond to output that was actually observed, not to a
 * category someone imagined.
 */

/**
 * Text emitted by the harness/framework rather than by the agent.
 *
 * Anchored at the start: an agent that *discusses* completion checks inside a
 * real deliverable keeps its deliverable.
 */
const FRAMEWORK_ARTIFACT_PATTERNS: RegExp[] = [
  // Mastra's `isTaskComplete` scoring report (observed live, chefAgent).
  /^#{0,6}\s*Completion Check Results\b/i,
];

/** Leading markdown framing a model may wrap around the report. */
const LEADING_FRAMING = /^[\s`*_>#-]+/;

/**
 * Is this text the framework talking about the run, rather than the run's output?
 */
export function isFrameworkArtifactText(text: string): boolean {
  const head = text.replace(LEADING_FRAMING, '').slice(0, 200);
  return FRAMEWORK_ARTIFACT_PATTERNS.some((pattern) => pattern.test(head));
}

/**
 * Remove a framework block APPENDED to otherwise real output.
 *
 * The report does not always replace the answer — when the agent narrates its
 * pipeline the report is glued onto the end of that same text, so a start-anchored
 * check sees a legitimate deliverable and keeps the whole thing. Observed on the
 * first chef run that completed: 819 chars of narration followed by "#### Completion
 * Check Results … ✅ The task is complete."
 *
 * Only ever cuts a TAIL that begins with the marker, so nothing before it can be
 * lost.
 */
export function stripTrailingFrameworkBlock(text: string): string {
  // Two shapes, both seen live. The report may start its own line, or be glued
  // straight onto the agent's last sentence with no separator at all:
  //   "Now let me verify the design renders correctly:#### Completion Check Results"
  // A markdown heading mid-sentence is not something prose does, so requiring
  // the `#` marks keeps the no-newline variant narrow.
  const match = /\n\s*#{0,6}\s*Completion Check Results\b|#{1,6}\s*Completion Check Results\b/i
    .exec(text);
  if (!match || match.index <= 0) return text;
  return text.slice(0, match.index).trimEnd();
}

/** A step of a Mastra generate response, as far as this module cares. */
interface ResponseStep { text?: unknown }

/**
 * Why a run produced no deliverable — logged only when one produced none.
 *
 * "Empty output" has now been misdiagnosed three times (memory scoping, the
 * attempt budget, the step ceiling), each time because the symptom is identical
 * whatever the cause and nothing recorded WHICH candidate was rejected. On the
 * design canary a run finished `finishReason=stop`, the scorer reported a
 * "substantive final output (684 chars)", and this function still returned ''.
 * Guessing from a truncated log is what produced the previous wrong diagnoses,
 * so the failure path now states its own evidence.
 */
export function describeEmptyDeliverable(response: unknown): string {
  try {
    const record = (response ?? {}) as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text : null;
    const steps = Array.isArray(record.steps) ? (record.steps as ResponseStep[]) : null;
    const parts = [
      `response.text=${text === null ? 'absent' : `${text.length}ch${isFrameworkArtifactText(text) ? '/framework' : ''}`}`,
      `steps=${steps === null ? 'absent' : steps.length}`,
    ];
    if (steps) {
      parts.push(`stepTexts=[${steps.map((step) => {
        const value = step?.text;
        if (typeof value !== 'string') return typeof value === 'undefined' ? 'none' : typeof value;
        if (value.length === 0) return 'empty';
        return `${value.length}ch${isFrameworkArtifactText(value) ? '/framework' : ''}`;
      }).join(',')}]`);
    }
    const toolResults = Array.isArray(record.toolResults) ? record.toolResults : null;
    parts.push(`toolResults=${toolResults === null ? 'absent' : toolResults.length}`);
    return parts.join(' ');
  } catch (error) {
    return `diagnostic failed: ${(error as Error).message}`;
  }
}

/**
 * The deliverable text of a run.
 *
 * Order of preference:
 *  1. `response.text`, unless it is a framework artifact;
 *  2. the LAST step whose text is a real deliverable — the agent's actual final
 *     answer, which the artifact was appended after;
 *  3. a tool-result summary, then the raw shape (unchanged legacy fallbacks).
 *
 * If every candidate is an artifact the result is empty, and that is deliberate:
 * an empty output fails the attempt visibly, whereas committing the framework's
 * "✅ The task is complete" as the answer looks like success and is not.
 */
export function extractDeliverableText(response: unknown): string {
  try {
    if (typeof response === 'string') return response;
    if (!response || typeof response !== 'object') return JSON.stringify(response) ?? '';

    const record = response as Record<string, unknown>;

    if (typeof record.text === 'string' && record.text.length > 0 && !isFrameworkArtifactText(record.text)) {
      return stripTrailingFrameworkBlock(record.text);
    }

    if (Array.isArray(record.steps) && record.steps.length > 0) {
      const steps = record.steps as ResponseStep[];
      for (let i = steps.length - 1; i >= 0; i--) {
        const text = steps[i]?.text;
        if (typeof text === 'string' && text.length > 0 && !isFrameworkArtifactText(text)) {
          return stripTrailingFrameworkBlock(text);
        }
      }
      // Every step was framework output: fall through rather than return one.
      if (typeof record.text === 'string' && isFrameworkArtifactText(record.text)) return '';
    }

    if (Array.isArray(record.toolResults) && record.toolResults.length > 0) {
      return (record.toolResults as Array<Record<string, unknown>>)
        .map((tr) => `[${tr.toolName}] ${JSON.stringify(tr.result ?? '')}`)
        .join('\n');
    }

    if (typeof record.output === 'string') return record.output;
    if (typeof record.text === 'string' && isFrameworkArtifactText(record.text)) return '';
    return JSON.stringify(response);
  } catch {
    return '';
  }
}

/**
 * Tools whose result means "this run PRODUCED a document".
 *
 * A set rather than a constant because domain agents persist through their own
 * writer — `designAgent` has no `artifact_put`, it has `design_write_deliverable`,
 * which stores the file AND registers the artifact in one call. Membership is
 * earned the same way the patterns above are: a tool belongs here only if it
 * WRITES. Adding a reader would resurrect the bug in `findArtifactIds` below.
 *
 * ⚠️ BOTH SPELLINGS OF EVERY TOOL, and this is not defensive padding.
 *
 * There is a naming boundary here that `config/pipeline-phase-tools.ts` documents
 * and that this file originally got wrong: prompts, docs and `createTool({ id })`
 * use the snake_case ID, but **Mastra's step history reports the agent's
 * tool-object KEY** — the camelCase export-variable name. Captured live:
 *
 *     payload: { toolName: 'designWriteDeliverableTool',
 *                result: { ref: { id: 'art-572ecd38-…' } } }
 *
 * Matching only ids meant this function returned `[]` for every run ever, so
 * artifact-based deliverable selection never once fired in production — and its
 * tests all passed, because they were written from the same wrong assumption
 * about the shape rather than from a captured response. A live design canary is
 * what exposed it: the agent wrote a 34 KB prototype, the Artifact Store had it,
 * and the job still committed the sentence the agent typed afterwards.
 */
const ARTIFACT_WRITE_TOOLS = new Set([
  // registered ids — what prompts and docs call these tools
  'artifact_put',
  'design_write_deliverable',
  // registry keys — what the runtime actually reports
  'artifactPutTool',
  'designWriteDeliverableTool',
]);

/**
 * Artifacts THIS run STORED, oldest first.
 *
 * Two things make this a fact rather than a guess, and the second one was
 * learned the expensive way:
 *
 *  1. the id comes back from a tool call inside this run — the Artifact Store
 *     records no runId, so nothing else could tie a document to its producer;
 *  2. it must come from a WRITE. The first version scanned the whole response
 *     for `art-…` ids, which also matched artifacts the agent merely READ
 *     (`artifact_get` / `artifact_list`) — and a live design job then committed
 *     an unrelated research document about a bakery as its deliverable. Handing
 *     the user someone else's work is worse than handing them narration.
 */
export function findArtifactIds(response: unknown): string[] {
  const record = response as { toolResults?: unknown } | null | undefined;
  const results = Array.isArray(record?.toolResults) ? record.toolResults : [];
  const ids: string[] = [];
  for (const entry of results as Array<Record<string, unknown>>) {
    const toolName = entry?.toolName ?? (entry?.payload as Record<string, unknown> | undefined)?.toolName;
    if (typeof toolName !== 'string' || !ARTIFACT_WRITE_TOOLS.has(toolName)) continue;
    // The envelope shape varies by framework version, so read the id by pattern
    // WITHIN this one write result rather than by a fixed path.
    let serialized: string;
    try { serialized = JSON.stringify(entry); } catch { continue; }
    for (const id of serialized.match(/\bart-[0-9a-f-]{36}\b/gi) ?? []) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
