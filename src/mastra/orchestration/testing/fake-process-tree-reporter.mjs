/**
 * Plain-JavaScript reporter for the G0 fake process-tree fixture.
 *
 * It is deliberately loader-free and forks its children with `execArgv: []`: a
 * `--import tsx` reporter would make esbuild spawn its own service process into
 * the owned group, so the "exact three-member tree" invariant would never hold.
 * Running as plain Node keeps the owned group to exactly leader + child +
 * grandchild. The spawner reads every identity from `/proc`; this reporter only
 * builds the fork chain, relays the descendant PIDs, and stays alive (ignoring
 * SIGTERM) until the owner's SIGKILL.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);
const LEADER_MODE = '--fake-process-tree-leader';
const CHILD_MODE = '--fake-process-tree-child';
const GRANDCHILD_MODE = '--fake-process-tree-grandchild';

// Non-cooperative: ignore SIGTERM so teardown must escalate to SIGKILL. The
// handler plus a ref'd timer keep the event loop alive until then.
process.on('SIGTERM', () => {});
setInterval(() => {}, 60_000);

function forkNext(mode) {
  return fork(SELF_PATH, [mode], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

function waitForChildMessage(child) {
  return new Promise((resolve, reject) => {
    child.once('message', (message) => resolve(message));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('descendant exited before reporting')));
  });
}

const mode = process.argv[2];
try {
  if (mode === GRANDCHILD_MODE) {
    process.send?.({ type: 'GRANDCHILD_READY' });
  } else if (mode === CHILD_MODE) {
    const grandchild = forkNext(GRANDCHILD_MODE);
    await waitForChildMessage(grandchild);
    process.send?.({ type: 'CHILD_READY', grandchildPid: grandchild.pid });
  } else if (mode === LEADER_MODE) {
    const child = forkNext(CHILD_MODE);
    const childReport = await waitForChildMessage(child);
    process.send?.({
      type: 'LEADER_READY',
      childPid: child.pid,
      grandchildPid: childReport?.grandchildPid,
    });
  } else {
    process.exitCode = 2;
  }
} catch (error) {
  process.send?.({ type: 'FAKE_TREE_FAILED', stage: String(error?.message ?? 'unknown') });
  process.exitCode = 1;
}
