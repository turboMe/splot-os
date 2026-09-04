/**
 * Model Capability Registry
 *
 * Central registry of all available LLM models (local + cloud) with their
 * capabilities, safe context limits, VRAM requirements, and concurrent slots.
 *
 * Used by the Smart Router (Etap 8) to assign subtasks to the cheapest
 * capable model, respecting GPU memory limits and parallelism constraints.
 *
 * Context limits are conservative to prevent system freezes on RTX 5060 Ti (16 GB).
 *
 * NOTE: Model IDs are sourced from config/model-manifest.ts (Single Source of Truth).
 * Only capability metadata (strengths, weaknesses, VRAM, etc.) is defined here.
 */

import { models, executionTierPresets } from './model-manifest.js';
import { getGpuGuard } from '../services/gpu-guard.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex';
export type ModelTier = 'local-micro' | 'local-light' | 'local-heavy' | 'cloud-free' | 'cloud-fast' | 'cloud-pro';

export interface ModelCapability {
  /** Mastra model ID, e.g. 'ollama/local/qwen3:1.7b' or 'google/gemini-2.5-pro' */
  modelId: string;
  /** Human-readable display name */
  name: string;
  /** Tier determines routing priority and cost */
  tier: ModelTier;
  /** Highest complexity this model can handle reliably */
  maxComplexity: TaskComplexity;
  /** What this model is good at */
  strengths: string[];
  /** What this model struggles with */
  weaknesses: string[];
  /** VRAM usage in MB (0 for cloud models) */
  vramMb: number;
  /** Safe context window (num_ctx) — conservative to prevent freezes */
  safeContextWindow: number;
  /** How many instances can run concurrently (GPU slot limit for local) */
  concurrentSlots: number;
  /** Relative cost per call (0 = free local, 1-10 = cloud) */
  costPerCall: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Is model currently available? (checked at startup) */
  available: boolean;
}

// ── Complexity ordering ──────────────────────────────────────────────────────

const COMPLEXITY_ORDER: Record<TaskComplexity, number> = {
  trivial: 0,
  simple: 1,
  moderate: 2,
  complex: 3,
};

export function complexityMeetsRequirement(
  modelMax: TaskComplexity,
  required: TaskComplexity,
): boolean {
  return COMPLEXITY_ORDER[modelMax] >= COMPLEXITY_ORDER[required];
}

// ── Local models (Ollama) ────────────────────────────────────────────────────

const localModels: ModelCapability[] = [
  // ── Tier: local-micro — router, JSON, classifier ──
  {
    modelId: models['qwen3.5-4b'],
    name: 'Qwen 3.5 4B',
    tier: 'local-micro',
    maxComplexity: 'trivial',
    strengths: ['json-extraction', 'classification', 'routing', 'fast'],
    weaknesses: ['code-generation', 'multi-file', 'reasoning'],
    vramMb: 3500,
    safeContextWindow: 32768,
    concurrentSlots: 3,
    costPerCall: 0,
    avgLatencyMs: 2500,
    available: true,
  },

  // ── Tier: local-light — simple edits, tool calling ──
  {
    modelId: models['gemma4-12b-official'],
    name: 'Gemma 4 12B (Official)',
    tier: 'local-light',
    maxComplexity: 'moderate',
    strengths: ['reasoning', 'coding', 'typescript', 'tool-calling', 'multimodal', 'long-context'],
    weaknesses: ['very-complex-refactors'],
    vramMb: 8000,
    safeContextWindow: 65536,
    concurrentSlots: 1,
    costPerCall: 0,
    avgLatencyMs: 5000,
    available: true,
  },
  {
    modelId: models['gemma4-e4b'],
    name: 'Gemma 4 E4B (MoE 26B/4B)',
    tier: 'local-light',
    maxComplexity: 'moderate',
    strengths: ['typescript', 'reasoning', 'tool-calling', 'multimodal', 'single-file-edit'],
    weaknesses: ['very-complex-refactors'],
    vramMb: 10000,
    safeContextWindow: 65536,
    concurrentSlots: 1,
    costPerCall: 0,
    avgLatencyMs: 8000,
    available: true,
  },
];

// ── Cloud models ─────────────────────────────────────────────────────────────

