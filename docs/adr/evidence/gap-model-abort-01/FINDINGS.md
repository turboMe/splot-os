# GAP-MODEL-ABORT-01 — findings

**Spike:** does an `AbortSignal` passed to the AI-SDK model call actually stop
in-flight token generation? (plan §32, §15.2; feeds ADR 0005 and the
`GAP-WORKER-ISO-01` decision in ADR 0005.)

**Verdict: `ABORT_WORKS`** — reproducible over two runs (2026-07-23).

## Setup

- Layer under test: `ai@6` `streamText`/`generateText` + `@ai-sdk/openai-compatible`,
  constructed exactly as `src/mastra/lib/ollama-gateway.ts`
  (`createOpenAICompatible({ baseURL: OLLAMA/v1 }).chatModel(name)`). This is the
  same model-resolution path Mastra `agent.generate/stream` wraps.
- Model: `huihui_ai/qwen3.5-abliterated:9b` (already resident in VRAM, so cold
  load is not measured). A reasoning model — output arrives as `reasoning-delta`
  parts, so the probe counts token-bearing `fullStream` parts, not `textStream`.
- Probe: `src/mastra/orchestration/spikes/gap-model-abort-probe.ts`
  (`npm run spike:gap-model-abort`).

## Measured

| Probe | abort@1500ms | abort@2800ms |
|---|---|---|
| CONTROL (no abort) | 342 chunks / 6362 ms | 350 chunks / 6323 ms |
| STREAM before abort | 70 | 143 |
| STREAM **after abort** | **0** | **0** |
| abort→stop latency | **2 ms** | **2 ms** |
| observed abort | yes (`abort` part) | yes (`abort` part) |
| GENERATE reject | `AbortError` @ 1505 ms | `AbortError` @ 2805 ms |

The control run sustains a long stream; after `abort()` **zero** further tokens
arrive and the stream ends in ~2 ms; the non-streaming `generateText` rejects at
exactly the abort point (1.5 / 2.8 s) instead of running the full ~6.3 s. The
signal reaches the transport.

The first evidence file (`…860659.json`, `INCONCLUSIVE`) is kept for
transparency: it predates the `textStream → fullStream` fix and shows 0 control
chunks — a probe-methodology artifact of a reasoning model, not a system result.

## Decision impact — `GAP-WORKER-ISO-01` (refines ADR 0005)

Because cooperative in-flight abort of the model call is viable, worker isolation
is **not** required *solely* to cancel a model call:

- **LLM attempts** may use cooperative in-process cancel for the model call.
- Process isolation (separate killable process + TERM/grace/KILL) is **still
  required** for: non-cooperative tools/subprocess (shell, git, media, browser)
  that ignore `AbortSignal`; protecting the Front event loop from heavy CPU-bound
  work; and hung connections unresponsive to abort.
- Therefore Front/dispatcher never hosts a heavy or non-cooperative attempt, but
  the dispatcher does not need "every attempt in its own process" purely for
  cancellation. This simplifies the Fala-3 dispatcher shape.

## Follow-ups (tracked, not blockers for this verdict)

1. **Remote/cloud providers**: local Ollama stops server-side generation on
   connection close. For Groq / OpenRouter / DeepSeek / fal / Anthropic, aborting
   the fetch stops *us* receiving tokens, but whether the provider stops
   compute/billing is provider-specific → per-capability `abort mode` in the
   capability manifest (§14.1) and ADR "Remote provider cancel" (§26).
2. **Mastra wrapper**: confirm `agent.stream/generate({ abortSignal })` forwards
   the signal to `streamText`/`generateText` (HRN-001 shows the meta-harness
   monkey-patches only `.generate`). Expected pass; add a thin spike in PR-2.
3. **Progress signal**: reasoning models emit `reasoning-delta`, not text; the
   harness must treat progress as a typed event over `fullStream` (§10.1), not
   text presence.
