/**
 * Mount the Meta Front v2 API into the production Mastra server (plan §17) —
 * flag-gated, additive. `index.ts` spreads `createV2ApiRoutes()` into its
 * `apiRoutes` ONLY when `FEATURE_ORCHESTRATION_V2 === 'true'`, so with the flag
 * off (default) nothing changes.
 *
 * Requires a MongoDB replica set (transactions): `MONGODB_URI_V2` must point at
 * one. If it does not, the v2 handlers return errors on use, but the rest of the
 * server is unaffected. The store connects lazily and optional background loops
 * (lane / worker / reconciler) drive jobs to completion.
 */
import { registerApiRoute } from '@mastra/core/server';
import {
  connectV2Store, ensureOrchestrationIndexes,
  drainLane, drainWorkers, reconcile, okWorker, WorkerPool, type V2Store, type WorkerFixture,
} from '../store/index.js';
import type { LaneDecider } from '../contracts/lane-decision.js';
import type { ProgressiveAttemptPolicy } from '../contracts/execution-budget.js';
import {
  drainSupervisedProcessWorkers,
  reconcileSupervisedProcesses,
  type SupervisedProcessRouter,
  type SupervisedProcessWorkerOptions,
} from '../execution/index.js';
import { createOrchestrationApi, type AuthContext, type ApiResponse } from './handlers.js';

interface V2MountConfig {
  uri?: string;
  dbName?: string;
  startBackground?: boolean;
  worker?: WorkerFixture;
  processWorker?: SupervisedProcessRouter;
  processWorkerOptions?: SupervisedProcessWorkerOptions;
  laneTickMs?: number;
  reconcileTickMs?: number;
  /**
   * F5B: the lane's decision component. Injected here rather than imported by
   * the store, so the durable substrate keeps no dependency on agents/models.
   * Omitted → deterministic single-SERIAL-task planning, as before.
   */
  laneDecider?: LaneDecider;
  /**
   * Attempt window for a chosen capability (see `config/capability-routing.ts`).
   * Code-owned: the lane picks WHO, this decides HOW LONG that specialist gets.
   */
  attemptCapFor?: (capability: string | null) => number | undefined;
  progressiveAttemptFor?: (
    capability: string | null,
  ) => ProgressiveAttemptPolicy | undefined;
  expectsArtifact?: (capability: string | null) => boolean;
  /**
   * Extra work on the reconcile tick, for projections that live OUTSIDE the V2
   * database and therefore cannot be part of any of its transactions — today the
   * F6 delegation completion bridge (`services/durable-delegation.ts`), which
   * copies a settled job back into the legacy delegation contract.
   *
   * Injected here rather than imported, for the same reason `laneDecider` is:
   * the substrate must not learn about legacy services. Failures are logged and
   * swallowed — an external projection may not stall reconciliation.
   */
  afterReconcile?: () => Promise<void>;
  /**
   * Operator stop for NEW dispatch (F6 work item 4).
   *
   * The Task Ledger has always had a kill switch meaning "background lanes are
   * paused", and until the cutover that was true — every background mechanism
   * was a legacy loop that consulted it. Moving delegation and automation onto
   * durable jobs quietly took them out of its reach: the lane orchestrator
   * dispatches from the store and had no idea an operator had said stop. A
   * safety control that stops less the more work you migrate is worse than none,
   * because it still reads as "stopped".
   *
   * Semantics match §8.4 pause: no NEW dispatch, in-flight work is left to
   * settle. Killing running attempts is `cancel`, a different and destructive
   * thing, and must stay a per-job decision.
   *
   * Injected rather than imported so the substrate keeps no dependency on the
   * Ledger. A throwing or slow check must never wedge the loop — it fails OPEN
   * (keep working), because a stuck read of the switch is not the operator
   * asking for a stop.
   */
  /**
   * Number of concurrent workers in WorkerPool. Defaults to 12.
   */
  workerConcurrency?: number;
  pauseDispatch?: () => Promise<boolean>;
}

let config: V2MountConfig = { startBackground: true };
let storePromise: Promise<V2Store> | null = null;
let backgroundStarted = false;
let backgroundRunning = false;
let laneTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let laneInFlight: Promise<void> | null = null;
let reconcileInFlight: Promise<void> | null = null;
let processWorkerShutdown: AbortController | null = null;
let workerPool: WorkerPool | null = null;

