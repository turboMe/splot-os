# F8 — pozostałe scenariusze fault suite

**Dla kogo:** osobna instancja domykająca bramkę F8.
**Stan na:** 2026-08-18. Wszystkie liczby poniżej są **zmierzone w tej sesji**, nie założone.
**Poprzednik:** `ideas/decyzja-infra-mongo-3-wezly-f8.md` (topologia), `ideas/infra-mongo-3-node-for-f8.md` (zadanie infra).

---

## 1. Gdzie jesteśmy

Plan (`ideas/plan-dziecko-po-odlozeniu-g0.md` §F8) wymienia **sześć** scenariuszy i trzy
właściwości w definicji ukończenia. Stan faktyczny:

| # | Scenariusz z planu | Stan | Plik |
|---|---|---|---|
| 1 | partycja worker↔Mongo podczas `claim`/`heartbeat` | ❌ **do zrobienia** | — |
| 2 | primary stepdown podczas odnawiania lease | 🟡 **częściowo** — pokryty *kill* primary, nie *stepdown* | `f8-no-duplicate-effect.ts` |
| 3 | `TransientTransactionError` | ❌ **do zrobienia** | — |
| 4 | `UnknownTransactionCommitResult` | ✅ | `f8-unknown-commit-idempotent.ts` |
| 5 | powrót starego primary po wygaśnięciu fence | 🟡 **częściowo** — powrót węzła pokryty, kombinacja z fence nie | `f8-no-split-brain.ts` |
| 6 | opóźniony i zdublowany retry | 🟡 **zdublowany ✅, opóźniony ❌** | `f8-unknown-commit-idempotent.ts` (B) |

| Właściwość z definicji ukończenia | Stan |
|---|---|
| brak **split-brain** | ✅ `f8-no-split-brain` |
| brak **duplicate effect** | ✅ `f8-no-duplicate-effect` + `f8-unknown-commit-idempotent` |
| brak **lost outbox** | ❌ **nietknięte** — a outbox realnie istnieje |

Commity: `68d38da`, `dd8f90a`, `0ba3de2`. Wszystkie trzy zielone, każdy sfalsyfikowany
(patrz §4).

---

## 2. Który scenariusz jest pilny, a który to ubezpieczenie

To jest najważniejsza treść tego dokumentu i **zmienia kolejność pracy**.

Produkcja chodzi **na jednym węźle** — zmierzone dziś:

```
rs.status() → replicaSet=rs0  członków=1
```

Na jednym węźle **nie da się** wywołać elekcji, stepdownu ani partycji między członkami.
Split-brain jest tam fizycznie niemożliwy — nie ma drugiego węzła, który mógłby się nie
zgodzić. Z sześciu scenariuszy planu **dwa** opisują awarie możliwe na dzisiejszej
produkcji:

- **`UnknownTransactionCommitResult`** — połączenie może zginąć w trakcie commitu na
  *dowolnej* topologii, także jednowęzłowej. **Pokryte ✅.**
- **utrata outboxu** — nie wymaga w ogóle wielu węzłów. **Niepokryte ❌.**

Reszta to ubezpieczenie na topologię 3-węzłową, której na produkcji **jeszcze nie ma**.
Wartościowe (bez tego nie wolno tam pójść), ale nie blokuje niczego dzisiaj.

> **Wniosek dla kolejności:** zrób **najpierw lost outbox**, nawet jeśli nie ma go na
> liście sześciu — jest w *definicji ukończenia*, a lista scenariuszy to droga do niej,
> nie cel. Potem reszta.

---

## 3. Scenariusze — precyzyjnie, z miejscem w kodzie

### 3.1 ⭐ LOST OUTBOX (priorytet 1 — jedyny pilny)

**Gdzie:** `src/mastra/orchestration/store/conversation-writer.ts:98` —
`projectConversationOnce()`.

Kształt kodu (przeczytany, nie zgadnięty): pobranie zdarzenia `PENDING`, wstawienie slotu
`mailbox` jako strażnik idempotencji, projekcja i `state: 'DELIVERED'` — **wszystko wewnątrz
jednego `runTxn`**. Zdarzenia wstawia `request-boundary.ts:102` i `:218`.

**Właściwość do udowodnienia:** zdarzenie nigdy nie znika bez projekcji. Konkretnie:

1. zabij commit w trakcie `projectConversationOnce` (failpoint `fail-commit`);
2. zdarzenie **musi** dalej być `PENDING` — nie `DELIVERED`, nie skasowane;
3. po wyleczeniu kolejne wywołanie projektuje je **dokładnie raz**;
4. dwa równoległe projektory na tym samym zdarzeniu → jedna projekcja, drugi dostaje
   `applied:false` (ścieżka duplicate-key, `:135`).

