# Plan: Uniwersalizacja agentów + produktyzacja systemu jako kontener na sprzedaż

> Status: propozycja (2026-07-21) · Branch: `claude/session-hst1xd`
> Warunek startu: **dopiero po domknięciu bieżącego planu autonomii** (m.in. `ideas/automation-delegation-lifecycle-fix.md`).
> Cel końcowy: kopia repo bez dopasowania do GastroBridge → uniwersalna platforma agentowa,
> którą każdy biznes personalizuje własnymi danymi, sprzedawana jako kontener (cloud-first, z opcją local).

---

## 0. Diagnoza: gdzie system jest "przyspawany" do GastroBridge

Zanim cokolwiek zmienimy, warto nazwać wszystkie punkty sprzężenia. Audyt kodu wskazuje 5 warstw:

| Warstwa | Pliki | Charakter sprzężenia |
|---|---|---|
| **Prompty domenowe** | `src/mastra/prompts/hunt/{domain,pipeline}.md`, `content/{business,domain}.md`, `sales/base.md`, `marketing/*.md`, `analytics/base.md`, `meta/{base,knowledge-plan}.md` | Nazwa firmy, ICP, typologia dostawców, filary przekazu, głos foundera, stopka RODO — wpisane na sztywno w treść |
| **Deterministyczne bramki** | `src/mastra/tools/hunt/hunt-quality-tools.ts` (271 linii), `workflows/producer-hunt/quality.ts` | Sygnały scoringu (branża spożywcza/HoReCa, polskie formy prawne, katalogi typu panoramafirm), `footerTemplate` z danymi Patryka, typologia supplier/restaurant |
| **CRM** | `src/mastra/tools/crm/*` (6 narzędzi), kolekcja Mongo `leads` | Sztywny schemat leada (segment producer/restaurant, statusy pipeline), jeden tenant |
| **Knowledge / NotebookLM** | `src/mastra/tools/knowledge/notebooklm-client.ts` | `NOTEBOOK_TITLE_ALIASES` zakodowane na tytuły notatników GastroBridge (`rynek`, `rhd`, `konkurencja`, `founder`, `leady`, …); jedno konto `nlm` |
| **Workflowy operacyjne** | `workflows/producer-hunt/*`, `workflows/sales/*`, `workflows/marketing/*`, `workflows/analytics/*`, `weekly-content.ts` | Prompty kroków i logika napisane pod GastroBridge |

Kluczowa obserwacja: **architektura już jest gotowa na uniwersalizację**. Wzorzec
`domain.md` (uniwersalna metodologia, EN) + `business.md` (fakty o firmie, generowane) istnieje
w content agencie — trzeba go tylko rozciągnąć na wszystkich agentów i zasilić danymi z profilu klienta,
zamiast z ręcznie pisanych plików.

---

## 1. Zasada przewodnia: **Business Profile Pack** (jedno źródło prawdy o firmie klienta)

Nie personalizujemy 6 agentów osobno. Budujemy **jedną warstwę profilu biznesowego**, z której
wszyscy agenci czerpią. To jest najważniejsza decyzja architektoniczna całego planu — redukuje
personalizację N agentów do wypełnienia jednego profilu.

### 1.1. Struktura profilu

```
profiles/<tenant-id>/
├── business-profile.json      # dane strukturalne (walidowane schematem Zod)
├── generated/                 # warstwy .md generowane z profilu (commit-owalne, edytowalne)
│   ├── business-brief.md      # odpowiednik dzisiejszego content/business.md
│   ├── voice.md               # głos marki / foundera
│   ├── icp.md                 # segmenty + typologia + kąty ofertowe
│   └── compliance.md          # stopki, zakazy prawne, rynek
├── signal-packs/              # sygnały scoringu dla hunt-agenta (patrz 3.1)
│   └── <industry>.json
└── crm-schema.json            # schemat CRM wygenerowany przez CRM-Builder (patrz 3.2)
```

`business-profile.json` — minimum pól (schemat Zod w `src/mastra/config/business-profile-schema.ts`):

