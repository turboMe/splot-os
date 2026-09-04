/**
 * Model pricing reference (USD per 1M tokens).
 * Used by services/dashboard-stats.ts to compute cost per task / agent / model.
 *
 * Prices are hardcoded for v1 (MVP). Future: move to MongoDB collection
 * `model_pricing` with effectiveFrom/effectiveTo for historical accuracy.
 *
 * Local models (Ollama) are priced at 0 — no API cost.
 * Override via env:
 * MODEL_PRICING_OVERRIDE_JSON='{"my-model":{"inputPer1M":1.0,"outputPer1M":2.0}}'
 */

export interface ModelPrice {
  /** USD per 1M input tokens */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
  /** Provider name (for grouping) */
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama' | 'deepseek' | 'unknown';
}

const FREE_OPENROUTER_PRICE: ModelPrice = { inputPer1M: 0, outputPer1M: 0, provider: 'openrouter' };
const FREE_OLLAMA_PRICE: ModelPrice = { inputPer1M: 0, outputPer1M: 0, provider: 'ollama' };

/**
 * Default pricing as of 2026-08.
 * Sources: https://www.anthropic.com/pricing, https://openai.com/api/pricing,
 * https://ai.google.dev/gemini-api/docs/pricing, https://openrouter.ai/models
 *
 * Notes:
 * - This tracks standard input/output token rates only. Cached-token discounts,
 *   batch/flex/priority tiers, long-context uplifts, and tool-call fees are not
 *   represented by the current dashboard schema.
 * - `gpt-5.3-mini` is a local manifest alias; OpenAI's current public mini tier
 *   is `gpt-5.4-mini`, so it is priced against that mini tier until the alias is
 *   retired or OpenAI publishes a distinct API rate for it.
 */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPrice> = {
  // ── Anthropic Claude ──────────────────────────────────────────────
  // Claude Fable 5 (newest flagship, June 2026)
  'claude-fable-5': { inputPer1M: 10, outputPer1M: 50, provider: 'anthropic' },
  // Claude Opus 4.x
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4.8': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4.7': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4.6': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4-5': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4-5-20251101': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4.5': { inputPer1M: 5, outputPer1M: 25, provider: 'anthropic' },
  'claude-opus-4-1': { inputPer1M: 15, outputPer1M: 75, provider: 'anthropic' },
  'claude-opus-4-1-20250805': { inputPer1M: 15, outputPer1M: 75, provider: 'anthropic' },
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75, provider: 'anthropic' },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75, provider: 'anthropic' },
  // Claude Sonnet 4.x
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-sonnet-4.6': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-sonnet-4-5': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-sonnet-4-5-20250929': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-sonnet-4.5': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-3-7-sonnet-latest': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-3-7-sonnet-20250219': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-3-5-sonnet-latest': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3, outputPer1M: 15, provider: 'anthropic' },
  // Claude Haiku
  'claude-haiku-4-5-20251001': { inputPer1M: 1, outputPer1M: 5, provider: 'anthropic' },
  'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5, provider: 'anthropic' },
  'claude-haiku-4.5': { inputPer1M: 1, outputPer1M: 5, provider: 'anthropic' },
  'claude-3-5-haiku-latest': { inputPer1M: 0.8, outputPer1M: 4, provider: 'anthropic' },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.8, outputPer1M: 4, provider: 'anthropic' },
  'claude-3-haiku-20240307': { inputPer1M: 0.25, outputPer1M: 1.25, provider: 'anthropic' },

  // ── OpenAI ────────────────────────────────────────────────────────
  'gpt-5.5': { inputPer1M: 5, outputPer1M: 30, provider: 'openai' },
  'gpt-5.4': { inputPer1M: 2.5, outputPer1M: 15, provider: 'openai' },
  'gpt-5.4-mini': { inputPer1M: 0.75, outputPer1M: 4.5, provider: 'openai' },
  'gpt-5.4-nano': { inputPer1M: 0.2, outputPer1M: 1.25, provider: 'openai' },
  'gpt-5.3-chat-latest': { inputPer1M: 1.75, outputPer1M: 14, provider: 'openai' },
  'gpt-5.3-codex': { inputPer1M: 1.75, outputPer1M: 14, provider: 'openai' },
  'gpt-5.3-mini': { inputPer1M: 0.75, outputPer1M: 4.5, provider: 'openai' },
  'gpt-5.2': { inputPer1M: 1.75, outputPer1M: 14, provider: 'openai' },
  'gpt-5.2-chat-latest': { inputPer1M: 1.75, outputPer1M: 14, provider: 'openai' },
  'gpt-5.2-codex': { inputPer1M: 1.75, outputPer1M: 14, provider: 'openai' },
  'gpt-5.1': { inputPer1M: 1.25, outputPer1M: 10, provider: 'openai' },
  'gpt-5.1-chat-latest': { inputPer1M: 1.25, outputPer1M: 10, provider: 'openai' },
  'gpt-5.1-codex': { inputPer1M: 1.25, outputPer1M: 10, provider: 'openai' },
  'gpt-5': { inputPer1M: 1.25, outputPer1M: 10, provider: 'openai' },
  'gpt-5-mini': { inputPer1M: 0.25, outputPer1M: 2, provider: 'openai' },
  'gpt-5-nano': { inputPer1M: 0.05, outputPer1M: 0.4, provider: 'openai' },
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8, provider: 'openai' },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6, provider: 'openai' },
  'gpt-4.1-nano': { inputPer1M: 0.1, outputPer1M: 0.4, provider: 'openai' },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, provider: 'openai' },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, provider: 'openai' },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30, provider: 'openai' },
  'o3': { inputPer1M: 2, outputPer1M: 8, provider: 'openai' },
  'o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4, provider: 'openai' },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4, provider: 'openai' },
  'o1': { inputPer1M: 15, outputPer1M: 60, provider: 'openai' },
  'o1-mini': { inputPer1M: 3, outputPer1M: 12, provider: 'openai' },

  // ── Google Gemini ─────────────────────────────────────────────────
  // Gemini 3.7 / 3.6 introductory standard rates through 2026-12-31.
  'gemini-3.7-flash': { inputPer1M: 0.75, outputPer1M: 3.75, provider: 'google' },
  'gemini-3.6-flash': { inputPer1M: 0.75, outputPer1M: 3.75, provider: 'google' },
  // Gemini 3.5
  'gemini-3.5-flash': { inputPer1M: 1.5, outputPer1M: 9, provider: 'google' },
  'gemini-3.5-flash-lite': { inputPer1M: 0.3, outputPer1M: 2.5, provider: 'google' },
  // Gemini 3.1
  'gemini-3.1-pro-preview': { inputPer1M: 2, outputPer1M: 12, provider: 'google' },
  'gemini-3.1-pro-preview-customtools': { inputPer1M: 2, outputPer1M: 12, provider: 'google' },
  'gemini-3.1-flash-lite': { inputPer1M: 0.25, outputPer1M: 1.5, provider: 'google' },
  'gemini-3.1-flash-lite-preview': { inputPer1M: 0.25, outputPer1M: 1.5, provider: 'google' },
  'gemini-3.1-flash-image-preview': { inputPer1M: 0.5, outputPer1M: 3, provider: 'google' },
  // Gemini 3.0
  'gemini-3-flash-preview': { inputPer1M: 0.5, outputPer1M: 3, provider: 'google' },
  'gemini-3.1-flash-preview': { inputPer1M: 0.5, outputPer1M: 3, provider: 'google' },
  'gemini-3-pro-image-preview': { inputPer1M: 2, outputPer1M: 12, provider: 'google' },
  // Gemini 2.5
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10, provider: 'google' },
  'gemini-2.5-pro-preview-tts': { inputPer1M: 1.25, outputPer1M: 10, provider: 'google' },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5, provider: 'google' },
  'gemini-2.5-flash-image': { inputPer1M: 0.3, outputPer1M: 2.5, provider: 'google' },
  'gemini-2.5-flash-preview-tts': { inputPer1M: 0.3, outputPer1M: 2.5, provider: 'google' },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4, provider: 'google' },
  'gemini-2.5-flash-lite-preview': { inputPer1M: 0.1, outputPer1M: 0.4, provider: 'google' },
  // Gemini 2.0
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4, provider: 'google' },
  'gemini-2.0-flash-lite': { inputPer1M: 0.075, outputPer1M: 0.3, provider: 'google' },
  // Gemini aliases (rolling → current latest GA as of 2026-08-21)
  'gemini-flash-latest': { inputPer1M: 0.75, outputPer1M: 3.75, provider: 'google' },
  'gemini-flash-lite-latest': { inputPer1M: 0.3, outputPer1M: 2.5, provider: 'google' },
  // Gemini embedding (per-token cost, not per-char)
  'gemini-embedding-001': { inputPer1M: 0, outputPer1M: 0, provider: 'google' },
  // Google Cloud Gemma (API-hosted, runs on Google infra, free tier exists)
  'gemma-4-26b-a4b-it': { inputPer1M: 0, outputPer1M: 0, provider: 'google' },
  'gemma-4-31b-it': { inputPer1M: 0, outputPer1M: 0, provider: 'google' },

  // ── DeepSeek (OpenAI-compatible, standard = cache-miss input rate) ─
  // https://api-docs.deepseek.com/quick_start/pricing/
  'deepseek-v4-flash': { inputPer1M: 0.14, outputPer1M: 0.28, provider: 'deepseek' },
  'deepseek-v4-pro': { inputPer1M: 0.435, outputPer1M: 0.87, provider: 'deepseek' },

  // ── OpenRouter free tier (cost = 0) ───────────────────────────────
  // Free models are subject to rate limits but have no per-token cost
  'openrouter/openrouter/free': FREE_OPENROUTER_PRICE,
  'openrouter/free': FREE_OPENROUTER_PRICE,
  'openrouter/auto': FREE_OPENROUTER_PRICE,
  'nemotron-3-super-120b-a12b:free': FREE_OPENROUTER_PRICE,
  'nvidia/nemotron-3-super-120b-a12b:free': FREE_OPENROUTER_PRICE,
  'nemotron-3-nano-30b-a3b:free': FREE_OPENROUTER_PRICE,
  'nvidia/nemotron-3-nano-30b-a3b:free': FREE_OPENROUTER_PRICE,
  'laguna-m.1:free': FREE_OPENROUTER_PRICE,
  'poolside/laguna-m.1:free': FREE_OPENROUTER_PRICE,
  'ring-2.6-1t:free': FREE_OPENROUTER_PRICE,
  'inclusionai/ring-2.6-1t:free': FREE_OPENROUTER_PRICE,
  'minimax-m2.5:free': FREE_OPENROUTER_PRICE,
  'minimax/minimax-m2.5:free': FREE_OPENROUTER_PRICE,
  'glm-4.5-air:free': FREE_OPENROUTER_PRICE,
  'z-ai/glm-4.5-air:free': FREE_OPENROUTER_PRICE,
  'gpt-oss-120b:free': FREE_OPENROUTER_PRICE,
  'openai/gpt-oss-120b:free': FREE_OPENROUTER_PRICE,
  'gpt-oss-20b:free': FREE_OPENROUTER_PRICE,
  'openai/gpt-oss-20b:free': FREE_OPENROUTER_PRICE,

  // ── OpenRouter paid models (live catalogue snapshot, 2026-08-21) ──
  'openrouter/google/gemini-3.7-flash': { inputPer1M: 0.375, outputPer1M: 1.875, provider: 'openrouter' },
  'openrouter/anthropic/claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10, provider: 'openrouter' },
  'openrouter/anthropic/claude-opus-5': { inputPer1M: 5, outputPer1M: 25, provider: 'openrouter' },
  'openrouter/~google/gemini-flash-latest': { inputPer1M: 0.375, outputPer1M: 1.875, provider: 'openrouter' },
  'openrouter/~anthropic/claude-sonnet-latest': { inputPer1M: 2, outputPer1M: 10, provider: 'openrouter' },
  'openrouter/~anthropic/claude-opus-latest': { inputPer1M: 5, outputPer1M: 25, provider: 'openrouter' },

  // ── Ollama local models (cost = 0, runs on local GPU) ─────────────
  'qwen3:1.7b': FREE_OLLAMA_PRICE,
  'qwen3:4b': FREE_OLLAMA_PRICE,
  'qwen3:8b': FREE_OLLAMA_PRICE,
  'qwen3:14b': FREE_OLLAMA_PRICE,
  'qwen3-coder:30b': FREE_OLLAMA_PRICE,
  'huihui_ai/qwen3.5-abliterated:9b': FREE_OLLAMA_PRICE,
  'gemma4:e4b': FREE_OLLAMA_PRICE,
  'gemma4:26b': FREE_OLLAMA_PRICE,
  'gemma4:12b': FREE_OLLAMA_PRICE,
  'maxwellb/gemma4-12b-it-oym': FREE_OLLAMA_PRICE,
  'speakleash/bielik-1.5b-v3.0-instruct:Q8_0': FREE_OLLAMA_PRICE,
  'speakleash/bielik-11b-v3.0-instruct:Q8_0': FREE_OLLAMA_PRICE,
  'llama3.1:8b': FREE_OLLAMA_PRICE,
  'llama3.1:70b': FREE_OLLAMA_PRICE,
  'bge-m3': FREE_OLLAMA_PRICE,
};