**Falsyfikacja:** przenieś `outbox.updateOne({state:'DELIVERED'})` **poza** transakcję —
asercja 2 musi zrobić się ✗.

**Uwaga:** to jest jedyny scenariusz, który realnie stoi między systemem a przepięciem
flag cutoveru. Reszta dokumentu może poczekać.

---

### 3.2 Partycja worker↔Mongo podczas `claim`/`heartbeat`

**Gdzie:** `claimAttempt` / `renewLease` w `src/mastra/orchestration/store/attempts.ts`.

**Właściwość:** worker odcięty od Mongo w trakcie pracy nie może po powrocie
zatwierdzić wyniku, jeśli jego lease w międzyczasie wygasł i został przejęty — a jeśli
NIE został przejęty, musi móc dokończyć.

Ta druga połowa jest ważniejsza i łatwiejsza do przeoczenia: system, który po każdej
czkawce sieciowej wyrzuca pracę, jest bezpieczny i bezużyteczny.

**Narzędzie:** `scripts/f8-mongo-chaos.sh partition <a|b|c>` — odcina węzeł. Do odcięcia
*klienta* od całego setu użyj partycji wszystkich trzech albo `iptables` w kontenerze
klienta; prostsza droga to `directConnection` do jednego węzła i partycja tego węzła.

**Pułapka zmierzona:** `claim` niesie deadline pracy. Jeśli scenariusz spędzi zbyt dużo
czasu na chaosie przed submitem, dostaniesz `work_deadline_or_authority` — realny strażnik
odpalający z powodu **niezwiązanego** z testem. Pierwsza wersja
`f8-unknown-commit-idempotent` na tym poległa; rozwiązanie: twórz attempt **po** chaosie.

---

### 3.3 `TransientTransactionError`

**Gdzie:** `src/mastra/orchestration/store/txn.ts` — `runTxn` ma **rozdzielony** retry:
`TransientTransactionError` restartuje callback, `UnknownTransactionCommitResult` ponawia
sam commit. Ten podział jest właśnie tym, co trzeba udowodnić.

**Narzędzie:** `bash scripts/f8-mongo-chaos.sh fail-txn-write [times|alwaysOn]` — **już
istnieje**, nie trzeba go pisać.

**Właściwość:** callback wykonany dwa razy nie zostawia dwóch efektów, a budżet retry jest
skończony.

**Pułapka zmierzona (kosztowała pół scenariusza):** `fail-commit` zabija połączenie w
trakcie `commitTransaction`, a powstały `MongoNetworkError` **nie niesie żadnych etykiet** —
ani `UnknownTransactionCommitResult`, ani `TransientTransactionError`. Sprawdź etykiety
zanim zbudujesz asercję na założeniu, że tam są. I pamiętaj, że po failpoincie pula tego
klienta jest pełna zabitych połączeń — używaj **świeżego, krótko żyjącego klienta**.

---

### 3.4 Opóźniony retry

**Właściwość:** attempt wskrzeszony po długim czasie (dłużej niż lease, dłużej niż
`jobControlRecoveryReserveMs: 90 000`) nie wchodzi w kolizję z tym, co go zastąpiło.

Najbliższe temu, co już jest: `f8-no-duplicate-effect` fenced-out worker. Różnica polega na
skali czasu — tam odcięcie trwa sekundy, tu chodzi o powrót po minutach, gdy zadanie mogło
już się **zakończyć**, a nie tylko zostać przejęte.

---

### 3.5 Stepdown (nie kill) podczas odnawiania lease

`f8-no-duplicate-effect` **zabija** primary. `rs.stepDown()` to inny przypadek: węzeł żyje,
oddaje rolę i dalej odpowiada klientom jako secondary. Sterownik ma wtedy przekierować, a
nie zawieść.

**Narzędzie:** `bash scripts/f8-mongo-chaos.sh stepdown [secs]` — **już istnieje**.

---

## 4. Zasady, które w tym repo kosztowały najwięcej

Nie są to ogólniki — każda pochodzi z konkretnej porażki w tej sesji.

**Po napisaniu asercji zepsuj kod i sprawdź, że widzisz ✗.**
Cztery razy w tej sesji napisałem asercję, która **nie potrafiła oblać**. Każda wyglądała
rozsądnie i każda była dekoracją. Trzy scenariusze F8 zostały sfalsyfikowane jawnie:
- `f8-no-split-brain` ← osłabienie `writeConcern` z `majority` do `w:1` w `txn.ts:17`
- `f8-no-duplicate-effect` ← usunięcie podniesienia fence w recovery
- `f8-unknown-commit-idempotent` ← usunięcie porównania hasha payloadu

