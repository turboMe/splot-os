# Prompt startowy — dokończenie epiku J2

> Skopiuj wszystko poniżej linii jako pierwszą wiadomość do nowej instancji.
> Katalog roboczy: `/projekty/mastra-agentic-environment/agentic-agents`.

---

Kontynuujesz epik **J2 — realny równoległy dispatch subtasków**. Nie zaczynasz
od zera: krok 1 z 6 jest zrobiony, a **wszystkie decyzje projektowe kroków 2–6
są już podjęte i zatwierdzone przez właściciela.** Twoim zadaniem jest je
wykonać, nie wybierać od nowa.

## Zanim napiszesz linijkę kodu

Przeczytaj w całości `ideas/j2-parallel-dispatch-2026-08-23.md`. To jest źródło
prawdy dla tego epiku: mapa 5 defektów (D1–D5), pomiary, sześć kroków, i bloki
oznaczone **DECYZJA** — te są wiążące.

Potem przeczytaj `git show fcc9ebc` i `git show 09297e1`. Pierwszy to krok 1,
drugi to uzasadnienia decyzji. Ton commitów i komentarzy w tym repo bierz stamtąd.

## Jedno zdanie, które musisz zrozumieć, zanim ruszysz

**Równoległość NIE czeka na włączenie — ona już od dawna jedzie na produkcji i
jest niepoprawna.** `parallel-dispatch.ts:169` puszcza grupę przez
`Promise.allSettled`, a `repo-maintenance.ts:180` (PATH A) woła to w pętli
self-healingu. Nie „dodajesz równoległości". Naprawiasz działającą.

Drugie: **żadnego z pięciu defektów nie naprawia replica set.** Topologia
`rs3f8` jest gotowa i zweryfikowana, ale jest potrzebna dopiero w kroku 6.
Jeśli złapiesz się na myśleniu „to się rozwiąże, jak podepniemy 3 węzły" —
wróć do sekcji 1 planu.

## Kolejność — nienegocjowalna

**2a → 2b → 3 → 4 → 5 → 6.**

2 musi być przed 3 i 4, bo bez poprawnej atrybucji **nie da się zmierzyć**, czy
limit fal i rozłączność plików cokolwiek dały — wynik subtaska byłby i tak
zlepkiem całego zadania.

2a musi być przed 2b. Powód w planie; jeśli go nie rozumiesz, nie zaczynaj 2b.

## Jak pracujesz

1. **Jeden krok = jeden commit.** Mały i kompletny bije duży i niedokończony.
2. **Najpierw asercja, która OBLEWA na obecnym kodzie. Potem poprawka.** Bramka,
   która nigdy nie była czerwona, niczego nie dowodzi. Udowodnij, że jest
   czerwona — tak jak `check:subtask-file-attribution` otwiera się dowodem, że
   stara implementacja nadal gubi zapisy.
3. **Porównania ze źródłem prawdy zamiast atrap.** Tam gdzie twierdzenie brzmi
   „to naprawdę działa", wołaj realną usługę/podproces, nie fixture. Ten projekt
   ma trzy udokumentowane wpadki, gdzie testy były zielone, bo pisane z
   **wyobrażenia** o kształcie odpowiedzi.
4. **„Zbudowane i zielone" ≠ „wpięte".** Zawsze sprawdź, czy cokolwiek dociera do
   kodu, który testujesz. To wzorzec, który w tym repo wracał trzy razy.
5. Skrypty bramek i komentarze w kodzie **po angielsku**; dokumenty w `ideas/`
   **po polsku**. Tak jest w całym repo.

## Weryfikacja — uwaga, `check:all` jest dziś zepsuty

`npm run check:all` wywala się na linii 86 (`check:embedding-consistency`,
`no such table: code_chunks`) i pod `set -euo pipefail` **zatrzymuje się tam**,
więc ~100 bramek za nią, łącznie z twoją, w ogóle się nie uruchamia.

**To osobny defekt, ma własne zadanie. NIE naprawiaj go przy okazji J2.**

Do czasu naprawy weryfikuj tak (98 ze 100 przechodzi):

```bash
sed -n '87,200p' scripts/check-all.sh | grep '^npm run' | sed 's/^npm run //' \
  | while read -r c; do npm run "$c" >/dev/null 2>&1 || echo "FAIL: $c"; done
```

Znane czerwone, **niezwiązane z J2**: `check:groq-model-ids` (własne zadanie).
`check:final-decision` oblewa uruchomiony pojedynczo, przechodzi normalnie —
potrzebuje repliki, którą `check-all.sh` sam sobie stawia.

Zawsze też `bash scripts/with-node.sh npx tsc --noEmit`.

## Infrastruktura

Zestaw `rs3f8` (porty 27019–27021) **zostaw podniesiony**. `down --purge`
skasowałby wolumeny z historią 37 elekcji. Produkcji nie dotyka — jedzie dalej
na jednowęzłowym `rs0` na 27017. Jeśli zestaw nie stoi: `npm run infra:rs3:up`,
sprawdzenie `npm run infra:rs3:prove`.

## Czego NIE wolno bez osobnej zgody właściciela

Zgoda na J2 **tego nie obejmuje** i żaden krok 2–6 tego nie potrzebuje:

- restart żywego serwera,
- dotykanie historii gita żywego repo (merge do live, auto-promote, self-swap),
- zmiana flag `AUTOHEAL_AUTO_PROMOTE` / `DEPLOY_AUTO_SWAP`,
- `down --purge` na `rs3f8`.

Jeśli któryś krok zacznie tego wymagać — **zatrzymaj się i zapytaj.**

## Higiena gita

`git status --short` przed **każdym** `git add`. Drzewo bywa dzielone z innymi
instancjami. `src/mastra/_skills/coding/test-generator.md` jest zmodyfikowany
przez kogoś innego — **nie commituj go**. Nigdy `git add -A`.

## Na koniec każdego kroku

Zaktualizuj wiersz J2 w `ideas/audyt-domena-coding-2026-08-22.md` oraz sekcję
„Stan" w planie. Uczciwy status jest lepszy niż cisza — także „zrobione 3 z 6,
krok 4 okazał się większy niż zakładano".

## Zacznij od

Kroku **2a**: `subtaskId` przestaje pochodzić z argumentu, który podaje model, a
zaczyna z kontekstu runu harnessu. Bramka: wywołaj narzędzie **bez** argumentu
`subtaskId` wewnątrz runu, który go ma, i udowodnij, że wpis i tak niesie
atrybucję — a przed poprawką nie niesie.

Nie spiesz się i nie rób kilku kroków naraz. Sześć kroków to nie jest jedna
sesja i nikt tego nie oczekuje.
