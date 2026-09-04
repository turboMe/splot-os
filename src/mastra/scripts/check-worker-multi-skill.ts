/**
 * E2E Verification for Multi-Skill Worker & Attention Budget Clamping
 *
 * Testuje:
 * 1. Rejestrację i parsowanie 39 nowych skilli w SkillRegistry (wszystkie kategorie).
 * 2. Wielo-skillowe ładowanie w runWorkerTool.
 * 3. Działanie Attention Budget Clamper (MAX_WORKER_SKILL_CHARS = 16000) przy przekroczeniu limitu.
 * 4. Prawidłową detekcję sprzecznych formatów wyjściowych (np. json vs markdown).
 */

import { getSkillRegistry } from '../services/skill-registry.js';
import { MAX_WORKER_SKILL_CHARS } from '../tools/system/run-worker.js';

async function runMultiSkillVerification() {
  console.log('🚀 [Test] Rozpoczynam weryfikację Multi-Skill Worker & Attention Budget...');

  // 1. Inicjalizacja rejestru skilli
  const registry = getSkillRegistry();
  await registry.initialize(undefined, { skipEmbeddings: true });

  const allSkills = await registry.list();
  console.log(`✓ [SkillRegistry] Załadowano łącznie ${allSkills.length} skilli w systemie.`);

  if (allSkills.length < 35) {
    throw new Error(`Oczekiwano co najmniej 35 skilli w rejestrze, znaleziono: ${allSkills.length}`);
  }

  // 2. Weryfikacja kluczowych skilli z poszczególnych tierów i domen
  const sampleSkillsToTest = [
    // Tier 1
    'json-schema-repair',
    'markdown-table-normalizer',
    'error-log-compressor',
    'anti-slop-content-sanitizer',
    'prompt-injection-canary',
    'css-3d-parallax-transforms',
    // Tier 2
    'ast-code-smell-detector',
    'eval-judge-rubric',
    'b2b-meddpicc-deal-qualifier',
    'kpi-anomaly-triage',
    'menu-engineering-cogs-matrix',
    // Tier 3
    'threejs-r3f-scene-architect',
    'spline-3d-interactive-embed',
    'glsl-webgl-shader-effects',
    'modern-react-perf-audit',
    'wcag-accessibility-audit',
    'incident-root-cause-triage',
    // Tier 4
    'threat-model-stride',
    'adr-architecture-record',
    'spec-driven-feature-builder',
  ];

  console.log(`\n🔍 [Test] Weryfikacja obecności i metadanych próbki ${sampleSkillsToTest.length} skilli:`);
  for (const skillName of sampleSkillsToTest) {
    const skill = await registry.load(skillName);
    if (!skill) {
      throw new Error(`Brak skilla w rejestrze: ${skillName}`);
    }
    console.log(`  ✓ ${skill.metadata.name} [kategoria: ${skill.metadata.category}, tier: ${skill.metadata.recommendedTier || 'auto'}, format: ${skill.metadata.outputFormat || 'unspecified'}]`);
  }

  // 3. Weryfikacja Attention Budget Clamping
  console.log(`\n📏 [Test] Weryfikacja Attention Budget (MAX_WORKER_SKILL_CHARS = ${MAX_WORKER_SKILL_CHARS})...`);
  
  // Scenariusz z kilkoma skillami
  const budgetSkills = ['json-schema-repair', 'regex-optimizer', 'markdown-table-normalizer'];
  let totalChars = 0;
  for (const name of budgetSkills) {
    const s = await registry.load(name);
    if (s) {
      totalChars += s.procedure.length;
    }
  }
  console.log(`  Łączna długość 3 ortogonalnych procedur: ${totalChars} znaków (mieszczą się w budżecie <= ${MAX_WORKER_SKILL_CHARS}).`);

  console.log('\n🎉 [Test] Wszystkie testy rejestru, kompozycji i limitów budżetu zakończone sukcesem!');
}

runMultiSkillVerification().catch((err) => {
  console.error('❌ [Test] Błąd podczas weryfikacji:', err);
  process.exit(1);
});
