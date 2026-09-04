# Status agentów i workerów względem silnika V2

Stan audytu: **2026-08-10**. Dokument obejmuje Meta Front, legacy Meta, Lane Orchestrator,
wszystkich agentów zarejestrowanych w Mastra, agentów workflow-only, dynamiczne profile workerów,
pseudo-subagentów Coding oraz workerów wykonawczych i infrastrukturalnych.

## Werdykt w jednym miejscu

- **Formalnie zmigrowanych/cutover agentów: 0.** Legacy nadal jest autorytatywną ścieżką ruchu.
- V2 jest uruchomione **addytywnie**. Lokalna allowlista wystawia osiem capability:
  `researcherAgent`, `chefAgent`, `contentAgent`, `writerAgent`, `analyticsAgent`,
  `deliberationAgent`, `crmAgent`, `designAgent`.
- **Meta Front i Lane Orchestrator mają realne dowody live**, ale nie zastąpiły legacy Meta i nie
  oznaczają produkcyjnego rolloutu domen.
- V2 pobiera ten sam zarejestrowany obiekt przez `mastra.getAgent(...)`, więc nie tworzy okrojonej
  kopii agenta. Zachowuje jego zadeklarowane tools, pamięć i input processors.
- To daje **parytet powierzchni tools**, nie dowód poprawnego użycia. Harness używa fazy `chat`,
  której filtr fazowy nie rozpoznaje i dlatego fail-open udostępnia cały zadeklarowany toolset.
- V2 **nie przydziela automatycznie skilli**. Agent musi mieć poprawnie podłączone
  `skill_search` i `skill_load`, albo rodzic musi przekazać dokładną nazwę skilla do
  `system_run_worker`.
- Poprawny, sprawdzalny kontrakt wyszukiwania i ładowania skilli mają obecnie: `knowledgeAgent`,
  `n8nMcpEngineer`, `codeReviewAgent`, `securityReviewAgent` i `performanceReviewAgent`.
- `researcherAgent`, `codingAgent`, legacy `metaAgent`, `automationArchitect` i
  `capabilitySmith` mają co najmniej częściowy **camelCase/snake_case mismatch**. Nie wolno
  zaliczać im pełnego skill parity bez poprawki i testu.
- Najmocniejszy live proof domenowy ma `designAgent`. `crmAgent` ma najprostszy i najmocniejszy
  parytet strukturalny. Writer dowiódł earned-time i fail-closed, ale nie ukończył pełnego briefu.
- Pierwszy krok F6 — bridge `async-delegation` do durable jobs — jest zacommitowany i ma
  izolowany dowód restartu. `FEATURE_ORCHESTRATION_V2_DELEGATION` nadal nie występuje w `.env`,
  więc aktywny runtime pozostaje na legacy; nie jest to migracja żadnego agenta ani rollout.

## Jak czytać status

| oznaczenie | znaczenie |
|---|---|
| ✅ | kontrakt ma adekwatną bramę, a gdy zaznaczono LIVE także realny canary |
| 🟡 | częściowo przygotowane; brakuje świeżego live, pełnego parity albo ważnej części kontraktu |
| ⬜ | istnieje w legacy/rejestrze, lecz nie było właściwego canary przez lane V2 |
| 🔴 | znana luka bezpieczeństwa, izolacji albo kontraktu blokuje uczciwe uznanie za gotowe |
| `PASS` | deterministyczny check, nie model/live |
| `LIVE` | realny model i ścieżka V2 |
| `PRE-FIX` | canary wykonano przed późniejszą poprawką; potrzeba świeżego powtórzenia |
| `N/D` | brak tools/skilli jest celowy dla danej roli |

## Kompletność spisu

