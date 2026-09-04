/**
 * Chef-agent menu quality scorer (E3 §6).
 *
 * A DETERMINISTIC rubric over a generated menu (ChefMenu) — no LLM judge, so the
 * score is reproducible and cheap. It encodes the menu-engineering rules from
 * `prompts/chef/domain.md`:
 *
 *   1. schemaValidity   — each dish carries the required fields (name/description/
 *                         ingredients/techniques) and the menu has real sections.
 *   2. progression      — temperature/intensity arc across courses (light→heavy,
 *                         cold→warm→hot…): rewards temperature coverage + variety.
 *   3. textures         — "Min. 3 textures per dish" (domain.md): fraction of dishes
 *                         with ≥3 distinct textures.
 *   4. techniques       — "Max 2 dishes of the same technique type, never
 *                         consecutively": penalizes over-repeated and adjacent-shared
 *                         techniques.
 *   5. dietaryPaths     — parallel vegetarian / gluten-free paths exist (never
 *                         "subtract on request"). Uses the profile's declared
 *                         restrictions when available, else the recommended default
 *                         (vegetarian + gluten-free).
 *   6. difficultyParity — menu execution difficulty within ±1 of the profile's
 *                         `difficultyTarget.score` (E2 parity rule). Skipped (weight
 *                         redistributed) when no target is provided.
 *
 * The pure `scoreChefMenu()` function is the primary, directly-testable deliverable
 * (plan Done-when: "scorer computes a score for the E2 menu"). `chefMenuQualityScorer`
 * is a thin Mastra `createScorer` wrapper that parses the menu (and optional profile)
 * out of the run output.
 */
import { createScorer } from '@mastra/core/evals';
import { getAssistantMessageFromRunOutput } from '@mastra/evals/scorers/utils';
import type { ChefMenu, ChefDish, ChefProfile } from '../tools/chef/chef-service';

// Techniques that materially raise execution difficulty (used by the difficulty proxy).
const ADVANCED_TECHNIQUES = [
  'sous-vide',
  'sous vide',
  'espuma',
  'spherification',
  'gel',
  'foam',
  'foaming',
  'emulsion',
  'confit',
  'smoke',
  'smoking',
  'cure',
  'curing',
  'ferment',
  'fermentation',
  'tuile',
  'glaze',
  'reduction',
  'clarify',
  'consommé',
  'tempering',
  'laminate',
];

const VEGETARIAN_TAGS = ['vegetarian', 'vegan', 'wegetariańskie', 'wegańskie', 'vege'];
const GLUTEN_FREE_TAGS = ['gluten_free', 'gluten-free', 'gf', 'bezglutenowe'];

export interface ChefMenuScoreDimensions {
  schemaValidity: number;
  progression: number;
  textures: number;
  techniques: number;
  dietaryPaths: number;
  /** null when no difficultyTarget was supplied (dimension skipped). */
  difficultyParity: number | null;
}

export interface ChefMenuScoreResult {
  /** Weighted overall score in [0,1]. */
  score: number;
  passed: boolean;
  dimensions: ChefMenuScoreDimensions;
  /** Per-dimension human-readable findings. */
  details: string[];
  estimatedDifficulty?: number;
}

/** Default pass threshold for the weighted overall score. */
export const CHEF_MENU_SCORE_THRESHOLD = 0.7;

/** Flattens all dishes across sections, preserving menu order. */
function flattenDishes(menu: ChefMenu): ChefDish[] {
  const out: ChefDish[] = [];
  for (const section of menu.sections ?? []) {
    for (const dish of section.dishes ?? []) out.push(dish);
  }
  return out;
}

function isAdvanced(technique: string): boolean {
  const t = technique.toLowerCase();
  return ADVANCED_TECHNIQUES.some((a) => t.includes(a));
}

