# Producer Hunt: prompty discovery (klasyfikacja zamiast filtrowania)

Ten dokument opisuje prompty fazy discovery po PR C. Przed PR C oba prompty (NotebookLM
oraz fallback po snippetach Tavily) wprost prosiły model o "lokalnych producentów" i
filtrowały "sklepy pośredniczące". Po PR C oba prompty proszą o klasyfikację każdej
znalezionej firmy do `supplierType` zamiast filtrowania.

Plan: [ideas/producer-hunt-fix-v3.md §4.3 + §4.4](../ideas/producer-hunt-fix-v3.md).
Kontekst typów: [producer-hunt-supplier-types.md](producer-hunt-supplier-types.md).
Profile zapytań Tavily: [producer-hunt-discovery.md](producer-hunt-discovery.md).

## Główny prompt NotebookLM

Plik: [producer-hunt.ts](../src/mastra/workflows/producer-hunt.ts) (krok `discover-leads`).

Wcześniej:

> "Na podstawie załadowanych źródeł, sporządź listę do ${count} **lokalnych producentów żywności** z województwa ${region}. (...) Pomiń portale ogólne, bazy firm i **sklepy pośredniczące**. Skup się na REALNYCH wytwórcach."

Po PR C:

> "Na podstawie załadowanych źródeł, sporządź listę do ${count} firm z województwa ${region}, które mogą dostarczać żywność do restauracji w modelu B2B (cel: GastroBridge)."

Prompt:

1. Wymienia osiem typów dostawcy z definicjami (producer, manufacturer, cooperative, producer_group, wholesaler, distributor, importer, farm_aggregator) plus `unknown` jako fallback.
2. Lista typów akceptowalnych jest zbudowana z `acceptableSupplierTypes` (z PR A) — jeżeli user przekaże `supplierTypes: ["wholesaler", "distributor"]`, model dostaje tę listę i wie, czego szukać.
3. Lista wykluczeń jest węższa i precyzyjniejsza:
   - portale/katalogi (panoramafirm, gowork, pkt.pl, oferteo, aleo);
   - sieci B2C (Biedronka, Lidl, Auchan, Tesco, Kaufland, Carrefour);
   - restauracje/hotele/pizzerie (to klienci, nie dostawcy);
   - sieci hurtowe Selgros/Makro — można zostawić dla kontekstu, ale ICP to ich poddostawcy.
4. Zwracane pola obejmują wszystkie pola z PR A: `supplierType`, `directToHoreca`, `brandsOrPortfolio`, `servesRegions`. Dochodzą też `productCategory`, `sourceUrls`, `emailSource`, `isProducer`, `confidence`, `reason`.
5. Reguła `isProducer: false dla hurtowni/dystrybutorów/importerów` zapobiega temu, że model
   automatycznie ustawia `isProducer: true` przy każdym wpisie (po PR A penalty za ten
   sygnał już nie istnieje, ale poprawne `false` daje czystszy CRM).
6. Dla niejednoznacznych firm: `supplierType: "unknown"`. To NIE jest automatyczny `reject`:
   PR A scoruje `unknown` na -50 tylko jeśli `directToHoreca` też nie potwierdza HoReCa,
   więc niektóre niepewne leady przejdą do `research_needed`.

## Fallback prompt (po snippetach Tavily)

Uruchamia się gdy NotebookLM zawiódł lub zwrócił < `count` leadów.

Zmiany analogiczne do głównego promptu:

- ten sam zestaw typów akceptowalnych (`acceptableSupplierTypes`),
- ta sama lista wykluczeń,
- jawna instrukcja "Nie odrzucaj hurtowni i dystrybutorów — to wartościowi partnerzy GastroBridge",
- ten sam JSON output z polami klasyfikującymi.

Skrót snippetów (`uniqueResults.slice(0, 20)`) i max długość treści (`r.content.slice(0, 400)`) zostają bez zmian — to jest tylko gdy basen URL jest spory.

## Schema odpowiedzi

`discoveryResponseSchema = z.object({ leads: z.array(leadSchema) })`. `leadSchema` po PR A
ma już opcjonalne `supplierType`, `directToHoreca`, `brandsOrPortfolio`, `servesRegions`, więc
walidacja jest wstecznie kompatybilna:

- model może je pominąć — wtedy heurystyka `inferSupplierType` (PR A) ustali typ.
- model może je podać — wtedy preferowany jest typ deklarowany, jeśli heurystyka go potwierdza.

`generateJsonWithFallback` (helpers.ts) używa schemy z PR A — żaden ekstra mapping nie jest
potrzebny.

## Diagnostyka

Po PR C w outpucie `discover-leads` widać już zazwyczaj zróżnicowane typy. W konsoli
`create-research-leads` (PR A) statystyka:

```
[producer-hunt:<taskId>] discovered by type: {"producer":3,"wholesaler":2,"distributor":1,"unknown":2}
```

Jeśli po 3-5 testowych runach większość leadów ma `supplierType: "unknown"`, wskazuje to,
że lokalny model słabo klasyfikuje. Wtedy:

1. sprawdzić czy prompt nie został obcięty (lokalny model `localMarketing` może mieć krótki
   kontekst);
2. rozważyć `cloudFallback` przy discovery (workflow-models.ts) — ale tylko jeśli `localMarketing`
   jest wyraźnie niewystarczający, bo cloud zwiększa koszt i opóźnienie.

## Co PR C świadomie nie zmienia

- Pytanie do notatnika `rynek` w `enrich-leads` ([producer-hunt.ts:496-508](../src/mastra/workflows/producer-hunt.ts#L496-L508)) — to jest PR D.
- Prompt finalnego enrichment LLM (`Dokończ research firmy`) — PR D.
- Drafty cold-mail — PR E.

PR C zamyka klasyfikację po stronie discovery. Workflow ma teraz spójną klasyfikację:
discovery LLM → heurystyka PR A → scoring PR A → segment CRM PR A. Reszta workflow dalej
zakłada, że pracuje z producentem; PR D i PR E to zmienią.
