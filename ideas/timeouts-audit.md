# Audyt budżetów czasu, kroków i retry — mapa kolizji

Stan: 2026-07-22, branch `fix/delegation-depth-hardening`.
Zakres: wszystkie limity czasu / kroków / retry / pollingu w `agentic-agents`.
Charakter: audyt diagnostyczny. Bez zmian w kodzie.

---

## 0. Wnioski

1. **Najbardziej zewnętrzny limit systemu jest niewidoczny w Twoim kodzie.** `@mastra/deployer` zakłada `app.use("*", timeout(server?.timeout ?? 3*60*1e3))` — **180 s twardego 504 na każdy request HTTP** do :4111. Nie ma go w `.env`, w `.env.example`, w `deploy.config.json`, w żadnym docu ani w `src/mastra/index.ts:107` — jedynym miejscu, gdzie dałoby się go nadpisać. **Wszystkie budżety powyżej 180 s są nieosiągalne po nie-streamingowym HTTP**: deep/critical 300 s, film/music poll 600 s, automation delegation 1200 s.
2. **Nie ma jednego źródła prawdy.** Limity siedzą w 8 niezależnych warstwach, każda z własną jednostką i własnym „bezpiecznym" numerem. `src/mastra/config/` nie ma pliku `budgets.ts` — bo nigdy go nie było.
3. **Warstwy nie znają się nawzajem.** Jedyny mechanizm koordynacji (`resolveDelegationBudget`, P2 z 22.07) obejmuje ~połowę ścieżek delegacji; reszta ma zaszyte liczby większe od budżetu rodzica.
4. **Rezultat, który widzisz jako „kolizje":** procesy-sieroty (dziecko żyje dłużej niż rodzic), martwe dźwignie (limit, który matematycznie nie może zadziałać), kłamliwe deklaracje (model dostaje „masz 300 s", ginie po 210 s) i trzy martwe zmienne w `.env`, które nic nie robią.

---

## 1. Mapa warstw — sufity od zewnątrz

```
L0  Cloudflare edge                    100 s → 524   ⚠ nieuwzględnione nigdzie w repo
     (tylko ścieżka n8n.gastrobridge.com → n8n :5678 → HTTP Request → Mastra :4111)
L1  Hono timeout w @mastra/deployer    180 s → 504   ⚠ NIEWIDOCZNE, niekonfigurowalne env-em
L2  Node server.requestTimeout         300 s → 408   (default Node, nieustawiane)
L3  harness wall-clock                 60 / 180 / 300 s   (profil głębokości)
L4  delegate-task                      min(240 / 900 / 1200 s, parentRemaining − 20 s)
L5  agent.defaultOptions.maxSteps      10-150 kroków      (martwe pod harnessem)
L6  narzędzie                          3 s – 1800 s       (AbortSignal / exec / poll deadline)
L7  proces potomny                     python / ffmpeg / playwright / git
L8  zdalne API                         fal / ElevenLabs / n8n / MCP
```

Reguła, której system **nie** przestrzega: budżet warstwy N musi być ≤ budżetowi warstwy N−1.
Dziś zależność jest odwrócona w co najmniej pięciu miejscach: L4 (1200 s) > L3 (300 s) > L2 (300 s) ≈ L1 (180 s) > L0 (100 s), a L6 potrafi mieć 1800 s.

Łagodząca okoliczność dla L0: **Mastra :4111 nie jest tunelowana** — tunel wystawia wyłącznie n8n :5678. 100 s bije więc tylko na ścieżce publiczny webhook → n8n → HTTP Request → Mastra. Ta ścieżka jest żywa (`MASTRA_API_URL_FOR_N8N`, `LEDGER_PUSH_WEBHOOK_URL`).

Furtka, o której nikt nie wie: Hono `timeout()` to `Promise.race([next(), timer])`. Odpowiedź **streamingowa** rozwiązuje `next()` w momencie wysłania nagłówków, więc timer gaśnie i strumień może biec dalej. Czyli `/api/agents/:id/stream` **przeżywa** 180 s, a `/api/agents/:id/generate` i **wszystkie** własne route'y w `index.ts` — nie. Nic w repo tego nie dokumentuje ani na tym nie polega.

---

## 2. L1/L2 — agent i harness

### Profile głębokości (`services/depth-controller.ts:100-193`)

| poziom | maxSteps | wall-clock | ctx tokens | maxStepsWithoutProgress | warmup |
|---|---|---|---|---|---|
| fast | 10 | 60 s | 4 k | 8 | 2 |
| standard | 25 | 180 s | 16 k | **25 (= maxSteps)** | 5 |
| deep | 40 | 300 s | 32 k | 20 | 3 |
| critical | 40 | 300 s | 32 k | 15 | 2 |

