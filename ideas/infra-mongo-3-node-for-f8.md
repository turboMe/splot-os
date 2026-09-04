# Zadanie infrastrukturalne: replica set ≥3 węzły dla bramki F8

**Dla kogo:** osobna instancja/agent pracujący nad infrastrukturą, nie nad kodem agentów.
**Data zebrania faktów:** 2026-08-18. Wszystko poniżej jest **zmierzone**, nie założone.

---

## 1. Po co to jest

`ideas/plan-dziecko-po-odlozeniu-g0.md` §F8 to **jedyny formalny bloker rolloutu**
(wskazany przez ADR 0006). Dotyczy **utraty danych na produkcji**, nie wiarygodności
testów. Bez niego nie wolno zrobić F9 (rollout + usunięcie legacy).

F8 wymaga udowodnienia, że pod awariami nie ma **split-brain**, **lost outbox** ani
**duplicate effect** — z dowodami, nie z rozumowania. Scenariusze do wywołania:

- partycja sieciowa worker↔Mongo w trakcie `claim`/`heartbeat`,
- `stepdown` primary w trakcie odnawiania lease,
- `TransientTransactionError`,
- `UnknownTransactionCommitResult`,
- powrót starego primary po wygaśnięciu fence,
- opóźniony i zdublowany retry.

**Żadnego z nich nie da się wywołać na jednym węźle.** Stąd to zadanie.

---

## 2. Stan faktyczny — zmierzony

```
rs.status()  →  replicaSet: rs0 | członków: 1
                localhost:27017  state=PRIMARY  health=1
rs.conf()    →  version: 1 | writeConcernMajorityJournalDefault: true
```

Kontener: `mastra-mongo`, obraz `mongo:7`, port `0.0.0.0:27017->27017/tcp`.

Definicja: **`/projekty/mastra-agentic-environment/docker-compose.yml`**
(uwaga: ten plik **nie jest wersjonowany** w repo `agentic-agents` — leży piętro wyżej).

```yaml
  mongo:
    image: mongo:7
    container_name: mastra-mongo
    command: ["--replSet", "rs0", "--bind_ip_all"]
    ports: ["27017:27017"]
    volumes: [mongo-data:/data/db]
    healthcheck:
      test: ["CMD","mongosh","--quiet","--eval","db.hello().isWritablePrimary"]
```

```yaml
volumes:
  mongo-data:
    external: true
    name: jarvis-dashboard-agent_mongo-data
```

---

## 3. Pięć pułapek, które trzeba znać ZANIM cokolwiek ruszysz

### 3.1 ⛔ Wolumen danych jest WSPÓŁDZIELONY z innym projektem

`mongo-data` to `external: true` o nazwie `jarvis-dashboard-agent_mongo-data`.
Zawiera dane produkcyjne. **`docker compose down -v` zniszczy dane innego projektu.**
Nigdy nie usuwaj tego wolumenu. Nowe węzły dostają **własne, nowe** wolumeny.

### 3.2 Członek RS ogłasza się jako `localhost:27017`

To jest zapisane w konfiguracji replica setu, nie w compose. Klienci łączą się z
hosta przez zmapowany port. Przy przejściu na 3 węzły **każdy** connection string w
systemie musi dalej działać — a jest ich dużo:

```
MONGODB_URI=…                (aplikacja)
MONGODB_URI_V2=…             (orkiestracja V2)
MONGODB_URI_SPIKE_RS=…       (brama check:all)
```

Zmiana `rs.conf()` na hosty typu `mongo1:27017` **zerwie połączenia z hosta**, jeśli
nie zapewnisz rozwiązywania tych nazw (wpisy w `/etc/hosts` albo sieć dockerowa +
klient też w kontenerze). To jest główne ryzyko tego zadania.

### 3.3 Limit otwartych plików

