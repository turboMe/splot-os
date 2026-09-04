import assert from 'node:assert/strict';

import { classifyComplexity, type DepthLevel } from '../services/depth-controller.js';

const DEPTH_ORDER: Record<DepthLevel, number> = {
  fast: 0,
  standard: 1,
  deep: 2,
  critical: 3,
};

function classify(prompt: string, phase = 'chat'): DepthLevel {
  return classifyComplexity({
    prompt,
    phase: phase as Parameters<typeof classifyComplexity>[0]['phase'],
    agentId: 'depth-controller-check',
  }).level;
}

function assertLevel(prompt: string, expected: DepthLevel, phase?: string): void {
  const actual = classify(prompt, phase);
  assert.equal(actual, expected, `${prompt}: expected ${expected}, got ${actual}`);
}

function assertAtLeast(prompt: string, minimum: DepthLevel, phase?: string): void {
  const actual = classify(prompt, phase);
  assert.ok(
    DEPTH_ORDER[actual] >= DEPTH_ORDER[minimum],
    `${prompt}: expected at least ${minimum}, got ${actual}`,
  );
}

delete process.env.FEATURE_ADAPTIVE_DEPTH;

assertLevel('jaki status?', 'fast');
assertLevel('sprawdz szybko ten plik', 'fast');
assertAtLeast('zrob dokladny audyt implementacji fazy 4', 'deep');
assertAtLeast('zaprojektuj architekture integracji CRM + email + n8n', 'deep');
assertLevel('sprawdz ostatnie 3 delegacje czy zakonczyły sie sukcesem i sprawdz czy teraz jest cos aktywnego', 'fast');
assertLevel('czy teraz jest cos aktywnego?', 'fast');
assertLevel('pokaz aktywne zadania', 'fast');
assertLevel('aktywuj ten workflow', 'critical');
assertLevel('aktywacja workflow na produkcji', 'critical');
assertLevel('deploy workflow z credentialami i aktywuj', 'critical');
assertAtLeast('porownaj trzy podejscia architektoniczne', 'deep');
assertLevel(
  'Przeprowadź debatę architektoniczną na temat umieszczenia decyzji modelu wewnątrz lub poza granicą transakcyjną orkiestratora, przedstawiając argumenty za/przeciw oraz rekomendację.',
  'deep',
);
assertLevel(
  'Przeprowadź debatę architektoniczną (monolit vs mikroserwisy) dla systemu agentowego w firmie jednoosobowej, uwzględniając ograniczenia operacyjne i wymagania solopreneura.',
  'deep',
);
const whileSanity = classifyComplexity({
  prompt: 'Explain what happens while a worker is processing a normal request.',
  phase: 'chat',
  agentId: 'depth-controller-check',
});
assert.ok(
  !whileSanity.signals.some((signal) => signal.name === 'simple_keyword' && signal.matched === 'ile'),
  'the Polish word ile must not match inside the English word while',
);

process.env.FEATURE_ADAPTIVE_DEPTH = 'off';
assertLevel('jaki status?', 'deep');

delete process.env.FEATURE_ADAPTIVE_DEPTH;

// ── P1 (delegation-depth-hardening): thread depth inheritance ────────────────
// Live failure fixture (2026-07-21): "Deleguj" after a critical task classified
// as fast (score 0, zero signals) and starved the delegation at 60s/4k tokens.
{
  const { recordThreadDepth, getThreadDepth, _resetThreadDepths } = await import('../services/depth-controller.js');
  const { classifyComplexity } = await import('../services/depth-controller.js');

  const classifyInThread = (prompt: string, threadId: string): DepthLevel =>
    classifyComplexity({ prompt, phase: 'chat', agentId: 'depth-controller-check', threadId }).level;

  _resetThreadDepths();

  // Fresh thread — continuation command has nothing to inherit → stays fast.
  assert.equal(classifyInThread('Deleguj', 'thread-fresh'), 'fast', 'fresh thread: Deleguj should stay fast');

  // Thread that ran critical — the live fixtures now inherit it.
  recordThreadDepth('thread-heavy', 'critical');
  assert.equal(classifyInThread('Deleguj', 'thread-heavy'), 'critical', 'Deleguj should inherit critical');
  assert.equal(classifyInThread('dalej', 'thread-heavy'), 'critical', 'dalej should inherit critical');
  assert.equal(classifyInThread('kontynuuj!', 'thread-heavy'), 'critical', 'kontynuuj should inherit critical');
  assert.equal(classifyInThread('ok, deleguj', 'thread-heavy'), 'critical', 'ok, deleguj should inherit critical');

  // Signal name is recorded for observability.
  const inherited = classifyComplexity({ prompt: 'Deleguj', phase: 'chat', agentId: 'depth-controller-check', threadId: 'thread-heavy' });
  assert.ok(
    inherited.signals.some((s) => s.name === 'depth_inherited' && s.matched === 'critical'),
    'inheritance should emit depth_inherited:critical signal',
  );

  // Explicit fast hint ALWAYS wins over inheritance.
  assert.equal(classifyInThread('szybko, kontynuuj', 'thread-heavy'), 'fast', 'fast hint should beat inheritance');

  // Status questions are NOT continuation commands — they stay fast.
  assert.equal(classifyInThread('Jak status?', 'thread-heavy'), 'fast', 'status question should stay fast');
  assert.equal(classifyInThread('Jestes?', 'thread-heavy'), 'fast', 'Jestes? should stay fast');

  // A long message with real content classifies on its own signals, never inherits.
  const longPrompt = 'Deleguj przygotowanie krótkiego podsumowania spotkania z wczoraj i wyslij mi je na telegramie w formie listy punktow';
  const longResult = classifyComplexity({ prompt: longPrompt, phase: 'chat', agentId: 'depth-controller-check', threadId: 'thread-heavy' });
  assert.ok(
    !longResult.signals.some((s) => s.name === 'depth_inherited'),
    'long message should not inherit thread depth',
  );

  // Lighter turns must not erase the heavy memory (the "I jak?" → "Deleguj" sequence).
  recordThreadDepth('thread-heavy', 'fast'); // a fast status turn happens…
  assert.equal(getThreadDepth('thread-heavy'), 'critical', 'fast turn must not overwrite critical thread depth');
  assert.equal(classifyInThread('Deleguj', 'thread-heavy'), 'critical', 'Deleguj should still inherit after a fast turn');

  // Standard-level threads do NOT propagate (only deep/critical inherit).
  recordThreadDepth('thread-standard', 'standard');
  assert.equal(classifyInThread('Deleguj', 'thread-standard'), 'fast', 'standard thread depth should not inherit');

  // Kill switch restores stateless behavior.
  process.env.FEATURE_DEPTH_THREAD_INHERITANCE = 'off';
  assert.equal(classifyInThread('Deleguj', 'thread-heavy'), 'fast', 'flag off: Deleguj should stay fast');
  delete process.env.FEATURE_DEPTH_THREAD_INHERITANCE;

  _resetThreadDepths();
}

