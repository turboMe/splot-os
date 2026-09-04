/**
 * check:pipeline-reflector — Reflektor Part 3 (§3.3B + §3.4 + §3.5).
 *
 * Deterministic, network-free assertions that the pipeline-mode reflector and
 * the per-phase tool allowlists behave as designed:
 *   - phase detection from the last `*_set_*_status` call;
 *   - per-phase signal windowing (error rate / loops / wrong_tool reset on a
 *     phase transition, NOT counted globally over a 150-step run);
 *   - pipeline mode produces SOFT levers only (no forceNoTool / hard levers);
 *   - the global/orchestration signals (direction_instability, low_progress,
 *     scope_creep, low_confidence) are DISABLED in pipeline mode;
 *   - fail-open `resolvePhaseTools` (unknown agent / phase / empty → null);
 *   - status + getter tools are present in EVERY phase (agent can always exit);
 *   - automation Golden Path per-phase tools resolve and channel correctly.
 */
import assert from 'node:assert/strict';

process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

const { StrategyReflector } = await import('../services/strategy-reflector.js');
const { normalizeStepsForReflector } = await import('../services/generate-with-harness.js');
const {
  resolvePhaseTools,
  getStatusToolName,
  isPipelineAgent,
  buildToolIdToKeyMap,
  translateToolIdsToKeys,
} = await import('../config/pipeline-phase-tools.js');

type Reflector = InstanceType<typeof StrategyReflector>;

const STATUS_TOOL = 'chef_set_project_status';

