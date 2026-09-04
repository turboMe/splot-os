# Prompt startowy — wykonawca Agent Foundry

Do wklejenia jako pierwsza wiadomość w sesji modelu, który ma zrealizować
`ideas/auto-agent-build.md`.

---

Pracujesz w `/projekty/mastra-agentic-environment/agentic-agents`.

**Zadanie:** zaimplementować Agent Foundry — mechanizm, który pozwala systemowi zbudować,
zweryfikować i wdrożyć nowego agenta (prostego oraz specjalistę). Pełny plan jest w
`ideas/auto-agent-build.md`.

**Zanim cokolwiek zrobisz: przeczytaj `ideas/auto-agent-build.md` w CAŁOŚCI.** Plan zawiera
dokładne ścieżki plików, wzorce do sklonowania z numerami linii, komendy weryfikujące i
kryteria akceptacji dla każdego kroku. Nie zaczynaj od kodu.

---

## KROK 0 — środowisko i gałąź (wykonaj przed czymkolwiek innym)

### 0.1 Node — pułapka, która ugryzie natychmiast

`.nvmrc` żąda **v22.20.0**, a shell ma teraz **v20.19.5**. Pod v20 serwer startuje, ale
**nie nasłuchuje i nie loguje błędu** — wygląda jak działający.

**Nigdy nie wołaj `npm` ani `npx` bezpośrednio.** Wszystkie skrypty tego repo idą przez:

```bash
bash scripts/with-node.sh npm run check:all
```

Sprawdź to zanim uznasz jakikolwiek wynik za wiarygodny.

### 0.2 Cudzy WIP w drzewie roboczym — nie jest Twój

`git status` pokaże niezacommitowane zmiany, których **nie Ty jesteś autorem**:

```
 M docs/MIGRACJA-DOMENY-CODING.md
 M ideas/f7-co-zostalo-z-migracji-agentow.md
 M src/mastra/config/model-manifest.ts
 M src/mastra/scripts/skill-nightly-cycle.ts
 M src/mastra/services/generate-with-harness.ts
?? ideas/audyt-domena-coding-2026-08-22.md
?? ideas/nowe-przepisy-podpinanie.md
?? src/mastra/lib/gateway-registry.ts
```

**Zakazane na tych plikach:** `git checkout`, `git restore`, `git reset`, `git clean`,
nadpisanie, usunięcie. To jest cudza praca w locie i jej utrata jest nieodwracalna.

Kiedy bramka zażąda czystego drzewa (`worktreeState === CLEAN`), odłóż ten WIP na
**opisany** stash i **głośno o tym poinformuj człowieka**:

```bash
git stash push -u -m "WIP transient-tool-shelf - NIE nalezy do agent-foundry"
```

Stash jest odwracalny, `checkout` nie jest. Jeśli masz wątpliwość — zapytaj, nie zgaduj.

### 0.3 Gałąź — baza ma znaczenie

Obecna gałąź `hotfix/transient-tool-shelf` jest **311 commitów przed `master`**, a `master`
jest 0 commitów przed nią. **Odgałęzienie od `master` skasowałoby całą pracę z ostatnich
tygodni.** Bazą jest bieżący HEAD:

```bash
git checkout -b feat/agent-foundry
```

Potem zacommituj **wyłącznie plan** jako pierwszy commit gałęzi (nie dokładaj cudzych plików):

```bash
git add ideas/auto-agent-build.md ideas/auto-agent-build-prompt.md
git commit -m "docs(foundry): plan budowy agentow i prompt wykonawcy"
```

Sprawdź `git status` po `git add` i zanim zacommitujesz — jeśli w zestawie jest cokolwiek
poza tymi dwoma plikami, cofnij i popraw.

---

## Jak pracujesz

**Etap po etapie.** Plan ma 7 etapów (0–6). Kolejność: 0 → 1 → 2 są sekwencyjne, etap 3 jest
niezależny (może iść równolegle), etap 4 wymaga 1, etap 5 wymaga 2, etap 6 wymaga wszystkiego.

Po każdym etapie, zanim przejdziesz dalej:
1. `bash scripts/with-node.sh npm run check:all` — musi być zielony,
2. commit z opisem w stylu repo: `feat(foundry): ...` / `fix(foundry): ...` / `docs(foundry): ...`,
3. krótki raport dla człowieka: co zrobione, co zweryfikowane, co następne.

**Nigdy nie łącz dwóch etapów w jednym commicie.**

**Każdą bramkę testuj w OBU kierunkach.** Napisanie bramki to połowa roboty — druga połowa
to świadome zepsucie jednej rzeczy i potwierdzenie, że bramka świeci na czerwono. Bramka,
która nigdy nie oblewa, jest ozdobą, a nie zabezpieczeniem. Plan mówi wprost przy każdym
kryterium, co zepsuć.

