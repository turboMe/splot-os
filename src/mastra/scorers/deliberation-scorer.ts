import { z } from 'zod';
import { createScorer } from '@mastra/core/evals';
import {
  getAssistantMessageFromRunOutput,
  getUserMessageFromRunInput,
} from '@mastra/evals/scorers/utils';

export const deliberationQualityScorer = createScorer({
  id: 'deliberation-quality',
  name: 'Deliberation Quality Scorer',
  description:
    'Ocenia jakość procesu decyzyjnego Design Council (deliberationAgent), czy debata wniosła wartość i była adekwatna do problemu.',
  type: 'agent',
  judge: {
    model: 'google/gemini-2.5-pro',
    instructions:
      'Jesteś ekspertem oceny procesów analitycznych i decyzyjnych w systemach wieloagentowych (Design Council). Analizujesz zapytanie użytkownika oraz finalną syntezę (odpowiedź) z deliberationAgenta. Twoim zadaniem jest ocenić jakość debaty, przydatność rekomendacji, zgodność z wybraną głębokością oraz czy krytyka wniosła wartość. Zwracaj wyłącznie poprawny JSON.',
  },
})
  .preprocess(({ run }) => {
    const userText = getUserMessageFromRunInput(run.input) || '';
    const assistantText = getAssistantMessageFromRunOutput(run.output) || '';
    return { userText, assistantText };
  })
  .analyze({
    description: 'Ocenia jakość wygenerowanych rekomendacji i adekwatność głębokości debaty.',
    outputSchema: z.object({
      didCritiqueFindRealProblem: z.boolean().default(false),
      didFinalPlanAddressCritique: z.boolean().default(false),
      wasPlanExecutable: z.boolean().default(true),
      wasDebateDepthAppropriate: z.enum(['overused', 'right', 'insufficient']).default('right'),
      artifactCompletenessScore: z.number().min(0).max(1).default(1),
      confidence: z.number().min(0).max(1).default(1),
      explanation: z.string().default(''),
    }),
    createPrompt: ({ results }) => `
Oceń jakość procesu deliberacji.

Zapytanie użytkownika / wejście do agenta decyzyjnego:
"""
${results.preprocessStepResult.userText}
"""

Finalna odpowiedź agenta decyzyjnego (zawiera rekomendacje, plan implementacji, informacje o subagentach, artefaktach itp.):
"""
${results.preprocessStepResult.assistantText}
"""

Zadania:
1) Zweryfikuj, czy w odpowiedzi widać ślady realnej krytyki (czy wskazano problemy / ryzyka) i czy plan adresuje te problemy. Jeśli zadanie było bardzo proste (depth: light), krytyka mogła nie znaleźć błędów.
2) Czy zaproponowany plan jest wystarczająco jasny i wykonywalny przez inne systemy (codingAgent / automationArchitect)?
3) Czy użyta liczba subagentów/głębokość debaty była adekwatna (np. do zmiany literówki nie potrzeba deep debate). Jeśli nie podano w tekście, załóż 'right'.
4) Czy wygenerowano wszystkie niezbędne artefakty (notatki, brief, plan)? Oceń kompletność artefaktów jako score 0.0 do 1.0 na podstawie samej deklaracji.

Zwróć JSON z ocenami (patrz struktura Schema).
    `,
  })
  .generateScore(({ results }) => {
    const r = (results as any)?.analyzeStepResult || {};
    let score = 0;
    if (r.wasPlanExecutable) score += 0.4;
    if (r.wasDebateDepthAppropriate === 'right') score += 0.3;
    if (r.wasDebateDepthAppropriate === 'overused') score += 0.1;
    score += (r.artifactCompletenessScore ?? 0) * 0.3;
    // Maks 1.0
    return Math.max(0, Math.min(1, score));
  })
  .generateReason(({ results, score }) => {
    const r = (results as any)?.analyzeStepResult || {};
    return `Executable=${r.wasPlanExecutable}, Depth=${r.wasDebateDepthAppropriate}, Artifacts=${r.artifactCompletenessScore}, CritiqueValue=${r.didCritiqueFindRealProblem}. Score=${score}. ${r.explanation ?? ''}`;
  });

export const deliberationScorers = {
  deliberationQualityScorer,
};
