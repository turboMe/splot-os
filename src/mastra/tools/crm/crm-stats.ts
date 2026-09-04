/**
 * CRM Stats & Aggregation Tool (`crm_get_stats`)
 *
 * Provides instant lead counts, facet breakdowns (by segment, status, region,
 * country, subsegment), and human-readable Markdown summary tables in a single
 * fast MongoDB aggregation query.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import {
  CRM_STATUSES,
  CRM_SEGMENTS,
  normalizeCrmLead,
  literalRegex,
  optionalString,
  buildCountryMatcher,
  type CrmStatus,
  type CrmLeadResult,
} from './search-leads.js';

export interface CrmStatsFilterInput {
  country?: string;
  region?: string;
  city?: string;
  segment?: string;
  subsegment?: string;
  status?: CrmStatus;
  tags?: string[];
  hasEmail?: boolean;
  hasPhone?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}

export function buildCrmStatsFilter(input: CrmStatsFilterInput): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const andClauses: Record<string, unknown>[] = [];

  const country = optionalString(input.country);
  const region = optionalString(input.region);
  const city = optionalString(input.city);
  const segment = optionalString(input.segment);
  const subsegment = optionalString(input.subsegment);

  if (region) filter.region = literalRegex(region);
  if (segment) filter.segment = segment;
  if (input.status) filter.status = input.status;

  if (Array.isArray(input.tags) && input.tags.length > 0) {
    filter.tags = { $in: input.tags };
  }

  if (input.hasEmail === true) {
    filter.email = { $exists: true, $ne: null, $nin: ['', 'null'] };
  } else if (input.hasEmail === false) {
    andClauses.push({
      $or: [
        { email: { $exists: false } },
        { email: null },
        { email: '' },
      ],
    });
  }

  if (input.hasPhone === true) {
    filter.phone = { $exists: true, $ne: null, $nin: ['', 'null'] };
  } else if (input.hasPhone === false) {
    andClauses.push({
      $or: [
        { phone: { $exists: false } },
        { phone: null },
        { phone: '' },
      ],
    });
  }

  if (input.createdAfter || input.createdBefore) {
    const createdAtFilter: Record<string, Date> = {};
    if (input.createdAfter) {
      const d = new Date(input.createdAfter);
      if (!Number.isNaN(d.getTime())) createdAtFilter.$gte = d;
    }
    if (input.createdBefore) {
      const d = new Date(input.createdBefore);
      if (!Number.isNaN(d.getTime())) createdAtFilter.$lte = d;
    }
    if (Object.keys(createdAtFilter).length > 0) {
      filter.createdAt = createdAtFilter;
    }
  }

  if (input.updatedAfter || input.updatedBefore) {
    const updatedAtFilter: Record<string, Date> = {};
    if (input.updatedAfter) {
      const d = new Date(input.updatedAfter);
      if (!Number.isNaN(d.getTime())) updatedAtFilter.$gte = d;
    }
    if (input.updatedBefore) {
      const d = new Date(input.updatedBefore);
      if (!Number.isNaN(d.getTime())) updatedAtFilter.$lte = d;
    }
    if (Object.keys(updatedAtFilter).length > 0) {
      filter.updatedAt = updatedAtFilter;
    }
  }

  if (subsegment) {
    andClauses.push({
      $or: [
        { subsegment },
        { 'metadata.subsegment': subsegment },
        { tags: subsegment },
      ],
    });
  }

  if (country) {
    andClauses.push({
      $or: buildCountryMatcher(country),
    });
  }

  if (city) {
    andClauses.push({
      $or: [
        { city: literalRegex(city) },
        { 'metadata.city': literalRegex(city) },
        { address: literalRegex(city) },
        { region: literalRegex(city) },
      ],
    });
  }

  if (andClauses.length === 1) {
    Object.assign(filter, andClauses[0]);
  } else if (andClauses.length > 1) {
    filter.$and = andClauses;
  }

  return filter;
}

const latestInteractionSchema = z.object({
  timestamp: z.string().optional(),
  action: z.string().optional(),
  description: z.string().optional(),
  agentId: z.string().optional(),
});

const leadSampleSchema = z.object({
  id: z.string().optional(),
  companyName: z.string().optional(),
  email: z.string().optional(),
  contactName: z.string().optional(),
  status: z.string().optional(),
  region: z.string().optional(),
  segment: z.string().optional(),
  lastInteractionAt: z.string().optional(),
  latestInteraction: latestInteractionSchema.optional(),
  website: z.string().optional(),
});

export const crmGetStatsTool = createTool({
  id: 'crm_get_stats',
  description:
    'Instant CRM analytics and lead counts. Use whenever the user or agent asks for numbers, lead counts (e.g. by country, region, segment, status), pipeline distributions, or database summaries. Performs fast aggregation in 1 query.',
  inputSchema: z.object({
    country: z.string().optional().describe('Country name or code, e.g. "Poland", "PL", "Islandia", "IS", "DE"'),
    region: z.string().optional().describe('Region / voivodeship, e.g. "Mazowieckie", "Pomorskie"'),
    city: z.string().optional().describe('City name, e.g. "Warszawa", "Kraków", "Gdańsk"'),
    segment: z.string().optional().describe(`Exact segment: ${CRM_SEGMENTS.join(' | ')}`),
    subsegment: z.string().optional().describe('Subsegment, e.g. "kuchnia", "sala", "marketing_gastro", "menu_food_cost"'),
    status: z.enum(CRM_STATUSES).optional().describe('Lead status in the CRM'),
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    hasEmail: z.boolean().optional().describe('Filter leads with/without email'),
    hasPhone: z.boolean().optional().describe('Filter leads with/without phone number'),
    createdAfter: z.string().optional().describe('ISO date (e.g. 2026-08-01) for leads created after'),
    createdBefore: z.string().optional().describe('ISO date for leads created before'),
    updatedAfter: z.string().optional().describe('ISO date for leads updated after'),
    updatedBefore: z.string().optional().describe('ISO date for leads updated before'),
    groupBy: z
      .enum(['all', 'segment', 'status', 'region', 'country', 'subsegment', 'none'])
      .optional()
      .default('all')
      .describe('Grouping dimension for breakdown (default "all" returns segment, status, region, and subsegment breakdowns)'),
    includeSample: z.boolean().optional().default(true).describe('Include a small sample of recent matching leads'),
    sampleLimit: z.number().int().min(1).max(20).optional().default(5).describe('Number of sample leads (default 5, max 20)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    totalCount: z.number().describe('Total number of matching leads'),
    filterApplied: z.record(z.string(), z.unknown()),
    breakdown: z.record(z.string(), z.number()).describe('Counts broken down by the primary groupBy choice'),
    segmentBreakdown: z.record(z.string(), z.number()).describe('Counts by segment'),
    statusBreakdown: z.record(z.string(), z.number()).describe('Counts by pipeline status'),
    regionBreakdown: z.record(z.string(), z.number()).describe('Counts by region (top 15)'),
    subsegmentBreakdown: z.record(z.string(), z.number()).describe('Counts by subsegment (top 15)'),
    sampleLeads: z.array(leadSampleSchema),
    summaryMarkdown: z.string().describe('Clean Markdown summary table ready for chat presentation'),
    error: z.string().optional(),
  }),
  execute: async (context: any) => {
    try {
      const input =
        context && typeof context === 'object' && 'context' in context && context.context
          ? context.context
          : context || {};

      const db = await getDb();
      const collection = db.collection('leads');
      const matchFilter = buildCrmStatsFilter(input);
      const totalCount = await collection.countDocuments(matchFilter);

      const sampleLimit = Math.max(1, Math.min(20, input.sampleLimit ?? 5));
      const includeSample = input.includeSample !== false;

      const facetPipeline: any[] = [
        { $match: matchFilter },
        {
          $facet: {
            bySegment: [
              { $group: { _id: { $ifNull: ['$segment', 'unassigned'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byStatus: [
              { $group: { _id: { $ifNull: ['$status', 'unknown'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byRegion: [
              { $group: { _id: { $ifNull: ['$region', 'unspecified'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 15 },
            ],
            bySubsegment: [
              { $group: { _id: { $ifNull: ['$subsegment', 'unassigned'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 15 },
            ],
            samples: includeSample
              ? [
                  { $sort: { lastInteractionAt: -1, updatedAt: -1, _id: -1 } },
                  { $limit: sampleLimit },
                ]
              : [{ $limit: 1 }],
          },
        },
      ];

      const facetResult =
        totalCount > 0
          ? await collection.aggregate(facetPipeline).toArray()
          : [{ bySegment: [], byStatus: [], byRegion: [], bySubsegment: [], samples: [] }];

      const facetData = facetResult[0] || {
        bySegment: [],
        byStatus: [],
        byRegion: [],
        bySubsegment: [],
        samples: [],
      };

      const segmentBreakdown: Record<string, number> = Object.fromEntries(
        (facetData.bySegment || []).map((item: any) => [String(item._id), Number(item.count)]),
      );
      const statusBreakdown: Record<string, number> = Object.fromEntries(
        (facetData.byStatus || []).map((item: any) => [String(item._id), Number(item.count)]),
      );
      const regionBreakdown: Record<string, number> = Object.fromEntries(
        (facetData.byRegion || []).map((item: any) => [String(item._id), Number(item.count)]),
      );
      const subsegmentBreakdown: Record<string, number> = Object.fromEntries(
        (facetData.bySubsegment || []).map((item: any) => [String(item._id), Number(item.count)]),
      );

      const sampleLeads: CrmLeadResult[] = includeSample && Array.isArray(facetData.samples)
        ? facetData.samples.map((lead: Record<string, unknown>) => normalizeCrmLead(lead))
        : [];

      let primaryBreakdown: Record<string, number> = {};
      const groupBy = input.groupBy || 'all';
      if (groupBy === 'segment') primaryBreakdown = segmentBreakdown;
      else if (groupBy === 'status') primaryBreakdown = statusBreakdown;
      else if (groupBy === 'region') primaryBreakdown = regionBreakdown;
      else if (groupBy === 'subsegment') primaryBreakdown = subsegmentBreakdown;
      else if (groupBy === 'all') primaryBreakdown = { ...segmentBreakdown };

      // Markdown synthesis
      let summaryMarkdown = `### 📊 CRM Leads Analytics\n\n- **Łączna liczba pasujących kontaktów / leadów**: **${totalCount}**\n`;
      if (input.country) summaryMarkdown += `- **Filtr kraju**: \`${input.country}\`\n`;
      if (input.region) summaryMarkdown += `- **Filtr regionu**: \`${input.region}\`\n`;
      if (input.city) summaryMarkdown += `- **Filtr miasta**: \`${input.city}\`\n`;
      if (input.segment) summaryMarkdown += `- **Filtr segmentu**: \`${input.segment}\`\n`;
      if (input.subsegment) summaryMarkdown += `- **Filtr podsegmentu**: \`${input.subsegment}\`\n`;
      if (input.status) summaryMarkdown += `- **Filtr statusu**: \`${input.status}\`\n`;

      if (Object.keys(segmentBreakdown).length > 0) {
        summaryMarkdown += '\n#### 📁 Rozkład wg segmentów\n| Segment | Liczba leadów |\n|---|---:|\n';
        for (const [seg, count] of Object.entries(segmentBreakdown)) {
          summaryMarkdown += `| \`${seg}\` | **${count}** |\n`;
        }
      }

      if (Object.keys(statusBreakdown).length > 0) {
        summaryMarkdown += '\n#### 🔄 Rozkład wg statusów w lejku\n| Status | Liczba leadów |\n|---|---:|\n';
        for (const [st, count] of Object.entries(statusBreakdown)) {
          summaryMarkdown += `| \`${st}\` | **${count}** |\n`;
        }
      }

      if (Object.keys(regionBreakdown).length > 0 && (groupBy === 'all' || groupBy === 'region')) {
        summaryMarkdown += '\n#### 📍 Rozkład geograficzny (top regiony)\n| Region | Liczba leadów |\n|---|---:|\n';
        for (const [reg, count] of Object.entries(regionBreakdown)) {
          summaryMarkdown += `| ${reg} | **${count}** |\n`;
        }
      }

      if (sampleLeads.length > 0) {
        summaryMarkdown += '\n#### 🔍 Przykładowe rekordy\n';
        for (const sample of sampleLeads) {
          const name = sample.companyName || sample.contactName || sample.id || 'Nienazwany lead';
          const loc = [sample.region, sample.segment].filter(Boolean).join(' • ');
          summaryMarkdown += `- **${name}** (${sample.status || 'brak statusu'})${loc ? ` — *${loc}*` : ''}${sample.email ? ` [${sample.email}]` : ''}\n`;
        }
      }

      return {
        success: true,
        totalCount,
        filterApplied: matchFilter,
        breakdown: primaryBreakdown,
        segmentBreakdown,
        statusBreakdown,
        regionBreakdown,
        subsegmentBreakdown,
        sampleLeads,
        summaryMarkdown,
      };
    } catch (error) {
      return {
        success: false,
        totalCount: 0,
        filterApplied: {},
        breakdown: {},
        segmentBreakdown: {},
        statusBreakdown: {},
        regionBreakdown: {},
        subsegmentBreakdown: {},
        sampleLeads: [],
        summaryMarkdown: `❌ Błąd pobierania statystyk CRM: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  },
});
