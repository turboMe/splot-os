/**
 * OBSERVE — live, read-only E2E of the meta-agent orchestration loop.
 *
 * Purpose: drive the REAL `metaAgent.generate()` with a SAFE, read-only,
 * multi-domain task so we can watch the pieces we just built actually fire:
 *   - WS4.3 recognition-before-action (search_tools / recall lessons / memory)
 *   - WS2  LLM-authored delegation plan (system_plan_task: assumptions + per-step success)
 *   - WS4.2 two delegation paths: EXPERT delegate vs BLANK worker
 *   - GoalContract + adaptive depth + review/approval gates
 *
 * It makes REAL cloud-LLM calls and REAL (read-only) delegations. The task
 * is framed as a DRY RUN with hard no-mutation constraints, mirroring
 * check-cognitive-loop-dry-run.ts but against the real agent (not a fake).
 *
 * Run: npx tsx src/mastra/scripts/observe-meta-orchestration.ts
 */
import 'dotenv/config';

// Belt-and-suspenders: make sure the path under test is enabled in-process.
process.env.FEATURE_DELEGATION_LLM_PLAN = 'true';
process.env.FEATURE_ADAPTIVE_DEPTH = 'true';
process.env.FEATURE_REFLECTION_REPAIR_PASS = 'true';

const { mastra } = await import('../index.js');
const { queryAgentEvents } = await import('../lib/agent-event-log.js');

const metaAgent = mastra.getAgent('metaAgent');

const runId = `observe-meta-orchestration-${Date.now()}`;

// ── The safe, read-only, multi-domain task ──────────────────────────────────
// Designed to naturally route ONE subtask to an EXPERT (domain + tools) and
// ONE subtask to a BLANK worker (pure text), so we see both delegation paths.
const task = `
TRYB READ-ONLY / DRY RUN. Nie wykonuj żadnych działań mutujących:
nie zmieniaj plików, nie deployuj, nie aktywuj workflow, nie usuwaj danych,
nie wysyłaj emaili, nie zmieniaj credentiali. To analiza koncepcyjna.

WAŻNE: NIE używaj agenta automationArchitect ani żadnego narzędzia n8n.

Zadanie (wieloetapowe, analityczne):

1. Poproś eksperta od wiedzy/researchu (knowledgeAgent lub researcherAgent)
   o READ-ONLY syntezę: jakie są dobre praktyki bezpiecznego przechowywania
   sekretów (.env, klucze API, tokeny) w projekcie TypeScript. Tylko analiza,
   bez zmian w plikach.

2. Osobno, jako CZYSTO TEKSTOWE zadanie (bez narzędzi): sklasyfikuj i streść
   pięć typowych miejsc wycieku sekretów w trzy kategorie
   (kod / konfiguracja / logi), po jednym zdaniu na każde.

3. Zsyntetyzuj oba wyniki w zwięzły raport po polsku z jasną rekomendacją,
   czego nie wolno zrobić bez ludzkiej zgody.
`;

// ── Capture every step's tool activity ──────────────────────────────────────
type StepObservation = {
  step: number;
  toolCalls: Array<{ toolName: string; argsSummary: string }>;
  toolResults: Array<{ toolName: string; ok: boolean; summary: string }>;
};
const steps: StepObservation[] = [];
let stepCounter = 0;

function summarize(value: unknown, max = 160): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

console.log(`\n=== OBSERVE meta orchestration · runId=${runId} ===\n`);
const startedAt = new Date();

const response = await (metaAgent.generate as any)(task, {
  taskId: runId,
  runId,
  memory: {
    thread: `${runId}-thread`,
    resource: 'observe-user',
  },
  onStepFinish: (stepResult: any) => {
    stepCounter += 1;
    const toolCalls = (stepResult?.toolCalls ?? []).map((tc: any) => ({
      toolName: tc?.toolName ?? tc?.payload?.toolName ?? 'unknown',
      argsSummary: summarize(tc?.args ?? tc?.payload?.args),
    }));
    const toolResults = (stepResult?.toolResults ?? []).map((tr: any) => {
      const result = tr?.result ?? tr?.payload?.result;
      const ok = result?.success !== false && tr?.isError !== true;
      return {
        toolName: tr?.toolName ?? tr?.payload?.toolName ?? 'unknown',
        ok,
        summary: summarize(result),
      };
    });
    steps.push({ step: stepCounter, toolCalls, toolResults });
    if (toolCalls.length) {
      console.log(
        `  step ${stepCounter}: ${toolCalls.map((t: any) => t.toolName).join(', ')}`,
      );
    }
  },
});

const finalText = String(response?.text ?? '');

// ── Pull telemetry for this run ─────────────────────────────────────────────
const events = await queryAgentEvents({ runId, limit: 500 });
const taskEvents = await queryAgentEvents({ taskId: runId, limit: 500 });
const allEvents = [...events, ...taskEvents];
const eventTypes = new Set(allEvents.map((e) => e.type));

