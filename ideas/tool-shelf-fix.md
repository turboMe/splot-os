# Kompleksowy Plan Optymalizacji Transient Tool Shelf & Polityki Narzędziowej

Data utworzenia: 2026-08-25  
Status: Wdrożone i zweryfikowane (Completed)  
Cel: Drastyczna redukcja step churn (marnowania tur przez agentów), eliminacja błędów przepełnienia półki, czysty podział na warstwy narzędziowe oraz przyspieszenie pracy agentów poprzez wiązki narzędzi (*Tool Bundles*) i automatyczną rotację pamięci podręcznej (Auto-LRU).

---

## 1. Diagnoza i Główne Założenia Architektoniczne

Obecny mechanizm `TransientToolShelfProcessor` chroni okno kontekstowe przed zalewem tokenów, ale wymagał usprawnienia w warstwie użyteczności:
1. **Likwidacja 2-krokowego churnu:** Wyszukiwanie narzędzi (`search_tools`) automatycznie ładuje najlepsze dopasowania (`autoLoad: true`), eliminując konieczność osobnego wołania `load_tool` w kolejnej turze.
2. **Likwidacja błędów przepełnienia półki:** Zastąpienie blokującego komunikatu błędu automatyczną eksmisją najstarszych narzędzi dynamicznych (Auto-LRU / FIFO) przy przekroczeniu `maxActive`.
3. **Pakiety narzędzi (*Tool Bundles / Capability Packs*):** Ładowanie spójnych zestawów narzędzi odpowiadających fazom pracy (np. analiza kodu, edycja, research, scraping) zamiast pojedynczych narzędzi.
4. **Zwiększenie limitu `maxActive`:** Podniesienie bufora dynamicznych narzędzi z **8 do 10** dla złożonych hubów (`coding-agent`, `researcher-agent`).
5. **Czysty podział na warstwy (Kernel Controls vs coreTools vs Active):**
   * **Kernel Controls (Warstwa 0):** Narzędzia kontrolne półki (`search_tools`, `load_tool`, `list_active_tools`, `release_tools`, `skill_search`, `skill_load`, `skill_swap`, `skill_release`) są stałą częścią jądra systemu (`TRANSIENT_SHELF_CONTROL_NAMES`), wstrzykiwaną automatycznie i chronioną przed jakimkolwiek odcięciem. **Nie wpisujemy ich do `coreTools`**.
   * **Domenowe `coreTools` (Warstwa 1):** Odchudzone do absolutnego minimum przeżycia i protokołu: `artifact_put`, `artifact_get` (wymiana stanu) oraz `request_approval` (bramka bezpieczeństwa).
   * **Dynamiczne `active` (Warstwa 2):** 8–10 elastycznych slotów z automatyczną rotacją LRU, zarządzanych przez wiązki i wyszukiwanie.

---

## 2. Inwentaryzacja i Polityka Narzędziowa Agentów

W systemie znajduje się 25 agentów, podzielonych według jasnych kryteriów architektonicznych:

| Grupa | Agenci | Liczba narzędzi | Status Tool Shelf | Konfiguracja i Rekomendacja |
|---|---|---|---|---|
| **Grupa A: Duże huby narzędziowe** | `coding-agent` (40+), `researcher-agent` (15+), `marketing-agent` (23) | **15 – 45** | **UŻYWAJĄ PÓŁKI** | **Optymalizacja:** `maxActive: 10`, odchudzone `coreTools` (3 narzędzia), pełne pokrycie pakietami `toolBundles`. |
| **Grupa B: Agenci domenowi (Media/Kreatywni)** | `chef-agent` (30+), `content-agent` (20+), `hunt-agent` (15), `writer-agent` (8), `film-agent` (8), `musician-agent` (8), `design-agent` (8) | **8 – 35** | **UŻYWAJĄ PÓŁKI** | **Półka standardowa:** `maxActive: 8`, odchudzone `coreTools` (3 narzędzia), dedykowane pakiety fazowe. |
| **Grupa C: Złota Ścieżka (Infrastrukturalni)** | `meta-agent` (7), `knowledge-agent` (7), `automation-architect` (14), `n8n-mcp-engineer` (11) | **7 – 14** | **UŻYWAJĄ z `preserveConfiguredToolsAsCore: true`** | **Brak ukrywania narzędzi:** Wszystkie ich narzędzia są na stałe przypięte. Ukrywanie ich narzędzi powodowało halucynacje (potwierdzone w audycie z 23.08). Półka zarządza tylko ewentualną dodatkową pulą tła. |
| **Grupa D: Agenci wąskospecjalizowani i mikroagenci** | `analytics-agent` (8), `sales-agent` (10), `code-review-agent` (4), `security-review-agent` (3), `performance-review-agent` (3), `crm-agent` (1), `deliberation-agent` (2), `weather-agent` (2), `lane-orchestrator-agent` (1), `meta-front-agent` (2) | **1 – 10** | **NIE UŻYWAJĄ PÓŁKI** | **Brak półki:** Posiadają wąski, precyzyjny zestaw narzędzi. Dodanie procesora półki i 9 meta-narzędzi zwiększyłoby niepotrzebnie szum w prompcie. |

