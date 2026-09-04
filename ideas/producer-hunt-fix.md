# Producer Hunt Fix Plan

Plan dla deva: stabilizacja i poprawa jakości workflow `producer-hunt` w Mastrze.

## 1. Kontekst i diagnoza

### Obserwowane problemy

1. Workflow potrafi dojść do `enrich-leads`, ale wywala się przed `extract-emails`.
2. Workflow potrafi wygenerować drafty, ale lokalny model potrafi przeciążyć system.
3. Brakuje automatycznego fallbacku chmurowego po nieudanej próbie lokalnej.
4. Model czasem zwraca poprawny JSON składniowo, ale niezgodny typami ze schematem workflow.
5. Discovery/enrichment czasem miesza firmy o podobnych nazwach albo bierze profile osób/katalogi zamiast producentów.
6. Drafty bywają zbyt generyczne albo zawierają niepożądane elementy typu placeholdery i wymyślone nazwy produktu.

### Konkretne runy potwierdzające problem

#### Run 1: `0b9cdade-b1de-4abd-aa91-540f65b0c298`

Input:

```json
{
  "region": "śląskie",
  "count": 5
}
```

Status: `failed`.

Przebieg:

- `discover-leads`: success, 5 leadów, ok. 69 s.
- `create-research-leads`: success, 5 valid leadów.
- `enrich-leads`: success, 5 enrichmentów, ok. 320 s.
- `extract-emails`: failed po ok. 3 ms.

Błąd:

```text
Step input validation failed:
- enriched.4.rawAnalysis: Invalid input: expected string, received object
```

Przyczyna bezpośrednia:

`producerHuntEnrichmentAgent` zwrócił dla firmy `Admar PHUP sp.j. M.R. Czwiertnia` pole `rawAnalysis` jako obiekt:

```json
{
  "companyName": "Admar (Admar Mariusz i Ryszard Czwiertnia)",
  "location": "Ruda Śląska, woj. śląskie",
  "industry": "Branża cukiernicza / produkcja słodyczy",
  "coreBusiness": "Produkcja wyrobów cukierniczych i słodyczy...",
  "potentialPartners": "Hotele, event agency...",
  "valueProposition": "Zautomatyzowanie i rozszerzenie kanałów sprzedaży..."
}
```

Natomiast `enrichedLeadSchema` wymaga:

```ts
const enrichedLeadSchema = leadSchema.extend({
  rawAnalysis: z.string(),
  personalizationHook: z.string(),
});
```

Najważniejsze: `tryParseJson<T>()` daje tylko typ TypeScript, ale nie waliduje runtime. Kod obecnie zakłada, że `parsed?.rawAnalysis` jest stringiem, jeśli istnieje. To nie jest prawdziwe przy danych z LLM.

#### Run 2: `a66a7a04-5f19-4353-8f2a-4a20ac956738`

Input:

```json
{
  "region": "śląskie",
  "count": 10
}
```

Status: `canceled`.

Przebieg:

- `discover-leads`: success, 10 leadów, ok. 71 s.
- `create-research-leads`: success.
- `enrich-leads`: success, 10 enrichmentów, ok. 553 s.
- `extract-emails`: success, 10 emaili.
- `draft-cold-emails`: success, 9 draftów, ok. 717 s.
- Nie doszedł do `create-gmail-drafts`, `save-drafts-fs`, `update-crm`, `await-approval`.

Wniosek:

Ten run nie wygląda jak typowy błąd walidacji. Bardziej wygląda na przerwanie/cancel w okolicy ciężkiego draftowania i restartu/crasha środowiska.

### Obecny model routing

W `src/mastra/config/workflow-models.ts` aktualnie wszystkie role `producerHunt` idą przez:

```ts
modelPresets.localMarketing // ollama/local/gemma4:26b
```

Dotyczy:

- `producerHunt.discovery`
- `producerHunt.enrichment`
- `producerHunt.emailExtraction`
- `producerHunt.draftEmail`
- `producerHunt.jsonRepair`

Qwen nadal występuje w repo dla innych ścieżek:

- `analyticsAgent`
- `system.run_worker` preset `reasoning`
- `system.run_worker` preset `powerful`

Ale aktualny producer-hunt nie powinien go używać, jeśli Mastra działa na świeżym bundle i aktualnej konfiguracji.

### Najważniejsza diagnoza

To nie jest wyłącznie problem “Gemma jest za słaba”.