```jsonc
{
  "company": { "name": "", "website": "", "legalName": "", "founder": "", "oneLiner": "" },
  "industry": { "sector": "", "businessModel": "marketplace|saas|services|ecommerce|...", "keywords": [] },
  "market": { "country": "PL", "language": "pl", "regions": [], "complianceFooterData": { "controller": "", "purpose": "", "optOutWord": "STOP" } },
  "icp": [ { "name": "", "description": "", "priority": 1, "signals": [], "antiSignals": [], "valueProp": "", "outreachAngle": "" } ],
  "messaging": { "pillars": [], "proofPoints": [], "differentiation": [], "guardrails": { "bannedClaims": [], "bannedPhrases": [], "sensitiveTopics": [] } },
  "voice": { "persona": "", "tone": [], "doNot": [], "defaultOutputLanguage": "pl" },
  "goals": { "currentQuarter": "", "kpis": [] },
  "cta": [ { "channel": "linkedin|email|...", "segment": "", "text": "" } ],
  "knowledge": { "nlmBinaryPath": "nlm", "nlmAccount": "", "notebooks": { "<alias>": "<tytuł-lub-uuid>" } },
  "crm": { "pipelineStatuses": [], "segments": [], "customFields": [] },
  "models": { "profile": "cloud|local|hybrid", "byokKeys": true }
}
```

### 1.2. Jak profil trafia do agentów — rozszerzenie `prompt-loader`

`combinePrompts()` (`src/mastra/lib/prompt-loader.ts`) dostaje dwa nowe mechanizmy:

1. **Overlay per tenant** — `loadPrompt('hunt/domain')` szuka najpierw
   `profiles/<tenant>/prompts/hunt/domain.md`, potem `src/mastra/prompts/hunt/domain.md`.
   Klient (albo agent onboardingowy) może nadpisać dowolny prompt bez dotykania kodu.
