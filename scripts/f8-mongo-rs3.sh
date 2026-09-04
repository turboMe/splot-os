#!/usr/bin/env bash
#
# Three-node MongoDB replica set for the F8 gate (plan §F8, ADR 0006).
#
# WHY THIS EXISTS
# ---------------
# F8 has to prove there is no split-brain, no lost outbox and no duplicate
# effect UNDER FAILURE. None of those failures can be produced on one node:
# stepdown needs someone to step down *to*, and a partition needs a majority
# left standing to notice. Production `mastra-mongo` is a single-node rs0.
#
# WHY BESIDE PRODUCTION, NOT INSTEAD OF IT
# ----------------------------------------
# The production data volume is `external: true` and named
# `jarvis-dashboard-agent_mongo-data` — it is SHARED with another project.
# F8 needs a topology it is allowed to tear apart repeatedly; production data
# is the one thing that must never be in that blast radius. So this stands
# next to it on its own ports, with its own fresh volumes.
#
#   THIS SCRIPT NEVER TOUCHES PORT 27017, THE `agentforge` DATABASE, OR ANY
#   VOLUME IT DID NOT CREATE. `down --purge` refuses any volume name that is
#   not literally one of its own three. See `assert_own_volume`.
#
# WHY `--network host` (the pattern from scripts/ephemeral-mongo-rs.sh)
# --------------------------------------------------------------------
# A replica set member is reached at the host:port recorded in `rs.conf()`,
# not at the port a client happened to dial. With a bridge network the members
# would have to advertise container names (`f8-rs3-a:27019`), which resolve
# inside Docker but NOT from the host — every connection string in this repo
# would break, and fixing that means editing /etc/hosts. On the host network
# `localhost:27019` means the same thing to a peer mongod and to a Node client
# on the host, so `mongodb://localhost:27019,localhost:27020,localhost:27021`
# works from the application with no system-level configuration at all.
#
# WHY THREE DATA-BEARING NODES AND NOT TWO PLUS AN ARBITER
# --------------------------------------------------------
# An arbiter votes but stores nothing, so it can never acknowledge a
# `w: "majority"` write. In a P-S-A set losing the one secondary leaves a
# majority that cannot advance the majority commit point: `w: majority` writes
# stall and the WiredTiger cache fills with un-committable history. Every
# transaction in the orchestration store uses `w: majority`, so an arbiter
# would inject failure modes that belong to the arbiter, not to the code F8 is
# meant to judge. Three data-bearing nodes tolerate one loss cleanly.
#
# WHY A DISTINCT REPLICA SET NAME (`rs3f8`, not `rs0`)
# ----------------------------------------------------
# Production and the 27018 spike are both `rs0`. A driver given
# `?replicaSet=rs0` rejects a set that answers with a different name — so a
# stale copy-pasted URI aimed here fails immediately and loudly, instead of
# quietly finding production. The name difference is a guard rail, not decor.
#
#   scripts/f8-mongo-rs3.sh up             # start 3 nodes + initiate, wait for PRIMARY
#   scripts/f8-mongo-rs3.sh status         # rs.status(), one line per member
#   scripts/f8-mongo-rs3.sh uri            # print the connection string
#   scripts/f8-mongo-rs3.sh down           # stop + remove containers, KEEP volumes
#   scripts/f8-mongo-rs3.sh down --purge   # ...and remove its own three volumes
set -euo pipefail

RS_NAME="rs3f8"
NODES=(a b c)
PORTS=(27019 27020 27021)
PREFIX="f8-rs3"
IMAGE="mongo:7"

# Ports that belong to someone else. Guarded explicitly rather than trusted:
# a one-character typo in PORTS above would otherwise aim a fresh `rs.initiate`
# at the production mongod, and `rs.initiate` on a live set is not reversible
# by re-running this script.
FORBIDDEN_PORTS=(27017 27018)
PROD_VOLUME="jarvis-dashboard-agent_mongo-data"

container() { echo "${PREFIX}-$1"; }
volume()    { echo "${PREFIX}-$1-data"; }

uri() {
  local hosts=""
  for i in "${!NODES[@]}"; do
    hosts+="${hosts:+,}localhost:${PORTS[$i]}"
  done
  echo "mongodb://${hosts}/?replicaSet=${RS_NAME}"
}

assert_ports_are_ours() {
  for port in "${PORTS[@]}"; do
    for forbidden in "${FORBIDDEN_PORTS[@]}"; do
      if [ "$port" = "$forbidden" ]; then
        echo "REFUSING: port ${port} belongs to production/the 27018 spike, not to F8." >&2
        exit 3
      fi
    done
  done
}

# `down --purge` is the only destructive path in this file. It may delete a
# volume only if the name is one this script itself creates. Anything else —
# above all the shared production volume — is a hard stop, not a warning.
#
# THE ALLOWLIST IS WRITTEN OUT LITERALLY, ON PURPOSE. The first version built
# it from "${PREFIX}-a-data", which made the guard a tautology: change PREFIX
# and the allowlist follows, so it approved whatever it was pointed at. Tested
# with PREFIX=someone-elses, it deleted three foreign volumes and exited 0.
# A guard derived from the value it is guarding cannot fail. These three
# strings are the contract; if the names above ever change, this list has to be
# edited deliberately, and that edit is the review.
ALLOWED_VOLUMES=(f8-rs3-a-data f8-rs3-b-data f8-rs3-c-data)

