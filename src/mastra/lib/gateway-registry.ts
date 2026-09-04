import { defaultGateways } from '@mastra/core/llm';
import { OllamaGateway } from './ollama-gateway.js';
import { OpenRouterGateway } from './openrouter-gateway.js';
import { DeepSeekGateway } from './deepseek-gateway.js';
import { GroqGateway } from './groq-gateway.js';
import { ZenMuxGateway } from './zenmux-gateway.js';

export function ensureDefaultGateways(): void {
  const existing = new Set((defaultGateways as any[]).map((g) => g.id));

  if (!existing.has('ollama')) {
    (defaultGateways as any[]).push(new OllamaGateway());
  }
  if (process.env.OPENROUTER_API_KEY && !existing.has('openrouter')) {
    (defaultGateways as any[]).push(new OpenRouterGateway());
  }
  if (process.env.DEEPSEEK_API_KEY && !existing.has('custom-deepseek')) {
    (defaultGateways as any[]).push(new DeepSeekGateway());
  }
  if (process.env.GROQ_API_KEY && !existing.has('custom-groq')) {
    (defaultGateways as any[]).push(new GroqGateway());
  }
  if (process.env.ZENMUX_API_KEY && !existing.has('custom-zenmux')) {
    (defaultGateways as any[]).push(new ZenMuxGateway());
  }
}