### `defaultOptions.maxSteps` na agentach — w większości martwe

| wartość | agenci | status |
|---|---|---|
| 150 | chef, content, hunt, writer, film, musician, **design** | żywe tylko dla 6 pipeline'owych; design idzie inną ścieżką |
| 50 | researcher | żywe (direct generate) |
| 40 | meta, coding, automation, knowledge, deliberation | **nadpisywane** przez harness (10/25/40) |
| 24 | n8nMcpEngineer, capabilitySmith | n8nMcpEngineer nadpisywany przez `N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS` (8) |

`generate-with-harness.ts:742` wstrzykuje `maxSteps: getEffectiveProfile(runId).maxSteps` **przed** spreadem opcji wywołującego. Dla agentów pod harnessem liczba na agencie nie ma żadnego znaczenia.

Dwa równoległe reżimy kroków:
- **harness**: 10/25/40 kroków, twardy wall-clock
- **pipeline** (`generate-pipeline-with-reflection.ts`, świadomie bez depth controllera): 150 kroków, **zero** własnego wall-clocka — ogranicza je wyłącznie timeout delegacji z L3

---

## 3. L3 — delegacja (`tools/system/delegate-task.ts`)

| knob | default | env | capped by parent? |
|---|---|---|---|
| `DEFAULT_DIRECT_DELEGATION_TIMEOUT_MS` | 240 s | `DELEGATION_DIRECT_TIMEOUT_MS` | tak |
| `DEFAULT_FILMMAKER_DELEGATION_TIMEOUT_MS` (film + musician) | 900 s | `DELEGATION_FILMMAKER_TIMEOUT_MS` | tak → w praktyce ≤280 s |
| `DEFAULT_AUTOMATION_DELEGATION_TIMEOUT_MS` | 1200 s | `DELEGATION_AUTOMATION_TIMEOUT_MS` (**ustawione w .env**) | **NIE** |
| coding sync/async | **300 s zaszyte** | — | **NIE** |
| knowledge sync/async | **300 s zaszyte** | — | **NIE** |
| `SYNC_SAFETY_MARGIN` | **120 s** (było 20 s, podniesione 2026-08-24) | `DELEGATION_SYNC_SAFETY_MARGIN_MS` | — |
| `MIN_VIABLE_SYNC` | 60 s | `DELEGATION_MIN_VIABLE_SYNC_MS` | — |
| async lane (generic) | 240/900 s, celowo bez capa | — | nie (z założenia) |

Trzy różne semantyki słowa „timeout" w jednym pliku:
- `generateWithAbortableTimeout` — **przerywa** pracę dziecka (AbortController)
- `withDelegationTimeout` — tylko odrzuca obietnicę, dziecko biegnie dalej (ścieżka pipeline)
- harnessowe `withTimeout` — przerywa, ale tylko własne wywołanie LLM

`HarnessGenerateInput.abortSignal` istnieje, ale `delegate-task` **nigdy** go nie przekazuje w dół. Sygnał przerwania nie przechodzi przez granicę delegacji.

---

## 4. POTWIERDZONE KOLIZJE

### Krytyczne (produkują sieroty albo gwarantowany timeout)

**K1 — upgrade głębokości zwiększa kroki, nie czas.**
`setRunDeadline` wołany raz (`generate-with-harness.ts:223`) z profilu początkowego. `upgradeRunDepth` (reflektor, `strategy-reflector.ts:1427/1429`) podnosi `maxSteps` 10→40, ale deadline zostaje na 60 s. Run po eskalacji ma 4× kroków w tym samym oknie czasu — czyli eskalacja pogarsza sytuację zamiast pomagać.

**K2 — pipeline: 150 kroków w oknie ≤240 s.**
Chef/content/hunt/writer/film/musician mają 150 kroków bez własnego zegara, a delegacja daje im ≤240 s (realnie 100–280 s po capie rodzica). 150 kroków w 240 s jest fizycznie nieosiągalne. Te agenty **zawsze** kończą timeoutem delegacji, nigdy step capem. Deklarowany limit 150 jest fikcją.

**K3 — automation 1200 s pod rodzicem 300 s.**
`generateAutomation({timeoutMs: 1_200_000})` (`delegate-task.ts:489`) omija `resolveDelegationBudget`. Meta (deep) umiera po 300 s; dziecko biegnie dalej do 20 minut, mutując n8n i Mongo, bez nikogo, komu mogłoby zwrócić wynik. To dokładnie ta patologia, którą WS-A miał zlikwidować — tyle że WS-A działa tylko wewnątrz jednego poziomu.

