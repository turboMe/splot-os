# Prompt startowy — implementacja Agent Foundry

> Skopiuj wszystko poniżej linii jako pierwszą wiadomość do nowej instancji.
> Repozytorium: `/projekty/mastra-agentic-environment/agentic-agents`.

---

Rozpoczynasz implementację **Agent Foundry** zgodnie z zatwierdzonym planem
`ideas/auto-agent-build.md`. Nie projektuj systemu od nowa. Najpierw potwierdź aktualność
touchpointów względem wybranego commita, a potem realizuj etapy w zapisanej kolejności.

## Oczekiwany rezultat tej instancji

1. Bezpiecznie załóż nowy lokalny branch `feat/agent-foundry-foundation` w osobnym worktree.
2. Zrealizuj ETAP 0.
3. Zrealizuj ETAP 1 wraz z negatywnymi fixture'ami i dowodami akceptacji.
4. Nie wchodź w ETAP 2, dopóki ETAP 1 nie jest kompletny i zielony. Jeśli ETAP 0–1 zakończysz
   bez blockerów i pozostaje bezpieczny budżet/kontekst, możesz rozpocząć ETAP 2, ale nie
   przeskakuj żadnej zależności.

Pracuj wytrwale do ukończenia tego milestone'u. Nie kończ na samym audycie lub kolejnym planie,
chyba że wystąpi opisany niżej prawdziwy blocker bezpieczeństwa.

## Najpierw: instrukcje i source of truth

Przed zmianami przeczytaj w całości:

1. `AGENTS.md`.
2. `.agents/skills/mastra/SKILL.md` oraz wskazaną w nim instrukcję embedded docs.
3. `ideas/auto-agent-build.md` — cały dokument, nie tylko ETAP 0–1.
4. Aktualne implementacje i testy wszystkich touchpointów wymienionych w §8 planu.

Mastra zmienia API między wersjami. Każdą używaną sygnaturę sprawdzaj najpierw w dokumentacji
zainstalowanych pakietów `node_modules/@mastra/*/dist/docs`, potem w typach/source konkretnej
zainstalowanej wersji. Nie implementuj API Mastry z pamięci.

## BASE_COMMIT i utworzenie brancha — obowiązkowa procedura

Punkt audytu `f2c479f` zapisany w planie **nie jest automatycznie właściwym BASE_COMMIT-em**.
Bazą ma być dokładny, uzgodniony z właścicielem czysty commit, który zawiera finalny
`ideas/auto-agent-build.md`.

Najpierw wykonaj tylko odczyty:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git worktree list --porcelain
git branch --list 'feat/agent-foundry-foundation'
```

Następnie:

- jeśli właściciel podał pełny SHA `BASE_COMMIT`, zweryfikuj go i użyj dokładnie tego SHA;
- jeśli SHA nie został podany, ale bieżący czysty HEAD zawiera finalny plan, pokaż dowód i użyj
  tego HEAD;
- jeśli drzewo jest dirty, finalny plan nie istnieje w żadnym uzgodnionym commicie albo
  planowany touchpoint zawiera nieprzekazany WIP, zatrzymaj się i poproś wyłącznie o wskazanie
  `BASE_COMMIT`/handoff. Nie stashuj i nie kopiuj dirty zmian po cichu.

Po potwierdzeniu SHA utwórz branch przez osobny worktree. Docelowy katalog:

```text
/projekty/mastra-agentic-environment/agentic-agents-foundry
```

Równoważna komenda po podstawieniu pełnego, zweryfikowanego SHA:

```bash
git worktree add -b feat/agent-foundry-foundation \
  /projekty/mastra-agentic-environment/agentic-agents-foundry \
  REPLACE_WITH_CONFIRMED_FULL_SHA
