# HANDOFF — trzy poprawki po audycie `graphify-strengthening`

**To jest jedyny plik, od którego zaczynasz.**

Stan wyjściowy: **implementacja G1/G2/G3 jest zrobiona i zweryfikowana jako działająca —
`typecheck`, `check:prompt-tool-names`, `check:coding-domain`, `check:graphify-affected-parse`,
`check:graphify-strengthening` wszystkie zielone, sprawdzone niezależnie, nie tylko na podstawie
transkryptu wykonawcy.** Nic z tego nie trzeba przerabiać. Poniżej trzy drobne, punktowe
poprawki znalezione przy niezależnej weryfikacji — każda to kilka linii.

Kontekst pełny: `ideas/plan-graphify-strengthening-2026-08-26.md` (już zrealizowany).

---

## Poprawka 1 — wpiąć nową bramkę w `check:all` (średni priorytet)

`package.json` ma wpis `"check:graphify-strengthening": "bash scripts/with-node.sh npx tsx src/mastra/scripts/verify-graphify-strengthening.ts"`,
ale `scripts/check-all.sh` **nigdy go nie wywołuje**. Skutek: ta bramka nigdy nie odpali się
automatycznie, tylko ręcznie.

**Do zrobienia:** dodać `npm run check:graphify-strengthening` do `scripts/check-all.sh`, w
sąsiedztwie istniejącej linii `npm run check:graphify-affected-parse` (najlepiej zaraz po niej —
tematycznie spokrewnione, ta sama sekcja).

**Weryfikacja:** `grep -n "check:graphify-strengthening" scripts/check-all.sh` musi coś zwrócić.
Dodatkowo: skoro `check-coding-domain.ts` ma własny test „package scripts run the gate directly
and from check:all" dla siebie — rozważ, czy analogiczna asercja nie powinna też pilnować TEJ
bramki, żeby przyszłe nowe skrypty tego typu nie gubiły wpięcia po cichu. To nie jest wymagane,
tylko warte rozważenia skoro wzorzec już istnieje w tym samym pliku.

---

## Poprawka 2 — nazwa asercji w `check-coding-domain.ts` obiecuje więcej niż sprawdza (niski priorytet)

Test nazywa się:
```ts
check('all coding-domain agents and file-editor role register graphify_affected', () => {
  for (const agentId of CODING_DOMAIN_AGENTS) { ... }
});
```
Pętla iteruje wyłącznie po `CODING_DOMAIN_AGENTS` (4 agenty) — **nigdzie nie odwołuje się do
`SUBAGENT_ROLES['file-editor']`**. Fakt o file-editorze jest faktycznie zweryfikowany gdzie
indziej (`verify-graphify-strengthening.ts` G2.5), więc nic nie jest naprawdę niesprawdzone —
ale ta konkretna bramka kłamie własną nazwą o tym, co robi. To dokładnie klasa błędu, którą to
repo już miało (nagłówek/nazwa mówi jedno, treść robi drugie).

**Do zrobienia — wybierz jedno:**
- (a) Zmienić nazwę testu na `'all coding-domain agents register graphify_affected'` (usunąć
  „and file-editor role" — bo tego nie sprawdza), **ALBO**
- (b) Dopisać do pętli faktyczną asercję dla file-editora:
  ```ts
  import { SUBAGENT_ROLES } from '../config/subagent-roles.js';
  // ...
  assert.ok(
    SUBAGENT_ROLES['file-editor'].allowedTools.includes('graphify_affected'),
    'file-editor role must register graphify_affected',
  );
  ```
  wtedy nazwa testu staje się prawdziwa.

Rekomendacja: **(b)** — skoro nazwa już to obiecuje, dopnij treść do nazwy zamiast odwrotnie;
daje to jedno miejsce więcej pilnujące tego samego faktu, co jest tanie i nieszkodliwe.

**Weryfikacja:** `npx tsx src/mastra/scripts/check-coding-domain.ts` — dalej zielone, i nazwa
testu zgadza się z tym, co faktycznie assertuje.

---

## Poprawka 3 — liczba mnoga/pojedyncza w komunikacie świeżości + test, który tego nie łapie (bardzo niski priorytet)

`src/mastra/services/graphify.ts:122`:
```ts
return `graph built at ${builtCommit.slice(0, 7)}, HEAD is ${count} commit${count === 1 ? '' : 's'} ahead — may miss the ${count} most recent changes`;
```
Liczba mnoga na końcu (`changes`) jest ZAWSZE, nawet dla `count === 1` — gramatycznie powinno być
`change` w liczbie pojedynczej. Nie wpływa na działanie (model i tak zrozumie treść), ale:

**Test, który MIAŁ to złapać, nie łapie tego z powodu luźnego regexa.** W
`check-graphify-affected-parse.ts` i `verify-graphify-strengthening.ts` jest:
```ts
assert.match(status, /HEAD is 1 commit ahead — may miss the 1 most recent change/);
```
Ten regex **przechodzi też dla „changes"**, bo nie ma zakotwiczenia na końcu (`change` jest
prefiksem `changes`) — więc test daje fałszywe poczucie bezpieczeństwa, nie faktyczną gwarancję
poprawnej gramatyki.

**Do zrobienia:**
1. W `graphify.ts` dodać warunek: `` `${count} most recent change${count === 1 ? '' : 's'}` ``.
2. W OBU miejscach z testem dopisać `$` na końcu regexa (albo `\b` + koniec stringa), żeby
   faktycznie odróżniał `change` od `changes`:
   ```ts
   assert.match(status, /HEAD is 1 commit ahead — may miss the 1 most recent change$/);
   ```
   i analogicznie dla wariantu z 3 commitami: `most recent changes$` (tu liczba mnoga jest
   poprawna, więc regex ma być inny niż dla przypadku `count === 1`).

**Weryfikacja:** po poprawce, uruchom `check:graphify-affected-parse` i
`check:graphify-strengthening` — oba muszą dalej przechodzić, ALE teraz faktycznie testując
poprawną gramatykę (spróbuj świadomie cofnąć poprawkę #1 i sprawdzić, że wtedy któryś z tych
dwóch testów RZECZYWIŚCIE oblewa — to jest dowód, że regex faktycznie coś testuje, nie tylko że
przechodzi).

---

## Czego NIE robić

- Nie przerabiaj niczego z G1/G2/G3 poza tymi trzema punktami — reszta jest zweryfikowana i
  działa poprawnie, potwierdzone niezależnie (nie tylko z transkryptu wykonawcy).
- Nie zmieniaj treści promptów (`coding/base.md`, `security-review.md`, `performance-review.md`,
  `subagent-file-editor.md`) — te są poprawne.
- Nie dotykaj `security-review-agent.ts`/`performance-review-agent.ts` — poprawne, minimalne.

## Definicja ukończenia

Wszystkie trzy poprawki zrobione, `npm run check:all` (albo przynajmniej
`check:graphify-strengthening`, `check:coding-domain`, `check:graphify-affected-parse`,
`typecheck`) zielone, i punkt 3 zweryfikowany przez świadome cofnięcie poprawki żeby zobaczyć,
że test faktycznie potrafi oblać.
