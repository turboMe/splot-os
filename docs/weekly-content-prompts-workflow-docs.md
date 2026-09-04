# Weekly Content: porownanie promptow i logiki (Jarvis vs Mastra)

Data audytu: 2026-05-05.

Cel dokumentu: utrzymac parytet jakosci przy migracji workflow `weekly-content` ze starego Jarvisa do Mastry. Zasada migracji: Mastra nie moze generowac slabszego outputu niz stary kod. Minimum to parytet, docelowo lepiej.

## 1. Zrodla porownania

### Mastra
- Workflow: `src/mastra/workflows/weekly-content.ts`
- Bazowy prompt agenta: `src/mastra/prompts/marketing/base.md`
- Prompty krokow: `src/mastra/prompts/marketing/research.md`, `copy-pl.md`, `copy-en.md`
- Agent: `src/mastra/agents/marketing-agent.ts`

### Jarvis
- Runtime workflow: `../jarvis-dashboard-agent/apps/workers/src/agents/marketing-agent/index.ts`
- Kroki: `../jarvis-dashboard-agent/apps/workers/src/agents/marketing-agent/steps/research.ts`, `copy-pl.ts`, `copy-en.ts`, `image-placeholder.ts`
- Prompty: `../jarvis-dashboard-agent/apps/workers/src/agents/marketing-agent/prompts/research.md`, `copy-pl.md`, `copy-en.md`
- Kontekst bazowy/prototypowy: `../jarvis-dashboard-agent/prototyp/AGENTS.md`
- Historyczna komenda workflow: `../jarvis-dashboard-agent/prototyp/.agent/workflows/weekly-content.md`

## 2. Najwazniejsze ustalenia

### Krytyczne: prompty krokow nie byly podawane poprawnym API Mastry

Mastra `Agent.generate()` nie przyjmuje opcji `systemPrompt`. Poprawne opcje to m.in. `system` albo `instructions`. W workflow byly trzy wywolania:

- `research-week`
- `generate-pl`
- `translate-en`

Efekt: `npx tsc --noEmit` zwracal bledy TS2769 na liniach wywolan `marketingAgent.generate(..., { systemPrompt })`. To oznaczalo, ze runtime byl co najmniej nieskompilowalny, a w praktyce prompty krokow nie byly poprawnie przeniesione do Mastry.

Status: naprawione przez uzycie `system: systemPrompt`, z zachowaniem bazowych instrukcji agenta.

### Krytyczne: workflow gubil parametry ilosci postow miedzy krokami

Jarvis domyslnie generowal:

- 5 postow LinkedIn
- 3 tresci Instagram
- 2 adaptacje EN z top LinkedIn

Mastra miala domyslnie 3 LI + 2 IG, a dodatkowo `research-week` nie przekazywal `liCount` i `igCount` do `generate-pl`. W lancuchu `.then()` kolejny krok dostaje output poprzedniego kroku, wiec parametry startowe trzeba jawnie przenosic albo czytac przez `getInitData()`.

Status: naprawione. Domyslne wartosci to teraz 5 LI + 3 IG, workflow wspiera tez legacy aliasy `linkedinCount` i `instagramCount`.

### Wazne: brakowalo czesci instrukcji jakosciowych z Jarvisa

Najwieksze braki promptowe w Mastrze przed poprawkami:

- Slabszy bazowy kontekst produktu: brak pilota Wroclaw, narracji "Allegro dla HoReCa", rozroznienia komunikacji producent/restaurator.
- `research.md`: brak `sourceCitations`, mniej precyzyjny enum `bestFor`, mniej kontekstu GastroBridge.
- `copy-pl.md`: brak limitow znakow, pul hashtagow, rozroznienia kont LinkedIn, rotacji formatow i harmonogramu publikacji.
- `copy-en.md`: brak limitu 1300 znakow, zasad translacji hashtagow i zachowania struktury hook/story/takeaway/CTA.
- Workflow user prompt dla PL copy byl zbyt ogolny, bez starych instrukcji o miksie kont, rotacji formatow, dniach publikacji i unikalnosci tematow.

Status: brakujace reguly zostaly dopisane do promptow i user promptu kroku `generate-pl`.

## 3. Porownanie promptow

