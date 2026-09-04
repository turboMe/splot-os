# Prompt startowy — domknięcie luk po J2 (A/B/C/D)

> Skopiuj wszystko poniżej linii jako pierwszą wiadomość do nowej instancji.
> Katalog roboczy: `/projekty/mastra-agentic-environment/agentic-agents`.

---

Domykasz cztery luki znalezione w audycie **po** wykonaniu epiku J2. Nie
naprawiasz J2 — J2 jest zrobione i potwierdzone niezależnie (kroki 1–6, wszystkie
bramki zielone, `npm run check:all` = 93 zielone / 0 czerwonych / exit 0).
Zajmujesz się ścieżkami **obok** J2, które równoległość dopiero uwidoczniła.

## Zanim napiszesz linijkę kodu

Przeczytaj `ideas/j2-domkniecie-2026-08-23.md` w całości. Tam są cztery luki
(A/B/C/D), dowody z kodu, jeden twardy pomiar i **bloki DECYZJA** — te są wiążące,
masz je wykonać, nie wybierać od nowa.

Kontekst historyczny, gdyby był potrzebny: `ideas/j2-parallel-dispatch-2026-08-23.md`
(plan epiku) oraz `git show fcc9ebc` / `git show 09297e1` (ton commitów i
komentarzy w tym repo).

## Kolejność — nienegocjowalna

**A → B → C → D.**

- **A** pierwsze, bo odpala się przy **każdym** zapisie `.ts` i już dziś, przy
  jednym agencie, wysyła modelowi nieprawdziwe zdanie „Project does not compile".
  Zmierzone: `npx tsc --noEmit` trwa **16,45 s** na bezczynnej maszynie, a limit
  w kodzie to **15 s** — więc przekracza go zawsze, zanim ktokolwiek dołoży
  obciążenia.
- **B** drugie, bo to ono kosztuje realne pieniądze: brak atrybucji `commandsRun`
  powoduje eskalacje na przypięty `deepseek-v4-pro` dla subtasków, które nic
  złego nie zrobiły.
- **C** trzecie — cofa krok 2b, ale tylko gdy model sięgnie po
  `coding_update_artifact` z listą.
- **D** to higiena `.env` plus jedna realna niespójność (`FILM_SKILL_ROOT` vs
  `FILM_SKILLS_ROOT`).

## Jak pracujesz

1. **Jeden krok = jeden commit.** Mały i kompletny bije duży i niedokończony.
2. **Najpierw asercja, która OBLEWA na obecnym kodzie. Potem poprawka.** Każda
   luka w dokumencie ma gotowe „Sprawdzenie (falsyfikowalne)" — użyj go. Bramka,
   która nigdy nie była czerwona, niczego nie dowodzi; udowodnij, że jest.
3. **Porównania ze źródłem prawdy zamiast atrap.** Tam, gdzie twierdzenie brzmi
   „to naprawdę działa", wołaj realną usługę. Ten projekt ma trzy udokumentowane
   wpadki, gdzie testy były zielone, bo pisane z **wyobrażenia** o kształcie
   odpowiedzi.
4. **„Zbudowane i zielone" ≠ „wpięte".** Sprawdź, czy cokolwiek dociera do kodu,
   który testujesz.
5. **Nie pozwól narzędziu twierdzić czegoś, czego nie sprawdziło.** To jest sedno
   luki A i najłatwiej je odtworzyć w innym miejscu.
6. Skrypty bramek i komentarze w kodzie **po angielsku**, dokumenty w `ideas/`
   **po polsku** — tak jest w całym repo.

## Pułapka, w którą łatwo wpaść przy B i C

Atrybucja **nie może pochodzić z argumentu podanego przez model**. Krok 2a
rozwiązał to dla plików (`subtaskId` bierze się z kontekstu runu harnessu,
argument modelu jest tylko zapasowy). Przy `commandsRun` masz zrobić to **tak
samo**. Jeśli oprzesz się na tym, co poda model, odtworzysz problem, który 2a
właśnie zlikwidował — i zrobisz to cicho, bo testy z atrapami tego nie złapią.

## Weryfikacja

- `npm run check:all` — **musi zostać 0 czerwonych.** Punkt odniesienia sprzed
  Twojej pracy: 93 zielone, exit 0. Jeśli liczba zielonych spadnie, coś
  zepsułeś albo bramka przestała się uruchamiać.
- `bash scripts/with-node.sh npx tsc --noEmit` — czysty.
- Bramki J2, których dotykasz pośrednio:
  `check:subtask-file-attribution`, `check:subtask-quality-loop`,
  `check:dispatch-concurrency-cap`, `f8:subtask-artifact-fencing`.
- Zestaw `rs3f8` (porty 27019–27021) **zostaw podniesiony**; `npm run infra:rs3:up`
  jeśli nie stoi, `npm run infra:rs3:prove` jako sprawdzenie.

## Czego NIE wolno bez osobnej zgody właściciela

Żadna z luk A–D tego nie potrzebuje:

- restart żywego serwera (Mastra została zresetowana 23.08 wieczorem i działa),
- dotykanie historii gita żywego repo (merge do live, auto-promote, self-swap),
- zmiana flag `AUTOHEAL_AUTO_PROMOTE` / `DEPLOY_AUTO_SWAP`,
- `down --purge` na `rs3f8`.

Przy luce D: **`.env` to żywa konfiguracja z sekretami.** Dopisz wyłącznie
`J2_DISPATCH_CONCURRENCY=3` (nie zmienia zachowania — czyni limit widocznym).
Kluczy `ARK_*` / `RUNWAY_*` **nie dodawaj** — to świadomy wybór właściciela, opisany
w dokumencie. Niczego w `.env` nie kasuj i nie przestawiaj.

## Higiena gita

`git status --short` przed **każdym** `git add`. Drzewo bywa dzielone z innymi
instancjami. `src/mastra/_skills/coding/test-generator.md` jest zmodyfikowany
przez kogoś innego — **nie commituj go**. Nigdy `git add -A`.

## Na koniec każdej luki

Zaktualizuj `ideas/j2-domkniecie-2026-08-23.md` (sekcja danej luki) oraz wiersz
J2 w `ideas/audyt-domena-coding-2026-08-22.md`. Uczciwy status jest lepszy niż
cisza — także „A i B zrobione, C okazało się większe niż zakładano".

## Zacznij od

Luki **A**: zapis pliku pod dzierżawą subtaska ma **nie uruchamiać** tsc w ogóle;
poza dispatchem limit ma być wyższy niż zmierzone 16,45 s (minimum 60 s), a
komunikat po timeoucie ma mówić „weryfikacja nie zdążyła", nigdy „projekt się nie
kompiluje".

Nie rób kilku luk naraz. Cztery luki to nie jest jedna sesja i nikt tego nie oczekuje.
