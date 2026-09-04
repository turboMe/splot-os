# Producer Hunt: stabilność i diagnostyka (v2)

Ten dokument opisuje warstwę stabilności i diagnostyki workflow `producer-hunt` po wdrożeniu
planu [producer-hunt-fix-v2.md](../ideas/producer-hunt-fix-v2.md). Wszystkie zmiany są
ortogonalne do planu v3 (typologia dostawcy) — łączą się ze sobą w pełni.

Plan: [ideas/producer-hunt-fix-v2.md](../ideas/producer-hunt-fix-v2.md).
Reszta dokumentacji workflow: [producer-hunt-prompts-workflow-docs.md](producer-hunt-prompts-workflow-docs.md).

## Mapa zmian

| Punkt v2 | Co | Pliki |
| --- | --- | --- |
| **P0.2** | Fallback draft w outer-catch `draft-cold-emails`. Gdy `generateJsonWithFallback` rzuci wyjątek poza swoim deterministic fallbackiem, używamy `fallbackDraftFor` (per typ z PR E) i pushujemy draft do listy zamiast pomijać lead. | [producer-hunt.ts](../src/mastra/workflows/producer-hunt.ts) |
| **P0.3** | Validate-output gating po `draft-cold-emails`. `valid_email_but_zero_drafts` → twardy throw + log do `logs`. `no_reachable_leads` → tylko log, workflow leci dalej. | [producer-hunt.ts](../src/mastra/workflows/producer-hunt.ts) |
| **P1.5** | Outer-catch `enrich-leads` zachowuje dane z NotebookLM/Tavily. Zmienne `nlmAnalysis`/`nlmHook`/`leadContext` wyniesione na poziom pętli; fallback rawAnalysis bierze pierwszą niepustą z `[nlm, leadContext, lead.reason, 'Enrichment niedostępny.']`. Diagnostyka pisana do `metadata.preservedSource`. | [producer-hunt.ts](../src/mastra/workflows/producer-hunt.ts) |
| **P1.6** | Deterministyczny regex w `extract-emails`. Kolejność: regex → local LLM → cloud. Helper `extractEmailsFromText` + `pickBestEmail` z preferencją domeny website. | [email.ts](../src/mastra/workflows/producer-hunt/email.ts), [producer-hunt.ts](../src/mastra/workflows/producer-hunt.ts) |
| **P2.7** | Strukturalne logi do MongoDB collection `logs`. Helper `logProducerHuntEvent` używany w 6 stepach: discovery, quality, enrichment, email-extraction, draft, validate-output. | [logging.ts](../src/mastra/workflows/producer-hunt/logging.ts), [producer-hunt.ts](../src/mastra/workflows/producer-hunt.ts) |
| **P2.8** | Notebook cleanup z retry (1s/3s/5s) i audytem. Helper `cleanupNotebook` zastępuje `.catch(() => {})` w `discover-leads` i `enrich-leads`. Sukces/porażka idą do `logs` przez `logProducerHuntEvent`. | [notebook-cleanup.ts](../src/mastra/workflows/producer-hunt/notebook-cleanup.ts), [producer-hunt.ts](../src/mastra/workflows/producer-hunt.ts) |

Zachowane bez zmian (już zrobione przed v2):

- **P0.1**: rejestracja agentów producer-hunt — `producerHuntCloudFallbackAgent` itd. są w `mastra.agents`.
- **P1.4**: discovery dobija przy `leads.length < count` — PR B wprowadził multi-round + city-level + budżet 30 zapytań. Plan v2 zakładał tylko warzywa per region; PR B ma multi-profile per typ dostawcy.

## P0.2 — fallback draft w outer-catch

```ts
} catch (err) {
  console.warn(...);
  const safeDraft = fallbackDraft();          // = fallbackDraftFor(draftType, ...)
  const safeValidation = validateDraft(safeDraft, lead);
  if (safeValidation.ok) {
    drafts.push({...});
    fallbackDraftedCount++;
    await logProducerHuntEvent({ event: 'draft_fallback_used', ... });
  } else {
    failedCount++;
    await logProducerHuntEvent({ event: 'draft_fallback_invalid', level: 'error', ... });
  }
}
```

