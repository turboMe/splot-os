# Lightweight Self-Expansion & Specialist Dossier — Kompletny Plan Implementacyjny

**Wersja:** 5.0 — Pełna Wersja Architektoniczno-Implementacyjna (Master Blueprint)  
**Data:** 2026-09-01  
**Status:** W trakcie realizacji (In Execution)  
**Gałąź git:** `feature/lightweight-self-expansion`  
**Plik docelowy:** `ideas/agent-builder-quck-win.md`  
**Architekt:** Principal Agentic Systems Engineer & Mastra Architect  

---

## 1. Diagnoza, Wizja i Model Trójwarstwowy (Lightweight Self-Expansion)

### 1.1. Diagnoza: Dlaczego nie kompilujemy nowych klas TypeScript w 95%+ przypadków?
W pierwotnej koncepcji (`auto-agent-build.md`) tworzenie agenta zakładało ciężki kompilator kodu TypeScript (45 dni prac, 7 stanów maszyny stanowej, generowanie kodu TS dla każdego zapytania). W rzeczywistości produkcyjnej Mastra:
- **Przeładowanie pamięci i kontekstu (Agent Sprawl):** Dodanie 50 nowych klas agentów do `agentBoard` i `new Mastra({ agents: { ... } })` drastycznie wydłuża prompt Meta Agenta i zwiększa koszt/latencję każdej tury decyzyjnej.
- **Dług utrzymaniowy:** Każdy agent TypeScript wymaga utrzymywania schematów Zod, importów, zgodności z wersjami `@mastra/core` oraz testów statycznych `check:all`.
- **Wymóg restartu i przełączania slotów:** Dodanie klasy TS wymaga kompilacji, weryfikacji portów (`:4222` candidate -> `:4111` live) i restartu instancji Node.js.

### 1.2. Model Samorozwoju Trójwarstwowego (Podział potrzeb 70% / 20% / 8% / <2%)
W 98%+ sytuacji, gdy użytkownik mówi *„stwórz mi agenta do [domena]”*, potrzebuje on wyspecjalizowanego zachowania, a nie nowej klasy w kodzie. System dzieli samorozwój na 4 precyzyjne warstwy:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ WARSTWA 1: Procedury i Skille (SOP w Markdown) — 70% potrzeb                 │
│ - Pliki w src/mastra/_skills/auto/<skill-id>.md ze ścisłym YAML frontmatter  │
│ - Hot-reload w locie przez TransientSkillShelf (zero restartów!)              │
├──────────────────────────────────────────────────────────────────────────────┤
│ WARSTWA 2: Narzędzia i Automatyzacje (n8n / MCP) — 20% potrzeb               │
│ - Nowe webhooki/API konfigurowane w n8n przez automationArchitect            │
│ - Dedykowane serwery MCP budowane w sandboxie przez capabilitySmith          │
├──────────────────────────────────────────────────────────────────────────────┤
│ WARSTWA 3: Baza Wiedzy (Public Cloud vs Private Local) — 8% potrzeb          │
│ - Publiczna: Dedykowane notatniki Google NotebookLM przez knowledgeAgent     │
│ - Prywatna/Poufna: Lokalny RAG (bge-m3 + Ollama) w katalogu private/         │
├──────────────────────────────────────────────────────────────────────────────┤
│ WARSTWA 4: Stały Agent TypeScript (Guided TS Build) — <2% potrzeb            │
│ - Tworzony wyłącznie na wyraźne żądanie w osobnym worktree gita              │
│ - Nadzorowany przez guarded-build-core.ts z bramkami tsc i check:all         │
│ - Wymaga jednoznacznego zatwierdzenia (Approval Gate) przez Patryka          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Kontrakt Paszportu Specjalisty (`SpecialistDossierV1`) i 4 Złote Pytania

