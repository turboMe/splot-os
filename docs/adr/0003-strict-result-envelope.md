# ADR 0003 — Strict result envelope, no false success

**Status:** Accepted.
**Plan refs:** §9.1, §3.6 (invariant "No false success"), `RES-001`.

## Context

The legacy `services/result-envelope.ts` maps prose replies to
`status: 'ok'` (prose fallback). Empty output, malformed JSON and unknown
statuses can therefore be reported as success (`RES-001`).

## Decision

1. A new, **additive** strict envelope (`contracts/result-envelope.ts`) — the
   legacy parser is not reused.
2. Producer status is a discriminated union: `ok | partial | blocked | failed |
   cancelled | timed_out | unknown_outcome`. Per-status required shapes
   (`ok`/`partial` require `data`; `blocked` requires typed `blocked`;
   `failed`/… require typed `error`).
3. `validateProducerResult` returns a typed rejection (`empty | not_json |
   not_object | missing_status | unknown_status | schema_invalid`) — **never** a
   coerced `ok`. A compatibility layer may keep raw payload as an artifact but
   may not promote it to success.
4. Trust split: identity/version fields (`tenantId`, `jobId`, `planVersion`,
   `attemptFence`, stop generations, `runtimeRunId`, …) are stamped by the
   runtime via `sealResultEnvelope` and cannot be overridden by producer content.
5. Retryability comes from a policy registry + error code, not a model
   suggestion.

## Consequences

- Closing `RES-001` requires a property/schema suite over all variants + an E2E
  no-false-success test (G2). Verified in PR-1 by `check:orchestration-contracts`.
- Empty/prose replies now surface as typed failures → feeds `AGT-001`
  diagnostics, not a success-rate regression.
