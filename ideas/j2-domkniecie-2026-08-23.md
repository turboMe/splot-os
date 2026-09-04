# J2 — audyt po wykonaniu 6 kroków. Co zostało do domknięcia

**Data:** 2026-08-23, wieczór
**Kontekst:** kroki 1–6 planu `ideas/j2-parallel-dispatch-2026-08-23.md` zostały
wykonane (commity `fcc9ebc`, `f8e45d9`, `1fa75f0`, `30ac857`, `8be25e9`,
`d315fd1`, `9be0ca6`). Ten dokument jest **niezależną weryfikacją** tamtej pracy
pod kątem pytania właściciela: *czy przy obciążającej pracy agentów, wielu
delegacjach i zapisach czegoś nie zabraknie.*

---

## 0. Co jest zrobione dobrze (weryfikacja, nie streszczenie)

| krok | stan | dowód |
|---|---|---|
| 1 zapis atomowy + atrybucja | ✅ | `$pull`/`$push`, brak `$set` całej tablicy |
| 2a atrybucja z runu, nie od modelu | ✅ | bramka wywołuje narzędzie **bez** `subtaskId` i wpis i tak go niesie; log `[coding] subtask scope taken from the run: run-subtask (the call said model-invented-subtask)` |
| 2b odczyt filtruje + zawór | ✅ | `collectSubtaskResult` filtruje, zawór all-legacy działa, mieszane dane go nie wyzwalają |
| 3 limit falowy | ✅ | default 3, wyniki wyrównane po indeksie, `allSettled` zachowane |
| 4 rozłączność zapis–zapis | ✅ | bramka zielona w obie strony |
| 5 osobny wątek per subtask | ✅ | 4 asercje, w tym brak zdarzeń krzyżowych |
| 6 fencing | ✅ | realna elekcja na rs3f8, **obie połowy**: nieprzeciwstawiony kończy, wyprzedzony jest odcięty. Realnie wpięty w `executeSubtask` (claim → heartbeat → yield) |

**`npm run check:all` — 93 zielone, 0 czerwonych, exit 0.** Pierwszy raz od
rana przechodzi w całości (blokada z linii 86 naprawiona commitem `aef7062`).
Mastra zrestartowana, wstaje w ~10 s, 30 agentów.

To jest solidna robota. Poniższe luki **nie podważają** kroków 1–6 — dotyczą
sąsiednich ścieżek, których plan nie obejmował, a które przy równoległości
zaczynają boleć.

---

## 1. LUKA A (krytyczna) — `tsc` po każdym zapisie, na współdzielonym worktree, z limitem 15 s

`code-change-ledger.ts:928` — po **każdym** zapisie pliku `.ts`/`.tsx`:

```ts
await execAsync('npx tsc --noEmit', { cwd: workspacePath, timeout: 15000 });
```

**ZMIERZONE dziś na bezczynnej maszynie: `npx tsc --noEmit` trwa 16,45 s.**
Limit wynosi 15 s. Czyli **przekracza go już bez żadnego obciążenia** — a przy
trzech równoległych subtaskach (domyślny limit fali) mamy trzy pełne przebiegi
tsc na jednym drzewie naraz.

Trzy skutki, każdy realny:

1. **Kłamliwy komunikat na każdym zapisie.** Po timeoucie `execError.stdout`
   jest pusty, więc `fileErrors.length === 0` i wiadomość brzmi:
   *„WARNING: Project does not compile, but tsc errors may relate to other
   files."* To zdanie trafia do wyniku narzędzia praktycznie **zawsze**, i jest
   nieprawdziwe — projekt kompiluje się poprawnie (`tsc --noEmit` = 0 błędów).
2. **Model dostaje fałszywy sygnał alarmowy po każdym zapisie** i może zacząć
   „naprawiać" nieistniejące błędy — albo trafić w heurystykę
   `agent_reported_failure` w `validateSubtaskQuality`.
3. **Pełny tsc nie potrafi odpowiedzieć na pytanie, które zadaje.** Jego celem
   jest „czy JA zepsułem TEN plik", a przy równoległości w tym samym drzewie
   leżą niedokończone edycje sąsiadów. Odpowiedź jest o cudzej pracy.

> **DECYZJA:** weryfikacja kompilacji **nie należy do ścieżki zapisu** przy
> równoległym dispatchu. Ma ją robić rola `terminal`/`qa` po zamknięciu grupy —
> po to ten podział ról istnieje.
>
> 1. Gdy w kontekście runu jest dzierżawa subtaska (czyli jedziemy pod
>    dispatchem) — **nie odpalać tsc w ogóle** przy zapisie.
> 2. Poza dispatchem (tryb jednoagentowy) zostawić, ale **podnieść limit powyżej
>    zmierzonego czasu** (16,45 s → minimum 60 s; limit ma łapać zawieszenie, nie
>    normalną pracę — ta sama reguła co przy podłogach idle liveness).
> 3. Komunikat po timeoucie ma mówić **„weryfikacja nie zdążyła"**, nigdy
>    „projekt się nie kompiluje". Narzędzie nie ma prawa twierdzić czegoś, czego
>    nie sprawdziło.