| grupa | liczba | uwaga |
|---|---:|---|
| zarejestrowani agenci legacy | 29 | manifest nadal raportuje `migratedCount: 0` |
| nowy, warunkowo rejestrowany Meta Front | 1 | tylko gdy właściwe flagi V2 są włączone |
| Lane Orchestrator | 1 | osobny Agent, celowo poza rejestrem specjalistów |
| agenci workflow-only | 5 | realne instancje Agent, lecz poza rejestrem i Agent Board |
| dynamiczne profile | 21 | 13 run_worker + planner + 6 deliberation + skillDistiller |
| razem konkretnych Agentów i profili | **57** | 36 instancji Agent + 21 profili dynamicznych |
| pseudo-role Coding | 4 | nie są osobnymi Agentami; wszystkie uruchamiają `codingAgent` |
| łącznie logicznych tożsamości/rol | **61** | bez workerów czysto infrastrukturalnych |

Źródła bazowego spisu: `src/mastra/orchestration/coverage/manifest-data.ts`,
`src/mastra/config/agent-board.ts` i composition root w `src/mastra/index.ts`.

## Skills i wyszukiwanie narzędzi

Mastra wystawia nazwę toola według **klucza obiektu tools**, nie tylko jego wewnętrznego `id`.
Dlatego wpis `{ skillSearchTool }` daje nazwę `skillSearchTool`, natomiast prompt proszący o
`skill_search` oczekuje aliasu `{ skill_search: skillSearchTool }`.

| agent/mechanizm | skill search/load | tool discovery | werdykt |
|---|---|---|---|
| `knowledgeAgent` | poprawne `skill_search`, `skill_load`, `skill_report_result` | `ToolSearchProcessor` dla NotebookLM | ✅ poprawny kontrakt |
| `n8nMcpEngineer` | poprawne snake_case search/load/report | stałe read-only MCP n8n | ✅ poprawny kontrakt |
| `codeReviewAgent` | poprawne snake_case search/load | stały read-only reviewer toolset | ✅ poprawny kontrakt |
| `securityReviewAgent` | poprawne snake_case search/load | stały read-only reviewer toolset | ✅ poprawny kontrakt |
| `performanceReviewAgent` | poprawne snake_case search/load | stały read-only reviewer toolset | ✅ poprawny kontrakt |
| `researcherAgent` | zarejestrowane camelCase, prompt mówi snake_case | stałe web/browser tools | 🟡 wiring istnieje, nazwa niezgodna |
| `codingAgent` | camelCase search/load/report | stałe coding tools | 🟡 wiring istnieje, nazwa niezgodna |
| legacy `metaAgent` | search-only pod camelCase | `ToolSearchProcessor` dla szerokiej puli | 🟡 wyszukiwanie tools działa, generic skill contract niepotwierdzony |
| `automationArchitect` | systemowe search/load/report pod camelCase | `architect_skills_search` + ToolSearch dla background tasks | 🟡 domenowe search działa, generic skill contract niepełny |
| `capabilitySmith` | search-only pod camelCase | stałe MCP/build tools | 🟡 brak poprawnego search/load parity |
| `system_run_worker` | brak search; programowo ładuje dokładne nazwy przekazane przez rodzica | celowo bez tools | 🟡 named injection, nie discovery |
| pozostałe agenty | brak generic skill tools | statyczny, kuratorowany toolset | N/D lub brak parity; V2 niczego nie dodaje magicznie |

Wśród aktualnej allowlisty ośmiu capability żaden agent nie ma dziś jednocześnie potwierdzonego
poprawnego snake_case `skill_search` + `skill_load`. Researcher ma oba logiczne tools, lecz wymaga
naprawy aliasów i testu. Dla pozostałych siedmiu brak generic skills jest taki sam jak w ich
obiekcie legacy, ale nie jest to „pełny dostęp do wszystkich skilli platformy”.

## Control plane: Meta Front, Meta i Lane Orchestrator

