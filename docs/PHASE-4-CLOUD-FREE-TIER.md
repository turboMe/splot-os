# Phase 4 — Cloud Free Tier + Budget

> Status: ✅ Complete | 4.1 ✅ | 4.2 ✅ | 4.3 ✅ | Completed: 2026-05-09

## Overview

Phase 4 adds OpenRouter's free-tier models as a zero-cost cloud layer between
local models and paid cloud APIs. This gives the system more routing options
without spending money, while protecting against rate limits and overuse.

## Architecture

```
SmartRouter model selection flow:
  1. local-micro    (qwen3:1.7b, etc.)     — free, VRAM needed
  2. local-light    (gemma3:4b, gemma4:e4b) — free, VRAM needed
  3. local-heavy    (qwen3-coder:30b, etc.) — free, GPU intensive
  4. cloud-free ★   (OpenRouter free tier)  — free, no VRAM, rate limited
  5. cloud-fast     (GPT-5.3 Mini, etc.)    — paid
  6. cloud-pro      (Gemini 2.5 Pro, etc.)  — expensive

Guard rails:
  ├→ Circuit Breaker: blocks model after 3 consecutive failures (5min cooldown)
  ├→ Budget Tracker:  blocks cloud-free after daily limit (default: 200 req/day)
  └→ Escalation Path: cloud-free → cloud-fast → cloud-pro
```

## 4.1 OpenRouter Free Tier ✅

### New File: `lib/openrouter-gateway.ts`

OpenRouter gateway using `MastraModelGateway` (same pattern as `OllamaGateway`).
- Uses `@ai-sdk/openai-compatible` with `baseURL: https://openrouter.ai/api/v1`
- Activates only when `OPENROUTER_API_KEY` env var is set
- Registers curated free models grouped by provider namespace
- Sends `HTTP-Referer` and `X-OpenRouter-Title` headers per OpenRouter requirements

### Models Registered (cloud-free tier)

| Model ID | Name | Max Complexity | Strengths |
|----------|------|---------------|-----------|
| `openrouter/nvidia/nemotron-3-super-120b-a12b:free` | Nemotron Super 120B | moderate | reasoning, planning, JSON |
| `openrouter/nvidia/nemotron-3-nano-30b-a3b:free` | Nemotron Nano 30B | simple | classification, routing |
| `openrouter/poolside/laguna-m.1:free` | Poolside Laguna M.1 | moderate | code generation, TypeScript |
| `openrouter/inclusionai/ring-2.6-1t:free` | InclusionAI Ring 2.6 | moderate | reasoning, analysis |

### Escalation Path Updated

```
local-micro  → local-light → local-heavy → cloud-free → cloud-fast → cloud-pro
local-heavy  → cloud-free  → cloud-fast  → cloud-pro
cloud-free   → cloud-fast  → cloud-pro
```

### Design Decisions from Research

| OpenRouter Feature | Our Usage |
|-------------------|-----------|
| `models: [...]` fallback | Not used at gateway level — our SmartRouter handles fallback |
| `provider.require_parameters: true` | Important for JSON mode — set when needed |
| `provider.data_collection: "deny"` | Should be set for code-containing requests |
| `openrouter/free` | NOT used — unpredictable model selection |
| `openrouter/auto` | NOT used — can incur costs |
| OpenAI SDK compatibility | Used via `@ai-sdk/openai-compatible` |

## 4.2 Circuit Breaker ✅

### New File: `services/circuit-breaker.ts`

Prevents cascading failures when a model is rate-limited or down.

| Config | Value | Notes |
|--------|-------|-------|
| Threshold | 3 consecutive failures | Before opening circuit |
| Reset time | 5 minutes | After which half-open probe is allowed |
| States | CLOSED → OPEN → HALF-OPEN | Standard circuit breaker pattern |

### Integration Points

1. **`smart-router.ts`**: `selectModel()` skips models with open circuits
2. **`subtask-executor.ts`**: Records success/failure after each execution
3. **Diagnostics**: `getOpenCircuits()` returns all blocked models

## 4.3 Budget Tracker ✅

### New File: `services/budget-tracker.ts`

Tracks daily API usage per provider with configurable limits.

| Config | Default | Override |
|--------|---------|----------|
| Daily request limit | 200 | `OPENROUTER_DAILY_LIMIT` env var |
| Alert threshold | 80% | Logs warning when reached |
| Reset | Automatic at midnight | Date-based (YYYY-MM-DD) |

### Integration Points

1. **`smart-router.ts`**: Skips `cloud-free` models when `isOverBudget('openrouter')` is true
2. **`subtask-executor.ts`**: Records requests for `openrouter/` models after execution
3. **Diagnostics**: `getDailySummary('openrouter')` returns per-model breakdown

## Diagnostics Endpoint

```
GET /deploy/cloud-free-status
```

Returns:
```json
{
  "budget": {
    "date": "2026-05-09",
    "requests": 42,
    "totalTokens": 15000,
    "limit": 200,
    "percentUsed": 21,
    "overBudget": false,
    "models": [
      { "modelId": "openrouter/nvidia/nemotron...", "requests": 30, "tokens": 12000 }
    ]
  },
  "circuitBreakers": [],
  "timestamp": "2026-05-09T15:47:00Z"
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key |
| `OPENROUTER_DAILY_LIMIT` | No | `200` | Max daily requests |

## Files Summary

### New Files

| File | Purpose |
|------|---------|
| `lib/openrouter-gateway.ts` | OpenRouter MastraModelGateway implementation |
| `services/circuit-breaker.ts` | Model health circuit breaker |
| `services/budget-tracker.ts` | Daily request budget tracking |

### Modified Files

| File | Change |
|------|--------|
| `config/model-capabilities.ts` | Added `cloud-free` tier + 4 OpenRouter models |
| `services/smart-router.ts` | Circuit breaker + budget checks in `selectModel()` |
| `services/subtask-executor.ts` | Circuit breaker + budget recording after execution |
| `index.ts` | OpenRouter gateway registration + diagnostics endpoint |

## Verification

All code compiles cleanly: `npx tsc --noEmit` → 0 errors.
