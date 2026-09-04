# Producer Hunt fix v2 - plan wykonawczy

## Aktualny stan po sprawdzeniu kodu

### P0

1. Rejestracja agentow producer-hunt w Mastrze - WYKONANE
   - `src/mastra/index.ts` importuje i rejestruje:
     - `producerHuntDiscoveryAgent`
     - `producerHuntEnrichmentAgent`
     - `producerHuntEmailExtractionAgent`
     - `producerHuntDraftAgent`
     - `producerHuntJsonRepairAgent`
     - `producerHuntCloudFallbackAgent`
   - Status: gotowe. Nie wracac do `marketingAgent.generate(...)`.

2. Fallback draft w `draft-cold-emails` przy blednym JSON - CZESCIOWO WYKONANE
   - Jest `fallbackDraft()` i jest podany do `generateJsonWithFallback`.
   - Brakuje fallbacku w zewnetrznym `catch` kroku draftowania. Jesli `generateJsonWithFallback` lub walidacja rzuci wyjatek poza swoim deterministic fallbackiem, kod tylko loguje `draft fail` i nie dodaje draftu.
   - Status: do poprawy.

3. Workflow nie powinien konczyc sie `success`, gdy `count=10`, byly poprawne emaile, a `drafts=0` - BRAK
   - `await-approval` zwraca sukces z `feedback: "Brak draftow."`.
   - Brakuje kroku diagnostycznego albo twardego bledu biznesowego po `draft-cold-emails`.
   - Status: do poprawy.

### P1

4. Discovery powinien odpalac kolejne rundy search, jesli `leads.length < count` - CZESCIOWO WYKONANE
   - Fallback LLM po snippetach odpala sie juz przy `leads.length < count`.
   - Nadal nie ma kolejnych rund realnego search z dodatkowymi zapytaniami.
   - Dla `productType=warzywa` brakuje dedykowanych zapytan: przetworstwo warzyw i owocow, kiszonki, soki, pomidory, ogorki, gospodarstwo warzywne, miasta/powiaty, RHD.
   - Status: do rozbudowy.

5. Enrichment nie powinien wyrzucac danych z NotebookLM, gdy finalne LLM padnie - CZESCIOWO WYKONANE
   - `generateJsonWithFallback` ma fallback oparty o `nlmHook || lead.reason` i `nlmAnalysis || leadContext`.
   - Ale zewnetrzny `catch` nadal tworzy `rawAnalysis: "Enrichment niedostepny."`, co moze przykryc dane z NLM lub `leadContext`, jesli blad nastapi po zebraniu danych.
   - Status: do poprawy.

6. Email extraction powinien uzywac deterministycznego regexu, a LLM tylko jako fallback - BRAK
   - Aktualnie email extraction najpierw odpala lokalnego agenta, potem cloud fallback.
   - Nie ma regexu po `rawAnalysis`, `sourceUrls`, `emailSource`, `website`, `leadContext`.
   - Status: do poprawy.

### P2

7. Strukturalne logi per krok - CZESCIOWO WYKONANE
   - Sa console logi i warningi.
   - Sa `qualitySummary` i `postResearchSummary`.
   - Brakuje zapisu strukturalnego do Mongo/DuckDB/logs: `found`, `validEmail`, `enriched`, `drafted`, `skippedReason`, `error`.
   - Status: do poprawy.

8. Cleanup NotebookLM - BRAK POTWIERDZONEJ NAPRAWY
   - Kod probuje usuwac discovery notebook i deep notebooki przez `knowledgeDeleteNotebookTool`.
   - Skoro po runie zostaja tymczasowe notatniki, cleanup jest nieskuteczny lub nie ma retry/audytu.
   - Status: do poprawy.

## Cel v2

Po wdrozeniu v2 workflow ma:

- nie generowac `success` przy pustych draftach bez jasnego powodu;
- nie tracic danych z NotebookLM po awarii finalnego LLM;
- deterministycznie wyciagac emaile zanim uzyje LLM;
- dopelniac discovery dodatkowymi rundami search, zwlaszcza dla nisz produktowych;
- zapisywac strukturalna diagnostyke do bazy, aby kolejne audyty nie wymagaly zgadywania z `console.warn`;
- sprzatac lub raportowac niesprzatniete notebooki NotebookLM.

