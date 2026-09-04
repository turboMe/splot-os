# Content Intelligence: RSS/n8n -> weekly-content

Data planu: 2026-05-06.

Cel: wzbogacic workflow `weekly-content` o swieze, przetworzone sygnaly z n8n/RSS, bez utraty kontroli nad zrodlami, deduplikacja i historia uzycia. Baza danych ma byc operacyjnym source of truth, a NotebookLM ma pelnic role kuratorskiej pamieci dlugoterminowej.

## 1. Stan obecny

### Mastra ma ogolna integracje n8n

- `src/mastra/tools/n8n/client.ts` zawiera klienta REST do n8n:
  - `listWorkflows()`
  - `getWorkflow()`
  - `createWorkflow()`
  - `updateWorkflow()`
  - `activateWorkflow()`
  - `deactivateWorkflow()`
  - `triggerWebhook()`
  - `getExecutions()`
- `src/mastra/tools/n8n/n8n-tools.ts` wystawia narzedzia:
  - `n8n.trigger`
  - `n8n.health`
  - `n8n.list_workflows`
  - `n8n.get_workflow`
  - `n8n.update_workflow`
  - `n8n.activate_workflow`
  - `n8n.deactivate_workflow`
- `metaAgent` moze odkryc narzedzia n8n przez `ToolSearchProcessor`.
- `automationArchitect` ma narzedzia n8n bezposrednio w swoim toolsetcie.

### Mastra ma wzorce RSS/n8n, ale nie mapowanie na istniejace workflowy

W `src/mastra/tools/architect/pattern-catalog.ts` sa wzorce:

- `rss-keyword-to-telegram`
- `rss-ollama-classifier-to-telegram`
- `rss-dedup-memory-telegram`

To sa szablony/generatory workflowow, nie dowod, ze trzy istniejace automatyzacje z konta n8n sa juz zaimportowane, znane lub nazwane w Mastrze.

### Potwierdzono widocznosc trzech automatyzacji RSS w n8n

W `.env` sa ustawione zmienne n8n:

- `N8N_URL`
- `N8N_BASE_URL`
- `N8N_API_KEY`
- `N8N_WEBHOOK_URL`

Pierwsza proba odczytu `/api/v1/workflows` po zaladowaniu `.env` nie powiodla sie, bo aktualny endpoint `127.0.0.1:5678` odrzucal polaczenie (`ECONNREFUSED`). Przyczyna: kontenery nie byly uruchomione. Po starcie `af-mongodb` i `af-n8n` z `../jarvis-dashboard-agent/docker-compose.yml` endpoint `http://localhost:5678/healthz` zwrocil `200 {"status":"ok"}`.

W `../docker-compose.yml` dla Mastry jest tylko MongoDB. Nie ma tam serwisu n8n. Lokalny n8n jest w starym Jarvisie jako kontener `af-n8n` w `network_mode: host`.

Ikona desktopowa `Mastra.desktop` uruchamia `/home/linus/Pulpit/Mastra.sh`. Skrypt zostal zaktualizowany 2026-05-06 tak, zeby przed startem `pnpm dev` uruchamial `mongodb` i `n8n` z `../jarvis-dashboard-agent/docker-compose.yml`, czekal na `http://localhost:5678/healthz`, a dopiero potem startowal Mastra Studio.

Potwierdzone workflowy:

| workflowId | name | active | trigger | Mongo collections |
| --- | --- | --- | --- | --- |
| `ylMngWCWKhiSxvi2` | `RSS-Collector` | tak | schedule | `rss_articles` |
| `4kQsYYy6T8pCHnqv` | `rss-ai-processor` | tak | schedule | `rss_articles` |
| `XFsZplJGu8OSRFnQ` | `RSS-Weekly-Digest` | tak | schedule + manual | `rss_articles`, `digests` |

Aktualny stan MongoDB:

