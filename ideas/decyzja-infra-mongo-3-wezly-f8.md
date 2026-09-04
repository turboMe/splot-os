# Decyzja: trzywęzłowy replica set dla bramki F8

**Data:** 2026-08-18
**Status:** zbudowane i zweryfikowane na żywo; **nic nie włączone w produkcji**
**Zadanie źródłowe:** `ideas/infra-mongo-3-node-for-f8.md`
**Blokuje:** F8 (jedyny formalny bloker rolloutu wg ADR 0006), a przez to F9

---

## 1. Decyzja w jednym zdaniu

Trzywęzłowy replica set `rs3f8` stoi **OBOK** produkcji, na portach **27019/27020/27021**,
na sieci hosta, z własnymi wolumenami — produkcyjny single-node `rs0` na 27017
pozostaje **nietknięty**.

---

## 2. Co zostało zbudowane

| Plik | Rola |
|---|---|
| `scripts/f8-mongo-rs3.sh` | topologia: `up` / `down [--purge]` / `status` / `uri` |
| `scripts/f8-mongo-chaos.sh` | awarie: `stepdown` / `isolate` / `partition` / `kill` / `revive` / `freeze` / `fail-commit` / `fail-txn-write` / `heal` / `views` |
| `src/mastra/scripts/prove-f8-rs3-transaction.ts` | dowód: aplikacja łączy się i commituje transakcję wielodokumentową |

Wpisy w `package.json`: `infra:rs3:up` / `:down` / `:purge` / `:status` / `:uri` /
`:chaos` / `:views` / `:heal` / `:prove`.

```
npm run infra:rs3:up            # postaw 3 węzły
npm run infra:rs3:prove         # dowód transakcji
npm run infra:rs3:chaos -- partition primary
npm run infra:rs3:views         # widok KAŻDEGO węzła na KAŻDY węzeł
npm run infra:rs3:heal          # cofnij wszystkie awarie
npm run infra:rs3:down          # zdejmij (wolumeny zostają)
```

---

## 3. Trzy decyzje projektowe i ich uzasadnienie

### 3.1 Obok produkcji, nie zamiast

Wolumen produkcyjny `jarvis-dashboard-agent_mongo-data` jest `external: true` i
**współdzielony z innym projektem**. F8 z definicji potrzebuje topologii, którą wolno
rozrywać wielokrotnie. Te dwie rzeczy nie mogą być tym samym wolumenem.

Koszt tej decyzji jest realny i trzeba go nazwać: **`rs3f8` nie jest produkcją**.
Dowód z niego mówi „kod orkiestracji przetrwał tę awarię", a nie „produkcja przetrwa
tę awarię", bo produkcja to nadal jeden węzeł. To jest świadomy kompromis — patrz §7.

### 3.2 Trzy węzły z danymi (PSS), nie dwa plus arbiter

Arbiter głosuje, ale **nie przechowuje danych**, więc nigdy nie potwierdzi zapisu
`w: "majority"`. W układzie P-S-A utrata jedynego sekundariusza zostawia większość,
która nie potrafi przesunąć majority commit point: zapisy `w: majority` stają, a cache
WiredTigera zapełnia się historią, której nie da się scommitować. Cała orkiestracja V2
pisze z `w: majority`, więc arbiter wstrzyknąłby tryby awarii należące do arbitra,
a nie do kodu, który F8 ma ocenić.

**Zmierzone:** przy jednym węźle wyłączonym (`kill c`) zapis `w: majority` nadal
commituje — 2 z 3 to większość *z danymi*. To jest dokładnie ta własność, którą
arbiter by zepsuł.

### 3.3 Sieć hosta, nie sieć dockerowa

Członek RS jest osiągalny pod adresem zapisanym w `rs.conf()`, a nie pod portem,
na który zadzwonił klient (pułapka 3.2 z dokumentu źródłowego). Na sieci bridge
członkowie musieliby ogłaszać się jako `f8-rs3-a:27019` — nazwy rozwiązywalne
wewnątrz Dockera, ale **nie z hosta**, co zerwałoby każdy connection string w repo
i wymusiło edycję `/etc/hosts` (zmiana konfiguracji systemowej — świadomie odrzucona).

