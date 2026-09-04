/**
 * Model Circuit Breaker (Phase 4.2)
 *
 * Prevents repeated calls to failing models (rate-limited, down, timeout).
 * After `threshold` consecutive failures, the circuit opens for `resetMs`.
 *
 * Three states:
 *   CLOSED  → model is healthy, requests go through
 *   OPEN    → model is failing, requests are blocked
 *   HALF    → cooldown expired, next request is a probe (auto-transition)
 *
 * Usage:
 *   const breaker = getCircuitBreaker();
 *   if (breaker.isOpen('openrouter/nvidia/nemotron:free')) skip;
 *   try { result = await call(); breaker.recordSuccess(modelId); }
 *   catch { breaker.recordFailure(modelId); }
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface CircuitState {
  /** Consecutive failure count */
  failures: number;
  /** Timestamp of last failure */
  lastFailure: number;
  /** Timestamp of last success */
  lastSuccess: number;
  /** Whether the circuit is currently open */
  open: boolean;
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

export class ModelCircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  /** Number of consecutive failures before opening circuit */
  private readonly threshold: number;
  /** Milliseconds before an open circuit resets (half-open probe) */
  private readonly resetMs: number;

  constructor(opts: { threshold?: number; resetMs?: number } = {}) {
    this.threshold = opts.threshold ?? 3;
    this.resetMs = opts.resetMs ?? 300_000; // 5 minutes
  }

  /**
   * Check if the circuit is open for a model.
   * Returns true if the model should be skipped.
   * Automatically transitions to half-open after resetMs.
   */
  isOpen(modelId: string): boolean {
    const state = this.states.get(modelId);
    if (!state || !state.open) return false;

    // Check if cooldown has expired → half-open (allow one probe)
    const elapsed = Date.now() - state.lastFailure;
    if (elapsed >= this.resetMs) {
      // Transition to half-open: allow next request as a probe
      state.open = false;
      state.failures = 0;
      console.log(
        `[CircuitBreaker] ${modelId}: HALF-OPEN after ${(elapsed / 1000).toFixed(0)}s cooldown`,
      );
      return false;
    }

    return true;
  }

  /**
   * Record a successful call. Resets failure count and closes circuit.
   */
  recordSuccess(modelId: string): void {
    const state = this.states.get(modelId);
    if (state) {
      state.failures = 0;
      state.open = false;
      state.lastSuccess = Date.now();
    }
  }

  /**
   * Record a failed call. Opens circuit after threshold consecutive failures.
   */
  recordFailure(modelId: string): void {
    let state = this.states.get(modelId);
    if (!state) {
      state = { failures: 0, lastFailure: 0, lastSuccess: 0, open: false };
      this.states.set(modelId, state);
    }

    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= this.threshold) {
      state.open = true;
      console.warn(
        `[CircuitBreaker] ${modelId}: OPEN after ${state.failures} consecutive failures. ` +
        `Will reset after ${this.resetMs / 1000}s.`,
      );
    }
  }

  /**
   * Get the current state of a model's circuit (for diagnostics).
   */
  getState(modelId: string): { failures: number; open: boolean; cooldownRemainingMs: number } {
    const state = this.states.get(modelId);
    if (!state) return { failures: 0, open: false, cooldownRemainingMs: 0 };

    const cooldownRemainingMs = state.open
      ? Math.max(0, this.resetMs - (Date.now() - state.lastFailure))
      : 0;

    return {
      failures: state.failures,
      open: state.open,
      cooldownRemainingMs,
    };
  }

  /**
   * Get summary of all models with open circuits (for logging).
   */
  getOpenCircuits(): Array<{ modelId: string; failures: number; cooldownRemainingMs: number }> {
    const result: Array<{ modelId: string; failures: number; cooldownRemainingMs: number }> = [];
    for (const [modelId, state] of this.states) {
      if (state.open) {
        result.push({
          modelId,
          failures: state.failures,
          cooldownRemainingMs: Math.max(0, this.resetMs - (Date.now() - state.lastFailure)),
        });
      }
    }
    return result;
  }

  /**
   * Force-reset a specific model's circuit (manual intervention).
   */
  reset(modelId: string): void {
    this.states.delete(modelId);
  }

  /**
   * Reset all circuits.
   */
  resetAll(): void {
    this.states.clear();
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: ModelCircuitBreaker | null = null;

export function getCircuitBreaker(): ModelCircuitBreaker {
  if (!_instance) {
    _instance = new ModelCircuitBreaker();
  }
  return _instance;
}
