/**
 * Unified Model Manifest — Single Source of Truth
 *
 * ALL model assignments for agents, workflows, worker presets, and
 * infrastructure live here. Change a model once → every consumer picks it up.
 *
 * Structure:
 *   Section 1: Model Inventory    — what models exist (aliases → full IDs)
 *   Section 2: Agent Assignments   — which agent uses which model
 *   Section 3: Workflow Assignments — which workflow step uses which model
 *   Section 4: Worker Presets      — run_worker tool preset → model mapping
 *   Section 5: Infrastructure      — embedding, observational memory, n8n defaults
 *   Section 7: Design Assignments   — design domain specialist models
 *   Section 8: Writer Assignments   — writer domain specialist models
 *   Section 9: Film Assignments     — filmmaker domain specialist models
 *
 * Usage in consumers:
 *   import { agentModels, resolveModelId } from '../config/model-manifest.js';
 *   model: resolveModelId(agentModels.metaAgent),
 */

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1: MODEL INVENTORY
//
// Human-readable alias → full Mastra model ID.
// Add new models here (local, cloud, OpenRouter) and use the alias everywhere.
// ═════════════════════════════════════════════════════════════════════════════

export const models = {
  // ═══════════════════════════════════════════════════════════════════════════
  // LOCAL (Ollama) — darmowe, prywatne, limitowane VRAM
  // ═══════════════════════════════════════════════════════════════════════════
  'qwen3.5-4b': 'ollama/local/qwen3.5:4b',
  'gemma4-e4b': 'ollama/local/gemma4:e4b',
  'qwen3.6-27b': 'ollama/local/qwen3.6:27b',
  'gemma4-12b-official': 'ollama/local/gemma4:12b',


  // ═══════════════════════════════════════════════════════════════════════════
  // GOOGLE (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  // ═══════════════════════════════════════════════════════════════════════════
  'gemini-3.7-flash': 'google/gemini-3.7-flash',                       // GA, najnowszy Flash, 1M ctx, $0.75/$3.75 intro do 2026-12-31
  'gemini-3.6-flash': 'google/gemini-3.6-flash',                       // GA, szybki agentic/coding, 1M ctx, $0.75/$3.75 intro do 2026-12-31
  'gemini-3.5-flash': 'google/gemini-3.5-flash',                       // GA, agentic+coding, 1M ctx, $1.50/$9 per 1M
  'gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',             // GA, high-volume/subagenci, $0.30/$2.50 per 1M
  // Rolling aliases Google — wygodne dla latest, ale do evali lepsze są stabilne aliasy powyżej.
  'gemini-flash-latest': 'google/gemini-flash-latest',
  'gemini-flash-lite-latest': 'google/gemini-flash-lite-latest',
  'gemini-3.1-pro-preview': 'google/gemini-3.1-pro-preview',           // 🆕 najsilniejszy pro preview, $2/$12 per 1M
  'gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite',             // 🆕 GA lite flash (bez -preview suffix)
  'gemini-3.1-flash-lite-preview': 'google/gemini-3.1-flash-lite-preview', // preview light flash
  'gemini-3-flash-preview': 'google/gemini-3-flash-preview',           // 🆕 pośredni flash
  'gemini-2.5-pro': 'google/gemini-2.5-pro',                           // flagship, 1M ctx, reasoning + code
  'gemini-2.5-flash': 'google/gemini-2.5-flash',                       // fast, 1M ctx, daily driver
  'gemini-2.5-flash-lite': 'google/gemini-2.5-flash-lite',             // 🆕 ultra-tani flash lite
  'gemini-2.5-flash-image': 'google/gemini-2.5-flash-image',           // 🆕 multimodal image generation
  'gemini-2.0-flash': 'google/gemini-2.0-flash',                       // ⚠️ shutdown 2026-06-01; zachowany tylko dla zgodności
  'gemini-2.0-flash-lite': 'google/gemini-2.0-flash-lite',             // ⚠️ shutdown 2026-06-01; zachowany tylko dla zgodności
  'gemini-embedding-001': 'google/gemini-embedding-001',               // najlepszy embed model Google

  // ═══════════════════════════════════════════════════════════════════════════
  // OPENAI (klucz: OPENAI_API_KEY)
  // ═══════════════════════════════════════════════════════════════════════════
  'gpt-5.5': 'openai/gpt-5.5',                  // flagship, najnowszy
  'gpt-5.4-mini': 'openai/gpt-5.4-mini',             // szybki, tani, dobry do JSON (v5.4)
  'gpt-5.3-mini': 'openai/gpt-5.3-mini',             // szybki, tani, dobry do JSON
  'gpt-5.1': 'openai/gpt-5.1',                  // solidny, tańszy od 5.5
  'gpt-4.1': 'openai/gpt-4.1',                  // coding-focused, 1M ctx
  'gpt-4.1-mini': 'openai/gpt-4.1-mini',             // lekki, szybki, coding
  'gpt-4.1-nano': 'openai/gpt-4.1-nano',             // ultra-tani, klasyfikacja
  'o3': 'openai/o3',                        // deep reasoning (o-series)
  'o3-mini': 'openai/o3-mini',                   // reasoning, szybszy
  'o4-mini': 'openai/o4-mini',                   // najnowszy reasoning mini

  // ═══════════════════════════════════════════════════════════════════════════
  // ANTHROPIC (klucz: ANTHROPIC_API_KEY)
  // ═══════════════════════════════════════════════════════════════════════════
  'claude-fable-5': 'anthropic/claude-fable-5',              // 🆕 flagship reasoning, $10/$50, 1M ctx
  'claude-opus-4.8': 'anthropic/claude-opus-4-8',            // 🆕 najnowszy Opus, $5/$25
  'claude-opus-4.7': 'anthropic/claude-opus-4-7',            // 🆕 Opus 4.7, $5/$25
  'claude-opus-4.6': 'anthropic/claude-opus-4-6',            // Opus 4.6, $5/$25
  'claude-opus-4.5': 'anthropic/claude-opus-4-5',            // 🆕 Opus 4.5, $5/$25
  'claude-opus-4.1': 'anthropic/claude-opus-4-1',            // 🆕 legacy Opus 4.1, $15/$75
  'claude-opus-4.0': 'anthropic/claude-opus-4-20250514',     // 🆕 legacy Opus 4.0, $15/$75
  'claude-sonnet-4.6': 'anthropic/claude-sonnet-4-6',        // Sonnet 4.6, best value
  'claude-sonnet-4.5': 'anthropic/claude-sonnet-4-5',        // 🆕 Sonnet 4.5, $3/$15
  'claude-sonnet-4.0': 'anthropic/claude-sonnet-4-20250514', // 🆕 legacy Sonnet 4.0, $3/$15
  'claude-haiku-4.5': 'anthropic/claude-haiku-4-5',          // fastest, cheapest
  'claude-haiku-3.5': 'anthropic/claude-3-5-haiku-latest',   // 🆕 legacy 3.5 haiku, $0.80/$4

  // ═══════════════════════════════════════════════════════════════════════════
  // DEEPSEEK (klucz: DEEPSEEK_API_KEY) — OpenAI-compatible, tani, 1M ctx
  // Format: custom-deepseek/deepseek/<model> (custom gateway, 3-segment ID)
  // ═══════════════════════════════════════════════════════════════════════════
  'deepseek-v4-flash': 'custom-deepseek/deepseek/deepseek-v4-flash',  // 🆕 1M ctx, thinking mode, $0.14/$0.28 (high-volume)
  'deepseek-v4-pro': 'custom-deepseek/deepseek/deepseek-v4-pro',      // 🆕 1M ctx, thinking mode, $0.435/$0.87 (mocniejszy)

  // ═══════════════════════════════════════════════════════════════════════════
  // OPENROUTER FREE (klucz: OPENROUTER_API_KEY) — $0 cost, rate-limited
  // ═══════════════════════════════════════════════════════════════════════════
  // Natywny router OpenRoutera. Dobiera bieżący darmowy model pod wymagania
  // requestu (m.in. tools, structured output i vision), więc ten alias jest
  // stabilny nawet wtedy, gdy konkretne modele :free pojawiają się lub znikają.
  'openrouter-free-auto': 'openrouter/openrouter/free',
  'nemotron-ultra-free': 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  'nemotron-super-free': 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  'nemotron-nano-free': 'openrouter/nvidia/nemotron-3-nano-30b-a3b:free',
  'nemotron-omni-reasoning-free': 'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'cohere-code-free': 'openrouter/cohere/north-mini-code:free',
  'gemma4-31b-free': 'openrouter/google/gemma-4-31b-it:free',
  'minimax-free': 'openrouter/minimax/minimax-m2.5:free',
  'glm-free': 'openrouter/z-ai/glm-4.5-air:free',
  'gpt-oss-120b-free': 'openrouter/openai/gpt-oss-120b:free',
  'gpt-oss-20b-free': 'openrouter/openai/gpt-oss-20b:free',
  'llama-3.3-70b-free': 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
  'qwen-2.5-72b-free': 'openrouter/qwen/qwen-2.5-72b-instruct:free',


  // ═══════════════════════════════════════════════════════════════════════════
  // GROQ CLOUD NATIVE (klucz: GROQ_API_KEY) — ultra-fast LPU (<300ms)
  // Format: custom-groq/groq/<model> (custom gateway, 3-segment ID)
  // ═══════════════════════════════════════════════════════════════════════════
  'groq-gpt-oss-120b': 'custom-groq/groq/openai/gpt-oss-120b',      // production: complex reasoning, code, long-form
  'groq-gpt-oss-20b': 'custom-groq/groq/openai/gpt-oss-20b',        // production: fast extraction, classification, summaries
  'groq-qwen-27b': 'custom-groq/groq/qwen/qwen3.6-27b',             // preview/canary only; not assigned to production workers


  // ═══════════════════════════════════════════════════════════════════════════
  // ZENMUX (klucz: ZENMUX_API_KEY) — AI model aggregator, OpenAI-compatible
  // Format: custom-zenmux/<provider>/<model> (3-segment ID)
  // Base URL: https://zenmux.ai/api/v1
  // ═══════════════════════════════════════════════════════════════════════════
  'kimi-k3': 'custom-zenmux/moonshotai/kimi-k3',                          // 🆕 Moonshot Kimi K3, 1M ctx, multimodal, reasoning (PAYG: $2.70 in / $13.50 out)
  'zenmux-glm-5.3-free': 'custom-zenmux/z-ai/glm-5.3-free',               // 🆕 Z.AI GLM 5.3 ($0/$0 free tier, reasoning, coding, 128k ctx)
  'glm-5.3-free': 'custom-zenmux/z-ai/glm-5.3-free',                      // alias GLM 5.3 Free ($0/$0)
  'zenmux-dots3-free': 'custom-zenmux/dots-studio/dots3-note-prev',       // 🆕 Dots3 Note ($0/$0 free tier)
  'zenmux-agnes-flash-free': 'custom-zenmux/sapiens-ai/agnes-2.5-flash',  // 🆕 Agnes 2.5 Flash ($0/$0 free tier)


  // NOTE: the former "CEREBRAS FREE" section ('cerebras-llama-3.1-70b'/'-8b') was removed
  // 2026-07-29 — both mapped to 'openrouter/cerebras/llama-3.1-70b'/'-8b', which OpenRouter
  // rejects as an invalid model ID. Root cause: every other entry in this file uses
  // openrouter/<model-AUTHOR>/<model> (nvidia, google, meta-llama, ...); "cerebras" is an
  // inference PROVIDER, not a model author, and was never a valid OpenRouter namespace.
  // Confirmed live: Cerebras's current OpenRouter lineup (openrouter.ai/provider/cerebras)
  // serves google/gemma-4-31b-it, z-ai/glm-4.7, openai/gpt-oss-120b — no Llama 3.1 at all.
  // weatherAgent/analyticsAgent repointed to 'gemini-3.1-flash-lite' below.

  // ═══════════════════════════════════════════════════════════════════════════
  // OPENROUTER PAID (klucz: OPENROUTER_API_KEY)
  // ═══════════════════════════════════════════════════════════════════════════
  'or-gemini-3.7-flash': 'openrouter/google/gemini-3.7-flash',
  'or-claude-sonnet-5': 'openrouter/anthropic/claude-sonnet-5',
  'or-claude-opus-5': 'openrouter/anthropic/claude-opus-5',
  // Rolling aliases: automatycznie przechodzą na najnowszy model danej rodziny.
  // Do powtarzalnych evali używaj przypiętych aliasów powyżej.
  'or-gemini-flash-latest': 'openrouter/~google/gemini-flash-latest',
  'or-claude-sonnet-latest': 'openrouter/~anthropic/claude-sonnet-latest',
  'or-claude-opus-latest': 'openrouter/~anthropic/claude-opus-latest',
  'or-claude-opus-4.8': 'openrouter/anthropic/claude-opus-4.8',
  'or-claude-opus-4.6': 'openrouter/anthropic/claude-opus-4.6',
  'or-claude-sonnet-4.6': 'openrouter/anthropic/claude-sonnet-4.6',
  'or-claude-haiku-4.5': 'openrouter/anthropic/claude-haiku-4.5',
  'or-gpt-5.4': 'openrouter/openai/gpt-5.4',
  'or-gpt-5.5': 'openrouter/openai/gpt-5.5',
  'or-gemini-3.5-flash': 'openrouter/google/gemini-3.5-flash',
  'or-qwen3.7-max': 'openrouter/qwen/qwen-3.7-max',

  // ═══════════════════════════════════════════════════════════════════════════
  // EMBEDDING — modele wektorowe (nie do generacji tekstu)
  // ═══════════════════════════════════════════════════════════════════════════
  'bge-m3': 'ollama/local/bge-m3',

  // ═══════════════════════════════════════════════════════════════════════════
  // IMAGE GENERATION — modele do generowania obrazów
  // ═══════════════════════════════════════════════════════════════════════════

  // Google Imagen 4 (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  'imagen-4-fast': 'google/imagen-4-fast',             // szybki, tańszy
  'imagen-4': 'google/imagen-4',                  // standard, dobra jakość
  'imagen-4-ultra': 'google/imagen-4-ultra',            // najwyższa jakość, photorealistic

  // Google Nano Banana (natywna generacja obrazów w Gemini)
  'gemini-image-flash': 'google/gemini-3.1-flash-image-preview',  // szybki, do 4K
  'gemini-image-pro': 'google/gemini-3-pro-image-preview',      // najwyższa jakość Gemini

  // OpenAI GPT Image (klucz: OPENAI_API_KEY)
  'gpt-image-2': 'openai/gpt-image-2',              // flagship, thinking mode, text rendering
  'gpt-image-1': 'openai/gpt-image-1',              // starszy, stabilny

  // OpenRouter FLUX (klucz: OPENROUTER_API_KEY — płatne, nie free)
  'flux-2-pro': 'openrouter/black-forest-labs/flux.2-pro',  // najwyższa jakość FLUX

  // ═══════════════════════════════════════════════════════════════════════════
  // VIDEO GENERATION — modele do generowania wideo
  // ═══════════════════════════════════════════════════════════════════════════

  // Google Veo (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  'veo-3.1': 'google/veo-3.1',                   // flagship, audio+video, 4K
  'veo-3.1-lite': 'google/veo-3.1-lite',              // lżejszy, tańszy

  // ═══════════════════════════════════════════════════════════════════════════
  // TTS (Text-to-Speech) — synteza mowy
  // ═══════════════════════════════════════════════════════════════════════════

  // OpenAI TTS (klucz: OPENAI_API_KEY)
  'tts-1': 'openai/tts-1',                     // real-time, niski latency
  'tts-1-hd': 'openai/tts-1-hd',                 // wyższa jakość, wolniejszy
  'gpt-4o-mini-tts': 'openai/gpt-4o-mini-tts',          // naturalny, emocje, 11+ głosów

  // Google TTS (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  'gemini-tts-flash': 'google/gemini-3.1-flash-tts',          // 70+ języków, tagi emocji [whispers] [laughs]
  'gemini-tts-2.5-flash': 'google/gemini-2.5-flash-preview-tts',  // 🆕 TTS na bazie 2.5-flash
  'gemini-tts-2.5-pro': 'google/gemini-2.5-pro-preview-tts',      // 🆕 TTS na bazie 2.5-pro

  // ElevenLabs TTS (klucz: ELEVENLABS_API_KEY)
  'eleven-v3': 'elevenlabs/eleven_v3',                  // najnowszy, emocje/tagi
  'eleven-multilingual-v2': 'elevenlabs/eleven_multilingual_v2', // 29 języków, stabilny
  'eleven-turbo-v2.5': 'elevenlabs/eleven_turbo_v2_5',  // niski latency

  // ═══════════════════════════════════════════════════════════════════════════
  // STT (Speech-to-Text) — transkrypcja mowy
  // ═══════════════════════════════════════════════════════════════════════════

  // OpenAI STT (klucz: OPENAI_API_KEY)
  'whisper-1': 'openai/whisper-1',                 // klasyczny, batch, multilingual
  'whisper-v3-turbo': 'openai/whisper-large-v3-turbo',   // szybszy, tańszy batch
  'gpt-4o-transcribe': 'openai/gpt-4o-transcribe',        // najdokładniejszy, hałas/akcenty
  'gpt-4o-mini-transcribe': 'openai/gpt-4o-mini-transcribe',   // lżejszy, tańszy

  // Google STT (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  'chirp-3': 'google/chirp-3',                   // 100+ języków, diaryzacja, denoiser

  // ═══════════════════════════════════════════════════════════════════════════
  // REALTIME VOICE — agenci głosowi (streaming audio in/out)
  // ═══════════════════════════════════════════════════════════════════════════

  // OpenAI Realtime (klucz: OPENAI_API_KEY)
  'gpt-realtime-2': 'openai/gpt-realtime-2',           // GPT-5 reasoning, voice agent, 128K ctx
  'gpt-realtime-translate': 'openai/gpt-realtime-translate',   // live tłumaczenie 70+ → 13 języków
} as const;