Są trzy warstwy problemu:

1. **Bug implementacyjny:** brak runtime walidacji i normalizacji odpowiedzi LLM przed zwróceniem outputu ze stepu.
2. **Brak model fallbacku:** po niepoprawnym JSON/typach lokalny model nie jest zastępowany modelem chmurowym.
3. **Brak filtrów jakości:** workflow nie broni się wystarczająco przed złymi leadami, podmienionymi firmami i generycznymi draftami.

## 2. Cele zmian

### Cel techniczny

Workflow `producer-hunt` nie może wywalać się na danych, które sam wygenerował we wcześniejszym kroku.

Każdy step LLM musi kończyć się jednym z trzech stanów:

1. Poprawne dane zgodne ze schematem.
2. Poprawne dane po repair/fallback.
3. Bezpieczny deterministyczny fallback, który pozwala workflow iść dalej albo świadomie oznacza lead jako `research_needed`.

### Cel produktowy

Workflow ma generować mniej, ale lepszych draftów:

- tylko do realnych firm-producentów,
- z poprawnym mailem,
- z potwierdzonym lub przynajmniej wiarygodnym website/context,
- z personalizacją bez halucynacji,
- z prawidłową stopką RODO,
- bez generycznych i kompromitujących treści.

### Cel operacyjny

Lokalne modele nie mogą crashować systemu.

Ciężkie modele mają być:

- nieużywane domyślnie w producer-hunt,
- wykrywane w preflight,
- zastępowane bezpieczniejszym modelem albo fallbackiem chmurowym,
- logowane, jeśli zostaną użyte.

## 3. Zakres implementacji

### Pliki główne

1. `src/mastra/workflows/producer-hunt.ts`
   - normalizacja outputów,
   - runtime walidacja Zod,
   - helpery local/repair/cloud fallback,
   - lead scoring,
   - guardrails draftów,
   - dodatkowe logi.

2. `src/mastra/config/workflow-models.ts`
   - dodać jawny model cloud fallback dla producer-hunt,
   - opcjonalnie rozdzielić modele dla quality/repair/draft.

3. `src/mastra/agents/marketing-agent.ts`
   - dodać osobnego agenta fallbackowego, np. `producerHuntCloudFallbackAgent`,
   - opcjonalnie dodać wyspecjalizowanych agentów quality-check.

4. `src/mastra/index.ts`
   - zarejestrować nowego agenta fallbackowego w `agents`.

### Pliki opcjonalne

Rekomendowane jest wydzielenie helperów do osobnych plików, żeby `producer-hunt.ts` nie urósł jeszcze bardziej:

1. `src/mastra/workflows/producer-hunt/types.ts`
   - schematy Zod,
   - typy `Lead`, `EnrichedLead`, `Draft`,
   - typy jakości leadów.

2. `src/mastra/workflows/producer-hunt/json.ts`
   - `tryParseJson`,
   - `normalizeStringField`,
   - `generateJsonWithFallback`.

3. `src/mastra/workflows/producer-hunt/quality.ts`
   - scoring leadów,
   - walidacja domen,
   - draft guardrails.

Jeśli zależy nam na minimalnym diffie, można zacząć w jednym pliku `producer-hunt.ts`, a refaktor do folderu zrobić później.

## 4. Etap 0: baseline przed zmianami

### Zadania

1. Zapisać obecny stan modeli:

```bash
ollama list
ollama ps
```

2. Spisać ostatnie snapshoty:

- `0b9cdade-b1de-4abd-aa91-540f65b0c298`
- `a66a7a04-5f19-4353-8f2a-4a20ac956738`

3. Upewnić się, że Mastra po zmianie działa na świeżym bundle:

- restart `mastra dev`,
- sprawdzić, że `.mastra/output/delegate-task.mjs` ma aktualne modele,
- sprawdzić, że `producerHunt*Agent` są w `mastra.listAgents()`.

### Kryteria ukończenia

- Wiemy, jaki model jest faktycznie używany w runtime.
- Wiemy, czy obecny proces Mastry jest świeży po zmianach.
- Mamy punkt odniesienia dla kolejnych testów.

## 5. Etap 1: normalizacja i walidacja `rawAnalysis`

### Problem

Aktualny kod:

```ts
const rawAnalysis = parsed?.rawAnalysis || nlmAnalysis || leadContext || 'Brak głębokiego researchu.';
```

