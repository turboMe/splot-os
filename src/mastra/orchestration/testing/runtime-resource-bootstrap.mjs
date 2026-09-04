/**
 * Fixed inert bootstrap for the strict G0 gate.
 *
 * The TypeScript loader and resource guard are installed by fixed parent
 * arguments, but the suite entrypoint is not imported until the parent has
 * registered the exact detached process-group identity and handed off every
 * declared listener lease.
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const challenge = process.env.ORCHESTRATION_G0_PARENT_CHALLENGE;
const entrypoint = process.env.ORCHESTRATION_G0_SUITE_ENTRYPOINT;

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

if (
  typeof process.send !== 'function'
  || !/^[a-f0-9]{64}$/.test(challenge ?? '')
  || !entrypoint
  || !isAbsolute(entrypoint)
) {
  throw new Error('strict G0 bootstrap is missing its fixed parent context');
}

const challengeHash = sha256Text(challenge);
const mongoAllocationSymbol = Symbol.for('g0.mongo-owner-allocation/v1');
let released = false;
let mongoAllocationHash;
const releaseDeadline = setTimeout(() => {
  if (!released) {
    process.exitCode = 1;
    process.disconnect?.();
  }
}, 30_000);

process.on('message', (message) => {
  if (
    !message
    || typeof message !== 'object'
  ) {
    return;
  }
  if (message.type === 'G0_MONGO_OWNER_GRANT') {
    const messageKeys = Object.keys(message).sort();
    if (
      released
      || mongoAllocationHash !== undefined
      || messageKeys.length !== 4
      || messageKeys.join(',') !== 'allocation,allocationHash,challengeHash,type'
      || message.challengeHash !== challengeHash
      || typeof message.allocationHash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(message.allocationHash)
      || !message.allocation
      || typeof message.allocation !== 'object'
      || Array.isArray(message.allocation)
    ) {
      process.exitCode = 1;
      return;
    }
    let serialized;
    try {
      serialized = JSON.stringify(message.allocation);
    } catch {
      process.exitCode = 1;
      return;
    }
    if (
      typeof serialized !== 'string'
      || Buffer.byteLength(serialized, 'utf8') > 8 * 1024
      || sha256Text(serialized) !== message.allocationHash
      || message.allocation.parentChallengeHash !== challengeHash
    ) {
      process.exitCode = 1;
      return;
    }
    let allocation = Object.freeze(JSON.parse(serialized));
    const consumeAllocation = Object.freeze(() => {
      if (allocation === undefined) {
        throw new Error('Mongo owner allocation was already consumed');
      }
      const consumed = allocation;
      allocation = undefined;
      return consumed;
    });
    Object.defineProperty(globalThis, mongoAllocationSymbol, {
      value: consumeAllocation,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    mongoAllocationHash = message.allocationHash;
    process.send?.({
      type: 'G0_MONGO_OWNER_GRANTED',
      challengeHash,
      allocationHash: mongoAllocationHash,
    });
    return;
  }
  if (message.type !== 'G0_RELEASE_WORKLOAD') return;
  if (
    released
    || mongoAllocationHash === undefined
    || message.challengeHash !== challengeHash
    || message.entrypointHash !== sha256Text(entrypoint)
  ) {
    process.exitCode = 1;
    return;
  }
  released = true;
  clearTimeout(releaseDeadline);
  process.send?.({
    type: 'G0_WORKLOAD_RELEASED',
    challengeHash,
    entrypointHash: sha256Text(entrypoint),
  });
  // Listener leases have already been handed off before release. Keep IPC
  // available for audit messages without letting the channel itself keep an
  // otherwise-quiescent suite alive forever.
  process.channel?.unref?.();
  void import(pathToFileURL(entrypoint).href).catch(async (error) => {
    const errorClass = error instanceof Error
      && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : 'UnknownError';
    process.send?.({
      type: 'G0_WORKLOAD_IMPORT_FAILED',
      challengeHash,
      errorClass,
    });
    process.exitCode = 1;
    // Inherited leases are bound listening sockets. A workload that failed
    // before claiming them would otherwise hold the event loop open until the
    // parent's suite timeout, reporting TIMEOUT instead of the real failure.
    // Released here so the child drains and exits on its own.
    try {
      await globalThis[Symbol.for('g0.runtime-resource-child/v1')]
        ?.abandonUnclaimedLeases?.();
    } catch {
      // Already fail-closed: exitCode is set and the parent owns the outcome.
    }
  });
});

process.send({
  type: 'G0_BOOTSTRAP_READY',
  challengeHash,
  entrypointHash: sha256Text(entrypoint),
  pid: process.pid,
});