---

## 3. Kompletna Specyfikacja Pakietów Narzędzi (*Tool Bundles*)

Definicje pakietów zarejestrowane w profilach agentów w `src/mastra/config/transient-tool-shelf-profiles.ts`:

### 1. `coding-agent`
* **`coreTools`:** `['artifact_put', 'artifact_get', 'system_request_approval']`
* **`maxActive`:** `10`
* **`initialTopK`:** `4`
* **`toolBundles`:**
  * **`inspect`** *(Inspekcja i nawigacja po repozytorium)*:  
    `['view', 'search_content', 'find_files', 'workspace_search', 'repo_map', 'lsp_inspect']`
  * **`write`** *(Zapis, śledzenie i rewizja plików)*:  
    `['coding_write_file_tracked', 'coding_create_artifact', 'coding_accept_file', 'coding_reject_file']`
  * **`test_run`** *(Weryfikacja testowa i polecenia systemowe)*:  
    `['coding_run_test', 'execute_command', 'bg_task']`
  * **`git_worktree`** *(Izolowane gałęzie i łatki)*:  
    `['coding_init_worktree', 'coding_remove_worktree', 'coding_apply_patch']`
  * **`impact_analysis`** *(Analiza grafu zależności i symboli)*:  
    `['graphify_affected', 'graphify_explain', 'graphify_god_nodes', 'code_outline']`
  * **`docs_external`** *(Dokumentacja zewnętrznych bibliotek Context7)*:  
    `['context7_resolve_library_id', 'context7_query_docs']`

### 2. `researcher-agent`
* **`coreTools`:** `['artifactPutTool', 'artifactGetTool', 'requestApprovalTool']`
* **`maxActive`:** `10`
* **`initialTopK`:** `4`
* **`toolBundles`:**
  * **`web_search`** *(Odkrywanie stron i wyszukiwanie w sieci)*:  
    `['searchWebTool', 'findCompanyLinksTool']`
  * **`web_extract`** *(Szybka ekstrakcja i zaawansowany crawling)*:  
    `['tavilyExtractTool', 'firecrawl_scrape', 'firecrawl_crawl']`
  * **`browser_dom`** *(Interaktywna przeglądarka Playwright)*:  
    `['playwright_navigate', 'playwright_click', 'playwright_fill', 'playwright_evaluate']`
  * **`report_write`** *(Zapis wyników i raportów na dysku)*:  
    `['writeExternalProjectFileTool', 'writeFileTool']`

### 3. `marketing-agent`
* **`coreTools`:** `['artifactPutTool', 'artifactGetTool', 'requestApprovalTool']`
* **`maxActive`:** `8`
* **`initialTopK`:** `4`
* **`toolBundles`:**
  * **`crm_pipeline`** *(Zarządzanie leadami i relacjami)*:  
    `['searchLeadsTool', 'createLeadTool', 'updateStatusTool', 'updateLeadTool', 'addInteractionTool']`
  * **`email_outreach`** *(Szkicowanie wiadomości i kalendarz)*:  
    `['recordEmailDraftTool', 'gmailSearchTool', 'gmailManageDraftTool', 'calendarCreateEventTool']`
  * **`market_intel`** *(Wywiad rynkowy i agregacja RSS)*:  
    `['rssGetArticlesTool', 'rssSearchArticlesTool', 'rssCreateDigestTool', 'searchWebTool']`
  * **`knowledge_research`** *(Głęboka analiza w NotebookLM)*:  
    `['knowledgeQueryTool', 'knowledgeQueryMultiTool', 'knowledgeListNotebooksTool', 'knowledgeResearchStartTool']`