**K4 — coding i knowledge: 300 s zaszyte, poza koordynacją.**
`delegate-task.ts:379, 408, 567, 593`. Ta sama patologia co K3, mniejsza skala. Trzy niezależne źródła prawdy dla jednego budżetu: stała zaszyta, `DELEGATION_DIRECT_TIMEOUT_MS`, i cap rodzica.

**K5 — rodzic `fast` = delegacja zawsze wypychana w tło. To jest kolizja nr 1.**
Rodzic fast ma 60 s. Zanim model zdecyduje się delegować, zostaje ~40–55 s; okno = remaining − 20 s ≈ 20–35 s; `viable` wymaga ≥60 s → **zawsze false** → `forcedAsync`.
Dla `standard` (180 s) dziecko dostaje ~130 s z deklarowanych 240 s (54 %). Dopiero `deep` daje pełne 240 s.

Klucz: **jak często trafiamy w `fast`?** Uruchomiony klasyfikator na typowych, naturalnych poleceniach:

| prompt | poziom | budżet | sync-delegacja |
|---|---|---|---|
| „zrób mi film promocyjny o restauracji" | fast | 60 s / 10 kr | NIEMOŻLIWA → async |
| „wygeneruj utwór muzyczny do reklamy" | fast | 60 s / 10 kr | NIEMOŻLIWA → async |
| „zrób grafiki na social media dla nowego dania" | fast | 60 s / 10 kr | NIEMOŻLIWA → async |
| „przygotuj rozdział książki o fermentacji" | fast | 60 s / 10 kr | NIEMOŻLIWA → async |
| „znajdź dostawców serów rzemieślniczych w Małopolsce i zrób z tego listę" | fast | 60 s / 10 kr | NIEMOŻLIWA → async |
| „popraw bug w delegate-task" | fast | 60 s / 10 kr | NIEMOŻLIWA → async |
| „Napisz post na LinkedIn o nowym menu" | fast | 60 s / 10 kr | NIEMOŻLIWA → async |
| „Deleguj to researcherowi" | fast | 60 s / 10 kr | NIEMOŻLIWA → async |
| „Zbadaj rynek producentów sera w Polsce" | standard | 180 s / 25 kr | ≤130 s |
| „Zbuduj automatyzację n8n do obsługi leadów" | deep | 300 s / 40 kr | ≤240 s |
| „zaprojektuj i zbuduj automatyzację…, przetestuj i wdroż na produkcję" | critical | 300 s / 40 kr | ≤280 s |

Przyczyna: `COMPLEX_KEYWORDS` (`depth-controller.ts:197`) zawiera `zaprojektuj|zrefaktoruj|zbuduj|przeanalizuj|zbadaj|zintegruj|zmigruj|przepisz|zoptymalizuj…`, ale **nie zawiera najczęstszych polskich trybów rozkazujących**: `zrób`, `wygeneruj`, `przygotuj`, `znajdź`, `napisz`, `popraw`, `stwórz`, `nagraj`, `zaplanuj`. Każde z nich, użyte w krótkim zdaniu, daje score < 0.15 → `fast`.

Czyli: **normalny sposób, w jaki mówi się do meta-agenta, trafia w profil, który konstrukcyjnie nie jest w stanie wykonać żadnej synchronicznej delegacji.** Domeny generatywne (film, muzyka, design, writer, content, hunt) — czyli dokładnie te, które budowałeś ostatnio — są tym dotknięte w 100 %.

Częściowa mitygacja: P1 (`FEATURE_DEPTH_THREAD_INHERITANCE`) dziedziczy ciężką głębokość, ale **tylko** dla krótkich komend kontynuacji (`CONTINUATION_COMMAND`, `depth-controller.ts:215`) i tylko gdy wątek już wcześniej biegł na deep/critical. Pierwsze polecenie w wątku nigdy nie skorzysta.

**K6 — model dostaje w prompcie nieprawdziwy budżet.**
Depth header (`generate-with-harness.ts:1741`) mówi dziecku „Timeout: 300 s" (jego własny profil), podczas gdy `delegate-task` zabije je po 210 s (cap rodzica). Model planuje pod liczbę, która nie obowiązuje.

**K7 — ogon po timeoucie jest poza budżetem.**
Po `callAgentGenerate` (jedynym miejscu objętym wall-clockiem) biegnie do 6 dodatkowych przebiegów LLM: reflection-repair, depth-upgrade-second-pass, auto-deliberation, auto-review, approval-gate, goal-completion-repair (`generate-with-harness.ts:406-535`). Każdy to `maxSteps: 1, toolChoice: 'none'`, ale **żaden nie ma timeoutu**. Margines 20 s w L3 zakłada, że ogon jest krótki — przy wolnym modelu lokalnym to minuty. Do tego precontext (900–1500 ms × kilka) przed wywołaniem.

### Poważne (martwe dźwignie i sprzeczne domyślne)