const cloudModels: ModelCapability[] = [
  // ── Tier: cloud-fast — szybkie, tanie ──
  {
    modelId: models['gpt-5.3-mini'],
    name: 'GPT-5.3 Mini',
    tier: 'cloud-fast',
    maxComplexity: 'moderate',
    strengths: ['fast', 'typescript', 'json', 'simple-edits', 'tool-calling'],
    weaknesses: ['complex-architecture'],
    vramMb: 0,
    safeContextWindow: 128000,
    concurrentSlots: 10,
    costPerCall: 1,
    avgLatencyMs: 3000,
    available: true,
  },
  {
    modelId: models['gemini-2.5-flash'],
    name: 'Gemini 2.5 Flash',
    tier: 'cloud-fast',
    maxComplexity: 'moderate',
    strengths: ['fast', 'code-review', 'analysis', 'multi-file', 'long-context'],
    weaknesses: ['very-complex-refactors'],
    vramMb: 0,
    safeContextWindow: 1000000,
    concurrentSlots: 10,
    costPerCall: 2,
    avgLatencyMs: 4000,
    available: true,
  },
  {
    modelId: models['claude-haiku-4.5'],
    name: 'Claude Haiku 4.5',
    tier: 'cloud-fast',
    maxComplexity: 'simple',
    strengths: ['fast', 'review', 'validation', 'json'],
    weaknesses: ['complex-code', 'architecture'],
    vramMb: 0,
    safeContextWindow: 200000,
    concurrentSlots: 10,
    costPerCall: 1,
    avgLatencyMs: 2000,
    available: true,
  },

  // ── Tier: cloud-pro — pełna moc ──
  {
    modelId: models['gemini-2.5-pro'],
    name: 'Gemini 2.5 Pro',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['architecture', 'multi-file-refactor', 'reasoning', 'planning', 'long-context'],
    weaknesses: [],
    vramMb: 0,
    safeContextWindow: 1000000,
    concurrentSlots: 5,
    costPerCall: 8,
    avgLatencyMs: 10000,
    available: true,
  },
  {
    modelId: models['gpt-5.5'],
    name: 'GPT-5.5',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['architecture', 'complex-code', 'reasoning', 'planning'],
    weaknesses: [],
    vramMb: 0,
    safeContextWindow: 200000,
    concurrentSlots: 5,
    costPerCall: 10,
    avgLatencyMs: 8000,
    available: true,
  },
  {
    modelId: models['claude-sonnet-4.6'],
    name: 'Claude Sonnet 4.6',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['code-generation', 'architecture', 'reasoning', 'safety'],
    weaknesses: [],
    vramMb: 0,
    safeContextWindow: 200000,
    concurrentSlots: 5,
    costPerCall: 8,
    avgLatencyMs: 6000,
    available: true,
  },
  {
    modelId: models['claude-opus-4.8'],
    name: 'Claude Opus 4.8',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['frontend-design', 'taste', 'long-context', 'reasoning', 'complex-code'],
    weaknesses: ['cost', 'latency'],
    vramMb: 0,
    safeContextWindow: 200000,
    concurrentSlots: 3,
    costPerCall: 10,
    avgLatencyMs: 10000,
    available: true,
  },

  // ── DeepSeek (OpenAI-compatible, tani, 1M ctx) ──
  {
    modelId: models['deepseek-v4-flash'],
    name: 'DeepSeek V4 Flash',
    tier: 'cloud-fast',
    maxComplexity: 'moderate',
    strengths: ['fast', 'cheap', 'json', 'tool-calling', 'long-context', 'high-volume'],
    weaknesses: ['no-privacy', 'very-complex-architecture'],
    vramMb: 0,
    safeContextWindow: 128000,
    concurrentSlots: 10,
    costPerCall: 1,
    avgLatencyMs: 4000,
    available: !!process.env.DEEPSEEK_API_KEY,
  },
  {
    modelId: models['deepseek-v4-pro'],
    name: 'DeepSeek V4 Pro',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['reasoning', 'code-generation', 'long-context', 'thinking-mode', 'cheap-pro'],
    weaknesses: ['no-privacy'],
    vramMb: 0,
    safeContextWindow: 128000,
    concurrentSlots: 5,
    costPerCall: 3,
    avgLatencyMs: 8000,
    available: !!process.env.DEEPSEEK_API_KEY,
  },
];

// ── Cloud-free models (OpenRouter free tier, Phase 4.1) ──────────────────────