**Sprawdzenie (falsyfikowalne):** zapis `.ts` z dzierżawą w kontekście nie
uruchamia żadnego procesu tsc (obecnie uruchamia); zapis bez dzierżawy, przy
sztucznie zaniżonym limicie, produkuje komunikat, który **nie** zawiera
twierdzenia o niekompilowaniu się projektu.

**Stan 23.08 — ✅ DOMKNIĘTA.** Nowa bramka
`check:tracked-write-tsc-scope` najpierw oblała trzy asercje na starym kodzie:
rzeczywisty zapis przez tool Mastry uruchomił sondę `npx` mimo prawdziwej
dzierżawy z rs3f8, timeout zwrócił modelowi „Project does not compile", a limit
60 s nie istniał. Po poprawce ten sam test przechodzi: zapis pod lease nie
uruchamia procesu, tryb jednoagentowy ma limit 60 s, a przerwana weryfikacja
mówi wprost, że nie zdążyła i stan kompilacji jest nieznany. Bramka jest wpięta
w `check:all`; `check:subtask-file-attribution` oraz `tsc --noEmit` pozostają
zielone.

---

## 2. LUKA B (wysoka) — `commandsRun` bez atrybucji zatruwa całe zadanie

Krok 2 naprawił atrybucję **plików**. **Komend nie.** Łańcuch, cały zweryfikowany
w źródle:

| miejsce | stan |
|---|---|
| `commandRunSchema` (`code-task-artifacts.ts:51`) | **brak pola `subtaskId`** — nie ma go nigdzie w kodzie |
| `collectSubtaskResult:1023` | `(artifact.commandsRun ?? []).map(...)` — **bez filtra**, komendy całego zadania |
| `collectSubtaskResult:1029` | `hasErrors` liczone z tsc **całego zadania** |
| `executeSubtask:280` | ta lista wchodzi do wyniku **każdego** subtaska |
| `validateSubtaskQuality:461` | `commandsRun.find(c => c.command.includes('tsc'))` → sygnał `tsc_errors` |
| `buildScopedPrompt:881` i `:949` | prompt **każe** każdemu `file-editor` odpalić `npx tsc --noEmit` |

**Efekt jest gorszy niż zwykły wyścig — to trwałe zatrucie.** `commandsRun`
rośnie przez `$push` i nic go nie czyści, a `find` bierze **pierwszy** wpis. Więc
pierwszy nieudany `tsc` w zadaniu oznacza, że **każdy kolejny subtask, w każdej
kolejnej grupie, aż do końca zadania** dostaje `hasErrors: true`, status
`partial` i sygnał `tsc_errors` → retry → eskalacja na przypięty
`deepseek-v4-pro`. Późniejszy udany tsc tego nie cofa.

To dokładnie ten tryb awarii, przed którym miał chronić krok 2 — naprawiony dla
plików, pominięty dla komend. Defekt jest **zastany** (nie wprowadziło go J2), ale
J2 podnosi jego koszt proporcjonalnie do liczby subtasków.

> **DECYZJA:** symetria z krokiem 2, punkt po punkcie.
> 1. `subtaskId` do `commandRunSchema` (opcjonalny, dokładnie jak w `fileChangeSchema`).
> 2. `coding_run_test` zapisuje go **z kontekstu runu**, nie z argumentu modelu
>    (ta sama reguła co 2a — inaczej odtworzymy problem, który 2a rozwiązał).
> 3. `collectSubtaskResult` filtruje `commandsRun` po `subtaskId`, z **tym samym
>    zaworem all-legacy** co dla plików.
> 4. Przy okazji: `find` → **ostatni** wpis tsc subtaska, nie pierwszy. Udana
>    weryfikacja po nieudanej ma ją unieważniać; dziś nie unieważnia.

**Sprawdzenie:** artefakt z nieudanym tsc subtaska A i czystą pracą B → B
przechodzi jakość, A nie (dziś oblewają oba). Druga asercja: późniejszy udany tsc
tego samego subtaska kasuje wcześniejszy sygnał.

