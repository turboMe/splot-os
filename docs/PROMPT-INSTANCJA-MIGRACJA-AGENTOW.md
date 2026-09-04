# Prompt startowy — instancja migrująca agentów na silnik V2

Pracujesz w `/projekty/mastra-agentic-environment/agentic-agents`. Kontynuujesz
**F7 — migrację agentów, jeden po jednym**. Pierwszy (`designAgent`) został
przeprowadzony przez pełne sito i canary; Twoim zadaniem są następni.

---

## 1. Przeczytaj, zanim cokolwiek dotkniesz

| co | gdzie |
|---|---|
| **sito migracyjne K1–K10 + protokół canary + karta per agent** | `docs/MIGRACJA-AGENTA-NA-V2.md` |
| plan z dziennikiem (F7 i wcześniejsze) | `ideas/plan-dziecko-po-odlozeniu-g0.md` |
| opis silnika | `docs/ORCHESTRATION-V2.md` |
| karty agentów (menu routera) | `src/mastra/config/agent-board.ts` |
| co wolno routować + podłogi idle | `src/mastra/config/capability-routing.ts` |

**Nie zaczynaj od kodu. Zacznij od sita.** Ono istnieje dlatego, że każdy
wcześniejszy canary znalazł defekt, którego deterministyczne testy nie łapały.

---

## 2. Stan: co znaczy „przeniesiony"

**Dziś ŻADEN agent nie ma odebranego ruchu legacy.** Osiem capability jest
*osiągalnych* przez V2 równolegle i przeszło canary; produkcja jedzie na legacy,
bo flagi F6 są domyślnie wyłączone. Rollback zawsze = zdjęcie flagi.

Jeśli ktoś (albo Ty) napisze „agent jest przepięty", sprawdź, czy nie znaczy to
tylko „jest w allowliście". To dwie różne rzeczy i mylenie ich jest kosztowne.

---

## 3. Ustalenie, które wyznacza KOLEJNOŚĆ

**Legacy to nie jedna ścieżka, tylko trzy** — i od tego zależy, czy V2 jest
ulepszeniem, czy regresją:

| ścieżka legacy | kto | V2 jest… |
|---|---|---|
| **generyczna** (gołe `agent.generate`) | design, analytics, crm, sales, marketing, reszta | ✅ **wyraźnie lepsze** — dokłada głębokość, reflektor, liveness, koperty |
| pipeline + reflektor | chef, content, hunt, writer, filmmaker, musician | porównywalne |
| **dedykowany harness + precontext** | coding, automation, knowledge, review | ✅ mechanizm gotowy (K3), ale wpis w rejestrze **tylko razem z canary** |

**K3 nie jest już blokadą mechanizmu** — `capability-precontext.ts` podaje
`contextBuilder` per capability i `automationArchitect` ma wpis (zweryfikowany
live). Dla coding/knowledge/review wpis jeszcze NIE istnieje i **nie dodawaj go
bez canary tego agenta**: wpis bez canary to deklaracja, nie zdolność.

**Nowa, ważniejsza granica — K11: czy produktem agenta jest TEKST.** Tryb
`bounded_text` ocenia run po niepustym tekście. Agent, którego produktem jest
**efekt w świecie**, może wykonać pracę i dostać `FAILED` — a wtedy silnik
**powtarza akcję w świecie**. Zmierzone na `automationArchitect`. Zanim ruszysz
agenta piszącego na zewnątrz (marketing, sales, hunt, knowledge, coding),
sprawdź, czy kończy run PRODUKTEM (tekst albo zapisany artefakt).

---

## 4. Kolejność i znane blokady