Awaria pojedynczego modelu nie zeruje draftów dla wszystkich leadów. `fallbackDraftFor` z PR E
zawsze zwraca poprawny draft (RODO + GastroBridge + neutralny opener per typ), więc
`safeValidation.ok === false` jest skrajne — występuje tylko gdy `fallbackDraftFor` ma bug.

## P0.3 — validate-output gating

Po pętli draftowania:

```ts
const validEmailCount = enrichedWithEmails.filter((l) => isValidEmail(l.email)).length;

if (drafts.length === 0) {
  const reason = validEmailCount > 0 ? 'valid_email_but_zero_drafts' : 'no_reachable_leads';
  // log do MongoDB
  await logProducerHuntEvent({ event: 'producer_hunt_needs_attention', skippedReason: reason, ... });

  if (validEmailCount > 0) {
    throw new Error('Producer Hunt needs attention: ...');  // workflow widoczny jako failed
  }
  // dla validEmailCount === 0 workflow idzie dalej do await-approval (zwróci 'Brak draftów.')
}
```

Diagnostyka po runie:

```js
db.logs.find({
  taskId: "<taskId>",
  message: { $in: ["producer_hunt_needs_attention", "draft_summary"] }
})
```

## P1.5 — preserve NLM data

Przed v2 outer-catch ustawiał `'Enrichment niedostępny.'` nawet gdy NotebookLM zdążył dać wyniki, tylko finalne LLM padło. Po v2:

```ts
let nlmAnalysis = '';
let nlmHook = '';
let leadContext = '';
let preservedSource: 'nlm' | 'searchContext' | 'leadReason' | 'none' = 'none';

try {
  // ... cały enrichment ...
} catch (err) {
  const preservedAnalysis =
    normalizeTextField(nlmAnalysis, '')
    || normalizeTextField(leadContext, '')
    || normalizeTextField(lead.reason, '')
    || 'Enrichment niedostępny.';
  // ... aktualizacja CRM z metadata.preservedSource ...
}
```

W CRM: `db.leads.metadata`:

```js
{
  enrichmentError: "...",
  usedPreservedNlmData: true,
  preservedSource: "nlm" | "searchContext" | "leadReason" | "none"
}
```

## P1.6 — deterministyczny regex

Nowy plik: [email.ts](../src/mastra/workflows/producer-hunt/email.ts).

- `extractEmailsFromText(text)` — regex `/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi` + strip trailing punctuation + lower-case domeny + filtr placeholderów (`example.com`, `test@`, `name@domain`, `noreply`, ...).
- `pickBestEmail({ rawAnalysis, emailSource, website, sourceUrls, leadContext })` — agreguje źródła, ekstraktuje, preferuje email z domeny pasującej do `website`.

Pętla `extract-emails`:

```
if (lead.email valid) → out.push, alreadyHadEmail++
else regex po (rawAnalysis + emailSource + website + sourceUrls)
  ├ znalezione → out.push, foundByRegex++
  ├ nic → local LLM
  │   ├ znalezione → foundByLocalLlm++
  │   └ nic → cloud
  │       ├ znalezione → foundByCloud++
  │       └ nic → stillMissing++ (lead idzie dalej bez maila)
```

Diagnostyka summary trafia do `logs` jako `email_extraction_summary`:

```json
{
  "alreadyHadEmail": 3,
  "foundByRegex": 4,
  "foundByLocalLlm": 1,
  "foundByCloud": 0,
  "stillMissing": 2,
  "total": 10
}
```

Korzyść: lead z emailem w stopce strony WWW (NotebookLM dokleił do `rawAnalysis`) nie potrzebuje LLM. Oszczędność tokenów ~25-50% przy hurtowniach (które mają emaile w stopkach).

## P2.7 — strukturalne logi do MongoDB

Helper: [logging.ts](../src/mastra/workflows/producer-hunt/logging.ts).

```ts
export async function logProducerHuntEvent(event: {
  taskId, stepId, event, level?, company?, metrics?, skippedReason?, error?
}): Promise<void>
```