**Stan 23.08 — ✅ DOMKNIĘTA.** Przed poprawką realna bramka wykazała pięć
niezależnych czerwonych własności: `coding_run_test` wywołany przez prawdziwy
harness zapisał dwie komendy bez atrybucji z runu; B widział komendę A;
późniejszy zielony tsc nie kasował czerwonego; komendy legacy nie miały głośnego
zaworu; dane mieszane wracały task-wide. Dodatkowa bramka jakości oblała wybór
pierwszego tsc. Po poprawce `commandRunSchema` ma opcjonalny `subtaskId`, zapis
bierze go z już znormalizowanego kontekstu runu, czytelnik ma niezależny zawór
all-legacy i filtr per subtask, a collector oraz quality gate czytają ostatni tsc
danego subtaska. `check:subtask-file-attribution`,
`check:subtask-quality-loop` i `tsc --noEmit` są zielone.

---

## 3. LUKA C (średnia, ale cicho cofa krok 2) — `coding_update_artifact` nadpisuje całe tablice

Opis narzędzia (`code-task-artifacts.ts:256`) brzmi dosłownie:

> *„Provided fields replace previous values, so provide a complete state for updated lists."*

czyli **wprost instruuje model, żeby przysłał kompletne listy zastępujące
poprzednie**. `execute` robi `$set` na `filesChanged`, `commandsRun`, `plan`,
`filesRead`, `approvalsRequested`. A `buildScopedPrompt` każe subtaskom wołać
`coding_update_artifact` po zakończeniu pracy.

**Fence z kroku 6 tego nie zasłania i nie miał zasłaniać.** Dzierżawa jest
**per-subtask** (`leaseKeyFor(subtaskId)` = hash w `subtaskLeases.<klucz>`), więc
dwa różne subtaski przechodzą swoje filtry **jednocześnie** — tak ma być, one mają
biec równolegle. Fence odcina nieaktualną kopię *tego samego* subtaska, nie
sąsiada.

Dwa skutki:
- **(a)** klasyczny lost update między równoległymi subtaskami — ten sam kształt,
  który naprawiliśmy w `upsertArtifactFileChange`, tylko innym wejściem;
- **(b)** groźniejszy: model podający `filesChanged` **nie zna cudzych
  `subtaskId`** i ich nie poda. Jedno takie wywołanie **kasuje atrybucję całego
  zadania** → `hasAttributedChanges` = false → włącza się zawór all-legacy → znów
  każdy widzi wszystko. **Krok 2b cofa się sam, cicho, bez błędu.**

> **DECYZJA:** `filesChanged` i `commandsRun` to **rejestry pisane przez
> narzędzia, które znają prawdę** — model nie ma ich czym poprawić, może je
> tylko zgubić. Pod dzierżawą wartości podane przez model dla tych dwóch pól
> **ignorujemy** i logujemy, że zostały zignorowane. `plan`, `filesRead`,
> `approvalsRequested` pod dzierżawą przechodzą na semantykę dokładającą
> (`$addToSet`/`$push`) zamiast zastępującej. Poza dzierżawą — zachowanie bez
> zmian, żeby nie ruszać trybu jednoagentowego.
>
> Opis narzędzia trzeba poprawić razem z kodem: dopóki mówi „replace", model
> będzie robił to, co mówi.

**Sprawdzenie:** pod dzierżawą wywołanie `coding_update_artifact` z
`filesChanged` nie zmienia zapisanej tablicy i atrybucja przeżywa; bez dzierżawy
dzisiejsze zachowanie zostaje.

**Stan 23.08 — ✅ DOMKNIĘTA.** Czerwona bramka użyła realnego Mongo i dwóch
równoległych, prawidłowych lease’ów różnych subtasków. Na starym kodzie ostatnie
wywołanie zostawiło wyłącznie modelowy `filesChanged` zwycięzcy, kasując oba
faktyczne wpisy i ich atrybucję; osobno oblał opis nakazujący zastępowanie.
Kontrola bez lease’u była zielona już przed poprawką. Po zmianie pod lease’em
`filesChanged` i `commandsRun` są ignorowane z głośnym logiem opartym na
tożsamości lease’u, a `plan`, `filesRead` i `approvalsRequested` są atomowo
dokładane przez `$addToSet/$each`. Bez lease’u kompletne listy nadal zastępują
stan. F8 został przepięty z niedozwolonego rejestru na addytywny `plan`; przeszedł
obie realne połowy (krótka partycja bez takeover oraz elekcja z `fence 1 → 2`),
po czym uzdrowił i zostawił rs3f8 jako 3/3 członków. Zielone:
`check:subtask-file-attribution`, `f8:subtask-artifact-fencing`, `tsc --noEmit`.

---

## 4. LUKA D (niska, higiena) — `.env` vs `.env.example`

29 kluczy jest w `.env.example`, nie ma w `.env`. **Większość jest nieszkodliwa** —
sprawdziłem defaulty w kodzie, nie zgadywałem:

- 12 flag `FEATURE_*` (m.in. `SKILL_DISTILLATION`, `GRAPHIFY`, `LEDGER_V1`,
  `IDEMPOTENCY`, `COMM_CONTRACTS`, `AUTOMATION_FINALIZE_ON_DELIVERABLE`) ma w
  kodzie **default `true`** → brak w `.env` = włączone, zgodnie z example;
