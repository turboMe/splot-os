/**
 * Marketing-agent scorers (Etap 10 §12.1).
 *
 * - `marketingDraftingCompletenessScorer` — LLM-judge ocenia czy wygenerowany
 *   cold-email zawiera: subject, body, personalizację (referencje do firmy / hook),
 *   CTA, język polski. Nieblokujący.
 */
import { z } from 'zod';
import { createScorer } from '@mastra/core/evals';
import {
  getAssistantMessageFromRunOutput,
  getUserMessageFromRunInput,
} from '@mastra/evals/scorers/utils';

export const marketingDraftingCompletenessScorer = createScorer({
  id: 'marketing-drafting-completeness',
  name: 'Marketing Drafting Completeness',
  description:
    'Ocena draftów cold-email pod kątem kompletności (subject + body + personalizacja + CTA + język).',
  type: 'agent',
  judge: {
    model: 'google/gemini-2.5-pro',
    instructions:
      'Jesteś recenzentem cold-email outreachu B2B. Oceniasz czy draft spełnia minimalne wymogi: subject, body, personalizacja, CTA, poprawny język. Zwracasz wyłącznie JSON.',
  },
})
  .preprocess(({ run }) => {
    const userText = getUserMessageFromRunInput(run.input) || '';
    const assistantText = getAssistantMessageFromRunOutput(run.output) || '';
    return { userText, assistantText };
  })
  .analyze({
    description: 'Wyciąga subject/body/personalizację z odpowiedzi i ocenia kompletność.',
    outputSchema: z.object({
      hasSubject: z.boolean(),
      hasBody: z.boolean(),
      hasPersonalization: z.boolean(),
      hasCTA: z.boolean(),
      languageOk: z.boolean(),
      explanation: z.string().default(''),
    }),
    createPrompt: ({ results }) => `
Oceń kompletność cold-email draftu wygenerowanego przez agenta.

Brief (zapytanie użytkownika lub kontekst zadania):
"""
${results.preprocessStepResult.userText}
"""

Wygenerowany draft (odpowiedź agenta — może być JSON { subject, body } lub tekst):
"""
${results.preprocessStepResult.assistantText}
"""

Sprawdź czy draft ma:
- subject: temat (linia tematu)
- body: treść maila (≥ 2 zdania, ale ≤ 4-5 zdań — krótki cold-email)
- personalizacja: referencja do nazwy firmy lub konkretu z firmy/branży (nie generyczna formuła)
- CTA: jasne wezwanie do działania (np. propozycja rozmowy, krótkiego callu)
- languageOk: język zgodny z briefem (jeśli brief po polsku → odpowiedź po polsku)

Zwróć JSON: { "hasSubject": bool, "hasBody": bool, "hasPersonalization": bool, "hasCTA": bool, "languageOk": bool, "explanation": "..." }
    `,
  })
  .generateScore(({ results }) => {
    const r = (results as any)?.analyzeStepResult || {};
    const flags = [r.hasSubject, r.hasBody, r.hasPersonalization, r.hasCTA, r.languageOk];
    const hits = flags.filter(Boolean).length;
    return hits / flags.length;
  })
  .generateReason(({ results, score }) => {
    const r = (results as any)?.analyzeStepResult || {};
    return `subject=${r.hasSubject ?? false}, body=${r.hasBody ?? false}, personalization=${r.hasPersonalization ?? false}, cta=${r.hasCTA ?? false}, lang=${r.languageOk ?? false}. Score=${score}. ${r.explanation ?? ''}`;
  });

export const marketingScorers = {
  marketingDraftingCompletenessScorer,
};
