# SYSTEM IDEALNY — Blueprint autonomicznego Outcome Engine

> **Cel na wejściu → wynik na wyjściu.** Prosty czat z przodu, fabryka agentów z tyłu.
> System, który zamiast mówić Ci, co masz zrobić, mówi: *"dobuduję sobie ten moduł, przetestuję i dam znać, jak będzie gotowy"*.
>
> Research: 18.07.2026 · Grounded w aktualnym kodzie repo (Mastra 1.31, 22 agentów, autoheal, harness, async delegation).

---

## 0. TL;DR

1. **~70% fundamentów już masz** — async delegation, budget-tracker, goal-tracker, autoheal promote/rollback, reflectory, scorery, skill registry. Brakuje spoiwa, nie cegieł.
2. Sercem systemu idealnego jest **Task Ledger** — jedno źródło prawdy o wszystkim, co system robi. Z niego wynika: czat zawsze responsywny, statusy, kolejkowanie, audyt.
3. Meta rozdzielamy na **Meta-Front** (konsjerż, rozmawia z Tobą, nigdy się nie blokuje) i **Orchestration Lanes** (równoległe orkiestracje w tle z własnym budżetem i claimami zasobów).
4. Samorozbudowa = **Capability Gap Protocol**: mur → klasyfikacja luki → szukaj gotowca (MCP Registry / Smithery, 7k+ serwerów) → sandbox → approval → podpięcie; brak gotowca → codingAgent buduje na worktree → canary → promote (istniejący mechanizm autoheal!).
5. Uczenie się = **destylacja skilli po sukcesie** (wzorzec Hermes Agent od Nous Research: SKILL.md + Kurator + liczniki użyć; u Nous ~40% szybciej przy 20+ własnych skillach).
6. "Graphify" to najpewniej **Graphiti (Zep)** — temporal knowledge graph z gotowym MCP serverem. Do kodu lepszy jest **Serena** (LSP: nawigacja po symbolach zamiast czytania plików). Bierzemy oba, do różnych rzeczy.
7. Nowa fizyka w arsenale: **browserAgent** (Stagehand / browser-use), **computerAgent** (Bytebot — desktop w kontenerze, nigdy na hoście), **capabilitySmith** (właściciel CGP), **strateg** (cron, nie ścieżka requestu).
8. Świat zewnętrzny: **A2A v1.0** (Mastra wspiera natywnie) + na horyzoncie **AP2 (Agent Payments Protocol)** — przyszła szyna dla wizji "system zarabia na siebie".
9. Autonomia rośnie **per zdolność wg track recordu** (shadow → propose → auto z rollbackiem), nigdy globalnym przełącznikiem. Bramki to nie hamulec, to mechanizm wzrostu zaufania.
10. Roadmapa: **6 faz × 2 tygodnie**, każda z twardym kryterium wyjścia.

---

## 1. Zmiana paradygmatu: odpowiedzi → wyniki (Outcome Contract)

Każde Twoje wejście Meta klasyfikuje na jedno z trzech:

| Typ | Zachowanie |
|---|---|
| **QUESTION** | Odpowiada od razu, z pamięci/wiedzy. Zero orkiestracji. |
| **TASK** | Wykonuje w tej turze (do ~1 min) albo deleguje async i mówi kiedy da znać. |
| **GOAL** | Zawiera **Outcome Contract** i odpala Lane w tle. |

**Outcome Contract** — obiekt zapisywany w Ledger:

```yaml
goal: "Zdobądź 10 leadów producentów z branży X"
definition_of_done: "10 rekordów w CRM ze statusem qualified + notatka źródła"
budget: { usd: 5, hours: 24, iterations: 4 }
autonomy_tier: propose        # shadow | propose | auto
report: { channel: chat+push, on: [milestone, blocker, done] }
```

Wzorzec odpowiedzi Meta — **zawsze** trzy zdania, nigdy poradnik:

> *"Zrozumiałem: chcesz X. Robię: plan A w tle (lane #17, budżet $5). Dam znać przy pierwszym milestone albo za 2h — co wcześniejsze."*

A gdy brakuje zdolności (to jest kluczowa zmiana kultury systemu):

> *"Nie mam jeszcze modułu do Y. Mogę go sobie dobudować: znalazłem gotowy MCP `foo` (2h, ~$1) albo zbuduję własny tool (1 dzień, ~$4). Buduję wariant 1?"*

