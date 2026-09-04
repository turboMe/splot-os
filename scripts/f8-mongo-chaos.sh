#!/usr/bin/env bash
#
# Fault injection for the F8 gate, against the three-node set from
# scripts/f8-mongo-rs3.sh. Without this, F8 has a topology and nothing to do
# with it.
#
# Every fault below was MEASURED against the running set, not reasoned about.
# The measurements are recorded next to each command because two of them are
# counter-intuitive and a reader who assumes the obvious will write a test that
# proves nothing.
#
# THE TWO PARTITION MODES ARE NOT INTERCHANGEABLE
# -----------------------------------------------
# `isolate` blocks a node's INBOUND heartbeats with the `failCommand`
# failpoint. Measured: the majority marks the node `health=0` within ~3 s, but
# NO FAILOVER HAPPENS — the node's own outbound heartbeats still land, which
# keeps resetting the other members' election timers. An isolated primary goes
# on believing it is primary (isWritablePrimary=true) while the rest of the set
# reports it unreachable, and stays that way indefinitely. That is the
# stuck-lease / disagreeing-membership case, and it is the one most likely to
# expose a lease renewal that trusts its own view.
#
# `partition` freezes the whole process with `docker pause`, so the node
# neither sends nor receives. Measured: the majority elects a new primary in
# ~15 s (electionTimeoutMillis 10 s + detection), the term increments, and on
# `heal` the old primary rejoins as SECONDARY. That is the failover /
# stale-primary-return case.
#
# Use `isolate` to ask "does the worker notice it lost the cluster's
# confidence?" and `partition` to ask "does the worker survive a real
# failover?". They fail different code.
#
#   scripts/f8-mongo-chaos.sh status
#   scripts/f8-mongo-chaos.sh stepdown [secs]
#   scripts/f8-mongo-chaos.sh isolate <a|b|c|port|primary|secondary>
#   scripts/f8-mongo-chaos.sh partition <node> [secs]
#   scripts/f8-mongo-chaos.sh kill <node>
#   scripts/f8-mongo-chaos.sh revive <node>
#   scripts/f8-mongo-chaos.sh freeze <node> [secs]
#   scripts/f8-mongo-chaos.sh fail-commit [times|alwaysOn]
#   scripts/f8-mongo-chaos.sh fail-txn-write [times|alwaysOn]
#   scripts/f8-mongo-chaos.sh heal
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Ports, container names, rs_eval and — the point of sourcing rather than
# copying — the same production guards.
# shellcheck source=./f8-mongo-rs3.sh
source "${HERE}/f8-mongo-rs3.sh"

# --- addressing ---------------------------------------------------------------

primary_index() {
  local out
  out=$(rs_eval "
    const s = rs.status();
    const p = s.members.find(m => m.stateStr === 'PRIMARY');
    p ? p.name.split(':')[1] : 'NONE';
  " 2>/dev/null | tr -d '\r' | tail -n1) || return 1
  for i in "${!PORTS[@]}"; do
    [ "${PORTS[$i]}" = "$out" ] && { echo "$i"; return 0; }
  done
  return 1
}

secondary_index() {
  local out
  out=$(rs_eval "
    const s = rs.status();
    const p = s.members.find(m => m.stateStr === 'SECONDARY' && m.health === 1);
    p ? p.name.split(':')[1] : 'NONE';
  " 2>/dev/null | tr -d '\r' | tail -n1) || return 1
  for i in "${!PORTS[@]}"; do
    [ "${PORTS[$i]}" = "$out" ] && { echo "$i"; return 0; }
  done
  return 1
}

# a|b|c, a port, or the role words. Roles are resolved at call time on purpose:
# after a failover "the primary" is a different container than it was a minute
# ago, and a script that hard-codes node A stops testing anything.
resolve_node() {
  local want="${1:-}"
  case "$want" in
    primary)   primary_index   || { echo "no PRIMARY to resolve" >&2; exit 1; } ;;
    secondary) secondary_index || { echo "no healthy SECONDARY to resolve" >&2; exit 1; } ;;
    a|b|c)
      for i in "${!NODES[@]}"; do [ "${NODES[$i]}" = "$want" ] && { echo "$i"; return 0; }; done
      echo "unknown node '${want}'" >&2; exit 2 ;;
    2701[9]|2702[01])
      for i in "${!PORTS[@]}"; do [ "${PORTS[$i]}" = "$want" ] && { echo "$i"; return 0; }; done
      echo "port '${want}' is not part of this set" >&2; exit 2 ;;
    *) echo "usage: node is a|b|c, ${PORTS[*]}, primary, or secondary (got '${want}')" >&2; exit 2 ;;
  esac
}

# Talk to ONE specific node, not "any live node" — a fault has to be applied to
# the node named on the command line, never to whichever one happens to answer.
node_eval() {
  local idx="$1" js="$2"
  docker exec "$(container "${NODES[$idx]}")" \
    mongosh --quiet --port "${PORTS[$idx]}" --eval "$js"
}