function createReflector(name: string, config: Record<string, unknown> = {}): Reflector {
  return new StrategyReflector({
    runId: `check-pipeline-reflector-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    agentId: 'chefAgent',
    originalPrompt: 'original chef task',
    config: { warmupSteps: 1, maxToolRepetitions: 99, ...config },
  });
}

function statusStep(phase: string) {
  return {
    toolCalls: [{ toolName: STATUS_TOOL, args: { status: phase } }],
    toolResults: [{ toolName: STATUS_TOOL, result: { success: true }, isError: false }],
  };
}

function okStep(toolName: string) {
  return {
    toolCalls: [{ toolName, args: {} }],
    toolResults: [{ toolName, result: { generated: true, value: 'real content here' }, isError: false }],
  };
}

function errStep(toolName: string) {
  return {
    toolCalls: [{ toolName, args: {} }],
    toolResults: [{ toolName, result: { success: false }, isError: false }],
  };
}

function trivialStep(toolName: string) {
  return {
    toolCalls: [{ toolName, args: {} }],
    toolResults: [{ toolName, result: { results: [] }, isError: false }],
  };
}

const originalWarn = console.warn;
console.warn = () => {};

try {
  // ── §3.4 — fail-open resolvePhaseTools ──
  {
    assert.equal(resolvePhaseTools('unknownAgent', 'menu_draft'), null, 'unknown agent → null');
    assert.equal(resolvePhaseTools('chefAgent', null), null, 'null phase → null');
    assert.equal(resolvePhaseTools('chefAgent', 'totally_made_up_phase'), null, 'unknown phase → null');

    const menu = resolvePhaseTools('chefAgent', 'menu_draft');
    assert.ok(menu, 'menu_draft should resolve a non-null allowlist');
    assert.ok(menu!.includes('chef_generate_menu'), 'menu_draft must surface chef_generate_menu');
    // §3.4 — status + getter tools available in EVERY phase (always-exit guarantee).
    assert.ok(menu!.includes(STATUS_TOOL), 'status tool must be in every phase');
    assert.ok(menu!.includes('chef_get_project'), 'getter tool must be in every phase');

    // A checkpoint phase mapped to [] still returns alwaysAvailable (never empty).
    const checkpoint = resolvePhaseTools('chefAgent', 'checkpoint_profile');
    assert.ok(checkpoint && checkpoint.length > 0, 'empty phase → alwaysAvailable, never empty');
    assert.ok(checkpoint!.includes(STATUS_TOOL), 'checkpoint still keeps the status tool');
  }

  // ── helpers: getStatusToolName / isPipelineAgent ──
  {
    assert.equal(getStatusToolName('chefAgent'), STATUS_TOOL);
    assert.equal(getStatusToolName('contentAgent'), 'content_set_project_status');
    assert.equal(getStatusToolName('huntAgent'), 'hunt_set_run_status');
    assert.equal(getStatusToolName('writerAgent'), 'writer_set_project_status');
    assert.equal(getStatusToolName('automationArchitect'), '', 'automation has no status tool');
    assert.equal(getStatusToolName('marketingAgent'), undefined, 'non-pipeline agent → undefined');

    assert.equal(isPipelineAgent('chefAgent'), true);
    assert.equal(isPipelineAgent('automationArchitect'), true);
    assert.equal(isPipelineAgent('writerAgent'), true);
    assert.equal(isPipelineAgent('marketingAgent'), false);
  }

  // ── writer phase map resolves specialist writing tools ──
  {
    const research = resolvePhaseTools('writerAgent', 'research');
    assert.ok(research, 'writer research phase resolves');
    assert.ok(research!.includes('writer_prepare_research_delegation'), 'writer research prepares delegation contracts');
    assert.ok(research!.includes('system_delegate_task'), 'writer research can delegate to researcherAgent');
    assert.ok(research!.includes('writer_ingest_research_result'), 'writer research can ingest researcher output');
    assert.ok(research!.includes('writer_add_sources'), 'writer research can persist source cards');
    assert.ok(research!.includes('writer_set_project_status'), 'writer phase keeps status tool');

    const critic = resolvePhaseTools('writerAgent', 'critic_gate');
    assert.ok(critic, 'writer critic phase resolves');
    assert.ok(critic!.includes('writer_quality_gate'), 'writer critic phase can run the composite quality gate');
    assert.ok(critic!.includes('writer_prepare_worker_review'), 'writer critic phase can prepare structured worker reviews');
    assert.ok(critic!.includes('writer_audit_slop'), 'writer critic phase can run deterministic audit');
    assert.ok(critic!.includes('system_run_worker'), 'writer critic phase can spawn specialist workers');

    const revision = resolvePhaseTools('writerAgent', 'revision');
    assert.ok(revision, 'writer revision phase resolves');
    assert.ok(revision!.includes('writer_revision_decision'), 'writer revision can compare before/after quality gates');
  }

  // ── §3.5 — automation Golden Path per-phase channeling ──
  {
    const validate = resolvePhaseTools('automationArchitect', 'validate');
    assert.ok(validate, 'validate phase resolves');
    assert.ok(validate!.includes('architect_validate_workflow'), 'validate surfaces the validator');
    assert.ok(
      !validate!.includes('architect_deploy_automation'),
      'validate must NOT surface the deploy tool (prevents premature deploy)',
    );
    // chat is intentionally unmapped → fail-open (no restriction).
    assert.equal(resolvePhaseTools('automationArchitect', 'chat'), null, 'chat phase fail-opens');
  }

  // ── id → key translation boundary (the live-run silent no-op fix) ──
  // The phase map is authored in tool `id`s, but Mastra step history /
  // activeTools / the model's tool registry all key on the tool OBJECT KEY.
  // resolvePhaseTools output MUST be translated id → key or it matches nothing
  // (phase detection returns null → fail-open → channeling silently disabled).
  {
    // Mirrors a chef `agent.listTools()` registry (registryKey → tool with id).
    const fakeRegistry: Record<string, { id: string }> = {
      chefStartProjectTool: { id: 'chef_start_project' },
      chefSetProjectStatusTool: { id: 'chef_set_project_status' },
      chefGenerateMenuTool: { id: 'chef_generate_menu' },
      chefGetProjectTool: { id: 'chef_get_project' },
    };
    const idToKey = buildToolIdToKeyMap(fakeRegistry);
    assert.equal(idToKey['chef_set_project_status'], 'chefSetProjectStatusTool', 'id → key map built');

    // Translate a phase allowlist: known ids → keys, unknown ids dropped.
    const keys = translateToolIdsToKeys(
      ['chef_generate_menu', 'chef_get_project', 'tool_not_in_this_agent'],
      idToKey,
    );
    assert.ok(keys, 'translation yields a non-null allowlist when at least one id maps');
    assert.ok(keys!.includes('chefGenerateMenuTool'), 'id translated to its registry key');
    assert.ok(
      !keys!.includes('tool_not_in_this_agent') && !keys!.includes('chef_generate_menu'),
      'unmapped ids dropped; raw ids never leak into activeTools',
    );

    // Fail-open: null input → null; nothing maps → null (caller applies NO restriction).
    assert.equal(translateToolIdsToKeys(null, idToKey), null, 'null input → null');
    assert.equal(
      translateToolIdsToKeys(['totally_unknown'], idToKey),
      null,
      'zero matches → null (never an empty allowlist that would deadlock the model)',
    );

    // The detection key for the status tool must be the registry KEY, not the id
    // — this is exactly what broke the first live run (phase always null).
    const statusKey = idToKey[getStatusToolName('chefAgent')!];
    assert.equal(statusKey, 'chefSetProjectStatusTool', 'status tool resolves to its registry key for detection');
  }

  // ── AI SDK v5 arg/result extraction (the silent telemetry-gap fix) ──
  // The fallback `normalizeSteps` path (top-level `step.toolCalls`) MUST read v5
  // `input`/`output`, not just `args`/`result`. When it read only `args`, status
  // args came back `{}` → phase detection went blind after the first window
  // compaction → pipeline phase telemetry stopped after the first transition.
  {
    // v5-shaped step: tool-call arg under `input`, result under `output.value`.
    const v5 = normalizeStepsForReflector([
      {
        toolCalls: [{ toolName: STATUS_TOOL, input: { status: 'recipes' } }],
        toolResults: [{ toolName: STATUS_TOOL, output: { value: { success: true, status: 'recipes' } } }],
      },
    ]);
    const call0 = v5[0]?.toolCalls?.[0] as { args?: { status?: string } } | undefined;
    assert.equal(call0?.args?.status, 'recipes', 'v5 `input` must be extracted as args (not {})');
    const res0 = v5[0]?.toolResults?.[0] as { result?: { status?: string } } | undefined;
    assert.equal(res0?.result?.status, 'recipes', 'v5 `output.value` must be unwrapped as result');
  }

  // ── phase detection falls back to the status tool's RESULT ──
  // If a window's status CALL has no readable `status` arg (compacted/odd shape),
  // detection must still recover the phase from the tool's returned `{ status }`.
  {
    const reflector = createReflector('result-fallback');
    const phaseTools = resolvePhaseTools('chefAgent', 'recon') ?? [];
    const steps = [
      // status call with EMPTY args, phase only present in the RESULT.
      {
        toolCalls: [{ toolName: STATUS_TOOL, args: {} }],
        toolResults: [{ toolName: STATUS_TOOL, result: { success: true, status: 'recon' }, isError: false }],
      },
      trivialStep('chef_search_recipe_library'),
      trivialStep('chef_search_recipe_library'),
    ];
    const decision = reflector.evaluateHistory(steps, { pipelineMode: true, statusToolName: STATUS_TOOL, phaseTools });
    assert.equal(decision.signal, 'wrong_tool', 'wrong_tool still fires when phase came from the result');
    assert.ok(
      decision.intervention!.injectSystem!.includes('recon'),
      'phase name recovered from the status RESULT (not just the arg)',
    );
  }

  // ── §3.3B — happy path: clean pipeline run → ZERO intervention ──
  {
    const reflector = createReflector('happy');
    const steps = [statusStep('menu_draft'), okStep('chef_generate_menu'), okStep('chef_save_menu')];
    const decision = reflector.evaluateHistory(steps, { pipelineMode: true, statusToolName: STATUS_TOOL });
    assert.equal(decision.action, 'continue', 'healthy pipeline run must not intervene');
  }

  // ── §3.3B — high_error_rate is windowed PER PHASE (reset on transition) ──
  {
    const reflector = createReflector('error-reset');
    // 4 errors BEFORE the transition, then a clean phase.
    const steps = [
      errStep('chef_recon_a'),
      errStep('chef_recon_b'),
      errStep('chef_recon_c'),
      errStep('chef_recon_d'),
      statusStep('menu_draft'),
      okStep('chef_generate_menu'),
    ];
    const decision = reflector.evaluateHistory(steps, { pipelineMode: true, statusToolName: STATUS_TOOL });
    assert.equal(decision.action, 'continue', 'errors before the transition must not leak into the new phase');
  }

  // ── §3.3B — high_error_rate DOES fire within the current phase window ──
  {
    const reflector = createReflector('error-in-phase');
    const steps = [
      statusStep('menu_draft'),
      errStep('chef_generate_menu'),
      errStep('chef_generate_menu_b'),
      errStep('chef_generate_menu_c'),
    ];
    const decision = reflector.evaluateHistory(steps, { pipelineMode: true, statusToolName: STATUS_TOOL });
    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'high_error_rate', 'errors within the current phase must trigger');
  }

  // ── §3.3B — wrong_tool is the MAIN pipeline signal; soft levers ONLY ──
  {
    const reflector = createReflector('wrong-tool');
    const phaseTools = resolvePhaseTools('chefAgent', 'recon') ?? [];
    const steps = [
      statusStep('recon'),
      trivialStep('chef_search_recipe_library'),
      trivialStep('chef_search_recipe_library'),
    ];
    const decision = reflector.evaluateHistory(steps, {
      pipelineMode: true,
      statusToolName: STATUS_TOOL,
      phaseTools,
    });
    assert.equal(decision.action, 'inject_reflection');
    assert.equal(decision.signal, 'wrong_tool');
    const iv = decision.intervention!;
    assert.ok(iv.injectSystem, 'wrong_tool injects a system reflection');
    assert.ok(iv.dropTools?.includes('chef_search_recipe_library'), 'drops the misused tool');
    // Pipeline mode = SOFT levers only.
    assert.equal(iv.forceNoTool, undefined, 'pipeline mode must NOT forceNoTool');
    assert.equal(iv.escalateModel, undefined, 'pipeline mode must NOT escalate the model');
    assert.equal(iv.forceTool, undefined, 'pipeline mode must NOT force a tool');
    assert.equal(iv.restrictTools, undefined, 'pipeline mode must NOT use restrictTools');
    // §3.3B — the reflection names the phase + phase-appropriate tools.
    assert.ok(iv.injectSystem!.includes('recon'), 'reflection names the current phase');
  }

  // ── §3.3B — direction_instability is DISABLED in pipeline mode ──
  {
    const steps = [
      { toolCalls: [{ toolName: 'system_delegate_task', args: { targetAgent: 'a' } }], toolResults: [{ toolName: 'system_delegate_task', result: { success: true }, isError: false }] },
      { toolCalls: [{ toolName: 'system_delegate_task', args: { targetAgent: 'b' } }], toolResults: [{ toolName: 'system_delegate_task', result: { success: true }, isError: false }] },
      { toolCalls: [{ toolName: 'system_delegate_task', args: { targetAgent: 'c' } }], toolResults: [{ toolName: 'system_delegate_task', result: { success: true }, isError: false }] },
      { toolCalls: [{ toolName: 'system_delegate_task', args: { targetAgent: 'd' } }], toolResults: [{ toolName: 'system_delegate_task', result: { success: true }, isError: false }] },
      { toolCalls: [{ toolName: 'system_delegate_task', args: { targetAgent: 'e' } }], toolResults: [{ toolName: 'system_delegate_task', result: { success: true }, isError: false }] },
    ];
    // Pipeline mode → disabled → continue.
    const pipeline = createReflector('dir-pipeline');
    const pDecision = pipeline.evaluateHistory(steps, { pipelineMode: true, statusToolName: STATUS_TOOL });
    assert.equal(pDecision.action, 'continue', 'direction_instability must be disabled in pipeline mode');

    // Sanity: the SAME history fires in normal mode (proves the signal exists).
    const normal = createReflector('dir-normal');
    const nDecision = normal.evaluateHistory(steps, {});
    assert.equal(nDecision.signal, 'direction_instability', 'normal mode still detects direction_instability');
  }

  // ── §3.3B — low_progress (long run) is DISABLED in pipeline mode ──
  {
    const longRun = Array.from({ length: 25 }, (_, i) => okStep(`chef_step_${i}`));
    const pipeline = createReflector('low-progress-pipeline');
    const pDecision = pipeline.evaluateHistory(longRun, { pipelineMode: true, statusToolName: STATUS_TOOL });
    assert.equal(pDecision.action, 'continue', '150-step pipelines must not trip low_progress');

    const normal = createReflector('low-progress-normal');
    const nDecision = normal.evaluateHistory(longRun, {});
    assert.equal(nDecision.signal, 'low_progress', 'normal mode still detects low_progress');
  }

  // ── evaluateHistory stays pure (no counter mutation) ──
  {
    const reflector = createReflector('pure');
    const steps = [statusStep('recon'), trivialStep('chef_search_recipe_library'), trivialStep('chef_search_recipe_library')];
    reflector.evaluateHistory(steps, { pipelineMode: true, statusToolName: STATUS_TOOL });
    reflector.evaluateHistory(steps, { pipelineMode: true, statusToolName: STATUS_TOOL });
    assert.equal(reflector.interventionCount, 0, 'evaluateHistory must not mutate counters');
  }
} finally {
  console.warn = originalWarn;
}

console.log('✅ Pipeline reflector checks passed');

// ── W1 — LIVE WIRING: a pipeline agent on the V2 caller is channeled by the
// phase it is ACTUALLY in, not by the static phase the call was made with ──
//
// Every assertion above exercises the reflector and the phase map directly, and
// all of them passed while the thing they describe was unreachable from V2: the
// harness resolved the allowlist once, from `input.phase`, and the V2 caller
// passes `phase: 'chat'` — a phase `resolvePhaseTools` does not know, so it
// returned null and the run went unrestricted from start to finish. Measured on
// a real job: chefAgent did `intake`, jumped straight to `chef_generate_menu`,
// never entered `recon` (so never delegated the research), never saved the menu,
// and closed as `done` with an empty menu on the project row.
//
// So this drives the REAL V2 caller and the REAL harness, faking only the model
// boundary, and asserts on the `activeTools` the model would have been given.
{
  const { harnessCallerFactory } = await import(
    '../orchestration/execution/harness-agent-caller.js'
  );

  /** Chef tools as Mastra reports them: registry KEY → { id }. */
  const CHEF_REGISTRY: Record<string, { id: string }> = {
    chefSetProjectStatusTool: { id: 'chef_set_project_status' },
    chefGetProjectTool: { id: 'chef_get_project' },
    delegateTaskTool: { id: 'system_delegate_task' },
    reviewsGooglePlaceTool: { id: 'reviews_google_place' },
    chefSearchRecipeLibraryTool: { id: 'chef_search_recipe_library' },
    chefGenerateMenuTool: { id: 'chef_generate_menu' },
    chefSaveMenuTool: { id: 'chef_save_menu' },
  };

  /** Captures what `prepareStep` would hand the model for a given history. */
  class PhaseProbeAgent {
    seen: Array<{ label: string; activeTools: string[] | undefined }> = [];
    async listTools(): Promise<Record<string, { id: string }>> { return CHEF_REGISTRY; }
    async generate(_prompt: string, options: Record<string, any> = {}): Promise<unknown> {
      const prepare = options.prepareStep as
        | ((a: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
        | undefined;
      if (prepare) {
        // ⚠️ Naming boundary, and the reason this probe nearly asserted the wrong
        // thing: Mastra's step history reports the tool's REGISTRY KEY, while the
        // phase map is authored in ids. A status step keyed by `id` is invisible
        // to detection — which is precisely the mismatch `buildToolIdToKeyMap`
        // exists to bridge, so the fixture has to speak keys like the real thing.
        const statusStepKeyed = (phase: string) => ({
          toolCalls: [{ toolName: 'chefSetProjectStatusTool', args: { status: phase } }],
          toolResults: [
            { toolName: 'chefSetProjectStatusTool', result: { status: phase }, isError: false },
          ],
        });
        const probe = async (label: string, steps: unknown[]) => {
          const out = await prepare({ stepNumber: steps.length, steps, systemMessages: [] });
          this.seen.push({ label, activeTools: out?.activeTools as string[] | undefined });
        };
        // Fresh run: nothing announced yet.
        await probe('no-phase', []);
        // The agent announced `recon` — research phase.
        await probe('recon', [statusStepKeyed('recon')]);
        // …then moved on to drafting the menu.
        await probe('menu_draft', [statusStepKeyed('recon'), statusStepKeyed('menu_draft')]);
      }
      return { text: 'ok', steps: [], finishReason: 'stop', toolCalls: [], toolResults: [] };
    }
  }

  async function runOnV2(agentId: string): Promise<PhaseProbeAgent> {
    const agent = new PhaseProbeAgent();
    const now = Date.now();
    const caller = harnessCallerFactory({
      agent: agent as never,
      agentId,
      ctx: {
        attemptId: `att-${agentId}-${now}`,
        taskId: `task-${now}`,
        jobId: `job-${now}`,
        attemptNumber: 1,
        businessOperationCutoffAt: new Date(now + 600_000),
        workDeadlineAt: new Date(now + 540_000),
        hardDeadlineAt: new Date(now + 900_000),
        goal: 'nowe menu dla restauracji',
      } as never,
    } as never);
    await caller({ prompt: 'nowe menu dla restauracji', signal: new AbortController().signal });
    return agent;
  }

  const chef = await runOnV2('chefAgent');
  const byLabel = (l: string) => chef.seen.find((s) => s.label === l);

  const recon = byLabel('recon');
  assert.ok(recon, 'prepareStep must run for a pipeline agent on V2');
  assert.ok(recon!.activeTools, 'the recon phase must CHANNEL tools, not leave the run open');
  assert.ok(
    recon!.activeTools!.includes('delegateTaskTool'),
    'recon is where chef reaches for the researcher — delegation must be available there',
  );
  assert.ok(
    !recon!.activeTools!.includes('chefGenerateMenuTool'),
    'and the menu generator must NOT be reachable during recon — skipping straight to it '
    + 'is exactly the observed defect',
  );

  const draft = byLabel('menu_draft');
  assert.ok(
    draft?.activeTools?.includes('chefGenerateMenuTool'),
    'once the agent announces menu_draft the generator must become available — the phase '
    + 'has to FOLLOW the run, not stay where it started',
  );
  assert.ok(
    !draft!.activeTools!.includes('reviewsGooglePlaceTool'),
    'and recon-only tools must fall away again',
  );

  // The regression guard: everyone else must be untouched by all of this.
  const generic = await runOnV2('designAgent');
  assert.ok(
    generic.seen.every((s) => s.activeTools === undefined),
    'a NON-pipeline agent must keep the exact behaviour it had before W1: no phase '
    + 'channeling, no restriction — asserted rather than assumed, because this code path '
    + 'is shared by every V2 capability',
  );

  // ── A loop must be broken even when NO phase is detected ──
  //
  // The live defect this guards: chef called `chef_draft_recipe` 145 times with
  // empty arguments, failing input validation identically every time, until the
  // job hit its wall clock. The reflector DID ask for the tool to be dropped —
  // but the lever only applied when a phase allowlist already existed, and with
  // no phase detected there was none, so the request was silently discarded. In
  // pipeline mode the hard levers are stripped too, which left nothing at all.
  //
  // No status call appears in this history on purpose: that is the state that
  // produced the 145-call run, and the state the old code could not act in.
  class LoopProbeAgent {
    seen: Array<{ activeTools: string[] | undefined }> = [];
    async listTools(): Promise<Record<string, { id: string }>> {
      return { ...CHEF_REGISTRY, chefDraftRecipeTool: { id: 'chef_draft_recipe' } };
    }
    async generate(_prompt: string, options: Record<string, any> = {}): Promise<unknown> {
      const prepare = options.prepareStep as
        | ((a: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
        | undefined;
      if (prepare) {
        // Mastra RETURNS the input-validation failure as the tool result.
        const rejected = {
          toolCalls: [{ toolName: 'chefDraftRecipeTool', args: {} }],
          toolResults: [{
            toolName: 'chefDraftRecipeTool',
            result: {
              error: true,
              message: 'Tool input validation failed for chefDraftRecipeTool.',
              validationErrors: { projectId: 'required' },
            },
            isError: false,
          }],
        };
        // The `standard` depth profile sets maxToolRepetitions: 6, so the
        // history has to cross THAT threshold, not the library default of 4.
        const steps = Array.from({ length: 8 }, () => rejected);
        // Drive it well past the per-run reflection budget (3 for `standard`),
        // spacing the steps beyond the 2-step per-signal cooldown. The LAST call
        // is therefore made with the nag budget already spent — which is the
        // state the live 145-call run was actually in, and the state in which
        // every lever used to be discarded.
        for (let i = 0; i < 6; i++) {
          const out = await prepare({ stepNumber: 8 + i * 3, steps, systemMessages: [] });
          this.seen.push({ activeTools: out?.activeTools as string[] | undefined });
        }
      }
      return { text: 'ok', steps: [], finishReason: 'stop', toolCalls: [], toolResults: [] };
    }
  }

  const looping = new LoopProbeAgent();
  const now = Date.now();
  const loopCaller = harnessCallerFactory({
    agent: looping as never,
    agentId: 'chefAgent',
    ctx: {
      attemptId: `att-loop-${now}`,
      taskId: `task-loop-${now}`,
      jobId: `job-loop-${now}`,
      attemptNumber: 1,
      businessOperationCutoffAt: new Date(now + 600_000),
      workDeadlineAt: new Date(now + 540_000),
      hardDeadlineAt: new Date(now + 900_000),
      goal: 'przepisy do menu',
    } as never,
  } as never);
  await loopCaller({ prompt: 'przepisy do menu', signal: new AbortController().signal });

  const broken = looping.seen[looping.seen.length - 1];
  assert.ok(broken, 'prepareStep must run for the looping history');
  assert.ok(
    looping.seen.length >= 4,
    'the probe must outlast the reflection budget, or it proves nothing about the '
    + 'state the live run was in',
  );
  assert.ok(
    broken.activeTools,
    'a tool looping on identical validation failures must produce an allowlist to '
    + 'subtract from — leaving it unrestricted is what let the 145-call run continue',
  );
  assert.ok(
    !broken.activeTools!.includes('chefDraftRecipeTool'),
    'the looping tool must be dropped for the next step',
  );
  assert.ok(
    broken.activeTools!.includes('chefSetProjectStatusTool'),
    'and dropping it must not strand the agent: it still has to be able to advance '
    + 'its own state machine',
  );
}

console.log('✅ W1 live-wiring checks passed');

// Explicit exit: the W1 section imports the V2 caller, which pulls the durable
// store's module graph and leaves handles that keep the event loop alive. Before
// this the gate had no I/O at all and fell off the end; a suite entry that prints
// success and then hangs is worse than one that fails, because check:all waits.
process.exit(0);
