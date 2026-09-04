/**
 * Hunt Agent — Market Packs (localization layer, §7 of ideas/huntAgent.md).
 *
 * The deterministic quality engine in workflows/producer-hunt/quality.ts is Poland-coded
 * (REGION_TOKENS, PUBLIC_EMAIL_DOMAINS, DIRECTORIES, RETAIL_CHAIN_KEYWORDS, legalForms, and a
 * hard-checked Polish RODO footer). A Market Pack carries the per-locale knowledge the huntAgent
 * needs so the SAME pipeline can run on a foreign market without rewriting the gates.
 *
 * Design (locked 2026-06-15):
 *   - Universal gates (email validity, domain match, official-vs-social, scoring structure) are
 *     locale-agnostic and live in quality.ts unchanged.
 *   - A Market Pack supplies the locale-specific layer. PL = first-class (today's constants, 1:1).
 *     Foreign markets = `degraded` best-effort: minimum viable pack (output language, search
 *     locale, compliance footer) + more weight on the LLM/researcher.
 *   - Quality is a slider, not a switch: the more of a pack you fill, the closer to PL rigor.
 *
 * Phase 1 scope: the PL pack (first-class) + an Icelandic (`is`) degraded stub as the worked
 * example that the agent flags as degraded in the Hunt Report. Promoting a market to first-class =
 * filling its lists (directories/chains/domains/legal-forms/keywords) here later — hours, not weeks.
 */
import type { FooterCheck } from '../workflows/producer-hunt/quality.js';

export interface MarketPack {
  /** ISO-ish locale key, e.g. 'pl', 'is'. */
  locale: string;
  /** Human label for the Hunt Report. */
  label: string;
  /** Default email/output language for this market (overridable per HuntBrief). */
  outputLanguage: string;
  /** Steers researcherAgent / Tavily toward the right sources. */
  searchLocale: { lang: string; country: string; tldHints: string[] };
  /**
   * The compliance-footer markers `validateDraft` hard-checks for this market.
   * PL = the literal RODO footer; foreign markets = their own GDPR/EEA wording.
   */
  footerCheck: FooterCheck;
  /**
   * Whether this pack is first-class (PL) or a degraded best-effort stub. When `degraded`, the
   * agent MUST flag the market explicitly in the Hunt Report and lean on universal gates + the
   * researcher rather than hard locale filters.
   */
  degraded: boolean;
}

/**
 * PL — first-class. Footer is today's quality.ts RODO check 1:1, so a PL run through the huntAgent
 * is byte-for-byte equivalent to the producer-hunt workflow's draft gate.
 */
const PL_PACK: MarketPack = {
  locale: 'pl',
  label: 'Polska (PL) — first-class',
  outputLanguage: 'pl',
  searchLocale: { lang: 'pl', country: 'PL', tldHints: ['.pl'] },
  footerCheck: {
    adminMarker: 'Administratorem danych jest GastroBridge',
    optOutMarker: '"STOP"',
    purposeMarker: 'Cel kontaktu:',
    sourceMarker: 'Źródło danych:',
    template:
      'Administratorem danych jest Organization (Data Controller). ' +
      'Cel kontaktu: nawiązanie relacji biznesowej w sektorze HoReCa. ' +
      'Źródło danych: publicznie dostępne informacje (<źródło>). ' +
      'Jeśli nie chcesz otrzymywać wiadomości, odpowiedz "STOP", a usuniemy Twoje dane.',
    label: 'Brak pełnej stopki RODO (wymagane: administrator, cel kontaktu, źródło danych, opt-out "STOP")',
  },
  degraded: false,
};

/**
 * EN — International / Global B2B. First-class English market pack for global lead hunting.
 */
const EN_PACK: MarketPack = {
  locale: 'en',
  label: 'International / Global (EN) — first-class',
  outputLanguage: 'en',
  searchLocale: { lang: 'en', country: 'US', tldHints: ['.com', '.io', '.co.uk', '.eu', '.org', '.net', '.de', '.se', '.no'] },
  footerCheck: {
    adminMarker: 'Data controller:',
    optOutMarker: '"Unsubscribe"',
    purposeMarker: 'reaching out',
    template:
      'Data controller: Organization (Data Controller). ' +
      'Purpose: establishing legitimate B2B business relations. ' +
      'Source: publicly available business information (<source>). ' +
      'If you prefer not to receive future emails, reply with "Unsubscribe" to have your details removed.',
    label: 'Missing GDPR compliance footer (required: controller, purpose, source, opt-out "Unsubscribe")',
  },
  degraded: false,
};

/**
 * IS — degraded best-effort stub. Supplies the minimum (output language, Icelandic search locale,
 * an Icelandic GDPR/EEA opt-out footer). Directory/chain/domain/legal-form filtering falls back to
 * the universal gates + researcher knowledge until this market is promoted to first-class.
 */
const IS_PACK: MarketPack = {
  locale: 'is',
  label: 'Ísland (IS) — degraded best-effort',
  outputLanguage: 'is',
  searchLocale: { lang: 'is', country: 'IS', tldHints: ['.is'] },
  footerCheck: {
    // Icelandic GDPR/EEA controller + opt-out wording. Keep brand + opt-out verifiable as a hard gate.
    // Degraded stub: only the universal admin+opt-out markers are hard-checked (no purpose/source
    // markers yet) until IS is promoted to first-class.
    adminMarker: 'Ábyrgðaraðili gagna er GastroBridge',
    optOutMarker: '"STOP"',
    template:
      'Ábyrgðaraðili gagna er Organization (Data Controller). ' +
      'Tilgangur: að koma á viðskiptasambandi í HoReCa-geiranum. ' +
      'Uppruni gagna: opinberlega aðgengilegar upplýsingar (<source>). ' +
      'Ef þú vilt ekki fá fleiri skilaboð, svaraðu "STOP" og við fjarlægjum gögnin þín.',
    label: 'Vantar persónuverndarfót (GDPR)',
  },
  degraded: true,
};

const PACKS: Record<string, MarketPack> = {
  pl: PL_PACK,
  en: EN_PACK,
  global: EN_PACK,
  international: EN_PACK,
  is: IS_PACK,
};

export const DEFAULT_MARKET = 'pl';

/**
 * Resolve a Market Pack by locale. Unknown markets get a degraded clone of the requested locale so
 * the agent can still run (universal gates + researcher) and will flag it as degraded.
 */
export function getMarketPack(market?: string | null): MarketPack {
  const key = (market ?? DEFAULT_MARKET).trim().toLowerCase();
  const pack = PACKS[key];
  if (pack) return pack;
  // Unknown market → degraded fallback: keep PL footer as the safety net but mark degraded so the
  // agent surfaces "verify compliance footer manually for <market>" in the Hunt Report.
  return {
    locale: key,
    label: `${key.toUpperCase()} — unknown market (degraded fallback)`,
    outputLanguage: key,
    searchLocale: { lang: key, country: key.toUpperCase(), tldHints: [] },
    footerCheck: PL_PACK.footerCheck,
    degraded: true,
  };
}

export function listMarkets(): string[] {
  return Object.keys(PACKS);
}