Zakłada, że `parsed.rawAnalysis` jest stringiem. Jeśli model zwróci obiekt, obiekt trafia do `enriched.push(...)`, a następny step wybucha na walidacji wejścia.

### Zmiana

Dodać helper:

```ts
function normalizeTextField(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (value == null) {
    return fallback;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => normalizeTextField(item, ''))
      .filter(Boolean)
      .join('\n');
    return text || fallback;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => {
        const normalized = normalizeTextField(val, '');
        return normalized ? `${key}: ${normalized}` : '';
      })
      .filter(Boolean);

    return entries.length > 0 ? entries.join('\n') : fallback;
  }

  return String(value);
}
```

W `enrich-leads` używać:

```ts
const rawAnalysis = normalizeTextField(
  parsed?.rawAnalysis,
  normalizeTextField(nlmAnalysis || leadContext, 'Brak głębokiego researchu.'),
);

const personalizationHook = normalizeTextField(
  parsed?.personalizationHook,
  nlmHook || `Producent żywności z regionu ${region}.`,
);
```

Następnie przed `enriched.push(...)`:

```ts
const candidate = {
  ...lead,
  website: normalizeNullableString(parsed?.website ?? website ?? lead.website),
  personalizationHook,
  rawAnalysis,
};

const validation = enrichedLeadSchema.safeParse(candidate);

if (!validation.success) {
  console.warn(`[producer-hunt:${taskId}] enrichment schema repair fallback for ${lead.company}:`, validation.error.message);
  enriched.push(createFallbackEnrichedLead(lead, region));
} else {
  enriched.push(validation.data);
}
```

### Ważna decyzja

Nie rozluźniać `enrichedLeadSchema` do `rawAnalysis: z.any()`.

Schemat ma zostać restrykcyjny. Normalizacja ma się wydarzyć przed zwróceniem outputu ze stepu.

### Kryteria akceptacji

- Jeśli LLM zwróci `rawAnalysis` jako obiekt, workflow nie pada.
- `extract-emails` zawsze dostaje `rawAnalysis` jako string.
- Snapshot `enrich-leads.output.enriched[*].rawAnalysis` nie zawiera obiektów.

## 6. Etap 2: walidowany JSON helper dla LLM

### Problem

`tryParseJson<T>()` daje złudne bezpieczeństwo. TypeScriptowy generic nie sprawdza danych w runtime.

Aktualne kroki zależne od JSON:

- fallback discovery,
- finalne enrichment polishing,
- draft cold emails,
- JSON repair draftu.

### Zmiana

Dodać helper typu:

```ts
type GenerateJsonOptions<T> = {
  taskId: string;
  stepId: string;
  entityName?: string;
  prompt: string;
  schema: z.ZodSchema<T>;
  localAgent: Agent;
  repairAgent?: Agent;
  cloudFallbackAgent?: Agent;
  repairPrompt?: (badOutput: string, error: string) => string;
  fallback: (reason: string) => T;
};
```

Flow:

1. Wywołaj local agent.
2. `tryParseJson`.
3. `schema.safeParse`.
4. Jeśli fail:
   - log `local_invalid_json` albo `local_schema_invalid`,
   - wywołaj repair agent z błędem walidacji i oryginalnym outputem.
5. Ponownie parse + validate.
6. Jeśli fail i jest cloud agent:
   - wywołaj cloud fallback agent z tym samym promptem oraz informacją, co było źle.
7. Ponownie parse + validate.
8. Jeśli nadal fail:
   - użyj deterministycznego fallbacku,
   - loguj `deterministic_fallback`.

Przykładowe API:

```ts
const result = await generateJsonWithFallback({
  taskId,
  stepId: 'enrich-leads',
  entityName: lead.company,
  prompt,
  schema: enrichmentResponseSchema,
  localAgent: producerHuntEnrichmentAgent,
  repairAgent: producerHuntJsonRepairAgent,
  cloudFallbackAgent: producerHuntCloudFallbackAgent,
  fallback: () => ({
    personalizationHook: nlmHook || lead.reason || `Producent żywności z regionu ${region}.`,
    rawAnalysis: nlmAnalysis || leadContext || 'Brak głębokiego researchu.',
    website,
  }),
});
```

### Schematy odpowiedzi LLM

Nie używać bezpośrednio `enrichedLeadSchema` jako schematu odpowiedzi z modelu, bo model nie musi zwracać pełnego leada.

