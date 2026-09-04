# Plan: Graphify Faza 2 — auto-injection, meta, statystyka trendu

Status: **decyzje podjęte, zero zmian w kodzie.** Kontynuacja
`ideas/plan-graphify-strengthening-2026-08-26.md` (zrealizowany, commit `a7022ce`).

Trzy niezależne strumienie pracy, w kolejności od najtańszego/najmniej ryzykownego:
**B (prompt meta) → C (statystyka trendu) → A (auto-injection do precontext)**.
A jest na końcu celowo — wymaga realnego śledztwa (patrz sekcja A.0), nie jest gotowym przepisem.

---

## B. Meta — świadomość grafu przed delegacją

**Decyzja: tak, zrobić.** Meta ma zarejestrowane wszystkie 3 narzędzia (`meta-agent.ts:336-338`),
ale `prompts/meta/base.md` ma zero wzmianek o graphify (sprawdzone grepem). Meta orkiestruje
delegacje do `codingAgent` — jeśli zadanie użytkownika nazywa konkretną funkcję/symbol, meta
może przed napisaniem brief'u sprawdzić `graphify_affected`/`explain` i albo wzbogacić brief o
realne dane o zależnościach, albo ostrzec użytkownika wprost o skali zmiany.

### Do zrobienia
1. Dopisać do `meta/base.md` (najbliżej `§1.1 Grounding First` lub `§6 Hard domain routing
   rules`) krótką regułę: gdy prośba użytkownika nazywa konkretny, znany symbol/funkcję do
   zmiany, a nie jest to trywialna/lokalna zmiana, meta może wywołać `graphify_affected` PRZED
   napisaniem brief'u dla `codingAgent`, i jeśli wynik pokazuje wysoki fan-out, wspomnieć o tym
   w podsumowaniu dla użytkownika lub wzbogacić brief.
2. **Sprawdzić budżet promptu PRZED edycją** — `check:meta-prompt-size` ma DWIE asercje, wiążąca
   jest `reduction >= 0.25` (realny zapas przy ostatnim sprawdzeniu: ~749 znaków), nie limit
   znaków samego pliku. Ten sam problem już raz był rozwiązywany w tej sesji (patrz
   `ideas/plan-wdrozenia-skilli-2026-08-26.md` sekcja 1.1) — powtórzyć tamten dryl: policzyć
   zapas, dopiero potem pisać regułę, i trzymać się w limicie.
3. Reguła MUSI być krótka (to nie jest miejsce na nowy rozdział) — jedno zdanie z warunkiem
   wyzwolenia, jedno zdanie z tym, co zrobić z wynikiem.

### Weryfikacja
- `npm run check:meta-prompt-size` — dalej zielone po edycji.
- Test pozytywny: poproś meta o coś w stylu „zmień sposób liczenia X w `harness-policy.ts`" —
  powinien wywołać graf przed napisaniem brief'u.
- Test negatywny: „popraw literówkę w komentarzu w pliku Y" — meta **nie powinien** wołać grafu
  dla trywialnej zmiany (koszt bez korzyści, dokładnie ta sama zasada co przy `§6` codingAgenta).

---

## C. Lekka statystyka trendu grafu (skorygowana wersja pomysłu)

**Decyzja: tak, ale NIE czytać surowych snapshotów.** Zweryfikowany fakt: 23 dzienne snapshoty
= **570 MB łącznie** (~25 MB/dzień), bez żadnej retencji — rośnie bez końca. To samo w sobie jest
osobnym, realnym problemem operacyjnym (dysk cicho puchnie), niezależnym od tego, czy budujemy
statystykę.

### C.1 — Ekstrakcja mikro-podsumowania (właściwa funkcja)

Zamiast trzymać pełne grafy, przy KAŻDYM odświeżeniu (te same hooki co dziś — `post-commit`/
`post-merge`, patrz `project_graphify_strengthening` w pamięci) dopisać jeden mały rekord do
pliku append-only, np. `src/mastra/graphify-out/trend.jsonl`:

```json
{"date":"2026-08-26","commit":"a7022ce...","nodes":23651,"links":35371,"communities":1457,
 "top_god_nodes":[{"label":"...","edges":187},...]}
```

To kilka KB na wpis, nie MB — może rosnąć latami bez żadnego problemu z miejscem.

**Do zrobienia:**
1. Nowa funkcja w `graphify.ts` (albo osobny mały moduł `graphify-trend.ts`) — po udanym
   `graphify update`, odczytać `nodes.length`, `links.length`, liczbę community, i N
   najbardziej połączonych węzłów (dane już liczone przez `graphify god-nodes`, więc to
   ponowne wykorzystanie istniejącego narzędzia, nie nowa logika grafowa).
