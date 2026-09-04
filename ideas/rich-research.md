# Rich research dla weekly-content

Cel: kazdy run `weekly-content` ma zaczynac od mocnego, aktualnego researchu z cytowalnymi zrodlami, a workflow ma zatrzymac sie lub oznaczyc run jako `needs_research`, jezeli research jest za slaby. To ma usunac obecny efekt, w ktorym generator tworzy krotkie, generyczne posty na podstawie pustych hookow typu `no-current-source`.

## 1. Wniosek po sprawdzeniu stanu

Obecne workflowy n8n sa dobrym szkieletem, ale nie sa wystarczajace. Samo podpiecie wiekszej liczby polskich zrodel nie wystarczy.

Potwierdzony stan:

- n8n dziala lokalnie i ma aktywne workflowy `RSS-Collector`, `rss-ai-processor`, `RSS-Weekly-Digest`.
- n8n zapisuje RSS do bazy `rss_intelligence`.
- narzedzia RSS po stronie Mastry czytaja obecnie przez `getDb()`, czyli baze `agentforge`, gdzie kolekcje RSS sa puste.
- `rss_intelligence.rss_articles` ma ok. 867 artykulow, ale tylko ok. 42 sa przetworzone przez AI.
- `rss-ai-processor` ma harmonogram miesieczny, wiec backlog praktycznie nie znika.
- obecny feed `https://www.horecatrends.pl/rss/serwis_rss_1910.xml` jest zly/stary dla tego celu.
- w runie `weekly-content-7537400e` research mial `sourceCitations: []`, `source: no-current-source` i bledy NotebookLM o niezaimportowanych zrodlach.
- finalne drafty w filesystemie sa takie same jak w trace, nie ma bogatszej wersji w bazie.

Decyzja architektoniczna: zostawic `rss_intelligence` jako operacyjna baze content intelligence i podpiac Mastra bezposrednio do niej przez `getRssDb()`. Nie rozpraszac danych RSS miedzy `agentforge` i `rss_intelligence`.

## 2. Docelowy przeplyw

```text
RSS feeds
  -> n8n collector
  -> rss_intelligence.rss_articles
  -> n8n AI processor
  -> rss_intelligence.content_signals
  -> Mastra freshSignals service/tools
  -> weekly-content research-week
  -> quality gate
  -> generate-pl / translate-en / save-drafts
```

NotebookLM zostaje jako pamiec dlugoterminowa i zrodlo kontekstowe, ale nie moze byc jedynym zrodlem aktualnych hookow. Dla contentu tygodniowego swieze sygnaly z bazy maja byc pierwszym, deterministycznym inputem.

## 3. Plan krok po kroku

### Krok 1 - zrobic backup i nie ruszac aktywnego n8n w ciemno

1. Wyeksportowac obecne workflowy n8n: `RSS-Collector`, `rss-ai-processor`, `RSS-Weekly-Digest`.
2. Zaimportowac nowy workflow `RSS-Content-Intelligence-v2` jako nieaktywny.
3. Uruchomic go recznie i sprawdzic zapis w Mongo.
4. Dopiero po walidacji wylaczyc lub ograniczyc stare workflowy.

### Krok 2 - ustalic jedna baze operacyjna

1. `rss_intelligence` zostaje baza dla RSS i sygnalow.
2. W Mastrze narzedzia RSS i adapter `weekly-content` maja uzywac `getRssDb()`.
3. Nie inicjalizowac pustych kolekcji RSS w `agentforge` jako produkcyjnego source of truth.

Do poprawy w kodzie:

- `src/mastra/tools/rss/rss-tools.ts` powinien czytac z `getRssDb()`.
- `weekly-content` powinien pobierac `freshSignals` z `rss_intelligence.content_signals` albo tymczasowo z adaptera `rss_articles -> FreshContentSignal`.
- `init-db.ts` powinien jasno rozdzielac kolekcje aplikacyjne od `rss_intelligence`, zeby nie tworzyc falszywego poczucia, ze RSS sa w `agentforge`.

### Krok 3 - dodac indeksy

Minimalne indeksy:

```js
db.rss_articles.createIndex({ guid: 1 }, { unique: true });
db.rss_articles.createIndex({ processed: 1, sourcePriority: -1, publishedAt: -1 });
db.rss_articles.createIndex({ source: 1, publishedAt: -1 });
db.rss_articles.createIndex({ canonicalUrl: 1 });

db.content_signals.createIndex({ signalId: 1 }, { unique: true });
db.content_signals.createIndex({ "scores.relevance": -1, publishedAt: -1 });
db.content_signals.createIndex({ language: 1, country: 1, publishedAt: -1 });
db.content_signals.createIndex({ usedInTasks: 1 });
db.content_signals.createIndex({ source: 1, publishedAt: -1 });

db.research_runs.createIndex({ taskId: 1 }, { unique: true });
db.research_runs.createIndex({ weekDate: -1 });
```