Na sieci hosta `localhost:27019` znaczy to samo dla peer-mongoda i dla klienta Node
na hoście. Connection string działa bez żadnej zmiany systemowej:

```
mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8
```

**Cena tej decyzji:** brak izolacji przestrzeni nazw sieci oznacza, że nie da się
zrobić prawdziwej partycji pakietowej bez `iptables` na hoście (czyli bez zmiany
firewalla hosta — odrzucone). Stąd dwa różne tryby partycji w §5, z których żaden
nie jest partycją pakietową, i oba są opisane tym, czym naprawdę są.

### 3.4 Nazwa `rs3f8`, nie `rs0`

Produkcja i spike na 27018 to oba `rs0`. Sterownik, który dostanie `?replicaSet=rs0`,
odrzuci zestaw odpowiadający inną nazwą — więc **skopiowany po staremu URI wywali się
natychmiast i głośno**, zamiast po cichu trafić w okolice produkcji. Różnica nazw
to bariera, nie ozdoba.

---

## 4. Dlaczego włączony jest `enableTestCommands=1`

**Zmierzone:** bez tego mongod odpowiada `CommandNotFound: no such command
'configureFailPoint'`. Dwie z sześciu awarii wymaganych przez F8 —
`TransientTransactionError` i `UnknownTransactionCommitResult` — nie mają wtedy
deterministycznego wyzwalacza. Można *liczyć* na złapanie ich przez ubicie primary
w trakcie commitu; F8 potrzebuje dowodu, nie wygranego wyścigu.

Flaga jest bezpieczna **tutaj** i nie byłaby w produkcji: to trzy jednorazowe węzły
na własnych portach i wolumenach. **W produkcyjnym compose tej flagi celowo nie ma
i nie wolno jej tam dodać.**

---

## 5. Dwa tryby partycji — NIE są wymienne

To jest najważniejsza rzecz operacyjna w tym dokumencie. Oba zmierzone na żywo.

### `isolate <node>` — partycja JEDNOSTRONNA (failpoint na heartbeatach przychodzących)

- większość oznacza węzeł jako `health=0` w ~3 s,
- **failover NIE następuje** — wychodzące heartbeaty izolowanego węzła nadal docierają
  i resetują liczniki wyborcze pozostałych,
- izolowany primary **dalej uważa się za primary** (`isWritablePrimary=true`)
  w nieskończoność, podczas gdy reszta zestawu raportuje go jako nieosiągalnego,
- węzeł **nadal obsługuje klientów**.

To jest przypadek „zatrzaśniętego lease'u" i rozjazdu widoków — najlepszy do pytania
*czy worker zauważa, że stracił zaufanie klastra?*

### `partition <node> [secs]` — izolacja SYMETRYCZNA (`docker pause`)

- proces zamrożony: nic nie wysyła i nic nie odbiera,
- większość wybiera nowego primary w ~15 s, **term się inkrementuje**,
- po `heal` stary primary wraca jako `SECONDARY` i rozpoznaje nowego.

To jest przypadek failoveru i powrotu starego primary po wygaśnięciu fence.

**Czego ŻADEN z nich nie jest:** partycją pakietową à la Jepsen. `isolate` blokuje
tylko heartbeaty przychodzące (warstwa aplikacji), `partition` zamraża cały proces.
Prawdziwa partycja dwukierunkowa wymagałaby osobnej przestrzeni nazw sieci —
patrz §7.

---

## 6. Pułapka, która kosztowałaby F8 fałszywy zielony wynik

**Sterownik MongoDB sam ponawia `commitTransaction` raz, po cichu.**

Zmierzone: `fail-commit` z `times:1` dało **transakcję zaliczoną bez żadnego błędu**.
Failpoint był uzbrojony i strzelał przez cały czas (`timesEntered` to udowodnił) —
tylko że jednorazową awarię pochłonęło wbudowane ponowienie sterownika i nigdy nie
dotarła do aplikacji.

