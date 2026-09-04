/**
 * Hunt Agent — deterministic quality-gate tools (Phase 0).
 *
 * Wraps the "gold" deterministic logic that lives in the producer-hunt workflow
 * (workflows/producer-hunt/quality.ts + email.ts) as must-call agent tools, so the
 * huntAgent can run the SAME reliability gates the workflow runs — WITHOUT touching
 * the workflow (it keeps importing those functions unchanged).
 *
 * Design principle (ideas/huntAgent.md §1): the LLM owns strategy + creativity; these
 * deterministic gates own verification. The agent decides WHAT to research and HOW to
 * phrase an email; these tools decide WHETHER a lead is good enough and WHETHER a draft
 * is allowed to ship.
 *
 * Scope: supplier scoring (`scoreLead`) + restaurant scoring (`scoreRestaurant`, Phase 3,
 * dispatched by `targetKind`). The Market Pack footer parameterization for `validateDraftTool`
 * is wired (Phase 1).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  scoreLead,
  scoreRestaurant,
  mapToCrmSegment,
  validateEnrichmentIdentity,
  validateDraft,
} from '../../workflows/producer-hunt/quality.js';
import { pickBestEmail } from '../../workflows/producer-hunt/email.js';
import { getMarketPack, listMarkets } from '../../lib/hunt-market-pack.js';

// ─── Shared lead-shape schema (mirrors producer-hunt Lead, all optional but company) ──
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

const leadShape = z.object({
  company: z.string().describe('Company name as discovered.'),
  companyName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  rawAnalysis: z.string().nullable().optional().describe('Deep-research text (enrichment), if available.'),
  personalizationHook: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  productCategory: z.string().nullable().optional(),
  sourceUrls: z.union([z.array(z.string()), z.string()]).nullable().optional(),
  emailSource: z.string().nullable().optional(),
  isProducer: z.boolean().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  supplierType: supplierTypeSchema.nullable().optional(),
  directToHoreca: z.enum(['yes', 'limited', 'no', 'unknown']).nullable().optional(),
  servesRegions: z.array(z.string()).nullable().optional(),
  brandsOrPortfolio: z.array(z.string()).nullable().optional(),
});

// ─── score_lead ────────────────────────────────────────────────────────────────
export const huntScoreLeadTool = createTool({
  id: 'hunt_score_lead',
  description:
    'DETERMINISTIC lead-quality gate. Scores ONE candidate 0–100 and returns a decision ' +
    '(draft_candidate ≥55 | research_needed ≥25 | reject) plus the inferred supplier type and a ' +
    'human-readable list of scoring reasons. Rewards a valid email, email↔website domain match, ' +
    'official site, food/production/wholesale/distribution/importer/cooperative signals, region match ' +
    'and legal form; penalizes directories (-40), social-only (-15), retail chains (-25), end-consumer ' +
    'signals and negative research findings. Call this on EVERY candidate after discovery and again ' +
    'after enrichment — never decide lead quality with your own judgment. ' +
    'For targetKind "restaurant" the polarity flips: venue/menu/booking/reputation signals QUALIFY a ' +
    'demand-side customer, and end-consumer venue words are no longer a penalty. Call this on EVERY ' +
    'candidate after discovery and again after enrichment — never decide lead quality with your own judgment.',
  inputSchema: z.object({
    lead: leadShape,
    region: z.string().describe('Target region for region-match scoring, e.g. "Dolnośląskie".'),
    targetKind: z
      .enum(['supplier', 'restaurant'])
      .default('supplier')
      .describe('What we are hunting: "supplier" (sell-side) or "restaurant" (GastroBridge customer).'),
  }),
  outputSchema: z.object({
    score: z.number(),
    decision: z.enum(['draft_candidate', 'research_needed', 'reject']),
    inferredSupplierType: supplierTypeSchema,
    crmSegment: z.string().describe('Suggested CRM segment: a supplier type, or "restaurant" for demand-side leads.'),
    reasons: z.array(z.string()),
  }),
  execute: async (context) => {
    const q =
      context.targetKind === 'restaurant'
        ? scoreRestaurant(context.lead as any, context.region)
        : scoreLead(context.lead as any, context.region);
    return {
      score: q.score,
      decision: q.decision,
      inferredSupplierType: q.inferredSupplierType,
      crmSegment: context.targetKind === 'restaurant' ? 'restaurant' : mapToCrmSegment(q.inferredSupplierType),
      reasons: q.reasons,
    };
  },
});

// ─── validate_enrichment_identity ────────────────────────────────────────────────
export const huntValidateEnrichmentIdentityTool = createTool({
  id: 'hunt_validate_enrichment_identity',
  description:
    'DETERMINISTIC sanity check that the enrichment is about the SAME company as the discovered lead ' +
    '(catches research drift to a different firm). Compares company-name tokens, email↔website domain ' +
    'coherence (with tolerance for wholesalers/distributors that legitimately use separate B2B domains), ' +
    'flags foreign domains, and detects supplier-type drift vs the heuristic. Returns ok + a confidence ' +
    '(ok when ≥0.5) + reasons. Call after ENRICH, before drafting.',
  inputSchema: z.object({
    lead: leadShape.describe('The originally discovered lead.'),
    enriched: leadShape
      .extend({ rawAnalysis: z.string().nullable().optional() })
      .describe('The enrichment result (companyName, website, supplierType, rawAnalysis…).'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    confidence: z.number(),
    reasons: z.array(z.string()),
  }),
  execute: async (context) => {
    const check = validateEnrichmentIdentity(context.lead as any, context.enriched as any);
    return { ok: check.ok, confidence: check.confidence, reasons: check.reasons };
  },
});

// ─── validate_draft ──────────────────────────────────────────────────────────────
export const huntValidateDraftTool = createTool({
  id: 'hunt_validate_draft',
  description:
    'DETERMINISTIC hard gate for a cold-email draft before it can become a Gmail draft. HARD failures ' +
    '(block shipping): subject too short, leftover placeholders ([imię], {{…}}, XYZ…), missing the ' +
    '"GastroBridge" name, invented competitor names, or an incomplete RODO footer (PL requires ALL of: ' +
    'controller, "Cel kontaktu:", "Źródło danych:", opt-out "STOP"). On a footer hardFailure, append the ' +
    'canonical `footerTemplate` from hunt_get_market_pack — do NOT hunt for it in files. SOFT warnings ' +
    '(advisory): draft too short, no concrete detail from research, no reference to the company offer, or ' +
    'a sales/pricing tone ("darmowe"/cennik) — first contact is a relationship initiation, not an offer. ' +
    'Call on EVERY draft (your own or a worker\'s). A draft with any hardFailure MUST NOT be sent — fix and re-validate. ' +
    'The compliance-footer check is parameterized by `market` (default "pl" = the RODO footer; foreign ' +
    'markets check that locale\'s GDPR/EEA opt-out wording from the Market Pack).',
  inputSchema: z.object({
    draft: z.object({
      subject: z.string(),
      body: z.string(),
    }),
    lead: leadShape.partial().extend({ company: z.string().optional() }).optional()
      .describe('Optional lead context (rawAnalysis) for the soft "uses research" check.'),
    market: z
      .string()
      .default('pl')
      .describe('Active market locale (e.g. "pl", "is"). Selects which compliance footer is hard-checked. Default "pl".'),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('true = no hardFailures, safe to proceed.'),
    hardFailures: z.array(z.string()),
    softWarnings: z.array(z.string()),
    marketDegraded: z.boolean().describe('true when the active market is a degraded best-effort pack — flag it in the Hunt Report.'),
  }),
  execute: async (context) => {
    const pack = getMarketPack(context.market);
    const res = validateDraft(context.draft, context.lead ?? {}, pack.footerCheck);
    return {
      ok: res.ok,
      hardFailures: res.hardFailures,
      softWarnings: res.softWarnings,
      marketDegraded: pack.degraded,
    };
  },
});

// ─── get_market_pack ──────────────────────────────────────────────────────────────
export const huntGetMarketPackTool = createTool({
  id: 'hunt_get_market_pack',
  description:
    'Resolve the Market Pack for a locale (§7 localization). Returns the default output language, the ' +
    'search locale (lang/country/TLD hints to steer researcherAgent / Tavily), the CANONICAL compliance ' +
    'footer (`footerTemplate` — append it verbatim to every email, replacing only the `<źródło>` token ' +
    'with the public source the lead was found at), the markers the draft must contain, and whether the ' +
    'pack is DEGRADED (best-effort). This is your SOURCE OF TRUTH for the footer — when hunt_validate_draft ' +
    'reports a missing/incomplete footer, append `footerTemplate` from here; NEVER search source files for ' +
    'it. Call in INTAKE to set the run\'s market + outputLanguage. PL is first-class; unknown/foreign ' +
    'markets return a degraded pack you MUST flag in the Hunt Report. Default market "pl".',
  inputSchema: z.object({
    market: z.string().default('pl').describe('Target market locale, e.g. "pl", "is". Default "pl".'),
  }),
  outputSchema: z.object({
    locale: z.string(),
    label: z.string(),
    outputLanguage: z.string(),
    searchLocale: z.object({
      lang: z.string(),
      country: z.string(),
      tldHints: z.array(z.string()),
    }),
    footerTemplate: z
      .string()
      .nullable()
      .describe('Canonical footer to append verbatim; replace only the `<źródło>` token. null if the pack carries markers only.'),
    footerMarkers: z.object({
      adminMarker: z.string(),
      optOutMarker: z.string(),
      purposeMarker: z.string().nullable(),
      sourceMarker: z.string().nullable(),
    }),
    degraded: z.boolean(),
    knownMarkets: z.array(z.string()),
  }),
  execute: async (context) => {
    const pack = getMarketPack(context.market);
    return {
      locale: pack.locale,
      label: pack.label,
      outputLanguage: pack.outputLanguage,
      searchLocale: pack.searchLocale,
      footerTemplate: pack.footerCheck.template ?? null,
      footerMarkers: {
        adminMarker: pack.footerCheck.adminMarker,
        optOutMarker: pack.footerCheck.optOutMarker,
        purposeMarker: pack.footerCheck.purposeMarker ?? null,
        sourceMarker: pack.footerCheck.sourceMarker ?? null,
      },
      degraded: pack.degraded,
      knownMarkets: listMarkets(),
    };
  },
});

// ─── pick_best_email ──────────────────────────────────────────────────────────────
export const huntPickBestEmailTool = createTool({
  id: 'hunt_pick_best_email',
  description:
    'DETERMINISTIC email extractor. Scans enrichment text / emailSource / website / sourceUrls for valid ' +
    'addresses, strips placeholders (example.com, test@, name@domain), normalizes them, and prefers the ' +
    'address whose domain matches the company website. Returns the best email or null. This is the FIRST ' +
    'extraction step — only fall back to a run_worker(fast) then run_worker(cloud) LLM pass if this returns null.',
  inputSchema: z.object({
    rawAnalysis: z.string().nullable().optional(),
    emailSource: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    sourceUrls: z.union([z.array(z.string()), z.string()]).nullable().optional(),
    leadContext: z.string().nullable().optional(),
  }),
  outputSchema: z.object({
    email: z.string().nullable(),
    found: z.boolean(),
  }),
  execute: async (context) => {
    const email = pickBestEmail({
      rawAnalysis: context.rawAnalysis ?? null,
      emailSource: context.emailSource ?? null,
      website: context.website ?? null,
      sourceUrls: context.sourceUrls ?? null,
      leadContext: context.leadContext ?? null,
    });
    return { email, found: email != null };
  },
});

export const huntQualityTools = {
  huntScoreLeadTool,
  huntValidateEnrichmentIdentityTool,
  huntValidateDraftTool,
  huntPickBestEmailTool,
  huntGetMarketPackTool,
};