### 2.1. Cztery Złote Pytania Researchera
Przed wykonaniem jakichkolwiek akcji, `researcherAgent` przeprowadza rekonesans domenowy odpowiadając na 4 pytania:
1. **Kim jest rola i do kogo pasuje (Rola & Host)?** Definicja doskonałości roli, standardy rynkowe i przypisanie agenta-gospodarza (`assignedHostAgent` spośród 25 dojrzałych agentów systemu).
2. **Jakich narzędzi potrzebuje (Narzędzia & Integracje)?** Identyfikacja narzędzi wbudowanych vs brakujących integracji zewnętrznych (zlecenie do `capabilitySmith` lub `automationArchitect`).
3. **Jakich procedur potrzebuje (Skille SOP)?** Ścisły algorytm postępowania krok po kroku, drzewo decyzyjne IF/THEN oraz format artefaktu wyjściowego.
4. **Jakiej wiedzy potrzebuje (Wiedza & Źródła)?** Weryfikacja oficjalnych, aktualnych aktów prawnych, dokumentacji, linków ISAP/UODO/EUR-Lex i próbek danych.

### 2.2. Zarządzanie Prywatnością i Granica Danych (Privacy Boundary)
System wprowadza **klasyfikację poufności**:
- **Public / Standard (`notebooklm_cloud`):** Wiedza ogólnodostępna (ustawy, dokumentacje, artykuły SEO). Wykorzystuje nielimitowany kontekst Google NotebookLM i szybkie modele chmurowe.
- **Confidential / Private (`local_vector_rag` / `local_markdown_doc`):** Dane wrażliwe (umowy spółki, wyciągi finansowe, dane osobowe PII, strategie B2B). Wykorzystuje **w 100% lokalne modele (Ollama: `gemma4-12b`, `qwen3.6-27b`)** oraz lokalną bazę wektorową z embeddingami `bge-m3`.

#### Zasada Interaktywnej Bramki Prywatności:
Gdy Meta Agent wykryje, że zadanie dotyczy danych poufnych, **nie podejmuje decyzji po cichu**. Informuje użytkownika o wykryciu danych wrażliwych i zadaje pytanie:
> *„Zauważyłem, że to zadanie dotyczy poufnych danych biznesowych/finansowych. Czy chcesz, abym skonfigurował specjalistę w **(1) Trybie Prywatnym / Lokalnym (Ollama + Lokalny RAG offline - Rekomendowane)**, czy w **(2) Trybie Chmurowym (Google NotebookLM)**?”*

W przypadku wyboru wariantu prywatnego, system tworzy dedykowany katalog:
`src/mastra/knowledge/private/<domain-slug>/`  
i zwraca użytkownikowi dokładną ścieżkę do umieszczania plików.

### 2.3. Kompletny Schemat Zod (`src/mastra/schemas/specialist-dossier.ts`)