- `FEATURE_INTERIM_TOOL_SHELF` / `_SKILL_SHELF` są **opt-out**
  (`if (/^(false|0|no|off)$/i.test(...)) return false`) → brak = włączone;
- `J2_DISPATCH_CONCURRENCY` — brak, ale default w kodzie to `3`, czyli dokładnie
  wartość z example.

**Do zrobienia mimo to:**
1. Dopisać `J2_DISPATCH_CONCURRENCY=3` do `.env`. Nie zmienia zachowania —
   **czyni limit widocznym dla operatora**. Dziś jedyny sposób poznania wartości
   to przeczytać kod, a to jest pokrętło, które przy dławieniu rate limitami
   będzie się kręcić jako pierwsze.
2. **Realna niespójność do naprawy:** `film-validators.ts:22-23` czyta
   **oba** `FILM_SKILL_ROOT` i `FILM_SKILLS_ROOT`, ale
   `film-reference-tools.ts:12` czyta **tylko liczbę mnogą**. Kto ustawi samą
   pojedynczą, dostanie działającą walidację i niedziałające referencje. Ujednolicić.
3. **Do decyzji właściciela, nie do naprawy:** `ARK_API_KEY`/`ARK_BASE_URL` i
   `RUNWAY_API_KEY`/`RUNWAY_BASE_URL` to alternatywne powierzchnie domeny
   filmmaker. Ich brak = te ścieżki niedostępne; domyślna (fal/seedance) działa.
   To wybór, nie usterka.

**Stan 23.08 — ✅ DOMKNIĘTA.** Realne wywołanie `filmLoadReferenceTool` z
wyłącznie pojedynczym `FILM_SKILL_ROOT`, wskazującym unikalną istniejącą
referencję, najpierw oblało: loader zignorował alias i wrócił do domyślnego
drzewa. Po jednoliniowym ujednoliceniu ta sama bramka
`check:filmmaker-domain` przechodzi. Do żywego, ignorowanego `.env` dopisano
wyłącznie `J2_DISPATCH_CONCURRENCY=3`; wpis występuje raz, a
`check:dispatch-concurrency-cap` potwierdza rzeczywisty peak 3. Kluczy
`ARK_*`/`RUNWAY_*` nie dodano, `.env.example` nie wymagał zmiany, a `.env` nie
jest i nie będzie częścią commitu. Końcowe `check:all` po A–D przechodzi jako
ścisły nadzbiór punktu odniesienia (94 zielone / 0 czerwonych / exit 0: dawne 93
plus nowa bramka A), `tsc --noEmit` jest czysty, a `infra:rs3:prove` potwierdza
3/3 zdrowe węzły i transakcje na rs3f8 (`term: 41`).

---

## 5. Obserwacja operacyjna

Zastałem proces `check-subtask-file-attribution` **wiszący 63 minuty**
(uruchomiony 21:52, żywy o 22:55). Nie odtworzyłem tego na obecnym kodzie —
bramka kończy się w ~1 s — więc to relikt pośredniego stanu plików w trakcie
tamtej sesji. Ale warto znać kształt: bramki importujące łańcuch
`subtask-executor` potrafią wisieć, bo ciągną za sobą efekty uboczne ładowania
modułów. Osobna sonda, którą pisałem dziś do weryfikacji, zawisła z tego samego
powodu i musiałem ją przerwać.

---

## 6. Kolejność domykania

**A → B → C → D.**

A jest pierwsze, bo odpala się przy **każdym zapisie** i już dziś, przy jednym
agencie, wysyła modelowi nieprawdziwy komunikat. B jest drugie, bo to ono kosztuje
pieniądze (eskalacje na drogi model). C jest trzecie, bo cofa krok 2 tylko wtedy,
gdy model sięgnie po `coding_update_artifact` z listą. D to higiena.

Żaden z tych kroków **nie wymaga** restartu serwera ani dotykania historii gita
żywego repo — czyli nie potrzebuje osobnej zgody właściciela.

---

## 7. Odpowiedź na pytanie właściciela wprost

*Czy J2 zostało wykonane prawidłowo?* — **Tak, wszystkie sześć kroków, z
uczciwymi bramkami.**

*Czy czegoś zabraknie przy obciążającej pracy?* — **Tak, trzech rzeczy (A, B,
C).** Wszystkie leżą **obok** J2, nie w nim: to ścieżki, których plan J2 nie
obejmował, a które równoległość dopiero uwidacznia. A i B są zastane — działały
źle również przed J2, tylko wcześniej wszystko było tak samo nieatrybuowane, że
nie dało się tego zobaczyć.
