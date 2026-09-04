# Plan: wzmocnienie użycia grafu Graphify — 2026-08-26

Status: **analiza skończona, zweryfikowana na żywo, zero zmian w kodzie.** Punkt odniesienia:
test ze spike'u [[project_ideal_system_masterplan]] 2026-07-20 — `graphify_affected` na
`transitionLane` dał ~140 tokenów precyzyjnej odpowiedzi vs ~14 190 tokenów czytania 5 plików
(97% redukcji), a fuzzy `query` NL wypadło słabo (dlatego nigdy nie zbudowano tego narzędzia).

---

## 0. Stan faktyczny — kto dziś ma graf, kto nie

| Agent/rola | `graphify_*` | Reguła w prompcie | Uwaga |
|---|---|---|---|
| `codingAgent` | ✅ affected+explain+god_nodes | ✅ `coding/base.md §6` | jedyny z pełną trójką |
| `code-review-agent` | ✅ tylko `affected` | pośrednio (recenzja diffa) | świadomie bez `explain`/`god_nodes`, żeby nie zwiedzał zamiast wydać werdykt |
| `meta-agent` | ✅ wszystkie 3 | własna inspekcja read-only | poza zakresem tego planu |
| **`security-review-agent`** | ❌ | — | ma `codeWorkspace` (view/search_content/workspace_search/lsp_inspect) — **nie jest ślepy**, brakuje mu tylko grafu symboli |
| **`performance-review-agent`** | ❌ | — | identyczna sytuacja co wyżej |
| subagent `file-editor` | ❌ | — | celowo minimalny zestaw (`subagent-roles.ts:100-126`) |
| subagent `terminal`/`qa`/`researcher` | ❌ | — | nie dotyczy tego planu — inne domeny pracy |

## 1. Werdykt — trzy dodania, jedno już wcześniej uzgodnione

### ✅ `security-review-agent` → `graphify_affected`
Uzgodnione w poprzedniej turze. Uzasadnienie: zmieniona sygnatura funkcji eksportowanej wymaga
sprawdzenia, czy KAŻDY wywołujący faktycznie sanityzuje input — to dokładnie praca, do której
graf jest zrobiony (a nie: ogólne czytanie kodu, które recenzent już ma).

### ✅ `performance-review-agent` → `graphify_affected`
Ta sama klasa rozumowania: zmieniona funkcja na hot-pathcie vs wywoływana raz na starcie to
inna waga regresji. `graphify_affected` odpowiada wprost „kto to wywołuje i jak szeroko",
zamiast grepowania po repo z gorszą precyzją (dokładnie to pokazał test z 2026-07-20).

### ✅ Subagent `file-editor` → `graphify_affected` (TYLKO to, nie `explain`/`god_nodes`)
Nie jako zamiennik „decision-complete brief" (to zostaje główny mechanizm — patrz
`_skills/coding/code-plan-decision-complete.md`), tylko jako **siatka bezpieczeństwa**: gdy
plan okaże się niekompletny w trakcie edycji, file-editor może sam sprawdzić blast radius
zamiast ślepo kontynuować albo odsyłać rundę z powrotem do orkiestratora. Read-only, niskie
ryzyko, spójne z tym, co już ma (`lsp_inspect`).

**Nie dotykać** `terminal`/`qa`/`researcher` — inne domeny pracy, graf im nic nie daje.

---

## 2. Mechanizm odświeżania — zweryfikowany na żywo w tej sesji, nie z dokumentacji

### 2.1 Jak to działa dziś

```
git config core.hooksPath = scripts/git-hooks          ← AKTYWNE w tym repo, sprawdzone
  ├─ post-commit  → scripts/graph-refresh.sh (async, w tle, fail-soft, nigdy nie blokuje commita)
  └─ post-merge   → scripts/graph-refresh.sh (to samo)

coding_apply_patch (code-worktree.ts:465-507):
  1. git commit  -- w izolowanym worktree
  2. git merge --no-edit  -- W GŁÓWNYM REPO (AGENTIC_AGENTS_REPO)  ← TO odpala post-merge hook
```

**Wniosek: codingAgent nie musi „pamiętać o commicie" — jego normalny workflow
(`coding_apply_patch`) już wykonuje operację gita, która odpala odświeżenie automatycznie.**
Nie trzeba dopisywać nowej instrukcji „zakończ zadanie commitem" — mechanizm już tam jest,
wbudowany w istniejące narzędzie merge'ujące.

### 2.2 Dowód end-to-end z tej sesji (nie symulacja)

| Zdarzenie | Czas |
|---|---|
| Commit `f2d9783` | 15:52:31 |
| `graph.json` przebudowany (hook w tle) | 15:52:52 — **21 sekund** |
| `graph.json["built_at_commit"]` | `f2d9783c6808...` — **dokładnie ten sam SHA co HEAD** |

