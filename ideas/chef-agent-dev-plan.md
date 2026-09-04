# Plan rozwoju: Chef Domain Agent + pipeline "Księga Menu"

> Wersja: 1.0 | Data: 2026-06-10 | Autor analizy: Claude (na bazie audytu repo `mastra-agentic-agents-blue-green-autohealing-system`, commit master)
> Odbiorca: dev (Patryk / codingAgent przez Nocną Zmianę)
> Cel: od rozmowy LUB linku do strony restauracji → recon (menu + opinie) → profil → menu → receptury → finalna Księga Menu pisana przyrostowo do katalogu na dysku.

---

## 0. TL;DR - pięć decyzji architektonicznych

| # | Decyzja | Uzasadnienie (fakt z kodu) |
|---|---|---|
| D1 | **Wydzielić `chefAgent` jako pełnoprawnego agenta domenowego** (wzorzec: marketing/sales) | Chef to dziś 16 tooli wpiętych w meta-agenta. `prompts/chef/domain.md` (świetna wiedza: Kasavana-Smith, progresje, pairing) jest **sierotą - żaden plik TS go nie ładuje** (grep "chef/domain" = 0 wyników). Meta wg własnego promptu ma być dyrektorem, nie wykonawcą. |
| D2 | **Research przez `researcherAgent` (PSEV)** - hipoteza POTWIERDZONA, ale wymaga 1 fixu | Researcher ma Tavily + **Playwright MCP** (nawigacja, snapshot, pdf) + **Firecrawl MCP** (scrape/crawl → markdown) + pętlę Plan-Search-Extract-Verify z triangulacją źródeł. Jest zarejestrowany w `index.ts:821`, ale **NIE MA go w `AGENT_IDS` w delegate-task.ts** - nikt nie może go delegować. Używa go tylko producer-hunt przez bezpośredni import. |
| D3 | **Wyszukiwanie w 3 warstwach zamiast strzępków** | Obecny `tavily.ts` = tylko `/search` z `search_depth:'basic'` (snippety). Tavily wspiera `include_raw_content:'markdown'` na /search oraz endpoint `/extract` (do 20 URL, depth `advanced` wyciąga tabele - istotne dla menu). Istnieje oficjalny pakiet `@mastra/tavily` z gotowym `createTavilyExtractTool`. |
| D4 | **Opinie Google Maps: oficjalne Places API (5 opinii) + PSEV po prasie/TripAdvisor; opcjonalnie Outscraper** | Oficjalny limit Places API to 5 "most relevant" opinii bez paginacji - potwierdzone, stan na 2026. Scraping Maps Playwrightem = kruchy i szara strefa TOS - odrzucamy. Płatne API (Outscraper/SerpApi) dają nielimitowane opinie z sortem `lowest_rating` (złoto do "słabych stron") - jako opcja Etapu 3. |
| D5 | **Dokument przyrostowy: rodzina tooli `chef_document_*` z sekcjami na kotwicach** | `fs_write_file` robi tylko pełny overwrite w sandboxie (brak append). Dokument budowany sekcja-po-sekcji między kotwicami HTML-comment: każda faza pipeline'u dopisuje swoją sekcję, crash = wznawialne, iteracja = podmiana jednej sekcji bez psucia reszty. Zero "jednego wielkiego generowania". |

---

## 1. Stan obecny - zweryfikowane fakty (audyt kodu)

### 1.1 Co działa i zostaje bez zmian
- Model danych chef (`chef-service.ts`): `ChefProject/ChefProfile/ChefMenu/ChefDish/ChefRecipe(BOM: components+miseEnPlace+serviceSteps)/ChefNote` + indeksy Mongo - kompletny, nie ruszamy.
- Silnik ankiety: `getMissingFields/getContextualQuestions/getDefaultSuggestions` - gotowa maszynka do "dodatkowych pytań od agenta" (wejście konwersacyjne). Wykorzystujemy 1:1.
- `chef_generate_menu`: ładuje profil + kontekst z notebooków NLM (cross-notebook query, cache 24h) i zwraca instrukcję kompozycji → `chef.save_menu`. Wzorzec "tool ładuje kontekst, agent komponuje" zostaje.
- Wersjonowanie menu, `chef_iterate_menu`, notatki chefa.
- Harness: `run_worker` (presety fast/default/reasoning/powerful/cloud + skills), równoległe tool calle w jednej turze, `requestApproval`, async delegation + pending updates, failure-brain, GoalContracts w delegate-task.

### 1.2 Luki (każda z dowodem)
| # | Luka | Dowód |
|---|---|---|
| L1 | Brak agenta domenowego chef | `grep -l "chef-tools" agents/` → tylko `meta-agent.ts`. Brak `agents/chef-agent.ts`. |
| L2 | `prompts/chef/domain.md` nieładowany | `grep -rn "chef/domain" src/ --include="*.ts"` → 0 trafień. `combinePrompts` łączy tylko jawnie podane ścieżki; meta ładuje wyłącznie `meta/base`. |
| L3 | Researcher niedelegowalny | `grep -n researcher tools/system/delegate-task.ts` → 0. Brak w tabeli agentów w `prompts/meta/base.md`. |
| L4 | Tavily = snippety | `tavily.ts:27` - body zawiera tylko `search_depth:'basic'`; brak `/extract`, brak `include_raw_content`. |
| L5 | Eksport bez receptur | `chef_export_menu` renderuje tylko kartę menu. `ChefService.getRecipesByProject()` istnieje, ale **żaden tool go nie woła** (w chef-tools.ts używany jest tylko `getRecipe` pojedynczo, linia 417). |
| L6 | Brak zapisu przyrostowego | `fs_write_file` (terminal-tools.ts) = `fs.writeFile` pełny overwrite, scoped do sandboxa; terminal-tools nie są zaimportowane przez żadnego agenta (grep w agents/ i services/ = 0). |
| L7 | Martwy embedding notatek chefa | `chef-service.ts:4`: `const embeddingService: any = null; // mocked` → semantyczne `searchNotes` zawsze spada do regexa, `addNote` nigdy nie zapisuje embeddingu. Gotowy `lib/embedder.ts` (używa go failure-brain) czeka na podpięcie. |
| L8 | Rozjazd prompt/narzędzia researchera | Prompt `shared/subagent-researcher.md` wymienia `workspace_view`, `coding_create_artifact` w Allowed Tools - agent ich **nie ma** (tools = tavily + skills + playwright + firecrawl). Drobne, ale model będzie halucynował wywołania. |
| L9 | Firecrawl warunkowy | `mcp.ts`: serwer firecrawl montowany tylko gdy `FIRECRAWL_API_KEY` w env. Do potwierdzenia w Twoim `.env` - bez klucza researcher ma tylko Playwright do deep-readu. |

### 1.3 Werdykt ws. researchera (Twoje pytanie)
**Tak, researcher (PSEV) jest właściwym wehikułem researchu i jest obiektywnie lepszy od tego, co ma chef/meta:** czyta pełne strony (Playwright accessible-tree, Firecrawl → markdown), triangulu​je źródła (3+ = high confidence), zwraca ustrukturyzowany JSON `findings[{claim, sources[], verificationLevel}]`. Model: `gemini-3.1-flash-lite-preview` (tani, szybki - OK do reconu). Jedyny problem to L3 (niedelegowalny) i L8/L9 - wszystkie tanie w naprawie.

---

## 2. Architektura docelowa

```
                                 ┌──────────────────────────────┐
 Patryk ──(rozmowa LUB URL)──▶   │   META (Jarvis) - router      │
                                 └──────┬───────────────┬───────┘
                                        │ delegate_task │ delegate_task (parallel, async)
                                        ▼               ▼
                              ┌──────────────┐   ┌────────────────────┐
                              │  chefAgent   │   │ researcherAgent     │
                              │ (NOWY,domain)│◀──│ (PSEV)              │
                              │ prompt:      │ ad│ Misja A: menu recon │
                              │ chef/domain  │hoc│ Misja B: reputation │
                              │ + pipeline   │──▶│ (Tavily adv/extract │
                              └──┬───┬───┬───┘   │  Playwright,Firecr.)│
                                 │   │   │       └────────────────────┘
              chef_* (16 tooli)──┘   │   └── run_worker(reasoning) xN
              + chef_document_*      │        (receptury równolegle,
              + reviews_google_place │         critic gate)
                                     ▼
                              NotebookLM (chef_* x9)  - grounding kulinarny
                                     │
                                     ▼
                    /projekty/splot-projects/menu-books/<slug>/menu-book.md
                    (sekcje dopisywane przyrostowo, render → PDF)
```