let _pricingCache: Record<string, ModelPrice> | null = null;

/**
 * Returns the merged pricing table (defaults + env override).
 * Cached after first call.
 */
function loadPricing(): Record<string, ModelPrice> {
  if (_pricingCache) return _pricingCache;

  const merged = { ...DEFAULT_MODEL_PRICING };

  const overrideJson = process.env.MODEL_PRICING_OVERRIDE_JSON;
  if (overrideJson) {
    try {
      const override = JSON.parse(overrideJson) as Record<string, Partial<ModelPrice>>;
      for (const [model, partial] of Object.entries(override)) {
        merged[model] = {
          inputPer1M: partial.inputPer1M ?? merged[model]?.inputPer1M ?? 0,
          outputPer1M: partial.outputPer1M ?? merged[model]?.outputPer1M ?? 0,
          provider: partial.provider ?? merged[model]?.provider ?? 'unknown',
        };
      }
    } catch (err) {
      console.warn('[ModelPricing] Failed to parse MODEL_PRICING_OVERRIDE_JSON:', (err as Error).message);
    }
  }

  _pricingCache = merged;
  return merged;
}

/**
 * Get pricing for a specific model. Falls back to a `provider: 'unknown'`
 * record with 0 cost if model is not registered (returns undefined-equivalent
 * but typed as zero so callers don't need to null-check).
 */