**K8 — `standard`: `maxStepsWithoutProgress` = 25 = `maxSteps`.**
Warunek to `stepNumber > 25` (`strategy-reflector.ts:773, 1050`), a run ma kroki 1–25. Nigdy nie zadziała. Dla `fast` (8 przy 10 krokach) prawie nigdy.

**K9 — designAgent: narzędzia 900 s, delegacja 240 s.**
`design_render_video`, `design_render_video_seek`, `design_convert_formats` domyślnie 900 s; `design_narrate_pipeline` 1800 s. `getDelegationTimeoutMsFor` (`delegate-task.ts:1379-1385`) zna wyjątek tylko dla filmmaker/musician — design dostaje 240 s. Agent ginie, a `execFileAsync` trzyma żywy proces Playwright/ffmpeg.

**K10 — `design_narrate_pipeline.timeoutMs` jest per-chunk, nie per-pipeline.**
Odczytany raz (`design-tools.ts:1583`), przekazywany do **każdego** chunku (`:1640`). 20 chunków × 1800 s = teoretyczny sufit 10 godzin. Nazwa i schemat (`max: 3_600_000`) obiecują ograniczenie całości.
Analogicznie `design_export_pdf` używa jednego odczytu przy dwóch `exec` (`:1330`, `:1357`) → realny sufit 2× deklaracji.

**K11 — deadline pollingu obchodzony przez fetch bez sygnału.**
`FILM_POLL_TIMEOUT_MS` / `MUSIC_POLL_TIMEOUT_MS` = 600 s wyglądają poprawnie, ale każdy tick pollingu (`film-generate.ts:250`, `music-generate.ts:306`) i pobranie pliku (`:265`, `:321`) używa `fetch` **bez AbortSignal**. Jedno zawieszone połączenie TCP sprawia, że pętla `while (Date.now() < deadline)` nigdy nie sprawdzi warunku — 600 s staje się nieskończonością. To samo w synchronicznym renderze ElevenLabs (`music-generate.ts:451`).

**K12 — MCP: jeden 180 s dla pięciu bardzo różnych serwerów.**
`mcp.ts:79` — wspólny `timeout: 180000` dla notebooklm SSE, **playwright**, firecrawl, gmail i context7. Pod delegacją 240 s dwa wywołania Playwrighta nie zmieszczą się nigdy.

**K13 — NotebookLM: cztery liczby dla jednej operacji.**
Narzędzie 120 s (`knowledge-tools.ts:29`) → klient robi z tego 130 s procesu (`notebooklm-client.ts:96`) → własny default klienta 60 s (`:71`) → `researchStart` 300/600 s (`:159`). Chef woła ten sam klient raz z 60 s (`chef-tools.ts:765`), raz ze 120 s (`:605`). A delegacja do knowledge jest zaszyta na 300 s, więc `deep research` (600 s) nie ma szans się zmieścić.

**K14 — trzy sprzeczne budżety Tavily.** 30/15 s (`tavily.ts:59`), 45/30 s (`:219`), 20 s (`business/competitor-analysis.ts:28`). To samo API, trzy niepowiązane liczby, żadna nie env-owalna.

**K15 — trzy rywalizujące narzędzia „wykonaj shell".**
`terminal-tools.ts:116` 15 s `execAsync` bez knoba · `meta-execute-command.ts:21-22` 30 s / max 120 s ze `spawn` i prawdziwym SIGKILL · `external-projects-tools.ts:79` 30 s przez **`execSync`**, który blokuje event loop Node na całe 30 s, zamrażając wszystkie równoległe agenty.

### Braki pokrycia (nieskończone czekanie)

**K16 — wywołania LLM bez żadnego timeoutu:** 9 gołych `agent.generate(prompt)` w `workflows/analytics/`, `workflows/marketing/`, `workflows/sales/`; `run-worker.ts:234`; wszystkie trzy nogi `producer-hunt/helpers.ts::generateJsonWithRepair`.

**K17 — HTTP bez AbortSignal:** `research/reviews-google-place.ts:90`, `lib/ollama-gateway.ts:13` (health probe modeli lokalnych!), `weather-tool.ts:45,56`, `weather-workflow.ts:48,60`, plus film/music z K11.

**K18 — 8 operacji git bez timeoutu** w `dev/code-worktree.ts` (`:104, :182, :195, :288, :301, :307, :534, :542`). Zawieszony `git merge` albo prompt o hasło blokuje codingAgent bez końca. `graphify-tools.ts` też nie przekazuje żadnego budżetu do `services/graphify.ts`.

### Fosylia — martwy kod i martwe zmienne