### Krok 4 - podmienic i rozszerzyc zrodla

Obecne zrodla do zachowania:

- `https://www.wiadomoscihandlowe.pl/feed`
- `https://agfundernews.com/feed`
- `https://restaurantnews.com/feed`
- `https://modernrestaurantmanagement.com/feed`

Zrodlo do wyrzucenia lub zastapienia:

- `https://www.horecatrends.pl/rss/serwis_rss_1910.xml` - zbyt waskie/stare.

Zweryfikowane polskie feedy do dodania:

- `https://www.horecatrends.pl/rss/informacje.xml`
- `https://www.horecatrends.pl/rss/gastronomia.xml`
- `https://www.horecatrends.pl/rss/dostawcy.xml`
- `https://www.horecatrends.pl/rss/trendy.xml`
- `https://www.portalspozywczy.pl/rss/portalspozywczy.xml`
- `https://www.portalspozywczy.pl/rss/mleko.xml`
- `https://www.portalspozywczy.pl/rss/mieso.xml`
- `https://www.portalspozywczy.pl/rss/owoce-warzywa.xml`
- `https://www.portalspozywczy.pl/rss/handel.xml`
- `https://www.portalspozywczy.pl/rss/technologie.xml`
- `https://www.portalspozywczy.pl/rss/logistyka.xml`
- `https://www.dlahandlu.pl/rss/nowoczesny.xml`
- `https://www.dlahandlu.pl/rss/gastronomia.xml`
- `https://www.dlahandlu.pl/rss/e-commerce.xml`
- `https://www.farmer.pl/fragments/rss/rss000.xml`
- `https://www.farmer.pl/rss/produkcjazwierzeca.xml`
- `https://www.farmer.pl/rss/srodkiprodukcji.xml`
- `https://www.farmer.pl/rss/energia.xml`
- `https://www.farmer.pl/rss/biznes.xml`
- `https://www.horecanet.pl/feed/`
- `https://poradnikhandlowca.com.pl/feed/`

Priorytet dla `weekly-content`: polskie HoReCa, handel, foodservice, dostawcy, logistyka, ceny zywnosci, rolnictwo/surowce. Zrodla globalne maja uzupelniac trendy technologiczne, ale nie dominowac polskiego contentu.

### Krok 5 - przerobic collector

Collector ma:

1. Czytac zrodla z `rss_sources` albo z Code node jako fallback.
2. Normalizowac URL do `canonicalUrl`.
3. Deduplikowac po `guid` i `canonicalUrl`.
4. Zapisywac `publishedAt` jako date/ISO, nie tylko tekst `pubDate`.
5. Dopisywac `sourcePriority`, `sourceTags`, `language`, `country`, `category`.
6. Nie oznaczac artykulu jako przetworzonego przy samym zebraniu.

### Krok 6 - przerobic AI processor

AI processor ma:

1. Uruchamiac sie co 1-2 godziny, nie miesiecznie.
2. Brac batch np. 60 artykulow, sortowany po `sourcePriority desc`, `publishedAt desc`.
3. Pilnowac fair processingu, zeby jeden feed nie zapychal calego batcha.
4. Zwracac strukture JSON, nie luzny opis.
5. Zapisywac wynik w `rss_articles` oraz osobny dokument w `content_signals`.

Model:

- dla klasyfikacji i ekstrakcji mozna zostawic lokalny Ollama, ale prompt musi wymuszac JSON-only;
- jesli `gemma4:26b` jest wolny, mozna uzyc mniejszego modelu do pierwszego passu, ale finalny `content_signals` musi miec `confidence_score` i `relevance_score`.

### Krok 7 - dodac `content_signals`

`content_signals` to gotowy input dla Mastry. Nie powinno sie zmuszac `weekly-content` do interpretowania surowych RSS.

Minimalny dokument:

```ts
type ContentSignal = {
  signalId: string;
  guid: string;
  title: string;
  canonicalUrl: string;
  source: string;
  sourceName: string;
  publishedAt: string;
  collectedAt: string;
  processedAt: string;
  language: "pl" | "en";
  country: string;
  category: string;
  summary: string;
  whyItMatters: string;
  tags: string[];
  contentAngles: string[];
  hooks: Array<{
    hook: string;
    bestFor: "linkedin-personal" | "linkedin-company" | "instagram";
    angle: string;
  }>;
  scores: {
    relevance: number;
    confidence: number;
    novelty: number;
  };
  usedInTasks: string[];
};
```