### 2.1 Nowy `chefAgent` (plik: `src/mastra/agents/chef-agent.ts`)
- **Instructions** = `combinePrompts('chef/domain', 'chef/pipeline')` - wreszcie używamy sieroty L2; nowy `prompts/chef/pipeline.md` (sekcja 5.8) opisuje maszynę stanów, briefy workerów i zasady dokumentu.
- **Tools**: wszystkie 16 chef_* (przeniesione z mety), nowe `chef_document_*`, `chef_export_menu_book`, `reviews_google_place`, `knowledgeQueryTool`/`knowledgeQueryMultiTool` (weryfikacja proporcji klasyków - zasada "ZAKAZ HALUCYNACJI PROPORCJI" z domain.md), `runWorkerTool`, `delegateTaskTool` (do ad-hoc dopytań researchera w trakcie), `requestApprovalTool`, `currentTimeTool`, memory (`memoryRecall/Write`), `chefAddNote/SearchNotes`.
- **Model**: nowy klucz `chefAgent` w `model-manifest.ts`. Rekomendacja: **mocny model cloud dla kompozycji** - to jedyna domena, gdzie jakość kreatywna JEST produktem (meta/knowledge jadą na flash-lite, co wystarcza do tool-callingu, ale nie do pisania menu fine dining). Punkt decyzyjny D-M1 w sekcji 8; bezpieczny start: ten sam flash co meta + kompozycje delegowane do `run_worker(powerful)`, pomiar scorerem w Etapie 3, potem ewentualny upgrade.
- **Memory**: jak marketing/sales (Memory z lastMessages ~20); wątek per projekt (threadId = projectId) - ciągłość iteracji menu.
- **Rejestracje** (checklista, każda to znany punkt awarii w tym repo): `index.ts` agents{}, `delegate-task.ts` AGENT_IDS + opis w description, tabela agentów w `prompts/meta/base.md`, `config/agent-ids.ts`, wpis w `model-manifest.ts`, scorer placeholder.
- **Meta po zmianie**: traci 16 chef tooli (odchudzenie kontekstu), zachowuje wiersz w tabeli delegacji: `chefAgent → menu engineering, księgi menu, receptury, audyty menu restauracji (chef tools + research + dokument)`. UWAGA breaking-change: jeśli masz zapisane konwersacje/lekcje mety odwołujące się do chef_* - po prostu przestaną być wołane przez metę; failure-brain TTL 90 dni sam to wyczyści.

### 2.2 Warstwa wyszukiwania - 3 poziomy (fix "strzępków")
| Poziom | Co | Kiedy używane | Koszt zmiany |
|---|---|---|---|
| W1 | Upgrade `tavily.ts`: parametr `searchDepth` ('basic'\|'advanced'), opcja `includeRawContent:'markdown'`, **nowy `tavilyExtractTool`** (urls≤20, `extract_depth:'advanced'` dla stron z tabelami/menu, `query`+`chunks_per_source` do rerankingu). Alternatywa: adopcja oficjalnego `@mastra/tavily` (`createTavilySearchTool`/`createTavilyExtractTool`) zamiast ręcznego kodu - mniej utrzymania. | Wszyscy agenci; researcher dostaje extract jako szybszą ścieżkę niż browser | ~1-2 h |
| W2 | Researcher delegowalny (fix L3) + fix L8 (prompt vs tools) + Misje A/B (briefy w 5.3) | Recon restauracji, dopytki ad-hoc | ~1 h |
| W3 | `FIRECRAWL_API_KEY` w .env (fix L9) - aktywuje scrape/crawl→markdown w researcherze; najlepsza ścieżka dla menu w HTML i JS-heavy | Deep-read stron menu | 5 min + klucz |

Heurystyka wyboru w briefie researchera: extract (W1) najpierw → jeśli pusto/JS-heavy → Firecrawl scrape → jeśli nadal nic → Playwright navigate+snapshot. Menu w PDF: Tavily extract advanced i Firecrawl radzą sobie z częścią PDF-ów; fallback `browser_pdf`/pobranie i raport `menuSource.format:'pdf'`. Menu wyłącznie jako zdjęcie/Instagram → poza zakresem v1, researcher raportuje `format:'image'` + `gaps[]`, chef dopyta użytkownika (uczciwa degradacja zamiast halucynacji).

### 2.3 Pipeline - maszyna stanów projektu
Rozszerzamy `ChefProjectStatus` (dziś: questionnaire/review/generating/...):

```
intake ─▶ recon ─▶ profile_synthesis ─▶ checkpoint_profile ─▶ menu_draft
                                                                  │
   done ◀─ render ◀─ qa_final ◀─ recipes ◀─ checkpoint_menu ◀─ critic_gate
```

| Faza | Kto | Co robi | Zapis do dokumentu (sekcja) |
|---|---|---|---|
| **intake** | meta → chefAgent | Wejście A (rozmowa): chef zakłada projekt, ankieta 2-3 pytania/turę (istniejący silnik missingFields). Wejście B (URL): chef zakłada projekt szkieletowy, meta RÓWNOLEGLE odpala Misję A i B do researchera (async delegation - wynik wraca przez pending updates). | `chef_document_init` → szkielet z kotwicami |
| **recon** | researcherAgent x2 (parallel) | Misja A: aktualne menu (struktura, ceny, techniki, **difficultyScore 1-5**). Misja B: opinie Google (Places 5 + PSEV po TripAdvisor/blogach/prasie lokalnej) → strengths/weaknesses/quotableInsights z cytatami i źródłami. | sekcja `research-brief` |
| **profile_synthesis** | chefAgent (+ run_worker fast do mapowania) | CurrentMenuAnalysis+ReputationRecon → ChefProfile (mapper deterministyczny + LLM na luki): cuisineTypes z menu, priceRange.tier z avg ceny dania głównego (progi PLN konfigurowalne), establishmentType heurystyką, signatureDishes z pozytywnych wzmianek, **NOWE pola profilu: `difficultyTarget` (parytet ±1 vs obecne) i `currentMenuRef`**. Braki → pytania do użytkownika (silnik ankiety). | sekcja `concept` (draft) |
| **checkpoint_profile** | requestApproval | Patrykowi/klientowi: profil + wnioski z reconu + 2-3 pytania uzupełniające. Tu zbiegają się oba wejścia. | - |
| **menu_draft** | chefAgent | `chef_generate_menu` (NLM grounding) → kompozycja wg domain.md (progresje, tekstury, parytet trudności "podobny poziom, ale ciekawsze i bardziej lokalne") → `save_menu`. | sekcja `menu-card` |
| **critic_gate** | run_worker(reasoning) | Walidacja menu vs profil: min 3 tekstury/danie, max 2 te same techniki, ścieżki dietetyczne równoległe, spójność cen z tierem, difficultyTarget, czy adresuje weaknesses z opinii. Werdykt pass/fix-list. Max 2 iteracje, potem eskalacja do checkpointu. | - |
| **checkpoint_menu** | requestApproval | Akceptacja karty menu / feedback → `chef_iterate_menu`. | aktualizacja `menu-card` |
| **recipes** | run_worker(reasoning) xN RÓWNOLEGLE | Per danie: brief ze ścisłą schemą `chef_draft_recipe` (komponenty, gramatury metryczne, mise en place, service steps). ChefAgent weryfikuje każdy draft vs zasady domain.md i klasykę (knowledge.query chef_classic przy sosach-matkach itp.), poprawia, zapisuje `chef_draft_recipe`, **od razu dopisuje kartę do dokumentu** (`chef_document_write_section` recipe:<slug>). Batche po 4-6 workerów/turę. | sekcje `recipe:<slug>` (N sztuk) |
| **qa_final** | chefAgent + run_worker(fast) | Kompletność: każde danie ma recepturę (`getRecipesByProject` vs menu) - to domyka L5; macierz alergenów spójna karta↔receptury; lint jednostek (regex na "szklank/łyżk/szczypt", dozwolone q.s.); `chef_document_status` = wszystkie sekcje wypełnione. | sekcje `allergen-matrix`, `insights` |
| **render** | chefAgent | `chef_document_render` → finalny .md (+ opcjonalnie PDF, Etap 3) + `chef_export_menu_book` jako kompilacja kontrolna z Mongo (źródło prawdy = baza; dokument = artefakt). Raport do mety → Patryk. | sekcja `appendix`, frontmatter `status: final` |

