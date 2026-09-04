# Producer Hunt: typologia dostawcy

Workflow `producer-hunt` od PR A przyjmuje, że nie wszystkie leady to producenci. Każdy lead
jest klasyfikowany do jednego z typów dostawcy i workflow korzysta z tej klasyfikacji do
scoringu, decyzji i CRM segment.

Plan implementacji: [ideas/producer-hunt-fix-v3.md](../ideas/producer-hunt-fix-v3.md).

## Typy dostawcy

| Typ              | Opis                                                                  | CRM segment   |
| ---              | ---                                                                   | ---           |
| `producer`       | producent / wytwórca / gospodarstwo / manufaktura / RHD               | `producer`    |
| `manufacturer`   | większy zakład przetwórstwa                                           | `manufacturer`|
| `cooperative`    | spółdzielnia, kooperatywa                                             | `cooperative` |
| `producer_group` | grupa producencka, zrzeszenie hodowców                                | `cooperative` |
| `wholesaler`     | hurtownia spożywcza, hurtownia HoReCa, cash & carry                   | `wholesaler`  |
| `distributor`    | dystrybutor regionalny / krajowy do gastronomii                       | `distributor` |
| `importer`       | importer specjalistyczny (kuchnia włoska, hiszpańska, azjatycka, ...) | `importer`    |
| `farm_aggregator`| platforma agregująca rolników (marketplace producentów)               | `aggregator`  |
| `unknown`        | klasyfikacja niepewna; lead idzie do `research_needed` / `reject`     | `unknown`     |

Wszystkie typy poza `unknown` są domyślnie akceptowane przez workflow.
Mapowanie typu → CRM `segment` jest scentralizowane w
[`mapToCrmSegment`](../src/mastra/workflows/producer-hunt/quality.ts) (PR A).

## Pola na lead/enriched-lead

PR A rozszerza schema o:

- `supplierType` — typ zadeklarowany (przez discovery LLM lub input użytkownika).
- `directToHoreca` — `yes | limited | no | unknown`. Czy firma dostarcza bezpośrednio do
  restauracji/hoteli/cateringu.
- `brandsOrPortfolio` — lista marek/produktów w portfolio.
- `servesRegions` — gdzie dostarczają (województwa/miasta).

Na `EnrichedLead` dodatkowo:

- `inferredSupplierType` — typ ustalony przez heurystykę `inferSupplierType`. To jest
  jedyne pole, na którym opiera się scoring i decyzje workflow. `supplierType` z LLM
  jest tylko wskazówką.

## Heurystyka klasyfikacji (`inferSupplierType`)

Plik: [quality.ts](../src/mastra/workflows/producer-hunt/quality.ts).

Algorytm:

1. Jeśli model zadeklarował typ inny niż `unknown` i tekst lead/enriched zawiera słowa
   kluczowe pasujące do tego typu → przyjmij deklarację.
2. W przeciwnym razie: kolejne sprawdzenia keyword setów w aggregowanym tekście
   (`reason + rawAnalysis + personalizationHook + city + productCategory + emailSource +
   company + companyName + website + sourceUrls + brandsOrPortfolio`):
   - `WHOLESALE_KEYWORDS` → `wholesaler`
   - `DISTRIBUTION_KEYWORDS` → `distributor`
   - `IMPORTER_KEYWORDS` → `importer`
   - `COOPERATIVE_KEYWORDS` → `producer_group` / `farm_aggregator` / `cooperative`
   - `PRODUCTION_KEYWORDS` lub `lead.isProducer === true`:
     - jeśli tekst zawiera `zaklad/przetwor/manufaktur` → `manufacturer`
     - inaczej → `producer`
3. Jeśli żaden zestaw nie pasuje, ale model zadeklarował konkretny typ — przyjmij deklarację
   (mimo braku potwierdzenia).
4. Inaczej → `unknown`.

Heurystyka jest wstecznie kompatybilna: stare leady, które nie mają `supplierType`,
ale mają silne sygnały produkcji, dostają `producer` / `manufacturer`.

## Scoring per typ

PR A przebudowuje [`scoreLead`](../src/mastra/workflows/producer-hunt/quality.ts) tak, aby:

- Bonus +15 za sygnały produkcji liczy się tylko dla `producer | manufacturer`. Dla
  pozostałych typów premiowane są ich własne sygnały (hurtownia, dystrybucja, importer,
  kooperatywa).
- Penalty -15 za brak sygnału produkcji odpala się tylko gdy
  `inferredSupplierType ∈ {producer, manufacturer}`.
- Stara penalty -50 za `isProducer === false` została usunięta. Zamiast tego: -50 jeśli
  `supplierType === unknown` i jednocześnie `directToHoreca` nie potwierdza HoReCa.