assert_own_volume() {
  local name="$1"
  if [ "$name" = "$PROD_VOLUME" ]; then
    echo "REFUSING: ${name} is the SHARED PRODUCTION volume. Never." >&2
    exit 3
  fi
  for allowed in "${ALLOWED_VOLUMES[@]}"; do
    [ "$name" = "$allowed" ] && return 0
  done
  echo "REFUSING: ${name} was not created by this script." >&2
  exit 3
}

# Containers are named after the same prefix, and `down` removes them before it
# ever reaches the volumes — so they need the same independent check, for the
# same reason.
ALLOWED_CONTAINERS=(f8-rs3-a f8-rs3-b f8-rs3-c)

assert_own_container() {
  local name="$1"
  for allowed in "${ALLOWED_CONTAINERS[@]}"; do
    [ "$name" = "$allowed" ] && return 0
  done
  echo "REFUSING: container ${name} was not created by this script." >&2
  exit 3
}

# mongosh has to run somewhere that is actually up. During chaos the first node
# may be paused, stopped, or a secondary that refuses the command — so ask each
# running container in turn rather than assuming node A answers.
live_node_index() {
  for i in "${!NODES[@]}"; do
    local c; c=$(container "${NODES[$i]}")
    if [ "$(docker inspect -f '{{.State.Running}}{{.State.Paused}}' "$c" 2>/dev/null)" = "truefalse" ]; then
      echo "$i"; return 0
    fi
  done
  return 1
}

# Run a mongosh eval against any live member. Prints mongosh's stdout verbatim.
rs_eval() {
  local idx; idx=$(live_node_index) || { echo "no live ${PREFIX} node to talk to" >&2; return 1; }
  docker exec "$(container "${NODES[$idx]}")" \
    mongosh --quiet --port "${PORTS[$idx]}" --eval "$1"
}

# WHICH NODE IS ASKED DECIDES WHAT THE ANSWER IS. This is not a detail.
#
# `status` used to report from the first live container, i.e. node A. Measured:
# after `chaos isolate a`, the majority saw A as health=0 — and `status` printed
# all three as health=1, because it was asking A, the one member that cannot
# observe its own one-way partition. The probe reported a healthy cluster in the
# middle of a successful partition.
#
# A replica set has no single truth during a partition, so the vantage point has
# to be chosen and then STATED. The primary's view is the majority view, which
# is the one that decides whether writes commit.
vantage_index() {
  for i in "${!NODES[@]}"; do
    local c; c=$(container "${NODES[$i]}")
    [ "$(docker inspect -f '{{.State.Running}}{{.State.Paused}}' "$c" 2>/dev/null)" = "truefalse" ] || continue
    if docker exec "$c" mongosh --quiet --port "${PORTS[$i]}" \
         --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; then
      echo "$i"; return 0
    fi
  done
  live_node_index
}

# Sourced by scripts/f8-mongo-chaos.sh, which needs the ports, the container
# names, `rs_eval` and above all the SAME guards. Duplicating those constants in
# a second file is how a chaos script eventually points at production: the two
# copies drift, and the copy that drifts is the one nobody re-reads. When
# sourced, this file defines and stops; only a direct run dispatches a command.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0
fi