Dodać oddzielne schema:

```ts
const enrichmentResponseSchema = z.object({
  personalizationHook: z.string().min(5),
  rawAnalysis: z.union([
    z.string(),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
  ]).optional(),
  website: z.string().optional().nullable(),
  linkedIn: z.string().optional().nullable(),
  facebook: z.string().optional().nullable(),
});
```

Potem normalizować `rawAnalysis` do stringa przed zapisaniem w `EnrichedLead`.

Dla draftu:

```ts
const draftResponseSchema = z.object({
  subject: z.string().min(5).max(120),
  body: z.string().min(200),
});
```

Dla discovery:

```ts
const discoveryResponseSchema = z.object({
  leads: z.array(leadSchema).default([]),
});
```

### Kryteria akceptacji

- Każdy output LLM przechodzi przez `safeParse`.
- Nie ma miejsc, gdzie `tryParseJson<T>()` jest traktowany jako gwarancja typu.
- Błąd lokalnego modelu nie kończy automatycznie workflowu, jeśli może zadziałać repair/cloud/fallback.

## 7. Etap 3: cloud fallback dla producer-hunt

### Problem

W `workflowModels.producerHunt` są wpisane modele lokalne, ale nie ma awaryjnego modelu chmurowego.

### Zmiana w `workflow-models.ts`

Dodać:

```ts
producerHunt: {
  discovery: modelPresets.localMarketing,
  enrichment: modelPresets.localMarketing,
  emailExtraction: modelPresets.localMarketing,
  draftEmail: modelPresets.localMarketing,
  jsonRepair: modelPresets.localMarketing,
  cloudFallback: modelPresets.googleFlash,
}
```

Rekomendacja:

- `google/gemini-2.5-flash` jako pierwszy fallback: szybki, tani, dobry do JSON repair i struktury.
- `openai/gpt-5.2-mini` jako alternatywa, jeśli Gemini daje słabe polskie copy albo źle trzyma format.

### Zmiana w `marketing-agent.ts`

Dodać:

```ts
export const producerHuntCloudFallbackAgent = createMarketingAgent(
  'producer-hunt-cloud-fallback-agent',
  'Producer Hunt Cloud Fallback Agent',
  workflowModels.producerHunt.cloudFallback,
);
```

### Zmiana w `index.ts`

Dodać do importu i `agents`:

```ts
producerHuntCloudFallbackAgent,
```

### Kiedy używać cloud fallbacku

Nie używać chmury domyślnie na każdym kroku.

Używać tylko wtedy, gdy:

1. Lokalny model rzuci wyjątek.
2. Lokalny model zwróci nieparsowalny JSON.
3. Lokalny model zwróci JSON niezgodny ze schematem.
4. Repair lokalny nie naprawi odpowiedzi.
5. Draft quality guardrail odrzuci lokalny draft.

### Kryteria akceptacji

- W logach widać, kiedy użyto cloud fallbacku.
- Fallback jest per lead/per step, a nie restartuje całego workflow.
- Jeśli cloud też zawiedzie, workflow idzie deterministycznym fallbackiem albo oznacza lead jako `research_needed`.

## 8. Etap 4: preflight i bezpieczne użycie modeli lokalnych

### Problem

Ciężki model lokalny może załadować się podczas długiego kroku i doprowadzić do crusha systemu.

### Zmiana

Dodać listę modeli ryzykownych:

```ts
const HEAVY_LOCAL_MODELS = [
  'ollama/local/qwen3.5-abliterated:35b',
  'ollama/huihui_ai/qwen3.5-abliterated:35b',
];
```

Dodać helper:

```ts
function assertSafeProducerHuntModel(model: string, stepId: string, taskId: string) {
  if (HEAVY_LOCAL_MODELS.includes(model)) {
    console.warn(`[producer-hunt:${taskId}] heavy local model configured for ${stepId}: ${model}`);
  }
}
```

W wersji bardziej defensywnej:

- Jeśli `draftEmail` jest ciężkim modelem, użyć `cloudFallback` albo `localMarketing`.
- Jeśli `enrichment` jest ciężkim modelem, ograniczyć `count` albo przełączyć na fallback.

### Nie robić

Nie wołać automatycznie `ollama pull`.

Nie ubijać procesów Ollamy z poziomu workflow.

Nie ładować równolegle wielu ciężkich modeli.

