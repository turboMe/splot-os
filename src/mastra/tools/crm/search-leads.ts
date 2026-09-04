/**
 * CRM: read-only lead lookup backed by the shared MongoDB connection.
 *
 * A user-supplied locator is always treated as literal text. The lookup tries
 * an exact match first and only then falls back to a literal contains match.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';

// Re-exported, not restated: config/crm-statuses.ts owns the vocabulary, and
// the copies that used to live here, in workspace-service and in the dashboard
// drifted apart until a sent lead fell out of the board entirely.
export { CRM_STATUSES } from '../../config/crm-statuses.js';
import { CRM_STATUSES, type CrmStatus } from '../../config/crm-statuses.js';

export const CRM_SEGMENTS = [
  'supplier_gb',
  'restaurant_gb',
  'automation',
  'web_dev',
  'gastro_consulting',
  'consulting_recruitment',
  'career_it_pl',
  'career_it_is',
  'career_chef_pl',
  'career_chef_is',
  'other',
] as const;

export type { CrmStatus } from '../../config/crm-statuses.js';
export type CrmSegment = (typeof CRM_SEGMENTS)[number];
export type CrmMatchKind = 'exact' | 'contains' | 'filtered' | 'none';
export type CrmResultKind = 'none' | 'single' | 'multiple';

type MongoFilter = Record<string, unknown>;

export interface CrmSearchInput {
  query?: string;
  region?: string;
  status?: CrmStatus;
  segment?: string;
  subsegment?: string;
}

export interface CrmSearchPlan {
  baseFilter: MongoFilter;
  exactFilter?: MongoFilter;
  containsFilter?: MongoFilter;
}

export interface CrmLatestInteraction {
  timestamp?: string;
  action?: string;
  description?: string;
  agentId?: string;
}

export interface CrmLeadResult {
  id?: string;
  companyName?: string;
  email?: string;
  contactName?: string;
  status?: string;
  region?: string;
  segment?: string;
  lastInteractionAt?: string;
  latestInteraction?: CrmLatestInteraction;
  website?: string;
}

export const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const optionalDateString = (value: unknown): string | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === 'string') return optionalString(value);
  if (value && typeof (value as { toISOString?: unknown }).toISOString === 'function') {
    try {
      return (value as { toISOString: () => string }).toISOString();
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** Escape text before placing it in a MongoDB `$regex` string. */
export const escapeRegexLiteral = (value: string): string => (
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
);

export const literalRegex = (value: string, exact = false): Record<string, string> => {
  const escaped = escapeRegexLiteral(value);
  return {
    $regex: exact ? `^${escaped}$` : escaped,
    $options: 'i',
  };
};

export interface CrmSearchInput {
  query?: string;
  region?: string;
  country?: string;
  city?: string;
  status?: CrmStatus;
  segment?: string;
  subsegment?: string;
}

