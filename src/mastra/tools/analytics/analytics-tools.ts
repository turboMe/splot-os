import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  collectRoiAnalytics,
  collectTrendAnalytics,
  collectWeeklyAnalytics,
} from './analytics-collectors.js';

const asOfSchema = z.string().datetime().optional().describe(
  'Optional ISO-8601 cutoff. Omit for now. Supplying it makes a replay deterministic.',
);

const collectorOutputSchema = z.object({
  success: z.boolean(),
  report: z.record(z.string(), z.unknown()).nullable().describe(
    'Read-only deterministic report with two windows, metric availability, provenance and denominators.',
  ),
  error: z.string().nullable(),
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const analyticsCollectWeeklyTool = createTool({
  id: 'analytics_collect_weekly',
  description:
    'MUST-CALL deterministic, read-only collector for a weekly analytics report. ' +
    'Reads real CRM leads/history, shared signals and agent_events; compares two equal adjacent, non-overlapping periods. ' +
    'Every metric carries availability, source, sample size and any denominator. Missing CRM actions or fields return unavailable/N/A, never a fabricated zero.',
  strict: true,
  inputSchema: z.object({
    periodDays: z.number().int().min(1).max(365).default(7)
      .describe('Length of EACH comparison window in days. Default 7; maximum 365.'),
    asOf: asOfSchema,
  }),
  outputSchema: collectorOutputSchema,
  mcp: {
    annotations: {
      title: 'Collect weekly analytics',
      ...readOnlyAnnotations,
    },
  },
  execute: async ({ periodDays, asOf }) => {
    try {
      return {
        success: true,
        report: await collectWeeklyAnalytics({ periodDays: periodDays ?? 7, asOf }),
        error: null,
      };
    } catch (error) {
      return { success: false, report: null, error: errorMessage(error) };
    }
  },
});

export const analyticsCollectRoiTool = createTool({
  id: 'analytics_collect_roi',
  description:
    'MUST-CALL deterministic, read-only collector for ROI and funnel analysis. ' +
    'Uses real leads/history, agent_events token telemetry and workflow_runs across two equal adjacent windows. ' +
    'Revenue, conversion, response rate or ROI remain unavailable when their event/status vocabulary or denominator is missing; they are never coerced to zero.',
  strict: true,
  inputSchema: z.object({
    periodDays: z.number().int().min(1).max(365).default(30)
      .describe('Length of EACH comparison window in days. Default 30; maximum 365.'),
    asOf: asOfSchema,
    avgDealValuePLN: z.number().positive().max(1_000_000).default(5_000)
      .describe('Explicit revenue assumption per observed partner conversion in PLN.'),
    exchangeRatePLNPerUSD: z.number().positive().max(100).default(4)
      .describe('Explicit PLN per USD assumption used only to convert observed system cost.'),
  }),
  outputSchema: collectorOutputSchema,
  mcp: {
    annotations: {
      title: 'Collect ROI analytics',
      ...readOnlyAnnotations,
    },
  },
  execute: async ({ periodDays, asOf, avgDealValuePLN, exchangeRatePLNPerUSD }) => {
    try {
      return {
        success: true,
        report: await collectRoiAnalytics({
          periodDays: periodDays ?? 30,
          asOf,
          avgDealValuePLN: avgDealValuePLN ?? 5_000,
          exchangeRatePLNPerUSD: exchangeRatePLNPerUSD ?? 4,
        }),
        error: null,
      };
    } catch (error) {
      return { success: false, report: null, error: errorMessage(error) };
    }
  },
});

export const analyticsCollectTrendsTool = createTool({
  id: 'analytics_collect_trends',
  description:
    'MUST-CALL deterministic, read-only collector for CRM, RSS, workflow and system trends. ' +
    'Reads RSS from the dedicated rss_intelligence database and converts real string publishedAt/pubDate fields before windowing. ' +
    'Returns two equal adjacent windows, bounded top topics, source provenance, sample sizes and explicit unavailable values.',
  strict: true,
  inputSchema: z.object({
    periodDays: z.number().int().min(1).max(365).default(14)
      .describe('Length of EACH comparison window in days. Default 14; maximum 365.'),
    asOf: asOfSchema,
  }),
  outputSchema: collectorOutputSchema,
  mcp: {
    annotations: {
      title: 'Collect trend analytics',
      ...readOnlyAnnotations,
    },
  },
  execute: async ({ periodDays, asOf }) => {
    try {
      return {
        success: true,
        report: await collectTrendAnalytics({ periodDays: periodDays ?? 14, asOf }),
        error: null,
      };
    } catch (error) {
      return { success: false, report: null, error: errorMessage(error) };
    }
  },
});
