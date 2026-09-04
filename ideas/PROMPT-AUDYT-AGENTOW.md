# Prompt startowy — audyt agentów domenowych

> Skopiuj wszystko poniżej linii do nowej instancji.

---

Przeczytaj `ideas/audyt-agentow-domenowych.md` W CAŁOŚCI, zanim cokolwiek zrobisz.
Potem `ideas/chef-kompletnosc-pipeline-v2.md` — tam jest diagnoza źródłowa, z której
ten audyt wyrósł.

## Co się stało i po co to robimy

Chef pod V2 oddawał niedokończoną pracę: 25 dań, zero przepisów, 8 z 8 workerów
padło, projekt stanął w połowie. Ta sama praca w kontakcie bezpośrednim wychodziła
kompletna. Po naprawie ten sam pipeline dowiózł 26 dań / 26 przepisów / Księgę 47 KB
/ PDF w 23 minuty, z działającą kontrolą jakości w środku (krytyk zgłosił `fix`,
chef poprawił menu i dopiero wtedy poszedł dalej).

**Żadna z pięciu przyczyn nie była specyficzna dla chefa.** Trzy z pięciu presetów
workerów wskazywały modele, których dostawcy już nie serwują — to dotyczyło każdego
agenta. Brama kompletności nie istniała w kodzie. Telemetria zapisywała 145 kolejnych
błędów jako sukcesy. Twoje zadanie: przejść pozostałych agentów i sprawdzić, czy nie
mają tego samego.

## Dwie zasady, których pilnujesz

1. **Agent z krokami wewnętrznymi wykonuje je SAM.** Jeśli agent ma własny pipeline,
   lane nie ma prawa wyjąć z niego kroku i uruchomić osobno — uruchomi go z innymi
   założeniami niż pipeline agenta. Dokładnie to zabiło recon chefa: lane rozbijał
   zadanie na `researcher → chef` i wycinał URL, więc faza recon nie startowała w
   20 z 20 zadań.
2. **Jakość wyniku sprawdzana według wymagań pipeline'u, w KODZIE.** Zdanie w
   prompcie („sprawdź kompletność") to nie brama — model może je pominąć i pomijał.
   Brama to kod, który ODMAWIA zamknięcia niekompletnego produktu.

## Jak pracujesz

**Kolejność jest nieprzypadkowa: najpierw wszystko, co darmowe.** Całą diagnozę
chefa — pięć przyczyn — postawiono bez ani jednego przebiegu pipeline'u, z samego
kodu, bazy i odpytania API dostawców. Przebieg służył wyłącznie potwierdzeniu.
Przebieg to ~25 minut i realne pieniądze.

Dla każdego agenta:
1. **K1–K4 z dokumentu (darmowe)** — modele, granica lane'a, brama kompletności,
   uczciwość telemetrii. Wyczerp je.
2. Dopiero jeśli coś zostaje otwarte — **jeden przebieg pinowany** (`capability` w
   komendzie `/v2/conversations/:cid/commands`), żeby odizolować pipeline od routingu.
3. Na koniec domeny — **jeden przebieg przez lane** (bez `capability`). Dopiero to
   jest droga użytkownika.
4. **Odhacz w tabeli w `ideas/audyt-agentow-domenowych.md`** i dopisz, co znalazłeś.
   Dokument jest żywy — to jest jego jedyny sens.

Zaczynaj od agentów pipeline'owych (`contentAgent`, `writerAgent`, `huntAgent`,
`filmmakerAgent`, `musicianAgent`, `automationArchitect`) — tam mieszka ta klasa
błędów. `automationArchitect` ma znany brak: jest pipeline'owy, a nie deklaruje
`runsInternally`.

## Pułapki, na których przejechały poprzednie instancje

- **Node v22 obowiązkowo** (`bash scripts/with-node.sh …`). Pod v20 serwer startuje,
  nie nasłuchuje i nie loguje błędu.
- **Edycja pliku restartuje `mastra dev` i zabija job w locie.** Zmiany planuj między
  przebiegami. Przed edycją sprawdź, czy nic nie leci.
- **`agent_events` filtrowane po `agentId` KŁAMIE.** Filtr pokazał 6 wywołań narzędzi
  dla przebiegu, który miał 182. Sub-runy i workery logują się pod innymi id.
- **Pole czasu to `timestamp` (Date), nie `createdAt`.** Porównanie ze stringiem
  cicho nie zwraca nic.
- **Wersje.** Porównuj produkt do NAJNOWSZEJ wersji, nie do pierwszej. `findOne`
  zwraca dowolną — u chefa wyglądało to na brak pokrycia, bo krytyk przemianował
  danie w v2.
- **Nie ufaj zielonej bramie jako dowodowi zachowania.** Brama, która asertuje
  obecność stringa, przechodzi przy działającym defekcie. Zanim uznasz bramę za
  dowód — **zepsuj naprawę i sprawdź, że brama pada.** Jeśli nie pada, nie mierzy
  tego, co myślisz. Tak wyszło, że pierwsza wersja bezpiecznika pętli była
  nieosiągalna, a `probe:worker-presets` w pierwszym uruchomieniu napisał „✓" nie
  sprawdziwszy niczego (brakowało `dotenv`).
- **Baza jest współdzielona** — testuj na świeżym obiekcie, inaczej podbierzesz cudzy
  gotowy wynik i uznasz to za sukces. Sprawdź nazwę w bazie ZANIM odpalisz.
- **„Zbudowane i zielone" ≠ „wpięte".** Testy dowodzą, że kod robi to, co robi — nie
  że cokolwiek do niego dociera. Sprawdź, którą ścieżką naprawdę idzie produkcja
  (są dwie implementacje `prepareStep`: `generate-with-harness.ts` obsługuje V2,
  `generate-pipeline-with-reflection.ts` to droga starsza).

## Czego oczekujemy

Dla każdego sprawdzonego agenta: odhaczona tabela, a dla każdego defektu — dowód
(plik i linia albo pomiar z żywego joba), nie przypuszczenie. Jeśli czegoś nie da
się rozstrzygnąć bez kolejnego przebiegu, **powiedz to wprost, zamiast zgadywać.**

Node: `nvm use v22.20.0`.
