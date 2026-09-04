/**
 * Tavily web search tools.
 * Ported from: packages/search/src/index.ts (jarvis).
 * Used by: producer-hunt enrichment, marketing research, knowledge-plan 'search' mode.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// Internal service (shared across tools)
// ────────────────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  rawContent?: string;
}

interface TavilySearchOptions {
  searchDepth?: 'basic' | 'advanced';
  includeRawContent?: 'none' | 'markdown';
}

/**
 * P4c (delegation-depth-hardening) — Tavily rejects queries consisting ONLY of
 * `site:` operators with a 400 ("Query cannot consist only of site: operators").
 * Observed live: `site:finnssonbistro.is` burned a step and returned nothing.
 * When the query has no search terms beyond the operators, append the bare
 * domain name as a term so the call succeeds instead of erroring.
 */
export function repairSiteOnlyQuery(query: string): string {
  const withoutOperators = query.replace(/site:\S+/gi, '').trim();
  if (withoutOperators.length > 0) return query;
  const domains = [...query.matchAll(/site:(\S+)/gi)].map((m) => m[1]);
  if (domains.length === 0) return query;
  const terms = domains
    .map((d) => d.replace(/^www\./i, '').split('.')[0])
    .filter((t) => t.length > 0)
    .join(' ');
  return terms.length > 0 ? `${query} ${terms}` : query;
}

async function tavilySearch(
  query: string,
  maxResults = 5,
  options: TavilySearchOptions = {},
): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set in .env');
  query = repairSiteOnlyQuery(query);

  const searchDepth = options.searchDepth ?? 'basic';
  // Tavily /search accepts include_raw_content: false | 'markdown' | 'text'.
  // 'markdown' returns full page content (LLM-ready) instead of snippets.
  const includeRawContent = options.includeRawContent === 'markdown' ? 'markdown' : false;
  // 'advanced' depth is slower but extracts tables/embedded content — needed for menus.
  const timeoutMs = searchDepth === 'advanced' ? 30_000 : 15_000;

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: searchDepth,
      max_results: maxResults,
      include_raw_content: includeRawContent,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Tavily API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { results: any[] };
  return data.results.map(r => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
    ...(r.raw_content ? { rawContent: r.raw_content as string } : {}),
  }));
}

const DIRECTORIES = [
  'panoramafirm.pl', 'aleo.com', 'owg.pl', 'biznesfinder.pl', 'cylex.pl',
  'infoveriti.pl', 'krs-online.com.pl', 'money.pl', 'oferteo.pl', 'yellowpages',
  'targeo.pl', 'pkt.pl', 'msp.money.pl', 'rejestr.io',
];

