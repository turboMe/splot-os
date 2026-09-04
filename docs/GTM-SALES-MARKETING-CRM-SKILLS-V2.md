# Dokumentacja Architektury GTM & Agentic Skills V2 (2026)

## 1. Wprowadzenie i Kontekst Biznesowy

Niniejsza dokumentacja opisuje architekturę i procedury operacyjne klastra agentów Go-To-Market (GTM): **`marketingAgent`**, **`salesAgent`** oraz **`crmAgent`** w środowisku Mastra / Splot OS.

Celem wdrożenia jest zapewnienie pełnej autonomii przy zachowaniu ścisłych bramek bezpieczeństwa (Safety Gates), eliminacji halucynacji narzędziowych oraz dynamicznego doładowywania wyspecjalizowanych procedur agentowych (**Skills**) w standardzie 2025/2026.

---

## 2. Architektura Klastra Agentów

```
                      ┌──────────────────────────────┐
                      │          metaAgent           │
                      │    (Orkiestrator Zadań)      │
                      └──────────────┬───────────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          ▼                          ▼                          ▼
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  marketingAgent  │       │    salesAgent    │       │     crmAgent     │
│  - Top-of-Funnel │       │ - Consultative   │       │ - System of      │
│  - ABM Profiling │       │   Deal Architect │       │   Record Owner   │
│  - Multi-touch   │       │ - MEDDPICC & NBA │       │ - Higiena danych │
│  - Copywriting   │       │ - Objections     │       │ - Sentinel Churnu│
└─────────┬────────┘       └─────────┬────────┘       └─────────┬────────┘
          │                          │                          │
          └──────────────────────────┼──────────────────────────┘
                                     ▼
                  ┌─────────────────────────────────────┐
                  │   UnifiedCapabilityShelfProcessor   │
                  │   - Step 0 Hybrid Preselection      │
                  │   - BM25 + Wektorowe Wyszukiwanie   │
                  │   - Auto-LRU Eviction (maxActive)   │
                  │   - Tool Bundles & Atomic Load      │
                  └──────────────────┬──────────────────┘
                                     ▼
                  ┌─────────────────────────────────────┐
                  │        KATALOG SKILLI I NARZĘDZI    │
                  │   .agents/skills/ & src/mastra/_skills  │
                  └─────────────────────────────────────┘
```

### Podział Odpowiedzialności i Role:

1. **`marketingAgent`** (`src/mastra/agents/marketing-agent.ts`):
   - **Rola**: Top-of-Funnel, generowanie i wzbogacanie leadów B2B, badanie firm w modelu ABM, projektowanie wieloetapowych sekwencji komunikacji i treści wiralowych.
   - **Podstawowe bundle**: `market_intel`, `email_outreach`, `crm_pipeline`, `knowledge_research`.

2. **`salesAgent`** (`src/mastra/agents/sales-agent.ts`):
   - **Rola**: Consultative Deal Architect, prowadzenie rozmów handlowych, kwalifikacja MEDDPICC, neutralizacja obiekcji (ROI, budżet, timing, sceptycyzm AI), generowanie ofert i orkiestracja wdrożenia klienta (*Onboarding*).
   - **Podstawowe bundle**: `objection_handling`, `deal_qualification`, `onboarding`.

3. **`crmAgent`** (`src/mastra/agents/crm-agent.ts`):
   - **Rola**: System of Record Guardian, audyt higieny bazy, weryfikacja statusów leada, deduplikacja, prewencja churnu (*Client Health Sentinel*) oraz analiza wątków.
   - **Podstawowe bundle**: `churn_prevention`, `deal_qualification`, `onboarding`.

---

## 3. Integracja Dynamicznej Półki (`Capability Shelf`)

Każdy z agentów został wyposażony w procesor wejściowy `createUnifiedCapabilityShelfProcessor` oraz ogranicznik kontekstu `createTokenLimiter(120_000)`.