### Kryteria akceptacji

- Producer-hunt nie ładuje qwen 35B przypadkiem.
- Jeśli ktoś zmieni config na ciężki model, workflow loguje wyraźne ostrzeżenie.
- Draftowanie pozostaje sekwencyjne.

## 9. Etap 5: filtry jakości leadów

### Problem

Workflow potrafi przepuścić:

- osoby prywatne,
- firmy nieprodukujące żywności,
- portale katalogowe,
- błędne domeny,
- firmy o podobnej nazwie, ale z innego kraju/branży.

### Zmiana

Dodać scoring leadów po `discover-leads`, przed `create-research-leads` albo wewnątrz `create-research-leads`.

Proponowany typ:

```ts
type LeadQuality = {
  score: number;
  decision: 'draft_candidate' | 'research_needed' | 'reject';
  reasons: string[];
};
```

### Reguły scoringu

#### Plusy

- `+25` poprawny email.
- `+20` domena email pasuje do domeny website.
- `+20` website wygląda jak oficjalna strona firmy.
- `+15` reason zawiera produkt lub kategorię produkcyjną.
- `+15` region/miejscowość zgodna z inputem.
- `+10` firma ma formę prawną albo nazwę działalności gospodarczej.

#### Minusy

- `-40` website to GoWork, katalog firm, Panorama Firm, pkt.pl jako jedyne źródło.
- `-40` wygląda jak osoba prywatna bez firmy.
- `-35` domena zagraniczna lub inna marka niż firma.
- `-30` reason nie wskazuje produkcji żywności.
- `-25` social media jako jedyne źródło, bez potwierdzenia produkcji.
- `-25` email z darmowej domeny przy braku innych potwierdzeń.

### Decyzje

- `score >= 60`: `draft_candidate`
- `30 <= score < 60`: `research_needed`
- `score < 30`: `reject`

Na start można nie usuwać leadów całkowicie, tylko:

- `draft_candidate` idzie dalej do pełnego workflow,
- `research_needed` idzie do CRM i może być enriched, ale nie draftowany,
- `reject` logowany i pomijany.

### Kryteria akceptacji

- `Anna Shevchenko`-like profile nie idą do draftu.
- `Admiral Group UK` jako enrichment dla polskiego `Admirał sp. z o.o.` zostaje oznaczony jako mismatch.
- GoWork/katalog może pomóc w researchu, ale nie może być jedyną podstawą do draftu.

## 10. Etap 6: guardrails enrichmentu

### Problem

Enrichment potrafi podmienić firmę:

Przykład:

- wejście: `Admirał sp. z o.o.`, `kontakt@admiralfish.pl`
- enrichment: `https://www.admiralgroup.co.uk/`, brytyjski ubezpieczyciel

To jest groźniejsze niż brak danych, bo prowadzi do maila o kompletnie złej firmie.

### Zmiana

Dodać `validateEnrichmentIdentity(lead, enriched)`.

Reguły:

1. Jeśli domena website jest inna niż domena email i nie ma wyraźnego dopasowania nazwy, obniżyć confidence.
2. Jeśli enrichment wskazuje inną branżę niż produkcja żywności, oznaczyć mismatch.
3. Jeśli website ma TLD/kraj niepasujący do regionu i brak polskiego kontekstu, oznaczyć mismatch.
4. Jeśli nazwa firmy z enrichmentu nie pokrywa się tokenami z nazwą wejściową, oznaczyć mismatch.

Przykładowy typ:

```ts
type EnrichmentIdentityCheck = {
  ok: boolean;
  confidence: number;
  reasons: string[];
};
```

Jeśli `ok === false`:

- nie używać nowego website,
- nie używać halucynowanego hooka,
- użyć pierwotnych danych,
- ustawić `personalizationHook` defensywny,
- oznaczyć `metadata.enrichmentWarning`.

### Prompt update

Dopisać do promptu enrichmentu:

```text
Nie podmieniaj firmy na inną o podobnej nazwie.
Jeśli nie możesz potwierdzić, że źródło dotyczy dokładnie tej firmy, zwróć:
"identityConfidence": 0.2,
"identityWarning": "Nie potwierdzono zgodności firmy"
```

Rozszerzyć `enrichmentResponseSchema`:

```ts
identityConfidence: z.number().min(0).max(1).optional(),
identityWarning: z.string().optional(),
```