### 4. `chef-agent`
* **`coreTools`:** `['artifactPutTool', 'artifactGetTool', 'requestApprovalTool']`
* **`maxActive`:** `8`
* **`toolBundles`:**
  * **`menu_creation`** *(Generowanie, dopracowywanie i eksport menu)*:  
    `['chefGenerateMenuTool', 'chefSaveMenuTool', 'chefGetMenuTool', 'chefIterateMenuTool', 'chefExportMenuTool']`
  * **`recipe_engine`** *(Kreacja przepisów, pairing smaków i sezonowość)*:  
    `['chefDraftRecipeTool', 'chefSearchRecipeLibraryTool', 'chefGetRecipeTool', 'chefSuggestPairingsTool', 'chefCheckSeasonalTool']`
  * **`menu_book_doc`** *(Generowanie dokumentu Menu Book i PDF)*:  
    `['chefDocumentInitTool', 'chefDocumentWriteSectionTool', 'chefDocumentStatusTool', 'chefDocumentRenderTool', 'chefDocumentPdfTool']`
  * **`project_mgmt`** *(Profil restauracji, status projektu i notatki)*:  
    `['chefStartProjectTool', 'chefGetProjectTool', 'chefListProjectsTool', 'chefSetProjectStatusTool', 'chefAddNoteTool']`

### 5. `content-agent`
* **`coreTools`:** `['artifactPutTool', 'artifactGetTool', 'requestApprovalTool']`
* **`maxActive`:** `8`
* **`toolBundles`:**
  * **`content_strategy`** *(Sygnały rynkowe, research i strategia)*:  
    `['contentFetchSignalsTool', 'contentQueryStrategyTool', 'knowledgeQueryTool']`
  * **`content_pack_doc`** *(Pisanie wieloczęściowego pakietu treści)*:  
    `['contentDocumentInitTool', 'contentDocumentWriteSectionTool', 'contentDocumentStatusTool', 'contentDocumentRenderTool']`
  * **`quality_and_ship`** *(Bramka jakościowa, szkice i harmonogram publikacji)*:  
    `['contentQualityCheckTool', 'contentSaveDraftTool', 'contentScheduleTool']`
  * **`exemplars`** *(Baza wzorców i notatek)*:  
    `['contentSearchExemplarsTool', 'contentAddExemplarTool', 'contentAddNoteTool', 'contentSearchNotesTool']`

### 6. `capability-smith`
* **`coreTools`:** `['artifactPutTool', 'artifactGetTool', 'requestApprovalTool']`
* **`maxActive`:** `6`
* **`toolBundles`:**
  * **`mcp_registry`** *(Odkrywanie, sandbox i podłączanie serwerów MCP)*:  
    `['mcpDiscoverTool', 'capabilitySandboxTool', 'capabilityRequestAttachTool', 'capabilityAttachTool', 'capabilityListTool']`
  * **`cgp_build`** *(Zlecanie budowy nowych narzędzi)*:  
    `['capabilityBuildTool', 'capabilityBuildStatusTool', 'delegateTaskTool']`
  * **`system_board`** *(Tablica agentów i pamięć obserwacyjna)*:  
    `['memoryRecallTool', 'memoryWriteTool', 'agentBoardListTool', 'agentBoardGetTool']`

---

## 4. Szczegóły Zmian w Kodzie Źródłowym

### Plik A: `src/mastra/config/transient-tool-shelf-profiles.ts`
1. Rozszerzenie definicji typu o `toolBundles?: Record<string, string[]>`.
2. Zaktualizowanie profili `PROFILES` o definicje `toolBundles`, odchudzone `coreTools` oraz nowe limity `maxActive: 10`.
3. Poprawne scalanie `toolBundles` w funkcji `resolveTransientToolShelfProfile`.

