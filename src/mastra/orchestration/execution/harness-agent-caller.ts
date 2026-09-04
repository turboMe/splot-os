/**
 * Harness-backed ModelCaller — runs a V2 attempt through `generateWithHarness`
 * instead of a bare `agent.generate`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `createMastraAgentCaller` (the original seam) calls `agent.generate(prompt,
 * {abortSignal})` directly. That is deliberately minimal and correct for
 * fixtures, but it means a registered agent running as a V2 worker loses
 * *everything* the legacy delegation path gives it:
 *
 *   - adaptive depth profile (maxSteps / model tier)
 *   - Strategy Reflector (`prepareStep` loop + scope-creep detection)
 *   - liveness budget (cut on silence, not on working too long)
 *   - pending user-message consumption (an interrupt mid-run)
 *   - tool envelopes, capability-gap detection, goal evidence
 *
 * So migrating a real capability onto V2 with the bare caller would be a
 * REGRESSION against the protections `CAN-002`/`HRN-002` just verified on the
 * legacy path. This caller closes that gap so a V2 job is at least as well
 * governed as a legacy delegation.
 *
 * BUDGET NESTING (the K3/K4 rule, applied here)
 * ---------------------------------------------
 * The gateway owns the outer bound: it aborts at `businessOperationCutoffAt`
 * and races its own explicit reject, so a non-cooperative caller cannot hang
 * it. The harness installs its OWN timeout on top of whatever it is given, so
 * handing it the *same* instant would mean two timers for one deadline. The
 * harness therefore gets `remaining - reserve`: strictly inside the parent
 * window, leaving the reserve for its own wrap-up (events, artifacts, goal
 * evidence) to land before the gateway cuts the call. Same invariant F3
 * enforced for sync delegation: a child deadline never exceeds what the parent
 * can survive.
 *
 * The gateway's signal is forwarded as `abortSignal`, so a parent/deadline
 * abort still stops the underlying generation — and because the harness now
 * detects Mastra's silent `finishReason: 'tripwire'` resolve (see F3), an
 * aborted V2 attempt surfaces as a real rejection instead of an empty success.
 */
import type { Agent } from '@mastra/core/agent';
import { generateWithHarness } from '../../services/generate-with-harness.js';
import { recordDistillationCandidate } from '../../services/skill-distiller.js';
import type { WorkerContext } from '../store/worker.js';
import type { ModelCaller } from './gateway.js';
import type { RegistryAgent } from './registry-worker.js';
import { describeEmptyDeliverable, extractDeliverableText, findArtifactIds } from '../../services/harness-output-text.js';
import { clearRunArtifacts, getRunArtifacts } from '../../services/run-artifacts.js';
import { agentBoard } from '../../config/agent-board.js';
import {
  DEFAULT_IDLE_FLOOR_MS, IDLE_FLOOR_BY_LATENCY, SIDE_EFFECT_PRODUCT_CAPABILITIES,
} from '../../config/capability-routing.js';
import { setRunLivenessHardCapAt } from '../../services/run-budget.js';
import { detectWriterProgressCandidates } from './writer-progress.js';
import type { ProgressiveAttemptPolicy } from '../contracts/execution-budget.js';
import type { ProducerArtifactRef } from '../contracts/result-envelope.js';
import { precontextForCapability } from './capability-precontext.js';
import { auditArtifactClaims } from './artifact-claim-guard.js';
import {
  automationDeliverableForRun, mcpHandoffFailedForRun,
} from '../../services/mcp-handoff-state.js';
import { countForbiddenWriterEmDashes, normalizeOutboundDashes } from '../../tools/writer/anti-slop.js';

/**
 * Left for the harness to finish its own bookkeeping inside the gateway window.
 * Deliberately generous relative to a store CAS: this covers event writes,
 * output compaction and goal-evidence recording, not a single round-trip.
 */
const DEFAULT_HARNESS_RESERVE_MS = 2_000;

/** Never hand the harness a non-positive or absurdly short window. */
const MIN_HARNESS_TIMEOUT_MS = 1_000;

