#!/usr/bin/env bash
#
# The gate. Every deterministic check, with the durable half actually executed.
#
# This is a script rather than a chain of `&&` in package.json because the gate
# has to own its prerequisite. About twenty checks open a durability section
# against a MongoDB replica set; nothing ever started one, so each printed
# "⚠ SKIP" and the gate still exited 0. Measured 2026-08-10: a full green run
# had five sections — lane-request-user, final-decision, capability-routing,
# durable-delegation, progress-lease — whose assertions never ran.
#
# Two rules, in order:
#
#  1. THE GATE BRINGS ITS OWN REPLICA SET, and it must be the ISOLATED one.
#     Availability is not the only question: the application's mongod runs with
#     a 1024 open-file soft limit and a ~800-handle baseline, and every
#     throwaway orchestration database costs ~70 more. Pointing the whole gate
#     at it panics WiredTiger ("Too many open files") and aborts the server
#     mid-run — measured, twice. The ephemeral container starts near 120
#     handles, is raised to 64000, and is thrown away afterwards.
#
#  2. REQUIRE_RS=1, SO A SKIP IS A FAILURE. If a durability section still
#     cannot run — no Docker and no local replica set — the gate fails and says
#     so, instead of reporting green on assertions that never executed.
#
# A developer without Docker can still run any individual check: without
# REQUIRE_RS the skip is a skip, and every deterministic section runs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

EPHEMERAL_RS="mongodb://localhost:27018/?replicaSet=rs0"
STARTED_RS=0

cleanup() {
  if [ "$STARTED_RS" = 1 ]; then
    npm run --silent spike:mongo-rs:down >/dev/null 2>&1 || true
  fi
}
# INT/TERM too: a gate interrupted half-way must not leave its container behind.
trap cleanup EXIT INT TERM

# `check:replica-set` under REQUIRE_RS=1 exits non-zero exactly when nothing
# answers, and MONGODB_URI_SPIKE_RS pins the question to the ephemeral one.
if REQUIRE_RS=1 MONGODB_URI_SPIKE_RS="$EPHEMERAL_RS" npm run --silent check:replica-set >/dev/null 2>&1; then
  export MONGODB_URI_SPIKE_RS="$EPHEMERAL_RS"
  echo "gate: using the ephemeral replica set already up on :27018"
elif up_output=$(npm run --silent spike:mongo-rs:up 2>&1); then
  STARTED_RS=1
  export MONGODB_URI_SPIKE_RS="$EPHEMERAL_RS"
  echo "gate: started the ephemeral replica set on :27018 — stopped again when the gate finishes"
else
  echo "gate: could not start the ephemeral replica set:" >&2
  echo "${up_output}" | sed 's/^/      /' >&2
  echo "gate: falling back to whatever replica set this machine has." >&2
  echo "      WARNING: if that is the application's mongod, its 1024 open-file soft limit" >&2
  echo "      may panic WiredTiger part-way through. Raise it (compose: ulimits.nofile 64000)" >&2
  echo "      or install Docker so the gate can use the isolated spike replica set." >&2
fi

export REQUIRE_RS=1

# Fails here, loudly and in two seconds, when there is no replica set at all —
# rather than eighty checks later, or (as before) not at all.
npm run check:replica-set
npm run check:skill-frontmatter
npm run check:computer-use-policy
npm run check:browser-policy-target-scoping