### Plik B: `src/mastra/processors/transient-tool-shelf.ts`
1. **Funkcja rozwijania wiązek (`expandRequestedNames`):**
   * Rozwija nazwy będące kluczami w bundles oraz dopasowuje pojedyncze narzędzia do całych pakietów.
   * Filtruje rozwinięcia przez `isKnown`, co zapewnia stabilność w środowiskach o ograniczonym zestawie narzędzi.
2. **Auto-LRU w `load_tool`:**
   * Jeśli `(shelfState.active.length + toLoad.length) > maxActive`, procesor wylicza nadmiar i usuwa najstarsze narzędzia z początku `shelfState.active`.
   * Narzędzia z `core` są nietykalne.
   * `success` jest zawsze `true`.
3. **Auto-Load w `search_tools`:**
   * Dodanie parametru `autoLoad?: boolean` do schematu `inputSchema` (domyślnie `true`).
   * Automatyczna rejestracja w `shelfState.active` najlepszych dopasowań (z wykorzystaniem logiki Auto-LRU).
   * Zwrócenie w wyjściu `autoLoaded: string[]`.
4. **Preselekcja w kroku 0 (Step Zero):**
   * Zastosowanie `expandRequestedNames` do narzędzi wytypowanych przez ranking leksykalny w kroku 0, aby od razu ładować całą powiązaną wiązkę.
5. **Aktualizacja komunikatu systemowego (`args.messageList.addSystem`):**
   * Poinstruowanie modelu, że `search_tools` automatycznie aktywuje narzędzia i zwalnia starsze, a narzędzia są dostępne natychmiast w kolejnym kroku tej samej tury.

---

## 5. Granice Bezpieczeństwa (Czego NIE dotykać)

1. **`TRANSIENT_SHELF_CONTROL_NAMES` w `transient-shelf-controls.ts`:**
   * Kontrolki `search_tools`, `load_tool`, `release_tools`, `list_active_tools`, `skill_search`, `skill_load`, `skill_swap`, `skill_release` pozostają nienaruszone.
2. **`preserveConfiguredToolsAsCore: true`:**
   * Zachowane dla `meta-agent`, `automation-architect`, `knowledge-agent`, `n8n-mcp-engineer`.
3. **Kompatybilność wsteczna:**
   * `load_tool` i `release_tools` zachowują pełną sprawność.
4. **Brak modyfikacji narzędzi domenowych w `src/mastra/tools/*`:**
   * Narzędzia domenowe nie posiadają zależności od implementacji półki.
5. **Mechanizm Feature Flag:**
   * `FEATURE_INTERIM_TOOL_SHELF` i `INTERIM_TOOL_SHELF_AGENTS` działają bez zmian.

---

## 6. Lista Zadań Krok po Kroku dla Developera

- [x] **Krok 1:** Edycja `src/mastra/config/transient-tool-shelf-profiles.ts`:
  - Dodanie `toolBundles` do interfejsu.
  - Zaktualizowanie profili dla `coding-agent`, `researcher-agent`, `marketing-agent`, `chef-agent`, `content-agent`, `capability-smith`.
  - Odchudzenie `coreTools` i podniesienie `maxActive: 10` dla kluczowych hubów.
- [x] **Krok 2:** Edycja `src/mastra/processors/transient-tool-shelf.ts`:
  - Implementacja `expandRequestedNames` dla wiązek.
  - Implementacja Auto-LRU w `load_tool` (likwidacja błędu `capacityRejected`).
  - Implementacja `autoLoad: true` w `search_tools`.
  - Integracja wiązek z preselekcją w kroku 0.
  - Aktualizacja instrukcji systemowej w `addSystem`.
  - Wzmocnienie obcinania pojemności dla `toLoad` większych niż `maxActive`.
- [x] **Krok 3:** Aktualizacja i uruchomienie testów jednostkowych:
  ```bash
  npm run check:transient-tool-shelf
  ```
  *(Weryfikacja: Auto-LRU, Auto-Load w search, wiązki narzędzi, izolacja per-request, zachowanie coreTools).*
- [x] **Krok 4:** Aktualizacja i uruchomienie testów E2E oraz kompilacji:
  ```bash
  npm run e2e:transient-tool-shelf
  npm run typecheck
  npm run build
  ```
- [x] **Krok 5:** Sprawdzenie całościowej integracji z domenami (`check:coding-domain`, `check:musician-domain`, `check:subagent-roles-enforced`).
