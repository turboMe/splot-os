# Master Plan Architektoniczny i Wykonawczy: Orchestration & Delegation Refactor V3
## Skinny Meta Orchestrator, Dynamic Skill-to-Model Tiering, Inter-Agent Handoffs & Multi-Step Pipelines

**Data opracowania:** 2026-09-01  
**Autor:** Principal Agentic Systems Engineer & Mastra Architect  
**Wersja:** 3.1 (Kompletna / Master Specification)  
**Status:** DRAFT / READY FOR EXECUTION  
**Główny obszar zmian:** `agentic-agents/src/mastra/*`

---

## 1. Wprowadzenie, Audyt i Diagnoza Stanu Obecnego

### 1.1. Istota Problemu: "Fat Orchestrator" i Pętla Samowykonania
W dotychczasowej architekturze `metaAgent` (będący orkiestratorem głównym) cierpiał na syndrom **Fat Orchestratora**. Zamiast natychmiast planować i delegować pracę do agentów domenowych oraz wyspecjalizowanych workerów, w większości przypadków próbował rozwiązywać zadania we własnym wątku konwersacyjnym, marnując tokeny drogiego modelu rozumującego (`deepseek-v4-pro` / `gemini-3.7-flash` / `claude-sonnet-4.6`).

#### Szczegółowe przyczyny źródłowe w kodzie:
1. **Przeładowana powierzchnia narzędziowa (`meta-agent.ts`):**  
   `metaAgent` miał bezpośrednio wpięte do swojego schematu ponad 35 narzędzi domenowych (m.in. `searchLeadsTool`, `codeSearchTool`, `repoMapTool`, `codeOutlineTool`, `worktreeDiffTool`, `telegramSendFileTool`, `knowledgeLookupTool`) oraz procesor dynamicznej półki `transientToolShelfProcessor`, który udostępniał kolejne ~50 narzędzi (Gmail, Calendar, n8n, MongoDB, RSS).
2. **Sprzeczność i szkodliwe wytyczne w promptach (`meta/base.md`):**  
   Sekcja 5 promptu definiowała:  
   > *"Path 0 - Direct answer or direct specialized tool: Answer known facts directly. If one deterministic tool solves the task, use it; do not spawn a worker/expert unnecessarily."*  
   oraz sekcja 6:  
   > *"Read-only code inspection -> use repoMapTool, codeSearchTool, codeOutlineTool... (do not delegate just to view code)."*  
   LLM, widząc dostępne narzędzia w swoim schemacie, klasyfikował większość poleceń jako `Path 0` i wchodził w kosztowne, wieloetapowe pętle `tool_use`.
3. **Asymetria kosztu kognitywnego delegacji (`delegate-task.ts`):**  
   Wykonanie narzędzia bezpośredniego wymagało od modelu wygenerowania zaledwie kilku tokenów JSON. Z kolei delegacja przez `delegateTaskTool` wymagała wypełnienia rozbudowanego obiektu `taskSpec` (z polami `goal`, `context`, `scope`, `outOfScope`, `successCriteria`, `constraints` po angielsku). Model wybierał ścieżkę najmniejszego oporu kognitywnego.
4. **Odcięty od wykonania Router Modeli (`model-capabilities.ts`):**  
   W pliku `model-capabilities.ts` istniała kompletna, precyzyjna macierz `modelRegistry`, `TaskComplexity` oraz funkcje `getCapableModels()` i `getCheapestCapableModel()`. Jednakże żaden element aktywnego runtime'u ich nie wywoływał – wszystkie modele agentów były zdefiniowane na sztywno w `model-manifest.ts`.
5. **Blokowanie delegacji sekwencyjnych i brak czystego Handoffu:**  
   Gdy Agent A próbował wywołać synchronicznie Agenta B przez `delegate_task`, Agent A wisiał w pamięci i konsumował budżet czasowy rodzica (`DEFAULT_DELEGATION_SYNC_SAFETY_MARGIN_MS = 120s`). Dodatkowo Meta musiał za każdym razem "wtrącać się" po zakończeniu kroku, aby przekazać wynik do kolejnego agenta, zamiast płynnego przepływu `Chef -> Writer -> Content`.