| # | agent | ścieżka | efekt w świecie | znane blokady |
|---|---|---|---|---|
| 1 | ~~`designAgent`~~ | generyczna | płatna generacja | ✅ zrobiony — karta w `docs/MIGRACJA-AGENTA-NA-V2.md` §5; **jego canary naprawił kanał artefaktów dla WSZYSTKICH agentów** |
| 2 | `automationArchitect` | dedykowany harness | **deploy do n8n** | K3 precontext (`automation-precontext.ts`); Golden Path już jedzie durable po F6 |
| 3 | `huntAgent` | pipeline | zapisy do CRM | — |
| 4 | `marketingAgent` | generyczna | Gmail, CRM, kalendarz | — (sufit 5→25 naprawiony) |
| 5 | `salesAgent` | generyczna | Gmail, CRM, kalendarz | — (sufit 5→25 naprawiony) |
| 6 | `knowledgeAgent` | dedykowany harness | **tworzy notatniki w Google użytkownika** | K3 precontext + K8 MCP |
| 7 | `filmmakerAgent`, `musicianAgent` | pipeline | płatna generacja | najpierw suchy przebieg bez płatnej generacji |
| 8 | `codingAgent` | dedykowany harness | repo | ⛔ K7: `requiresCodeCommandApproval` **zawiesza run**, a w tle nie ma komu odpowiedzieć |

---

## 5. ⛔ Granica, której nie przekraczaj sam

**Wszyscy pozostali agenci mają ciężki promień rażenia** — pieniądze, zapis na
zewnątrz (CRM, Gmail, Google użytkownika), albo zmianę systemu (deploy n8n, repo).

**K10 to decyzja właściciela, nie audytu.** Nie włączaj agenta, którego efektu
w świecie użytkownik nie autoryzował wprost. Zapytaj, nazywając konkretny efekt
(„błędna trasa wyśle maila z Twojego Gmaila", a nie „to pisze na zewnątrz").

---

## 6. Jak testujesz — zasady kupione bólem

```bash
nvm use v22.20.0        # ⚠️ obowiązkowo; pod v20 serwer startuje i NIE nasłuchuje, bez błędu
npm run build
ss -ltnp | grep :4111   # ⚠️ KTO trzyma port PRZED startem
```

Canary uruchamiaj przez **`ORCHESTRATION_V2_CAPABILITIES`**, nigdy przez edycję
`DEFAULT_V2_CAPABILITIES` — canary nie zmienia produkcji:

```bash
FEATURE_ORCHESTRATION_V2_LIVENESS=true \
ORCHESTRATION_V2_CAPABILITIES='researcherAgent,chefAgent,contentAgent,writerAgent,analyticsAgent,deliberationAgent,crmAgent,designAgent,<NOWY>' \
MONGODB_DB_V2=orchestration_v2_canary_<nowy> \
node .mastra/output/index.mjs &
```

1. **Świeża baza V2 na każdy canary** — worker jest SERIAL, stary backlog zagłodzi
   nowy job i zmierzysz kolejkę, nie swoją zmianę.
2. **Wynik czytaj Z BAZY** (`orch_jobs`, `orch_job_tasks`, `orch_job_attempts`,
   `orch_execution_results`), nie z odpowiedzi frontu.
3. **`npm run check:all` musi być zielone: 0 błędów I 0 SKIP-ów.** Brama sama
   podnosi efemeryczny replica set i `REQUIRE_RS=1` zamienia pominięcie w błąd.
4. **Nie ubijaj serwera w trakcie próby** — praca wznawia się przy boocie, ale
   backlog rośnie.

**Diagnostyka, którą już masz w logu serwera:**
- `[Harness] step ceiling raised to the agent's own N (profile: M)` — K1 działa
- `[Harness] Depth: fast|standard|deep (score=…)` — jaki profil dostał run
- `[Harness] activity gaps: agent=… maxGap=…s` — najdłuższa cisza w trakcie pracy
- `[orch-v2] run produced no deliverable — …` — KTÓRY kandydat został odrzucony
- `[meta-front] reply promised a notification it cannot send`
- `[artifacts] <id> was stored OUTSIDE any harness run` — zapis, którego żaden job
  nie może oddać jako wyniku