export function getModelPricing(model: string): ModelPrice {
  const pricing = loadPricing();
  const candidates = getModelCandidates(model);

  for (const candidate of candidates) {
    if (pricing[candidate]) return pricing[candidate]!;
  }

  for (const candidate of candidates) {
    const match = findSnapshotBase(candidate, pricing);
    if (match) return match;
  }

  if (candidates.some(candidate => candidate.endsWith(':free'))) {
    return FREE_OPENROUTER_PRICE;
  }

  if (model.startsWith('ollama/') || model.startsWith('ollama/local/')) {
    return FREE_OLLAMA_PRICE;
  }

  return { inputPer1M: 0, outputPer1M: 0, provider: 'unknown' };
}

function getModelCandidates(model: string): string[] {
  const trimmed = model.trim();
  const candidates = new Set<string>([trimmed]);
  const slash = trimmed.indexOf('/');

  if (slash > 0) {
    candidates.add(trimmed.slice(slash + 1));
  }

  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash > 0) {
    candidates.add(trimmed.slice(lastSlash + 1));
  }

  if (trimmed.startsWith('ollama/local/')) {
    candidates.add(trimmed.slice('ollama/local/'.length));
  }

  return Array.from(candidates).filter(Boolean);
}

function findSnapshotBase(model: string, pricing: Record<string, ModelPrice>): ModelPrice | undefined {
  const key = Object.keys(pricing)
    .filter(k => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];

  return key ? pricing[key] : undefined;
}

