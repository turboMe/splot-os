# Producer Hunt: enrichment dopasowany do typu

Ten dokument opisuje fazę enrichmentu po PR D. Przed PR D enrichment zakładał, że pracuje
z producentem rzemieślniczym: jedna strona WWW dodawana do NotebookLM, jedno generyczne
pytanie o tradycję rodzinną i certyfikaty, fallback hook "Producent żywności z regionu X".
Po PR D każdy etap enrichmentu jest dopasowany do `supplierType` z PR A/B/C.

Plan: [ideas/producer-hunt-fix-v3.md §5](../ideas/producer-hunt-fix-v3.md).
Klasyfikacja: [producer-hunt-supplier-types.md](producer-hunt-supplier-types.md).
Discovery: [producer-hunt-discovery.md](producer-hunt-discovery.md), [producer-hunt-discovery-prompts.md](producer-hunt-discovery-prompts.md).

## Pipeline enrichmentu (per lead)

Każdy lead przechodzi sekwencyjnie:

1. **Tavily `findCompanyLinksTool`** — bez zmian. Daje website + LinkedIn + Facebook + searchContext.
2. **Tavily extra-query per typ** *(nowe)* — `additionalSearchQueryForType` z [enrichment-prompts.ts](../src/mastra/workflows/producer-hunt/enrichment-prompts.ts) buduje precyzyjne zapytanie zorientowane na typ. Wynik jest doklejany do `leadContext` jako "Type-specific context".
3. **NotebookLM Deep Research** *(rozszerzone)* — strona główna + 4 podstrony zależne od typu (`additionalSourcePathsForType`) + Tavily searchContext jako tekst.
4. **NotebookLM query** *(per typ)* — `researchQuestionFor(supplierType, lead)` zamiast generycznego pytania o producenta.
5. **Final LLM polish** *(per typ)* — `finalEnrichmentPromptFor` zamiast inline promptu. Pyta o dane dopasowane do typu i prosi o `supplierType` w outpucie.
6. **Identity guardrail** — z PR A; przy mismatch hook resetowany do `defaultHookForType(supplierType, region)` zamiast zawsze "Producent żywności".
7. **Post-research scoring** — `scoreLead` z PR A; segment CRM ustawiany przez `mapToCrmSegment(inferredSupplierType)`.

## Plik: [enrichment-prompts.ts](../src/mastra/workflows/producer-hunt/enrichment-prompts.ts)

PR D wydziela cały prompt engineering do osobnego pliku:

| Funkcja                            | Cel                                                                                 |
| ---                                | ---                                                                                 |
| `defaultHookForType(type, region)` | Domyślny fallback hook (per typ) — używany w 3 miejscach (final LLM fallback, identity-mismatch reset, schema-fallback) |
| `additionalSourcePathsForType(type)` | Lista podstron URL do dodania do NotebookLM (`/asortyment`, `/portfolio`, `/marki`, `/czlonkowie`, ...) |
| `additionalSearchQueryForType(type, company)` | Dodatkowe zapytanie Tavily (np. dla hurtowni: `"X" hurtownia HoReCa minimum zamówienia dostawa restauracje`) |
| `researchQuestionFor(type, lead)`  | Pełne pytanie do NotebookLM z sekcjami `PERSONALIZATION_HOOK:` i `DEEP_ANALYSIS:`   |
| `finalEnrichmentPromptFor(args)`   | Prompt finalny dla LLM, zwracający `enrichmentResponseSchema`-zgodny JSON           |

## Multi-source per typ

Tabela podstron NotebookLM:

| Typ                                 | Podstrony URL                                                                |
| ---                                 | ---                                                                          |
| `producer` / `manufacturer`         | `/o-nas`, `/produkty`, `/aktualnosci`, `/kontakt`                            |
| `wholesaler`                        | `/asortyment`, `/oferta`, `/dla-gastronomii`, `/horeca`, `/cennik`, `/kontakt` |
| `distributor`                       | `/marki`, `/portfolio`, `/oferta`, `/horeca`, `/kontakt`                     |
| `cooperative` / `producer_group` / `farm_aggregator` | `/o-nas`, `/czlonkowie`, `/produkcja`, `/aktualnosci`, `/kontakt` |
| `importer`                          | `/marki`, `/portfolio`, `/dla-gastronomii`, `/kontakt`                       |
| `unknown`                           | `/o-nas`, `/oferta`, `/kontakt`                                              |

Implementacja:
- max 4 ekstra podstrony per lead (`extraPaths.slice(0, 4)`), żeby NotebookLM nie zwolnił
- 404 jest tolerowane (nie pre-fetchujemy, NLM ignoruje brakujące zasoby)
- doklejane równolegle przez `Promise.all`, każdy `addSource` ma `.catch(() => null)` — pojedyncza porażka nie blokuje reszty

## Pytania per typ (skrót)

Producer / manufacturer — niezmienione (produkty, skala, certyfikaty, tradycja).

Wholesaler — pyta o asortyment, marki własne i obce, obsługę HoReCa, minimum zamówienia, zasięg dostaw.

