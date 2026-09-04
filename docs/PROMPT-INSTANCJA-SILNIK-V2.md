# Prompt startowy: instancja rozwijająca SILNIK durable orchestration V2

> Skopiuj wszystko poniżej linii jako pierwszą wiadomość do nowej instancji.

---

Pracujesz w `/projekty/mastra-agentic-environment/agentic-agents` nad **silnikiem** durable
orchestration V2. Kontynuuj bez zatrzymywania się na proszenie o zgodę na kolejny krok.

## Gdzie czytać (w tej kolejności)

| co | gdzie |
|---|---|
| **plan pracy** (bieżący, z dziennikiem) | `ideas/plan-dziecko-po-odlozeniu-g0.md` |
| **opis silnika** | `docs/ORCHESTRATION-V2.md` |
| **pełny status wszystkich agentów, workerów, tools i skilli** | `docs/STATUS-AGENTOW-SILNIK-V2.md` |
| karty agentów (menu routera) | `src/mastra/config/agent-board.ts` |
| co wolno routować + podłogi idle | `src/mastra/config/capability-routing.ts` |
| kontrakt trybu headless | `src/mastra/orchestration/execution/headless-contract.ts` |
| workflowy legacy (do porównań) | `src/mastra/workflows/` |

## Stan: co jest zrobione

Etapy **F1–F5B ZAMKNIĘTE**. Silnik potrafi dziś: przyjąć polecenie nieblokująco, zapisać je
trwale, **wybrać specjalistę z zamkniętego menu**, wykonać pod pełnym profilem harnessu, ocenić
własny wynik, ponowić próbę, zapytać człowieka i domknąć job — wszystko przeżywa restart procesu.

**F6 (cutover) jest rozpoczęte: 1/5 prac zamknięta.** Bridge `async-delegation` do durable jobs
jest zacommitowany i live-verified w izolacji, ale `FEATURE_ORCHESTRATION_V2_DELEGATION` pozostaje
domyślnie OFF i nie ma go w `.env`. F7 (migracja agentów), F8 (fault suite G8) i F9 (rollout)
pozostają nierozpoczęte.

⚠️ **W sensie cutoveru przeniesionych agentów jest ZERO.** V2 jest **addytywne** — legacy
(`void executeDelegation`) nadal obsługuje cały ruch produkcyjny. Osiem capability jest
osiągalnych przez V2 **równolegle**. Rollback = zakomentowanie czterech `FEATURE_ORCHESTRATION_V2*`.

## ⭐ TWÓJ NASTĘPNY ETAP: kontynuacja F6 — cutover mechanizmów tła

To jest **właściwy cel całego planu**, a wszystko przed nim było przygotowaniem. Pierwszy krok —
opt-in bridge dla `async-delegation` — jest zamknięty. Pozostały zakres z planu (§F6): Automation
Golden Path → trwałe tasks/attempts z realnym cancel; capability BUILD → odnawiany lease/fence; Task Ledger jako
**projekcja**, nie scheduler; `GAP-CUTOVER-01` — cutover żywych danych (jeden autorytatywny
wykonawca, reguła next-fire, drain pracy w locie, backfill + reconciliation).

**Zacznij od audytu PRZED pisaniem kodu.** Ten wzorzec zamknął F4 bez ani jednej linii kodu
i oszczędził 2–3 sesje: sprawdź, co z tego JUŻ istnieje, zanim uwierzysz własnemu planowi.
Konkretnie: `grep` konsumentów `startAsyncDelegation` / `executeDelegation` / `background-task-manager`
i ustal, które z nich mają już trwały odpowiednik w `orchestration/store/`.