```

Jeśli branch albo katalog już istnieje, nie usuwaj ich, nie resetuj i nie przejmuj. Pokaż stan
i poproś właściciela o decyzję: wznowienie istniejącej pracy albo nowa nazwa z suffixem.

Po utworzeniu worktree przejdź do niego i potwierdź:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

Oczekiwany branch to `feat/agent-foundry-foundation`, HEAD musi być równy zatwierdzonemu
BASE_COMMIT, a nowe drzewo musi być czyste przed pierwszą zmianą.

## Granice bezpieczeństwa

- Nie uruchamiaj `npm run dev`, Mastra Studio, live Mastry, candidate, deploy, autoheal,
  NotebookLM provisioning ani inicjalizacji bazy.
- Nie dotykaj działającej instancji, live Mongo, DuckDB, observability retention ani procesów
  użytkownika. ETAP 0–1 tego nie potrzebuje.
- Nie wykonuj merge, rebase, push, promote, swap ani zmian na branchu live.
- Nie używaj `git stash`, `git reset --hard`, `git checkout -- <plik>` ani `git add -A`.
- Nie poprawiaj przy okazji cudzych zmian lub niezwiązanych czerwonych bramek.
- Dozwolone są odczyty repo, edycje w nowym worktree, małe commity na nowym branchu oraz
  deterministyczne testy niewymagające live usług.
- Przed każdą zmianą związaną z bazą lub runtime udowodnij izolację. Brak dowodu oznacza stop,
  nie fallback do aplikacyjnego Mongo.

## Zakres ETAPU 0

Zrealizuj dokładnie §ETAP 0 planu:

- zapisz BASE_COMMIT i wersje Node/Mastry/Editora/evals,
- dodaj ADR-y dla workflow, source of truth, release manifest, build-vs-deployment oraz granicy
  Researcher/Knowledge Agent,
- zamroź nazwy publicznych narzędzi i trzech maszyn stanów,
- opisz warunek licencji/RBAC Agent Builder bez uruchamiania UI.

ETAP 0 nie zmienia runtime. Zakończ go osobnym, wąskim commitem.

## Zakres ETAPU 1

Zrealizuj dokładnie §ETAP 1 oraz konieczne refaktory foundation z §8. Priorytet:

1. Schematy Zod i typy dla need, research, dossier, źródeł/claimów, wiedzy, build spec,
   approval, build/deployment/canary records i trzech lifecycle'ów.
2. Niezmienna identity/spec revision, append-only receipts oraz wersjonowana projekcja CAS.
3. Centralny agent source registry, Tool Binding Registry i Agent Release Manifest/resolver.
4. Rozdzielenie `internal` od `shadow`; shadow ma być niewidoczny we wszystkich live surfaces.
5. File-only Board/roster bez zapisu do Mongo.
6. Strict approval contract odrzucający legacy/unbound/expired approval.
7. Canonical JSON hashing i negatywne fixture'y wymienione w planie.

Nie implementuj jeszcze scaffoldingu, Coding Agenta, candidate, semantic canary ani aktywacji.
ETAP 1 ma stworzyć kontrakty i fail-closed foundation, nie atrapę całego Foundry.

## Sposób pracy

- Najpierw dopisz test/asercję pokazującą czerwony stan, potem minimalną poprawkę, na końcu
  dowód zielony.
- Reużywaj istniejących registries, helperów i wzorców. Nie twórz równoległego systemu obok
  `capability-build.ts`, permitów, Board ani deploy orchestratora.
- Do rozłącznych odczytów/audytów możesz użyć subagentów. Współdzielone registry mają jednego
  writera; równoległe edycje tylko dla jawnie rozłącznych plików.
- Używaj `rg` do wyszukiwania i `apply_patch` do ręcznych zmian.
- Jeden logiczny acceptance unit = jeden mały commit. Przed każdym `git add` sprawdź
  `git status --short` i `git diff --name-only`; dodawaj wyłącznie jawne ścieżki.
- Nie zmieniaj decyzji zamrożonych w planie bez konkretnego dowodu sprzeczności. Jeśli taka
  sprzeczność istnieje, zapisz plik/linie, wpływ i minimalne warianty decyzji dla właściciela.

## Weryfikacja ETAPU 0–1

Uruchamiaj rosnąco, wyłącznie w nowym worktree:

1. najwęższy test czystego modułu/fixture,
2. nowy `check:agent-foundry-contracts`,
3. `npm run typecheck`,
4. `npm run build`, jeśli statyczna inspekcja potwierdzi, że nie uruchamia live usług ani nie
   łączy się z bazą,
5. `git diff --check`.

Nie uruchamiaj jeszcze pełnego `npm run check:all`: obecny skrypt może fallbackować z
testowego `:27018` do dostępnego replica setu. Najpierw późniejszy etap musi wprowadzić
fail-closed isolated mode albo właściciel musi wyznaczyć jawnie izolowane okno.

Każda bramka musi raportować, co rzeczywiście sprawdziła. Zielony wynik mocka nie jest dowodem
ekspozycji runtime. Dla ETAPU 1 wymagane są przynajmniej intencjonalne red cases:

- brak mapowania runtime ID,
- nieznany tool binding,
- skill przekraczający tool ceiling,
- high-risk bez jurysdykcji,
- shadow widoczny w root API, Meta rosterze, legacy delegation albo default V2,
- nielegalna zmiana identity/spec lub projection bez CAS,
- unbound, wrong-tool, wrong-task albo expired approval.

## Warunek ukończenia milestone'u

Milestone jest ukończony dopiero, gdy:

- nowy branch/worktree istnieje i nie zawiera cudzych zmian,
- ADR-y ETAPU 0 są kompletne,
- kontrakty i foundation ETAPU 1 są zaimplementowane,
- shadow jest fail-closed niewidoczny we wszystkich powierzchniach live composition,
- negatywne fixture'y najpierw dowiodły defektu, a potem są zielone,
- TypeScript, właściwe targeted checks i `git diff --check` przechodzą,
- nie uruchomiono ani nie zmodyfikowano live systemu lub baz,
- commity są małe, opisowe i ograniczone do brancha Foundry.

## Raport końcowy

Podaj:

1. branch, worktree, BASE_COMMIT i końcowy HEAD,
2. listę commitów i plików,
3. wykonane red/green dowody oraz dokładne komendy,
4. czego celowo nie uruchomiono z powodu granic live/DB,
5. pozostałe ryzyka lub blocker,
6. jednoznaczny następny krok według grafu zależności planu.

Nie deklaruj ETAPU jako ukończonego bez dowodów jego kryteriów akceptacji.
