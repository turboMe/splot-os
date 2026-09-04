#!/usr/bin/env node
/**
 * Real-process fixture for PROCESS_SUPERVISOR_V1.
 *
 * Every long-running mode has a hard self-expiry so an assertion failure cannot
 * leave an immortal test process. Production code must still clean up only an
 * exactly authenticated process group; this TTL is a final test-harness guard.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(import.meta.url);
const mode = process.argv[2] ?? 'success';
const hardTtlMs = Math.max(
  1_000,
  Math.min(30_000, Number(process.env.ORCH_FIXTURE_HARD_TTL_MS ?? 15_000)),
);
const keepAlive = setInterval(() => {}, 1_000);
const hardExpiry = setTimeout(() => process.exit(97), hardTtlMs);

function finish(code = 0) {
  clearInterval(keepAlive);
  clearTimeout(hardExpiry);
  process.exit(code);
}

function notify(type, payload = {}) {
  if (typeof process.send === 'function') {
    process.send({ type, pid: process.pid, ...payload });
  }
}

function ignoreAbortMessages() {
  process.on('message', () => {});
}

switch (mode) {
  case 'success': {
    console.log(JSON.stringify({
      status: 'ok',
      data: { supervised: true, pid: process.pid },
    }));
    finish(0);
    break;
  }
  case 'failed': {
    console.error('intentional supervised fixture failure');
    finish(23);
    break;
  }
  case 'sentinel': {
    const sentinelPath = process.argv[3];
    if (!sentinelPath) finish(24);
    await writeFile(sentinelPath, `started:${process.pid}\n`, 'utf8');
    console.log(JSON.stringify({ status: 'ok', data: { sentinel: true } }));
    finish(0);
    break;
  }
  case 'cooperative': {
    process.on('message', (message) => {
      if (message?.type === 'ABORT') {
        notify('ABORTED');
        finish(0);
      }
    });
    process.on('SIGTERM', () => finish(91));
    notify('READY');
    break;
  }
  case 'term': {
    ignoreAbortMessages();
    process.on('SIGTERM', () => finish(0));
    notify('READY');
    break;
  }
  case 'kill-tree':
  case 'kill-child': {
    ignoreAbortMessages();
    process.on('SIGTERM', () => {});
    const nextMode = mode === 'kill-tree' ? 'kill-child' : 'kill-grandchild';
    const child = spawn(process.execPath, [fixturePath, nextMode], {
      detached: false,
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('message', (message) => {
      if (message?.type === 'READY') {
        notify('READY', { descendantPid: child.pid, depth: nextMode });
      }
    });
    child.on('error', () => finish(25));
    break;
  }
  case 'term-root-child-survives': {
    ignoreAbortMessages();
    const child = spawn(process.execPath, [fixturePath, 'kill-grandchild'], {
      detached: false,
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('message', (message) => {
      if (message?.type === 'READY') {
        notify('READY', { descendantPid: child.pid });
      }
    });
    child.on('error', () => finish(26));
    process.on('SIGTERM', () => finish(0));
    break;
  }
  case 'kill-grandchild': {
    ignoreAbortMessages();
    process.on('SIGTERM', () => {});
    notify('READY');
    break;
  }
  case 'escaped-root': {
    const escapedTtlMs = Math.max(
      250,
      Math.min(5_000, Number(process.argv[3] ?? 1_000)),
    );
    const escaped = spawn(
      process.execPath,
      [fixturePath, 'escaped-child', String(escapedTtlMs)],
      {
        detached: true,
        env: { ...process.env },
        stdio: 'ignore',
      },
    );
    escaped.unref();
    const rootExitDelayMs = Math.max(
      0,
      Math.min(
        1_000,
        Number(process.env.ORCH_FIXTURE_ESCAPE_ROOT_DELAY_MS ?? 0),
      ),
    );
    console.log(JSON.stringify({
      status: 'ok',
      data: { escapedPid: escaped.pid },
    }));
    if (rootExitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, rootExitDelayMs));
    }
    finish(0);
    break;
  }
  case 'escaped-child': {
    ignoreAbortMessages();
    process.on('SIGTERM', () => {});
    const escapedTtlMs = Math.max(
      250,
      Math.min(5_000, Number(process.argv[3] ?? 1_000)),
    );
    setTimeout(() => finish(0), escapedTtlMs);
    notify('READY');
    break;
  }
  default:
    console.error(`unknown process fixture mode: ${mode}`);
    finish(64);
}
