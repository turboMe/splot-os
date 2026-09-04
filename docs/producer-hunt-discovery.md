# Producer Hunt: discovery — multi-profile, multi-round

Ten dokument opisuje fazę discovery workflow `producer-hunt` po PR B. Przed PR B była to
pojedyncza pula 10 zapytań Tavily, twardo zorientowana na producentów. Po PR B jest to
multi-profile pipeline z budżetem zapytań i fallback rundą po miastach.

Plan: [ideas/producer-hunt-fix-v3.md §4](../ideas/producer-hunt-fix-v3.md).
Kontekst typów: [producer-hunt-supplier-types.md](producer-hunt-supplier-types.md).

## Profile zapytań

Plik: [discovery-queries.ts](../src/mastra/workflows/producer-hunt/discovery-queries.ts).

Każdy `SupplierType` (poza `unknown`) ma osobny `DiscoveryProfile`:

```ts
type DiscoveryProfile = {
  type: SupplierType;
  baseQueries: (region, productType?) => string[];
  nicheQueries: (region, productType?) => string[];
  cityQueries: (region, city, productType?) => string[];
  trustedDomainHints: string[];
};
```

Profile (skrót):

| Typ              | baseQueries (skrót)                                                                   |
| ---              | ---                                                                                   |
| `producer`       | "producent ${food} ${region}", "lokalni dostawcy do restauracji", "gospodarstwo rolne", "manufaktura" |
| `manufacturer`   | "zakład przetwórstwa", "rolniczy handel detaliczny"                                   |
| `cooperative`    | "kooperatywa spożywcza", "spółdzielnia rolnicza", "lokalna inicjatywa producentów"    |
| `producer_group` | "grupa producencka", "zrzeszenie hodowców", "grupa producentów"                       |
| `wholesaler`     | "hurtownia spożywcza HoReCa", "cash and carry", "dla gastronomii dostawca"            |
| `distributor`    | "dystrybutor spożywczy HoReCa", "dostawca do restauracji", "foodservice dystrybucja"  |
| `importer`       | "importer specjalności kulinarnych", "bezpośredni import", "importer marek HoReCa"    |
| `farm_aggregator`| "platforma rolnicy lokalni", "agregator producentów", "marketplace producentów żywności"|

`nicheQueries` uruchamiają się tylko gdy nie podano `productType` — to zestaw szczegółowych
kategorii (sery rzemieślnicze, masarnia, tłocznia, hurtownia mięsa, hurtownia mrożonek itp.).

`cityQueries` to fallback dla rundy 2 — odpalają się per miasto z `getRegionTokens(region)`.

## Wybór profili na podstawie inputu

`producer-hunt` przyjmuje opcjonalny `supplierTypes`. Reguła:

- brak `supplierTypes` → wszystkie profile poza `unknown` (`ACCEPTABLE_SUPPLIER_TYPES`).
- jawna lista typów → tylko profile z tej listy.

Przykładowe inputy:

```json
{ "region": "śląskie", "count": 8 }
// 8 profili × baseQueries × nicheQueries

{ "region": "wielkopolskie", "count": 6, "supplierTypes": ["wholesaler", "distributor"] }
// tylko 2 profile, zapytania B2B

{ "region": "małopolskie", "count": 5, "supplierTypes": ["producer"] }
// jeden profil — tryb regresji do zachowania sprzed PR B
```

## Multi-round logic

### Runda 1 — bazowe + niszowe

Dla każdego aktywnego profilu workflow składa `baseQueries(region, productType)` +
`nicheQueries(region, productType)`, ale tnie do `MAX_QUERIES_PER_PROFILE_ROUND_1 = 5`
zapytań na profil. Zapytania puszcza równolegle przez `searchWebTool` (Tavily, max 5
wyników na zapytanie).

### Runda 2 — fallback po miastach

Uruchamia się gdy:

- `accumulatedHits.size < count * 2` (liczba surowych hitów po deduplikacji),
- `queriesIssued < TAVILY_QUERY_BUDGET`.

Dla każdego aktywnego profilu × maks. 4 największe miasta z `getRegionTokens(region)`
([quality.ts:142-183](../src/mastra/workflows/producer-hunt/quality.ts#L142-L183)) workflow
buduje zapytania `profile.cityQueries(region, city, productType)`. Filtr miast: usuwa
warianty regionu (`slask`, `slaskie`) i zostawia konkretne miasta (`katowice`, `bielsko`,
`zywiec`, `cieszyn`, ...).

Profile bez `cityQueries` (np. `importer`) nie odpalają nic w rundzie 2.

### Budżet

`TAVILY_QUERY_BUDGET = 30` na cały run. Po przekroczeniu kolejne rundy są pomijane,
do logu trafia `query budget exhausted`. Zapobiega nieliniowemu wzrostowi kosztu Tavily
przy `count = 50+` lub `supplierTypes = [wszystkie typy]`.

## Filtrowanie URL przed NotebookLM

Po deduplikacji wszystkich hitów workflow wybiera top 12 do NotebookLM. Filtr `isUsableForNotebook`:

1. **Odrzuca** `SOCIAL_AND_NLM_INCOMPATIBLE_HINTS` — Facebook, Instagram, LinkedIn, TikTok,
   Twitter/X, YouTube. NotebookLM słabo indeksuje te strony.
2. **Odrzuca** `EXCLUDED_DOMAIN_HINTS` — Allegro, OLX, Ceneo, Empik, Lidl, Biedronka, Auchan,
   Tesco, Kaufland, Carrefour, Netto, Aldi. To nie są nasi klienci ani sensowne źródła.
3. **Dopuszcza** wszystkie pozostałe domeny — w tym `hurtownia*.pl`, `dystrybucja*.pl`,
   `gastropol`, `gourmet`, `kooperatywa*`. Przed PR B filtr odrzucał tylko 3 domeny social,
   ale niczego nie zatrzymywał z B2C.

## Diagnostyka

W konsoli `discover-leads` widać:

```
[producer-hunt:<taskId>] discover round1: 32 queries across 8 profiles
[producer-hunt:<taskId>] discover round1: query budget exhausted   # gdy >30
[producer-hunt:<taskId>] discover round2: 16 city-level queries (cities=katowice,bielsko,zywiec,cieszyn)
[producer-hunt:<taskId>] total unique links: 124, queries issued: 30/30, top 12 → NotebookLM.
```

`discover-leads` zwraca też `acceptableSupplierTypes` w outpucie — przepuszcza dalej do
`create-research-leads`, gdzie służy do filtrowania po `inferredSupplierType` (PR A).

## Co PR B świadomie nie zmienia

- Prompt do NotebookLM dalej brzmi "lokalnych producentów żywności" — to PR C.
- Fallback prompt po snippetach dalej zwraca leady z perspektywy producenckiej — PR C.
- Schema discovery LLM (`discoveryResponseSchema`) bez `supplierType` na poziomie odpowiedzi —
  PR C.

PR B daje workflow bogatszy basen kandydatów (hurtownie/dystrybutorzy/grupy widoczne w
Tavily), ale dopiero PR C nauczy NotebookLM ich klasyfikować. Do tego czasu hurtownia
wpadnie do basenu, ale NotebookLM może ją odfiltrować w pamięci (i wtedy heurystyka PR A
złapie tylko te, które przemkną przez fallback snippetów).