---

## 2. Podstawy Architektoniczne: SOTA 2026 i Skill-to-Model Tiering

### 2.1. Reguła Dźwigni SOP (SOP Leverage) i Odpowiedź na Pytania o Modele
W inżynierii agentowej obowiązuje kluczowa zasada: **Im bardziej precyzyjna, ustrukturyzowana i deterministyczna jest procedura w Skillu (SOP krok-po-kroku ze schematem wejścia/wyjścia), tym mniejszej mocy wnioskowania potrzebuje model, aby wykonać ją bezbłędnie.**

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                              MATRYCA DOPASOWANIA TIERU MODELU                               │
├──────────────────────┬─────────────────────────────┬────────────────────────────────────────┤
│ Charakterystyka      │ Dostępność Skilla / SOP     │ Wymagany Tier Modelu                   │
├──────────────────────┼─────────────────────────────┼────────────────────────────────────────┤
│ Deterministyczna     │ Pełny Skill (SOP)           │ TIER 1: ULTRA-FAST (Koszt ~0, <500ms)  │
│ Ekstrakcja, CRUD,    │ Wymuszone formaty we/wy     │ (Groq 20B, Gemini-2.5-Flash, Qwen 4B,  │
│ Szablon email, JSON  │                             │ Gemma-4 E4B)                           │
├──────────────────────┼─────────────────────────────┼────────────────────────────────────────┤
│ Domenowa             │ Skill wytycznych            │ TIER 2: BALANCED / MID                 │
│ Research, Refaktor,  │ Wymaga narzędzi domenowych  │ (Gemini-2.5-Flash, DeepSeek-v4-Flash,  │
│ Kampania marketing   │                             │ Groq 120B, Gemma-4-12B)                │
├──────────────────────┼─────────────────────────────┼────────────────────────────────────────┤
│ Otwarta / Złożona    │ Brak Skilla (lub cząstkowy) │ TIER 3: PRO / REASONING                │
│ Architektura, Debug, │ Wymaga dekompozycji i planu │ (DeepSeek-v4-Pro, Claude Sonnet 4.6,   │
│ Self-Repair, Audyt   │                             │ Claude Opus 4.8, GPT-5.5)              │
└──────────────────────┴─────────────────────────────┴────────────────────────────────────────┘
```

### 2.2. Modele Agentów Domenowych a Modele Workerów
1. **Agenci domenowi pozostają ze swoimi sprawdzonymi modelami:**  
   `codingAgent`, `automationArchitect`, `chefAgent`, `marketingAgent`, `writerAgent` itp. zachowują konfigurację z `model-manifest.ts` jako domyślną.
2. **Workery (`runWorkerTool`):**  
   Dostają automatyczny wybór najtańszego modelu (Tier 1 / Tier 2) na podstawie metadanych przypisanego skilla.
3. **Dynamiczny Tier Override dla Agentów Domenowych:**  
   Jeśli zadanie zlecane agentowi domenowemu posiada ścisły skill z tagiem `recommendedTier: fast`, `delegate_task` może opcjonalnie uruchomić ten konkretny przebieg agenta na tańszym modelu, oszczędzając do 95% kosztów.

### 2.3. Wsparcie dla Agentów Domenowych
Wszyscy agenci domenowi zyskują:
* Narzędzie `runWorkerTool` (np. `chefAgent` może zlecić workerowi Tier 1 wygenerowanie tabeli alergenów bez zużywania własnego kontekstu).
* Ujednolicony dostęp do `artifactPutTool` i `artifactGetTool`.
* Bezpieczne reguły delegacji i handoffu.

---

## 3. Architektura Sekwencji, Handoffów i Przekazywania Artefaktów

### 3.1. Problem Zadań Wieloetapowych (np. Chef $\rightarrow$ Writer $\rightarrow$ Content)
Częsty scenariusz biznesowy:  
1. *Chef tworzy kartę dań na podstawie linku.*
2. *Writer pisze artykuł prasowy na podstawie nowej karty dań.*
3. *Content planuje posty do social mediów na cały tydzień na podstawie artykułu i karty.*

Dotychczas sekwencje te napotykały na bariery:
* Zagnieżdżanie wywołań synchronicznych blokowało czas wykonania rodzica (`DEFAULT_DELEGATION_SYNC_SAFETY_MARGIN_MS`).
* Po każdym kroku Meta musiał pytać użytkownika lub czekać na kolejną interakcję.

### 3.2. Rozwiązanie: Artifact-Driven Sequential Pipeline & Handoff Contract

```
┌─────────────────────────────────────────────────────────────────────────────┐
│             PRZEPŁYW SEKWENCYJNY Z UŻYCIEM ARTEFAKTÓW I HANDOFFU            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [UŻYTKOWNIK]                                                               │
│       │ "Przygotuj nowe menu -> artykuł prasowy -> plan postów na tydzień"  │
│       ▼                                                                     │
│  [META AGENT (Skinny Orchestrator)]                                         │
│       │                                                                     │
│       ├─► 1. delegate_task(chefAgent)                                       │
│       │        │ (Chef tworzy Menu Book)                                    │
│       │        ▼                                                            │
│       │   [Zapis: artifact_menu_01.md] ──┐                                  │
│       │                                  │                                  │
│       ├─► 2. delegate_task(writerAgent,  │ (Przekazanie referencji ID)      │
│       │                   inputArtifactIds: [artifact_menu_01])              │
│       │        │ (Writer pobiera menu i pisze artykuł)                      │
│       │        ▼                                                            │
│       │   [Zapis: artifact_art_01.md]  ──┐                                  │
│       │                                  │                                  │
│       ├─► 3. delegate_task(contentAgent, │                                  │
│       │                   inputArtifactIds: [artifact_art_01])              │
│       │        │ (Content tworzy posty IG/FB/TikTok)                        │
│       │        ▼                                                            │
│       │   [Zapis: artifact_posts_01.md]                                     │
│       │                                                                     │
│       ▼                                                                     │
│  [Zwrócenie kompletnego wyniku z linkami do 3 artefaktów użytkownikowi]     │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Handoff przez Magazyn Artefaktów (`Artifact Store`):**  
   Duże dane wyjściowe (karty menu, raporty, artykuły, zbiory ofert pracy) są zapisywane jako pliki markdown w magazynie artefaktów za pomocą `artifactPutTool`. Do kolejnych agentów w potoku przekazywany jest wyłącznie lekki identyfikator (`artifactId`), który kolejny agent odczytuje przez `artifactGetTool`.