### Schemat działania procesora:
- **Krok 0 (Preselekcja)**: Procesor analizuje zapytanie użytkownika i automatycznie aktywuje najbardziej adekwatne narzędzia i skille (np. wykrycie pytania o obiekcję klienta doładowuje skill `b2b-objection-matrix-solver`).
- **Narzędzia sterujące**: Agent ma do dyspozycji:
  - `capability_search`: przeszukuje katalog hybrydowy (BM25 + embeddings).
  - `capability_load`: atomowo doładowuje lub zwalnia skille i narzędzia.
  - `capability_list_active`: raportuje stan aktywnej pamięci podręcznej.
- **Auto-LRU Eviction**: Zapobiega przepełnieniu okna kontekstowego modelu przez rotację najdawniej używanych procedur.

---

## 4. Rejestr 6 Nowych Skilli Agentowych

### 1. `b2b-objection-matrix-solver`
* **Ścieżka**: `.agents/skills/b2b-objection-matrix-solver/SKILL.md` oraz `src/mastra/_skills/sales/b2b-objection-matrix-solver.md`
* **Domena**: Sprzedaż konsultacyjna B2B, obsługa oporu decydentów.
* **Wzorzec operacyjny**:
  1. Klasyfikacja typu obiekcji (Cena / Budżet, Timing / Brak czasu, Status Quo, Sceptycyzm wobec AI, Władza decyzyjna).
  2. Pobranie twardych faktów z Bazy Wiedzy GastroBridge / Consulting (`knowledgeLookupTool`).
  3. Formułowanie odpowiedzi w schemacie **Feel-Felt-Found + Value Anchor + ROI Proof**.
  4. Przygotowanie szkicu w Gmail (`gmail_manage_draft`) i rejestracja interakcji w CRM (`addInteractionTool`).

### 2. `meddpicc-deal-qualifier`
* **Ścieżka**: `.agents/skills/meddpicc-deal-qualifier/SKILL.md` oraz `src/mastra/_skills/sales/meddpicc-deal-qualifier.md`
* **Domena**: Kwalifikacja szans sprzedaży Enterprise/B2B.
* **Wzorzec operacyjny**:
  1. Analiza 8 filarów: Metrics, Economic Buyer, Decision Criteria, Decision Process, Paper Process, Identify Pain, Champion, Competition.
  2. Kalkulacja wskaźnika **Deal Health Score (0-100)**:
     - 80-100: *High Probability* (ścieżka do zamknięcia).
     - 50-79: *Medium Risk* (wymaga zaadresowania luk decyzyjnych).
     - <50: *High Risk / Unqualified*.
  3. Generowanie raportu jako **Artifact Markdown** i ustalenie *Next Best Action (NBA)*.
  4. Zapis metadanych kwalifikacji do rekordu CRM.

### 3. `abm-account-dossier-builder`
* **Ścieżka**: `.agents/skills/abm-account-dossier-builder/SKILL.md` oraz `src/mastra/_skills/marketing/abm-account-dossier-builder.md`
* **Domena**: Account-Based Marketing i wywiad rynkowy.
* **Wzorzec operacyjny**:
  1. Przeszukanie WWW lokalu, mediów społecznościowych i opinii Google (`reviews_google_place`, `searchWebTool`).
  2. Identyfikacja komitetu decyzyjnego (Właściciel, Szef Kuchni, Dyrektor Operacyjny).
  3. Wykrycie 3 głównych punktów bólu (Food Cost, rotacja personelu, brak automatyzacji).
  4. Generowanie **Account Dossier Artifact** i utworzenie rekordu w CRM z flagą `skipIfEngaged`.