**Endpoint canary (sprawdzone — nagłówek i pole łatwo pomylić):**

```bash
curl -s -X POST http://localhost:4111/v2/front/messages -H 'Content-Type: application/json' -H 'x-resource-id: canary_x' -d '{"conversationId":"conv_1","message":"<zlecenie>"}'
```

**Po canary agenta, który produkuje pliki, sprawdź w bazie `producer.artifacts`** —
nie tylko `data.text`. Pusta tablica przy zapisanym pliku to defekt, nie detal.

---

## 7. Reguły, które w tej pracy wyszły najdrożej

**1. „Zbudowane i zielone" ≠ „wpięte".** `findArtifactIds` dopasowywał ID, których
runtime nie emituje — nie działał NIGDY, dla ŻADNEGO agenta. Liveness był
nieosiągalny, bo caller zawsze podawał `timeoutMs`. `designAgent` nie miał ŻADNEGO
narzędzia zapisu. **Testy były zielone, bo pisane z WYOBRAŻENIA o kształcie danych.**

**1b. Ten wzorzec wrócił przy PIERWSZYM agencie — spodziewaj się go przy swoim.**
Canary designu znalazł **martwy kanał artefaktów**: plik powstawał, a referencja
do niego ginęła, bo (a) `ModelCaller` nie miał pola na id i caller je wyrzucał,
(b) czytnik szukał `a.id`, gdy kontrakt mówi `artifactId`. Następny krok sekwencji
dostawał 2 KB urywek 18 KB dokumentu. **Stara brama tego nie widziała, bo sama
wstrzykiwała `artifacts: ['art-1']` do kontekstu i sprawdzała render.**
→ Naprawione; pilnuje tego `npm run check:artifact-handoff` i kryterium **K9b**.
**Wniosek dla Ciebie: gdy sprawdzasz pole, sprawdź też KTO je wypełnia.** Pusty
kontener wygląda identycznie jak brak danych.

**2. Nie testuj przeciwko własnej atrapie.** Trzy razy z rzędu bug chował się za
test doublem (`findArtifactIds`, `readResult`, `consumeApproval`). **Gdy test
nazywa się od jakiejś logiki, ta logika MUSI się w nim wykonać.**

**3. Statyczny toolset zaniża agenta.** `knowledgeAgent` wygląda na 8 wewnętrznych
narzędzi, a realnie pisze do Google użytkownika przez sidecar MCP. Czytaj też
importy `../mcp.js`.

**4. Gdy trzecia łatka nie działa — przestań łatać i DOMKNIJ MAPĘ.** Bariera stopu
miała cztery punkty obrony, a decydujący był pierwszy, nie ostatni.

**5. Mierz przed przełączeniem.** Podłoga idle była o 4% wyższa od realnej ciszy
chefa. „Tak jak było" zabiłoby pracujące runy i wyglądałoby jak zawieszenie.

**6. Audyt, którego awarie wyglądają jak jego ustalenia, jest gorszy niż żaden.**
Zduplikowany odczyt `maxSteps` dał 18 fałszywych ustaleń naraz.

---

## 8. ⚠️ Druga sesja w tym samym drzewie

Sprawdź `git status --short` **przed** uznaniem bramy za wiarygodną. Commituj
**wyłącznie jawnymi ścieżkami** (`git add <plik>`). **NIGDY `git add -A`** — raz
zagarnęło to cudzą pracę pod mój commit.

---

## 9. Na koniec każdego agenta

1. Wypełnij **kartę migracji** z `docs/MIGRACJA-AGENTA-NA-V2.md` §4 i wklej ją do
   `ideas/plan-dziecko-po-odlozeniu-g0.md`.
2. Zaktualizuj `docs/ORCHESTRATION-V2.md` o to, co canary złapał.
3. Raportuj uczciwie: **jeśli czegoś nie sprawdziłeś live, powiedz to wprost**,
   zamiast sugerować, że przeszło.
