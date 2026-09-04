# Dashboard Operacyjny GastroBridge — Pełny Plan

> Wersja: 1.0 · Data: 2026-06-08 · Autor: opracowanie na bazie realnego stanu Mongo + kodu
> Plan napisany od zera, na podstawie inwentaryzacji danych — nie kontynuuje wcześniejszych szkiców.

---

## 0. Cel

Zbudować **jeden dashboard operacyjny, na którym Patryk pracuje codziennie**: przegląda to,
co wygenerowały agenty (leady, drafty emaili, posty social, menu), edytuje, zatwierdza i wysyła.
To NIE jest dashboard telemetrii agentów (ten już istnieje jako "Agent Evaluation Dashboard",
`dashboard/index.html` + route'y `/dashboard/*`). To osobny, biznesowy interfejs pracy.

Zasada przewodnia: **człowiek jest ostatnim krokiem pipeline'u agentowego** — agent przygotowuje,
człowiek akceptuje/edytuje/wysyła. Dashboard to "skrzynka zatwierdzeń" z pełnym kontekstem.

---

## 1. Źródła prawdy (stan faktyczny, zweryfikowany)

Dane są rozproszone w 3 magazynach. Dashboard musi je scalić:

### 1.1 MongoDB `agentforge` (host: `localhost:27017`, kontener `af-mongodb`, mongo:7)
- **`leads`** (156 dok.) — główny CRM. Schema NIEjednorodna, dwie kampanie:
  - **Producenci żywności (GastroBridge)**: scraping OLX. Pola `metadata.olx_*`
    (`olx_url`, `olx_title`, `olx_price`, `olx_city`, `olx_category_id`, `olx_description`,
    `olx_user_id`, `is_business`), `region`, `source` często pusty.
  - **automation-client-hunt** (54 dok.): `segment: "automation-prospect"`,
    `metadata.quality_score`, `metadata.use_case_idea`, `metadata.estimated_hours_saved`,
    `metadata.source_url`, `metadata.draft.{subject,gmailDraftId,createdAt}`.
  - Wspólne: `id` (string), `companyName`, `status`, `history[]` (timeline akcji:
    `{timestamp, action, description, agentId}`), `createdAt`, `updatedAt`, `lastInteractionAt`.
  - Niektóre mają też `email`, `contactName`, `phone`, `linkedIn`, `segment`, `tags[]`, `website`.
  - **Statusy (lejek)**: `research_needed` (27) → `research_enriched` (12) → `draft_gotowy` (117).
    Brak statusów "wysłane / odpowiedź / wygrane / przegrane" — do dodania.
  - **Źródła**: `(brak)` 101, `automation-client-hunt-strategy` 54, `olx_ryneczek` 1.
- **`crm/leads`** (1 dok.) — USZKODZONY (cały string trafił jako nazwa pola). Do usunięcia/zignorowania.
- **`conversations`** (9) — `{threadId, domain, messages[], updatedAt}`. Historia rozmów (Telegram/Gmail?).
- **`chef_projects`** (11), **`chef_menus`** (6), **`chef_recipes`** (2), **`chef_notes`** (3) —
  produkt generowania menu (osobna domena).
- **`drafts`** (0), **`inbox_drafts`** (0) — PUSTE. Przeznaczone na rejestr draftów, nigdy niezasilone.

### 1.2 MongoDB `rss_intelligence` (5.7 MB)
- **`rss_articles`** (4331) — surowy feed HoReCa: `{guid, category, title, description, link,
  source, pubDate, processed, relevance_score, summary_ai, tags_ai[]}`.
- **`content_signals`** (214) — PRZETWORZONE sygnały, gotowe paliwo do social:
  `{signalId, title, summary, whyItMatters, contentAngles[], hooks[]{hook,bestFor,angle},
  scores{relevance,confidence,novelty}, tags[], category, country, language, source,
  publishedAt, usedInTasks[]}`. `usedInTasks` pozwala odróżnić wykorzystane od świeżych.
- **`digests`** (5) — zagregowane przeglądy.

### 1.3 Filesystem — DraftsStore: `src/mastra/public/.drafts/`
Struktura: `.drafts/<YYYY-MM-DD>/<task>/<draftId>/{draft.md, draft.meta.json}`.
38 draftów, ostatni 2026-05-08 (pipeline stoi). Dwa typy:
- **cold-email** (19, task `producer-hunt-*`): meta = `{draftId, taskId, type:"cold-email",
  language, status, company, region, segment, enrichment{company,email,website,reason,
  rawAnalysis,personalizationHook}, gmailDraftId, createdAt, agentId, llm{}}`.
  Treść `draft.md` = pełny email (Do/Firma/Strona/Temat + body + stopka RODO).
- **weekly-content** (19, task `weekly-content-*`): `type` ∈ {`linkedin-post`,`instagram-caption`}.
  meta = `{draftId, taskId, type, language(pl/en), topic, hashtags[], charCount, rationale,
  imagePrompt, scheduledFor, weekStarting, createdAt, agentId, llm{}}`. Treść `draft.md` = post.

### 1.4 Gmail (zewnętrzne)
Drafty fizycznie istnieją też w Gmailu pod `gmailDraftId`. To kanał wysyłki.
Integracja przez istniejący Google OAuth (`/auth/google`, route'y już w `index.ts`).

---

## 2. Architektura

```
┌─────────────────────────────────────────────────────────────┐
│  FRONTEND (single-file HTML v1 → React v2)                    │
│  /workspace-ui  — serwowany przez Mastra                      │
│  Moduły: CRM Kanban | Content Studio | Outreach | Chef        │
└───────────────┬─────────────────────────────────────────────┘
                │ fetch JSON
┌───────────────▼─────────────────────────────────────────────┐
│  BACKEND API  (registerApiRoute w src/mastra/index.ts)        │
│  /api/leads, /api/content, /api/drafts, /api/chef, /api/stats │
│  Warstwa serwisów: WorkspaceService (mapper + agregacja)      │
└───┬───────────────┬───────────────────┬─────────────────────┘
    │               │                   │
┌───▼────┐   ┌──────▼──────┐   ┌────────▼────────┐
│ Mongo  │   │ Mongo       │   │ FS DraftsStore  │
│ agent  │   │ rss_intel   │   │ public/.drafts  │
│ forge  │   │             │   │                 │
└────────┘   └─────────────┘   └────────┬────────┘
                                         │ DraftRegistry sync
                                  ┌──────▼──────────┐
                                  │ agentforge.drafts│ (indeks)
                                  └──────────────────┘
```

**Decyzje architektoniczne:**
- **Hostujemy w istniejącym serwerze Mastra** (`localhost:4111`), tak jak `/dashboard-ui`.
  Zero nowego procesu, zero nowego portu. Route'y przez `registerApiRoute` z `@mastra/core/server`.
- **Mongo = źródło prawdy dla metadanych; FS = źródło prawdy dla treści draftów.**
  Rejestr `agentforge.drafts` to indeks (cache) FS, nie duplikat treści.
- **Normalizacja przez mapper w API, nie migracja danych.** Surowy `leads` zostaje;
  `WorkspaceService.normalizeLead()` produkuje spójny kształt dla frontu. Nieinwazyjne, odwracalne.
- **v1 single-file HTML** (jak istniejący dashboard — Chart.js z CDN, zero build-stepu),
  bo szybko i spójnie z resztą. **v2 React** gdy API się ustabilizuje i UI urośnie.

---

## 3. Model danych — kontrakt znormalizowany (output API)

### 3.1 Lead (znormalizowany)
```ts
type WorkspaceLead = {
  id: string;
  companyName: string;
  segment: 'gastro-producer' | 'automation-prospect' | 'other';
  status: LeadStatus;            // patrz 3.2
  source: string | null;
  region: string | null;
  contact: { email?: string; phone?: string; name?: string; linkedIn?: string; website?: string };
  // Pola specyficzne — zachowane pod `details` zależnie od segmentu:
  details: {
    olx?: { url; title; price; city; categoryId; isBusiness; description };
    automation?: { qualityScore; useCaseIdea; estimatedHoursSaved; sourceUrl };
  };
  draft?: { gmailDraftId?: string; subject?: string; localDraftId?: string };
  history: Array<{ timestamp; action; description; agentId }>;
  tags: string[];
  createdAt; updatedAt; lastInteractionAt;
};
```

### 3.2 Lejek statusów (rozszerzony — kolumny Kanban)
Obecne dane: `research_needed`, `research_enriched`, `draft_gotowy`.
Docelowy lejek (mapowanie wstecznie kompatybilne):
```
new → research_needed → research_enriched → draft_gotowy → sent → replied → won | lost | parked
```
Stare statusy mapują się 1:1 na pierwsze trzy/cztery kolumny. Nowe (`sent`, `replied`,
`won`, `lost`, `parked`) dodajemy przy akcjach w dashboardzie.

### 3.3 Draft (znormalizowany, z rejestru)
```ts
type WorkspaceDraft = {
  draftId: string;
  taskId: string;
  channel: 'email' | 'linkedin' | 'instagram';
  type: 'cold-email' | 'linkedin-post' | 'instagram-caption';
  language: 'pl' | 'en';
  status: 'draft' | 'approved' | 'scheduled' | 'sent' | 'discarded';
  title: string;                 // topic | subject | company
  body: string;                  // z draft.md
  charCount: number;
  limit: number;                 // limit platformy (patrz 5.2)
  meta: Record<string, unknown>; // pełne draft.meta.json
  gmailDraftId?: string;
  scheduledFor?: string;         // tylko social
  imagePrompt?: string;          // tylko social
  enrichment?: object;           // tylko cold-email
  filePath: string;
  createdAt; updatedAt;
};
```

### 3.4 ContentSignal (passthrough z `content_signals`, lekko spłaszczony)
Bez transformacji — front konsumuje wprost `hooks`, `contentAngles`, `scores`, `whyItMatters`.
Flaga `used = usedInTasks.length > 0`.

---

## 4. Backend API

Wszystko jako `registerApiRoute` w `src/mastra/index.ts`, logika w nowym
`src/mastra/services/workspace-service.ts` + `draft-registry.ts`.

### 4.1 CRM
| Metoda | Ścieżka | Opis |
|---|---|---|
| GET | `/api/leads` | lista znormalizowana; query: `?status=&segment=&source=&region=&q=&limit=&skip=` |
| GET | `/api/leads/:id` | szczegóły + dołączony draft (z rejestru po `gmailDraftId`/match) |
| PATCH | `/api/leads/:id` | zmiana `status`, `tags`; każda zmiana dopisuje wpis do `history[]` |
| POST | `/api/leads/:id/note` | dopisanie notatki do `history[]` (`action:"note"`, `agentId:"dashboard"`) |
| GET | `/api/leads/stats` | rozkłady status/segment/region/source (do nagłówka) |

### 4.2 Content (signals → idea inbox)
| GET | `/api/content/signals` | `content_signals`, sort po `scores.relevance`; `?used=false&category=&q=` |
| GET | `/api/content/signals/:id` | pełny sygnał z hooks/angles |
| POST | `/api/content/signals/:id/draft` | (faza 4) zleca agentowi wygenerowanie draftu z sygnału |
| GET | `/api/content/articles` | surowy `rss_articles` (przeglądarka feedu), paginowane |

### 4.3 Drafts (rejestr + edycja)
| GET | `/api/drafts` | lista z rejestru; `?channel=&status=&language=&week=` |
| GET | `/api/drafts/:id` | pełna treść + meta |
| PATCH | `/api/drafts/:id` | zapis edytowanej treści `draft.md` + bump `updatedAt`; walidacja limitu |
| POST | `/api/drafts/:id/approve` | status → `approved` |
| POST | `/api/drafts/:id/send` | email: wyślij przez Gmail (`gmailDraftId`); social: oznacz `scheduled/sent` |
| POST | `/api/drafts/reindex` | ręczne przeskanowanie FS → rejestr (mongo `agentforge.drafts`) |
| GET | `/api/drafts/calendar` | drafty social pogrupowane po `weekStarting`/`scheduledFor` |

### 4.4 Chef (opcjonalnie, faza późniejsza)
| GET | `/api/chef/projects`, `/api/chef/menus/:projectId` | przeglądarka wygenerowanych menu |

### 4.5 UI
| GET | `/workspace-ui` | serwuje single-file HTML (czyta z `src/mastra/workspace/index.html`) |

---

## 5. Logika kluczowa

### 5.1 DraftRegistry (naprawa indeksowania)
Obecny `services/delta-indexer.ts` jest niesprawny: celuje w nieistniejącą bazę
`gastro_bridge`/`drafts_registry`, czyta dowolne `*.json` (nie `draft.meta.json`), nie parsuje
`draft.md`, nie jest nigdzie podpięty. **Przepisujemy jako `draft-registry.ts`:**
1. Skan `src/mastra/public/.drafts/**/draft.meta.json`.
2. Dla każdego: wczytaj `draft.meta.json` + sąsiedni `draft.md`.
3. Upsert do **`agentforge.drafts`** (klucz `draftId`, dodatkowo `filePath`, `bodyHash`).
4. Mapowanie `type` → `channel` (`cold-email`→email, `linkedin-post`→linkedin, `instagram-caption`→instagram).
5. Wyzwalanie: (a) endpoint `/api/drafts/reindex`, (b) opcjonalnie fs.watch w dev,
   (c) hook po zakończeniu workflowów content/producer-hunt.
6. Edycja z dashboardu (`PATCH`) zapisuje ZARÓWNO do FS (`draft.md`) JAK I do rejestru — FS pozostaje źródłem prawdy treści.

### 5.2 Limity platform (alerty w edytorze)
```
linkedin-post:       3000 (miękki ~1300 dla zasięgu)
instagram-caption:   2200
cold-email subject:  ~60
twitter/x (przyszłość): 280
```
`charCount` już jest liczony przy generacji — front liczy na żywo i koloruje próg.

### 5.3 Mapper leadów (`normalizeLead`)
- Wykryj segment: `segment==="automation-prospect"` lub `source` zawiera `automation` → automation;
  obecność `metadata.olx_*` → gastro-producer; inaczej `other`.
- Wyciągnij kontakt z pól top-level + `metadata`.
- Zmapuj `details` zależnie od segmentu.
- Dołącz draft: po `metadata.draft.gmailDraftId` albo match po `companyName` w rejestrze draftów.
- Odfiltruj uszkodzony rekord z `crm/leads` (nie czytamy tej kolekcji w ogóle).

---

## 6. Frontend — moduły i UX

Pojedyncza strona, zakładki (tabs), spójny styl z istniejącym dashboardem (ciemny, karty).

### 6.1 CRM / Pipeline (priorytet 1)
- **Kanban** kolumny = statusy (5.2). Karta: firma, segment-badge, region, ikona "ma draft".
- Drag&drop między kolumnami → `PATCH /api/leads/:id` (status + auto-wpis history).
- **Filtry** górne: segment, source, region, szukajka po nazwie.
- **Panel szczegółów** (drawer z prawej): kontakt, metadata (OLX/automation), **timeline `history[]`**,
  podgląd podpiętego draftu, przyciski: dodaj notatkę, otwórz draft w edytorze, otwórz w Gmailu.
- **Pasek statystyk** u góry: liczba leadów per status, per segment.

### 6.2 Content Studio — Social (priorytet 2)
- **Idea Inbox** (lewa kolumna): `content_signals` sort po `relevance`, badge `novelty`,
  filtr `used=false`. Klik → rozwija hooks/angles/whyItMatters. Przycisk "Zrób draft" (faza 4).
- **Kalendarz/grid** (centrum): drafty social po `weekStarting`/`scheduledFor`,
  kolumny dni, badge platformy (LI/IG) i języka (PL/EN).
- **Edytor markdown** (drawer): live preview, licznik znaków + alert limitu, podgląd `imagePrompt`,
  pole `rationale`. Zapis → `PATCH /api/drafts/:id`. Akcje: approve, schedule.

### 6.3 Outreach — cold-email (priorytet 3)
- Lista draftów email (z rejestru, `channel=email`) spięta z leadami.
- Widok split: lewo lista, prawo podgląd `draft.md` (Do/Temat/body) + `enrichment` + przycisk "Wyślij przez Gmail".
- Status flow: draft → approved → sent (po wysyłce status leada → `sent`).

### 6.4 Chef Studio (priorytet 4, opcjonalny)
- Lista `chef_projects`, podgląd `chef_menus` (sekcje, dania, składniki, techniki) — read-only v1.

---

## 7. Fazy implementacji

> **Uwaga:** Mastra rezerwuje prefiks `/api` dla route'ów wewnętrznych — wszystkie endpointy workspace używają prefiksu `/ws` (np. `GET /ws/leads`).

### Faza 0 — Fundament (backend skeleton) ✅
- [x] `workspace-service.ts`: połączenie Mongo (reuse istniejącego klienta), `normalizeLead`, agregacje.
- [x] `draft-registry.ts`: skan FS → `agentforge.drafts`, mapper meta+body.
- [x] Route'y read-only: `GET /ws/leads`, `/ws/leads/:id`, `/ws/leads/stats`,
      `GET /ws/drafts`, `/ws/drafts/:id`, `GET /ws/content/signals`.
- [x] `/ws/drafts/reindex` + jednorazowy reindex (zasilenie pustej `drafts`).
- **Weryfikacja**: ✅ `curl` zwraca 156 leadów (gastro 51 / automation 54 / other 51), reindex zaindeksował 38 draftów (email 19 / linkedin 13 / instagram 6), sygnały OK.

### Faza 1 — CRM operacyjny ✅
- [x] `PATCH /ws/leads/:id` (status+history), `POST /ws/leads/:id/note`.
- [x] Frontend: `/workspace-ui`, zakładka CRM Kanban + drawer szczegółów + filtry + statystyki.
- **Weryfikacja**: ✅ UI serwowane (HTTP 200, ~25 KB), endpoint PATCH dopisuje wpis do `history[]`.

### Faza 2 — Content Studio ✅
- [x] `PATCH /ws/drafts/:id` (zapis FS+rejestr, walidacja limitu), `/status`, `/calendar`.
- [x] Frontend: Idea Inbox (signals) + kalendarz draftów + edytor markdown z live preview i limitami.
- **Weryfikacja**: ✅ `/ws/drafts/calendar` grupuje posty social po tygodniu (IG reel + LinkedIn widoczne), edytor liczy znaki vs limit per kanał.

### Faza 3 — Outreach + wysyłka
- [ ] Integracja Gmail: `POST /api/drafts/:id/send` (wysyła draft po `gmailDraftId`).
- [ ] Frontend: zakładka Outreach, split-view, akcja wyślij → status leada `sent`.
- **Weryfikacja**: wysłany email znika z "draft", lead przechodzi w `sent`.

### Faza 4 — Pętla generowania (zamknięcie obiegu)
- [ ] `POST /api/content/signals/:id/draft` — zlecenie agentowi marketingowemu draftu z sygnału.
- [ ] Hook: po wygenerowaniu draftu auto-reindex rejestru.
- **Weryfikacja**: z sygnału powstaje draft widoczny w kalendarzu bez restartu.

### Faza 5 — Chef + dopieszczenie
- [ ] Read-only przeglądarka menu, audyt akcji, drobne UX.

---

## 8. Ryzyka i decyzje do potwierdzenia

1. **Schema leadów niejednorodna** → rozwiązane mapperem (nie ruszamy danych źródłowych).
2. **`crm/leads` uszkodzony** → ignorujemy kolekcję, czytamy tylko `leads`.
3. **Rejestr draftów był martwy** → przepisujemy `delta-indexer` → `draft-registry`, cel `agentforge.drafts`.
4. **Tunel Cloudflare rotuje** → dashboard tylko lokalny (`localhost:4111`), nie pinujemy URLi.
5. **Pipeline treści stoi od 2026-05-08** → dashboard najpierw obsłuży istniejące 38 draftów,
   reaktywacja generacji to Faza 4.
6. **Gmail send wymaga ważnego OAuth** → reuse `/auth/google`; jeśli token wygasł, akcja "wyślij" pokaże re-auth.

**Do potwierdzenia przez Patryka:**
- Zakres v1: CRM + Content Studio (rekomendacja), czy od razu wszystkie 4 moduły?
- Frontend: single-file HTML na start (rekomendacja) vs React od początku?
- Rozszerzony lejek statusów (`sent/replied/won/lost/parked`) — akceptacja nazewnictwa?

---

## 9. Mapa plików (do utworzenia/zmiany)

```
src/mastra/services/workspace-service.ts     [NOWY]  mapper + agregacje CRM/content
src/mastra/services/draft-registry.ts        [NOWY]  skan FS → agentforge.drafts (zastępuje delta-indexer)
src/mastra/services/gmail-send.ts            [NOWY, Faza 3]  wysyłka po gmailDraftId
src/mastra/index.ts                          [EDYCJA] dodanie route'ów /api/* i /workspace-ui
src/mastra/workspace/index.html              [NOWY]  single-file frontend (v1)
src/mastra/services/delta-indexer.ts         [USUNĄĆ/DEPRECATE] martwy, zły target DB
```

Kolekcje Mongo dotykane: `agentforge.leads` (R/W history+status), `agentforge.drafts` (W indeks),
`rss_intelligence.content_signals` (R), `rss_intelligence.rss_articles` (R).
FS: `src/mastra/public/.drafts/**` (R/W treści).