- +15 za `directToHoreca === yes`, +5 za `limited`. -20 dla `wholesaler` z
  `directToHoreca === no`.
- -30 jeśli tekst dotyczy końcowego konsumenta (restauracja/hotel/pizzeria/...) i nie
  ma żadnych sygnałów dostawcy.
- -25 jeśli tekst dotyczy sieci handlowej B2C (Biedronka, Lidl, Auchan, Tesco, ...).

Progi decyzji bez zmian: `>= 55: draft_candidate`, `>= 25: research_needed`, `< 25: reject`.

`scoreLead` zwraca teraz dodatkowo `inferredSupplierType` — używany przez `create-research-leads`,
`enrich-leads` i CRM updates.

## Identity guardrail

[`validateEnrichmentIdentity`](../src/mastra/workflows/producer-hunt/quality.ts) — dwie zmiany
w PR A:

1. **Tolerancja domeny dla hurtowni/dystrybutora/importera**: zamiast pełnej kary -0.6 za
   niezgodność domeny website z domeną emaila, dla typów dystrybucyjnych nakłada się tylko
   -0.2. Hurtownie często mają oddzielne domeny B2B / portalowe / CRM-owe.
2. **Drift typu**: jeśli model klasyfikuje typ inaczej niż heurystyka po researchu,
   `confidence -= 0.2` z reasonem "Model klasyfikuje typ jako X, heurystyka jako Y".

## Workflow input

`producer-hunt` przyjmuje opcjonalny parametr `supplierTypes`:

```ts
inputSchema: z.object({
  region: z.string(),
  count: z.number().default(10),
  productType: z.string().optional(),
  supplierTypes: z.array(supplierTypeSchema).optional(),
}),
```

- Brak `supplierTypes` → akceptuj wszystkie typy poza `unknown` (`ACCEPTABLE_SUPPLIER_TYPES`).
- Jawna lista → tylko leady o `inferredSupplierType` z listy idą dalej; reszta dostaje
  `decision: 'reject'` z reasonem `reject: typ X poza listą akceptowalnych`.

Przykładowe inputy:

```json
{ "region": "śląskie", "count": 8 }
{ "region": "wielkopolskie", "count": 6, "supplierTypes": ["wholesaler", "distributor"] }
{ "region": "małopolskie", "count": 5, "supplierTypes": ["producer", "cooperative"] }
```

## Co PR A świadomie nie zmienia

- Prompty discovery NotebookLM i fallback są bez zmian (PR C).
- Prompty enrichmentu pytają dalej "co wytwarzają" (PR D).
- Drafty cold-mail dalej zakładają producenta (PR E).
- Bazowe zapytania Tavily są dalej producer-biased (PR B).

PR A wprowadza tylko silnik klasyfikacji + scoring + segment CRM, żeby kolejne PR-y mogły
się o niego oprzeć bez ryzyka regresji.

## Diagnostyka po runie

Każdy lead w `db.leads` po PR A ma:

- `segment`: nowy mapping (np. `wholesaler`, `distributor`).
- `metadata.supplierType`: typ wynikowy (heurystyka).
- `metadata.declaredSupplierType`: typ od modelu, jeśli był.
- `metadata.directToHoreca`, `metadata.brandsOrPortfolio`, `metadata.servesRegions`.
- `metadata.qualityReasons`: pierwszy element to teraz `type: <inferredSupplierType>`.
- `metadata.postResearchQuality.inferredSupplierType` po enrichmencie.

Konsola `discover-leads`:

```
[producer-hunt:<taskId>] discovered by type: {"producer":3,"wholesaler":2,"unknown":1}
```

Konsola `lead quality`:

```
[producer-hunt:<taskId>] lead quality <name>: type=wholesaler, decision=draft_candidate, score=72, reasons=type: wholesaler; +25: poprawny email; +20: website wygląda jak oficjalna strona; +15: sygnał hurtowni / sprzedaży B2B; ...
```

## Testowanie regresji

Po PR A workflow musi:

1. Dla `region: "śląskie", count: 5` (run producencki) generować nie mniej draftów niż
   przed PR A. Nowa logika nie powinna obniżyć scoringu producentów.
2. Dla leadów oznaczonych przez NotebookLM jako hurtownia (np. nazwy zawierające
   "Hurtownia X"): wcześniej trafiali do `reject`, teraz powinni iść do `draft_candidate`
   lub `research_needed` zależnie od pozostałych sygnałów.
3. Dla leadów typu "Restauracja Y" / "Hotel Z" — dalej `reject` (chronione przez
   `END_CONSUMER_KEYWORDS`).
4. Dla "Biedronka", "Lidl", itd. — dalej `reject` przez `RETAIL_CHAIN_KEYWORDS`.
