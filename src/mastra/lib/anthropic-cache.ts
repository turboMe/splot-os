/**
 * Anthropic prompt-caching helper.
 *
 * Cache reads on Claude cost ~10× less than normal input tokens
 * (Opus 4.x: $15/1M input → $1.50/1M cached read; Sonnet/Haiku proportionally).
 * The marker tells Anthropic: "everything before this point can be cached
 * for ~5 minutes, charge me 90% less on subsequent reads". First write costs
 * 1.25× input — break-even at the 2nd hit within the 5-min window.
 *
 * Cache_control MUST be attached to a real prompt block (system message,
 * tool definition, or message-part) — Mastra reads providerOptions only off
 * those structures. Call-level providerOptions on agent.generate() are NOT
 * propagated to the system block by the Anthropic provider, so they do
 * NOT enable caching. Use `withAnthropicSystemCache(content)` to wrap
 * agent instructions correctly.
 */

const ANTHROPIC_CACHE_OPTIONS = {
  anthropic: { cacheControl: { type: 'ephemeral' as const } },
} as const;

type CacheOptionResult = { providerOptions: typeof ANTHROPIC_CACHE_OPTIONS } | Record<string, never>;

/**
 * @deprecated Call-level providerOptions are stuffed into a top-level
 * `cache_control` field that the Anthropic Messages API ignores — so this
 * does NOT actually enable prompt caching. Kept only to avoid breaking
 * existing call-sites. Prefer `withAnthropicSystemCache()` on agent
 * instructions instead.
 */
export function cacheOptionsForModel(modelId?: string): CacheOptionResult {
  if (!modelId) return {};
  return modelId.startsWith('anthropic/')
    ? { providerOptions: ANTHROPIC_CACHE_OPTIONS }
    : {};
}

/**
 * @deprecated See `cacheOptionsForModel` — call-level cacheControl is a no-op.
 * Use `withAnthropicSystemCache()` on the agent's instructions field.
 */
export function anthropicCacheOptions(): { providerOptions: typeof ANTHROPIC_CACHE_OPTIONS } {
  return { providerOptions: ANTHROPIC_CACHE_OPTIONS };
}

/**
 * Wrap a system-prompt string into a SystemModelMessage carrying an Anthropic
 * ephemeral cache breakpoint. For non-Anthropic providers the providerOptions
 * are silently ignored, so this is safe to apply unconditionally on agents
 * that may swap models via the manifest.
 *
 * Usage:
 *   instructions: withAnthropicSystemCache(await loadPrompt('meta/base'))
 */
export function withAnthropicSystemCache(content: string) {
  return {
    role: 'system' as const,
    content,
    providerOptions: ANTHROPIC_CACHE_OPTIONS,
  };
}
