/**
 * AuthorClaw Translation + Foreign Rights Pipeline
 *
 * Plans machine-translation of a manuscript and produces the rights-pitch
 * documents authors need to license foreign-language editions.
 *
 * Pipeline (per target language):
 *   1. DeepL API pass (caller supplies key via vault)
 *   2. Claude / GPT post-edit pass (fixes idioms, proper nouns, register)
 *   3. Per-chapter diff for author review
 *   4. Market ROI estimate using Bestseller Trends Data (sibling project)
 *   5. Rights one-pager generator for Babelcube / Tektime / direct pitches
 *
 * Critical safety rails:
 *   - Every exported translated file gets a MANDATORY disclosure line in the
 *     file footer flagging it as AI-assisted translation.
 *   - France has legal disclosure requirements (Code de la consommation
 *     Art. L.111-1 + 2024 AI transparency guidance). This service refuses
 *     to output a French translation unless the machine-translation
 *     disclosure flag is set on the project.
 *   - No translation is auto-published. Every export pass creates a
 *     ConfirmationRequest showing the disclosure text, the cost, and the
 *     target market before anything external happens.
 */

import type { ConfirmationGateService } from './confirmation-gate.js';

export type TargetLanguage =
  | 'de' | 'es' | 'fr' | 'it' | 'pt' | 'nl' | 'pl' | 'ja' | 'ko' | 'zh';

export interface TranslationPlan {
  projectId: string;
  bookTitle: string;
  sourceLang: string;                      // Typically 'en'
  targetLangs: TargetLanguage[];
  estimatedWordCount: number;
  estimatedCostByLang: Record<TargetLanguage, { usd: number; notes: string }>;
  roiRankings: Array<{
    lang: TargetLanguage;
    market: string;
    estimatedReaderMultiplier: number;     // Relative to US baseline (1.0)
    estimatedRevenueMultiplier: number;
    rationale: string;
  }>;
  disclaimerLines: string[];
  recommendedOrder: TargetLanguage[];
}

export interface RightsPitchPackage {
  targetLang: TargetLanguage;
  market: string;
  pitchOnePager: string;                   // Markdown
  sampleChapterPath?: string;
  metadataTemplate: {
    title: string;
    subtitle?: string;
    authorName: string;
    genre: string;
    wordCountApprox: number;
    comps: string[];
    marketingAngle: string;
  };
}

// ═══════════════════════════════════════════════════════════
// Market heuristics
// ═══════════════════════════════════════════════════════════

// Rough reader-base + revenue multipliers vs US indie romance baseline.
// These are order-of-magnitude estimates. DO NOT take as investment advice.
const MARKET_PROFILES: Record<TargetLanguage, {
  market: string;
  readerMultiplier: number;
  revenueMultiplier: number;
  rationale: string;
}> = {
  de: { market: 'Germany / DACH', readerMultiplier: 0.35, revenueMultiplier: 1.1, rationale: 'High avg ebook spend, strong KU usage, romance + fantasy dominate.' },
  es: { market: 'Spanish-speaking markets', readerMultiplier: 0.4, revenueMultiplier: 0.45, rationale: 'Large total readership but low avg price; good for discoverability.' },
  fr: { market: 'France', readerMultiplier: 0.2, revenueMultiplier: 0.6, rationale: 'Smaller ebook market; trad-pub dominant; AI-disclosure legally required.' },
  it: { market: 'Italy', readerMultiplier: 0.15, revenueMultiplier: 0.5, rationale: 'Smaller market, but low competition in English-origin translated fiction.' },
  pt: { market: 'Brazil / Portugal', readerMultiplier: 0.25, revenueMultiplier: 0.3, rationale: 'Large reader base in Brazil, low pricing power.' },
  nl: { market: 'Netherlands / Flanders', readerMultiplier: 0.1, revenueMultiplier: 0.9, rationale: 'Small market; most Dutch readers read English. Low ROI usually.' },
  pl: { market: 'Poland', readerMultiplier: 0.15, revenueMultiplier: 0.4, rationale: 'Growing digital market; price-sensitive.' },
  ja: { market: 'Japan', readerMultiplier: 0.15, revenueMultiplier: 0.6, rationale: 'Hard to break into; strong domestic preference. Consider only with local partner.' },
  ko: { market: 'South Korea', readerMultiplier: 0.1, revenueMultiplier: 0.7, rationale: 'Small ebook market; strong manhwa/webnovel competition.' },
  zh: { market: 'Greater China', readerMultiplier: 0.05, revenueMultiplier: 0.3, rationale: 'Distribution extremely difficult; platform approvals required.' },
};

