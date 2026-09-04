/**
 * Producer-hunt workflow (10 stepów) — port z jarvis
 * (apps/workers/src/agents/marketing-agent: outreach.ts, enrichment.ts, drafting.ts, index.ts).
 *
 * Mapowanie steps → jarvis (per plan §8.1):
 *   01 discover-leads          ← steps/outreach.ts (Tavily/NotebookLM + fallback LLM)
 *   02 create-research-leads   ← index.ts:461-478 (lead bez maila → status `research_needed`)
 *   03 enrich-leads            ← steps/enrichment.ts (deep research; tu fallback przez agent.generate)
 *   04 extract-emails          ← index.ts:499-510 (LLM email-extraction)
 *   05 draft-cold-emails       ← steps/drafting.ts
 *   06 create-gmail-drafts     ← gmail.createDraft
 *   07 save-drafts-fs          ← DraftsStore.save (lib/drafts-store.ts)
 *   08 update-crm              ← crm.upsertLead + addInteraction
 *   09 await-approval          ← workflow.suspend()
 *   10 send-on-approve         ← gmail.sendDraft per draft
 *
 * Uwaga: enrichment korzysta z researcherAgent (Tavily search + extract, Playwright);
 * gdy deep research nie wystarczy, schodzi do fallbacku przez LLM.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  producerHuntDiscoveryAgent,
  producerHuntDraftAgent,
  producerHuntEmailExtractionAgent,
  producerHuntEnrichmentAgent,
  producerHuntJsonRepairAgent,
  producerHuntCloudFallbackAgent,
} from '../agents/marketing-agent';
import { researcherAgent } from '../agents/researcher-agent.js';
import { knowledgeAgent } from '../agents/knowledge-agent.js';
import { generateKnowledge } from '../services/knowledge-harness.js';
import { workflowModels } from '../config/workflow-models.js';
import { getDb } from '../lib/mongo';
import { GmailService } from '../tools/google/gmail.js';
import { getDraftsStore } from '../lib/drafts-store.js';
import { searchWebTool, findCompanyLinksTool } from '../tools/search/tavily.js';
import {
  knowledgeQueryTool,
  knowledgeCreateNotebookTool,
  knowledgeAddSourceTool,
} from '../tools/knowledge/knowledge-tools.js';
import { 
  normalizeTextField, 
  normalizeNullableString, 
  generateJsonWithFallback,
  assertSafeProducerHuntModel
} from './producer-hunt/helpers.js';
import {
  scoreLead,
  validateEnrichmentIdentity,
  validateDraft,
  normalizeOptionalText,
  mapToCrmSegment,
  ACCEPTABLE_SUPPLIER_TYPES,
  getRegionTokens,
  type SupplierType,
} from './producer-hunt/quality.js';
import {
  DISCOVERY_PROFILES,
  EXCLUDED_DOMAIN_HINTS,
  SOCIAL_AND_NLM_INCOMPATIBLE_HINTS,
  TAVILY_QUERY_BUDGET,
  MAX_QUERIES_PER_PROFILE_ROUND_1,
} from './producer-hunt/discovery-queries.js';
import {
  defaultHookForType,
  additionalSourcePathsForType,
  additionalSearchQueryForType,
  researchQuestionFor,
  finalEnrichmentPromptFor,
} from './producer-hunt/enrichment-prompts.js';
import {
  researcherTaskFor,
  discoveryQuestionFor,
  knowledgeAgentDiscoveryInstruction,
} from './producer-hunt/discovery-prompts.js';
import {
  draftPromptFor,
  fallbackDraftFor,
} from './producer-hunt/draft-prompts.js';
import { pickBestEmail } from './producer-hunt/email.js';
import { logProducerHuntEvent } from './producer-hunt/logging.js';
import { cleanupNotebook } from './producer-hunt/notebook-cleanup.js';

// ── Schemas ─────────────────────────────────────────────────────────────────
const supplierTypeSchema = z.enum([
  'producer',
  'manufacturer',
  'cooperative',
  'producer_group',
  'wholesaler',
  'distributor',
  'importer',
  'farm_aggregator',
  'unknown',
]);

const directToHorecaSchema = z.enum(['yes', 'limited', 'no', 'unknown']);

const leadSchema = z.object({
  company: z.string(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  productCategory: z.string().nullable().optional(),
  sourceUrls: z.union([z.array(z.string()), z.string()]).nullable().optional(),
  emailSource: z.string().nullable().optional(),
  isProducer: z.boolean().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  supplierType: supplierTypeSchema.nullable().optional(),
  directToHoreca: directToHorecaSchema.nullable().optional(),
  servesRegions: z.array(z.string()).nullable().optional(),
  brandsOrPortfolio: z.array(z.string()).nullable().optional(),
});
type Lead = z.infer<typeof leadSchema>;

const enrichedLeadSchema = leadSchema.extend({
  rawAnalysis: z.string(),
  personalizationHook: z.string(),
  companyName: z.string().nullable().optional(),
  inferredSupplierType: supplierTypeSchema.optional(),
});
type EnrichedLead = z.infer<typeof enrichedLeadSchema>;

const draftSchema = z.object({
  taskId: z.string(),
  draftId: z.string(),
  company: z.string(),
  email: z.string(),
  subject: z.string(),
  body: z.string(),
  enrichment: enrichedLeadSchema.optional(),
  gmailDraftId: z.string().optional(),
  fsPath: z.string().optional(),
});
type Draft = z.infer<typeof draftSchema>;

const qualitySummarySchema = z.object({
  discovered: z.number(),
  draftCandidates: z.number(),
  researchNeeded: z.number(),
  rejected: z.number(),
  candidatesForResearch: z.number(),
});

const postResearchSummarySchema = z.object({
  inputCandidates: z.number(),
  enrichedAccepted: z.number(),
  enrichedRejected: z.number(),
});

// New schemas for LLM responses
const enrichmentResponseSchema = z.object({
  companyName: z.string().optional().nullable(),
  supplierType: supplierTypeSchema.optional(),
  directToHoreca: directToHorecaSchema.optional(),
  brandsOrPortfolio: z.array(z.string()).optional().default([]),
  servesRegions: z.array(z.string()).optional().default([]),
  personalizationHook: z.string().min(5),
  rawAnalysis: z.union([
    z.string(),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
  ]).optional(),
  website: z.string().optional().nullable(),
  linkedIn: z.string().optional().nullable(),
  facebook: z.string().optional().nullable(),
  identityConfidence: z.number().min(0).max(1).optional(),
  identityWarning: z.string().optional(),
});

const draftResponseSchema = z.object({
  subject: z.string().min(5).max(120),
  body: z.string().min(200),
});

const discoveryResponseSchema = z.object({
  leads: z.array(leadSchema).default([]),
});

// Output researcher-agent (PSEV) — Blok 1a
const researcherFindingSchema = z.object({
  claim: z.string().optional(),
  sources: z.array(z.string()).default([]),
  verificationLevel: z.enum(['high', 'medium', 'low']).optional(),
});

const researcherOutputSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed']).optional(),
  summary: z.string().optional(),
  confidence: z.string().optional(),
  findings: z.array(researcherFindingSchema).default([]),
  contradictions: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

// Output knowledge-agent (NLM discovery) — Blok 1b
const nlmDiscoveryOutputSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed']).optional(),
  notebookId: z.string().optional(),
  leads: z.array(leadSchema).default([]),
  notes: z.string().optional(),
});

// Source list (URL + opcjonalny tytuł), przekazywane z Bloku 1a → 1b
const sourceItemSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
});

const isValidEmail = (e?: string | null): e is string =>
  !!normalizeOptionalText(e) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeOptionalText(e)!);

const normalizeSourceUrls = (value: unknown): string[] | undefined => {
  if (!value) return undefined;
  const values = Array.isArray(value)
    ? value
    : String(value).split(/[\n,;]/);
  const normalized = values
    .map((url) => normalizeOptionalText(String(url)))
    .filter((url): url is string => !!url);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'tak', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'nie', 'no', '0'].includes(normalized)) return false;
  return undefined;
};

const normalizeConfidence = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : undefined;
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!value) return undefined;
  const values = Array.isArray(value) ? value : String(value).split(/[\n,;]/);
  const normalized = values
    .map((item) => normalizeOptionalText(String(item)))
    .filter((item): item is string => !!item);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeSupplierType = (value: unknown): SupplierType | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const allowed: SupplierType[] = [
    'producer', 'manufacturer', 'cooperative', 'producer_group',
    'wholesaler', 'distributor', 'importer', 'farm_aggregator', 'unknown',
  ];
  return allowed.includes(normalized as SupplierType) ? (normalized as SupplierType) : undefined;
};

const normalizeDirectToHoreca = (value: unknown): 'yes' | 'limited' | 'no' | 'unknown' | undefined => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['yes', 'tak', 'true', '1'].includes(normalized)) return 'yes';
  if (['no', 'nie', 'false', '0'].includes(normalized)) return 'no';
  if (['limited', 'czesciowo', 'częściowo', 'partial'].includes(normalized)) return 'limited';
  if (['unknown', 'nieznane', 'nieznany'].includes(normalized)) return 'unknown';
  return undefined;
};

const normalizeLead = (lead: Lead): Lead => ({
  company: lead.company.trim(),
  email: normalizeOptionalText(lead.email),
  website: normalizeOptionalText(lead.website),
  reason: normalizeOptionalText(lead.reason),
  city: normalizeOptionalText(lead.city),
  productCategory: normalizeOptionalText(lead.productCategory),
  sourceUrls: normalizeSourceUrls(lead.sourceUrls),
  emailSource: normalizeOptionalText(lead.emailSource),
  isProducer: normalizeBoolean(lead.isProducer),
  confidence: normalizeConfidence(lead.confidence),
  supplierType: normalizeSupplierType(lead.supplierType),
  directToHoreca: normalizeDirectToHoreca(lead.directToHoreca),
  servesRegions: normalizeStringArray(lead.servesRegions),
  brandsOrPortfolio: normalizeStringArray(lead.brandsOrPortfolio),
});

const tryParseJson = <T = unknown>(text: string): T | null => {
  try {
    // 1. Spróbuj wyciągnąć z markdown code block
    const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
    if (match) return JSON.parse(match[1]);

    // 2. Jeśli nie ma bloków, spróbuj znaleźć pierwszy '{' i ostatni '}'
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }

    // 3. Fallback do bezpośredniego parsu
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ── Step 01a: gather-sources ────────────────────────────────────────────────
// Researcher Agent (PSEV) szuka URL stron firm-kandydatów. Tavily multi-round
// jako fallback gdy researcher zwróci niewystarczająco źródeł.
const gatherSourcesStep = createStep({
  id: 'gather-sources',
  description: 'Researcher Agent (PSEV) szuka URL kandydatów; Tavily multi-round jako fallback.',
  inputSchema: z.object({
    region: z.string(),
    count: z.number().default(10),
    productType: z.string().optional(),
    supplierTypes: z.array(supplierTypeSchema).optional(),
    userContext: z.string().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    count: z.number(),
    productType: z.string().nullable(),
    userContext: z.string().nullable(),
    acceptableSupplierTypes: z.array(supplierTypeSchema),
    sources: z.array(sourceItemSchema),
  }),
  execute: async (context) => {
    const taskId = `producer-hunt-${randomUUID().slice(0, 8)}`;
    const { region, count, productType, supplierTypes, userContext } = context.inputData;
    const acceptableSupplierTypes = (supplierTypes && supplierTypes.length > 0
      ? supplierTypes.filter((t) => t !== 'unknown')
      : ACCEPTABLE_SUPPLIER_TYPES) as SupplierType[];
    console.log(`[producer-hunt:${taskId}] gather-sources region=${region} spec=${productType ?? 'all'} types=${acceptableSupplierTypes.join(',')} ctx=${userContext ? 'yes' : 'no'}`);

    // Preflight checks (modele dla downstream stepów)
    const models = workflowModels.producerHunt;
    assertSafeProducerHuntModel(models.discovery, 'discovery', taskId);
    assertSafeProducerHuntModel(models.enrichment, 'enrichment', taskId);
    assertSafeProducerHuntModel(models.draftEmail, 'draftEmail', taskId);

    const isUsableForNotebook = (url: string) => {
      const lower = url.toLowerCase();
      if (SOCIAL_AND_NLM_INCOMPATIBLE_HINTS.some((d) => lower.includes(d))) return false;
      if (EXCLUDED_DOMAIN_HINTS.some((d) => lower.includes(d))) return false;
      return true;
    };

    // ── 1. Researcher Agent (PSEV) — primary source ─────────────────────
    const collected = new Map<string, { url: string; title?: string }>();
    let researcherStatus: 'completed' | 'partial' | 'failed' = 'failed';
    let researcherFindings = 0;
    try {
      const brief = researcherTaskFor({
        region,
        productType,
        acceptableSupplierTypes,
        count,
        userContext,
      });
      console.log(`[producer-hunt:${taskId}] researcher: PSEV brief sent (target ~${count * 3} URLs)`);
      const res = await researcherAgent.generate([{ role: 'user', content: brief }]);
      const parsed = tryParseJson<unknown>(res.text);
      const validation = researcherOutputSchema.safeParse(parsed);
      if (validation.success) {
        researcherStatus = validation.data.status ?? 'completed';
        for (const finding of validation.data.findings) {
          researcherFindings++;
          for (const url of finding.sources) {
            if (!url || typeof url !== 'string') continue;
            if (collected.has(url)) continue;
            if (!isUsableForNotebook(url)) continue;
            collected.set(url, { url, title: finding.claim });
          }
        }
        console.log(`[producer-hunt:${taskId}] researcher: status=${researcherStatus}, findings=${researcherFindings}, usable URLs=${collected.size}`);
      } else {
        console.warn(`[producer-hunt:${taskId}] researcher: output nieparsowalny — przechodzę do Tavily fallback`);
      }
    } catch (err) {
      console.warn(`[producer-hunt:${taskId}] researcher fail:`, (err as Error).message);
    }

    // ── 2. Tavily multi-round fallback gdy researcher dał za mało ─────────
    type SearchHit = { title: string; url: string; content: string; score: number };
    const accumulatedHits = new Map<string, SearchHit>();
    let queriesIssued = 0;

    if (collected.size < count * 2) {
      console.log(`[producer-hunt:${taskId}] tavily fallback start (researcher dał ${collected.size}, target=${count * 2})`);

      const runQueries = async (queries: string[], roundLabel: string) => {
        const remaining = Math.max(0, TAVILY_QUERY_BUDGET - queriesIssued);
        const slice = queries.slice(0, remaining);
        if (slice.length === 0) {
          console.log(`[producer-hunt:${taskId}] ${roundLabel}: query budget exhausted`);
          return;
        }
        queriesIssued += slice.length;
        const responses = await Promise.all(
          slice.map((q) => searchWebTool.execute!({ query: q, maxResults: 5 }, {} as any)),
        );
        for (const res of responses) {
          if (!res || !('success' in res) || !res.success) continue;
          for (const hit of res.results as SearchHit[]) {
            if (!accumulatedHits.has(hit.url)) accumulatedHits.set(hit.url, hit);
          }
        }
      };

      const activeProfiles = acceptableSupplierTypes
        .map((t) => DISCOVERY_PROFILES[t as Exclude<SupplierType, 'unknown'>])
        .filter(Boolean);

      const round1Queries: string[] = [];
      for (const profile of activeProfiles) {
        const base = profile.baseQueries(region, productType);
        const niche = profile.nicheQueries(region, productType);
        const merged = [...base, ...niche].slice(0, MAX_QUERIES_PER_PROFILE_ROUND_1);
        round1Queries.push(...merged);
      }
      console.log(`[producer-hunt:${taskId}] tavily round1: ${round1Queries.length} queries across ${activeProfiles.length} profiles`);
      await runQueries(round1Queries, 'tavily round1');

      if (accumulatedHits.size < count * 2 && queriesIssued < TAVILY_QUERY_BUDGET) {
        const regionTokens = getRegionTokens(region);
        const cities = regionTokens.filter((t) => t.length > 4 && !t.includes('skie') && !t.includes('slask')).slice(0, 4);
        const round2Queries: string[] = [];
        for (const profile of activeProfiles) {
          for (const city of cities) {
            round2Queries.push(...profile.cityQueries(region, city, productType));
          }
        }
        if (round2Queries.length > 0) {
          console.log(`[producer-hunt:${taskId}] tavily round2: ${round2Queries.length} city-level queries (cities=${cities.join(',')})`);
          await runQueries(round2Queries, 'tavily round2');
        }
      }

      for (const hit of accumulatedHits.values()) {
        if (collected.has(hit.url)) continue;
        if (!isUsableForNotebook(hit.url)) continue;
        collected.set(hit.url, { url: hit.url, title: hit.title });
      }
    }

    const sources = Array.from(collected.values()).slice(0, 16);
    console.log(`[producer-hunt:${taskId}] gather-sources finished: ${sources.length} URLs (researcher findings=${researcherFindings}, tavily queries=${queriesIssued}/${TAVILY_QUERY_BUDGET}, raw tavily hits=${accumulatedHits.size}).`);

    await logProducerHuntEvent({
      taskId,
      stepId: 'gather-sources',
      event: 'sources_summary',
      metrics: {
        region,
        productType: productType ?? null,
        requestedCount: count,
        userContext: userContext ? userContext.slice(0, 200) : null,
        acceptableSupplierTypes,
        researcherStatus,
        researcherFindings,
        tavilyQueriesIssued: queriesIssued,
        tavilyQueryBudget: TAVILY_QUERY_BUDGET,
        tavilyRawHits: accumulatedHits.size,
        finalSources: sources.length,
      },
    });

    return {
      taskId,
      region,
      count,
      productType: productType ?? null,
      userContext: userContext ?? null,
      acceptableSupplierTypes,
      sources,
    };
  },
});

// ── Step 01b: discover-via-nlm ──────────────────────────────────────────────
// Knowledge Agent (NotebookLM) tworzy notebook ze źródeł i odpytuje go o listę
// firm. Fallback: LLM ze snippetów (gdy NLM zawiódł lub zwrócił mało wyników).
const discoverViaNlmStep = createStep({
  id: 'discover-via-nlm',
  description: 'Knowledge Agent ładuje źródła do NotebookLM i odpytuje o listę firm.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    count: z.number(),
    productType: z.string().nullable(),
    userContext: z.string().nullable(),
    acceptableSupplierTypes: z.array(supplierTypeSchema),
    sources: z.array(sourceItemSchema),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    leads: z.array(leadSchema),
    acceptableSupplierTypes: z.array(supplierTypeSchema),
  }),
  execute: async (context) => {
    const { taskId, region, count, productType, userContext, acceptableSupplierTypes, sources } = context.inputData;

    let leads: Lead[] = [];
    let nlmStatus: 'completed' | 'partial' | 'failed' | 'skipped' = 'skipped';

    if (sources.length > 0) {
      const discoveryQuestion = discoveryQuestionFor({
        region,
        productType: productType ?? undefined,
        acceptableSupplierTypes,
        count,
        userContext: userContext ?? undefined,
      });
      const notebookTitle = `Discovery: Producers ${region} (${taskId})`;
      const instruction = knowledgeAgentDiscoveryInstruction({
        taskId,
        region,
        notebookTitle,
        sources,
        discoveryQuestion,
        count,
      });

      try {
        console.log(`[producer-hunt:${taskId}] knowledge-agent: tworzę Discovery Notebook (${sources.length} źródeł)...`);
        const res = await generateKnowledge({
          agent: knowledgeAgent,
          prompt: instruction,
          taskId,
          threadId: `producer-hunt-knowledge-${taskId}`,
          phase: 'research',
          timeoutMs: 300_000,
        });
        const responseText = typeof (res.response as any)?.text === 'string'
          ? (res.response as any).text
          : res.outputPreview;
        const parsed = tryParseJson<unknown>(responseText);
        const validation = nlmDiscoveryOutputSchema.safeParse(parsed);
        if (validation.success) {
          nlmStatus = validation.data.status ?? 'completed';
          leads = validation.data.leads ?? [];
          console.log(`[producer-hunt:${taskId}] knowledge-agent: status=${nlmStatus}, leads=${leads.length}, notebookId=${validation.data.notebookId ?? '?'}`);
        } else {
          nlmStatus = 'failed';
          console.warn(`[producer-hunt:${taskId}] knowledge-agent: output nieparsowalny:`, validation.error.message);
        }
      } catch (err) {
        nlmStatus = 'failed';
        console.warn(`[producer-hunt:${taskId}] knowledge-agent fail:`, (err as Error).message);
      }
    } else {
      console.warn(`[producer-hunt:${taskId}] discover-via-nlm: brak źródeł — pomijam NLM, lecę fallbackiem LLM (jeśli mamy snippety… ale tu ich nie ma).`);
    }

    // Fallback do LLM gdy NLM zawiódł lub zwrócił mało — używamy tytułów źródeł jako kontekstu
    const minAcceptable = count;
    if (leads.length < minAcceptable && sources.length > 0) {
      console.log(`[producer-hunt:${taskId}] NLM zwrócił ${leads.length}/${count}, uruchamiam LLM fallback ze źródeł...`);
      const searchContext = sources.slice(0, 20).map(s => `[${s.title ?? s.url}](${s.url})`).join('\n\n');
      const fallbackTypesText = acceptableSupplierTypes.join(', ');
      const ctxLine = userContext ? `\nDODATKOWY KONTEKST: ${userContext}` : '';
      const fallbackPrompt = `Na podstawie poniższych źródeł wybierz do ${count} firm z ${region},
które mogą dostarczać żywność do restauracji w modelu B2B (cel: GastroBridge).

Akceptowane typy dostawcy: ${fallbackTypesText}.${ctxLine}
Klasyfikuj każdą firmę do jednego z typów:
- producer / manufacturer (wytwórca / zakład przetwórstwa),
- cooperative / producer_group / farm_aggregator (kooperatywa / grupa / platforma),
- wholesaler (hurtownia HoReCa, cash & carry),
- distributor (dystrybutor foodservice),
- importer (importer specjalistyczny),
- unknown (jeśli nie potrafisz dopasować).

Pomiń:
- katalogi firm i portale ogólne (panoramafirm, gowork, pkt.pl, aleo, oferteo);
- sieci handlowe B2C (Biedronka, Lidl, Auchan, Tesco, Kaufland, Carrefour);
- restauracje, hotele, pizzerie, bary mleczne (to nasi klienci, nie dostawcy).

Nie odrzucaj hurtowni i dystrybutorów — to wartościowi partnerzy GastroBridge.
Nie wpisuj "Brak danych" — używaj null.

Źródła:
${searchContext}

Zwróć WYŁĄCZNIE JSON:
{ "leads": [
  {
    "company": "...",
    "supplierType": "wholesaler",
    "directToHoreca": "yes",
    "brandsOrPortfolio": ["..."],
    "servesRegions": ["..."],
    "email": null,
    "website": null,
    "city": "...",
    "productCategory": "...",
    "sourceUrls": ["..."],
    "emailSource": null,
    "isProducer": false,
    "confidence": 0.7,
    "reason": "..."
  }
] }`;

      const res = await generateJsonWithFallback({
        taskId,
        stepId: 'discover-via-nlm-fallback',
        prompt: fallbackPrompt,
        schema: discoveryResponseSchema,
        localAgent: producerHuntDiscoveryAgent,
        repairAgent: producerHuntJsonRepairAgent,
        cloudFallbackAgent: producerHuntCloudFallbackAgent,
        fallback: () => ({ leads: [] }),
      });

      leads = [...leads, ...res.leads];
    }

    // Dedup + walidacja
    const seen = new Set();
    const normalizedLeads = leads
      .filter((l) => l?.company && l.company.length >= 3)
      .map((l) => normalizeLead(l));

    const finalLeads = normalizedLeads.filter(l => {
      if (!l.company || l.company.length < 3) return false;
      const normalizedName = l.company.toLowerCase()
        .replace(/sp\. z o\.o\.|s\.c\.|sp\. j\.|p\.h\.u\.|p\.p\.h\.u\.|spółka|"/g, '')
        .trim();
      const emailDomain = l.email && isValidEmail(l.email) ? l.email.split('@')[1].toLowerCase() : null;
      const key = emailDomain ? `domain:${emailDomain}` : `name:${normalizedName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, count);

    console.log(`[producer-hunt:${taskId}] discover-via-nlm finished, found ${finalLeads.length} leads (nlmStatus=${nlmStatus}).`);
    await logProducerHuntEvent({
      taskId,
      stepId: 'discover-via-nlm',
      event: 'discover_summary',
      metrics: {
        region,
        productType: productType ?? null,
        requestedCount: count,
        nlmStatus,
        sources: sources.length,
        nlmLeads: leads.length,
        found: finalLeads.length,
        validEmail: finalLeads.filter((l) => isValidEmail(l.email)).length,
        withWebsite: finalLeads.filter((l) => !!l.website).length,
        acceptableSupplierTypes,
      },
    });
    return { taskId, region, leads: finalLeads, acceptableSupplierTypes };
  },
});


// ── Step 02: create-research-leads ──────────────────────────────────────────
const createResearchLeadsStep = createStep({
  id: 'create-research-leads',
  description:
    'Klasyfikuje leady i przepuszcza draft_candidate oraz research_needed do pogłębionego researchu.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    leads: z.array(leadSchema),
    acceptableSupplierTypes: z.array(supplierTypeSchema),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    validLeads: z.array(leadSchema),
    researchOnlyCount: z.number(),
    qualitySummary: qualitySummarySchema,
    acceptableSupplierTypes: z.array(supplierTypeSchema),
  }),
  execute: async (context) => {
    const { taskId, region, leads, acceptableSupplierTypes } = context.inputData;
    const acceptedTypeSet = new Set<SupplierType>(acceptableSupplierTypes as SupplierType[]);

    // Scoring and filtering
    const scoredLeads = leads.map((l) => {
      const lead = normalizeLead(l);
      const quality = scoreLead(lead, region);

      // propaguj inferredSupplierType do leada (nie nadpisuj declared)
      const enrichedLead: Lead = {
        ...lead,
        supplierType: lead.supplierType ?? quality.inferredSupplierType,
      };

      // jeśli typ jest poza listą akceptowalnych, wymuś reject
      if (!acceptedTypeSet.has(quality.inferredSupplierType)) {
        return {
          lead: enrichedLead,
          quality: {
            ...quality,
            decision: 'reject' as const,
            reasons: [...quality.reasons, `reject: typ ${quality.inferredSupplierType} poza listą akceptowalnych`],
          },
        };
      }

      return { lead: enrichedLead, quality };
    }).sort((a, b) => b.quality.score - a.quality.score);

    // validLeads zostaje nazwą kontraktu workflow, ale teraz oznacza kandydatów
    // do researchu: pewnych i niepewnych, o ile nie są odrzucone.
    const validLeads = scoredLeads
      .filter(sl => sl.quality.decision !== 'reject')
      .map(sl => sl.lead);

    const researchOnly = scoredLeads
      .filter(sl => sl.quality.decision === 'research_needed')
      .map(sl => sl.lead);

    const draftCandidateCount = scoredLeads.filter(sl => sl.quality.decision === 'draft_candidate').length;
    const rejectedCount = scoredLeads.filter(sl => sl.quality.decision === 'reject').length;
    const qualitySummary = {
      discovered: scoredLeads.length,
      draftCandidates: draftCandidateCount,
      researchNeeded: researchOnly.length,
      rejected: rejectedCount,
      candidatesForResearch: validLeads.length,
    };

    // Rozkład typów dla diagnostyki
    const bySupplierType: Record<string, number> = {};
    for (const sl of scoredLeads) {
      const t = sl.quality.inferredSupplierType;
      bySupplierType[t] = (bySupplierType[t] ?? 0) + 1;
    }
    console.log(`[producer-hunt:${taskId}] discovered by type:`, JSON.stringify(bySupplierType));

    const db = await getDb();

    for (const sl of scoredLeads) {
      console.log(
        `[producer-hunt:${taskId}] lead quality ${sl.lead.company}: type=${sl.quality.inferredSupplierType}, decision=${sl.quality.decision}, score=${sl.quality.score}, reasons=${sl.quality.reasons.join('; ')}`,
      );

      if (sl.quality.decision === 'reject') {
        console.log(`[producer-hunt:${taskId}] rejecting lead ${sl.lead.company} (score: ${sl.quality.score}, reasons: ${sl.quality.reasons.join(', ')})`);
        continue;
      }

      const segment = mapToCrmSegment(sl.quality.inferredSupplierType);

      await db.collection('leads').updateOne(
        { companyName: sl.lead.company, region },
        {
          $set: {
            companyName: sl.lead.company,
            segment,
            region,
            status: sl.quality.decision === 'draft_candidate' ? 'research_queued' : 'research_needed',
            website: sl.lead.website,
            updatedAt: new Date(),
            metadata: {
              discoveryReason: sl.lead.reason,
              city: sl.lead.city,
              productCategory: sl.lead.productCategory,
              sourceUrls: sl.lead.sourceUrls,
              emailSource: sl.lead.emailSource,
              isProducer: sl.lead.isProducer,
              confidence: sl.lead.confidence,
              supplierType: sl.quality.inferredSupplierType,
              declaredSupplierType: sl.lead.supplierType,
              directToHoreca: sl.lead.directToHoreca,
              servesRegions: sl.lead.servesRegions,
              brandsOrPortfolio: sl.lead.brandsOrPortfolio,
              qualityScore: sl.quality.score,
              qualityDecision: sl.quality.decision,
              qualityReasons: sl.quality.reasons,
              taskId,
            },
          },
          $setOnInsert: { createdAt: new Date(), id: `research-${randomUUID().slice(0, 8)}` },
        },
        { upsert: true },
      );
    }

    console.log(
      `[producer-hunt:${taskId}] candidates-for-research=${validLeads.length}, research-needed=${researchOnly.length}, draft-candidates=${draftCandidateCount}, rejected=${rejectedCount}`,
    );
    await logProducerHuntEvent({
      taskId,
      stepId: 'create-research-leads',
      event: 'quality_summary',
      metrics: {
        region,
        ...qualitySummary,
        bySupplierType,
      },
    });
    return {
      taskId,
      region,
      validLeads,
      researchOnlyCount: researchOnly.length,
      qualitySummary,
      acceptableSupplierTypes,
    };
  },
});

// ── Step 03: enrich-leads ───────────────────────────────────────────────────
const enrichLeadsStep = createStep({
  id: 'enrich-leads',
  description: 'Pogłębiony research firm (zwraca personalizationHook do drafterów) z użyciem NotebookLM.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    validLeads: z.array(leadSchema),
    researchOnlyCount: z.number(),
    qualitySummary: qualitySummarySchema.optional(),
    acceptableSupplierTypes: z.array(supplierTypeSchema).optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enriched: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
    postResearchSummary: postResearchSummarySchema,
  }),
  execute: async (context) => {
    const { taskId, region, validLeads } = context.inputData;
    const enriched: EnrichedLead[] = [];
    let enrichedRejected = 0;

    // Pobierz ogólny kontekst rynkowy z NotebookLM (jeśli dostępny)
    let marketContext = '';
    try {
      const marketQuery = await knowledgeQueryTool.execute!({
        notebook: 'rynek',
        question: `Jakie są najważniejsze trendy i wyzwania dla dostawców żywności (producentów, hurtowni, dystrybutorów) obsługujących HoReCa w regionie ${region}?`,
      }, {} as any);
      if (marketQuery && 'success' in marketQuery && marketQuery.success) {
        marketContext = (marketQuery as any).answer ?? '';
      }
    } catch (e) {
      console.warn(`[producer-hunt:${taskId}] NotebookLM 'rynek' niedostępny.`);
    }

    const db = await getDb();

    for (const lead of validLeads) {
      const declaredOrInferredType: SupplierType = (lead.supplierType as SupplierType | undefined) ?? 'unknown';
      console.log(`[producer-hunt:${taskId}] enriching lead: ${lead.company} (type=${declaredOrInferredType})...`);
      let notebookId = '';

      // P1.5: zmienne researchu wyniesione na poziom pętli — outer-catch może z nich
      // skorzystać do zachowania danych NLM zamiast pisać 'Enrichment niedostępny.'
      let nlmAnalysis = '';
      let nlmHook = '';
      let nlmEmail = '';
      let leadContext = '';
      let preservedSource: 'nlm' | 'searchContext' | 'leadReason' | 'none' = 'none';

      try {
        // 1. Szukanie linków i głębszego kontekstu przez Tavily
        const linksResult = await findCompanyLinksTool.execute!({
          companyName: lead.company,
          region,
        }, {} as any);

        const isSuccess = linksResult && 'success' in linksResult && linksResult.success;
        leadContext = isSuccess ? (linksResult as any).searchContext : '';
        const website = normalizeOptionalText(isSuccess ? ((linksResult as any).website ?? lead.website) : lead.website);
        const researchWebsite = website
          ? (website.startsWith('http') ? website : `https://${website}`)
          : null;

        // 1b. Dodatkowe Tavily query per typ (hurtownia/dystrybutor/importer/kooperatywa)
        const extraSearchQuery = additionalSearchQueryForType(declaredOrInferredType, lead.company);
        if (extraSearchQuery) {
          try {
            const extraRes = await searchWebTool.execute!({ query: extraSearchQuery, maxResults: 5 }, {} as any);
            if (extraRes && 'success' in extraRes && extraRes.success) {
              const snippets = extraRes.results.map((r: any) => `[${r.title}](${r.url}): ${r.content.slice(0, 240)}`).join('\n\n');
              leadContext = leadContext ? `${leadContext}\n\n--- Type-specific context (${declaredOrInferredType}) ---\n${snippets}` : snippets;
            }
          } catch (extraErr) {
            console.warn(`[producer-hunt:${taskId}] extra search for ${lead.company} failed:`, (extraErr as Error).message);
          }
        }

        // 2. Jeśli mamy stronę, robimy DEEP research przez NotebookLM (multi-source per typ)
        if (researchWebsite) {
          try {
            console.log(`[producer-hunt:${taskId}] creating Deep Research notebook for ${lead.company}...`);
            const createRes = await knowledgeCreateNotebookTool.execute!({ title: `Deep: ${lead.company} (${taskId})` }, {} as any);
            if (createRes && 'success' in createRes && createRes.success) {
              notebookId = (createRes as any).notebookId;

              // Dodajemy stronę główną
              await knowledgeAddSourceTool.execute!({
                notebook: notebookId,
                sourceType: 'url',
                url: researchWebsite,
                title: `Strona: ${lead.company}`
              }, {} as any);

              // Multi-source: dodajemy podstrony dopasowane do typu (max 4 ekstra → razem ≤5 URL).
              // NotebookLM toleruje 404, więc nie pre-fetchujemy.
              const extraPaths = additionalSourcePathsForType(declaredOrInferredType).slice(0, 4);
              const baseUrl = researchWebsite.replace(/\/$/, '');
              await Promise.all(
                extraPaths.map((path) =>
                  knowledgeAddSourceTool.execute!({
                    notebook: notebookId,
                    sourceType: 'url',
                    url: `${baseUrl}${path}`,
                    title: `${lead.company} ${path}`,
                  }, {} as any).catch(() => null),
                ),
              );

              // Tavily searchContext jako tekst pomocniczy.
              if (leadContext) {
                await knowledgeAddSourceTool.execute!({
                  notebook: notebookId,
                  sourceType: 'text',
                  text: leadContext,
                  title: `Search context for ${lead.company}`
                }, {} as any);
              }

              // Czekamy na indeksowanie
              await new Promise(resolve => setTimeout(resolve, 8000));

              const researchQuestion = researchQuestionFor(declaredOrInferredType, {
                company: lead.company,
                website: researchWebsite,
                city: lead.city ?? null,
                productCategory: lead.productCategory ?? null,
              });

              const queryRes = await knowledgeQueryTool.execute!({
                notebook: notebookId,
                question: researchQuestion
              }, {} as any);

              if (queryRes && 'success' in queryRes && queryRes.success) {
                const answer = (queryRes as any).answer || '';
                nlmHook = answer.match(/PERSONALIZATION_HOOK:\s*(.*)/)?.[1]?.trim() || '';
                nlmAnalysis = answer.match(/DEEP_ANALYSIS:\s*(.*?)(?=\n\s*EXTRACT_EMAIL:|$)/s)?.[1]?.trim() || answer;
                const rawNlmEmail = answer.match(/EXTRACT_EMAIL:\s*(.*)/)?.[1]?.trim() || '';
                // NLM zwraca "null" string gdy nie znalazł — odfiltruj
                if (rawNlmEmail && rawNlmEmail.toLowerCase() !== 'null' && isValidEmail(rawNlmEmail)) {
                  nlmEmail = rawNlmEmail;
                  console.log(`[producer-hunt:${taskId}] NLM extracted email for ${lead.company}: ${nlmEmail}`);
                }
              }
            }
          } catch (nlmErr) {
            console.warn(`[producer-hunt:${taskId}] NLM Deep Research failed for ${lead.company}:`, (nlmErr as Error).message);
          } finally {
            if (notebookId) {
              await cleanupNotebook({
                taskId,
                stepId: 'enrich-leads',
                notebookId,
                title: `Deep: ${lead.company} (${taskId})`,
                kind: 'deep-research',
              });
            }
          }
        }

        // 3. Finalne szlifowanie przez LLM (per typ)
        const sourceUrls = Array.isArray(lead.sourceUrls) ? lead.sourceUrls.join('\n') : (lead.sourceUrls ?? '');
        const prompt = finalEnrichmentPromptFor({
          supplierType: declaredOrInferredType,
          lead: {
            company: lead.company,
            website,
            city: lead.city ?? null,
            productCategory: lead.productCategory ?? null,
          },
          researchWebsite,
          website,
          sourceUrls,
          reason: lead.reason ?? null,
          nlmAnalysis,
          nlmHook,
          marketContext,
          leadContext,
          region,
        });

        const parsed = await generateJsonWithFallback({
          taskId,
          stepId: 'enrich-leads',
          entityName: lead.company,
          prompt,
          schema: enrichmentResponseSchema,
          localAgent: producerHuntEnrichmentAgent,
          repairAgent: producerHuntJsonRepairAgent,
          cloudFallbackAgent: producerHuntCloudFallbackAgent,
          fallback: () => ({
            companyName: lead.company,
            supplierType: declaredOrInferredType,
            personalizationHook: nlmHook || lead.reason || defaultHookForType(declaredOrInferredType, region),
            rawAnalysis: nlmAnalysis || leadContext || 'Brak głębokiego researchu.',
            website: researchWebsite ?? website,
            identityConfidence: 0.5,
            brandsOrPortfolio: [],
            servesRegions: [],
          }),
        });

        const rawAnalysis = normalizeTextField(
          parsed.rawAnalysis,
          normalizeTextField(nlmAnalysis || leadContext, 'Brak głębokiego researchu.'),
        );

        const personalizationHook = normalizeTextField(
          parsed.personalizationHook,
          nlmHook || defaultHookForType(declaredOrInferredType, region),
        );

        // Priorytet email: existing valid email z discovery > email wyciągnięty z NotebookLM > null
        const effectiveEmail = isValidEmail(lead.email)
          ? lead.email
          : (nlmEmail && isValidEmail(nlmEmail) ? nlmEmail : lead.email);
        const effectiveEmailSource = lead.email && isValidEmail(lead.email)
          ? lead.emailSource
          : (nlmEmail ? 'notebooklm' : lead.emailSource);

        const candidate = {
          ...lead,
          email: effectiveEmail,
          emailSource: effectiveEmailSource,
          companyName: normalizeOptionalText(parsed.companyName) ?? lead.company,
          website: normalizeNullableString(parsed.website ?? researchWebsite ?? website ?? lead.website),
          personalizationHook,
          rawAnalysis,
          supplierType: parsed.supplierType ?? lead.supplierType,
          directToHoreca: parsed.directToHoreca ?? lead.directToHoreca,
          brandsOrPortfolio: parsed.brandsOrPortfolio ?? lead.brandsOrPortfolio,
          servesRegions: parsed.servesRegions ?? lead.servesRegions,
        };

        // Identity Guardrail
        const identity = validateEnrichmentIdentity(lead, parsed);
        if (!identity.ok || (parsed.identityConfidence && parsed.identityConfidence < 0.5)) {
          console.warn(`[producer-hunt:${taskId}] identity mismatch for ${lead.company}:`, identity.reasons.join(', '));
          // Reset to safe values if identity is doubtful
          candidate.personalizationHook = defaultHookForType(declaredOrInferredType, region);
          candidate.rawAnalysis = `Wstępny research dla ${lead.company}. Wymaga weryfikacji tożsamości. Original analysis: ${rawAnalysis.slice(0, 100)}...`;
        }

        const validation = enrichedLeadSchema.safeParse(candidate);
        if (!validation.success) {
          console.warn(`[producer-hunt:${taskId}] schema repair fallback for ${lead.company}:`, validation.error.message);
          const fallbackCandidate: EnrichedLead = {
            ...lead,
            personalizationHook: defaultHookForType(declaredOrInferredType, region),
            rawAnalysis: 'Błąd walidacji enrichmentu.',
            companyName: lead.company,
          };
          const fallbackQuality = scoreLead(fallbackCandidate, region);
          fallbackCandidate.inferredSupplierType = fallbackQuality.inferredSupplierType;
          await db.collection('leads').updateOne(
            { companyName: lead.company, region },
            {
              $set: {
                status: fallbackQuality.decision === 'reject' ? 'research_rejected' : 'research_enriched',
                segment: mapToCrmSegment(fallbackQuality.inferredSupplierType),
                updatedAt: new Date(),
                'metadata.postResearchQuality': fallbackQuality,
                'metadata.supplierType': fallbackQuality.inferredSupplierType,
              },
            },
          );
          if (fallbackQuality.decision === 'reject') {
            enrichedRejected++;
            continue;
          }
          enriched.push(fallbackCandidate);
        } else {
          const postResearchQuality = scoreLead(validation.data, region);
          const enrichedWithType: EnrichedLead = {
            ...validation.data,
            inferredSupplierType: postResearchQuality.inferredSupplierType,
          };

          await db.collection('leads').updateOne(
            { companyName: lead.company, region },
            {
              $set: {
                status: postResearchQuality.decision === 'reject' ? 'research_rejected' : 'research_enriched',
                segment: mapToCrmSegment(postResearchQuality.inferredSupplierType),
                website: validation.data.website,
                updatedAt: new Date(),
                'metadata.postResearchQuality': postResearchQuality,
                'metadata.supplierType': postResearchQuality.inferredSupplierType,
                'metadata.directToHoreca': validation.data.directToHoreca,
                'metadata.brandsOrPortfolio': validation.data.brandsOrPortfolio,
                'metadata.servesRegions': validation.data.servesRegions,
                'metadata.enrichmentPreview': {
                  website: validation.data.website,
                  companyName: validation.data.companyName,
                  personalizationHook: validation.data.personalizationHook,
                  rawAnalysisPreview: validation.data.rawAnalysis.slice(0, 500),
                },
              },
            },
          );

          console.log(
            `[producer-hunt:${taskId}] post-research quality ${lead.company}: type=${postResearchQuality.inferredSupplierType}, decision=${postResearchQuality.decision}, score=${postResearchQuality.score}, reasons=${postResearchQuality.reasons.join('; ')}`,
          );

          if (postResearchQuality.decision === 'reject') {
            console.warn(`[producer-hunt:${taskId}] post-research reject ${lead.company}`);
            enrichedRejected++;
            continue;
          }
          enriched.push(enrichedWithType);
        }
      } catch (err) {
        console.warn(`[producer-hunt:${taskId}] enrichment fail dla ${lead.company}:`, (err as Error).message);

        // P1.5: nie nadpisuj pustym placeholderem, jeśli mamy już dane z NotebookLM lub Tavily.
        const preservedAnalysis =
          normalizeTextField(nlmAnalysis, '')
          || normalizeTextField(leadContext, '')
          || normalizeTextField(lead.reason, '')
          || 'Enrichment niedostępny.';

        if (nlmAnalysis) preservedSource = 'nlm';
        else if (leadContext) preservedSource = 'searchContext';
        else if (lead.reason) preservedSource = 'leadReason';

        const preservedHook =
          normalizeTextField(nlmHook, '')
          || normalizeTextField(lead.reason, '')
          || defaultHookForType(declaredOrInferredType, region);

        const fallbackCandidate: EnrichedLead = {
          ...lead,
          personalizationHook: preservedHook,
          rawAnalysis: preservedAnalysis,
          companyName: lead.company,
        };
        const fallbackQuality = scoreLead(fallbackCandidate, region);
        fallbackCandidate.inferredSupplierType = fallbackQuality.inferredSupplierType;

        // Zapis diagnostyki do CRM, żeby widać było że enrichment padł, ale dane się zachowały.
        try {
          await db.collection('leads').updateOne(
            { companyName: lead.company, region },
            {
              $set: {
                'metadata.enrichmentError': (err as Error).message,
                'metadata.usedPreservedNlmData': preservedSource !== 'none',
                'metadata.preservedSource': preservedSource,
                updatedAt: new Date(),
              },
            },
          );
        } catch (logErr) {
          console.warn(`[producer-hunt:${taskId}] failed to record enrichment error for ${lead.company}:`, (logErr as Error).message);
        }

        if (fallbackQuality.decision === 'reject') {
          enrichedRejected++;
          continue;
        }
        enriched.push(fallbackCandidate);
      }
    }

    const enrichedByType: Record<string, number> = {};
    for (const e of enriched) {
      const t = (e.inferredSupplierType ?? e.supplierType ?? 'unknown') as string;
      enrichedByType[t] = (enrichedByType[t] ?? 0) + 1;
    }

    await logProducerHuntEvent({
      taskId,
      stepId: 'enrich-leads',
      event: 'enrichment_summary',
      metrics: {
        region,
        inputCandidates: validLeads.length,
        enrichedAccepted: enriched.length,
        enrichedRejected,
        enrichedByType,
      },
    });

    return {
      taskId,
      region,
      enriched,
      researchOnlyCount: context.inputData.researchOnlyCount,
      postResearchSummary: {
        inputCandidates: validLeads.length,
        enrichedAccepted: enriched.length,
        enrichedRejected,
      },
    };
  },
});


// ── Step 04: extract-emails ─────────────────────────────────────────────────
const extractEmailsStep = createStep({
  id: 'extract-emails',
  description:
    'Dla leadów bez maila ale z rawAnalysis próbuje wyciągnąć adres przez LLM (jarvis index.ts:499-510).',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enriched: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
    postResearchSummary: postResearchSummarySchema.optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enrichedWithEmails: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, enriched } = context.inputData;
    const out: EnrichedLead[] = [];

    // P1.6: liczniki dla diagnostyki
    let alreadyHadEmail = 0;
    let foundByRegex = 0;
    let foundByLocalLlm = 0;
    let foundByCloud = 0;
    let stillMissing = 0;

    for (const lead of enriched) {
      if (isValidEmail(lead.email)) {
        out.push(lead);
        alreadyHadEmail++;
        continue;
      }

      // 1. Deterministyczny regex po wszystkich źródłach z lead'a.
      const regexCandidate = pickBestEmail({
        rawAnalysis: lead.rawAnalysis,
        emailSource: lead.emailSource,
        website: lead.website,
        sourceUrls: lead.sourceUrls,
      });
      if (regexCandidate && isValidEmail(regexCandidate)) {
        console.log(`[producer-hunt:${taskId}] regex znalazł email dla ${lead.company}: ${regexCandidate}`);
        out.push({ ...lead, email: regexCandidate });
        foundByRegex++;
        continue;
      }

      // 2. Lokalny LLM jako pierwszy fallback po regexie.
      const prompt = `Wyciągnij adres e-mail dla firmy "${lead.company}" z poniższego kontekstu.
Zwróć WYŁĄCZNIE adres email lub słowo "null".
Kontekst: ${lead.rawAnalysis}\nStrona: ${lead.website ?? '-'}`;

      try {
        const res = await producerHuntEmailExtractionAgent.generate(prompt);
        const candidate = res.text.trim().replace(/^"|"$/g, '');
        if (isValidEmail(candidate)) {
          console.log(`[producer-hunt:${taskId}] local LLM znalazł email dla ${lead.company}: ${candidate}`);
          out.push({ ...lead, email: candidate });
          foundByLocalLlm++;
          continue;
        }
        console.warn(`[producer-hunt:${taskId}] local email extraction returned no email for ${lead.company}, próbuję cloud fallback.`);
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] extract-email local LLM fail ${lead.company}:`,
          (err as Error).message,
        );
      }

      // 3. Cloud fallback.
      try {
        const cloudRes = await producerHuntCloudFallbackAgent.generate(`${prompt}\n\nReturn only one email address or null.`);
        const cloudCandidate = cloudRes.text.trim().replace(/^"|"$/g, '');
        if (isValidEmail(cloudCandidate)) {
          console.log(`[producer-hunt:${taskId}] cloud fallback znalazł email dla ${lead.company}: ${cloudCandidate}`);
          out.push({ ...lead, email: cloudCandidate });
          foundByCloud++;
          continue;
        }
      } catch (cloudErr) {
        console.warn(
          `[producer-hunt:${taskId}] extract-email cloud fallback fail ${lead.company}:`,
          (cloudErr as Error).message,
        );
      }

      // Nie usuwamy leada — idzie dalej bez maila, draft go pominie.
      console.warn(`[producer-hunt:${taskId}] brak emaila dla ${lead.company} — zapiszę w CRM jako do researchu.`);
      out.push(lead);
      stillMissing++;
    }

    console.log(
      `[producer-hunt:${taskId}] extract-emails summary: alreadyHadEmail=${alreadyHadEmail}, foundByRegex=${foundByRegex}, foundByLocalLlm=${foundByLocalLlm}, foundByCloud=${foundByCloud}, stillMissing=${stillMissing}`,
    );

    await logProducerHuntEvent({
      taskId,
      stepId: 'extract-emails',
      event: 'email_extraction_summary',
      metrics: {
        region,
        alreadyHadEmail,
        foundByRegex,
        foundByLocalLlm,
        foundByCloud,
        stillMissing,
        total: out.length,
      },
    });

    return {
      taskId,
      region,
      enrichedWithEmails: out,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 05: draft-cold-emails ──────────────────────────────────────────────
const draftColdEmailsStep = createStep({
  id: 'draft-cold-emails',
  description: 'Pisze spersonalizowane maile na podstawie enrichmentu i zasad Patryka.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    enrichedWithEmails: z.array(enrichedLeadSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, enrichedWithEmails } = context.inputData;
    const drafts: Draft[] = [];

    let draftedCount = 0;
    let fallbackDraftedCount = 0;
    let skippedNoEmail = 0;
    let failedCount = 0;
    const draftedByType: Record<string, number> = {};

    for (const lead of enrichedWithEmails) {
      if (!isValidEmail(lead.email)) {
        console.log(`[producer-hunt:${taskId}] skip drafting for ${lead.company} (no email)`);
        skippedNoEmail++;
        continue;
      }

      const draftType: SupplierType = (lead.inferredSupplierType
        ?? lead.supplierType
        ?? 'producer') as SupplierType;

      console.log(`[producer-hunt:${taskId}] drafting email for ${lead.company} (${lead.email}) type=${draftType}...`);

      const fallbackDraft = () => fallbackDraftFor(draftType, { company: lead.company, region });

      const prompt = draftPromptFor(draftType, {
        company: lead.company,
        email: lead.email,
        region,
        rawAnalysis: lead.rawAnalysis,
        personalizationHook: lead.personalizationHook,
        city: lead.city ?? null,
        productCategory: lead.productCategory ?? null,
        brandsOrPortfolio: lead.brandsOrPortfolio ?? null,
        servesRegions: lead.servesRegions ?? null,
      });

      try {
        const parsed = await generateJsonWithFallback({
          taskId,
          stepId: 'draft-cold-emails',
          entityName: lead.company,
          prompt,
          schema: draftResponseSchema,
          localAgent: producerHuntDraftAgent,
          repairAgent: producerHuntJsonRepairAgent,
          cloudFallbackAgent: producerHuntCloudFallbackAgent,
          repairPrompt: (badOutput, error) => {
            const validation = validateDraft(tryParseJson(badOutput) as any || { subject: '', body: '' }, lead);
            const failureList = validation.hardFailures.join(', ');
            return `Napraw poniższy draft maila. Musi być poprawnym JSONem i spełniać wszystkie zasady (zwłaszcza RODO i brak placeholderów).
              Błędy: ${failureList || error}
              Oryginalny output: ${badOutput}`;
          },
          fallback: fallbackDraft,
        });

        // Final quality check
        const validation = validateDraft(parsed, lead);
        if (!validation.ok) {
           console.error(`[producer-hunt:${taskId}] draft validation failed for ${lead.company} even after repair/fallback:`, validation.hardFailures.join(', '));
           const safeDraft = fallbackDraft();
           parsed.subject = safeDraft.subject;
           parsed.body = safeDraft.body;
        }

        drafts.push({
          taskId,
          draftId: `email-${randomUUID().slice(0, 6)}`,
          company: lead.company,
          email: lead.email,
          subject: parsed.subject,
          body: parsed.body,
          enrichment: lead,
        });
        draftedCount++;
        draftedByType[draftType] = (draftedByType[draftType] ?? 0) + 1;
      } catch (err) {
        console.warn(`[producer-hunt:${taskId}] draft fail ${lead.company}:`, (err as Error).message);
        // P0.2: gdy generateJsonWithFallback rzuci wyjątek poza swoim deterministic fallbackiem,
        // używamy fallbackDraftFor (per typ), żeby lead nie został pominięty.
        const safeDraft = fallbackDraft();
        const safeValidation = validateDraft(safeDraft, lead);
        if (safeValidation.ok) {
          drafts.push({
            taskId,
            draftId: `email-${randomUUID().slice(0, 6)}`,
            company: lead.company,
            email: lead.email,
            subject: safeDraft.subject,
            body: safeDraft.body,
            enrichment: lead,
          });
          console.log(`[producer-hunt:${taskId}] draft fallback used for ${lead.company} after exception.`);
          fallbackDraftedCount++;
          draftedByType[draftType] = (draftedByType[draftType] ?? 0) + 1;
          await logProducerHuntEvent({
            taskId,
            stepId: 'draft-cold-emails',
            event: 'draft_fallback_used',
            level: 'warn',
            company: lead.company,
            metrics: { supplierType: draftType },
            error: (err as Error).message,
          });
        } else {
          console.error(
            `[producer-hunt:${taskId}] draft fallback failed validation for ${lead.company}:`,
            safeValidation.hardFailures.join(', '),
          );
          failedCount++;
          await logProducerHuntEvent({
            taskId,
            stepId: 'draft-cold-emails',
            event: 'draft_fallback_invalid',
            level: 'error',
            company: lead.company,
            metrics: { supplierType: draftType, hardFailures: safeValidation.hardFailures },
            error: (err as Error).message,
          });
        }
      }
    }

    console.log(`[producer-hunt:${taskId}] generated ${drafts.length} drafts.`);

    const validEmailCount = enrichedWithEmails.filter((l) => isValidEmail(l.email)).length;

    await logProducerHuntEvent({
      taskId,
      stepId: 'draft-cold-emails',
      event: 'draft_summary',
      metrics: {
        region,
        drafted: draftedCount,
        fallbackDrafted: fallbackDraftedCount,
        skippedNoEmail,
        failed: failedCount,
        validEmailCount,
        totalDrafts: drafts.length,
        draftedByType,
      },
    });

    // P0.3: validate-output gating — wykryj sytuacje wymagające uwagi.
    if (drafts.length === 0) {
      const reason = validEmailCount > 0 ? 'valid_email_but_zero_drafts' : 'no_reachable_leads';
      const level: 'error' | 'warn' = validEmailCount > 0 ? 'error' : 'warn';
      console[level === 'error' ? 'error' : 'warn'](
        `[producer-hunt:${taskId}] needs_attention: reason=${reason}, validEmailCount=${validEmailCount}, draftCount=0`,
      );

      await logProducerHuntEvent({
        taskId,
        stepId: 'draft-cold-emails',
        event: 'producer_hunt_needs_attention',
        level,
        skippedReason: reason,
        metrics: {
          region,
          validEmailCount,
          draftCount: 0,
          enrichedCount: enrichedWithEmails.length,
        },
      });

      if (validEmailCount > 0) {
        // Twardy błąd workflow — Mastra UI zobaczy step jako failed z czytelnym komunikatem.
        throw new Error(
          `Producer Hunt needs attention: ${validEmailCount} leadów z poprawnym emailem, ale 0 draftów. taskId=${taskId}`,
        );
      }
    }

    return {
      taskId,
      region,
      drafts,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 06: create-gmail-drafts ────────────────────────────────────────────
const createGmailDraftsStep = createStep({
  id: 'create-gmail-drafts',
  description: 'Zapisuje każdy draft jako Gmail draft (do późniejszej akceptacji + wysyłki).',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, drafts } = context.inputData;
    const result: Draft[] = [];
    let gmail: GmailService | null = null;
    for (const draft of drafts) {
      try {
        gmail ??= await GmailService.create();
        const gmailDraftId = await gmail.createDraft({
          to: draft.email,
          subject: draft.subject,
          body: draft.body,
        });
        console.log(`[producer-hunt:${taskId}] gmail draft saved id=${gmailDraftId}`);
        result.push({ ...draft, gmailDraftId });
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] gmail.createDraft fail ${draft.email}:`,
          (err as Error).message,
        );
        result.push(draft);
      }
    }
    return {
      taskId: context.inputData.taskId,
      region: context.inputData.region,
      drafts: result,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 07: save-drafts-fs ─────────────────────────────────────────────────
const saveDraftsFsStep = createStep({
  id: 'save-drafts-fs',
  description:
    'Zapisuje draft.md + draft.meta.json do filesystemu (zgodne z layoutem jarvis dashboardu).',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, drafts } = context.inputData;
    const store = getDraftsStore();
    await store.ensureBaseDir();
    const result: Draft[] = [];
    for (const draft of drafts) {
      const content = `**Do:** ${draft.email}\n**Firma:** ${draft.company}\n**Strona:** ${draft.enrichment?.website ?? 'nieznana'}\n**Temat:** ${draft.subject}\n\n---\n\n${draft.body}`;
      try {
        const enrichmentType = draft.enrichment?.inferredSupplierType
          ?? draft.enrichment?.supplierType
          ?? 'producer';
        const segment = mapToCrmSegment(enrichmentType as SupplierType);
        const fsPath = await store.save({
          taskId,
          draftId: draft.draftId,
          content,
          metadata: {
            draftId: draft.draftId,
            taskId,
            type: 'cold-email',
            language: 'pl',
            status: 'draft',
            company: draft.company,
            region,
            segment,
            supplierType: enrichmentType,
            enrichment: draft.enrichment,
            gmailDraftId: draft.gmailDraftId,
            createdAt: new Date().toISOString(),
            agentId: 'producer-hunt-draft-agent',
            llm: { provider: 'mastra', model: workflowModels.producerHunt.draftEmail, costUsd: 0 },
          },
        });
        result.push({ ...draft, fsPath });
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] save-fs fail ${draft.draftId}:`,
          (err as Error).message,
        );
        result.push(draft);
      }
    }
    return {
      taskId,
      region,
      drafts: result,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 08: update-crm ─────────────────────────────────────────────────────
const updateCrmStep = createStep({
  id: 'update-crm',
  description: 'Upsert leadów do CRM (status=draft_gotowy) + zapis interakcji draft_created.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, region, drafts } = context.inputData;
    const db = await getDb();
    const now = new Date();
    for (const draft of drafts) {
      const interaction = {
        action: 'draft_created',
        description: `Wygenerowano draft (id=${draft.draftId}) po enrichment.`,
        agentId: 'marketing-agent',
        ts: now,
      };
      const enrichmentType = draft.enrichment?.inferredSupplierType
        ?? draft.enrichment?.supplierType
        ?? 'producer';
      const segment = mapToCrmSegment(enrichmentType as SupplierType);

      await db.collection('leads').updateOne(
        { email: draft.email },
        {
          $set: {
            email: draft.email,
            companyName: draft.company,
            segment,
            region,
            status: 'draft_gotowy',
            website: draft.enrichment?.website,
            updatedAt: now,
            metadata: {
              enrichment: draft.enrichment,
              supplierType: enrichmentType,
              draft: {
                subject: draft.subject,
                body: draft.body,
                draftId: draft.draftId,
                gmailDraftId: draft.gmailDraftId,
                fsPath: draft.fsPath,
              },
              taskId,
            },
          },
          $setOnInsert: {
            createdAt: now,
            id: draft.email,
          },
          $push: { history: interaction } as never,
        },
        { upsert: true },
      );
    }
    return {
      taskId,
      region,
      drafts,
      researchOnlyCount: context.inputData.researchOnlyCount,
    };
  },
});

// ── Step 09: await-approval ────────────────────────────────────────────────
const awaitApprovalStep = createStep({
  id: 'await-approval',
  description: 'Wstrzymuje workflow do czasu zatwierdzenia/odrzucenia draftów przez człowieka.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    researchOnlyCount: z.number(),
  }),
  suspendSchema: z.object({
    drafts: z.array(draftSchema),
    message: z.string(),
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
    rejectedDraftIds: z.array(z.string()).optional(),
    feedback: z.string().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    approved: z.boolean(),
    feedback: z.string(),
  }),
  execute: async (context) => {
    const { taskId, region, drafts } = context.inputData;

    if (context.resumeData) {
      const { approved, rejectedDraftIds = [], feedback } = context.resumeData;
      const filtered = approved
        ? drafts.filter((d) => !rejectedDraftIds.includes(d.draftId))
        : [];
      return { taskId, region, drafts: filtered, approved, feedback: feedback ?? '' };
    }

    if (drafts.length === 0) {
      return { taskId, region, drafts: [], approved: false, feedback: 'Brak draftów.' };
    }

    // Persist approval request do MongoDB (kompatybilne z dashboardem jarvis).
    try {
      const db = await getDb();
      await db.collection('approvals').insertOne({
        id: `producer-hunt-${taskId}`,
        kind: 'producer-hunt-drafts',
        taskId,
        region,
        status: 'pending',
        draftCount: drafts.length,
        drafts: drafts.map((d) => ({
          draftId: d.draftId,
          email: d.email,
          company: d.company,
          subject: d.subject,
        })),
        createdAt: new Date(),
      });
    } catch (err) {
      console.warn(
        `[producer-hunt:${taskId}] persist approval fail:`,
        (err as Error).message,
      );
    }

    return context.suspend(
      {
        drafts,
        message: `Zatwierdź ${drafts.length} cold-email draftów producentów (region=${region}). W rejectedDraftIds podaj draftId tych do pominięcia.`,
      },
      { resumeLabel: 'Zatwierdź drafty' },
    );
  },
});

// ── Step 10: send-on-approve ───────────────────────────────────────────────
const sendOnApproveStep = createStep({
  id: 'send-on-approve',
  description: 'Wysyła zaakceptowane drafty przez gmail.sendDraft. Aktualizuje status w CRM.',
  inputSchema: z.object({
    taskId: z.string(),
    region: z.string(),
    drafts: z.array(draftSchema),
    approved: z.boolean(),
    feedback: z.string(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    sentCount: z.number(),
    skippedCount: z.number(),
    approved: z.boolean(),
  }),
  execute: async (context) => {
    const { taskId, drafts, approved } = context.inputData;
    if (!approved || drafts.length === 0) {
      console.log(
        `[producer-hunt:${taskId}] send-on-approve: approved=${approved}, drafts=${drafts.length} → skip.`,
      );
      return { taskId, sentCount: 0, skippedCount: drafts.length, approved };
    }
    const db = await getDb();
    let gmail: GmailService | null = null;
    let sent = 0;
    let skipped = 0;
    for (const draft of drafts) {
      if (!draft.gmailDraftId) {
        console.warn(`[producer-hunt:${taskId}] brak gmailDraftId dla ${draft.email} → skip`);
        skipped++;
        continue;
      }
      try {
        gmail ??= await GmailService.create();
        await gmail.sendDraft(draft.gmailDraftId);
        await db.collection('leads').updateOne(
          { email: draft.email },
          {
            $set: { status: 'email_sent', sentAt: new Date(), updatedAt: new Date() },
            $push: {
              history: {
                action: 'email_sent',
                description: `Wysłano draft ${draft.draftId}.`,
                agentId: 'marketing-agent',
                ts: new Date(),
              },
            } as never,
          },
        );
        sent++;
      } catch (err) {
        console.warn(
          `[producer-hunt:${taskId}] sendDraft fail ${draft.email}:`,
          (err as Error).message,
        );
        skipped++;
      }
    }
    // Mark approval record as completed
    try {
      await db.collection('approvals').updateOne(
        { id: `producer-hunt-${taskId}` },
        { $set: { status: 'approved', completedAt: new Date(), sentCount: sent } },
      );
    } catch {
      /* swallow */
    }
    return { taskId, sentCount: sent, skippedCount: skipped, approved: true };
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────
export const producerHuntWorkflow = createWorkflow({
  id: 'producer-hunt',
  description:
    'Wyszukuje producentów (11-step): gather-sources → discover-via-nlm → classify → enrichment → email-extraction → draft → gmail-draft → save-fs → update-crm → approval → send.',
  inputSchema: z.object({
    region: z.string(),
    count: z.number().default(10),
    productType: z.string().optional(),
    supplierTypes: z.array(supplierTypeSchema).optional(),
    userContext: z.string().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    sentCount: z.number(),
    skippedCount: z.number(),
    approved: z.boolean(),
  }),
})
  .then(gatherSourcesStep)
  .then(discoverViaNlmStep)
  .then(createResearchLeadsStep)
  .then(enrichLeadsStep)
  .then(extractEmailsStep)
  .then(draftColdEmailsStep)
  .then(createGmailDraftsStep)
  .then(saveDraftsFsStep)
  .then(updateCrmStep)
  .then(awaitApprovalStep)
  .then(sendOnApproveStep);

producerHuntWorkflow.commit();