2. Dopisać wywołanie tej funkcji na końcu `scripts/graph-refresh.sh` (po udanym `update`), albo
   jako osobny krok wywoływany stamtąd.
3. **Nie commitować `trend.jsonl` automatycznie** — zostaje lokalny/gitignored jak reszta
   `graphify-out/`, chyba że zdecydujesz inaczej (do przemyślenia: czy chcesz mieć historię
   trendu w repo, czy tylko lokalnie na maszynie, która buduje graf).

### C.2 — Retencja surowych snapshotów (osobny, niezależny fix)

**Do zrobienia:** dodać prosty limit — np. trzymaj pełne `graphify-out/{data}/graph.json` tylko
z ostatnich N dni (7? 14?), starsze usuwaj przy okazji odświeżania, skoro `trend.jsonl` i tak
zachowuje to, co z nich naprawdę wartościowe. To NIE wymaga zmiany w `graphify` CLI — wystarczy
mały krok sprzątający w `graph-refresh.sh` (znajdź katalogi starsze niż N dni, usuń).

### Gdzie to wykorzystać
Nie nowy agent — dane trafiają do `analyticsAgent`/dashboardu jako sygnał „ten obszar kodu robi
się coraz bardziej sprzężony w czasie" (rosnący fan-in konkretnego pliku między snapshotami).
To dopisanie do istniejącej analityki, nie nowa domena. **Poza zakresem tego planu** — samo
zbieranie danych (C.1) i porządkowanie (C.2) wystarczy na tę falę; wykorzystanie w dashboardzie
to osobne zadanie na później, gdy dane już się zbiorą na tyle, żeby był z czego robić trend.

### Weryfikacja
- Po zmianie: zrobić realny commit, sprawdzić że `trend.jsonl` dostał nowy wpis w rozsądnym
  czasie (te same ~20s co reszta odświeżania).
- Sprawdzić że stary katalog snapshotu starszy niż próg retencji faktycznie zniknął po
  kolejnym odświeżeniu, a `trend.jsonl` nadal ma wpis z tamtego dnia (dane przetrwały mimo że
  surowy graf zniknął — to jest cały sens tego rozdzielenia).

---

## A. Automatyczne wstrzykiwanie analizy wpływu do precontext (flaga, domyślnie ON)

**Decyzja: tak, za flagą `FEATURE_GRAPHIFY_PRECONTEXT`, domyślnie `true`** — niski koszt przy
dzisiejszym niskim użyciu domeny coding, a gdy trafi zadanie, będzie obsłużone od razu z pełną
analizą wpływu, bez polegania na tym, że model sam pamięta o regule z `§6`. Wzorzec `isHarnessFeatureEnabled('FLAG', true)` już jest ustalony w tym repo (patrz `isGraphifyEnabled()`
w `graphify.ts`) — trzymać się go, nie wymyślać nowego mechanizmu flag.

### A.0 — Śledztwo PRZED implementacją (nie zakładaj gotowego rozwiązania)

To jest jedyna część tego planu, gdzie NIE mam gotowej odpowiedzi i mówię to wprost: **narzędzia
CLI graphify (`affected`, `explain`) przyjmują SYMBOL, nie ścieżkę pliku.** Sprawdziłem
`graphify --help` — nie ma komendy typu „affected dla tego pliku". `coding-precontext.ts` i
`review-precontext.ts` dostają `targetFiles`/`filesChanged` (ścieżki), nie nazwy symboli.

**Musisz najpierw rozstrzygnąć, jak zmapować plik → sensowne zapytanie do grafu.** Warianty do
zbadania, żaden nie jest z góry wybrany:
- (a) Węzły w `graph.json` mają pole `source` (widziałem to w surowym pliku) — możliwe, że da
  się przefiltrować węzły po `source` pasującym do ścieżki pliku i odczytać ich stopień
  bezpośrednio z JSON-a, bez wywoływania CLI per plik. Sprawdź, czy to jest tańsze i
  wystarczająco dokładne niż poniższe.
- (b) Wyciągnąć nazwę pliku bez rozszerzenia jako kandydata na symbol i wywołać
  `graphify_explain` — `parseExplainOutput`/`runGraphifyExplain` mają już logikę
  dopasowania rozmytego („the explain parser captures the node id the retry needs" —
  `check-graphify-affected-parse.ts`). Sprawdź, czy to wystarcza dla typowych przypadków.
  Sprawdź, czy da się z tego dojść do listy eksportowanych symboli pliku, czy trzeba osobnego
  źródła (np. `lsp_inspect`/AST) do wskazania KTÓRY symbol w pliku jest tym istotnym.