# `alwaysOn`, or a count.
#
# THE DEFAULT IS `alwaysOn` AND THAT MATTERS. The first version defaulted to
# `times:1`, and measured against the live set it produced NOTHING: the
# transaction committed with no error at all. The failpoint was armed and
# firing the whole time — `timesEntered` proved it — but the MongoDB driver
# retries `commitTransaction` once, by itself, on a retryable error. The
# single-shot failure was consumed by that retry and never reached the
# application.
#
# So `times:1` answers "does the driver's own retry paper over one lost
# commit?" (yes), and `alwaysOn` answers "what does the application see when
# the failure outlives the retry?" (UnknownTransactionCommitResult). Only the
# second is evidence for F8. A `times:1` test looks like a passing partition
# test and proves nothing whatsoever.
failpoint_mode() {
  local raw="${1:-alwaysOn}"
  if [ "$raw" = "alwaysOn" ]; then echo "'alwaysOn'"; else echo "{times:${raw}}"; fi
}

case "${1:-}" in
  status)
    "${HERE}/f8-mongo-rs3.sh" status
    echo -n "  faults: "
    faults=""
    for i in "${!NODES[@]}"; do
      c=$(container "${NODES[$i]}")
      state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
      case "$state" in
        paused)  faults+="${NODES[$i]}=PARTITIONED " ;;
        exited)  faults+="${NODES[$i]}=KILLED " ;;
        missing) faults+="${NODES[$i]}=ABSENT " ;;
        running)
          # An active failCommand failpoint is visible in its own counters:
          # `mode:'off'` in a *query* would clear it, so ask the failpoint
          # registry instead of poking the failpoint itself.
          if node_eval "$i" "
              const fp = db.adminCommand({getParameter:1, 'failpoint.failCommand':1});
              const on = fp['failpoint.failCommand'] && fp['failpoint.failCommand'].mode;
              quit(on && on !== 'off' && !(typeof on === 'object' && Object.keys(on).length === 0) ? 0 : 1);
            " >/dev/null 2>&1; then
            faults+="${NODES[$i]}=FAILPOINT "
          fi
          ;;
      esac
    done
    [ -z "$faults" ] && echo "none (all three running, no failpoints)" || echo "$faults"
    ;;

  # Every node's view of every node. During a partition there is no single
  # truth, and the DISAGREEMENT is the thing being tested — an isolated node
  # reports the cluster healthy while the cluster reports it gone. A one-vantage
  # status cannot show that, and reading one vantage as "the" state is how a
  # partition test silently passes without partitioning anything.
  views)
    for i in "${!NODES[@]}"; do
      c=$(container "${NODES[$i]}")
      state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
      if [ "$state" != "running" ]; then
        printf '  %s (%s) is %s — no view\n' "${NODES[$i]}" "${PORTS[$i]}" "$state"
        continue
      fi
      printf '  %s (%s) sees: ' "${NODES[$i]}" "${PORTS[$i]}"
      timeout 10 docker exec "$c" mongosh --quiet --port "${PORTS[$i]}" --eval "
        const s = rs.status();
        print(s.members.map(m => m.name.split(':')[1] + '=' +
          (m.health === 1 ? m.stateStr : 'DOWN')).join('  ') + '   [term ' + s.term + ']');
      " 2>/dev/null || echo "(no answer — frozen or unreachable)"
    done
    ;;

  # Orderly handover. The old primary is frozen for the same window so it does
  # not simply win the next election and hand the test a topology that never
  # actually changed.
  stepdown)
    secs="${2:-30}"
    idx=$(primary_index) || { echo "no PRIMARY — nothing to step down" >&2; exit 1; }
    echo "  stepping down ${PORTS[$idx]} for ${secs}s"
    # replSetStepDown severs the connection by design; mongosh reports that as
    # an error even though the command succeeded. Only a non-network failure is
    # a real failure here.
    node_eval "$idx" "
      try { rs.stepDown(${secs}); print('  stepDown accepted'); }
      catch (e) {
        const net = /network|connection|socket|closed/i.test(e.message || '');
        print(net ? '  stepDown accepted (connection dropped, as expected)'
                  : '  stepDown FAILED: ' + e.message);
      }" || true
    sleep 3
    "${HERE}/f8-mongo-rs3.sh" status
    ;;

  # ONE-WAY partition. See the header: this does NOT cause a failover.
  isolate)
    idx=$(resolve_node "${2:-}")
    echo "  isolating ${PORTS[$idx]} (inbound heartbeats refused; it keeps serving clients)"
    node_eval "$idx" "
      const r = db.adminCommand({
        configureFailPoint:'failCommand', mode:'alwaysOn',
        data:{ failCommands:['replSetHeartbeat'], errorCode:6, failInternalCommands:true }});
      print('  failpoint ok=' + r.ok);" >/dev/null
    echo "  applied — the majority marks it health=0 within ~3s"
    sleep 4
    "${HERE}/f8-mongo-rs3.sh" status
    ;;

  # SYMMETRIC partition. Causes a real election after ~15s.
  partition)
    idx=$(resolve_node "${2:-}")
    secs="${3:-0}"
    c=$(container "${NODES[$idx]}")
    assert_own_container "$c"
    echo "  partitioning ${PORTS[$idx]} (process frozen: sends nothing, receives nothing)"
    docker pause "$c" >/dev/null
    if [ "$secs" != "0" ]; then
      echo "  holding for ${secs}s, then healing this node"
      sleep "$secs"
      docker unpause "$c" >/dev/null
      echo "  ${PORTS[$idx]} back"
      sleep 3
    fi
    "${HERE}/f8-mongo-rs3.sh" status
    ;;

  # Crash, not a partition: the process is gone and its connections are refused
  # rather than left hanging. `revive` restarts the SAME container on the SAME
  # volume, so it rejoins as the same member with its data intact.
  kill)
    idx=$(resolve_node "${2:-}")
    c=$(container "${NODES[$idx]}")
    assert_own_container "$c"
    echo "  killing ${PORTS[$idx]}"
    docker stop -t 0 "$c" >/dev/null
    sleep 3
    "${HERE}/f8-mongo-rs3.sh" status
    ;;

  revive)
    idx=$(resolve_node "${2:-}")
    c=$(container "${NODES[$idx]}")
    assert_own_container "$c"
    echo "  reviving ${PORTS[$idx]}"
    docker start "$c" >/dev/null
    sleep 5
    "${HERE}/f8-mongo-rs3.sh" status
    ;;

  # Keep a node out of elections without making it unreachable — the way to
  # choose WHICH node wins the next election instead of accepting whoever does.
  freeze)
    idx=$(resolve_node "${2:-}")
    secs="${3:-60}"
    echo "  freezing ${PORTS[$idx]} for ${secs}s (ineligible for election, still replicating)"
    node_eval "$idx" "try { rs.freeze(${secs}); print('  frozen'); } catch(e) { print('  freeze: ' + e.message); }" || true
    ;;

  # UnknownTransactionCommitResult: the commit is sent and the connection dies
  # before the answer comes back, so the driver genuinely cannot tell whether it
  # committed. This is the error that turns a retry into a DUPLICATE EFFECT if
  # the write is not idempotent — the single most important thing F8 checks.
  fail-commit)
    mode=$(failpoint_mode "${2:-alwaysOn}")
    idx=$(primary_index) || { echo "no PRIMARY" >&2; exit 1; }
    echo "  primary ${PORTS[$idx]}: commitTransaction will lose its connection (mode=${2:-alwaysOn})"
    node_eval "$idx" "
      const r = db.adminCommand({
        configureFailPoint:'failCommand', mode:${mode},
        data:{ failCommands:['commitTransaction'], closeConnection:true }});
      print('  failpoint ok=' + r.ok);"
    ;;

  # TransientTransactionError: the server aborts the transaction and labels the
  # error retryable-as-a-whole. A correct caller restarts the whole transaction.
  fail-txn-write)
    mode=$(failpoint_mode "${2:-alwaysOn}")
    idx=$(primary_index) || { echo "no PRIMARY" >&2; exit 1; }
    echo "  primary ${PORTS[$idx]}: writes inside a transaction will abort as transient (mode=${2:-alwaysOn})"
    node_eval "$idx" "
      const r = db.adminCommand({
        configureFailPoint:'failCommand', mode:${mode},
        data:{ failCommands:['insert','update','findAndModify','delete'],
               errorCode:112, errorLabels:['TransientTransactionError'] }});
      print('  failpoint ok=' + r.ok);"
    ;;

  # Undo EVERY fault, in the order that makes the next one possible: a paused
  # node cannot be asked to clear a failpoint, and a stopped node cannot be
  # asked anything at all.
  heal)
    for i in "${!NODES[@]}"; do
      c=$(container "${NODES[$i]}")
      assert_own_container "$c"
      state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
      [ "$state" = "paused" ] && { docker unpause "$c" >/dev/null; echo "  unpaused ${NODES[$i]}"; }
      [ "$state" = "exited" ] && { docker start "$c" >/dev/null; echo "  restarted ${NODES[$i]}"; sleep 4; }
    done
    for i in "${!NODES[@]}"; do
      node_eval "$i" "db.adminCommand({configureFailPoint:'failCommand', mode:'off'}).ok" >/dev/null 2>&1 \
        && echo "  cleared failpoints on ${NODES[$i]}" \
        || echo "  could not clear failpoints on ${NODES[$i]} (not running?)"
    done
    echo "  waiting for the set to settle"
    for _ in $(seq 1 30); do
      ok=$(rs_eval "
        try {
          const s = rs.status();
          (s.members.filter(m => m.health === 1).length === ${#NODES[@]} &&
           s.members.some(m => m.stateStr === 'PRIMARY')) ? 'READY' : 'WAIT';
        } catch (e) { 'WAIT' }" 2>/dev/null | tr -d '\r' | tail -n1 || echo WAIT)
      [ "$ok" = "READY" ] && break
      sleep 2
    done
    "${HERE}/f8-mongo-rs3.sh" status
    ;;

  *)
    sed -n '/^#   scripts/,/^#   scripts.*heal/p' "${BASH_SOURCE[0]}" | sed 's/^#   /  /'
    exit 2 ;;
esac
