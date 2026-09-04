/**
 * Generate-time Model Health Gate (loop_fix.md P1)
 *
 * Problem: each agent's model is resolved STATICALLY at construction, and the
 * PeriodicWorkerManager availability signal is consumed by nothing. So an
 * unavailable / circuit-open model has no escape hatch and just burns the whole
 * 300s wall-clock budget.
 *
 * Fix (core, low-risk): a pre-flight gate. Before `agent.generate()`, resolve
 * the model the agent will use, check its health (cached availability registry
 * + circuit breaker), and if it is down, swap to the first healthy model from
 * the agent's fallback chain. Reuses the existing
 * `config/model-capabilities` registry + `services/circuit-breaker`.
 *
 * Reads ONLY the cached `available` flag (refreshed by PeriodicWorkerManager /
 * startup) — it does NOT make a live provider request, so it adds no latency.
 */

import { modelRegistry } from '../config/model-capabilities.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { agentModelKeyForId, agentModels, fallbackChainForAgent, resolveModelId } from '../config/model-manifest.js';

export interface HealthGateResult {
  /** The model id the run should use (swapped fallback, or the intended one). */
  modelId: string | null;
  /** True when the intended model was unhealthy and a fallback was substituted. */
  swapped: boolean;
  /** The originally intended model id (for telemetry). */
  intendedModelId: string | null;
  /** Reason the intended model was considered unhealthy, when swapped. */
  reason?: string;
}

/**
 * Is a model id usable right now? A model is healthy when the capability
 * registry does NOT mark it unavailable AND its circuit breaker is closed.
 * Models absent from the registry are treated as "assume available" (we cannot
 * assess them) but are still subject to the circuit breaker.
 */
export function isModelHealthy(modelId: string): boolean {
  const entry = modelRegistry.find((m) => m.modelId === modelId);
  const availableKnown = entry ? entry.available : true;
  if (!availableKnown) return false;
  return !getCircuitBreaker().isOpen(modelId);
}

/**
 * Resolve the model id an agent would use without an explicit override.
 * Returns null when the agentId is unknown (e.g. an ad-hoc worker), in which
 * case the caller should leave the agent's constructed model untouched.
 */
function intendedModelForAgent(agentId: string | null | undefined): string | null {
  const key = agentModelKeyForId(agentId);
  if (!key) return null;
  return resolveModelId(agentModels[key]);
}

/**
 * Pre-flight health gate. Given the agentId and (optionally) an explicit
 * requested model, return the model the run should use. When the intended model
 * is unhealthy, walk the agent's fallback chain and pick the first healthy one.
 *
 * Never throws. When nothing healthy is found (all providers down) it returns
 * the intended model so the caller degrades gracefully rather than blocking.
 */
export function selectHealthyModelId(opts: {
  agentId: string | null | undefined;
  requestedModelId?: string | null;
}): HealthGateResult {
  const intended = opts.requestedModelId ?? intendedModelForAgent(opts.agentId);

  // Unknown model (ad-hoc worker, no manifest mapping) → don't gate.
  if (!intended) {
    return { modelId: null, swapped: false, intendedModelId: null };
  }

  if (isModelHealthy(intended)) {
    return { modelId: intended, swapped: false, intendedModelId: intended };
  }

  const entry = modelRegistry.find((m) => m.modelId === intended);
  const reason = entry && !entry.available
    ? 'model marked unavailable'
    : 'circuit breaker open';

  for (const candidate of fallbackChainForAgent(opts.agentId)) {
    if (candidate === intended) continue;
    if (isModelHealthy(candidate)) {
      return { modelId: candidate, swapped: true, intendedModelId: intended, reason };
    }
  }

  // Nothing healthy to fall back to — degrade gracefully, keep the intended
  // model (the run may still fail, but we don't block on a guess).
  return { modelId: intended, swapped: false, intendedModelId: intended, reason };
}