---

## 3. Mapowanie zadań → subagenci i workerzy (kto do czego)

| Zadanie | Wykonawca | Dlaczego ten, a nie inny |
|---|---|---|
| Recon menu ze strony (URL) | **researcherAgent** (Misja A) | Jedyny z Playwright+Firecrawl; PSEV wymusza źródła zamiast zgadywania |
| Recon opinii/reputacji | **researcherAgent** (Misja B) + tool `reviews_google_place` | Triangulacja Google+TripAdvisor+blogi; structured findings z cytatami |
| Dopytka faktograficzna w trakcie (np. "co to za technika w ich menu", ceny składnika lokalnie) | researcherAgent przez `delegate_task` z chefAgenta | Mały, szybki PSEV; chef nie scrapuje sam |
| Grounding kulinarny, weryfikacja proporcji klasyków | **knowledge tools / NLM** (chef_master, chef_classic, chef_flavor...) | Już zintegrowane w generate_menu + jawna zasada anty-halucynacyjna z domain.md |
| Kompozycja karty menu | **chefAgent osobiście** | Kreatywny rdzeń wymagający pełnego kontekstu profil+recon+NLM; nie fragmentować |
| Critic gate (walidacja menu) | run_worker(**reasoning**) | Tani, świeże oczy bez kontekstowego biasu autora; wzorzec draft→critique z promptu mety |
| Autorstwo receptur (per danie) | run_worker(**reasoning**) RÓWNOLEGLE, weryfikacja: chefAgent | 12 dań w 2-3 turach zamiast 12; kontekst chefa nie puchnie; chef = redaktor naczelny, nie maszynistka |
| Mapowanie recon→profil, macierz alergenów, linty | run_worker(**fast**) | Ekstrakcja/reformat, nie kreacja |
| Decyzja koncepcyjna wysokiego ryzyka (np. pełny rebranding menu fine dining dla płacącego klienta) | **deliberationAgent** (opcjonalna brama przed menu_draft) | Zgodnie z regułami routingu deliberacji w meta/base.md - tylko gdy stawka wysoka |
| Bramki ludzkie | requestApproval (istnieje) | Wysyłka czegokolwiek do klienta i finalizacja zawsze przez Patryka |
| Implementacja TEGO planu | codingAgent (subagenci file-editor/terminal/qa) przez Nocną Zmianę | To zadanie deweloperskie, nie runtime'owe |

Anty-wzorce (zapisać w prompts/chef/pipeline.md): chef NIE używa Playwrighta/Tavily bezpośrednio (deleguje); meta NIE komponuje menu (deleguje do chefa); workerzy NIE zapisują do Mongo ani do dokumentu (tylko chef przez swoje toole - pojedynczy punkt zapisu = spójność).

---

## 4. Specyfikacje nowych narzędzi

### 4.1 `tools/search/tavily.ts` - upgrade (W1)
```ts
// searchWebTool: + searchDepth: z.enum(['basic','advanced']).default('basic'),
//                + includeRawContent: z.enum(['none','markdown']).default('none')
// NOWY tavilyExtractTool:
inputSchema: z.object({
  urls: z.array(z.string().url()).min(1).max(20),
  extractDepth: z.enum(['basic','advanced']).default('advanced'), // advanced = tabele/embedded (menu!)
  query: z.string().optional(),            // rerank chunków pod intencję
  chunksPerSource: z.number().int().min(1).max(5).optional(),
})
// output: { results: [{url, rawContent}], failed: [{url, error}] }
```
Decyzja D-T1: ręczny kod jw. vs `@mastra/tavily` (oficjalne `createTavilySearchTool/createTavilyExtractTool`). Rekomendacja: pakiet oficjalny, chyba że audyt wykaże konflikt wersji peer-deps z Twoim pinem @mastra/core - wtedy ręczny (30 min różnicy).

### 4.2 `tools/research/reviews-google-place.ts` - NOWY
```ts
id: 'reviews_google_place'
input: { name: string, city: string, countryHint?: 'PL'|'IS'|string }
// Places API (New): Text Search → place_id → Place Details
// fields: displayName, rating, userRatingCount, priceLevel, types,
//         formattedAddress, reviews (MAX 5 - limit API, bez paginacji), googleMapsUri
output: { found, place:{...}, reviews:[{rating,text,relativeTime,author}], limitNote:'official_5' }
```
Env: `GOOGLE_MAPS_API_KEY` (osobny od OAuth Gmaila!). Koszt: Place Details ~groszowe per projekt. Rozszerzenie Etap 3 (flagowane `OUTSCRAPER_API_KEY`): `reviewsLimit:30, sort:'lowest_rating'|'newest'` - sort po najniższych ocenach to najszybsza kopalnia "słabych stron".

### 4.3 Briefy misji researchera (pliki: `prompts/research/menu-recon.md`, `prompts/research/reputation-recon.md`)
Misja A - kontrakt wyjścia (JSON):
```json
{ "restaurant": {"name","url"},
  "menuSource": {"url","format":"html|pdf|image|unknown"},
  "sections": [{"name","dishes":[{"name","description","price","inferredTechniques":[],"inferredAllergens":[]}]}],
  "pricing": {"currency","minMain","maxMain","avgMain"},
  "styleNotes": "ingredient-led / opisowy / poetycki ...",
  "difficulty": {"score":1-5,"signals":["sous-vide","fermentacje","liczba komponentów/talerz"]},
  "language":"pl|en|...", "confidence":"high|medium|low", "gaps":[] }
```
Misja B - kontrakt wyjścia:
```json
{ "place": {"name","address","rating","reviewCount"},
  "strengths": [{"theme","evidence":[{"quote","source","date?"}]}],
  "weaknesses": [{"theme","evidence":[...]}],
  "menuMentions": [{"dish","sentiment","quote","source"}],
  "quotableInsights": ["max 6 ciekawostek z cytatem+źródłem - paliwo do sekcji insights"],
  "sources": [], "confidence":"..." }
```
Reguła w briefie: każdy claim z URL źródła (PSEV i tak to wymusza); Google Maps czytaj WYŁĄCZNIE przez tool reviews_google_place, nie browserem (TOS + kruchość); TripAdvisor/blogi/prasa - extract/Firecrawl/Playwright wolno.

### 4.4 `chef_import_website_profile` - synteza recon→profil (w chef-tools.ts)
```ts
input: { projectId, currentMenuAnalysis: CurrentMenuAnalysisSchema, reputation?: ReputationSchema }
// deterministyczny mapper: avgMain→priceRange.tier (progi PLN w env/konfigu),
// cuisineTypes z dishes (LLM-assist przez run_worker fast po stronie agenta, tool tylko zapisuje),
// + zapis difficultyTarget, currentMenuRef do profilu (rozszerzyć interfejs ChefProfile + zod w update_profile)
// → wewnętrznie ChefService.updateProfile (deepMerge) → zwraca missingFields jak update_profile
```

### 4.5 `tools/chef/chef-document-tools.ts` - rdzeń wymagania "dopisywanie zamiast jednego generowania" (NOWY)
Katalog: `CHEF_DOCS_DIR` (env, default `/projekty/splot-projects/menu-books`), plik `<slug>/menu-book.md`. Path-traversal guard jak w fs_write_file. Kotwice: `<!-- mb:<sectionId>:start -->` ... `<!-- mb:<sectionId>:end -->`.

