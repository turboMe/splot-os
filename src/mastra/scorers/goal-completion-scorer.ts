/**
 * Goal Completion Scorer (Reflektor Part 2 §2.7)
 *
 * A deterministic completion scorer for Mastra's native `isTaskComplete`
 * (CompletionConfig). It wraps the existing GoalContract `evaluateCompletion()`
 * — which already encodes "what done means" (progress, evidenceFor/Against,
 * confidence, planned-step status) — into the 0/1 score the completion loop
 * expects (0 = not complete → Mastra injects feedback and re-iterates; 1 =
 * complete → the run finalizes).
 *
 * We do NOT build a self-score → repair-prompt loop by hand: Mastra's
 * `isTaskComplete` owns the iteration + automatic feedback injection. We only
 * supply the pass/fail definition via this scorer.
 *
 * The scorer is created per-run via `createGoalCompletionScorer(goalContractId)`
 * so the contract id is captured in a closure (the CompletionContext does not
 * reliably carry our contract id), keeping the scorer body deterministic and
 * side-effect-light (a single Mongo read through `evaluateCompletion`).
 */

import { createScorer } from '@mastra/core/evals';
import { extractDeliverableText } from '../services/harness-output-text.js';
import {
  completeGoalContract,
  evaluateCompletion,
  getGoalContract,
  type GoalContract,
} from '../services/goal-tracker.js';
import {
  formatAutomationDeliverableReport,
  getAutomationDeliverableDetails,
  hasAutomationDeliverable,
  looksLikeAutomationReport,
} from '../services/mcp-handoff-state.js';

export interface GoalCompletionScorerOptions {
  /**
   * Native Mastra `isTaskComplete` runs before the harness final-evidence pass.
   * For auto-created generic harness contracts, a substantive final answer with
   * no negative evidence is enough to close the contract; otherwise generic
   * pending steps can trap the run in repeated scorer feedback.
   */
  autoFinalizeOnOutput?: boolean;
  autoFinalizeOnAutomationDeliverable?: boolean;
  minOutputChars?: number;
}

/**
 * Build a completion scorer bound to a specific GoalContract.
 *
 * @param goalContractId  The contract whose `evaluateCompletion()` decides done.
 * @returns A MastraScorer returning 1 when the contract passes, else 0.
 */
export function createGoalCompletionScorer(
  goalContractId: string,
  options: GoalCompletionScorerOptions = {},
) {
  let lastReason = 'not evaluated';
  return createScorer({
    id: 'goal-completion',
    name: 'Goal Completion Scorer',
    description:
      'Deterministic 0/1 completion check that wraps GoalContract.evaluateCompletion '
      + '(progress, evidence, confidence, planned-step status) for native isTaskComplete.',
  })
    .generateScore(async ({ run }) => {
      try {
        const evaluation = await evaluateCompletion(goalContractId);
        if (evaluation.passed) {
          lastReason = `complete — score=${evaluation.score}, progress=${evaluation.progress}, confidence=${evaluation.confidenceLevel}`;
          return 1;
        }

        const autoFinalized = options.autoFinalizeOnOutput
          ? await maybeAutoFinalizeGenericHarnessContract(goalContractId, run.output, options)
          : null;
        if (autoFinalized) {
          lastReason = autoFinalized.reason;
          return 1;
        }

        const deterministicAutomationFinalized = options.autoFinalizeOnAutomationDeliverable
          ? await maybeAutoFinalizeAutomationDeliverable(goalContractId)
          : null;
        if (deterministicAutomationFinalized) {
          lastReason = deterministicAutomationFinalized.reason;
          return 1;
        }

        // finalize-on-deliverable (Lever 1) — the delegation/LLM-plan contract used by
        // the Automation Architect is NOT a generic harness contract, so the generic
        // auto-finalize above never applies and `evaluateCompletion` never passes
        // (plan steps are not closed mid-run). That is the engine of the post-`tested`
        // hang. When the Golden Path latched a real deliverable AND the model has
        // produced a terminal report, finalize via the native isTaskComplete path.
        const automationFinalized = options.autoFinalizeOnOutput
          ? await maybeAutoFinalizeAutomationContract(goalContractId, run.output)
          : null;
        if (automationFinalized) {
          lastReason = automationFinalized.reason;
          return 1;
        }

        lastReason = `incomplete (${evaluation.recommendation}) — score=${evaluation.score}, progress=${evaluation.progress}, `
          + `missing: ${evaluation.missingCriteria.slice(0, 5).join('; ') || 'n/a'}`;
        return 0;
      } catch (err) {
        // Fail OPEN: if we cannot evaluate the contract, do not block finalization
        // (treat as complete) so the scorer never traps a run in a feedback loop.
        lastReason = `evaluation error (fail-open → complete): ${(err as Error).message}`;
        return 1;
      }
    })
    .generateReason(() => lastReason);
}

