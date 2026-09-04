# HANDOFF — wzmocnienie użycia grafu Graphify

**To jest jedyny plik, od którego zaczynasz.** Nie zaczynaj od kodu.

Stan wyjściowy: **analiza skończona i zweryfikowana na żywo, zero zmian w kodzie.**

---

## 1. Co to za zadanie

Test ze spike'u 2026-07-20 pokazał, że `graphify_affected` (analiza wpływu zmiany na symbol)
daje precyzyjną odpowiedź o kaskadzie zależności przy **97% mniejszym zużyciu tokenów** niż
czytanie plików wprost. Dziś tylko `codingAgent`, `code-review-agent` i `meta-agent` z tego
korzystają. Zadanie: dodać to samo trzem kolejnym miejscom (`security-review-agent`,
`performance-review-agent`, subagent `file-editor`), dodać sygnał świeżości grafu, i wzmocnić
prompty z prozy na wyraźną, egzekwowalną-w-praktyce regułę.

## 2. Kolejność czytania

1. **`ideas/plan-graphify-strengthening-2026-08-26.md`** — cały plan, z żywym dowodem
   działania mechanizmu (sekcja 2.2 — commit → hook → przebudowa grafu → `built_at_commit`
   zgodny z HEAD, zmierzone na commicie `f2d9783`, 21 sekund).
2. Dopiero potem kod.

## 3. Twarde fakty, zweryfikowane w tej sesji (nie zakładaj, sprawdź ponownie jeśli coś nie gra)

- `core.hooksPath` w tym repo wskazuje na `scripts/git-hooks` — hooki `post-commit`/`post-merge`
  są AKTYWNE i odpalają `scripts/graph-refresh.sh` (async, fail-soft, nigdy nie blokuje).
- `coding_apply_patch` ([code-worktree.ts:465-507](../src/mastra/tools/dev/code-worktree.ts#L465))
  robi `git commit` w worktree + `git merge --no-edit` w głównym repo — TO odpala post-merge hook.
  **codingAgent nie potrzebuje nowej instrukcji „zakończ commitem" — jego istniejący workflow
  już to robi.**
- `src/mastra/graphify-out/graph.json` ma pole `built_at_commit` (SHA-1 40 znaków) —
  **istnieje, ale `graphify.ts`/`graphify-tools.ts` go NIE czyta ani nie pokazuje agentowi.**
  To jest fala G1 planu — najtańsza i fundamentalna dla reszty.
- Graf obejmuje **tylko `src/mastra`** (`npm run graph:build` = `graphify update src/mastra`).
- **Niezacommitowane zmiany w worktree NIGDY nie są widoczne w grafie — to poprawne
  zachowanie, nie błąd.** Graf odpowiada na „co istnieje dla reszty systemu teraz", nie na
  „co ja właśnie piszę". Nie próbuj tego „naprawiać".
- `security-review-agent`/`performance-review-agent` używają `workspace: codeWorkspace` —
  **mają już** `view`/`search_content`/`workspace_search`/`lsp_inspect` niejawnie. Nie są
  ślepe — brakuje im konkretnie grafu zależności symboli, nic więcej.

## 4. Kolejność wdrożenia (z planu, sekcja 5)

**G1 (najpierw)** → sygnał świeżości w `graphify.ts`/`graphify-tools.ts` (porównanie
`built_at_commit` z `git rev-parse HEAD`).
**G2** → dodać `graphify_affected` do: `security-review-agent.ts`, `performance-review-agent.ts`,
i do `allowedTools` roli `file-editor` w `subagent-roles.ts`. **Przed uznaniem ostatniego za
zrobione, sprawdź `subtask-executor.ts`** — czy dodanie samego stringa do `allowedTools`
faktycznie coś odblokowuje, czy potrzebny jest dodatkowy wpis mapujący nazwę na obiekt
narzędzia. To realne pytanie do zbadania, nie założenie do przyjęcia.
**G3** → wzmocnić prompty (`coding/base.md §6`, nowe sekcje w `security-review.md`,
`performance-review.md`, `subagent-file-editor.md`) — dokładne treści w planie, sekcja 4.

## 5. Czego NIE robić

- Nie dawać `graphify_explain`/`graphify_god_nodes` file-editorowi — tylko `affected`.
- Nie zmieniać `graph-refresh.sh` na synchroniczne.
- Nie dotykać `terminal`/`qa`/`researcher` subagentów — poza zakresem.
- Nie próbuj włączać niezacommitowanych zmian do grafu (patrz punkt 3 wyżej).

## 6. Definicja ukończenia

Fala jest skończona, gdy: (1) bramki/weryfikacja z planu sekcja 6 przechodzą, (2) jest jeden
realny przebieg z obserwacją — np. dla G2: recenzent naprawdę WYWOŁUJE `graphify_affected` na
diffie ze zmienioną eksportowaną funkcją, nie tylko ma je zarejestrowane w toolsecie, i test
negatywny (diff bez zmiany eksportowanego symbolu) nie wywołuje go niepotrzebnie.

Zgłoś wynik — nie przechodź dalej bez potwierdzenia, że dana fala faktycznie działa, nie tylko
się kompiluje.
