/**
 * DeepSeek Gateway
 *
 * Provides access to DeepSeek's cloud models via the Mastra Gateway interface.
 * Uses the dedicated @ai-sdk/deepseek provider (NOT the generic
 * @ai-sdk/openai-compatible one). This matters: DeepSeek's v4 thinking mode
 * returns a `reasoning_content` field that MUST be echoed back on every
 * follow-up turn of a multi-turn tool loop. The generic openai-compatible
 * provider drops `reasoning_content`, which makes the model re-think from
 * scratch each turn → slow loops, 60s harness timeouts, and empty outputs in
 * blank workers. The dedicated provider preserves that round-trip.
 *
 * Key facts from the DeepSeek API:
 * - OpenAI-compatible base URL: https://api.deepseek.com (provider sets it)
 * - Models support JSON output, tool calls, and (v4) thinking mode.
 * - Auth via a single API key (DEEPSEEK_API_KEY) — unchanged.
 *
 * Model ID format: custom-deepseek/deepseek/<model>
 * Example: custom-deepseek/deepseek/deepseek-v4-flash
 *
 * Mastra requires a 3-segment ID (gateway/provider/model). DeepSeek exposes a
 * single provider namespace, so the provider segment is simply `deepseek` and
 * only the final segment is sent to the API.
 */

import { MastraModelGateway } from '@mastra/core/llm';
import type { ProviderConfig, GatewayLanguageModel } from '@mastra/core/llm';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { models } from '../config/model-manifest.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_PROVIDER = 'deepseek';

// ── Models — generated from model-manifest.ts ────────────────────────────────

/**
 * Derives the DeepSeek model list from the model-manifest inventory.
 * Any model whose full ID starts with 'custom-deepseek/' is included.
 *
 * manifest: 'custom-deepseek/deepseek/deepseek-v4-flash'
 *       → model: 'deepseek-v4-flash'
 */
const DEEPSEEK_MODELS: string[] = (Object.values(models) as string[])
  .filter((fullId) => fullId.startsWith('custom-deepseek/'))
  .map((fullId) => fullId.slice(fullId.lastIndexOf('/') + 1));

// ── Gateway Implementation ───────────────────────────────────────────────────

export class DeepSeekGateway extends MastraModelGateway {
  readonly id = 'custom-deepseek';
  readonly name = 'DeepSeek (cloud)';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      console.warn('[DeepSeekGateway] DEEPSEEK_API_KEY not set — gateway disabled');
      return {};
    }

    return {
      [DEEPSEEK_PROVIDER]: {
        name: 'DeepSeek',
        models: DEEPSEEK_MODELS,
        apiKeyEnvVar: 'DEEPSEEK_API_KEY',
        gateway: 'custom-deepseek',
      },
    };
  }

  buildUrl(_modelId: string): string {
    return DEEPSEEK_BASE_URL;
  }

  async getApiKey(): Promise<string> {
    return process.env.DEEPSEEK_API_KEY ?? '';
  }

  async resolveLanguageModel({
    modelId,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('[DeepSeekGateway] DEEPSEEK_API_KEY not set');
    }

    // DeepSeek expects the bare model name (e.g. "deepseek-v4-flash").
    // The dedicated provider defaults baseURL to https://api.deepseek.com and
    // handles the reasoning_content round-trip required by v4 thinking mode.
    const provider = createDeepSeek({
      apiKey,
      baseURL: DEEPSEEK_BASE_URL,
    });

    return provider.chat(modelId) as unknown as GatewayLanguageModel;
  }
}