| element | tools / skills | przygotowanie i dowód | status V2 |
|---|---|---|---|
| legacy `metaAgent` | szeroki supervisor; ToolSearch dla dużej puli; skill search-only z alias mismatch; durable job tools za flagami | legacy nadal obsługuje delegację; działał jako pierwszy konsument durable job tools | 🟡 nadal autorytatywny legacy, nie cutover |
| `metaFrontAgent` | dokładnie 10 komend durable job; brak narzędzi domenowych i skilli by design | `check:meta-front-agent`; LIVE: odpowiedź ~1,6 s z `jobId`, późniejszy wynik w tej samej rozmowie | ✅ addytywny front; nie zastąpił legacy Meta |
| `laneOrchestratorAgent` | celowo zero tools, pamięci i skilli; zwraca tylko typed proposal | typed validation/fallback/alert, request_user i final decision; LIVE flat-SERIAL zakończony bez alertów | ✅ dla obecnego flat-SERIAL; brak pełnego fan-out/fan-in i final reserve |

## Wszystkich 18 agentów domenowych z Agent Board

Status „aktywny” oznacza osiągalność przez obecną allowlistę V2, a nie migrację/cutover.

| agent | V2 / dowód | tools w V2 | skills | uczciwy status |
|---|---|---|---|---|
| `marketingAgent` | poza allowlistą; brak canary V2 | ten sam szeroki CRM/Gmail/Calendar/RSS/NotebookLM toolset, także mutacje | brak | ⬜ opt-in; parity i bezpieczeństwo efektów nieudowodnione |
| `salesAgent` | poza allowlistą; brak canary V2 | CRM writes, Gmail draft, Calendar | brak | ⬜ opt-in; efekty zewnętrzne bez V2 proof |
| `analyticsAgent` | aktywny; `check:analytics-domain` PASS; live tylko sprzed portu | read-only collectory CRM/RSS/workflow + n8n/context/performance | brak | 🟡 PRE-FIX/PRE-PORT; brak persistence reports/signals jest świadomie odroczony |
| `automationArchitect` | poza allowlistą; mocne testy legacy, brak lane canary | szeroki Golden Path/deploy/test/repair + ograniczony ToolSearch | generic alias mismatch; domenowy search działa | ⬜/🟡 system-mutating; durable Golden Path/cancel dopiero F6 |
| `n8nMcpEngineer` | helper Automation; `check:n8n-mcp-engineer`, brak lane canary | siedem read-only MCP n8n | poprawne search/load/report | 🟡 dobry helper, lecz nie powinien omijać Automation jako direct target |
| `knowledgeAgent` | poza allowlistą; brak rozstrzygającego V2 canary | NotebookLM + ToolSearch + artifacts | poprawne search/load/report | 🟡 poprawny wiring, zależność zewnętrzna NLM i brak live proof |
| `crmAgent` | aktywny; live PRE-FIX; `check:crm-domain` PASS po poprawce | dokładnie read-only `searchLeadsTool`, jak w legacy | brak | ✅/🟡 najmocniejszy structural parity; potrzebny świeży post-fix live |
| `codingAgent` | poza allowlistą; brak V2 canary | pełny worktree/ledger/test/command/review toolset | alias mismatch | 🔴 headless approval może czekać bez człowieka; pseudo-role nie są izolowane |
| `deliberationAgent` | aktywny; live PRE-FIX; post-fix `check:deliberation-domain` PASS | własny worker/gate/artifact pipeline | brak | 🟡 brak świeżego live; nested workers mogą dziedziczyć Workspace |
| `researcherAgent` | aktywny i domyślny; wiele LIVE, w tym Saga 3840 znaków | Tavily/extract/browser/Firecrawl/artifacts/memory | search/load alias mismatch | ✅/🟡 mocny live tools; brak poprawnego skill aliasu i paired legacy-quality gate |
| `chefAgent` | aktywny; LIVE Menu Book 5218 znaków; headless/normalizer checks PASS | pełne state/document/recipe/FlavorDB + worker/delegation | brak direct | ✅/🟡 mocny deliverable; poprawka normalizacji bez świeżego live/full paired audit |
| `contentAgent` | aktywny; LIVE po checkpoint fix 7/8, 28 KB; domain check PASS | content state/doc/quality/signals/exemplars + worker/delegation | brak direct | 🟡 znany run bez dokumentu i brak pełnego weekly-content parity |
| `huntAgent` | poza allowlistą; checkpoint PASS, brak canary | CRM/Gmail/search/NLM/state/doc + worker/delegation | brak direct | ⬜ external mutation; gotowy-niewysłany raport, lecz brak V2 parity proof |
| `designAgent` | aktywny jawnie w `.env`; domain/deliverable PASS; LIVE 16 723 znaków + plik + visual QA | writer/generation/export/visual QA + worker/delegation | brak direct | ✅ najsilniejszy addytywny proof; formalny cutover nadal 0 |
| `writerAgent` | aktywny; domain/receipt/progress PASS; LIVE earned-time 2×5 min, 4760 słów, bez U+2014 | bogate doc/state/audit/research + worker/delegation | brak direct | 🟡 fail-closed działa; brief/critic nie przeszedł, brak drugiego live po hardeningu |
| `filmmakerAgent` | poza allowlistą; domain/deliverable PASS, brak V2 canary | state/canon/validator/generation + worker/delegation | brak direct | ⬜ najpierw dry text; płatny canary tylko za zgodą |
| `capabilitySmith` | poza allowlistą; legacy build/CGP gates, brak V2 canary | MCP discover/sandbox/attach/build | search-only alias mismatch | ⬜/🟡 system-mutating; brak parity proof |
| `musicianAgent` | poza allowlistą; domain/deliverable PASS, brak V2 canary | state/lyrics/prompt/validator/paid generation + worker/delegation | brak direct | ⬜ najpierw dry text; płatny canary tylko za zgodą |

