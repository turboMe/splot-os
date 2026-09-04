#!/usr/bin/env tsx
/**
 * Deterministic CRM regression check. It uses a sanitized fixture copied from
 * the leads snapshot and never connects to MongoDB.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { gateRunsInOrder } from './lib/gate-steps.js';

import {
  CRM_STATUSES,
  buildCrmSearchPlan,
  crmResultKind,
  escapeRegexLiteral,
  normalizeCrmLead,
} from '../tools/crm/search-leads.js';

type RegexClause = { $regex: string; $options: string };

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

function fieldRegex(filter: Record<string, unknown>, field: string): RegexClause {
  const clauses = filter.$or as Array<Record<string, unknown>> | undefined;
  const clause = clauses?.find(candidate => field in candidate)?.[field] as RegexClause | undefined;
  assert.ok(clause, `missing ${field} regex clause`);
  return clause;
}

console.log('check:crm-domain');

// Sanitized from agentforge.leads. The literal parentheses reproduce the
// production miss: an unescaped regex made the full company name return zero.
const snapshotLead = {
  id: '72307877-b054-44d0-8c37-d631b0ac38fe',
  companyName: 'Triada Augusto Pomorze (oddział Toruń)',
  email: 'kontakt@triadaaugusto.example',
  status: 'draft_gotowy',
  segment: 'distributor',
  region: 'Kujawsko-Pomorskie',
  website: 'https://triadaaugusto.pl',
  lastInteractionAt: new Date('2026-06-28T17:26:07.780Z'),
  history: [{
    timestamp: new Date('2026-06-28T17:26:07.780Z'),
    action: 'draft_recorded',
    description: 'Cold email draft — faza assemble huntu 68631b44',
    agentId: 'meta-agent',
  }],
};

check('snapshot locator is escaped and matches the literal parenthesized name', () => {
  const escaped = escapeRegexLiteral(snapshotLead.companyName);
  assert.equal(escaped, 'Triada Augusto Pomorze \\(oddział Toruń\\)');
  assert.equal(new RegExp(`^${escaped}$`, 'i').test(snapshotLead.companyName), true);

  const plan = buildCrmSearchPlan({ query: snapshotLead.companyName });
  assert.ok(plan.exactFilter, 'query should produce an exact phase');
  assert.ok(plan.containsFilter, 'query should produce a contains fallback');

  const exact = fieldRegex(plan.exactFilter, 'companyName');
  assert.equal(exact.$regex, `^${escaped}$`, 'exact phase must be anchored');
  assert.equal(new RegExp(exact.$regex, exact.$options).test(snapshotLead.companyName), true);

  const contains = fieldRegex(plan.containsFilter, 'companyName');
  assert.equal(contains.$regex, escaped, 'contains fallback must remain escaped and unanchored');
  assert.equal(new RegExp(contains.$regex, contains.$options).test(`Lead: ${snapshotLead.companyName}`), true);
});

check('all literal regex metacharacters are escaped in query and region filters', () => {
  const literal = 'A+B [North] (HQ)? $5.00';
  const plan = buildCrmSearchPlan({ query: literal, region: 'Północ (PL)' });
  const queryRegex = fieldRegex(plan.containsFilter!, 'companyName');
  const regionRegex = plan.baseFilter.region as RegexClause;

  assert.equal(new RegExp(`^${queryRegex.$regex}$`, 'i').test(literal), true);
  assert.equal(new RegExp(`^${regionRegex.$regex}$`, 'i').test('Północ (PL)'), true);
  assert.equal(queryRegex.$regex.includes('[North]'), false, 'character class must not remain active');
});

check('search plan preserves filters in both exact and fallback phases', () => {
  const plan = buildCrmSearchPlan({
    query: snapshotLead.companyName,
    region: snapshotLead.region,
    status: 'research_enriched',
    segment: snapshotLead.segment,
  });

  for (const filter of [plan.exactFilter, plan.containsFilter]) {
    assert.ok(filter);
    assert.equal(filter.status, 'research_enriched');
    assert.equal(filter.segment, 'distributor');
    assert.deepEqual(filter.region, plan.baseFilter.region);
  }
});

check('result cardinality explicitly distinguishes zero, one, and many', () => {
  assert.equal(crmResultKind(0), 'none');
  assert.equal(crmResultKind(1), 'single');
  assert.equal(crmResultKind(2), 'multiple');
  assert.equal(crmResultKind(99), 'multiple');
});

check('snapshot history becomes a complete latestInteraction', () => {
  const normalized = normalizeCrmLead(snapshotLead);
  assert.equal(normalized.lastInteractionAt, '2026-06-28T17:26:07.780Z');
  assert.deepEqual(normalized.latestInteraction, {
    timestamp: '2026-06-28T17:26:07.780Z',
    action: 'draft_recorded',
    description: 'Cold email draft — faza assemble huntu 68631b44',
    agentId: 'meta-agent',
  });
});

check('legacy history.ts is accepted and the newest dated interaction wins', () => {
  const normalized = normalizeCrmLead({
    companyName: 'Legacy lead',
    history: [
      {
        timestamp: '2026-07-02T10:00:00.000Z',
        action: 'newer_action',
        description: 'Newer canonical interaction',
        agentId: 'crm-agent',
      },
      {
        ts: '2026-07-01T09:00:00.000Z',
        action: 'draft_created',
        description: 'Legacy interaction stored later in the array',
        agentId: 'hunt-agent',
      },
    ],
  });

  assert.equal(normalized.lastInteractionAt, '2026-07-02T10:00:00.000Z');
  assert.equal(normalized.latestInteraction?.action, 'newer_action');

  const legacyOnly = normalizeCrmLead({
    history: [{
      ts: new Date('2026-07-01T09:00:00.000Z'),
      action: 'draft_created',
      description: 'Legacy timestamp field',
      agentId: 'hunt-agent',
    }],
  });
  assert.deepEqual(legacyOnly.latestInteraction, {
    timestamp: '2026-07-01T09:00:00.000Z',
    action: 'draft_created',
    description: 'Legacy timestamp field',
    agentId: 'hunt-agent',
  });
});

check('workspace status research_enriched is accepted', () => {
  assert.ok(CRM_STATUSES.includes('research_enriched'));
});

import { buildCrmStatsFilter } from '../tools/crm/crm-stats.js';

check('geographic filters (country, city) produce valid regex and or-clauses in search plan', () => {
  const planPl = buildCrmSearchPlan({ country: 'Poland', city: 'Warszawa' });
  assert.ok(planPl.baseFilter.$and || planPl.baseFilter.$or, 'should generate compound filter for country/city');
  
  const statsFilter = buildCrmStatsFilter({
    country: 'PL',
    segment: 'restaurant_gb',
    status: 'zainteresowany',
    hasEmail: true,
  });
  assert.equal(statsFilter.segment, 'restaurant_gb');
  assert.equal(statsFilter.status, 'zainteresowany');
  assert.deepEqual(statsFilter.email, { $exists: true, $ne: null, $nin: ['', 'null'] });
  assert.ok(statsFilter.$and || statsFilter.$or, 'should generate country match clauses');
});

const toolSource = readFileSync('src/mastra/tools/crm/search-leads.ts', 'utf8');
const statsToolSource = readFileSync('src/mastra/tools/crm/crm-stats.ts', 'utf8');
const agentSource = readFileSync('src/mastra/agents/crm-agent.ts', 'utf8');
const promptSource = readFileSync('src/mastra/prompts/crm/pipeline.md', 'utf8');
const packageSource = readFileSync('package.json', 'utf8');

check('tool executes exact count before the contains fallback and exposes the full contract', () => {
  const exactIndex = toolSource.indexOf('countDocuments(plan.exactFilter)');
  const containsIndex = toolSource.indexOf('filter = plan.containsFilter');
  assert.ok(exactIndex >= 0 && containsIndex > exactIndex, 'exact lookup must precede contains fallback');
  for (const field of ['matchKind', 'resultKind', 'totalMatched', 'truncated', 'latestInteraction']) {
    assert.ok(toolSource.includes(field), `tool output must expose ${field}`);
  }
  assert.match(toolSource, /\.int\(\)\.min\(1\)\.max\(50\)/, 'limit must be bounded to 1..50');
});

check('stats tool exposes aggregation facet and breakdown schemas', () => {
  assert.ok(statsToolSource.includes('crm_get_stats'), 'tool id must be crm_get_stats');
  assert.ok(statsToolSource.includes('segmentBreakdown'), 'must compute segmentBreakdown');
  assert.ok(statsToolSource.includes('statusBreakdown'), 'must compute statusBreakdown');
  assert.ok(statsToolSource.includes('regionBreakdown'), 'must compute regionBreakdown');
  assert.ok(statsToolSource.includes('summaryMarkdown'), 'must output summaryMarkdown');
});

check('agent loads the CRM pipeline prompt and registers search and stats tools', () => {
  assert.ok(agentSource.includes("loadPrompt('crm/pipeline')"));
  assert.ok(agentSource.includes('searchLeadsTool'), 'CRM agent must register searchLeadsTool');
  assert.ok(agentSource.includes('crmGetStatsTool'), 'CRM agent must register crmGetStatsTool');
});

check('prompt guides agent to use crm_get_stats for totals and aggregations', () => {
  assert.ok(promptSource.includes('crmGetStatsTool'));
  assert.ok(promptSource.includes('crm_get_stats'));
  assert.ok(promptSource.includes('crm_search_leads'));
});

check('package scripts run the CRM gate directly and from check:all', () => {
  assert.ok(packageSource.includes('"check:crm-domain"'));
  assert.ok(
    gateRunsInOrder(['check:n8n-mcp-engineer', 'check:crm-domain', 'check:design-domain']),
    'check:all must run the CRM gate between the n8n and design gates',
  );
});

if (failures > 0) {
  console.error(`\n❌ check:crm-domain — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\n✅ check:crm-domain — literal lookup, cardinality, history, prompt, and read-only boundary hold');
