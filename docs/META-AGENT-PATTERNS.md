# Meta-Agent Orchestration Patterns

> Scenariusze testowe dla meta-agenta v3.  
> Dla każdego: input użytkownika → oczekiwana sekwencja toolcalli → output.  
> Testuj manualnie w **Mastra Studio** (`http://localhost:4111`) lub przez API.

---

## Scenariusz 1 — Parallel delegation (niezależne domeny)

**Input użytkownika:**
```
sprawdź stan n8n i jednocześnie daj mi raport tygodniowy — chcę mieć oba wyniki naraz
```

**Oczekiwane toolcalle (w jednym parallel batch):**
```
Turn 1 (parallel):
  → n8nHealthTool()
  → delegate_task(analyticsAgent, "GOAL: Generate weekly KPI report...")
```

**Co weryfikować:**
- W toolTrace Mastra Studio oba calle mają **nakładające się timestampy** (są równoległe, nie sekwencyjne)
- Odpowiedź łączy wyniki obu bez pytania o potwierdzenie
- `analyticsAgent` używa `qwen3-coder:30b` (lokalny)

**Red flag:** jeśli meta robi `n8nHealthTool` → czeka → dopiero potem `delegate_task` → to **błąd sekwencji** (poprawić prompt lub sprawdzić model)

---

## Scenariusz 2 — Ad-hoc worker (run_worker)

**Input użytkownika:**
```
przetłumacz mi ten tekst na język niemiecki i angielski jednocześnie:
"GastroBridge łączy producentów żywności z restauratorami w Polsce"
```

**Oczekiwane toolcalle:**
```
Turn 1 (parallel):
  → run_worker(preset='default', taskBrief='GOAL: Translate to German...')
  → run_worker(preset='default', taskBrief='GOAL: Translate to English...')
```

**Co weryfikować:**
- Meta NIE używa `delegate_task` (żaden expert nie ma tłumaczenia w domenie)
- Dwa `run_worker` lecą równolegle
- Model `ollama/local/gemma4:26b` widoczny w output `model` field
- Odpowiedź meta po polsku, tłumaczenia wklejone w czytelnym formacie

**Alternatywna ścieżka akceptowalna:**
- Jeden `run_worker(preset='default')` z briefem "translate to both German and English" — też OK

---

## Scenariusz 3 — Dekompozycja + synteza (N workers in parallel)

**Input użytkownika:**
```
mam 5 artykułów RSS, streszcz każdy w 2 zdaniach po polsku:
1. [tytuł + link artykułu 1]
2. [tytuł + link artykułu 2]
...
```

**Oczekiwane toolcalle:**
```
Turn 1 (parallel):
  → run_worker(fast, "GOAL: Summarize article 1 in 2 Polish sentences. INPUT: [artykuł 1]...")
  → run_worker(fast, "GOAL: Summarize article 2 in 2 Polish sentences. INPUT: [artykuł 2]...")
  → run_worker(fast, "GOAL: Summarize article 3 in 2 Polish sentences. INPUT: [artykuł 3]...")
  → run_worker(fast, "GOAL: Summarize article 4 in 2 Polish sentences. INPUT: [artykuł 4]...")
  → run_worker(fast, "GOAL: Summarize article 5 in 2 Polish sentences. INPUT: [artykuł 5]...")

Turn 2 (synthesis — meta itself):
  → compose final answer from 5 worker outputs
```

**Co weryfikować:**
- 5× `run_worker` w jednym batch (parallel)
- Preset `fast` (gemma4:e4b — wystarczy do prostych streszczeń)
- Meta NIE deleguje do `marketingAgent` — to nie jest zadanie kreatywne, tylko mechaniczne
- Brief każdego workera zawiera `INPUT:` z treścią artykułu (nie URL — worker nie ma narzędzi do fetch)

**Uwaga:** jeśli artykuły są tylko jako URL, meta powinna najpierw `searchWebTool` albo przyznać "nie mam treści artykułów, podaj mi tekst".

---

## Scenariusz 4 — Retry loop z krytyką

**Input użytkownika:**
```
napisz mi JSON z danymi fikcyjnej restauracji: nazwa, adres, 3 dania menu z cenami
```

**Oczekiwana sekwencja:**
```
Turn 1:
  → run_worker(fast, "GOAL: Generate restaurant JSON. OUTPUT FORMAT: {name, address, menu: [{dish, price_pln}]}")

Turn 1 output (celowo niepoprawny — np. ceny jako string "30 zł" zamiast number):
  → { name: "...", address: "...", menu: [{dish: "...", price_pln: "30 zł"}] }

Turn 2 (meta diagnozuje i retryuje):
  → run_worker(fast, ..., attemptNumber: 2, previousAttempt: {
      output: '...poprzedni JSON...',
      criticism: 'price_pln must be a number (e.g. 30), not a string ("30 zł")'
    })

Turn 2 output:
  → { name: "...", address: "...", menu: [{dish: "...", price_pln: 30}] }
```