```ts
chef_document_init(projectId, restaurantName)
  // tworzy plik: frontmatter (projekt, wersja, status:draft, data) + WSZYSTKIE kotwice sekcji
  // (puste sekcje z placeholderem "_w przygotowaniu_") wg szablonu z sekcji 5. Idempotentne.

chef_document_write_section(projectId, sectionId, markdown, mode:'replace'|'append')
  // zapis MIĘDZY kotwicami wskazanej sekcji; replace = iteracje, append = np. kolejna karta receptury
  // sectionId: 'title'|'research-brief'|'concept'|'menu-card'|'recipe:<dish-slug>'
  //          |'allergen-matrix'|'insights'|'appendix'
  // dla recipe:* - kotwica tworzona dynamicznie przy pierwszym zapisie (kolejność alfabetyczna w bloku receptur)

chef_document_status(projectId)
  // parsuje kotwice → { sections:[{id, filled:boolean, words}], missing:[], path }
  // chef wie co dopisać po crashu/wznowieniu - dokument jest wznawialny z definicji

chef_document_render(projectId, format:'md'|'pdf')
  // md: czyści placeholdery, bump frontmatter status:final, zwraca ścieżkę
  // pdf (Etap 3): md-to-pdf (puppeteer już w stacku przez Playwright) lub pandoc - decyzja D-R1
```
Dlaczego kotwice, a nie goły append: re-run fazy nadpisuje SWOJĄ sekcję chirurgicznie; iteracja menu po feedbacku nie psuje gotowych receptur; status liczony z pliku = zero dodatkowego stanu (plik jest źródłem prawdy artefaktu, Mongo źródłem prawdy danych).

### 4.6 `chef_export_menu_book` - kompilacja kontrolna (w chef-tools.ts)
`getMenu + getRecipesByProject` (domyka L5) → pełny render księgi z Mongo. Rola: weryfikacja zgodności dokument↔baza w qa_final + fallback, gdyby plik zaginął. ~1-2 h, czysty dodatek.

### 4.7 Fixy jednolinijkowe
- `chef-service.ts:4`: podpiąć `lib/embedder.ts` (generateEmbedding/cosineSimilarity) zamiast `null` (L7).
- `delegate-task.ts`: `researcherAgent: 'researcherAgent'` w AGENT_IDS + wiersz w description + wiersz w tabeli `prompts/meta/base.md` (L3).
- `prompts/shared/subagent-researcher.md`: usunąć z Allowed Tools narzędzia, których agent nie ma; dopisać firecrawl_scrape/tavily_extract (L8).
- `.env`: `FIRECRAWL_API_KEY`, `GOOGLE_MAPS_API_KEY` (+ wpisy w .env.example) (L9).
- Stale comment w producer-hunt.ts o "braku integracji Tavily/NLM" - skasować przy okazji.

### 4.8 `prompts/chef/pipeline.md` - NOWY (doklejany do domain.md)
Zawartość: maszyna stanów z sekcji 2.3, mapowanie z sekcji 3, anty-wzorce, szablony briefów workerów (krytyk, receptura - format GOAL/CONTEXT/INPUT/OUTPUT FORMAT/CONSTRAINTS zgodny z konwencją mety), zasada "po każdej ukończonej fazie NAJPIERW chef_document_write_section, POTEM raport" oraz reguła języka dokumentu (PL default, EN na życzenie).

Szablon briefu receptury (do wklejenia w pipeline.md):
```
GOAL: Kompletna karta technologiczna dania "<nazwa>" zgodna ze schemą chef_draft_recipe.
CONTEXT: <profil skrócony: kuchnia, tier, staffLevel, kitchenCapability> + <opis dania z karty menu>
  + <wyciąg NLM dla techniki bazowej, jeśli klasyk>.
INPUT: dish JSON z menu (name, description, ingredients[], techniques[]).
OUTPUT FORMAT: czysty JSON: { yield:{amount:4,unit:"porcji"}, components:[{componentName,
  ingredients:[{name,quantity,unit,notes?}], miseEnPlace:[{order,instruction,temperature?,time?}]}],
  serviceSteps:[...], allergens:[], equipmentNeeded:[] }. Nic poza JSON.
CONSTRAINTS: wyłącznie miary metryczne (g/ml/szt), zakaz "szklanka/szczypta" (dozwolone q.s.),
  komponenty rozdzielone (protein/purée/sos/garnish), żargon profesjonalny,
  realne temperatury i czasy, max 8 składników/komponent.
```

---

## 5. Format dokumentu "Księga Menu" (spec artefaktu dla szefa kuchni)

Kolejność sekcji = kolejność kotwic z init. Wszystko Markdown, tabele dla danych, miary metryczne, styl opisów dań wg reguł domain.md (bistro: ingredient-led 5-10 słów; fine dining: powściągliwość albo pełna narracja - nigdy środek).

1. **title** - nazwa restauracji, "Propozycja menu - <sezon> <rok>", wersja, data, "Przygotowano: AgentForge Chef".
2. **research-brief** (1 strona max) - co znaleźliśmy: obecne menu (liczba pozycji, widełki cen, styl, difficulty 1-5 z sygnałami), reputacja (rating, liczba opinii, top-3 mocne, top-3 słabe - każde z 1 cytatem i źródłem). Ton: rzeczowy, bez oceniania personelu.
3. **concept** - narracja nowego menu: czym się różni, dlaczego pasuje do lokalizacji/typu/sezonu, jak utrzymuje parytet trudności wykonawczej (te same stacje/skille, ciekawsze efekty), które słabości z opinii adresuje wprost.
4. **menu-card** - karta: sekcje → dania (nazwa, opis w stylu docelowym, sugerowana cena PLN obok widełek z ich obecnego menu, tagi dietetyczne, alergeny ikonowo). Ścieżki równoległe (vege/GF) jawnie, nie "na życzenie".
5. **recipe:<slug>** xN - karta technologiczna per danie:
   - nagłówek: danie, yield, czas mise/serwis, stacja, sprzęt
   - per komponent: tabela BOM `| Składnik | Ilość | Jedn. | Uwagi |` + kroki mise en place (numerowane, z temp./czasem)
   - SERWIS (wydawka): kroki montażu na talerzu
   - alergeny, plating (1-2 zdania), pairing wino + bezalkoholowy
6. **allergen-matrix** - tabela dania×alergeny (UE 14), spójna z recepturami (qa_final to wymusza).
7. **insights** - "Ciekawostki z opinii": 4-6 pozycji łączących cytat gościa → decyzję w menu ("Goście chwalą X → wzmacniamy przez...; narzekają na Y → danie Z rozwiązuje to przez..."). Każda z linkiem źródłowym. To sekcja sprzedażowa - pokazuje, że menu nie wzięło się z powietrza.
8. **appendix** - sezonowość użytych składników (z chef_check_seasonal), sugestia rotacji (kotwice vs rotacja kwartalna 30-40%), pełna lista źródeł reconu, metryka wersji menu w Mongo (projectId/menuId/wersja).

---

## 6. Etapy wdrożenia (zlecać codingAgentowi w tej kolejności)

