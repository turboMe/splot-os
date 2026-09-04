import { z } from 'zod';
import { Agent } from '@mastra/core/agent';

/**
 * Normalizes a field that should be a string. 
 * Handles cases where LLM returns an object or array instead of a string.
 */
export function normalizeTextField(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (value == null) {
    return fallback;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => normalizeTextField(item, ''))
      .filter(Boolean)
      .join('\n');
    return text || fallback;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => {
        const normalized = normalizeTextField(val, '');
        return normalized ? `${key}: ${normalized}` : '';
      })
      .filter(Boolean);

    return entries.length > 0 ? entries.join('\n') : fallback;
  }

  return String(value);
}

export function normalizeNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

const HEAVY_LOCAL_MODELS = [
  'ollama/local/qwen3.5-abliterated:35b',
  'ollama/huihui_ai/qwen3.5-abliterated:35b',
];

export function assertSafeProducerHuntModel(model: string, stepId: string, taskId: string) {
  if (HEAVY_LOCAL_MODELS.includes(model)) {
    console.warn(`[producer-hunt:${taskId}] heavy local model configured for ${stepId}: ${model}`);
  }
}

export type GenerateJsonOptions<T> = {
  taskId: string;
  stepId: string;
  entityName?: string;
  prompt: string;
  schema: z.ZodSchema<T>;
  localAgent: Agent;
  repairAgent?: Agent;
  cloudFallbackAgent?: Agent;
  repairPrompt?: (badOutput: string, error: string) => string;
  fallback: (reason: string) => T;
};

export async function generateJsonWithFallback<T>({
  taskId,
  stepId,
  entityName,
  prompt,
  schema,
  localAgent,
  repairAgent,
  cloudFallbackAgent,
  repairPrompt,
  fallback,
}: GenerateJsonOptions<T>): Promise<T> {
  const logPrefix = `[producer-hunt:${taskId}:${stepId}]${entityName ? ` [${entityName}]` : ''}`;
  let badOutput = '';
  let lastError = '';

  const tryParse = (text: string): T | null => {
    try {
      // 1. Try to extract from markdown code block
      const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
      const jsonText = match ? match[1] : text;
      
      // Find first { and last }
      const start = jsonText.indexOf('{');
      const end = jsonText.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        return JSON.parse(jsonText.slice(start, end + 1));
      }
      
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  };

  // 1. Local attempt
  try {
    const res = await localAgent.generate(prompt);
    badOutput = res.text;
    const parsed = tryParse(res.text);
    if (parsed) {
      const validation = schema.safeParse(parsed);
      if (validation.success) {
        return validation.data;
      }
      lastError = validation.error.message;
      console.warn(`${logPrefix} local schema invalid:`, validation.error.message);
    } else {
      lastError = 'Invalid JSON';
      console.warn(`${logPrefix} local invalid json`);
    }
  } catch (err) {
    lastError = (err as Error).message;
    console.warn(`${logPrefix} local attempt failed:`, lastError);
  }

  // 2. Repair attempt. This only makes sense when we have a bad model output.
  if (repairAgent && badOutput) {
    try {
      const rPrompt = repairPrompt 
        ? repairPrompt(badOutput, lastError)
        : `Napraw poniższy tekst, aby był poprawnym obiektem JSON zgodnym ze schematem.
          Zwróć WYŁĄCZNIE czysty JSON.
          Błąd walidacji: ${lastError}
          Tekst do naprawy: ${badOutput}`;

      const repairRes = await repairAgent.generate(rPrompt);
      const repairParsed = tryParse(repairRes.text);
      if (repairParsed) {
        const validation = schema.safeParse(repairParsed);
        if (validation.success) {
          console.log(`${logPrefix} repair success`);
          return validation.data;
        }
        lastError = validation.error.message;
      } else {
        lastError = 'Repair returned invalid JSON';
      }
      console.warn(`${logPrefix} repair failed:`, lastError);
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(`${logPrefix} repair attempt failed:`, lastError);
    }
  }

  // 3. Cloud fallback attempt. This must still run if local or repair threw.
  if (cloudFallbackAgent) {
    try {
      console.log(`${logPrefix} using cloud fallback...`);
      const cloudPrompt = `${prompt}

Previous local attempt failed or returned invalid data.
Validation/error details: ${lastError}

Return only valid JSON matching the requested shape.`;
      const cloudRes = await cloudFallbackAgent.generate(cloudPrompt);
      const cloudParsed = tryParse(cloudRes.text);
      if (cloudParsed) {
        const validation = schema.safeParse(cloudParsed);
        if (validation.success) {
          console.log(`${logPrefix} cloud fallback success`);
          return validation.data;
        }
        lastError = validation.error.message;
      } else {
        lastError = 'Cloud fallback returned invalid JSON';
      }
      console.warn(`${logPrefix} cloud fallback failed:`, lastError);
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(`${logPrefix} cloud fallback attempt failed:`, lastError);
    }
  }

  // 4. Deterministic fallback
  console.log(`${logPrefix} using deterministic fallback`);
  return fallback(lastError || 'All attempts failed');
}