function hasTagMatch(dish: ChefDish, tags: string[]): boolean {
  const dishTags = (dish.dietaryTags ?? []).map((t) => t.toLowerCase());
  return dishTags.some((dt) => tags.some((t) => dt.includes(t)));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ─── Dimension scorers ───────────────────────────────────────────────────────

function scoreSchema(dishes: ChefDish[], details: string[]): number {
  if (dishes.length === 0) {
    details.push('schemaValidity: 0.00 — menu has no dishes.');
    return 0;
  }
  let valid = 0;
  for (const d of dishes) {
    const ok =
      !!d.name?.trim() &&
      !!d.description?.trim() &&
      Array.isArray(d.ingredients) &&
      d.ingredients.length > 0 &&
      Array.isArray(d.techniques) &&
      d.techniques.length > 0;
    if (ok) valid++;
  }
  const score = valid / dishes.length;
  details.push(`schemaValidity: ${score.toFixed(2)} — ${valid}/${dishes.length} dishes complete.`);
  return score;
}

function scoreProgression(dishes: ChefDish[], menu: ChefMenu, details: string[]): number {
  if (dishes.length < 2) {
    details.push('progression: 1.00 — <2 dishes, trivially ordered.');
    return 1;
  }
  const withTemp = dishes.filter((d) => !!d.temperature?.trim());
  const coverage = withTemp.length / dishes.length;
  const distinct = new Set(withTemp.map((d) => d.temperature!.toLowerCase().trim())).size;
  const arc = menu.metadata?.temperatureArc;
  const hasArc = Array.isArray(arc) && arc.length >= 2;
  // Variety component: ≥2 distinct temperatures (or a declared arc) earns full credit.
  const variety = distinct >= 2 || hasArc ? 1 : distinct === 1 ? 0.4 : 0;
  const score = clamp01(0.5 * coverage + 0.5 * variety);
  details.push(
    `progression: ${score.toFixed(2)} — temp coverage ${(coverage * 100).toFixed(0)}%, ${distinct} distinct temps${hasArc ? ', arc declared' : ''}.`,
  );
  return score;
}

function scoreTextures(dishes: ChefDish[], details: string[]): number {
  if (dishes.length === 0) return 0;
  let ok = 0;
  for (const d of dishes) {
    const distinct = new Set((d.textures ?? []).map((t) => t.toLowerCase().trim())).size;
    if (distinct >= 3) ok++;
  }
  const score = ok / dishes.length;
  details.push(`textures: ${score.toFixed(2)} — ${ok}/${dishes.length} dishes have ≥3 textures.`);
  return score;
}

function scoreTechniques(dishes: ChefDish[], details: string[]): number {
  if (dishes.length < 2) {
    details.push('techniques: 1.00 — <2 dishes, no repetition possible.');
    return 1;
  }
  // Count dishes per technique type.
  const dishCount = new Map<string, number>();
  for (const d of dishes) {
    const uniq = new Set((d.techniques ?? []).map((t) => t.toLowerCase().trim()));
    for (const t of uniq) dishCount.set(t, (dishCount.get(t) ?? 0) + 1);
  }
  const overRepeated = [...dishCount.entries()].filter(([, c]) => c > 2);

  // Adjacent dishes sharing any technique.
  let consecutive = 0;
  for (let i = 1; i < dishes.length; i++) {
    const a = new Set((dishes[i - 1].techniques ?? []).map((t) => t.toLowerCase().trim()));
    const b = (dishes[i].techniques ?? []).map((t) => t.toLowerCase().trim());
    if (b.some((t) => a.has(t))) consecutive++;
  }

  // Penalty normalized by menu size; each violation class capped so a single bad
  // pair never zeroes an otherwise-clean menu.
  const overPenalty = overRepeated.length / Math.max(1, dishCount.size);
  const consecutivePenalty = consecutive / (dishes.length - 1);
  const score = clamp01(1 - 0.6 * overPenalty - 0.4 * consecutivePenalty);
  details.push(
    `techniques: ${score.toFixed(2)} — ${overRepeated.length} over-repeated (>2 dishes), ${consecutive} consecutive-shared pairs.`,
  );
  return score;
}

function scoreDietaryPaths(
  dishes: ChefDish[],
  profile: ChefProfile | undefined,
  details: string[],
): number {
  // Determine which paths are expected.
  const declared = (profile?.guestProfile?.dietaryRestrictions ?? []).map((r) => r.toLowerCase());
  const needVegetarian =
    declared.length === 0 || declared.some((r) => VEGETARIAN_TAGS.some((t) => r.includes(t)));
  const needGlutenFree =
    declared.length === 0 || declared.some((r) => GLUTEN_FREE_TAGS.some((t) => r.includes(t)));

  const checks: boolean[] = [];
  if (needVegetarian) checks.push(dishes.some((d) => hasTagMatch(d, VEGETARIAN_TAGS)));
  if (needGlutenFree) checks.push(dishes.some((d) => hasTagMatch(d, GLUTEN_FREE_TAGS)));
  // Any other declared restriction → require at least one matching dish tag.
  for (const r of declared) {
    if (VEGETARIAN_TAGS.some((t) => r.includes(t)) || GLUTEN_FREE_TAGS.some((t) => r.includes(t)))
      continue;
    checks.push(dishes.some((d) => (d.dietaryTags ?? []).some((t) => t.toLowerCase().includes(r))));
  }

  if (checks.length === 0) {
    details.push('dietaryPaths: 1.00 — no dietary paths required.');
    return 1;
  }
  const satisfied = checks.filter(Boolean).length;
  const score = satisfied / checks.length;
  details.push(`dietaryPaths: ${score.toFixed(2)} — ${satisfied}/${checks.length} required paths present.`);
  return score;
}

/** Heuristic 1-5 execution-difficulty proxy from technique density + advanced techniques. */
function estimateDifficulty(dishes: ChefDish[]): number {
  if (dishes.length === 0) return 1;
  const avgTech =
    dishes.reduce((s, d) => s + (d.techniques?.length ?? 0), 0) / dishes.length;
  const advancedRatio =
    dishes.filter((d) => (d.techniques ?? []).some(isAdvanced)).length / dishes.length;
  const raw = 1 + avgTech + advancedRatio * 1.5;
  return Math.max(1, Math.min(5, Math.round(raw)));
}

function scoreDifficultyParity(
  dishes: ChefDish[],
  profile: ChefProfile | undefined,
  details: string[],
): { score: number | null; estimated?: number } {
  const target = profile?.difficultyTarget?.score;
  if (typeof target !== 'number') {
    details.push('difficultyParity: skipped — no difficultyTarget on profile.');
    return { score: null };
  }
  const est = estimateDifficulty(dishes);
  const delta = Math.abs(est - target);
  const score = delta <= 1 ? 1 : delta === 2 ? 0.5 : 0;
  details.push(
    `difficultyParity: ${score.toFixed(2)} — estimated ${est}/5 vs target ${target}/5 (Δ${delta}).`,
  );
  return { score, estimated: est };
}

// ─── Public pure scorer ──────────────────────────────────────────────────────

/**
 * Computes the deterministic menu-quality score. Pass the optional profile to
 * enable the dietary-paths (declared restrictions) and difficulty-parity checks.
 */
export function scoreChefMenu(menu: ChefMenu, profile?: ChefProfile): ChefMenuScoreResult {
  const details: string[] = [];
  const dishes = flattenDishes(menu);

  const schemaValidity = scoreSchema(dishes, details);
  const progression = scoreProgression(dishes, menu, details);
  const textures = scoreTextures(dishes, details);
  const techniques = scoreTechniques(dishes, details);
  const dietaryPaths = scoreDietaryPaths(dishes, profile, details);
  const parity = scoreDifficultyParity(dishes, profile, details);

  // Base weights; difficultyParity weight is redistributed proportionally when skipped.
  const weights: Record<string, number> = {
    schemaValidity: 0.25,
    progression: 0.15,
    textures: 0.15,
    techniques: 0.15,
    dietaryPaths: 0.15,
    difficultyParity: 0.15,
  };
  const values: Record<string, number | null> = {
    schemaValidity,
    progression,
    textures,
    techniques,
    dietaryPaths,
    difficultyParity: parity.score,
  };

  let totalWeight = 0;
  let acc = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = values[k];
    if (v === null) continue; // skipped dimension — drop its weight
    acc += v * w;
    totalWeight += w;
  }
  const score = totalWeight > 0 ? clamp01(acc / totalWeight) : 0;

  return {
    score,
    passed: score >= CHEF_MENU_SCORE_THRESHOLD,
    dimensions: {
      schemaValidity,
      progression,
      textures,
      techniques,
      dietaryPaths,
      difficultyParity: parity.score,
    },
    details,
    estimatedDifficulty: parity.estimated,
  };
}

