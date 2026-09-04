/**
 * Parent-guarded G0 child preload.
 *
 * This is a Node-level guard and audit boundary, not an OS network sandbox.
 * The strict parent retains destructive resource authority. The child receives
 * only a public resource declaration plus inherited, already-bound loopback
 * servers. Every denied Node API attempt is audited before it throws.
 */
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const workerThreads = require('node:worker_threads');

const CONTRACT_ENV = 'ORCHESTRATION_G0_RUNTIME_RESOURCE_CONTRACT';
const CHALLENGE_ENV = 'ORCHESTRATION_G0_PARENT_CHALLENGE';
const WORKSPACE_ENV = 'ORCHESTRATION_G0_WORKSPACE_ROOT';
const SOURCE_ROOT_ENV = 'ORCHESTRATION_G0_SOURCE_ROOT';
const PROCESS_EXECUTION_ID_ENV = 'ORCH_PROCESS_EXECUTION_ID';
const RUNTIME_RUN_ID_ENV = 'ORCH_RUNTIME_RUN_ID';
const CONTRACT_VERSION = 'g0-runtime-resource-contract/v1';
const AUDIT_VERSION = 'g0-runtime-resource-audit/v1';
const AUDIT_MESSAGE_TYPE = 'G0_RUNTIME_RESOURCE_AUDIT';
const PORT_LEASE_MESSAGE_TYPE = 'G0_PORT_LEASE';
const BRIDGE_SYMBOL = Symbol.for('g0.runtime-resource-child/v1');
const MAX_CONTRACT_BYTES = 16 * 1024;
const MAX_AUDIT_EVENTS = 2_048;
const MAX_PENDING_LEASE_CONNECTIONS = 16;
const PORT_LEASE_HANDOFF_TIMEOUT_MS = 5_000;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const CHALLENGE_RE = /^[a-f0-9]{64}$/;
const SAFE_ROLE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_LEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DENIED_BINDINGS = new Set([
  'spawn_sync',
  'process_wrap',
  'tcp_wrap',
  'udp_wrap',
  'cares_wrap',
  'pipe_wrap',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} contains missing or unknown fields`);
  }
}

function assertLiteral(value, expected, label) {
  if (value !== expected) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 identifier`);
  }
  return value;
}

