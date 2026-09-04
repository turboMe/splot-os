import type { Server as HttpServer } from 'node:http';

const BRIDGE_SYMBOL = Symbol.for('g0.runtime-resource-child/v1');
const CONTRACT_ENV = 'ORCHESTRATION_G0_RUNTIME_RESOURCE_CONTRACT';
const inheritedPortLeaseBrand = Symbol('InheritedPortLease');
const SAFE_ROLE_RE = /^[a-z][a-z0-9-]{0,63}$/;

interface GuardPortLeaseController {
  readonly port: number;
  attachHttpServer(server: HttpServer): void;
  close(): Promise<void>;
}

interface RuntimeResourceChildBridge {
  readonly mode: 'UNCONTROLLED_DIRECT' | 'PARENT_GUARDED_V1';
  claimPortLease?(role: string): GuardPortLeaseController;
}

export interface InheritedPortLease {
  readonly port: number;
  attachHttpServer(server: HttpServer): void;
  close(): Promise<void>;
  readonly [inheritedPortLeaseBrand]: true;
}

const controllers = new WeakMap<object, GuardPortLeaseController>();

function bridgeFromPreload(): RuntimeResourceChildBridge | undefined {
  const candidate = (
    globalThis as typeof globalThis & {
      [BRIDGE_SYMBOL]?: RuntimeResourceChildBridge;
    }
  )[BRIDGE_SYMBOL];
  if (!candidate) return undefined;
  if (
    candidate.mode !== 'UNCONTROLLED_DIRECT'
    && candidate.mode !== 'PARENT_GUARDED_V1'
  ) {
    throw new Error('invalid runtime resource child bridge');
  }
  return candidate;
}

function guardedContractWasDeclared(): boolean {
  const raw = process.env[CONTRACT_ENV];
  if (raw === undefined) return false;
  try {
    const candidate = JSON.parse(raw) as { mode?: unknown };
    return candidate?.mode === 'PARENT_GUARDED_V1';
  } catch {
    // The preload owns strict parsing. If it is absent, malformed policy input
    // must not make the helper silently choose the direct-listen fallback.
    return true;
  }
}

function controllerFor(lease: object): GuardPortLeaseController {
  const controller = controllers.get(lease);
  if (!controller) throw new Error('foreign inherited port lease');
  return controller;
}

/**
 * Claim one exact parent-bound server handed over through Node IPC.
 *
 * Direct/non-gate runs receive `undefined` and may use their existing
 * ephemeral-port fallback. A guarded run is fail-closed: a missing, duplicate,
 * or foreign role throws in the preload-owned bridge.
 */
export function claimInheritedPortLease(
  role: string,
): InheritedPortLease | undefined {
  if (typeof role !== 'string' || !SAFE_ROLE_RE.test(role)) {
    throw new TypeError('inherited port lease role is invalid');
  }
  const bridge = bridgeFromPreload();
  if (!bridge) {
    if (guardedContractWasDeclared()) {
      throw new Error('parent-guarded runtime preload is missing');
    }
    return undefined;
  }
  if (bridge.mode === 'UNCONTROLLED_DIRECT') {
    if (guardedContractWasDeclared()) {
      throw new Error('parent-guarded runtime preload is inactive');
    }
    return undefined;
  }
  if (typeof bridge.claimPortLease !== 'function') {
    throw new Error('parent-guarded runtime did not install port lease authority');
  }

  const controller = bridge.claimPortLease(role);
  const lease = {
    get port() {
      return controllerFor(this).port;
    },
    attachHttpServer(server: HttpServer) {
      controllerFor(this).attachHttpServer(server);
    },
    close() {
      return controllerFor(this).close();
    },
    [inheritedPortLeaseBrand]: true as const,
  };
  controllers.set(lease, controller);
  return Object.freeze(lease);
}
