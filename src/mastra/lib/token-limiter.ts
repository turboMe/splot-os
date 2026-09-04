import { TokenLimiterProcessor } from '@mastra/core/processors';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

/**
 * o200k_base ranks (Mastra's default token-limiter encoding) but with the
 * special-token table emptied.
 *
 * Why: TokenLimiterProcessor counts tokens via js-tiktoken `encode()`, which by
 * default rejects any text containing a special-token literal (e.g. the substring
 * "<|endoftext|>") and throws "The text contains a special token that is not
 * allowed". Agents that ingest scraped web / recon content (chef recon, knowledge,
 * automation, coding) routinely encounter such literals in pages, reviews and
 * model dumps. Because the processor runs at every agentic step, a single
 * offending message aborts the whole input-processor workflow and surfaces to the
 * user as "Exhausted all fallback models. ... step processor:token-limiter".
 *
 * Emptying special_tokens makes the encoder treat "<|...|>" markers as ordinary
 * text and count them normally — token budgeting stays correct, the crash is gone.
 */
const encodingWithoutSpecialTokens = { ...o200kBase, special_tokens: {} };

/**
 * Build a TokenLimiterProcessor that won't crash on special-token literals.
 * Use this instead of `new TokenLimiterProcessor({ limit })` anywhere agent
 * input may contain untrusted/scraped text.
 */
export function createTokenLimiter(limit: number): TokenLimiterProcessor {
  return new TokenLimiterProcessor({ limit, encoding: encodingWithoutSpecialTokens });
}