// ────────────────────────────────────────────────────────────────────────────
// searchWebTool
// ────────────────────────────────────────────────────────────────────────────
export const searchWebTool = createTool({
  id: 'search_web',
  description: 'Searches the web via Tavily API. Use for current information (news, trends, market data) or when NotebookLM does not have the answers.',
  inputSchema: z.object({
    query: z.string().describe('The search query (in Polish or English).'),
    maxResults: z.number().optional().default(5).describe('Maximum number of results to return (1-10).'),
    searchDepth: z.enum(['basic', 'advanced']).optional().default('basic')
      .describe("'basic' = fast snippets; 'advanced' = deeper extraction (tables/menus), slower."),
    includeRawContent: z.enum(['none', 'markdown']).optional().default('none')
      .describe("'markdown' = full page content (LLM-ready) instead of snippets — uses more tokens."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    results: z.array(z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      score: z.number(),
      rawContent: z.string().optional(),
    })),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const results = await tavilySearch(context.query, Math.min(context.maxResults ?? 5, 10), {
        searchDepth: context.searchDepth,
        includeRawContent: context.includeRawContent,
      });
      return { success: true, count: results.length, results };
    } catch (error) {
      return { success: false, count: 0, results: [], error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// findCompanyLinksTool
// ────────────────────────────────────────────────────────────────────────────
export const findCompanyLinksTool = createTool({
  id: 'search_find_company_links',
  description: 'Searches for the official website, LinkedIn page, and Facebook page of a company. Useful in producer-hunt for lead enrichment before drafting emails.',
  inputSchema: z.object({
    companyName: z.string().describe('The name of the company to search for.'),
    region: z.string().optional().default('').describe('The region (e.g., "Kujawsko-Pomorskie") — improves result relevance.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    website: z.string().optional(),
    linkedIn: z.string().optional(),
    facebook: z.string().optional(),
    searchContext: z.string().optional().describe('Raw search results (titles + snippets) to be used as LLM context.'),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const query = `oficjalna strona www facebook linkedin ${context.companyName} ${context.region ?? ''}`.trim();
      const results = await tavilySearch(query, 10);

      const info: { website?: string; linkedIn?: string; facebook?: string; searchContext?: string } = {
        searchContext: results.map(r => `[${r.title}](${r.url}): ${r.content.slice(0, 200)}`).join('\n\n'),
      };

      for (const res of results) {
        const url = res.url.toLowerCase();
        if (!info.linkedIn && url.includes('linkedin.com/company')) { info.linkedIn = res.url; continue; }
        if (!info.facebook && url.includes('facebook.com') && !url.includes('/groups/') && !url.includes('/posts/')) {
          info.facebook = res.url; continue;
        }
        const isDir = DIRECTORIES.some(d => url.includes(d));
        const isSocial = url.includes('instagram.com') || url.includes('twitter.com') || url.includes('youtube.com');
        if (!info.website && !isDir && !isSocial) {
          const words = context.companyName.toLowerCase().split(' ').filter((w: string) => w.length > 3);
          const match = words.filter((w: string) => url.includes(w) || res.title.toLowerCase().includes(w)).length;
          if (match > 0 || res.score > 0.8) info.website = res.url;
        }
      }

      if (!info.website && results.length > 0) {
        const first = results.find(r => !r.url.includes('facebook.com') && !r.url.includes('linkedin.com'));
        if (first) info.website = first.url;
      }

      return { success: true, ...info };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// tavilyExtractTool — pull full page content from known URLs (Tavily /extract)
// Use AFTER search, when you already have URLs and need the full text (e.g. a
// restaurant menu page). 'advanced' depth pulls tables/embedded content.
// ────────────────────────────────────────────────────────────────────────────
interface ExtractResult {
  url: string;
  rawContent: string;
}
interface ExtractFailure {
  url: string;
  error: string;
}

async function tavilyExtract(
  urls: string[],
  extractDepth: 'basic' | 'advanced',
): Promise<{ results: ExtractResult[]; failed: ExtractFailure[] }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set in .env');

  const response = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      urls,
      extract_depth: extractDepth,
      format: 'markdown',
    }),
    // advanced extraction can be slow on heavy pages
    signal: AbortSignal.timeout(extractDepth === 'advanced' ? 45_000 : 30_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Tavily extract API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    results?: Array<{ url: string; raw_content?: string }>;
    failed_results?: Array<{ url: string; error?: string }>;
  };

  const results: ExtractResult[] = (data.results ?? []).map(r => ({
    url: r.url,
    rawContent: r.raw_content ?? '',
  }));
  const failed: ExtractFailure[] = (data.failed_results ?? []).map(f => ({
    url: f.url,
    error: f.error ?? 'unknown',
  }));
  return { results, failed };
}

export const tavilyExtractTool = createTool({
  id: 'tavily_extract',
  description: 'Extracts the FULL content (markdown) from specific URLs via Tavily /extract. Use when you already HAVE the URLs (e.g., a restaurant menu page) and need the entire text rather than snippets. An extractDepth of "advanced" extracts tables and embedded content (menus, pricing).',
  inputSchema: z.object({
    urls: z.array(z.string().url()).min(1).max(20).describe('List of URLs to extract content from (1-20).'),
    extractDepth: z.enum(['basic', 'advanced']).optional().default('advanced')
      .describe("'advanced' = tables/embedded content (menus); 'basic' = faster, simpler pages."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    results: z.array(z.object({
      url: z.string(),
      rawContent: z.string(),
    })),
    failed: z.array(z.object({
      url: z.string(),
      error: z.string(),
    })),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const { results, failed } = await tavilyExtract(context.urls, context.extractDepth ?? 'advanced');
      return { success: true, count: results.length, results, failed };
    } catch (error) {
      return { success: false, count: 0, results: [], failed: [], error: (error as Error).message };
    }
  },
});