## Plan implementacji

### Krok 1 - P0: fallback draft w zewnetrznym catch

Plik: `src/mastra/workflows/producer-hunt.ts`

Zakres:

1. W kroku `draft-cold-emails` wyciagnac tworzenie draftu do helpera lokalnego:

```ts
const pushDraft = (lead: EnrichedLead, draft: { subject: string; body: string }) => {
  drafts.push({
    taskId,
    draftId: `email-${randomUUID().slice(0, 6)}`,
    company: lead.company,
    email: lead.email!,
    subject: draft.subject,
    body: draft.body,
    enrichment: lead,
  });
};
```

2. W `try` uzywac `pushDraft(lead, parsed)`.
3. W `catch (err)` zamiast samego `console.warn`:
   - stworzyc `safeDraft = fallbackDraft()`;
   - przepuscic przez `validateDraft`;
   - jesli poprawny, `pushDraft(lead, safeDraft)`;
   - zapisac strukturalny event `draft_fallback_used`.
4. Nie dopuscic, aby awaria jednego modelu zerowala drafty dla wszystkich leadow.

Kryterium akceptacji:

- Jesli `producerHuntDraftAgent.generate(...)` rzuci wyjatek, workflow nadal tworzy fallback draft dla danego leada z poprawnym emailem.

### Krok 2 - P0: diagnostyczny fail/needs_attention dla `drafts=0`

Plik: `src/mastra/workflows/producer-hunt.ts`

Zakres:

1. Dodac krok po `draft-cold-emails`, przed `create-gmail-drafts`, np. `validate-producer-hunt-output`.
2. Input:
   - `taskId`
   - `region`
   - `drafts`
   - `researchOnlyCount`
   - dodatkowo metryki z poprzednich krokow, jesli zostana przepuszczone dalej: `qualitySummary`, `postResearchSummary`, `emailExtractionSummary`.
3. Warunek bledu:
   - `requestedCount >= 5`
   - `discoveredWithValidEmail > 0` lub `enrichedWithValidEmail > 0`
   - `drafts.length === 0`
4. Zachowanie:
   - zapisac rekord do `logs` i/lub `tasks`:
     - `level: "error"`
     - `event: "producer_hunt_needs_attention"`
     - `reason: "valid_email_but_zero_drafts"`
     - `taskId`, `region`, metryki;
   - rzucic blad workflow z czytelnym komunikatem albo zwrocic status wymagajacy uwagi, jesli Mastra UI lepiej obsluguje output niz exception.
5. Jesli `drafts=0`, ale wszystkie leady byly bez emaila lub wszystkie zostaly odrzucone przez post-research gating, nie robic twardego bledu. Zamiast tego zapisac `needs_attention` z powodem `no_reachable_leads`.

Kryterium akceptacji:

- Run `count=10`, `validEmails > 0`, `drafts=0` nie konczy sie cichym `success`.
- W snapshot/logach widac jednoznaczny powod.

### Krok 3 - P1: discovery multi-round search

Plik: `src/mastra/workflows/producer-hunt.ts`

Zakres:

1. Wyciagnac budowe zapytan do helpera, np.:

```ts
function buildDiscoveryQueries(region: string, productType?: string, round = 1): string[]
```

2. Runda 1:
   - obecne `baseQueries`;
   - obecne `nicheQueries`.
3. Runda 2, gdy `leads.length < count`:
   - zapytania zalezne od `productType`;
   - dla `warzywa`, `owoce`, `warzywa i owoce`:
     - `przetworstwo warzyw owocow ${region} producent kontakt`
     - `kiszonki ${region} producent email`
     - `tlocznia sokow ${region} owoce warzywa kontakt`
     - `pomidory ogorki gospodarstwo ${region} sprzedaż bezposrednia`
     - `gospodarstwo warzywne ${region} RHD kontakt`
     - `rolniczy handel detaliczny warzywa ${region} email`
