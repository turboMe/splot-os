# HANDOFF — wdrożenie skilli + tor computer use

**To jest jedyny plik, od którego zaczynasz.** Zawiera kontekst, kolejność czytania, twarde
niezmienniki i pułapki. Nie zaczynaj od kodu.

Stan wyjściowy: **analiza skończona, nic nie wdrożone, `src/` nietknięte.**

---

## 1. Co to za zadanie

Użytkownik przygotował 33 skille w `/projekty/mastra-agentic-environment/staging-skills/` z myślą o
wzbogaceniu agentów. Audyt wykazał, że **10 z 33 jest wartych wdrożenia**, 5 jest aktywnie
szkodliwych, reszta redundantna. Poprawione wersje są gotowe. Twoje zadanie: **wdrożyć je falami,
z weryfikacją po każdej**, oraz — jeśli użytkownik na to pójdzie — rozpocząć tor computer use.

Do wdrożenia jest **12 skilli + 2 patche do promptów**, wszystko w `staging-skills/_ready/`.
Dwa z tych plików to patche, nie skille (`prompt-patches/`), i **jeden z nich warunkuje falę 1** —
patrz niezmiennik 7 poniżej.

Stan zweryfikowany przy przygotowaniu (2026-08-26): wszystkie `allowedTools` w `_ready/` istnieją
w rejestrze narzędzi, zero kolizji nazw z 188 istniejącymi skillami, patch do `meta/base.md`
mieści się w budżecie bramki (353 zn. przy suficie 749). **Sprawdź to ponownie**, jeśli od tego
czasu ktoś dotykał `src/mastra/tools` albo `prompts/meta/`.

## 2. Kolejność czytania (nie zmieniaj jej)

1. **`ideas/audyt-staging-skills-2026-08-26.md`** — *dlaczego*. Cztery fakty architektoniczne
   (sekcja 0) rządzą każdą decyzją „komu dać skill". Bez nich wykonasz plan mechanicznie i źle.
2. **`ideas/plan-wdrozenia-skilli-2026-08-26.md`** — *co i w jakiej kolejności*. Fale 0-5, komendy,
   weryfikacja, rollback, tor computer use.
3. **`/projekty/mastra-agentic-environment/staging-skills/_ready/README.md`** — manifest gotowych
   plików i mapowanie na katalogi docelowe.

Dopiero potem kod.

## 3. Topografia

| Co | Gdzie |
|---|---|
| Repo gitowe | `/projekty/mastra-agentic-environment/agentic-agents/` ← **tu commitujesz** |
| Katalog nadrzędny | `/projekty/mastra-agentic-environment/` — **nie jest repo gitowym** |
| Gotowe skille | `staging-skills/_ready/` — **poza gitem, edycje nieodwracalne** |
| Oryginały staging | `staging-skills/{meta,research,coding,design,marketing,automation}/` — archiwum, nie ruszaj |
| Cel skilli | `agentic-agents/src/mastra/_skills/<kategoria>/` |
| Korpus promptów providerów | `/projekty/mastra-agentic-environment/prompty-providerów/system_prompts_leaks-main/` |

## 4. Twarde niezmienniki

1. **Fala 0 przed falą 1.** Bramka `check:skill-frontmatter` powstaje *zanim* dojdą nowe skille.
   Odwrotna kolejność = pierwszy błąd wykryje agent w produkcji.
2. **Restart po każdej fali.** Embeddingi liczone są przy starcie procesu (`index.ts:2485`). Bez
   restartu nowy skill nie istnieje dla `skill_search` — i wyjdzie ci, że „nie działa".
3. **Nie dodawaj niczego do `_skills/design/`** — rozstrzygnięte, wariant (a). Te 24 pliki celowo
   nie mają frontmattera i są niewidoczne dla rejestru; pierwszy plik z frontmatterem zmieni
   zachowanie wyszukiwarki dla całego systemu, a dwa największe (`design-styles.md` 54 839 zn.,
   `slide-decks.md` 41 770 zn.) i tak nie mieszczą się w budżecie półki design-agenta (36 000).
4. **Nie kopiuj 5 plików z listy „NIE robić"** (sekcja 6 planu). Każdy ma udokumentowany, konkretny
   powód — nie „wydają się słabe", tylko sprzeczność z regułą albo cofnięcie zapłaconej lekcji.
5. **Weryfikacja to obserwacja, nie bramki.** Zielony `check:all` nie mówi nic o trafności
   embeddingów. Po każdej fali odpal realne `skill_search` — **z testami negatywnymi włącznie**
   (co nowy skill *nie powinien* wyciągać).
6. **Polityka do kodu, nie do skilla** (sekcja 5.1 planu). Skill można zdjąć z półki; polityka
   w `harness-policy.ts` + `withToolEnvelope` z `HARNESS_POLICY_MODE=enforce` blokuje twardo.
   Nie odwracaj tej kolejności w torze computer use.
