/**
 * Unit check — Reflektor Part 2 §2.7: goalContractScorer.
 *
 * Verifies the deterministic `createGoalCompletionScorer` 0/1 mapping WITHOUT
 * running a full agent: it creates a GoalContract in Mongo, runs the scorer
 * against it, and asserts the score reflects `evaluateCompletion`:
 *   - fresh contract (no progress, no evidence) → score 0 (incomplete)
 *   - completed contract (step done + evidenceFor) → score 1 (complete)
 *
 * Mongo-backed: if Mongo is unreachable the check SKIPS (exit 0) rather than
 * failing, so it is safe in CI environments without a database.
 *
 * Run: npx tsx src/mastra/scripts/check-goal-completion-scorer.ts
 */
import assert from 'node:assert/strict';

process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

const { getDb } = await import('../lib/mongo.js');

// ── Mongo reachability gate ──
try {
  const db = await getDb();
  await db.command({ ping: 1 });
} catch (err) {
  console.log(`⏭️  goal-completion-scorer check SKIPPED — Mongo unreachable: ${(err as Error).message}`);
  process.exit(0);
}

const { createGoalCompletionScorer } = await import('../scorers/goal-completion-scorer.js');
const { createGoalContract, getGoalContract, recordEvidence } = await import('../services/goal-tracker.js');
const { runWithHarnessExecutionContext } = await import('../services/harness-execution-context.js');
const { markAutomationDeliverable } = await import('../services/mcp-handoff-state.js');

const originalLog = console.log;
const taskId = `scorer-check-${Date.now()}`;

// Minimal run input — the scorer reads its contract id from the closure, so the
// output value is irrelevant; it only needs to satisfy the ScorerRun shape.
const runInput = { output: 'final answer text' } as any;

try {
  // ── Case 1: fresh contract → incomplete → score 0 ──
  const incomplete = await createGoalContract({
    taskId: `${taskId}-incomplete`,
    agentId: 'check-agent',
    originalGoal: 'Ship a verified feature',
    plannedSteps: [
      { description: 'Implement', targetAgent: 'codingAgent' },
      { description: 'Verify', targetAgent: 'codingAgent' },
    ],
    successCriteria: ['Tests pass', 'Docs updated'],
  });

  const incompleteScorer = createGoalCompletionScorer(incomplete.contractId);
  const incompleteResult = await incompleteScorer.run(runInput);
  assert.equal(incompleteResult.score, 0, `fresh contract must score 0 (incomplete); reason: ${incompleteResult.reason}`);

  // ── Case 2: completed contract → score 1 ──
  const complete = await createGoalContract({
    taskId: `${taskId}-complete`,
    agentId: 'check-agent',
    originalGoal: 'Ship a verified feature',
    plannedSteps: [{ description: 'Implement + verify', targetAgent: 'codingAgent' }],
    successCriteria: ['Tests pass'],
  });

  // Mark the single step done with supporting evidence → high progress + confidence.
  await recordEvidence(complete.contractId, {
    stepId: 'step-1',
    type: 'for',
    description: 'Implementation complete and tests green.',
    stepStatus: 'done',
  });

  const completeScorer = createGoalCompletionScorer(complete.contractId);
  const completeResult = await completeScorer.run(runInput);
  assert.equal(completeResult.score, 1, `completed contract must score 1 (complete); reason: ${completeResult.reason}`);

  // ── Case 3: generic harness contract + substantive output → auto-finalized ──
  const generic = await createGoalContract({
    taskId: `${taskId}-generic-harness`,
    agentId: 'meta-agent',
    originalGoal: 'Produce a read-only analytical report',
    plannedSteps: [
      { description: 'Clarify the objective, constraints, and success criteria for phase "chat".', targetAgent: 'meta-agent' },
      { description: 'Execute the task using available context, tools, and recorded evidence.', targetAgent: 'meta-agent' },
      { description: 'Verify completion against the objective and report any blockers or missing evidence.', targetAgent: 'meta-agent' },
    ],
    successCriteria: ['Report addresses the request'],
  });

  const autoScorer = createGoalCompletionScorer(generic.contractId, {
    autoFinalizeOnOutput: true,
    minOutputChars: 20,
  });
  const autoResult = await autoScorer.run({
    output: 'Final report: the requested read-only analysis is complete and includes the required recommendations.',
  } as any);
  assert.equal(autoResult.score, 1, `generic harness contract should auto-finalize on substantive output; reason: ${autoResult.reason}`);
  const autoContract = await getGoalContract(generic.contractId);
  assert.equal(autoContract?.status, 'completed', 'auto-finalized generic contract should be terminal completed');

  // ── Case 3b: generic harness contract + transient tool error (against-evidence) + substantive output → auto-finalized ──
  const genericWithAgainst = await createGoalContract({
    taskId: `${taskId}-generic-transient-error`,
    agentId: 'meta-agent',
    originalGoal: 'Check recent async delegations and runtime state',
    plannedSteps: [
      { description: 'Clarify the objective, constraints, and success criteria for phase "chat".', targetAgent: 'meta-agent' },
      { description: 'Execute the task using available context, tools, and recorded evidence.', targetAgent: 'meta-agent' },
      { description: 'Verify completion against the objective and report any blockers or missing evidence.', targetAgent: 'meta-agent' },
    ],
    successCriteria: ['Direct answer with evidence'],
  });

  // Record a transient tool failure (e.g. invalid eval or retry) followed by substantive answer
  await recordEvidence(genericWithAgainst.contractId, {
    type: 'against',
    description: 'Tool evidence included 1 failure(s): metaExecuteCommandTool result={"success":false,"stderr":"Cannot find module"}',
  });

  const autoScorer3b = createGoalCompletionScorer(genericWithAgainst.contractId, {
    autoFinalizeOnOutput: true,
    minOutputChars: 20,
  });
  const autoResult3b = await autoScorer3b.run({
    output: 'Weryfikacja zakończona: zbadano historię delegacji w bazie i podano pełny raport końcowy.',
  } as any);
  assert.equal(autoResult3b.score, 1, `generic contract with transient error must auto-finalize on deliverable; reason: ${autoResult3b.reason}`);
  const autoContract3b = await getGoalContract(genericWithAgainst.contractId);
  assert.equal(autoContract3b?.status, 'completed', 'transient-error generic contract should be terminal completed');

  // ── Case 4: Automation Architect deliverable → deterministic auto-finalize ──
  const automation = await createGoalContract({
    taskId: `${taskId}-automation`,
    agentId: 'automationArchitect',
    originalGoal: 'Build and deploy an inactive n8n workflow',
    plannedSteps: [
      { description: 'Validate node configuration', targetAgent: 'automationArchitect' },
      { description: 'Execute the delegated analysis or work using the target agent domain tools and memory.', targetAgent: 'automationArchitect' },
      { description: 'Return a result that satisfies the requested output contract and can be used by the caller.', targetAgent: 'automationArchitect' },
    ],
    successCriteria: ['Workflow reaches tested status'],
  });
  const automationResult = await runWithHarnessExecutionContext(
    { runId: `${taskId}-automation-run` },
    async () => {
      markAutomationDeliverable('tested', {
        automationId: 'auto-check',
        workflowId: 'wf-check',
        workflowName: 'Mastra - Check',
        riskScore: 15,
        riskVerdict: 'approve',
      });
      const scorer = createGoalCompletionScorer(automation.contractId, {
        autoFinalizeOnAutomationDeliverable: true,
      });
      return scorer.run({ output: '' } as any);
    },
  );
  assert.equal(
    automationResult.score,
    1,
    `automation deliverable should auto-finalize even when output text is empty; reason: ${automationResult.reason}`,
  );
  const automationContract = await getGoalContract(automation.contractId);
  assert.equal(automationContract?.status, 'completed', 'automation deliverable contract should be terminal completed');

  // ── Cleanup ──
  const db = await getDb();
  await db.collection('goal_contracts').deleteMany({
    contractId: { $in: [incomplete.contractId, complete.contractId, generic.contractId, genericWithAgainst.contractId, automation.contractId] },
  });
} finally {
  console.log = originalLog;
}