Zapisuje do `db.logs` dokument:

```ts
{
  timestamp: Date,
  level: 'debug' | 'info' | 'warn' | 'error',
  agentId: 'producer-hunt-workflow',
  taskId, stepId,
  message: <event>,
  data: { company?, ...metrics, skippedReason?, error? }
}
```

Eventy zapisywane przez workflow:

| Step | Event |
| --- | --- |
| `discover-leads` | `discover_summary` (rawHits, queriesIssued, queryBudget, found, validEmail, withWebsite, acceptableSupplierTypes) |
| `discover-leads` | `notebook_cleanup_success` / `notebook_cleanup_failed` |
| `create-research-leads` | `quality_summary` (qualitySummary + bySupplierType) |
| `enrich-leads` | `enrichment_summary` (inputCandidates, enrichedAccepted, enrichedRejected, enrichedByType) |
| `enrich-leads` | `notebook_cleanup_success` / `notebook_cleanup_failed` (per lead) |
| `extract-emails` | `email_extraction_summary` (alreadyHadEmail, foundByRegex, foundByLocalLlm, foundByCloud, stillMissing, total) |
| `draft-cold-emails` | `draft_summary` (drafted, fallbackDrafted, skippedNoEmail, failed, draftedByType) |
| `draft-cold-emails` | `draft_fallback_used` (per lead) — gdy P0.2 ratuje draft po wyjątku |
| `draft-cold-emails` | `draft_fallback_invalid` (per lead) — gdy nawet fallback nie przeszedł walidacji |
| `draft-cold-emails` | `producer_hunt_needs_attention` (P0.3) |

Diagnostyka po runie:

```js
db.logs.find({ taskId: "<taskId>" }).sort({ timestamp: 1 })
```

Funnel można odtworzyć z 4 dokumentów: `discover_summary` → `quality_summary` → `enrichment_summary` → `email_extraction_summary` → `draft_summary`. Plus `producer_hunt_needs_attention` jeśli było.

## P2.8 — notebook cleanup retry

Helper: [notebook-cleanup.ts](../src/mastra/workflows/producer-hunt/notebook-cleanup.ts).

```ts
cleanupNotebook({
  taskId, stepId,
  notebookId,
  title?, kind?,
}) → { success, attempts, lastError? }
```

Zachowanie:
- 3 próby z opóźnieniami `1s`, `3s`, `5s`,
- każdy sukces → `notebook_cleanup_success` z `attempts`,
- po 3 porażkach → `notebook_cleanup_failed` (level `warn`) z `lastError`,
- helper nigdy nie rzuca — workflow nie pada na cleanupie.

Użyty w 2 miejscach:
- `discover-leads` finally (po Discovery Notebook),
- `enrich-leads` per-lead finally (po Deep Research notebook).

Diagnostyka po runie — które notatniki zostały osierocone:

```js
db.logs.find({
  message: "notebook_cleanup_failed",
  taskId: "<taskId>"
}, {
  "data.notebookId": 1,
  "data.title": 1,
  "data.kind": 1,
  "data.error": 1
})
```

Cleanup może systemowo padać (n8n MCP zwracał wcześniej `405 method not allowed` na delete) — wtedy mamy listę `notebookId` do ręcznego sprzątnięcia, zamiast cichego wycieku.

## Podsumowanie

Po v2 + v3 workflow ma:

- discovery z multi-profile, multi-round i bogatym basenem URL (PR B),
- klasyfikację supplierType na każdym etapie (PR A/C),
- enrichment dopasowany do typu z multi-source NotebookLM (PR D),
- drafty per typ z fallbackiem outer-catch (PR E + P0.2),
- regex email extraction przed LLM (P1.6),
- preservation NLM data przy padzie LLM (P1.5),
- gating wymuszający atencję przy `drafts=0` z poprawnymi mailami (P0.3),
- pełny funnel diagnostyki w `db.logs` (P2.7),
- audytowalny cleanup notebooków NotebookLM (P2.8).

Workflow jest stabilniejszy, tańszy (mniej wywołań LLM dzięki regex) i mierzalny (jeden query Mongo daje pełen obraz runu).