`graph.json` **ma pole `built_at_commit`** (SHA-1, 40 znaków) — potwierdzone realnym plikiem,
nie dokumentacją. **`graphify.ts`/`graphify-tools.ts` w ogóle go nie czyta ani nie pokazuje
agentowi.** To jest najtańsza, najbardziej ugruntowana rzecz do naprawienia w tym planie.

### 2.3 Zasięg grafu

`npm run graph:build` = `graphify update src/mastra` — **tylko `src/mastra`**. Zmiany w
`scripts/`, `package.json`, `docker-compose.yml` na poziomie repo nigdy nie trafiają do grafu.
To ograniczenie zakresu, nie błąd — warto tylko o tym pamiętać przy planowaniu czegokolwiek
poza `src/mastra`.

---

## 3. Odpowiedzi na pytania o optymalność (to, co user prosił przemyśleć)

### Q1: Czy graf jest aktualny, gdy agent podchodzi do zadania?

**Zwykle tak — ale bez sygnału, który by to POTWIERDZAŁ.** Odświeżanie jest napędzane realnymi
mergami (nie nocnym cronem), więc w praktyce opóźnienie to sekundy do dziesiątek sekund po
ostatnim mergu. Ryzyko: **równoległe przebiegi**. Jeśli zadanie A właśnie zmergowało duże
zmiany, a zadanie B w tym samym momencie pyta `graphify_affected` o symbol, którego to dotyczy,
może dostać wynik sprzed odświeżenia w tle — bez żadnego ostrzeżenia, że odświeżanie jeszcze trwa.

**Rozwiązanie — nie nowy mechanizm, tylko odczytanie tego, co już jest:**
Dodać do wyniku narzędzia (`graphify_affected`/`explain`/`god_nodes`) porównanie
`graph.json.built_at_commit` z `git rev-parse HEAD`:
- identyczne → `"graph up to date (built at HEAD)"`;
- różne → `"graph built at <sha>, HEAD is N commits ahead — may miss the N most recent changes"`.