export function buildCountryMatcher(country: string): MongoFilter[] {
  const isPl = /^(pl|poland|polska)$/i.test(country);
  const isIs = /^(is|iceland|islandia|ísland)$/i.test(country);
  const clauses: MongoFilter[] = [
    { country: literalRegex(country) },
    { 'metadata.country': literalRegex(country) },
    { address: literalRegex(country) },
  ];

  if (isPl) {
    clauses.push(
      { country: { $regex: '^(pl|poland|polska)$', $options: 'i' } },
      { companyName: { $regex: '(poland|polska|sp\\. z o\\.o\\.|sp\\.k\\.)', $options: 'i' } },
      { email: { $regex: '\\.pl$', $options: 'i' } },
      { website: { $regex: '\\.pl(/.*)?$', $options: 'i' } },
      { segment: { $regex: '_pl$', $options: 'i' } },
      { region: { $regex: '(Polska|Poland|Mazowieckie|Wielkopolskie|Małopolskie|Śląskie|Dolnośląskie|Pomorskie|Kujawsko-Pomorskie|Lubelskie|Łódzkie|Lubuskie|Opolskie|Podkarpackie|Podlaskie|Świętokrzyskie|Warmińsko-Mazurskie|Zachodniopomorskie|Warszawa|Kraków|Wrocław|Poznań|Gdańsk|Katowice|Szczecin|Bydgoszcz|Lublin|Białystok|Gdynia|Toruń|Rzeszów|Kielce|Gliwice|Olsztyn|Bielsko-Biała|Zabrze|Rybnik|Tychy|Opole)', $options: 'i' } },
    );
  } else if (isIs) {
    clauses.push(
      { country: { $regex: '^(is|iceland|islandia|ísland)$', $options: 'i' } },
      { companyName: { $regex: '(iceland|ísland|ehf\\.)', $options: 'i' } },
      { email: { $regex: '\\.is$', $options: 'i' } },
      { website: { $regex: '\\.is(/.*)?$', $options: 'i' } },
      { segment: { $regex: '_is$', $options: 'i' } },
      { region: { $regex: '(Iceland|Islandia|Ísland|Reykjavík|Reykjavik|Kópavogur|Kopavogur|Hafnarfjörður|Hafnarfjordur|Akureyri|Reykjanesbær|Garðabær|Mosfellsbær|Árborg|Akranes|Vestmannaeyjar)', $options: 'i' } },
    );
  }

  return clauses;
}

/**
 * Build both lookup phases so the exact-first policy is independently
 * checkable without connecting to MongoDB.
 */
export function buildCrmSearchPlan(input: CrmSearchInput): CrmSearchPlan {
  const baseFilter: MongoFilter = {};
  const andClauses: MongoFilter[] = [];
  const region = optionalString(input.region);
  const country = optionalString(input.country);
  const city = optionalString(input.city);
  const segment = optionalString(input.segment);
  const subsegment = optionalString(input.subsegment);
  const query = optionalString(input.query);

  if (region) baseFilter.region = literalRegex(region);
  if (input.status) baseFilter.status = input.status;
  if (segment) baseFilter.segment = segment;
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
    Object.assign(baseFilter, andClauses[0]);
  } else if (andClauses.length > 1) {
    baseFilter.$and = andClauses;
  }

  if (!query) return { baseFilter };

  return {
    baseFilter,
    exactFilter: {
      ...baseFilter,
      $or: [
        { id: query },
        { companyName: literalRegex(query, true) },
        { email: literalRegex(query, true) },
        { contactName: literalRegex(query, true) },
      ],
    },
    containsFilter: {
      ...baseFilter,
      $or: [
        { companyName: literalRegex(query) },
        { email: literalRegex(query) },
        { contactName: literalRegex(query) },
      ],
    },
  };
}

export function crmResultKind(totalMatched: number): CrmResultKind {
  if (totalMatched <= 0) return 'none';
  if (totalMatched === 1) return 'single';
  return 'multiple';
}

/** Return the newest usable history record, supporting both `timestamp` and legacy `ts`. */
export function latestInteractionFromLead(lead: Record<string, unknown>): CrmLatestInteraction | undefined {
  if (!Array.isArray(lead.history)) return undefined;

  const candidates = lead.history.flatMap((raw): CrmLatestInteraction[] => {
    if (!raw || typeof raw !== 'object') return [];
    const entry = raw as Record<string, unknown>;
    const interaction: CrmLatestInteraction = {
      timestamp: optionalDateString(entry.timestamp) ?? optionalDateString(entry.ts),
      action: optionalString(entry.action),
      description: optionalString(entry.description),
      agentId: optionalString(entry.agentId),
    };
    return interaction.timestamp ? [interaction] : [];
  });

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  return candidates[0];
}

