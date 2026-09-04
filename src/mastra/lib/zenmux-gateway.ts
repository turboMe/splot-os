/**
 * ZenMux Gateway
 *
 * Provides access to ZenMux's AI model aggregator via the Mastra Gateway
 * interface. ZenMux is fully OpenAI Chat Completions compatible.
 *
 * Base URL: https://zenmux.ai/api/v1
 * Auth: ZENMUX_API_KEY (Bearer token)
 *
 * Model ID format in ZenMux: <provider>/<model>
 * Example: moonshotai/kimi-k3-free
 *
 * Mastra 3-segment ID format: custom-zenmux/moonshotai/kimi-k3-free
 * The gateway strips 'custom-zenmux/' and reconstructs the full model name
 * as <provider>/<model> for the ZenMux API.
 *
 * Key features:
 * - OpenAI-compatible Chat Completions API
 * - PAYG (Pay As You Go) billing — $0 for free-tier models
 * - Supports streaming, tool calls, structured output
 * - Free models like moonshotai/kimi-k3-free ($0 in/$0 out)
 */

import { MastraModelGateway } from '@mastra/core/llm';
import type { ProviderConfig, GatewayLanguageModel } from '@mastra/core/llm';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { models } from '../config/model-manifest.js';

import { wrapWithResilientFallback } from './resilient-model-wrapper.js';

const ZENMUX_BASE_URL = 'https://zenmux.ai/api/v1';

// ── Models — generated from model-manifest.ts ────────────────────────────────

/**
 * Derives ZenMux models from the model-manifest inventory.
 * Any model whose full ID starts with 'custom-zenmux/' is included.
 *
 * manifest: 'custom-zenmux/moonshotai/kimi-k3-free'
 *       → { provider: 'moonshotai', model: 'kimi-k3-free' }
 */
const ZENMUX_MODELS: Array<{ id: string; provider: string; model: string }> = (Object.values(models) as string[])
  .filter((fullId) => fullId.startsWith('custom-zenmux/'))
  .map((fullId) => {
    // 'custom-zenmux/moonshotai/kimi-k3-free' → 'moonshotai/kimi-k3-free'
    const withoutGateway = fullId.replace('custom-zenmux/', '');
    const slashIdx = withoutGateway.indexOf('/');
    const provider = withoutGateway.slice(0, slashIdx);
    const model = withoutGateway.slice(slashIdx + 1);
    return { id: withoutGateway, provider, model };
  });

// ── Gateway Implementation ───────────────────────────────────────────────────

export class ZenMuxGateway extends MastraModelGateway {
  readonly id = 'custom-zenmux';
  readonly name = 'ZenMux (cloud)';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const apiKey = process.env.ZENMUX_API_KEY;
    if (!apiKey) {
      console.warn('[ZenMuxGateway] ZENMUX_API_KEY not set — gateway disabled');
      return {};
    }

    // Group models by provider namespace (e.g. moonshotai)
    const byProvider: Record<string, string[]> = {};
    for (const m of ZENMUX_MODELS) {
      (byProvider[m.provider] ??= []).push(m.model);
    }

    const result: Record<string, ProviderConfig> = {};
    for (const [provider, modelList] of Object.entries(byProvider)) {
      result[provider] = {
        name: `ZenMux: ${provider}`,
        models: Array.from(new Set(modelList)),
        apiKeyEnvVar: 'ZENMUX_API_KEY',
        gateway: 'custom-zenmux',
      };
    }

    return result;
  }

  buildUrl(_modelId: string): string {
    return ZENMUX_BASE_URL;
  }

  async getApiKey(): Promise<string> {
    return process.env.ZENMUX_API_KEY ?? '';
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
    const apiKey = process.env.ZENMUX_API_KEY;
    if (!apiKey) {
      throw new Error('[ZenMuxGateway] ZENMUX_API_KEY is missing');
    }

    // Reconstruct full model name for ZenMux API
    // providerId = "moonshotai", modelId = "kimi-k3-free"
    // ZenMux expects: "moonshotai/kimi-k3-free"
    const fullModelName = `${providerId}/${modelId}`;

    const providerConfig = createOpenAICompatible({
      name: `zenmux-${providerId}`,
      baseURL: ZENMUX_BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const baseModel = providerConfig.chatModel(fullModelName);
    return wrapWithResilientFallback(baseModel, {
      modelName: fullModelName,
      providerName: 'ZenMux',
    }) as unknown as GatewayLanguageModel;
  }
}