**Znany, nierozstrzygnięty warunek poboczny** (opisany w planie, sekcja „ZGODA NA KOMENDĘ
W TRYBIE HEADLESS"): `requiresCodeCommandApproval` **zawiesza run i czeka na człowieka**, a w tle
nie ma komu odpowiedzieć. To ostatnia znana instancja klasy „mechanizm pod nadzór człowieka,
uruchomiony bez człowieka". Blokuje włączenie `codingAgent`. Rozstrzygnij to, jeśli F6 tego
dotknie — mechanizm `NEEDS_INPUT` już istnieje i jest rozpoznawany deterministycznie
w `FINAL_DECISION`.

## Jak testujesz (zasady kupione bólem, każda kosztowała pół sesji)

```bash
nvm use v22.20.0        # ⚠️ obowiązkowo
npm run build
ss -ltnp | grep :4111   # ⚠️ KTO trzyma port PRZED startem
FEATURE_ORCHESTRATION_V2_LIVENESS=true \
  MONGODB_DB_V2=orchestration_v2_<twoja-nazwa> \
  node .mastra/output/index.mjs &
```

Zlecenie przez Meta Front (nieblokujący):
`POST http://localhost:4111/v2/front/messages`, nagłówek `x-resource-id`, body
`{conversationId, message}`.

**Wynik czytaj Z BAZY, nie z odpowiedzi frontu** — `orch_jobs`, `orch_job_tasks`,
`orch_execution_results` w `MONGODB_DB_V2`.

1. **Node v22.** Pod v20 zbudowany serwer startuje, kończy boot i **NIE NASŁUCHUJE — bez żadnego
   błędu w logu.** Wygląda jak zawieszenie. `scripts/with-node.sh` obejmuje skrypty npm, ale
   **nie ręczny start serwera**.
2. **Sprawdź właściciela portu.** Start drugiego serwera wysyła Twój request do STAREGO; job ląduje
   w cudzej bazie, a próba pada na `connection … closed` z walki o Mongo — **wygląda jak wada
   agenta**. Po starcie potwierdź, że Twoja baza faktycznie dostaje joby.
3. **Świeża baza na canary.** Worker jest SERIAL — stary backlog zagłodzi nowy job i zmierzysz
   kolejkę, nie swoją zmianę.
4. **Nie ubijaj serwera w trakcie próby.** Praca wznawia się przy boocie (trwałość działa), ale
   backlog rośnie z każdym podejściem.
5. **`check:all` musi być zielone (52 pozycje) przed commitem.** `check:dashboard-orchestration`
   **bywa flaky, gdy serwer chodzi** (walczy o połączenia Mongo) — jeśli padnie, zatrzymaj serwer
   i powtórz; przechodzi w izolacji.

**Diagnostyka, którą już masz w logu serwera:**
- `[Harness] activity gaps: agent=… maxGap=…s events=… mode=…` — najdłuższa cisza w trakcie pracy
- `[orch-v2] run produced no deliverable — …` — mówi, KTÓRY kandydat został odrzucony
- `[artifacts] … stored OUTSIDE any harness run` — zapis nieprzypisany do runu
- `[meta-front] reply promised a notification it cannot send` — front obiecał push, którego nie ma

## ⚠️ DRUGA SESJA W TYM SAMYM DRZEWIE

Równoległa instancja pilnuje **jakości domenowej** (porównanie legacy↔V2 per agent) i edytuje
`prompts/`, `tools/<domena>/`, `scripts/check-<domena>-domain.ts`. Jej prompt startowy:
`docs/PROMPT-INSTANCJA-POROWNANIE-LEGACY-V2.md`.

- **Twój teren:** `src/mastra/orchestration/**`, `src/mastra/services/` (harness, budżety),
  `src/mastra/config/capability-routing.ts`.
- `git status --short` **przed** uznaniem bramy za wiarygodną. Jej edycja w toku raz wywaliła
  `check:all` błędem składni w `model-capabilities.ts` — wtedy weryfikuj **suitami docelowymi**.
- Commituj **wyłącznie jawnymi ścieżkami** (`git add <plik>`). **NIGDY `git add -A`** — raz
  skasowało to mój własny plik i zagarnęło cudzą pracę pod mój commit.

## Zasady, które w tej pracy wyszły najdroższej

**1. „Zbudowane i zielone" ≠ „wpięte".** Pięć osobnych awarii jednej klasy: `findArtifactIds`
dopasowywał ID, których runtime nie emituje (nie działał NIGDY, dla żadnego agenta); liveness był
nieosiągalny, bo caller zawsze podawał `timeoutMs`; `designAgent` nie miał ŻADNEGO narzędzia
zapisującego. **Testy były zielone, bo pisane z WYOBRAŻENIA o kształcie danych, nie ze ZRZUTU.**
Gdy coś sprawdzasz — weź prawdziwy zrzut i zbuduj test z niego.

**2. Nie odzyskuj faktu o runie z obiektu, który framework może przekształcić.** Zapisz go
w momencie zdarzenia (`services/run-artifacts.ts` — zapisujący odnotowuje zapis).

**3. Mierz przed przełączeniem.** Pierwsza podłoga idle była o 4% wyższa od realnej ciszy chefa
(230 s). Włączenie „tak jak było" zabiłoby pracujące runy — i wyglądałoby jak zawieszenie.

**4. Gdy trzecia naprawa tego samego objawu nie działa** — przestań poprawiać naprawę i sprawdź,
czy agent w ogóle **ma czym** wykonać zadanie.

**5. Test ma pilnować WŁASNOŚCI, nie formatowania źródła.** Asercja szukająca literalnego
`return { text: fullResponseText` padła po przeformatowaniu returna, choć kolejność, której
broniła, była nietknięta.

## Na koniec każdego etapu

Zaktualizuj `ideas/plan-dziecko-po-odlozeniu-g0.md` i `docs/ORCHESTRATION-V2.md` o to, co zostało
zrobione i **jaki był dowód**, po czym wyznacz następny krok. Raportuj uczciwie: jeśli coś nie ma
świeżego dowodu live, powiedz to wprost, zamiast sugerować, że przeszło.