2. **Interpolacja zmiennych** — prompty bazowe przechodzą na placeholdery
   `{{company.name}}`, `{{icp.0.outreachAngle}}`, `{{market.language}}` itd., wypełniane
   z `business-profile.json` w momencie ładowania. Sekcje warunkowe
   (`{{#if industry.businessModel == "marketplace"}}…{{/if}}`) dla fragmentów, które mają sens
   tylko dla części biznesów (np. dwustronność marketplace'u w hunt/domain).

Ponieważ agenci są konstruowani z `await combinePrompts(...)` na starcie procesu, w wariancie
single-tenant (kontener = jedna firma) wystarczy `TENANT_ID` w env i restart. Pełny multi-tenant
(dynamiczne instrukcje per request) to opcja późniejsza — Mastra wspiera `instructions` jako funkcję
z runtime context, ale NIE robimy tego w MVP (komplikuje memory i telemetrię).

### 1.3. **Onboarding Agent (Profiler)** — jak "wgrywać" dane o firmie

Nowy agent `profiler-agent` (albo tryb meta-agenta), który buduje profil za użytkownika. Trzy kanały wejścia:

1. **Wywiad** — strukturalna rozmowa (PL/EN wg użytkownika): czym jest firma, kto jest klientem,
   co sprzedaje, jakie ma cele kwartalne, czego nie wolno mówić publicznie. Pytania mapują się 1:1
   na pola `business-profile.json` — agent prowadzi rozmowę aż profil przejdzie walidację Zod.
2. **Ingest dokumentów** — użytkownik wrzuca: stronę www (scrape przez `researcherAgent`), pitch deck,
   ofertę, cennik, dotychczasowe maile. Profiler ekstrahuje pola profilu + proponuje treść `generated/*.md`.
3. **Import z NotebookLM** — jeśli użytkownik ma już notatniki, profiler mapuje je na aliasy
   (`knowledge.notebooks`) i odpytuje je, żeby dociągnąć fakty do profilu.

Wyjście: `business-profile.json` + wygenerowane `generated/*.md` + (opcjonalnie) utworzenie
notatników NLM z wsadem klienta. **Profil jest edytowalny ręcznie** — generacja to start, nie kajdany.
Do tego walidator `npm run profile:check` (spójność: ICP ↔ signal-pack ↔ crm-schema ↔ stopka).

---

## 2. Fazy realizacji (kolejność wykonania)

```
Faza 0  Domknięcie planu autonomii (bieżąca praca) ───────────── warunek startu
Faza 1  Business Profile Pack + prompt-loader (fundament)          ~1 tydzień
Faza 2  Uniwersalizacja agentów: content → marketing → sales       ~1 tydzień
Faza 3  Hunt-agent uniwersalny (signal-packi) + Knowledge (NLM)    ~1–1.5 tygodnia
Faza 4  CRM-Builder agent (zamiast sztywnego CRM)                  ~1.5 tygodnia
Faza 5  Modele: cloud-first + profil local (BYOK)                  ~3–4 dni
Faza 6  Kontener: docker compose, profile, setup-wizard            ~1 tydzień
Faza 7  Licencjonowanie + dystrybucja (Keygen/Stripe)              ~3–4 dni
Faza 8  Hosting demo/SaaS + strona + GTM                           równolegle z 7
```

Zasada: **kopia repo (public product repo) powstaje na początku Fazy 1** — `git clone` + wycięcie
katalogów prywatnych (`pomysły/`, `ideas/`, `reports/`, workflowy GastroBridge zostają jako
`examples/gastrobridge/` albo znikają). GastroBridge staje się wtedy **pierwszym tenantem**
produktu — najlepszy możliwy test: jeśli GastroBridge da się w pełni odtworzyć samym
`business-profile.json`, uniwersalizacja jest kompletna. To jest kryterium akceptacji każdej fazy.

---

## 3. Szczegóły per agent

### 3.1. Hunt Agent — dopasowanie do każdej firmy

Dziś: `hunt/domain.md` to ekspercki rubrik pod marketplace HoReCa; `hunt_score_lead` ma zaszyte
sygnały branży spożywczej; stopka RODO z danymi Patryka.

Zmiany:

1. **`hunt/domain.md` → szablon**: metodologia (podział pracy strategia/bramki, rubrik zimnego maila,
   extraction order, identity guard, conductor-pattern) jest w 100% uniwersalna — zostaje. Wycinamy:
   nazwę firmy, typologię dostawców, kąty ofertowe, przykłady sygnałów → to wchodzi z
   `{{icp}}` (każdy segment ICP ma `signals`, `antiSignals`, `valueProp`, `outreachAngle` — dokładnie
   to, czym dziś jest sekcja "Supplier typology").
2. **Signal-packi dla `hunt_score_lead`**: scoring przechodzi z zaszytych stałych na config
   `profiles/<tenant>/signal-packs/<industry>.json`:
   ```jsonc
   {
     "rewardSignals": [{ "pattern": "…", "weight": 10, "label": "…" }],
     "penaltySignals": [{ "pattern": "panoramafirm\\.pl|pkt\\.pl", "weight": -25, "label": "directory" }],
     "legalForms": ["sp\\. z o\\.o\\.", "GmbH", "Ltd", "LLC"],
     "targetKinds": { "supplier": { … }, "restaurant": { … } }   // → generyczne: per segment ICP
   }
   ```
   Dostarczamy **gotowe packi startowe** (food/HoReCa — obecny; services B2B; e-commerce; SaaS;
   manufacturing) + profiler generuje pack z ICP i użytkownik go tuninguje. Mechanika bramki
   (0–100, progi draft_candidate/research_needed/reject, domain-match email) — bez zmian.
3. **Market Pack**: `footerTemplate` budowany z `market.complianceFooterData` profilu
   (administrator, cel, źródło, opt-out) zamiast na sztywno. Szablony stopek per kraj (PL RODO,
   DE UWG, US CAN-SPAM) w code, dane firmy z profilu.
4. **Brief workera (bulk drafting)**: sekcja "ROLE: You are Patryk…" → `{{voice.persona}}`;
   reszta spec-u (jeden value prop, jeden ask, ban klisz, limit słów) uniwersalna.
5. CRM segmenty w hunt → z `crm.segments` profilu.

### 3.2. CRM: odłączyć sztywny CRM → **CRM-Builder Agent**

Dziś: 6 narzędzi na sztywnej kolekcji `leads` z ustalonymi statusami/segmentami.

Docelowo — dwuwarstwowo:

1. **Warstwa danych (generyczna, deterministyczna)** — narzędzia CRM przechodzą na model
   schema-driven:
   - `crm_schemas` (Mongo): dokument per tenant — encje (np. lead, deal, kontakt, obiekt "projekt"),
     pola (typ, wymagalność, enum), pipeline'y (statusy + dozwolone przejścia), segmenty.
   - Istniejące narzędzia stają się generyczne: `crm_create_record`, `crm_update_record`,
     `crm_search`, `crm_update_status` (walidacja przejść wg schematu), `crm_add_interaction`
     (bez zmian koncepcyjnie). Walidacja wejścia dynamicznym schematem Zod budowanym z `crm-schema.json`.
   - Kolekcje per tenant: `crm_<tenant>_<entity>` — czysta izolacja i łatwy eksport.
2. **CRM-Builder Agent (nowy)** — agent, który **projektuje CRM pod użytkownika**:
   - wejście: `business-profile.json` + wywiad ("jak wygląda Twój proces sprzedaży? co jest dealem?
     kiedy lead jest kwalifikowany?");
   - wyjście: `crm-schema.json` (pipeline, pola, segmenty, reguły eskalacji) + migracja/seed;
   - iteracje: "dodaj pole NIP", "rozdziel pipeline na inbound/outbound" → agent wersjonuje schemat
     (nigdy nie kasuje pól z danymi — tylko deprecation);
   - bonus: generuje widoki w dashboardzie (dashboard już ma warstwę analytics — dołożyć rendering
     kolumn/pipeline z `crm-schema.json`).

MVP ścieżka: najpierw krok 1 (generyczne narzędzia + konfigurowalne statusy/segmenty/custom fields —
to odblokowuje sales/marketing/hunt), potem pełny builder z encjami.

### 3.3. Content Agent — pod każdy biznes

Najłatwiejszy przypadek, bo wzorzec już istnieje: `content/business.md` to dokładnie ten dokument,
który profiler ma generować (pozycjonowanie, ICP, filary, value props per segment, różnicowanie,
cel kwartału, CTA per platforma, guardrails, aktywa do cytowania — sekcje 1–9 zostają jako **szablon
generatora**). Zmiany:
- `content/business.md` → `profiles/<tenant>/generated/business-brief.md` (generowany, edytowalny);
- `content/domain.md` — przejrzeć i wyciąć resztki GastroBridge (jest na liście plików z nazwą firmy);
- strategia notatnika `content-strategy` (jak pisać virale) — uniwersalna, zostaje; alias notatnika
  z profilu (patrz 3.6).

### 3.4. Sales Agent — pod każdego użytkownika i biznes

`sales/base.md` (PL, mały) → szablon EN z interpolacją:
- tożsamość: `{{company.name}}`, typy klientów z `{{icp}}`;
- **pipeline statusy z `crm-schema.json`** (nie z promptu!) — prompt mówi "respect the pipeline
  defined by CRM schema; never skip stages", a konkretne statusy wstrzykuje loader;
- reguły eskalacji (discount > X%, oferta handlowa, C-level) → `business-profile.json` →
  sekcja `sales.approvalRules` (konfigurowalne progi);
- workflowy `sales/*` (proposal-generator, meeting-scheduler, onboarding-checklist) — prompty kroków
  na interpolację profilu; struktura kroków bez zmian.

### 3.5. Marketing Agent — pod każdy biznes

`marketing/base.md` + `cold-email.md` + `copy-pl/en.md` + `outreach-draft.md` + `research.md`:
- kontekst firmy, narracja, founder, model komunikacji per segment → z profilu
  (`messaging`, `voice`, `icp`, `cta`);
- zasady operacyjne (draft-only, approval, limit 120 słów, zakaz "–", źródła przy liczbach) —
  **uniwersalne, zostają w bazie**;
- mapa notatników NLM w prompcie → generowana z `knowledge.notebooks` profilu;
- języki copy: zamiast plików `copy-pl`/`copy-en` — jeden szablon + `{{voice.defaultOutputLanguage}}`
  (obecna para zostaje jako para przykładów językowych dla generatora).

### 3.6. Knowledge Agent — konto NLM każdego użytkownika

- `NOTEBOOK_TITLE_ALIASES` w `notebooklm-client.ts` → ładowane z `knowledge.notebooks` profilu
  (fallback: brak aliasów = użytkownik używa tytułów/UUID wprost);
- **auth per użytkownik**: `nlm` CLI trzyma własną autoryzację Google — kontener dostaje volume
  na konfigurację nlm (`~/.nlm` → `/data/nlm`), setup-wizard prowadzi przez `nlm login` użytkownika;
  `NLM_BINARY_PATH` + `NLM_AUTH_DIR` w env;
- profiler przy onboardingu: proponuje **standardowy zestaw notatników** (market, competitors,
  founder-voice, leads, docs, content-strategy) i tworzy je przez `notebook_create` + `source_add`
  z materiałów klienta;
- **fallback bez NLM**: nie każdy klient ma/chce NotebookLM. Dodać adapter `KnowledgeBackend`
  (interfejs: `query`, `queryMulti`, `addSource`) z dwiema implementacjami: `notebooklm` (obecna)
  i `builtin-rag` (istniejący stack embeddingów bge-m3/gemini-embedding + Mongo/libSQL — system już
  ma warstwę `system_knowledge`, więc to sklejenie, nie budowa od zera). Wybór w profilu.

---

## 4. Modele: chmurowe domyślnie, lokalne opcjonalnie

`model-manifest.ts` już jest single-source-of-truth z aliasami — to duży atut. Zmiany:

1. **Profile modelowe**: `MODEL_PROFILE=cloud | local | hybrid` (env). Manifest dostaje trzy mapy
   przypisań (dzisiejsza konfiguracja ≈ `hybrid`). `cloud`: tanie flash/mini do workerów
   (gemini-3.1-flash-lite / gpt-5.4-mini), mocniejsze do agentów domenowych (gemini-3.5-flash /
   claude), embeddingi gemini-embedding-001. `local`: obecne mapowania Ollama (bielik/qwen/gemma) —
   zostają w manifescie jako pełnoprawny profil.
2. **BYOK (bring your own keys)** jako model domyślny sprzedaży: klient wkleja własne klucze
   (Google/OpenAI/Anthropic/OpenRouter) w `.env` / setup-wizardzie. **Nie odsprzedajemy tokenów** —
   zero ryzyka marży na inference, zero compliance na dane klienta przechodzące przez nasze konta.
   (Opcja "managed keys" z narzutem — dopiero gdy będzie popyt.)
3. **Health-gate już istnieje** (`model-availability`, `model-health-gate`) — dołożyć degradację
   profilu: brak Ollamy → automatyczny fallback aliasów local→cloud z ostrzeżeniem w logu.
4. Setup-wizard waliduje klucze na starcie (1 tani call per provider) i drukuje szacunkowy
   koszt/miesiąc dla wybranego profilu.

---

## 5. Kontener: pakowanie produktu

### 5.1. Kompozycja

```
docker-compose.yml
├── app        # Mastra build (npm run build → .mastra/output), Node 22, non-root
├── mongo      # dane CRM/memory/telemetria (volume)
├── dashboard  # istniejący dashboard (może być serwowany przez app)
├── n8n        # OPCJONALNY profil compose (--profile automation)
└── ollama     # OPCJONALNY profil compose (--profile local-models, wymaga GPU/gruby RAM)
```

- **`docker compose --profile cloud up`** = minimalny footprint (app+mongo+dashboard), działa na
  VPS-ie za 5–10 €.
- **`--profile local-models`** dokłada Ollamę — to jest obiecana ścieżka "pobierz kontener i odpal
  lokalnie na własnych modelach". README z wymaganiami sprzętowymi per model.
- Naprawić znany problem świeżej instalacji: zewnętrzny volume `n8n_data` (opisany w README) —
  w produkcie volume ma być zwykły, bez `external: true`.
- Obraz budowany w CI (GitHub Actions już jest w repo): multi-stage Dockerfile, tag = wersja,
  `linux/amd64` + `linux/arm64` (Hetzner ARM jest tani, Maki klientów to ARM).
- **Setup-wizard** (`npm run setup` albo pierwszorazowy ekran w dashboardzie): klucze modeli →
  profil modelowy → onboarding Profilera (rozdz. 1.3) → nlm login (opcjonalnie) → smoke-test.
- Sekrety wyłącznie przez env/volume; `profile/` i dane Mongo na volume — obraz jest bezstanowy
  i aktualizowalny (`docker compose pull && up -d`).

### 5.2. Licencjonowanie i dystrybucja

Rekomendacja: **[Keygen](https://keygen.sh/for-docker-images/) + Stripe** — standardowy, sprawdzony
stack do sprzedaży self-hosted kontenerów:
- prywatny, license-gated rejestr OCI (klient robi `docker login` kluczem licencyjnym → `docker pull`);
- Stripe webhook → automatyczne wystawienie/odnowienie/wygaszenie licencji (jest gotowy przewodnik
  [How to License and Distribute a Private Docker Image](https://keygen.sh/blog/how-to-license-and-distribute-a-private-docker-image/));
- walidacja licencji w aplikacji: sprawdzenie przy starcie + grace period offline (nie zabijamy
  produkcji klienta, gdy padnie sieć); Keygen ma też wariant self-hosted, gdyby zależność od SaaS przeszkadzała;
- alternatywa prostsza na start: [Keyforge/Stripe one-time keys](https://keyforge.dev/guides/how-to-stripe-one-time) albo Lemon Squeezy (obsłuży też VAT UE za nas — dla sprzedaży z Polski do UE to duży plus).

**Model open-core** (opcjonalny, ale wart rozważenia): rdzeń harnessa (cognitive loop, envelope,
memory) publiczny na GitHubie = marketing i zaufanie; agenci domenowi + profiler + CRM-builder +
signal-packi = warstwa płatna. Zasada podziału wg [buyer-based open core](https://www.opencoreventures.com/blog/a-standard-pricing-model-for-open-core):
to, co kupuje "operator biznesu", jest płatne; to, co ciekawi dewelopera — darmowe.

---

## 6. Hosting: gdzie i jak

Dwie osobne potrzeby — nie mylić:

### 6.1. Hosting produktu klienta (główny model: **klient hostuje sam**)
Sprzedajemy kontener, więc domyślnie hosting jest problemem klienta — dajemy instrukcje:
- **Rekomendowany setup w docs**: Hetzner CX32 (4 vCPU/8 GB, ~9.4 €/mies.) + Coolify/Dokploy
  (self-hosted PaaS, deploy compose jednym klikiem) — najtańsza sensowna produkcja, EU/GDPR;
- profil `local-models`: maszyna z GPU lub Mac Studio klienta.

### 6.2. Nasz hosting (demo, trial, opcja "managed")
- **Start (demo + landing + docs): Hetzner + Coolify** — jeden CX32 uciągnie kilka instancji demo;
  koszt ~10–20 €/mies. Pełna kontrola, brak niespodzianek w rachunku.
- **Wersja managed (gdy pojawią się klienci "nie chcę DevOps")**: per-klient stack na
  **Railway** (najlepszy DX, usage-based, ~20 $/mies./instancję) albo **Render** (od 7 $/serwis,
  przewidywalnie) — obie platformy deployują obraz z rejestru bez naszej roboty operacyjnej.
  Fly.io tylko, jeśli będzie potrzeba multi-region (po śmierci free tier wychodzi 8–25 $/instancję).
- Ekonomia: przy > ~40–50 $/mies. na PaaS przenosić workload na Hetznera (4× taniej za te same vCPU).
- MongoDB: w composie (na tym samym VPS). Managed Atlas dopiero dla wersji managed z SLA.

### 6.3. Kanały sprzedaży
1. **Własny landing + Stripe/Lemon Squeezy checkout** → klucz licencyjny → `docker login` + compose. Główny kanał.
2. **GitHub (open-core)** → gwiazdki/trust → konwersja do płatnej licencji.
3. Później: marketplace'y (DigitalOcean Marketplace, Elest.io, Self-Host Pro) — gotowy ruch
   ludzi szukających self-hosted appek.

---

## 7. Cennik (propozycja)

Kontekst rynkowy 2026: platformy agentowe SMB (Lindy, Relevance AI) to 30–150 $/user/mies.;
typowe SME wydaje 500–5000 $/mies. na gotowe rozwiązanie agentowe; custom build to 30–100 k$
jednorazowo. My sprzedajemy **całą firmę agentową w kontenerze na infra i kluczach klienta** —
pozycjonowanie: "flat fee, bez opłat per task, dane u Ciebie".

| Plan | Cena | Zawartość |
|---|---|---|
| **Community** (open-core, jeśli wejdzie) | 0 | rdzeń harnessa, 1 agent przykładowy, bez profilera/CRM-buildera |
| **Solo** | **59 €/mies.** lub 590 €/rok | pełny kontener, 1 tenant/1 profil firmy, BYOK, aktualizacje, docs |
| **Business** | **149 €/mies.** lub 1490 €/rok | + CRM-Builder, signal-packi premium, priorytetowe aktualizacje, wsparcie e-mail 48h |
| **Lifetime / Perpetual** | **990–1490 € jednorazowo** + opcjonalne 290 €/rok za aktualizacje | licencja wieczysta na bieżącą wersję major — self-hosted crowd kocha ten model i on realnie konwertuje |
| **Managed** (później) | 249–399 €/mies. | my hostujemy (Railway/Hetzner), onboarding 1:1, SLA |
| **Setup/wdrożenie** (usługa) | 500–2000 € one-off | Profiler z człowiekiem: wywiad, ingest, tuning signal-packa — naturalny upsell i źródło feedbacku |

Zasady: ceny netto, roczny = 2 miesiące gratis, trial 14 dni (licencja czasowa z Keygen), ceny w EUR
(sprzedaż UE; Lemon Squeezy jako merchant-of-record zdejmuje VAT-OSS). Startowo celujemy nisko
(walidacja popytu), podnosimy po pierwszych 10–20 klientach — podnoszenie cen jest łatwe, obniżanie boli.

---

## 8. Ryzyka i decyzje otwarte

1. **Sekwencja: nie zaczynać przed domknięciem planu autonomii.** Uniwersalizacja dotyka promptów
   i bramek, które autonomia właśnie stabilizuje — robienie obu naraz = konflikt na każdym pliku.
2. **NLM CLI to nieoficjalne API** — NotebookLM nie ma publicznego API dla kont osobistych; `nlm`
   może się wysypać po zmianach Google. Dlatego fallback `builtin-rag` (3.6) to nie "nice to have",
   tylko warunek sprzedawalności knowledge-agenta.
3. **Bramki jakości tracą ostrość po uogólnieniu** — signal-pack generowany przez LLM będzie słabszy
   niż ręcznie dopieszczony pack HoReCa. Mitygacja: pack-i startowe per branża + telemetria scoringu
   (już jest) do tuningu + usługa wdrożeniowa jako produkt.
4. **Utrzymanie dwóch repo** (prywatne GastroBridge + produktowe). Mitygacja: GastroBridge jako
   tenant produktu (profil + packi w `profiles/gastrobridge/`), nie fork — jedna baza kodu.
5. **Licencja projektu**: sprawdzić obecny `LICENSE` przed publikacją czegokolwiek; open-core wymaga
   świadomej decyzji (np. rdzeń Apache-2.0 / FSL, warstwa płatna proprietary).
6. **Wsparcie klientów** to realny koszt czasu solo-foundera — dlatego setup-wizard i smoke-testy
   w Fazie 6 są ważniejsze niż kolejny feature; każdy ticket "nie odpala się" to godzina z życia.

## 9. Kryteria ukończenia (definition of done)

- [ ] `grep -ri "gastrobridge" src/` w repo produktowym zwraca 0 wyników (poza `profiles/` i `examples/`).
- [ ] GastroBridge odtworzony w 100% jako `profiles/gastrobridge/` — hunt/content/sales/marketing/knowledge
      działają identycznie jak przed refaktorem (porównanie na zapisanych runach harness replay).
- [ ] Drugi, testowy profil zupełnie innej branży (np. agencja usług B2B) przechodzi pełny cykl:
      onboarding → hunt z własnym signal-packiem → draft z poprawną stopką → CRM wg własnego schematu.
- [ ] `docker compose --profile cloud up` na czystym VPS: od zera do działającego dashboardu < 15 min.
- [ ] `docker compose --profile local-models up` działa z Ollamą bez kluczy chmurowych.
- [ ] Zakup testowy: Stripe checkout → klucz → `docker login` → `pull` → aktywacja licencji.
