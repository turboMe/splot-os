/**
 * Native Groq Gateway
 *
 * Provides direct access to Groq Cloud API via the Mastra Gateway interface.
 * Uses @ai-sdk/openai-compatible pointing to Groq's official API base URL.
 *
 * Base URL: https://api.groq.com/openai/v1
 * Auth: GROQ_API_KEY
 *
 * Model ID format: custom-groq/groq/<model>
 * Example: custom-groq/groq/openai/gpt-oss-120b
 */

import { MastraModelGateway } from '@mastra/core/llm';
import type { ProviderConfig, GatewayLanguageModel } from '@mastra/core/llm';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { models } from '../config/model-manifest.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_PROVIDER = 'groq';

/**
 * Derives the Groq model list from the model-manifest inventory.
 * Any model whose full ID starts with 'custom-groq/' is included.
 */
const GROQ_MODELS: string[] = (Object.values(models) as string[])
  .filter((fullId) => fullId.startsWith('custom-groq/'))
  .map((fullId) => fullId.replace(/^custom-groq\/groq\//, ''));

export class GroqGateway extends MastraModelGateway {
  readonly id = 'custom-groq';
  readonly name = 'Groq Cloud (native)';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.warn('[GroqGateway] GROQ_API_KEY not set — gateway disabled');
      return {};
    }

    return {
      [GROQ_PROVIDER]: {
        name: 'Groq Cloud API',
        models: GROQ_MODELS,
        apiKeyEnvVar: 'GROQ_API_KEY',
        gateway: 'custom-groq',
      },
    };
  }

  buildUrl(_modelId: string): string {
    return GROQ_BASE_URL;
  }

  async getApiKey(): Promise<string> {
    return process.env.GROQ_API_KEY ?? '';
  }

  async resolveLanguageModel({
    modelId,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('[GroqGateway] GROQ_API_KEY is missing');
    }

    const providerConfig = createOpenAICompatible({
      name: 'groq',
      baseURL: GROQ_BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) MastraAgent/1.0',
      },
    });

    return providerConfig.chatModel(modelId) as unknown as GatewayLanguageModel;
  }
}
