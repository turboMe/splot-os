# Etap 8 (Wiedza) — rewizja z Graphify

> Rozpisane 2026-07-20. Rewizja pierwotnego E8 planu (Serena + snapshot + Graphiti)
> po znalezieniu Graphify. **Wymaga empirycznej weryfikacji przed wdrożeniem** —
> patrz §5. Decyzja sterowana danymi, nie hype'em (zasada C2.4).

## 0. Cel E8 (bez zmian)

„Koniec palenia tokenów na czytanie kodu." Metryka wyjścia: **zadanie kodowe
kończy się przy <50% tokenów wejściowych vs baseline**. Fakt zapisany w
poniedziałek odnajdywany w piątek (warstwa faktów — patrz §4).

## 1. Co to jest Graphify (zweryfikowane u źródła 2026-07-20)

GitHub `Graphify-Labs/graphify`, autorytatywnie przez API:
- **92 260 ⭐, 8 975 forków**, Python, **MIT**, utworzone 2026-04-03, push dzisiaj,
  domyślny branch `v8`, 580 open issues.
- tree-sitter AST (~40 języków, w tym TS/TSX), **lokalny, deterministyczny**,
  code-only bez API key (offline, koszt 0), **bez vector store** (czysty graf).
- Krawędzie: `calls`, `imports`, `inherits`, `mixes_in`, tagowane `EXTRACTED` vs
  `INFERRED`. Community detection (Leiden), god-nodes (centralność).
- Output: `graph.json` (graf), `GRAPH_REPORT.md` (koncepcje + sugerowane pytania),
  `graph.html` (interaktywna wizualizacja).
- CLI: `extract` (build), `query` (NL → scoped subgraph), `update` (tylko zmienione
  pliki), `watch` (auto-sync). Ma też **MCP server** (query_graph/get_node/
  get_neighbors/shortest_path/PR tools, stdio/HTTP).

**Ryzyko:** młody (3,5 mies.) i szybko zmienny (default branch v8, 580 issues) →
pinować wersję, nie jechać na latest; zależność od Pythona w stacku TS.

## 2. Graphify vs plan — mapowanie warstw

| Warstwa E8 | Plan | Graphify | Decyzja |
|---|---|---|---|
| 3. Architektura repo (queryable map) | statyczny snapshot MD | **graph.json + report + query** | **Graphify zastępuje** (lepsze niż statyczny MD i niż nasz `repo_map`) |
| 1. Kod: nawigacja „które pliki" | Serena (LSP) | graf calls/imports + god-nodes + query | **Graphify pokrywa rdzeń**; Serena → opcjonalna |
| 1'. Edycje punktowe / precyzja symboli | Serena (LSP find_references, rename) | brak LSP (AST statyczny) | zostają istniejące `code_search`/`code_outline` + codingAgent; Serena tylko jeśli dane pokażą lukę |
| 2. Fakty temporalne (user/system) | Graphiti | **NIE robi tego** | Graphiti zostaje osobno — **odroczone** (pilot po E8), nie zależy od Graphify |

**Efekt rewizji:** rdzeń E8 = Graphify (warstwa 1+3). Serena i Graphiti → „opcjonalne,
włączamy jeśli metryki pokażą lukę". Mniej ruchomych części, gorący dobrze utrzymany
tool, bezpośrednio celuje w metrykę tokenową.

## 3. Integracja (Opcja A: CLI wrapper — start) — SKORYGOWANE PO SPIKE

Zgodnie z rekomendacją: **CLI wrapper bez MCP** (mniej ruchomych części, łatwiej
zmierzyć zysk tokenowy). MCP (Opcja B, ~144 MB RAM) rozważymy dla długich sesji
PÓŹNIEJ, gdy CLI się sprawdzi.

**Prace (po spike — akcent na komendy precyzyjne, nie fuzzy query):**
- `tools/dev/graphify-tools.ts` — toole odpalające CLI (wzorzec jak istniejące
  shell-outy; timeout, redakcja, fail-safe):
  - **`graphify_affected(symbol)`** → `graphify affected` — co się zepsuje/zależy od
    X (GŁÓWNA wartość; precyzyjne; ~140 tok). Wołane PRZED edycją symbolu.
  - **`graphify_explain(symbol)`** → `graphify explain` — węzeł + sąsiedzi (precyzyjne).
  - **`graphify_god_nodes()`** → huby architektury (orientacja w nowym repo).
  - `graphify_query(q, --context)` → tylko pomocniczo, z filtrem (niska precyzja solo).
