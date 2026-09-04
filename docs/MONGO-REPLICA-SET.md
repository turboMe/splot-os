# Mongo jako replica set (rs0)

**Wprowadzone:** 2026-07-29 (etap **F1** planu
[`plan-dziecko-po-odlozeniu-g0.md`](../ideas/plan-dziecko-po-odlozeniu-g0.md))

## Dlaczego

Transakcje wielodokumentowe **nie działają na standalone MongoDB**. Cały substrat
orkiestracji V2 na nich stoi (granice A/B/C, CAS, outbox), więc dopóki produkcyjny Mongo
był standalone, **żaden element V2 nie mógł ruszyć na produkcji** — niezależnie od tego,
ile kodu było gotowe.

Jeden węzeł wystarcza do transakcji. Pełna odporność na partition/stepdown wymaga **≥3
węzłów** i jest osobną bramką (**G8**, etap F8 planu) — single-node RS jej **nie** spełnia.

## Konfiguracja

`docker-compose.yml`:

```yaml
mongo:
  image: mongo:7
  command: ["--replSet", "rs0", "--bind_ip_all"]
  healthcheck:
    test: ["CMD", "mongosh", "--quiet", "--eval", "db.hello().isWritablePrimary"]
```

- **`--bind_ip_all`** jest konieczne: członek RS ogłasza się jako `localhost:27017`,
  a klienci łączą się z hosta przez mapowany port.
- **Healthcheck sprawdza `isWritablePrimary`, nie `ping`.** `ping` odpowiada także na węźle
  z niezainicjowanym RS, więc kontener raportowałby `healthy` przy niedziałających
  transakcjach — czyli dokładnie w stanie, który ma wykryć.

URI (w `.env`) musi zawierać `?replicaSet=rs0`.

## Świeża instalacja — inicjalizacja RS

Sam `--replSet` **nie wystarcza**: replica set trzeba raz zainicjować. Bez tego Mongo
odpowiada `NotYetInitialized` i healthcheck nigdy nie przejdzie.

```bash
docker compose up -d mongo
docker exec mastra-mongo mongosh --quiet --eval \
  'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] })'
```

Weryfikacja:

```bash
docker exec mastra-mongo mongosh --quiet --eval \
  'const s=rs.status(); print(s.set + " " + s.members[0].stateStr)'
```

Oczekiwane: `rs0 PRIMARY`.

## Migracja istniejącej instancji (co zrobiono)

Przejście standalone → single-node RS **zachowuje dane** — nie ma migracji plików, węzeł
czyta ten sam katalog. Wykonana procedura:

1. `mongodump --archive --gzip` na żywo (backup logiczny),
2. `docker stop`, `tar czf` wolumenu (backup fizyczny 1:1),
3. dodanie `command: ["--replSet","rs0","--bind_ip_all"]`, `docker compose up -d mongo`,
4. `rs.initiate(...)` → PRIMARY po 1 s,
5. weryfikacja: rozmiary baz bez zmian (`agentforge` 391.8 MB), 121 kolekcji widocznych
   przez sterownik aplikacji, transakcja przez `withTransaction` zakończona commitem,
6. `MONGODB_URI` → `?replicaSet=rs0`, `check:all` zielony.

## Rollback

Usunąć `command:` z `docker-compose.yml` i `?replicaSet=rs0` z `MONGODB_URI`, po czym
`docker compose up -d mongo`. Węzeł, który był single-node RS, startuje jako standalone
i **dane pozostają czytelne** (kolekcja `local.oplog.rs` staje się nieużywana).

## ⚠️ Pułapka: wolumen jest `external`

`docker-compose.yml` świadomie deklaruje:

```yaml
volumes:
  mongo-data:
    external: true
    name: jarvis-dashboard-agent_mongo-data
```

Dane żyją w wolumenie **`jarvis-dashboard-agent_mongo-data`** (reuse z poprzedniego
projektu), a **nie** w `mastra-agentic-environment_mongo-data` — mimo że taki wolumen też
istnieje i zawiera ~302 MB starych, osieroconych danych.

**Przy backupie zawsze sprawdź, co jest faktycznie zamontowane:**

```bash
docker inspect mastra-mongo --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Backup „po nazwie projektu" da archiwum pustego wolumenu (~865 KB zamiast ~488 MB).
