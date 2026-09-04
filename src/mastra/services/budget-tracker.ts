/**
 * Request Budget Tracker (Phase 4.3)
 *
 * Tracks daily API usage per provider to prevent overuse of free tiers.
 * OpenRouter free models have rate limits (varies by model).
 * This tracker provides a configurable daily request budget as a safety net.
 *
 * State is in-memory (resets on restart). For a dev environment, this is fine.
 * Production would use Redis/Mongo for persistence.
 *
 * Usage:
 *   const budget = getBudgetTracker();
 *   if (budget.isOverBudget('openrouter')) skip cloud-free;
 *   budget.recordRequest('openrouter', modelId, tokens);
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface DailyStats {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Total requests this day */
  requests: number;
  /** Total input + output tokens */
  totalTokens: number;
  /** Per-model breakdown */
  byModel: Map<string, { requests: number; tokens: number }>;
}

interface ProviderBudget {
  /** Max requests per day (0 = unlimited) */
  maxDailyRequests: number;
  /** Alert threshold (fraction, e.g. 0.8 = alert at 80%) */
  alertThreshold: number;
  /** Whether an alert has been fired today */
  alertFired: boolean;
  /** Daily stats */
  stats: DailyStats;
}

// ── Budget Tracker ───────────────────────────────────────────────────────────

export class BudgetTracker {
  private readonly providers = new Map<string, ProviderBudget>();

  constructor() {
    // Default budgets per provider
    this.registerProvider('openrouter', {
      maxDailyRequests: parseInt(process.env.OPENROUTER_DAILY_LIMIT ?? '200', 10),
      alertThreshold: 0.8,
    });

    // Recon providers (E3, R4) — paid/metered external APIs used during chef recon.
    // Daily request budgets are a cheap safety net against runaway recon loops; tune
    // via env. Set a limit to 0 to disable the cap for a provider.
    this.registerProvider('tavily', {
      maxDailyRequests: parseInt(process.env.TAVILY_DAILY_LIMIT ?? '100', 10),
      alertThreshold: 0.8,
    });
    this.registerProvider('places', {
      maxDailyRequests: parseInt(process.env.PLACES_DAILY_LIMIT ?? '200', 10),
      alertThreshold: 0.8,
    });
    this.registerProvider('firecrawl', {
      maxDailyRequests: parseInt(process.env.FIRECRAWL_DAILY_LIMIT ?? '100', 10),
      alertThreshold: 0.8,
    });
  }

  /**
   * Register or update a provider's budget configuration.
   */
  registerProvider(
    providerId: string,
    config: { maxDailyRequests: number; alertThreshold?: number },
  ): void {
    const existing = this.providers.get(providerId);
    this.providers.set(providerId, {
      maxDailyRequests: config.maxDailyRequests,
      alertThreshold: config.alertThreshold ?? 0.8,
      alertFired: existing?.alertFired ?? false,
      stats: existing?.stats ?? this.createEmptyStats(),
    });
  }

  /**
   * Record an API request.
   */
  recordRequest(providerId: string, modelId: string, tokens: number = 0): void {
    const budget = this.providers.get(providerId);
    if (!budget) return;

    // Reset stats if day changed
    this.ensureCurrentDay(budget);

    budget.stats.requests++;
    budget.stats.totalTokens += tokens;

    const modelStats = budget.stats.byModel.get(modelId) ?? { requests: 0, tokens: 0 };
    modelStats.requests++;
    modelStats.tokens += tokens;
    budget.stats.byModel.set(modelId, modelStats);

    // Check alert threshold
    if (
      !budget.alertFired &&
      budget.maxDailyRequests > 0 &&
      budget.stats.requests >= budget.maxDailyRequests * budget.alertThreshold
    ) {
      budget.alertFired = true;
      const pct = Math.round((budget.stats.requests / budget.maxDailyRequests) * 100);
      console.warn(
        `[BudgetTracker] ⚠️ ${providerId}: ${pct}% of daily budget used ` +
        `(${budget.stats.requests}/${budget.maxDailyRequests} requests)`,
      );
    }
  }

  /**
   * Check if a provider is over its daily request budget.
   */
  isOverBudget(providerId: string): boolean {
    const budget = this.providers.get(providerId);
    if (!budget || budget.maxDailyRequests <= 0) return false;

    this.ensureCurrentDay(budget);
    return budget.stats.requests >= budget.maxDailyRequests;
  }

  /**
   * Get remaining budget info for a provider.
   */
  getRemainingBudget(providerId: string): {
    remaining: number;
    limit: number;
    used: number;
    percentUsed: number;
  } {
    const budget = this.providers.get(providerId);
    if (!budget || budget.maxDailyRequests <= 0) {
      return { remaining: Infinity, limit: 0, used: 0, percentUsed: 0 };
    }

    this.ensureCurrentDay(budget);
    const used = budget.stats.requests;
    const remaining = Math.max(0, budget.maxDailyRequests - used);
    const percentUsed = Math.round((used / budget.maxDailyRequests) * 100);

    return { remaining, limit: budget.maxDailyRequests, used, percentUsed };
  }

  /**
   * Get full daily summary for a provider (for diagnostics/API endpoint).
   */
  getDailySummary(providerId: string): {
    date: string;
    requests: number;
    totalTokens: number;
    limit: number;
    percentUsed: number;
    overBudget: boolean;
    models: Array<{ modelId: string; requests: number; tokens: number }>;
  } | null {
    const budget = this.providers.get(providerId);
    if (!budget) return null;

    this.ensureCurrentDay(budget);

    const models: Array<{ modelId: string; requests: number; tokens: number }> = [];
    for (const [modelId, stats] of budget.stats.byModel) {
      models.push({ modelId, ...stats });
    }
    models.sort((a, b) => b.requests - a.requests);

    return {
      date: budget.stats.date,
      requests: budget.stats.requests,
      totalTokens: budget.stats.totalTokens,
      limit: budget.maxDailyRequests,
      percentUsed: budget.maxDailyRequests > 0
        ? Math.round((budget.stats.requests / budget.maxDailyRequests) * 100)
        : 0,
      overBudget: this.isOverBudget(providerId),
      models,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private createEmptyStats(): DailyStats {
    return {
      date: this.today(),
      requests: 0,
      totalTokens: 0,
      byModel: new Map(),
    };
  }

  private ensureCurrentDay(budget: ProviderBudget): void {
    const today = this.today();
    if (budget.stats.date !== today) {
      // New day — reset stats
      budget.stats = this.createEmptyStats();
      budget.alertFired = false;
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: BudgetTracker | null = null;

export function getBudgetTracker(): BudgetTracker {
  if (!_instance) {
    _instance = new BudgetTracker();
  }
  return _instance;
}