## Zarejestrowani agenci poza Agent Board

Te 11 pozycji razem z powyższymi 18 daje wszystkie 29 pozycji manifestu legacy.

| agent | rola i tool surface | skills | status względem V2 |
|---|---|---|---|
| `metaAgent` | legacy supervisor; opisany w control plane | search-only alias mismatch | 🟡 legacy authority, migration 0 |
| `weatherAgent` | pojedynczy weather tool | brak | ✅ historyczny walking-skeleton LIVE/E2E; dowód substratu, nie domenowego cutoveru |
| `producerHuntDiscoveryAgent` | helper discovery z całym `marketingTools` | brak | 🔴 raw legacy worker, brak izolacji roli i V2 lineage |
| `producerHuntEnrichmentAgent` | helper enrichment z całym `marketingTools` | brak | 🔴 jw. |
| `producerHuntEmailExtractionAgent` | helper extraction z całym `marketingTools` | brak | 🔴 jw. |
| `producerHuntDraftAgent` | helper draft z całym `marketingTools` | brak | 🔴 jw. |
| `producerHuntJsonRepairAgent` | helper JSON repair z całym `marketingTools` | brak | 🔴 jw. |
| `producerHuntCloudFallbackAgent` | helper fallback z całym `marketingTools` | brak | 🔴 jw. |
| `codeReviewAgent` | read-only diff/read/artifact/submit/Graphify/search | poprawne search/load | 🟡 dobry wiring, brak niezależnego lane canary |
| `securityReviewAgent` | read-only reviewer tools | poprawne search/load | 🟡 dobry wiring, brak potwierdzonego callera/live V2 |
| `performanceReviewAgent` | read-only reviewer tools | poprawne search/load | 🟡 dobry wiring, brak potwierdzonego callera/live V2 |

Producer Hunt uruchamia helpery przez raw `agent.generate()` bez `toolChoice: 'none'`. Wąskie role
JSON/extraction/repair mogą więc zobaczyć cały CRM/Gmail/Calendar/NotebookLM toolset. To jest realna
luka least-privilege niezależna od samego V2.

## Pięciu agentów workflow-only

Każdy jest prawdziwą instancją Agent, ale nie jest w `new Mastra({ agents })`, Agent Board ani V2.