**Dwie asercje w `f8-no-duplicate-effect` NIE testują tego, co się wydaje.** Recovery robi
dwie rzeczy naraz: kończy attempt jako `WORKER_LOST` **i** podnosi fence. Usunięcie kontroli
fence z `submitAttemptResult`, a potem z `renewLease`, zostawiło obie asercje **zielone** —
bo strażnik cyklu życia odpowiada pierwszy. To jest zapisane w nagłówku tamtego pliku i nie
należy tego „naprawiać" przez udawanie, że fence jest tam izolowany.

**Zanim uznasz pustkę za defekt: policz wiersze bez filtra i przeczytaj sygnaturę w
źródle.** W jednej sesji dziewięć „defektów" okazało się błędami sondy — złe nazwy pól
(`createdAt` vs `timestamp`), zła kolekcja (`harness_events` vs `agent_events`), niezainicjowany
rejestr.

**Nieudany write concern NIE znaczy, że zapisu nie było.** Znaczy, że nie został
**potwierdzony**. Primary zastosował go lokalnie; jeśli nie stracił elekcji, po powrocie
secondary go zreplikują. To udokumentowana semantyka Mongo, nie defekt — i dokładnie dlatego
idempotencja jest *podstawową* obroną, a nie dodatkiem. „Mój zapis się nie udał" nigdy nie
jest bezpiecznym przekonaniem workera.

**`isolate` ≠ odcięcie.** Blokuje wyłącznie przychodzące `replSetHeartbeat`, więc większość
oznacza węzeł jako `health=0` — ale replikacja idzie innym kanałem i zapis `w:majority` przez
ten węzeł **przechodzi**, legalnie. Zmierzone. Żeby uzyskać stary primary bez większości,
odetnij **pozostałe dwa** węzły.

**Git tu mówi po polsku.** Nie buduj logiki na dopasowaniu angielskiego wyjścia gita —
`nothing to commit` nigdy nie wystąpi. Decyduj po kodzie wyjścia albo `--porcelain`.
Brama: `npm run check:git-locale-independence`.

---

## 5. Środowisko

```bash
npm run infra:rs3:up        # trzy węzły na 27019/27020/27021, replicaSet=rs3f8
npm run infra:rs3:status
npm run infra:rs3:down
```

Chaos: `bash scripts/f8-mongo-chaos.sh <verb>` — **wszystkie potrzebne czasowniki już
istnieją**, zweryfikowane w źródle: `status`, `views`, `stepdown`, `isolate`, `partition`,
`kill`, `revive`, `freeze`, `fail-commit`, `fail-txn-write`, `heal`. Żaden scenariusz z §3
nie wymaga dopisywania narzędzia — tylko napisania testu.

Uruchomienie istniejących scenariuszy:
```bash
npm run f8:no-duplicate-effect
npm run f8:unknown-commit-idempotent
npm run f8:no-split-brain
```

**Node v22 obowiązkowo** (`nvm use v22.20.0`). Pod v20 serwer startuje, **nie nasłuchuje i
nie loguje błędu**.

**Zestaw 3-węzłowy stoi OBOK produkcji**, na osobnych wolumenach. Wolumen produkcyjny
`jarvis-dashboard-agent_mongo-data` jest `external` i **współdzielony z innym projektem** —
`docker compose down -v` zniszczyłby cudze dane. Nigdy go nie usuwaj.

---

## 6. Zasady pracy w repo

- Commituj **wyłącznie jawnymi ścieżkami**. **Nigdy `git add -A`** — w drzewie pracują inne
  sesje. `git status --short` przed uznaniem czegokolwiek za swoje.
- **NIE włączaj** `FEATURE_ORCHESTRATION_V2_DELEGATION` ani
  `FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS` (linie 420–421 w `.env`, zakomentowane
  świadomie). To decyzja właściciela, nie skutek uboczny scenariusza.
- Po każdym scenariuszu: `bash scripts/check-all.sh` musi wyjść 0.
- Nowe scenariusze **nie idą** do `check:all` — wymagają zestawu 3-węzłowego, którego brama
  nie podnosi. Trzymaj je jako osobne `npm run f8:*`, tak jak trzy istniejące.

---

## 7. Definicja ukończenia tego zadania

- lost outbox pokryty i **sfalsyfikowany** (priorytet 1);
- partycja claim/heartbeat, `TransientTransactionError`, opóźniony retry, stepdown —
  pokryte, każdy sfalsyfikowany jawnie;
- każdy plik ma w nagłówku zapisane **czego NIE dowodzi** (wzorzec z trzech istniejących);
- `check:all` exit 0;
- wpis w dzienniku postępu `ideas/plan-dziecko-po-odlozeniu-g0.md` §6 z numerami commitów.