Distributor — marki w portfolio, ekskluzywne przedstawicielstwa, region, specjalizacja kulinarna.

Cooperative / producer_group / farm_aggregator — ilu członków, jakie kategorie, model sprzedaży zbiorczej, HoReCa.

Importer — kraje pochodzenia, wyłączności, fine dining vs casual.

Unknown — najpierw ustal typ, potem co konkretnie wiadomo o firmie. Hook neutralny.

Wszystkie szablony kończą się sekcjami `PERSONALIZATION_HOOK:` i `DEEP_ANALYSIS:` — ten format jest parsowany regexem w `enrich-leads`.

## Final LLM prompt

`finalEnrichmentPromptFor`:

- przekazuje `supplierType` jako kontekst (zaszyte w briefingu),
- prosi o `supplierType`/`directToHoreca`/`brandsOrPortfolio`/`servesRegions` w outpucie (PR A schema),
- jawnie mówi "dla hurtowni odwołuj się do oferty HoReCa, nie do rzemieślniczego wytwarzania" — to przeciwdziała sytuacji, gdy lokalny model wraca do producent-stylu po samym imieniu firmy,
- ustawia bazę dla pola `identityWarning`, gdy model zmienia typ względem discovery.

## Default hook per typ

Mapping:

| Typ              | Hook                                                  |
| ---              | ---                                                   |
| `producer`       | `Producent żywności z regionu ${region}.`             |
| `manufacturer`   | `Zakład przetwórstwa z regionu ${region}.`            |
| `wholesaler`     | `Hurtownia spożywcza obsługująca region ${region}.`   |
| `distributor`    | `Dystrybutor żywności obsługujący ${region}.`         |
| `importer`       | `Importer specjalistyczny w regionie ${region}.`      |
| `cooperative`    | `Zrzeszenie producentów z regionu ${region}.`         |
| `producer_group` | `Zrzeszenie producentów z regionu ${region}.`         |
| `farm_aggregator`| `Platforma producentów z regionu ${region}.`          |
| `unknown`        | `Producent żywności z regionu ${region}.` *(fallback)*|

## Kontekst rynkowy (notatnik `rynek`)

Pytanie do notatnika `rynek` zostało zmienione z producer-only na neutralne:

```
Jakie są najważniejsze trendy i wyzwania dla dostawców żywności (producentów, hurtowni,
dystrybutorów) obsługujących HoReCa w regionie ${region}?
```

Dzięki temu market context dla hurtowni i dystrybutorów nie jest stronniczy.

## Identity guardrail przy mismatch

`validateEnrichmentIdentity` zwraca `ok: false` gdy:

- nazwa firmy z enrichmentu nie ma wspólnych tokenów z lead.company (-0.6),
- domena emaila nie pasuje do domeny website (-0.6 producent / -0.2 hurtownia/dystrybutor/importer),
- domena wygląda na zagraniczny podmiot (-0.2),
- model klasyfikuje typ inaczej niż heurystyka (-0.2). *(z PR A)*

Przy mismatch:
- `personalizationHook` reset → `defaultHookForType(declaredOrInferredType, region)` zamiast zawsze "Producent żywności".
- `rawAnalysis` reset → `Wstępny research dla ${company}. Wymaga weryfikacji tożsamości. Original analysis: ...`.

Lead nie jest odrzucany — może iść jako `research_needed`, jeśli post-research score nie przejdzie progu draft.

## Diagnostyka

Konsola enrichmentu:

```
[producer-hunt:<taskId>] enriching lead: Hurtownia X (type=wholesaler)...
[producer-hunt:<taskId>] post-research quality Hurtownia X: type=wholesaler, decision=draft_candidate, score=78, reasons=type: wholesaler; +25: poprawny email; +20: website wygląda jak oficjalna strona; +15: sygnał hurtowni / sprzedaży B2B; +15: bezpośrednia sprzedaż do HoReCa; ...
```

W CRM (`db.leads.metadata`):

- `supplierType` (heurystyka po researchu),
- `directToHoreca`,
- `brandsOrPortfolio`,
- `servesRegions`,
- `enrichmentPreview` z preview rawAnalysis.

## Co PR D świadomie nie zmienia

- Drafty cold-email — PR E.
- `validateDraft` dalej wymaga frazy "GastroBridge" i stopki RODO, ale dla hurtowni/dystrybutora nie powinien blokować innego copywritingu — to PR E.
- `update-crm` zapisuje segment per typ (PR A), więc `enriched.inferredSupplierType` → segment już płynie do CRM bez dodatkowych zmian.

PR D zamyka research. Po PR D mamy:

1. Bogaty basen kandydatów (PR B),
2. Klasyfikacja przy discovery (PR C) i przy heurystyce (PR A),
3. Multi-source NotebookLM + per-typ pytania + per-typ final LLM (PR D).

Hurtownia/dystrybutor po enrichmencie ma `rawAnalysis` o swoim portfolio i HoReCa, a nie o "rzemieślniczym wytwarzaniu". `personalizationHook` jest dopasowany do typu. Pozostaje napisać do nich mail dopasowany do typu — to PR E.