```typescript
import { z } from 'zod';

export const SpecialistSourceSchema = z.object({
  url: z.string().url().optional().describe('Zweryfikowany link źródłowy (dla źródeł publicznych)'),
  filePath: z.string().optional().describe('Ścieżka do lokalnego pliku (dla źródeł prywatnych)'),
  title: z.string().min(3).describe('Oficjalny tytuł aktu, dokumentu lub szablonu'),
  type: z.enum(['statute', 'official_guideline', 'industry_standard', 'documentation', 'internal_contract', 'sample_data']),
  cadence: z.enum(['static', 'monthly', 'quarterly', 'live']).default('static'),
});

export const PrivacyBoundarySchema = z.object({
  classification: z.enum([
    'public',              // Wiedza ogólnodostępna
    'internal_business',   // Dane biznesowe
    'confidential_strict'  // Ściśle poufne, PII, finanse
  ]),
  knowledgeBackend: z.enum([
    'notebooklm_cloud',    // Google NotebookLM
    'local_vector_rag',    // Lokalny RAG bge-m3
    'local_markdown_doc',  // Pliki markdown w katalogu lokalnym
    'none'
  ]),
  modelTier: z.enum([
    'cloud_standard',      // Modele chmurowe (DeepSeek / Gemini)
    'local_ollama_only',   // Wymuszenie modeli Ollama (gemma4-12b / qwen3.6-27b)
    'hybrid'
  ]),
  localKnowledgePath: z.string().optional().describe('Ścieżka do katalogu prywatnego, np. src/mastra/knowledge/private/<domain>'),
});

export const SpecialistSkillSpecSchema = z.object({
  skillId: z.string().regex(/^[a-z0-9-]+$/).describe('Identyfikator skilla (slug, np. rodo-poland-compliance)'),
  name: z.string().min(5).describe('Czytelna nazwa procedury'),
  description: z.string().min(15).describe('Kiedy i w jakich warunkach uruchamiać ten skill'),
  algorithm: z.array(z.string().min(10)).min(3).describe('Ścisły algorytm postępowania krok po kroku'),
  decisionTree: z.array(z.string()).optional().describe('Warunki brzegowe IF/THEN'),
  outputArtifactType: z.string().default('document').describe('Typ generowanego artefaktu'),
});

export const SpecialistDossierSchema = z.object({
  domain: z.string().regex(/^[a-z0-9_]+$/).describe('Identyfikator domeny, np. legal_rodo_poland'),
  role: z.object({
    title: z.string().min(5).describe('Tytuł specjalisty'),
    assignedHostAgent: z.enum([
      'researcherAgent',
      'salesAgent',
      'marketingAgent',
      'analyticsAgent',
      'automationArchitect',
      'codingAgent',
      'writerAgent',
      'chefAgent',
      'contentAgent',
      'huntAgent',
      'designAgent',
      'knowledgeAgent',
    ]),
    mission: z.string().min(20).describe('Główna misja i definicja sukcesu'),
    standards: z.array(z.string()).min(2).describe('Kluczowe kryteria jakościowe i zasady prawne/etyczne'),
  }),
  privacy: PrivacyBoundarySchema,
  knowledgeNeeded: z.object({
    corpusTitle: z.string().min(5).describe('Tytuł bazy wiedzy / notatnika'),
    sources: z.array(SpecialistSourceSchema).default([]),
  }),
  skillsNeeded: z.array(SpecialistSkillSpecSchema).min(1).describe('Wymagane procedury operacyjne SOP'),
  toolsNeeded: z.object({
    existingTools: z.array(z.string()).describe('Wymagane istniejące narzędzia w systemie'),
    missingTools: z.array(z.object({
      name: z.string(),
      purpose: z.string(),
      targetPlatform: z.enum(['mcp', 'n8n', 'local_tool']),
    })).default([]),
  }),
});

export type SpecialistDossierV1 = z.infer<typeof SpecialistDossierSchema>;
```

---

## 3. Deterministyczny Silnik Wykonawczy i Nowe Komponenty

### 3.1. Przepływ Wykonawczy (Reasoning ➔ Execution)

```text
                           [UŻYTKOWNIK: Zlecenie w czacie]
                                          │
                                          ▼
                             [META: Solution Decision]
                     Wykrycie potrzeby stworzenia specjalisty
                                          │
                                          ▼
                              [KROK 1: REKONESANS]
                researcherAgent bada 4 Filary i źródła prawne
                                          │
                                          ▼
                         [Paszport: SpecialistDossierV1]
                      Zapisany jako artefakt specialist_dossier
                                          │
                ┌─────────────────────────┴─────────────────────────┐
                ▼                                                   ▼
      [Wariant Publiczny (Cloud)]                       [Wariant Prywatny (Local)]
      knowledgeAgent:                                   specialist-builder:
      - notebooklm_create_notebook()                    - mkdir src/mastra/knowledge/private/<domain>/
      - Pętla notebooklm_add_source()                   - Inicjalizacja indeksu bge-m3
      - Kalibracja zapytaniami                          - preferLocal: true w YAML frontmatter
                │                                                   │
                └─────────────────────────┬─────────────────────────┘
                                          │
                                          ▼
                                [KROK 2: GENERACJA SKILLA]
             writerAgent pobiera szablon _skills/meta/build-specialist-skill.md
             i wywołuje narzędzie systemowe: skillSaveTool (hot-reload)
                                          │
                                          ▼
                                [KROK 3: RAPORT DLA PATRYKA]
             - Host Agent, podpięty skill, stan bazy wiedzy
             - W trybie prywatnym: bezpośredni link do katalogu lokalnego
```

### 3.2. Nowe Narzędzia Systemowe