- baza: `rss_intelligence`
- `rss_articles`: 858 dokumentow
- `digests`: 3 dokumenty
- `rss_sources`: 0 dokumentow
- `rss_articles.processed = true`: 42 dokumenty
- `rss_articles.processed = false`: 816 dokumentow

Aktualne zrodla w `RSS-Collector`:

- `horecatrends.pl`
- `thespoon.tech`
- `wiadomoscihandlowe.pl`
- `agfundernews.com`
- `restaurantnews.com`
- `modernrestaurantmanagement.com`

Rozklad dokumentow pokazuje, ze to byl proof of concept, nie finalny korpus:

- `thespoon.tech`: 500 artykulow, 0 przetworzonych
- `wiadomoscihandlowe.pl`: 175 artykulow, 30 przetworzonych
- `restaurantnews.com`: 87 artykulow, 8 przetworzonych
- `agfundernews.com`: 61 artykulow, 0 przetworzonych
- `modernrestaurantmanagement.com`: 22 artykuly, 4 przetworzone
- `horecatrends.pl`: 13 artykulow, 0 przetworzonych

Wniosek: pipeline istnieje i zbiera/przetwarza dane, ale wymaga normalizacji, wiekszej liczby polskich zrodel, fair processingu per zrodlo oraz bezposredniego podpiecia pod `weekly-content`.

Uwaga jakosciowa: `digests` zawiera dwa puste dokumenty i jeden poprawny briefing tygodniowy. Workflow digestu trzeba traktowac jako eksperymentalny do czasu walidacji outputu przed zapisem.

## 2. Decyzja architektoniczna

Nie ladujemy kazdego newsa do NotebookLM.

Robimy:

1. **MongoDB / rss_intelligence** jako operacyjny source of truth.
2. **Adapter `freshSignals`** czyta obecne `rss_articles`, z mozliwoscia pozniejszej migracji do `content_signals`.
3. **weekly-content** pobiera top sygnaly deterministycznie z bazy.
4. **NotebookLM** dostaje opcjonalny tygodniowy digest najlepszych sygnalow, a nie pelny strumien RSS.

Powody:

- baza pozwala filtrowac po dacie, tagach, zrodle, score i statusie uzycia,
- mozemy oznaczac sygnaly jako `used` i nie powtarzac ich w postach,
- mozemy debugowac, dlaczego dany sygnal wszedl lub nie wszedl do contentu,
- NotebookLM jest dobre do kontekstu i syntezy, ale slabsze jako kolejka operacyjna i dedup store.

## 3. Docelowy flow

```text
n8n RSS workflows
  -> rss_sources registry
  -> rss_articles collection
  -> local LLM processing
  -> content_signals/freshSignals adapter
  -> weekly-content fresh signal query
  -> NotebookLM query_multi rynek/rhd/konkurencja/founder
  -> research synthesis
  -> PL/EN post generation
  -> mark selected signals as used
  -> weekly digest to NotebookLM (optional)
```

## 4. Kolekcje RSS i `content_signals`

### 4.1. Najszybszy wariant: adapter na obecne `rss_articles`

Obecne dokumenty `rss_articles` maja juz pola wystarczajace do pierwszego podpiecia:

- `title`
- `link`
- `source`
- `pubDate`
- `description`
- `summary_ai`
- `tags_ai`
- `relevance_score`
- `category`
- `processed`

Pierwszy krok wdrozenia nie musi tworzyc nowej kolekcji. Mozna dodac narzedzie `content.signals.search`, ktore mapuje `rss_articles` na wewnetrzny format `FreshContentSignal`.

Minimalne kryteria:

- `processed: true`
- `summary_ai` istnieje i ma sensowna dlugosc
- `relevance_score >= 6` przy obecnej skali 0-10
- preferuj ostatnie 7-21 dni
- ogranicz dominacje jednego zrodla przez limit per source
- preferuj polskie zrodla, ale zostaw wybrane sygnaly globalne, jezeli dobrze pasuja do GastroBridge