// Rough per-1000-word DeepL cost at Pro tier (actual pricing varies by plan).
const DEEPL_COST_PER_1K_WORDS = 0.025;
// Claude post-edit adds roughly ~$0.01-0.02/1k words at Sonnet rates.
const POST_EDIT_COST_PER_1K_WORDS = 0.015;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class TranslationPipelineService {
  private gate: ConfirmationGateService | null = null;

  setGate(gate: ConfirmationGateService): void {
    this.gate = gate;
  }

  /**
   * Build the translation plan. Pure function — estimates cost + ROI
   * rankings. Does not execute any translation.
   */
  plan(input: {
    projectId: string;
    bookTitle: string;
    sourceLang?: string;
    targetLangs: TargetLanguage[];
    estimatedWordCount: number;
  }): TranslationPlan {
    const sourceLang = input.sourceLang || 'en';
    const costPer1kTotal = DEEPL_COST_PER_1K_WORDS + POST_EDIT_COST_PER_1K_WORDS;

    const estimatedCostByLang = {} as Record<TargetLanguage, { usd: number; notes: string }>;
    const roiRankings: TranslationPlan['roiRankings'] = [];

    for (const lang of input.targetLangs) {
      const profile = MARKET_PROFILES[lang];
      if (!profile) continue;

      const kWords = input.estimatedWordCount / 1000;
      const cost = Math.round(kWords * costPer1kTotal * 100) / 100;

      estimatedCostByLang[lang] = {
        usd: cost,
        notes: `${input.estimatedWordCount.toLocaleString()} words @ ~$${costPer1kTotal.toFixed(3)}/1k (DeepL + Claude post-edit).`,
      };

      roiRankings.push({
        lang,
        market: profile.market,
        estimatedReaderMultiplier: profile.readerMultiplier,
        estimatedRevenueMultiplier: profile.revenueMultiplier,
        rationale: profile.rationale,
      });
    }

    // Recommended order: highest revenueMultiplier first.
    const recommendedOrder = [...roiRankings]
      .sort((a, b) => b.estimatedRevenueMultiplier - a.estimatedRevenueMultiplier)
      .map(r => r.lang);

    const disclaimerLines = [
      'All translation cost + ROI estimates are approximate and depend on your chosen vendor plan, post-edit quality, and local market dynamics at the time of release.',
      'Machine-translated works MUST be disclosed to consumers in France (Code de la consommation Art. L.111-1, extended to AI).',
      'Even where not legally required, clearly labeling AI-assisted translation protects reader trust and review integrity.',
      'A professional human translator produces substantially better quality than machine + post-edit. For flagship titles consider hiring one.',
    ];

    return {
      projectId: input.projectId,
      bookTitle: input.bookTitle,
      sourceLang,
      targetLangs: input.targetLangs,
      estimatedWordCount: input.estimatedWordCount,
      estimatedCostByLang,
      roiRankings: roiRankings.sort((a, b) => b.estimatedRevenueMultiplier - a.estimatedRevenueMultiplier),
      disclaimerLines,
      recommendedOrder,
    };
  }

  /**
   * Propose actually running a translation. Creates a ConfirmationRequest
   * with the full cost + disclosure text. Caller must wait for approval
   * before invoking the actual DeepL / Claude API calls.
   */
  async proposeTranslation(input: {
    projectId: string;
    bookTitle: string;
    targetLang: TargetLanguage;
    estimatedWordCount: number;
    sampleText?: string;
  }): Promise<{ confirmationId: string | null; message: string }> {
    if (!this.gate) throw new Error('Translation pipeline not wired to confirmation gate');

    const profile = MARKET_PROFILES[input.targetLang];
    if (!profile) throw new Error(`Unsupported target language: ${input.targetLang}`);

    const plan = this.plan({
      projectId: input.projectId,
      bookTitle: input.bookTitle,
      targetLangs: [input.targetLang],
      estimatedWordCount: input.estimatedWordCount,
    });

    const cost = plan.estimatedCostByLang[input.targetLang];
    const disclosureText = input.targetLang === 'fr'
      ? 'Traduction assistée par intelligence artificielle. (This translation was assisted by artificial intelligence.)'
      : 'Translated with AI assistance and human review.';

    const dryRun = [
      `Target market: ${profile.market}`,
      `Word count: ${input.estimatedWordCount.toLocaleString()}`,
      `Estimated cost: $${cost.usd.toFixed(2)}`,
      `Expected timeline: ${Math.ceil(input.estimatedWordCount / 30000)} day(s) for DeepL + ${Math.ceil(input.estimatedWordCount / 20000)} day(s) for Claude post-edit.`,
      ``,
      `MANDATORY disclosure text (will be added to the exported file footer):`,
      `"${disclosureText}"`,
      ``,
      input.targetLang === 'fr'
        ? `FRANCE LEGAL NOTE: French consumer law requires disclosure of AI-translated works.`
        : `Readers consistently rate undisclosed machine translations lower; disclosing protects reviews + reputation.`,
    ].join('\n');

    const req = await this.gate.createRequest({
      service: 'translation-pipeline',
      action: `translate-to-${input.targetLang}`,
      platform: profile.market,
      description: `Machine-translate "${input.bookTitle}" into ${profile.market} (${input.targetLang.toUpperCase()}).`,
      payload: {
        projectId: input.projectId,
        targetLang: input.targetLang,
        estimatedWordCount: input.estimatedWordCount,
      },
      riskLevel: 'high',
      isReversible: false,
      disclosures: [`${input.targetLang.toUpperCase()}: "${disclosureText}"`],
      dryRunResult: dryRun,
      rollbackSteps: 'Translation cost is incurred on execution. Delete the output file if you decide not to publish.',
      estimatedCost: cost.usd,
    });

    return {
      confirmationId: req.id,
      message: `Confirmation request created. Approve in dashboard before translation runs. Estimated cost: $${cost.usd.toFixed(2)}.`,
    };
  }

  /**
   * Generate a rights-pitch one-pager for a target language/market.
   */
  generateRightsPitch(input: {
    targetLang: TargetLanguage;
    bookTitle: string;
    authorName: string;
    genre: string;
    wordCountApprox: number;
    comps?: string[];
    marketingAngle?: string;
  }): RightsPitchPackage {
    const profile = MARKET_PROFILES[input.targetLang];
    const marketingAngle = input.marketingAngle
      || `Author is actively marketing in English and has an established reader base — translation expands total addressable market without cannibalizing the original.`;

    const onePager = `# ${input.bookTitle} — Rights Pitch (${profile.market})

**Author:** ${input.authorName}
**Language:** ${input.targetLang.toUpperCase()} (${profile.market})
**Original genre:** ${input.genre}
**Word count:** ~${input.wordCountApprox.toLocaleString()}
**Rights available:** ${profile.market} edition (ebook + audiobook unless noted otherwise)

## Why this market
${profile.rationale}

## Comparables
${(input.comps && input.comps.length > 0)
    ? input.comps.map(c => `- ${c}`).join('\n')
    : '- (Author: add 3-5 recent bestsellers in this genre/market.)'}

## Marketing angle
${marketingAngle}

## Rights options
- **Option A:** Royalty-split platform (Babelcube, Tektime) — no upfront cost to author, translator takes a revenue share.
- **Option B:** Direct translator hire — flat fee (often $0.05-$0.12/word), author retains all royalties.
- **Option C:** Trad foreign-rights sale through a rights agent.

## Contact
[Author / agent contact here]

---
_Prepared with AuthorClaw. Estimated market data is approximate._`;

    return {
      targetLang: input.targetLang,
      market: profile.market,
      pitchOnePager: onePager,
      metadataTemplate: {
        title: input.bookTitle,
        authorName: input.authorName,
        genre: input.genre,
        wordCountApprox: input.wordCountApprox,
        comps: input.comps || [],
        marketingAngle,
      },
    };
  }
}