| Obszar | Jarvis | Mastra przed audytem | Status po audycie |
| --- | --- | --- | --- |
| Bazowa tozsamosc | GastroBridge B2B marketplace, Polska, Wroclaw, Patryk Head Chef, zero frazesow | Krotszy prompt marketingowy, dobry ton, ale mniej kontekstu produktu | Uzupelniony o Wroclaw, marketplace, narracje, komunikacje do obu segmentow i NotebookLM |
| Research | NotebookLM `rynek` + `konkurencja`, cytaty, `bestFor` per platforma/konto, `sourceCitations` | Tylko fakty i JSON, ale bez `sourceCitations`, slabszy `bestFor` | Lepsze niz Jarvis: `knowledge.query_multi` dla `rynek`, `rhd`, `konkurencja`, `founder`, historia contentu i warunkowy `research_start` |
| Copy PL | Limity znakow, pulle hashtagow, osobny LinkedIn Patryk/GastroBridge, Instagram, komunikacja producer/restaurateur, rotacja | Mial dobry ton, ale brakowalo wielu ograniczen operacyjnych | Uzupelniony o limity, hashtagi, segmenty, rotacje i harmonogram |
| Copy EN | Adaptacja kulturowa, <1300 znakow, hashtagi EN, zachowaj GastroBridge/HoReCa | Adaptacja byla, ale bez kilku ograniczen | Uzupelniony o limity, strukture i zasady uogolniania lokalnych danych |
| User prompt PL copy | Wymuszal mix kont, mix formatow, rotacje, unikalnosc tematow | Tylko liczba postow + research JSON | Uzupelniony |

## 4. Porownanie logiki workflow

| Obszar | Jarvis | Mastra przed audytem | Status po audycie |
| --- | --- | --- | --- |
| Modele per step | `callLLM(step, ...)` wybieral modele i fallbacki per krok | Jeden model agenta `ollama/local/gemma4:26b` | Nadal brak pelnego per-step routing; do rozważenia osobno |
| JSON mode | `jsonMode: true`, `repairJSON`, fallbacki | Prosty `JSON.parse` z fenced block | Dodany Zod validation + repair pass z `structuredOutput` |
| NotebookLM fallback | Try/catch, fallback text, workflow szedl dalej | Brak try/catch wokol query mogl wywalic caly workflow | Dodany try/catch, fallback bez halucynacji i warunkowy `knowledge.research_start` przy slabym sygnale |
| Wolumen contentu | 5 LI + 3 IG + 2 EN | 3 LI + 2 IG, parametry gubione po pierwszym kroku | 5 LI + 3 IG, aliasy legacy, liczniki przenoszone dalej |
| EN translation | Top 2 LinkedIn | Tworzyl `topPosts`, ale mapowal po wszystkich `liPosts` | Naprawione na top 2 |
| Image prompts | Osobny krok + opcjonalna generacja obrazow do folderow draftow | Brak osobnego kroku image generation, tylko `imagePrompt` w danych | Nadal do przeniesienia |
| Metadata draftow | `rationale`, `imagePrompt`, `imagePath`, `calendarEventId`, LLM provider/model/cost | Minimalne metadata, sztywne `mastra/gemma` | Czesc metadata przywrocona: `rationale`, `imagePrompt`, typ IG; obraz i provider/cost nadal do przeniesienia |
| Task lifecycle | Mongo task, runs telemetry, heartbeat, awaiting_approval | Mastra output + draft store, mniej telemetry Jarvisa | Do decyzji: czy odtwarzamy task telemetry w Mastra, czy wystarcza observability Mastry |

## 5. Co zostalo juz przeniesione/poprawione