| element | dowód | komentarz |
|---|---|---|
| `META_AGENT_MAX_STEPS=40` w `.env:310` + `.env.example:403` | 0 odwołań w kodzie | relikt sprzed harnessu |
| `META_AGENT_SYNC_TIMEOUT_MS=45000` w `.env:311` + `.env.example:405` | 0 odwołań | ktoś kiedyś wierzył, że meta ma 45 s. Kto dziś tuninguje tym latencję meta — nie zmienia nic |
| `AUTOMATION_MAX_FIX_ATTEMPTS=3` w `.env:217` + `.env.example:388` | 0 odwołań | tylko w starych planach w `ideas/` |
| `waitForClaims` (`task-ledger-scheduler.ts:216`) | brak callerów produkcyjnych | niesie `DEFAULT_WAIT_MS` 15 min i `LEASE_TTL` 20 min |
| `waitForBackgroundTask` (`background-task-manager.ts:239`) | brak callerów | `MAX_WAIT_MS` 10 min |
| `HarnessGenerateInput.abortSignal` | nigdy nie ustawiany przez delegate-task | granica delegacji nie przenosi abortu |
| `attemptNumber` w `run-worker.ts:120`, `run-deliberation-worker.ts:44` | pole podawane przez model, brak licznika po stronie serwera | pozorna kontrola retry (kontrast: `repair-workflow.ts:73-84` liczy w Mongo) |
| `wait_timeout=120` / `timeout 180s` w `producer-hunt/discovery-prompts.ts:177,180` | proza w prompcie | nic tego nie egzekwuje |

Uwaga korygująca: `bg_task(action:'wait').timeoutMs` nie ma `.max()` w schemacie zod (`background-task-tool.ts:62`), ale warstwa serwisowa i tak przycina do 600 s (`background-task-manager.ts:242`). Luka jest kosmetyczna, nie funkcjonalna.

---

## 5. Kolizje warstwy infrastruktury

**I1 — 180 s HTTP vs 300 s deep/critical.** Klient dostaje 504, a run pali tokeny jeszcze 120 s bez odbiorcy. `docs/E2E-ORCHESTRATION-FINDINGS.md:13,168` opisuje dokładnie tę kaskadę, ale przypisuje ją budżetowi agenta — nie ścianie HTTP.

**I2 — 180 s HTTP vs `DELEGATION_AUTOMATION_TIMEOUT_MS=1200000`.** 20-minutowy build wywołany po HTTP w trybie sync (`FEATURE_AUTOMATION_ASYNC_DEFAULT=false`) **matematycznie nie może wrócić**. Jedyne, co dzieli tę konfigurację od gwarantowanego 504, to ten wyłączony flag.

**I3 — 180 s HTTP vs 600 s poll film/music.** Plus ElevenLabs (`music-surfaces.ts:100-110`) w trybie `sync-bytes` **bez żadnego poll timeoutu**, przy `lengthMs` do 600 000.

**I4 — `SWAP_TIMEOUT=30` zaszyte vs `healthCheck.timeoutMs=60000` z configu.** Okno po swapie jest połową okna przed swapem. Zimny start Mastry robi pełny `RepoIndexer.index()` + `SkillRegistry.initialize()` + `initModelAvailability()` + `ensureIndexes()` (`index.ts:2033-2067`), nic z tego nie jest ograniczone czasowo. Start wolniejszy niż 30 s → fałszywe „swap failed" na zdrowym procesie. To samo zaszyte 30 s w `promote-candidate.sh:96` i `rollback-to-stable.sh:54`.

**I5 — `curl` bez `--max-time` dokładnie w dwóch ścieżkach decydujących o rollbacku:** `deploy-blue-green.sh:305` i `watchdog.sh:203`. Każdy inny probe w repo jest ograniczony (4/5/8/10 s) — te dwa nie, i to one decydują o cofnięciu deploya.

**I6 — dwie niezależne władze rollbackowe o niekompatybilnej czułości.** `watchdog.sh` potrzebuje 3 × 30 s = 90 s pod rząd, a okno canary to 60 s. Degradacja objawiająca się przerywanymi błędami przechodzi canary i dopiero potem wywraca watchdoga. Obie piszą do tego samego `.deploy/autoheal-state.json`.

**I7 — dashboard poluje szybciej, niż serwer odpowiada, i bez żadnego timeoutu po stronie klienta.** 2 s (`analytics.js:1917`), 3 s (`index.html:3099`, `:3141`), a żaden `fetch` nie ma `AbortSignal.timeout`. `/dashboard/active-topology` robi w środku żywe `n8n.listWorkflows()` bez timeoutu — wewnątrz 3-sekundowego pollingu. Requesty piętrzą się w przeglądarce i trzymają handlery aż do ściany 180 s. `DASHBOARD_V2_CACHE_TTL_MS=15000` **nie obejmuje** tych endpointów — cache jest na `/dashboard/v2/*`, a szybki polling idzie na nieceache'owane surowe zapytania Mongo.

