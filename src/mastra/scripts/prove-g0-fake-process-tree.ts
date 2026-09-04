/**
 * Live proof for the G0 fake child/grandchild process fixture (§19.1/§19.3).
 *
 * This spawns a real detached leader → child → grandchild tree, proves it is
 * exactly that shape and owned by the run's tokens, shows the members ignore
 * SIGTERM, and proves the owner's SIGKILL empties the exact tree with no escaped
 * or leaked process. It is destructive only to the three processes it spawns.
 *
 * Safety envelope: Linux; only the exact process group this run created is ever
 * signalled; the group is force-killed in a `finally` even if an assertion fails.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  inspectOwnedProcessTree,
} from '../orchestration/execution/linux-process-tree.js';
import {
  spawnFakeProcessTree,
  teardownFakeProcessTree,
  verifyFakeProcessTreeShape,
  type FakeProcessTreeHandle,
} from '../orchestration/testing/fake-process-tree.js';

const PROOF_VERSION = 'g0-fake-process-tree-live-proof/v1';

async function runProof(): Promise<void> {
  assert.equal(process.platform, 'linux', 'fake process-tree proof requires Linux');
  const processExecutionId = `proof_exec_${randomBytes(16).toString('hex')}`;
  const runtimeRunId = `proof_run_${randomBytes(16).toString('hex')}`;

  let handle: FakeProcessTreeHandle | undefined;
  try {
    handle = await spawnFakeProcessTree({ processExecutionId, runtimeRunId });

    // Exact parenting and confinement to the leader's group and session.
    assert.equal(handle.child.ppid, handle.leader.pid, 'child is not parented by the leader');
    assert.equal(handle.grandchild.ppid, handle.child.pid, 'grandchild is not parented by the child');
    for (const member of [handle.child, handle.grandchild]) {
      assert.equal(member.pgid, handle.leader.pid, 'member escaped the leader group');
      assert.equal(member.sid, handle.leader.pid, 'member escaped the leader session');
    }
    assert.equal(handle.leader.pid, handle.owner.pid);
    assert.equal(handle.owner.mode, 'PROCESS_GROUP');

    // Independently inspect the owned tree: exactly three members, no escape.
    const before = await inspectOwnedProcessTree(handle.owner);
    assert.equal(verifyFakeProcessTreeShape(before, handle), null, 'owned tree is not the exact shape');
    assert.equal(before.groupMembers.length, 3, 'owned tree does not hold exactly three members');
    assert.equal(before.escapedTokenMembers.length, 0, 'a token member escaped the owned group');
    assert.equal(before.treeEmpty, false, 'owned tree is unexpectedly already empty');

    // Fail-closed teardown: SIGTERM is ignored (non-cooperative), SIGKILL empties.
    const evidence = await teardownFakeProcessTree(handle);
    assert.equal(evidence.status, 'PASS', evidence.reason ?? 'teardown did not pass');
    assert.equal(evidence.shapeVerified, true);
    assert.equal(evidence.termIgnored, true, 'members did not ignore SIGTERM');
    assert.equal(evidence.killedEmpty, true, 'SIGKILL did not empty the owned tree');
    assert.equal(evidence.childAbsent, true);
    assert.equal(evidence.grandchildAbsent, true);
    assert.equal(evidence.escapedTokenMembers, 0);
    assert.deepEqual(evidence.signals, ['SIGTERM', 'SIGKILL']);

    // Independently re-inspect: the exact tree is really gone, no token member left.
    const after = await inspectOwnedProcessTree(handle.owner);
    assert.equal(after.treeEmpty, true, 'owned tree survived teardown');
    assert.equal(after.tokenMembers.length, 0, 'a token member survived teardown');
    assert.equal(after.escapedTokenMembers.length, 0, 'a token member escaped teardown');

    handle = undefined;
    console.log(JSON.stringify({
      schemaVersion: PROOF_VERSION,
      status: 'PASSED',
      tree: {
        leaderPid: evidence.ownerLeaderPid,
        childPid: evidence.childPid,
        grandchildPid: evidence.grandchildPid,
        observedGroupMembers: evidence.observedGroupMembers,
      },
      teardown: {
        termIgnored: evidence.termIgnored,
        killedEmpty: evidence.killedEmpty,
        childAbsent: evidence.childAbsent,
        grandchildAbsent: evidence.grandchildAbsent,
        escapedTokenMembers: evidence.escapedTokenMembers,
        signals: evidence.signals,
      },
      treeEmptyAfter: true,
    }));
  } finally {
    // A failed proof must still not leave the owned group alive.
    if (handle) {
      await teardownFakeProcessTree(handle).catch(() => {
        try { process.kill(-handle!.owner.pid, 'SIGKILL'); } catch { /* already gone */ }
      });
    }
  }
}

await runProof();