#### `src/mastra/tools/system/skill-save.ts` (`skillSaveTool`)
Narzędzie z pełną walidacją nagłówka YAML, zapisujące procedurę w `_skills/auto/<skillId>.md` i odświeżające `SkillRegistry`:
- Pola YAML: `name`, `description`, `domain`, `category`, `knowledgeNotebookTitle`, `knowledgeNotebookId`, `localKnowledgePath`, `preferLocal`, `allowedTools`.
- Automatyczne wywołanie `getSkillRegistry().load(skillId)` po zapisie.

#### `src/mastra/config/artifact-types.ts`
Rozszerzenie unii typów artefaktów o `specialist_dossier`.

#### `src/mastra/services/specialist-builder.ts`
Deterministyczny orkiestrator spinający tworzenie notatnika/katalogu prywatnego, zapis skilla i wiązanie agenta-gospodarza.

---

## 4. Uporządkowanie Rejestrów i Usunięcie Długu (§8 z `auto-agent-build.md`)

| Komponent | Plik | Rola i Refaktoryzacja |
|---|---|---|
| **Rejestr Źródeł Agentów** | `src/mastra/config/agent-source-registry.ts` | **NOWY** — Scentralizowane źródło prawdy dla 25+ agentów (ścieżki plików, prompty, domeny, widoczność). |
| **Rejestr Narzędzi** | `src/mastra/config/tool-binding-registry.ts` | **NOWY** — Centralna klasyfikacja kategorii, poziomów ryzyka i wymagań approvali dla narzędzi. |
| **Manifest Modeli** | `src/mastra/config/model-manifest.ts` | **REFAKTOR** — Automatyczna derywacja `agentModels` z `agentModelSequences` w TypeScript (usunięcie 25 zduplikowanych wpisów). |
| **Narzędzie Delegacji** | `src/mastra/tools/system/delegate-task.ts` | **REFAKTOR** — Podpięcie mapy `AGENT_IDS` pod `AGENT_SOURCE_REGISTRY`. |
| **Wspólny Silnik Budowy** | `src/mastra/services/guarded-build-core.ts` | **NOWY** — Wydzielenie z `capability-build.ts` generycznego runnera procesów (`runCommandInProcessGroup`), zarządzania `git worktree` i bramek `tsc/check:all`. |

---

## 5. Zestaw 5 Wzorcowych Skilli (`src/mastra/_skills/`)

1. **`_skills/meta/research-specialist-dossier.md` (`researcherAgent`):**  
   Instrukcja przeprowadzania rekonesansu 4 Filarów, sprawdzania domen publicznych (ISAP, UODO, EUR-Lex) lub klasyfikacji danych wrażliwych i generowania JSON `SpecialistDossierV1`.
2. **`_skills/meta/build-specialist-skill.md` (`writerAgent`):**  
   Szablon kompilacji procedury operacyjnej SOP do pliku Markdown ze ścisłym YAML frontmatter.
3. **`_skills/knowledge/setup-domain-knowledge-pack.md` (`knowledgeAgent`):**  
   Procedura tworzenia notatnika w NotebookLM, zasilania źródłami i kalibracji zapytań (grounding probes).
4. **`_skills/knowledge/setup-private-local-knowledge.md` (`knowledgeAgent`):**  
   Procedura tworzenia lokalnego katalogu `src/mastra/knowledge/private/<domain>/` i konfiguracji indeksu `bge-m3`.
5. **`_skills/coding/scaffold-new-mastra-agent.md` (`codingAgent`):**  
   Procedura awaryjna tworzenia stałego agenta TypeScript w izolowanym worktree z bramkami `guarded-build-core.ts`.

---

## 6. Instrukcja Promptowa dla Meta Agenta (`prompts/meta/base.md`)

Poniższa sekcja zostaje wstrzyknięta do promptu systemowego Meta Agenta:

```markdown
<!-- SECTION: AUTONOMOUS SPECIALIST CREATION & SOLUTION DECISION -->
## 15. Specialist Creation & Solution Decision Protocol

When the user asks to build, create, or provision a new agent, expert, or assistant (e.g., "Stwórz mi agenta do RODO", "Potrzebuję asystenta do audytu SEO", "Zbuduj eksperta do naszych wewnętrznych umów"):

### Rule 1: DO NOT Code New TypeScript Classes by Default
Do not write new `.ts` agent files in `src/mastra/agents/` unless explicitly commanded: "Wymuszam utworzenie stałego agenta w kodzie TypeScript".
Use the **Lightweight 4-Pillar Passport (`SpecialistDossierV1`)** model. It provisions skills, knowledge packs, and tools in under 60 seconds without server restarts.

### Rule 2: Privacy Detection & Interactive Confirmation Gate
Before provisioning:
- If the domain touches confidential business records, internal contracts, financial statements, or PII:
  Inform the user and ask:
  *"Zauważyłem, że to zadanie dotyczy poufnych danych biznesowych. Czy chcesz, abym skonfigurował specjalistę w (1) Trybie Prywatnym / Lokalnym (Ollama + Lokalna baza wiedzy offline - Rekomendowane), czy w (2) Trybie Chmurowym (Google NotebookLM)?"*
- If public/general industry knowledge, default to Cloud (`notebooklm_cloud`).

### Rule 3: The 4-Pillar Provisioning Workflow
1. **Research & Dossier:** Delegate to `researcherAgent` to conduct live research, collect verified official links or classify local data paths, and output a valid `SpecialistDossierV1` JSON (saved as artifact type `specialist_dossier`).
2. **Execution:** Pass the validated dossier to `specialist-builder` / `knowledgeAgent` + `writerAgent` + `skillSaveTool`.
3. **Report:** Provide the user with the ready confirmation, listing:
   - Host Agent (`assignedHostAgent`)
   - Created Skill (`_skills/auto/<skillId>.md`)
   - Knowledge Base details (NotebookLM title OR exact path to private local knowledge directory).

### Rule 4: Execution of Specialist Tasks
When the user subsequently assigns a task for this domain:
- Route to the `assignedHostAgent` (e.g., `researcherAgent`).
- Pass the skill in delegation: `skills: ['<skillId>']`.
- The agent will execute the SOP and query the knowledge pack via `knowledgeLookupTool`.
```

---

## 7. Checklist Realizacji Planu (Śledzenie Postępów)

- [x] **Faza 1: Centralizacja Rejestrów i Eliminacja Długu**
  - [x] Utworzenie `src/mastra/config/agent-source-registry.ts`
  - [x] Utworzenie `src/mastra/config/tool-binding-registry.ts`
  - [x] Refaktor `src/mastra/config/model-manifest.ts` (automatyczna derywacja `agentModels`)
  - [x] Refaktor `src/mastra/tools/system/delegate-task.ts` (podpięcie pod `AGENT_SOURCE_REGISTRY`)
  - [x] Utworzenie i weryfikacja skryptu `src/mastra/scripts/check-registries-sync.ts` (Zaliczony: 25 agentów, 0 błędów)
  - [x] Weryfikacja typu: `npx tsc --noEmit` (Kod 0)
- [x] **Faza 2: Wydzielenie `guarded-build-core.ts` i Narzędzia Systemowe**
  - [x] Utworzenie `src/mastra/services/guarded-build-core.ts`
  - [x] Refaktor `src/mastra/services/capability-build.ts` do używania `guarded-build-core.ts`
  - [x] Utworzenie `src/mastra/tools/system/skill-save.ts` (`skillSaveTool`)
  - [x] Rozszerzenie `src/mastra/config/artifact-types.ts` o `specialist_dossier`
- [x] **Faza 3: Schematy, Serwis Budowy i Zestaw Skilli**
  - [x] Utworzenie `src/mastra/schemas/specialist-dossier.ts` (z `PrivacyBoundarySchema`)
  - [x] Utworzenie `src/mastra/services/specialist-builder.ts` (obsługa Cloud i Local Private)
  - [x] Utworzenie skilli w `src/mastra/_skills/meta/` i `_skills/knowledge/`
  - [x] Aktualizacja promptów `src/mastra/prompts/meta/base.md` oraz `meta-front/base.md`
- [x] **Faza 4: Weryfikacja i Testy End-to-End**
  - [x] Utworzenie i uruchomienie skryptu `src/mastra/scripts/check-specialist-builder-e2e.ts` (100% green)
  - [x] Uruchomienie `npx tsc --noEmit` i `npm run check:registries-sync`
  - [x] Utworzenie dokumentacji technicznej i instrukcji użytkownika