// ── P5: no bogus depth_floor signal on plain chit-chat ───────────────────────
{
  const { classifyComplexity } = await import('../services/depth-controller.js');
  const result = classifyComplexity({ prompt: 'Jestes?', phase: 'chat', agentId: 'depth-controller-check' });
  assert.ok(
    !result.signals.some((s) => s.name === 'depth_floor'),
    `"Jestes?" must not emit depth_floor (got: ${result.signals.map((s) => s.name).join(', ')})`,
  );
  // Real floors still fire.
  const critical = classifyComplexity({ prompt: 'zmigruj produkcyjna baze danych', phase: 'chat', agentId: 'depth-controller-check' });
  assert.ok(
    critical.signals.some((s) => s.name === 'depth_floor' && s.matched === 'critical'),
    'critical keyword should still emit depth_floor:critical',
  );
}

// ── A pipeline agent is never a `fast` turn ──────────────────────────────────
{
  const { classifyComplexity } = await import('../services/depth-controller.js');
  const brief = 'Przygotuj nowe menu dla restauracji https://www.saetasvinid.is/';

  // The measured case, verbatim: a correct one-line brief scores 0.00 with no
  // signals, and chefAgent walks eleven phases. Given `fast` it was told
  // "Max steps: 10 … Planning: skip … Keep the answer direct" and delivered 4
  // recipe cards for 18 dishes with five Menu Book sections left empty.
  const plain = classifyComplexity({ prompt: brief, phase: 'chat', agentId: 'depth-controller-check' });
  assert.equal(plain.level, 'fast', 'the brief itself carries no signal — that is the whole problem');

  const pipeline = classifyComplexity({ prompt: brief, phase: 'chat', agentId: 'chefAgent' });
  assert.equal(pipeline.level, 'standard', 'a pipeline agent must not run a state machine at `fast`');
  assert.ok(
    pipeline.signals.some((s) => s.name === 'pipeline_depth_floor' && s.matched === 'chefAgent'),
    'and the floor must be visible in the signals, not silent',
  );

  // RAISE, never lower — the same rule as the step ceiling and the idle window.
  const deep = classifyComplexity({
    prompt: 'Zaprojektuj i zmigruj cala architekture menu dla dwoch domen',
    phase: 'chat',
    agentId: 'chefAgent',
  });
  assert.ok(['deep', 'critical'].includes(deep.level),
    `a genuinely heavy prompt keeps its level, got ${deep.level}`);

  // Non-pipeline agents are untouched: this buys depth where a state machine
  // needs it, not everywhere.
  const ordinary = classifyComplexity({ prompt: brief, phase: 'chat', agentId: 'crmAgent' });
  assert.equal(ordinary.level, 'fast', 'a non-pipeline agent still classifies on the prompt alone');

  process.env.FEATURE_PIPELINE_DEPTH_FLOOR = 'false';
  assert.equal(
    classifyComplexity({ prompt: brief, phase: 'chat', agentId: 'chefAgent' }).level,
    'fast',
    'flag off restores prompt-only classification',
  );
  delete process.env.FEATURE_PIPELINE_DEPTH_FLOOR;
}

console.log('DepthController checks passed.');