2. **Dwa tryby realizacji sekwencji:**
   - **Tryb A: Fast Dispatcher (Meta jako automatyczny dyspozytor potoku):**  
     Meta w ramach jednego wątku planuje kroki $1 \rightarrow 2 \rightarrow 3$. Po zakończeniu Kroku 1 automatycznie (bez angażowania użytkownika) uruchamia Krok 2 z przekazanym `artifactId`, a po nim Krok 3. Na koniec zwraca użytkownikowi kompletne podsumowanie z linkami do wszystkich artefaktów.
   - **Tryb B: Direct Peer Handoff (`handoff_task`):**  
     Agent kończący etap może jawnie przekazać pałeczkę do kolejnego agenta (`handoffTaskTool({ nextAgent: 'writerAgent', artifactId: 'artifact_menu_01', instructions: '...' })`), zwalniając swój wątek.

---

## 4. Szczegółowy Projekt Techniczny (File-by-File)

### 4.1. `agentic-agents/src/mastra/services/skill-registry.ts`
**Cel:** Rozszerzenie kontraktu metadanych skilli o deklarację wymaganego tieru modelu oraz wsparcie handoffu.

#### Zmiany w interfejsie `SkillMetadata`:
```typescript
export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'critical';
export type SkillModelTier = 'fast' | 'balanced' | 'pro';

export interface SkillMetadata {
  /** Unique skill name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Category/domain (e.g., 'crm', 'coding', 'chef', 'content') */
  category?: string;
  /** Search keywords */
  keywords?: string[];
  /** Allowed tools for this skill */
  allowedTools?: string[];
  /** Minimum task complexity this skill handles */
  minComplexity?: TaskComplexity;
  /** Recommended execution model tier */
  recommendedTier?: SkillModelTier;
  /** Whether this skill can run on a local Ollama model */
  preferLocal?: boolean;
  /** Whether the skill produces an artifact suitable for downstream handoff */
  handoffCapable?: boolean;
  /** Expected format of output deliverable */
  outputFormat?: string;
  /** Skill version */
  version?: number;
  /** Any extra metadata fields */
  [key: string]: any;
}
```