---

## 2. Co już masz — inwentarz (nie budujemy od zera)

| Warstwa blueprintu | Już istnieje w repo |
|---|---|
| Orkiestracja | `meta-agent` + `delegate_task` (z `async: true`!), `plan_task`, `run_worker`, workflowy |
| Praca w tle | `services/async-delegation.ts`, `background-task-manager.ts`, `checkPendingUpdates` + `pendingUpdatesProcessor` |
| Budżety / bezpieczniki | `budget-tracker.ts`, `circuit-breaker.ts`, `gpu-guard.ts` |
| Cele i ocena | `goal-tracker.ts`, goal-completion scorer, agent-performance-report |
| Samonaprawa | autoheal: repair lane, supervisor, **promote/rollback** |
| Refleksja | strategy-reflector, pipeline-reflector, `generate-pipeline-with-reflection.ts` |
| Skille | `.agents/skills`, `story-skills`, `skillSearchTool`, PHASE-2 skill registry + failure brain |
| Pamięć | working memory, observational memory (scope: thread), shared memory, memory-recall/write |
| Kod | delta-indexer, code search/embed/outline, worktrees, repo-map |
| Nadzór | `requestApprovalTool`, SAFETY-LAYER, error-collector, global-error-handler, dashboard |
| Automatyzacje | n8n + MCP engineer + golden path + coverage checks |

**Wniosek:** brakuje pięciu rzeczy: (1) Task Ledger z claimami, (2) lifecycle skilli z destylacją po sukcesie, (3) protokół samorozbudowy CGP, (4) graf wiedzy + symboliczny dostęp do kodu, (5) browser/computer use. Reszta to spinanie istniejących serwisów.

---

## 3. Meta rozmawia i dyryguje jednocześnie

### 3.1 Podział na Meta-Front i Orchestration Lanes

- **Meta-Front (konsjerż)** — jedyny agent, który z Tobą rozmawia. Lekki, szybki model. Twarda zasada: **nie wykonuje pracy dłuższej niż ~30 s** — wszystko powyżej deleguje jako Lane. Dzięki temu czat jest responsywny ZAWSZE, nawet gdy w tle mieli się 5 orkiestracji.
- **Orchestration Lane** — jeden GOAL = jeden lane: własny thread pamięci, budżet, claims, heartbeat, historia planów. Technicznie: podniesienie istniejącego `async-delegation` + `background-task-manager` do rangi pierwszoklasowego bytu z rekordem w Ledger.
- *"Co się dzieje w systemie?"* = odczyt Ledger (jedna tania kwerenda), **nie** przerywanie pracy agentów.

### 3.2 Task Ledger — serce systemu

Kolekcja Mongo `task_ledger`; przykładowy rekord:

```jsonc
{
  "id": "lane-2026-07-18-017",
  "goal": "...", "contract": { /* §1 */ },
  "state": "running",            // queued | running | blocked | awaiting_approval | done | failed
  "claims": ["repo:src/mastra/agents/*", "n8n:workflow:lead-scraper", "crm:write"],
  "budget": { "cap_usd": 5, "spent_usd": 1.37 },
  "heartbeat_at": "…", "milestones": [ … ], "artifacts": [ … ],
  "plans": [ { "v": 1, "status": "abandoned", "why": "scraper blocked" }, { "v": 2, "status": "active" } ],
  "parent": null, "children": ["lane-…-018"]
}
```

**Wszystko** co system robi jest w Ledger: zadania z czatu, crony, autoheal, self-dev, CGP. Dashboard i czat czytają to samo źródło.

### 3.3 Kolejkowanie i kolizje (Twoje pytanie o nakładające się orkiestracje)

- **Resource claims deklarowane na etapie planu** (planTask zwraca listę). Scheduler: claims rozłączne → lanes idą **równolegle**; przecinające się → **kolejka** FIFO z priorytetami. Preempcja tylko ręczna (Twoje "wstrzymaj #17").
- **Idempotency keys** na narzędziach z efektami ubocznymi (n8n trigger, CRM write, mail) — ochrona przed podwójnym wykonaniem przy retry.
- **Worktree per zadanie kodowe** (już macie) = naturalna izolacja na repo; claims na ścieżki tylko dla merge.

### 3.4 Statusy i proaktywność