/**
 * Calculate USD cost for a single completion.
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = getModelPricing(model);
  const inputCost = (promptTokens / 1_000_000) * price.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * price.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Batch cost calculation for an array of token usages.
 */
export function aggregateCost(
  records: Array<{ model: string; promptTokens: number; completionTokens: number }>,
): { totalUsd: number; byModel: Record<string, { tokens: number; usd: number }> } {
  const byModel: Record<string, { tokens: number; usd: number }> = {};
  let totalUsd = 0;

  for (const r of records) {
    const cost = calculateCost(r.model, r.promptTokens, r.completionTokens);
    totalUsd += cost;
    if (!byModel[r.model]) byModel[r.model] = { tokens: 0, usd: 0 };
    byModel[r.model]!.tokens += r.promptTokens + r.completionTokens;
    byModel[r.model]!.usd += cost;
  }

  return { totalUsd, byModel };
}

/**
 * List all registered models (for dashboard introspection).
 */
export function listKnownModels(): Array<{ model: string; pricing: ModelPrice }> {
  const pricing = loadPricing();
  return Object.entries(pricing).map(([model, p]) => ({ model, pricing: p }));
}

/**
 * Reset the cache — useful for tests or when env vars change at runtime.
 */
export function resetPricingCache(): void {
  _pricingCache = null;
}