export function getWorkerPool(): WorkerPool | null {
  return workerPool;
}

export function configureV2Mount(c: V2MountConfig): void {
  const next = { ...config, ...c };
  if (next.worker && next.processWorker) {
    throw new Error('configure either worker or processWorker, not both');
  }
  if (next.processWorker && next.progressiveAttemptFor) {
    throw new Error(
      'progressive attempts require the in-process worker progress protocol; processWorker is unsupported',
    );
  }
  config = next;
}

function startBackground(s: V2Store): void {
  if (backgroundStarted) return;
  backgroundStarted = true;
  backgroundRunning = true;
  const shutdown = new AbortController();
  processWorkerShutdown = shutdown;
  const worker = config.worker ?? okWorker;

  if (!config.processWorker) {
    workerPool = new WorkerPool(s.client, s.db, worker, {
      concurrency: config.workerConcurrency,
      pauseDispatch: config.pauseDispatch,
    });
    workerPool.start();
  }

  laneTimer = setInterval(() => {
    if (!backgroundRunning || laneInFlight) return;
    laneInFlight = (async () => {
      try {
        if (config.pauseDispatch) {
          const paused = await config.pauseDispatch().catch(() => false);
          if (paused) return;
        }
        await drainLane(s.client, s.db, {
          decide: config.laneDecider,
          attemptCapFor: config.attemptCapFor,
          progressiveAttemptFor: config.progressiveAttemptFor,
          expectsArtifact: config.expectsArtifact,
        });
        if (config.processWorker) {
          await drainSupervisedProcessWorkers(
            s.client,
            s.db,
            config.processWorker,
            {
              ...config.processWorkerOptions,
              signal: config.processWorkerOptions?.signal
                ? AbortSignal.any([
                    config.processWorkerOptions.signal,
                    shutdown.signal,
                  ])
                : shutdown.signal,
            },
          );
        }
      }
      catch (err) { console.warn(`[orch-v2] lane tick: ${(err as Error).message}`); }
      finally { laneInFlight = null; }
    })();
    void laneInFlight;
  }, config.laneTickMs ?? 250);
  laneTimer.unref?.();
  reconcileTimer = setInterval(() => {
    if (!backgroundRunning || reconcileInFlight) return;
    reconcileInFlight = (async () => {
      try {
        await reconcileSupervisedProcesses(s.client, s.db);
        await reconcile(s.client, s.db);
        if (config.afterReconcile) {
          await config.afterReconcile().catch((err) => {
            console.warn(`[orch-v2] afterReconcile: ${(err as Error).message}`);
          });
        }
      } catch (err) {
        console.warn(`[orch-v2] reconcile: ${(err as Error).message}`);
      } finally {
        reconcileInFlight = null;
      }
    })();
    void reconcileInFlight;
  }, config.reconcileTickMs ?? 5_000);
  reconcileTimer.unref?.();
}