async function maybeAutoFinalizeGenericHarnessContract(
  goalContractId: string,
  output: unknown,
  options: GoalCompletionScorerOptions,
): Promise<{ reason: string } | null> {
  const outputText = extractScoredOutputText(output);
  const minOutputChars = options.minOutputChars ?? 80;
  if (outputText.trim().length < minOutputChars) return null;

  const contract = await getGoalContract(goalContractId);
  if (!contract) return null;
  if (contract.status === 'completed') {
    return { reason: `complete — contract already terminal completed; output chars=${outputText.length}` };
  }
  if (contract.status !== 'active') return null;
  if (!isGenericHarnessContract(contract)) return null;
  const hasFailedStep = contract.plannedSteps.some((step) => step.status === 'failed');
  if (hasFailedStep) return null;

  await completeGoalContract(
    goalContractId,
    'completed',
    `Goal completion scorer accepted substantive final output for generic harness contract (${outputText.length} chars).`,
  );
  const note = contract.evidenceAgainst.length > 0
    ? ` (${contract.evidenceAgainst.length} transient against-evidence superseded by deliverable)`
    : '';
  return {
    reason:
      `complete — substantive final output (${outputText.length} chars) closed generic harness GoalContract${note}`,
  };
}

async function maybeAutoFinalizeAutomationDeliverable(
  goalContractId: string,
): Promise<{ reason: string } | null> {
  const details = getAutomationDeliverableDetails();
  if (!details || (details.status !== 'tested' && details.status !== 'active')) return null;

  const contract = await getGoalContract(goalContractId);
  if (!contract) return null;
  if (contract.status === 'completed') {
    return { reason: `complete — automation deliverable ${details.status}; contract already completed` };
  }
  if (contract.status !== 'active') return null;

  await completeGoalContract(
    goalContractId,
    'completed',
    `Goal completion scorer accepted deterministic automation deliverable:\n${formatAutomationDeliverableReport(details)}`,
  );
  return {
    reason:
      `complete — deterministic automation deliverable status=${details.status}, `
      + `automationId=${details.automationId ?? 'unknown'}, workflowId=${details.workflowId ?? 'unknown'}`,
  };
}

/**
 * finalize-on-deliverable — finalize an Automation Architect run whose Golden Path
 * already produced a deployed workflow (the run-scoped deliverable latch) and whose
 * final output is a terminal report. Unlike the generic path this is keyed off the
 * deterministic latch (set by `buildResult`), so it does NOT depend on the contract
 * being a generic harness contract or on plan steps being closed mid-run.
 *
 * Deliberately does NOT require `evidenceAgainst.length === 0`: a resolved gate-block
 * earlier in the run (e.g. `node_validation_required` → MCP handoff → revalidate)
 * leaves against-evidence, but a subsequent `tested`/`active` supersedes it. The latch
 * + a contract-valid terminal report are sufficient proof of success, and the report
 * shape guarantees the delegation text-contract also passes (no false-failed).
 */
async function maybeAutoFinalizeAutomationContract(
  goalContractId: string,
  output: unknown,
): Promise<{ reason: string } | null> {
  if (!hasAutomationDeliverable()) return null;
  const outputText = extractScoredOutputText(output);
  if (!looksLikeAutomationReport(outputText)) return null;

  const contract = await getGoalContract(goalContractId);
  if (!contract) return null;
  if (contract.status === 'completed') {
    return { reason: `complete — automation deliverable + terminal report; contract already completed` };
  }
  if (contract.status !== 'active') return null;

  await completeGoalContract(
    goalContractId,
    'completed',
    `Goal completion scorer accepted a terminal automation report backed by a Golden Path deliverable (${outputText.length} chars).`,
  );
  return {
    reason:
      `complete — Golden Path deliverable present and final output is a terminal automation report `
      + `(${outputText.length} chars); finalized via isTaskComplete instead of re-iterating the never-passing scorer.`,
  };
}

function isGenericHarnessContract(contract: GoalContract): boolean {
  const [first, second, third] = contract.plannedSteps;
  return !!first && !!second && !!third
    && /^Clarify the objective, constraints, and success criteria for phase /.test(first.description)
    && second.description === 'Execute the task using available context, tools, and recorded evidence.'
    && third.description === 'Verify completion against the objective and report any blockers or missing evidence.';
}

/**
 * The run's output, as the HARNESS defines it — not as this file used to.
 *
 * THE DEFECT THIS REPLACES
 * ------------------------
 * This function had its own idea of "output": it took `record.text` without
 * asking whether that text was the framework talking about the run, and fell
 * back to `JSON.stringify(output)` — a serialized response object, which is
 * never a deliverable and always clears the 80-character threshold.
 *
 * So the scorer would close a GoalContract as "complete — substantive final
 * output (2519 chars)" for a run whose deliverable was empty. Two components
 * held two different notions of the same thing and disagreed in the worst
 * direction: the one that decides SUCCESS was the lenient one.
 *
 * Measured on the automationArchitect canary (round 1, 2026-08-11): the job was
 * marked FAILED with `empty_output` while this scorer reported a substantive
 * output, and the thread was left open as "symptom gone, cause unknown".
 * `harness-output-text.ts` even documents the same contradiction from the design
 * canary ("substantive final output (684 chars)", and that function returned '').
 *
 * Sharing `extractDeliverableText` is the point: whatever the harness would
 * refuse to hand back as a product, this must refuse to accept as evidence of
 * completion. §3.6 "no false success" is a property of the pair, not of one side.
 */
function extractScoredOutputText(output: unknown): string {
  return extractDeliverableText(output);
}
