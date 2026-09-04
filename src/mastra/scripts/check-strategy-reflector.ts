import assert from 'node:assert/strict';

process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

const { StrategyReflector, isFailureResult, isValidationFailureResult } = await import('../services/strategy-reflector.js');
const { runWithHarnessExecutionContext } = await import('../services/harness-execution-context.js');
const { markAutomationDeliverable } = await import('../services/mcp-handoff-state.js');

function createReflector(
  name: string,
  config: Record<string, unknown> = {},
  originalPrompt = 'original user task',
): InstanceType<typeof StrategyReflector> {
  return new StrategyReflector({
    runId: `check-strategy-reflector-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    agentId: 'check-agent',
    originalPrompt,
    config: {
      warmupSteps: 1,
      maxToolRepetitions: 99,
      maxIdenticalToolRepetitions: 99,
      ...config,
    },
  });
}

function analyzeOneTool(
  reflector: InstanceType<typeof StrategyReflector>,
  input: {
    toolName?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
    stepText?: string;
  } = {},
) {
  const toolName = input.toolName ?? 'check_tool';
  return reflector.analyzeStep({
    agentId: 'check-agent',
    toolCalls: [{ toolName, args: input.args ?? {} }],
    toolResults: [{
      toolName,
      result: input.result ?? { success: true },
      isError: input.isError ?? false,
    }],
    stepText: input.stepText,
  });
}

const originalWarn = console.warn;
console.warn = () => {};

try {
  {
    const reflector = createReflector('tool-loop', { maxToolRepetitions: 4, maxIdenticalToolRepetitions: 4 });
    analyzeOneTool(reflector, { toolName: 'repeat_tool' });
    analyzeOneTool(reflector, { toolName: 'repeat_tool' });
    analyzeOneTool(reflector, { toolName: 'repeat_tool' });
    const decision = analyzeOneTool(reflector, { toolName: 'repeat_tool' });

    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'tool_loop');
  }

  {
    // Test: Identical arguments trigger loop at maxIdenticalToolRepetitions
    const reflector = createReflector('identical-arg-loop', { maxIdenticalToolRepetitions: 3, maxToolRepetitions: 99 });
    analyzeOneTool(reflector, { toolName: 'browser_navigate', args: { url: 'https://example.com/p1' } });
    analyzeOneTool(reflector, { toolName: 'browser_navigate', args: { url: 'https://example.com/p1' } });
    const decision = analyzeOneTool(reflector, { toolName: 'browser_navigate', args: { url: 'https://example.com/p1' } });
    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'tool_loop');
    assert.ok(decision.reason?.includes('identical target') || decision.reason?.includes('identical arguments'));
  }

  {
    // Test: Distinct arguments allow progression without triggering loop
    const reflector = createReflector('distinct-arg-progression', { maxIdenticalToolRepetitions: 3, maxReadToolRepetitions: 25 });
    for (let i = 1; i <= 5; i++) {
      const decision = analyzeOneTool(reflector, { toolName: 'browser_navigate', args: { url: `https://example.com/p${i}` } });
      assert.equal(decision.action, 'continue');
    }
  }

  {
    // Test: evaluateHistory with distinct arguments allows progression
    const reflector = createReflector('eval-history-distinct-args', { maxIdenticalToolRepetitions: 3, maxReadToolRepetitions: 25 });
    const steps = [
      { toolCalls: [{ toolName: 'browser_navigate', args: { url: 'https://example.com/page1' } }] },
      { toolCalls: [{ toolName: 'browser_navigate', args: { url: 'https://example.com/page2' } }] },
      { toolCalls: [{ toolName: 'browser_navigate', args: { url: 'https://example.com/page3' } }] },
      { toolCalls: [{ toolName: 'browser_navigate', args: { url: 'https://example.com/page4' } }] },
      { toolCalls: [{ toolName: 'browser_navigate', args: { url: 'https://example.com/page5' } }] },
    ];
    const decision = reflector.evaluateHistory(steps);
    assert.equal(decision.action, 'continue');
  }

  {
    // Test: evaluateHistory with identical arguments triggers loop
    const reflector = createReflector('eval-history-identical-args', { maxIdenticalToolRepetitions: 3, maxToolRepetitions: 99 });
    const steps = [
      { toolCalls: [{ toolName: 'browser_navigate', args: { url: 'https://example.com/stuck' } }] },
      { toolCalls: [{ toolName: 'browser_navigate', args: { url: 'https://example.com/stuck' } }] },
      { toolCalls: [{ toolName: 'browser_navigate', args: { url: 'https://example.com/stuck' } }] },
    ];
    const decision = reflector.evaluateHistory(steps);
    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'tool_loop');
    assert.ok(decision.reason?.includes('identical target') || decision.reason?.includes('identical arguments'));
  }

  {
    const reflector = createReflector('high-error-rate');
    const decision = reflector.analyzeStep({
      agentId: 'check-agent',
      toolCalls: [
        { toolName: 'first_tool', args: {} },
        { toolName: 'second_tool', args: {} },
        { toolName: 'third_tool', args: {} },
      ],
      toolResults: [
        { toolName: 'first_tool', result: { success: false }, isError: false },
        { toolName: 'second_tool', result: { status: 'error' }, isError: false },
        { toolName: 'third_tool', result: { success: true }, isError: false },
      ],
    });

    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'high_error_rate');
  }

  {
    const reflector = createReflector('direction-instability', { maxDirectionChanges: 1 });
    analyzeOneTool(reflector, {
      toolName: 'system_delegate_task',
      args: { targetAgent: 'codingAgent' },
    });
    analyzeOneTool(reflector, {
      toolName: 'system_delegate_task',
      args: { targetAgent: 'knowledgeAgent' },
    });
    const decision = analyzeOneTool(reflector, {
      toolName: 'system_delegate_task',
      args: { targetAgent: 'automationArchitect' },
    });

    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'direction_instability');
  }

  {
    const reflector = createReflector('delegation-failure', { maxDelegationFailures: 0 });
    const decision = analyzeOneTool(reflector, {
      toolName: 'system_delegate_task',
      args: { targetAgent: 'codingAgent' },
      result: { success: false, error: 'worker failed' },
      isError: false,
    });

    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'delegation_failures');
  }

  {
    const reflector = createReflector('low-confidence');
    const decision = analyzeOneTool(reflector, {
      stepText: 'Nie jestem pewien, czy to zadziała.',
    });

    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'low_confidence');
  }

  // Large workflow JSON is legitimate for automationArchitect and must not
  // consume the reflection budget as scope creep. Other agents retain the guard.
  {
    const largeArgs = { workflow: 'x'.repeat(3_000) };
    const steps = ['one', 'two', 'three'].map((suffix) => ({
      toolCalls: [{ toolName: `workflow_tool_${suffix}`, args: largeArgs }],
      toolResults: [{ toolName: `workflow_tool_${suffix}`, result: { success: true }, isError: false }],
    }));
    const normal = createReflector('scope-creep-normal', { minScopeCreepChars: 1_000 }, 'short prompt');
    assert.equal(normal.evaluateHistory(steps).signal, 'scope_creep', 'normal agents keep scope-creep detection');

    const automation = new StrategyReflector({
      runId: `check-strategy-reflector-scope-creep-automation-${Date.now()}`,
      agentId: 'automationArchitect',
      originalPrompt: 'short prompt',
      config: { warmupSteps: 1, maxToolRepetitions: 99, minScopeCreepChars: 1_000 },
    });
    assert.equal(automation.evaluateHistory(steps).action, 'continue', 'automationArchitect suppresses stateless scope-creep');
    analyzeOneTool(automation, { toolName: 'workflow_tool_one', args: largeArgs });
    analyzeOneTool(automation, { toolName: 'workflow_tool_two', args: largeArgs });
    const incremental = analyzeOneTool(automation, { toolName: 'workflow_tool_three', args: largeArgs });
    assert.equal(incremental.action, 'continue', 'automationArchitect suppresses incremental scope-creep');
  }

  // forbidden_nodes is a real policy error, not a resolvable MCP gate.
  {
    const reflector = createReflector('forbidden-is-error', { maxToolRepetitions: 99 });
    const decision = reflector.evaluateHistory([
      {
        toolCalls: [
          { toolName: 'architect_execute_automation_request', args: { attempt: 1 } },
          { toolName: 'architect_execute_automation_request', args: { attempt: 2 } },
          { toolName: 'architect_execute_automation_request', args: { attempt: 3 } },
        ],
        toolResults: [
          { toolName: 'architect_execute_automation_request', result: { success: false, failureClass: 'forbidden_nodes' } },
          { toolName: 'architect_execute_automation_request', result: { success: false, failureClass: 'forbidden_nodes' } },
          { toolName: 'architect_execute_automation_request', result: { success: false, failureClass: 'forbidden_nodes' } },
        ],
      },
    ]);
    assert.equal(decision.signal, 'high_error_rate', 'repeated forbidden-node attempts must count as errors');
  }

  {
    const reflector = createReflector('max-reflections', {
      maxReflectionsPerRun: 1,
      maxToolRepetitions: 1,
    });
    const firstDecision = analyzeOneTool(reflector, { toolName: 'loop_once' });
    const secondDecision = analyzeOneTool(reflector, { toolName: 'another_loop_once' });

    assert.equal(firstDecision.action, 'inject_reflection');
    assert.equal(firstDecision.signal, 'tool_loop');
    assert.equal(secondDecision.action, 'continue');
  }

  // ── Part 1: stateless evaluateHistory + intervention lever mapping ──

  // tool_loop → injectSystem + dropTools includes the looping tool.
  {
    const reflector = createReflector('eval-tool-loop', { maxToolRepetitions: 3 });
    const steps = [
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
    ];
    const decision = reflector.evaluateHistory(steps);

    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'tool_loop');
    assert.ok(decision.intervention, 'expected an intervention');
    assert.ok(decision.intervention!.injectSystem, 'tool_loop should inject a system reflection');
    assert.deepEqual(decision.intervention!.dropTools, ['repeat_tool']);
  }

  // high_error_rate → injectSystem + forceNoTool.
  {
    const reflector = createReflector('eval-high-error');
    const steps = [
      {
        toolCalls: [
          { toolName: 'a', args: {} },
          { toolName: 'b', args: {} },
          { toolName: 'c', args: {} },
        ],
        toolResults: [
          { toolName: 'a', result: { success: false }, isError: false },
          { toolName: 'b', result: { status: 'error' }, isError: false },
          { toolName: 'c', result: { success: true }, isError: false },
        ],
      },
    ];
    const decision = reflector.evaluateHistory(steps);

    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'high_error_rate');
    assert.equal(decision.intervention!.forceNoTool, true);
    assert.ok(decision.intervention!.injectSystem);
  }

  // No anomaly → continue, no intervention.
  {
    const reflector = createReflector('eval-clean');
    const steps = [
      { toolCalls: [{ toolName: 'tool_one', args: {} }], toolResults: [{ toolName: 'tool_one', result: { success: true }, isError: false }] },
      { toolCalls: [{ toolName: 'tool_two', args: {} }], toolResults: [{ toolName: 'tool_two', result: { success: true }, isError: false }] },
    ];
    const decision = reflector.evaluateHistory(steps);

    assert.equal(decision.action, 'continue');
    assert.equal(decision.intervention, undefined);
  }

  // evaluateHistory is stateless/idempotent: same input → same decision.
  {
    const reflector = createReflector('eval-idempotent', { maxToolRepetitions: 3 });
    const steps = [
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
    ];
    const first = reflector.evaluateHistory(steps);
    const second = reflector.evaluateHistory(steps);

    assert.equal(first.signal, second.signal);
    assert.equal(reflector.interventionCount, 0, 'evaluateHistory must NOT mutate counters');
  }

  // recordIntervention populates triggeredReflections + budget exhaustion.
  {
    const reflector = createReflector('eval-record', { maxToolRepetitions: 3, maxReflectionsPerRun: 1 });
    const steps = [
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
    ];
    const decision = reflector.evaluateHistory(steps);
    assert.equal(reflector.isReflectionBudgetExhausted(), false);

    reflector.recordIntervention(decision, 3);

    assert.equal(reflector.interventionCount, 1);
    assert.equal(reflector.getTriggeredReflections().length, 1);
    assert.equal(reflector.getTriggeredReflections()[0]!.signal, 'tool_loop');
    assert.equal(reflector.isReflectionBudgetExhausted(), true);
  }

  // ── Part 2 §2.3: isFailureResult — structural-first, no free-text false positives ──

  // True failures via structural signals.
  assert.equal(isFailureResult({ success: false }), true, 'success:false is a failure');
  assert.equal(isFailureResult({ status: 'error' }), true, 'status:error is a failure');
  assert.equal(isFailureResult({ status: 'failed' }), true, 'status:failed is a failure');
  assert.equal(isFailureResult({ error: 'boom' }), true, 'error!=null is a failure');
  assert.equal(isFailureResult({ isError: true }), true, 'isError:true is a failure');
  assert.equal(isFailureResult({ type: 'error-text', value: 'nope' }), true, 'error-* envelope is a failure');

  // True failures via small JSON-like strings.
  assert.equal(isFailureResult('{"success":false}'), true, 'JSON string success:false is a failure');
  assert.equal(isFailureResult('{ "status": "error" }'), true, 'JSON string status:error is a failure');

  // NOT failures — successful structured results.
  assert.equal(isFailureResult({ success: true }), false, 'success:true is not a failure');
  assert.equal(isFailureResult({ status: 'ok', failedSteps: 0 }), false, 'failedSteps:0 is not a failure');

  // NOT failures — free-text prose that merely mentions failure/error words.
  assert.equal(isFailureResult('All steps completed, failedSteps: 0, no errors.'), false, 'benign prose is not a failure');
  assert.equal(isFailureResult('Implemented robust error handling and retry logic.'), false, '"error handling" prose is not a failure');
  assert.equal(isFailureResult('The build failed previously but now passes.'), false, 'historical "failed" prose is not a failure');
  assert.equal(isFailureResult('error: none'), false, 'bare "error:" free text is no longer a false positive');

  // NOT failures — non-string / non-object scalars.
  assert.equal(isFailureResult(42), false, 'number is not a failure');
  assert.equal(isFailureResult(null), false, 'null is not a failure');
  assert.equal(isFailureResult(undefined), false, 'undefined is not a failure');

  // Integration: a clean run whose stepText mentions "error handling" must NOT
  // be scored as high_error_rate.
  {
    const reflector = createReflector('eval-no-false-positive');
    const steps = [
      {
        toolCalls: [
          { toolName: 'a', args: {} },
          { toolName: 'b', args: {} },
          { toolName: 'c', args: {} },
        ],
        toolResults: [
          { toolName: 'a', result: 'Added error handling to the parser.', isError: false },
          { toolName: 'b', result: { success: true, failedSteps: 0 }, isError: false },
          { toolName: 'c', result: 'Build failed earlier, now green.', isError: false },
        ],
      },
    ];
    const decision = reflector.evaluateHistory(steps);
    assert.equal(decision.action, 'continue', 'benign results must not trigger high_error_rate');
  }

  // ── Part 2 §2.4: per-signal cooldown/hysteresis ──

  // Same signal respects the cooldown window; a different signal does not.
  {
    const reflector = createReflector('eval-cooldown', {
      maxToolRepetitions: 3,
      maxReflectionsPerRun: 10,
      interventionCooldownSteps: 2,
    });

    // tool_loop fires at step 3 and is recorded.
    const loopDecision = reflector.evaluateHistory([
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
    ]);
    assert.equal(loopDecision.signal, 'tool_loop');
    reflector.recordIntervention(loopDecision, 3);

    // Same signal at step 4 (gap 1 < cooldown 2) → still in cooldown.
    assert.equal(reflector.isSignalInCooldown('tool_loop', 4), true, 'same signal must be in cooldown 1 step later');
    // Step 5 (gap 2 >= cooldown 2) → cooldown elapsed.
    assert.equal(reflector.isSignalInCooldown('tool_loop', 5), false, 'same signal cooldown must elapse after the window');
    // A DIFFERENT signal is never blocked by tool_loop's cooldown.
    assert.equal(reflector.isSignalInCooldown('high_error_rate', 4), false, 'a different signal must not be in cooldown');
  }

  // ── Part 2 §2.2: wrong_tool (succeeds but trivial/empty result) ──

  // Same tool succeeds twice with empty results → wrong_tool + dropTools.
  {
    const reflector = createReflector('eval-wrong-tool', { maxToolRepetitions: 99, warmupSteps: 1 });
    const steps = [
      { toolCalls: [{ toolName: 'search_tool', args: { q: 'x' } }], toolResults: [{ toolName: 'search_tool', result: { results: [] }, isError: false }] },
      { toolCalls: [{ toolName: 'search_tool', args: { q: 'y' } }], toolResults: [{ toolName: 'search_tool', result: { results: [] }, isError: false }] },
    ];
    const offDecision = reflector.evaluateHistory(steps); // flag OFF → no goal trigger
    assert.equal(offDecision.action, 'continue', 'wrong_tool must NOT fire when goal triggers disabled');

    const onDecision = reflector.evaluateHistory(steps, { goalTriggersEnabled: true });
    assert.equal(onDecision.action, 'inject_reflection');
    assert.equal(onDecision.signal, 'wrong_tool');
    assert.deepEqual(onDecision.intervention!.dropTools, ['search_tool']);
    assert.ok(onDecision.intervention!.injectSystem);
  }

  // A tool that returns a substantive result does NOT trigger wrong_tool.
  {
    const reflector = createReflector('eval-wrong-tool-negative', { maxToolRepetitions: 99, warmupSteps: 1 });
    const steps = [
      { toolCalls: [{ toolName: 'search_tool', args: {} }], toolResults: [{ toolName: 'search_tool', result: { results: [{ id: 1 }, { id: 2 }] }, isError: false }] },
      { toolCalls: [{ toolName: 'search_tool', args: {} }], toolResults: [{ toolName: 'search_tool', result: { results: [{ id: 3 }] }, isError: false }] },
    ];
    const decision = reflector.evaluateHistory(steps, { goalTriggersEnabled: true });
    assert.equal(decision.action, 'continue', 'substantive results must not trigger wrong_tool');
  }

  // ── Part 2 §2.1: progress_stall (flat goal progress despite successful tools) ──

  // Flat progress over the window with successful tools → progress_stall.
  {
    const reflector = createReflector('eval-progress-stall', { maxToolRepetitions: 99, warmupSteps: 1, progressStallSteps: 3 });
    const steps = [
      { toolCalls: [{ toolName: 'work_a', args: {} }], toolResults: [{ toolName: 'work_a', result: { ok: true, items: [1] }, isError: false }] },
      { toolCalls: [{ toolName: 'work_b', args: {} }], toolResults: [{ toolName: 'work_b', result: { ok: true, items: [1] }, isError: false }] },
      { toolCalls: [{ toolName: 'work_c', args: {} }], toolResults: [{ toolName: 'work_c', result: { ok: true, items: [1] }, isError: false }] },
    ];
    // 4 samples, all 0.40 → no upward movement across 3 deltas.
    const stalled = reflector.evaluateHistory(steps, {
      goalTriggersEnabled: true,
      progressSamples: [0.4, 0.4, 0.4, 0.4],
    });
    assert.equal(stalled.action, 'inject_reflection');
    assert.equal(stalled.signal, 'progress_stall');
    assert.equal(stalled.intervention!.forceNoTool, true);

    // Rising progress → no stall.
    const moving = reflector.evaluateHistory(steps, {
      goalTriggersEnabled: true,
      progressSamples: [0.1, 0.25, 0.4, 0.6],
    });
    assert.equal(moving.action, 'continue', 'rising progress must not trigger progress_stall');

    // Flat progress but goal triggers OFF → no stall.
    const flagOff = reflector.evaluateHistory(steps, { progressSamples: [0.4, 0.4, 0.4, 0.4] });
    assert.equal(flagOff.action, 'continue', 'progress_stall must NOT fire when goal triggers disabled');
  }

  // ── Part 2 §2.5: hard levers (only on severe signals + when enabled) ──

  // tool_loop just at threshold → soft only (no escalateModel), even when hard levers enabled.
  {
    const reflector = createReflector('eval-hard-soft', { maxToolRepetitions: 3 });
    const steps = [
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
    ];
    const decision = reflector.evaluateHistory(steps, { hardLeversEnabled: true });
    assert.equal(decision.signal, 'tool_loop');
    assert.equal(decision.intervention!.escalateModel, undefined, 'mild loop must not escalate the model');
    assert.deepEqual(decision.intervention!.dropTools, ['repeat_tool'], 'mild loop still drops the looping tool (soft)');
  }

  // tool_loop well past threshold (>= 2x) + hard levers enabled → escalateModel.
  {
    const reflector = createReflector('eval-hard-severe', { maxToolRepetitions: 3 });
    const steps = Array.from({ length: 6 }, () => ({ toolCalls: [{ toolName: 'repeat_tool', args: {} }] }));
    const enabled = reflector.evaluateHistory(steps, { hardLeversEnabled: true });
    assert.equal(enabled.signal, 'tool_loop');
    assert.equal(enabled.intervention!.escalateModel, true, 'severe loop must escalate the model when hard levers enabled');

    // Same severe loop but hard levers DISABLED → no hard lever.
    const disabled = reflector.evaluateHistory(steps);
    assert.equal(disabled.intervention!.escalateModel, undefined, 'hard levers must be gated off by default');
    assert.deepEqual(disabled.intervention!.dropTools, ['repeat_tool'], 'soft lever still applies when hard levers off');
  }

  // Severe delegation failures + hard levers → forceTool approval.
  {
    const reflector = createReflector('eval-hard-delegation', { maxDelegationFailures: 1, warmupSteps: 1 });
    const mkFail = () => ({
      toolCalls: [{ toolName: 'system_delegate_task', args: { targetAgent: 'codingAgent' } }],
      toolResults: [{ toolName: 'system_delegate_task', result: { success: false }, isError: false }],
    });
    const mkOk = () => ({
      toolCalls: [{ toolName: 'read_file', args: { path: 'a.ts' } }],
      toolResults: [{ toolName: 'read_file', result: { ok: true, contents: 'x'.repeat(40) }, isError: false }],
    });
    // 3 delegation failures (>= 2x maxDelegationFailures(1) → severe) interleaved with
    // successful non-delegation calls so errorRate (3/7 ≈ 0.43) stays below the
    // high_error_rate threshold and delegation_failures wins the priority race.
    const steps = [mkFail(), mkOk(), mkFail(), mkOk(), mkFail(), mkOk(), mkOk()];
    const decision = reflector.evaluateHistory(steps, { hardLeversEnabled: true });
    assert.equal(decision.signal, 'delegation_failures');
    assert.equal(decision.intervention!.forceTool, 'system_request_approval', 'severe delegation failures force an approval tool');
  }

  // ── §2.6: isUnrecoverable (stateless stopWhen predicate) ──

  // Healthy / mildly-struggling trajectories are NOT unrecoverable.
  {
    const reflector = createReflector('eval-unrec-healthy', {});
    const ok = [
      { toolCalls: [{ toolName: 'read_file', args: {} }], toolResults: [{ toolName: 'read_file', result: { ok: true }, isError: false }] },
      { toolCalls: [{ toolName: 'grep', args: {} }], toolResults: [{ toolName: 'grep', result: { matches: [1, 2] }, isError: false }] },
      { toolCalls: [{ toolName: 'edit', args: {} }], toolResults: [{ toolName: 'edit', result: { ok: true }, isError: false }] },
    ];
    assert.equal(reflector.isUnrecoverable(ok), false, 'a productive trajectory is recoverable');
    assert.equal(reflector.isUnrecoverable([]), false, 'an empty history is not unrecoverable');
  }

  // Catastrophic loop (>= maxToolRepetitions * unrecoverableLoopMultiplier).
  // §loop_fix.P2c — multiplier lowered 3→2, so with maxToolRepetitions=3 the raw
  // ceiling is now 3 * 2 = 6. Results are omitted so the trivial-result cut (0b)
  // does not interfere — this exercises the raw repetition ceiling only.
  {
    const reflector = createReflector('eval-unrec-loop', { maxToolRepetitions: 3 }); // ceiling = 3 * 2 = 6
    const five = Array.from({ length: 5 }, () => ({ toolCalls: [{ toolName: 'spin', args: {} }] }));
    assert.equal(reflector.isUnrecoverable(five), false, '5 < 6 loop ceiling → still recoverable');
    const six = Array.from({ length: 6 }, () => ({ toolCalls: [{ toolName: 'spin', args: {} }] }));
    assert.equal(reflector.isUnrecoverable(six), true, '6 repeats hits the catastrophic-loop ceiling');
  }

  // §loop_fix.P2c — unproductive loop: the SAME tool keeps returning trivial /
  // empty (non-error) results. Unrecoverable at maxUnproductiveLoopRepetitions
  // (default 6), below the raw ceiling. Targets the observed MCP `notebook_query`
  // empty-result loop that neither the error-rate nor validation path caught.
  {
    const reflector = createReflector('eval-unrec-trivial', {}); // default maxUnproductiveLoopRepetitions = 6
    const mkEmpty = () => ({
      toolCalls: [{ toolName: 'notebook_query', args: {} }],
      toolResults: [{ toolName: 'notebook_query', result: '', isError: false }],
    });
    const fiveEmpty = Array.from({ length: 5 }, mkEmpty);
    assert.equal(reflector.isUnrecoverable(fiveEmpty), false, '5 trivial results < 6 → still recoverable');
    const sixEmpty = Array.from({ length: 6 }, mkEmpty);
    assert.equal(reflector.isUnrecoverable(sixEmpty), true, '6 trivial results hits the unproductive-loop cut');
  }

  // Sustained very-high error rate over enough calls.
  {
    const reflector = createReflector('eval-unrec-errors', {}); // 0.8 rate, min 6 calls
    const mkErr = () => ({ toolCalls: [{ toolName: 'flaky', args: {} }], toolResults: [{ toolName: 'flaky', result: { success: false }, isError: false }] });
    const mkOk = () => ({ toolCalls: [{ toolName: 'flaky', args: {} }], toolResults: [{ toolName: 'flaky', result: { ok: true }, isError: false }] });
    // 6 errors + 1 ok = 6/7 ≈ 0.857 ≥ 0.8 over 7 calls.
    const hot = [mkErr(), mkErr(), mkErr(), mkErr(), mkErr(), mkErr(), mkOk()];
    assert.equal(reflector.isUnrecoverable(hot), true, 'sustained >=0.8 error rate over >=6 calls is unrecoverable');
    // Same error count but diluted below threshold → recoverable.
    const diluted = [mkErr(), mkErr(), mkErr(), mkOk(), mkOk(), mkOk(), mkOk(), mkOk()]; // 3/8 = 0.375
    assert.equal(reflector.isUnrecoverable(diluted), false, 'error rate below threshold is recoverable');
  }

  // Delegations failing far past the recovery threshold.
  {
    const reflector = createReflector('eval-unrec-deleg', { maxDelegationFailures: 2 }); // ceiling = 2 * 3 = 6
    const mkFail = () => ({
      // Runtime tool name = registration key (`delegateTaskTool`), NOT the .id.
      toolCalls: [{ toolName: 'delegateTaskTool', args: { targetAgent: 'codingAgent' } }],
      toolResults: [{ toolName: 'delegateTaskTool', result: { success: false }, isError: false }],
    });
    const six = Array.from({ length: 6 }, mkFail);
    assert.equal(reflector.isUnrecoverable(six), true, '6 delegation failures hits the unrecoverable ceiling');
  }

  // §loop_fix.P2d — Mastra's tool-input validation envelope is detected despite
  // the boolean `error: true` (which previously short-circuited the message scan).
  {
    const mastraEnvelope = {
      error: true,
      message: 'Tool input validation failed for delegateTaskTool. Please fix the following errors and try again:\n- targetAgent: Invalid option',
      validationErrors: { fields: { targetAgent: 'Invalid option' } },
    };
    assert.equal(isValidationFailureResult(mastraEnvelope), true, 'Mastra { error:true, message, validationErrors } envelope is a validation failure');
    assert.equal(isValidationFailureResult({ error: true }), false, 'bare error:true (no validationErrors, no message) is not detectable as a validation failure');
    assert.equal(isValidationFailureResult({ ok: true, message: 'all good' }), false, 'a benign result is not a validation failure');
    assert.equal(isValidationFailureResult('Tool input validation failed for X'), true, 'a bare validation string still matches');
  }

  // §loop_fix.P2d — validation failures spread across DIFFERENT tools (the model
  // cannot form valid args for anything) trip the global cut at maxToolRepetitions.
  {
    const reflector = createReflector('eval-unrec-globalvalid', { maxToolRepetitions: 4 });
    const mkInvalid = (tool: string) => ({
      toolCalls: [{ toolName: tool, args: {} }],
      toolResults: [{ toolName: tool, result: { error: true, message: `Tool input validation failed for ${tool}`, validationErrors: {} }, isError: false }],
    });
    // 2× delegateTaskTool + 2× runWorkerTool = 4 total validation failures, but
    // only 2 per tool — below the per-tool cut, caught only by the global cut.
    const mixed = [mkInvalid('delegateTaskTool'), mkInvalid('runWorkerTool'), mkInvalid('delegateTaskTool'), mkInvalid('runWorkerTool')];
    assert.equal(reflector.isUnrecoverable(mixed), true, '4 validation failures across tools hits the global cut');
    const three = [mkInvalid('delegateTaskTool'), mkInvalid('runWorkerTool'), mkInvalid('delegateTaskTool')];
    assert.equal(reflector.isUnrecoverable(three), false, '3 < 4 global validation cut → still recoverable');
  }

  // §loop_fix.P2e — STATEFUL backstop: after the prepareStep path has fired the
  // SAME stuck signal maxRepeatedStuckInterventions (default 3) times, the run is
  // unrecoverable EVEN WITH EMPTY steps. This catches both the malformed-tool-
  // call-JSON loop (tool_loop; args coerced to {} → validation fails) and the
  // flat-progress churn (low_progress) where the failures never normalize into
  // countable tool results.
  {
    const reflector = createReflector('eval-unrec-stuck-loop', {
      maxToolRepetitions: 3,
      maxReflectionsPerRun: 99, // don't let budget exhaustion interfere
      maxRepeatedStuckInterventions: 3,
    });
    const loopSteps = [
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
      { toolCalls: [{ toolName: 'repeat_tool', args: {} }] },
    ];
    const decision = reflector.evaluateHistory(loopSteps);
    assert.equal(decision.signal, 'tool_loop', 'precondition: evaluateHistory yields a tool_loop decision');

    reflector.recordIntervention(decision, 3);
    reflector.recordIntervention(decision, 5);
    assert.equal(reflector.isUnrecoverable([]), false, '2 tool_loop interventions < 3 → still recoverable');
    reflector.recordIntervention(decision, 7);
    assert.equal(reflector.isUnrecoverable([]), true, '3 tool_loop interventions hits the stateful stuck-signal cut even with empty steps');
  }

  // §loop_fix.P2e — the same stateful cut also catches a repeated low_progress
  // churn (observed: flat-progress steps 16,18,20,22,24,26 → 300s timeout).
  {
    const reflector = createReflector('eval-unrec-stuck-lowprogress', {
      maxReflectionsPerRun: 99,
      maxRepeatedStuckInterventions: 3,
    });
    const lowProgressDecision = {
      action: 'inject_reflection' as const,
      signal: 'low_progress' as const,
      reason: 'flat progress',
      message: 'no measurable progress',
    };
    reflector.recordIntervention(lowProgressDecision, 16);
    reflector.recordIntervention(lowProgressDecision, 18);
    assert.equal(reflector.isUnrecoverable([]), false, '2 low_progress interventions < 3 → still recoverable');
    reflector.recordIntervention(lowProgressDecision, 20);
    assert.equal(reflector.isUnrecoverable([]), true, '3 low_progress interventions hits the stateful stuck-signal cut');
  }

  // §loop_fix.P2f — progress_stall is also a stuck signal. The live pro run
  // reached repeated flat GoalContract progress after successful tools; it must
  // be eligible for the same stateful hard-stop path as low_progress/tool_loop.
  {
    const reflector = createReflector('eval-unrec-stuck-progress-stall', {
      maxReflectionsPerRun: 99,
      maxRepeatedStuckInterventions: 3,
    });
    const progressStallDecision = {
      action: 'inject_reflection' as const,
      signal: 'progress_stall' as const,
      reason: 'flat GoalContract progress',
      message: 'progress is not advancing',
    };
    reflector.recordIntervention(progressStallDecision, 12);
    reflector.recordIntervention(progressStallDecision, 14);
    assert.equal(reflector.isUnrecoverable([]), false, '2 progress_stall interventions < 3 → still recoverable');
    reflector.recordIntervention(progressStallDecision, 16);
    assert.equal(reflector.isUnrecoverable([]), true, '3 progress_stall interventions hits the stateful stuck-signal cut');
  }

  // §loop_fix.P2f — convergence stop must trust its own recorded `converge`
  // interventions. In real Mastra runs, the later stopWhen window can lose the
  // original delegation result shape, but a recorded converge signal already
  // proves a deliverable was observed.
  {
    const reflector = createReflector('eval-converge-stateful-stop', {
      maxReflectionsPerRun: 2,
    });
    const convergeDecision = {
      action: 'inject_reflection' as const,
      signal: 'converge' as const,
      reason: 'deliverable already available',
      message: 'finalize now',
    };
    reflector.recordIntervention(convergeDecision, 15);
    assert.equal(reflector.shouldConvergeStop([]), false, 'converge before budget exhaustion should not stop yet');
    reflector.recordIntervention(convergeDecision, 17);
    assert.equal(reflector.shouldConvergeStop([]), true, 'converge + exhausted budget stops even when current steps omit the deliverable');
  }

  // live automation hardening — once Golden Path latched a terminal automation
  // deliverable, convergence must outrank a repeated-tool signal. Otherwise a
  // tested workflow can keep churning on n8n_get_workflow / runtime checks until
  // the delegation timeout.
  await runWithHarnessExecutionContext(
    { runId: `check-terminal-deliverable-${Date.now()}` },
    async () => {
      markAutomationDeliverable('tested');
      const reflector = createReflector('eval-tested-outranks-tool-loop', {
        maxToolRepetitions: 3,
      });
      const steps = [
        { toolCalls: [{ toolName: 'repeat_tool', args: {} }], toolResults: [{ toolName: 'repeat_tool', result: { success: true }, isError: false }] },
        { toolCalls: [{ toolName: 'repeat_tool', args: {} }], toolResults: [{ toolName: 'repeat_tool', result: { success: true }, isError: false }] },
        { toolCalls: [{ toolName: 'repeat_tool', args: {} }], toolResults: [{ toolName: 'repeat_tool', result: { success: true }, isError: false }] },
      ];
      const decision = reflector.evaluateHistory(steps, { convergenceEnabled: true });
      assert.equal(decision.signal, 'converge', 'terminal automation deliverable must outrank tool_loop');
      assert.equal(decision.intervention?.forceNoTool, true, 'converge should force a no-tool final report step');
    },
  );

  // §loop_fix.P2e — a steering signal (wrong_tool) must NOT count toward the
  // stuck-signal cut (it can legitimately fire a few times on a healthy run).
  {
    const reflector = createReflector('eval-unrec-stuck-steering', {
      maxReflectionsPerRun: 99,
      maxRepeatedStuckInterventions: 3,
    });
    const wrongToolDecision = {
      action: 'inject_reflection' as const,
      signal: 'wrong_tool' as const,
      reason: 'wrong tool',
      message: 'use a different tool',
    };
    reflector.recordIntervention(wrongToolDecision, 4);
    reflector.recordIntervention(wrongToolDecision, 6);
    reflector.recordIntervention(wrongToolDecision, 8);
    assert.equal(reflector.isUnrecoverable([]), false, 'a steering signal (wrong_tool) does NOT trip the stuck-signal cut');
  }
} finally {
  console.warn = originalWarn;
}

console.log('✅ StrategyReflector checks passed');