async function stopBackground(): Promise<void> {
  backgroundRunning = false;
  processWorkerShutdown?.abort('orchestration mount shutdown');
  if (laneTimer) clearInterval(laneTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  laneTimer = null;
  reconcileTimer = null;
  processWorkerShutdown = null;
  if (workerPool) {
    await workerPool.stop();
    workerPool = null;
  }
  await Promise.allSettled([
    ...(laneInFlight ? [laneInFlight] : []),
    ...(reconcileInFlight ? [reconcileInFlight] : []),
  ]);
  backgroundStarted = false;
}

async function getStore(): Promise<V2Store> {
  if (!storePromise) {
    storePromise = connectV2Store({ uri: config.uri, dbName: config.dbName }).then(async (s) => {
      await ensureOrchestrationIndexes(s.db);
      if (config.startBackground !== false) {
        // Recover committed process stops before the regular lane/reconciler
        // loops begin. Flag-off and explicitly background-free mounts retain
        // their previous behavior.
        await reconcileSupervisedProcesses(s.client, s.db);
        startBackground(s);
      }
      return s;
    });
  }
  return storePromise;
}

/**
 * The mount's own store, for IN-PROCESS consumers (agent tools) that must talk to
 * exactly the same V2 store the HTTP surface and background loops use — not a
 * second connection with its own lifecycle.
 *
 * Deliberately NOT a general accessor: it reuses the same lazy singleton, so a
 * caller cannot accidentally start a competing set of lane/worker loops.
 */
export async function getV2Store(): Promise<V2Store> {
  return getStore();
}

/**
 * Connect the store and start the background loops NOW, instead of waiting for
 * the first authenticated HTTP request.
 *
 * Why this exists: `getStore()` is reached only *after* the auth check in
 * `withApi`, so with pure lazy init a booted server does no work at all until an
 * authenticated request happens to arrive. For a durable substrate that is the
 * wrong default in two ways — a restarted server leaves already-accepted jobs
 * sitting in ACCEPTED, and any non-HTTP producer (the agent-facing durable-job
 * tools, another process, a scheduler) gets no execution whatsoever. Found by
 * live-verify Proof F, where a tool-started job never moved because nothing had
 * touched the HTTP surface.
 *
 * Failure is logged, never thrown: an unavailable Mongo must not prevent the rest
 * of the server from booting. The lazy path still works, so a later request (or
 * `getV2Store`) simply retries.
 */
export async function startV2Mount(): Promise<void> {
  try {
    await getStore();
  } catch (err) {
    // Reset so a later call can retry instead of caching the rejection forever.
    storePromise = null;
    console.warn(`[orch-v2] eager mount start failed (will retry lazily): ${(err as Error).message}`);
  }
}

/** For tests: close the lazily-created store. */
export async function __closeV2Store(): Promise<void> {
  if (storePromise) {
    const s = await storePromise;
    await stopBackground();
    await s.close();
    storePromise = null;
  }
}

// --- Hono adaptation (c: any matches the existing server handlers) ---

function honoAuth(c: any): AuthContext | null {
  const resourceId = c.req.header('x-resource-id');
  if (typeof resourceId !== 'string' || resourceId.length === 0) return null;
  const principalId = c.req.header('x-principal-id');
  return { resourceId, principalId: typeof principalId === 'string' ? principalId : resourceId };
}

function reply(c: any, r: ApiResponse): unknown {
  return c.json(r.body, r.status);
}

async function withApi(c: any, fn: (api: ReturnType<typeof createOrchestrationApi>, auth: AuthContext) => Promise<ApiResponse>): Promise<unknown> {
  const auth = honoAuth(c);
  if (!auth) return c.json({ error: 'unauthenticated' }, 401);
  try {
    const s = await getStore();
    const api = createOrchestrationApi(s.client, s.db);
    return reply(c, await fn(api, auth));
  } catch (err) {
    return c.json({ error: 'orchestration_v2_unavailable', detail: (err as Error).message }, 503);
  }
}

/** Raw route definitions (exported for isolated testing without booting Mastra). */
export const v2RouteDefs = [
  {
    path: '/v2/conversations/:cid/commands', method: 'POST' as const,
    handler: async (c: any) => withApi(c, async (api, auth) => api.startCommand(auth, c.req.param('cid'), await c.req.json().catch(() => ({})))),
  },
  {
    path: '/v2/conversations/:cid/jobs', method: 'GET' as const,
    handler: async (c: any) => withApi(c, async (api, auth) => api.listJobs(auth, c.req.param('cid'))),
  },
  {
    // C-boundary read model: ordered conversation projections, cursored by `?after=`.
    path: '/v2/conversations/:cid/projections', method: 'GET' as const,
    handler: async (c: any) => withApi(c, async (api, auth) => api.getConversation(auth, c.req.param('cid'), Number(c.req.query('after')) || 0)),
  },
  {
    path: '/v2/jobs/:jid', method: 'GET' as const,
    handler: async (c: any) => withApi(c, async (api, auth) => api.getJob(auth, c.req.param('jid'))),
  },
  {
    path: '/v2/jobs/:jid/commands', method: 'POST' as const,
    handler: async (c: any) => withApi(c, async (api, auth) => api.jobCommand(auth, c.req.param('jid'), await c.req.json().catch(() => ({})))),
  },
];

/** Build the Mastra apiRoutes for the v2 surface. Optionally (re)configure the mount. */
export function createV2ApiRoutes(cfg?: V2MountConfig): ReturnType<typeof registerApiRoute>[] {
  if (cfg) configureV2Mount(cfg);
  return v2RouteDefs.map((d) => registerApiRoute(d.path, { method: d.method, handler: d.handler }));
}