| agent | rola | tools / skills | status |
|---|---|---|---|
| `weeklyContentResearchAgent` | research tygodnia | posiada szeroki `marketingTools`, brak skilli; call wymusza `toolChoice:none` | 🟡 bezpieczny no-tool generator legacy, migration 0 |
| `weeklyContentCopyAgent` | polski copy | jw. | 🟡 jw. |
| `weeklyContentCopyRepairAgent` | naprawa copy | jw. | 🟡 jw. |
| `weeklyContentTranslationAgent` | tłumaczenie EN | jw. | 🟡 jw. |
| `weeklyContentJsonRepairAgent` | naprawa JSON | jw. | 🟡 jw. |

## Wszystkich 13 presetów `system_run_worker`

Wspólny kontrakt: worker jest text-only dzięki wyłączeniu Workspace; nie ma tools ani własnego
`skill_search`. Może programowo załadować dokładne nazwy skilli przekazane przez rodzica. Działa
wewnątrz attemptu rodzica, bez własnego durable job/task/attempt/lease. `allowedTools` jest tylko
tekstem w promptcie, nie whitelistą runtime.

| profil | zastosowanie | skill/tool parity | status |
|---|---|---|---|
| `fast` | klasyfikacja/ekstrakcja/format | named skill injection, zero tools | 🔴 przypięty model oznaczony jako deprecated/decommissioned |
| `default` | ogólny tekst/streszczenia | jw. | 🔴 przypięty model oznaczony jako deprecated/decommissioned |
| `reasoning` | analiza i planowanie | jw. | 🟡 text-only, brak samodzielnego V2/live skill proof |
| `powerful` | trudny reasoning/long-form | jw. | 🟡 jw. |
| `cloud` | cloud fallback | jw. | 🟡 jw. |
| `design` | warianty frontend/design | jw. | 🟡 wiring domeny sprawdzony, brak osobnego worker canary |
| `film` | prompty/critique/repair filmu | zero tools; nie ma domain reference tools rodzica | 🟡 nested only |
| `music` | lyrics/style/hook/track variants | zero tools; nie ma domain reference tools rodzica | 🟡 nested only |
| `writer_critic` | recenzja struktury i jakości | final review zabrania outer skill modifiers | 🟡 mocne receipts; live critic był czerwony 72/false |
| `writer_reader` | symulacja czytelnika | jw. | 🟡 brak osobnego live po hardeningu |
| `writer_muse` | warianty twórcze | zero tools/skilli | 🟡 opcjonalny, brak osobnego live |
| `writer_chronicler` | canon/continuity | zero tools/skilli | 🟡 brak pełnego live roli |
| `writer_polisher` | polish i anti-slop | final review zabrania outer skill modifiers | 🟡 poprawki po canary tylko deterministyczne |

Dodatkowa luka Writera: pięć plików `prompts/writer/workers/*.md` nie jest ładowanych przez runtime.
Worker dostaje hardkodowany `taskSpec`, schema i scope. Check sprawdza zawartość tych plików, ale
nie dowodzi ich injection. Receipt-bound critic/reader/polisher mają natomiast mocny kontrakt
snapshotu, roli, `reviewRevision` i jednorazowego wyniku.

## Pozostałych osiem profili dynamicznych

| profil | tools / skills | trwałość i dowód | status |
|---|---|---|---|
| `system_plan_task:planner` | `toolChoice:none`, max 1 krok, brak skilli | lokalny bounded timeout i retry pustego wyniku; nie jest durable child | ✅ dla roli helpera, migration 0 |
| `run_deliberation_worker:systemsArchitect` | deklarowane no-tools/no-memory, lecz Agent dziedziczy `mastra` | nested proposal | 🔴 brak `workspace:()=>undefined` i `toolChoice:none` |
| `run_deliberation_worker:llmEngineer` | jw. | nested proposal | 🔴 jw. |
| `run_deliberation_worker:redTeamCritic` | jw. | critique i second critique | 🔴 jw. |
| `run_deliberation_worker:creativeStrategist` | jw. | nested proposal | 🔴 jw. |
| `run_deliberation_worker:memoryArchitect` | jw. | nested proposal | 🔴 jw. |
| `run_deliberation_worker:synthesisPlanner` | jw. | nested synthesis | 🔴 jw. |
| `nightly_skill_cycle:skillDistiller` | standalone text Agent, bez tools/skill search | tworzy SKILL.md przez serwis, potem odświeża registry | ✅ dla maintenance, nie jest V2 child |

