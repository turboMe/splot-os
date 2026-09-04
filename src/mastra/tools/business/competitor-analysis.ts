/**
 * Competitor analysis tool.
 * Multi-query Tavily search organized by focus area (overview, products, pricing, reviews, news).
 * Returns structured research context for the calling agent to synthesize.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// Internal Tavily helper (mirrors tools/search/tavily.ts — no shared export)
// ────────────────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

async function tavilySearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set in .env');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, search_depth: 'advanced', max_results: maxResults }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Tavily API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { results: any[] };
  return (data.results ?? []).map(r => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: r.content ?? '',
    score: r.score ?? 0,
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// Query builders per focus area
// ────────────────────────────────────────────────────────────────────────────

function buildQueries(
  companyName: string,
  website: string | undefined,
  industry: string | undefined,
  focusAreas: string[],
  language: string,
): Record<string, string> {
  const ctx = industry ? ` ${industry}` : '';
  const site = website ? ` site:${website.replace(/^https?:\/\//, '').split('/')[0]}` : '';
  const queries: Record<string, string> = {};

  if (focusAreas.includes('overview')) {
    queries['overview'] = language === 'pl'
      ? `${companyName}${ctx} firma przegląd historia oferta`
      : `${companyName}${ctx} company overview about`;
  }
  if (focusAreas.includes('products')) {
    queries['products'] = language === 'pl'
      ? `${companyName} produkty usługi funkcje co oferuje`
      : `${companyName}${ctx} products services features offering`;
  }
  if (focusAreas.includes('pricing')) {
    queries['pricing'] = language === 'pl'
      ? `${companyName} ceny cennik plany subskrypcja`
      : `${companyName}${ctx} pricing plans cost subscription`;
    if (site) queries['pricing_site'] = `${companyName} pricing${site}`;
  }
  if (focusAreas.includes('reviews')) {
    queries['reviews'] = language === 'pl'
      ? `${companyName} opinie recenzje klienci doświadczenia`
      : `${companyName}${ctx} reviews opinions customers experience G2 Capterra`;
  }
  if (focusAreas.includes('news')) {
    queries['news'] = language === 'pl'
      ? `${companyName} aktualności wiadomości 2024 2025`
      : `${companyName}${ctx} news latest 2024 2025`;
  }

  return queries;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definition
// ────────────────────────────────────────────────────────────────────────────

const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  relevanceScore: z.number(),
});

type SearchResultItem = z.infer<typeof SearchResultSchema>;

export const competitorAnalysisTool = createTool({
  id: 'business_competitor_analysis',
  description:
    'Analyzes a competitor company using multi-query Tavily research. Returns structured sections (overview, products, pricing, reviews, news) and raw context. Use when you need competitive intelligence about a company.',
  inputSchema: z.object({
    companyName: z.string().describe('Company name to research'),
    website: z.string().optional().describe('Company website URL — improves accuracy'),
    industry: z.string().optional().describe('Industry context, e.g. "restaurant SaaS", "food delivery Poland"'),
    focusAreas: z
      .array(z.enum(['overview', 'products', 'pricing', 'reviews', 'news']))
      .optional()
      .default(['overview', 'products', 'pricing'])
      .describe('Which aspects to research'),
    language: z.enum(['pl', 'en']).optional().default('en').describe('Search language'),
    maxResultsPerArea: z.number().optional().default(4).describe('Tavily results per focus area (1-6)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    companyName: z.string(),
    sections: z.object({
      overview: z.array(SearchResultSchema).optional(),
      products: z.array(SearchResultSchema).optional(),
      pricing: z.array(SearchResultSchema).optional(),
      reviews: z.array(SearchResultSchema).optional(),
      news: z.array(SearchResultSchema).optional(),
    }),
    sources: z.array(z.string()).describe('Deduplicated list of all source URLs'),
    rawContext: z.string().describe('All snippets concatenated — feed to LLM for SWOT / summary'),
    totalResultsFound: z.number(),
    searchQueriesUsed: z.array(z.string()),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { companyName, website, industry, language, maxResultsPerArea } = context;
    const focusAreas = context.focusAreas ?? ['overview', 'products', 'pricing'];
    const limit = Math.min(maxResultsPerArea ?? 4, 6);

    try {
      const queries = buildQueries(companyName, website, industry, focusAreas, language ?? 'en');

      // Run all queries in parallel
      const entries = Object.entries(queries);
      const resultSets = await Promise.allSettled(
        entries.map(([, q]) => tavilySearch(q, limit)),
      );

      const sections: Record<string, SearchResultItem[]> = {};
      const allUrls = new Set<string>();
      const rawParts: string[] = [];
      let totalFound = 0;

      for (let i = 0; i < entries.length; i++) {
        const [areaKey] = entries[i]!;
        const res = resultSets[i]!;
        if (res.status === 'rejected') continue;

        const area = areaKey.replace('_site', '') as string; // merge pricing_site into pricing
        const mapped = res.value.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.content.slice(0, 400),
          relevanceScore: Math.round(r.score * 100) / 100,
        }));

        if (!sections[area]) sections[area] = [];
        // Deduplicate within sections
        for (const item of mapped) {
          if (!allUrls.has(item.url)) {
            sections[area]!.push(item);
            allUrls.add(item.url);
            rawParts.push(`### [${area.toUpperCase()}] ${item.title}\n${item.snippet}\nSource: ${item.url}`);
            totalFound++;
          }
        }
      }

      return {
        success: true,
        companyName,
        sections,
        sources: Array.from(allUrls),
        rawContext: rawParts.join('\n\n---\n\n'),
        totalResultsFound: totalFound,
        searchQueriesUsed: entries.map(([, q]) => q),
      };
    } catch (error) {
      return {
        success: false,
        companyName,
        sections: {},
        sources: [],
        rawContext: '',
        totalResultsFound: 0,
        searchQueriesUsed: [],
        error: (error as Error).message,
      };
    }
  },
});