function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${label} must be a valid TCP port`);
  }
  return value;
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function parsePortLeaseDeclaration(input, index) {
  const value = assertPlainObject(input, `portLeases[${index}]`);
  assertExactKeys(
    value,
    ['role', 'leaseIdHash', 'port'],
    `portLeases[${index}]`,
  );
  if (typeof value.role !== 'string' || !SAFE_ROLE_RE.test(value.role)) {
    throw new TypeError(`portLeases[${index}].role is invalid`);
  }
  return {
    role: value.role,
    leaseIdHash: assertSha256(
      value.leaseIdHash,
      `portLeases[${index}].leaseIdHash`,
    ),
    port: assertPort(value.port, `portLeases[${index}].port`),
  };
}

function parseOutbound(input) {
  const value = assertPlainObject(input, 'outbound');
  assertExactKeys(
    value,
    [
      'mode',
      'allowedLoopbackPorts',
      'osDefaultDenyProven',
      'externalRequestAbsenceProven',
    ],
    'outbound',
  );
  assertLiteral(value.mode, 'NODE_EGRESS_GUARD_V1', 'outbound.mode');
  assertLiteral(
    value.osDefaultDenyProven,
    false,
    'outbound.osDefaultDenyProven',
  );
  assertLiteral(
    value.externalRequestAbsenceProven,
    false,
    'outbound.externalRequestAbsenceProven',
  );
  if (
    !Array.isArray(value.allowedLoopbackPorts)
    || value.allowedLoopbackPorts.length < 1
    || value.allowedLoopbackPorts.length > 16
  ) {
    throw new TypeError('outbound.allowedLoopbackPorts has an invalid length');
  }
  const allowedLoopbackPorts = value.allowedLoopbackPorts.map(
    (port, index) => assertPort(
      port,
      `outbound.allowedLoopbackPorts[${index}]`,
    ),
  );
  const sorted = [...allowedLoopbackPorts].sort((left, right) => left - right);
  if (
    new Set(allowedLoopbackPorts).size !== allowedLoopbackPorts.length
    || allowedLoopbackPorts.some((port, index) => port !== sorted[index])
  ) {
    throw new TypeError(
      'outbound.allowedLoopbackPorts must be unique and sorted',
    );
  }
  return {
    mode: 'NODE_EGRESS_GUARD_V1',
    allowedLoopbackPorts,
    osDefaultDenyProven: false,
    externalRequestAbsenceProven: false,
  };
}

function parseGuardedContract(input) {
  const value = assertPlainObject(input, 'runtime resource contract');
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'mode',
      'workspaceOwnershipMode',
      'portOwnershipMode',
      'processOwnershipMode',
      'nodePermissionMode',
      'workspaceRootHash',
      'processExecutionIdHash',
      'runtimeRunIdHash',
      'portLeases',
      'outbound',
    ],
    'runtime resource contract',
  );
  assertLiteral(value.schemaVersion, CONTRACT_VERSION, 'schemaVersion');
  assertLiteral(value.mode, 'PARENT_GUARDED_V1', 'mode');
  assertLiteral(
    value.workspaceOwnershipMode,
    'PARENT_PRIVATE_DIRECTORY_V1',
    'workspaceOwnershipMode',
  );
  assertLiteral(
    value.portOwnershipMode,
    'PARENT_BOUND_IPC_HANDOFF_V1',
    'portOwnershipMode',
  );
  assertLiteral(
    value.processOwnershipMode,
    'LINUX_PROCESS_GROUP_TRUSTED_V1',
    'processOwnershipMode',
  );
  assertLiteral(
    value.nodePermissionMode,
    'NODE_PERMISSION_NO_CHILD_PROCESS_V1',
    'nodePermissionMode',
  );
  if (!Array.isArray(value.portLeases) || value.portLeases.length > 8) {
    throw new TypeError('portLeases has an invalid length');
  }
  const portLeases = value.portLeases.map(parsePortLeaseDeclaration);
  const roles = portLeases.map((lease) => lease.role);
  const sortedRoles = [...roles].sort();
  if (
    new Set(roles).size !== roles.length
    || roles.some((role, index) => role !== sortedRoles[index])
  ) {
    throw new TypeError('port lease roles must be unique and sorted');
  }
  const outbound = parseOutbound(value.outbound);
  for (const lease of portLeases) {
    if (!outbound.allowedLoopbackPorts.includes(lease.port)) {
      throw new TypeError(
        `port lease ${lease.role} is absent from the exact allowlist`,
      );
    }
  }
  return {
    schemaVersion: CONTRACT_VERSION,
    mode: 'PARENT_GUARDED_V1',
    workspaceOwnershipMode: 'PARENT_PRIVATE_DIRECTORY_V1',
    portOwnershipMode: 'PARENT_BOUND_IPC_HANDOFF_V1',
    processOwnershipMode: 'LINUX_PROCESS_GROUP_TRUSTED_V1',
    nodePermissionMode: 'NODE_PERMISSION_NO_CHILD_PROCESS_V1',
    workspaceRootHash: assertSha256(
      value.workspaceRootHash,
      'workspaceRootHash',
    ),
    processExecutionIdHash: assertSha256(
      value.processExecutionIdHash,
      'processExecutionIdHash',
    ),
    runtimeRunIdHash: assertSha256(
      value.runtimeRunIdHash,
      'runtimeRunIdHash',
    ),
    portLeases,
    outbound,
  };
}

function parseContract(raw) {
  if (raw === undefined) {
    return {
      schemaVersion: CONTRACT_VERSION,
      mode: 'UNCONTROLLED_DIRECT',
    };
  }
  if (
    typeof raw !== 'string'
    || Buffer.byteLength(raw, 'utf8') > MAX_CONTRACT_BYTES
  ) {
    throw new TypeError('runtime resource contract exceeds the fixed limit');
  }
  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new TypeError('runtime resource contract is not valid JSON');
  }
  const value = assertPlainObject(candidate, 'runtime resource contract');
  if (value.mode === 'UNCONTROLLED_DIRECT') {
    assertExactKeys(value, ['schemaVersion', 'mode'], 'runtime resource contract');
    assertLiteral(value.schemaVersion, CONTRACT_VERSION, 'schemaVersion');
    return {
      schemaVersion: CONTRACT_VERSION,
      mode: 'UNCONTROLLED_DIRECT',
    };
  }
  return parseGuardedContract(value);
}

function hashContract(contract) {
  // This exactly mirrors hashRuntimeResourceContract(): the strict schema emits
  // fields in declaration order and requires its two variable arrays sorted.
  return sha256Text(JSON.stringify(contract));
}

function exactRealDirectory(raw, label) {
  if (
    typeof raw !== 'string'
    || raw.length === 0
    || raw.length > 4_096
    || !path.isAbsolute(raw)
    || /[\u0000-\u001f]/.test(raw)
  ) {
    throw new TypeError(`${label} is not an exact absolute directory`);
  }
  const resolved = fs.realpathSync.native(raw);
  if (resolved !== raw || !fs.statSync(resolved).isDirectory()) {
    throw new TypeError(`${label} must be its canonical existing directory`);
  }
  return resolved;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (
      !relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative)
    );
}

function validateRawIdentifier(raw, expectedHash, label) {
  if (
    typeof raw !== 'string'
    || raw.length < 8
    || raw.length > 256
    || /[\u0000-\u0020]/.test(raw)
    || sha256Text(raw) !== expectedHash
  ) {
    throw new TypeError(`${label} does not match the parent resource contract`);
  }
}

function validateWorkspaceAndPermissionBinding(guardedContract) {
  validateRawIdentifier(
    process.env[PROCESS_EXECUTION_ID_ENV],
    guardedContract.processExecutionIdHash,
    PROCESS_EXECUTION_ID_ENV,
  );
  validateRawIdentifier(
    process.env[RUNTIME_RUN_ID_ENV],
    guardedContract.runtimeRunIdHash,
    RUNTIME_RUN_ID_ENV,
  );

  const workspaceRoot = exactRealDirectory(
    process.env[WORKSPACE_ENV],
    WORKSPACE_ENV,
  );
  if (workspaceRoot === path.parse(workspaceRoot).root) {
    throw new TypeError('runtime workspace root cannot be a filesystem root');
  }
  if (sha256Text(workspaceRoot) !== guardedContract.workspaceRootHash) {
    throw new TypeError('runtime workspace root does not match the parent contract');
  }
  const sourceRoot = exactRealDirectory(
    process.env[SOURCE_ROOT_ENV],
    SOURCE_ROOT_ENV,
  );
  if (
    pathIsWithin(workspaceRoot, sourceRoot)
    || pathIsWithin(sourceRoot, workspaceRoot)
  ) {
    throw new TypeError('source root and writable workspace must be disjoint');
  }

  const cwd = fs.realpathSync.native(process.cwd());
  if (!pathIsWithin(workspaceRoot, cwd)) {
    throw new TypeError('child cwd is outside the exact runtime workspace');
  }

  const requiredWorkspacePaths = [
    'HOME',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
  ];
  const optionalWorkspacePaths = ['TMP', 'TEMP'];
  for (const name of requiredWorkspacePaths) {
    const candidate = exactRealDirectory(process.env[name], name);
    if (!pathIsWithin(workspaceRoot, candidate)) {
      throw new TypeError(`${name} is outside the exact runtime workspace`);
    }
  }
  for (const name of optionalWorkspacePaths) {
    if (process.env[name] === undefined) continue;
    const candidate = exactRealDirectory(process.env[name], name);
    if (!pathIsWithin(workspaceRoot, candidate)) {
      throw new TypeError(`${name} is outside the exact runtime workspace`);
    }
  }
  if (process.env.PWD !== undefined) {
    const pwd = exactRealDirectory(process.env.PWD, 'PWD');
    if (pwd !== cwd || !pathIsWithin(workspaceRoot, pwd)) {
      throw new TypeError('PWD is not the exact child cwd');
    }
  }

  if (
    !process.permission
    || typeof process.permission.has !== 'function'
    || process.permission.has('child') !== false
    || process.permission.has('worker') !== true
    || process.permission.has('fs.write', workspaceRoot) !== true
    || process.permission.has('fs.write', sourceRoot) !== false
  ) {
    throw new Error('Node permission state does not match the guarded contract');
  }
  const workspaceParent = path.dirname(workspaceRoot);
  if (
    workspaceParent !== workspaceRoot
    && process.permission.has('fs.write', workspaceParent) !== false
  ) {
    throw new Error('Node fs.write authority is broader than the exact workspace');
  }
  return { workspaceRoot, sourceRoot };
}

function installBridge(value) {
  if (Object.prototype.hasOwnProperty.call(globalThis, BRIDGE_SYMBOL)) {
    throw new Error('runtime resource child bridge was already installed');
  }
  Object.defineProperty(globalThis, BRIDGE_SYMBOL, {
    value: Object.freeze(value),
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

const contract = parseContract(process.env[CONTRACT_ENV]);

if (contract.mode !== 'PARENT_GUARDED_V1') {
  installBridge({ mode: 'UNCONTROLLED_DIRECT' });
} else {
  const challenge = process.env[CHALLENGE_ENV];
  if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) {
    throw new TypeError('parent runtime resource challenge is missing or invalid');
  }
  if (!process.connected || typeof process.send !== 'function') {
    throw new Error('parent-guarded runtime requires a connected IPC channel');
  }

  validateWorkspaceAndPermissionBinding(contract);
  const policyHash = hashContract(contract);
  const challengeHash = sha256Text(challenge);
  const allowedPorts = new Set(contract.outbound.allowedLoopbackPorts);
  const expectedLeases = new Map(
    contract.portLeases.map((lease) => [lease.role, lease]),
  );
  const receivedLeases = new Map();
  let resolveLeaseHandoff;
  const leaseHandoff = new Promise((resolve) => {
    resolveLeaseHandoff = resolve;
  });
  let auditSequence = 0;
  let allowedCount = 0;
  let deniedCount = 0;
  let auditOverflow = false;
  let finalEmitted = false;

  class RuntimeResourceDeniedError extends Error {
    constructor(operation, reason = 'runtime resource policy denied the operation') {
      super(`${reason}: ${operation}`);
      this.name = 'RuntimeResourceDeniedError';
      this.code = 'ERR_G0_RUNTIME_RESOURCE_DENIED';
    }
  }

  function sendAudit(eventType, decision, operation, details = {}) {
    if (finalEmitted && eventType !== 'FINAL') return false;
    const finalEvent = eventType === 'FINAL';
    const normalLimit = MAX_AUDIT_EVENTS - 1;
    if (!finalEvent && auditSequence >= normalLimit) {
      auditOverflow = true;
      return false;
    }
    if (finalEvent && auditSequence >= MAX_AUDIT_EVENTS) {
      auditOverflow = true;
      return false;
    }
    const event = {
      schemaVersion: AUDIT_VERSION,
      sequence: ++auditSequence,
      eventType,
      decision,
      operation,
      policyHash,
      challengeHash,
      details,
    };
    try {
      process.send({ type: AUDIT_MESSAGE_TYPE, event });
      return true;
    } catch {
      auditOverflow = true;
      return false;
    }
  }

  function auditAllowed(operation, details) {
    if (auditOverflow) {
      deniedCount++;
      throw new RuntimeResourceDeniedError(
        operation,
        'runtime resource audit capacity was exhausted',
      );
    }
    allowedCount++;
    if (!sendAudit('ACCESS_ALLOWED', 'ALLOW', operation, details)) {
      auditOverflow = true;
      deniedCount++;
      throw new RuntimeResourceDeniedError(
        operation,
        'runtime resource audit capacity was exhausted',
      );
    }
  }

  function deny(operation, reason, details = {}) {
    deniedCount++;
    if (!auditOverflow) {
      const emitted = sendAudit(
        'ACCESS_DENIED',
        'DENY',
        operation,
        { reason, ...details },
      );
      if (!emitted) auditOverflow = true;
    }
    throw new RuntimeResourceDeniedError(operation);
  }

  function normalizeHost(input) {
    if (typeof input !== 'string') return '';
    let host = input.trim().toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    if (host.endsWith('.')) host = host.slice(0, -1);
    return host;
  }

  function isLoopbackHost(input) {
    const host = normalizeHost(input);
    if (host === 'localhost') return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    if (/^127(?:\.[0-9]{1,3}){3}$/.test(host)) {
      return host.split('.').slice(1).every((part) => Number(part) <= 255);
    }
    if (
      /^::ffff:127(?:\.[0-9]{1,3}){3}$/.test(host)
      || /^0:0:0:0:0:ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
    ) {
      return true;
    }
    return false;
  }

  function assertAllowedDestination(operation, hostInput, portInput) {
    const host = normalizeHost(hostInput || 'localhost');
    const port = Number(portInput);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return deny(operation, 'INVALID_PORT');
    }
    if (!isLoopbackHost(host)) {
      return deny(operation, 'NON_LOOPBACK_DESTINATION', {
        hostKind: 'EXTERNAL_OR_UNRESOLVED',
        port,
      });
    }
    if (!allowedPorts.has(port)) {
      return deny(operation, 'PORT_NOT_ALLOWLISTED', {
        hostKind: 'LOOPBACK',
        port,
      });
    }
    auditAllowed(operation, { hostKind: 'LOOPBACK', port });
    return { host, port };
  }

  /**
   * `net.connect()` / `net.createConnection()` normalize their arguments to
   * `[options, callback]` and call `Socket.prototype.connect` with that single
   * array, so every library using those entry points (the Mongo driver among
   * them) arrives here in array form. Unwrap it and apply the exact same
   * checks to the inner options; the wrapper itself is never a destination.
   */
  function unwrapNetConnectArgs(args) {
    return Array.isArray(args[0]) && args[0].length >= 1 ? args[0][0] : args[0];
  }

  function netDestination(args) {
    const first = unwrapNetConnectArgs(args);
    if (isPlainObject(first)) {
      if (
        first.path !== undefined
        || first.fd !== undefined
        || first.handle !== undefined
        || typeof first.lookup === 'function'
      ) {
        return null;
      }
      return {
        host: first.host ?? first.hostname ?? 'localhost',
        port: first.port,
      };
    }
    if (typeof first === 'number' || /^[0-9]+$/.test(String(first))) {
      return {
        host: typeof args[1] === 'string' ? args[1] : 'localhost',
        port: first,
      };
    }
    return null;
  }

  function pinLoopbackOptions(options) {
    return {
      ...options,
      host: '127.0.0.1',
      ...(options.hostname === undefined ? {} : { hostname: '127.0.0.1' }),
    };
  }

  function hardenedNetConnectArgs(args, destination) {
    if (normalizeHost(destination.host) !== 'localhost') return args;
    // Normalized `[options, callback]` form. Node identifies this array by an
    // internal `normalizedArgs` symbol and re-normalizes anything without it,
    // so the array object itself must survive: replace the options entry in
    // place instead of building a new array. It is freshly created by
    // `normalizeArgs` for this single call, so mutating it is contained.
    if (Array.isArray(args[0]) && args[0].length >= 1) {
      const normalized = args[0];
      if (!isPlainObject(normalized[0])) return args;
      normalized[0] = pinLoopbackOptions(normalized[0]);
      return args;
    }
    if (isPlainObject(args[0])) {
      return [pinLoopbackOptions(args[0]), ...args.slice(1)];
    }
    const output = [...args];
    if (typeof output[1] === 'string') output[1] = '127.0.0.1';
    else output.splice(1, 0, '127.0.0.1');
    return output;
  }

  function urlDestination(input, defaultProtocol) {
    let candidate = input;
    if (
      candidate
      && typeof candidate === 'object'
      && typeof candidate.url === 'string'
    ) {
      candidate = candidate.url;
    }
    if (candidate instanceof URL) {
      const protocol = candidate.protocol;
      const port = candidate.port || (
        protocol === 'https:' || protocol === 'wss:' ? '443' : '80'
      );
      return { protocol, host: candidate.hostname, port };
    }
    if (typeof candidate === 'string') {
      try {
        return urlDestination(new URL(candidate), defaultProtocol);
      } catch {
        return null;
      }
    }
    if (isPlainObject(candidate)) {
      if (
        candidate.socketPath !== undefined
        || candidate.path instanceof URL
        || typeof candidate.createConnection === 'function'
      ) {
        return null;
      }
      const protocol = candidate.protocol ?? defaultProtocol;
      const hostValue = candidate.hostname ?? candidate.host ?? 'localhost';
      let host = hostValue;
      let embeddedPort;
      if (typeof hostValue === 'string') {
        try {
          const parsed = new URL(`${protocol}//${hostValue}`);
          host = parsed.hostname;
          embeddedPort = parsed.port || undefined;
        } catch {
          return null;
        }
      }
      const port = candidate.port
        ?? embeddedPort
        ?? (protocol === 'https:' || protocol === 'wss:' ? 443 : 80);
      return { protocol, host, port };
    }
    return null;
  }

  function assertUrlAllowed(operation, input, defaultProtocol, allowedProtocols) {
    const destination = urlDestination(input, defaultProtocol);
    if (
      !destination
      || !allowedProtocols.includes(destination.protocol)
    ) {
      return deny(operation, 'INVALID_OR_UNSUPPORTED_DESTINATION');
    }
    return assertAllowedDestination(
      operation,
      destination.host,
      destination.port,
    );
  }

  function rejectHttpOverrides(operation, args) {
    const first = args[0];
    const overrides = (
      first instanceof URL
      || typeof first === 'string'
    ) ? args[1] : first;
    if (!isPlainObject(overrides)) return;
    if (
      overrides.socketPath !== undefined
      || typeof overrides.createConnection === 'function'
      || typeof overrides.lookup === 'function'
      || (
        overrides.agent !== undefined
        && overrides.agent !== false
      )
    ) {
      deny(operation, 'CUSTOM_CONNECTION_OVERRIDE_IS_NOT_ALLOWED');
    }
  }

  function patchFunction(target, name, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (!descriptor) {
      if (typeof target[name] !== 'function' || !Object.isExtensible(target)) {
        throw new Error(`cannot install runtime resource guard for ${name}`);
      }
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: replacement,
      });
      return;
    }
    if (descriptor.writable !== true) {
      throw new Error(`cannot install runtime resource guard for ${name}`);
    }
    Object.defineProperty(target, name, {
      ...descriptor,
      value: replacement,
    });
  }

  const originalSocketConnect = net.Socket.prototype.connect;
  patchFunction(net.Socket.prototype, 'connect', function guardedSocketConnect(...args) {
    const destination = netDestination(args);
    if (!destination) {
      return deny('net.Socket.connect', 'NON_TCP_OR_UNRESOLVED_DESTINATION');
    }
    assertAllowedDestination(
      'net.Socket.connect',
      destination.host,
      destination.port,
    );
    return Reflect.apply(
      originalSocketConnect,
      this,
      hardenedNetConnectArgs(args, destination),
    );
  });

  const originalServerListen = net.Server.prototype.listen;
  patchFunction(net.Server.prototype, 'listen', function guardedServerListen(...args) {
    const inheritedHandle = args[0];
    // Node's IPC net.Server conversion calls server.listen(nativeTCPHandle)
    // before emitting the message's second argument. User code cannot mint a
    // native TCP handle because tcp_wrap/process bindings are denied below.
    if (
      inheritedHandle
      && typeof inheritedHandle === 'object'
      && !isPlainObject(inheritedHandle)
      && typeof inheritedHandle.listen === 'function'
      && typeof inheritedHandle.close === 'function'
      && typeof inheritedHandle.getsockname === 'function'
    ) {
      return Reflect.apply(originalServerListen, this, args);
    }
    return deny(
      'net.Server.listen',
      'DIRECT_LISTEN_BYPASSES_PARENT_PORT_LEASE',
    );
  });

  function patchHttpModule(module, label, defaultProtocol) {
    const originalRequest = module.request;
    const originalGet = module.get;
    patchFunction(module, 'request', function guardedRequest(...args) {
      rejectHttpOverrides(`${label}.request`, args);
      assertUrlAllowed(
        `${label}.request`,
        args[0],
        defaultProtocol,
        [defaultProtocol],
      );
      return Reflect.apply(originalRequest, this, args);
    });
    patchFunction(module, 'get', function guardedGet(...args) {
      rejectHttpOverrides(`${label}.get`, args);
      assertUrlAllowed(
        `${label}.get`,
        args[0],
        defaultProtocol,
        [defaultProtocol],
      );
      return Reflect.apply(originalGet, this, args);
    });
  }

  patchHttpModule(http, 'http', 'http:');
  patchHttpModule(https, 'https', 'https:');

  const originalTlsConnect = tls.connect;
  patchFunction(tls, 'connect', function guardedTlsConnect(...args) {
    const destination = netDestination(args);
    if (!destination) {
      return deny('tls.connect', 'NON_TCP_OR_UNRESOLVED_DESTINATION');
    }
    assertAllowedDestination(
      'tls.connect',
      destination.host,
      destination.port,
    );
    return Reflect.apply(
      originalTlsConnect,
      this,
      hardenedNetConnectArgs(args, destination),
    );
  });

  const originalHttp2Connect = http2.connect;
  patchFunction(http2, 'connect', function guardedHttp2Connect(...args) {
    assertUrlAllowed(
      'http2.connect',
      args[0],
      'https:',
      ['http:', 'https:'],
    );
    return Reflect.apply(originalHttp2Connect, this, args);
  });

  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function guardedFetch(input, init) {
        if (
          isPlainObject(init)
          && (
            init.dispatcher !== undefined
            || (
              init.redirect !== undefined
              && init.redirect !== 'manual'
            )
          )
        ) {
          return deny(
            'fetch',
            'CUSTOM_DISPATCHER_OR_REDIRECT_FOLLOW_IS_NOT_ALLOWED',
          );
        }
        assertUrlAllowed(
          'fetch',
          input,
          'http:',
          ['http:', 'https:'],
        );
        return Reflect.apply(originalFetch, this, [
          input,
          { ...(init ?? {}), redirect: 'manual' },
        ]);
      },
    });
  }

  if (typeof globalThis.WebSocket === 'function') {
    const OriginalWebSocket = globalThis.WebSocket;
    const GuardedWebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args, newTarget) {
        assertUrlAllowed(
          'WebSocket',
          args[0],
          'ws:',
          ['ws:', 'wss:'],
        );
        return Reflect.construct(target, args, newTarget);
      },
      apply(target, thisArg, args) {
        assertUrlAllowed(
          'WebSocket',
          args[0],
          'ws:',
          ['ws:', 'wss:'],
        );
        return Reflect.apply(target, thisArg, args);
      },
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: GuardedWebSocket,
    });
  }

  const originalDnsLookup = dns.lookup;
  patchFunction(dns, 'lookup', function guardedDnsLookup(hostname, ...args) {
    if (!isLoopbackHost(hostname)) {
      return deny('dns.lookup', 'NON_LOOPBACK_DNS_LOOKUP');
    }
    auditAllowed('dns.lookup', { hostKind: 'LOOPBACK' });
    return Reflect.apply(originalDnsLookup, this, [hostname, ...args]);
  });

  const deniedDnsFunctions = [
    'lookupService',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
    'setServers',
  ];
  for (const name of deniedDnsFunctions) {
    if (typeof dns[name] !== 'function') continue;
    patchFunction(dns, name, function guardedDnsFunction() {
      return deny(`dns.${name}`, 'DNS_EGRESS_IS_NOT_ALLOWED');
    });
  }

  if (dns.promises && typeof dns.promises === 'object') {
    const originalPromisesLookup = dns.promises.lookup;
    if (typeof originalPromisesLookup === 'function') {
      patchFunction(
        dns.promises,
        'lookup',
        function guardedPromisesLookup(hostname, ...args) {
          if (!isLoopbackHost(hostname)) {
            return deny('dns.promises.lookup', 'NON_LOOPBACK_DNS_LOOKUP');
          }
          auditAllowed('dns.promises.lookup', { hostKind: 'LOOPBACK' });
          return Reflect.apply(originalPromisesLookup, this, [hostname, ...args]);
        },
      );
    }
    for (const name of deniedDnsFunctions) {
      if (typeof dns.promises[name] !== 'function') continue;
      patchFunction(dns.promises, name, function guardedPromisesDnsFunction() {
        return deny(`dns.promises.${name}`, 'DNS_EGRESS_IS_NOT_ALLOWED');
      });
    }
  }

  if (dns.Resolver?.prototype) {
    for (const name of deniedDnsFunctions.filter((entry) => entry !== 'lookupService')) {
      if (typeof dns.Resolver.prototype[name] !== 'function') continue;
      patchFunction(
        dns.Resolver.prototype,
        name,
        function guardedResolverFunction() {
          return deny(`dns.Resolver.${name}`, 'DNS_EGRESS_IS_NOT_ALLOWED');
        },
      );
    }
  }

  const deniedDgramMethods = ['bind', 'connect', 'send'];
  for (const name of deniedDgramMethods) {
    if (typeof dgram.Socket?.prototype?.[name] !== 'function') continue;
    patchFunction(dgram.Socket.prototype, name, function guardedDgramMethod() {
      return deny(`dgram.Socket.${name}`, 'UDP_IS_NOT_ALLOWED');
    });
  }

  const deniedChildProcessFunctions = [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ];
  for (const name of deniedChildProcessFunctions) {
    if (typeof childProcess[name] !== 'function') continue;
    patchFunction(childProcess, name, function guardedChildProcessFunction() {
      return deny(`child_process.${name}`, 'CHILD_PROCESS_IS_NOT_ALLOWED');
    });
  }
  if (typeof childProcess.ChildProcess?.prototype?.spawn === 'function') {
    patchFunction(
      childProcess.ChildProcess.prototype,
      'spawn',
      function guardedChildProcessSpawn() {
        return deny(
          'child_process.ChildProcess.spawn',
          'CHILD_PROCESS_IS_NOT_ALLOWED',
        );
      },
    );
  }

  if (typeof workerThreads.Worker === 'function') {
    const OriginalWorker = workerThreads.Worker;
    const GuardedWorker = new Proxy(OriginalWorker, {
      construct() {
        return deny('worker_threads.Worker', 'USER_WORKER_IS_NOT_ALLOWED');
      },
      apply() {
        return deny('worker_threads.Worker', 'USER_WORKER_IS_NOT_ALLOWED');
      },
    });
    patchFunction(workerThreads, 'Worker', GuardedWorker);
  }

  if (typeof process.dlopen === 'function') {
    const originalDlopen = process.dlopen;
    Object.defineProperty(process, 'dlopen', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function guardedDlopen() {
        return deny('process.dlopen', 'NATIVE_ADDON_LOADING_IS_NOT_ALLOWED');
      },
    });
    void originalDlopen;
  }

  if (typeof process.binding === 'function') {
    const originalBinding = process.binding.bind(process);
    Object.defineProperty(process, 'binding', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function guardedBinding(name) {
        if (typeof name === 'string' && DENIED_BINDINGS.has(name)) {
          return deny(
            'process.binding',
            'RESTRICTED_NATIVE_BINDING',
            { bindingClass: name },
          );
        }
        return originalBinding(name);
      },
    });
  }

  syncBuiltinESMExports();

  function portEventDetails(record) {
    return {
      role: record.declaration.role,
      leaseIdHash: record.declaration.leaseIdHash,
      port: record.declaration.port,
    };
  }

  function closeUnexpectedHandle(handle) {
    if (!handle || typeof handle.close !== 'function') return;
    try {
      handle.close();
    } catch {
      // The invalid handle is already unusable; policy failure remains primary.
    }
  }

  function validatePortLeaseMessage(message, handle) {
    const value = assertPlainObject(message, 'G0_PORT_LEASE message');
    assertExactKeys(
      value,
      ['type', 'role', 'leaseId', 'port'],
      'G0_PORT_LEASE message',
    );
    assertLiteral(value.type, PORT_LEASE_MESSAGE_TYPE, 'G0_PORT_LEASE.type');
    if (typeof value.role !== 'string' || !SAFE_ROLE_RE.test(value.role)) {
      throw new TypeError('G0_PORT_LEASE.role is invalid');
    }
    if (
      typeof value.leaseId !== 'string'
      || !SAFE_LEASE_ID_RE.test(value.leaseId)
    ) {
      throw new TypeError('G0_PORT_LEASE.leaseId is invalid');
    }
    const port = assertPort(value.port, 'G0_PORT_LEASE.port');
    const declaration = expectedLeases.get(value.role);
    if (
      !declaration
      || declaration.port !== port
      || declaration.leaseIdHash !== sha256Text(value.leaseId)
    ) {
      throw new TypeError('G0_PORT_LEASE does not match the parent contract');
    }
    if (!(handle instanceof net.Server)) {
      throw new TypeError('G0_PORT_LEASE requires an inherited net.Server');
    }
    const address = handle.address();
    if (
      !address
      || typeof address === 'string'
      || address.port !== port
      || !isLoopbackHost(address.address)
    ) {
      throw new TypeError('G0_PORT_LEASE server is not the exact loopback lease');
    }
    return { declaration, leaseId: value.leaseId, server: handle };
  }

  function receivePortLease(message, handle) {
    let candidate;
    try {
      candidate = validatePortLeaseMessage(message, handle);
      if (receivedLeases.has(candidate.declaration.role)) {
        throw new TypeError('duplicate G0_PORT_LEASE role');
      }
    } catch {
      closeUnexpectedHandle(handle);
      return deny('G0_PORT_LEASE.receive', 'INVALID_PORT_LEASE_HANDOFF');
    }
    const pendingSockets = [];
    const record = {
      declaration: candidate.declaration,
      leaseId: candidate.leaseId,
      server: candidate.server,
      claimed: false,
      adopted: false,
      released: false,
      attachedServer: null,
      forwardingListener: null,
      closePromise: null,
      pendingSockets,
      pendingListener: null,
    };
    record.pendingListener = (socket) => {
      if (record.adopted && record.attachedServer) {
        record.attachedServer.emit('connection', socket);
        return;
      }
      if (pendingSockets.length >= MAX_PENDING_LEASE_CONNECTIONS) {
        socket.destroy();
        try {
          deny(
            'G0_PORT_LEASE.pendingConnection',
            'PORT_LEASE_ADOPTION_BACKLOG_EXCEEDED',
          );
        } catch {
          process.exitCode = 1;
        }
        return;
      }
      socket.pause();
      pendingSockets.push(socket);
    };
    record.server.on('connection', record.pendingListener);
    // A lease only has to keep the process alive once the workload has adopted
    // it. Until then it stays unref'd, so a suite that exits or fails before
    // claiming its lease can still drain and exit instead of sitting on a
    // listening socket until the parent's suite timeout.
    record.server.unref?.();
    receivedLeases.set(record.declaration.role, record);
    sendAudit(
      'PORT_LEASE_RECEIVED',
      'ALLOW',
      'G0_PORT_LEASE.receive',
      portEventDetails(record),
    );
    if (receivedLeases.size === expectedLeases.size) {
      resolveLeaseHandoff();
    }
  }

  process.prependListener('message', (message, handle) => {
    if (!message || message.type !== PORT_LEASE_MESSAGE_TYPE) return;
    receivePortLease(message, handle);
  });

  function claimPortLease(role) {
    if (typeof role !== 'string' || !SAFE_ROLE_RE.test(role)) {
      return deny('G0_PORT_LEASE.claim', 'INVALID_PORT_LEASE_ROLE');
    }
    const record = receivedLeases.get(role);
    if (!record) {
      return deny('G0_PORT_LEASE.claim', 'PORT_LEASE_NOT_RECEIVED');
    }
    if (record.claimed) {
      return deny('G0_PORT_LEASE.claim', 'PORT_LEASE_ALREADY_CLAIMED');
    }
    record.claimed = true;

    return Object.freeze({
      port: record.declaration.port,
      attachHttpServer(server) {
        if (record.released) {
          return deny(
            'G0_PORT_LEASE.attachHttpServer',
            'PORT_LEASE_ALREADY_RELEASED',
          );
        }
        if (record.adopted) {
          return deny(
            'G0_PORT_LEASE.attachHttpServer',
            'PORT_LEASE_ALREADY_ADOPTED',
          );
        }
        if (
          !(server instanceof net.Server)
          || server === record.server
          || server.listening
        ) {
          return deny(
            'G0_PORT_LEASE.attachHttpServer',
            'INVALID_HTTP_SERVER',
          );
        }
        record.server.off('connection', record.pendingListener);
        record.attachedServer = server;
        record.forwardingListener = (socket) => {
          server.emit('connection', socket);
        };
        record.server.on('connection', record.forwardingListener);
        // Adopted: the workload is now serving on it, so it may hold the loop.
        record.server.ref?.();
        record.adopted = true;
        for (const socket of record.pendingSockets.splice(0)) {
          server.emit('connection', socket);
        }
        sendAudit(
          'PORT_LEASE_ADOPTED',
          'ALLOW',
          'G0_PORT_LEASE.attachHttpServer',
          portEventDetails(record),
        );
      },
      close() {
        return releaseLeaseRecord(record, 'G0_PORT_LEASE.close');
      },
    });
  }

  function releaseLeaseRecord(record, operation) {
    if (record.closePromise) return record.closePromise;
    record.closePromise = Promise.resolve().then(() => {
      if (record.released) return;
      record.released = true;
      record.server.off('connection', record.pendingListener);
      if (record.forwardingListener) {
        record.server.off('connection', record.forwardingListener);
      }
      for (const socket of record.pendingSockets.splice(0)) {
        socket.destroy();
      }
      try {
        // close() stops accept synchronously. Do not await its callback:
        // callers may intentionally destroy already accepted sockets only
        // after this promise resolves.
        record.server.close();
      } catch {
        return deny(operation, 'PORT_LEASE_RELEASE_FAILED');
      }
      sendAudit(
        'PORT_LEASE_RELEASED',
        'ALLOW',
        operation,
        {
          ...portEventDetails(record),
          // A lease the workload claimed and then closed completed its
          // lifecycle even if it was never adopted — closing without adopting
          // is a legitimate outcome (a suite may claim a lease purely to prove
          // a listener setup failure). Only a never-claimed lease is abandoned.
          claimed: record.claimed === true,
        },
      );
    });
    return record.closePromise;
  }

  /**
   * Release every lease the workload never took ownership of.
   *
   * A lease is a bound, listening socket, so an unclaimed one keeps the child
   * event loop alive. Without this, a workload that fails before claiming its
   * leases cannot exit and the parent can only classify it as a suite TIMEOUT,
   * hiding the real cause. This never fakes completion: unadopted leases still
   * leave the finalize lease contract unsatisfied.
   */
  function abandonUnclaimedLeases() {
    return Promise.all(
      [...receivedLeases.values()]
        .filter((record) => !record.released)
        .map((record) => releaseLeaseRecord(record, 'G0_PORT_LEASE.abandon')),
    );
  }

  installBridge({
    mode: 'PARENT_GUARDED_V1',
    claimPortLease,
    abandonUnclaimedLeases,
  });

  sendAudit('BOOTSTRAP', 'ALLOW', 'runtime-resource-guard.bootstrap', {
    mode: contract.mode,
  });
  sendAudit('POLICY_ACTIVE', 'ALLOW', 'runtime-resource-guard.policy', {
    outboundMode: contract.outbound.mode,
    allowedLoopbackPortCount: allowedPorts.size,
  });

  if (expectedLeases.size > 0) {
    let handoffTimer;
    try {
      await Promise.race([
        leaseHandoff,
        new Promise((_, reject) => {
          handoffTimer = setTimeout(() => {
            try {
              deny(
                'G0_PORT_LEASE.bootstrap',
                'PORT_LEASE_HANDOFF_TIMEOUT',
              );
            } catch (error) {
              reject(error);
            }
          }, PORT_LEASE_HANDOFF_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (handoffTimer) clearTimeout(handoffTimer);
    }
  }
  if (typeof process.channel?.unref === 'function') {
    process.channel.unref();
  }

  process.once('beforeExit', () => {
    const activeLeaseCount = [...receivedLeases.values()].filter(
      (record) => !record.released,
    ).length;
    const leasesComplete = receivedLeases.size === expectedLeases.size
      && [...receivedLeases.values()].every(
        // Claiming and closing without adopting is a complete lifecycle; only
        // a lease the workload never claimed leaves the contract unsatisfied.
        (record) => record.claimed && record.released,
      );
    const passed = !auditOverflow && deniedCount === 0 && leasesComplete;
    const details = {
      nodeEgressGuardStatus: passed ? 'PASS' : 'FAILED',
      allowedCount,
      deniedCount,
      activeLeaseCount,
      auditOverflow,
    };
    finalEmitted = true;
    const emitted = sendAudit(
      'FINAL',
      passed ? 'ALLOW' : 'DENY',
      'runtime-resource-guard.finalize',
      details,
    );
    if (!passed || !emitted) process.exitCode = 1;
  });

  void originalServerListen;
}