const cloudFreeModels: ModelCapability[] = [
  {
    modelId: models['nemotron-super-free'],
    name: 'Nemotron Super 120B (free)',
    tier: 'cloud-free',
    maxComplexity: 'moderate',
    strengths: ['reasoning', 'planning', 'json', 'code-review', 'analysis'],
    weaknesses: ['rate-limited', 'latency-variance', 'no-privacy'],
    vramMb: 0,
    safeContextWindow: 32000,
    concurrentSlots: 5,
    costPerCall: 0,
    avgLatencyMs: 8000,
    available: !!process.env.OPENROUTER_API_KEY,
  },
  {
    modelId: models['nemotron-ultra-free'],
    name: 'Nemotron Ultra 550B (free - 1M ctx)',
    tier: 'cloud-free',
    maxComplexity: 'complex',
    strengths: ['heavy-reasoning', 'planning', '1M-context', 'architecture'],
    weaknesses: ['rate-limited', 'latency-variance', 'no-privacy'],
    vramMb: 0,
    safeContextWindow: 1000000,
    concurrentSlots: 5,
    costPerCall: 0,
    avgLatencyMs: 10000,
    available: !!process.env.OPENROUTER_API_KEY,
  },
  {
    modelId: models['cohere-code-free'],
    name: 'Cohere North Mini Code (free - 256k ctx)',
    tier: 'cloud-free',
    maxComplexity: 'moderate',
    strengths: ['code-generation', 'typescript', 'fast-coding', '256k-context'],
    weaknesses: ['rate-limited', 'no-privacy'],
    vramMb: 0,
    safeContextWindow: 256000,
    concurrentSlots: 5,
    costPerCall: 0,
    avgLatencyMs: 2500,
    available: !!process.env.OPENROUTER_API_KEY,
  },
  {
    modelId: models['gemma4-31b-free'],
    name: 'Gemma 4 31B Cloud (free - 262k ctx)',
    tier: 'cloud-free',
    maxComplexity: 'moderate',
    strengths: ['reasoning', 'coding', 'typescript', 'tool-calling', '262k-context'],
    weaknesses: ['rate-limited', 'no-privacy'],
    vramMb: 0,
    safeContextWindow: 262144,
    concurrentSlots: 5,
    costPerCall: 0,
    avgLatencyMs: 3500,
    available: !!process.env.OPENROUTER_API_KEY,
  },
  {
    modelId: models['nemotron-nano-free'],
    name: 'Nemotron Nano 30B (free)',
    tier: 'cloud-free',
    maxComplexity: 'simple',
    strengths: ['classification', 'json-extraction', 'fast', 'routing'],
    weaknesses: ['complex-code', 'architecture', 'rate-limited'],
    vramMb: 0,
    safeContextWindow: 16000,
    concurrentSlots: 5,
    costPerCall: 0,
    avgLatencyMs: 3000,
    available: !!process.env.OPENROUTER_API_KEY,
  },

  {
    modelId: models['groq-gpt-oss-120b'],
    name: 'Groq GPT-OSS 120B (production, LPU)',
    tier: 'cloud-free',
    maxComplexity: 'complex',
    strengths: ['reasoning', 'code-generation', 'planning', 'ultra-fast-inference', 'tool-calling'],
    weaknesses: ['rate-limited-rpm'],
    vramMb: 0,
    safeContextWindow: 131072,
    concurrentSlots: 5,
    costPerCall: 0,
    avgLatencyMs: 400,
    available: !!process.env.GROQ_API_KEY,
  },
  {
    modelId: models['groq-gpt-oss-20b'],
    name: 'Groq GPT-OSS 20B (production, fast LPU)',
    tier: 'cloud-free',
    maxComplexity: 'moderate',
    strengths: ['fast', 'reasoning', 'routing', 'json', 'classification'],
    weaknesses: ['rate-limited-rpm'],
    vramMb: 0,
    safeContextWindow: 131072,
    concurrentSlots: 5,
    costPerCall: 0,
    avgLatencyMs: 200,
    available: !!process.env.GROQ_API_KEY,
  },
  // ── ZenMux ──
  {
    modelId: models['kimi-k3'],
    name: 'Moonshot Kimi K3 (via ZenMux PAYG)',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['reasoning', 'coding', 'long-context', 'math', 'planning', 'analysis'],
    weaknesses: ['rate-limited', 'paid-payg'],
    vramMb: 0,
    safeContextWindow: 128000,
    concurrentSlots: 3,
    costPerCall: 5,
    avgLatencyMs: 8000,
    available: !!process.env.ZENMUX_API_KEY,
  },
  {
    modelId: models['zenmux-glm-5.3-free'],
    name: 'Z.AI GLM 5.3 (free via ZenMux)',
    tier: 'cloud-free',
    maxComplexity: 'complex',
    strengths: ['coding', 'reasoning', 'agentic', 'workflow', 'design', 'fast'],
    weaknesses: ['rate-limited', 'sunset-risk'],
    vramMb: 0,
    safeContextWindow: 128000,
    concurrentSlots: 3,
    costPerCall: 0,
    avgLatencyMs: 6000,
    available: !!process.env.ZENMUX_API_KEY,
  },
  {
    modelId: models['zenmux-dots3-free'],
    name: 'Dots Studio Dots3 Note (free via ZenMux)',
    tier: 'cloud-free',
    maxComplexity: 'moderate',
    strengths: ['summarization', 'notes', 'extraction'],
    weaknesses: ['rate-limited'],
    vramMb: 0,
    safeContextWindow: 32000,
    concurrentSlots: 3,
    costPerCall: 0,
    avgLatencyMs: 5000,
    available: !!process.env.ZENMUX_API_KEY,
  },
  {
    modelId: models['zenmux-agnes-flash-free'],
    name: 'Sapiens AI Agnes 2.5 Flash (free via ZenMux)',
    tier: 'cloud-free',
    maxComplexity: 'moderate',
    strengths: ['fast', 'classification', 'extraction'],
    weaknesses: ['rate-limited'],
    vramMb: 0,
    safeContextWindow: 32000,
    concurrentSlots: 5,
    costPerCall: 0,
    avgLatencyMs: 3000,
    available: !!process.env.ZENMUX_API_KEY,
  },
];