- **Build code-only = `graphify update <ścieżka-kodu>`** (NIE `extract`, który używa LLM).
- **Zawęzić zakres do dirów kodu** (agents/services/tools/config/lib/workflows/scripts),
  żeby wyciąć szum z `_skills/assets/prompts/public` (spike §5a problem 1).
- Rejestracja u `codingAgent` (i read-only u meta do planowania delegacji) + **karta
  w Agent Board** (E2) z kontraktem „pytaj graf PRZED czytaniem plików".
- Reguła w coding-harness/precontext (E-istniejące): kolejność
  **graphify_query → code_search/outline → czytanie plików** (całe pliki za
  uzasadnieniem). To realizuje „mapa przed eksploracją".
- Lifecycle grafu (nie rebuild przy każdym starcie Mastry):
  - pierwsze uruchomienie / brak `graph.json` → `graphify extract --code-only` (raz);
  - po zmianach → `graphify update` (inkrementalnie) w istniejącym `repo-maintenance`
    / hooku po merge (mamy koncept repo-maintenance);
  - `createExternalProject` (agent tworzy repo) → `graphify extract` na nowym repo.
- `graphify-out/` → `.gitignore` (artefakt runtime, jak `_skills/auto`).
- Model/instalacja: Python + graphify **pinowana wersja** (nie `v8` latest);
  udokumentować w README/setup. Sprawdzić, czy działa w host-network/kontenerze.

## 4. Warstwa faktów (2) — odroczona, niezależna