- `harness-events` → **event bus** (Mongo change streams) → Meta-Front dostaje digest na starcie tury (rozszerzenie istniejącego `checkPendingUpdates`).
- **Push na telefon**: milestone / blocker / approval needed → Telegram (kanał w stylu OpenClaw; na start wystarczy webhook n8n, który już macie).
- Komendy operatora w czacie: `status`, `status #17`, `pauza #17`, `anuluj #17`, `priorytet #17 wysoki`.

---

## 4. Samorozbudowa: Capability Gap Protocol (CGP)

Gdy agent trafia mur, **nie kończy błędem** — emituje `capability_gap` (nowy typ zadania w Ledger):

```
1. KLASYFIKUJ lukę:  wiedza | skill | tool | MCP | agent | uprawnienia
2. SZUKAJ GOTOWCA:
   – skille:  skillSearchTool (jest)
   – MCP:     nowy tool `mcp_discover` → oficjalny MCP Registry (REST API, ~2000 serwerów)
              + Smithery (7000+ serwerów, CLI i hosting)
   – trafienie → SANDBOX TRIAL (osobny proces, allowlist domen, mock sekretów)
              → smoke test → APPROVAL GATE (nowe sekrety/uprawnienia = zawsze Ty)
              → podpięcie przez Mastra MCPClient (dynamiczna konfiguracja)
3. BUDUJ gdy brak gotowca:
   spec → codingAgent na worktree (jest) → testy `check:*` → canary
        → promote/rollback (istniejący mechanizm autoheal!)
4. ZAPISZ:  wpis w Capability Registry + auto-skill "jak tego używać"
```

- CGP to zwykłe zadanie w Ledger — w statusach widzisz: *"system dobudowuje sobie moduł X (krok 2/4: sandbox trial)"*.
- Mur bez wyjścia → eskalacja do Ciebie **z gotową specyfikacją i wyceną wariantów**, nie z pytaniem "co robić?".

---

## 5. Uczenie się: destylacja skilli po sukcesie (wzorzec Hermes Agent)

