/**
 * OpenRouter Gateway (Phase 4.1)
 *
 * Provides access to OpenRouter's free and paid models via the Mastra Gateway
 * interface. Uses @ai-sdk/openai-compatible since OpenRouter is fully
 * compatible with OpenAI Chat Completions format.
 *
 * Key features from OpenRouter API:
 * - `models: [...]` fallback lists (handled server-side by OpenRouter)
 * - `provider.require_parameters: true` — enforces JSON mode support
 * - `provider.data_collection: "deny"` — prevents training on our code
 * - Response includes `data.model` — which model was actually used
 *
 * Model ID format: openrouter/<provider>/<model>
 * Example: openrouter/nvidia/nemotron-3-super-120b-a12b:free
 *
 * The gateway registers multiple "providers" (nvidia, poolside, etc.)
 * so Mastra can route to them via 3-segment IDs.
 */

import { MastraModelGateway } from '@mastra/core/llm';
import type { ProviderConfig, GatewayLanguageModel } from '@mastra/core/llm';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { models } from '../config/model-manifest.js';
import {
  fetchOpenRouterFreeModels,
  isTextGenerationOpenRouterModel,
  toMastraOpenRouterModelId,
} from './openrouter-model-catalog.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ── Manifest models + live zero-price catalogue ──────────────────────────────

/**
 * Derives gateway models from the static manifest inventory.
 * Any model whose full ID starts with 'openrouter/' is included.
 * Provider namespace and model name are extracted from the ID segments.
 *
 * manifest: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free'
 *       → { id: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'nvidia', model: 'nemotron-3-super-120b-a12b:free' }
 */
interface OpenRouterGatewayModel {
  id: string;
  provider: string;
  model: string;
}

function toGatewayModel(fullId: string): OpenRouterGatewayModel | null {
  if (!fullId.startsWith('openrouter/')) return null;

  // 'openrouter/nvidia/model' -> 'nvidia/model'. Keep the first slash because
  // OpenRouter model ids are vendor-namespaced.
  const withoutGateway = fullId.slice('openrouter/'.length);
  const slashIdx = withoutGateway.indexOf('/');
  if (slashIdx <= 0 || slashIdx === withoutGateway.length - 1) return null;

  const upstreamProvider = withoutGateway.slice(0, slashIdx);
  const model = withoutGateway.slice(slashIdx + 1);
  // The gateway id already namespaces this provider, so preserve the exact
  // OpenRouter vendor. Changing `openai` to `openai-oss`, for example, would
  // make the manifest id and registered provider disagree.
  return { id: withoutGateway, provider: upstreamProvider, model };
}

const MANIFEST_MODELS: OpenRouterGatewayModel[] = (Object.values(models) as string[])
  .filter((fullId) => fullId.startsWith('openrouter/'))
  .map(toGatewayModel)
  .filter((model): model is OpenRouterGatewayModel => model !== null);

async function allGatewayModels(apiKey: string): Promise<OpenRouterGatewayModel[]> {
  let discovered: OpenRouterGatewayModel[] = [];
  try {
    const freeModels = await fetchOpenRouterFreeModels({ apiKey });
    discovered = freeModels
      .filter(isTextGenerationOpenRouterModel)
      .map((model) => toGatewayModel(toMastraOpenRouterModelId(model.id)))
      .filter((model): model is OpenRouterGatewayModel => model !== null);
  } catch (error) {
    // Static manifest entries, including openrouter/free, remain usable when
    // catalogue discovery is temporarily unavailable.
    console.warn('[OpenRouterGateway] Free-model discovery failed:', (error as Error).message);
  }

  const deduplicated = new Map<string, OpenRouterGatewayModel>();
  for (const model of [...MANIFEST_MODELS, ...discovered]) deduplicated.set(model.id, model);
  return [...deduplicated.values()];
}

// ── Gateway Implementation ───────────────────────────────────────────────────

export class OpenRouterGateway extends MastraModelGateway {
  readonly id = 'openrouter';
  readonly name = 'OpenRouter';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.warn('[OpenRouterGateway] OPENROUTER_API_KEY not set — gateway disabled');
      return {};
    }

    // Register static aliases plus every current 0/0 text-generation model.
    // This also catches promotional entries without a `:free` suffix.
    const gatewayModels = await allGatewayModels(apiKey);
    const byProvider: Record<string, string[]> = {};
    for (const m of gatewayModels) {
      (byProvider[m.provider] ??= []).push(m.model);
    }

    const result: Record<string, ProviderConfig> = {};
    for (const [provider, modelList] of Object.entries(byProvider)) {
      result[provider] = {
        name: `OpenRouter: ${provider}`,
        models: modelList,
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        gateway: 'openrouter',
      };
    }

    return result;
  }

  buildUrl(_modelId: string): string {
    return OPENROUTER_BASE_URL;
  }

  async getApiKey(): Promise<string> {
    return process.env.OPENROUTER_API_KEY ?? '';
  }

  async resolveLanguageModel({
    modelId,
    providerId,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('[OpenRouterGateway] OPENROUTER_API_KEY not set');
    }

    // Reconstruct the exact vendor-namespaced model name for OpenRouter API.
    // providerId = "nvidia", modelId = "nemotron-3-super-120b-a12b:free"
    // OpenRouter expects: "nvidia/nemotron-3-super-120b-a12b:free"
    const fullModelName = `${providerId}/${modelId}`;

    const provider = createOpenAICompatible({
      name: `openrouter-${providerId}`,
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      headers: {
        'HTTP-Referer': 'https://agentic-agents.local',
        'X-OpenRouter-Title': 'Agentic Agents Coding System',
      },
    });

    return provider.chatModel(fullModelName);
  }
}