Graphify NIE robi warstwy 2. Fakty temporalne (Graphiti) zostają osobnym,
mniejszym pilotem PO rdzeniu E8 (plan już to zakładał: „tydzień, wymaga dyscypliny
zapisu", pilot 2 typy faktów, wyłączalny flagą). Nie blokuje metryki tokenowej,
która jest o kodzie. Źródło faktów mamy już częściowo: `decision_memo` (E3),
observational/shared memory. Decyzja Graphiti vs rozbudowa istniejącej pamięci —
osobno, po zmierzeniu E8.

## 5. Weryfikacja EMPIRYCZNA (przed commitem — to jest „dobrze zweryfikować")

Pytania, na które trzeba odpowiedzieć DANYMI, nie założeniem:
1. **Jakość parsowania TS/TSX na NASZYM repo** — `graphify extract --code-only`
   na agentic-agents; obejrzeć graph.json/report: czy delegate-task→harness→agent
   zależności są sensowne? Czy łapie nasze wzorce (dynamiczne importy, Mastra tools)?
2. **Realny zysk tokenowy** — zadanie wzorcowe kodowe: ścieżka `graphify_query →
   read` vs obecna `repo_map/code_search → read`; zmierzyć tokeny wejściowe
   (baseline:metrics). Cel <50%. Jeśli nie bije naszego repo_map — nie warto.
3. **Czas/koszt build + update** — ile trwa extract na ~naszym rozmiarze; czy
   `update` jest naprawdę inkrementalny i szybki.
4. **Stabilność zależności** — pin wersji; czy CLI kontrakt (`query --graph`) jest
   stabilny między wersjami (580 issues, szybki rozwój).
5. **RAM/proces** — CLI (bez rezydentnego procesu) vs MCP (~144 MB); na start CLI.

**Spike (pierwszy krok wykonania E8):** zainstalować pinowaną wersję, `extract
--code-only` na repo, obejrzeć wynik, jedno zadanie wzorcowe z pomiarem tokenów.
Dopiero zielony spike → budujemy `graphify_query` tool + lifecycle.

## 5a. WYNIKI SPIKE (wykonane 2026-07-20) — werdykt: WARUNKOWO TAK

Instalacja: izolowany venv, **`graphifyy==0.9.22`** (nazwa PyPI z podwójnym y!;
zweryfikowana jako oficjalna — homepage→repo, MIT, autor Safi Shamsi, py≥3.10).
Uwaga: realna komenda code-only to **`graphify update <path>`** (bez LLM), NIE
`extract --code-only` (to jest wersja z LLM) — opis pierwotny miał nieścisłości.

**Build (`graphify update src/mastra`):**
- **12,5 s**, RSS 318 MB, exit 0. **Poprawnie zignorował 9,1 GB `public/`** (assety).
- **19 249 węzłów, 24 834 krawędzi, 1361 społeczności**; graph.json 18 MB.
- Krawędzie realne i sensowne: `calls` 3258, `imports` 2095, `imports_from` 1208,
  `extends` 186, `re_exports` 22, `references` 262 (+ `contains` strukturalne).

**Jakość zapytań (make-or-break):**
| Komenda | Werdykt | Dowód |
|---|---|---|
| `affected "X"` (analiza wpływu) | ✅ **ŚWIETNE, precyzyjne** | `affected transitionLane` zwrócił DOKŁADNIE zależne pliki z E1/E5 (async-delegation, automation-job-manager, ledger-tools, oba testy) — **~140 tokenów** za kompletną, poprawną analizę wpływu |
| `explain "X"` (węzeł + sąsiedzi) | ✅ **precyzyjne** | `explain delegateTaskTool` → importowany przez meta + 8 orkiestratorów (idealnie) |
| `god-nodes` (huby) | ✅ **~90% trafne** | getDb/logHarnessEvent/withToolEnvelope/generateWithHarness/redactSecrets = nasze realne huby (szum: `Genre Presets` z danych music) |
| `query "<NL>"` (szeroki BFS) | ⚠️ **niska precyzja** | 832 węzły na proste pytanie, szum w seedach (tytuły filmów z `_skills`); trzeba `--context` do zawężenia |

**Kluczowy wniosek — przewartościowanie roli:** największa wartość Graphify to NIE
fuzzy `query` (nasz semantyczny `code_search` robi to lepiej), tylko **precyzyjna
nawigacja strukturalna**: `affected` (co się zepsuje jak zmienię X — atut, którego
u nas NIE MA), `explain`, `god-nodes`. To komplementarne do naszego code_search, a
`affected` daje agentowi świadomość wpływu PRZED edycją — realna oszczędność „czytam
wszystko na wszelki wypadek".

**Dwa problemy do rozwiązania przy wdrożeniu:**
1. **Szum z nie-kodu** — wskazanie `src/mastra` wciąga `_skills/*.md`, `assets/`,
   `prompts/`, `public/` do grafu. Dla mapy KODU zawęzić do dirów kodu
   (agents/services/tools/config/lib/workflows/scripts) albo skonfigurować ignore.
2. **`query` niska precyzja** — używać `affected`/`explain`/`god-nodes` jako głównych
   powierzchni (precyzyjne), a `query` tylko z `--context` filtrem, nie jako główny
   „semantic search".

**Werdykt spike:** ✅ **warto — ale w węższej, celniejszej roli** niż pierwotnie
zakładałem. Nie „zamiennik code_search", tylko **warstwa analizy strukturalnej/wpływu**
(affected/explain/god-nodes) dokładająca to, czego nam brakuje. Build tani (12,5 s),
lokalny, bez API key, bez vector store. Pin `graphifyy==0.9.22`.

**Do domknięcia weryfikacji (przed pełnym wdrożeniem E8):** twardy pomiar tokenowy
head-to-head `affected`+`explain` vs obecna ścieżka „grep+czytaj pliki" na zadaniu
wzorcowym edycyjnym (spodziewany duży zysk dla zadań, które muszą znać wpływ zmiany).

## 5b. WYKONANE — graphify_affected tool (2026-07-20)

Po zielonym pomiarze tokenowym zbudowany PIERWSZY tool E8:
- **Pomiar tokenowy** (scenariusz „zrozum wpływ zmiany transitionLane"):
  Graphify affected ~412 tok · grep ~575 tok (niepełne) · czytanie 5 plików ~14 190 tok
  → **~97% redukcji** vs czytanie, i bardziej kompletne niż grep. Największy zysk dla
  symboli o wysokim fanoucie.
- `services/graphify.ts` — bezpieczny `execFile` wrapper (bez wstrzyknięć) + czysty
  parser `parseAffectedOutput`; fail-soft (brak CLI/grafu → structured „unavailable"
  + hint, nigdy throw). Ścieżki konfigurowalne: `GRAPHIFY_BIN`, `GRAPHIFY_GRAPH`.
- `tools/dev/graphify-tools.ts` — `graphify_affected(symbol, depth)`; zarejestrowany
  u **codingAgent** + w puli odkrywalnej **meta**.
- `npm run graph:build` / `graph:update` (`graphify update src/mastra`); `graphify-out/`
  w `.gitignore`. Flaga `FEATURE_GRAPHIFY` (default ON, tool degraduje się łagodnie
  bez grafu — bezpieczne).
- Testy: `check:graphify-affected-parse` (parser na realnym outpucie spike'u +
  degradacja) w `check:all` (zielone). Żywy smoke: tool zwrócił 22 zależne węzły
  dla transitionLane z poprawnymi plikami.
- **Setup do uruchomienia u operatora:** `pipx install graphifyy==0.9.22` (lub
  `GRAPHIFY_BIN` na venv), potem `npm run graph:build`. Bez tego tool mówi „unavailable"
  i agent używa code_search/repo_map.

**Instalacja (WYKONANA 2026-07-20) — IZOLOWANA, nie w projekcie:**
- graphify żyje w dedykowanym venv **`~/.venvs/graphify`** (poza repo, poza systemowym
  Pythonem; PEP 668 blokuje pip --user, venv jest wyłączony). `graphifyy==0.9.22`.
- projekt zna go tylko przez **`GRAPHIFY_BIN`** w `.env` (gitignorowany → ścieżka
  maszynowa NIE trafia do repo). Graf `graphify-out/` żyje w projekcie (opisuje jego
  kod) ale jest gitignorowany. Zero zależności Pythona w package.json, zero śladu w repo.
- `npm run graph:build` → 19 264 węzły, 14 s. Tool zweryfikowany na realnej instalacji
  (openLane → 17 zależności, GRAPHIFY_BIN z .env).

**explain + god-nodes DODANE (2026-07-20):** `graphify_explain(symbol)` (węzeł + sąsiedzi
kierunkowo) i `graphify_god_nodes(top)` (huby) — ten sam wrapper, parsery przetestowane
(`check:graphify-affected-parse`), żywy smoke OK (delegateTaskTool: 10 połączeń; huby:
getDb 338 / logHarnessEvent 56 / withToolEnvelope 52). Wszystkie 3 toole u codingAgent +
pula meta.

**Reguła + auto-refresh DODANE (2026-07-20):**
- **Reguła w prompcie** `coding/base.md` → sekcja „Map before you edit" — codingAgent ma
  wołać `graphify_affected` PRZED edycją współdzielonego symbolu (+ explain/god_nodes do
  orientacji), z fallbackiem do code_search/repo_map. Zamienia dostępne narzędzie w nawyk.
- **Auto-odświeżanie po zmianie kodu** — `scripts/graph-refresh.sh` (fail-soft, w tle,
  inkrementalne, NIGDY nie blokuje commita; resolve GRAPHIFY_BIN z env/.env/venv/PATH,
  skip gdy brak CLI/grafu) + git hooki `post-commit`/`post-merge` w `scripts/git-hooks/`;
  instalacja `npm run graph:hooks` (`git config core.hooksPath scripts/git-hooks`, aktywne
  na tym klonie; fresh clone: uruchom raz). Log w `.mastra/graph-refresh.log`.

**Pozostało w E8:** `check:coding-token-budget` (metryka <50% tokenów na całym zadaniu
edycyjnym — dowód liczbą, nie założeniem). Serena/Graphiti dalej odroczone.

## 6. Exit criteria (zaktualizowane)

- Spike: graph.json sensowny na naszym TS + zmierzony zysk tokenowy na zadaniu
  wzorcowym (<50% vs baseline).
- `graphify_query` tool u codingAgent + karta w Board + reguła kolejności w harnessie.
- Lifecycle: extract raz / update po merge / gitignore / nowe repo.
- Metryka `check:coding-token-budget` (zadanie wzorcowe <50% tokenów) — jak w planie.
- Serena/Graphiti: świadomie odroczone; wracają tylko jeśli dane pokażą lukę
  (precyzja edycji / fakty temporalne).

## 7. Czego NIE robimy na start

- MCP Graphify (Opcja B) — dopiero po sprawdzeniu CLI.
- Serena — dopóki Graphify + istniejące code_search wystarczają do celu tokenowego.
- Graphiti — osobny pilot faktów po rdzeniu E8.
- Rebuild grafu przy każdym starcie Mastry — tylko extract-raz + update-po-zmianie.
- Jazda na `v8`/latest — pin wersji.
