# Dług techniczny — budżety czasu i limity

**Stan:** 2026-07-29, po wdrożeniu liveness (L1–L5).
**Źródło:** [audyt timeoutów](../ideas/timeouts-audit.md) · [plan liveness](../ideas/liveness-budget-plan.md)

Ten dokument jest listą **świadomie odłożonych** rzeczy — nie zapomnianych.
Każda pozycja ma: co, dlaczego boli, dlaczego odłożone, jak duże.

---

## Co JEST już naprawione (żeby nie szukać dwa razy)

| # | Rzecz | Gdzie |
|---|---|---|
| — | Wall-clock tnący pracującego agenta → **liveness** | `run-budget.ts`, `generate-with-harness.ts` |
| K8 | Martwa dźwignia `maxStepsWithoutProgress` (standard: 25 = maxSteps → nigdy nie odpalała) | `depth-controller.ts` |
| K11 | film/music polling i download bez limitu; ElevenLabs sync bez **żadnego** limitu | `film-generate.ts`, `music-generate.ts` |
| K17 | **Ollama health probe** bez limitu (blokował discovery modeli dla wszystkich agentów), weather, Google Places | `ollama-gateway.ts`, `weather-*`, `reviews-google-place.ts` |
| K18 | 9× git bez limitu (zawieszony `git merge` blokował codingAgent bez końca) | `code-worktree.ts` |
| — | 3 checki delegacji istniały w repo, ale **nigdy nie uruchamiane** | `package.json` → `check:all` |
| **K3/K4** | budżety dzieci > rodzica → sieroty mutujące n8n/Mongo (**DŁUG A, zamknięty**) | `delegate-task.ts`, `e3978d3` |
| **K2** | pipeline: 150 kroków bez zegara (**DŁUG B, zamknięty**) | `generate-pipeline-with-reflection.ts`, `a7319c7` |
| — | `abortSignal` nie przechodził przez granicę delegacji — timeout przerywał **czekanie, nie pracę** | `harness-execution-context.ts`, `e3978d3` |
| — | pending: crash po claim **gubił wiadomość** → lease/ACK + redelivery | `pending-message-queue.ts`, `b4f9ec3` |
| — | guard bypassu harnessu nie pokrywał `.stream()` i **nie był w bramce** | `audit-coding-generate.ts`, `8876788` |

---

## ~~DŁUG A~~ — koordynacja budżetu rodzic↔dziecko (K3, K4) ✅ ZAMKNIĘTY 2026-07-29

> **Zamknięty w F3** (`e3978d3`). Sync coding/knowledge przechodzą przez
> `resolveDelegationBudget`; automation przy **niewykonalnym oknie routuje do async**
> zamiast startować sync, który dowodliwie nie zdąży (sam cap by go zepsuł — golden-path
> build realnie potrzebuje więcej niż okno rodzica). Ścieżka async świadomie **bez** capa:
> przeżycie rodzica jest tam intencją. Dodatkowo `abortSignal` przechodzi teraz przez granicę
> delegacji, więc przerwanie rodzica **zatrzymuje pracę**, nie tylko czekanie.
> Dowód: `e2e:delegation-abort` (7 asercji, w `check:all`).
>
> Poniższy opis zachowany jako kontekst historyczny.

<details><summary>Oryginalny opis</summary>

**Co:** przy delegacji część ścieżek pyta o pozostały budżet rodzica
(`resolveDelegationBudget`, [delegate-task.ts](../src/mastra/tools/system/delegate-task.ts) linie 636/716/747),
a część ma **zaszyte liczby**:

| linia | wartość | agent |
|---|---|---|
| 99 | `1_200_000` (20 min) | automation |
| 379, 408 | `300_000` | coding |
| 567, 593 | `300_000` | knowledge |

**Dlaczego boli:** rodzic umiera po swoim budżecie, dziecko biegnie dalej — **mutując n8n i Mongo bez nikogo, komu mogłoby zwrócić wynik**. To realne procesy-sieroty, nie teoria (audyt K3 opisuje zaobserwowany przypadek).

**Dlaczego odłożone:** liveness pilnuje, *czy dany agent żyje*; nie ma nic do powiedzenia o tym, *ile czasu rodzic obiecał dziecku*. To osobny mechanizm.

**Częściowo poprawione:** ścieżki używające `resolveDelegationBudget` dostają teraz uczciwą liczbę także w trybie liveness (bo `getRemainingRunBudgetMs` odpowiada w obu trybach). Zaszyte — nie.

**Rozmiar:** ~1 sesja. Ryzyko: średnie (dotyka żywej delegacji).

---

</details>

---

## ~~DŁUG B~~ — pipeline bez własnego zegara (K2) ✅ ZAMKNIĘTY 2026-07-29

