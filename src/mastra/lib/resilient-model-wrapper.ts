/**
 * Resilient Language Model Wrapper
 *
 * Wraps an AI SDK LanguageModel (V1/V2/V3) with automatic fallback execution.
 * When the primary model encounters a recoverable error (HTTP 429 Rate Limit,
 * HTTP 500/502/503/504, or network timeout), the wrapper automatically and
 * seamlessly reroutes the request (both `doGenerate` and `doStream`) to a list
 * of fallback models.
 *
 * This ensures that streaming calls in Mastra Studio UI as well as background
 * generation calls never fail when free/rate-limited models hit capacity limits.
 */

import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { models } from '../config/model-manifest.js';

const GROQ_GATEWAY_PREFIX = 'custom-groq/groq/';

export interface FallbackOptions {
  modelName: string;
  providerName: string;
}

/**
 * Checks if an error is a recoverable failure (Rate Limit, Server Error, Network).
 */
export function isRecoverableModelError(error: any): boolean {
  if (!error) return false;
  const status = error.statusCode ?? error.status ?? error.response?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 408) {
    return true;
  }
  const msg = String(error.message || '').toLowerCase();
  if (
    msg.includes('rate limit') ||
    msg.includes('usage limit') ||
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('too many requests') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('service unavailable')
  ) {
    return true;
  }
  return false;
}

/**
 * Creates default fallback models based on available environment API keys.
 */
export function getAvailableFallbackModels(): any[] {
  const fallbacks: any[] = [];

  // 1. DeepSeek (highest quality & reliability)
  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const deepseekProvider = createDeepSeek({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com',
      });
      fallbacks.push({
        name: 'DeepSeek Chat (V4 Pro)',
        model: deepseekProvider.chat('deepseek-chat'),
      });
    } catch (e: any) {
      console.warn('[ResilientWrapper] Failed to initialize DeepSeek fallback:', e.message);
    }
  }

  // 2. Groq Cloud (ultra-fast LPU fallback)
  if (process.env.GROQ_API_KEY) {
    try {
      const groqProvider = createOpenAICompatible({
        name: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) MastraAgent/1.0',
        },
      });
      const groqModelId = models['groq-gpt-oss-120b'].slice(GROQ_GATEWAY_PREFIX.length);
      fallbacks.push({
        name: 'Groq GPT-OSS 120B',
        model: groqProvider.chatModel(groqModelId),
      });
    } catch (e: any) {
      console.warn('[ResilientWrapper] Failed to initialize Groq fallback:', e.message);
    }
  }

  // 3. OpenRouter fallback
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const openRouterProvider = createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
      });
      fallbacks.push({
        name: 'OpenRouter Gemini 2.5 Flash',
        model: openRouterProvider.chatModel('google/gemini-2.5-flash'),
      });
    } catch (e: any) {
      console.warn('[ResilientWrapper] Failed to initialize OpenRouter fallback:', e.message);
    }
  }

  return fallbacks;
}

/**
 * Wraps any LanguageModel with resilient fallback for `doGenerate` and `doStream`.
 */
export function wrapWithResilientFallback<T extends object>(primaryModel: T, options?: FallbackOptions): T {
  const modelName = options?.modelName || (primaryModel as any).modelId || 'unknown-model';

  return new Proxy(primaryModel, {
    get(target, prop, receiver) {
      if (prop === 'doGenerate') {
        return async (generateOptions: any) => {
          try {
            return await (target as any).doGenerate(generateOptions);
          } catch (err: any) {
            if (!isRecoverableModelError(err)) {
              throw err;
            }

            const errorMsg = err.data?.error?.message || err.message || 'Rate limit / unavailable';
            console.warn(
              `[ResilientGateway] ⚠️ Primary model "${modelName}" failed (${errorMsg}). Activating fallback chain for doGenerate...`,
            );

            const fallbackModels = getAvailableFallbackModels();
            if (fallbackModels.length === 0) {
              console.error('[ResilientGateway] No fallback models configured with valid API keys!');
              throw err;
            }

            let lastErr = err;
            for (const fb of fallbackModels) {
              try {
                console.log(`[ResilientGateway] 🔄 Trying fallback: ${fb.name}...`);
                const result = await fb.model.doGenerate(generateOptions);
                console.log(`[ResilientGateway] ✅ Fallback ${fb.name} successfully generated response.`);
                return result;
              } catch (fbErr: any) {
                console.warn(`[ResilientGateway] Fallback ${fb.name} failed: ${fbErr.message}`);
                lastErr = fbErr;
              }
            }
            throw lastErr;
          }
        };
      }

      if (prop === 'doStream') {
        return async (streamOptions: any) => {
          try {
            return await (target as any).doStream(streamOptions);
          } catch (err: any) {
            if (!isRecoverableModelError(err)) {
              throw err;
            }

            const errorMsg = err.data?.error?.message || err.message || 'Rate limit / unavailable';
            console.warn(
              `[ResilientGateway] ⚠️ Primary model "${modelName}" stream failed (${errorMsg}). Activating fallback chain for doStream...`,
            );

            const fallbackModels = getAvailableFallbackModels();
            if (fallbackModels.length === 0) {
              console.error('[ResilientGateway] No fallback models configured with valid API keys!');
              throw err;
            }

            let lastErr = err;
            for (const fb of fallbackModels) {
              try {
                console.log(`[ResilientGateway] 🔄 Trying stream fallback: ${fb.name}...`);
                const streamResult = await fb.model.doStream(streamOptions);
                console.log(`[ResilientGateway] ✅ Fallback ${fb.name} successfully opened stream.`);
                return streamResult;
              } catch (fbErr: any) {
                console.warn(`[ResilientGateway] Fallback stream ${fb.name} failed: ${fbErr.message}`);
                lastErr = fbErr;
              }
            }
            throw lastErr;
          }
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}
