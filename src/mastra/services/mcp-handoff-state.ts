/**
 * WS-G — run-scoped "MCP handoff failed" flag.
 *
 * When the Automation Architect delegates to n8nMcpEngineer for node/template
 * validation and that handoff FAILS (e.g. WS-F's `n8n_mcp_handoff_no_real_tool_use`,
 * an empty result, or any `n8n_mcp_handoff_*`), the node configs it would build on
 * are UNVALIDATED. The Golden Path deploy then refuses (fail-closed) until either a
 * successful MCP handoff clears the flag, or the architect reports `blocked`.
 *
 * The flag is keyed by the harness execution context (the architect's current run),
 * which is shared — via AsyncLocalStorage — by both the delegation tool and the
 * Golden Path deploy that run inside the same `agent.generate`.
 */
import { getHarnessExecutionContext } from './harness-execution-context.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';

/** Golden Path statuses that represent a real, deployed workflow deliverable. */
export type AutomationDeliverableStatus = 'tested' | 'draft_created' | 'active';
export type AutomationDeliverableDetails = {
  status: AutomationDeliverableStatus;
  automationId?: string;
  workflowId?: string;
  workflowName?: string;
  message?: string;
  riskScore?: number;
  riskVerdict?: string;
  missingConfig?: unknown[];
  missingCredentials?: unknown[];
  /**
   * How the test that produced a `tested` status was actually run.
   *
   * `tested` is latched by a MOCK pass as readily as by a real-credentials one —
   * the Golden Path's own message says "deployed as inactive draft and passed
   * mock test". A mock validates structure; it proves nothing executed. Without
   * this field the force-report lever cannot tell the two apart, so a brief that
   * explicitly demanded an end-to-end run on real data was finalized on a mock.
   */
  testMode?: 'mock' | 'manual' | 'real_credentials';
};

const TTL_MS = 30 * 60_000;
const failedRuns = new Map<string, number>();
// WS-C-hard / finalize-on-deliverable — runs that produced a deployable Golden Path
// deliverable (a workflow that reached tested/draft_created/active). Set
// DETERMINISTICALLY by the Golden Path (no fragile parsing of compacted/normalized
// step results). Read by (a) the Strategy Reflector so graceful convergence finalizes
// after a deliverable, and (b) the finalize-on-deliverable levers (completion scorer +
// prepareStep force-report + stopWhen backstop) so a clean run ENDS with a report
// instead of hanging to the delegation timeout. Stores the terminal STATUS so the
// force-report lever can fire on tested/active but leave draft_created room to repair.
const deliveredRuns = new Map<string, { status: AutomationDeliverableStatus; details?: AutomationDeliverableDetails; at: number }>();
// WS-J — runs where at least one MCP handoff SUCCEEDED (real tool calls verified by
// WS-F). The node-validation gate uses this to enforce that a workflow with non-core
// nodes was actually run past n8nMcpEngineer before deploy.
const succeededRuns = new Map<string, number>();

function runKey(): string | null {
  const ctx = getHarnessExecutionContext();
  if (!ctx) return null;
  return ctx.runId ?? ctx.taskId ?? ctx.threadId ?? null;
}

function prune(now: number): void {
  const cutoff = now - TTL_MS;
  for (const [key, ts] of failedRuns) {
    if (ts < cutoff) failedRuns.delete(key);
  }
  for (const [key, ts] of succeededRuns) {
    if (ts < cutoff) succeededRuns.delete(key);
  }
  for (const [key, entry] of deliveredRuns) {
    if (entry.at < cutoff) deliveredRuns.delete(key);
  }
}

/**
 * The same facts, read by EXPLICIT run id — for code that runs after the run.
 *
 * Every reader above resolves the key from `getHarnessExecutionContext()`, which
 * exists only INSIDE the run. A caller composing the result afterwards is outside
 * that AsyncLocalStorage, so those functions would answer `false` no matter what
 * happened — the same trap that made `findArtifactIds` fail twice: a run-scoped
 * fact read from a place the run has already left.
 *
 * `run-artifacts` solved it the same way, and this mirrors it deliberately.
 */
export function mcpHandoffFailedForRun(runId: string | undefined): boolean {
  if (!runId) return false;
  prune(Date.now());
  return failedRuns.has(runId);
}

/** Deliverable status this run recorded, or `null` — by explicit id. */
export function automationDeliverableForRun(
  runId: string | undefined,
): AutomationDeliverableStatus | null {
  if (!runId) return null;
  prune(Date.now());
  return deliveredRuns.get(runId)?.status ?? null;
}

/** WS-C-hard — record that the current run produced a deployable deliverable. */
export function markAutomationDeliverable(
  status: AutomationDeliverableStatus,
  details?: Omit<AutomationDeliverableDetails, 'status'>,
): void {
  const key = runKey();
  if (!key) return;
  const now = Date.now();
  prune(now);
  deliveredRuns.set(key, { status, details: { ...(details ?? {}), status }, at: now });
}