**I8 — `?limit` bez clampa na 8 endpointach** (`index.ts:241, 1067, 1144, 1174, 1196, 1327/1343, 1480/1603, 1709`). `?limit=10000000` potrafi trzymać handler do 180 s i wyOOM-ować proces. Dla kontrastu `:560` clampuje do 100, `:787` do 500.

**I9 — `process.exit(0)` na SIGTERM bez drenażu** (`index.ts:2078-2092`), podczas gdy `deploy-blue-green.sh:263-270` daje 10 s grace przed `kill -9`. Pętla grace to martwy kod: requesty i runy w locie są ucinane bez 503/Retry-After.

**I10 — split-brain stref czasowych.** n8n w kontenerze ma `Europe/Warsaw` (`docker-compose.yml:45`), a `AUTOMATION_DEFAULT_TIMEZONE=Atlantic/Reykjavik` (`.env:218`, UTC+0 bez DST). Crony pisane przez architekta i wykonywane przez n8n rozjeżdżają się o 1–2 h zależnie od DST.

**I11 — samoleczenie jest w praktyce rozbrojone, choć wygląda na włączone.** `ERROR_COLLECTOR_ENABLED=false` (`.env:294`, brak w `.env.example`, domyślna w kodzie to `true`), `AUTOHEAL_SUPERVISOR_ENABLED` domyślnie `false`, a `OBSERVE_ONLY` wymuszany na `true` niezależnie od env (`autoheal-supervisor.sh:241-243`). Przy tym `index.ts:198-234` nadal wystawia `/deploy/crash-test` i `/deploy/auto-heal-status`, a stan raportuje `"stable"`.

**I12 — duplikaty kluczy w `.env` (wygrywa ostatni).** `CHEF_DOCS_DIR` (`:180` sensowna ścieżka, `:322` **puste** → wygrywa puste) i `NLM_BINARY_PATH` (`:205` ścieżka absolutna, `:207` gołe `nlm` → wygrywa PATH-zależne, a skrypty deployu biegną z innym PATH-em niż powłoka interaktywna).

**I13 — rozjazdy `.env` ↔ `.env.example`:** `FEATURE_DELEGATION_LLM_PLAN` (prod `true` / szablon `false`), `CHEF_FLAVOR_PAIRING_ENABLED` (prod `true` / szablon `false`), `ERROR_COLLECTOR_ENABLED` (w prod, brak w szablonie). Świeży klon dostaje inne zachowanie orkiestracji niż produkcja.

**I14 — 10 flag P1-P8 nieobecnych w `.env`** (ledger, comm-contracts, scheduler, idempotency, skill-distillation, graphify, depth-inheritance, budget-coordination, timeout-salvage, finalize-on-deliverable) — działają na domyślnych z kodu (ON). Poprawne, ale niewidoczne w konfiguracji.

**I15 — CORS `origin:'*'`** (deployer `:4524`, bo `server.auth` nieustawione) na wszystkich route'ach zapisu `/ws/*` i `/dashboard/approvals/:id/approve` — czyli na bramce zatwierdzania płatnych akcji.

**I16 — brak jakiejkolwiek supervizji procesu Mastry.** Nie ma unitu systemd, PM2 ani nginx/caddy. Serwer startuje gołym `node .mastra/output/index.mjs &` z pidfile (`start-candidate.sh:49`, `deploy-blue-green.sh:288`). `Restart=always` dotyczy wyłącznie Ollamy.

### Sufity infrastruktury — tabela

| # | sufit | wartość | gdzie | konfigurowalne? |
|---|---|---|---|---|
| 1 | Cloudflare edge → 524 | **100 s** | poza repo | ❌ na Free/Pro |
| 2 | **Hono `timeout()` → 504** | **180 s** | `@mastra/deployer/dist/server/index.js:4515, 4542` | ✅ tylko przez `server:{timeout}` w `index.ts:107` — **nieustawione** |
| 3 | Node `requestTimeout` → 408 | 300 s | default Node | ❌ |
| 4 | Node `headersTimeout` | 60 s | default Node | ❌ |
| 5 | body limit | 4,5 MB | deployer `:4485` | ✅ `server.bodySizeLimit` — nieustawione |
| 6 | CORS preflight cache | 3600 s | deployer | ✅ nieustawione |

### Warstwa deploy/autoheal — knoby