> **Zamknięty w F3/CAN-002** (`a7319c7`). Pipeline ma teraz realny cancel (`AbortSignal`
> przekazywany do `agent.generate`, `withDelegationTimeout` **abortuje** zamiast porzucać
> czekanie) oraz własny bound: **liveness** (cisza + hard cap), a nie zegar — render czy
> rekonesans legalnie trwa minuty. Liveness startuje tylko tam, gdzie wpięty jest
> `prepareStep`, inaczej zdrowy run wyglądałby na milczący.
> Manifest: `CAN-002` = `implemented` (**nie** `verified` — brak żywego przebiegu).
>
> Poniższy opis zachowany jako kontekst historyczny.

<details><summary>Oryginalny opis</summary>

**Co:** `chefAgent`, `contentAgent`, `huntAgent`, `writerAgent`, `filmmakerAgent`, `musicianAgent`
idą przez `generate-pipeline-with-reflection.ts` — **świadomie bez depth controllera**: 150 kroków, **zero** wall-clocka.
Ogranicza je wyłącznie timeout delegacji od rodzica.

**Dlaczego boli:** 150 kroków w oknie ≤240 s jest fizycznie nieosiągalne — te agenty **zawsze** kończą timeoutem delegacji, nigdy step-capem. Deklarowany limit 150 jest fikcją.

**Dlaczego odłożone:** liveness rozwiązuje to elegancko (etap L6 planu), ale wymaga wpięcia rejestru w ścieżkę pipeline'ową, która dziś w ogóle nie zna pojęcia budżetu.

**Rozmiar:** ~1 sesja. Ryzyko: niskie (dodanie ochrony tam, gdzie dziś jej nie ma).

---

</details>

---

## DŁUG C — długi ogon narzędzi (K9, K10, K12–K16)

Kilkanaście niezależnych drobiazgów. **Nie jeden mechanizm** — dlatego nie da się ich „naprawić raz".

| # | Co | Skutek |
|---|---|---|
| K9 | design: narzędzia 900 s pod delegacją 240 s | agent ginie, `ffmpeg`/Playwright zostaje żywy |
| K10 | `design_narrate_pipeline` liczy limit **per chunk**, nie per pipeline | 20 chunków × 1800 s = teoretycznie 10 h |
| K12 | jeden limit 180 s dzielony przez 5 serwerów MCP (w tym Playwright) | dwa wywołania Playwrighta nie zmieszczą się nigdy |
| K13 | NotebookLM: **cztery** różne liczby dla jednej operacji | `deep research` (600 s) nie ma szans pod delegacją 300 s |
| K14 | Tavily: trzy sprzeczne budżety dla tego samego API | — |
| ~~K15~~ | ~~trzy rywalizujące narzędzia „wykonaj polecenie"; `external-projects-tools.ts:79` używał **`execSync`**~~ | ✅ **zamknięty 2026-07-29** (`e0c80d2`) — patrz niżej |
| K16 | 9 wywołań modelu **bez żadnego limitu** (`workflows/analytics`, `marketing`, `sales`) | nieskończone czekanie |

**Dlaczego odłożone:** w L3 naprawiono z tego wyłącznie to, co było **warunkiem koniecznym** dla liveness — zawieszone I/O (bo cisza z powodu zawisu wyglądałaby jak śmierć). Reszta to dług, nie architektura.

**K15 zamknięty** (`e0c80d2`): `runExternalProjectCommandTool` zmieniony z `execSync` na `spawn`
async (ten sam wzorzec co `meta-execute-command.ts`), z prawdziwym `SIGKILL` na timeoucie.
**Detal złapany przez nowy test, nie od razu oczywisty:** `child.kill()` na samym procesie
shella NIE wystarcza dla poleceń złożonych (`sleep 5 && echo x`) — bash forkuje `sleep` jako
dziecko, na które tylko czeka, więc zabicie shella zostawia `sleep` jako sierotę biegnącą
dalej. Naprawione przez `spawn(..., {detached:true})` + `process.kill(-child.pid, 'SIGKILL')`
(zabija całą grupę procesów, nie tylko lidera). `check:external-project-command-nonblocking`
(w `check:all`) dowodzi obu właściwości wprost na prawdziwym `runCommand`: event loop tyka
podczas działania dziecka (execSync by go zablokował), a polecenie przekraczające timeout
jest naprawdę zabite, nie zostawione wiszące. **K16 teraz najgroźniejsza otwarta pozycja**
(nieskończone czekanie, 9 gołych wywołań modelu bez limitu).

**Rozmiar:** ~1–2 sesje na całość, albo pojedynczo gdy zaboli.

---

## DŁUG D — ściana HTTP i klasyfikator (P0 z audytu)

**Co:**
1. `@mastra/deployer` wymusza **niewidoczny `timeout(180 s)`** na każdy request HTTP do :4111. Nie ma go w `.env`, `.env.example`, `deploy.config.json` ani `index.ts`. **Wszystkie budżety >180 s są nieosiągalne** po nie-streamingowym HTTP.
   Furtka, której nikt nie udokumentował: odpowiedź **streamingowa** przeżywa (Hono `timeout()` to `Promise.race`, a strumień rozwiązuje `next()` przy nagłówkach). Czyli `/stream` żyje, `/generate` nie.