Produkcyjny mongod chodzi z miękkim limitem 1024 przy ~800 uchwytach bazowych.
Każda efemeryczna baza orkiestracji kosztuje ~70 uchwytów. **Zmierzone dwukrotnie:**
puszczenie pełnej bramy na produkcyjnym mongodzie panikuje WiredTiger
(„Too many open files") i **przerywa serwer w trakcie**. Nowe węzły muszą mieć
`ulimits: nofile: 64000`.

### 3.4 Healthcheck nie może używać `ping`

`ping` odpowiada także na węźle **bez** zainicjowanego RS — kontener raportowałby
`healthy` przy niedziałających transakcjach. Obecny healthcheck sprawdza
`db.hello().isWritablePrimary` i tak ma zostać. **Uwaga:** na węzłach SECONDARY to
zwróci `false`, więc healthcheck dla nich musi być inny (np. `db.hello().ok`),
inaczej compose uzna zdrowe repliki za chore.

### 3.5 Istnieje już wzorzec efemerycznego RS — użyj go, nie wymyślaj

`scripts/ephemeral-mongo-rs.sh` stawia izolowany RS na **27018** (`--network host`,
`--rm`, `--ulimit nofile=64000`). Brama `check:all` sama go podnosi. To jest gotowy,
działający wzorzec na jednoplikowy skrypt zarządzający topologią — nowy skrypt dla
3 węzłów powinien go naśladować, łącznie z izolacją od `agentforge`.

---

## 4. Zakres zadania

### Co masz dostarczyć

1. **Topologia 3-węzłowa** (1 primary + 2 secondary; ewentualnie 2+1 arbiter — uzasadnij
   wybór, arbiter nie daje trwałości i przy `writeConcern: majority` bywa pułapką).
2. **Sposób uruchamiania**, który NIE dotyka wolumenu `jarvis-dashboard-agent_mongo-data`.
3. **Zachowanie kompatybilności connection stringów** — albo przez `/etc/hosts`,
   albo przez sieć dockerową z klientem w kontenerze. Udowodnij, że aplikacja łączy się
   po zmianie.
4. **Skrypt do wywoływania awarii** (partycja, stepdown) — bez tego F8 to tylko topologia.
5. **Dokument decyzyjny**: dlaczego taka topologia, jak wrócić do jednego węzła,
   co zrobić gdy coś pójdzie źle.

### Czego NIE robisz

- Nie ruszasz kodu agentów ani orkiestracji — to zadanie **wyłącznie** infrastrukturalne.
- Nie włączasz flag `FEATURE_ORCHESTRATION_V2_DELEGATION` ani
  `FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS` — to osobna, świadoma decyzja właściciela.
- Nie usuwasz żadnego wolumenu dockerowego.
- Nie piszesz samych testów fault-injection F8 — masz dostarczyć **topologię i narzędzia**,
  na których dadzą się napisać.

### Decyzja do podjęcia i uzasadnienia

Czy 3-węzłowy RS ma **zastąpić** produkcyjny single-node, czy stanąć **obok** jako
osobne środowisko na porcie 27019+ przeznaczone dla F8. Drugie jest bezpieczniejsze
(zero ryzyka dla danych produkcyjnych), pierwsze jest wierniejsze produkcji.
**Rekomendacja z zebranych faktów: obok.** Powód — wolumen jest współdzielony z innym
projektem, a bramka F8 i tak potrzebuje topologii, którą wolno rozrywać.

---

## 5. Definicja ukończenia

- `rs.status()` pokazuje ≥3 zdrowych członków,
- da się wywołać stepdown i partycję **skryptem**, powtarzalnie,
- aplikacja łączy się i wykonuje transakcję na nowej topologii,
- dane produkcyjne nietknięte (`docker volume ls` pokazuje
  `jarvis-dashboard-agent_mongo-data` bez zmian),
- dokument decyzyjny w `ideas/`, z instrukcją powrotu.

---

## 6. Zasady pracy w tym repo (obowiązują też Ciebie)

- **Node v22 obowiązkowo** (`nvm use v22.20.0`). Pod v20 serwer startuje, nie nasłuchuje
  i nie loguje błędu.
- Commituj **wyłącznie jawnymi ścieżkami**. **Nigdy `git add -A`** — w drzewie pracują
  inne sesje.
- `git status --short` przed uznaniem czegokolwiek za swoje.
- **Git tu mówi po polsku** — nie buduj logiki na dopasowaniu angielskiego wyjścia gita
  (`nothing to commit` nigdy nie wystąpi). Decyduj po kodzie wyjścia albo `--porcelain`.
- Po napisaniu asercji **zepsuj kod i sprawdź, że widzisz ✗**. Brama, która nie potrafi
  oblać, jest dekoracją — w tym repo zdarzyło się to wielokrotnie.
- Zanim uznasz pustkę za defekt: policz wiersze **bez** filtra i przeczytaj sygnaturę
  w źródle. W jednej sesji dziewięć „defektów" okazało się błędami sondy.