/** WS-C-hard — true if the current run already produced a deployable deliverable. */
export function hasAutomationDeliverable(): boolean {
  return getAutomationDeliverableStatus() !== null;
}

/**
 * finalize-on-deliverable — the terminal Golden Path status latched for the current
 * run (tested/draft_created/active), or null. Lets the force-report lever fire on a
 * genuine terminal (tested/active) while leaving `draft_created` room to repair/retest.
 */
export function getAutomationDeliverableStatus(): AutomationDeliverableStatus | null {
  return getAutomationDeliverableDetails()?.status ?? null;
}

/** finalize-on-deliverable — structured facts for deterministic final reports. */
export function getAutomationDeliverableDetails(): AutomationDeliverableDetails | null {
  const key = runKey();
  if (!key) return null;
  const entry = deliveredRuns.get(key);
  if (entry === undefined) return null;
  if (entry.at < Date.now() - TTL_MS) {
    deliveredRuns.delete(key);
    return null;
  }
  return entry.details ?? { status: entry.status };
}

/** Record that a (mandatory) MCP handoff failed for the current architect run. */
export function markMcpHandoffFailed(): void {
  const key = runKey();
  if (!key) return;
  const now = Date.now();
  prune(now);
  failedRuns.set(key, now);
}

/** Clear the failure flag — call after a SUCCESSFUL MCP handoff in the same run. */
export function clearMcpHandoffFailed(): void {
  const key = runKey();
  if (!key) return;
  failedRuns.delete(key);
}

/** WS-J — record that a real, verified MCP handoff SUCCEEDED for the current run. */
export function markMcpHandoffSucceeded(): void {
  const key = runKey();
  if (!key) return;
  const now = Date.now();
  prune(now);
  succeededRuns.set(key, now);
}

/** WS-J — true if the current run had at least one successful MCP handoff. */
export function hasSuccessfulMcpHandoff(): boolean {
  const key = runKey();
  if (!key) return false;
  const ts = succeededRuns.get(key);
  if (ts === undefined) return false;
  if (ts < Date.now() - TTL_MS) {
    succeededRuns.delete(key);
    return false;
  }
  return true;
}

/** True if the current run has an unresolved failed MCP handoff. */
export function isMcpHandoffFailed(): boolean {
  const key = runKey();
  if (!key) return false;
  const ts = failedRuns.get(key);
  if (ts === undefined) return false;
  if (ts < Date.now() - TTL_MS) {
    failedRuns.delete(key);
    return false;
  }
  return true;
}

/** WS-G gate is on by default; set FEATURE_MCP_HANDOFF_GATE=false to disable. */
export function mcpHandoffGateEnabled(): boolean {
  return process.env.FEATURE_MCP_HANDOFF_GATE !== 'false';
}

// ── finalize-on-deliverable ──────────────────────────────────────────────────
// Shared policy used by all three finalize levers (completion scorer + prepareStep
// force-report + stopWhen backstop) so they never drift. Kept here (no heavy deps)
// to avoid a cycle with delegate-task.ts (which sits downstream of the harness).

/** finalize-on-deliverable is ON by default; set the flag to false to revert. */
export function automationFinalizeEnabled(): boolean {
  return isHarnessFeatureEnabled('FEATURE_AUTOMATION_FINALIZE_ON_DELIVERABLE', true);
}

/**
 * True when `text` is a terminal automation report that will also pass the delegation
 * text-contract (`isAutomationArchitectContractComplete` in delegate-task.ts): a
 * terminal status word, plus `automationId`+`workflowId` for non-blocked terminals.
 * Kept in lockstep with that contract so finalizing here never yields a false-failed
 * delegation. The latch (tested/draft/active) is what makes this safe to act on.
 */
export function looksLikeAutomationReport(text: string | undefined | null): boolean {
  if (!text) return false;
  if (!/\b(blocked|draft_created|tested|active|manual_review_required)\b/i.test(text)) return false;
  if (/\b(blocked|manual_review_required)\b/i.test(text)) return true;
  const lower = text.toLowerCase();
  return lower.includes('automationid') && lower.includes('workflowid');
}

/**
 * Heuristic: does the user's brief ask the architect to ACTIVATE the workflow? Used to
 * keep the force-report lever from cutting off a legitimate activation when the run is
 * only at `tested` (built+mock-tested, not yet active).
 */
