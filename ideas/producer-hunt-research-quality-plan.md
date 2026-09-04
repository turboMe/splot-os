# Producer Hunt: plan napraw researchu i jakosci leadow

## Cel

Producer Hunt ma najpierw znalezc wystarczajaco duzo kandydatow, potem wykonac research dla leadow pewnych i niepewnych, a dopiero po researchu zdecydowac, czy powstaje cold email. Obecny blad polega na tym, ze `research_needed` jest zapisywane do CRM, ale nie przechodzi do kroku `enrich-leads`, wiec workflow konczy z jednym lub zerem emaili mimo znalezienia kilku sensownych firm.

## Diagnoza z logow

Ostatnie uruchomienia pokazaly, ze problem pojawia sie przed etapem researchu:

- `slaskie`, `count=10`: discovery znalazlo 7 leadow z emailami, ale `validLeads=0`, `researchOnlyCount=5`, `enriched=0`, `drafts=0`.
- `wroclaw`, `count=10`: discovery znalazlo 9 leadow, ale tylko 1 przeszedl jako `draft_candidate`, wiec powstal 1 draft.
- `mazowieckie`, `count=5`, `productType=warzywa i owoce`: 3 leady przeszly do enrichmentu i powstaly 3 drafty.

Wniosek: enrichment i draftowanie dzialaja, gdy dostaja dane. Gubi nas bramka jakosci przed researchem.

## Zakres zmian

1. Zmienic znaczenie `validLeads` w `create-research-leads` na liste kandydatow do enrichmentu, czyli `draft_candidate + research_needed`.
2. Zostawic `researchOnlyCount`, ale traktowac go jako metryke, nie jako koniec sciezki.
3. Wzmocnic scoring:
   - obslugiwac fleksje i rdzenie slow: `spozywcz`, `zywnos`, `produkc`, `produkt`, `kaw`, `herbat`, `catering`, `kanapk`, `potraw`, itd.;
   - traktowac miasta jako dopasowanie regionu, np. Cieszyn/Zywiec/Bielsko-Biala/Chorzow dla `slaskie`;
   - rozpoznawac puste placeholdery typu `brak`, `brak danych`, `nie podano`;
   - nie karac publicznych domen email (`gmail.com`, `wp.pl`, `o2.pl`) za brak zgodnosci z domena strony;
   - karac po researchu frazy typu `nie mozna potwierdzic`, `brak danych pozytywnych`, `niepowiazane z branza spozywcza`.
4. Rozszerzyc schema leadow z discovery o pola pomocnicze:
   - `city`,
   - `productCategory`,
   - `sourceUrls`,
   - `emailSource`,
   - `isProducer`,
   - `confidence`.
5. Zmienic prompt discovery tak, zeby model zwracal dane przydatne do scoringu, a nie tylko jedno zdanie `reason`.
6. Uruchamiac fallback discovery, gdy liczba znalezionych leadow jest mniejsza od `count`, a nie dopiero ponizej 70%.
7. Dodac post-research gating:
   - enrichment robi research dla wszystkich nieodrzuconych kandydatow;
   - po enrichmentu lead jest ponownie oceniany na podstawie `reason + rawAnalysis + productCategory + city`;
   - dopiero wtedy odrzucamy leady o niskiej pewnosci lub z negatywnymi sygnalami tozsamosci.
8. Poprawic identity guard:
   - enrichment ma zwracac `companyName`;
   - walidacja nazwy ma realnie porownywac nazwe wejsciowa z nazwa po researchu;
   - mismatch domeny strony nie powinien odrzucac leadow z publicznym emailem.
9. Dodac diagnostyke:
   - logowac score, decyzje i powody dla kazdego leada;
   - w output kroku `create-research-leads` zapisywac summary: discovered, draftCandidates, researchNeeded, rejected, candidatesForResearch;
   - w CRM zapisywac pre- i post-research quality metadata.

## Kryteria sukcesu

- Dla `count=10` workflow nie konczy sie na 1 emailu tylko dlatego, ze leady byly `research_needed`.
- Lead z poprawnym emailem i sensownym opisem producenta trafia do enrichmentu nawet bez strony WWW.
- Lead bez emaila, ale z mocnym opisem producenta, trafia do enrichmentu i potem do `extract-emails`.
- Ledy niepotwierdzone po researchu nie dostaja maila.
- Snapshot workflow pokazuje, gdzie odpadl kazdy lead i dlaczego.