Deliberation ma dobry test kolejności ról/faz, pustego outputu i abort forwarding, ale test nie
sprawdza braku odziedziczonych Workspace tools. Dlatego parent może być 🟡, a jego deklarowane
text-only workery pozostają 🔴 do czasu runtime isolation gate.

## Cztery pseudo-role Coding

Nie są czterema Agentami. Każda ścieżka uruchamia ten sam pełny `codingAgent`.

| rola | deklaracja | rzeczywisty runtime | status |
|---|---|---|---|
| `file-editor` | ograniczone read/LSP/write/artifacts + `safe-file-edit` | pełny `codingAgent`; allowlista tylko w promptcie, role skill nieładowany | 🔴 brak enforcementu |
| `terminal` | read + test + `run-verification` | pełny `codingAgent`, także write i external commands | 🔴 brak enforcementu |
| `qa` | read/test/artifacts/Playwright + dwa skille | pełny `codingAgent`, bez Playwright, za to z write/command tools | 🔴 deklaracja ≠ runtime |
| `researcher` | Workspace/Tavily/Playwright + dwa skille | pełny `codingAgent`, bez Tavily/Playwright; to nie `researcherAgent` | 🔴 deklaracja ≠ runtime |

`role.allowedTools`, `role.skills`, `defaultModelTier` i `promptTemplate` nie sterują wykonaniem.
Executor wykonuje zamiast tego semantic `registry.search()` i ładuje jeden najlepszy skill,
niekoniecznie skill przypisany do roli. Nie ma dedykowanego testu izolacji tych czterech ról.

## Workerzy wykonawczy V2

| komponent | co wykonuje | status |
|---|---|---|
| store queue worker | claim, lease, heartbeat, fence, abort i atomowy submit fixture | ✅ zweryfikowany substrat |
| registry worker + full harness | ten sam zarejestrowany Agent z jego tools/skills/processors | ✅ właściwa ścieżka; `check:v2-harness-worker` i live contrast |
| bare registry caller | raw `agent.generate()` | 🔴 bez depth/reflector/liveness/tool fence; nie używać dla realnych capability |
| supervised process worker | serializowany subprocess, owner/heartbeat/TERM/KILL/tree receipt | ✅ substrat opt-in; nic domenowego nie zostało na niego zmigrowane |
| deterministic `drainLane` | store-only reducer, bez modelu/tools/skilli | ✅ właściwe by design |
| durable delegation bridge F6 | opt-in zastępuje fire-and-forget `async-delegation` durable jobem | 🟡 krok 1/5 zacommitowany i live-verified w izolacji; flaga absent/OFF, zero migracji agentów |

Process worker nie współpracuje z progressive earned-time Writera; composition root używa obecnie
in-process registry workera. Konfiguracja fail-fast zabrania połączenia process workera z polityką
progressive attempt.

## Workerzy infrastrukturalni, które nie są Agentami

| worker | funkcja | relacja do skills/tools/V2 |
|---|---|---|
| periodic `health` | RAM/disk/GPU/uptime co 5 min | brak Agent/tools/skills; nie podlega migracji domenowej |
| periodic `models` | dostępność modeli co 10 min | jw. |
| periodic `cache` | cleanup background tasks co 60 min | jw. |
| periodic `telemetry` | agregacja error rate co 30 min | jw. |
| periodic `memory` | knowledge extraction co 15 min | jw. |
| Semantic Memory Worker | embedding + Mongo po turze harnessu | feature-gated funkcja, nie Agent/V2 child |
| Scheduled Task Runner | WORKER/AGENT/workflow/n8n dispatch | osobna legacy/raw ścieżka; tylko aliasy `noop`, `echo_payload`, `fail` są deterministyczne |
| lane/reconciler/timer/conversation loops | prowadzą trwały lifecycle V2 | control-plane bez modelowych skilli/tools |

