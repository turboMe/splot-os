#!/usr/bin/env tsx
/**
 * Analytics V2 domain gate.
 *
 * This is deliberately offline: it exercises the real schema drift as fixtures
 * and verifies the registered pipeline/tool contracts without touching Mongo.
 * The drift encoded here was observed in production-shaped local data:
 * - RSS lives in rss_intelligence and its dates are strings,
 * - CRM history has draft/status actions but no email/response/meeting events,
 * - CRM has no partner conversion status,
 * - workflow_runs documents may have neither startedAt nor status.
 *
 * Run: npx tsx src/mastra/scripts/check-analytics-domain.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildCrmTrendMetrics,
  buildEqualComparisonWindows,
  buildRssTopicComparison,
  buildWorkflowComparisons,
  compareMetric,
  type AnalyticsLeadDocument,
  type AnalyticsRssArticle,
} from '../tools/analytics/analytics-collectors.js';

const AGENT_PATH = 'src/mastra/agents/analytics-agent.ts';
const COLLECTORS_PATH = 'src/mastra/tools/analytics/analytics-collectors.ts';
const TOOLS_PATH = 'src/mastra/tools/analytics/analytics-tools.ts';
const PIPELINE_PATH = 'src/mastra/prompts/analytics/pipeline.md';

const agentSource = readFileSync(AGENT_PATH, 'utf8');
const collectorsSource = readFileSync(COLLECTORS_PATH, 'utf8');
const toolsSource = readFileSync(TOOLS_PATH, 'utf8');
const pipelineSource = readFileSync(PIPELINE_PATH, 'utf8');

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

// Registration and prompt composition are part of the capability, not merely
// dead source files.
assert.match(
  agentSource,
  /combinePrompts\('analytics\/base', 'analytics\/pipeline'\)/,
  'analytics-agent must load the V2 pipeline after its base prompt',
);
for (const toolName of [
  'analyticsCollectWeeklyTool',
  'analyticsCollectRoiTool',
  'analyticsCollectTrendsTool',
]) {
  assert.match(agentSource, new RegExp(`\\b${toolName}\\b`), `${toolName} is not registered`);
}
assert.doesNotMatch(
  agentSource,
  /\b(?:addContextTool|pushSignalTool)\b/,
  'analysis_report-only agent must not expose write/signal tools',
);

for (const toolId of [
  'analytics_collect_weekly',
  'analytics_collect_roi',
  'analytics_collect_trends',
]) {
  assert.match(toolsSource, new RegExp(`id: '${toolId}'`), `missing createTool id ${toolId}`);
}
assert.equal(countMatches(toolsSource, /strict:\s*true/g), 3, 'all analytics tools must use strict inputs');
assert.equal(
  countMatches(toolsSource, /\.\.\.readOnlyAnnotations/g),
  3,
  'all analytics tools must apply the read-only MCP annotations',
);
assert.match(toolsSource, /readOnlyHint:\s*true/);
assert.match(toolsSource, /destructiveHint:\s*false/);
assert.match(toolsSource, /idempotentHint:\s*true/);
assert.match(toolsSource, /outputSchema:\s*collectorOutputSchema/);

// Correct data plane and read-only enforcement. The explicit conversion is
// required because production-shaped RSS pubDate/publishedAt fields are strings.
assert.match(collectorsSource, /getRssDb\(\)/, 'RSS must use the dedicated database helper');
assert.match(collectorsSource, /rssDb\.collection<AnalyticsRssArticle>\('rss_articles'\)/);
assert.match(collectorsSource, /\$convert:/, 'RSS string dates must be converted before window matching');
assert.match(collectorsSource, /rss_intelligence\.rss_articles/);
assert.match(
  collectorsSource,
  /parseDate\(entry\.timestamp\) \?\? parseDate\(entry\.ts\)/,
  'CRM history windows must support both timestamp and live/legacy ts',
);
assert.doesNotMatch(
  collectorsSource,
  /\.(?:insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite)\s*\(/,
  'analytics collectors must stay read-only',
);

for (const contractFragment of [
  'analysis_report',
  'N/A',
  'previous.to == current.from',
  'denominator',
  'provenance',
  'n<10',
  'headless',
  'rss_intelligence.rss_articles',
]) {
  assert.ok(pipelineSource.includes(contractFragment), `pipeline misses contract: ${contractFragment}`);
}
assert.match(pipelineSource, /Nie wywołuj `addContextTool`, `pushSignalTool`/);

const asOf = new Date('2026-08-10T12:00:00.000Z');
const windows = buildEqualComparisonWindows(14, asOf);
const windowMs = 14 * 24 * 60 * 60 * 1_000;

assert.equal(windows.previous.to, windows.current.from, 'windows must be adjacent');
assert.equal(new Date(windows.current.to).getTime() - new Date(windows.current.from).getTime(), windowMs);
assert.equal(new Date(windows.previous.to).getTime() - new Date(windows.previous.from).getTime(), windowMs);
assert.ok(
  new Date(windows.previous.to).getTime() <= new Date(windows.current.from).getTime(),
  'windows must not overlap',
);
assert.throws(() => buildEqualComparisonWindows(0, asOf), /between 1 and 365/);
assert.throws(() => buildEqualComparisonWindows(366, asOf), /between 1 and 365/);

// CRM fixture mirrors the real vocabulary drift: mixed Date/string createdAt,
// draft/note/status events, and statuses unrelated to partner conversion.
const leads: AnalyticsLeadDocument[] = [
  {
    createdAt: new Date('2026-08-03T09:00:00.000Z'),
    status: 'draft_gotowy',
    region: 'Dolnośląskie',
    segment: 'producer',
    history: [
      { action: 'draft_recorded', timestamp: new Date('2026-08-04T09:00:00.000Z') },
      {
        action: 'status_change',
        timestamp: new Date('2026-08-05T09:00:00.000Z'),
        toStatus: 'research_enriched',
      },
    ],
  },
  {
    createdAt: '2026-07-30T10:00:00.000Z',
    status: 'research_enriched',
    region: 'Mazowieckie',
    segment: 'distributor',
    // Live/legacy drift: this entry has only `ts`, not `timestamp`.
    history: [{ action: 'note', ts: '2026-07-31T10:00:00.000Z' }],
  },
  {
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    status: 'research_needed',
    region: 'Dolnośląskie',
    segment: 'producer',
    history: [{ action: 'lead_created', timestamp: new Date('2026-07-20T10:00:00.000Z') }],
  },
];

const crm = buildCrmTrendMetrics(leads, windows);
assert.equal(crm.newLeads.current.value, 2);
assert.equal(crm.newLeads.previous.value, 1);
assert.equal(crm.interactions.current.value, 3);
assert.equal(crm.interactions.previous.value, 1);
for (const metric of [crm.emailsSent, crm.responses, crm.meetings, crm.partnerConversions]) {
  assert.equal(metric.current.status, 'unavailable');
  assert.equal(metric.current.value, null, `${metric.metric} must be N/A, not zero`);
  assert.equal(metric.previous.value, null, `${metric.metric} previous must be N/A, not zero`);
  assert.equal(metric.percentDelta, null);
}
assert.deepEqual(crm.byRegion.current, { Dolnośląskie: 1, Mazowieckie: 1 });
assert.deepEqual(crm.byRegion.previous, { Dolnośląskie: 1 });

// A production-shaped workflow_runs document lacks the legacy startedAt/status
// fields, so both count and error-rate are unavailable rather than zero.
const workflowMetrics = buildWorkflowComparisons([{ workflowId: 'legacy-run-shape' }], windows);
assert.equal(workflowMetrics.runs.current.status, 'unavailable');
assert.equal(workflowMetrics.runs.current.value, null);
assert.equal(workflowMetrics.errorRate.current.status, 'unavailable');
assert.equal(workflowMetrics.errorRate.current.value, null);

// RSS fixture uses both real string date formats and asserts each window's
// denominator. The boundary document belongs to current, never to both windows.
const rssArticles: AnalyticsRssArticle[] = [
  {
    pubDate: 'Tue, 04 Aug 2026 10:00:00 GMT',
    title: 'Nowa restauracja wybiera lokalny produkt',
  },
  {
    publishedAt: windows.current.from,
    title: 'Technologia dla rynku HoReCa',
  },
  {
    publishedAt: '2026-07-20T10:00:00.000Z',
    title: 'Gastronomia i ceny żywności',
  },
];
const rss = buildRssTopicComparison(rssArticles, windows, {
  dateFieldObserved: true,
  collectionDocuments: 11_356,
});
assert.equal(rss.status, 'available');
assert.equal(rss.totalArticles.current.value, 2);
assert.equal(rss.totalArticles.previous.value, 1);
const restaurantTopic = rss.topics.find((topic) => topic.keyword === 'restauracja');
assert.ok(restaurantTopic, 'expected restaurant keyword in RSS topics');
assert.deepEqual(restaurantTopic.denominator, { currentArticles: 2, previousArticles: 1 });

const unreadableRss = buildRssTopicComparison(
  [{ pubDate: 'not-a-date', title: 'restauracja' }],
  windows,
  { dateFieldObserved: false, collectionDocuments: 1 },
);
assert.equal(unreadableRss.status, 'unavailable');
assert.equal(unreadableRss.totalArticles.current.value, null, 'unobservable RSS must be N/A, not zero');

const availableCount = (value: number) => ({
  status: 'available' as const,
  value,
  unit: 'count' as const,
  source: 'fixture',
  sampleSize: 1,
  denominator: null,
  reason: null,
});
const zeroBaseline = compareMetric('zeroBaseline', availableCount(5), availableCount(0));
assert.equal(zeroBaseline.absoluteDelta, 5);
assert.equal(zeroBaseline.percentDelta, null);
assert.equal(zeroBaseline.percentDeltaReason, 'previous_value_is_zero');

console.log('check:analytics-domain PASS');
console.log('  ✓ three strict read-only tools are registered behind the V2 pipeline');
console.log('  ✓ two equal non-overlapping windows and zero-baseline semantics hold');
console.log('  ✓ real CRM/workflow drift stays unavailable (N/A), never false zero');
console.log('  ✓ RSS string dates use rss_intelligence with explicit denominators');
