# Próba rollbacku cutoveru (N/N-1) — czy da się wrócić bez porzucenia pracy w locie

**Dla kogo:** osobna instancja. **Nie koliduje** z instancją domykającą F8 (patrz §6).
**Data zebrania faktów:** 2026-08-18. Wszystko poniżej **przeczytane w źródle**, nie założone.
**Kontekst nadrzędny:** `ideas/plan-dziecko-po-odlozeniu-g0.md` §F9.

---

## 1. Po co to jest — logika rolloutu, nie lista życzeń

Flagi cutoveru (`FEATURE_ORCHESTRATION_V2_DELEGATION`,
`FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS`) są w `.env` **zakomentowane, linie 420–421**.
Cały mechanizm F6 jest zbudowany i zielony, ale **nigdy nie przeszedł przez niego ruch**.
To ten sam wzorzec, który w tym repo wychodził wielokrotnie: *„zbudowane i zielone" ≠
„wpięte"*.

Przed przekręceniem flagi na żywym ruchu trzeba umieć odpowiedzieć na trzy pytania:

| Pytanie | Stan — **zmierzony**, nie z planu |
|---|---|
| Czy umiemy **zatrzymać**? | ✅ **Tak.** `pauseDispatch: () => isKillSwitchActive()` w `src/mastra/index.ts:2302`, bezwarunkowo, na żywym mouncie. Semantyka: pauzuje przyjmowanie, praca w locie się domyka. |
| Czy umiemy **zobaczyć**? | 🟡 Częściowo — `services/dashboard-orchestration.ts` czyta `orch_jobs`. Brak SLO i alertów. |
| Czy umiemy **wrócić**? | ❓ **Nikt nigdy nie sprawdził.** Zero kodu. To jest zadanie. |

F9 wymienia „N/N-1 rollback rehearsal" w definicji ukończenia. Nie ma go w repo w żadnej
formie (`grep -rl "rollback" src/mastra/scripts/` → trzy pliki, żaden o tym).

**To jest właściwy następny krok**, bo to on odblokowuje decyzję właściciela o przekręceniu
flagi. Zatrzymanie mamy. Powrotu nie mamy.

---

## 2. Konkretna hipoteza — z dowodem z kodu

Nie jest to ogólne „przetestuj rollback". Czytanie kodu wskazuje **konkretną asymetrię**,
którą trzeba potwierdzić albo obalić na żywo.

Flaga jest czytana w **dwóch miejscach o różnej dynamice**:

**A. Przyjęcie nowej pracy — dynamicznie, przy każdym wywołaniu:**
```ts
// services/durable-delegation.ts:139
export function durableDelegationEnabled(): boolean {
  return process.env[FLAG] === 'true' && process.env.FEATURE_ORCHESTRATION_V2 === 'true';
}
// :172
if (!durableDelegationEnabled() || !config) return null;
```

**B. Most domykający (kopiuje wynik joba V2 z powrotem do kontraktu legacy) — RAZ, przy
starcie procesu:**
```ts
// index.ts:2203
const useDurableDelegation = durableDelegationEnabled();
// index.ts:2291 — cała gałąź jest warunkowa
...(useDurableDelegation || useDurableAutomation
  ? { afterReconcile: async () => {
        if (useDurableDelegation) await runDelegationCompletionBridge();
        if (useDurableAutomation) await runAutomationCompletionBridge();
      } }
  : {}),
```

Stąd **dwa różne zachowania rollbacku**, i tylko jedno jest bezpieczne:

| Sposób wycofania | Przyjęcie nowej pracy | Most domykający | Skutek dla pracy w locie |
|---|---|---|---|
| zmiana `process.env` **bez restartu** | natychmiast legacy ✅ | dalej zamontowany ✅ | domyka się poprawnie |
| **zakomentowanie w `.env` + restart** ← *tak wygląda prawdziwy rollback* | legacy ✅ | **nigdy nie montowany** | 🔴 **hipoteza: praca w locie osierocona** |

