# Plan refactoru pętli ReAct → Compound AI System

> **Cel nadrzędny:** Przejście z monolitycznej pętli ReAct (frontier model robi wszystko) na hybrydowy *compound AI system*, w którym frontier (Claude/GPT) **planuje i refleksjuje**, a lokalne modele (Qwen/Mistral/Llama) **wykonują**.
>
> **Filozofia:** Każda zmiana ma być **additive** — nie burzymy obecnej pętli, dokładamy nowe ścieżki za feature flagami i stopniowo migrujemy.
>
> **Czas wdrożenia:** ~6-8 tygodni roboczych podzielone na 9 niezależnie deployowalnych etapów.

---

## Spis treści

- [Założenia ogólne](#założenia-ogólne)
- [Architektura docelowa](#architektura-docelowa)
- [ETAP 0 — Fundament (model registry + capabilities)](#etap-0--fundament-model-registry--capabilities)
- [ETAP 1 — Prompt caching i KV cache](#etap-1--prompt-caching-i-kv-cache)
- [ETAP 2 — Native function calling z fallbackiem](#etap-2--native-function-calling-z-fallbackiem)
- [ETAP 3 — Streaming thought do UI](#etap-3--streaming-thought-do-ui)
- [ETAP 4 — Compaction historii (lokalny worker)](#etap-4--compaction-historii-lokalny-worker)
- [ETAP 5 — Plan-and-Execute (kluczowy etap)](#etap-5--plan-and-execute-kluczowy-etap)
- [ETAP 6 — Reflection przed finalAnswer](#etap-6--reflection-przed-finalanswer)
- [ETAP 7 — Tool retrieval (semantyczny wybór narzędzi)](#etap-7--tool-retrieval-semantyczny-wybór-narzędzi)
- [ETAP 8 — UI improvements](#etap-8--ui-improvements)
- [Macierz decyzji: który model do czego](#macierz-decyzji-który-model-do-czego)
- [Strategia rollback i feature flagi](#strategia-rollback-i-feature-flagi)
- [Czego NIE dotykamy w żadnym etapie](#czego-nie-dotykamy-w-żadnym-etapie)

---

## Założenia ogólne

### Reguły inżynierskie obowiązujące w każdym etapie

1. **Każdy etap musi być deployowalny niezależnie.** Nie merguj etapu, który psuje aktualnie działający flow.
2. **Każda nowa ścieżka ma feature flag** w env (`FEATURE_X_ENABLED=true|false`) lub w MongoDB `settings`. Default: `false` na produkcji do czasu walidacji.
3. **Telemetria PIERWSZA, kod DRUGI.** Każdy etap najpierw dodaje metryki (token cost, latency, success rate), a dopiero potem zmiany behawioralne.
4. **Backwards compat:** wszystkie publiczne typy (np. `LLMResponse`, `ReActStep`, `ToolTrace`) — tylko **rozszerzane** o opcjonalne pola, nigdy łamane.
5. **Testy regresji:** po każdym etapie odpalić istniejący happy-path (smalltalk, CRM read, Gmail draft, n8n deploy) i sprawdzić że dalej działa.
6. **TypeCheck musi przechodzić:** `pnpm -r typecheck` zielony przed mergem.
7. **Dokumentacja:** każdy etap kończy się aktualizacją `docs/architecture.md` (lub stworzeniem jeśli nie istnieje).

### Mapa kluczowych plików (referencje)

| Komponent | Ścieżka |
|---|---|
| Centralna pętla ReAct | `apps/workers/src/agents/meta-agent/react-loop.ts` |
| Klasa MetaAgent | `apps/workers/src/agents/meta-agent/index.ts` |
| Wrapper narzędzi | `apps/workers/src/agents/meta-agent/tools.ts` |
| Definicje narzędzi | `apps/workers/src/agents/meta-agent/tool-definitions.ts` |
| Handlery narzędzi + approval | `apps/workers/src/agents/meta-agent/tool-registry.ts` |
| Tool RAG (już istnieje!) | `apps/workers/src/agents/meta-agent/tool-rag-service.ts` |
| Prompty | `apps/workers/src/agents/meta-agent/prompts/*.md` |
| BaseAgent (callLLM) | `apps/workers/src/core/base-agent.ts` |
| Eventy Redis | `apps/workers/src/core/events.ts` |
| LLM Router | `packages/llm/src/router.ts` |
| Provider Anthropic | `packages/llm/src/providers/anthropic.ts` |
| Provider OpenAI | `packages/llm/src/providers/openai.ts` |
| Provider Gemini | `packages/llm/src/providers/gemini.ts` |
| Provider Ollama | `packages/llm/src/providers/ollama.ts` |
| Embedding Service | `packages/llm/src/embeddings.ts` |
| Schematy Zod | `packages/shared/src/schemas.ts` |
| JSON repair | `packages/shared/src/jsonRepair.ts` |
| Konfiguracja agentów | `packages/shared/src/agentConfig.ts` |

---

## Architektura docelowa

```
                    ┌──────────────────────────────────┐
USER message  ────► │ MetaAgent.run() — entry point    │
                    └──────────────────────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────────────┐
                    │ Intent classifier                │ ← lokalny 7B (taniej)
                    └──────────────────────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
              ▼                                     ▼
   simple_intent                           complex_intent
   (smalltalk, single read)                (workflow, multi-step)
              │                                     │
              ▼                                     ▼
   ┌────────────────────┐               ┌──────────────────────┐
   │ ReAct loop (skinny)│               │ Plan generation       │ ← FRONTIER (1×)
   │ - lokalny 14B      │               │ Claude / GPT-4        │
   │ - max 3 steps      │               └──────────────────────┘
   └────────────────────┘                          │
                                                   ▼
                                       ┌──────────────────────┐
                                       │ Plan executor         │ ← LOKALNY 14B
                                       │ - wykonuje krok po    │   (N× per task)
                                       │   kroku z planu       │
                                       │ - może wywołać tools  │
                                       │   równolegle (parallel│
                                       │   tool calls)         │
                                       └──────────────────────┘
                                                   │
                                  ┌────────────────┼────────────────┐
                                  ▼                ▼                ▼
                          [tool 1: CRM]   [tool 2: Gmail]   [tool N: ...]
                                  │                │                │
                                  └────────────────┴────────────────┘
                                                   │
                                                   ▼
                                       ┌──────────────────────┐
                                       │ Compactor (gdy hist. │ ← LOKALNY 7B
                                       │  > 60% budżetu)       │
                                       └──────────────────────┘
                                                   │
                                                   ▼
                                       ┌──────────────────────┐
                                       │ Reflection /          │ ← FRONTIER (1×)
                                       │ Self-critique         │   przed finalAnswer
                                       └──────────────────────┘
                                                   │
                                                   ▼
                                       ┌──────────────────────┐
                                       │ Final response        │ ← FRONTIER lub
                                       │ generation            │   lokalny 14B
                                       └──────────────────────┘

INFRASTRUKTURA WSPIERAJĄCA:
- Tool retrieval: lokalne embeddings (BGE-M3 / Nomic) + Mongo cosine
- Prompt cache: Anthropic cache_control + Ollama KV cache (keep_alive)
- Streaming: SSE delta events przez Redis pub/sub
- Telemetria: runs collection (już istnieje) + nowe metryki cost/latency
```

**Liczba calls per task:**
- Obecnie (monolit): ~10-15 calls do frontier w pętli ReAct
- Docelowo (compound): 1× plan + 0-1× reflection do frontier, reszta lokalnie

**Spodziewana redukcja kosztu chmurowego:** 75-85%.

---

## ETAP 0 — Fundament (model registry + capabilities)

> **Czas:** 2 dni roboczych
> **Risk:** zerowy (sam kod typów + konfiguracji, brak zmian behawioralnych)
> **Feature flag:** nie wymagany
> **Cel:** Dać nazwę i strukturę temu, co dziś jest rozproszone po kodzie. Każdy następny etap odwołuje się do tego.

### Co budujemy

**1.** Centralny rejestr modeli z ich możliwościami (capabilities):
- Czy wspiera natywny tool calling
- Maksymalna liczba parallel tool calls
- Czy wspiera streaming
- Czy wspiera prompt caching (i jaki rodzaj)
- Cost per 1M tokens (in/out) — do live cost counter
- Klasa modelu: `frontier` | `mid` | `small` | `embedding`

**2.** Tier system dla zadań:
- `tier:frontier` — planowanie, reflection, complex reasoning
- `tier:mid` — execution, tool calling, deterministic tasks
- `tier:small` — compaction, intent classification, JSON repair
- `tier:embedding` — vector retrieval

**3.** Helper `pickModelForRole(role)` z fallbackiem.

### Pliki nowe

```
packages/llm/src/model-registry.ts          [NEW]
packages/llm/src/types.ts                   [EXTEND]
```

### Pliki dotykane

- `packages/llm/src/router.ts` — dorzucamy import ModelRegistry, ale nie zmieniamy logiki
- `packages/shared/src/agentConfig.ts` — dorzucamy do każdego per-step entry pole `tier?: ModelTier`
- `apps/workers/src/core/base-agent.ts` — dodajemy metodę `pickModel(role)` używaną później

### Pliki czego NIE TYKAMY

- ❌ `react-loop.ts` — w tym etapie 0 zmian
- ❌ Provider files (`anthropic.ts`, `ollama.ts` itd.) — to etap 2
- ❌ Prompty — bez zmian

### Implementacja krok po kroku

#### Krok 1 — `packages/llm/src/model-registry.ts`

```ts
export type ModelTier = 'frontier' | 'mid' | 'small' | 'embedding'

export interface ModelCapabilities {
  spec: string                    // e.g. "anthropic:claude-3-5-sonnet-20241022"
  tier: ModelTier
  // Function calling
  supportsNativeTools: boolean
  maxParallelTools: number        // 1 = sequential only
  // Streaming
  supportsStreaming: boolean
  // Caching
  promptCaching: 'anthropic-explicit' | 'openai-auto' | 'kv-prefix' | 'none'
  // Cost (USD per 1M tokens)
  costPer1MIn: number
  costPer1MOut: number
  // Context window
  maxContextTokens: number
  // Inteligent flags
  goodForJson: boolean
  goodForCoding: boolean
  goodForReflection: boolean      // czy ma sens self-critique
}

export const MODEL_REGISTRY: Record<string, ModelCapabilities> = {
  // === FRONTIER ===
  'anthropic:claude-3-5-sonnet-20241022': {
    spec: 'anthropic:claude-3-5-sonnet-20241022',
    tier: 'frontier',
    supportsNativeTools: true,
    maxParallelTools: 10,
    supportsStreaming: true,
    promptCaching: 'anthropic-explicit',
    costPer1MIn: 3,
    costPer1MOut: 15,
    maxContextTokens: 200_000,
    goodForJson: true,
    goodForCoding: true,
    goodForReflection: true,
  },
  'openai:gpt-4o': {
    spec: 'openai:gpt-4o',
    tier: 'frontier',
    supportsNativeTools: true,
    maxParallelTools: 10,
    supportsStreaming: true,
    promptCaching: 'openai-auto',
    costPer1MIn: 2.5,
    costPer1MOut: 10,
    maxContextTokens: 128_000,
    goodForJson: true,
    goodForCoding: true,
    goodForReflection: true,
  },

  // === MID (lokalne 14B+) ===
  'ollama:qwen2.5:14b': {
    spec: 'ollama:qwen2.5:14b',
    tier: 'mid',
    supportsNativeTools: true,        // Qwen 2.5 ma natywne tool calling
    maxParallelTools: 3,
    supportsStreaming: true,
    promptCaching: 'kv-prefix',       // Ollama KV cache
    costPer1MIn: 0,
    costPer1MOut: 0,
    maxContextTokens: 32_768,
    goodForJson: true,
    goodForCoding: true,
    goodForReflection: false,         // jeszcze za słabe
  },
  'ollama:mistral-nemo:12b': {
    spec: 'ollama:mistral-nemo:12b',
    tier: 'mid',
    supportsNativeTools: true,
    maxParallelTools: 2,
    supportsStreaming: true,
    promptCaching: 'kv-prefix',
    costPer1MIn: 0,
    costPer1MOut: 0,
    maxContextTokens: 128_000,
    goodForJson: true,
    goodForCoding: false,
    goodForReflection: false,
  },

  // === SMALL (lokalne 7B) ===
  'ollama:qwen2.5:7b': {
    spec: 'ollama:qwen2.5:7b',
    tier: 'small',
    supportsNativeTools: true,
    maxParallelTools: 1,
    supportsStreaming: true,
    promptCaching: 'kv-prefix',
    costPer1MIn: 0,
    costPer1MOut: 0,
    maxContextTokens: 32_768,
    goodForJson: true,
    goodForCoding: false,
    goodForReflection: false,
  },
  'ollama:llama3.1:8b': {
    spec: 'ollama:llama3.1:8b',
    tier: 'small',
    supportsNativeTools: false,       // niestabilne — JSON mode bezpieczniejszy
    maxParallelTools: 1,
    supportsStreaming: true,
    promptCaching: 'kv-prefix',
    costPer1MIn: 0,
    costPer1MOut: 0,
    maxContextTokens: 128_000,
    goodForJson: true,
    goodForCoding: false,
    goodForReflection: false,
  },

  // === EMBEDDING ===
  'ollama:bge-m3': {
    spec: 'ollama:bge-m3',
    tier: 'embedding',
    supportsNativeTools: false,
    maxParallelTools: 0,
    supportsStreaming: false,
    promptCaching: 'none',
    costPer1MIn: 0,
    costPer1MOut: 0,
    maxContextTokens: 8192,
    goodForJson: false,
    goodForCoding: false,
    goodForReflection: false,
  }
}

export function getCapabilities(spec: string): ModelCapabilities {
  const exact = MODEL_REGISTRY[spec]
  if (exact) return exact

  // Fallback: match po prefixie (np. "ollama:qwen2.5:14b-instruct" → "ollama:qwen2.5:14b")
  for (const key of Object.keys(MODEL_REGISTRY)) {
    if (spec.startsWith(key)) return MODEL_REGISTRY[key]
  }

  // Domyślnie traktuj jako small + JSON mode (najbezpieczniej)
  return {
    spec,
    tier: 'small',
    supportsNativeTools: false,
    maxParallelTools: 1,
    supportsStreaming: true,
    promptCaching: 'none',
    costPer1MIn: 0,
    costPer1MOut: 0,
    maxContextTokens: 8192,
    goodForJson: false,
    goodForCoding: false,
    goodForReflection: false,
  }
}

/** Wybierz model do roli z fallbackiem przez tiery. */
export function pickModelByTier(
  preferredTier: ModelTier,
  configuredModels: Record<ModelTier, string>
): string {
  return configuredModels[preferredTier] ?? configuredModels.mid ?? configuredModels.small
}
```

#### Krok 2 — env w `.env.example`

```bash
# Model assignment per tier — nadpisuje agentConfig.ts gdy ustawione
LLM_TIER_FRONTIER=anthropic:claude-3-5-sonnet-20241022
LLM_TIER_MID=ollama:qwen2.5:14b
LLM_TIER_SMALL=ollama:qwen2.5:7b
LLM_TIER_EMBEDDING=ollama:bge-m3
```

#### Krok 3 — `BaseAgent.pickModel()`

W `apps/workers/src/core/base-agent.ts` dodać metodę:

```ts
import { getCapabilities, pickModelByTier, ModelTier } from '@af/llm/model-registry'

protected pickModel(tier: ModelTier): string {
  const fromEnv = {
    frontier: process.env.LLM_TIER_FRONTIER,
    mid: process.env.LLM_TIER_MID,
    small: process.env.LLM_TIER_SMALL,
    embedding: process.env.LLM_TIER_EMBEDDING,
  } as Record<ModelTier, string | undefined>

  return fromEnv[tier]
      ?? this.config.llmConfig.tiers?.[tier]
      ?? this.config.llmConfig.primary
}
```

### Kryteria akceptacji

- ✅ Plik `model-registry.ts` istnieje, eksportuje `MODEL_REGISTRY`, `getCapabilities`, `pickModelByTier`
- ✅ `BaseAgent.pickModel('frontier')` zwraca string spec modelu
- ✅ Type-check pass
- ✅ Istniejący happy-path nadal działa (bo nic nie wywołuje `pickModel` jeszcze)
- ✅ `.env.example` zaktualizowane

### Testy

```ts
// packages/llm/src/__tests__/model-registry.test.ts
describe('getCapabilities', () => {
  it('zwraca exact match', () => {
    expect(getCapabilities('ollama:qwen2.5:14b').tier).toBe('mid')
  })
  it('matchuje po prefixie', () => {
    expect(getCapabilities('ollama:qwen2.5:14b-instruct').tier).toBe('mid')
  })
  it('zwraca konserwatywny default dla nieznanego', () => {
    const unknown = getCapabilities('foo:bar')
    expect(unknown.tier).toBe('small')
    expect(unknown.supportsNativeTools).toBe(false)
  })
})
```

### Rollback

Brak — etap nie zmienia behawioru. Wystarczy revert PR.

---

## ETAP 1 — Prompt caching i KV cache

> **Czas:** 1.5 dnia
> **Risk:** niski (caching jest transparent — albo trafia w cache, albo robi normalny call)
> **Feature flag:** `FEATURE_PROMPT_CACHE_ENABLED=true` (domyślnie ON dla Anthropic, ON dla Ollama)
> **Cel:** 60-90% redukcja kosztu na powtarzających się prefiksach (system prompt + tool definitions w pętli ReAct).

### Co osiągamy

1. **Anthropic:** dodać `cache_control: { type: 'ephemeral' }` na bloku system prompt + tool definitions. TTL 5 min.
2. **Ollama:** ustawić `keep_alive: '30m'` aby model nie był wyładowywany z VRAM między requestami → KV cache prefix hits.
3. **OpenAI:** caching jest auto — tylko log `cached_tokens` z response.
4. **Gemini:** brak explicit cache w API (Gemini 2.0 Flash ma context cache, ale tylko dla treści > 32k). Pomijamy.
5. **Telemetria:** loguj `cache_creation_input_tokens` i `cache_read_input_tokens` (Anthropic) oraz `cached_tokens` (OpenAI) do `runs` collection.

### Pliki dotykane

- `packages/llm/src/providers/anthropic.ts` — dorzucenie `cache_control` markerów
- `packages/llm/src/providers/ollama.ts` — dodać `keep_alive` w options
- `packages/llm/src/providers/openai.ts` — log `cached_tokens` do response.usage
- `packages/llm/src/types.ts` — rozszerzyć `LLMResponse.usage` o opcjonalne `cachedTokens`, `cacheCreationTokens`
- `apps/workers/src/core/base-agent.ts` — w telemetrii (saveRunStep) dorzucić cache stats

### Pliki czego NIE TYKAMY

- ❌ Logika ReAct loop — caching jest w warstwie providera
- ❌ Prompts — nie zmieniamy treści, tylko sposób przesyłania
- ❌ Schematy Zod

### Implementacja

#### Krok 1 — Anthropic provider

W `packages/llm/src/providers/anthropic.ts` przy budowie messages:

```ts
// Stary kod (uproszczony):
messages: [{ role: 'user', content: opts.userPrompt }]

// Nowy kod:
const useCache = process.env.FEATURE_PROMPT_CACHE_ENABLED !== 'false'

const systemBlocks = [
  {
    type: 'text',
    text: opts.systemPrompt,
    ...(useCache && opts.systemPrompt.length > 1024 ? {
      cache_control: { type: 'ephemeral' }
    } : {})
  }
]

const response = await client.messages.create({
  model: this.model,
  max_tokens: opts.maxTokens ?? 4096,
  system: systemBlocks,    // zamiast plain string
  messages: [{ role: 'user', content: opts.userPrompt }],
  ...
})

// W mapowaniu response.usage:
return {
  text: response.content[0].text,
  usage: {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cachedTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
  },
  ...
}
```

**Ważne:**
- Cache działa **tylko gdy block ma ≥1024 tokenów** (Anthropic limit). Sprawdzaj długość przed dodaniem `cache_control`.
- W ReAct loop systemPrompt to ~270 linii react.md + tool definitions = ~3000+ tokenów → zawsze cache'uje się.
- Cache TTL 5 min — perfekt dla pętli ReAct (zwykle <2 min).

#### Krok 2 — Ollama provider

W `packages/llm/src/providers/ollama.ts`:

```ts
const response = await fetch(`${baseUrl}/api/chat`, {
  method: 'POST',
  body: JSON.stringify({
    model: this.model,
    messages: [...],
    format: opts.jsonMode ? 'json' : undefined,
    keep_alive: '30m',           // <-- TO JEST KLUCZOWE
    options: {
      temperature: opts.temperature ?? 0.7,
      num_predict: opts.maxTokens ?? -1,
    },
    stream: false,
  })
})
```

`keep_alive: '30m'` mówi Ollamie żeby trzymała model w VRAM przez 30 min po ostatnim użyciu. Bez tego model jest wyładowywany po 5 min, co psuje KV cache.

**Dodatkowo** — globalna zmienna systemowa Ollamy:
```bash
# /etc/systemd/system/ollama.service.d/override.conf
[Service]
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_NUM_PARALLEL=4"
Environment="OLLAMA_MAX_LOADED_MODELS=3"
```

Udokumentować w `docs/deployment.md`.

#### Krok 3 — Telemetria

W `BaseAgent.callLLM` rozszerzyć log:

```ts
await this.saveRunStep(taskId, {
  stepName: step,
  type: 'llm_call',
  data: {
    provider: response.provider,
    model: response.model,
    tokensIn: response.usage.inputTokens,
    tokensOut: response.usage.outputTokens,
    cachedTokens: response.usage.cachedTokens ?? 0,         // NEW
    cacheCreationTokens: response.usage.cacheCreationTokens ?? 0,  // NEW
    cacheHitRate: response.usage.cachedTokens
      ? response.usage.cachedTokens / (response.usage.inputTokens + response.usage.cachedTokens)
      : 0,                                                  // NEW
    costUsd: response.costUsd,
  }
})
```

#### Krok 4 — Dashboard widget (opcjonalnie w tym etapie)

Dodać w stronie ustawień metryki "ostatnie 24h":
- Cache hit rate %
- Tokens saved by cache
- Estimated savings $

### Kryteria akceptacji

- ✅ Anthropic call z systemPrompt > 1024 tok zwraca `cacheCreationTokens > 0` przy pierwszym callu
- ✅ Drugie wywołanie w obrębie 5 min zwraca `cachedTokens > 0`, `cacheCreationTokens === 0`
- ✅ Ollama: po `keep_alive` set, drugi call w obrębie minuty ma TTFT (time-to-first-token) **2× krótsze** (mierzone benchmarkiem)
- ✅ Telemetria w `runs` collection zawiera nowe pola
- ✅ Brak regresji na istniejących testach

### Benchmark do zrobienia po wdrożeniu

```bash
# Porównanie before/after
node scripts/benchmark-react-loop.ts \
  --task "Find leads with status sent and create digest" \
  --runs 10 \
  --report cost-comparison.json
```

Oczekiwany wynik: spadek `costUsd` na zadanie o ≥60% dla Anthropic, ≥40% dla mixed setup.

### Rollback

`FEATURE_PROMPT_CACHE_ENABLED=false` — providery wracają do starej ścieżki bez `cache_control`.

---

## ETAP 2 — Native function calling z fallbackiem

> **Czas:** 4-5 dni
> **Risk:** średni — zmienia format komunikacji z LLM, ale fallback do JSON mode zostaje
> **Feature flag:** `FEATURE_NATIVE_TOOLS_ENABLED=true` + per-model gating w model registry
> **Cel:** Eliminacja `parseReActStepWithRepair` (drugi LLM call) dla modeli wspierających natywne tool calling. Spadek błędów parsing z ~5% do <0.5%.

### Co budujemy

Warstwa abstrakcji nad `callLLM` która:
1. Sprawdza `getCapabilities(model).supportsNativeTools`
2. Jeśli TAK — buduje natywny `tools` payload (Anthropic tool_use, OpenAI function calling, Ollama tool calling)
3. Jeśli NIE — fallback do obecnego JSON mode + Zod validation

### Pliki nowe

```
packages/llm/src/tool-calling.ts                              [NEW]
apps/workers/src/agents/meta-agent/tool-schema-builder.ts     [NEW]
```

### Pliki dotykane

- `packages/llm/src/types.ts` — rozszerzenie `LLMCallOptions` o `tools?: ToolSpec[]` i `LLMResponse` o `toolCalls?: ParsedToolCall[]`
- `packages/llm/src/providers/anthropic.ts` — implementacja `tool_use`
- `packages/llm/src/providers/openai.ts` — `tools` + `tool_choice`
- `packages/llm/src/providers/ollama.ts` — `tools` parameter (od Ollama 0.4+)
- `packages/llm/src/providers/gemini.ts` — `functionDeclarations` (Gemini Function Calling)
- `apps/workers/src/agents/meta-agent/react-loop.ts` — opcjonalna ścieżka native (jeśli model wspiera)
- `apps/workers/src/agents/meta-agent/tools.ts` — eksport schematów narzędzi w formacie JSON Schema

### Pliki czego NIE TYKAMY

- ❌ `tool-registry.ts` — handlery wykonują się tak samo
- ❌ `tool-definitions.ts` — przerabiamy strukturę w nowym helperze, nie ruszamy oryginału
- ❌ Schemat XOR (action vs finalAnswer) — przy native tools to się załatwia samo (model zwraca tool_use LUB text)

### Implementacja

#### Krok 1 — typy

```ts
// packages/llm/src/types.ts (rozszerzenie)
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, any>  // JSON Schema
}

export interface ParsedToolCall {
  id: string                       // ID przyznane przez providera (do tool_result message)
  name: string
  args: Record<string, any>
}

export interface LLMCallOptions {
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  stream?: boolean
  tools?: ToolSpec[]               // NEW
  toolChoice?: 'auto' | 'required' | { tool: string }  // NEW
}

export interface LLMResponse {
  text: string
  // ... existing fields
  toolCalls?: ParsedToolCall[]     // NEW — gdy model zwrócił natywne tool_use
}
```

#### Krok 2 — Builder schematów narzędzi

```ts
// apps/workers/src/agents/meta-agent/tool-schema-builder.ts
import { ToolSpec } from '@af/llm/types'
import { TOOL_DEFINITIONS } from './tool-definitions'

/** Konwersja istniejącego TOOL_DEFINITIONS do JSON Schema dla native tool calling. */
export function buildToolSpecs(toolNames: string[]): ToolSpec[] {
  return toolNames.map(name => {
    const def = TOOL_DEFINITIONS.find(d => d.name === name)
    if (!def) throw new Error(`Tool not found: ${name}`)

    return {
      name: def.name,
      description: def.description,
      parameters: {
        type: 'object',
        properties: argsToJsonSchema(def.args),
        required: def.args.filter(a => a.required).map(a => a.name)
      }
    }
  })
}

function argsToJsonSchema(args: ToolArg[]): Record<string, any> {
  const props: Record<string, any> = {}
  for (const arg of args) {
    props[arg.name] = {
      type: arg.type,
      description: arg.description,
      ...(arg.enum ? { enum: arg.enum } : {}),
      ...(arg.items ? { items: arg.items } : {})
    }
  }
  return props
}
```

#### Krok 3 — Provider Anthropic (przykład)

```ts
// packages/llm/src/providers/anthropic.ts
async call(opts: LLMCallOptions): Promise<LLMResponse> {
  const useNative = opts.tools && opts.tools.length > 0

  const apiPayload: any = {
    model: this.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.userPrompt }],
    temperature: opts.temperature ?? 0.7,
  }

  if (useNative) {
    apiPayload.tools = opts.tools!.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
    if (opts.toolChoice) {
      apiPayload.tool_choice = opts.toolChoice === 'auto'
        ? { type: 'auto' }
        : opts.toolChoice === 'required'
        ? { type: 'any' }
        : { type: 'tool', name: opts.toolChoice.tool }
    }
  } else if (opts.jsonMode) {
    // stara ścieżka JSON mode
    apiPayload.system[0].text += '\n\nRespond with valid JSON only.'
  }

  const response = await this.client.messages.create(apiPayload)

  // Parse response
  const textBlocks = response.content.filter(b => b.type === 'text')
  const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')

  return {
    text: textBlocks.map(b => b.text).join('\n'),
    toolCalls: toolUseBlocks.map(b => ({
      id: b.id,
      name: b.name,
      args: b.input as Record<string, any>,
    })),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedTokens: response.usage.cache_read_input_tokens ?? 0,
    },
    provider: 'anthropic',
    model: this.model,
    raw: response,
  }
}
```

Analogicznie dla OpenAI (`tools: [{type:'function', function: {...}}]`, response: `choices[0].message.tool_calls`), Ollama (`tools: [...]`, response: `message.tool_calls`), Gemini (`tools: [{functionDeclarations: [...]}]`, response: `candidates[0].content.parts[i].functionCall`).

#### Krok 4 — Pętla ReAct rozszerzenie

```ts
// react-loop.ts — nowa funkcja, nie zmieniamy istniejącej
async function reactStepWithNativeTools(params: {
  agent: any
  tools: MetaAgentTools
  systemPrompt: string
  userPrompt: string
  taskId: string
}): Promise<{ thought: string; action: ParsedToolCall | null; finalAnswer: string | null; usage: any }> {
  const modelSpec = await params.agent.resolveModelForStep('react-step')
  const caps = getCapabilities(modelSpec)

  if (!caps.supportsNativeTools || process.env.FEATURE_NATIVE_TOOLS_ENABLED === 'false') {
    // Fallback do starej ścieżki JSON mode
    return await reactStepLegacy(params)
  }

  // Native path
  const toolSpecs = buildToolSpecs(params.tools.listAvailable())

  const response = await params.agent.callLLM('react-step', {
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
    tools: toolSpecs,
    toolChoice: 'auto',
    temperature: 0.1,
  }, params.taskId)

  if (response.toolCalls && response.toolCalls.length > 0) {
    // Model wybrał narzędzie — bierzemy pierwsze (multi-tool to ETAP 5)
    return {
      thought: response.text,
      action: response.toolCalls[0],
      finalAnswer: null,
      usage: response.usage,
    }
  }

  // Model zwrócił tylko text — to finalAnswer
  return {
    thought: response.text,
    action: null,
    finalAnswer: response.text,
    usage: response.usage,
  }
}
```

#### Krok 5 — Routing w `reactLoop`

W główniej pętli, w miejscu gdzie obecnie jest `parseReActStepWithRepair`:

```ts
const stepResult = await reactStepWithNativeTools({...})
const parsed = {
  thought: stepResult.thought,
  action: stepResult.action ? {
    tool: stepResult.action.name,
    args: stepResult.action.args
  } : null,
  finalAnswer: stepResult.finalAnswer
}
// dalej tak samo jak teraz
```

### Kryteria akceptacji

- ✅ Dla `ollama:qwen2.5:14b` (lub innego z `supportsNativeTools: true`) pętla nigdy nie wywołuje `parseReActStepWithRepair`
- ✅ Dla `ollama:gemma2:9b` (`supportsNativeTools: false`) pętla używa starej ścieżki JSON
- ✅ Telemetria w `runs` zawiera flagę `usedNativeTools: boolean`
- ✅ Liczba `react-step-repair` calls spada do <1% wszystkich react-step calls (mierzone na produkcji przez tydzień)
- ✅ Brak regresji w istniejących e2e testach

### Testy

```ts
// apps/workers/src/agents/meta-agent/__tests__/native-tools.test.ts
describe('native tool calling', () => {
  it('Qwen 2.5 zwraca tool_calls bezpośrednio', async () => {
    const agent = new MetaAgent({ ...config, primary: 'ollama:qwen2.5:14b' })
    const result = await agent.run({ message: 'Pokaż leady ze statusem sent', taskId: 't1' })
    const runs = await db.collection('runs').find({ taskId: 't1' }).toArray()
    expect(runs.find(r => r.stepName === 'react-step-repair')).toBeUndefined()
  })

  it('Llama 3.1 8B fallback do JSON mode', async () => {
    const agent = new MetaAgent({ ...config, primary: 'ollama:llama3.1:8b' })
    const result = await agent.run({ message: 'Pokaż leady', taskId: 't2' })
    const runs = await db.collection('runs').find({ taskId: 't2' }).toArray()
    expect(runs.find(r => r.data?.usedNativeTools === false)).toBeDefined()
  })
})
```

### Rollback

`FEATURE_NATIVE_TOOLS_ENABLED=false` lub w model-registry zmienić `supportsNativeTools` na `false` dla problematycznego modelu.

---

## ETAP 3 — Streaming thought do UI

> **Czas:** 3 dni
> **Risk:** średni — wymaga refactoru `callLLM` z Promise na async iterator
> **Feature flag:** `FEATURE_STREAMING_ENABLED=true`
> **Cel:** User widzi rozumowanie agenta natychmiast, jak w Claude Desktop / ChatGPT. Dramatyczna poprawa perceived latency.

### Co budujemy

1. Rozszerzenie `callLLM` o tryb streaming — zwraca `AsyncIterable<LLMChunk>` zamiast `LLMResponse`
2. W providers implementacja stream parsing (Anthropic SSE, OpenAI SSE, Ollama NDJSON, Gemini SSE)
3. W `react-loop.ts` strumieniowanie `thought` przez Redis pub/sub jako `meta:thought_delta` events
4. Frontend (poza scope tego planu, ale uwzględnić) odbiera delta i renderuje na żywo

### Pliki dotykane

- `packages/llm/src/types.ts` — `LLMChunk`, rozszerzenie `LLMCallOptions`
- `packages/llm/src/providers/*.ts` — implementacja `callStream(opts)` w każdym
- `packages/llm/src/router.ts` — passthrough streamu przez fallback chain
- `apps/workers/src/core/base-agent.ts` — metoda `callLLMStream`
- `apps/workers/src/agents/meta-agent/react-loop.ts` — strumieniowanie thought
- `apps/workers/src/core/events.ts` — rejestracja nowych typów eventów

### Implementacja kluczowych części

```ts
// packages/llm/src/types.ts
export type LLMChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsDelta: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string }
```

```ts
// providers/anthropic.ts
async *callStream(opts: LLMCallOptions): AsyncIterable<LLMChunk> {
  const stream = await this.client.messages.stream(buildPayload(opts))
  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { type: 'text_delta', delta: event.delta.text }
      } else if (event.delta.type === 'input_json_delta') {
        yield { type: 'tool_call_delta', id: '...', argsDelta: event.delta.partial_json }
      }
    }
    // ... inne typy eventów
  }
  yield { type: 'done', finishReason: 'stop' }
}
```

```ts
// react-loop.ts (fragment)
let accumulatedThought = ''
for await (const chunk of agent.callLLMStream('react-step', opts, taskId)) {
  if (chunk.type === 'text_delta') {
    accumulatedThought += chunk.delta
    await publishEvent({
      type: 'meta:thought_delta',
      agentId,
      taskId,
      data: { delta: chunk.delta, step: i + 1 }
    })
  }
  // ... handle tool_call_start, etc.
}
```

### Kryteria akceptacji

- ✅ Frontend dostaje pierwszy `meta:thought_delta` event w <500ms od startu kroku
- ✅ Cały thought napływa progressively (nie czekanie na koniec)
- ✅ Dla modeli bez streaming support — fallback do non-stream
- ✅ Token usage zlicza się poprawnie (z ostatniego eventu `usage`)

### Rollback

`FEATURE_STREAMING_ENABLED=false`.

---

## ETAP 4 — Compaction historii (lokalny worker)

> **Czas:** 3 dni
> **Risk:** niski (compaction jest opcjonalna — gdy się popsuje, fallback to pełna historia)
> **Feature flag:** `FEATURE_COMPACTION_ENABLED=true`
> **Cel:** 50-70% redukcja kosztu pętli >5 kroków. Pozwala bezpiecznie podnieść `maxSteps` do 25-30.

### Co budujemy

Trigger: gdy `totalTokens / TOKEN_BUDGET > 0.6`, summaryzuj kroki 1..N-4 do max 200 znaków każdy. Zachowaj recency (4 ostatnie) i salience (kroki 1-2 z planem).

### Pliki nowe

```
apps/workers/src/agents/meta-agent/compactor.ts      [NEW]
```

### Pliki dotykane

- `apps/workers/src/agents/meta-agent/react-loop.ts` — wywołanie compactora przy budowie `stepContext`

### Implementacja

```ts
// apps/workers/src/agents/meta-agent/compactor.ts
import { BaseAgent } from '../../core/base-agent'
import { ReActStep } from './react-loop'

const SALIENCE_HEAD = 2     // pierwsze 2 kroki — zwykle plan + kluczowy lookup
const RECENCY_TAIL = 4      // ostatnie 4 kroki — pełne
const SUMMARY_MAX_LEN = 200 // znaków per zsummaryzowany krok

export async function compactHistory(
  steps: ReActStep[],
  agent: BaseAgent,
  taskId: string
): Promise<string> {
  if (steps.length <= SALIENCE_HEAD + RECENCY_TAIL) {
    // Mało kroków — nie ma co compactować
    return formatStepsFull(steps)
  }

  const head = steps.slice(0, SALIENCE_HEAD)
  const tail = steps.slice(-RECENCY_TAIL)
  const middle = steps.slice(SALIENCE_HEAD, -RECENCY_TAIL)

  // Summaryzuj middle przez lokalny model
  const middleText = middle.map((s, i) =>
    `Krok ${SALIENCE_HEAD + i + 1}: ${s.action?.tool ?? 'finalAnswer'} → ${s.observation.slice(0, 500)}`
  ).join('\n')

  const summary = await (agent as any).callLLM('compact-history', {
    systemPrompt: 'Jesteś kompaktorem historii agentów. Zwróć maks 1 zdanie per krok, zachowując fakty i wyniki narzędzi. Pomiń rozumowanie.',
    userPrompt: `Skompaktuj te kroki:\n\n${middleText}\n\nFormat: "Krok N: <co zrobił> → <wynik w 1 zdaniu>"`,
    temperature: 0,
    maxTokens: 500,
  }, taskId)

  return [
    formatStepsFull(head),
    `\n[--- KROKI ${SALIENCE_HEAD + 1}-${steps.length - RECENCY_TAIL} (skompaktowane) ---]\n${summary.text}\n[--- KONIEC SKOMPAKTOWANEGO ---]\n`,
    formatStepsFull(tail, steps.length - RECENCY_TAIL)
  ].join('\n')
}

function formatStepsFull(steps: ReActStep[], offset = 0): string {
  return steps.map((s, i) =>
    `Krok ${offset + i + 1}:\nMyśl: ${s.thought}\nAkcja: ${s.action ? JSON.stringify(s.action) : 'Brak'}\nObserwacja: ${s.observation}`
  ).join('\n\n')
}
```

W `react-loop.ts` dodać `agent.config.tiers.small` do per-step config dla `compact-history`:

```ts
// w agentConfig.ts dla MetaAgent.perStep:
'compact-history': {
  primary: 'ollama:qwen2.5:7b',   // lokalny mały model — tani i szybki
  fallback: 'ollama:llama3.1:8b'
}
```

W `react-loop.ts`:

```ts
const SHOULD_COMPACT_THRESHOLD = 0.6
const tokenRatio = (totalTokensIn + totalTokensOut) / TOKEN_BUDGET

const stepContext = (process.env.FEATURE_COMPACTION_ENABLED === 'true' && tokenRatio > SHOULD_COMPACT_THRESHOLD)
  ? await compactHistory(steps, params.agent, params.taskId)
  : steps.map((s, idx) => /* obecna logika */).join('\n\n')
```

### Kryteria akceptacji

- ✅ Po 7 krokach pętli, jeśli używamy frontier modelu, w `runs` jest entry `compact-history` z provider `ollama`
- ✅ Token usage głównego callu spada o ≥40% w stosunku do baseline (mierzone na zadaniach >5 kroków)
- ✅ Jakość finalAnswer nie pogarsza się (manualna ewaluacja na 20 zadaniach)

### Rollback

`FEATURE_COMPACTION_ENABLED=false` — stara logika historii.

---

## ETAP 5 — Plan-and-Execute (kluczowy etap)

> **Czas:** 7-10 dni roboczych — to największy etap
> **Risk:** wysoki — nowa architektura. Bardzo duże znaczenie testów regresji.
> **Feature flag:** `FEATURE_PLAN_EXECUTE_ENABLED=true` + per-intent gating
> **Cel:** Dwufazowy flow — frontier model **planuje raz**, lokalny model **wykonuje N kroków**. To jest serce całej transformacji.

### Filozofia etapu

**Obecnie:** każda iteracja pętli to osobny call do (drogo) frontier modelu, który myśli „co teraz?". 10 kroków = 10 calls do GPT-4 = $$$.

**Po refaktorze:**
1. Frontier dostaje całe zadanie + listę narzędzi → zwraca **plan** w postaci DAG (Directed Acyclic Graph) zadań
2. Lokalny executor (Qwen 14B) wykonuje plan krok po kroku
3. Jeśli krok zwróci nieprzewidziany wynik → executor robi mini-replanning (lokalnie, krótko) lub eskaluje do frontier replanning (rzadko)
4. Po wykonaniu planu frontier może zrobić reflection (etap 6) i wygenerować finalAnswer

**Kiedy NIE używać Plan-and-Execute:**
- Smalltalk, single-shot read (`general_chat`, prosty CRM read) — to są zadania na 1-2 kroki, planowanie to overhead
- Decyzja: na podstawie intent classifier (już istnieje)

### Pliki nowe

```
apps/workers/src/agents/meta-agent/planner.ts                 [NEW]
apps/workers/src/agents/meta-agent/executor.ts                [NEW]
apps/workers/src/agents/meta-agent/replanner.ts               [NEW]
apps/workers/src/agents/meta-agent/prompts/planner.md         [NEW]
apps/workers/src/agents/meta-agent/prompts/executor.md        [NEW]
apps/workers/src/agents/meta-agent/prompts/replanner.md       [NEW]
packages/shared/src/schemas-plan.ts                           [NEW]
```

### Pliki dotykane

- `apps/workers/src/agents/meta-agent/index.ts` — `MetaAgent.run()` dorzuca routing do nowego flow gdy intent jest complex
- `packages/shared/src/agentConfig.ts` — nowe entries per-step: `planner`, `executor`, `replanner`
- `apps/workers/src/core/events.ts` — nowe typy eventów: `plan:created`, `plan:step_start`, `plan:step_done`, `plan:replanning`

### Pliki czego NIE TYKAMY

- ❌ `react-loop.ts` — zostaje jako fallback dla zadań simple lub gdy `FEATURE_PLAN_EXECUTE_ENABLED=false`
- ❌ Handlery narzędzi w `tool-registry.ts` — wykonują się tak samo
- ❌ Schemat `ReActStep` — używamy w fallback

### Schemat planu

```ts
// packages/shared/src/schemas-plan.ts
import { z } from 'zod'

export const PlanStepSchema = z.object({
  id: z.string(),                          // np. "step1"
  description: z.string(),                 // ludzki opis
  tool: z.string(),                        // nazwa narzędzia z TOOL_DEFINITIONS
  args: z.record(z.any()).default({}),     // args literal LUB template z {{step1.output.field}}
  dependsOn: z.array(z.string()).default([]),  // ids innych steps
  parallelGroup: z.string().optional(),    // steps z tym samym groupem mogą iść równolegle
  optional: z.boolean().default(false),    // jeśli true, błąd nie przerywa planu
  retries: z.number().int().min(0).max(3).default(1),
})

export const PlanSchema = z.object({
  goal: z.string(),                        // cel zadania (echo z user message)
  reasoning: z.string(),                   // dlaczego ten plan (do logu)
  steps: z.array(PlanStepSchema).min(1).max(20),
  successCriteria: z.string(),             // czego oczekujemy po wykonaniu
  estimatedSteps: z.number(),              // dla UI progress bara
})

export const PlanStepResultSchema = z.object({
  stepId: z.string(),
  success: z.boolean(),
  output: z.any(),
  error: z.string().optional(),
  durationMs: z.number(),
  retriesUsed: z.number().default(0),
})

export type Plan = z.infer<typeof PlanSchema>
export type PlanStep = z.infer<typeof PlanStepSchema>
export type PlanStepResult = z.infer<typeof PlanStepResultSchema>
```

### Implementacja — Planner (frontier)

```ts
// apps/workers/src/agents/meta-agent/planner.ts
import { Plan, PlanSchema } from '@af/shared/schemas-plan'
import { buildToolSpecs } from './tool-schema-builder'

export async function generatePlan(params: {
  agent: BaseAgent
  message: string
  toolNames: string[]
  taskId: string
  context?: { crm?: any; memory?: any[] }
}): Promise<Plan> {
  const systemPrompt = await loadPrompt('planner.md')
  const toolList = formatToolsForPlanner(params.toolNames)

  const userPrompt = [
    `ZADANIE OD UŻYTKOWNIKA:`,
    params.message,
    '',
    `DOSTĘPNE NARZĘDZIA:`,
    toolList,
    '',
    params.context?.crm ? `KONTEKST CRM:\n${JSON.stringify(params.context.crm).slice(0, 1000)}` : '',
    '',
    `Zwróć plan zgodny ze schematem JSON.`,
  ].filter(Boolean).join('\n')

  const response = await params.agent.callLLM('planner', {
    systemPrompt,
    userPrompt,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 4096,
  }, params.taskId)

  // Walidacja
  const parsed = JSON.parse(response.text)
  const validation = PlanSchema.safeParse(parsed)
  if (!validation.success) {
    throw new Error(`Plan validation failed: ${JSON.stringify(validation.error.issues)}`)
  }

  // DAG validation — sprawdź że dependsOn nie ma cykli i że referuje istniejące steps
  validateDag(validation.data)

  return validation.data
}

function validateDag(plan: Plan): void {
  const stepIds = new Set(plan.steps.map(s => s.id))
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        throw new Error(`Step ${step.id} depends on non-existent ${dep}`)
      }
    }
  }
  // Topological sort — jeśli się nie da, jest cykl
  const sorted = topoSort(plan.steps)
  if (sorted.length !== plan.steps.length) {
    throw new Error('Plan zawiera cykl zależności')
  }
}
```

### Prompt dla plannera (`planner.md`)

Kluczowe wytyczne (skrócone — pełny prompt to ~150 linii):

```markdown
Jesteś PLANEREM zadań agentowych. Twoja jedyna rola to zaplanować rozwiązanie zadania użytkownika
jako sekwencji kroków używających dostępnych narzędzi.

## Twoje zadanie
Wygeneruj plan w formacie JSON zgodnym ze schematem PlanSchema.

## Kluczowe reguły
1. **NIE wykonuj narzędzi** — tylko planujesz
2. **Każdy krok = jedno narzędzie** z konkretnymi args
3. **Templating wyników:** w args możesz użyć `{{stepId.output.path}}` aby odwołać się do
   wyniku poprzedniego kroku. Np. `{{step1.output.email}}`.
4. **Parallel groups:** kroki z tym samym `parallelGroup` mogą iść równolegle. Używaj tego
   dla niezależnych readów (np. CRM lookup + Gmail lookup równocześnie).
5. **Dependencies:** każdy step który używa `{{stepN.*}}` musi mieć `stepN` w `dependsOn`.
6. **Plan minimalistyczny:** preferuj 3-5 kroków. Maksimum 15.
7. **Optional steps:** dla weryfikacji/walidacji ustaw `optional: true`.
8. **NIE planuj approval** — to runtime się tym zajmie. Po prostu wywołaj narzędzie wymagające approval.

## Przykład
User: "Wyślij maila do leada TechCorp z propozycją współpracy uwzględniającą RHD"

Plan:
{
  "goal": "Wyślij draft maila do TechCorp z RHD compliance",
  "reasoning": "Potrzebuję leada z CRM, wiedzy o RHD, i utworzyć draft. Lookup leada
                i wiedzy są niezależne — robię równolegle.",
  "steps": [
    {
      "id": "step1",
      "description": "Znajdź lead TechCorp w CRM",
      "tool": "crm.search_leads",
      "args": { "query": "TechCorp" },
      "dependsOn": [],
      "parallelGroup": "lookups"
    },
    {
      "id": "step2",
      "description": "Pobierz wiedzę o RHD",
      "tool": "knowledge.query",
      "args": { "question": "Kluczowe wymogi RHD dla restauracji", "notebooks": ["rhd"] },
      "dependsOn": [],
      "parallelGroup": "lookups"
    },
    {
      "id": "step3",
      "description": "Utwórz draft maila",
      "tool": "gmail.create_draft",
      "args": {
        "crmLeadIdOrEmail": "{{step1.output.email}}",
        "subject": "Propozycja współpracy",
        "body": "Bazuj na: {{step2.output.answer}}"
      },
      "dependsOn": ["step1", "step2"]
    }
  ],
  "successCriteria": "Draft maila utworzony i przypisany do leada TechCorp w CRM",
  "estimatedSteps": 3
}
```

### Implementacja — Executor (lokalny)

```ts
// apps/workers/src/agents/meta-agent/executor.ts
import { Plan, PlanStep, PlanStepResult } from '@af/shared/schemas-plan'

export class PlanExecutor {
  private results = new Map<string, any>()

  constructor(
    private agent: BaseAgent,
    private tools: MetaAgentTools,
    private taskId: string,
    private agentId: string
  ) {}

  async execute(plan: Plan): Promise<{
    success: boolean
    results: Map<string, PlanStepResult>
    pendingApprovals: any[]
    needsReplan?: { reason: string; failedStep: string }
  }> {
    const results = new Map<string, PlanStepResult>()
    const pendingApprovals: any[] = []
    const groups = this.buildExecutionGroups(plan)

    await publishEvent({
      type: 'plan:created',
      agentId: this.agentId,
      taskId: this.taskId,
      data: { plan, totalSteps: plan.steps.length }
    })

    for (const group of groups) {
      // Wszystkie steps w grupie idą równolegle
      const groupResults = await Promise.allSettled(
        group.map(step => this.executeStep(step, plan))
      )

      for (let i = 0; i < group.length; i++) {
        const step = group[i]
        const settled = groupResults[i]

        if (settled.status === 'rejected') {
          // Hard error — failover do replanner
          if (!step.optional) {
            return {
              success: false,
              results,
              pendingApprovals,
              needsReplan: { reason: settled.reason.message, failedStep: step.id }
            }
          }
        } else {
          const result = settled.value
          results.set(step.id, result)
          this.results.set(step.id, result.output)

          if (result.output?.pendingApproval) {
            pendingApprovals.push(result.output.pendingApproval)
            // Approval blokuje plan — wracamy do user-a
            return { success: false, results, pendingApprovals }
          }

          if (!result.success && !step.optional) {
            return {
              success: false,
              results,
              pendingApprovals,
              needsReplan: { reason: result.error ?? 'unknown', failedStep: step.id }
            }
          }
        }
      }
    }

    return { success: true, results, pendingApprovals }
  }

  private async executeStep(step: PlanStep, plan: Plan): Promise<PlanStepResult> {
    await publishEvent({
      type: 'plan:step_start',
      agentId: this.agentId,
      taskId: this.taskId,
      data: { stepId: step.id, tool: step.tool, description: step.description }
    })

    const startTime = Date.now()
    let lastError: string | undefined
    let retries = 0

    for (let attempt = 0; attempt <= step.retries; attempt++) {
      try {
        // Resolve template args ({{stepN.output.field}})
        const resolvedArgs = this.resolveArgs(step.args)

        // Wykonaj narzędzie
        const result = await this.tools.execute(step.tool, resolvedArgs, this.taskId)

        if (result.success) {
          const stepResult: PlanStepResult = {
            stepId: step.id,
            success: true,
            output: result.data,
            durationMs: Date.now() - startTime,
            retriesUsed: retries,
          }

          await publishEvent({
            type: 'plan:step_done',
            agentId: this.agentId,
            taskId: this.taskId,
            data: { stepId: step.id, success: true, durationMs: stepResult.durationMs }
          })

          return stepResult
        }

        lastError = result.error
        retries = attempt + 1
      } catch (e) {
        lastError = (e as Error).message
        retries = attempt + 1
      }

      // Backoff przed retry
      if (attempt < step.retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
      }
    }

    return {
      stepId: step.id,
      success: false,
      output: null,
      error: lastError,
      durationMs: Date.now() - startTime,
      retriesUsed: retries,
    }
  }

  /** Resolwuje template'y typu {{step1.output.email}} z poprzednich rezultatów. */
  private resolveArgs(args: Record<string, any>): Record<string, any> {
    const json = JSON.stringify(args)
    const resolved = json.replace(/\{\{(\w+)\.output\.([^}]+)\}\}/g, (match, stepId, path) => {
      const stepResult = this.results.get(stepId)
      if (!stepResult) throw new Error(`Reference to non-executed step: ${stepId}`)
      const value = getPath(stepResult, path)
      if (value === undefined) throw new Error(`Path ${path} not found in ${stepId} output`)
      return JSON.stringify(value).slice(1, -1)  // unwrap quotes
    })
    return JSON.parse(resolved)
  }

  /** Zbuduj grupy steps które mogą iść równolegle (topological + parallelGroup). */
  private buildExecutionGroups(plan: Plan): PlanStep[][] {
    // Topological sort
    const sorted = topoSort(plan.steps)
    const groups: PlanStep[][] = []
    const completed = new Set<string>()

    for (const step of sorted) {
      // Sprawdź czy wszystkie deps są w poprzednich grupach
      const allDepsCompleted = step.dependsOn.every(d => completed.has(d))

      if (groups.length > 0 && allDepsCompleted) {
        const lastGroup = groups[groups.length - 1]
        const sameGroup = step.parallelGroup &&
                         lastGroup.some(s => s.parallelGroup === step.parallelGroup) &&
                         lastGroup.every(s => !step.dependsOn.includes(s.id))
        if (sameGroup) {
          lastGroup.push(step)
          continue
        }
      }

      groups.push([step])
      step.dependsOn.forEach(d => completed.add(d))
      completed.add(step.id)
    }

    return groups
  }
}

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj)
}
```

### Implementacja — Replanner (frontier, rzadko)

```ts
// apps/workers/src/agents/meta-agent/replanner.ts
export async function replan(params: {
  agent: BaseAgent
  originalPlan: Plan
  completedResults: Map<string, PlanStepResult>
  failedStepId: string
  failureReason: string
  message: string
  taskId: string
}): Promise<Plan | { abandon: true; reason: string }> {
  const systemPrompt = await loadPrompt('replanner.md')
  const userPrompt = [
    `ORYGINALNE ZADANIE: ${params.message}`,
    `ORYGINALNY PLAN: ${JSON.stringify(params.originalPlan, null, 2)}`,
    `KROKI WYKONANE: ${[...params.completedResults.entries()]
      .map(([id, r]) => `${id}: ${r.success ? 'OK' : 'FAIL: ' + r.error}`)
      .join('\n')}`,
    `KROK KTÓRY ZAWIÓDŁ: ${params.failedStepId}`,
    `POWÓD: ${params.failureReason}`,
    ``,
    `Zwróć NOWY plan kontynuujący od miejsca awarii LUB { "abandon": true, "reason": "..." }
     jeśli zadanie nie da się dokończyć.`,
  ].join('\n\n')

  const response = await params.agent.callLLM('replanner', {
    systemPrompt,
    userPrompt,
    jsonMode: true,
    temperature: 0.3,
  }, params.taskId)

  const parsed = JSON.parse(response.text)
  if (parsed.abandon) return parsed
  return PlanSchema.parse(parsed)
}
```

### Routing w MetaAgent

```ts
// apps/workers/src/agents/meta-agent/index.ts
async run(input: { message: string; taskId: string }): Promise<any> {
  // ... istniejący kod do intent classification ...

  const usePlanExecute = process.env.FEATURE_PLAN_EXECUTE_ENABLED === 'true'
                      && this.shouldUsePlanExecute(intent, input.message)

  if (usePlanExecute) {
    return await this.runPlanExecute(input)
  }

  // Fallback do obecnej pętli ReAct
  return await this.runReactLoop(input)
}

private shouldUsePlanExecute(intent: string, message: string): boolean {
  // Plan-and-execute tylko dla complex intents
  const complexIntents = ['workflow_orchestration', 'tool_request']
  if (!complexIntents.includes(intent)) return false

  // Heurystyka: krótki message (< 50 znaków) prawdopodobnie smalltalk
  if (message.length < 50) return false

  return true
}

private async runPlanExecute(input: { message: string; taskId: string }): Promise<any> {
  // 1. Generate plan (FRONTIER)
  const plan = await generatePlan({
    agent: this,
    message: input.message,
    toolNames: this.tools.listAvailable(),
    taskId: input.taskId,
    context: { crm: await this.loadCrmContext(), memory: await this.loadMemory() }
  })

  await this.persistLiveState(input.taskId, { plan, phase: 'executing' })

  // 2. Execute (LOKALNY)
  const executor = new PlanExecutor(this, this.tools, input.taskId, this.id)
  let executionResult = await executor.execute(plan)

  // 3. Replan jeśli failure (FRONTIER, rzadko)
  let replansUsed = 0
  const MAX_REPLANS = 2
  while (executionResult.needsReplan && replansUsed < MAX_REPLANS) {
    const newPlan = await replan({
      agent: this,
      originalPlan: plan,
      completedResults: executionResult.results,
      failedStepId: executionResult.needsReplan.failedStep,
      failureReason: executionResult.needsReplan.reason,
      message: input.message,
      taskId: input.taskId,
    })

    if ('abandon' in newPlan) {
      return this.respondAbandoned(newPlan.reason)
    }

    executionResult = await executor.execute(newPlan)
    replansUsed++
  }

  // 4. Final answer (FRONTIER lub mid)
  return await this.generateFinalAnswer(executionResult, input)
}
```

### Kryteria akceptacji

- ✅ Dla intentu `workflow_orchestration` system używa Plan-and-Execute
- ✅ Dla `general_chat` używa starej pętli ReAct
- ✅ Plan jest tworzony 1× per zadanie (frontier call)
- ✅ Steps wykonują się przez lokalny model (sprawdzenie w `runs` collection)
- ✅ Parallel groups faktycznie działają równolegle (durationMs zsumowane < suma poszczególnych)
- ✅ Replan triggeruje się przy fail i daje nowy plan
- ✅ Telemetria pokazuje: total cost, breakdown frontier vs local
- ✅ Spadek kosztu chmurowego ≥70% na zadaniach z 5+ kroków (mierzone na 50 zadaniach)

### Testy

```ts
describe('Plan-and-Execute', () => {
  it('generuje plan przez frontier i wykonuje przez local', async () => {
    // setup: meta-agent z primary frontier, executor local
    const result = await metaAgent.run({
      message: 'Pokaż leady ze statusem sent i utwórz dla nich digest',
      taskId: 't1'
    })

    const runs = await db.collection('runs').find({ taskId: 't1' }).toArray()
    const plannerRun = runs.find(r => r.stepName === 'planner')
    expect(plannerRun.data.provider).toBe('anthropic')

    const executorRuns = runs.filter(r => r.stepName?.startsWith('tool_'))
    expect(executorRuns.length).toBeGreaterThan(0)
  })

  it('replanuje przy błędzie', async () => {
    // mock tool error
    // sprawdź że replanner został wywołany
  })

  it('parallel groups działają równolegle', async () => {
    // dwa kroki z parallelGroup="lookups"
    // sprawdź że sumaryczny czas < suma czasów
  })
})
```

### Stopniowy rollout

1. **Tydzień 1:** wdrożyć z `FEATURE_PLAN_EXECUTE_ENABLED=false`
2. **Tydzień 2:** włączyć dla 10% zadań (random sampling) — porównanie A/B
3. **Tydzień 3:** włączyć dla intent=`workflow_orchestration` na produkcji
4. **Tydzień 4:** rozszerzenie na `tool_request`
5. **Tydzień 5+:** monitorowanie metryk, tuning prompts plannera

### Rollback

`FEATURE_PLAN_EXECUTE_ENABLED=false` → cały ruch wraca do starej pętli ReAct.

---

## ETAP 6 — Reflection przed finalAnswer

> **Czas:** 2 dni
> **Risk:** niski
> **Feature flag:** `FEATURE_REFLECTION_ENABLED=true`
> **Cel:** Eliminacja halucynacji „twierdzę że zrobiłem X" gdy w toolTrace nie ma X.

### Co budujemy

Po wygenerowaniu kandydata na `finalAnswer` (z plan-execute lub z ReAct loop) **frontier model** dostaje:
- Treść finalAnswer
- Tool trace (lista wywołanych narzędzi + observations)
- Pyta: „Czy każde stwierdzenie w finalAnswer ma pokrycie w obserwacjach?"

Jeśli TAK — zwróć finalAnswer.
Jeśli NIE — wskaż które fragmenty są niepokryte i zwróć poprawioną wersję LUB triggeruje dodatkowy verification tool call.

**KIEDY skip reflection:**
- Intent `general_chat`
- 0 tool calls w trace (smalltalk — nie ma czego weryfikować)
- Lokalny model jako primary (reflection na małych modelach pogarsza wyniki — patrz wcześniejsza analiza)

### Pliki nowe

```
apps/workers/src/agents/meta-agent/reflector.ts                [NEW]
apps/workers/src/agents/meta-agent/prompts/reflector.md        [NEW]
```

### Pliki dotykane

- `apps/workers/src/agents/meta-agent/index.ts` — wywołanie reflector przed `respondToUser`
- `packages/shared/src/agentConfig.ts` — `reflector` step

### Implementacja

```ts
// apps/workers/src/agents/meta-agent/reflector.ts
import { ToolTrace } from '@af/shared'

export interface ReflectionResult {
  approved: boolean
  improved?: string         // poprawiona wersja finalAnswer
  unsupportedClaims?: string[]
  suggestedVerificationTools?: string[]
}

export async function reflect(params: {
  agent: BaseAgent
  candidateAnswer: string
  toolTrace: ToolTrace[]
  userMessage: string
  taskId: string
}): Promise<ReflectionResult> {
  // Skip dla małych modeli — reflection wymaga frontier
  const modelSpec = params.agent.pickModel('frontier')
  const caps = getCapabilities(modelSpec)
  if (!caps.goodForReflection) {
    return { approved: true }
  }

  // Skip jeśli brak tool calls
  if (params.toolTrace.length === 0) {
    return { approved: true }
  }

  const systemPrompt = await loadPrompt('reflector.md')
  const userPrompt = [
    `ZADANIE UŻYTKOWNIKA: ${params.userMessage}`,
    ``,
    `PROPONOWANA ODPOWIEDŹ DLA UŻYTKOWNIKA:`,
    params.candidateAnswer,
    ``,
    `WYWOŁANE NARZĘDZIA I ICH OBSERWACJE:`,
    params.toolTrace.map((t, i) =>
      `${i+1}. ${t.tool} → ${t.status}: ${t.detail?.slice(0, 500) ?? ''}`
    ).join('\n'),
    ``,
    `Sprawdź czy każde stwierdzenie w odpowiedzi jest pokryte obserwacjami z narzędzi.`,
    `Zwróć JSON: { "approved": boolean, "improved": "...", "unsupportedClaims": [...] }`,
  ].join('\n')

  const response = await params.agent.callLLM('reflector', {
    systemPrompt,
    userPrompt,
    jsonMode: true,
    temperature: 0,
  }, params.taskId)

  return JSON.parse(response.text)
}
```

### Prompt `reflector.md`

```markdown
Jesteś REFLEKTOREM — niezależnym walidatorem odpowiedzi agenta.

## Twoja jedyna rola
Sprawdzić, czy każde **konkretne stwierdzenie faktyczne** w `PROPONOWANEJ ODPOWIEDZI`
jest pokryte przez `WYWOŁANE NARZĘDZIA I OBSERWACJE`.

## Co weryfikujesz
- ID, nazwy, statusy — MUSZĄ być z observations
- Liczby (kwoty, ilości) — MUSZĄ być z observations
- "Wykonałem X" — MUSI być w trace narzędzie X z status=success
- Linki, ścieżki, technical details — MUSZĄ być z observations

## Co NIE weryfikujesz
- Stylistyka, formatowanie
- Ogólne wypowiedzi typu "mogę pomóc dalej"
- Opinie/sugestie agenta

## Format zwrotu
{
  "approved": true,                          // gdy wszystko OK
  "improved": null,
  "unsupportedClaims": []
}

LUB jeśli są problemy:
{
  "approved": false,
  "improved": "Poprawiona wersja odpowiedzi z usuniętymi/oznaczonymi nieweryfikowalnymi twierdzeniami",
  "unsupportedClaims": ["Twierdzenie X nie ma pokrycia w obserwacjach"]
}
```

### Kryteria akceptacji

- ✅ Reflection wykonuje się dla zadań z >0 tool calls i intent in [tool_request, workflow_orchestration]
- ✅ Spadek halucynacji o ≥40% (mierzone manualną ewaluacją 50 zadań przed/po)
- ✅ Reflection skip dla simple_intent
- ✅ Reflection skip gdy primary model nie ma goodForReflection
- ✅ Latency wzrost <2s na zadanie (1 dodatkowy LLM call do frontier)

### Rollback

`FEATURE_REFLECTION_ENABLED=false`.

---

## ETAP 7 — Tool retrieval (semantyczny wybór narzędzi)

> **Czas:** 4 dni
> **Risk:** średni — może obniżyć jakość jeśli źle dobrany top-K
> **Feature flag:** `FEATURE_TOOL_RETRIEVAL_ENABLED=true`
> **Cel:** Skalowanie do 100+ narzędzi bez zatkania context window. Trafniejszy wybór tool przez semantyczne podobieństwo.

### Aktualny stan

W repozytorium już istnieje `apps/workers/src/agents/meta-agent/tool-rag-service.ts` — podstawa już jest. Ten etap **rozszerza** go i podpina do plannera/executora.

### Co budujemy

1. **Indeksacja narzędzi:** dla każdego entry w `TOOL_DEFINITIONS` generujemy embedding z `${name}\n${description}\n${argsDescription}`
2. **Storage:** Mongo collection `tool_embeddings` — `{ name, embedding, model, createdAt }`
3. **Sync job:** przy starcie workera sprawdza czy są nowe/zmienione tools, regeneruje embeddings
4. **Retrieval API:** `findRelevantTools(query, k=10)` — cosine similarity
5. **Integracja z plannerem:** zamiast pełnej listy narzędzi, planner dostaje top-K relevant
6. **Integracja z ReAct loop:** tak samo

### Pliki dotykane

- `apps/workers/src/agents/meta-agent/tool-rag-service.ts` — rozszerzenie istniejącego
- `apps/workers/src/agents/meta-agent/planner.ts` — wywołanie `findRelevantTools` przed planem
- `apps/workers/src/agents/meta-agent/react-loop.ts` — opcjonalny path z retrieved tools

### Pliki nowe

```
apps/workers/src/agents/meta-agent/__tests__/tool-rag.test.ts  [NEW]
scripts/sync-tool-embeddings.ts                                [NEW]
```

### Implementacja

#### Krok 1 — Sync job

```ts
// scripts/sync-tool-embeddings.ts
import { TOOL_DEFINITIONS } from '@/agents/meta-agent/tool-definitions'
import { EmbeddingService } from '@af/llm/embeddings'
import { getDb } from '@/core/db'

async function sync() {
  const db = await getDb()
  const collection = db.collection('tool_embeddings')
  const embedder = new EmbeddingService()

  const EMBED_MODEL = process.env.LLM_TIER_EMBEDDING ?? 'ollama:bge-m3'

  for (const tool of TOOL_DEFINITIONS) {
    const text = [
      `Tool: ${tool.name}`,
      `Description: ${tool.description}`,
      `Args: ${tool.args.map(a => `${a.name} (${a.type}): ${a.description}`).join(', ')}`,
    ].join('\n')

    const hash = sha256(text)
    const existing = await collection.findOne({ name: tool.name })

    if (existing?.contentHash === hash && existing.model === EMBED_MODEL) {
      continue   // bez zmian
    }

    const result = await embedder.generate(text, EMBED_MODEL)
    await collection.replaceOne(
      { name: tool.name },
      {
        name: tool.name,
        embedding: result.embedding,
        contentHash: hash,
        model: EMBED_MODEL,
        updatedAt: new Date(),
      },
      { upsert: true }
    )

    console.log(`Indexed tool: ${tool.name}`)
  }
}

sync().then(() => process.exit(0))
```

Dodać do `package.json`:
```json
"scripts": {
  "sync:tools": "tsx scripts/sync-tool-embeddings.ts"
}
```

I do `Dockerfile` workera — uruchamiać przy starcie.

#### Krok 2 — Retrieval

```ts
// rozszerzenie tool-rag-service.ts
export async function findRelevantTools(
  query: string,
  k = 10,
  options?: { minSimilarity?: number; alwaysInclude?: string[] }
): Promise<{ name: string; similarity: number }[]> {
  const minSim = options?.minSimilarity ?? 0.3
  const embedder = new EmbeddingService()
  const queryEmb = await embedder.generate(query, process.env.LLM_TIER_EMBEDDING ?? 'ollama:bge-m3')

  const db = await getDb()
  const allEmbeddings = await db.collection('tool_embeddings').find({}).toArray()

  const scored = allEmbeddings.map(t => ({
    name: t.name,
    similarity: cosineSimilarity(queryEmb.embedding, t.embedding)
  })).filter(s => s.similarity >= minSim)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)

  // Always-include (np. system.search_tools, system.update_plan zawsze dostępne)
  const alwaysInclude = options?.alwaysInclude ?? ['system.search_tools', 'system.update_plan']
  for (const name of alwaysInclude) {
    if (!scored.find(s => s.name === name)) {
      scored.push({ name, similarity: 0 })
    }
  }

  return scored
}
```

#### Krok 3 — Integracja w plannerze

```ts
// planner.ts — modyfikacja
const relevantTools = process.env.FEATURE_TOOL_RETRIEVAL_ENABLED === 'true'
  ? await findRelevantTools(params.message, 15)
  : params.toolNames.map(n => ({ name: n, similarity: 1 }))

const toolList = formatToolsForPlanner(relevantTools.map(t => t.name))
```

#### Krok 4 — Hybrydowe retrieval (BM25 + embeddings)

Embeddings same czasem dają miss dla rzadkich nazw. Dodać:

```ts
async function findRelevantToolsHybrid(query: string, k = 10) {
  const semanticResults = await findRelevantTools(query, k * 2)
  const bm25Results = await findToolsByKeyword(query, k * 2)  // prosty match po słowach z description

  // Reciprocal rank fusion
  const merged = new Map<string, number>()
  semanticResults.forEach((r, i) => merged.set(r.name, (merged.get(r.name) ?? 0) + 1 / (i + 60)))
  bm25Results.forEach((r, i) => merged.set(r.name, (merged.get(r.name) ?? 0) + 1 / (i + 60)))

  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([name]) => ({ name, similarity: merged.get(name)! }))
}
```

### Kryteria akceptacji

- ✅ Sync job przy starcie indeksuje wszystkie tools w <30s
- ✅ Reindex tylko zmienionych (sprawdzane przez `contentHash`)
- ✅ Planner z 100 dostępnymi tools dostaje top 15 — i jego prompt jest 5× krótszy
- ✅ Trafność: na 50 testowych zadaniach top-5 retrieved zawiera właściwe narzędzie w >90% przypadków
- ✅ Latency retrieval < 100ms

### Rollback

`FEATURE_TOOL_RETRIEVAL_ENABLED=false` — planner dostaje pełną listę.

---

## ETAP 8 — UI improvements

> **Czas:** 5-7 dni
> **Risk:** niski — tylko frontend
> **Feature flag:** brak (UI polish)
> **Cel:** Doświadczenie użytkownika na poziomie Claude Desktop / Cursor.

### Co budujemy

1. **Inline tool cards** — w chat stream pojawia się karta z tool execution (zamiast plain text "uruchamiam X")
2. **Approval inline** — gdy tool wymaga approval, karta z preview/diff i przyciskami Approve/Reject/Edit
3. **Live cost & token counter** — widget w prawym górnym rogu z licznikiem
4. **Plan visualization** — gdy używamy plan-and-execute, user widzi DAG planu
5. **Step replay & time travel** — w Recent Tasks slider do przewijania kroków
6. **Confidence indicator** — gdy reflection oznaczyła `unsupportedClaims`, wizualne ostrzeżenie

### Pliki dotykane (frontend)

```
apps/web/src/components/chat/
  ToolCard.tsx                    [NEW]
  ApprovalCard.tsx                [NEW]
  CostCounter.tsx                 [NEW]
  PlanVisualization.tsx           [NEW]
  StepReplay.tsx                  [NEW]
apps/web/src/hooks/
  useAgentEvents.ts               [EXTEND] — handle nowe eventy: plan:*, meta:thought_delta
apps/web/src/pages/Chat.tsx       [MODIFY]
apps/web/src/pages/Tasks.tsx      [MODIFY]
```

### Komponenty (zarys)

```tsx
// ToolCard.tsx
interface ToolCardProps {
  tool: string
  args: Record<string, any>
  status: 'thinking' | 'running' | 'done' | 'error'
  durationMs?: number
  result?: any
  cost?: number
}

export function ToolCard({ tool, args, status, durationMs, result, cost }: ToolCardProps) {
  return (
    <div className="rounded-lg border p-3 my-2 bg-muted/50">
      <div className="flex items-center gap-2">
        <ToolIcon name={tool} />
        <span className="font-mono text-sm">{tool}</span>
        <StatusBadge status={status} />
        {durationMs && <span className="text-xs text-muted-foreground">{durationMs}ms</span>}
        {cost && <span className="text-xs">${cost.toFixed(4)}</span>}
      </div>
      <details className="mt-2">
        <summary className="text-xs cursor-pointer">Args ({Object.keys(args).length})</summary>
        <pre className="text-xs">{JSON.stringify(args, null, 2)}</pre>
      </details>
      {result && (
        <details className="mt-2">
          <summary className="text-xs cursor-pointer">Wynik</summary>
          <ResultPreview data={result} />
        </details>
      )}
    </div>
  )
}
```

```tsx
// CostCounter.tsx
export function CostCounter({ taskId }: { taskId: string }) {
  const { events } = useAgentEvents(taskId)

  const stats = useMemo(() => {
    let totalIn = 0, totalOut = 0, costUsd = 0
    for (const e of events) {
      if (e.type === 'llm:usage') {
        totalIn += e.data.tokensIn
        totalOut += e.data.tokensOut
        costUsd += e.data.costUsd
      }
    }
    return { totalIn, totalOut, costUsd }
  }, [events])

  return (
    <div className="fixed top-4 right-4 bg-card border rounded-lg p-2 text-xs">
      <div>💸 ${stats.costUsd.toFixed(4)}</div>
      <div>🎫 {(stats.totalIn + stats.totalOut).toLocaleString()} tok</div>
      <ProgressBar value={(stats.totalIn + stats.totalOut) / 100_000} />
    </div>
  )
}
```

### Kryteria akceptacji

- ✅ Tool cards renderują się w real-time (delta events)
- ✅ Approval card pozwala approve/reject/edit bez przechodzenia do osobnej sekcji
- ✅ Cost counter aktualizuje się live z każdym tool call
- ✅ Plan visualization pokazuje DAG z aktualnym progressem
- ✅ Step replay pozwala scrollować przez historię task'a

### Rollback

Frontend feature — można po prostu nie publikować.

---

## Macierz decyzji: który model do czego

Po wdrożeniu wszystkich etapów docelowy mapping (default values):

| Komponent (LLM call site) | Tier | Sugerowany model | Powód |
|---|---|---|---|
| `intent-analysis` | small | `ollama:qwen2.5:7b` | Klasyfikacja, prosta |
| `planner` | frontier | `anthropic:claude-3-5-sonnet` | Wymaga reasoningu + kreatywności |
| `executor` (per-step) | mid | `ollama:qwen2.5:14b` | Wykonanie planu — deterministyczne |
| `replanner` | frontier | `anthropic:claude-3-5-sonnet` | Adaptacja przy błędzie |
| `reflector` | frontier | `anthropic:claude-3-5-sonnet` | Meta-cognitive |
| `compact-history` | small | `ollama:qwen2.5:7b` | Summaryzacja, tania |
| `chat-orchestration` (final response) | mid | `ollama:qwen2.5:14b` | Generowanie odpowiedzi user-facing |
| `react-step` (legacy fallback) | mid | `ollama:qwen2.5:14b` | Gdy plan-execute disabled |
| `react-step-repair` (legacy fallback) | small | `ollama:qwen2.5:7b` | JSON fix, prosty |
| `subtask.delegate*` | mid | `ollama:qwen2.5:14b` | Sub-task — wąskie zadanie |
| `chef:generate` / `chef:iterate` | mid | `ollama:qwen2.5:14b` | Domena specjalistyczna |
| `knowledge-plan` | small | `ollama:qwen2.5:7b` | Routing po notebookach |
| `rss-digest` | small | `ollama:qwen2.5:7b` | Summaryzacja artykułów |
| Embeddings (tool retrieval, memory) | embedding | `ollama:bge-m3` | Industry standard |

**Override per-task:** UI w `/settings` pozwala ustawić override w MongoDB `agent_llm_configs` — admin może zmienić bez deploya.

---

## Strategia rollback i feature flagi

Wszystkie etapy są niezależnie wyłączalne:

```bash
# .env (production defaults po pełnym wdrożeniu)
FEATURE_PROMPT_CACHE_ENABLED=true       # ETAP 1
FEATURE_NATIVE_TOOLS_ENABLED=true       # ETAP 2
FEATURE_STREAMING_ENABLED=true          # ETAP 3
FEATURE_COMPACTION_ENABLED=true         # ETAP 4
FEATURE_PLAN_EXECUTE_ENABLED=true       # ETAP 5
FEATURE_REFLECTION_ENABLED=true         # ETAP 6
FEATURE_TOOL_RETRIEVAL_ENABLED=true     # ETAP 7
```

Awaria? Wyłącz flag → restart worker'a → poprzedni flow wraca w <60s.

**Każdy etap ma osobne metryki w `runs` collection** — można porównać A/B przed włączeniem na 100%.

---

## Czego NIE dotykamy w żadnym etapie

To są krytyczne fragmenty kodu, których **NIE WOLNO** modyfikować w tym refactorze (osobne PR-y w razie potrzeby):

1. **System approvali** (`tool-registry.ts:1713-1787`) — approval flow to security-critical, oddzielny security review
2. **CRM service** (`packages/crm/`) — refactor pętli nie powinien dotykać warstwy danych
3. **Schemat bazy danych** (collections: `tasks`, `runs`, `leads`, `memory`) — chyba że dodajemy NOWE collection (`tool_embeddings`, `plan_history`)
4. **Authentication / authorization** — nie ruszamy
5. **Webhook receivers** dla Telegram/Gmail/n8n — to osobna warstwa
6. **Konfiguracja Docker / deployment** — tylko dodajemy env vars, nie zmieniamy struktury
7. **Stary `react-loop.ts`** — zostawiamy jako fallback. NIE usuwamy nawet po pełnym wdrożeniu plan-execute (bezpieczna sieć dla simple intents)

---

## Harmonogram wdrożenia (sugerowany)

| Tydzień | Etap | Stan na koniec |
|---|---|---|
| 1 | ETAP 0 — Fundament | Model registry merged, brak zmian behawioralnych |
| 1 | ETAP 1 — Caching | Anthropic + Ollama caching aktywne, -60% kosztu |
| 2 | ETAP 2 — Native tools | Qwen 14B używa native tool calling |
| 2-3 | ETAP 3 — Streaming | UI pokazuje thoughts live |
| 3 | ETAP 4 — Compaction | Pętle >5 kroków używają compactora |
| 4-5 | ETAP 5 — Plan-and-Execute | Beta dla 10% workflow_orchestration |
| 6 | ETAP 6 — Reflection | Halucynacje -40% |
| 7 | ETAP 7 — Tool retrieval | Skala do 100+ tools |
| 8 | ETAP 8 — UI polish | Doświadczenie produktowe |

---

## Metryki sukcesu (KPI)

Po pełnym wdrożeniu należy obserwować:

| Metryka | Baseline (obecnie) | Cel |
|---|---|---|
| **Cost per task (USD)** | ~$0.05-0.15 | <$0.02 |
| **Latency p50** | ~12s | <8s |
| **Latency p95** | ~45s | <25s |
| **Halucynacje (manual eval)** | ~15% zadań | <5% |
| **JSON parse errors** | ~5% kroków | <0.5% |
| **Zadania ukończone** (vs limit kroków) | ~85% | >95% |
| **Cache hit rate (Anthropic)** | 0% | >70% |
| **% zadań z plan-execute** | 0% | >40% (workflow_orch + tool_request) |

---

## Załącznik A — Lista wszystkich nowych env vars

```bash
# Tier mapping
LLM_TIER_FRONTIER=anthropic:claude-3-5-sonnet-20241022
LLM_TIER_MID=ollama:qwen2.5:14b
LLM_TIER_SMALL=ollama:qwen2.5:7b
LLM_TIER_EMBEDDING=ollama:bge-m3

# Feature flags
FEATURE_PROMPT_CACHE_ENABLED=true
FEATURE_NATIVE_TOOLS_ENABLED=true
FEATURE_STREAMING_ENABLED=true
FEATURE_COMPACTION_ENABLED=true
FEATURE_PLAN_EXECUTE_ENABLED=false       # default false do walidacji A/B
FEATURE_REFLECTION_ENABLED=true
FEATURE_TOOL_RETRIEVAL_ENABLED=true

# Tuning
REACT_LOOP_TOKEN_BUDGET=100000
COMPACTION_THRESHOLD_RATIO=0.6
PLAN_MAX_REPLANS=2
TOOL_RETRIEVAL_TOP_K=15
TOOL_RETRIEVAL_MIN_SIMILARITY=0.3

# Ollama infrastructure
OLLAMA_KEEP_ALIVE=30m
OLLAMA_NUM_PARALLEL=4
OLLAMA_MAX_LOADED_MODELS=3
```

---

## Załącznik B — Nowe typy eventów (Redis pub/sub)

```ts
// Plan-and-Execute events
type PlanCreatedEvent = { type: 'plan:created'; data: { plan: Plan; totalSteps: number } }
type PlanStepStartEvent = { type: 'plan:step_start'; data: { stepId: string; tool: string } }
type PlanStepDoneEvent = { type: 'plan:step_done'; data: { stepId: string; success: boolean } }
type PlanReplanningEvent = { type: 'plan:replanning'; data: { reason: string; failedStep: string } }

// Streaming events
type ThoughtDeltaEvent = { type: 'meta:thought_delta'; data: { delta: string; step: number } }

// Reflection events
type ReflectionStartEvent = { type: 'meta:reflection_start' }
type ReflectionDoneEvent = { type: 'meta:reflection_done'; data: { approved: boolean; unsupportedClaims?: string[] } }

// LLM usage (do live cost counter)
type LlmUsageEvent = { type: 'llm:usage'; data: { provider: string; model: string; tokensIn: number; tokensOut: number; costUsd: number; cachedTokens?: number } }
```

---

## Załącznik C — Database migrations

Nowe collections (idempotentne — `createIndex` z `unique`):

```ts
// db.tool_embeddings
{
  name: 'tool_embeddings',
  indexes: [
    { key: { name: 1 }, unique: true },
    { key: { contentHash: 1 } },
  ]
}

// db.plan_history (do replay i debugging)
{
  name: 'plan_history',
  indexes: [
    { key: { taskId: 1 } },
    { key: { createdAt: -1 } },
  ]
}
```

Brak migrations dla istniejących collections — refactor jest additive.

---

**Koniec planu.**

> *Dla DevOps:* po wdrożeniu uruchom `pnpm sync:tools` w cron co 24h aby utrzymać embeddings spójne z `TOOL_DEFINITIONS`.
> *Dla developera:* zacznij od ETAP 0 i ETAP 1 — obie zerowy ryzyk + natychmiastowa wartość. ETAP 5 to największy wysiłek, ale daje najwięcej.
> *Dla PM/biznesu:* po każdym etapie jest mierzalna wartość, etapy są niezależne. Można wstrzymać po dowolnym i mieć stabilny system.