export function normalizeCrmLead(lead: Record<string, unknown>): CrmLeadResult {
  const latestInteraction = latestInteractionFromLead(lead);
  const fallbackId = lead._id === undefined || lead._id === null ? undefined : String(lead._id);

  return {
    id: optionalString(lead.id) ?? fallbackId,
    companyName: optionalString(lead.companyName),
    email: optionalString(lead.email),
    contactName: optionalString(lead.contactName),
    status: optionalString(lead.status),
    region: optionalString(lead.region),
    segment: optionalString(lead.segment),
    lastInteractionAt: optionalDateString(lead.lastInteractionAt) ?? latestInteraction?.timestamp,
    latestInteraction,
    website: optionalString(lead.website),
  };
}

const searchLeadsInputSchema = z.object({
  query: z.string().optional().describe('Literal company name, email, contactName, or lead ID'),
  region: z.string().optional().describe('Literal region text, e.g. "Mazowieckie" or "Kujawsko-Pomorskie"'),
  country: z.string().optional().describe('Country name or code, e.g. "Poland", "PL", "Islandia", "IS"'),
  city: z.string().optional().describe('City name, e.g. "Warszawa", "Kraków", "Gdańsk"'),
  status: z.enum(CRM_STATUSES).optional().describe('Lead status in the CRM'),
  segment: z.string().optional().describe(`Exact segment: ${CRM_SEGMENTS.join(' | ')}`),
  subsegment: z.string().optional().describe('Subsegment / subcategory within segment, e.g. "kuchnia", "sala", "marketing_gastro", "menu_food_cost"'),
  limit: z.number().int().min(1).max(50).optional().default(10).describe('Returned result limit, from 1 to 50'),
});

const latestInteractionSchema = z.object({
  timestamp: z.string().optional(),
  action: z.string().optional(),
  description: z.string().optional(),
  agentId: z.string().optional(),
});

const leadSchema = z.object({
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

export const searchLeadsTool = createTool({
  id: 'crm_search_leads',
  description: 'Read-only CRM lookup. Tries a literal exact match before a safe literal contains fallback and returns match cardinality plus the latest interaction.',
  inputSchema: searchLeadsInputSchema,
  outputSchema: z.object({
    success: z.boolean(),
    matchKind: z.enum(['exact', 'contains', 'filtered', 'none']),
    resultKind: z.enum(['none', 'single', 'multiple']),
    totalMatched: z.number(),
    count: z.number(),
    truncated: z.boolean(),
    leads: z.array(leadSchema),
    error: z.string().optional(),
  }),
  execute: async (context: any) => {
    try {
      const input = (context && typeof context === 'object' && 'context' in context && context.context) ? context.context : context;
      const db = await getDb();
      const collection = db.collection('leads');
      const plan = buildCrmSearchPlan(input);
      const limit = Math.max(1, Math.min(50, input?.limit ?? 10));

      let filter = plan.baseFilter;
      let matchKind: Exclude<CrmMatchKind, 'none'> = 'filtered';
      let totalMatched: number;

      if (plan.exactFilter && plan.containsFilter) {
        const exactTotal = await collection.countDocuments(plan.exactFilter);
        if (exactTotal > 0) {
          filter = plan.exactFilter;
          matchKind = 'exact';
          totalMatched = exactTotal;
        } else {
          filter = plan.containsFilter;
          matchKind = 'contains';
          totalMatched = await collection.countDocuments(filter);
        }
      } else {
        totalMatched = await collection.countDocuments(filter);
      }

      const leads = totalMatched > 0
        ? await collection
          .find(filter)
          .sort({ lastInteractionAt: -1, updatedAt: -1 })
          .limit(limit)
          .toArray()
        : [];

      return {
        success: true,
        matchKind: totalMatched === 0 ? 'none' as const : matchKind,
        resultKind: crmResultKind(totalMatched),
        totalMatched,
        count: leads.length,
        truncated: totalMatched > leads.length,
        leads: leads.map(lead => normalizeCrmLead(lead)),
      };
    } catch (error) {
      return {
        success: false,
        matchKind: 'none' as const,
        resultKind: 'none' as const,
        totalMatched: 0,
        count: 0,
        truncated: false,
        leads: [],
        error: (error as Error).message,
      };
    }
  },
});