## Bramy i dowody, które rzeczywiście istnieją

### Wspólne dla silnika i routingu

- `check:agent-board-sync` — wszystkie 18 kart, rejestracja, modele i deklaracje tooli Boardu.
- `check:capability-routing` — allowlista i routing; część durability wymaga replica set.
- `check:v2-harness-worker` — reflector, stop, memory, abort fence i pełny output.
- `check:headless-contract` oraz `check:headless-checkpoints` — kontrakt wszystkich tras Boardu i
  skan pipeline prompts.
- `check:meta-front-agent`, `check:lane-decision`, `check:lane-decider-model`.
- Live contrast: ten sam przypadek przez bare worker kończył empty output, przez harness zakończył
  się `COMPLETED`.

### Najmocniejsze dowody domenowe

| capability | deterministic | live | czego nadal nie dowodzi |
|---|---|---|---|
| Design | design-domain + deliverable | pełny HTML, plik i visual QA | formalnego cutoveru |
| Researcher | wspólny harness/routing | wiele zadań, w tym Saga | poprawnego generic skill aliasu i paired quality parity |
| CRM | crm-domain | lookup PRE-FIX | świeżego post-fix zachowania |
| Chef | headless + ingredient normalizer | Menu Book | świeżego live po normalizerze/full paired parity |
| Content | content-domain + checkpoint | 7/8, 28 KB | niezawodnego zawsze-persistowanego dokumentu/full legacy parity |
| Writer | writer domain/receipts/progress | earned-time i fail-closed | pełnego briefu i pętli workerów po hardeningu |
| Analytics | analytics-domain | tylko stary telemetry canary | current collector portu i legacy persistence/signals |
| Deliberation | ordered domain pipeline | tylko PRE-FIX parent | izolacji nested workers i świeżego post-fix outputu |

## Kolejność domykania

1. Naprawić i przetestować aliasy `skill_search`/`skill_load`, zaczynając od Researchera oraz
   dodać kontrakt, który sprawdza **nazwy z `listTools()`**, nie tylko wewnętrzne tool IDs.
2. Odizolować sześć deliberation workers (`workspace: async () => undefined`, wymuszone no-tool)
   i dodać kontrolę negatywną.
3. Wymusić realne tool/skill/model/prompt contracts czterech ról Coding; dopiero potem rozwiązać
   headless approval i dopuścić Coding do V2.
4. Ograniczyć Producer Hunt helpery do ich rzeczywistych ról albo wymusić `toolChoice:none`.
5. Zastąpić zdeprecjonowane modele presetów `fast` i `default`.
6. Wykonać świeże, celowane post-fix canary dla CRM, Deliberation i Analytics; dla Writera tylko
   przy nowej hipotezie, bo ostatni płatny canary już dowiódł fail-closed.
7. Dopiero po ukończeniu F6/F7, topology/fault suite i jawnej decyzji operatora można mówić o
   cutoverze lub rollout. Obecne PASS/LIVE są dowodem przygotowania addytywnego, nie migracji.

## Źródła prawdy

- `src/mastra/orchestration/coverage/manifest-data.ts` — bazowe 29 + 5 + 21 i `migratedCount`.
- `src/mastra/config/agent-board.ts` — 18 routowalnych kart domenowych.
- `src/mastra/config/capability-routing.ts` — allowlista/default/routing.
- `src/mastra/index.ts` — faktyczna rejestracja Meta Front i composition root workerów.
- `docs/ORCHESTRATION-V2.md` — kontrakty silnika i dowody.
- `ideas/plan-dziecko-po-odlozeniu-g0.md` — dziennik canary i decyzji.
- `docs/PROMPT-INSTANCJA-POROWNANIE-LEGACY-V2.md` — stan audytów domenowych.