2. Klasyfikator nie zna najczęstszych polskich trybów rozkazujących (`zrób`, `wygeneruj`, `przygotuj`, `znajdź`, `napisz`, `stwórz`) → naturalne polecenia lądują w profilu `fast` (60 s).

**Dlaczego odłożone:** liveness usunął **pilność** tego problemu — agent nie jest już cięty za długą pracę, więc niski profil boli mniej. Ale ściana HTTP nadal obowiązuje dla **synchronicznej** odpowiedzi.

**Uwaga:** to jest miejsce, gdzie kusi „przy okazji" zbudować job/lease/fencing z
[timeouts-architecture-implementation-plan.md](../ideas/timeouts-architecture-implementation-plan.md).
**To jest odłożona orkiestracja** ([handoff](./ORCHESTRATION-PAUSED-HANDOFF.md)) — nie budować jej ukradkiem.

**Rozmiar:** ściana ~0,5 sesji; klasyfikator ~0,5 sesji.

---

## DŁUG E — infrastruktura i higiena (I1–I16, fosylia)

Najważniejsze z audytu §5:

- **I5** — `curl` **bez `--max-time`** dokładnie w dwóch ścieżkach decydujących o rollbacku (`deploy-blue-green.sh:305`, `watchdog.sh:203`). Każdy inny probe w repo jest ograniczony. Zawieszony rollback = brak rollbacku.
- **I7** — dashboard poluje co 2–3 s **bez timeoutu po stronie klienta**; `/dashboard/active-topology` robi w środku żywe `n8n.listWorkflows()` bez limitu. Requesty piętrzą się do ściany 180 s.
- **I8** — `?limit` **bez clampa** na 8 endpointach → `?limit=10000000` trzyma handler i może wyOOM-ować proces.
- **I10** — split-brain stref czasowych: n8n `Europe/Warsaw` vs `AUTOMATION_DEFAULT_TIMEZONE=Atlantic/Reykjavik` → crony rozjeżdżają się o 1–2 h zależnie od DST.
- **I11** — samoleczenie wygląda na włączone, ale jest **rozbrojone** (`ERROR_COLLECTOR_ENABLED=false`, `OBSERVE_ONLY` wymuszany na `true`), a `/deploy/auto-heal-status` raportuje `"stable"`.
- **I12** — duplikaty kluczy w `.env` (wygrywa ostatni): `CHEF_DOCS_DIR` (drugi **pusty**), `NLM_BINARY_PATH`.
- **I13** — rozjazdy `.env` ↔ `.env.example` → świeży klon dostaje inne zachowanie niż produkcja.
- **I15** — CORS `origin:'*'` na bramce zatwierdzania **płatnych akcji**.
- **I16** — brak jakiejkolwiek supervizji procesu Mastry (bez systemd/PM2; gołe `node ... &` z pidfile).

**Fosylia (martwy kod / martwe zmienne):** `META_AGENT_MAX_STEPS`, `META_AGENT_SYNC_TIMEOUT_MS`, `AUTOMATION_MAX_FIX_ATTEMPTS` — **zero odwołań w kodzie**, ale wyglądają jak działające pokrętła. `waitForClaims`, `waitForBackgroundTask` — brak callerów.

**Rozmiar:** I5/I8/I12 to minuty każde. I11/I16 to decyzje operacyjne, nie kod.

---

## Kolejność, gdyby wracać do tego wprost

```
1. ~~K15 (execSync zamraża serwer)~~       — ✅ zamknięty 2026-07-29 (`e0c80d2`)
2. I5  (curl bez limitu w rollbacku)       — minuty, chroni deploy
3. ~~DŁUG A (K3/K4 sieroty)~~              — ✅ zamknięty 2026-07-29 (F3)
4. ~~DŁUG B (pipeline bez zegara)~~        — ✅ zamknięty 2026-07-29 (CAN-002)
5. DŁUG D (ściana HTTP + klasyfikator)     — gdy sync >180 s zacznie boleć
6. reszta C i E                            — gdy zaboli konkretnie
```

**Stan po 2026-07-29:** z pięciu grup zamknięte są **A** i **B** w całości, **K15** z grupy C,
oraz reszta **C** częściowo (K11/K17/K18 przez L3). Najgroźniejsza otwarta pozycja teraz to
**K16** — 9 gołych wywołań modelu bez żadnego limitu (nieskończone czekanie, nie zamrożenie
serwera).

**Zasada:** nic z tego nie jest blokerem warstwy agentów. To lista do sięgnięcia,
gdy konkretna rzecz zaboli — nie plan do odhaczenia po kolei.