**Nie improwizuj.** Każdy plik i wzorzec jest w planie nazwany z numerem linii. Jeśli
zastaniesz w kodzie coś innego niż plan opisuje — **zatrzymaj się i zgłoś rozbieżność**.
Plan był weryfikowany wobec kodu, ale kod żyje. Rozbieżność jest informacją, nie przeszkodą
do obejścia.

**Punkty `STOP` w planie są prawdziwe.** Zatrzymaj się i zapytaj człowieka:
- gdy istniejący agent pokrywa ≥80% potrzeby (KROK 3.1),
- gdy brakuje narzędzia — oddaj kontrakt do `capabilitySmith`, nie dorabiaj narzędzia w
  ramach budowy agenta (KROK 3.3),
- po teście generatora na `echoAgent` (koniec ETAPU 1).

---

## Zasada nadrzędna

**„Zbudowane i zielone" ≠ „wpięte".**

To repo zapłaciło za tę lekcję trzy razy: `findArtifactIds` nie działał dla żadnego agenta
mimo zielonych testów; liveness był zbudowany, przetestowany i nieosiągalny dla V2;
`designAgent` obiecywał dokumenty, nie mając czym zapisać pliku. Wszystkie trzy wyglądały
na gotowe.

Testy dowodzą, że kod robi to, co robi — **nie że cokolwiek do niego dociera**. Dlatego
ETAP 6 (dry run na żywym agencie, do aktywacji i rollbacku) nie jest formalnością i nie
wolno go skrócić ani zastąpić testami.

---

## Pułapki repo (sekcja P1–P10 planu — przeczytaj ją, nie streszczaj sobie)

Najczęściej wywracające przy TYM zadaniu:

- **P1** — klucze w obiekcie `tools:` to nazwy, które widzi model, **nie** `createTool({ id })`.
  Ta pomyłka sprawiła, że `findArtifactIds` nie działał dla żadnego agenta, a testy były
  zielone, bo pisane z wyobrażenia o kształcie odpowiedzi zamiast ze zrzutu.
- **P3** — git w tym środowisku mówi po polsku. Dopasowywanie angielskiego wyjścia gita jest
  **zawsze** fałszywe. Konflikt wykrywaj przez `git rev-parse --verify --quiet MERGE_HEAD`.
- **P4** — agent bez zadeklarowanego `maxSteps` nie dostaje „bez limitu", tylko domyślne
  `maxSteps = 5` Mastry. Deklaracja jest obowiązkowa, generator ma ODMAWIAĆ bez niej.
- **P8** — `check:all` podnosi własny efemeryczny replica set Mongo i łańcuchuje ~112
  pod-skryptów. Trwa realnie. Nie przerywaj go, uznając że „wisi".
- **P9** — `build-agent-board.ts` pisze do **żywej** kolekcji Mongo `agent_board`, nie tylko
  do pliku rostera. Uruchomiony w worktree modyfikuje stan działającego systemu.

---

## Czego nie robić

- Nie włączaj żadnych flag i nie dotykaj `.env`. Cała praca jest additive i flag-gated.
- Nie promuj niczego na produkcję (`:4111`). Etap 5 kończy się na stagingu (`:4222`).
- Nie zaczynaj od etapu 6 „żeby szybko zobaczyć, czy działa".
- Nie commituj cudzego WIP (patrz 0.2).
- Nie wprowadzaj `runEvals` z Mastry — nie jest w tym repo używane nigdzie. Skopiuj wzorzec
  istniejącego Scorera (`@mastra/evals/scorers/*`, 5 sztuk zarejestrowanych w `index.ts`).
- Nie rób deklaratywnego `AgentDefinition` generującego wszystkie 10 punktów dotknięcia.
  To właściwy refaktor, ale świadomie odłożony na po zbudowaniu 2–3 agentów.

---

## Gdy utkniesz

Zgłoś człowiekowi: co próbowałeś, jakie było **dokładne** wyjście (nie parafraza), i jaką
masz hipotezę. Nie obchodź bramki, żeby przejść dalej — bramka, która przeszkadza, zwykle
mówi prawdę o czymś, co jest zepsute.

Jeśli test jest zielony, a Ty nie umiesz wskazać, **co konkretnie by go zepsuło** — nie
zaliczaj tego kroku. To jest wczesny objaw defektu, który to repo złapało już trzykrotnie.

---

## Zacznij teraz od

1. Przeczytania `ideas/auto-agent-build.md` w całości.
2. Wykonania KROKU 0 (Node → status → gałąź → commit planu).
3. Raportu: potwierdzenie gałęzi, stan WIP, i plan na ETAP 0 — **zanim** napiszesz pierwszą
   linię kodu.