4. Runda 3, gdy nadal `leads.length < count`:
   - zapytania po miastach/powiatach.
   - Dodac prosta mape regionow:
     - `slaskie`: Katowice, Bielsko-Biala, Cieszyn, Zywiec, Gliwice, Rybnik, Pszczyna, Czestochowa, Tychy.
     - `dolnoslaskie/wroclaw`: Wroclaw, Trzebnica, Olesnica, Swidnica, Legnica, Jelenia Gora, Dolina Baryczy.
     - `mazowieckie`: Warszawa, Grojec, Radom, Plock, Siedlce.
5. Po kazdej rundzie:
   - dodac nowe wyniki do `uniqueResults`;
   - odpalic NotebookLM albo fallback snippets tylko na nowych wynikach;
   - deduplikowac po domenie email, nazwie i source URL.
6. Limit:
   - maksymalnie 3 rundy;
   - zatrzymac po `count * 1.5` surowych kandydatow albo `count` po deduplikacji.

Kryterium akceptacji:

- Dla `slaskie`, `productType=warzywa`, `count=10` workflow wykonuje co najmniej druga runde search, jesli pierwsza zwroci mniej niz 10 leadow.

### Krok 4 - P1: nie tracic danych NLM w enrichment catch

Plik: `src/mastra/workflows/producer-hunt.ts`

Zakres:

1. Zmienic zewnetrzny `catch` w `enrich-leads`.
2. Obecny fallback:

```ts
rawAnalysis: 'Enrichment niedostepny.'
```

zastapic:

```ts
const preservedAnalysis =
  normalizeTextField(nlmAnalysis, '') ||
  normalizeTextField(leadContext, '') ||
  normalizeTextField(lead.reason, '') ||
  'Enrichment niedostepny.';
```

3. `personalizationHook` ustawic na:
   - `nlmHook`, jesli jest;
   - `lead.reason`, jesli jest;
   - neutralny fallback.
4. Zapisac do metadata:
   - `enrichmentError`
   - `usedPreservedNlmData: true/false`
   - `preservedSource: "nlm" | "searchContext" | "leadReason" | "none"`
5. Nie nadpisywac realnego NLM tekstu pustym placeholderem.

Kryterium akceptacji:

- Gdy finalne LLM padnie po udanym NLM, `rawAnalysis` zawiera dane NLM, a nie `Enrichment niedostepny.`.

### Krok 5 - P1: deterministyczny email extraction

Pliki:

- `src/mastra/workflows/producer-hunt.ts`
- opcjonalnie nowy helper `src/mastra/workflows/producer-hunt/email.ts`

Zakres:

1. Dodac helper:

```ts
export function extractEmailsFromText(text: string): string[]
```

2. Regex:

```ts
/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
```

3. Normalizacja:
   - usuwac trailing punctuation: `.`, `,`, `;`, `)`, `]`;
   - lower-case domeny;
   - deduplikacja.
4. Filtrowanie:
   - odrzucic przyklady typu `example.com`, `test@`, `name@domain`;
   - preferowac email z domeny pasujacej do website;
   - potem email z `emailSource`;
   - potem email z `rawAnalysis`;
   - potem pierwszy poprawny.
5. Kolejnosc w `extract-emails`:
   - jesli lead ma email, przepusc;
   - regex po `emailSource`, `rawAnalysis`, `website`, `sourceUrls`, ewentualnie zachowanym `leadContext`;
   - dopiero jesli regex nic nie znajdzie, uzyc lokalnego LLM;
   - dopiero potem cloud fallback.
6. Dodac summary:
   - `alreadyHadEmail`
   - `foundByRegex`
   - `foundByLocalLlm`
   - `foundByCloud`
   - `stillMissing`.

Kryterium akceptacji:

- Lead z emailem obecnym w `rawAnalysis` lub snippetach nie potrzebuje LLM do ekstrakcji.

### Krok 6 - P2: strukturalne logi

Pliki:

- nowy helper `src/mastra/workflows/producer-hunt/logging.ts`
- `src/mastra/workflows/producer-hunt.ts`

Zakres:

1. Dodac helper:

```ts
type ProducerHuntLogEvent = {
  taskId: string;
  stepId: string;
  event: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  company?: string;
  metrics?: Record<string, unknown>;
  skippedReason?: string;
  error?: string;
};
```

2. `logProducerHuntEvent(db, event)` zapisuje do `logs`:
   - `timestamp`
   - `level`
   - `agentId: "producer-hunt-workflow"`
   - `taskId`
   - `message`
   - `data`.
