/**
 * Singleton embedder for semantic search and RAG.
 * Provider and model are selected only from model-manifest.ts:
 *   infrastructure.embedding.model -> models[alias]
 *
 * Runtime env still supplies endpoints/secrets:
 *   OLLAMA_BASE_URL=http://localhost:11434
 *   GOOGLE_GENERATIVE_AI_API_KEY=...
 *
 * Used by: chef notes semantic search, automation-architect pattern RAG.
 *
 * Note: changing the model changes vector dimensions. Consumers should store
 * EMBEDDING_MODEL_ID next to persisted vectors and re-embed on mismatch.
 */

export type EmbeddingVector = number[];

type Provider = 'ollama' | 'google';

/**
 * Embedding config comes from the manifest so changing
 * infrastructure.embedding.model is enough to switch provider/model.
 */
import { infrastructure, resolveModelId } from '../config/model-manifest.js';

interface EmbeddingConfig {
  provider: Provider;
  model: string;
}

export const EMBEDDING_MODEL_ID = resolveModelId(infrastructure.embedding.model);

function resolveManifestEmbeddingConfig(): EmbeddingConfig {
  const fullId = EMBEDDING_MODEL_ID;
  const [provider, ...parts] = fullId.split('/');

  if (provider === 'ollama') {
    const model = parts[0] === 'local' ? parts.slice(1).join('/') : parts.join('/');
    if (!model) throw new Error(`Invalid Ollama embedding model id: ${fullId}`);
    return { provider, model };
  }

  if (provider === 'google') {
    const model = parts.join('/');
    if (!model) throw new Error(`Invalid Google embedding model id: ${fullId}`);
    return { provider, model };
  }

  throw new Error(`Unsupported embedding provider in model manifest: ${fullId}`);
}

const EMBEDDING_CONFIG = resolveManifestEmbeddingConfig();
const PROVIDER = EMBEDDING_CONFIG.provider;
const EMBEDDING_MODEL = EMBEDDING_CONFIG.model;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Process-wide throttle + retry for local Ollama embeddings.
 *
 * Why: at startup the SkillRegistry (~100 skills) and the MemoryExtractor both
 * call generateEmbedding independently. Each call opens its own fetch, so even
 * though generateEmbeddings() is internally sequential there is NO global cap
 * across callers. A burst of concurrent requests crashes the bge-m3 runner
 * ("llama runner process has terminated"), producing 500s and 0 embeddings.
 *
 * Fix: gate every Ollama request through a tiny semaphore (default 2 concurrent)
 * and retry transient runner crashes / 5xx with exponential backoff so a runner
 * that died mid-burst gets time to reload before the next attempt.
 */
const OLLAMA_CONCURRENCY = Math.max(1, Number(process.env.EMBEDDING_CONCURRENCY) || 2);
const OLLAMA_MAX_RETRIES = Math.max(0, Number(process.env.EMBEDDING_MAX_RETRIES ?? 3));

let activeOllamaRequests = 0;
const ollamaWaitQueue: Array<() => void> = [];

function acquireOllamaSlot(): Promise<void> {
  if (activeOllamaRequests < OLLAMA_CONCURRENCY) {
    activeOllamaRequests++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => ollamaWaitQueue.push(resolve));
}

function releaseOllamaSlot(): void {
  const next = ollamaWaitQueue.shift();
  if (next) {
    next();
  } else {
    activeOllamaRequests = Math.max(0, activeOllamaRequests - 1);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryableOllamaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Runner crash, gateway/5xx, timeout, connection reset — all transient under load.
  return (
    /llama runner process has terminated/i.test(msg) ||
    /error 5\d\d/i.test(msg) ||
    /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b/i.test(msg) ||
    /(timed out|aborted|fetch failed)/i.test(msg)
  );
}

// Native context window for the embedding model. Inputs longer than this (in
// tokens) are clipped server-side rather than rejected. bge-m3 = 8192.
const OLLAMA_EMBED_NUM_CTX = Math.max(512, Number(process.env.EMBEDDING_NUM_CTX) || 8192);

async function fetchOllamaEmbeddingRaw(text: string): Promise<EmbeddingVector> {
  // Use the modern /api/embed endpoint, not legacy /api/embeddings. The legacy
  // endpoint ignores `truncate` and `num_ctx` and returns HTTP 500 "the input
  // length exceeds the context length" for any input longer than the loaded
  // window — silently dropping large code chunks, skills, and RAG documents from
  // the index. /api/embed honors num_ctx (so we clip at the model's full 8192,
  // not Ollama's smaller default) and truncate:true clips overflow instead of
  // erroring, so embedding always succeeds.
  const url = `${OLLAMA_BASE_URL}/api/embed`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      truncate: true,
      options: { num_ctx: OLLAMA_EMBED_NUM_CTX },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama embeddings error ${response.status} (model=${EMBEDDING_MODEL}): ${err}`);
  }

  const data = (await response.json()) as { embeddings?: number[][] };
  const embedding = data.embeddings?.[0];
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`Ollama returned empty embedding (model=${EMBEDDING_MODEL})`);
  }
  return embedding;
}

async function fetchOllamaEmbedding(text: string): Promise<EmbeddingVector> {
  await acquireOllamaSlot();
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= OLLAMA_MAX_RETRIES; attempt++) {
      try {
        return await fetchOllamaEmbeddingRaw(text);
      } catch (err) {
        lastErr = err;
        if (attempt >= OLLAMA_MAX_RETRIES || !isRetryableOllamaError(err)) break;
        // Exponential backoff (250ms, 500ms, 1s, ...) + jitter so the crashed
        // runner has time to reload and retries don't re-synchronize into a burst.
        const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 100);
        await sleep(backoff);
      }
    }
    throw lastErr;
  } finally {
    releaseOllamaSlot();
  }
}

async function fetchGoogleEmbedding(text: string): Promise<EmbeddingVector> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set — google embedder unavailable');

  const url = `${GOOGLE_API_BASE}/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Embeddings API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

async function fetchEmbedding(text: string): Promise<EmbeddingVector> {
  return PROVIDER === 'google' ? fetchGoogleEmbedding(text) : fetchOllamaEmbedding(text);
}

/**
 * Embed a single text. Returns a float vector.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingVector> {
  return fetchEmbedding(text);
}

/**
 * Embed multiple texts. Ollama has no batch endpoint, so we run sequentially
 * to avoid hammering the local server. Google batchEmbedContents is used when
 * provider=google.
 */
export async function generateEmbeddings(texts: string[]): Promise<EmbeddingVector[]> {
  if (texts.length === 0) return [];
  if (PROVIDER === 'google') return fetchGoogleBatch(texts);
  const out: EmbeddingVector[] = [];
  for (const t of texts) out.push(await fetchOllamaEmbedding(t));
  return out;
}

async function fetchGoogleBatch(texts: string[]): Promise<EmbeddingVector[]> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set — google embedder unavailable');

  const url = `${GOOGLE_API_BASE}/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Embeddings batch API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { embeddings: Array<{ values: number[] }> };
  return data.embeddings.map((e) => e.values);
}

/**
 * Cosine similarity between two vectors. Returns [-1, 1].
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) throw new Error('Vector length mismatch');
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find top-K most similar items from a list.
 */
export function findTopK<T extends { embedding: EmbeddingVector }>(
  query: EmbeddingVector,
  items: T[],
  k: number,
): Array<T & { score: number }> {
  return items
    .map((item) => ({ ...item, score: cosineSimilarity(query, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
