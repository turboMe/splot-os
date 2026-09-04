#!/usr/bin/env bash
# Ephemeral single-node Mongo replica set for orchestration spikes (GAP-TXN-01).
# Isolated from production `mastra-mongo` (27017): runs on 27018, --rm, torn down
# on `down`. Never touches the `agentforge` database.
#
#   scripts/ephemeral-mongo-rs.sh up    # start + rs.initiate, wait for PRIMARY
#   scripts/ephemeral-mongo-rs.sh down  # stop (auto-removes)
set -euo pipefail

NAME="orch-txn-spike-rs"
PORT="27018"

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # nofile: mongod itself warns that 1024 is too low, and it is not academic —
    # every throwaway orchestration database costs ~70 file handles, so a run of
    # the durability suites panics WiredTiger ("Too many open files") and aborts
    # the server mid-test. 64000 is the minimum mongod asks for at startup.
    docker run -d --rm --name "$NAME" --network host --ulimit nofile=64000:64000 mongo:7 \
      --replSet rs0 --port "$PORT" --bind_ip_all >/dev/null
    sleep 3
    docker exec "$NAME" mongosh --quiet --port "$PORT" \
      --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:${PORT}'}]})" >/dev/null
    for _ in $(seq 1 15); do
      p=$(docker exec "$NAME" mongosh --quiet --port "$PORT" --eval "db.hello().isWritablePrimary" 2>/dev/null || true)
      [ "$p" = "true" ] && { echo "ephemeral rs0 PRIMARY on mongodb://localhost:${PORT}/?replicaSet=rs0"; exit 0; }
      sleep 1
    done
    echo "ephemeral rs did not reach PRIMARY" >&2; exit 1
    ;;
  down)
    docker stop "$NAME" >/dev/null 2>&1 || true
    echo "ephemeral rs stopped"
    ;;
  *)
    echo "usage: $0 up|down" >&2; exit 2 ;;
esac
