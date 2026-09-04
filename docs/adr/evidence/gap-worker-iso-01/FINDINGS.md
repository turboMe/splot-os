# GAP-WORKER-ISO-01 — findings

**Spike:** does a heavy attempt in the Front/dispatcher process block the Node
event loop, and does a separate execution context protect it? (plan §32, §15.2,
§16.1; feeds ADR 0005 and ADR 0007.)

**Verdict: `ISOLATE_SYNC_KEEP_ASYNC`** — reproducible (2026-07-23).

## Method

A 25 ms heartbeat interval records how late each beat fires (`actualGap − 25` =
event-loop lag). Max lag is measured while a fixed workload runs under three
conditions. Pure Node (`worker_threads`, `crypto`) — no Mongo/Ollama.
Probe: `src/mastra/orchestration/spikes/gap-worker-iso-probe.ts`
(`npm run spike:gap-worker-iso`).

## Measured (max event-loop lag)

| Condition | workload 1500 ms | workload 1000 ms |
|---|---|---|
| SYNC_IN_PROCESS (heavy sync tool, main thread) | **1500 ms** | **999 ms** |
| SYNC_OUT_OF_PROC (same work in worker_thread) | **1 ms** | **1 ms** |
| ASYNC_IN_PROCESS (async-I/O loop, like a token stream) | **1 ms** | **1 ms** |

A CPU-bound synchronous attempt on the main thread freezes the event loop for its
**entire** duration — the Front would not answer status/cancel for that whole
window. The same work in a `worker_thread`, and any async-I/O-bound work, keep the
loop responsive (~1 ms).

## Decision (with `GAP-MODEL-ABORT-01`)

- **Isolate** CPU-bound / synchronous / non-cooperative attempts in a separate
  execution context. The Front/dispatcher never runs a synchronous heavy attempt.
- **Async-I/O model calls may stay in-process** — they do not block the loop and
  are cooperatively cancellable (`GAP-MODEL-ABORT-01`). So the dispatcher does not
  need "every attempt in its own process".
- Isolation granularity: `worker_thread` cheaply protects the event loop for
  CPU-bound JS; **media/subprocess/browser/git** attempts additionally need a
  killable **OS process** (`child_process` + TERM/grace/KILL) because their cancel
  is non-cooperative and they are separate binaries. This is the process adapter
  (plan §11.2), used by the `subprocess/browser` and `media/paid` pools (§16.1).

## Impact on the design

- Worker pools (§16.1) split by isolation need, not just concurrency: Front/bounded
  = in-process cooperative; domain-LLM = in-process cooperative model call with
  offloaded CPU post-processing; subprocess/media = killable child process.
- G3 ("process tree znika po TERM/KILL") and G7 (event-loop lag under saturation)
  now have a concrete threshold: any attempt whose synchronous CPU slice can exceed
  a small budget must be offloaded.
