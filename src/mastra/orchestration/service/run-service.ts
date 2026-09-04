/**
 * Runnable Orchestration V2 service (plan §17.4/§4) — skeleton.
 *
 * Turns the tested substrate into an actual process: the Meta Front HTTP server
 * plus background loops that drive the lane, workers and reconciler. This is the
 * deterministic-loop version (single-flight setInterval ticks); production would
 * run the lane/worker pools as independent wake-driven processes with durable
 * timers, but the contract (drainLane / drainWorkers / reconcile) is the same.
 *
 * Requires a MongoDB replica set (transactions). Standalone-safe otherwise: it
 * lives entirely in the `orch_*` namespace and never touches production data.
 */
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  connectV2Store, ensureOrchestrationIndexes,
  drainLane, drainWorkers, reconcile, okWorker, type WorkerFixture,
} from '../store/index.js';
import { createOrchestrationHttpServer, type AuthResolver } from '../http/index.js';
import {
  drainSupervisedProcessWorkers,
  reconcileSupervisedProcesses,
  type SupervisedProcessRouter,
  type SupervisedProcessWorkerOptions,
} from '../execution/index.js';

/**
 * Structurally neutral listener handed to the service by a runtime owner.
 *
 * The lease already owns a bound listening socket. Attaching it to the HTTP
 * server avoids the release-then-bind gap of reserving a port number only.
 */
export interface ServiceListenerLease {
  readonly port: number;
  attachHttpServer(server: HttpServer): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface ServiceOptions {
  uri?: string;
  dbName?: string;
  port?: number;
  host?: string;
  listenerLease?: ServiceListenerLease;
  worker?: WorkerFixture;
  /** Opt-in serializable PROCESS_GROUP consumer for non-cooperative work. */
  processWorker?: SupervisedProcessRouter;
  processWorkerOptions?: SupervisedProcessWorkerOptions;
  resolveAuth?: AuthResolver;
  laneTickMs?: number;
  reconcileTickMs?: number;
  log?: (msg: string) => void;
}

export interface ServiceHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function startOrchestrationService(opts: ServiceOptions = {}): Promise<ServiceHandle> {
  if (opts.worker && opts.processWorker) {
    throw new Error('configure either worker or processWorker, not both');
  }
  if (opts.listenerLease && (opts.host !== undefined || opts.port !== undefined)) {
    throw new Error('configure either listenerLease or host/port, not both');
  }
  if (
    opts.listenerLease
    && (
      !Number.isInteger(opts.listenerLease.port)
      || opts.listenerLease.port < 1
      || opts.listenerLease.port > 65_535
    )
  ) {
    throw new TypeError('listenerLease.port must be a valid TCP port');
  }
  const log = opts.log ?? ((m) => console.log(`[orch-v2] ${m}`));
  const store = await connectV2Store({ uri: opts.uri, dbName: opts.dbName });
  let server: ReturnType<typeof createOrchestrationHttpServer> | undefined;
  const httpConnections = new Set<Socket>();
  let serverClosed = false;
  let listenerLeaseClosed = false;
  let storeClosed = false;
  let laneTick: ReturnType<typeof setInterval> | undefined;
  let reconcileTick: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let laneInFlight: Promise<void> | null = null;
  let reconcileInFlight: Promise<void> | null = null;
  const processWorkerShutdown = new AbortController();
  const processWorkerSignal = opts.processWorkerOptions?.signal
    ? AbortSignal.any([
        opts.processWorkerOptions.signal,
        processWorkerShutdown.signal,
      ])
    : processWorkerShutdown.signal;

  const stopStartedTicks = async (): Promise<void> => {
    running = false;
    processWorkerShutdown.abort('orchestration service shutdown');
    if (laneTick) clearInterval(laneTick);
    if (reconcileTick) clearInterval(reconcileTick);
    // Do not close Mongo underneath a tick that has already started.
    await Promise.allSettled([
      ...(laneInFlight ? [laneInFlight] : []),
      ...(reconcileInFlight ? [reconcileInFlight] : []),
    ]);
  };

  const closeServer = async (): Promise<void> => {
    if (serverClosed) {
      for (const connection of httpConnections) connection.destroy();
      return;
    }
    let closePromise: Promise<void> | undefined;
    if (server?.listening) {
      closePromise = new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    for (const connection of httpConnections) connection.destroy();
    if (closePromise) await closePromise;
    serverClosed = true;
  };

  const closeListenerLease = async (): Promise<void> => {
    if (!opts.listenerLease || listenerLeaseClosed) return;
    await opts.listenerLease.close();
    listenerLeaseClosed = true;
  };

  const closeHttpResources = async (): Promise<void> => {
    const errors: unknown[] = [];
    try {
      // A leased listener accepts outside the target HTTP server, so stop that
      // accept source before taking the tracked connections down.
      await closeListenerLease();
    } catch (error) {
      errors.push(error);
    }
    try {
      await closeServer();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'orchestration HTTP cleanup failed');
    }
  };