- (c) Jeśli żadna z powyższych nie daje wystarczająco pewnego wyniku — **nie zgaduj**. Sekcja ma
  się wyciszyć (ten sam wzorzec `suppressedReasons` co reszta precontext), nie zwrócić coś
  mylącego.

**Zdecyduj i udokumentuj wybór w kodzie (komentarz), zanim przejdziesz dalej.**

### A.1 — Ograniczenie kosztu (twarde wymogi, nie sugestie)

1. **Maksymalnie JEDNO wywołanie grafu na budowę precontext**, niezależnie od liczby
   `targetFiles`/`filesChanged` — wybierz jeden najistotniejszy plik/symbol (np. pierwszy z
   listy, albo ten z największą liczbą zmienionych linii jeśli ta informacja jest dostępna), nie
   iteruj po wszystkich.
2. **Sekcja pojawia się w markdown tylko gdy wynik jest informacyjny** (>0 zależnych) — dokładnie
   wzorzec `tryRecallMemory`/`trySkillSearch`, które dziś milczą przy pustym wyniku. Liczysz
   zawsze (fail-soft), pokazujesz tylko gdy warto.
3. **Budżet czasowy** — użyj tego samego `withTimeout(...)` co reszta `coding-precontext.ts` (900ms
   dla pamięci/skilli); jeśli graphify nie odpowie w rozsądnym oknie, ucisz i idź dalej. Nie
   blokuj całego wywołania LLM na wolnym procesie CLI.
4. **Nie duplikuj z Repository Map.** `assembleContext`'s `repoMap` (przez `repo-indexer.ts`) to
   INNY, lżejszy mechanizm (struktura plików), nie graf zależności AST. Nowa sekcja
   (`### Blast Radius (auto)`) jest dodatkowa, nie zamiennik — nie usuwaj istniejącej.

### A.2 — Gdzie wpiąć

1. `coding-precontext.ts` (`buildCodingPrecontext`) — nowy opcjonalny parametr/sekcja, flaga
   sprawdzana na starcie funkcji (`isHarnessFeatureEnabled('FEATURE_GRAPHIFY_PRECONTEXT', true)`).
2. `review-precontext.ts` (`buildReviewPrecontext`) — analogicznie, korzystając z
   `artifact.filesChanged`, które już jest odczytywane.
3. **Nie dotykaj innych precontextów** (`knowledge-precontext.ts`, `automation-precontext.ts`) —
   poza zakresem, inne domeny.

### Weryfikacja
- Realne wywołanie `buildCodingPrecontext` z `targetFiles` wskazującym na plik ze znanym,
  wysokim fan-out (np. coś z `pipeline-phase-tools.ts` albo `harness-policy.ts`) — sekcja
  `### Blast Radius (auto)` musi się pojawić z realnymi danymi.
- Realne wywołanie z plikiem bez zewnętrznych zależności (np. nowy, izolowany plik) — sekcja
  musi się WYCISZYĆ, nie pojawić jako pusta/myląca.
- Zmierzyć rzeczywisty narzut czasowy jednego wywołania `graphify_affected`/`explain` w tej
  ścieżce (nie zakładaj — zmierz, tak jak w fali G1 poprzedniego planu).
- Flaga `FEATURE_GRAPHIFY_PRECONTEXT=false` musi realnie wyłączać sekcję (test negatywny).

---

## Kolejność i szacunek

| Fala | Zakres | Ryzyko | Zależność |
|---|---|---|---|
| B | prompt meta, ~3-5 linii | niskie | brak |
| C.1 | ekstrakcja mikro-podsumowania | niskie | brak |
| C.2 | retencja surowych snapshotów | niskie | żadna, ale rób po C.1 (nie usuwaj danych, zanim nie masz gdzie ich zachować) |
| A | auto-injection do precontext | średnie — wymaga A.0 | brak formalnej, ale najbardziej złożone, rób na końcu |

## Czego NIE robić
- Nie budować nowego agenta pod statystykę trendu — to dopisek do istniejącej analityki.
- Nie iterować `graphify_affected` po każdym pliku w `targetFiles` — jedno wywołanie, wybór
  najistotniejszego pliku.
- Nie zgadywać mapowania plik→symbol w A.0 — jeśli niepewne, wyciszyć sekcję, nie zwracać
  przybliżenia.
- Nie commitować automatycznie `trend.jsonl` bez jawnej decyzji, czy ma być w repo czy tylko
  lokalnie.