| knob | wartość | plik | env |
|---|---|---|---|
| `healthCheck.timeoutMs` / `intervalMs` | 60 s / 3 s | `deploy.config.json:18-19` | przez `AUTOHEAL_CONFIG_FILE` |
| `watchdog.durationMinutes` / `checkIntervalSeconds` | 600 s / 30 s | `deploy.config.json:24-25` | — |
| `maxErrorsBeforeRollback` | 3 | `deploy.config.json:26` | — |
| `SWAP_TIMEOUT` | **30 s zaszyte** | `deploy-blue-green.sh:299` | ❌ |
| post-promote / post-rollback health | **30 s zaszyte** | `promote-candidate.sh:96`, `rollback-to-stable.sh:54` | ❌ |
| `AUTOHEAL_CANARY_SECONDS` | 60 s | `canary-watch.sh:32` | ✅ nieudokumentowane |
| `AUTOHEAL_MAX_ATTEMPTS` / `RETRY_BACKOFF_SECONDS` | 2 / 5 s (płaski) | `retry-deploy.sh:42-44` | ✅ nieudokumentowane |
| `AUTOHEAL_SUPERVISOR_INTERVAL_SECONDS` | 15 s | `autoheal-supervisor.sh:47` | ✅ nieudokumentowane |
| health probe `curl --max-time` | 4 / 5 / 8 / 10 s / **∞** | 7 różnych plików | ❌ |
| mongo healthcheck | 10 s / 5 s / 5 prób | `docker-compose.yml:26-28` | ❌ |
| CI job | 900 s | `.github/workflows/ci.yml:14` | ❌ |
| `check:all` — 37 sekwencyjnych `tsx` | **bez limitu** | `package.json:60` | ❌ |
| `predev`/`prestart` → tunnel up | do 60 s blokady | `package.json:8,11` | ❌ |

### Polling dashboardu

| co | interwał | timeout klienta |
|---|---|---|
| `loadLiveActivity` → `/dashboard/agent-activity` | 2 s | **brak** |
| `fetchTopology` → `/dashboard/active-topology` | 3 s | **brak** |
| `updateJarvisFeed` → `/dashboard/agent-activity?limit=50` | 3 s | **brak** |
| `loadAll` (analytics) | 30 s | **brak** |

Zero SSE, zero WebSocketów, zero reconnect/backoff. Wszystko to gołe interwały.

---

## 6. Pełny inwentarz — warstwa narzędzi

Szczegółowe tabele per domena (design, film, music, MCP/n8n, system, dev/terminal, knowledge, search/comms, workflows, lib) — patrz kolizje K9-K18 powyżej. Najważniejsze liczby:

| domena | knob | default | env? |
|---|---|---|---|
| design | `render_video` / `render_video_seek` / `convert_formats` | **900 s** | ❌ tylko zod input, max 3600 s |
| design | `narrate_pipeline` | **1800 s per chunk** | ❌ |
| design | `add_music` / `export_pptx` / `export_pdf` / `gen_thumbs` | 600 s | ❌ |
| design | `fetch_images` / `verify` / `generate_image` / `tts` | 120–180 s | ❌ |
| design | ffmpeg concat / silence / ffprobe | 600 / 120 / 30 s | ❌ |
| film | `FILM_POLL_TIMEOUT_MS` / `INTERVAL` | 600 s / 5 s | ✅ (tylko surface `fal`) |
| music | `MUSIC_POLL_TIMEOUT_MS` / `INTERVAL` | 600 s / 5 s | ✅ |
| music | ElevenLabs `sync-bytes` | **brak** | ❌ |
| MCP | wspólny klient (notebooklm, **playwright**, firecrawl, gmail, context7) | 180 s | ❌ |
| MCP | `n8nMcpClient` | 60 s | ❌ |
| n8n | REST ×9 / webhook / `/run` / `/healthz` | 10 / 30 / 60 / 3 s | ❌ |
| knowledge | tool 120 s → klient 130 s → default klienta 60 s → research 300/600 s | 4 liczby | ❌ |
| system | `plan_task` | 45 s ×2 próby | ✅ `PLAN_TASK_TIMEOUT_MS` |
| system | `meta_execute_command` | 30 s / max 120 s | ❌ zod input |
| terminal | `shell_execute` | 15 s | ❌ |
| dev | `tsc --noEmit` / test-command / external-project `execSync` | 15 / 60 / 30 s | ❌ |
| dev | 8× git w `code-worktree.ts`, graphify | **∞** | ❌ |
| search | Tavily search / extract / competitor-analysis | 30-15 / 45-30 / 20 s | ❌ |
| lib | mongo / ollama embed / google embed | 5 / 30 / 15 s | ✅ tylko mongo |
| workflows | `repo-maintenance` — 12 różnych timeoutów | 10 s – 600 s | ❌ wszystkie zaszyte |
| workflows | 9× `agent.generate` w analytics/marketing/sales | **∞** | ❌ |

`src/mastra/processors/**` i `src/mastra/scorers/**` — zero budżetów czasowych. Czyste.