### Krok 8 - dodac adapter w Mastrze

Proponowany kontrakt dla `weekly-content`:

```ts
type FreshContentSignal = {
  id: string;
  title: string;
  sourceName: string;
  url: string;
  publishedAt: string;
  summary: string;
  whyItMatters: string;
  tags: string[];
  bestAngles: string[];
  hooks: Array<{
    hook: string;
    bestFor: "linkedin-personal" | "linkedin-company" | "instagram";
    angle: string;
  }>;
  score: number;
};
```

Narzedzia/service:

- `content.signals.search({ weekDate, language, limit, minRelevance, excludeUsed })`
- `content.signals.markUsed({ taskId, signalIds })`
- `content.signals.weeklyDigest({ weekDate })`

### Krok 9 - dodac quality gate przed generowaniem

`research-week` nie moze przejsc dalej, jezeli research jest pusty lub generyczny.

Minimalne wymagania:

- min. 6 swiezych sygnalow lacznie;
- min. 4 sygnaly PL;
- min. 3 rozne zrodla;
- min. 3 sygnaly z ostatnich 14 dni;
- min. 3 cytowalne URL-e;
- zadne `newsHooks[].source` nie moze byc `no-current-source`;
- max 2 sygnaly z jednego zrodla w finalnym secie;
- sredni `relevance >= 0.65` albo `relevance_score >= 6`;
- jezeli NotebookLM zwraca blad pending import, zapisac diagnostyke i nie udawac, ze research jest aktualny.

Zachowanie przy porazce:

1. sprobowac dociagnac wiecej sygnalow z `rss_articles`;
2. jezeli nadal slabo, zakonczyc `research-week` statusem `needs_research`;
3. nie generowac draftow z placeholderow.

### Krok 10 - dodac artifact researchu

Dla kazdego runu zapisac `research_runs`:

```ts
type ResearchRun = {
  taskId: string;
  weekDate: string;
  createdAt: string;
  selectedSignalIds: string[];
  rejectedSignalIds: string[];
  sourceCoverage: Record<string, number>;
  diagnostics: string[];
  quality: {
    passed: boolean;
    score: number;
    reasons: string[];
  };
};
```

To pozwoli pozniej szybko odpowiedziec, czy dany run mial dobry research i z jakich zrodel korzystal.

### Krok 11 - dopiero potem poprawic copy gate

Krotkie LinkedIn posty to osobny problem walidacji. Po research gate trzeba dodac enforcement:

- LinkedIn PL personal/company: docelowo 1000-2000 znakow;
- LinkedIn EN: np. 900-1800 znakow;
- Instagram: osobne limity i format;
- walidacja Zodem albo runtime validator po `generate-pl`;
- jezeli model zwroci za krotkie LI, nie zapisujemy draftu, tylko robimy repair z konkretnym powodem.

## 4. JSON n8n - RSS-Content-Intelligence-v2

To jest docelowy szkielet importu. Importowac jako inactive, ustawic credential MongoDB na baze `rss_intelligence`, przetestowac recznie, dopiero potem aktywowac.

Uwaga praktyczna: w niektorych wersjach n8n `RSS Feed Read` przy dynamicznym URL nie przenosi pelnego kontekstu z input itemu. Ten JSON inferuje zrodlo po domenie/linku. Jezeli w testach pairing bedzie slaby, trzeba wygenerowac statyczne node'y RSS per zrodlo z `rss_sources`, tak jak w obecnym collectorze, ale z poprawiona lista feedow.

