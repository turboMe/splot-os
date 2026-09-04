/**
 * Meta-agent scorers (Etap 10 §12.1).
 *
 * Cel: ocenić czy supervisor delegował właściwą domenę dla zapytania użytkownika.
 *
 * - `metaToolCallAppropriatenessScorer` — LLM-judge sprawdza, czy tool/agent
 *   wybrany przez meta-agenta pasował do intencji (CRM/marketing/sales/automation).
 *   Nieblokujący, sampling 10-20% (konfigurowane przy podpięciu w `metaAgent.scorers`).
 *
 * Wzór: `weather-scorer.ts` (translationScorer).
 */
import { z } from 'zod';
import { createScorer } from '@mastra/core/evals';
import {
  getAssistantMessageFromRunOutput,
  getUserMessageFromRunInput,
} from '@mastra/evals/scorers/utils';

export const metaToolCallAppropriatenessScorer = createScorer({
  id: 'meta-tool-call-appropriateness',
  name: 'Meta Tool-Call Appropriateness',
  description:
    'Sprawdza czy meta-agent delegował właściwą domenę (CRM, marketing, sales, analytics, automation) dla zapytania użytkownika.',
  type: 'agent',
  judge: {
    model: 'google/gemini-2.5-pro',
    instructions:
      'Jesteś ekspertem oceny supervisor agentów. Otrzymujesz zapytanie użytkownika i odpowiedź meta-agenta (z ewentualnymi tool-callsami w treści). Twoim zadaniem jest stwierdzić, czy meta-agent dobrał trafnie domenę narzędzi/podagent. Zwracaj wyłącznie JSON.',
  },
})
  .preprocess(({ run }) => {
    const userText = getUserMessageFromRunInput(run.input) || '';
    const assistantText = getAssistantMessageFromRunOutput(run.output) || '';
    return { userText, assistantText };
  })
  .analyze({
    description: 'Klasyfikuje intencję użytkownika i ocenia trafność wyboru narzędzi.',
    outputSchema: z.object({
      expectedDomain: z.enum([
        'crm',
        'marketing',
        'sales',
        'analytics',
        'automation',
        'chef',
        'memory',
        'general',
      ]),
      domainMatched: z.boolean(),
      confidence: z.number().min(0).max(1).default(1),
      explanation: z.string().default(''),
    }),
    createPrompt: ({ results }) => `
Oceń trafność wyboru narzędzi przez meta-agenta.

Zapytanie użytkownika:
"""
${results.preprocessStepResult.userText}
"""

Odpowiedź agenta (zawiera odpowiedź lub delegację do podagenta):
"""
${results.preprocessStepResult.assistantText}
"""

Domeny do wyboru:
- crm: zapytania o klientów, leady, statusy
- marketing: cold-email, content, kampanie, producer-hunt
- sales: oferty, spotkania, onboarding
- analytics: KPI, raporty, ROI, trendy
- automation: budowa workflow n8n, risk-score, deploy, patterny
- chef: tworzenie menu, projekty kulinarne
- memory: przypomnienia, historia, kontekst
- general: ogólne pytania nieprzypisane do domeny

Zadania:
1) Klasyfikuj zapytanie do jednej domeny (expectedDomain).
2) Sprawdź czy odpowiedź agenta pasuje do tej domeny (np. wywołał właściwy podagent / narzędzie).
3) Bądź łagodny dla przypadków, gdy odpowiedź jest ogólna ale poprawna.

Zwróć JSON: { "expectedDomain": "...", "domainMatched": boolean, "confidence": 0..1, "explanation": "..." }
    `,
  })
  .generateScore(({ results }) => {
    const r = (results as any)?.analyzeStepResult || {};
    if (r.domainMatched) return Math.max(0, Math.min(1, 0.7 + 0.3 * (r.confidence ?? 1)));
    return 0;
  })
  .generateReason(({ results, score }) => {
    const r = (results as any)?.analyzeStepResult || {};
    return `Domain=${r.expectedDomain ?? '?'}, matched=${r.domainMatched ?? false}, conf=${r.confidence ?? 0}. Score=${score}. ${r.explanation ?? ''}`;
  });

export const metaScorers = {
  metaToolCallAppropriatenessScorer,
};