---

### 4.2. `agentic-agents/src/mastra/config/model-capabilities.ts` & `model-manifest.ts`
**Cel:** Ożywienie routera modeli, powiązanie rejestru z wykonaniem i zdefiniowanie 3 spójnych tierów wykonawczych.

#### 1. Definicja Tierów Wykonawczych:
```typescript
export type ExecutionTier = 'fast' | 'balanced' | 'pro';

export interface TierModelMapping {
  tier: ExecutionTier;
  primaryModelId: string;
  fallbackModelId: string;
  localAlternativeModelId?: string;
  maxRecommendedComplexity: TaskComplexity;
}

export const EXECUTION_TIERS: Record<ExecutionTier, TierModelMapping> = {
  fast: {
    tier: 'fast',
    primaryModelId: models['groq-gpt-oss-20b'],        // Ultra-szybki LPU, darmowy, ~200ms
    fallbackModelId: models['gemini-2.5-flash'],      // Bardzo tani, stabilny tool-calling
    localAlternativeModelId: models['qwen3.5-4b'],    // Lokalny micro-model dla offline
    maxRecommendedComplexity: 'simple',
  },
  balanced: {
    tier: 'balanced',
    primaryModelId: models['gemini-2.5-flash'],       // Szybki, 1M context, solidne wnioskowanie
    fallbackModelId: models['deepseek-v4-flash'],     // Tani cloud, wysoka przepustowość
    localAlternativeModelId: models['gemma4-12b-official'],
    maxRecommendedComplexity: 'moderate',
  },
  pro: {
    tier: 'pro',
    primaryModelId: models['deepseek-v4-pro'],        // Głębokie rozumowanie, tryb myślenia
    fallbackModelId: models['claude-sonnet-4.6'],     // SOTA architektura i bezpieczeństwo
    localAlternativeModelId: models['nemotron-ultra-free'],
    maxRecommendedComplexity: 'complex',
  },
};
```

#### 2. Funkcja dynamicznego doboru modelu (`resolveExecutionModel`):
```typescript
export function resolveExecutionModel(options: {
  requestedTier?: ExecutionTier | 'auto';
  skills?: SkillMetadata[];
  agentDefaultModelId: string;
  preferLocal?: boolean;
}): string {
  // 1. Jawny wybór tieru
  if (options.requestedTier && options.requestedTier !== 'auto') {
    const tierConfig = EXECUTION_TIERS[options.requestedTier];
    if (options.preferLocal && tierConfig.localAlternativeModelId) {
      return tierConfig.localAlternativeModelId;
    }
    return tierConfig.primaryModelId;
  }

  // 2. Automatyczny dobór na podstawie Skilli (SOP)
  if (options.skills && options.skills.length > 0) {
    const allSkillsFast = options.skills.every(
      (s) => s.recommendedTier === 'fast' || s.minComplexity === 'trivial' || s.minComplexity === 'simple'
    );
    if (allSkillsFast) {
      return EXECUTION_TIERS.fast.primaryModelId;
    }

    const anySkillPro = options.skills.some(
      (s) => s.recommendedTier === 'pro' || s.minComplexity === 'complex' || s.minComplexity === 'critical'
    );
    if (anySkillPro) {
      return EXECUTION_TIERS.pro.primaryModelId;
    }

    return EXECUTION_TIERS.balanced.primaryModelId;
  }

  // 3. Domyślny model agenta
  return options.agentDefaultModelId;
}
```