// ── Embedding models (not for routing, but documented) ───────────────────────

// ollama/local/bge-m3 — 1.2 GB, embedding only
// ollama/local/nomic-embed-text — 274 MB, embedding only

// ── Registry ─────────────────────────────────────────────────────────────────

export const modelRegistry: ModelCapability[] = [...localModels, ...cloudFreeModels, ...cloudModels];

/**
 * Get all models that can handle a given complexity level.
 * Sorted by cost (cheapest first), then by latency.
 */
export function getCapableModels(
  requiredComplexity: TaskComplexity,
  preferLocal: boolean = true,
): ModelCapability[] {
  return modelRegistry
    .filter((m) => m.available && complexityMeetsRequirement(m.maxComplexity, requiredComplexity))
    .sort((a, b) => {
      // Local preference if requested
      if (preferLocal) {
        const aLocal = a.tier.startsWith('local') ? 0 : 1;
        const bLocal = b.tier.startsWith('local') ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
      }
      // Then by cost
      if (a.costPerCall !== b.costPerCall) return a.costPerCall - b.costPerCall;
      // Then by latency
      return a.avgLatencyMs - b.avgLatencyMs;
    });
}

/**
 * Get the cheapest model that can handle a given complexity.
 * Falls back to cloud if no local model available.
 */
export function getCheapestCapableModel(
  requiredComplexity: TaskComplexity,
): ModelCapability | undefined {
  return getCapableModels(requiredComplexity, true)[0];
}

/**
 * Total VRAM budget in MB — usable by Ollama models.
 *
 * Resolution priority:
 * 1. Env var MODEL_VRAM_BUDGET_MB (for containers / CI / manual override)
 * 2. Dynamic detection via GpuGuard (auto-detect GPU, reserve for compositor)
 * 3. Fallback: 0 (cloud-only mode if no GPU and no override)
 *
 * NOTE: This is the *planning* budget — the Smart Router also does
 * *runtime* pre-flight checks via GpuGuard.getSnapshot() before dispatch.
 */
function resolveVramBudget(): number {
  // Explicit override takes priority (useful for containers, CI, headless servers)
  const envOverride = process.env.MODEL_VRAM_BUDGET_MB;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }

  // Dynamic detection via GpuGuard (static import — no circular dependency)
  try {
    const guard = getGpuGuard();
    return guard.getSafeVramBudgetMb();
  } catch {
    // GpuGuard not available (e.g. missing nvidia-smi in container)
    console.warn('[ModelCapabilities] GpuGuard unavailable — using 0 MB VRAM budget (cloud-only)');
    return 0;
  }
}

export const VRAM_BUDGET_MB = resolveVramBudget();

// ── Execution Tiers (Etap V3) ────────────────────────────────────────────────