/** All valid model alias keys */
export type ModelKey = keyof typeof models;

/**
 * Resolve a model alias to its full Mastra model ID string.
 *
 * Example: resolveModelId('gemini-2.5-flash') → 'google/gemini-2.5-flash'
 */
export function resolveModelId(key: ModelKey): string {
  return models[key];
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: AGENT PRIMARY & FALLBACK SEQUENCES (GŁÓWNY MODEL + FALLBACKI)
//
// 🎯 JEDNO MIEJSCE DO KONFIGURACJI MODELI DLA WSZYSTKICH AGENTÓW:
//
// Jak to edytować:
//   - `primary`: Model główny (pierwszy wybór, na którym agent startuje).
//   - `fallback`: Lista modeli zapasowych (kolejka ratunkowa). Gdy model główny
//     zwróci błąd (brak środków, rate limit, timeout, 500), system automatycznie
//     przełącza się na kolejny model z tej listy.
//
// Wartości to aliasy ze słownika modeli w Sekcji 1 (np. 'kimi-k3-free', 'deepseek-v4-pro').
// ═════════════════════════════════════════════════════════════════════════════

export interface AgentSequenceConfig {
  /** 🟢 MODEL GŁÓWNY (pierwszy wybór) */
  primary: ModelKey;
  /** 🟡 MODELE ZAPASOWE / FALLBACK (w kolejności priorytetu) */
  fallback: ModelKey[];
}

export const agentModelSequences = {
  // ── [1] AGENCI Z NOWYMI MODELAMI ZENMUX + FALLBACK ──────────────────────────

  /** Meta Agent — główny orkiestrator systemu */
  metaAgent: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['gemini-3.7-flash'] as ModelKey[],
  },

  /** Design Agent — orkiestrator generowania UI/HTML i assetów */
  designAgent: {
    primary: 'deepseek-v4-pro' as ModelKey,
    fallback: ['gemini-3.7-flash', 'deepseek-v4-flash'] as ModelKey[],
  },

  /** Content Agent — dyrygent tworzenia postów i treści (IG/LinkedIn/TikTok) */
  contentAgent: {
    primary: 'deepseek-v4-pro' as ModelKey,
    fallback: ['gemini-3.7-pro', 'gemini-3.5-flash', 'glm-5.3-free'] as ModelKey[],
  },

  /**
   * Automation Architect — projektant i walidator workflowów n8n.
   *
   * flash, nie pro (2026-08-24). Zmierzone na żywo: build szedł ~27 s/krok, ale
   * edycja spaliła 700 s na DWÓCH krokach, bo model wyprowadzał schemat węzła
   * Mongo z pierwszych zasad zamiast zapytać `n8nMcpEngineer`, który zwraca to
   * z żywej instancji w ~5 s. Praca, która faktycznie wymaga myślenia, jest tu
   * mała; praca, która wymaga FAKTÓW o instalacji, należy do helpera i do
   * walidatora. Ta sama rodzina i ten sam tryb thinking, 1M ctx, ~3× taniej.
   * `pro` zostaje pierwszym fallbackiem, więc błąd eskaluje like-for-like.
   */
  automationArchitect: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'or-claude-sonnet-5', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** Chef Agent — dyrygent inżynierii menu i przepisów */
  chefAgent: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.3-free'] as ModelKey[],
  },

  // ── [2] POZOSTALI AGENCI DOMENOWI I POMOCNICZY ──────────────────────────────

  /** Meta Front — szybki klasyfikator i responder (front_only) */
  metaFrontAgent: {
    primary: 'deepseek-v4-flash' as ModelKey,
    fallback: ['gemini-3.6-flash', 'deepseek-v4-pro', 'nemotron-ultra-free'] as ModelKey[],
  },

  /** Lane Orchestrator — szybki decydent ścieżek wykonania */
  laneOrchestratorAgent: {
    primary: 'deepseek-v4-flash' as ModelKey,
    fallback: ['gemini-3.6-flash', 'deepseek-v4-pro', 'nemotron-ultra-free'] as ModelKey[],
  },

  /** Coding Agent — narzędzia workspace, LSP, refaktoryzacja */
  codingAgent: {
    primary: 'deepseek-v4-flash' as ModelKey,
    fallback: ['deepseek-v4-pro', 'gemini-3.5-flash'] as ModelKey[],
  },

  /** Code Review Agent — recenzja kodu i kontraktów */
  codeReviewAgent: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** Security Review Agent — audyt bezpieczeństwa i uprawnień */
  securityReviewAgent: {
    primary: 'deepseek-v4-pro' as ModelKey,
    fallback: ['deepseek-v4-flash', 'gemini-3.5-flash'] as ModelKey[],
  },

  /** Performance Review Agent — audyt wydajnościowy */
  performanceReviewAgent: {
    primary: 'gemini-3.7-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** Sales Agent — pipeline CRM i onboarding */
  salesAgent: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** CRM Agent — szybki lookup leadów */
  crmAgent: {
    primary: 'deepseek-v4-flash' as ModelKey,
    fallback: ['gemini-3.5-flash', 'nemotron-ultra-free'] as ModelKey[],
  },

  /** Analytics Agent — raporty i KPI */
  analyticsAgent: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** Weather Agent — zapytania pogodowe */
  weatherAgent: {
    primary: 'nemotron-ultra-free' as ModelKey,
    fallback: ['openrouter-free-auto', 'openrouter-free-auto'] as ModelKey[],
  },

  /**
   * n8n MCP Engineer — dokumentacja i węzły n8n.
   */
  n8nMcpEngineer: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** Marketing Agent — copywriting i maile */
  marketingAgent: {
    primary: 'gemini-3.7-flash' as ModelKey,
    fallback: ['gemini-3.5-flash', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** Knowledge Agent — operacje NotebookLM */
  knowledgeAgent: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'gemini-3.7-pro'] as ModelKey[],
  },

  /** Researcher Agent — web research i synteza */
  researcherAgent: {
    primary: 'deepseek-v4-flash' as ModelKey,
    fallback: ['gemini-3.5-flash', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** Deliberation Agent — Design Council */
  deliberationAgent: {
    primary: 'deepseek-v4-flash' as ModelKey,
    fallback: ['deepseek-v4-pro', 'gemini-3.5-flash'] as ModelKey[],
  },

  /** Hunt Agent — discovery i lead-hunting */
  huntAgent: {
    primary: 'gemini-3.5-flash' as ModelKey,
    fallback: ['deepseek-v4-flash', 'deepseek-v4-pro'] as ModelKey[],
  },

  /** Writer Agent — długie formy pisarskie */
  writerAgent: {
    primary: 'deepseek-v4-pro' as ModelKey,
    fallback: ['deepseek-v4-flash', 'gemini-3.5-flash'] as ModelKey[],
  },

  /** Filmmaker Agent — reżyseria Seedance */
  filmmakerAgent: {
    primary: 'deepseek-v4-pro' as ModelKey,
    fallback: ['deepseek-v4-flash', 'gemini-3.5-flash'] as ModelKey[],
  },

  /** Musician Agent — kompozycja muzyczna */
  musicianAgent: {
    primary: 'deepseek-v4-pro' as ModelKey,
    fallback: ['deepseek-v4-flash', 'gemini-3.5-flash'] as ModelKey[],
  },

  /** Capability Smith — zarządzanie narzędziami i MCP */
  capabilitySmith: {
    primary: 'gemini-3.7-flash' as ModelKey,
    fallback: ['deepseek-v4-pro', 'gemini-3.5-flash'] as ModelKey[],
  },
} as const;

/**
 * Automatycznie wygenerowana mapa modeli głównych dla agentów z sekwencji model-manifest.
 */
export const agentModels = Object.fromEntries(
  Object.entries(agentModelSequences).map(([key, seq]) => [key, seq.primary]),
) as { readonly [K in keyof typeof agentModelSequences]: (typeof agentModelSequences)[K]['primary'] };


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3: WORKFLOW ASSIGNMENTS
//
// Model assignments for individual workflow steps. Replaces the old
// modelPresets + workflowModels pattern in workflow-models.ts.
// ═════════════════════════════════════════════════════════════════════════════

export const workflowAssignments = {
  // MIGRATION SETTING, not a permanent one (owner decision, 2026-08-12).
  //
  // The whole coding domain runs on one strong model while its capabilities are
  // ported to V2 one at a time. The reason is evidential, not qualitative: when a
  // ported capability misbehaves, a mixed roster leaves "the port is wrong" and
  // "this tier could never do it" indistinguishable, and this project has already
  // paid for that confusion once (`analyticsAgent` failing on a provider's
  // ResourceExhausted while the migration hunted a substrate defect).
  //
  // Revisit per role once the domain is ticked off: `patch` and `jsonRepair`
  // were on cheap local/free tiers deliberately, and `review` on a separate model
  // from the author is a real property worth restoring — a reviewer that shares
  // the writer's blind spots is not an independent reviewer.
  coding: {
    default: 'gemini-3.7-flash' as ModelKey,  // diagnose-and-plan
    patch: 'deepseek-v4-flash' as ModelKey,  // was qwen3.6-27b
    review: 'gemini-3.5-flash' as ModelKey,  // was nemotron-ultra-free
    selfHealingPlanner: 'deepseek-v4-pro' as ModelKey,
    selfHealingReview: 'gemini-3.5-flash' as ModelKey,
    jsonRepair: 'deepseek-v4-flash' as ModelKey,  // was nemotron-super-free
  },

  marketing: {
    default: 'gemini-3.7-flash' as ModelKey,
  },

  weeklyContent: {
    research: 'groq-qwen-27b' as ModelKey,
    copyPl: 'groq-qwen-27b' as ModelKey,
    copyRepair: 'groq-qwen-27b' as ModelKey,
    translateEn: 'groq-qwen-27b' as ModelKey,
    jsonRepair: 'groq-gpt-oss-120b' as ModelKey,
  },

  producerHunt: {
    discovery: 'groq-qwen-27b' as ModelKey,
    enrichment: 'groq-qwen-27b' as ModelKey,
    emailExtraction: 'groq-qwen-27b' as ModelKey,
    draftEmail: 'groq-qwen-27b' as ModelKey,
    jsonRepair: 'groq-gpt-oss-120b' as ModelKey,
    cloudFallback: 'deepseek-v4-flash' as ModelKey,
  },
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4: EXECUTION TIER PRESETS — SINGLE SOURCE OF TRUTH (Refactor V3)
// ═════════════════════════════════════════════════════════════════════════════

export const executionTierPresets = {
  /** Tier Fast — ultraniska latencja, wysoka współbieżność w chmurze (LPU / Flash) */
  fast: {
    primary: 'groq-gpt-oss-20b' as ModelKey,
    fallback: 'gemini-2.5-flash-lite' as ModelKey,
  },
  /** Tier Balanced — uniwersalny daily-driver w chmurze (Google/DeepSeek) */
  balanced: {
    primary: 'gemini-3.5-flash-lite' as ModelKey,
    fallback: 'deepseek-v4-flash' as ModelKey,
  },
  /** Tier Pro — głębokie rozumowanie, architektura i synteza w chmurze */
  pro: {
    primary: 'deepseek-v4-pro' as ModelKey,
    fallback: 'gemini-3.7-flash' as ModelKey,
  },
  /** Tier Private — ściśle lokalny (Ollama) dla zadań poufnych/wrażliwych */
  private: {
    primary: 'gemma4-12b-official' as ModelKey,
    fallback: 'qwen3.5-4b' as ModelKey,
  },
} as const;

export type ExecutionTierPresetKey = keyof typeof executionTierPresets;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4b: WORKER PRESETS (system.run_worker tool & plan_task)
//
// Maps preset names to model aliases. Used by run_worker and specialist pipelines.
// General presets inherit directly from executionTierPresets (SSOT).
// ═════════════════════════════════════════════════════════════════════════════

export const workerPresets = {
  // ── Presety Ogólne (dziedziczą z Tierów) ──
  fast: executionTierPresets.fast.primary,
  default: executionTierPresets.balanced.primary,
  reasoning: executionTierPresets.pro.primary,
  powerful: executionTierPresets.pro.primary,
  cloud: executionTierPresets.balanced.primary,

  // ── Presety Domenowe / Multimedialne ──
  design: 'deepseek-v4-flash' as ModelKey,
  film: 'deepseek-v4-flash' as ModelKey,
  music: 'deepseek-v4-flash' as ModelKey,

  // ── Presety Pisarza (Writer Sub-Workers) ──
  writer_critic: 'deepseek-v4-flash' as ModelKey,
  writer_reader: 'deepseek-v4-flash' as ModelKey,
  writer_muse: 'deepseek-v4-flash' as ModelKey,
  writer_chronicler: 'deepseek-v4-flash' as ModelKey,
  writer_polisher: 'deepseek-v4-flash' as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4b: AGENT MODEL LOOKUP + FALLBACK CHAINS (loop_fix.md P1)
//
// Generate-time model health gate needs two things the static per-agent
// assignment doesn't give it:
//   1. Map a runtime agentId (kebab-case Mastra id OR camelCase telemetry id)
//      back to its `agentModels` key, so the harness can learn the model an
//      agent would use even when no explicit `input.model` is passed.
//   2. An ordered fallback chain to swap to when the intended model is
//      unavailable / circuit-open. Only models present in the capability
//      registry belong here (others can't be health-checked).
// ═════════════════════════════════════════════════════════════════════════════

export type AgentModelKey = keyof typeof agentModels;

/** camelCase → kebab-case (e.g. 'knowledgeAgent' → 'knowledge-agent'). */
function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * Resolve a runtime agentId to its `agentModels` key. Accepts both the camelCase
 * key itself ('knowledgeAgent') and the kebab-case Mastra Agent.id
 * ('knowledge-agent'). Returns undefined for unknown ids (e.g. ad-hoc workers).
 */
export function agentModelKeyForId(agentId: string | null | undefined): AgentModelKey | undefined {
  if (!agentId) return undefined;
  if (agentId in agentModels) return agentId as AgentModelKey;
  for (const key of Object.keys(agentModels) as AgentModelKey[]) {
    if (toKebabCase(key) === agentId) return key;
  }
  return undefined;
}

/**
 * Default ordered fallback chain for orchestrator / expert agents. Cheapest
 * reliable cloud provider first (DeepSeek stayed UP during the failing run),
 * then a cross-provider escape hatch. Every entry MUST exist in
 * config/model-capabilities.ts so it can be health-checked.
 */
export const orchestratorFallbackChain: ModelKey[] = [
  'deepseek-v4-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'deepseek-v4-pro',
];

/**
 * Optional per-agent overrides of the fallback chain.
 * Automatically derived from `agentModelSequences` in Section 2.
 */
export const agentFallbackChains: Partial<Record<AgentModelKey, ModelKey[]>> = {
  metaAgent: agentModelSequences.metaAgent.fallback,
  designAgent: agentModelSequences.designAgent.fallback,
  contentAgent: agentModelSequences.contentAgent.fallback,
  automationArchitect: agentModelSequences.automationArchitect.fallback,
  chefAgent: agentModelSequences.chefAgent.fallback,
  metaFrontAgent: agentModelSequences.metaFrontAgent.fallback,
  laneOrchestratorAgent: agentModelSequences.laneOrchestratorAgent.fallback,
  codingAgent: agentModelSequences.codingAgent.fallback,
  codeReviewAgent: agentModelSequences.codeReviewAgent.fallback,
  securityReviewAgent: agentModelSequences.securityReviewAgent.fallback,
  performanceReviewAgent: agentModelSequences.performanceReviewAgent.fallback,
  salesAgent: agentModelSequences.salesAgent.fallback,
  crmAgent: agentModelSequences.crmAgent.fallback,
  analyticsAgent: agentModelSequences.analyticsAgent.fallback,
  weatherAgent: agentModelSequences.weatherAgent.fallback,
  n8nMcpEngineer: agentModelSequences.n8nMcpEngineer.fallback,
  marketingAgent: agentModelSequences.marketingAgent.fallback,
  knowledgeAgent: agentModelSequences.knowledgeAgent.fallback,
  researcherAgent: agentModelSequences.researcherAgent.fallback,
  deliberationAgent: agentModelSequences.deliberationAgent.fallback,
  huntAgent: agentModelSequences.huntAgent.fallback,
  writerAgent: agentModelSequences.writerAgent.fallback,
  filmmakerAgent: agentModelSequences.filmmakerAgent.fallback,
  musicianAgent: agentModelSequences.musicianAgent.fallback,
  capabilitySmith: agentModelSequences.capabilitySmith.fallback,
};

/** Fallback chain (resolved to full model ids) for a given agentId. */
export function fallbackChainForAgent(agentId: string | null | undefined): string[] {
  const key = agentModelKeyForId(agentId);
  const chain = (key && agentModelSequences[key]?.fallback)
    ? agentModelSequences[key].fallback
    : (key && agentFallbackChains[key])
      ? agentFallbackChains[key]!
      : orchestratorFallbackChain;
  return chain.map((alias) => resolveModelId(alias));
}

/**
 * Test-only global model override. When `TEST_FORCE_MODEL` is set to a valid
 * model alias, every agent + worker text-generation model resolves to it. Used
 * to pin E2E runs to the cheapest cloud provider (DeepSeek) and avoid
 * cross-provider outages muddying the loop signal. Does NOT affect embedding /
 * image / tts / infrastructure models. Returns null when unset/invalid.
 */
export function resolveTestForcedModelId(): string | null {
  const alias = process.env.TEST_FORCE_MODEL?.trim();
  if (!alias) return null;
  if (alias in models) return models[alias as ModelKey];
  console.warn(`[ModelManifest] TEST_FORCE_MODEL="${alias}" is not a known model alias — ignoring.`);
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5: INFRASTRUCTURE
//
// Models for internal infrastructure: observational memory compression,
// embedding, and n8n workflow generation defaults.
// ═════════════════════════════════════════════════════════════════════════════

export const infrastructure = {
  /** Model used by Observational Memory to compress conversation history */
  observationalMemory: 'deepseek-v4-flash' as ModelKey,

  /**
   * Etap 6 — model that distills successful task trajectories into SKILL.md
   * during the nightly cycle (scripts/skill-nightly-cycle.ts). 2026-08-19:
   * switched from local gemma4-12b to the cloud worker-reasoning model
   * (same alias as workerPresets.reasoning) to clear the backlog in one
   * night — still ~$0 on Groq's free tier. Swap back to a local ModelKey if
   * quality or rate limits make that a bad trade.
   */
  skillDistiller: 'deepseek-v4-flash' as ModelKey,

  /** Embedding model source of truth (used by lib/embedder.ts) */
  embedding: {
    model: 'bge-m3' as ModelKey,
  },

  /** N8n workflow generation defaults (used by automation-architect builders) */
  n8n: {
    defaultModel: 'gemini-3.7-flash' as ModelKey,
    reasoningModel: 'gemini-3.7-flash' as ModelKey,
  },
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6: DELIBERATION ASSIGNMENTS
//
// Model assignments for specific Design Council roles in the deliberationAgent.
// Used by the run_deliberation_worker tool.
// ═════════════════════════════════════════════════════════════════════════════

export const deliberationAssignments = {
  systemsArchitect: 'deepseek-v4-flash' as ModelKey,
  llmEngineer: 'deepseek-v4-flash' as ModelKey,
  redTeamCritic: 'deepseek-v4-flash' as ModelKey,
  creativeStrategist: 'deepseek-v4-flash' as ModelKey,
  memoryArchitect: 'deepseek-v4-flash' as ModelKey,
  synthesisPlanner: 'deepseek-v4-flash' as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7: DESIGN DOMAIN ASSIGNMENTS
//
// Specialist model assignments for the Mastra design domain.
// ═════════════════════════════════════════════════════════════════════════════

export const designAssignments = {
  htmlGenerator: 'gemini-3.5-flash' as ModelKey,
  directionAdvisor: 'gemini-3.5-flash' as ModelKey,
  expertCritique: 'gemini-3.5-flash' as ModelKey,
  narrationWriter: 'gemini-3.5-flash' as ModelKey,
  imageGen: 'gpt-image-2' as ModelKey,
  imageGenPhoto: 'gpt-image-2' as ModelKey,
  tts: 'eleven-multilingual-v2' as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8: WRITER DOMAIN ASSIGNMENTS
//
// Specialist model assignments for the Mastra writer domain.
// ═════════════════════════════════════════════════════════════════════════════

export const writerAssignments = {
  orchestrator: 'deepseek-v4-flash' as ModelKey,
  fictionDrafter: 'deepseek-v4-pro' as ModelKey,
  articleDrafter: 'deepseek-v4-pro' as ModelKey,
  critic: 'deepseek-v4-pro' as ModelKey,
  readerSim: 'deepseek-v4-flash' as ModelKey,
  muse: 'deepseek-v4-pro' as ModelKey,
  chronicler: 'deepseek-v4-pro' as ModelKey,
  polisher: 'deepseek-v4-pro' as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9: FILM DOMAIN ASSIGNMENTS
//
// Specialist model assignments for the Seedance filmmaker domain.
// ═════════════════════════════════════════════════════════════════════════════

export const filmmakerAssignments = {
  orchestrator: 'deepseek-v4-pro' as ModelKey,
  storyPlanner: 'deepseek-v4-pro' as ModelKey,
  promptCompiler: 'deepseek-v4-pro' as ModelKey,
  continuityCritic: 'deepseek-v4-flash' as ModelKey,
  takeReviewer: 'deepseek-v4-flash' as ModelKey,
  repairPlanner: 'deepseek-v4-flash' as ModelKey,
  referenceFrameDesigner: 'gpt-image-2' as ModelKey,
  generationSupervisor: 'deepseek-v4-pro' as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10: MUSICIAN DOMAIN ASSIGNMENTS
//
// Every value is a ModelKey from Section 1 → swap freely while testing for the
// sweet spot. Granular on purpose so each sub-role is tunable independently.
// The MUSIC model itself is NOT a ModelKey — it is a remote REST surface,
// configured in config/music-surfaces.ts, not in the `models` map.
// ═════════════════════════════════════════════════════════════════════════════

export const musicianAssignments = {
  orchestrator: 'deepseek-v4-pro' as ModelKey,   // director / phase driver
  lyricist: 'deepseek-v4-flash' as ModelKey,       // lyrics writing (claude-opus-4.8 candidate)
  stylePrompter: 'deepseek-v4-flash' as ModelKey,  // genre/instrument/production style prompt compiler
  interviewer: 'deepseek-v4-flash' as ModelKey,    // vague idea → song brief
  variantWorker: 'deepseek-v4-flash' as ModelKey,  // parallel A/B lyric/style variants (run_worker preset)
  takeReviewer: 'deepseek-v4-flash' as ModelKey,   // listen-back triage on returned metadata
} as const;
