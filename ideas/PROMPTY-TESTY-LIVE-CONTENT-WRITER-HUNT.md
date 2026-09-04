# Prompty do testów live przez Meta Front — content / writer / hunt

**Do czego to jest.** Trzy zadania do odpalenia przez Meta Front (normalna droga,
bez pinowania capability). Chodzi o to, żeby lane sam wybrał agenta i żeby każdy
pipeline przeszedł swoją maszynę stanów do końca. Wyniki sprawdzam następnego dnia
według listy na dole.

**Zasady odpalania:**
- Jedno zadanie na raz, **nie równolegle** — inaczej nie da się rozdzielić zdarzeń
  w `agent_events` po czasie.
- Zanotuj godzinę startu każdego (albo zostaw je w tej samej rozmowie).
- Tematy są świeże, spoza tego, co już jest w bazie — nie podmieniaj ich na coś,
  co już przechodziło, bo agent może podebrać gotowy wynik i wyjdzie fałszywy sukces.

---

## 1. contentAgent

```
Potrzebuję content pack dla marki Ziarno & Para — palarnia kawy specialty
z Wrocławia, która właśnie wprowadza subskrypcję kawy do domu.
Grupa docelowa: ludzie 28-40 lat, pijący kawę codziennie, którzy chcą przestać
kupować przypadkową kawę w markecie.
Potrzebuję postów na Instagram, LinkedIn i TikTok plus prompty do grafik.
```

Czego to dotyka: pełny pipeline contentu (strategia → draft → krytyk → assemble →
render), `run_worker` na kilku presetach, Content Pack jako dokument sekcyjny,
równoległe zapisy sekcji (świeżo naprawiony wyścig).

---

## 2. writerAgent

```
Napisz opowiadanie: nocna zmiana w przychodni na obrzeżach miasta, młoda
lekarka przyjmuje pacjenta, który twierdzi, że był tu wczoraj — ale w systemie
nie ma po nim śladu. Ma być kameralnie i niepokojąco, bez taniego horroru.
Około 2500 słów, po polsku.
```

Czego to dotyka: pipeline writera (research → draft → critic_gate → revision →
render), workery `writer_*`, manuskrypt jako dokument sekcyjny, `writer_quality_gate`.
Writer jako jedyny miał już własną serializację zapisów — ten przebieg ma
potwierdzić, że nadal działa.

---

## 3. huntAgent

```
Znajdź mi producentów rzemieślniczych serów zagrodowych w Małopolsce
i na Podkarpaciu, którzy sprzedają do restauracji albo chcieliby zacząć.
Interesują mnie tacy z realną stroną i kontaktem — przygotuj listę
z uzasadnieniem, dlaczego każdy z nich pasuje.
```

Czego to dotyka: pipeline hunta (discovery → enrichment → scoring → report),
delegacje do researchera, Hunt Report jako dokument sekcyjny, równoległe zapisy
(świeżo naprawiony wyścig).

---

## Co sprawdzę następnego dnia

Dla każdego z trzech, w tej kolejności:

1. **Czy lane nie rozbił pipeline'u** — czy zadanie poszło jednym dispatchem do
   właściwego agenta, czy zostało pocięte na kroki i rozdane osobno. To jest
   defekt, który u chefa wycinał URL i zabijał całą fazę recon.
2. **Czy przeszły wszystkie fazy** — pełna ścieżka statusów do stanu końcowego,
   z fazą kontroli jakości w środku (a nie skok do `done`).
3. **Czy produkt pokrywa deklarację** — liczone po tożsamości, nie po liczbie:
   każdy zapowiedziany post / rozdział / lead ma swój wytwór.
4. **Czy dokument jest pełny** — sekcje kanoniczne niepuste, żadna nie zgubiona
   przez równoległy zapis. Tu właśnie chef gubił 5 z 6 sekcji na batch.
5. **Czy workery żyły** — zero `worker_run_failed`; gdyby coś padło, od razu
   widać, czy to model, czy treść.
6. **Czy produkt dotarł** — co dostała rozmowa: sam status czy odnośnik do
   wytworu. U chefa to nadal jest otwarte i podejrzewam to samo tutaj.
7. **Czy status końcowy nie kłamie** — czy `done` nie zostało ogłoszone przy
   wybrakowanym produkcie. Content, writer i hunt **nie mają jeszcze bramy
   kompletności** (ma ją tylko chef), więc spodziewam się, że mogą tak zrobić —
   i to jest jedna z rzeczy, które ten test ma pokazać.

**Jeśli któryś przebieg padnie w połowie — zostaw go tak, jak jest.** Nie kasuj
projektu ani nie uruchamiaj ponownie; niedokończony stan jest dowodem, a
powtórka go nadpisze.