---

### 4.3. `agentic-agents/src/mastra/tools/system/delegate-task.ts`
**Cel:** Rozszerzenie kontraktu delegacji o wstrzykiwanie procedur skilli, dynamiczny wybór tieru, przekazywanie artefaktów oraz wsparcie lekkiego briefu.

#### Rozszerzenie schematu wejściowego (`inputSchema`):
```typescript
skills: z
  .array(z.string())
  .optional()
  .describe('Lista nazw skilli z Skill Registry (np. ["consulting-lead-qualifier"]). Ich procedury zostaną wstrzyknięte do promptu agenta.'),

modelTier: z
  .enum(['auto', 'fast', 'balanced', 'pro'])
  .default('auto')
  .describe('Preferowany tier modelu. "fast" wybiera tani/szybki model dla zadań z gotowym SOP; "balanced" używa standardowego modelu domeny; "pro" wymusza mocny model rozumujący.'),

inputArtifactIds: z
  .array(z.string())
  .optional()
  .describe('Lista identyfikatorów artefaktów wygenerowanych przez poprzednich agentów w potoku (handoff/sekwencja).'),

taskBrief: z
  .string()
  .optional()
  .describe('Zwięzły opis zadania w formacie tekstowym (lekka alternatywa dla taskSpec dla szybkich delegacji).'),
```

#### Logika wykonania (`execute`):
1. **Wstrzykiwanie procedury Skilla:**  
   Pobranie procedury ze `SkillRegistry.load(skillName)` i dołączenie jej do instrukcji agenta pod nagłówkiem `## Active Standard Operating Procedure (SOP)`.
2. **Dołączenie przekazanych artefaktów:**  
   Jeśli przekazano `inputArtifactIds`, do promptu agenta wstrzykiwana jest informacja o dostępnych artefaktach wejściowych z poleceniem pobrania ich przez `artifactGetTool`.
3. **Dynamiczny Model Override:**  
   Wyznaczenie docelowego `modelId` przez `resolveExecutionModel` i uruchomienie agenta z odpowiednim modelem.

---

### 4.4. `agentic-agents/src/mastra/agents/meta-agent.ts`
**Cel:** Redukcja powierzchni narzędziowej Meta Agenta do czystej orkiestracji ("Skinny Orchestrator").

#### Zmiany w `tools`:
* **USUNIĘCIE NARZĘDZI DOMENOWYCH:**
  - `searchLeadsTool` (CRM $\rightarrow$ `crmAgent` / `salesAgent`)
  - `repoMapTool`, `codeSearchTool`, `codeOutlineTool`, `worktreeDiffTool` (Inspekcja kodu $\rightarrow$ `codingAgent` / `codeReviewAgent`)
  - `telegramSendFileTool` ($\rightarrow$ `marketingAgent`)
  - `knowledgeLookupTool` ($\rightarrow$ `knowledgeAgent`)
* **ODCIĘCIE `transientToolShelfProcessor` DLA META AGENTA:**  
  Meta nie może ładować narzędzi Gmail/Calendar/n8n/Mongo do własnego kontekstu.