/**
 * The memory resource every V2 run shares. Deliberately NOT per-agent — see the
 * note at its use site: a run may delegate, and the inner agent must be allowed
 * to read the same conversation.
 */
export const V2_MEMORY_RESOURCE = 'orch-v2';

function positiveEnvMs(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Full model text, NOT `outputPreview` — that one is truncated to 1000 chars,
 * which would silently corrupt any `structured` result envelope larger than
 * that (the A boundary would reject valid JSON as `invalid_result`).
 *
 * The fallback keeps its place for the empty-response case, but a framework
 * artifact never reaches it: an empty result fails the attempt visibly, which is
 * strictly better than committing a status report as the deliverable.
 */
function fullResponseText(response: unknown, fallback: string): string {
  // Via the harness's own deliverable selector, NOT `response.text`: the
  // framework appends its `isTaskComplete` report after the last iteration, and
  // reading the raw field committed "✅ The task is complete" as a job's result
  // on live traffic. Reading the field directly here would have quietly
  // reintroduced exactly that, since this is the value the A boundary freezes.
  const deliverable = extractDeliverableText(response);
  if (deliverable.length === 0 && fallback.length === 0) {
    // The attempt is about to fail with nothing to show. Record WHICH candidate
    // was rejected — "empty output" looks the same for every cause, and three
    // separate investigations have gone down the wrong path for want of this
    // one line.
    console.warn(`[orch-v2] run produced no deliverable — ${describeEmptyDeliverable(response)}`);
  }
  return deliverable.length > 0 ? deliverable : fallback;
}

/**
 * The house punctuation rule, applied to a finished deliverable.
 *
 * This used to THROW for `writerAgent`, on the reasoning that punctuation is that
 * agent's own product quality. Measured on the seven-agent sieve run: a 150-word
 * story came back with one em-dash, the attempt failed, the retry failed the same
 * way, and the JOB ended FAILED with nothing to show. The user lost the story over
 * one character — while the ban was already stated three times in writer's own
 * prompts AND in the global house style, so "ask again" had been exhausted.
 *
 * A failed attempt is also RETRIED, which means the model is paid to regenerate a
 * whole manuscript because of a dash. Normalizing costs one character and keeps
 * the work; the anti-slop audit still scores the text, so quality is not being
 * waved through, only rescued from a disproportionate penalty.
 */
function enforceWriterOutputPunctuation(agentId: string, text: string): string {
  if (agentId !== 'writerAgent') return text;
  const found = countForbiddenWriterEmDashes(text);
  if (found === 0) return text;
  console.warn(
    `[orch-v2] writerAgent produced ${found} forbidden em-dash(es) despite the house style — `
    + 'normalized rather than failing the attempt',
  );
  return normalizeOutboundDashes(text);
}

export interface HarnessCallerArgs {
  agent: RegistryAgent;
  agentId: string;
  ctx: WorkerContext;
  progressPolicy?: ProgressiveAttemptPolicy;
}

export function createHarnessAgentCaller(args: HarnessCallerArgs): ModelCaller {
  return async ({ prompt, classificationPrompt, signal, reportProgress }) => {
    // Evidence for the skill distiller, gathered as the run goes because it is
    // not recoverable afterwards: V2 has no result envelope to read lessons from.
    let toolCallsThisRun = 0;
    let sawToolError = false;
    let recoveredFromError = false;

    const reserveMs = positiveEnvMs('ORCHESTRATION_V2_HARNESS_RESERVE_MS') ?? DEFAULT_HARNESS_RESERVE_MS;
    const now = Date.now();
    const remainingMs = args.ctx.businessOperationCutoffAt.getTime() - now;
    const absoluteCutoffAt = args.progressPolicy
      ? args.ctx.absoluteWorkDeadlineAt
        ?? args.ctx.absoluteHardDeadlineAt
        ?? args.ctx.workDeadlineAt
      : args.ctx.absoluteBusinessOperationCutoffAt
        ?? args.ctx.businessOperationCutoffAt;
    const absoluteRemainingMs = absoluteCutoffAt.getTime() - now;
    // The attempt's absolute bound, passed as a HARD CAP rather than a wall clock.
    //
    // Passing `timeoutMs` here is what made liveness unreachable for every V2 job
    // ever run: `generateWithHarness` treats an explicit timeout as "this exact
    // budget" and disables liveness, whatever the flag says. So a design attempt
    // that was WORKING — calling tools, taking screenshots — was cut at 894s by a
    // clock that cannot tell work from a hang.
    //
    // As a hard cap the number means the same thing while the flag is off (it
    // becomes the wall clock), and under liveness it becomes the backstop while
    // silence does the cutting. The gateway keeps its own outer abort on
    // `businessOperationCutoffAt`; the reserve is what stops the two racing.
    const hardCapMs = Math.max(MIN_HARNESS_TIMEOUT_MS, absoluteRemainingMs - reserveMs);
    const initialHardCapMs = Math.max(MIN_HARNESS_TIMEOUT_MS, remainingMs - reserveMs);

    // How long this specialist may legitimately go quiet, derived from the same
    // `latencyClass` that sets its attempt window. Read from the agent id rather
    // than frozen onto the task: a capability IS a board id, so the floor is a
    // pure function of it and cannot drift between plan time and dispatch.
    const idleTimeoutMs = IDLE_FLOOR_BY_LATENCY[agentBoard[args.agentId]?.latencyClass ?? '']
      ?? DEFAULT_IDLE_FLOOR_MS;
    let currentProgressWorkDeadlineAt = args.ctx.workDeadlineAt.getTime();

    // The domain precontext this capability gets on its LEGACY path, if it has
    // one. Empty for everyone else, so their call is unchanged. Without this,
    // V2 was strictly worse than legacy for the four agents with a dedicated
    // harness — it gave them depth and liveness while taking away the facts they
    // work from (for automation: which credentials exist, which patterns worked,
    // which failures are already known).
    const precontextFields = await precontextForCapability(args.agentId);

    const result = await generateWithHarness({
      // The registry resolves agents out of the running Mastra instance, so this
      // IS a real Agent; `RegistryAgent` is only the structural type the worker
      // module uses to avoid a hard @mastra/core dependency.
      agent: args.agent as unknown as Agent,
      agentId: args.agentId,
      prompt,
      ...(classificationPrompt ? { classificationPrompt } : {}),
      // A V2 job is a generic agentic turn, not a coding/automation sub-phase.
      phase: 'chat',
      // Nobody is reading this run and nobody will answer it — the same fact the
      // headless output contract states in prose, told to the harness so it can
      // act on it. Its one effect is to withhold the tools that SUSPEND for human
      // approval: Mastra's answer to `requireApproval` is to stop the agent, and
      // a stopped agent in a durable job is a lease that expires rather than a
      // question anyone sees.
      headless: true,
      taskId: args.ctx.taskId,
      // Per-JOB thread: retries of the same job continue one conversation,
      // while `runId` stays per-attempt so telemetry can still separate them.
      threadId: `orch-v2-job:${args.ctx.jobId}`,
      runId: args.ctx.attemptId,
      // Canary isolation: V2 memory is scoped away from the legacy per-agent
      // resource, so a misbehaving V2 attempt cannot pollute the production
      // agent's memory while this path is still flag-gated.
      //
      // ONE resource for the whole lane, NOT `orch-v2:<agentId>`. A specialist
      // may delegate inside its own run — chefAgent's recon phase reaches for
      // the researcher — and with a per-agent resource the inner agent's memory
      // processor rejected the outer agent's messages outright:
      //   "wrong resourceId. Input orch-v2:chefAgent, expected orch-v2:researcherAgent"
      // Three attempts failed with empty output and the job ended FAILED. A job
      // is one conversation, so its memory is one resource; the per-job thread
      // below is what actually separates jobs.
      memoryResource: V2_MEMORY_RESOURCE,
      // Spread AFTER `memoryResource`: the precontext brings only its own four
      // fields, and V2 keeps its own memory scoping (see the note above).
      ...precontextFields,
      hardCapMs,
      ...(args.progressPolicy
        ? { initialHardCapMs }
        : {}),
      idleTimeoutMs,
      // V2 opts in on its own evidence, WITHOUT the global flag: that one would
      // also move review/coding/knowledge/automation onto liveness in the same
      // instant, and none of their gaps have been measured. Three design runs
      // measured 48.3s / 99.7s / 61.1s against a 240s floor; that is what this
      // switch is backed by, and nothing more.
      preferLiveness: process.env.FEATURE_ORCHESTRATION_V2_LIVENESS === 'true',
      abortSignal: signal,
      // ALWAYS observed, for every agent.
      //
      // This hook used to exist only for `writerAgent` under a progress policy,
      // and the distillation counters were put inside it — so they read 0 for
      // every other agent. A codingAgent run that made 19 real tool calls
      // reported `toolCalls=0`, and only the diagnostic line said so; the gate
      // asserting the counters were "wired" was perfectly happy, because they
      // were wired to a hook nothing handed to this agent.
      //
      // The writer-progress work stays behind its own condition BELOW, where it
      // belongs — the observation itself is not writer-specific.
      onStepObservation: async (observation) => {
        toolCallsThisRun += observation.toolCalls.length;
        if (observation.toolResults.some((r) => r.isError)) sawToolError = true;
        else if (sawToolError) recoveredFromError = true;

        if (!(args.agentId === 'writerAgent' && reportProgress && args.progressPolicy)) return;
        for (const milestone of detectWriterProgressCandidates(observation)) {
          // A snapshot may finish immediately before the currently earned
          // business cutoff. Give its already-started authoritative CAS
          // only the existing A window to return; the gateway applies the
          // same nested grace and still owns the outer abort.
          setRunLivenessHardCapAt(
            args.ctx.attemptId,
            currentProgressWorkDeadlineAt,
          );
          const report = await reportProgress(milestone);
          let livenessSync: ReturnType<typeof setRunLivenessHardCapAt> | undefined;
          if (
            report.reason !== 'stale_authority_or_cutoff'
            && report.reason !== 'closed'
          ) {
            // A live duplicate is the idempotent response to an accepted
            // write whose first reply may have been lost. Synchronize the
            // inner liveness watchdog just like the outer gateway, without
            // counting it as another earned extension.
            currentProgressWorkDeadlineAt = Math.max(
              currentProgressWorkDeadlineAt,
              report.workDeadlineAt,
            );
            livenessSync = setRunLivenessHardCapAt(
              args.ctx.attemptId,
              report.businessOperationCutoffAt - reserveMs,
            );
          }
          if (report.accepted) {
            const liveness = livenessSync!;
            console.log(
              `[orch-v2] writer progress lease extended: attempt=${args.ctx.attemptId} `
              + `kind=${milestone.kind} count=${report.extensionCount}/${args.progressPolicy!.maxExtensions} `
              + `deadline=${new Date(report.businessOperationCutoffAt).toISOString()} `
              + `liveness=${liveness.extended ? 'extended' : liveness.reason ?? 'unchanged'}`,
            );
            break; // at most one earned extension per model step
          }
          if (report.reason !== 'duplicate') break;
        }
      },
    });

    // THE DELIVERABLE IS THE ARTIFACT, when the run stored one.
    //
    // Picking the answer out of a run's text fails for any agent that narrates
    // after it delivers: `designAgent` stored a prototype and then said "Now let
    // me verify the design renders correctly:", and that sentence is what the job
    // committed.
    //
    // What the run RECORDED writing comes first; what its last response happens
    // to mention comes second. The scan alone is not enough, and the design
    // canary proved it twice: the harness makes SEVERAL `generate` calls, and the
    // returned one can be a follow-up with `steps=1, toolCalls=0, toolResults=0`.
    // A run wrote a 10 KB prototype and committed the reflector's "Depth
    // re-examination complete…" prose, because the write lived in an earlier
    // response that had already been discarded. The recorded fact survives that;
    // the scan stays as a fallback for writes made outside a harness run context.
    // Read under the runId the harness ACTUALLY used, not the one we asked for.
    // `generateWithHarness` resolves `input.runId ?? input.taskId ?? randomUUID()`,
    // so the two normally agree — but reading the returned value removes a whole
    // class of silent mismatch, and this path has produced three of those already.
    const runId = result.runId ?? args.ctx.attemptId;
    const recorded = getRunArtifacts(runId);
    clearRunArtifacts(runId);
    if (recorded.length === 0 && runId !== args.ctx.attemptId) {
      clearRunArtifacts(args.ctx.attemptId);
    }
    const artifactIds = recorded.length > 0 ? recorded : findArtifactIds(result.response);
    // What the run stored, as references the NEXT step can fetch in full. These
    // travel with the envelope on every path below, including the one where the
    // deliverable is the text: a run can store a file AND narrate it, and the
    // successor needs the id either way. `readUpstreamResults` renders them as
    // "pełna treść pod tymi id" — an offer that was empty for every run ever made,
    // because this caller computed the ids and then dropped them on the floor.
    let artifactRefs: ProducerArtifactRef[] = [];
    if (artifactIds.length > 0) {
      try {
        // Imported lazily so the V2 mount's module graph stays free of the
        // LEGACY Mongo client that `artifact-store` pulls in at load time — the
        // same deferral the mount uses for its other cross-layer imports. (A
        // static import was briefly suspected of stalling the lane; that turned
        // out to be a queue backlog, not this. The deferral is kept on its own
        // merits, not as a fix.)
        const { getArtifact } = await import('../../services/artifact-store.js');
        const lastId = artifactIds[artifactIds.length - 1]!;
        // Content only for the last one — a run that stores several has finished
        // with the latest, and the rest are referenced, not inlined.
        const records = await Promise.all(artifactIds.map(
          (id) => getArtifact(id, id === lastId ? { includeContent: true } : {}).catch(() => null),
        ));
        artifactRefs = records
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .map((r) => ({
            artifactId: r.id,
            type: String(r.type),
            summary: r.summary ?? '',
            ...(r.sha256 ? { hash: r.sha256 } : {}),
          }));
        // Whether the artifact IS the deliverable, or merely a record OF one.
        //
        // For a document producer they are the same thing: designAgent's brief is
        // the file it wrote, and its prose ("plik zapisany jako…") is a note about
        // the work, not the work. Substituting the artifact is exactly right there.
        //
        // For a capability whose product is an effect in the world it is the other
        // way round. Since the Golden Path records the deployed workflow itself,
        // substituting turned a readable "deployed X, id Y, inactive, risk 15"
        // into 3 601 characters of raw workflow JSON — measured on the canary.
        // The workflow is the REFERENCE; the report is the deliverable, and it
        // travels with the reference attached rather than replaced by it.
        const artifactIsTheDeliverable = !SIDE_EFFECT_PRODUCT_CAPABILITIES.has(args.agentId);
        const record = records[records.length - 1];
        if (artifactIsTheDeliverable && record?.content && record.content.trim().length > 0) {
          return {
            text: enforceWriterOutputPunctuation(args.agentId, record.content),
            fromArtifact: true,
            ...(artifactRefs.length > 0 ? { artifacts: artifactRefs } : {}),
          };
        }
      } catch (error) {
        // The store is unreachable — fall through to the text rather than fail
        // an otherwise finished run.
      }
    }
    // `deliverableText` before `outputPreview`: the preview is truncated to 1000
    // chars, and the deliverable is whatever pass actually produced one — a chef
    // run emitted 45 events and then returned a response whose only text was the
    // framework's completion report, so reading the final response alone failed
    // the attempt with nothing while the menu sat in an overwritten one.
    // Audit the report against what the run actually stored. The orchestrator
    // knows the ids; the model's word is not the source. See the guard's header
    // for why this annotates instead of failing the attempt.
    const audited = auditArtifactClaims(
      enforceWriterOutputPunctuation(
        args.agentId,
        fullResponseText(result.response, result.deliverableText || result.outputPreview),
      ),
      artifactRefs.map((ref) => ref.artifactId),
    );
    if (audited.unbackedIds.length > 0 || audited.claimedWithoutStoring) {
      console.warn(
        `[orch-v2] ${args.agentId} claimed an artifact it did not store `
        + `(unbacked: ${audited.unbackedIds.join(', ') || 'none by id'}, `
        + `stored: ${artifactRefs.length}) — the result was annotated`,
      );
    }
    // A mandatory MCP handoff that FAILED must be visible in the result.
    //
    // The Golden Path already refuses to deploy after one (`isMcpHandoffFailed`),
    // and that gate works — measured: nothing reached n8n. What did not work is
    // the STORY: the architect composed the workflow anyway, wrote it to a file
    // and returned a "Raport końcowy" with a node table, and the job closed
    // COMPLETED. Its own prompt tells it to stop and report `blocked`; it did not,
    // and a prompt rule that was already ignored is not the place to fix this.
    //
    // Read by explicit runId, because this code runs AFTER the run and the state
    // module's own readers resolve their key from the execution context.
    const handoffFailed = mcpHandoffFailedForRun(runId);
    const deliverable = automationDeliverableForRun(runId);
    if (handoffFailed) {
      console.warn(
        `[orch-v2] ${args.agentId}: mandatory n8n MCP handoff FAILED in this run `
        + `(deliverable: ${deliverable ?? 'none'}) — the result was annotated`,
      );
    }
    const text = handoffFailed
      ? `${audited.text}\n\n[weryfikacja systemu] Obowiązkowy handoff do n8nMcpEngineer NIE POWIÓDŁ SIĘ `
        + `w tym runie, więc konfiguracja węzłów nie została zweryfikowana przez MCP`
        + `${deliverable ? `; wdrożony stan: ${deliverable}` : ', a Golden Path nie wdrożył niczego'}.`
      : audited.text;

    // A run that succeeded and taught something is a skill candidate.
    //
    // This is the whole learning loop's entry point, and V2 did not have one.
    // `recordDistillationCandidate` had exactly two callers — `delegate-task.ts`
    // (the LEGACY delegation tool) and the capability build path — so every job
    // that ran through durable orchestration taught the system nothing. Nothing
    // failed; the corpus simply stopped growing as work moved onto V2, which is
    // the kind of defect that only shows up as an absence months later.
    //
    // Legacy reads `lessons` out of a result envelope. V2 has no envelope, so the
    // evidence is what the run itself did: how many tools it called, and whether
    // it recovered after a tool error. Both are the triggers `shouldDistill`
    // already recognises — this supplies them, it does not invent a new rule.
    //
    // Fire-and-forget, and failure-swallowing on purpose: bookkeeping must never
    // turn a finished job into a failed one.
    // Say what was decided, either way. "No candidate" and "the hook never ran"
    // look identical from the outside, and telling them apart afterwards is
    // impossible — measured: a COMPLETED job recorded nothing, and only a tool
    // count from the telemetry showed it was 4 calls against a threshold of 5
    // rather than a dead hook.
    console.log(
      `[orch-v2] ${args.agentId}: distillation evidence — toolCalls=${toolCallsThisRun}`
      + `, recovered=${recoveredFromError}`,
    );
    void recordDistillationCandidate({
      taskId: args.ctx.taskId,
      agentId: args.agentId,
      goal: prompt.slice(0, 500),
      toolCallCount: toolCallsThisRun,
      recovered: recoveredFromError,
      resultSummary: text.slice(0, 2000),
    }).catch(() => undefined);

    return {
      text,
      ...(artifactRefs.length > 0 ? { artifacts: artifactRefs } : {}),
    };
  };
}

/** Factory form, for injection into `createRegistryWorker({ makeCaller })`. */
export function harnessCallerFactory(args: HarnessCallerArgs): ModelCaller {
  return createHarnessAgentCaller(args);
}