export function briefRequiresActivation(prompt: string | undefined | null): boolean {
  if (!prompt) return false;
  if (!/\b(activate|activation|włącz|wlacz|enable|uruchom)\b/i.test(prompt)) return false;
  const negated =
    /\b(nie aktyw|don'?t activate|do not activate|bez aktyw|nie włącz|nie wlacz|nie włączaj|nie wlaczaj|inactive|nie uruchamiaj|tylko zbuduj|only build|just build)\b/i
      .test(prompt);
  return !negated;
}

/**
 * Does the brief ask for a test against REAL credentials / real data?
 *
 * Mirrors `briefRequiresActivation`: the same "the caller asked for one more
 * step, so do not finalize on top of them" rule, applied to execution instead of
 * activation. Measured 2026-08-24: a brief whose definition of done read "you ran
 * an end-to-end test against real credentials and real data, and the numbers must
 * match what is actually in `agent_runs`" was finalized on a passing MOCK, and
 * the run ended naming the real test as a "next step" it never took.
 */
export function briefRequiresRealTest(prompt: string | undefined | null): boolean {
  if (!prompt) return false;
  // The Polish arms end in `\w*`, not a bare stem: an inflected "prawdziwych
  // DANYCH" leaves the trailing `\b` sitting inside the word, so a stem-only
  // alternative silently never matches.
  const wantsReal =
    /\b(real[-\s]?credentials?|real data|end[-\s]?to[-\s]?end|e2e|live (?:test|run|data)|prawdziw\w*\s+(?:dan\w*|credential\w*|test\w*)|na żywo|na zywo|realn\w*\s+(?:dan\w*|test\w*))\b/i
      .test(prompt);
  if (!wantsReal) return false;
  const negated =
    /\b(mock only|only mock|no real (?:test|run|execution)|do not (?:run|execute)|don'?t (?:run|execute)|bez (?:realnego|prawdziwego) (?:testu|uruchomienia)|tylko mock|nie uruchamiaj)\b/i
      .test(prompt);
  return !negated;
}

/**
 * Should the prepareStep force-report lever fire for the latched status?
 *  - `active`        → yes (activation already done).
 *  - `tested`        → yes UNLESS the brief still wants a step this run has not
 *                      taken: activation, or a real-credentials test that has so
 *                      far only been mocked. Finalizing on top of either is the
 *                      over-iteration guard cutting off requested work.
 *  - `draft_created` → no (deploy succeeded but test was inconclusive — leave room to
 *                      repair/retest rather than reporting a half-built workflow).
 *
 * `testMode` is optional on purpose: a caller that cannot say how the test ran
 * keeps the previous behaviour, so this narrows the lever only where the evidence
 * to narrow it exists.
 */
export function shouldForceAutomationReport(
  status: AutomationDeliverableStatus | null,
  prompt: string | undefined | null,
  testMode?: AutomationDeliverableDetails['testMode'],
): boolean {
  if (status === 'active') return true;
  if (status !== 'tested') return false;
  if (briefRequiresActivation(prompt)) return false;
  if (testMode && testMode !== 'real_credentials' && briefRequiresRealTest(prompt)) return false;
  return true;
}

export function formatAutomationDeliverableReport(details: AutomationDeliverableDetails): string {
  const activeState = details.status === 'active' ? 'active=true' : 'active=false';
  const lines = [
    '## ✅ Automation workflow delivered',
    '',
    `status: ${details.status}`,
    `automationId: ${details.automationId ?? 'unknown'}`,
    `workflowId: ${details.workflowId ?? 'unknown'}`,
    `workflowName: ${details.workflowName ?? 'unknown'}`,
    `n8n active state: ${activeState}`,
    details.riskScore !== undefined
      ? `risk: ${details.riskScore}${details.riskVerdict ? ` (${details.riskVerdict})` : ''}`
      : undefined,
    details.message ? `message: ${details.message}` : undefined,
  ].filter((line): line is string => typeof line === 'string');

  const missingConfig = Array.isArray(details.missingConfig) ? details.missingConfig : [];
  const missingCredentials = Array.isArray(details.missingCredentials) ? details.missingCredentials : [];
  if (missingConfig.length > 0 || missingCredentials.length > 0) {
    lines.push('', '### To fill in before real activation/use');
    for (const item of missingConfig) lines.push(`- config: ${formatMissingItem(item)}`);
    for (const item of missingCredentials) lines.push(`- credential: ${formatMissingItem(item)}`);
  }

  if (details.status === 'tested') {
    lines.push('', 'The workflow was deployed as an inactive n8n draft and passed validation/testing. It was not activated.');
  }

  return lines.join('\n');
}

function formatMissingItem(item: unknown): string {
  if (!item || typeof item !== 'object') return String(item);
  const record = item as Record<string, unknown>;
  const key = record.key ?? record.service ?? record.nodeName ?? 'unknown';
  const description = record.description ?? record.setupHint ?? record.message;
  const required = record.required === true ? 'required' : 'optional';
  return description ? `${String(key)} (${required}) — ${String(description)}` : `${String(key)} (${required})`;
}