- Poprawne API Mastry dla promptow krokow: `system`, nie `systemPrompt`.
- Domyslne ilosci: 5 LinkedIn + 3 Instagram.
- Legacy aliasy wejscia: `linkedinCount`, `instagramCount`.
- Przenoszenie countow przez workflow.
- NotebookLM fallback w `research-week`.
- Research query ponownie obejmuje lokalnych producentow i Rekki w konkurencji.
- Prompt `base.md` dostal brakujacy kontekst produktu, segmentow i NotebookLM.
- Prompt `research.md` dostal `sourceCitations` i dokladniejsze `bestFor`.
- Prompt `copy-pl.md` dostal limity, hashtagi, segmenty, harmonogram i rotacje.
- Prompt `copy-en.md` dostal limity, hashtagi EN i zasady bezpiecznej adaptacji.
- Krok EN tlumaczy top 2 posty LinkedIn, jak w Jarvisie.
- Trzy kroki LLM (`research-week`, `generate-pl`, `translate-en`) waliduja odpowiedz przez Zod, a przy uszkodzonym JSON uruchamiaja repair pass z `structuredOutput`.
- Trzy kroki LLM wczytuja prompty przez `loadPrompt(...)`, a nie przez sciezki liczone wzgledem bundla `.mastra/output`; usuwa to blad `ENOENT` dla `.mastra/prompts/marketing/*.md`.
- `research-week` ma adapter zgodnosci dla starszego/snake_case JSON (`news_hooks`, `competitor_moves`, `impact`, `angle`), zeby nie uruchamiac ciezkiego LLM repair pass przy prostym mapowaniu pol.
- `generate-pl` ma adapter zgodnosci dla starszego ksztaltu JSON (`linkedin_personal`, `linkedin_company`, `content`, `tags`, `schedule`), zeby nie obciazac lokalnego modelu LLM repair pass przy prostym mapowaniu pol.
- Parser JSON ma lekki pre-repair dla typowych usterek lokalnego modelu (`_day"` bez otwierajacego cudzyslowu, `hashtations`, trailing comma), zanim workflow uruchomi LLM repair pass.
- `generate-pl` nie moze juz po cichu zakonczyc sie zerem draftow po blednym JSON - workflow rzuca jawny blad.
- Aliasowe nazwy NotebookLM (`rynek`, `rhd`, `konkurencja`, `founder`) sa mapowane w kliencie NotebookLM na realne tytuly notebookow GastroBridge, wiec `query_multi` i `research_start` nie powinny juz failowac na `Notebook "rynek" not found`.
- `sourceCitations` zawiera tylko uzywalne cytowania, a bledy narzedzi trafiaja do `researchDiagnostics` w skroconej formie. Lista `Available notebooks` nie jest juz przekazywana copywriterowi jako zrodlo.
- Research jest sanityzowany po JSON: puste `hook` dostaje bezpieczny fallback z tematu, generyczne zrodla typu "analiza trendow" przy braku danych sa zamieniane na `no-current-source`, a `bestFor` jest kanonizowane.
- Copy PL jest sanityzowane po JSON: dlugie pauzy sa zamieniane na zwykly dywiz, hashtagi sa rozbijane na osobne elementy tablicy, `char_count` jest liczony z finalnej tresci, a debugowe adapter rationale nie trafia do nowych fallbackow.
- `generate-pl` wymaga dokladnie zadanej liczby postow (`liCount`, `igCount`). Jesli model zwroci mniej lub wiecej, workflow probuje krotkiego top-up/regeneracji brakujacego kanalu; jesli lokalny model nadal nie dowiezie, uzupelnia brakujace sloty technicznym fallbackiem bez nowych faktow i liczb.
- Research nie przepuszcza juz pustych ruchow konkurencji typu `unknown-competitor` z pustym `move` i `ourAngle`.
- Diagnostyka `knowledge.research_start` pokazuje teraz kod bledu oraz stdout/stderr z `nlm`, zamiast pustego `nlm research start failed:`.
- Research uzywa `knowledge.query_multi` zamiast dwoch osobnych query.
- Research odpytuje `rynek`, `rhd`, `konkurencja` i `founder`.
- Research wczytuje ostatnie tematy z `DraftsStore` i przekazuje je jako `recentContentTopics`, zeby ograniczyc powtorki.
- Przy slabym sygnale z NotebookLM (`brak danych`, krotka odpowiedz lub malo cytatow) workflow uruchamia `knowledge.research_start` dla max 2 notebookow i ponawia `query_multi`.
- Fallback researchu nie korzysta juz z "ogolnej wiedzy o rynku HoReCa"; instruuje model, zeby przygotowal evergreen bez liczb i bez zmyslonych newsow.
- `npx tsc --noEmit` przechodzi.

## 6. Rzeczy nadal do przeniesienia, zeby nie bylo gorzej niz w Jarvisie

1. **Per-step model routing**
   Jarvis wybieral provider chain per krok (`research`, `copy-pl`, `copy-en`) i mial fallback. Mastra dziedziczy jeden model z agenta. To moze obnizac jakosc w krokach kreatywnych albo researchowych.

2. **Image generation**
   Jarvis mial `ImagePlaceholderStep` i opcjonalne `generateImage()` zapisujace `image.png` obok `draft.md`. Mastra przechowuje prompt obrazu, ale nie generuje obrazu.

3. **Plan tygodnia i human approval przed generacja**
   Prototypowy workflow najpierw proponowal plan tygodnia i czekal na akceptacje. Aktualny runtime Jarvisa generowal automatycznie i konczyl `awaiting_approval`, wiec to nie jest regresja wobec aktywnego Jarvisa, ale moze byc wymagane docelowo dla jakosci.

4. **Telemetry LLM**
   Jarvis zapisywal provider/model/tokeny/koszt per step w `runs`. Mastra ma observability, ale metadata draftow nadal ma placeholder `provider: mastra`, `model: gemma`, `costUsd: 0`.

## 7. Zalecany nastepny krok

Najbardziej oplacalne kolejne zadanie: wzbogacic research o warstwe swiezych sygnalow z RSS/przetworzonych newsow. Najlepszy kierunek to osobny magazyn "content intelligence" z przetworzonymi wpisami z n8n, ktory workflow przeszukuje deterministycznie przed NotebookLM. Wybrane, wysokiej jakosci wpisy mozna dodatkowo importowac do dedykowanego notebooka NotebookLM, ale baza powinna pozostac zrodlem operacyjnym: latwiej filtrowac po dacie, tagach, zrodle i uzyciu w postach.

Plan wdrozenia: `docs/content-intelligence-rss-n8n-plan.md`.