| Etap | Zakres | Szac. | Done when (GoalContract) |
|---|---|---|---|
| **E0 - odblokowanie** ✅ **DONE + ZWERYFIKOWANY (2026-06-11)** | 4.1 (Tavily adv+extract), 4.7 (researcher delegowalny, embedder fix, prompt fix, env), decyzja D-T1 | ~0.5 dnia | `npm run build` zielony; e2e: `tavily_extract` (advanced) na realnej stronie menu z Wrocławia (restauracjabellastoria.pl/menu) zwrócił **13 427 znaków** raw_content, status 200, 0 failed. **GoalContract spełniony.** Szczegóły w sekcji 9. |
| **E1 - chefAgent + dokument** ✅ **DONE + ZWERYFIKOWANY (2026-06-11)** | 2.1 (agent + rejestracje x6), 4.5 (chef_document_*), 4.6 (export_menu_book), 4.2 (reviews tool), 4.8 (pipeline.md) | ~1.5-2 dni | `npm run build` zielony; chef_document_init+write_section+status zweryfikowane e2e (zapis 3 sekcji → status **3/8**, plik w CHEF_DOCS_DIR, idempotentny re-write nie duplikuje kotwicy); `reviews_google_place` live na Places API (New) zwrócił rating **4.2 / 2334 opinii / 5 recenzji** (Pod Fredrą Wrocław) + degraduje gracefully bez klucza; chefAgent zarejestrowany w 4 punktach + meta straciło 16 chef-tooli (→ delegacja). Szczegóły w sekcji 9. |
| **E2 - pipeline właściwy** ✅ **DONE + ZWERYFIKOWANY (2026-06-11)** | 4.3 (misje A/B), 4.4 (import profilu + rozszerzenie ChefProfile), critic gate, równoległe receptury, checkpointy, statusy projektu | ~2-3 dni | `npm run build` zielony; mapper recon→profil live na Mongo (avgMain→tier `premium`, difficultyTarget, currentMenuRef snapshot, cuisineTypes, signatureDishes — wszystko zapisane do profilu w bazie); 11 statusów pipeline przechodzi i `done` persystuje; **przyrostowość udowodniona: 9 osobnych zapisów sekcji** (2 kanoniczne + 6 dynamicznych `recipe:<slug>` w trybie append + 1 re-append), 0 duplikacji kotwic, append akumuluje; pipeline.md = pełna maszyna 11 stanów z briefami krytyka i receptury + dwa checkpointy `request_approval`. Pełny agent-driven E2E (LLM → researcher → chef → menu-book.md) = runtime, do odpalenia na żywym agencie. Szczegóły w sekcji 9. |
| **E3 - polish** ✅ **DONE + ZWERYFIKOWANY (2026-06-12)** | PDF render (D-R1), chef-agent-scorer (rubryka: schema validity, progresja, min-3-tekstury, max-2-techniki, ścieżki diet, parytet trudności), lekcje do failure-brain, opcjonalny Outscraper, próg kosztów w budget-trackerze dla recon | ~1 dzień | `npm run build` zielony; `scoreChefMenu` liczy wynik dla menu w kształcie E2 (dobre menu → 1.00/pass, zdegenerowane → 0.20/fail z diagnostyką per-wymiar); `chef_document_pdf` renderuje Księgę przez headless Chrome (micromark+GFM) → poprawne obramowane tabele BOM (zweryfikowane `pdftotext`); 7 lekcji w failure-brain (recall semantyczny działa, top 0.725); próg kosztów recon w budget-trackerze (tavily/places/firecrawl + guard w `reviews_google_place`). **Outscraper świadomie pominięty (opcjonalny, R3).** Szczegóły w sekcji 9. |

Razem: ~5-6.5 dnia czystej roboty. Każdy etap = osobny ticket Nocnej Zmiany (deliberation → coding worktree → review → blue-green dry-run).

---

## 7. Ryzyka i punkty decyzyjne

| ID | Ryzyko/decyzja | Rekomendacja |
|---|---|---|
| D-M1 | Model chefAgenta: flash (tani, słabsza kompozycja) vs mocny cloud (jakość = produkt) | Start: flash + kompozycje przez run_worker(powerful); po E3 zmierzyć scorerem na 3 menu i dopiero wtedy decydować o upgrade. Nie zgaduj - zmierz. |
| D-T1 | `@mastra/tavily` vs ręczny kod | Pakiet, jeśli peer-deps czyste; inaczej ręczny (wzorzec już masz). |
| D-R1 | PDF: md-to-pdf vs pandoc | md-to-pdf (Chromium już jest przez Playwright); pandoc tylko jeśli chcesz LaTeX-jakość typografii. |
| R1 | Menu jako zdjęcie/Instagram-only (częste w PL gastro) | v1: uczciwa degradacja - researcher raportuje gap, chef dopytuje użytkownika o pozycje. v2 (backlog): OCR/vision. |
| R2 | Menu w PDF | extract advanced + Firecrawl łykają część; fallback browser_pdf; testować w E2 na realnych stronach. |
| R3 | Tylko 5 opinii oficjalnie | Dla pitchu wystarcza (5 "most relevant" + PSEV po TripAdvisor/blogach). Outscraper z sort lowest_rating dopiero, gdy robisz to seryjnie pod GastroBridge. Scraping Maps browserem: NIE (TOS, kruchość). |
| R4 | Koszt/projekt | Rząd wielkości: Tavily 15-25 kredytów, Places grosze, Firecrawl wg planu, LLM zależnie od D-M1. Wpiąć w budget-tracker, alert >X PLN/projekt. |
| R5 | Halucynacja proporcji w recepturach | Już zaadresowane: reguła domain.md + obowiązkowy knowledge.query(chef_classic) dla klasyków + critic gate + weryfikacja chefa przed zapisem. |
| R6 | Kontekst chefa przy 12+ daniach | Receptury w workerach (sekcja 3) + zapis sekcji od razu po każdej (dokument jako pamięć zewnętrzna) + ewentualnie async delegation dla całej fazy recipes. |

---

## 8. Pierwsze zlecenie dla Nocnej Zmiany (copy-paste do mety)

```
Ticket E0 z planu chef-agent-dev-plan.md (w repo: docs/plans/).
Pełna pętla: deliberationAgent weryfikuje plan E0 → codingAgent implementuje
w worktree (subagenci: file-editor pisze, terminal buduje, qa testuje) →
code-review gate → blue-green --dry-run. Zakres WYŁĄCZNIE E0:
(1) tavily.ts: searchDepth+includeRawContent+tavilyExtractTool [decyzja D-T1:
najpierw sprawdź zgodność @mastra/tavily z naszym @mastra/core, raportuj wybór],
(2) researcherAgent do AGENT_IDS w delegate-task + tabela w meta/base.md,
(3) chef-service.ts: podpiąć lib/embedder.ts zamiast null,
(4) subagent-researcher.md: wyrównać Allowed Tools do realnych narzędzi,
(5) .env.example: FIRECRAWL_API_KEY, GOOGLE_MAPS_API_KEY.
GoalContract: build zielony; delegate_task(researcherAgent, "pobierz pełną
treść https://<restauracja-wroclaw>/menu i wypisz sekcje menu") zwraca
realne sekcje; testy E0 z planu przechodzą. Swap po mojej akceptacji rano.
```

---

*Plan oparty o audyt kodu (ścieżki i linie w sekcji 1) + weryfikację web: Tavily docs (/extract, include_raw_content, @mastra/tavily), limit 5 opinii Places API (potwierdzony 2026). Inferencje oznaczone jako decyzje D-* lub rekomendacje - reszta to fakty z repo.*

---

## 9. Log wdrożenia

### E0 - odblokowanie — ✅ DONE (2026-06-11, Claude/Opus przez Claude Code)

**Decyzja D-T1: kod ręczny (NIE `@mastra/tavily`).** Powód: pakiet nie był zainstalowany, `@mastra/core` na `^1.31.0` (build podbił do 1.32.1); dodanie zależności = instalacja sieciowa + ryzyko peer-deps + powierzchnia supply-chain. Istniejący `tavily.ts` to czysta ręczna integracja — rozszerzono ją zgodnie z istniejącym wzorcem.

**Zmiany w kodzie:**
1. `tools/search/tavily.ts` — `tavilySearch()` przyjmuje `{ searchDepth, includeRawContent }`, mapuje `raw_content`; `searchWebTool` ma nowe pola wejścia `searchDepth ('basic'|'advanced')` + `includeRawContent ('none'|'markdown')` i opcjonalny `rawContent` na wyjściu; **nowy `tavilyExtractTool` (id `tavily_extract`)** — `/extract`, urls 1-20, `extractDepth` (default `advanced`), output `{ results:[{url,rawContent}], failed:[{url,error}] }`.
2. `tools/system/delegate-task.ts` — `researcherAgent` dodany do `AGENT_IDS`, do enuma `targetAgent` oraz do opisu narzędzia. Routing: ścieżka „All other agents: direct generate" (działa bez harnessu).
3. `prompts/meta/base.md` — wiersz `researcherAgent` w tabeli delegacji + akapit routingu (researcher = żywy web vs knowledgeAgent = NotebookLM).
4. `tools/chef/chef-service.ts` — usunięto `embeddingService = null`; podpięto adapter nad `lib/embedder` (`generate()`/`cosineSimilarity`). Semantyczne `searchNotes`/`addNote` działają; przy błędzie embeddera istniejący try/catch degraduje do regexa.
5. `prompts/shared/subagent-researcher.md` — Allowed Tools wyrównane do realnych narzędzi (usunięto nieistniejące `workspace_view`/`coding_*`; dodano `tavily_extract`, `firecrawl_scrape/crawl`, `skill_search/load`); dopisana kolejność deep-readu: extract → firecrawl → Playwright.
6. `agents/researcher-agent.ts` — `tavilyExtractTool` wpięty jako szybka ścieżka deep-readu.
7. `.env.example` — dodane `FIRECRAWL_API_KEY` i `GOOGLE_MAPS_API_KEY` (oba opisane jako OPCJONALNE z opisem degradacji).