* **POZOSTAWIENIE WYŁĄCZNIE NARZĘDZI ORKIESTRACJI:**
  - `delegateTaskTool` (delegacja do agentów domenowych)
  - `runWorkerTool` (uruchamianie ad-hoc workerów tekstowych)
  - `skillSearchTool` / `skillCatalogTool` (wyszukiwanie i inspekcja skilli)
  - `agentBoardGetTool` / `agentBoardListTool` (inspekcja kontraktów agentów)
  - `artifactGetTool`, `artifactPutTool`, `artifactListTool` (zarządzanie artefaktami)
  - `requestApprovalTool` (bramka autoryzacji)
  - `checkPendingUpdatesTool`, `ledgerStatusTool`, `ledgerControlTool` (nadzór nad zadaniami)
  - `memoryRecallTool`, `memoryWriteTool` (pamięć architektoniczna)

---

### 4.5. `agentic-agents/src/mastra/prompts/meta/base.md`
**Cel:** Przebudowa promptu głównego, usunięcie pokusy samowykonania i wdrożenie reguł dyspozytora.

#### Zmiany w promptu:
```markdown
# Jarvis Meta - Pure Orchestrator & Dispatcher

You are the head orchestrator of the system. You DO NOT execute domain tasks, API calls,
database queries, code inspections, or content generation yourself.

Your SOLE responsibility is to:
1. Understand the user's intent and definition of done.
2. Match the task with available Skills and Domain Agents.
3. Dispatch work with the optimal Model Tier (cheap/fast for skilled SOPs, reasoning for open tasks).
4. Coordinate multi-step sequential pipelines by passing Artifact IDs between agents.
5. Synthesize results and communicate with the user.

## Routing Protocol: Intent -> Skill Match -> Dispatch Tier

When receiving a task:
Step 1: Check if a specialized Skill exists using `skillSearchTool(query)`.
Step 2:
  - IF SKILL EXISTS with strict SOP:
    -> Dispatch to Specialist or Worker with `skills: [skillName]` and `modelTier: 'fast'`.
  - IF NO SKILL, but clear domain owner (e.g. Coding, Chef, Marketing):
    -> Dispatch to Domain Agent with `taskBrief` and `modelTier: 'balanced'`.
  - IF MULTI-STEP PIPELINE (e.g. Chef -> Writer -> Content):
    -> Execute Step 1, receive `artifactId`, immediately dispatch Step 2 with `inputArtifactIds: [artifactId]`, then Step 3.
  - IF COMPLEX / ARCHITECTURAL:
    -> Dispatch to deliberationAgent or reasoning worker with `modelTier: 'pro'`.
```

---

## 5. Plan Weryfikacji i E2E Testów

Po wdrożeniu zmian przeprowadzamy 5 testów weryfikacyjnych:

### 5.1. Test 1: Anti-Hoarding Test (Brak samowykonania przy zadaniu domenowym)
* **Wejście:** *"Sprawdź w CRM leady ze statusem new i podsumuj je."*
* **Weryfikacja:** Meta Agent **nie wywołuje** żadnych narzędzi bazodanowych. Natychmiast deleguje zadanie do `crmAgent` lub `salesAgent`.

### 5.2. Test 2: Skill-to-Model Fast Tier Test
* **Wejście:** *"Zakwalifikuj to zgłoszenie ze strony consulting i przygotuj draft maila."*
* **Weryfikacja:** Meta Agent dopasowuje skill `consulting-lead-qualifier`, uruchamia delegację z `modelTier: 'fast'` na modelu `groq-gpt-oss-20b` lub `gemini-2.5-flash`. Czas wykonania < 3s, koszt niższy o 90%.