  const closeStore = async (): Promise<void> => {
    if (storeClosed) return;
    await store.close();
    storeClosed = true;
  };

  try {
    await ensureOrchestrationIndexes(store.db);
    // Recover durable PROCESS_GROUP ownership before ordinary store recovery can
    // reap leases or advance jobs. This is deliberately awaited: serving traffic
    // before recovering a committed stop would reopen the stop/signal crash gap.
    await reconcileSupervisedProcesses(store.client, store.db);

    server = createOrchestrationHttpServer({
      client: store.client,
      db: store.db,
      resolveAuth: opts.resolveAuth,
    });
    server.on('connection', (connection: Socket) => {
      httpConnections.add(connection);
      connection.once('close', () => {
        httpConnections.delete(connection);
      });
    });
    if (opts.listenerLease) {
      await opts.listenerLease.attachHttpServer(server);
    } else {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server!.off('error', onError);
          reject(error);
        };
        const onListening = () => {
          server!.off('error', onError);
          resolve();
        };
        server!.once('error', onError);
        if (opts.host) {
          server!.listen(opts.port ?? 0, opts.host, onListening);
        } else {
          server!.listen(opts.port ?? 0, onListening);
        }
      });
    }
    let port: number;
    if (opts.listenerLease) {
      // The lease owns the listening server and forwards accepted sockets into
      // this HTTP server. The target therefore need not report `listening` or
      // expose an address of its own.
      port = opts.listenerLease.port;
    } else {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('orchestration service did not acquire a TCP port');
      }
      port = (address as AddressInfo).port;
    }
    const worker = opts.worker ?? okWorker;
    running = true;

    // Lane + worker tick (single-flight so ticks never overlap).
    laneTick = setInterval(() => {
      if (!running || laneInFlight) return;
      laneInFlight = (async () => {
        try {
          await drainLane(store.client, store.db);
          if (opts.processWorker) {
            await drainSupervisedProcessWorkers(
              store.client,
              store.db,
              opts.processWorker,
              {
                ...opts.processWorkerOptions,
                signal: processWorkerSignal,
              },
            );
          } else {
            await drainWorkers(store.client, store.db, worker);
          }
        } catch (err) {
          log(`lane/worker tick error: ${(err as Error).message}`);
        } finally {
          laneInFlight = null;
        }
      })();
      void laneInFlight;
    }, opts.laneTickMs ?? 250);
    laneTick.unref?.();

    // Reconciler tick: recover/signal process groups before ordinary recovery.
    reconcileTick = setInterval(() => {
      if (!running || reconcileInFlight) return;
      reconcileInFlight = (async () => {
        try {
          await reconcileSupervisedProcesses(store.client, store.db);
          await reconcile(store.client, store.db);
        } catch (err) {
          log(`reconcile error: ${(err as Error).message}`);
        } finally {
          reconcileInFlight = null;
        }
      })();
      void reconcileInFlight;
    }, opts.reconcileTickMs ?? 5_000);
    reconcileTick.unref?.();

    log(`listening on :${port} (db=${opts.dbName ?? 'orchestration_v2'})`);
    let stopCompleted = false;
    let stopInFlight: Promise<void> | undefined;
    const stop = async (): Promise<void> => {
      if (stopCompleted) return;
      if (!stopInFlight) {
        stopInFlight = (async () => {
          const errors: unknown[] = [];
          await stopStartedTicks();
          try {
            await closeHttpResources();
          } catch (error) {
            errors.push(error);
          }
          try {
            await closeStore();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, 'orchestration service cleanup failed');
          }
          stopCompleted = true;
          log('stopped');
        })();
      }
      const attempt = stopInFlight;
      try {
        await attempt;
      } finally {
        if (stopInFlight === attempt) stopInFlight = undefined;
      }
    };

    return { port, stop };
  } catch (setupError) {
    const errors: unknown[] = [setupError];
    await stopStartedTicks();
    try {
      await closeHttpResources();
    } catch (error) {
      errors.push(error);
    }
    try {
      await closeStore();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw setupError;
    throw new AggregateError(errors, 'orchestration service setup and cleanup failed');
  }
}