---

## 7. Archeologia — jak do tego doszło

| data | commit | co doszło |
|---|---|---|
| 2026-05-09 | `4a98b58` | parallel dispatch — pierwsze timeouty (subtask COMPLEXITY_TIMEOUTS) |
| 2026-05-13 | `f525a87`, `28b5bbe` | coding-harness 300 s + async delegation 300 s |
| 2026-06-13/15 | `67c6c6b`, `30e7a18`, `7592ef3` | `maxSteps: 150` dla pipeline'ów (chef → content → hunt) |
| 2026-06-18 | `bb64612` | `DELEGATION_DIRECT_TIMEOUT_MS` 240 s |
| 2026-07-22 | `d5a16fd` | P2 budget coordination — pierwsza próba koordynacji między warstwami, retrofit |

Każda warstwa była poprawna w momencie dodania. Kolizje wzięły się z tego, że kolejna warstwa nie wiedziała o poprzedniej.

---

## 8. Co z tego wynika dla struktury (do przedyskutowania)

Audyt nie proponuje jeszcze rozwiązania — poniżej tylko obserwacje, które wyznaczają przestrzeń projektową.

**Obserwacja 1: problemem nie są liczby, tylko brak relacji między nimi.**
Każda pojedyncza wartość jest sensowna w swoim kontekście. Kolizje biorą się z tego, że nikt nie egzekwuje niezmiennika „warstwa N ≤ warstwa N−1". Naprawianie liczb po kolei nie pomoże, bo za miesiąc dojdzie kolejna warstwa.

**Obserwacja 2: budżet musi być przekazywany w dół, nie deklarowany osobno na każdym poziomie.**
Dziś każda warstwa czyta swój własny default. `resolveDelegationBudget` (P2) to pierwszy i jedyny przypadek propagacji — działa, ale obejmuje połowę ścieżek. Ta sama idea, konsekwentnie: jedno „ile mi zostało" płynące przez AsyncLocalStorage aż do `AbortSignal` narzędzia.

**Obserwacja 3: brakuje pojęcia klasy zadania niezależnej od długości promptu.**
Klasyfikator ocenia słowa, a nie to, co zadanie faktycznie robi. „zrób mi film" jest krótkie i dostaje 60 s, choć wymaga 10 minut generowania wideo. Budżet powinien wynikać z docelowej domeny/narzędzia, nie z liczby znaków w promptcie.

**Obserwacja 4: rozdzielenie „interaktywne" od „długiego" jest nieuniknione.**
Przy ścianie 180 s (a na ścieżce publicznej 100 s) każde zadanie dłuższe niż ~2,5 min musi z definicji być asynchroniczne. Dziś system wpycha zadania w async przypadkiem (przez `viable=false`), a nie przez świadomą decyzję. To jest ta sama granica, tylko postawiona z właściwej strony.

**Obserwacja 5: część rzeczy to zwykły dług, nie architektura.**
Trzy martwe zmienne, dwa duplikaty w `.env`, dwa `curl` bez `--max-time` w ścieżkach rollbacku, `maxStepsWithoutProgress` równe `maxSteps`, 8 endpointów bez clampa na `?limit` — to poprawki punktowe, niezależne od jakiejkolwiek przebudowy.

### Ranking wg stosunku ryzyko/koszt naprawy

| priorytet | rzecz | dlaczego |
|---|---|---|
| P0 | ściana 180 s nieznana i nieustawiona | unieważnia wszystkie budżety >180 s; jedna linia w `index.ts:107` |
| P0 | klasyfikator wrzuca naturalne polecenia w `fast` | każda domena generatywna działa w trybie awaryjnym |
| P1 | budżety dzieci > budżet rodzica (K3, K4) | procesy-sieroty mutujące n8n/Mongo |
| P1 | pipeline 150 kroków vs ≤240 s (K2) | 6 agentów nigdy nie kończy normalnie |
| P1 | brak propagacji `abortSignal` przez granicę delegacji | żaden timeout nie zatrzymuje pracy w dół |
| P2 | ogon post-passów poza wall-clockiem (K7) | margines 20 s jest fikcyjny |
| P2 | upgrade głębokości bez przedłużenia deadline (K1) | eskalacja szkodzi zamiast pomagać |
| P2 | design 900/1800 s pod delegacją 240 s (K9, K10) | wiszące procesy ffmpeg/Playwright |
| P3 | martwe zmienne, duplikaty `.env`, rozjazdy z `.env.example` | fałszywe poczucie kontroli |
| P3 | `curl` bez `--max-time` w ścieżkach rollbacku (I5) | rollback może zawisnąć |
| P3 | `?limit` bez clampa (I8) | trywialny DoS na własnym dashboardzie |