// ── The scorer and the harness must mean the SAME thing by "output" ─────────
//
// This scorer had its own extractor: it took `record.text` without asking
// whether that text was the framework talking about the run, and fell back to
// `JSON.stringify(output)` — a serialized response object, which is never a
// deliverable and always clears the 80-character threshold. So it would close a
// GoalContract as "complete — substantive final output (2519 chars)" for a run
// whose deliverable was empty.
//
// Measured on the automationArchitect canary (round 1, 2026-08-11): the job was
// FAILED with `empty_output` while this scorer called the same run complete. The
// thread sat open as "symptom gone, cause unknown" until 2026-08-18.
//
// §3.6 "no false success" is a property of the PAIR. Whatever the harness would
// refuse to return as a product, this must refuse to accept as proof of success.
{
  const { extractDeliverableText } = await import('../services/harness-output-text.js');
  const frameworkReport = '#### Completion Check Results\n\nOverall: ✅ COMPLETE\n'
    + 'Score: 1 ✅\nReason: the model says it finished. '.repeat(20);

  assert.equal(extractDeliverableText({ text: frameworkReport, steps: [] }), '',
    'the harness refuses framework prose as a deliverable');

  // The scorer must refuse it too — via the shared extractor, not a copy.
  const { readFileSync } = await import('node:fs');
  const scorerRaw = readFileSync('src/mastra/scorers/goal-completion-scorer.ts', 'utf-8');
  // Comments stripped: the doc block above the fix NAMES the old expression, and
  // an assertion that fires on the prose explaining a defect punishes writing it
  // down. (Third time this trap has caught me in this codebase.)
  const scorerSrc = scorerRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
  assert.match(scorerSrc, /return extractDeliverableText\(output\);/,
    'the scorer must use the harness definition of output, not its own');
  assert.ok(!/JSON\.stringify\(output\)/.test(scorerSrc),
    'a serialized response object is not "substantive output" — it always passes any '
    + 'length threshold and turns the completion check into a formality');

  // A real deliverable still counts, or the fix would be a blockade.
  assert.match(
    extractDeliverableText({ text: 'Deployed workflow cvFwxEYsCml4jioA, active=false, risk 15.' }),
    /cvFwxEYsCml4jioA/,
    'genuine output must still close a contract');
}

console.log('✅ goalContractScorer check passed (incomplete→0, complete→1, generic-output→1, automation-deliverable→1)');
process.exit(0);
