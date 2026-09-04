# Audyt: `staging-skills/` (33 skille) + korpus `prompty-providerów/` — 2026-08-26

Status: **analiza, zero zmian w kodzie.** Dokument jest podstawą do decyzji, co wdrożyć.

Zakres: przeczytane wszystkie 33 pliki w `/projekty/mastra-agentic-environment/staging-skills/`,
zmapowane na realny runtime (`src/mastra/`), plus przegląd `prompty-providerów/system_prompts_leaks-main/`
pod kątem materiału wartego dołożenia.

---

## 0. Cztery fakty architektoniczne, które zmieniają całą dyskusję

Zanim ocena pojedynczych skilli — cztery rzeczy wyczytane z kodu, bez których mapowanie
„skill → agent" z README jest myślące o systemie, którego nie ma.

### F1. Katalog NIE jest przestrzenią nazw agenta

`SkillRegistry` ([skill-registry.ts:91](../src/mastra/services/skill-registry.ts#L91)) skanuje
`_skills/**` rekurencyjnie do jednej **płaskiej mapy** kluczowanej po `name`. `category` jest
wyprowadzana z katalogu nadrzędnego, ale służy tylko jako **opcjonalny filtr wyszukiwania**, nie
jako uprawnienie.

`TransientSkillShelfProcessor` jest domyślnie włączony dla **wszystkich** agentów
(`INTERIM_SKILL_SHELF_AGENTS=*`, [transient-skill-shelf-profiles.ts:89](../src/mastra/config/transient-skill-shelf-profiles.ts#L89)),
a `skill_search` bez `category` przeszukuje cały rejestr semantycznie.

**Konsekwencja:** pytanie „czy dać ten skill designerowi czy meta" nie jest pytaniem o katalog.
Wrzucenie pliku do `_skills/design/` NIE ogranicza go do `designAgent` — każdy agent z półką go
znajdzie. Jedyne realne dźwignie kierowania to **`description` + `keywords`** (bo po nich liczony
jest embedding) oraz to, co prompt agenta każe mu robić.

### F2. Skille designera **nie są w rejestrze** — i to jest pułapka

Wszystkie 24 pliki `_skills/design/*.md` **nie mają frontmattera**. Rejestr je pomija
([skill-registry.ts:107](../src/mastra/services/skill-registry.ts#L107): `if (!rawMeta.name && !rawMeta.description) continue`).
Designer sięga po nie **ścieżką**, nie wyszukiwaniem — `design/pipeline.md:80` mówi wprost:
„When `domain.md` says `references/<file>.md`, load the matching file from `src/mastra/_skills/design/<file>.md`".

**Konsekwencja krytyczna:** jeśli dorzucimy 8 staging-owych skilli design z poprawnym
frontmatterem, staną się one **jedynymi widocznymi w rejestrze skillami kategorii `design`**.
Każde `skill_search("slides")`, `skill_search("prototype")`, `skill_search("design system")` — z
dowolnego agenta — zwróci płytką wersję 3 KB, a nie 20-krotnie głębszy oryginał huashu, którego
wyszukiwarka nie widzi. To nie jest wzbogacenie designera; to **przykrycie go tanim duplikatem**.

### F3. `analyticsAgent` nie ma półki skilli w ogóle

README mapuje 7 skilli research na „**`analyticsAgent`** / Researcher". Tymczasem
[analytics-agent.ts](../src/mastra/agents/analytics-agent.ts) nie ma ani `inputProcessors`, ani
`skill_search`/`skill_load` w toolsecie. **Nie jest w stanie załadować żadnego skilla.**
Realny odbiorca tej grupy to `researcherAgent` (ma półkę + Tavily + Playwright MCP) i częściowo
`writerAgent`/`huntAgent`.

### F4. Metadane w staging-owych plikach opisują cudzy runtime

Każdy plik deklaruje `allowedTools: [agentBoardGet, view, write_to_file, execute_command,
grep_search, find_files, lsp_inspect, workspace_search, tavilySearch, read_url_content]`.
**Żadna z tych nazw nie istnieje** w rejestrze narzędzi tego repo (realne: `agent_board_get`,
`code_search`, `repo_map`, `code_outline`, `coding_write_file_tracked`, `shell_execute`,
`search_web`, `tavily_extract`, `fetch_page`). Półka renderuje je w system message jako
„Declared allowed tools (informational)" — więc nic nie psują twardo, ale **uczą model nazw,
których nie ma**. To dokładnie mechanizm z `project_architect_toolshelf_starvation`: agent, który
nie widzi realnego narzędzia, pisze z pamięci modelu.

Dodatkowo `estimatedTokens: 9800` przy pliku 3,8 KB (~950 tokenów) — zawyżone ~10×, we wszystkich
plikach. Pole nie wpływa na budżet półki (ta liczy realne znaki), ale jest kłamliwe w raportach.

---

## 1. Odpowiedzi na trzy zadane pytania

### P1: Design — do designera czy do meta?

**Do żadnego z nich w obecnej postaci.** Ale intuicja „meta też powinien umieć szybką makietę"
jest słuszna i da się ją spełnić czysto.

**Dlaczego nie do designera:** jego prompt to `design/domain.md` (76 KB, pełny mózg huashu) +
`design/pipeline.md` + 24 pliki referencyjne. Wszystkie 8 staging-owych skilli design są
**streszczeniami** tego, co on już ma głębiej:

| staging | co już jest | werdykt |
|---|---|---|
| `frontend-anti-ai-slop` | sekcja Anti-AI Slop w `domain.md` + biblioteka 40 stylów z mechanizmem „temperatury" bold/quiet | słabsze |
| `presentation-deck-builder` | `_skills/design/slide-decks.md` + `editable-pptx.md` + realne skrypty eksportu | dużo słabsze |
| `interactive-prototyping` | `_skills/design/react-setup.md` | **regres** (↓) |
| `design-system-tokens` | `design-styles.md`, `design-context.md` | słabsze |
| `document-pdf-publisher` | `design_export_pdf` + `save-as-pdf` w korpusie | **nie działa** (↓) |
| `wireframe-lofi-scaffolding` | huashu jest HTML-first — ASCII to krok wstecz | dla designera: zbędne |
| `visualize-suite` | — (ale zbudowany pod inny runtime) | źle zaadresowany |
| `architecture-diagram-svg` | — | **jedyny realnie nowy** |

Dwa z nich to nie tylko redundancja, ale cofnięcie zapłaconej lekcji:

- **`interactive-prototyping` regresuje działającą regułę.** Uczy ładować React z
  `cdnjs.cloudflare.com/.../react/18.2.0/...` bez `integrity`. `_skills/design/react-setup.md`
  wymaga **przypiętych wersji + hashy SRI** i wprost zakazuje `@latest`. A
  `_skills/design/animation-pitfalls.md:365` opisuje realny incydent (2026-05, animacja Mioo):
  ładowanie React/Babel z CDN przy globalnym proxy → `net::ERR_CONNECTION_CLOSED` w chromium
  podczas nagrywania Playwrightem. Ten skill przywraca dokładnie ten błąd jako domyślny wzorzec.

- **`document-pdf-publisher` jest bezczynny na tym stosie.** Uczy `@page { @top-right { content:
  "..." } }` + `counter(pages)` + `orphans/widows`. Realna ścieżka to
  `storage/repos_external/huashu-design/scripts/export_deck_pdf.mjs` → Playwright `page.pdf()` z
  `emulateMedia({ media: 'screen' })`, `preferCSSPageSize: false`, wymuszonym `width/height` i
  zerowymi marginesami. Czyli: **reguły `@media print` nigdy się nie odpalają, `@page` jest
  ignorowane, a Chromium i tak nie renderuje margin-boxów** (`@top-right`). Nagłówki/stopki na tym
  silniku robi się przez `displayHeaderFooter` + `headerTemplate` w opcjach `page.pdf()`.
  Ciekawostka potwierdzająca: oryginał z korpusu (`claude-design/skills/save-as-pdf`) **wprost
  zakazuje** ręcznego pisania `@page` — „the component owns the pagination".

**Dlaczego nie „po prostu do meta":** patrz F1 — meta **już teraz** może załadować dowolny skill
z rejestru. Przeniesienie plików do `_skills/meta/` niczego nie ogranicza ani nie odblokowuje.
Blokada jest gdzie indziej: `meta/base.md §6` ma twardą regułę routingu
„Visual/landing/UI artifacts -> `designAgent`". Skill, który każe meta samodzielnie budować
makiety, **eroduje własną regułę routingu agenta** — a to jest jedna z niewielu rzeczy, które w
tym systemie trzymają domeny na miejscu.

**Czysta linia podziału, którą proponuję:**

> Meta może produkować wizualizacje **wyjaśniające** (diagram topologii, szybki szkic IA żeby
> potwierdzić układ **zanim** deleguje). Nie produkuje wizualizacji **dostarczanych**. Wszystko,
> co ma trafić do klienta/użytkownika jako artefakt → `designAgent`.

Pod tę linię pasują dokładnie dwa pliki: `architecture-diagram-svg` (bez zmian) i mocno przycięty
`wireframe-lofi-scaffolding` — oba **z dopisaną klauzulą**: „to jest przyrząd myślowy, nie
deliverable; cokolwiek ma być dostarczone → `designAgent`". Bez tej klauzuli §6 zacznie się
rozjeżdżać i za dwa miesiące będziesz debugował, dlaczego meta robi landing page.

### P2: `automation/` — do kogo to pasuje?

**Do nikogo w całości. Twoja intuycja co do architekta jest trafna i da się wskazać konkretną
linię promptu, z którą to się bije.**

`n8n-workflow-patterns` uczy 4-krokowego cyklu: *Pre-Flight Schema Discovery → Node Design →
Test Execution → Gated Activation*. Prompt architekta `automation/base.md §6` (Golden Path) mówi:

> „For any concrete build, deploy, test, or activation request, the first BUILD action must be
> `executeAutomationRequestTool`. (...) **Do not spend the opening build steps manually calling
> runtime, health, list, compose, validate, risk, deploy, or test tools.**"

To jest sprzeczność wprost, nie różnica akcentu. A `skill_search`/`skill_load` są w
`alwaysAvailable` architekta w **każdej fazie**
([pipeline-phase-tools.ts:434](../src/mastra/config/pipeline-phase-tools.ts#L434)) — więc może to
załadować w fazie `compose` i zacząć ręcznie odpytywać schematy, czyli dokładnie to, przed czym
Golden Path go chroni.

Drugi problem: to byłby **trzeci** równoległy zbiór wytycznych n8n. Już są: prompt (23 KB) +
`_skills/n8n/` (6 plików kuratorowanych) + `_skills/auto/` (**49 skilli auto-destylowanych z
realnych przebiegów**). Nowy generyczny plik konkuruje semantycznie z tymi 49 wyuczonymi na
produkcji — i jest od nich uboższy (nie zna `forbidden_nodes`, nie zna zakazu `$vars.*`, nie zna
zakazu `active: true`, nie zna `localhost:3000` = legacy Jarvis).

Jeśli już gdzieś — to `n8nMcpEngineer` (on **jest** specjalistą od odpytywania schematów przez
MCP), ale jego prompt (12 KB) to pokrywa. **Rekomendacja: odrzucić.**

`terminal-devops-discipline` → to teren `codingAgent`, pokryty przez `_skills/security/terminal-safety-guard.md`
+ 7 plików `_skills/terminal/`. Jedyna dobra reguła („nie czyść cudzego brudnego worktree") jest
w tym repo załatwiona **strukturalnie** — coding pracuje w izolowanym worktree
(`coding_init_worktree`), nie w worktree użytkownika.

`browser-computer-safety` → patrz P3; właściciel to `researcherAgent`, nie architekt (architekt
nie ma żadnego narzędzia przeglądarkowego).

**Wniosek: `automation/` to najsłabsza z sześciu kategorii — 0 z 3 nadaje się do wdrożenia
tam, gdzie README je kieruje.**

### P3: Czy `browser-computer-safety.md` daje agentowi „computer use"?

**Nie. To sam dokument polityki, zero zdolności.** Skille w tym systemie to wyłącznie tekst
wstrzykiwany jako system message — półka mówi to wprost:
„Skill `allowedTools` metadata is guidance only; it never grants a tool".

Co jest realnie w runtime:

- **Brak computer use.** W całym rejestrze narzędzi nie ma nic do sterowania OS-em: żadnego
  screenshotu ekranu, myszy, klawiatury, `computer`-toola. Poziom 3 z tego skilla
  („Pixel-Based OS Computer Use") nie ma implementacji.
- **Jest przeglądarka — ale tylko dla jednego agenta.** `researcherAgent` dostaje toolset
  **Playwright MCP** + firecrawl ([researcher-agent.ts:40](../src/mastra/agents/researcher-agent.ts#L40)).
  To automatyzacja **DOM-owa**, nie pikselowa. Żaden inny agent tego nie ma.
- Pochodne: `_skills/coding/playwright-browser-automation.md`, `browser-login-flow.md`,
  `webapp-testing.md`, `screenshot.md` istnieją w rejestrze, ale `codingAgent` nie ma Playwrighta —
  może je wykonać tylko przez `shell_execute`. To istniejąca (nie wprowadzana przez staging)
  niespójność, warta osobnego przejrzenia.

Czyli: polityka bezpieczeństwa jest **sensowna dla researchera** i **bezprzedmiotowa dla reszty**.
I jest kompresją lepszego oryginału — `prompty-providerów/.../OpenAI/Codex/computer-use.md`
zawiera definicje, które staging zgubił: czym jest „sensitive data", że **wpisanie danych do
formularza liczy się jako transmisja**, niuans logowania („idź na xyz.com" = zgoda na login na
xyz.com, ale nie po redirekcie), „nie pytaj za wcześnie — przygotuj wszystko, potwierdź tuż przed
skutkiem", „nie powtarzaj potwierdzeń bez nowego ryzyka".

**Rekomendacja:** nie wdrażać kompresji. Przenieść **oryginał** Codeksa, przyciąć do tego, co ten
system faktycznie ma (Playwright MCP + `shell_execute` + `system_request_approval`), i osadzić przy
`researcherAgent` — a docelowo rozważyć, czy część nie powinna być twardą polityką w
`harness-tool-envelope`, a nie miękkim skillem (skill można wypuścić z półki; polityka nie).

---

## 2. Werdykty na wszystkie 33 skille

Legenda: **A** = wdrożyć, realny przyrost · **B** = wdrożyć po przepisaniu · **C** = zbędne,
pokryte gdzie indziej · **D** = odrzucić, aktywnie szkodliwe.

### `meta/` (4)

| Skill | Werdykt | Uzasadnienie |
|---|---|---|
| `meta-grounding-discovery` | **C** | `meta/base.md §1.1 „Grounding First & Two Kinds of Unknowns"` to ten sam materiał, dodany 2026-08-25 (commit `7191c5d`). Do tego nazwy narzędzi z innego runtime (F4) zamiast `repoMapTool`/`codeSearchTool`/`codeOutlineTool`, które prompt już wymienia. |
| `meta-clarifying-trigger` | **C/D** | Reguła „2–4 opcje + (Recommended)" już jest w §1.1. Ryzyko: `meta-front/base.md §1` to „**never block on durable work**" — skill każący zatrzymać się i zadać 2–3 pytania w kontekście durable joba to zakleszczenie. |
| `meta-memory-hygiene` | **B** | Najlepszy z czwórki. Rozróżnienie **fakt deklaratywny vs. dyrektywa imperatywna** trafia w udokumentowany incydent (`project_knowledge_hygiene_and_finalize_lever`: `system_knowledge` czytane przez agenta jak wskazówki, 119/124 śmieciowych `prompt_rule`). Ale nazwy magazynów (`user_preferences`, `project_topology`, `architecture_invariants`) nie istnieją, a limit „<20 faktów" jest wzięty z sufitu. Przepisać pod realne warstwy: observational memory / `memoryWriteTool` / `system_knowledge`. |
| `meta-skill-evolution` | **D** | Koliduje z rządzonym pipeline'em: `skill-distiller.ts` → `miniEvalSkill()` → aktywacja albo `_skills/quarantine/` → nocny cykl + tygodniowy kurator. Skill mówi „Update the skill file immediately or stage the patch" = **zapis do `_skills/` z pominięciem mini-evala i telemetrii `success_rate`**. Historia (`project_skill_distillation_cron`) pokazuje, ile kosztowało zaśmiecenie tej kolejki. Jeśli w ogóle — przepisać na „jak zgłosić kandydata do destylacji", wskazując istniejący mechanizm. |

### `research/` (6) — **uwaga: zły adresat w README (F3)**

| Skill | Werdykt | Uzasadnienie |
|---|---|---|
| `adversarial-fact-checker` | **A** | Najmocniejszy z szóstki. Reguła 3 głosów, „no silent averaging", tabela konfliktów z metodologią i datą — konkretny mechanizm, nie ogólnik. Adresat: `researcherAgent`, wtórnie `writerAgent` (ma `writer_verify_claims`/`writer_upsert_claims`, ale nie ma reguły rozstrzygania sprzeczności). |
| `deep-research-harness` | **B** | `shared/subagent-researcher.md` (17 KB) ma już pełny PSEV, tryby breadth, batch extraction, acquisition validation, retry/fallback i kontrakt wyjścia. Realnie nowe: **dekompozycja 5-kątowa** i **tabela wiarygodności źródeł (Tier 1–4)**. Przyciąć do tej delty albo dopisać jako sekcję do promptu researchera. |
| `scientific-academic-research` | **B** | Zero pokrycia, treść poprawna (ablacje, preprint vs peer-review, konflikt interesów). Niska częstotliwość użycia w profilu gastro/automatyzacja — niski priorytet, ale nic nie psuje. Adresat: `researcherAgent`/`knowledgeAgent`. |
| `financial-valuation-models` | **C** | Zero pokrycia, ale też **zero konsumenta** — nikt tu nie robi DCF/LBO. Analytics ma ROI/trendy *systemu*, nie wycenę spółek. Wrzucenie tego to silny atraktor semantyczny na zapytania „ROI/model/valuation" w rejestrze wspólnym dla wszystkich. |
| `spreadsheet-xlsx-engineering` | **C** | `_skills/coding/xlsx-manipulation.md` już jest. Skill mówi o `exceljs`/`openpyxl` (lokalne pliki), a realne narzędzia to `sheets_*` (Google Sheets API) — inna powierzchnia. Konwencja kolorów (niebieski = input, czarny = formuła) jest ładna, ale to jedna tabelka, nie skill. |
| `research-report-synthesizer` | **C** | Koliduje z `shared/result-envelope.md` + §10 kontraktu wyjścia researchera. Dwa konkurencyjne szablony raportu to gwarantowany dryf formatu. |

### `coding/` (7) — najgęściej pokryta domena w repo

Kontekst: `coding/base.md` (15 KB), `review.md` (13 KB, „Findings-First Codex Standard", 8 kroków,
tryby FAST/STANDARD/DEEP), `diagnose.md`, `security-review.md`, `performance-review.md`, 3 prompty
subagentów + **49 skilli w `_skills/coding/`** i 9 w `_skills/security/`.

| Skill | Werdykt | Uzasadnienie |
|---|---|---|
| `code-plan-decision-complete` | **B → A** | Najmocniejszy z siódemki. „Decision-Complete" jako **twarda bramka** (dokładne ścieżki, pełne sygnatury, wskazani wołający, strategia rollbacku, konkretne komendy weryfikacji, jawne OUT OF SCOPE) uderza w udokumentowany problem mglistych briefów. Przepisać nazwy narzędzi i komendy pod ten repo (`check:all`, worktree). |
| `code-review-8-angle` | **C jako jest** | ~80% duplikat `coding/review.md`. Brakującym 20% jest **druga faza (kandydat → weryfikacja CONFIRMED/PLAUSIBLE/REFUTED)** — i tego staging **też nie ma**, bo zgubił to przy kompresji. Zamiast tego pliku wziąć oryginał z korpusu (patrz §3). |
| `root-cause-debugging` | **C** | `coding/diagnose.md` (7 KB) pokrywa. |
| `test-verification-harness` | **C** | `_skills/coding/test-generator.md` + `run-verification.md` + `integration-testing.md` + `tdd-london.md`. Lista 6 klas warunków brzegowych jest dobra, ale to sekcja, nie skill. |
| `code-explore-readonly` | **C** | `_skills/terminal/swe-repo-explorer.md` + narzędzia `code_search`/`repo_map`/`code_outline`. Nazwy narzędzi z innego runtime. |
| `security-vulnerability-audit` | **C** | `_skills/security/` ma 9 plików (`owasp-code-review`, `prompt-injection-defense`, `secrets-redaction`, `agentic-actions-auditor`, `stride-dread`…) + prompt `security-review.md` 11,6 KB. |
| `code-simplification-refactor` | **D jako jest** | Reguła **„Default to writing zero comments"** jest sprzeczna z house style tego repo. Ten kod celowo niesie długie komentarze *dlaczego* — np. [analytics-agent.ts:27](../src/mastra/agents/analytics-agent.ts#L27) („EIGHT tools against Mastra's undeclared default of five steps…") czy [pipeline-phase-tools.ts:490](../src/mastra/config/pipeline-phase-tools.ts#L490) (ostrzeżenie o granicy id vs. registry key). To jest zapisana pamięć instytucjonalna. Skill załadowany podczas refaktoru każe ją usunąć. Reszta (rule of three, blast radius) jest OK i już pokryta. |

### `design/` (8) — patrz P1

| Skill | Werdykt | Uzasadnienie |
|---|---|---|
| `architecture-diagram-svg` | **A** (ale nie dla designera) | Jedyny realnie nowy. Właściciel: **meta** (diagram topologii dla wyjaśnienia) i wtórnie `codingAgent` (dokumentacja architektury). Wymaga klauzuli „to nie deliverable". |
| `wireframe-lofi-scaffolding` | **B** (dla meta, nie designera) | Dla designera krok wstecz (huashu jest HTML-first). Dla meta — sensowny szybki szkic IA przed delegacją. Przyciąć do ~1/3 i dodać klauzulę routingu. |
| `visualize-suite` | **C** | Zbudowany pod inline widget chatu (`show_widget`) — tej powierzchni tu nie ma („Text in Response, Visuals in the Tool" nie znaczy nic w Mastrze). Paleta 9 ramp jest dobra, ale w korpusie jest jej lepsza, walidowalna wersja (`dataviz`, §3). |
| `design-system-tokens` | **C** | Chudsza wersja `claude-design/skills/create-design-system` (19 KB) z korpusu; designer ma `design-styles.md` + `design-context.md`. |
| `frontend-anti-ai-slop` | **C** | `domain.md` ma pełną sekcję Anti-AI Slop i mechanizm „temperatury" stylów (bold/neutral/quiet + wymuszony bold w kierunku C). Staging spłaszcza to do 3 przykazań. |
| `presentation-deck-builder` | **C** | `_skills/design/slide-decks.md` + `editable-pptx.md` + `export_deck_pdf/pptx.mjs`. Łuk 8 slajdów to generyczny pitch deck, nie wiedza o tym stosie. |
| `interactive-prototyping` | **D** | Cofa regułę pinned + SRI i wraca do CDN bez integrity — patrz P1. |
| `document-pdf-publisher` | **D jako jest** | Bezczynny na `design_export_pdf` (screen media, `preferCSSPageSize:false`, margin-boxy nieobsługiwane przez Chromium) — patrz P1. **B**, jeśli przepisany na `displayHeaderFooter`/`headerTemplate`. |

### `marketing/` (5)

| Skill | Werdykt | Uzasadnienie |
|---|---|---|
| `html-email-bulletproof` | **A** | Najmocniejszy skill w całej paczce. Realna luka — nic w repo nie pokrywa VML dla Outlooka, tabelkowego layoutu, preview-text hacka, `mso-` resetów. Konsument istnieje: `gmail_manage_draft`, `crm_record_email_draft`, `hunt` draftuje maile. |
| `flier-marketing-collateral` | **B** | Realna luka (jednostronicowy A4 z gwarancją braku strony 2), sensowny dla GastroBridge. Ale to streszczenie bogatszego `claude-design/skills/flier` — portować oryginał. Uwaga: geometria druku i tak zależy od tego, kto renderuje (por. P1). |
| `editorial-voice-craft` | **C** | `marketing/copy-pl.md`, `copy-en.md`, `shared/house-style.md`, `meta/base.md §20` (Zero-Yapping) — a do tego istnieje **narzędzie** `writer_audit_slop`, czyli maszynowy odpowiednik tej listy. |
| `cold-outreach-proposals` | **C** | `marketing/cold-email.md` (7,8 KB) + `outreach-draft.md` (9,8 KB) — **oba przepisane 2026-08-25** pod standardy providerów (+179 / +294 linii). Dwa konkurencyjne kontrakty cold-maila to prosta droga do dryfu. |
| `competitive-market-recon` | **C** | `_skills/meta/competitor-analysis-strategy.md` + narzędzie `business_competitor_analysis`. |

**Ryzyko poboczne dla całej grupy marketing:** profil półki jest wspólny dla całej rodziny —
`profileFamily()` mapuje `weekly-content-*` i `producer-hunt-*` na `marketing-agent`
([transient-skill-shelf-profiles.ts:54](../src/mastra/config/transient-skill-shelf-profiles.ts#L54)).
To **11 agentów-kroków workflow** z kontraktami JSON (m.in. `weeklyContentJsonRepairAgent`).
Wzbogacenie „marketingu" o skille prozatorskie zwiększa szansę, że agent od naprawy JSON-a
załaduje poradnik o rytmie zdań. To istniejący warunek, nie nowy — ale ta paczka go dociąża.

### `automation/` (3) — patrz P2

| Skill | Werdykt |
|---|---|
| `browser-computer-safety` | **B** — przepisać z oryginału Codeksa, adresat `researcherAgent` |
| `n8n-workflow-patterns` | **D** — sprzeczny z Golden Path §6 |
| `terminal-devops-discipline` | **C** — pokryte przez `security/terminal-safety-guard` + `_skills/terminal/` |

### Bilans

| Werdykt | Liczba | Skille |
|---|---|---|
| **A** — wdrożyć | 3 | `html-email-bulletproof`, `adversarial-fact-checker`, `architecture-diagram-svg` |
| **B** — po przepisaniu | 7 | `meta-memory-hygiene`, `deep-research-harness`(delta), `scientific-academic-research`, `code-plan-decision-complete`, `wireframe-lofi-scaffolding`(dla meta), `flier-marketing-collateral`, `browser-computer-safety` |
| **C** — zbędne | 18 | reszta |
| **D** — odrzucić | 5 | `meta-skill-evolution`, `code-simplification-refactor`, `interactive-prototyping`, `document-pdf-publisher`, `n8n-workflow-patterns` |

Czyli **~10 z 33 warto**, z czego 3 bez przeróbek. To nie jest zła statystyka jak na paczkę
wygenerowaną hurtem — ale wdrożenie wszystkich 33 „bo są" **obniżyłoby** jakość systemu, bo
17 z nich konkurowałoby semantycznie z głębszymi, wyuczonymi na produkcji oryginałami.

---

## 3. Co wziąć z `prompty-providerów/system_prompts_leaks-main/`

Kontekst: korpus był już raz eksploatowany — commity `7191c5d` (2026-08-25, 24 pliki promptów,
+2468 linii) i `f724b7b` (2026-08-26, tiered thinking). Stąd duplikaty w §2: staging to **drugie
żniwo z tego samego pola**. Poniżej to, czego **jeszcze nie wzięto**, uszeregowane po realnej
wartości dla tego systemu.

### 3.1 `claude-code/skills/verify/SKILL.md` (12 KB) — **najwyższa wartość w całym korpusie**

Doktryna: **weryfikacja to obserwacja runtime, nie testy.** Kluczowe reguły:

- „Don't run tests. Don't typecheck. Running them proves you can run CI — not that the change works."
- „Don't import-and-call" — wywołanie funkcji z importu to test jednostkowy, nie weryfikacja.
- Tabela **powierzchni**: CLI → terminal, server → socket, GUI → piksele, biblioteka → granica
  pakietu, **prompt/agent config → uruchom agenta i złap zachowanie**, CI → dispatch.
- Werdykty **PASS / FAIL / BLOCKED / SKIP** z zasadami: „No partial pass — 3 of 4 passed is FAIL",
  **„When in doubt, FAIL"** („false PASS ships broken code; false FAIL costs one more human look").
- Faza „Push on it" — sondy poza happy path (`🔍`), z regułą, że lista samych `✅` bez `🔍` to
  odtworzenie happy path, nie weryfikacja.

**Dlaczego akurat tu:** to jest bezpośrednia odtrutka na udokumentowaną klasę awarii tego systemu —
`tested` zatrzaśnięty na mocku, scorer z własną definicją wyniku dającą fałszywy sukces, nagłówek
raportu kłamiący wobec treści, `policy_blocked` raportowane przy `log_only`. Reguła „when in doubt,
FAIL" + „no partial pass" to dokładnie brakująca asymetria.

**Port:** `_skills/coding/verify-runtime-observation.md`, mapując powierzchnie na realne
(`coding_run_test` → *nie jest weryfikacją*; `shell_execute` uruchamiający app; `n8n_trigger`;
`design_verify`; `POST /api/agents/*/generate` dla zmian promptu — z pamiętaniem o `memory.thread`).
Kandydat też na bramkę w self-healingu przed swapem.

### 3.2 `claude-code/skills/code-review/` (SKILL + `low/medium/high/xhigh/max`)

To, czego nie ma `code-review-8-angle` i czego nie ma `coding/review.md`:

- **Dwufazowość**: Faza 1 = N niezależnych kątów × do 6 kandydatów; Faza 2 = **weryfikator na
  kandydata**, zwracający dokładnie `CONFIRMED / PLAUSIBLE / REFUTED`.
- **Reguła obalania**: `REFUTED` tylko gdy da się skonstruować z kodu (cytat linii, dowód
  niemożliwości z typu/stałej, wskazanie istniejącego guarda, czysty styl bez efektu). Wszystko
  inne, co realistyczne (wyścigi, zimny cache, falsy-zero, off-by-one na granicy) → `PLAUSIBLE`.
- **Poziomy wysiłku** skalowane do ryzyka diffa — spina się z istniejącym
  `_skills/coding/diff-risk-analysis.md` (triage → wybór poziomu).
- **Kąt „Conventions"**: sprawdzaj `CLAUDE.md`/`AGENTS.md`, ale zgłaszaj tylko cytując regułę i
  linię — koniec z „preferencjami stylu" jako findingami.

To dopina jakościowo domenę, którą ostatnio zamykałeś (budżety recenzentów). Trzy oddzielni
recenzenci (`code-review`/`security-review`/`performance-review`) to już fan-out; brakuje im
**drugiego przebiegu weryfikującego**, który tnie fałszywe alarmy.

### 3.3 `claude-code/skills/dataviz/` (SKILL + 7 referencji + `validate_palette.js/py`)

Znacznie lepszy niż `visualize-suite`. Kluczowa różnica: **część kolorystyczna jest obliczalna, więc
się ją liczy** — jest realny skrypt walidujący pasmo jasności, podłogę chromy, separację par w
symulacji CVD i kontrast. Plus procedura „kolor NA KOŃCU" (forma → rola koloru → walidacja → marki →
warstwa hover → dostępność → obejrzyj render).

Konsument istnieje: dashboard (`dashboard/`), Analytics UI, `designAgent`. Warto portować **z
referencjami i skryptem**, nie jako streszczenie — inaczej traci się to, co go czyni wartościowym.

### 3.4 `OpenAI/Codex/computer-use.md` + `control-chrome.md` (13,5 KB)

Pełna polityka potwierdzeń, z której `browser-computer-safety` jest kompresją. Warte przeniesienia
w całości dla `researcherAgent`. `control-chrome.md` dodatkowo daje operacyjne wzorce sterowania
przeglądarką (kontekst kart, unikanie dialogów blokujących, wychodzenie z pętli po 2–3 nieudanych
próbach) — te ostatnie pokrywają się z `claude-code/skills/claude-in-chrome/SKILL.md`, który ma
świetną regułę: **nie wywołuj `alert/confirm/prompt` — blokują wszystkie kolejne zdarzenia i
zabijają sesję**.

### 3.5 `claude-design/skills/*` — oryginały tego, co staging streszcza

Jeśli którykolwiek design/marketing ma wejść, portować **stąd**, nie ze staging:

| Oryginał | Rozmiar | vs. staging |
|---|---|---|
| `create-design-system` | 19 KB | vs. `design-system-tokens` 3,3 KB |
| `save-as-pdf` | 9,2 KB | vs. `document-pdf-publisher` 2,3 KB — i **zakazuje** ręcznego `@page` |
| `make-a-deck` | 9,7 KB | vs. `presentation-deck-builder` 3,9 KB |
| `animated-video` | 10 KB | brak odpowiednika (designer ma własne) |
| `flier` | 2,1 KB | vs. `flier-marketing-collateral` 3,5 KB (tu staging jest dłuższy — sprawdzić co dodał) |
| `html-email` | 2,7 KB | vs. `html-email-bulletproof` 5,9 KB (staging **bogatszy** — zostawić staging) |

### 3.6 Drugi rząd (warte przejrzenia, niższy priorytet)

- `claude-code/agents/Explore.md` i `Plan.md` — wzorzec **egzekwowanego read-only** (jawna lista
  zakazów wraz z „no redirect operators, no heredocs, no temp files"). Dobry szablon dla promptów
  subagentów coding w tym repo.
- `claude-code/skills/simplify/SKILL.md` — 4 równoległe kąty czyszczące + reguła „pomiń finding,
  którego naprawa zmienia zamierzone zachowanie lub wychodzi poza diff — **odnotuj pominięcie
  zamiast się z nim spierać**".
- `OpenAI/Codex/plan_mode.md`, `codex-auto-review.md` — alternatywne ujęcie planowania/recenzji.
- `Google/jules.md`, `Misc/amp-code.md`, `Misc/warp-2.0-agent.md`, `Misc/devin-cli.md` — prompty
  agentów kodujących, do porównania z `coding/base.md`.
- `OpenAI/tool-deep-research.md` — do delty dla `deep-research-harness`.

---

## 4. Znaleziska poboczne (nie z paczki, ale wyszły przy okazji)

1. **10 zduplikowanych nazw skilli już jest w rejestrze** — `seedance-antislop`, `seedance-audio`,
   `seedance-copyright`, `seedance-examples-zh`, `seedance-filter`, `seedance-vocab-{es,ja,ko,ru,zh}`.
   `SkillRegistry` trzyma `Map` po `name`, więc **drugi plik cicho nadpisuje pierwszy** — część tych
   skilli jest nieosiągalna. Staging nie wnosi nowych kolizji (sprawdzone: 0 kolizji z 188
   istniejącymi nazwami), ale te 10 warto rozbroić.

2. **24 skille designera są niewidoczne dla rejestru** (F2). To może być świadome (dostęp
   ścieżkowy przez `design/pipeline.md`), ale wtedy warto to udokumentować w kodzie — bo pierwsza
   osoba, która doda tam plik z frontmatterem, zmieni zachowanie wyszukiwarki dla całego systemu.

3. **`architect_skills_search` ma zawężone `category` do `['n8n','terminal','all']`**
   ([skills-search.ts:163](../src/mastra/tools/architect/skills-search.ts#L163)) i skanuje tylko
   jeden poziom katalogów. Nowa kategoria `automation/` byłaby dla niego osiągalna wyłącznie przez
   `all` — kolejny argument, że ta kategoria nie ma dobrego miejsca.

4. **Niespójność Playwright**: `_skills/coding/{playwright-browser-automation,browser-form-filling,
   browser-login-flow,webapp-testing,e2e-testing-playwright}.md` są w rejestrze i semantycznie
   dostępne dla `codingAgent`, który **nie ma** toolsetu Playwright MCP (ma go tylko researcher).
   Coding może je wykonać jedynie przez `shell_execute`. Warto albo dać coding własny toolset
   przeglądarkowy, albo dopisać w tych skillach, że ścieżką jest shell.

---

## 5. Proponowana kolejność wdrożenia

Fazami, każda weryfikowalna osobno:

**Faza 1 — czysty przyrost, zero kolizji (3 pliki)**
`html-email-bulletproof` → `_skills/marketing/` · `adversarial-fact-checker` → `_skills/research/`
· `architecture-diagram-svg` → `_skills/meta/` (z klauzulą „nie deliverable").
Przed commitem: poprawić `allowedTools` na realne nazwy narzędzi, poprawić `estimatedTokens`.
Weryfikacja: `skill_search` z 3 różnych agentów zwraca je z sensownym score i **nie wypiera**
istniejących trafień.

**Faza 2 — najwyższa wartość z korpusu (2 pliki, wymagają portu)**
`verify` (§3.1) → `_skills/coding/` · dwufazowa recenzja z `code-review` (§3.2) → wpięta w
`coding/review.md` jako Faza 2 albo jako skill dla recenzentów.

**Faza 3 — po przepisaniu (5 plików)**
`meta-memory-hygiene` (pod realne warstwy pamięci) · `code-plan-decision-complete` (pod realne
komendy) · `browser-computer-safety` (z oryginału Codeksa, adresat researcher) ·
`wireframe-lofi-scaffolding` (przycięty, dla meta) · `flier-marketing-collateral` (z oryginału).

**Faza 4 — opcjonalnie**
`dataviz` z referencjami i walidatorem (§3.3) · delta `deep-research-harness` (5 kątów + tabela
Tier 1–4) do promptu researchera · `scientific-academic-research`.

**Nie wdrażać:** 5× D + 18× C. `staging-skills/` zostawić jako archiwum źródłowe, ale **nie
kopiować hurtem do `_skills/`** — rejestr jest wspólny dla wszystkich agentów i każdy dodany plik
konkuruje semantycznie z resztą.

---

## 6. Zasada, którą warto zapisać na stałe

Każdy skill w tym systemie kosztuje trzy rzeczy: miejsce w wyszukiwaniu semantycznym (konkuruje
z lepszymi), znaki w budżecie półki (`maxActive` 2–3, `maxActiveChars` 28–44 tys.) i — najdrożej —
**autorytet**. Załadowany skill wygląda dla modelu jak instrukcja domowa, nawet gdy jest
streszczeniem z internetu opisującym cudzy runtime.

Stąd bramka przed dodaniem czegokolwiek do `_skills/`:

1. **Czy istnieje konsument?** Czy jest agent z półką (F1/F3) i narzędziem, które ten skill zakłada?
2. **Czy runtime to wykona?** (`@page` w Chromium, `execute_command` jako nazwa narzędzia,
   inline widget) — jeśli nie, skill uczy halucynacji.
3. **Czy nie ma tego głębiej?** Prompt agenta, `_skills/<domena>/`, `_skills/auto/` — jeśli tak,
   dodanie płytszej wersji to regres, nie przyrost.
4. **Czy nie bije się z twardą regułą?** Golden Path §6, routing §6 meta, „never block on durable
   work", pipeline faz.
5. **Czy nazwa jest unikalna?** `Map` po `name` — kolizja to ciche nadpisanie.