### 5.3. Test 3: Multi-Step Sequential Pipeline Test (Chef $\rightarrow$ Writer $\rightarrow$ Content)
* **Wejście:** *"Przygotuj nowe menu na podstawie linku X, następnie niech writer napisze artykuł prasowy, a contentAgent zaplanuje posty na social media na cały tydzień."*
* **Weryfikacja:** Meta bez pytania użytkownika w trakcie procesu:
  1. Wywołuje `chefAgent` $\rightarrow$ powstaje `artifact_menu_xxx.md`.
  2. Wywołuje `writerAgent` z `inputArtifactIds: ['artifact_menu_xxx.md']` $\rightarrow$ powstaje `artifact_art_yyy.md`.
  3. Wywołuje `contentAgent` z `inputArtifactIds: ['artifact_art_yyy.md']` $\rightarrow$ powstaje `artifact_posts_zzz.md`.
  4. Zwraca syntetyczne podsumowanie z linkami do 3 artefaktów.

### 5.4. Test 4: Job Hunter $\rightarrow$ Marketing Drafts Pipeline Test
* **Wejście:** *"Przeskanuj rynek pracy AI w Polsce i przygotuj drafty zgłoszeń."*
* **Weryfikacja:** `researcherAgent` generuje `artifact_jobs.md`, a `marketingAgent` odbiera go i tworzy drafty w Gmailu.

### 5.5. Test 5: Pro Tier Escalation Test
* **Wejście:** *"Zaprojektuj nową architekturę klastra workerów do wielojęzycznego parsowania menu."*
* **Weryfikacja:** Brak skilla $\rightarrow$ system automatycznie wybiera `modelTier: 'pro'` (`deepseek-v4-pro` / `claude-sonnet-4.6`).

---

## 6. Fazy Wdrożenia (Commit-Sized Steps)

1. **Krok 1: Rozszerzenie Rejestru Skilli i Modeli (`skill-registry.ts`, `model-capabilities.ts`)**  
   - Aktualizacja typu `SkillMetadata`.  
   - Dodanie `EXECUTION_TIERS` i `resolveExecutionModel`.  
   - Oznaczenie kluczowych skilli w `_skills/**/*.md` tagami `recommendedTier: fast | balanced | pro`.
2. **Krok 2: Rozszerzenie Kontraktu `delegate_task` i `run_worker`**  
   - Dodanie parametrów `skills`, `modelTier`, `inputArtifactIds`, `taskBrief`.  
   - Wstrzykiwanie procedur skilli przed startem agenta docelowego.  
   - Dynamiczny Model Override dla agentów.  
   - Udostępnienie `runWorkerTool` agentom domenowym.
3. **Krok 3: Oczyszczenie `metaAgent` ("Skinny Orchestrator")**  
   - Usunięcie bezpośrednich narzędzi domenowych.  
   - Odcięcie `transientToolShelfProcessor` dla Meta Agenta.  
   - Pozostawienie wyłącznie narzędzi orkiestracyjnych.
4. **Krok 4: Aktualizacja Promptów (`meta/base.md` i szablony domenowe)**  
   - Usunięcie `Path 0` dla narzędzi wykonawczych.  
   - Wdrożenie protokołu dyspozytorskiego i reguł automatycznych sekwencji pipeline.
5. **Krok 5: Weryfikacja i Testy E2E**  
   - Uruchomienie skryptów testowych dla scenariuszy 5.1–5.5.  
   - Weryfikacja telemetrii i czasów odpowiedzi.

---

## 7. Podsumowanie Korzyści

1. **Drastyczne obniżenie kosztów i latencji:** Oszczędność 85–95% tokenów i skrócenie czasu reakcji z kilkunastu sekund do < 2 sekund dla zadań z gotowymi skillami.
2. **Koniec problemu samowykonania:** Meta Agent staje się czystym dyrygentem systemu.
3. **Płynne potoki wieloagentowe:** Bezproblemowe wykonywanie sekwencji wielokrokowych (`Chef -> Writer -> Content`) z automatyczną wymianą artefaktów bez blokowania wątków.
4. **Pełna modularność:** Dodanie nowego skilla automatycznie uczy system nowej procedury i przypisuje optymalny model bez modyfikacji kodu agentów.
