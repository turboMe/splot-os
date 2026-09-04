/**
 * Live Ollama ModelCaller — the exact AI-SDK path GAP-MODEL-ABORT-01 validated
 * (`createOpenAICompatible` + `generateText`, as in `lib/ollama-gateway.ts`).
 * The composed AbortSignal from the gateway is forwarded to `generateText`, so a
 * work-deadline hit actually stops token generation (measured in the spike).
 *
 * Used only by the opt-in live e2e; CI uses a deterministic ModelCaller.
 */
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelCaller } from './gateway.js';

export function createOllamaModelCaller(opts: { model: string; baseUrl?: string; maxOutputTokens?: number }): ModelCaller {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const provider = createOpenAICompatible({ name: 'ollama', apiKey: 'ollama', baseURL: `${baseUrl}/v1` });
  const model = provider.chatModel(opts.model);
  const maxOutputTokens = opts.maxOutputTokens ?? 400;
  return async ({ prompt, signal }) => {
    const { text } = await generateText({ model, prompt, abortSignal: signal, maxOutputTokens });
    return { text };
  };
}