```json
{
  "name": "RSS-Content-Intelligence-v2",
  "active": false,
  "nodes": [
    {
      "parameters": {},
      "id": "manual-trigger",
      "name": "Manual Trigger",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [-1260, -120]
    },
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "hours",
              "hoursInterval": 6
            }
          ]
        }
      },
      "id": "schedule-trigger",
      "name": "Every 6 Hours",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [-1260, 100]
    },
    {
      "parameters": {
        "jsCode": "const now = new Date().toISOString(); const sources = [{key:'horecatrends-info',name:'HorecaTrends - informacje',feedUrl:'https://www.horecatrends.pl/rss/informacje.xml',domain:'horecatrends.pl',category:'horeca',language:'pl',country:'PL',priority:95,tags:['horeca','gastronomia','trendy']},{key:'horecatrends-gastro',name:'HorecaTrends - gastronomia',feedUrl:'https://www.horecatrends.pl/rss/gastronomia.xml',domain:'horecatrends.pl',category:'horeca',language:'pl',country:'PL',priority:100,tags:['horeca','gastronomia']},{key:'horecatrends-dostawcy',name:'HorecaTrends - dostawcy',feedUrl:'https://www.horecatrends.pl/rss/dostawcy.xml',domain:'horecatrends.pl',category:'suppliers',language:'pl',country:'PL',priority:100,tags:['dostawcy','horeca']},{key:'horecatrends-trendy',name:'HorecaTrends - trendy',feedUrl:'https://www.horecatrends.pl/rss/trendy.xml',domain:'horecatrends.pl',category:'trends',language:'pl',country:'PL',priority:90,tags:['trendy','horeca']},{key:'wiadomoscihandlowe',name:'Wiadomosci Handlowe',feedUrl:'https://www.wiadomoscihandlowe.pl/feed',domain:'wiadomoscihandlowe.pl',category:'retail',language:'pl',country:'PL',priority:80,tags:['handel','fmcg']},{key:'portalspozywczy-main',name:'Portal Spozywczy',feedUrl:'https://www.portalspozywczy.pl/rss/portalspozywczy.xml',domain:'portalspozywczy.pl',category:'food-industry',language:'pl',country:'PL',priority:85,tags:['spozywka','produkcja']},{key:'portalspozywczy-mieso',name:'Portal Spozywczy - mieso',feedUrl:'https://www.portalspozywczy.pl/rss/mieso.xml',domain:'portalspozywczy.pl',category:'meat',language:'pl',country:'PL',priority:90,tags:['mieso','surowce']},{key:'portalspozywczy-mleko',name:'Portal Spozywczy - mleko',feedUrl:'https://www.portalspozywczy.pl/rss/mleko.xml',domain:'portalspozywczy.pl',category:'dairy',language:'pl',country:'PL',priority:90,tags:['nabial','surowce']},{key:'portalspozywczy-warzywa',name:'Portal Spozywczy - owoce i warzywa',feedUrl:'https://www.portalspozywczy.pl/rss/owoce-warzywa.xml',domain:'portalspozywczy.pl',category:'produce',language:'pl',country:'PL',priority:90,tags:['warzywa','owoce','surowce']},{key:'portalspozywczy-handel',name:'Portal Spozywczy - handel',feedUrl:'https://www.portalspozywczy.pl/rss/handel.xml',domain:'portalspozywczy.pl',category:'retail',language:'pl',country:'PL',priority:75,tags:['handel','fmcg']},{key:'portalspozywczy-tech',name:'Portal Spozywczy - technologie',feedUrl:'https://www.portalspozywczy.pl/rss/technologie.xml',domain:'portalspozywczy.pl',category:'technology',language:'pl',country:'PL',priority:75,tags:['technologie','foodtech']},{key:'portalspozywczy-logistyka',name:'Portal Spozywczy - logistyka',feedUrl:'https://www.portalspozywczy.pl/rss/logistyka.xml',domain:'portalspozywczy.pl',category:'logistics',language:'pl',country:'PL',priority:85,tags:['logistyka','dostawy']},{key:'dlahandlu-nowoczesny',name:'DlaHandlu - handel nowoczesny',feedUrl:'https://www.dlahandlu.pl/rss/nowoczesny.xml',domain:'dlahandlu.pl',category:'retail',language:'pl',country:'PL',priority:70,tags:['handel','retail']},{key:'dlahandlu-gastro',name:'DlaHandlu - gastronomia',feedUrl:'https://www.dlahandlu.pl/rss/gastronomia.xml',domain:'dlahandlu.pl',category:'horeca',language:'pl',country:'PL',priority:90,tags:['horeca','gastronomia']},{key:'dlahandlu-ecommerce',name:'DlaHandlu - e-commerce',feedUrl:'https://www.dlahandlu.pl/rss/e-commerce.xml',domain:'dlahandlu.pl',category:'ecommerce',language:'pl',country:'PL',priority:60,tags:['ecommerce','handel']},{key:'farmer-main',name:'Farmer',feedUrl:'https://www.farmer.pl/fragments/rss/rss000.xml',domain:'farmer.pl',category:'agriculture',language:'pl',country:'PL',priority:65,tags:['rolnictwo','surowce']},{key:'farmer-zwierzeta',name:'Farmer - produkcja zwierzeca',feedUrl:'https://www.farmer.pl/rss/produkcjazwierzeca.xml',domain:'farmer.pl',category:'agriculture',language:'pl',country:'PL',priority:80,tags:['mieso','nabial','surowce']},{key:'farmer-srodki',name:'Farmer - srodki produkcji',feedUrl:'https://www.farmer.pl/rss/srodkiprodukcji.xml',domain:'farmer.pl',category:'agriculture-inputs',language:'pl',country:'PL',priority:70,tags:['koszty','surowce']},{key:'farmer-energia',name:'Farmer - energia',feedUrl:'https://www.farmer.pl/rss/energia.xml',domain:'farmer.pl',category:'energy',language:'pl',country:'PL',priority:70,tags:['energia','koszty']},{key:'farmer-biznes',name:'Farmer - biznes',feedUrl:'https://www.farmer.pl/rss/biznes.xml',domain:'farmer.pl',category:'business',language:'pl',country:'PL',priority:60,tags:['biznes','rolnictwo']},{key:'horecanet',name:'Horecanet',feedUrl:'https://www.horecanet.pl/feed/',domain:'horecanet.pl',category:'horeca',language:'pl',country:'PL',priority:95,tags:['horeca','gastronomia']},{key:'poradnikhandlowca',name:'Poradnik Handlowca',feedUrl:'https://poradnikhandlowca.com.pl/feed/',domain:'poradnikhandlowca.com.pl',category:'retail',language:'pl',country:'PL',priority:65,tags:['handel','fmcg']},{key:'agfundernews',name:'AgFunderNews',feedUrl:'https://agfundernews.com/feed',domain:'agfundernews.com',category:'agtech',language:'en',country:'GLOBAL',priority:50,tags:['agtech','funding']},{key:'restaurantnews',name:'RestaurantNews',feedUrl:'https://restaurantnews.com/feed',domain:'restaurantnews.com',category:'restaurant',language:'en',country:'US',priority:45,tags:['restaurant','market']},{key:'modernrestaurantmanagement',name:'Modern Restaurant Management',feedUrl:'https://modernrestaurantmanagement.com/feed',domain:'modernrestaurantmanagement.com',category:'restaurant-management',language:'en',country:'US',priority:45,tags:['restaurant','management']}]; return sources.map((s,index)=>({json:{...s,index,loadedAt:now}}));"
      },
      "id": "source-registry",
      "name": "Source Registry",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [-980, 0]
    },
    {
      "parameters": {
        "url": "={{ $json.feedUrl }}",
        "options": {}
      },
      "id": "read-rss-feed",
      "name": "Read RSS Feed",
      "type": "n8n-nodes-base.rssFeedRead",
      "typeVersion": 1.1,
      "position": [-700, 0]
    },
    {
      "parameters": {
        "jsCode": "const now=new Date().toISOString(); const sources=[{key:'horecatrends',name:'HorecaTrends',domain:'horecatrends.pl',feedUrl:'https://www.horecatrends.pl/rss/gastronomia.xml',category:'horeca',language:'pl',country:'PL',priority:100,tags:['horeca','gastronomia']},{key:'wiadomoscihandlowe',name:'Wiadomosci Handlowe',domain:'wiadomoscihandlowe.pl',feedUrl:'https://www.wiadomoscihandlowe.pl/feed',category:'retail',language:'pl',country:'PL',priority:80,tags:['handel','fmcg']},{key:'portalspozywczy',name:'Portal Spozywczy',domain:'portalspozywczy.pl',feedUrl:'https://www.portalspozywczy.pl/rss/portalspozywczy.xml',category:'food-industry',language:'pl',country:'PL',priority:85,tags:['spozywka','surowce']},{key:'dlahandlu',name:'DlaHandlu',domain:'dlahandlu.pl',feedUrl:'https://www.dlahandlu.pl/rss/gastronomia.xml',category:'retail-horeca',language:'pl',country:'PL',priority:80,tags:['handel','horeca']},{key:'farmer',name:'Farmer',domain:'farmer.pl',feedUrl:'https://www.farmer.pl/fragments/rss/rss000.xml',category:'agriculture',language:'pl',country:'PL',priority:70,tags:['rolnictwo','surowce']},{key:'horecanet',name:'Horecanet',domain:'horecanet.pl',feedUrl:'https://www.horecanet.pl/feed/',category:'horeca',language:'pl',country:'PL',priority:95,tags:['horeca','gastronomia']},{key:'poradnikhandlowca',name:'Poradnik Handlowca',domain:'poradnikhandlowca.com.pl',feedUrl:'https://poradnikhandlowca.com.pl/feed/',category:'retail',language:'pl',country:'PL',priority:65,tags:['handel','fmcg']},{key:'agfundernews',name:'AgFunderNews',domain:'agfundernews.com',feedUrl:'https://agfundernews.com/feed',category:'agtech',language:'en',country:'GLOBAL',priority:50,tags:['agtech']},{key:'restaurantnews',name:'RestaurantNews',domain:'restaurantnews.com',feedUrl:'https://restaurantnews.com/feed',category:'restaurant',language:'en',country:'US',priority:45,tags:['restaurant']},{key:'modernrestaurantmanagement',name:'Modern Restaurant Management',domain:'modernrestaurantmanagement.com',feedUrl:'https://modernrestaurantmanagement.com/feed',category:'restaurant-management',language:'en',country:'US',priority:45,tags:['restaurant','management']}]; function clean(v){return String(v||'').replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim();} function canonical(u){try{const x=new URL(String(u||'')); x.hash=''; ['utm_source','utm_medium','utm_campaign','fbclid','gclid'].forEach(k=>x.searchParams.delete(k)); return x.toString();}catch{return String(u||'').trim();}} function hash(s){let h=0; for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i); h|=0;} return 'rss_'+Math.abs(h);} return items.map(item=>{const j=item.json||{}; const link=canonical(j.link||j.url||j.guid||''); const src=sources.find(s=>link.includes(s.domain))||sources[0]; const dt=new Date(j.isoDate||j.pubDate||j.pubdate||j.date||now); const publishedAt=isNaN(dt.getTime())?now:dt.toISOString(); return {json:{guid:hash(link||j.title||publishedAt),canonicalUrl:link,title:clean(j.title),link,pubDate:j.pubDate||j.isoDate||publishedAt,publishedAt,source:src.key,sourceName:src.name,feedUrl:src.feedUrl,category:src.category,language:src.language,country:src.country,description:clean(j.contentSnippet||j.content||j.description),processed:false,created_at:j.created_at||now,collectedAt:now,sourcePriority:src.priority,sourceTags:src.tags}}});"
      },
      "id": "normalize-articles",
      "name": "Normalize Articles",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [-420, 0]
    },
    {
      "parameters": {
        "operation": "update",
        "collection": "rss_articles",
        "updateKey": "guid",
        "fields": "guid,canonicalUrl,title,link,pubDate,publishedAt,source,sourceName,feedUrl,category,language,country,description,processed,created_at,collectedAt,sourcePriority,sourceTags",
        "options": {
          "upsert": true
        }
      },
      "id": "upsert-rss-articles",
      "name": "Upsert rss_articles",
      "type": "n8n-nodes-base.mongoDb",
      "typeVersion": 1.2,
      "position": [-140, 0],
      "credentials": {
        "mongoDb": {
          "id": "__MONGO_CREDENTIAL_ID__",
          "name": "MongoDB rss_intelligence"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "return [{json:{batchAt:new Date().toISOString()}}];"
      },
      "id": "collector-done",
      "name": "Collector Done",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [120, 0]
    },
    {
      "parameters": {
        "operation": "find",
        "collection": "rss_articles",
        "query": "={ \"processed\": false }",
        "limit": 60,
        "sort": "={ \"sourcePriority\": -1, \"publishedAt\": -1 }"
      },
      "id": "find-unprocessed",
      "name": "Find Unprocessed Articles",
      "type": "n8n-nodes-base.mongoDb",
      "typeVersion": 1.2,
      "position": [390, 0],
      "credentials": {
        "mongoDb": {
          "id": "__MONGO_CREDENTIAL_ID__",
          "name": "MongoDB rss_intelligence"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "return items.map(item=>{const a=item.json; const prompt='You classify RSS articles for a Polish HoReCa/FoodTech weekly content workflow. Return only valid JSON, no markdown. Score relevance for GastroBridge: B2B procurement, restaurants, suppliers, food prices, logistics, invoices, supply chain, foodservice technology. Required keys: guid,title,canonicalUrl,source,sourceName,publishedAt,summary_ai,why_it_matters,relevance_score,confidence_score,novelty_score,tags_ai,linkedin_angles,suggested_hooks,risk_flags. suggested_hooks must be an array of objects with hook,bestFor,angle where bestFor is linkedin-personal, linkedin-company, or instagram. Use relevance_score 0-10 and confidence_score/novelty_score 0-1. Article: '+JSON.stringify(a); return {json:{...a,prompt}};});"
      },
      "id": "build-ai-prompts",
      "name": "Build AI Prompts",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [660, 0]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://172.19.0.1:11434/api/generate",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { model: 'gemma4:26b', stream: false, options: { temperature: 0.2, num_predict: 900 }, prompt: $json.prompt } }}",
        "options": {
          "timeout": 120000
        }
      },
      "id": "ollama-analyze",
      "name": "Ollama Analyze Article",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [940, 0]
    },
    {
      "parameters": {
        "jsCode": "const now=new Date().toISOString(); return items.map(item=>{const raw=String(item.json.response||item.json.text||item.json.data?.response||''); let parsed={}; try{const start=raw.indexOf('{'); const end=raw.lastIndexOf('}'); parsed=start>=0&&end>start?JSON.parse(raw.slice(start,end+1)):{};}catch(e){parsed={parse_error:e.message};} const rel=Number(parsed.relevance_score||0); const conf=Number(parsed.confidence_score||0); const nov=Number(parsed.novelty_score||0); return {json:{guid:String(parsed.guid||item.json.guid||''),title:String(parsed.title||item.json.title||''),canonicalUrl:String(parsed.canonicalUrl||item.json.canonicalUrl||''),source:String(parsed.source||item.json.source||''),sourceName:String(parsed.sourceName||item.json.sourceName||''),publishedAt:String(parsed.publishedAt||item.json.publishedAt||now),summary_ai:String(parsed.summary_ai||''),why_it_matters:String(parsed.why_it_matters||''),relevance_score:rel,confidence_score:conf,novelty_score:nov,tags_ai:Array.isArray(parsed.tags_ai)?parsed.tags_ai:[],linkedin_angles:Array.isArray(parsed.linkedin_angles)?parsed.linkedin_angles:[],suggested_hooks:Array.isArray(parsed.suggested_hooks)?parsed.suggested_hooks:[],risk_flags:Array.isArray(parsed.risk_flags)?parsed.risk_flags:[],processed:true,processedAt:now,ai_parse_error:parsed.parse_error||null}}});"
      },
      "id": "parse-ai-result",
      "name": "Parse AI Result",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1220, 0]
    },
    {
      "parameters": {
        "operation": "update",
        "collection": "rss_articles",
        "updateKey": "guid",
        "fields": "guid,summary_ai,why_it_matters,relevance_score,confidence_score,novelty_score,tags_ai,linkedin_angles,suggested_hooks,risk_flags,processed,processedAt,ai_parse_error",
        "options": {
          "upsert": false
        }
      },
      "id": "update-article-ai",
      "name": "Update rss_articles AI Fields",
      "type": "n8n-nodes-base.mongoDb",
      "typeVersion": 1.2,
      "position": [1490, -100],
      "credentials": {
        "mongoDb": {
          "id": "__MONGO_CREDENTIAL_ID__",
          "name": "MongoDB rss_intelligence"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "const now=new Date().toISOString(); return items.filter(item=>Number(item.json.relevance_score||0)>=6 && Number(item.json.confidence_score||0)>=0.55 && item.json.canonicalUrl).map(item=>{const j=item.json; return {json:{signalId:'sig_'+j.guid,guid:j.guid,title:j.title,canonicalUrl:j.canonicalUrl,source:j.source,sourceName:j.sourceName,publishedAt:j.publishedAt,collectedAt:j.collectedAt||now,processedAt:j.processedAt||now,language:j.language||'pl',country:j.country||'PL',category:j.category||'unknown',summary:j.summary_ai,whyItMatters:j.why_it_matters,tags:j.tags_ai||[],contentAngles:j.linkedin_angles||[],hooks:j.suggested_hooks||[],scores:{relevance:Number(j.relevance_score||0)/10,confidence:Number(j.confidence_score||0),novelty:Number(j.novelty_score||0)},usedInTasks:[],createdAt:now,updatedAt:now}}});"
      },
      "id": "build-content-signals",
      "name": "Build content_signals",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1490, 100]
    },
    {
      "parameters": {
        "operation": "update",
        "collection": "content_signals",
        "updateKey": "signalId",
        "fields": "signalId,guid,title,canonicalUrl,source,sourceName,publishedAt,collectedAt,processedAt,language,country,category,summary,whyItMatters,tags,contentAngles,hooks,scores,usedInTasks,createdAt,updatedAt",
        "options": {
          "upsert": true
        }
      },
      "id": "upsert-content-signals",
      "name": "Upsert content_signals",
      "type": "n8n-nodes-base.mongoDb",
      "typeVersion": 1.2,
      "position": [1760, 100],
      "credentials": {
        "mongoDb": {
          "id": "__MONGO_CREDENTIAL_ID__",
          "name": "MongoDB rss_intelligence"
        }
      }
    }
  ],
  "connections": {
    "Manual Trigger": {
      "main": [
        [
          {
            "node": "Source Registry",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Every 6 Hours": {
      "main": [
        [
          {
            "node": "Source Registry",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Source Registry": {
      "main": [
        [
          {
            "node": "Read RSS Feed",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Read RSS Feed": {
      "main": [
        [
          {
            "node": "Normalize Articles",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Normalize Articles": {
      "main": [
        [
          {
            "node": "Upsert rss_articles",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Upsert rss_articles": {
      "main": [
        [
          {
            "node": "Collector Done",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Collector Done": {
      "main": [
        [
          {
            "node": "Find Unprocessed Articles",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Find Unprocessed Articles": {
      "main": [
        [
          {
            "node": "Build AI Prompts",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Build AI Prompts": {
      "main": [
        [
          {
            "node": "Ollama Analyze Article",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Ollama Analyze Article": {
      "main": [
        [
          {
            "node": "Parse AI Result",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Parse AI Result": {
      "main": [
        [
          {
            "node": "Update rss_articles AI Fields",
            "type": "main",
            "index": 0
          },
          {
            "node": "Build content_signals",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Build content_signals": {
      "main": [
        [
          {
            "node": "Upsert content_signals",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1",
    "saveManualExecutions": true,
    "saveDataErrorExecution": "all",
    "saveDataSuccessExecution": "all"
  },
  "pinData": {},
  "versionId": "draft-rich-research-v2",
  "meta": {
    "templateCredsSetupCompleted": false
  },
  "tags": [
    {
      "name": "rss"
    },
    {
      "name": "weekly-content"
    },
    {
      "name": "content-intelligence"
    }
  ]
}
```