function has(type: string): boolean {
  return eventTypes.has(type as any);
}
function mark(present: boolean): string {
  return present ? 'YES' : 'no ';
}

// ── Aggregate tool usage across all steps ───────────────────────────────────
const toolUsage = new Map<string, number>();
for (const s of steps) {
  for (const tc of s.toolCalls) {
    toolUsage.set(tc.toolName, (toolUsage.get(tc.toolName) ?? 0) + 1);
  }
}
const usedTools = [...toolUsage.keys()];
const delegated = usedTools.includes('system_delegate_task');
const usedWorker = usedTools.includes('system_run_worker');
const planned = usedTools.includes('system_plan_task') || has('plan_task_completed');
const recognized =
  usedTools.includes('search_tools') ||
  usedTools.includes('system_recall_worker_lessons') ||
  usedTools.includes('system_memory_recall');

console.log('\n=== OBSERVATION REPORT ===\n');

console.log('Tool usage (across all steps):');
for (const [name, count] of [...toolUsage.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}×  ${name}`);
}
if (!usedTools.length) console.log('  (no tool calls captured)');

console.log('\nExpected behaviors:');
console.log(`  [${mark(recognized)}] WS4.3 recognition-before-action (search_tools / recall lessons / memory)`);
console.log(`  [${mark(planned)}]  WS2  LLM-authored plan (system_plan_task / plan_task_completed)`);
console.log(`  [${mark(delegated)}]  WS4.2 expert delegation (system_delegate_task)`);
console.log(`  [${mark(usedWorker)}]  WS4.2 blank worker (system_run_worker)`);
console.log(`  [${mark(has('depth_classified'))}]  adaptive depth classified`);
console.log(`  [${mark(has('goal_contract_created'))}]  GoalContract created`);
console.log(`  [${mark(has('goal_plan_revised'))}]  plan revision (replan-on-failure)`);
console.log(`  [${mark(has('auto_review_completed'))}]  auto review gate`);
console.log(`  [${mark(has('approval_gate_completed'))}]  approval gate`);
console.log(`  [${mark(has('run_completed'))}]  run completed`);

console.log('\nKey telemetry events (chronological):');
const interesting = new Set([
  'depth_classified', 'depth_upgraded',
  'goal_contract_created', 'goal_plan_revised', 'goal_contract_completed',
  'plan_task_started', 'plan_task_completed', 'plan_task_failed',
  'delegation', 'worker_run_started', 'worker_run_completed', 'worker_run_failed',
  'reflector_intervention', 'reflection_repair_completed',
  'auto_review_completed', 'approval_gate_completed',
  'run_started', 'run_completed', 'run_failed',
]);
const chrono = allEvents
  .filter((e) => interesting.has(e.type))
  .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
const seen = new Set<string>();
for (const e of chrono) {
  const key = `${e.type}|${e.toolId ?? ''}|${e.status}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${e.type}  [${e.status}]${e.toolId ? ' tool=' + e.toolId : ''}${e.errorMessage ? ' err=' + summarize(e.errorMessage, 80) : ''}`);
}

console.log('\nFinal answer (first 600 chars):');
console.log(finalText.slice(0, 600) + (finalText.length > 600 ? '…' : ''));

console.log('\nShortcomings auto-flagged:');
const shortcomings: string[] = [];
if (!recognized) shortcomings.push('No recognition turn (WS4.3) — agent planned/acted without search_tools/recall.');
if (!planned) shortcomings.push('No LLM plan (WS2) — system_plan_task not invoked and no plan_task_completed event.');
if (!delegated) shortcomings.push('No expert delegation — step 1 should have gone to a read-only expert (knowledgeAgent/researcherAgent).');
if (!usedWorker) shortcomings.push('No blank worker — step 2 (pure text) should have spawned system_run_worker, not an expert.');
if (!has('goal_contract_created')) shortcomings.push('No GoalContract created for the root run.');
const usedAutomationArchitect = steps.some((s) =>
  s.toolCalls.some((tc) => tc.argsSummary.includes('automationArchitect')),
) || allEvents.some((e) => e.agentId === 'automationArchitect');
if (usedAutomationArchitect) shortcomings.push('SAFETY: automationArchitect was used despite the instruction NOT to — review delegation routing.');
if (!has('depth_classified')) shortcomings.push('No adaptive depth classification.');
if (!finalText.trim()) shortcomings.push('Empty final answer.');
if (shortcomings.length) {
  for (const s of shortcomings) console.log(`  - ${s}`);
} else {
  console.log('  (none — all expected behaviors observed)');
}

console.log(`\nRun finished in ${Date.now() - startedAt.getTime()}ms. Total events: ${allEvents.length}.`);
process.exit(0);