W drugim wierszu `config` nie zostaje ustawiony (`configureDurableDelegation` wywoływane
tylko `if (useDurableDelegation)`), więc `runDelegationCompletionBridge` zwróciłby `0` na
`if (!config) return 0` — ale nie zwróci nic, bo hook w ogóle nie istnieje.

**Konsekwencja, jeśli hipoteza się potwierdzi:** każda delegacja, która w momencie
rollbacku miała `status: 'running'` i `v2JobId`, zostaje bez odpowiedzi. Job V2 może
wykonać się bezbłędnie — wynik po prostu nigdy nie wraca do agenta, który na niego czeka.
Praca się wydarzyła, odpowiedź nie dotarła. To **nie jest** przypadek objęty F8 (tam chodzi
o awarie infrastruktury, tu o przejście flagi).

**Automation ma identyczny kształt** — `durable-automation-jobs.ts:155` i `:332`. Sprawdź
oba tory, nie tylko delegację.

> ⚠️ To jest **hipoteza z lektury kodu, nie zmierzony fakt**. Nie uruchamiałem tego.
> Twoim pierwszym zadaniem jest ją **potwierdzić albo obalić na żywo** — i jeśli okaże się
> błędna, to też jest wynik, tylko zapisz dlaczego.

---

## 3. Zasada, według której to naprawić (jeśli hipoteza się potwierdzi)

Jest już ustalona w tym repo, dwie linijki nad feralnym miejscem — komentarz przy kill
switchu w `index.ts:2300`:

> *„Pause only — in-flight attempts settle; killing them is `cancel`."*

Uogólnienie: **flaga bramkuje PRZYJĘCIE, nigdy DOMKNIĘCIE.**

Most domykający istnieje po to, żeby dokończyć pracę, która **już się zaczęła**. Jego
zadanie nie zależy od tego, czy chcemy *nowej* pracy w V2. Powinien działać zawsze, gdy
istnieją wiersze do domknięcia — a nie dlatego, że flaga była włączona w chwili startu
procesu.

Kształt naprawy (kierunek, nie recepta — uzasadnij własny wybór):
- most montowany **bezwarunkowo**, a nie w gałęzi `useDurableDelegation`;
- `config` ustawiany zawsze, a flaga decyduje wyłącznie w `maybeDispatchDurably`;
- most sam kończy się natychmiast, gdy nie ma nic do zrobienia (`rows.length === 0` →
  `return 0`), więc bezwarunkowe montowanie nie kosztuje nic, kiedy V2 jest wyłączone.

---

## 4. Co masz dostarczyć

1. **Próba na żywo** — skrypt, który:
   - włącza flagę, zleca kilka realnych delegacji,
   - pozwala części się domknąć, a część **zostawia w locie**,
   - wycofuje flagę **tak, jak zrobiłby to właściciel** (środowisko + restart pętli),
   - asercjonuje, że **każda** delegacja w locie osiąga stan terminalny w legacy —
     żadna nie zostaje w `running` na zawsze.
2. **Naprawa**, jeśli próba pokaże osierocenie.
3. **Brama regresyjna** — deterministyczny `check:*`, żeby ktoś tego nie cofnął. Ta luka
   jest niewidoczna dla wszystkich obecnych testów, bo każdy z nich działa przy **jednej,
   ustalonej** wartości flagi; defekt mieszka w **przejściu** między wartościami.
4. **Procedura rollbacku** w `docs/` — co właściciel ma zrobić, w jakiej kolejności, co
   sprawdzić, żeby wiedzieć, że się udało.

### Czego NIE robisz

- **NIE włączasz flag na stałe.** Włącz na czas próby, przywróć stan zastany. Linie 420–421
  w `.env` mają zostać zakomentowane. To decyzja właściciela.
- Nie ruszasz plików F8 (§6).
- Nie ruszasz migracji agentów ani promptów — to zadanie o **przejściu flagi**.

---

## 5. Definicja ukończenia