3. Dla kazdego kroku zapisac:
   - `discover-leads`: `found`, `validEmail`, `withWebsite`, `round`, `queryCount`, `uniqueResults`.
   - `create-research-leads`: `draftCandidates`, `researchNeeded`, `rejected`, score histogram.
   - `enrich-leads`: `inputCandidates`, `enrichedAccepted`, `enrichedRejected`, `identityMismatch`.
   - `extract-emails`: `alreadyHadEmail`, `foundByRegex`, `foundByLocalLlm`, `foundByCloud`, `stillMissing`.
   - `draft-cold-emails`: `drafted`, `fallbackDrafted`, `skippedNoEmail`, `failed`.
   - `validate-output`: `status`, `reason`.
4. Nie usuwac `console.log`, ale traktowac go jako pomocniczy. Zrodlem audytu ma byc Mongo `logs`.

Kryterium akceptacji:

- Po runie da sie jednym query po `taskId` odtworzyc funnel: discovered -> candidates -> enriched -> emails -> drafts.

### Krok 7 - P2: cleanup NotebookLM z retry i audytem

Pliki:

- `src/mastra/workflows/producer-hunt.ts`
- opcjonalnie `src/mastra/workflows/producer-hunt/notebook-cleanup.ts`

Zakres:

1. Dodac helper:

```ts
async function cleanupNotebook(notebookId: string, meta: { taskId: string; stepId: string; title?: string })
```

2. Helper ma:
   - probowac delete maksymalnie 3 razy;
   - miedzy probami czekac 1s, 3s, 5s;
   - logowac `notebook_cleanup_success` albo `notebook_cleanup_failed`;
   - nie rzucac bledu, ale zapisywac failed cleanup do `logs`.
3. Zamiast `.catch(() => {})` uzyc helpera.
4. Po discovery i po kazdym deep notebooku zapisac:
   - `notebookId`
   - `title`
   - `createdAt`
   - `cleanupStatus`.
5. Opcjonalnie dodac narzedzie diagnostyczne:
   - skrypt `src/mastra/scripts/list-producer-hunt-notebooks.ts`, jesli NotebookLM MCP pozwala listowac notebooki.

Kryterium akceptacji:

- Nie ma cichego faila cleanupu.
- Jesli NotebookLM zostawi notatnik, mamy `logs` z `notebookId`, tytulem i bledem delete.

## Kolejnosc wdrozenia

1. P0 draft catch fallback.
2. P0 validate-output / needs_attention.
3. P1 preserve NLM data in enrichment catch.
4. P1 regex email extraction.
5. P1 multi-round discovery.
6. P2 structured logs.
7. P2 notebook cleanup retry.

## Testy po wdrozeniu

1. `npx tsc --noEmit`
2. Uruchomienie manualne:
   - `{ "region": "slaskie", "count": 10 }`
   - `{ "region": "slaskie", "count": 10, "productType": "warzywa" }`
3. Oczekiwane metryki:
   - discovery robi kolejna runde, jesli pierwsza nie dobije do 10;
   - `candidatesForResearch > 0`;
   - `enrichedAccepted > 0`;
   - przy poprawnych emailach `drafts > 0`;
   - jesli `drafts=0`, workflow nie konczy sie cicho jako sukces.
4. Query diagnostyczne:
   - `logs.find({ taskId }).sort({ timestamp: 1 })`
   - sprawdzic eventy `discover_summary`, `quality_summary`, `enrichment_summary`, `email_extraction_summary`, `draft_summary`, `output_validation`.

## Ryzyka

- Multi-round search zwiekszy koszt i czas workflow. Ograniczyc liczbe rund i wynikow.
- Zbyt agresywny fail dla `drafts=0` moze zatrzymywac poprawne runy research-only. Dlatego warunek faila musi uwzgledniac, czy byly leady z poprawnym emailem.
- Regex email moze lapac smieci z cudzych stron. Potrzebna preferencja domeny official website i filtrowanie przykladowych adresow.
- Cleanup NotebookLM moze nie dzialac z powodu ograniczen MCP/API. Wtedy kluczowe jest logowanie failure z ID notatnika.