## 5. Definition of done

1. `rss_intelligence.content_signals` ma min. 50 aktualnych sygnalow, w tym min. 25 PL.
2. Kazdy sygnal ma `canonicalUrl`, `summary`, `whyItMatters`, `hooks`, `scores`.
3. `weekly-content` zapisuje `research_runs` dla kazdego runu.
4. Run bez min. 6 dobrych sygnalow nie generuje draftow.
5. `research.output.sourceCitations` nie jest puste.
6. `newsHooks[].source` nie zawiera `no-current-source`.
7. Drafty LinkedIn przechodza osobny length/quality validator przed zapisem.
8. W trace widac, ktore `signalId` zostaly uzyte do kazdego posta.

## 6. Najkrotsza sciezka wdrozenia

1. Poprawic Mastra RSS tools na `getRssDb()`.
2. Dodac adapter `content_signals` z fallbackiem do obecnych `rss_articles`.
3. Dodac quality gate w `research-week`.
4. W n8n poprawic feedy i schedule AI processora.
5. Dopiero potem importowac pelne `RSS-Content-Intelligence-v2`.
6. Na koncu dodac validator dlugosci i bogactwa postow LinkedIn.

## 7. Status implementacji

Wdrozone w repo:

- `src/mastra/lib/content-signals.ts` - adapter `content_signals` plus fallback do obecnych `rss_articles`.
- `src/mastra/tools/rss/rss-tools.ts` - RSS tools czytaja teraz `rss_intelligence`, nie puste `agentforge`.
- `src/mastra/workflows/weekly-content.ts` - `research-week` pobiera `freshSignals`, zapisuje `research_runs`, ma strict quality gate i przekazuje wykorzystane sygnaly do `save-drafts`.
- `src/mastra/workflows/weekly-content.ts` - `generate-pl` ma dodatkowy repair/validator dlugosci LinkedIn.
- `src/mastra/lib/mongo.ts` i `src/mastra/scripts/init-db.ts` - indeksy RSS sa kierowane do `rss_intelligence`.
- `scratch/install-rich-research-n8n.mjs` - skrypt instalujacy/aktualizujacy workflow n8n z istniejacym credentialem Mongo.

Wdrozone w n8n:

- Utworzony i aktywowany workflow: `RSS-Content-Intelligence-v2`.
- ID workflowa: `r2BRW4botxo0hche`.
- Harmonogram: co 2 godziny.
- Mongo credential uzyty z istniejacych workflowow: `4LCohL9nB1UUU4qh` (`MongoDB account 2`).

Uwagi po wdrozeniu:

- API n8n w tej instalacji zwrocilo `405 POST method not allowed` dla recznego `/run`, wiec pierwszy przebieg trzeba odpalic z UI n8n albo poczekac na harmonogram.
- W momencie wdrozenia `rss_intelligence.content_signals` mialo `0` dokumentow, ale adapter fallbacku widzial 10 sygnalow z przetworzonych `rss_articles` dla tygodnia `2026-05-04`.
- Fallback mial za malo polskich zrodel, wiec strict quality gate moze celowo zatrzymac natychmiastowy run `weekly-content` do czasu, az nowy n8n przetworzy polskie feedy.
- `init-db` zatrzymuje sie obecnie na starym problemie `agentforge.shared_memory`: duplikaty `{ key: null }` blokuja unikalny indeks `key_1`. Indeksy `rss_intelligence` zostaly zalozone osobnym poleceniem.