case "${1:-}" in
  up)
    assert_ports_are_ours

    for i in "${!NODES[@]}"; do
      c=$(container "${NODES[$i]}"); v=$(volume "${NODES[$i]}"); p="${PORTS[$i]}"
      if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ]; then
        echo "  · ${c} already running on :${p}"
        continue
      fi
      docker rm -f "$c" >/dev/null 2>&1 || true
      # nofile: mongod asks for 64000 at startup and the 1024 default is not
      # academic here — a run of the durability suites costs ~70 handles per
      # throwaway database and panics WiredTiger ("Too many open files")
      # part-way through, taking the server down mid-test.
      #
      # No `--rm`: chaos has to be able to `docker stop` a node and start it
      # again as the SAME member with the SAME data. `--rm` would delete it on
      # the first stop and turn every restart into a fresh, empty node.
      #
      # enableTestCommands=1 unlocks `configureFailPoint`. Measured: without it
      # mongod answers `CommandNotFound: no such command 'configureFailPoint'`,
      # and two of the six failures F8 must demonstrate —
      # TransientTransactionError and UnknownTransactionCommitResult — have no
      # deterministic trigger without failpoints. You can *hope* to catch them
      # by killing a primary mid-commit; F8 needs evidence, not a race won.
      #
      # This is safe HERE and would not be in production: these three nodes are
      # a throwaway F8 environment on their own ports and volumes. The flag is
      # deliberately absent from the production compose definition.
      docker run -d --name "$c" \
        --network host \
        --ulimit nofile=64000:64000 \
        -v "${v}:/data/db" \
        "$IMAGE" --replSet "$RS_NAME" --port "$p" --bind_ip_all \
        --setParameter enableTestCommands=1 >/dev/null
      echo "  · started ${c} on :${p} (volume ${v})"
    done

    # Wait for each mongod to answer before initiating: `rs.initiate` against a
    # member that has not finished opening its files fails with a message that
    # looks like a configuration error and is not one.
    for i in "${!NODES[@]}"; do
      c=$(container "${NODES[$i]}"); p="${PORTS[$i]}"
      for _ in $(seq 1 30); do
        if docker exec "$c" mongosh --quiet --port "$p" --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -q 1; then
          break
        fi
        sleep 1
      done
    done

    members=""
    for i in "${!NODES[@]}"; do
      members+="${members:+,}{_id:${i},host:'localhost:${PORTS[$i]}'}"
    done

    # Idempotent: an already-initiated set must not be re-initiated (that would
    # be a second, conflicting configuration), so ask first and only initiate
    # when the answer is that there is no config yet.
    existing=$(docker exec "$(container "${NODES[0]}")" mongosh --quiet --port "${PORTS[0]}" \
      --eval "try { rs.conf()._id } catch (e) { 'NONE' }" 2>/dev/null | tr -d '\r' | tail -n1 || echo NONE)
    if [ "$existing" = "$RS_NAME" ]; then
      echo "  · ${RS_NAME} already initiated — waiting for PRIMARY"
    else
      docker exec "$(container "${NODES[0]}")" mongosh --quiet --port "${PORTS[0]}" \
        --eval "rs.initiate({_id:'${RS_NAME}',members:[${members}]})" >/dev/null
      echo "  · rs.initiate(${RS_NAME}) sent"
    fi

    # Done means: a writable primary AND all three members reporting health 1.
    # "A primary exists" alone would go green while two nodes are still down,
    # which is exactly the state F8 must be able to tell apart from healthy.
    for _ in $(seq 1 60); do
      ok=$(rs_eval "
        try {
          const s = rs.status();
          const healthy = s.members.filter(m => m.health === 1).length;
          const primary = s.members.some(m => m.stateStr === 'PRIMARY');
          (healthy === ${#NODES[@]} && primary) ? 'READY' : 'WAIT';
        } catch (e) { 'WAIT' }
      " 2>/dev/null | tr -d '\r' | tail -n1 || echo WAIT)
      if [ "$ok" = "READY" ]; then
        echo ""
        echo "F8 replica set ${RS_NAME} is up — $(uri)"
        exec "$0" status
      fi
      sleep 1
    done
    echo "F8 replica set did not reach 3 healthy members with a PRIMARY" >&2
    "$0" status || true
    exit 1
    ;;

  status)
    idx=$(vantage_index) || { echo "no live ${PREFIX} node to talk to" >&2; exit 1; }
    docker exec "$(container "${NODES[$idx]}")" \
      mongosh --quiet --port "${PORTS[$idx]}" --eval "
        const s = rs.status();
        print('replicaSet: ' + s.set + ' | members: ' + s.members.length +
              ' | term: ' + s.term);
        print('as seen from localhost:${PORTS[$idx]}' +
              (s.members.find(m => m.self && m.stateStr === 'PRIMARY') ? ' (PRIMARY — majority view)'
                                                                      : ' (NOT primary — minority view)'));
        s.members.forEach(m => print('  ' + m.name.padEnd(20) + m.stateStr.padEnd(26) +
          'health=' + m.health));
      "
    ;;

  uri)
    uri
    ;;

  down)
    # VALIDATE EVERYTHING BEFORE DESTROYING ANYTHING. The first version checked
    # each name as it went, so the container removal loop had already run by the
    # time the volume guard refused — the guard reported a refusal on a system
    # it had, in part, already taken apart. Nothing is removed until every name
    # in this invocation has been approved.
    for n in "${NODES[@]}"; do
      assert_own_container "$(container "$n")"
      [ "${2:-}" = "--purge" ] && assert_own_volume "$(volume "$n")"
    done

    for n in "${NODES[@]}"; do
      c=$(container "$n")
      # `-v` reaps the ANONYMOUS volume the mongo image declares for
      # /data/configdb (one per container, otherwise left behind on every
      # up/down cycle). It does not touch NAMED volumes, which is exactly the
      # split we want: /data/db survives a `down`, and only `--purge` deletes it.
      docker rm -f -v "$c" >/dev/null 2>&1 || true
      echo "  · removed ${c}"
    done
    if [ "${2:-}" = "--purge" ]; then
      for n in "${NODES[@]}"; do
        v=$(volume "$n")
        docker volume rm "$v" >/dev/null 2>&1 || true
        echo "  · removed volume ${v}"
      done
      echo "F8 replica set removed, volumes purged. Production ${PROD_VOLUME} untouched."
    else
      echo "F8 replica set stopped. Volumes kept — 'down --purge' also deletes them."
    fi
    ;;

  *)
    echo "usage: $0 up|down [--purge]|status|uri" >&2; exit 2 ;;
esac