- hipoteza z §2 **potwierdzona albo obalona na żywo**, z zapisanym dowodem;
- jeśli potwierdzona — naprawiona, oba tory (delegacja i automation);
- brama regresyjna w `check:all`, **sfalsyfikowana** (zepsuj naprawę, zobacz ✗);
- procedura rollbacku w `docs/`;
- `bash scripts/check-all.sh` exit 0;
- `.env` w stanie zastanym — flagi dalej zakomentowane;
- wpis w dzienniku `ideas/plan-dziecko-po-odlozeniu-g0.md` §6.

---

## 6. Jak nie wejść w drogę instancji od F8

**Obie instancje pracują w TYM SAMYM drzewie roboczym** `/projekty/mastra-agentic-environment/agentic-agents`.
To nie są osobne worktree. Dlatego:

**Pliki należące do instancji F8 — NIE DOTYKAJ:**
```
src/mastra/scripts/f8-*.ts
scripts/f8-mongo-chaos.sh
src/mastra/orchestration/store/conversation-writer.ts
src/mastra/orchestration/store/attempts.ts
src/mastra/orchestration/store/txn.ts
```
Trzy ostatnie tamta instancja **celowo psuje i przywraca** przy falsyfikacji. Jeśli
zobaczysz je w `git status` w dziwnym stanie — to nie jest defekt, to trwająca
falsyfikacja. Zostaw.

**Twoje pliki** (rozłączne): `src/mastra/index.ts`, `services/durable-delegation.ts`,
`services/durable-automation-jobs.ts`, nowy skrypt, `docs/`.

**Dwa pliki wspólne — zachowaj ostrożność:**
- `package.json` — tamta instancja dopisuje wpisy `f8:*`. Dopisz swoje **jednym ruchem i
  od razu zacommituj**, nie trzymaj rozgrzebanego pliku.
- `scripts/check-all.sh` — tamta instancja **nie** dopisuje tam nic (scenariusze F8
  wymagają setu 3-węzłowego, którego brama nie podnosi), więc ten plik jest praktycznie
  Twój.
- `ideas/plan-dziecko-po-odlozeniu-g0.md` §6 — obie instancje dopisują wiersz dziennika.
  Dopisuj **na końcu**, jednym ruchem, i zacommituj od razu.

**Zawsze `git status --short` przed uznaniem czegokolwiek za swoje.** Zmiany, których nie
rozpoznajesz, należą do tamtej instancji.

---

## 7. Zasady pracy w repo

- **Node v22 obowiązkowo** (`nvm use v22.20.0`). Pod v20 serwer startuje, **nie nasłuchuje
  i nie loguje błędu** — wygląda jak zawieszenie bez przyczyny.
- Commituj **wyłącznie jawnymi ścieżkami**. **Nigdy `git add -A`.**
- **Po napisaniu asercji zepsuj kod i sprawdź, że widzisz ✗.** W poprzedniej sesji cztery
  asercje okazały się niezdolne do oblania — każda wyglądała rozsądnie. Brama, która nie
  potrafi oblać, jest dekoracją.
- **Zanim uznasz pustkę za defekt: policz wiersze bez filtra i przeczytaj sygnaturę w
  źródle.** W jednej sesji dziewięć „defektów" okazało się błędami sondy — złe nazwy pól
  (`createdAt` vs `timestamp`), zła kolekcja (`harness_events` vs `agent_events`),
  niezainicjowany rejestr. Przy pisaniu tego dokumentu też się to zdarzyło: uznałem, że
  kill switch nie sięga V2, bo szukałem w `src/mastra/orchestration/` — a wpięcie jest w
  `index.ts`. Sprawdź szerzej, zanim ogłosisz brak.
- **Git tu mówi po polsku** — nie buduj logiki na angielskim wyjściu gita
  (`nothing to commit` nigdy nie wystąpi). Decyduj po kodzie wyjścia albo `--porcelain`.
- Mongo produkcyjne to **single-node RS `rs0`** na 27017. Wolumen jest `external` i
  **współdzielony z innym projektem** — nigdy `docker compose down -v`.