// ─── Mastra scorer wrapper ───────────────────────────────────────────────────

/** Extracts a ChefMenu (and optional ChefProfile) from a run-output payload. */
function parseMenuFromOutput(output: unknown): { menu?: ChefMenu; profile?: ChefProfile } {
  let payload: any = output;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return {};
    }
  }
  if (!payload || typeof payload !== 'object') return {};
  // Accept { menu, profile }, or a bare ChefMenu (has sections[]).
  if (payload.menu && Array.isArray(payload.menu.sections)) {
    return { menu: payload.menu as ChefMenu, profile: payload.profile as ChefProfile | undefined };
  }
  if (Array.isArray(payload.sections)) {
    return { menu: payload as ChefMenu, profile: payload.profile as ChefProfile | undefined };
  }
  return {};
}

export const chefMenuQualityScorer = createScorer({
  id: 'chef-menu-quality',
  name: 'Chef Menu Quality',
  description:
    'Deterministic menu-engineering rubric: schema validity, progression, ≥3 textures/dish, ≤2-technique repetition, dietary paths, difficulty parity. Expects the run output to contain a ChefMenu (optionally a profile for parity).',
  type: 'agent',
})
  .preprocess(({ run }) => {
    const raw = getAssistantMessageFromRunOutput(run.output) ?? run.output;
    return parseMenuFromOutput(raw);
  })
  // Deterministic analysis step (plain function — no LLM judge).
  .analyze(({ results }) => {
    const { menu, profile } = (results as any).preprocessStepResult ?? {};
    if (!menu) {
      return { score: 0, passed: false, details: ['No ChefMenu found in run output.'] };
    }
    const r = scoreChefMenu(menu, profile);
    return { score: r.score, passed: r.passed, details: r.details };
  })
  .generateScore(({ results }) => (results as any)?.analyzeStepResult?.score ?? 0)
  .generateReason(({ results, score }) => {
    const r = (results as any)?.analyzeStepResult;
    if (!r) return `Score=${score}. No analysis produced.`;
    return `Score=${score.toFixed(2)} (pass=${r.passed}).\n${(r.details ?? []).join('\n')}`;
  });

export const chefScorers = {
  chefMenuQualityScorer,
};