### Kryteria akceptacji

- Enrichment nie może nadpisać polskiej firmy stroną zagranicznego podmiotu bez ostrzeżenia.
- Lead z niepewną tożsamością nie powinien dostać spersonalizowanego draftu o błędnych faktach.

## 11. Etap 7: guardrails draftów

### Problem

W pierwszym runie drafty miały przykłady niskiej jakości:

- generyczny temat `Współpraca`,
- placeholder `[Twoje Imię i Nazwisko]`,
- wymyślona nazwa `Gastro-Supply`,
- zbyt ogólne copy bez konkretnego researchu.

### Zmiana

Dodać `validateDraft(draft, lead)`.

Reguły twarde:

1. `subject` nie może być krótszy niż 5 znaków.
2. `body` nie może mieć placeholderów:
   - `[Twoje Imię i Nazwisko]`
   - `[imię]`
   - `[nazwa firmy]`
   - `{{...}}`
3. `body` musi zawierać `GastroBridge`.
4. `body` nie może zawierać wymyślonych nazw:
   - `Gastro-Supply`
   - `Gastro Market`, jeśli to nie jest ustalona marka
5. `body` musi zawierać stopkę RODO:
   - `Administratorem danych jest GastroBridge`
   - `Odpisz "NIE"`
6. `body` nie może obiecywać wysłania oferty/cennika bez zgody.
7. `body` nie powinno przekraczać ustalonego limitu słów.

Reguły miękkie:

1. Minimum jeden konkretny element z `rawAnalysis`.
2. Minimum jedno odniesienie do regionu/produktu/miejscowości, jeśli dostępne.
3. Brak przesadnego tonu sprzedażowego.

Typ:

```ts
type DraftValidation = {
  ok: boolean;
  hardFailures: string[];
  softWarnings: string[];
};
```

Flow:

1. Local draft.
2. Parse + schema validate.
3. `validateDraft`.
4. Jeśli hard fail:
   - repair prompt z listą błędów.
5. Jeśli repair fail:
   - cloud fallback.
6. Jeśli cloud fail:
   - deterministyczny fallback draft.

### Kryteria akceptacji

- Nie powstają drafty z placeholderami.
- Każdy draft ma stopkę RODO.
- Każdy draft mówi `GastroBridge`.
- Generyczny draft nie przechodzi bez repair/fallback.

## 12. Etap 8: poprawa discovery fallback

### Problem

Wcześniej fallback discovery uruchamiał się tylko przy `leads.length < 2`. Jeśli user prosi o 10, a NotebookLM da 2, workflow uznaje to za wystarczające.

### Zmiana

Zamiast:

```ts
if (leads.length < 2) { ... }
```

Użyć:

```ts
const minAcceptable = Math.max(2, Math.ceil(count * 0.6));
if (leads.length < minAcceptable) { ... }
```

Albo bardziej agresywnie:

```ts
if (leads.length < count) { ... }
```

Rekomendacja:

- Dla `count <= 5`: próbować dobić do `count`.
- Dla `count > 5`: minimum `ceil(count * 0.7)`, potem logować niedobór.

### Deduplikacja

Deduplikować nie tylko po nazwie firmy, ale też po:

- domenie email,
- domenie website,
- znormalizowanej nazwie bez `sp. z o.o.`, `s.c.`, cudzysłowów.

### Kryteria akceptacji

- Dla `count=10`, wynik 2 leady nie jest uznawany za pełny sukces bez próby fallbacku.
- Workflow loguje `requestedCount`, `foundCount`, `acceptedCount`, `researchNeededCount`.

## 13. Etap 9: logowanie i obserwowalność

### Problem

Aktualne `console.log` nie trafia konsekwentnie do kolekcji `logs`. Snapshoty workflow mają stan kroków, ale brakuje wygodnych powodów decyzji.

### Zmiana minimalna

Dodać ustrukturyzowane logi przez `console.log(JSON.stringify(...))` albo mały helper:

```ts
function logProducerHunt(taskId: string, event: string, data: Record<string, unknown>) {
  console.log(`[producer-hunt:${taskId}] ${event}`, JSON.stringify(data));
}
```

Logować:

- model,
- step,
- lead company,
- typ odpowiedzi modelu,
- parse status,
- schema validation status,
- czy użyto repair,
- czy użyto cloud fallback,
- czy użyto deterministic fallback,
- lead score i decyzję,
- draft validation failures.