### 4. `multi-touch-cadence-planner`
* **Ścieżka**: `.agents/skills/multi-touch-cadence-planner/SKILL.md` oraz `src/mastra/_skills/marketing/multi-touch-cadence-planner.md`
* **Domena**: Wieloetapowe sekwencje kontaktu B2B.
* **Wzorzec operacyjny**:
  1. Zaprojektowanie 4-stopniowego harmonogramu:
     - **Dzień 0**: *Hook & Problem Statement*
     - **Dzień +3**: *Value Asset / Case Study*
     - **Dzień +7**: *Quick Check & Insight*
     - **Dzień +14**: *Polite Break-up & Nurture*
  2. Utworzenie szkiców wiadomości w Gmail (`gmail_manage_draft`).
  3. Zaplanowanie zadań w harmonogramie (`schedule_task`).
  4. Wymóg weryfikacji przed wysyłką (`skipIfEngaged`).

### 5. `client-health-churn-sentinel`
* **Ścieżka**: `.agents/skills/client-health-churn-sentinel/SKILL.md` oraz `src/mastra/_skills/crm/client-health-churn-sentinel.md`
* **Domena**: Retencja, audyt relacji i zapobieganie odejściom klientów.
* **Wzorzec operacyjny**:
  1. Cykliczny skan bazy CRM pod kątem aktywnych klientów (`closed_won`, `in_progress`) bez interakcji przez $>30$ dni.
  2. Analiza sentymentu i opóźnień w wątkach Gmail (`gmailSearchTool`).
  3. Obliczenie wskaźnika **Account Health Score (0-100)**.
  4. Jeśli Score $<60$: natychmiastowy alert Telegram do Patryka oraz przygotowanie proaktywnego szkicu "Value Drop / Check-in" w Gmailu.

### 6. `client-onboarding-orchestrator`
* **Ścieżka**: `.agents/skills/client-onboarding-orchestrator/SKILL.md` oraz `src/mastra/_skills/sales/client-onboarding-orchestrator.md`
* **Domena**: Wdrożenie nowego klienta po wygranej transakcji.
* **Wzorzec operacyjny**:
  1. Reakcja na zmianę statusu leada na `closed_won`.
  2. Wygenerowanie spersonalizowanego pakietu wdrożeniowego (**Onboarding Pack Artifact**).
  3. Utworzenie spotkania Kickoff w Kalendarzu Google (`calendarCreateEventTool`).
  4. Przygotowanie powitalnego draftu wiadomości w Gmailu z linkami do zasobów.
  5. Aktualizacja etapu wdrożenia w CRM (`onboarding_scheduled`).

---

## 5. Zasady Bezpieczeństwa (Safety Gates)

Wszystkie procedury bezwzględnie przestrzegają poniższych reguł:
1. **Zero Direct Sends**: Agenci NIGDY nie wysyłają wiadomości e-mail bezpośrednio. Wykorzystywana jest wyłącznie akcja `gmail_manage_draft(action: 'create')`. Wysłanie wiadomości wymaga autoryzacji człowieka (Patryka).
2. **Bramka Rabatowa**: Zastosowanie rabatu $>10\%$ lub niestandardowych warunków handlowych wymaga wywołania `requestApprovalTool`.
3. **Deduplikacja i Ochrona Relacji**: Każda akcja outreach weryfikuje istnienie aktywnych rozmów (`skipIfEngaged`), aby uniknąć ponownego spamowania klienta.
4. **Idempotencja Zapisu CRM**: Zmiany w CRM są weryfikowane przed nadpisaniem istniejących notatek lub zmianą statusu deala.

---

## 6. Procedury Weryfikacji i Testowania

Weryfikację poprawności wdrożenia przeprowadzono następującymi komendami:
```bash
# 1. Sprawdzenie poprawności typów TypeScript w całym projekcie
npx tsc --noEmit

# 2. Weryfikacja instancjacji agentów oraz indeksowania półki skilli
bash scripts/with-node.sh npx tsx src/mastra/scripts/verify-gtm.ts
```

Wyniki testów:
- Kompilator TypeScript: 0 błędów.
- Skanowanie katalogów: 991 plików skilli zaindeksowanych w pamięci hybrydowej.
- Trafność wyszukiwania dla zapytań branżowych: `score: 1.00`.