### 4.2. Docelowy wariant: `content_signals`

Proponowany dokument:

```ts
{
  id: string;
  externalId?: string;
  url: string;
  canonicalUrl?: string;
  sourceName: string;
  feedUrl?: string;
  title: string;
  publishedAt?: Date;
  collectedAt: Date;
  processedAt: Date;

  rawExcerpt?: string;
  llmSummary: string;
  whyItMatters: string;
  horecaImpact?: string;
  producerAngle?: string;
  restaurantAngle?: string;
  gastrobridgeAngle?: string;
  suggestedHooks: string[];

  tags: string[];
  entities: string[];
  region?: string;
  competitors?: string[];

  scores: {
    relevance: number;   // 0..1, dopasowanie do GastroBridge
    novelty: number;     // 0..1, czy wnosi cos nowego
    confidence: number;  // 0..1, jak mocne sa zrodla
  };

  status: 'new' | 'selected' | 'used' | 'rejected' | 'archived';
  usedInDraftIds: string[];
  usedAt?: Date;
  rejectionReason?: string;

  sourceCitations: string[];

  notebookSync?: {
    syncedAt?: Date;
    notebook?: string;
    sourceId?: string;
  };
}
```

Indeksy:

- `{ url: 1 }` unique sparse
- `{ canonicalUrl: 1 }` sparse
- `{ publishedAt: -1 }`
- `{ status: 1, publishedAt: -1 }`
- `{ tags: 1, publishedAt: -1 }`
- `{ 'scores.relevance': -1, publishedAt: -1 }`

## 5. Rejestr zrodel RSS

Obecny `RSS-Collector` ma osobne node'y RSS dla kazdego feeda. To wystarcza do testu, ale nie bedzie dobre przy duzej liczbie polskich zrodel.

Docelowo zrodla powinny byc w `rss_sources` albo w repo jako wersjonowany plik konfiguracyjny, np. `config/rss-sources.json`. Poniewaz kolekcja `rss_sources` juz istnieje, najczystszy kierunek to wypelnic ja i przebudowac collector tak, zeby iterowal po aktywnych zrodlach.

Proponowany dokument `rss_sources`:

```ts
{
  id: string;
  name: string;
  feedUrl: string;
  siteUrl?: string;
  language: 'pl' | 'en' | 'de' | 'other';
  country?: string;
  category:
    | 'horeca'
    | 'foodservice'
    | 'fmcg'
    | 'retail'
    | 'restaurant_ops'
    | 'foodtech'
    | 'startup'
    | 'regulation'
    | 'supply_chain'
    | 'competitor'
    | 'producer';
  priority: number; // 1..5
  enabled: boolean;
  tags: string[];
  lastFetchedAt?: Date;
  lastSuccessAt?: Date;
  errorCount: number;
}
```

Zasady skalowania polskich zrodel:

- polskie zrodla HoReCa/foodservice maja najwyzszy priorytet dla `weekly-content`,
- zrodla FMCG/retail sa wazne, ale nie moga zdominowac tematyki restauracyjnej,
- globalne foodtech/restaurant tech zostaja jako inspiracja, nie jako glowny korpus,
- kazde zrodlo ma limit dzienny/tygodniowy, zeby jeden feed nie zalal bazy,
- `rss-ai-processor` powinien wybierac batch przez mieszanke `priority`, `publishedAt`, `processed=false` i limit per source,
- jesli feed nie ma dobrego RSS, osobno decydujemy czy robimy scraping, czy pomijamy zrodlo.

Kategorie polskich zrodel do dodania:

- HoReCa i gastronomia: portale branzowe, wydarzenia, wywiady, trendy menu i operacji restauracyjnych.
- Handel/FMCG: hurt, retail, private label, ceny, promocje, konsolidacja, zachowania zakupowe.
- Foodservice i dystrybucja: dostawcy, hurtownie, logistyka, cold chain, marketplace'y B2B.
- Producenci lokalni i regionalizacja: regionalne marki, produkty, certyfikaty, krotkie lancuchy dostaw.
- Regulacje i dane publiczne: GIS, UOKiK, MRiRW, GUS, prawo pracy, podatki, sanepid, odpady/opakowania.
- Startupy/foodtech/AI: automatyzacja kuchni, POS, ordering, inventory, pricing, analityka.