### Zmiana lepsza

Dodać zapis do MongoDB kolekcji np. `workflow_logs` albo `producer_hunt_logs`.

Dokument:

```ts
{
  taskId,
  workflow: 'producer-hunt',
  stepId,
  event,
  level,
  company,
  data,
  createdAt
}
```

Uwaga:

Nie zapisywać pełnych treści maili do logów, chyba że jawnie potrzebne. Wystarczy:

- subject,
- długość body,
- pierwsze 120 znaków,
- flags/warnings.

### Kryteria akceptacji

- Po runie da się odpowiedzieć:
  - ile było local retry,
  - ile cloud fallbacków,
  - czemu lead odpadł,
  - czemu draft został naprawiony,
  - który model był użyty.

## 14. Etap 10: testy

### Testy jednostkowe

Jeśli repo nie ma jeszcze frameworka testowego, można zacząć od małego skryptu `tsx`/`node` lub dodać testy w stylu używanym w projekcie. Przed dodaniem nowego frameworka sprawdzić `package.json`.

#### `normalizeTextField`

Przypadki:

1. string -> ten sam string trimmed.
2. pusty string -> fallback.
3. object -> czytelny string z kluczami.
4. array -> string z elementami.
5. null/undefined -> fallback.

#### enrichment validation

Input:

```json
{
  "rawAnalysis": {
    "industry": "cukiernicza",
    "coreBusiness": "produkcja słodyczy"
  }
}
```

Expected:

- finalny `EnrichedLead.rawAnalysis` jest stringiem,
- `enrichedLeadSchema.safeParse` przechodzi.

#### draft guardrails

Input draft:

```json
{
  "subject": "Współpraca",
  "body": "Z poważaniem, [Twoje Imię i Nazwisko]"
}
```

Expected:

- `validateDraft.ok === false`,
- hard failure zawiera placeholder.

### Testy integracyjne ręczne

#### Case A: reprodukcja błędu rawAnalysis

Wstrzyknąć sztuczny output enrichmentu z obiektem w `rawAnalysis`.

Expected:

- `extract-emails` nie failuje na Zodzie.

#### Case B: cloud fallback

Wymusić lokalny invalid JSON.

Expected:

- helper próbuje repair,
- potem cloud fallback,
- loguje ścieżkę fallbacku.

#### Case C: słaby lead

Lead:

```json
{
  "company": "Anna Shevchenko",
  "email": "annashevchenko2709@gmail.com",
  "website": "https://www.facebook.com/ShevchenkoAnna/",
  "reason": "brak potwierdzenia produkcji"
}
```

Expected:

- decyzja `research_needed` albo `reject`,
- brak draftu.

#### Case D: mismatch firmy

Lead:

```json
{
  "company": "Admirał sp. z o.o.",
  "email": "kontakt@admiralfish.pl",
  "website": "www.admiralfish.pl"
}
```

Enrichment zwraca:

```json
{
  "website": "https://www.admiralgroup.co.uk/",
  "rawAnalysis": "Brytyjski ubezpieczyciel..."
}
```

Expected:

- identity mismatch,
- nie nadpisujemy website na `admiralgroup.co.uk`,
- nie generujemy draftu o Admiral Group.

## 15. Kolejność wdrożenia

### PR 1: Stabilizacja kontraktu danych

Zakres:

- `normalizeTextField`,
- `createFallbackEnrichedLead`,
- walidacja `enrichedLeadSchema.safeParse` przed push,
- logi typu `enrichment_schema_invalid`,
- testy normalizacji.

Efekt:

- aktualny crash `rawAnalysis object` znika.

Ryzyko:

- niskie.

### PR 2: JSON helper + repair

Zakres:

- `generateJsonWithFallback` bez cloud fallbacku na start,
- local -> parse -> schema -> repair -> deterministic fallback,
- użycie w `enrich-leads` i `draft-cold-emails`.

Efekt:

- mniej cichych błędów i mniej pustych draftów.

Ryzyko:

- średnie, bo dotyka flow generacji.

### PR 3: Cloud fallback

Zakres:

- `workflowModels.producerHunt.cloudFallback`,
- `producerHuntCloudFallbackAgent`,
- rejestracja w `index.ts`,
- podpięcie w `generateJsonWithFallback`.

Efekt:

- lokalny model nie jest single point of failure.

Ryzyko:

