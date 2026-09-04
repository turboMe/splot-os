/**
 * Live OpenRouter model catalogue.
 *
 * The `:free` suffix is useful but not authoritative: promotional and stealth
 * models can have zero input/output prices without it. Price fields from the
 * API are decimal strings, so both sides must be parsed and checked.
 */

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface OpenRouterCatalogModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
    [key: string]: unknown;
  };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    [key: string]: unknown;
  };
  supported_parameters?: string[];
  expiration_date?: string | null;
  [key: string]: unknown;
}

export interface OpenRouterFreeModelRequirements {
  /** Parameters the endpoint must advertise, e.g. tools or structured_outputs. */
  requiredParameters?: string[];
  /** Input modalities the endpoint must accept, e.g. text and image. */
  inputModalities?: string[];
  /** Minimum context length in tokens. */
  minContextLength?: number;
  /** Keep expired promotional entries. Defaults to false. */
  includeExpired?: boolean;
  /** Reference time used for deterministic tests. */
  now?: Date;
}

export interface FetchOpenRouterFreeModelsOptions extends OpenRouterFreeModelRequirements {
  apiKey?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function isNumericZero(value: unknown): boolean {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

/** The catalogue price is the source of truth, not an id suffix. */
export function isFreeOpenRouterModel(model: OpenRouterCatalogModel): boolean {
  return isNumericZero(model.pricing?.prompt) && isNumericZero(model.pricing?.completion);
}

/** Only chat/generation models can be registered as Mastra language models. */
export function isTextGenerationOpenRouterModel(model: OpenRouterCatalogModel): boolean {
  const outputs = model.architecture?.output_modalities;
  return !outputs || outputs.length === 0 || outputs.includes('text');
}

export function filterFreeOpenRouterModels(
  models: OpenRouterCatalogModel[],
  requirements: OpenRouterFreeModelRequirements = {},
): OpenRouterCatalogModel[] {
  const requiredParameters = requirements.requiredParameters ?? [];
  const inputModalities = requirements.inputModalities ?? [];
  const now = requirements.now ?? new Date();

  return models.filter((model) => {
    if (!model?.id || !isFreeOpenRouterModel(model)) return false;

    if (!requirements.includeExpired && model.expiration_date) {
      const expiration = Date.parse(model.expiration_date);
      if (Number.isFinite(expiration) && expiration <= now.getTime()) return false;
    }

    const supported = new Set(model.supported_parameters ?? []);
    if (requiredParameters.some((parameter) => !supported.has(parameter))) return false;

    const modalities = new Set(model.architecture?.input_modalities ?? []);
    if (inputModalities.some((modality) => !modalities.has(modality))) return false;

    return (model.context_length ?? 0) >= (requirements.minContextLength ?? 0);
  });
}

export function toMastraOpenRouterModelId(openRouterModelId: string): string {
  return `openrouter/${openRouterModelId}`;
}

/**
 * Fetch all currently free OpenRouter entries. This is deliberately not cached:
 * callers such as the gateway own their refresh/startup policy.
 */
export async function fetchOpenRouterFreeModels(
  options: FetchOpenRouterFreeModelsOptions = {},
): Promise<OpenRouterCatalogModel[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const controller = options.signal ? null : new AbortController();
  const timeout = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
    : null;

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    const response = await fetchFn(OPENROUTER_MODELS_URL, {
      headers,
      signal: options.signal ?? controller?.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenRouter models API returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) {
      throw new Error('OpenRouter models API returned an invalid payload');
    }

    return filterFreeOpenRouterModels(body.data as OpenRouterCatalogModel[], options);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