Wniosek, wpisany w domyślne zachowanie skryptu (`alwaysOn`):

- `times:1` odpowiada na pytanie „czy ponowienie sterownika zamiata jeden zgubiony
  commit pod dywan?" → tak,
- `alwaysOn` odpowiada „co widzi aplikacja, gdy awaria przeżyje ponowienie?"
  → `UnknownTransactionCommitResult`.

**Tylko drugie jest dowodem dla F8.** Test z `times:1` wygląda jak przechodzący test
partycji i nie dowodzi absolutnie niczego.

Potwierdzone etykiety (`alwaysOn`, sterownik Node):

| komenda | etykieta u klienta |
|---|---|
| `fail-commit` | `UnknownTransactionCommitResult` |
| `fail-txn-write` | `TransientTransactionError` (code 112) |
| po `heal` | commit czysty |

---

## 7. Czego to NIE załatwia

1. **Produkcja nadal jest jednowęzłowa.** Bramka F8 przechodzi na `rs3f8`; produkcja
   ma dalej jeden węzeł na 27017 i pojedynczy punkt utraty danych. Dowód z F8 mówi
   „kod jest odporny", nie „produkcja jest odporna". To osobna decyzja właściciela (§9).
2. **Brak prawdziwej partycji pakietowej.** Patrz §5. Gdyby okazała się potrzebna,
   droga bez ruszania firewalla hosta jest znana: trzy mongody w **współdzielonej,
   nie-hostowej przestrzeni nazw sieci** (kontener-uchwyt + `--network container:`),
   z `--cap-add NET_ADMIN` i `iptables -i lo` w środku. Daje partycję asymetryczną
   peer↔peer przy zachowaniu dostępu klientów. Nie zbudowane — nie było potrzebne
   dla scenariuszy F8, a złożoność, która się psuje, jest gorsza od prostego
   mechanizmu, który działa.
3. **Nie napisano testów F8.** Zakres zadania to topologia i narzędzia; testy to F8.
4. **Nie dotknięto kodu agentów ani orkiestracji.** Jedyny nowy plik w `src/` to
   skrypt dowodowy, który niczego istniejącego nie zmienia.
5. **Flagi `FEATURE_ORCHESTRATION_V2_*` nietknięte.**
6. **`check:all` nietknięty** — dalej używa spike'a na 27018. `rs3f8` jest opt-in.

---

## 8. Powrót do stanu sprzed zmian

Zmiany są **addytywne**. Nic istniejącego nie zostało zmodyfikowane poza dodaniem
wpisów do `package.json`.

**Zdjęcie topologii (produkcja nietknięta w każdym wariancie):**

```bash
npm run infra:rs3:down      # usuwa kontenery, ZOSTAWIA wolumeny
npm run infra:rs3:purge     # usuwa kontenery I swoje trzy wolumeny
```

**Pełne wycofanie:**

```bash
npm run infra:rs3:purge
git revert <commit>         # albo: usuń 2 skrypty, 1 plik proof, 10 wpisów w package.json
```

Nie ma nic do cofnięcia w `docker-compose.yml` (nietknięty), w `.env` (nietknięty),
w `rs.conf()` produkcji (nietknięty — nadal `version: 1`).

**Zweryfikowane po całej sesji:** produkcja `rs0`, 1 członek, `PRIMARY`, `conf
version=1`, 123 kolekcje w `agentforge`, wolumen `jarvis-dashboard-agent_mongo-data`
z tą samą datą utworzenia `2026-04-26T13:26:14Z`.

---

## 9. Co idzie źle i co wtedy zrobić

