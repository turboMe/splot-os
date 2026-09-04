# Producer Hunt fix v3 — rozszerzenie researchu o firmy i hurtownie (plan dla deva)

Ten dokument jest osobnym planem nad `producer-hunt-fix-v2.md`. Skupia się tylko na fazach
discovery + enrichment i rozszerza zakres workflow z "tylko producenci" na "producenci +
firmy/hurtownie/dystrybutorzy/grupy producenckie", które realnie mogą dostarczać do restauracji
przez GastroBridge.

Kontekst implementacyjny (stan kodu, na którym ten plan się opiera):

- workflow: [producer-hunt.ts](agentic-agents/src/mastra/workflows/producer-hunt.ts)
- helpers: [helpers.ts](agentic-agents/src/mastra/workflows/producer-hunt/helpers.ts)
- scoring + identity: [quality.ts](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts)
- agenci: [marketing-agent.ts](agentic-agents/src/mastra/agents/marketing-agent.ts)
- konfiguracja modeli: [workflow-models.ts](agentic-agents/src/mastra/config/workflow-models.ts)
- Tavily: [tavily.ts](agentic-agents/src/mastra/tools/search/tavily.ts)
- NotebookLM: [knowledge-tools.ts](agentic-agents/src/mastra/tools/knowledge/knowledge-tools.ts)

## 1. Audyt: czy workflow naprawdę szuka tylko producentów?

Tak — na każdym etapie. Potwierdzenia w kodzie:

1. Tożsamość workflow i opis kroków:
   - `producerHuntWorkflow` description: "Wyszukuje producentów (10-step)..." — [producer-hunt.ts:1293](agentic-agents/src/mastra/workflows/producer-hunt.ts#L1293).
   - `discover-leads.description`: "Wyszukuje lokalnych producentów w zadanym regionie..." — [producer-hunt.ts:195](agentic-agents/src/mastra/workflows/producer-hunt.ts#L195).

2. Prompty discovery wprost wykluczają pośredników i firmy nieprodukujące:
   - "lista do ${count} lokalnych producentów żywności z województwa ${region}" — [producer-hunt.ts:277](agentic-agents/src/mastra/workflows/producer-hunt.ts#L277).
   - "Pomiń portale ogólne, bazy firm i sklepy pośredniczące. Skup się na REALNYCH wytwórcach." — [producer-hunt.ts:295](agentic-agents/src/mastra/workflows/producer-hunt.ts#L295).
   - Fallback prompt: "wybierz ${count} producentów żywności z ${region}" — [producer-hunt.ts:324](agentic-agents/src/mastra/workflows/producer-hunt.ts#L324).
   - `isProducer: true tylko jeśli źródło wskazuje realne wytwarzanie/produkcję` — [producer-hunt.ts:288](agentic-agents/src/mastra/workflows/producer-hunt.ts#L288).

3. Bazowe i niszowe zapytania Tavily są zorientowane producentowo:
   - `baseQueries` zawierają wyłącznie "producenci", "lokalni dostawcy", "gospodarstwo rolne", "rolniczy handel detaliczny", "zakład przetwórstwa" — [producer-hunt.ts:218-224](agentic-agents/src/mastra/workflows/producer-hunt.ts#L218-L224).
   - `nicheQueries` to tłocznia, masarnia, piekarnia rzemieślnicza itd. — [producer-hunt.ts:226-232](agentic-agents/src/mastra/workflows/producer-hunt.ts#L226-L232).
   - Brak jakichkolwiek zapytań o hurtownie spożywcze, dystrybutorów HoReCa, importerów, grupy producenckie, kooperatywy.

4. Scoring penalizuje firmy nieprodukcyjne i nagradza tylko sygnały produkcji:
   - `PRODUCTION_KEYWORDS` zawierają tylko słowa wytwórcze — [quality.ts:70-87](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L70-L87).
   - `-15: brak jasnego sygnału produkcji/wytwórstwa` — [quality.ts:362](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L362).
   - `-50: oznaczone jako nie-producent` przy `lead.isProducer === false` — [quality.ts:367](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L367).
   - Hurtownia / dystrybutor z mocnym opisem trafią do `reject` mimo że są wartościowi dla GastroBridge.

5. Enrichment prompt zakłada producenta:
   - "Co ich wyróżnia? Jakie konkretnie produkty wytwarzają? Czy mają tradycję rodzinną, certyfikaty (Produkt Lokalny, RHD)?" — [producer-hunt.ts:561-568](agentic-agents/src/mastra/workflows/producer-hunt.ts#L561-L568).
   - "Producent żywności z regionu ${region}" jako fallback hooka i `rawAnalysis` — [producer-hunt.ts:634](agentic-agents/src/mastra/workflows/producer-hunt.ts#L634), [producer-hunt.ts:648](agentic-agents/src/mastra/workflows/producer-hunt.ts#L648), [producer-hunt.ts:664](agentic-agents/src/mastra/workflows/producer-hunt.ts#L664).
   - `findCompanyLinksTool` szuka "oficjalnej strony" — neutralne, ale dalej nie różnicuje typu.

6. CRM:
   - Każdy lead trafia jako `segment: 'producer'` — [producer-hunt.ts:441](agentic-agents/src/mastra/workflows/producer-hunt.ts#L441), [producer-hunt.ts:1107](agentic-agents/src/mastra/workflows/producer-hunt.ts#L1107).
   - Po stronie raportowej i dashboardów to wymusza pojedynczy segment, niezależnie od typu firmy.

7. Cold email zakłada producenta:
   - "krótki, profesjonalny cold-email do producenta: '${lead.company}'" — [producer-hunt.ts:880](agentic-agents/src/mastra/workflows/producer-hunt.ts#L880).
   - "Wasze sery kozie", "konkretny produkt lub kategorię" — [producer-hunt.ts:567](agentic-agents/src/mastra/workflows/producer-hunt.ts#L567), [producer-hunt.ts:895](agentic-agents/src/mastra/workflows/producer-hunt.ts#L895).

Wniosek audytu: cała ścieżka od zapytań Tavily, przez prompt NotebookLM, scoring, enrichment,
aż po prompt cold maila jest twardo "producer-only". Zmiana skali to nie podmiana kilku słów —
trzeba wprowadzić typologię dostawcy i przeprowadzić ją przez wszystkie etapy.

## 2. Cel v3

Po wdrożeniu v3 workflow ma:

1. Znajdować nie tylko producentów, ale też hurtownie HoReCa, dystrybutorów żywności, importerów,
   grupy producenckie, kooperatywy/spółdzielnie i firmy cateringowe-dostawcze, jeśli realnie
   sprzedają do restauracji.
2. Klasyfikować każdy lead według typu dostawcy (`supplierType`) i przepuszczać dalej tylko te
   typy, które GastroBridge chce kontaktować.
3. Robić enrichment dopasowany do typu (producent vs hurtownia vs dystrybutor) — inne pytania,
   inne źródła wiarygodności, inny hook do maila.
4. Nie odrzucać hurtowni za to, że nie pasują do kryteriów producenta.
5. W CRM zapisywać `segment` zgodny z typem dostawcy.
6. Discovery dobijać do `count` poprzez sekwencyjne rundy: producent → grupa producencka → hurtownia
   HoReCa → dystrybutor regionalny.

Cel jakościowy: drafty mają być spójne z typem firmy. Do producenta piszemy o ich produktach,
do hurtowni o asortymencie i marżach przy skróceniu łańcucha, do grupy producenckiej o
ich zrzeszonych dostawcach.

Cel poza zakresem: zmiana kontraktu workflow `region/count/productType` zostaje. Dodajemy
opcjonalny parametr `supplierTypes`.

## 3. Nowy model danych

### 3.1. Nowe pola na `Lead` i `EnrichedLead`

Plik: [producer-hunt.ts](agentic-agents/src/mastra/workflows/producer-hunt.ts) sekcja
"Schemas" (od linii 56).

Dodać do `leadSchema`:

```ts
const supplierTypeSchema = z.enum([
  'producer',          // producent, wytwórca, gospodarstwo, masarnia, piekarnia rzemieślnicza
  'manufacturer',      // zakład przetwórstwa większej skali
  'cooperative',       // spółdzielnia, kooperatywa, lokalna inicjatywa
  'producer_group',    // grupa producencka, zrzeszenie hodowców
  'wholesaler',        // hurtownia spożywcza, hurtownia HoReCa, cash&carry
  'distributor',       // dystrybutor regionalny / krajowy, dostawca do gastronomii
  'importer',          // importer specjalistyczny (np. produkty włoskie/azjatyckie)
  'farm_aggregator',   // platforma agregująca rolników (np. lokalne RHD-y w jednej platformie)
  'unknown',           // klasyfikacja niepewna — nie trafia do draftu, idzie do research_needed
]);

const directToHorecaSchema = z.enum(['yes', 'limited', 'no', 'unknown']);

// Rozszerzenie leadSchema:
const leadSchema = z.object({
  company: z.string(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  productCategory: z.string().nullable().optional(),
  sourceUrls: z.union([z.array(z.string()), z.string()]).nullable().optional(),
  emailSource: z.string().nullable().optional(),
  isProducer: z.boolean().nullable().optional(),  // pozostawić dla wstecznej kompatybilności
  confidence: z.number().min(0).max(1).nullable().optional(),

  // NOWE
  supplierType: supplierTypeSchema.nullable().optional(),
  directToHoreca: directToHorecaSchema.nullable().optional(),
  servesRegions: z.array(z.string()).nullable().optional(),  // gdzie dostarczają (województwa/miasta)
  brandsOrPortfolio: z.array(z.string()).nullable().optional(), // marki/produkty z portfolio
});
```

Zasada na stykach typów: `isProducer === true` mapować do `supplierType: 'producer'`,
jeśli model nie podał typu. To pozwala stopniowo migrować bez wywalania starych ścieżek.

### 3.2. Akceptowalne typy

Workflow dostaje opcjonalny input `supplierTypes`. Domyślnie:

```ts
const DEFAULT_ACCEPTABLE_TYPES: SupplierType[] = [
  'producer', 'manufacturer', 'cooperative', 'producer_group',
  'wholesaler', 'distributor', 'importer', 'farm_aggregator',
];
```

`unknown` nigdy nie idzie do draftu. Trafia do `research_needed`.

Zmiana w input schema workflow:

```ts
inputSchema: z.object({
  region: z.string(),
  count: z.number().default(10),
  productType: z.string().optional(),
  supplierTypes: z.array(supplierTypeSchema).optional(),  // NOWE
}),
```

W `discover-leads` jeśli `supplierTypes` brak, użyć `DEFAULT_ACCEPTABLE_TYPES`.

## 4. Discovery: wieloprofilowe zapytania

### 4.1. Profil zapytań per `supplierType`

Wydzielić do nowego pliku
`src/mastra/workflows/producer-hunt/discovery-queries.ts`:

```ts
export type DiscoveryProfile = {
  type: SupplierType;
  baseQueries: (region: string, productType?: string) => string[];
  nicheQueries: (region: string, productType?: string) => string[];
  trustedDomainHints: string[];     // domeny premiowane przy filtrowaniu wyników
  excludedDomainHints: string[];    // domeny do dodatkowego pominięcia (np. b2c marketplace)
};
```

Profile (fragmenty zapytań — pełna lista w PR):

- `producer`:
  - `producent ${productType ?? 'żywności'} ${region} kontakt email`
  - `gospodarstwo rolne ${region} sprzedaż bezpośrednia`
  - `manufaktura ${productType ?? ''} ${region}`
  - `RHD ${region} ${productType ?? ''} kontakt`

- `manufacturer`:
  - `zakład przetwórstwa ${productType ?? 'spożywczy'} ${region}`
  - `${productType ?? 'mięso'} przetwórstwo zakład produkcyjny ${region}`

- `cooperative` / `producer_group`:
  - `grupa producencka ${productType ?? ''} ${region} kontakt`
  - `kooperatywa spożywcza ${region}`
  - `spółdzielnia rolnicza ${productType ?? ''} ${region}`
  - `zrzeszenie hodowców ${productType ?? ''} ${region}`

- `wholesaler`:
  - `hurtownia spożywcza ${region} HoReCa kontakt`
  - `hurtownia ${productType ?? 'gastronomiczna'} ${region}`
  - `cash and carry ${productType ?? ''} ${region}`
  - `hurtownia mięsa nabiału warzyw ${region}`
  - `dla gastronomii dostawca ${region}`

- `distributor`:
  - `dystrybutor ${productType ?? 'spożywczy'} ${region} HoReCa`
  - `dostawca do restauracji ${region} ${productType ?? ''}`
  - `regionalny dystrybutor ${productType ?? ''} ${region}`

- `importer`:
  - `importer ${productType ?? 'specjalności kulinarnych'} ${region}`
  - `bezpośredni import ${productType ?? ''} dystrybucja Polska`
  - `produkty włoskie hiszpańskie azjatyckie importer ${region}`

- `farm_aggregator`:
  - `platforma rolnicy lokalni ${region} dostawa do restauracji`
  - `agregator producentów ${region}`
  - `marketplace producentów ${region}`

`trustedDomainHints` per typ (przykłady — uzupełnić w PR):

- producent: domeny zawierające `gospodarstwo`, `manufaktura`, `serowarnia`, `tlocznia`, `masarnia`.
- hurtownia: `hurtownia`, `hurt-`, `cashandcarry`, `bsdhurt`, `selgros.pl`, `makro.pl`, `eurocash.pl`.
- dystrybutor: `dystrybucja`, `horeca`, `dostawca`, `gastropol`, `gourmet`.
- grupa producencka: `gpr-`, `kooperatywa`, `zrzeszenie`, `spoldzielnia`.

`excludedDomainHints` rozszerzyć (poza obecnymi `DIRECTORIES`/`SOCIAL_DOMAINS` z quality.ts):

- `allegro.pl`, `olx.pl`, `ceneo.pl`, `empik.com`, `lidl.pl`, `biedronka.pl` — to nie są
  potencjalni klienci GastroBridge.
- `selgros.pl`, `makro.pl` — gigantyczne sieci, nie są naszym ICP, ale mogą prowadzić do
  listy ich dostawców (link nie jest klientem, ale informacją). Premiować jako kontekst,
  nie jako lead.

### 4.2. Multi-round discovery z budżetem typów

Plik: [producer-hunt.ts](agentic-agents/src/mastra/workflows/producer-hunt.ts) — zastąpić
obecne `baseQueries` + `nicheQueries`.

Algorytm:

1. Wybierz aktywne profile na podstawie `supplierTypes` z inputu (lub domyślnych).
2. Runda 1: dla każdego profilu odpal `baseQueries(region, productType)` przez Tavily.
   Limit: maks. 5 zapytań na profil w rundzie 1.
3. Runda 2: jeśli `accepted.length < count`, dla profili które przyniosły < 2 leadów odpal
   `nicheQueries`.
4. Runda 3 (opcjonalna, tylko jeśli `count >= 10`): zapytania z miastami z
   `REGION_TOKENS[region]` ([quality.ts:142-183](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L142-L183))
   per profil:
   - `hurtownia ${productType ?? 'spożywcza'} ${city} kontakt`
   - `producent ${productType ?? 'żywności'} ${city} kontakt`

5. Limit globalny: maks. 30 zapytań Tavily na cały run (twardy budżet, żeby nie eksplodować
   kosztów). Po przekroczeniu logować `discovery_query_budget_exceeded` i przerywać kolejne
   rundy.

6. Deduplikacja taka jak teraz, plus:
   - przy konflikcie tej samej domeny website między dwoma profilami zachować profil
     z wyższym confidence.

### 4.3. Prompt dla NotebookLM (klasyfikacja typu zamiast filtrowania na "producent")

Zmienić `discoveryQuestion` w [producer-hunt.ts:277-295](agentic-agents/src/mastra/workflows/producer-hunt.ts#L277-L295):

Główna zmiana: nie kazać modelowi pomijać "sklepów pośredniczących". Zamiast tego kazać
sklasyfikować każdą znalezioną firmę i zwrócić `supplierType` + `directToHoreca`.

Nowy prompt (skrócony — pełny w kodzie):

```text
Na podstawie załadowanych źródeł wypisz do ${count} firm z województwa ${region},
które mogą dostarczać żywność do restauracji w modelu B2B.

Akceptowane typy dostawcy (jeśli widzisz inny typ, użyj "unknown"):
- producer        – producent / wytwórca, gospodarstwo, manufaktura, RHD
- manufacturer    – większy zakład przetwórstwa
- cooperative     – kooperatywa / spółdzielnia
- producer_group  – grupa producencka / zrzeszenie hodowców
- wholesaler      – hurtownia spożywcza, hurtownia HoReCa, cash&carry
- distributor     – dystrybutor regionalny / krajowy do gastronomii
- importer        – importer specjalistyczny
- farm_aggregator – platforma agregująca rolników

Pomiń:
- portale ogłoszeniowe, katalogi firm, panoramafirm, gowork, pkt.pl
- duże sieci handlowe B2C (Biedronka, Lidl, Auchan, Tesco) — to nie są nasi klienci
- restauracje i hotele jako podmiot docelowy

Dla każdej firmy zwróć:
{
  "company": "...",
  "supplierType": "producer | manufacturer | cooperative | producer_group | wholesaler | distributor | importer | farm_aggregator | unknown",
  "directToHoreca": "yes | limited | no | unknown",
  "brandsOrPortfolio": ["..."],
  "servesRegions": ["..."],
  "email": null,
  "website": null,
  "city": "...",
  "productCategory": "...",
  "sourceUrls": ["..."],
  "emailSource": null,
  "isProducer": true,
  "confidence": 0.0-1.0,
  "reason": "1 zdanie: co konkretnie oferują i komu sprzedają"
}

Nie wpisuj "Brak danych" - używaj null. Zwróć WYŁĄCZNIE JSON: { "leads": [ ... ] }
```

Uwaga implementacyjna: pole `isProducer` zostawiamy w prompcie i schema dla wstecznej
kompatybilności scoringu, ale w nowym scoringu to pole już nie decyduje samo o akceptacji
(p. §6).

### 4.4. Fallback prompt po snippetach

Analogiczna zmiana w fallback prompcie [producer-hunt.ts:324-331](agentic-agents/src/mastra/workflows/producer-hunt.ts#L324-L331).
Wymusić zwracanie `supplierType` i `directToHoreca`. Bez tej zmiany fallback dalej będzie
producer-biased.

### 4.5. Filtr URL dla `topUrls`

Obecnie [producer-hunt.ts:246-248](agentic-agents/src/mastra/workflows/producer-hunt.ts#L246-L248)
odrzuca tylko social media. Po zmianie:

- nie odrzucać domen hurtowni i dystrybutorów (`hurtownia`, `gastropol`, etc.).
- nie odrzucać domen kooperatyw.
- dalej odrzucać Facebook/LinkedIn/Instagram dla NotebookLM (te się kiepsko indeksują).
- odrzucać dodatkowo: olx, allegro, ceneo, marketplaces, sieciowe sklepy detaliczne.

## 5. Enrichment dopasowany do typu

### 5.1. Multi-source research

Aktualnie [producer-hunt.ts:516-587](agentic-agents/src/mastra/workflows/producer-hunt.ts#L516-L587)
robi:

1. Tavily `findCompanyLinksTool` → website + linkedin + facebook + searchContext.
2. Jedno NotebookLM "deep" z jednej strony WWW.

To wystarczy producentowi rzemieślniczemu, ale nie hurtowni (która ma 10 podstron asortymentu
i często cennik PDF). Zmiana:

Wprowadzić `enrichmentPlan(supplierType, lead)` który zwraca listę źródeł do dodania do
NotebookLM:

- `producer` / `manufacturer`:
  - `${website}/o-nas`, `${website}/produkty`, `${website}/aktualnosci`, `${website}/kontakt`.
  - jeśli `lead.facebook`/`lead.linkedIn` — można dodać jako URL, ale często NotebookLM
    słabo indeksuje social, więc zostawić poza NLM i użyć tylko jako `searchContext`.

- `wholesaler`:
  - `${website}/asortyment`, `${website}/oferta`, `${website}/dla-gastronomii`,
    `${website}/horeca`, `${website}/cennik`, `${website}/kontakt`.
  - dodatkowe Tavily query: `"${company}" hurtownia HoReCa minimum zamówienia dostawa restauracje`.

- `distributor`:
  - `${website}/marki`, `${website}/portfolio`, `${website}/oferta`, `${website}/kontakt`.
  - dodatkowe Tavily query: `"${company}" dystrybutor marki regiony dostaw`.

- `cooperative` / `producer_group` / `farm_aggregator`:
  - `${website}/o-nas`, `${website}/czlonkowie`, `${website}/produkcja`, `${website}/aktualnosci`.
  - dodatkowe Tavily query: `"${company}" zrzeszenie ilu członków produkty`.

- `importer`:
  - `${website}/marki`, `${website}/portfolio`, `${website}/dla-gastronomii`.
  - dodatkowe Tavily query: `"${company}" import marek dystrybucja Polska kontakt`.

Implementacja: zamiast jednego `knowledgeAddSourceTool` ze stroną główną, dodać 3-4 podstrony
plus tekst kontekstu z Tavily. Limit: maks. 5 źródeł na lead, żeby nie zatkać NotebookLM.

Jeżeli podstrona zwraca 404, NotebookLM zignoruje — nie crashuje. Nie próbować pre-fetchować
po HTTP HEAD (zbędna złożoność).

### 5.2. Pytanie do NotebookLM per typ

Zastąpić jeden generyczny `researchQuestion` ([producer-hunt.ts:561-569](agentic-agents/src/mastra/workflows/producer-hunt.ts#L561-L569))
funkcją `researchQuestionFor(supplierType, lead)`:

Producer / manufacturer:

```text
Co konkretnie wytwarza firma "${company}"?
1. Lista produktów lub kategorii (sery, wędliny, pieczywo, soki, przetwory, ...).
2. Skala produkcji (rzemieślnicza / średnia / przemysłowa).
3. Certyfikaty (Produkt Lokalny, RHD, Bio, ISO, BRC/IFS).
4. Tradycja / historia / wartości (rodzina, eko, naturalne).

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, konkretne odniesienie do ich produktu lub historii.
- DEEP_ANALYSIS: 4-6 zdań o tym, co produkują, dla kogo i co GastroBridge może im zaproponować.
```

Wholesaler:

```text
Co oferuje hurtownia "${company}"?
1. Główne kategorie asortymentu (mięso, nabiał, warzywa, owoce, mrożonki, suchy magazyn, ...).
2. Marki własne i marki obce w portfolio.
3. Czy obsługują HoReCa (restauracje, hotele, catering)? Czy wymagają minimum zamówienia?
4. Zasięg dostaw (jakie województwa / miasta).

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, odniesienie do ich oferty HoReCa lub konkretnej marki.
- DEEP_ANALYSIS: 4-6 zdań o portfolio, zasięgu i tym, jak GastroBridge może im pomóc skrócić łańcuch dostaw albo dotrzeć do nowych restauracji.
```

Distributor:

```text
Co dystrybuuje firma "${company}"?
1. Marki w portfolio (5-10 najważniejszych).
2. Specjalizacja kategorii (np. włoska, kuchnia azjatycka, słodycze premium).
3. Region działania.
4. Czy są ekskluzywnym przedstawicielem jakichś marek?

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, max 20 słów, odwołanie do konkretnej marki z ich portfolio.
- DEEP_ANALYSIS: 4-6 zdań o ich pozycji rynkowej i tym, czemu warto, żeby restauracje GastroBridge ich zauważyły.
```

Cooperative / producer_group / farm_aggregator:

```text
Czym jest "${company}"?
1. Ile gospodarstw / producentów zrzesza?
2. Jakie kategorie produktów reprezentują (warzywa, mięso, mleko, ...)?
3. Czy sprzedają zbiorczo, czy każdy członek osobno?
4. Czy obsługują HoReCa?

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, odniesienie do skali zrzeszenia lub regionu.
- DEEP_ANALYSIS: 4-6 zdań o strukturze i potencjale współpracy z GastroBridge.
```

Importer:

```text
Co importuje firma "${company}"?
1. Marki / kraje pochodzenia produktów.
2. Specjalizacja kulinarna (włoska, francuska, hiszpańska, azjatycka, ...).
3. Czy mają wyłączność na jakieś marki?
4. Czy obsługują restauracje fine dining / casual / sieciowe?

Na tej podstawie:
- PERSONALIZATION_HOOK: 1 zdanie, odniesienie do ich konkretnej marki lub regionu kuchni.
- DEEP_ANALYSIS: 4-6 zdań o ich portfolio i wartości dla restauracji.
```

### 5.3. Final-LLM enrichment prompt

Plik [producer-hunt.ts:591-621](agentic-agents/src/mastra/workflows/producer-hunt.ts#L591-L621).

Zmienić "Dokończ research firmy" tak, żeby:

- przyjmował `supplierType` z discovery (lub `unknown`),
- pytał o pola dopasowane do typu,
- zwracał (oprócz dotychczasowych pól) potwierdzony `supplierType`, `directToHoreca`,
  `brandsOrPortfolio`, `servesRegions`,
- nie wymuszał frazy "lokalny producent" w hooku.

Nowy `enrichmentResponseSchema`:

```ts
const enrichmentResponseSchema = z.object({
  companyName: z.string().optional().nullable(),
  supplierType: supplierTypeSchema.optional(),
  directToHoreca: directToHorecaSchema.optional(),
  brandsOrPortfolio: z.array(z.string()).optional().default([]),
  servesRegions: z.array(z.string()).optional().default([]),
  personalizationHook: z.string().min(5),
  rawAnalysis: z.union([
    z.string(),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
  ]).optional(),
  website: z.string().optional().nullable(),
  linkedIn: z.string().optional().nullable(),
  facebook: z.string().optional().nullable(),
  identityConfidence: z.number().min(0).max(1).optional(),
  identityWarning: z.string().optional(),
});
```

Fallback hook ([producer-hunt.ts:634](agentic-agents/src/mastra/workflows/producer-hunt.ts#L634), [producer-hunt.ts:648](agentic-agents/src/mastra/workflows/producer-hunt.ts#L648), [producer-hunt.ts:664](agentic-agents/src/mastra/workflows/producer-hunt.ts#L664)) zmienić z `Producent żywności z regionu ${region}` na funkcję per typ:

```ts
function defaultHookForType(supplierType: SupplierType, region: string): string {
  switch (supplierType) {
    case 'wholesaler':       return `Hurtownia spożywcza z regionu ${region}.`;
    case 'distributor':      return `Dystrybutor żywności obsługujący ${region}.`;
    case 'importer':         return `Importer specjalistyczny w regionie ${region}.`;
    case 'cooperative':
    case 'producer_group':   return `Zrzeszenie producentów z regionu ${region}.`;
    case 'farm_aggregator':  return `Platforma producentów z regionu ${region}.`;
    case 'manufacturer':     return `Zakład przetwórstwa z regionu ${region}.`;
    default:                 return `Producent żywności z regionu ${region}.`;
  }
}
```

Tej samej funkcji używać w identity-mismatch reset ([producer-hunt.ts:664](agentic-agents/src/mastra/workflows/producer-hunt.ts#L664)).

### 5.4. NotebookLM market context per typ

[producer-hunt.ts:496-508](agentic-agents/src/mastra/workflows/producer-hunt.ts#L496-L508) odpytuje
notatnik `rynek` o "lokalnych producentów". Zmienić pytanie na neutralne:

```text
Jakie są najważniejsze trendy i wyzwania dla dostawców żywności (producentów, hurtowni,
dystrybutorów) obsługujących HoReCa w regionie ${region}?
```

Dzięki temu kontekst rynkowy nie jest stronniczy w kierunku tylko producentów.

## 6. Scoring i decyzja per typ

Plik [quality.ts](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts).

### 6.1. Nowe zestawy słów kluczowych

Dodać:

```ts
const WHOLESALE_KEYWORDS = [
  'hurt', 'hurtow', 'cash and carry', 'cash&carry',
  'b2b', 'dla gastronomii', 'dla horeca', 'horeca',
  'sprzedaz hurtowa', 'oferta dla restauracji',
];

const DISTRIBUTION_KEYWORDS = [
  'dystrybut', 'dostawca do restauracji', 'dostawca do gastronomii',
  'dostawy do horeca', 'sprzedaz do gastronomii', 'foodservice',
];

const IMPORTER_KEYWORDS = [
  'import', 'importer', 'wylaczny przedstawiciel', 'wlosk', 'hiszpansk',
  'francusk', 'azjatyck', 'sprowadzamy',
];

const COOPERATIVE_KEYWORDS = [
  'spoldziel', 'kooperaty', 'grupa producenck', 'zrzeszenie',
  'lokalna inicjatywa', 'platforma producentow',
];
```

### 6.2. Funkcja `inferSupplierType`

Nowa funkcja (w `quality.ts`):

```ts
export function inferSupplierType(
  lead: LeadForScoring,
  declared?: SupplierType | null,
): SupplierType {
  // 1. zaufaj klasyfikacji modelu, ale tylko jeśli mamy potwierdzenia w treści.
  if (declared && declared !== 'unknown') {
    if (textConfirms(lead, declared)) return declared;
  }
  // 2. heurystyka po słowach kluczowych w reason/rawAnalysis/company/website.
  const text = aggregatedText(lead);
  if (hasAny(text, WHOLESALE_KEYWORDS))     return 'wholesaler';
  if (hasAny(text, DISTRIBUTION_KEYWORDS))  return 'distributor';
  if (hasAny(text, IMPORTER_KEYWORDS))      return 'importer';
  if (hasAny(text, COOPERATIVE_KEYWORDS))   return text.includes('grupa producenck') || text.includes('zrzeszenie')
    ? 'producer_group'
    : 'cooperative';
  if (hasAny(text, PRODUCTION_KEYWORDS))    return 'producer';
  return 'unknown';
}
```

Funkcja `textConfirms` sprawdza, czy w aggregowanym tekście są keywordy odpowiadające
deklarowanemu typowi. Jeśli nie, traktować deklarację jako niepotwierdzoną.

### 6.3. Scoring zależny od typu

Zmiana w `scoreLead`:

1. Najpierw `supplierType = inferSupplierType(lead, lead.supplierType)`.
2. Bonus `+15` za sygnały produkcji liczy się tylko dla `producer | manufacturer`.
   Dla pozostałych typów premiować ich własne sygnały (`+15` za `WHOLESALE_KEYWORDS`
   przy `wholesaler`, etc.).
3. Penalty `-15: brak jasnego sygnału produkcji/wytwórstwa` ([quality.ts:362](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L362))
   ma się odpalać tylko jeśli `supplierType ∈ {producer, manufacturer}`.
4. Penalty `-50: oznaczone jako nie-producent` ([quality.ts:367](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L367))
   usunąć. Zamiast tego: `-50` jeśli `supplierType === 'unknown'` po heurystyce
   i jednocześnie nie ma `directToHoreca === 'yes'`.
5. Dodać bonus `+15` za `directToHoreca === 'yes'` (każdy typ).
6. Dodać `-30` za "to jest restauracja/hotel" — nowy keyword set `END_CONSUMER_KEYWORDS`
   (`restauracja`, `hotel`, `pizzeria`, `bistro`, `kawiarnia`, `pub`). Jeśli tekst
   jest zdominowany przez te słowa i brak sygnałów dostawcy, lead odpada.
7. Dodać `-25` za "to jest sieć handlowa B2C" — nowy keyword set
   (`biedronka`, `lidl`, `auchan`, `tesco`, `kaufland`, `carrefour`).
8. Dodać kara `-20` jeśli `supplierType === 'wholesaler'` ale `directToHoreca === 'no'`.
   Hurtownia, która nie sprzedaje do gastronomii, nie jest klientem GastroBridge.

Progi decyzji można zostawić (`>=55: draft_candidate`, `>=25: research_needed`).

Zwracać też:

```ts
type LeadQuality = {
  score: number;
  decision: 'draft_candidate' | 'research_needed' | 'reject';
  reasons: string[];
  inferredSupplierType: SupplierType;  // NOWE
};
```

### 6.4. Identity guardrail

[quality.ts:388-425](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L388-L425).
Dwie zmiany:

1. Bonus tolerancji dla hurtowni: jeśli `supplierType === 'wholesaler' | 'distributor'`,
   nie penalizować `-0.6` za niezgodność domeny website z domeną emaila — duże hurtownie
   często mają oddzielne domeny CRM-owe / portalowe / b2b.
2. Sprawdzenie, że `enriched.supplierType` nie jest "obce". Jeśli model zaklasyfikował
   hurtownię jako `producer`, ale heurystyka pokazuje `wholesaler`, to identity warning,
   ale nie blokada — tylko `confidence -= 0.2`.

## 7. Workflow path: krok `create-research-leads`

Plik [producer-hunt.ts:376-471](agentic-agents/src/mastra/workflows/producer-hunt.ts#L376-L471).

1. Po `scoreLead` ustawić `lead.supplierType = quality.inferredSupplierType`, żeby
   przekazać dalej do enrichmentu.
2. Filtr `supplierTypes` z inputu workflow:
   - jeśli `inferredSupplierType` poza listą akceptowalnych, decyzja `reject`,
     reason `'reject: supplierType not in acceptable list'`.
3. Update CRM: `segment` zamiast hardcoded `'producer'` ustawiać na
   `mapToCrmSegment(inferredSupplierType)`:
   ```ts
   function mapToCrmSegment(type: SupplierType): string {
     switch (type) {
       case 'wholesaler':       return 'wholesaler';
       case 'distributor':      return 'distributor';
       case 'importer':         return 'importer';
       case 'cooperative':
       case 'producer_group':   return 'cooperative';
       case 'farm_aggregator':  return 'aggregator';
       case 'manufacturer':     return 'manufacturer';
       case 'producer':         return 'producer';
       default:                 return 'unknown';
     }
   }
   ```
4. Zapisać do `metadata.supplierType`, `metadata.directToHoreca`, `metadata.brandsOrPortfolio`,
   `metadata.servesRegions`.

W `update-crm` ([producer-hunt.ts:1099-1129](agentic-agents/src/mastra/workflows/producer-hunt.ts#L1099-L1129))
analogicznie zamienić `segment: 'producer'`.

## 8. Workflow path: krok `draft-cold-emails`

Plik [producer-hunt.ts:847-960](agentic-agents/src/mastra/workflows/producer-hunt.ts#L847-L960).

### 8.1. Per-type prompt

Wymienić obecny prompt ([producer-hunt.ts:879-907](agentic-agents/src/mastra/workflows/producer-hunt.ts#L879-L907)) na funkcję `draftPromptFor(supplierType, lead, region)`. Zasady wspólne (RODO, GastroBridge,
180 słów, brak emoji) zostają. Specyficzne fragmenty per typ:

- producer / manufacturer: jak teraz — "Wasze produkty", "rzemiosło", "tradycja".
- wholesaler: "Wasz portfel marek", "asortyment HoReCa", "skrócenie łańcucha do restauracji
  bez kosztu pozyskania klienta".
- distributor: "marki w Waszym portfolio", "wzmocnienie pozycji w segmencie restauracji".
- cooperative / producer_group / farm_aggregator: "Wasi członkowie", "lokalni producenci".
- importer: "Wasze marki sprowadzane z [kraj]", "fine dining".

### 8.2. `validateDraft` — tolerancja dla typu

Plik [quality.ts:427-462](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L427-L462).

1. Nie wymagać słowa "produkt" / "wytwarzacie" w bodyw — to było producentowo zorientowane.
   Dodać softWarning, jeśli body nie zawiera ani jednego z keywordów `[produkty, asortyment,
   portfolio, marki, oferta, dostarczacie, dystrybuujecie, importujecie, członkowie]`.
2. Reszta hard rules (RODO, GastroBridge, brak placeholderów) bez zmian.
3. Soft check `analysisWords` ([quality.ts:452-455](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts#L452-L455))
   dalej działa.

### 8.3. `fallbackDraft` per typ

Funkcja `fallbackDraft` w [producer-hunt.ts:874-877](agentic-agents/src/mastra/workflows/producer-hunt.ts#L874-L877)
ma jeden szablon. Wprowadzić warianty per typ. Wszystkie wciąż mają stopkę RODO i wzmiankę
GastroBridge, ale różny otwierający akapit.

## 9. Cleanup, logi, deduplikacja

### 9.1. Logi

W każdym kroku dodawać do logów `supplierType` i `inferredSupplierType` (gdzie ma sens).
Jeśli plan v2 wprowadzi `logProducerHuntEvent` (krok 6 z v2), v3 dorzuca po prostu te pola
do payloadu — nie tworzymy drugiej infrastruktury logowania.

Per krok minimum:

- `discover-leads`: `bySupplierType` (record `<SupplierType, number>`).
- `create-research-leads`: `acceptedByType`, `rejectedByType`, `unknownType`.
- `enrich-leads`: `enrichedByType`, `identityWarningsByType`.
- `draft-cold-emails`: `draftedByType`, `failedByType`.

### 9.2. Deduplikacja po typie

[producer-hunt.ts:355-368](agentic-agents/src/mastra/workflows/producer-hunt.ts#L355-L368)
dedupes po nazwie firmy lub domenie email. Zostawić, ale dorzucić exception:

- jeśli dwa rekordy mają tę samą domenę website, ale różny `supplierType`, łączyć w jeden
  rekord (preferować typ z wyższym confidence). Powód: hurtownia może mieć oficjalny dział
  produkcji i pojawić się dwa razy.

## 10. Konfiguracja modeli

Plik [workflow-models.ts](agentic-agents/src/mastra/config/workflow-models.ts).

Bez zmian. Dotychczasowe `producerHunt.discovery / enrichment / draftEmail` są wystarczające
dla nowej logiki — zmiana jest po stronie promptów i schematów, nie modeli.

Ale: rekomendowane podniesienie modelu `enrichment` na `googleFlash` lub `openaiPro`, jeśli
budżet pozwala. Klasyfikacja `supplierType` na podstawie wielu źródeł jest wyraźnie trudniejsza
niż dotychczasowy enrichment producenta i lokalny model będzie częściej dawać `unknown`.

Decyzja "kiedy podnieść" pozostaje po stronie ownera workflow — w PR tylko zostawić komentarz
w configu.

## 11. Plan wdrożenia (PR-y)

### PR A — model danych + scoring (najmniejsze ryzyko)

Zakres:

- Dodać `supplierTypeSchema`, `directToHorecaSchema` w `producer-hunt.ts`.
- Rozszerzyć `leadSchema` i `enrichedLeadSchema` o nowe pola.
- W `quality.ts`: nowe keyword sets, `inferSupplierType`, scoring per typ.
- Zmiana `LeadQuality` o pole `inferredSupplierType`.
- Mapowanie `inferredSupplierType` na `segment` CRM w `create-research-leads` i `update-crm`.
- Brak zmian promptów dyskrecyjnie.

Efekt:

- Nawet jeśli nic w discovery się nie zmienia, hurtownie/dystrybutorzy które mimo wszystko
  trafią do leadów (np. przez fallback Tavily) nie są już automatycznie odrzucani.
- W metadata leadów pojawia się typ.

Ryzyko: niskie. Funkcje są dodawane, scoring zostaje wstecznie kompatybilny dla typów
producenckich.

### PR B — discovery profile + multi-round queries

Zakres:

- Plik `discovery-queries.ts` z profilami.
- Wymiana `baseQueries` + `nicheQueries` na multi-profile loop.
- Filtry URL: dopuszczenie domen hurtowni i dystrybutorów, blokada B2C marketplaces.
- Limit budżetu zapytań.

Efekt:

- Tavily wraca z prawdziwie różnorodnymi linkami, nie tylko gospodarstwo/manufaktura.

Ryzyko: średnie. Zwiększa koszt Tavily — twardy budżet 30 zapytań na run.

### PR C — discovery prompt z klasyfikacją

Zakres:

- `discoveryQuestion` (NotebookLM) z `supplierType` i `directToHoreca`.
- Fallback prompt z tymi samymi polami.
- Walidacja w schema.

Efekt:

- Lead już z discovery ma `supplierType`. PR A może na nim polegać.

Ryzyko: średnie. Lokalny model częściej będzie się mylił przy klasyfikacji — wymaga
testowania na 5-10 przebiegach z różnymi regionami.

### PR D — enrichment dopasowany do typu

Zakres:

- `enrichmentPlan(supplierType, lead)` z multi-source.
- `researchQuestionFor(supplierType, lead)`.
- Nowy `enrichmentResponseSchema`.
- `defaultHookForType` zamiast hardcoded "Producent żywności".
- Identity guardrail zaktualizowany dla hurtowni.
- Pytanie do notatnika `rynek` neutralne.

Efekt:

- `rawAnalysis` i `personalizationHook` dopasowane do typu, bez frazy "Wasze produkty"
  dla hurtowni.

Ryzyko: średnie. Najwięcej zmian w prompt engineering — wymaga manualnej weryfikacji
na 5 leadach producenckich + 5 hurtowniach.

### PR E — drafty per typ + CRM segment

Zakres:

- `draftPromptFor(supplierType, lead, region)`.
- `fallbackDraft` warianty per typ.
- `validateDraft` rozluźniony.
- `update-crm` pisze segment per typ.

Efekt:

- Drafty cold-mail nie wyglądają jak template producencki dla hurtowni.

Ryzyko: średnie. Zmienia ton pisanych maili — przed merge wymagane review przykładowych
draftów dla każdego typu.

## 12. Testy

### 12.1. Unit

- `inferSupplierType` na 20+ przykładach (po jednym przykładzie per typ + typowe pułapki:
  "hurtownia mięsa od producenta" — czyli hybryda).
- `scoreLead` dla każdego typu z 3 przypadkami: pewny, niepewny, odrzucony.
- `mapToCrmSegment` na pełnym enum.

### 12.2. Integracyjne / manualne

Testowe inputy:

```json
{ "region": "śląskie", "count": 8 }
{ "region": "mazowieckie", "count": 8, "productType": "warzywa" }
{ "region": "wielkopolskie", "count": 6, "supplierTypes": ["wholesaler", "distributor"] }
{ "region": "małopolskie", "count": 5, "supplierTypes": ["producer", "cooperative"] }
```

Oczekiwane:

- Run 1: `bySupplierType` w discovery zawiera co najmniej 2 typy.
- Run 2: leady mają poprawnie sklasyfikowane warzywa od grup producenckich i hurtowni.
- Run 3: workflow nie generuje draftów dla typów spoza listy `supplierTypes`.
- Run 4: workflow nie generuje draftów dla hurtowni mimo że Tavily je znalazł.

Diagnostyka:

```js
db.leads.find({ "metadata.taskId": "..." }, {
  companyName: 1, segment: 1,
  "metadata.supplierType": 1, "metadata.directToHoreca": 1,
  "metadata.qualityDecision": 1, "metadata.qualityScore": 1,
});
```

Sprawdzić rozkład typów. Cel: po wdrożeniu v3 minimum 30% leadów to typy inne niż
`producer/manufacturer`, kiedy `supplierTypes` jest domyślne.

### 12.3. Regresja producencka

Bardzo ważne: workflow nadal musi działać tak dobrze jak wcześniej dla producentów. Test
regresji:

- Run identyczny do tego sprzed v3 (`region: "śląskie", count: 5`) — porównać liczbę
  draftów producenckich. Cel: nie spaść poniżej dotychczasowego poziomu (raport z runu
  `mazowieckie/warzywa/5` z planu v2: 3 drafty).

## 13. Zakres poza v3

Świadomie zostaje na później:

- Integracja z REGON/KRS (publiczne API GUS) dla potwierdzenia tożsamości firmy. To dawałoby
  silny identity-check, ale wymaga osobnej tooli i ma swoje rate limity.
- Specjalizowana baza domen HoReCa (Selgros, Eurocash, Bidfood, Iglotex itd.) jako "graf
  klientów" zamiast pojedynczego scrapingu — to oddzielny projekt.
- Per-type approval flow w UI dashboardu — można dodać po PR E, jeśli okaże się że typy
  mają różną gotowość draftów.

## 14. Notatki dla implementującego

1. Nie zmieniać kontraktu inputu workflow w PR A. `supplierTypes` dochodzi dopiero z PR C
   (kiedy classification ma sens).
2. PR A ma być self-contained: nawet bez nowych promptów heurystyka klasyfikuje stare leady
   i nie psuje regresu producenckiego.
3. W kazdym PR dodawać krótki test manualny w `scratch/` (jak `test-hunt.ts`), uruchamiany
   przez `tsx`, na 1 leadzie modelowym dla każdego typu.
4. Nie dotykać `producer-hunt-fix-v2.md` checklisty — ten plan ją uzupełnia, nie zastępuje.
   Ścieżki "P0/P1/P2" z v2 (draft fallback, validate-output, multi-round, regex email,
   logi, NLM cleanup) są ortogonalne do v3 i mogą wejść w dowolnej kolejności względem v3.
5. Po PR C przejrzeć runy w UI Mastry i sprawdzić, czy `supplierType: 'unknown'` nie jest
   większością. Jeśli tak — model prawdopodobnie wymaga doprecyzowania promptu lub upgrade'u.
6. Nie podmieniać nazwy workflow ("producer-hunt") nawet po rozszerzeniu zakresu — koszt
   migracji historii i CRM-u przewyższa zysk z nazewnictwa. Nazwa w opisie i UI może być
   "Supplier Hunt", ale ID workflow zostaje.