export type ExecutionTier = 'fast' | 'balanced' | 'pro' | 'private';

export interface TierModelMapping {
  tier: ExecutionTier;
  primaryModelId: string;
  fallbackModelId: string;
  localAlternativeModelId?: string;
  maxRecommendedComplexity: TaskComplexity;
}

export const EXECUTION_TIERS: Record<ExecutionTier, TierModelMapping> = {
  fast: {
    tier: 'fast',
    primaryModelId: models[executionTierPresets.fast.primary] || models['gemini-2.5-flash'],
    fallbackModelId: models[executionTierPresets.fast.fallback] || models['gemini-2.5-flash'],
    localAlternativeModelId: models[executionTierPresets.private.primary],
    maxRecommendedComplexity: 'simple',
  },
  balanced: {
    tier: 'balanced',
    primaryModelId: models[executionTierPresets.balanced.primary] || models['gemini-2.5-flash'],
    fallbackModelId: models[executionTierPresets.balanced.fallback] || models['deepseek-v4-flash'],
    localAlternativeModelId: models[executionTierPresets.private.primary],
    maxRecommendedComplexity: 'moderate',
  },
  pro: {
    tier: 'pro',
    primaryModelId: models[executionTierPresets.pro.primary] || models['deepseek-v4-pro'],
    fallbackModelId: models[executionTierPresets.pro.fallback] || models['claude-sonnet-4.6'],
    localAlternativeModelId: models['qwen3.6-27b'],
    maxRecommendedComplexity: 'complex',
  },
  private: {
    tier: 'private',
    primaryModelId: models[executionTierPresets.private.primary] || models['qwen3.5-4b'],
    fallbackModelId: models[executionTierPresets.private.fallback] || models['gemma4-12b-official'],
    localAlternativeModelId: models[executionTierPresets.private.primary],
    maxRecommendedComplexity: 'moderate',
  },
};

export interface ResolveExecutionModelOptions {
  requestedTier?: ExecutionTier | 'auto';
  skills?: Array<
    | string
    | {
        name?: string;
        recommendedTier?: 'fast' | 'balanced' | 'pro' | 'private';
        minComplexity?: string;
        preferLocal?: boolean;
        [key: string]: any;
      }
  >;
  agentDefaultModelId?: string;
  preferLocal?: boolean;
}

export function resolveExecutionModel(options: ResolveExecutionModelOptions): string {
  // 1. Explicit private request or preferLocal flag
  if (options.requestedTier === 'private' || options.preferLocal) {
    return EXECUTION_TIERS.private.primaryModelId;
  }

  // 2. Explicit tier request
  if (options.requestedTier && options.requestedTier !== 'auto') {
    const tierConfig = EXECUTION_TIERS[options.requestedTier];
    if (tierConfig) {
      return tierConfig.primaryModelId;
    }
  }

  // 3. Skill-based tier deduction (SOP leverage rule)
  if (options.skills && options.skills.length > 0) {
    const parsedSkills = options.skills.map((s) => {
      if (typeof s === 'string') {
        try {
          const { getSkillRegistry } = require('../services/skill-registry.js');
          const found = getSkillRegistry().getSkill(s);
          if (found) return found.metadata;
        } catch {
          // In ESM or if registry is uninitialized, fall back to string heuristics
        }
        return { name: s };
      }
      return (s as any).metadata || s;
    });

    // Check if any skill requires private/local execution
    const anySkillPrivate = parsedSkills.some(
      (s: any) => s.recommendedTier === 'private' || s.preferLocal === true
    );
    if (anySkillPrivate) {
      return EXECUTION_TIERS.private.primaryModelId;
    }

    const allSkillsFast = parsedSkills.every(
      (s: any) => s.recommendedTier === 'fast' || s.minComplexity === 'trivial' || s.minComplexity === 'simple'
    );
    if (allSkillsFast) {
      return EXECUTION_TIERS.fast.primaryModelId;
    }

    const anySkillPro = parsedSkills.some(
      (s: any) => s.recommendedTier === 'pro' || s.minComplexity === 'complex' || s.minComplexity === 'critical'
    );
    if (anySkillPro) {
      return EXECUTION_TIERS.pro.primaryModelId;
    }

    return EXECUTION_TIERS.balanced.primaryModelId;
  }

  // 4. Fallback to agent default model or balanced tier
  return options.agentDefaultModelId || EXECUTION_TIERS.balanced.primaryModelId;
}
