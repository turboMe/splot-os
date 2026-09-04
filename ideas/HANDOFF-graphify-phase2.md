# HANDOFF — Graphify Faza 2

**To jest jedyny plik, od którego zaczynasz.** Nie zaczynaj od kodu.

Stan wyjściowy: **decyzje podjęte, zero zmian w kodzie.** Poprzednia faza (`graphify_affected`
na security/performance-review + file-editor, sygnał świeżości) jest zrobiona, zweryfikowana,
zacommitowana (`a7022ce` na `feat/skills-and-computer-use`) — nie ruszaj tego.

---

## 1. Co to za zadanie

Trzy niezależne strumienie, wszystkie zdecydowane przez użytkownika:

- **B — meta ma poznać graf.** Meta orkiestruje delegacje do `codingAgent`, ale nie ma pojęcia,
  że graf istnieje (zero wzmianek w `meta/base.md`, mimo że narzędzia są zarejestrowane).
- **C — lekka statystyka trendu grafu, NIE surowe snapshoty.** Ważne: dzienne snapshoty
  (`graphify-out/{data}/graph.json`) są DUŻE — zweryfikowane na dysku: **570 MB w 23 dni, ~25
  MB/dzień, zero retencji, rośnie bez końca.** Rozwiązanie NIE polega na czytaniu tych plików do
  statystyki — polega na wyciągnięciu z każdego mikroskopijnego podsumowania (kilka KB) i dodaniu
  limitu wieku dla surowych snapshotów.
- **A — automatyczne wstrzykiwanie analizy wpływu do precontext, za flagą domyślnie ON.**
  Największa i najbardziej złożona część. **Ma otwarty punkt śledczy (A.0) — nie ma gotowego
  algorytmu mapowania plik→symbol, musisz go sam rozstrzygnąć, sprawdzając realne opcje.**

## 2. Kolejność czytania

1. **`ideas/plan-graphify-phase2-2026-08-26.md`** — pełny plan ze wszystkimi trzema strumieniami.
2. Kontekst poprzedniej fazy, jeśli potrzebny: `ideas/plan-graphify-strengthening-2026-08-26.md`
   i pamięć projektu `project_graphify_strengthening`.
3. Dopiero potem kod.

## 3. Kolejność wykonania

**B → C.1 → C.2 → A**, w tej kolejności (rosnące ryzyko/złożoność). Nie zaczynaj od A — to
najbardziej ryzykowna i niedookreślona część, a B i C są proste i bezpieczne do zrobienia jako
rozgrzewka/potwierdzenie, że rozumiesz konwencje tego repo (flagi, `isHarnessFeatureEnabled`,
wzorzec fail-soft z `suppressedReasons`).

## 4. Twarde fakty, zweryfikowane w tej sesji

- Snapshoty dzienne grafu: **570 MB / 23 dni, ~25 MB/dzień, ZERO retencji dziś.** Sprawdź to
  ponownie (`du -sh src/mastra/graphify-out/`) — mogło urosnąć jeszcze bardziej.
- CLI `graphify` (sprawdzone przez `graphify --help`) **nie ma komendy operującej na pliku** —
  `explain`/`affected`/`path` biorą nazwę węzła/symbolu. Nie zakładaj, że taka komenda się
  znajdzie — jeśli mapowanie plik→symbol okaże się niepewne, ucisz sekcję (A.0 w planie).
- `check:meta-prompt-size` ma **dwie** asercje, wiążąca jest `reduction >= 0.25`
  (`combined <= 31134` przy ostatnim sprawdzeniu), NIE limit samego pliku (33000 znaków). Policz
  aktualny zapas PRZED pisaniem reguły dla meta — ten sam błąd już raz kosztował czas w tej sesji
  (patrz `ideas/plan-wdrozenia-skilli-2026-08-26.md` sekcja 1.1).
- `coding-precontext.ts`/`review-precontext.ts` już mają ustalony wzorzec: policz zawsze
  (fail-soft, budżet czasowy), pokaż sekcję tylko gdy wynik jest informacyjny. Trzymaj się go,
  nie wymyślaj nowego.
- `assembleContext`'s „Repository Map" (przez `repo-indexer.ts`) to INNY mechanizm niż graphify —
  nie duplikuj, nie zastępuj.

## 5. Czego NIE robić

- Nie czytaj surowych dziennych snapshotów jako źródła statystyki (punkt C) — za duże, bez sensu
  do trzymania w nieskończoność w tej formie.
- Nie iteruj `graphify_affected` po każdym pliku w `targetFiles`/`filesChanged` w punkcie A —
  jedno wywołanie na budowę precontext, twardy wymóg z planu (A.1).
- Nie zgaduj mapowania plik→symbol w A — jeśli niepewne, wycisz sekcję zamiast zwracać
  przybliżenie, które wygląda na pewne, a nie jest.
- Nie buduj nowego agenta pod statystykę trendu (C) — to dopisek do istniejącej analityki.
- Nie ruszaj `graphify_affected` na `security-review-agent`/`performance-review-agent`/
  `file-editor` ani sygnału świeżości — to zrobione i zweryfikowane w poprzedniej fazie.

## 6. Definicja ukończenia

Każda fala (B, C.1+C.2, A) skończona, gdy: (1) weryfikacja z planu — sekcja „Weryfikacja" przy
każdym punkcie — przechodzi na żywo, nie tylko się kompiluje; (2) test negatywny faktycznie nie
uruchamia niepotrzebnie nowej ścieżki (trywialna zmiana / plik bez zależności / flaga wyłączona).

Zgłoś wynik po każdej fali.