**Weryfikacja:**
- `npm run build` (mastra build) — ✅ zielony.
- Live e2e `tavily_extract` (advanced) na realnej stronie z Wrocławia (`restauracjabellastoria.pl/menu`) — ✅ status 200, **13 427 znaków** raw_content (próg >2000 spełniony z zapasem), 0 `failed_results`, w treści realne menu + karta alergenów. Tavily `/search` również 200 (zwraca prawdziwe URL-e restauracji). **GoalContract E0 spełniony.**
- (Uwaga procesowa: pierwszy przebieg testu fałszywie pokazał 401 — był to błąd harnessu testowego, zmienne env podane PO `node -e` trafiały do argv zamiast do `process.env`. Po poprawce klucz Tavily okazał się w pełni ważny.)

**Walidacja kluczy (wszystkie podpięte i przetestowane live, 2026-06-11):**
- `TAVILY_API_KEY` — ✅ `/search` i `/extract` zwracają 200; extract 13 427 znaków z realnego menu.
- `GOOGLE_MAPS_API_KEY` — ✅ po włączeniu „Places API (New)" w GCP: `places:searchText` zwraca 200 (Bella Storia: rating 4.5, 5249 opinii). Gotowe pod `reviews_google_place` w E1.
- `FIRECRAWL_API_KEY` — ✅ klucz wpięty; `POST /v2/scrape` zwraca 200, 13 278 znaków markdown. `mcp.ts` montuje serwer firecrawl gdy klucz obecny; `researcher-agent.ts` spreaduje jego narzędzia (`firecrawl_scrape/crawl/search/extract/map`) automatycznie przy starcie — researcher ma teraz pełną ścieżkę deep-readu: `tavily_extract → firecrawl_scrape → Playwright`.

**Nie ruszone (poza zakresem E0, świadomie):** rejestracja chefAgenta, chef_document_*, reviews_google_place — to E1.

---

### E1 - chefAgent + dokument — ✅ DONE (2026-06-11, Claude/Opus przez Claude Code)

**Decyzja D-M1: chefAgent na `gemini-3.1-flash-lite-preview`** (ten sam flash co meta/researcher). Lekki, niezawodny tool-calling; ciężkie kompozycje (batch receptury) chefAgent deleguje przez `system_run_worker` (model `powerful`), żywy web/menu recon przez `delegate_task → researcherAgent`. Bezpieczny start zgodnie z planem §6.

**Nowe pliki:**
1. `prompts/chef/pipeline.md` (4.8) — maszyna stanów Księgi Menu: `INTAKE → RECON → PROFILE → MENU → RECIPES → BOOK → REVIEW`. Mapowania wejść (rozmowa vs URL), reguły delegacji (run_worker / researcher / knowledge), szablon brief'u workera, reguły dokumentu (kotwice, idempotencja, jeden plik per projekt), 6 anty-wzorców.
2. `tools/chef/chef-document-tools.ts` (4.5) — `chef_document_init` / `_write_section` / `_status` / `_render`. Sekcje kotwiczone komentarzami HTML (`<!-- section:ANCHOR start/end -->`), idempotentny upsert (`replaceSection`), 8 kanonicznych sekcji (`overview, profile, recon, menu, recipes, pairings, allergens, notes`). Guard na path-traversal (`bookPath`: sanityzacja UUID + `startsWith(CHEF_DOCS_DIR)`). `CHEF_DOCS_DIR` env (default `/projekty/splot-projects/menu-books`), plik `<projectId>.md`.
3. `tools/research/reviews-google-place.ts` (4.2) — `reviews_google_place` na Places API (New) `places:searchText` (nagłówki `X-Goog-Api-Key` + `X-Goog-FieldMask`). Bez `GOOGLE_MAPS_API_KEY` zwraca `{ success:false, degraded:true, hint }` (→ researcherAgent fallback). 403 daje hint o włączeniu API w GCP.
4. `agents/chef-agent.ts` (2.1) — `combinePrompts('chef/domain','chef/pipeline')`, `Memory(lastMessages:20)`. Toolset: 16 chef-tooli + `chefExportMenuTool` + 4 `chef_document_*` + `chef_export_menu_book` + `reviews_google_place` + `knowledge_query/_multi` + `run_worker`/`delegate_task`/`request_approval`/`current_time`/`memory_recall`/`memory_write`/`add_context`.