| Objaw | Przyczyna | Reakcja |
|---|---|---|
| `up` kończy się „did not reach 3 healthy members" | port zajęty albo wolumen z konfiguracją starego RS | `npm run infra:rs3:purge && npm run infra:rs3:up` |
| Zestaw został w rozwalonym stanie po testach | niedomknięta awaria | `npm run infra:rs3:heal` — cofa pauzy, restartuje ubite węzły, czyści failpointy |
| `status` pokazuje wszystko zdrowe w trakcie partycji | **pytasz nie ten węzeł** | `npm run infra:rs3:views` — pokazuje widok każdego węzła; podczas partycji nie ma jednej prawdy |
| Transakcja commituje mimo uzbrojonego failpointu | ponowienie sterownika (§6) | użyj `alwaysOn`, nie `times:1` |
| „Too many open files" / WiredTiger panic | limit uchwytów | węzły startują z `nofile=64000`; jeśli mimo to — sprawdź, czy nie celujesz w produkcyjny mongod na 27017 |
| Skrypt odmawia: „REFUSING: … not created by this script" | bariera zadziałała | **nie obchodź jej** — sprawdź, w co celujesz |

---

## 10. Otwarte decyzje właściciela

1. **Czy produkcja ma przejść na ≥3 węzły?** F8 dowodzi odporności *kodu*. Produkcja
   z jednym węzłem nadal ma pojedynczy punkt utraty danych — czyli dokładnie to ryzyko,
   dla którego F8 istnieje. Jeśli tak, blokerem jest współdzielony wolumen z drugim
   projektem i to trzeba rozstrzygnąć najpierw.
2. **Czy `rs3f8` ma wejść do `check:all`?** Dziś nie wchodzi. Bramka używa spike'a
   na 27018 (jeden węzeł). Sekcje trwałości, które potrzebują failoveru, wymagałyby
   przepięcia na `rs3f8` — kosztem czasu trwania bramy.
3. **Czy potrzebna jest prawdziwa partycja pakietowa** (§7.2), czy dwa istniejące
   tryby wystarczą do zamknięcia F8.
---

## Decyzje właściciela — rozstrzygnięte 2026-08-18

Trzy pytania zostawione przez agenta infrastrukturalnego, rozstrzygnięte na
podstawie pomiarów z tego dokumentu.

### 1. Produkcja NIE przechodzi teraz na ≥3 węzły

Kolejność jest odwrotna do intuicyjnej i to jest cały argument: **F8 ma dowieść,
że kod przeżywa failover.** Dodanie failoveru do kodu, o którym jeszcze nie
wiadomo, czy go przeżyje, wprowadza nową klasę awarii przed sprawdzeniem, czy
system sobie z nią radzi. Do tego migracja dotyka wolumenu współdzielonego z
`jarvis-dashboard-agent` — operacja nieodwracalna na cudzych danych.

**Sekwencja: F8 na `rs3f8` → dopiero potem decyzja o produkcji.**

⚠️ **Ryzyko pozostaje otwarte:** produkcja ma jeden węzeł i pojedynczy punkt
utraty danych. To jest świadomie noszone ryzyko, nie rzecz zamknięta.

### 2. `rs3f8` NIE wchodzi do `check:all`

`check:all` podnosi własny jednowęzłowy spike na 27018 i musi zostać na tyle
tani, żeby uruchamiać go często. Trzy kontenery plus czas elekcji przy KAŻDYM
przebiegu płaciłyby za sekcje, które tego nie potrzebują.

**Osobny zestaw `f8:*`, uruchamiany świadomie.** Zgodne z istniejącym wzorcem:
brama jest tania, rzeczy ciężkie stoją obok niej.

### 3. Partycja pakietowa — NIE, dopóki nie zabraknie istniejących trybów

Wymaga `iptables` na hoście, czyli zmiany zapory maszyny. Zmierzone zachowania
pokrywają scenariusze z definicji F8:

| tryb | co daje |
|---|---|
| `isolate` | primary, który NIE WIE, że stracił kworum — to jest split-brain |
| `partition` (pause) | realny failover ~15 s; stary primary wraca jako SECONDARY |
| `fail-commit alwaysOn` | `UnknownTransactionCommitResult` |
| `fail-txn-write alwaysOn` | `TransientTransactionError` (112) |

Wracamy do tego **tylko jeśli konkretny scenariusz F8 okaże się nieosiągalny**.
Budowanie zapasu to zmiana zapory bez dowodu, że jest potrzebna.