**Co weryfikować:**
- `attemptNumber` rośnie w kolejnych callach
- `previousAttempt.criticism` zawiera konkretną diagnozę (nie tylko "spróbuj jeszcze raz")
- Po poprawnym output meta zapisuje lekcję:
  ```
  pushSignalTool({
    type: 'lesson_learned',
    data: {
      task_pattern: 'generate structured JSON with numeric price fields',
      lesson: 'Always specify in OUTPUT FORMAT that price_pln must be a number not a string',
      preset: 'fast'
    },
    ttlHours: 720
  })
  ```

**Test recall:** w nowej sesji, przed podobnym zadaniem:
```
  → recall_worker_lessons('generate restaurant JSON with prices')
  → powinno wrócić lesson z score > 0.45
```

---

## Scenariusz 5 — Hybrydowy (parallel delegation + worker synthesis)

**Input użytkownika:**
```
chcę zrobić kampanię outreach do restauratorów z Krakowa.
Znajdź mi leady z Krakowa, sprawdź czy mamy dla nich jakieś drafty emaili,
i przygotuj krótkie podsumowanie co wiemy o tym segmencie rynku z naszej bazy wiedzy.
```

**Oczekiwane toolcalle:**
```
Turn 1 (parallel — 3 niezależne zadania):
  → crm.search_leads(city='Kraków')
  → gmail.search('to restauratorzy Kraków draft')      ← z ToolSearchProcessor
  → delegate_task(analyticsAgent, "GOAL: Query knowledge base about Kraków HoReCa segment...")
    OR knowledgeQueryTool('rynek Kraków restauratorzy')  ← też OK

Turn 2 (synthesis — meta lub worker):
  → run_worker(reasoning, "GOAL: Synthesize 3 data sources into outreach brief.
     CONTEXT: [wyniki z Turn 1]
     OUTPUT FORMAT: markdown with sections: Segment overview, Key leads, Existing drafts, Recommended next steps")
```

**Co weryfikować:**
- Turn 1: wszystkie 3 akcje równoległe (timestamps overlap)
- Turn 2: meta używa `reasoning` preset — synteza 3 źródeł wymaga więcej niż `fast`
- Final reply po polsku, ustrukturyzowany markdown
- Jeśli brak leadów z Krakowa — meta komunikuje to wprost, nie hallucynuje

---

## Jak testować w Mastra Studio

1. Otwórz `http://localhost:4111`
2. Wejdź w **Agents → Meta Agent**
3. Wpisz input z scenariusza w polu chat
4. Po odpowiedzi kliknij **"Show reasoning"** (jeśli Gemini 2.5 Pro — widoczny chain-of-thought)
5. Sprawdź **toolTrace** — każdy tool z timestampem i inputem/outputem

**Równoległość:** przy parallel batch toolcalle powinny mieć overlapping `startedAt`/`endedAt`.  
W Mastra Studio 1.31 toolTrace pokazuje je jako osobne wiersze — sprawdź czy `startedAt` drugiego jest przed `endedAt` pierwszego.

---

## Czerwone flagi (rzeczy które świadczą o problemie)

| Symptom | Prawdopodobna przyczyna | Fix |
|---|---|---|
| Meta serializuje zawsze (jeden tool, czeka, drugi tool) | Prompt nie daje wystarczającego sygnału do parallel | Sprawdź `meta/base.md` §Parallel |
| `run_worker` zwraca `success: false` dla lokalnych modeli | Ollama nie działa lub model nie pobrany | `ollama list`, `systemctl status ollama` |
| `recall_worker_lessons` zwraca 0 wyników zawsze | Brak lessons w DB lub embedder down | Sprawdź Google API key, `signals` collection w Mongo |
| Meta używa `delegate_task` zamiast `run_worker` dla tłumaczenia | OK — oba podejścia akceptowalne, ale `run_worker` tańsze | Edukacyjne, nie błąd |
| Meta nie pisze `taskBrief` po angielsku | Prompt v3 powinien to wymuszać | Sprawdź czy `meta/base.md` v3 się załadował |
| Odpowiedź meta to surowy JSON `{thought, reply}` | `response.md` wciąż w `combinePrompts` | Sprawdź `buildInstructions()` w meta-agent.ts |

---

*Ostatnia aktualizacja: 2026-05-05 — po wdrożeniu meta-agent v3 + Etap 1 (run_worker + recall_lessons)*
