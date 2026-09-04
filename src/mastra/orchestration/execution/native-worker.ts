/**
 * Native (non-agent) capability worker — F6 cutover, work item 2.
 *
 * Every V2 worker so far has been an agent: `createRegistryWorker` resolves a
 * capability to a registered Mastra agent and runs a bounded model call. But not
 * all durable work is a model call. The Automation Golden Path is a pipeline —
 * validate, score risk, deploy, test, repair — and giving it durable attempts,
 * a real stop barrier and lease-driven cancellation should not require pretending
 * it is a conversation.
 *
 * So a capability may instead name a FUNCTION. The substrate does not care: it
 * still freezes the capability into the plan, still leases and fences the
 * attempt, still passes the same `WorkerContext`, and still maps whatever comes
 * back through the A boundary. The only thing that changes is what runs.
 *
 * WHY A COMPOSITE RATHER THAN A SECOND MOUNT
 * ------------------------------------------
 * The mount takes exactly one `WorkerFixture`, and that is the right shape — one
 * queue, one claim path, one set of loops. A second worker would mean a second
 * consumer racing for the same attempts. This composes instead: a task whose
 * capability has a native executor runs it, and everything else falls through to
 * the agent worker unchanged.
 *
 * ROUTING STAYS CLOSED. A native capability is registered in code at the
 * composition root, exactly like the agent allowlist. A name the model produces
 * can only ever select from what is already registered — it can never introduce
 * an executor.
 */
import type { WorkerContext, WorkerFixture } from '../store/worker.js';

/**
 * A native executor. Receives the same context an agent worker gets — including
 * `signal`, which is what makes cancellation real for non-model work — and
 * returns a producer envelope (`{ status, data, summary?, error? }`).
 *
 * It is handed the context rather than a prompt because the whole point is that
 * this work is not a prompt. Where its INPUT lives is the executor's business:
 * the automation executor reads the durable row that already holds it, rather
 * than copying a workflow spec into the orchestration store.
 */
export type NativeCapabilityExecutor = (ctx: WorkerContext) => Promise<unknown>;

export interface NativeCapabilityWorkerOpts {
  /** Capability name → executor. Code-owned and closed; see the header. */
  executors: Record<string, NativeCapabilityExecutor>;
  /** Everything without a native executor — normally the registry agent worker. */
  fallback: WorkerFixture;
}

export function nativeCapabilityWorker(opts: NativeCapabilityWorkerOpts): WorkerFixture {
  return async (ctx) => {
    const capability = ctx.capability ?? null;
    // `Object.hasOwn`, not `in`: a capability called `toString` or `constructor`
    // must not resolve to something off the prototype chain and be invoked as an
    // executor. The name reaching here came through a plan a model influenced.
    const executor = capability !== null && Object.hasOwn(opts.executors, capability)
      ? opts.executors[capability]
      : undefined;
    if (!executor) return opts.fallback(ctx);
    try {
      return await executor(ctx);
    } catch (error) {
      // A throwing executor is a FAILED attempt with a readable cause, not an
      // unhandled rejection in the worker loop that would look like the whole
      // drain died.
      return {
        status: 'failed',
        error: { code: 'native_executor_failed', message: (error as Error).message },
      };
    }
  };
}

/** True when this capability runs as code rather than as an agent. */
export function isNativeCapability(
  executors: Record<string, NativeCapabilityExecutor>,
  capability: string | null | undefined,
): boolean {
  return typeof capability === 'string' && Object.hasOwn(executors, capability);
}
