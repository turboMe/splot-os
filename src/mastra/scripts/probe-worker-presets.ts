#!/usr/bin/env tsx
/**
 * Live probe: does every `run_worker` preset actually produce usable output?
 *
 * Why this exists: on 2026-08-19 three of the five general presets were broken
 * at once and nothing noticed. `fast` and `default` pointed at Groq Llama models
 * decommissioned that month ("The model `llama-3.3-70b-versatile` does not exist
 * or you do not have access to it"), and `reasoning` pointed at a free Nemotron
 * that answers with whitespace instead of content. Every chef run that reached
 * the recipe phase lost all of its workers; one produced a 25-dish menu and zero
 * recipe cards.
 *
 * Two failure classes, and the cheap gate only catches the first:
 *   1. REMOVED  — provider no longer serves the id. `model-availability.ts` now
 *      catches this by enumerating each provider's catalogue.
 *   2. BROKEN   — still listed, still 200 OK, but the content is unusable.
 *      OpenRouter happily lists the whitespace model. ONLY a real generation
 *      catches this, which is why this probe is a script and not a startup check.
 *
 * Network + tokens, so it is deliberately NOT part of `check:all`.
 * Run: npm run probe:worker-presets
 */
import 'dotenv/config';

import { workerPresets, models, type ModelKey } from '../config/model-manifest.js';

interface Provider {
  url: string;
  key: string | undefined;
  prefix: string;
}

const PROVIDERS: Record<string, Provider> = {
  'custom-groq': {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: process.env.GROQ_API_KEY,
    prefix: 'custom-groq/groq/',
  },
  'custom-deepseek': {
    url: 'https://api.deepseek.com/v1/chat/completions',
    key: process.env.DEEPSEEK_API_KEY,
    prefix: 'custom-deepseek/deepseek/',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: process.env.OPENROUTER_API_KEY,
    prefix: 'openrouter/',
  },
};

/**
 * Workers are asked for pure JSON by every brief in the pipeline prompts, so
 * that is what we assert: a parsable object, not merely a 200 response.
 */
const PROMPT = 'Return ONLY this JSON object and nothing else: {"ok":true,"n":42}';

type Verdict = 'ok' | 'unusable' | 'error' | 'skipped';

async function probe(modelId: string): Promise<{ verdict: Verdict; detail: string }> {
  const entry = Object.entries(PROVIDERS).find(([name]) => modelId.startsWith(`${name}/`));
  if (!entry) return { verdict: 'skipped', detail: 'no probe route for this provider' };
  const [, provider] = entry;
  if (!provider.key) return { verdict: 'skipped', detail: 'no API key in env' };
  if (!modelId.startsWith(provider.prefix)) {
    return { verdict: 'skipped', detail: `id does not carry the expected prefix ${provider.prefix}` };
  }
  const apiId = modelId.slice(provider.prefix.length);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
      // Generous budget: a thinking model spends most of it on reasoning tokens
      // and returns EMPTY content if the cap is tight — which would look exactly
      // like the breakage we are hunting.
      body: JSON.stringify({ model: apiId, messages: [{ role: 'user', content: PROMPT }], max_tokens: 800 }),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) return { verdict: 'error', detail: `HTTP ${res.status}: ${raw.slice(0, 140)}` };

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return { verdict: 'unusable', detail: `provider returned non-JSON: ${JSON.stringify(raw.slice(0, 80))}` };
    }
    if (body?.error) return { verdict: 'error', detail: JSON.stringify(body.error).slice(0, 160) };

    const content = String(body?.choices?.[0]?.message?.content ?? '');
    if (content.trim().length === 0) {
      return { verdict: 'unusable', detail: 'empty content (model emitted no final answer)' };
    }
    // The briefs say "nothing but JSON", so a model that wraps or narrates its
    // answer is a real problem for the pipeline, not a cosmetic one.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { verdict: 'unusable', detail: `no JSON in output: ${JSON.stringify(content.slice(0, 80))}` };
    try {
      JSON.parse(match[0]);
    } catch {
      return { verdict: 'unusable', detail: `unparsable JSON: ${JSON.stringify(match[0].slice(0, 80))}` };
    }
    const clean = content.trim().startsWith('{');
    return { verdict: 'ok', detail: clean ? 'clean JSON' : 'JSON present but wrapped in prose/think tags' };
  } catch (err) {
    return { verdict: 'error', detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // Ad-hoc mode: probe explicit model ids instead of the preset table. Used to
  // vet a candidate model BEFORE mapping a preset to it, and to prove this
  // script actually rejects a broken one rather than only ever printing ticks.
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (explicit.length > 0) {
    console.log('probe:worker-presets — ad-hoc model probe\n');
    let bad = 0;
    for (const modelId of explicit) {
      const result = await probe(modelId);
      const mark = { ok: '✓', unusable: '✗', error: '✗', skipped: '–' }[result.verdict];
      console.log(`  ${mark} ${modelId}\n      ${result.verdict.toUpperCase()}: ${result.detail}`);
      if (result.verdict === 'unusable' || result.verdict === 'error') bad++;
    }
    process.exit(bad > 0 ? 1 : 0);
  }

  console.log('probe:worker-presets — live generation against every run_worker preset\n');

  const seen = new Map<string, { verdict: Verdict; detail: string }>();
  let broken = 0;
  let probed = 0;
  let skipped = 0;

  for (const [preset, alias] of Object.entries(workerPresets)) {
    const modelId = models[alias as ModelKey];
    // Presets share models; probe each distinct model once.
    let result = seen.get(modelId);
    if (!result) {
      result = await probe(modelId);
      seen.set(modelId, result);
    }
    const mark = { ok: '✓', unusable: '✗', error: '✗', skipped: '–' }[result.verdict];
    console.log(`  ${mark} ${preset.padEnd(18)} ${modelId}`);
    console.log(`      ${result.verdict.toUpperCase()}: ${result.detail}`);
    if (result.verdict === 'unusable' || result.verdict === 'error') broken++;
    else if (result.verdict === 'skipped') skipped++;
    else probed++;
  }

  console.log('');
  if (broken > 0) {
    console.error(`✗ ${broken} preset(s) cannot do the job they are mapped to.`);
    process.exit(1);
  }
  // A probe that reached nothing must not read as a pass. The whole point of
  // this script is to be believable evidence, and "no API keys loaded" produced
  // a green tick on the first run — the same shape of false green that let the
  // dead presets survive in the first place.
  if (probed === 0) {
    console.error(`✗ nothing was actually probed (${skipped} skipped) — this is NOT a pass.`);
    process.exit(1);
  }
  console.log(`✓ ${probed} preset(s) returned usable JSON${skipped > 0 ? ` (${skipped} skipped)` : ''}`);
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