## 6. Narzedzia Mastry do dodania

Nowy modul: `src/mastra/tools/content-intelligence/content-signals.ts`.

Narzedzia:

1. `content.signals.search`
   - input: `fromDays`, `tags`, `minRelevance`, `limit`, `excludeUsed`
   - output: lista sygnalow gotowych do research promptu.

2. `content.signals.mark_used`
   - input: `signalIds`, `draftIds`, `taskId`
   - output: liczba zaktualizowanych sygnalow.

3. `content.signals.create`
   - input: pojedynczy przetworzony signal z n8n.
   - uzycie: opcjonalnie, jesli n8n bedzie wolal endpoint/API Mastry zamiast pisac bezposrednio do Mongo.

4. `content.signals.weekly_digest`
   - input: `weekStarting`, `limit`
   - output: markdown/text do importu do NotebookLM.

## 7. Integracja z `weekly-content`

Kolejny krok w workflow:

1. Przed `queryCoreNotebooks()` pobrac `freshSignals`:
   - ostatnie 7-14 dni,
   - `processed = true`,
   - `relevance_score >= 6` dla adaptera `rss_articles` albo `scores.relevance >= 0.65` dla `content_signals`,
   - jeszcze nieuzyte w draftach,
   - tagi: `horeca`, `rhd`, `producer`, `restaurant`, `competitor`, `pricing`.

2. W `research-week` dodac sekcje:

```md
# Fresh Content Signals From RSS/n8n
- title
- publishedAt
- sourceName
- llmSummary
- whyItMatters
- producerAngle
- restaurantAngle
- gastrobridgeAngle
- sourceCitations
```

3. W promptach dodac zasade:
   - sygnaly z bazy sa preferowanym zrodlem swiezosci,
   - NotebookLM jest zrodlem kontekstu, regulacji, founder voice i walidacji domenowej,
   - jesli sygnal nie ma citation/source URL, nie wolno uzywac go jako faktu liczbowego.

4. Po zapisie draftow:
   - zmapowac wykorzystane sygnaly na drafty,
   - oznaczyc je jako `used`,
   - dopisac `usedInDraftIds`.

## 8. Integracja z n8n

### Minimalny wariant

n8n zapisuje bezposrednio do MongoDB `rss_articles`, a Mastra mapuje je przez adapter `freshSignals`.

Plusy:

- najszybsze wdrozenie,
- nie wymaga nowego endpointu HTTP w Mastrze,
- pasuje do obecnego sposobu, w ktorym n8n/RSS juz pracuje na bazie.

Minusy:

- walidacja schematu jest po stronie n8n,
- wieksze ryzyko niespojnych pol,
- trzeba pilnowac credentials Mongo w n8n.
- docelowo trzeba przeniesc zarzadzanie zrodlami z recznych node'ow RSS do `rss_sources`.

### Docelowy wariant

n8n wysyla przetworzony signal do endpointu Mastry/AgentForge, a Mastra waliduje Zodem i zapisuje do MongoDB jako `content_signals`.

Plusy:

- jedno miejsce walidacji,
- latwiejsze wersjonowanie schematu,
- mniej ryzyka zepsucia kolekcji przez workflow n8n,
- mozna od razu liczyc dedup/canonical URL/scoring po stronie aplikacji.

Minusy:

- trzeba dodac endpoint lub lekki ingestion server, bo obecnie repo nie ma dedykowanych API routes dla takiego ingressu.

## 9. NotebookLM sync

Nie syncowac kazdego wpisu.

Raz w tygodniu:

1. Wybrac top 15-30 `content_signals`:
   - wysoki relevance,
   - wysoki confidence,
   - nieodrzucone,
   - najlepiej te, ktore weszly do content planningu.
2. Zbudowac tekst:
   - tytul,
   - zrodlo,
   - link,
   - podsumowanie,
   - angle dla producenta/restauratora,
   - wnioski dla GastroBridge.
3. Dodac do dedykowanego notebooka, np. `horeca_signals` albo `content_intelligence`.
4. W `weekly-content` docelowo mozna dodac ten notebook do query, ale uwazac na limit `knowledge.query_multi` max 4 notebooki. Alternatywa: zostawic `freshSignals` z DB jako osobna sekcja i nie zwiekszac liczby notebookow.

## 10. Etapy wdrozenia

### Etap 0 - potwierdzic n8n

- Status: wykonane 2026-05-06 po starcie kontenerow Jarvisa.
- n8n dziala pod `http://localhost:5678`.
- Znaleziono 3 aktywne workflowy RSS:
  - `RSS-Collector`
  - `rss-ai-processor`
  - `RSS-Weekly-Digest`
- Potwierdzono baze `rss_intelligence`.

### Etap 1 - uporzadkowac RSS DB i obecny adapter

- Ujednolicic nazwy kolekcji:
  - obecnie `rss-tools.ts` uzywa `digests`,
  - `init-db.ts` tworzy `rss_digests`.
- Ustalic, czy RSS ma byc w `agentforge`, czy `rss_intelligence`.
- Poprawic `RssService`, zeby nie czytal z innej bazy niz n8n zapisuje.
- Dodac adapter `rss_articles -> FreshContentSignal`, zeby `weekly-content` mogl korzystac z danych zanim powstanie finalne `content_signals`.
- Dodac walidacje digestu, zeby nie zapisywac pustych dokumentow do `digests`.

### Etap 2 - rozszerzyc polskie zrodla

- Wypelnic `rss_sources` lista polskich zrodel.
- Przebudowac `RSS-Collector`, zeby czytal aktywne zrodla z `rss_sources` zamiast utrzymywac osobne node'y per feed.
- Dodac limity per source i priorytety, zeby feedy globalne nie dominowaly polskiego kontekstu.
- Poprawic `rss-ai-processor`, zeby przerabial batch sprawiedliwie po zrodlach i priorytetach.

### Etap 3 - dodac `content_signals`

- Dodac indeksy w `init-db.ts`.
- Dodac service + tools `content.signals.*`.
- Dodac test/fixture dla search/mark_used.

### Etap 4 - wpiac `weekly-content`

- Pobierac `freshSignals` przed NotebookLM.
- Dopisac `freshSignals` do outputu `research-week`.
- Przekazac sygnaly do promptu researchu.
- Po `save-drafts` oznaczac wykorzystane sygnaly jako `used`.

### Etap 5 - sync do NotebookLM

- Dodac helper/workflow `content-signals-weekly-digest`.
- Generowac digest z top sygnalow.
- Dodawac digest jako text source do notebooka `content_intelligence`.

### Etap 6 - observability

- W draft metadata zapisywac:
  - `sourceSignalIds`,
  - `sourceUrls`,
  - `freshSignalsUsed`.
- W docs utrzymywac zasade: DB = freshness, NotebookLM = context.

## 11. Definition of done

- Agenci widza workflowy n8n przez `n8n.list_workflows`, gdy n8n API jest online.
- Trzy RSS automatyzacje sa opisane w repo albo zapisane w konfiguracji jako znane external workflows.
- `content_signals` ma indeksy i walidowany zapis.
- `weekly-content` uzywa `freshSignals` z bazy i nadal uzywa NotebookLM.
- Drafty nie tylko nie powtarzaja poprzednich tematow, ale tez nie powtarzaja uzytych RSS sygnalow.
- Tygodniowy digest moze byc dodany do NotebookLM bez zalewania go surowym RSS.
