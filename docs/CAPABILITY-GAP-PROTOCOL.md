# Capability Gap Protocol (Etap 7)

> Implementacja Etapu 7 planu `ideas/IDEALSYSTEMMASTERPLAN.md` (blueprint §4).
> Wdrożono: 2026-07-22, branch `fix/delegation-depth-hardening` (wspólny dla planu).
> Flaga: brak osobnej — protokół jest bierny dopóki ktoś nie zawoła capabilitySmitha;
> attach jest twardo bramkowany approvalem.

## Idea

Gdy agent trafia na mur („nie mam narzędzia do X"), system **nie kończy błędem**.
Emituje `capability_gap`, a `capabilitySmith` prowadzi protokół: najpierw szuka
gotowca (skill → kolega z Agent Board → serwer MCP), a dopiero potem buduje własne
narzędzie. Każda nowa moc wymaga **jednego „ok" człowieka**.

## Ścieżka

```
1. KLASYFIKUJ lukę: wiedza | skill | tool | MCP | agent | uprawnienia
2. SZUKAJ GOTOWCA
   skill_search → agent_board_list/get (może kolega to umie)
   mcp_discover(gap) → oficjalny MCP Registry (federuje Smithery), ranking,
                        zapis kandydatów jako `discovered`
3. SANDBOX TRIAL  capability_sandbox(capabilityId)
   → env -i (PUSTE środowisko) + MOCK wartości dla KAŻDEJ deklarowanej zmiennej
   → timeout → smoke test (connect + listTools)
   → ok: `sandboxed` | fail: `quarantined`
4. BRAMKA APPROVAL  capability_request_attach(capabilityId, justification)
   → wpis w `approvals` (ta sama skrzynka co system_request_approval), status
     `awaiting_approval`. STOP. Attach bez zatwierdzenia jest NIEMOŻLIWY.
5. ATTACH  capability_attach(capabilityId, approvalId)  [po zgodzie człowieka]
   → realne wartości env TYLKO z process.env po udokumentowanych NAZWACH
   → dedykowany MCPClient (wzorzec WS-E) → status `attached`
6. UŻYJ  capability_invoke(capabilityId, tool, args); tier `shadow` na start
7. BUILD (gdy brak gotowca) — `capability_build`, zaimplementowane:
   a) SPEC   artifact_put(action_plan) z CZTEREMA odpowiedziami: goal, ioContract,
             integrationPoint, testPlan. Brak którejkolwiek → build się nie zaczyna.
   b) DELEG. delegate_task(codingAgent, async) — pisze WYŁĄCZNIE we własnym worktree
   c) BUILD  capability_build(specArtifactId, branch, worktreePath, gapId?)
             → lane + claims `repo:src/mastra/**` (dwa buildy nie wchodzą sobie w kod)
             → BRAMKA: `npx tsc --noEmit` I `npm run check:all` W WORKTREE
             → zielone: merge --no-ff | czerwone: koniec, bez merge'a
             → wpis `built`/`shadow` w rejestrze, luka `resolved`, kandydat do E6
   d) PROMOTE (opcjonalny, DOMYŚLNIE OFF) — build/verify/promote/canary/mark-promoted
             ze skryptów autoheal; wymaga ZATWIERDZONEGO tokenu approval.
```

Build zwraca `buildId` natychmiast i biegnie w tle (bramka to minuty, a deployer tnie
HTTP na 180 s — patrz `ideas/timeouts-audit.md`); stan czyta `capability_build_status`.

## Komponenty

| Plik | Rola |
|---|---|
| `services/capability-registry.ts` | Mongo `capabilities` + maszyna stanów (`discovered→sandboxed→awaiting_approval→attached`, `quarantined`/`rejected`), `capability_gaps`, tier `shadow` |
| `tools/system/mcp-discover.ts` | `mcp_discover` — REST oficjalnego rejestru, parsowanie pakietów/remotes/envVars, ranking |
| `services/capability-sandbox.ts` | `buildSandboxSpawnSpec` (czysta, testowana) + `sandboxTrialCapability`; `resolveRuntimeInvocation` (npm→npx, local→node) |
| `services/capability-attach.ts` | bramka approval, `buildLiveEnv`, dedykowane klienty, `reattachApprovedCapabilities` (start), `invokeCapabilityTool` |
| `services/capability-build.ts` | ścieżka BUILD: `validateBuildSpec` (czysta, testowana), `runCapabilityBuild` (wszystkie wykonawcze wstrzykiwalne), `startCapabilityBuild`/`getBuildReport` (bieg w tle, Mongo `capability_builds`) |
| `tools/system/capability-tools.ts` | `capability_sandbox` / `_request_attach` / `_attach` / `_list` / `_invoke` / `_build` / `_build_status` |
| `agents/capability-smith.ts` + `prompts/capability/base.md` | właściciel protokołu (model standard), karta w Agent Board |
| `generate-with-harness.ts` → `detectCapabilityGap` | emisja `capability_gap` gdy odpowiedź przyznaje brak narzędzia |

## Bezpieczeństwo (nienegocjowalne — pokryte testami)

- **Sekrety nigdy w sandboxie.** Spawn przez `env -i`: dziecko dostaje WYŁĄCZNIE
  jawnie zbudowane env (PATH + HOME sandboxa + **mocki** dla każdej deklarowanej
  zmiennej). Zweryfikowane e2e: serwer w trialu widzi `sandbox-mock-secret-*`,
  a po zatwierdzeniu i attachu — realną wartość z `.env`.
- **Sekrety nigdy w Mongo.** Rejestr trzyma tylko NAZWY zmiennych (+ flagi
  `isRequired`/`isSecret`). Brakujące wymagane → attach odmawia i wypisuje nazwy
  do dodania w `.env`.
- **Zero samo-zatwierdzania.** `attachCapability` czyta `approvals` i wymaga
  statusu `approved`; `pending` = odmowa. Maszyna stanów blokuje skróty
  (`discovered → attached` rzuca wyjątkiem).
- **Nieznany serwer = niezaufany kod:** sandbox zawsze przed attachem; nowa
  zdolność startuje w tierze `shadow`.

## Testy (w `check:all`)

- `check:cgp-sandbox-isolation` (9 asercji, bez sieci) — podrzucone do
  `process.env` sekrety **nie pojawiają się** w spawn spec; mocki obecne;
  nielegalne przejścia rzucają; attach z `pending` odrzucony; `buildLiveEnv`
  raportuje braki po nazwach; rekord w Mongo bez sekretów; detektor luk łapie
  realne frazy („nie mam narzędzia", „I don't have a tool"), a nie zwykły tekst.
- `e2e:cgp-discover-attach` (7 asercji) — **pełna pętla na PRAWDZIWYM serwerze
  MCP** (`scripts/fixtures/fake-mcp-server.mjs` na oficjalnym SDK): sandbox
  (widzi mock) → request approval → attach ODMÓWIONY przy pending → człowiek
  zatwierdza → attach → `capability_invoke` działa i serwer widzi realny sekret
  → `capability_list` pokazuje attached. Bez sieci, bez LLM, deterministyczne.
- `check:capability-build-gates` (15 asercji, bez LLM/worktree/slotów — wszystkie
  wykonawcze wstrzykiwane) — testuje to, co w tej ścieżce naprawdę ma wartość:
  **odmowy**. Spec bez planu testu odrzucony po nazwie brakującego pola; proza
  „wspominająca" te słowa NIE przechodzi za spec; niekompletny spec blokuje
  **zanim pójdzie jakakolwiek komenda**; czerwony `tsc` i czerwony `check:all`
  (osobno) → zero merge'a i zero promote; konflikt merge'a → `blocked` i sprzątnięte
  drzewo; promote odmówiony bez tokenu oraz przy `pending`/`missing`/`rejected`;
  happy path kończy się `built`/`shadow` + luka `resolved` + kolejność kroków.

## Dwa realne błędy wyłapane przez testy (naprawione)

1. **Sandbox nie odpalał się na nvm** — sztywny PATH `/usr/bin` nie zawierał
   `node`/`npx` (brak `/usr/bin/node`). Każda zdolność padałaby na
   „connection closed". Fix: PATH sandboxa zawiera katalog bieżącego
   `process.execPath` (ścieżka, nie sekret — izolacja nienaruszona).
2. **Zły kształt argumentów przy `invoke`** — toole MCP w Mastrze walidują
   surowy obiekt argumentów; opakowanie w `{context}` powodowało błąd walidacji.

## Ograniczenia v1 (świadome)

- Brak sieciowego jailu (allowlist domen/proxy) w sandboxie — izolacja to
  czyszczenie env + mocki + timeout + brak attachu bez zgody. Domain allowlist:
  kandydat na v2.
- `capability_invoke` to surowa powierzchnia generyczna; przypięcie narzędzi
  zdolności bezpośrednio do toolsetów agentów (zamiast przez invoke) — v2.
- Tier `shadow` jest zapisywany, ale automatyczna promocja (`propose`/`auto`
  wg track recordu) należy do E10.
- `mcp_discover` wymaga sieci; e2e używa lokalnego fixture'a, żeby CI był offline.
- **BUILD nie odpala delegacji sam.** `capability_build` dostaje gotową gałąź
  i worktree od capabilitySmitha, bo wciągnięcie delegacji do środka zrobiłoby
  z builda jedno wywołanie dłuższe niż jakikolwiek budżet requestu. Pełna
  automatyka (gap → build bez człowieka w pętli) to świadomie NIE v1.
- **Promote nie jest przetestowany e2e** — `check:capability-build-gates` dowodzi,
  że bez zatwierdzenia się nie odpali, ale sama sekwencja slotów (build/verify/
  promote/canary) jest sprawdzona tylko przez istniejące testy autoheala.