- średnie: wymagane działające credentials do wybranego providera.

### PR 4: Lead quality + identity checks

Zakres:

- `scoreLeadQuality`,
- `validateEnrichmentIdentity`,
- decyzje `draft_candidate/research_needed/reject`,
- statusy w CRM.

Efekt:

- mniej złych leadów i mniej kompromitujących maili.

Ryzyko:

- średnie/wysokie: może zmniejszyć liczbę draftów.

### PR 5: Draft quality guardrails

Zakres:

- `validateDraft`,
- repair z listą hard failures,
- cloud fallback przy twardym failu,
- deterministyczny fallback.

Efekt:

- mniej generycznych i niebezpiecznych draftów.

Ryzyko:

- średnie: może zwiększyć liczbę retry i koszt.

### PR 6: Observability

Zakres:

- strukturalne logi,
- opcjonalnie kolekcja `producer_hunt_logs`,
- raport końcowy w output/snapshot: counts + fallback stats.

Efekt:

- łatwa diagnostyka po runie.

Ryzyko:

- niskie.

## 16. Proponowane nowe metryki końcowe workflow

Dodać do outputu końcowego albo do `await-approval` metadata:

```ts
{
  requestedCount: number;
  discoveredCount: number;
  acceptedLeadCount: number;
  researchNeededCount: number;
  rejectedLeadCount: number;
  enrichedCount: number;
  identityMismatchCount: number;
  draftCount: number;
  localModelFailureCount: number;
  repairCount: number;
  cloudFallbackCount: number;
  deterministicFallbackCount: number;
}
```

Te metryki powinny być widoczne w snapshotach i/lub approval record.

## 17. Kryteria końcowej akceptacji

### Stabilność

- Workflow nie failuje na `rawAnalysis` jako object.
- Workflow nie failuje na `email/website` jako null.
- Nie ma nieobsłużonych wyjątków z parse JSON.
- Lokalny model może failować bez ubicia całego workflow.

### Jakość leadów

- Lead bez wiarygodnego potwierdzenia producenta nie idzie do draftu.
- Firma o podobnej nazwie z innego kraju/branży nie nadpisuje enrichmentu.
- `count=10` nie kończy discovery po 2 leadach bez dodatkowej próby.

### Jakość draftów

- Każdy draft ma stopkę RODO.
- Każdy draft używa `GastroBridge`.
- Żaden draft nie ma placeholderów.
- Żaden draft nie używa wymyślonej nazwy produktu/firmy.
- Generyczny draft jest naprawiany albo zastępowany fallbackiem.

### Operacje

- Logi pokazują model i fallback path.
- Ciężkie modele lokalne są wykrywane i logowane.
- Run z 5 leadami nie powinien crashować hosta.

## 18. Rekomendowany minimalny zakres na najbliższą implementację

Jeśli trzeba zrobić to szybko i bez dużego refaktoru, implementować tylko:

1. `normalizeTextField`.
2. `safeParse` przed `enriched.push`.
3. `safeParse` po draft JSON.
4. `producerHuntCloudFallbackAgent`.
5. Fallback local -> repair -> cloud -> deterministic dla enrichmentu i draftu.
6. Discovery fallback przy `leads.length < count`.
7. Draft guardrail dla placeholderów, RODO i `GastroBridge`.

To powinno usunąć aktualne awarie i znacząco poprawić jakość bez pełnego przebudowania workflow.

## 19. Notatki dla implementującego

1. Nie zmieniać na raz wszystkiego w jednym dużym commicie, jeśli można tego uniknąć.
2. Najpierw chronić kontrakty danych między stepami.
3. Dopiero potem poprawiać jakość leadów i draftów.
4. Każdy step LLM powinien mieć lokalną walidację przed zwróceniem outputu do Mastry.
5. Nie ufać typom generycznym `tryParseJson<T>()`.
6. Nie rozluźniać schematów outputu tylko po to, żeby workflow przechodził.
7. Jeśli coś jest niepewne, lepiej oznaczyć lead jako `research_needed` niż wygenerować błędny mail.
8. Cloud fallback ma być awaryjny i jawnie logowany, nie domyślny.
9. Po każdej zmianie restartować `mastra dev`; stare bundle mogą dalej używać poprzednich modeli/agentów.
10. Przy testach z Gmail upewnić się, że workflow zatrzymuje się na approval i nie wysyła maili bez zatwierdzenia.