7. **Prompt bije skill.** Prompt agenta jest ładowany zawsze i ma wyższy autorytet niż procedura
   z półki. Skill sprzeczny z promptem nie „wygrywa czasem" — jest martwy albo produkuje
   niewytłumaczalną niekonsekwencję. Dlatego `architecture-diagram-svg` idzie razem z patchem 1.1,
   a `n8n-workflow-patterns` nie idzie wcale.
8. **Przeglądarka ≠ jedna polityka dla wszystkich.** `researcherAgent` ma przeglądarkę i **nie ma**
   `requestApprovalTool` → dla niego akcje bramkowane są nieosiągalne. `codingAgent` **ma**
   `requestApprovalTool` (`coding-agent.ts:40`) i po CU-3(a) dostanie przeglądarkę, a jego cel to
   jazda po własnej aplikacji na localhoście — inny profil ryzyka. Decyzja polityki bierze się
   z `target`, nie z akcji (tabela w sekcji 5.4(a) planu).
9. **Język**: skille i prompty po **angielsku** (to tooling). Po polsku tylko odpowiedzi do
   użytkownika i przykładowe treści biznesowe (maile, ulotki dla GastroBridge).

## 5. Pułapki, które zjadły już czas w tym repo

- **`check:all` chodzi pod `set -e`.** Jedna oblana kontrola ubija wszystkie następne. Nową bramkę
  wstaw **na początek** listy w `scripts/check-all.sh`, nie na koniec. Czytaj, która kontrola
  raportowała ostatnia, zanim uznasz przebieg za zielony.
- **Rejestr skilli to `Map` po `name`** — kolizja to *ciche* nadpisanie. Dziś jest 10 kolizji
  (`seedance-*`), fala 0.2 je rozbraja.
- **Nazwy narzędzi w skillach nie są walidowane** (dziś `check:prompt-tool-names` skanuje wyłącznie
  `src/mastra/prompts`). Staging deklaruje `view`, `write_to_file`, `execute_command`, `grep_search`
  — **żadna nie istnieje**. Realne nazwy weź z `grep -rh "id: '" src/mastra/tools`.
- **Świeży worktree nie ma `node_modules`.**
- **Git mówi tu po polsku** — dopasowywanie angielskiego wyjścia gita zawsze zawiedzie.
- **Kurator archiwizuje po 90 dniach od ostatniego użycia**, ale iteruje po `skill_stats`, gdzie
  wiersz powstaje przy pierwszym załadowaniu. Nigdy nieużyty skill nie zostanie zarchiwizowany —
  i to właśnie jest sygnał do ręcznego przeglądu po 30 dniach.
- **Sprawdź stan gałęzi na starcie.** Ostatnia znana: `feat/telegram-native-gateway`, `HEAD` na
  `f724b7b`. Jeśli się zmieniło — nie zakładaj, sprawdź.

## 6. Definicja ukończenia

Fala jest skończona, gdy **wszystkie trzy** są prawdziwe:

1. bramki z macierzy weryfikacji (sekcja 7 planu) przechodzą;
2. testy trafności — **pozytywne i negatywne** — dają oczekiwany wynik na żywym systemie;
3. jest jeden realny przebieg z obserwacją runtime, nie samą bramką.

Jeśli którykolwiek punkt nie wychodzi — **zgłoś to**.
Fałszywe „gotowe" jest w tym systemie udokumentowaną klasą awarii i jest dokładnie tym, przed czym
broni skill `verify-runtime-observation`, którego wdrożenie masz w fali 2.

## 7. Zakres, którego nie przekraczasz bez pytania

- Nie zmieniaj promptów agentów poza **trzema** edycjami jawnie opisanymi w planie:
  **1.1** (`meta/base.md` — wyjątek na wizualizacje wyjaśniające, wymaga zgody użytkownika,
  decyzja 2b), **2.1** (`coding/review.md` — druga faza recenzji),
  **4.1** (`shared/subagent-researcher.md` — dekompozycja i warstwy źródeł).
  Przy 1.1 wiążący jest zapas **749 znaków** z asercji `reduction >= 0.25`, nie limit 33 000 —
  to nie to samo i łatwo się na tym przejechać.
- Nie włączaj żadnej flagi na produkcji; nowe zdolności wchodzą domyślnie **OFF**.
- Nie ruszaj self-healingu (fala 2.2 jest opcjonalna i ma własną procedurę w
  `docs/SELF-HEALING-END-TO-END.md`).
- Nie commituj na `main`/`master` — gałąź per fala.
- **Wszystkie decyzje z sekcji 8 planu są rozstrzygnięte 2026-08-26 — nie pytaj o żadną.**
  Zatwierdzone: wariant (a) dla `_skills/design/`; obowiązkowa druga faza recenzji skalowana
  ryzykiem; wyjątek w `meta/base.md §6`; computer use **tylko substrat (a)** (CU-1 + CU-2 + CU-3(a)
  + bramki przeglądarkowe).
  **Nie realizuj:** CU-3(b) (kontener z wirtualnym ekranem), CU-4 (`operatorAgent`), portu `dataviz`.
  Te trzy są świadomie odłożone, nie zapomniane — warunki powrotu opisane w planie.