**Zmiany w plikach:**
5. `tools/chef/chef-tools.ts` (4.6) — **nowy `chefExportMenuBookTool` (id `chef_export_menu_book`)**: pobiera najnowsze menu (lub `menuId`) + `getRecipesByProject`, renderuje body menu i karty technologiczne, wpisuje do sekcji `menu` i `recipes` Księgi przez `replaceSection`. Dodane helpery `renderMenuBody` / `renderRecipeCard`.
6. Rejestracja chefAgenta (4 punkty): `index.ts` (import + mapa `agents`), `config/model-manifest.ts` (`agentModels.chefAgent`), `tools/system/delegate-task.ts` (`AGENT_IDS` + enum `targetAgent` + opis; routing generyczną ścieżką „direct generate", bez harnessu), `prompts/meta/base.md` (wiersz tabeli + akapit routingu).
7. `agents/meta-agent.ts` — **usunięto 16 chef-tooli** z importów i z rejestracji narzędzi. Meta nie trzyma już chef-tooli — cała domena menu należy do chefAgenta (delegacja przez `system_delegate_task`).

**Weryfikacja:**
- `npm run build` (mastra build) — ✅ zielony („Build successful").
- `chef_document_*` e2e (esbuild bundle, Node 22): init tworzy plik + idempotentny (`created:false` przy powtórzeniu); zapis 3 sekcji → `chef_document_status` zwraca **3/8** z poprawną listą `missing`; ponowny zapis `overview` NIE duplikuje kotwicy (1× marker) i podmienia treść (v2). ✅
- `reviews_google_place` live na Places API (New): „Restauracja Pod Fredrą Wrocław" → `success:true`, rating **4.2**, **2334** opinii, `PRICE_LEVEL_EXPENSIVE`, **5 recenzji** (PL). Bez klucza → `degraded:true`. ✅ **GoalContract E1 spełniony.**
- `chef_export_menu_book` — kompiluje się (build green); logika renderu (menu body + karty BOM/service) zweryfikowana statycznie. Pełny e2e na realnych danych menu/receptur z Mongo → E2 (tam jest E2E na prawdziwej restauracji).

**Uwaga (orphan, poza zakresem E1):** `prompts/chef/domain.md` odwołuje się do `system_update_plan`, które nie istnieje jako narzędzie w repo (chefAgent go nie ma). Świadomie nie wpinano nieistniejącego toola; do rozważenia w E2/E3 (albo dodać tool „update_plan", albo zamienić instrukcję na `chef_add_note` + Księgę).

---

### E2 - pipeline właściwy — ✅ DONE (2026-06-11, Claude/Opus przez Claude Code)

**Zakres:** pełna maszyna stanów (11 statusów), synteza recon→profil, rozszerzenie modelu profilu, briefy misji researchera, dynamiczne sekcje receptur w dokumencie + tryb append (rdzeń dowodu przyrostowości).

**Zmiany w modelu danych (`tools/chef/chef-service.ts`):**
1. `CHEF_PIPELINE_STATUSES` — kanoniczna tablica 11 statusów (`intake → recon → profile_synthesis → checkpoint_profile → menu_draft → critic_gate → checkpoint_menu → recipes → qa_final → render → done`) + typ `ChefPipelineStatus`.
2. `ChefProfile` rozszerzony o `difficultyTarget` (`{score?, rationale?}`) i `currentMenuRef` (`{url?, format?, avgMainPrice?, currency?, dishCount?, styleNotes?, difficultyScore?, capturedAt?}`).

**Nowe narzędzia (`tools/chef/chef-tools.ts`):**
3. `chef_import_website_profile` (4.4) — deterministyczny mapper recon→profil: `avgMain → priceRange.tier` (progi PLN z env `CHEF_PRICE_TIER_PLN`, default `35,70,130`: budget/mid/premium/luxury), `difficultyTarget` (parytet ±1 vs obecne menu), `currentMenuRef` (snapshot źródła), `cuisineTypes` (agent-derived), `identity.signatureDishes` (z pozytywnych wzmianek reputacji). Zapis przez `ChefService.updateProfile` (deepMerge) → zwraca `missingFields` jak `chef_update_profile`. Schematy wejścia `CurrentMenuAnalysisSchema` (Misja A) + `ReputationSchema` (Misja B).
4. `chef_set_project_status` (2.3) — `status: z.enum(CHEF_PIPELINE_STATUSES)`, sprawdza istnienie projektu, woła `updateProjectStatus`. Wywoływane przy każdym przejściu fazy → pipeline wznawialny/audytowalny.

**Dokument przyrostowy (`tools/chef/chef-document-tools.ts`):**
5. `chef_document_write_section` — `anchor` zmieniony z `z.enum(CANONICAL_SECTIONS)` na walidowany string (`ANCHOR_PATTERN = /^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/`) → dopuszcza dynamiczne `recipe:<slug>` i sekcje narracyjne planu §5. Dodany `mode: 'replace'|'append'` (default replace); append czyta istniejącą treść przez nowy helper `getSectionBody` i dokleja. Helper `titleFor(anchor)` generuje czytelne tytuły dla kanonicznych, `recipe:<slug>` („Receptura: <slug>") i sekcji planu (title/research-brief/concept/menu-card/allergen-matrix/insights/appendix).

**Prompty:**
6. `prompts/research/menu-recon.md` (4.3, Misja A) — kontrakt JSON menu recon (restaurant/menuSource/sections/pricing/styleNotes/difficulty 1-5/cuisineTypes/confidence/gaps), kolejność deep-readu, ZAKAZY (no Google Maps browserem, no halucynacja cen).
7. `prompts/research/reputation-recon.md` (4.3, Misja B) — kontrakt JSON reputacji (place/strengths/weaknesses/menuMentions/quotableInsights/signatureDishes/confidence), źródła w kolejności (reviews_google_place najpierw), reguła „każdy cytat z URL".
8. `prompts/chef/pipeline.md` przepisany z 7-stanowego szkicu (E1) na **pełną maszynę 11 stanów** z §2.3: statusy per faza, brief krytyka (critic_gate, run_worker reasoning), brief receptury z §4.8 (recipes, batch 4-6/turę), dwa twarde checkpointy (`request_approval` na checkpoint_profile + checkpoint_menu), reguła „NAJPIERW zapis sekcji, POTEM raport", tabela delegacji z §3, 10 anty-wzorców.

**Rejestracja:** `chef_import_website_profile` + `chef_set_project_status` wpięte do `agents/chef-agent.ts` (sekcja „Pipeline (E2)").

**Weryfikacja (live, Node/tsx):**
- `npm run build` (mastra build) — ✅ zielony („Build successful").
- **Dokument przyrostowy** (fs, tmp CHEF_DOCS_DIR): init → szkielet; 2 zapisy kanoniczne + 6 dynamicznych `recipe:<slug>` w trybie append + 1 ponowny append do `recipe:short-rib` = **9 osobnych zapisów sekcji** (>8, dowód przyrostowości); 6 odrębnych kotwic receptur, kotwica short-rib NIE zduplikowana (count=1), append zakumulował oba fragmenty, `titleFor` wyrenderował „Receptura: short rib", status kanoniczny 2/8. ✅
- **Mapper recon→profil** (live Mongo): projekt utworzony → import syntetycznego Misja A/B → `priceRange.tier` = `premium` (avgMain 75, progi 35/70/130 — 70≤75<130), `avgMainPrice` 75, `difficultyTarget.score` 3, `currentMenuRef.dishCount` 3 + format/difficultyScore, `cuisineTypes` i `identity.signatureDishes` zmapowane; **wszystko persystowane w profilu w bazie** (re-read `getProject` potwierdza tier+currentMenuRef). ✅
- **Progi tieru** (boundary): 10 przypadków budget/mid/premium/luxury — wszystkie poprawne (34→budget, 35→mid, 69→mid, 70→premium, 129→premium, 130→luxury). ✅
- **Statusy pipeline** (live Mongo): 10 przejść `recon…done` — wszystkie `success`, `done` persystuje; nieistniejący projekt → `success:false`. ✅

**Świadoma granica:** pełny agent-driven E2E z GoalContractu E2 (żywy URL restauracji → LLM steruje researcherAgentem i chefAgentem → menu-book.md z ≥6 daniami/recepturami) to test runtime'owy wymagający uruchomienia żywego agenta z modelem — zweryfikowano każdy KOMPONENT z osobna live (mapper, statusy, przyrostowy zapis, build), orkiestracja end-to-end do odpalenia na działającym agencie (E3/uruchomienie produkcyjne).

**Env:** `CHEF_PRICE_TIER_PLN` opcjonalny (default `35,70,130`) — nie wymaga wpisu w `.env`; działa z domyślnymi progami.

### E3 - polish — ✅ DONE (2026-06-12, Claude/Opus przez Claude Code)

**Uwaga językowa:** przed E3 cała domena chef została przetłumaczona PL→EN (kod, prompty, opisy narzędzi, `.describe()`, komunikaty błędów, docs/CHEF-AGENT.md) — tylko **treść artefaktu Księgi Menu** (tytuły sekcji, etykiety renderu, placeholdery) zostaje po polsku (deliverable dla polskich restauracji). Build zielony po konwersji.

**Zakres:** PDF render (D-R1), deterministyczny scorer menu, lekcje do failure-brain, próg kosztów recon w budget-trackerze. Outscraper świadomie pominięty (opcjonalny, R3 — dopiero przy seryjnym scrapingu pod GastroBridge).

**Nowe narzędzie (`tools/chef/chef-document-tools.ts`):**
1. `chef_document_pdf` (D-R1) — render Księgi Menu (Markdown) → PDF przez headless Chrome (`CHEF_CHROME_BIN`, default `google-chrome-stable`, `--headless=new --print-to-pdf`). Markdown→HTML przez `micromark` + `micromark-extension-gfm` (tabele GFM → realne obramowane `<table>` — krytyczne dla tabel BOM receptur i macierzy alergenów). Print-CSS A4 (marginesy, `page-break-inside:avoid` na tabelach, fallback fontów dla PL). Strip kotwic sekcji + ostrzeżenia. Temp HTML czyszczony w `finally`. Wynik: `<projectId>.pdf` obok `.md` (lub `outputPath`). `micromark` + `micromark-extension-gfm` dodane jako **bezpośrednie** zależności (były tranzytywne). Rejestracja w `agents/chef-agent.ts`.

**Nowy scorer (`scorers/chef-agent-scorer.ts`):**
2. `scoreChefMenu(menu, profile?)` — czysta, deterministyczna funkcja (bez LLM-judge, reprodukowalna) licząca 6 wymiarów z `domain.md`: `schemaValidity` (kompletność pól dania), `progression` (łuk temperatur/intensywności), `textures` (min. 3 tekstury/danie), `techniques` (max 2 dania tej samej techniki, nigdy pod rząd), `dietaryPaths` (równoległe ścieżki vege/GF), `difficultyParity` (±1 vs `profile.difficultyTarget.score`, pomijany gdy brak targetu — waga redystrybuowana). Próg pass = 0.70. `chefMenuQualityScorer` = cienki wrapper `createScorer` (krok `analyze` jako funkcja deterministyczna, parsuje ChefMenu z run.output). Rejestracja w `index.ts` (`scorers`).

**Failure-brain (`scripts/seed-chef-lessons.mjs`):**
3. 7 lekcji wpisanych do `system_knowledge` przez `writeKnowledge` (idempotentnie, dedup po type+title): inkrementalność dokumentu, status na każdym przejściu, recepty dopiero po checkpoint_menu, brak bezpośredniego scrapingu / single-writer, weryfikacja ratio w `chef_classic`, kontrakt `execute(context)` + `establishmentType`, separator GFM `|---|` dla tabel BOM w PDF. Typy: `prompt_rule` / `failure_case` / `tool_contract`.

**Próg kosztów recon (`services/budget-tracker.ts` + R4):**
4. Zarejestrowane providery recon `tavily` / `places` / `firecrawl` z dziennymi limitami requestów (env `TAVILY_DAILY_LIMIT` / `PLACES_DAILY_LIMIT` / `FIRECRAWL_DAILY_LIMIT`, alert 80%). `reviews_google_place` zguardowane: `isOverBudget('places')` → degraduje do researchera; `recordRequest('places', …)` po każdym wywołaniu API. Wiring Tavily/Firecrawl (narzędzia researchera) = follow-up po stronie researcher-tooli.

**Weryfikacja (live, Node/tsx):**
- `npm run build` (mastra build) — ✅ zielony; `chef_document_pdf` i `chef-menu-quality` obecne w bundlu `.mastra/output`.
- **PDF** (fs): Księga z poprawną tabelą GFM BOM (`| Składnik | Ilość | Jedn. | Uwagi |` + wiersz `|---|`) → PDF `%PDF-1.4`, ~46 KB, `pdftotext -layout` pokazuje wyrównane kolumny tabeli. Tabela bez wiersza separatora GFM renderuje się jako literalny tekst (udokumentowane jako lekcja). ✅
- **Scorer** (pure fn): poprawne menu w kształcie E2 (5 dań, sekcje, tekstury, temperatury, tagi diet, target 3) → **1.00 / pass**, est-difficulty 3; menu zdegenerowane (3× braise pod rząd, brak tekstur/temp/diet) → **0.196 / fail** z diagnostyką per-wymiar. ✅
- **Failure-brain** (live Mongo): 7 lekcji `created`; `recallKnowledge('chef menu book pipeline recipes incremental')` → 4 trafienia, top 0.725 (recall semantyczny działa). ✅
- **Budget recon** (live): `tavily/places/firecrawl` zarejestrowane z limitami 100/200/100; `isOverBudget('places')` false na starcie. ✅

**Done-when:** scorer liczy wynik dla menu z E2 ✅; PDF otwiera się i ma poprawne tabele BOM ✅.

**Env (E3):** `CHEF_CHROME_BIN` (default `google-chrome-stable`), `TAVILY_DAILY_LIMIT` / `PLACES_DAILY_LIMIT` / `FIRECRAWL_DAILY_LIMIT` (opcjonalne, defaulty w kodzie) — dopisane do `.env.example`.

**Świadoma granica:** jak w E2 — pełny agent-driven E2E (żywy URL → LLM → researcher → chef → Księga + PDF) to test runtime'owy na działającym agencie; tu zweryfikowano każdy komponent E3 z osobna.

---

### Post-E3 — poprawki z analizy logów (2026-06-12)

Po dwóch nieudanych żywych przebiegach pipeline'u (jeden przez meta-agenta, jeden bezpośrednio do chefa) analiza logów ujawniła trzy problemy. Wszystkie naprawione, build zielony.

**A1 — chefAgent zatrzymywał się na `profile_synthesis`.**
Root cause: chefAgent jako JEDYNY agent pipeline'owy nie ustawiał budżetu kroków → działał na frameworkowym defaulcie (~5 kroków) i był ucinany po kosztownych delegacjach recon, wymagając ręcznych szturchnięć użytkownika. Każdy inny agent (meta/coding/knowledge/automation/deliberation) ma `maxSteps: 40`.
- Fix: `agents/chef-agent.ts` — dodane `defaultOptions` + 3 warianty legacy z `maxSteps: 40` (mirror reszty).
- Fix: `prompts/chef/pipeline.md` — blok "Continuation contract" (raport = krótka linia statusu w TYM SAMYM turze, nie koniec tury; jedyne miejsca na zakończenie tury to dwa `request_approval`).
- Fix: `prompts/chef/domain.md` — rozszerzona "Autonomous continuation" o stany po-intake (recon→profile→checkpoint→menu→recipes bez pauzy).

**A2 — meta-agent obchodził pipeline chefa.**
Root cause: na "zmodernizuj menu restauracji" meta zdekomponował zadanie na pracę codingAgenta — skrypt `scripts/populate-*.ts` piszący wprost do Mongo + pliku Księgi — który utknął na pending approval, zostawiając projekt jako szkielet.
- Fix: `prompts/meta/base.md` — twarda reguła: zadanie menu/restauracja/Księga-Menu to ZAWSZE jedno `system_delegate_task(chefAgent)`, nigdy zadanie coding/populate-script; tylko chefAgent pisze dane chefa.

**A3 — embedding / observation memory: bge-m3 500 "llama runner process has terminated".**
- Fix kodowy (hardening): `lib/embedder.ts` — globalny semafor (cały proces, `EMBEDDING_CONCURRENCY`, default 2) wokół requestów Ollama + retry z backoffem dla przejściowych crashy runnera/5xx/błędów połączenia (`EMBEDDING_MAX_RETRIES`, default 3). Scentralizowane → SkillRegistry, MemoryExtractor i `saveKnowledge` korzystają bez zmian per-caller.
- **Żywa przyczyna była jednak infrastrukturalna, nie kodowa:** GPU (RTX 5060 Ti / sterownik 580 / CUDA 13) **zawieszone** — 100% util przy ZERO procesów compute i `cudaMalloc … device(s) is/are busy or unavailable`, więc KAŻDE ładowanie modelu Ollama padało (model czatowy też, nie tylko bge-m3). Hardening tylko degraduje łagodnie (retry → save-without-vector); embeddingów nie wyczaruje przy padniętym GPU. Remedium operacyjne (wymaga hasła usera): `sudo systemctl restart ollama`, a jeśli util dalej przypięte — reboot. Po odzysku SkillRegistry re-embeduje na następnym starcie dev, MemoryExtractor wraca do zapisu wektorów.

**Weryfikacja:** `npm run build` ✅ zielony; `EMBEDDING_CONCURRENCY` i reguła meta "NEVER decompose a menu" obecne w bundlu `.mastra/output`; `maxSteps: 40` w bundlu. Burst-test embeddera (20 równoległych) potwierdził, że przy padniętym GPU degraduje kontrolowanie (0/20, każdy po retry+backoff) — kod poprawny, blokada to GPU.

---

### Post-E3 — parytet pamięci chefAgent ↔ codingAgent (2026-06-12)

Po pytaniu o to, czy chef ma pamięć/embedding/observational memory/harness jak coding — audyt i wyrównanie.

**Stan przed:** chefAgent miał tylko `Memory{ lastMessages:20 }`. Brakowało: `observationalMemory`, `generateTitle`, `TokenLimiterProcessor`. Harness: chef idzie przez generyczny direct-`generate` w `delegate-task` (bez jcode-harnessu — coding/automation/knowledge mają własne wrappery nad `generateWithHarness`).

**Dodane (`agents/chef-agent.ts`, mirror codinga):**
- `observationalMemory` (model `gemma4-e4b` = `infrastructure.observationalMemory`, `scope:'thread'`, `temporalMarkers`, `observation.threadTitle`) + `generateTitle:true` — bieżące streszczenie wątku dla długiego pipeline'u (recon→profil→menu→recepty ×10 dań).
- `inputProcessors: [TokenLimiterProcessor(120_000)]` — ochrona kontekstu (model chefa `gemini-3.1-flash-lite-preview`, duże okno, ale degraduje po ~120K).

**Co chef ma już bez zmian (globalnie/domenowo):** embeddingi przez własne narzędzia (`chef_search_notes` RAG po notatkach, `memory_recall` po `system_knowledge`), globalny `MemoryExtractor` (kopalnia zdarzeń wszystkich agentów → `system_knowledge`), plus pamięć zewnętrzna domenowa (notatki + Księga Menu na dysku + stan projektu w Mongo, resumowalne).

**Świadomie odłożone — harness.** Poprawne podpięcie wymaga `chef-precontext.ts` + `chef-harness.ts` + flagi `FEATURE_CHEF_PRECONTEXT` + trasy w `delegate-task`. **Caveat:** `generateWithHarness` ustawia `maxSteps` z profilu depth-controllera (default 10) → naiwne podpięcie nadpisałoby `maxSteps:40` chefa i mogłoby przywrócić zawieszanie na `profile_synthesis`. Osobne, ostrożne zadanie, nie bolt-on.

**Weryfikacja:** `npm run build` — (wynik poniżej / w sesji).