npm run check:orchestration-contracts
npm run check:orchestration-store
npm run check:orchestration-gateway
npm run check:orchestration-process-tree
npm run check:orchestration-test-runtime
npm run check:orchestration-coverage
npm run check:pending-message-scope
npm run check:ledger-lifecycle
npm run check:ledger-projection
npm run check:multi-step-plan
npm run check:artifact-handoff
npm run check:capability-precontext
npm run check:outbound-mail
npm run check:house-style
npm run check:prompt-tool-names
npm run check:headless-approval
npm run check:live-merge-permission
npm run check:long-tool-liveness
npm run check:external-project-isolation
npm run check:external-project-mode
npm run check:embedding-consistency
npm run check:coding-task-scope
npm run check:coding-delegation-repo-path
npm run check:coding-domain
npm run check:workspace-lsp
npm run check:workspace-bm25
npm run check:dashboard-approval-auth
npm run check:approval-gate-negation
npm run check:git-locale-independence
npm run check:observability-retention
npm run check:autoheal-cycle
npm run check:error-collector
npm run check:repair-model-floor
npm run check:subagent-roles-enforced
npm run e2e:ledger-three-lanes
npm run check:ledger-claims-conflict
npm run check:idempotency-replay
npm run check:agent-board-sync
npm run check:meta-prompt-size
npm run check:result-envelope-parse
npm run e2e:artifact-handoff
npm run check:skill-distill-roundtrip
npm run check:curator-lifecycle
npm run check:graphify-affected-parse
npm run check:graphify-strengthening
npm run check:graphify-trend
npm run check:graphify-precontext
npm run check:cgp-sandbox-isolation
npm run check:capability-build-gates
npm run check:capability-build-lease
npm run check:capability-build-promote-sequence
npm run check:review-verdict-freshness
npm run check:v2-learning-loop
npm run check:subtask-quality-loop
npm run check:subtask-file-attribution
npm run check:tracked-write-tsc-scope
npm run check:dispatch-concurrency-cap
npm run check:parallel-group-disjoint-files
npm run check:subtask-thread-isolation
npm run check:coding-state-round-trips
npm run check:command-approval-gate
npm run e2e:cgp-discover-attach
npm run check:meta-final-synthesis
npm run check:agent-generate-memory-thread
npm run check:n8n-mcp-engineer
npm run check:crm-domain
npm run check:design-domain
npm run check:analytics-domain
npm run check:deliberation-domain
npm run check:ingredient-normalizer
npm run check:content-domain
npm run check:headless-checkpoints
npm run check:writer-domain
npm run check:writer-review-receipts
npm run check:writer-progress
npm run check:filmmaker-domain
npm run check:musician-domain
npm run check:depth-controller
npm run audit:harness
npm run check:delegation-budget
npm run check:liveness-budget
npm run e2e:orchestration-progress-lease
npm run check:delegation-hardening-tools
npm run check:delegation-salvage
npm run check:async-pipeline-routing
npm run check:external-project-command-nonblocking
npm run check:v2-harness-worker
npm run check:durable-job-tools
npm run check:dashboard-orchestration
npm run check:meta-front-agent
npm run check:lane-decision
npm run check:lane-decider-model
npm run check:lane-request-user
npm run check:groq-model-ids
npm run check:openrouter-model-catalog
npm run check:google-model-ids
npm run check:final-decision
npm run check:capability-routing
npm run check:durable-delegation
npm run check:durable-automation
npm run check:meta-front-reply
npm run check:headless-contract
npm run check:harness-output-text
npm run check:deliverable-capability
npm run check:step-ceiling
npm run check:harness-depth
npm run check:automation-approval-scope
npm run check:meta-harness-wrapper
npm run check:cognitive-loop-dry-run
npm run check:memory-extractor-hygiene
npm run check:automation-finalize-lever
npm run check:reviewer-budgets
npm run check:strategy-reflector
npm run check:pipeline-reflector
npm run check:transient-tool-shelf
npm run check:transient-skill-shelf
npm run check:chef-completeness-gate
npm run check:document-concurrency
npm run check:goal-completion-scorer
npm run check:automation-delegation-contract
npm run check:automation-coverage
npm run check:automation-patterns
npm run check:automation-golden-path
npm run check:automation-autonomy
npm run check:scheduled-tasks
npm run check:scheduled-succession
npm run check:scheduled-chain-handoff
npm run e2e:reflector-prepare-step
npm run e2e:transient-tool-shelf
npm run e2e:transient-skill-shelf
npm run e2e:reflector-stop-when
npm run e2e:reflector-cooldown-hold
npm run e2e:reflector-unrecoverable-stop
npm run e2e:reflector-output-scoring
npm run e2e:liveness-budget
npm run e2e:delegation-abort