Nous Research w [hermes-agent](https://github.com/nousresearch/hermes-agent) pokazał działający lifecycle — przenosimy 1:1, bo format jest zgodny z Waszym `.agents/skills`:

1. **TRIGGER:** zadanie `done` z ≥5 tool callami · recovery po błędzie · Twoja korekta.
2. **EXTRACT:** tani model destyluje przebieg → `SKILL.md` (YAML frontmatter: nazwa, triggery, narzędzia; body: kroki + pułapki). Format [agentskills.io](https://agentskills.io) — ładowalny przez `skillSearchTool` bez zmian.
3. **EVAL:** mini-eval przed aktywacją (macie wzorce evali w repo) — skill niedziałający nie wchodzi do puli.
4. **REGISTRY:** liczniki view/use/success per skill (Mongo).
5. **KURATOR** (cron tygodniowy): nieużywane 30 dni → `stale`, 90 dni → `archive`; niski success rate → zadanie naprawy dla reflectora.

Failure brain już macie (Phase 2) — to jest brakująca **success brain**. Razem domykają pętlę: *porażka uczy, czego unikać; sukces uczy, jak powtarzać taniej*. U Nous agent z 20+ własnymi skillami robi podobne zadania **~40% szybciej**.

**Cykl nocny (dream cycle):** w nocy, na lokalnych modelach (Ollama + `gpu-guard`, koszt ~0), system robi konsolidację: destylacja skilli z dnia, pruning pamięci, replay porażek, propozycje do backlogu self-dev. Rano czeka raport: *"czego się wczoraj nauczyłem, co proponuję ulepszyć"*.

---

## 6. Wiedza: "graphify" i koniec palenia tokenów na czytanie kodu

To, co opisujesz, to najpewniej **Graphiti** od Zep (nazwa "graphify" nie funkcjonuje). Ale kod i pamięć to dwa różne problemy — trzy warstwy:

| Warstwa | Narzędzie | Efekt |
|---|---|---|
| **Kod: symbole, nie pliki** | [Serena](https://github.com/oraios/serena) — MCP na LSP: `find_symbol`, `find_references`, edycje punktowe | Agent nawiguje po symbolach zamiast czytać pliki. Wasz delta-indexer/embeddingi zostają jako warstwa wyszukiwania. |
| **Fakty o systemie i o Tobie** | [Graphiti](https://github.com/getzep/graphiti) — temporalny graf encji/faktów z oknami ważności, gotowy MCP server, retrieval hybrydowy (semantic+BM25+graf) **bez wywołań LLM**, P95 ~300 ms | Pamięć globalna ponad thread-scoped observational memory. "Preferujesz X od czerwca", "workflow Y psuje się przy Z". |
| **Architektura repo** | Auto-syntezowany `docs/ARCHITECTURE-SNAPSHOT.md` po każdym merge (rozszerzenie `repo-maintenance`) | Agenci czytają snapshot (2k tokenów), nie kod (200k). |

Twarda zasada do promptów i harnessu: **outline → symbol → fragment**; czytanie całego pliku wymaga uzasadnienia. Kolejność wdrożenia: Serena (1 dzień, natychmiastowy zysk tokenowy) → snapshot (skrypt) → Graphiti (tydzień, wymaga dyscypliny zapisu).

---

## 7. Nowi agenci — tylko tacy, którzy dodają nową *fizykę*

Nie mnożymy promptów. Dodajemy zdolności, których żaden obecny agent nie ma:

- **browserAgent** — [Stagehand](https://github.com/browserbase/stagehand) (primitives act/extract/observe, self-healing selektory) albo [browser-use](https://github.com/browser-use/browser-use) (89% WebVoyager). Macie `.playwright-mcp` — to upgrade, nie rewolucja. Domyka hunt/research end-to-end (logowanie, portale, pobieranie danych).
- **computerAgent** — ⚠️ [Bytebot](https://github.com/bytebot-ai/bytebot) **jest zarchiwizowany** (sprawdzone 2026-07-22; read-only, ostatni commit 09.2025) — dobór narzędzia do przesądzenia, patrz §11. Docelowo: pełny desktop Linux w kontenerze. Zasada nienegocjowalna: computer use **nigdy na hoście**, zawsze VM/kontener, akcje nieodwracalne za approvalem. Opcjonalnie UI-TARS jako lokalny model wizji GUI (bez API zewnętrznego).
- **capabilitySmith** — rzemieślnik zdolności, właściciel CGP (§4). To on "przebija mury": szuka, sandboxuje, podpina, buduje.
- **strateg** — działa z crona, **nie** w ścieżce requestu. Czyta performance-review, scorery, Ledger, budżety → pisze tygodniowy plan rozwoju i backlog self-dev → Ty zatwierdzasz jednym "ok". To jest odpowiedź na "system planuje własny rozwój" bez dodawania hopu do każdej rozmowy.

---

## 8. Outcome Loop — "używa loops, aby zmieniać podejścia"

Formalizacja Waszego PLAN-AND-REPLAN + cognitive loop, osadzona na Ledgerze:

```
goal → plan (plan_task) → execute (lane) → score (goal-completion scorer ✓)
     → reflect (reflectory ✓) → replan | done | escalate
```

- **Stop conditions twarde:** budżet, deadline, max iteracji, brak postępu 2 iteracje z rzędu → eskalacja z raportem *"co próbowałem, dlaczego nie działa, co proponuję"*.
- Zmiana podejścia = nowy wpis w `plans[]` tego samego goala (stare plany zostają — audyt i materiał do destylacji).
- Scoring po każdej iteracji, nie na końcu — pętla wie, czy się zbliża do definition_of_done.

---

## 9. Komunikacja agentów i świat zewnętrzny

- **Wewnątrz:** delegate (✓) + signals (✓) + event bus (§3.4). Każdy agent dostaje **agent card** w Capability Registry: co umie, koszt, SLA, track record (dane z performance-review już są). Meta wybiera wykonawcę po kartach i statystykach, nie po hardkodowanej tabelce w promptcie — agenci mogą też używać siebie nawzajem przez te same karty.
- **Na zewnątrz:** [A2A v1.0](https://mastra.ai/docs/agents/a2a) (Linux Foundation, kwiecień 2026, 150+ organizacji; **Mastra wspiera natywnie** — expose agentów jako remote i konsumpcja zdalnych agentów jako subagentów). Wasze agenty wystawione po A2A = mogą być używane przez inne systemy.
- **Płatności:** AP2 (Agent Payments Protocol, ogłoszony przy A2A v1.0) — przyszła szyna dla wizji "system zarabia na swoje utrzymanie". Dziś: projektować Capability Registry tak, by karta agenta mogła mieć cennik.

---

## 10. Silniki (model routing)

| Rola | Model | Dlaczego |
|---|---|---|
| Meta-Front | deepseek-v4-pro (dziś) / **Kimi K3 canary** | szybko, tanio, pewne tool calle |
| Planowanie lane / trudne decyzje | K3 / Fable 5 | drogi model tam, gdzie naprawa błędu kosztuje więcej niż tokeny |
| Workerzy, destylacja, Kurator, cykl nocny | lokalne Ollama + DeepSeek | wolumen za grosze |
| Wizja GUI (computer use) | UI-TARS lokalnie / K3 (native vision) | bez zewnętrznego API albo 1M ctx |

Dopisać do `model-manifest.ts` sekcję `taskClassModels` (routing per klasa zadania + budżet). Canary K3 wg planu z poprzedniej analizy (OpenRouter one-liner → `check:*` → porównanie scorerami).

---

## 11. Gotowce z GitHub — czego NIE budować samemu

| Projekt | Co brać | Gdzie wpiąć |
|---|---|---|
| [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent) | lifecycle skilli: skill_manage, Kurator, liczniki, stany stale/archive | §5 — wzorzec 1:1 |
| [getzep/graphiti](https://github.com/getzep/graphiti) | temporal knowledge graph + gotowy MCP server | §6 — pamięć globalna |
| [oraios/serena](https://github.com/oraios/serena) | LSP MCP: symbole zamiast plików | §6 — codingAgent |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) / [browser-use](https://github.com/browser-use/browser-use) | browser agent | §7 |
| ~~[bytebot-ai/bytebot](https://github.com/bytebot-ai/bytebot)~~ ⚠️ **ZARCHIWIZOWANY** (read-only od ~03.2026, ostatni commit 09.2025) — sprawdzone 2026-07-22. Alternatywy: [trycua/cua](https://github.com/trycua/cua) (20,5k ⭐, MIT, aktywny), [e2b-dev/desktop](https://github.com/e2b-dev/desktop) | desktop w kontenerze | §7 — computerAgent, dobór do przesądzenia |
| UI-TARS (ByteDance) | lokalny model GUI-grounding | §7 — opcja |
| [MCP Registry](https://github.com/modelcontextprotocol/registry) + Smithery | REST API dyskowania serwerów | §4 — `mcp_discover` |
| [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) | wzorce sandbox/runtime coding agenta | porównać z coding-harness |
| MetaGPT | artefaktowe handoffy (dokument między rolami zamiast chatu) | odciąża meta i lanes |
| OpenClaw | kanały Telegram/WhatsApp | §3.4 — push na telefon |
| LangChain deepagents | planner + filesystem + subagents | sanity-check architektury |

**Nie budować od zera:** framework przeglądarkowy, graf wiedzy, rejestr MCP, desktop sandbox. Wszystko powyżej jest utrzymywane przez tysiące ludzi.

---

## 12. Roadmapa 90 dni (6 × 2 tygodnie)

**F1 — Task Ledger + Meta-Front** *(fundament: rozmawia i dyryguje)*
Ledger w Mongo (stany, claims, budżety, heartbeat); `delegate_task`/bg-tasks piszą do Ledger; digest w `checkPendingUpdates`; komendy status/pauza/anuluj; push Telegram przez n8n.
**Exit:** 3 równoległe orkiestracje w tle + płynny czat + kolizja na wspólnym claimie poprawnie kolejkuje.

**F2 — Skill Distillation + Kurator**
Hook po zadaniu, extractor (tani model), registry liczników, cron Kuratora, mini-eval przed aktywacją.
**Exit:** powtórzone zadanie używa auto-skilla i jest mierzalnie tańsze/szybsze niż pierwsze wykonanie.

**F3 — Capability Gap Protocol v1**
Tool `mcp_discover` (Registry + Smithery), sandbox trial, approval gate, dynamiczne podpięcie MCPClient; agent capabilitySmith.
**Exit:** system sam znajduje i (po Twoim "ok") podpina MCP, którego wczoraj nie miał, i kończy nim zadanie.

**F4 — Wiedza: Serena + snapshot + Graphiti**
**Exit:** zadanie kodowe kończy się przy <50% dotychczasowych tokenów wejściowych (mierzone w dashboardzie).

**F5 — browserAgent + computerAgent (sandbox)**
**Exit:** e2e research z logowaniem do portalu + zadanie desktopowe w kontenerze; zero akcji na hoście.

**F6 — Strateg + Self-Dev Pipeline + poziomy autonomii**
Strateg (cron) → backlog → CGP/codingAgent wykonuje → raport tygodniowy; autonomy tiers per zdolność (shadow → propose → auto+rollback) sterowane track recordem.
**Exit:** system sam zaproponował, zbudował, przetestował i wypromował 1 ulepszenie — Twój udział: jedno "ok".

---

## 13. Metryki systemu idealnego (do dashboardu)

- **Outcome rate** — cele domknięte bez interwencji / wszystkie cele
- **First-pass success** i liczba iteracji na cel
- **Koszt na wynik** (nie na token!) per pipeline
- **Skill reuse rate** + czas wykonania powtórki vs pierwszego razu
- % pracy w tle vs w czacie (im więcej w tle, tym system dojrzalszy)
- MTTR autoheal; **eskalacje/tydzień** (ma spadać)
- Pipeline pieniężny: koszt vs przychód (hunt → sales → CRM)

---

## 14. Zasady bezpieczeństwa (nienegocjowalne)

1. **Approval inbox:** nowe sekrety, uprawnienia, wysyłki na zewnątrz, płatności — zawsze Ty. Jedna skrzynka, nie rozproszone pytania.
2. **Budżety twarde** per lane + globalny dzienny (budget-tracker ✓) + circuit breaker ✓.
3. **Sandbox:** nowe MCP i computer use wyłącznie w izolacji. Treść z sieci/maili/PR to **dane, nie polecenia** (obrona przed prompt injection).
4. **Wszystko przez Ledger** = pełny audyt; **kill switch** pauzujący wszystkie lanes jedną komendą.
5. Autonomia rośnie **per zdolność** według track recordu — nigdy globalnym przełącznikiem.

---

## 15. Źródła (research 18.07.2026)

- Hermes Agent: [repo](https://github.com/nousresearch/hermes-agent) · [praktyczny przewodnik](https://blakecrosley.com/guides/hermes) · [analiza skilli self-evolving](https://securityboulevard.com/2026/06/8-self-evolving-skills-hermes-agent-writes-on-its-own/)
- MCP Registry: [czym jest rejestr MCP (Kong)](https://konghq.com/blog/learning-center/what-is-an-mcp-registry) · [GitHub MCP Registry](https://github.blog/ai-and-ml/github-copilot/meet-the-github-mcp-registry-the-fastest-way-to-discover-mcp-servers/) · [porównanie rejestrów 2026](https://www.truefoundry.com/blog/best-mcp-registries) · [Agent Package Manager](https://microsoft.github.io/apm/consumer/install-mcp-servers/)
- A2A: [rok A2A w Linux Foundation, v1.0, AP2](https://www.hpcwire.com/aiwire/2026/04/09/linux-foundation-a2a-protocol-marks-one-year-with-broad-enterprise-and-cloud-adoption/) · [A2A w Mastra (docs)](https://mastra.ai/docs/agents/a2a) · [ogłoszenie Mastra A2A](https://mastra.ai/blog/introducing-agent-to-agent-support)
- Computer/browser use: [najlepsze browser agenty 2026 (Firecrawl)](https://www.firecrawl.dev/blog/best-browser-agents) · [open-source CUA 2026](https://fazm.ai/blog/best-open-source-computer-use-ai-agents-2026) · [awesome-web-agents](https://github.com/steel-dev/awesome-web-agents)
- Pamięć grafowa: [Graphiti](https://github.com/getzep/graphiti) · [Graphiti MCP server](https://help.getzep.com/graphiti/getting-started/mcp-server) · [paper Zep: temporal KG dla pamięci agentów](https://arxiv.org/abs/2501.13956) · [Neo4j o Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- Kimi K3 / trend swarm: [Kimi Agent Swarm — 100 sub-agentów](https://www.kimi.com/blog/agent-swarm) · [K3 pricing/benchmarki](https://trilogyai.substack.com/p/kimi-k3-is-live-pricing-benchmarks) · [K3 API guide](https://www.verdent.ai/guides/agents/kimi-k3-api-guide)