To dokładnie ten sam wzorzec, co już istnieje dla `available: false` („unavailable, tu jest
hint co zrobić") — rozszerzony na świeżość zamiast tylko dostępności. Nic obcego architekturze.

### Q2: Co jeśli agent zmienia pliki bez commita — widzi graf + swoje zmiany, czy tylko graf?

**Tylko graf (ostatnia zmergowana prawda). Nigdy niezacommitowane zmiany w worktree.**

**To jest poprawne zachowanie, NIE błąd do naprawienia.** Powód: codingAgent pracuje w
IZOLOWANYM WORKTREE (`coding_init_worktree`), fizycznie innym katalogu niż
`AGENTIC_AGENTS_REPO/src/mastra`, który graf indeksuje. Analiza wpływu przed edycją MA sens
tylko względem tego, co naprawdę istnieje dla reszty systemu — analiza wpływu względem
własnego niedokończonego szkicu nie jest spójnym pojęciem (czego niby miałaby dowieść?).

**Konsekwencja do udokumentowania, nie do naprawienia:** agent nie powinien mylić „brak
wyników z `graphify_affected`" z „brak zależnych" — może to znaczyć, że powiązana zmiana po
prostu jeszcze nie jest zmergowana przez inne, równoległe zadanie. Dopisać to wprost do reguły
w `coding/base.md §6` (patrz sekcja 4 niżej), żeby nie było czytane jako gwarancja kompletności.

### Q3 (niezadane wprost, ale wynika z pytań): czy trzeba wymuszać synchroniczne odświeżenie?

**Nie.** `graph-refresh.sh` ma w komentarzu explicite: „NEVER blocks a commit/merge". Zmiana
tego na synchroniczne czekanie zwolniłaby każdy merge o czas przebudowy grafu (przy pełnym
rebuildzie rzędu dziesiątek sekund dla ~700+ plików) — zły kompromis dla korzyści, którą daje
sam sygnał staleness. Zamiast czekać, agent przy naprawdę krytycznej decyzji MOŻE ręcznie
odpalić `npm run graph:update` przez dostępne narzędzie terminalowe i dostać synchroniczną,
gwarantowaną świeżość — ale to wyjątek, nie domyślne zachowanie.

---

## 4. Wzmocnienie reguły — z prozy na coś wyraźniejszego

User słusznie zauważył: skoro to jest „zadana zasada" (prose guidance), a nie coś
egzekwowanego, trzeba mocniej wskazać agentom KIEDY z tego korzystać. Propozycje edycji
(do wykonania przez nową instancję, nie teraz):

### 4.1 `coding/base.md §6` — dziś istnieje, ale miękko

Obecny tekst mówi ogólnie „Before changing a shared function... use graphify_affected". Wzmocnić do:
- explicite wymienić TRIGGER: eksportowany symbol, publiczny kontrakt, klucz configu, cokolwiek
  z więcej niż jednym znanym wywołującym;
- dopisać notkę o Q2 wyżej: „no results ≠ no dependents — a parallel task's change may not be
  merged yet";
- dopisać notkę o Q1: jeśli wynik narzędzia oznaczy się jako nieaktualny względem HEAD, potraktować
  jako sygnał do ostrożności, nie ignorować.

### 4.2 `coding/security-review.md` — NOWA sekcja
Dodać analogiczną regułę do tej z `code-review-agent`: „for a changed exported function/type,
call `graphify_affected` before asserting every caller sanitizes input — do not claim call-site
coverage from memory or a partial grep."

### 4.3 `coding/performance-review.md` — NOWA sekcja
Analogicznie: „for a changed function on a suspected hot path, call `graphify_affected` to see
its actual call-site count/spread before judging isolated vs systemic impact."

### 4.4 `coding/subagent-file-editor.md` — NOWA, krótka sekcja
„If mid-edit you discover a shared symbol the brief didn't cover, use `graphify_affected` to
check its callers before proceeding — this does not replace a decision-complete brief, it is a
safety net for when one turns out incomplete."

---

## 5. Kolejność wdrożenia (dla wykonawcy)

**Fala G1 — sygnał świeżości (najpierw, bo to fundament pod resztę)**
1. `graphify.ts`: dodać funkcję czytającą `built_at_commit` z `graph.json` i porównującą z
   `git rev-parse HEAD` (przez `execFileAsync('git', ['rev-parse', 'HEAD'])`, zgodnie ze
   wzorcem już użytym w tym pliku).
2. `graphify-tools.ts`: dodać pole do `outputSchema` każdego z trzech narzędzi (np.
   `staleness: z.string().optional()`), wypełniane wynikiem z kroku 1.
3. Zaktualizować opis narzędzia, żeby agent wiedział, że pole istnieje i co znaczy.

**Fala G2 — trzy dodania toolsetu**
4. `security-review-agent.ts`: dodać `graphify_affected` do `tools:`.
5. `performance-review-agent.ts`: to samo.
6. `subagent-roles.ts`: dodać `graphify_affected` do `allowedTools` roli `file-editor`
   ([subagent-roles.ts:107-122](../src/mastra/config/subagent-roles.ts#L107)). Sprawdzić, czy
   `subtask-executor.ts` (mapowanie `allowedTools` string → realny obiekt narzędzia) już zna
   `graphify_affected`, czy trzeba dopisać wpis w tej mapie.

**Fala G3 — wzmocnienie promptów (sekcja 4 wyżej)**
7. Edycja `coding/base.md §6`.
8. Nowa sekcja w `coding/security-review.md`.
9. Nowa sekcja w `coding/performance-review.md`.
10. Nowa sekcja w `coding/subagent-file-editor.md`.

## 6. Weryfikacja — obserwacja, nie tylko bramka

- Po G1: zrobić commit testowy, sprawdzić że narzędzie faktycznie zwraca poprawny status
  świeżości PRZED i PO odświeżeniu w tle (świadomie złapać okno „stale", nie tylko stan końcowy).
- Po G2: `check:prompt-tool-names` (jeśli obejmuje te agenty) + realny przebieg —
  `security-review-agent` dostaje diff ze zmienioną eksportowaną funkcją i **faktycznie wywołuje**
  `graphify_affected`, nie tylko ma je dostępne.
- Test negatywny: recenzja diffa BEZ zmiany eksportowanego symbolu — reviewer **nie powinien**
  wywoływać grafu niepotrzebnie (koszt bez korzyści).
- Sprawdzić `subtask-executor.ts` — czy dodanie stringa do `allowedTools` file-editora
  faktycznie coś odblokowuje, czy potrzebny jest dodatkowy wpis mapujący nazwę na obiekt
  narzędzia (to jest realne pytanie, nie założenie — sprawdzić przed uznaniem G2.6 za zrobione).

## 7. Czego NIE robić

- Nie dawać `explain`/`god_nodes` file-editorowi — to narzędzia eksploracyjne, nie pasują do
  wąskiej, wykonawczej roli.
- Nie zmieniać `graph-refresh.sh` na synchroniczne — złamałoby „never blocks a commit/merge".
- Nie próbować włączać niezacommitowanych zmian worktree do grafu — patrz Q2, to fałszywy problem.
- Nie dotykać `terminal`/`qa`/`researcher` w tym planie — poza zakresem.
