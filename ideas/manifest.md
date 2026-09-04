# Propozycja Manifestu Modelów (Czerwiec 2026) — Idealny Balans Cena/Jakość

Na podstawie aktualnych benchmarków (czerwiec 2026) oraz analizy forów (m.in. Reddit, środowiska agentowe), przygotowałem zoptymalizowaną konfigurację modeli.

## Główne założenia (Router Pattern):
1. **Gemini 3.5 Flash ($1.50 / $9)** — Przejmuje większość "brudnej roboty" (routing, analizy stron, powtarzalne taski). Jest najszybszy i ma najlepszy stosunek ceny do jakości dla operacji agentowych i tool-callingowych.
2. **Claude Sonnet 4.6 ($3 / $15)** — "Sweet spot" jakości do ceny. Idealny do pisania kodu (`codingAgent`), planowania architektonicznego i trudniejszych zadań, gdzie pomyłka kosztuje czas.
3. **Claude Fable 5 ($10 / $50)** — Zarezerwowany wyłącznie jako ostateczność dla najcięższych zadań w presetach workers (`powerful`), dzięki czemu nie przepalamy budżetu na głupoty.
4. **Gemini 3.1 Flash-Lite** — Używany jako infrastruktura backendowa (np. kompresja pamięci obserwacyjnej), gdzie potrzebny jest milionowy kontekst i ułamek centa za tokeny.
5. **Modele Lokalne (Qwen 3.5-9B, Gemma 4-E4B)** — Maksymalnie wykorzystane w radzie projektowej (`deliberationAgent`), gdzie agenci dużo ze sobą "rozmawiają", co w chmurze generowałoby ogromne koszty.

---

## Propozycja kodu (`src/mastra/config/model-manifest.ts`)

```typescript
// (Sekcja 1: MODEL INVENTORY - pozostaje bez zmian, zawiera wszystkie najnowsze modele)

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: AGENT ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

export const agentModels = {
  // Meta Agent potrzebuje niezawodnego i superszybkiego routingu narzędzi z dużym oknem kontekstu.
  metaAgent: 'gemini-3.5-flash' as ModelKey,
  
  // Pisanie kodu wymaga wysokiej celności i logiki. Sonnet 4.6 to obecnie najlepszy balans cena/jakość.
  codingAgent: 'claude-sonnet-4.6' as ModelKey,
  
  // Przeglądy kodu mogą być robione przez tańsze, szybkie modele z dużym oknem na cały plik.
  codeReviewAgent: 'gemini-3.5-flash' as ModelKey,
  
  // Sprzedaż i CRM to domena modeli lokalnych lub tanich. Zostawiamy lokalną Gemmę.
  salesAgent: 'gemma4-26b' as ModelKey,
  crmAgent: 'gemma4-26b' as ModelKey,
  analyticsAgent: 'qwen3-coder-30b' as ModelKey,
  weatherAgent: 'gemma4-e4b' as ModelKey, // Można zejść do mniejszego modelu, pogoda nie wymaga 26B
  
  // Architekt potrzebuje precyzji strukturalnej (grafy n8n). Sonnet sprawdza się tu świetnie.
  automationArchitect: 'claude-sonnet-4.6' as ModelKey,
  
  // Marketing można robić lokalnie lub tanim modelem kreatywnym.
  marketingAgent: 'gemma4-26b' as ModelKey,
  
  // Operacje na bazie wiedzy i dokumentach.
  knowledgeAgent: 'gemini-3.1-flash-lite' as ModelKey,
  
  // Scraper/Researcher potrzebuje ogromnego kontekstu i niskiej ceny za scrapowane strony HTML.
  researcherAgent: 'gemini-3.5-flash' as ModelKey,
  
  // Dyrygent dyskusji - flash jest wystarczająco szybki i bystry.
  deliberationAgent: 'gemini-3.5-flash' as ModelKey, 
  
  // Chef deleguje ciężką pracę. Wystarczy dobry tool-caller.
  chefAgent: 'gemini-3.5-flash' as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3: WORKFLOW ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

export const workflowAssignments = {
  coding: {
    default: 'claude-sonnet-4.6' as ModelKey,      // Główne planowanie kodu
    patch: 'qwen3-coder-30b' as ModelKey,          // Lokalny ratunek (za darmo)
    review: 'gemini-3.5-flash' as ModelKey,        // Szybki review za ułamek ceny
    selfHealingPlanner: 'gemini-3.5-flash' as ModelKey,
    selfHealingReview: 'gemini-3.1-flash-lite' as ModelKey, // Logi błędów potrafią być długie
    jsonRepair: 'gemma4-e4b' as ModelKey,          // Trywialne zadanie
  },

  marketing: {
    default: 'gemma4-26b' as ModelKey,
  },

  weeklyContent: {
    research: 'gemini-3.5-flash' as ModelKey,
    copyPl: 'claude-haiku-4.5' as ModelKey,        // Haiku pisze bardzo naturalnie po polsku
    copyRepair: 'gemini-3.1-flash-lite' as ModelKey,
    translateEn: 'gemini-3.5-flash' as ModelKey,
    jsonRepair: 'gemma4-e4b' as ModelKey,
  },

  producerHunt: {
    discovery: 'gemini-3.5-flash' as ModelKey,
    enrichment: 'gemini-3.5-flash' as ModelKey,
    emailExtraction: 'gemini-3.1-flash-lite' as ModelKey,
    draftEmail: 'claude-haiku-4.5' as ModelKey,
    jsonRepair: 'gemma4-e4b' as ModelKey,
    cloudFallback: 'gemini-3.1-flash-lite' as ModelKey,
  },
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4: WORKER PRESETS (system.run_worker tool)
// ═════════════════════════════════════════════════════════════════════════════

export const workerPresets = {
  fast: 'gemma4-e4b' as ModelKey,                   // Lokalny, natychmiastowy
  default: 'gemini-3.5-flash' as ModelKey,          // Tani i świetny ogólnie
  reasoning: 'claude-sonnet-4.6' as ModelKey,       // Złoty środek logiki
  powerful: 'claude-fable-5' as ModelKey,           // Najpotężniejsze działo Anthropic (drogi, tylko gdy trzeba!)
  cloud: 'gemini-3.1-flash-lite' as ModelKey,       // "Śmieciarka" na gigantyczny tekst
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5: INFRASTRUCTURE
// ═════════════════════════════════════════════════════════════════════════════

export const infrastructure = {
  // Pamięć pożera dziesiątki tysięcy tokenów. Flash-Lite uratuje budżet.
  observationalMemory: 'gemini-3.1-flash-lite' as ModelKey,

  embedding: {
    model: 'bge-m3' as ModelKey,
  },

  n8n: {
    defaultModel: 'gemini-3.5-flash' as ModelKey,
    reasoningModel: 'claude-sonnet-4.6' as ModelKey,
  },
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6: DELIBERATION ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

export const deliberationAssignments = {
  systemsArchitect: 'qwen3.5-9b' as ModelKey,       // Architekt myśli - Qwen jest świetny strukturalnie
  llmEngineer: 'qwen3.5-9b' as ModelKey,
  redTeamCritic: 'gemini-3.5-flash' as ModelKey,    // Wymaga zewnętrznej, bezlitosnej logiki chmurowej
  creativeStrategist: 'gemma4-e4b' as ModelKey,     // Kreatywność
  memoryArchitect: 'gemma4-e4b' as ModelKey,
  synthesisPlanner: 'gemma4-e4b' as ModelKey,
} as const;
```
