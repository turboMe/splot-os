# Stabilny Meta Agent dla Gemma4:26B

## Cel dokumentu

Ten dokument opisuje docelową architekturę Meta Agenta opartego o lokalny model `gemma4:26b`, który ma działać stabilnie w pętli ReAct, używać narzędzi, minimalizować problem `lost in the middle` i nie gubić się przy dłuższych instrukcjach.

Kluczowa zasada:

```txt
Nie budujemy jednego ogromnego prompta.
Budujemy mały runtime agenta, który dynamicznie składa krótki prompt i pilnuje reguł poza modelem.
```

Model ma podejmować decyzję, a kod ma pilnować:

- formatu JSON,
- limitów kroków,
- wyboru dostępnych narzędzi,
- approval flow,
- błędów narzędzi,
- powtarzania tych samych akcji,
- skracania obserwacji,
- fallbacku do mocniejszego modelu.

---

# 1. Główna zasada architektoniczna

Gemma nie powinna dostawać jednego dużego prompta z całą dokumentacją narzędzi, przykładami, wyjątkami i procedurami.

Zamiast tego:

```txt
Agent Runtime = kod sterujący
Gemma = decydent następnego kroku
Tools = osobne funkcje
Validator = kontrola JSON i reguł
Prompt Builder = dynamiczne składanie krótkiego prompta
```

Gemma ma tylko odpowiedzieć na jedno pytanie:

```txt
Czy teraz:
1. odpowiedzieć użytkownikowi,
2. użyć jednego narzędzia,
3. zapytać o brakujące dane?
```

Cała dyscyplina operacyjna ma być w runtime, nie w samym promptcie.

---

# 2. Docelowa architektura

```txt
/user input
   ↓
Intent Router
   ↓
Prompt Builder
   ↓
Gemma4:26B
   ↓
JSON Validator
   ↓
Tool Executor / Final Answer
   ↓
Observation Summarizer
   ↓
Loop max 3-8 kroków
```

## Komponenty

| Komponent | Odpowiedzialność |
|---|---|
| `Intent Router` | Rozpoznaje typ zadania użytkownika |
| `Tool Selector` | Wybiera tylko narzędzia potrzebne do aktualnego zadania |
| `Recipe Selector` | Wybiera krótkie procedury pasujące do zadania |
| `Prompt Builder` | Składa krótki prompt dla modelu |
| `Gemma4:26B` | Podejmuje decyzję o następnym kroku |
| `JSON Validator` | Sprawdza, czy odpowiedź modelu jest poprawna |
| `Tool Executor` | Wykonuje narzędzie |
| `Observation Summarizer` | Skraca wynik narzędzia przed kolejnym krokiem |
| `Stop Conditions` | Pilnuje limitów, błędów i approval flow |
| `Fallback Router` | W razie potrzeby przełącza zadanie na mocniejszy model |

---

# 3. Podział promptów

## A. Stały system prompt

Krótki. Zawsze taki sam.

Zawiera tylko:

- wymagany format JSON,
- podstawową logikę ReAct,
- zakaz wymyślania narzędzi,
- zasadę jednego narzędzia na krok,
- zasadę `action` albo `finalAnswer`, nigdy oba,
- ogólne stop conditions.

Nie zawiera:

- długich przykładów CRM,
- pełnych opisów Gmail,
- pełnych opisów RSS,
- pełnych opisów automatyzacji,
- wielu przykładów,
- całego tool manifestu.

## B. Dynamiczny kontekst

Dodawany zależnie od zadania.

| Typ zadania | Co dokładamy do prompta |
|---|---|
| CRM | tylko narzędzia CRM + mini recipe CRM |
| Gmail draft | Gmail + CRM recipe |
| RSS/news | RSS recipe |
| automatyzacja | architect recipe |
| ogólne pytanie | prawie nic, finalAnswer od razu |
| brak narzędzia | `system.search_tools` |

---

# 4. Kolejność finalnego prompta

To jest ważne, bo lokalne modele często gubią instrukcje ze środka prompta.

Rekomendowana kolejność:

```txt
[1] SYSTEM CORE
[2] AKTUALNE ZADANIE UŻYTKOWNIKA
[3] DOSTĘPNE NARZĘDZIA DLA TEGO ZADANIA
[4] RELEVANT RECIPES, maksymalnie 1-3
[5] AKTUALNY STAN PĘTLI
[6] OSTATNIA OBSERWACJA
[7] WYMAGANY FORMAT JSON
```

Najważniejsze instrukcje powinny być na początku i na końcu. Nie chowamy krytycznych zasad w środku.

---

# 5. Tool filtering

Nie podawać Gemmie wszystkich narzędzi.

Zrobić funkcję:

```ts
selectRelevantTools(userInput, allTools): ToolDefinition[]
```

Przykład:

```ts
if task contains "lead", "status", "CRM":
  return crm tools

if task contains "mail", "draft", "email":
  return gmail tools + crm search

if task contains "news", "rss", "digest":
  return rss tools

if task contains "bot", "workflow", "automation", "integracja":
  return architect tools

else:
  return minimal tools: memory.search, knowledge.query, system.search_tools
```

Limit:

```txt
Maksymalnie 8-12 narzędzi w promptcie.
Najlepiej 3-7.
```

Gemma nie powinna widzieć 22 narzędzi, jeśli zadanie dotyczy tylko maila.

---

# 6. Krótki tool manifest

Zamiast pełnych opisów narzędzi używać krótkiego manifestu.

Przykład:

```json
{
  "name": "crm.search_leads",
  "description": "Search CRM leads by query, status, email or company.",
  "args": {
    "query": "string optional",
    "status": "string optional",
    "limit": "number optional"
  }
}
```

Nie dawać długiej dokumentacji narzędzia do prompta.

Długa dokumentacja powinna być w kodzie, testach albo osobnych recipe cards.

---

# 7. Recipe cards

Zamiast jednego wielkiego prompta zrobić małe karty procedur.

Proponowana struktura plików:

```txt
/prompts/core/system-core.md
/prompts/core/output-schema.md

/prompts/recipes/crm-status-update.md
/prompts/recipes/gmail-draft-from-crm.md
/prompts/recipes/rss-digest.md
/prompts/recipes/automation-design.md
/prompts/recipes/tool-discovery.md
```

## Przykład recipe: Gmail draft for CRM lead

```md
# Recipe: Gmail draft for CRM lead

Use when user asks to create or edit an email draft for a CRM lead.

Steps:
1. If lead identity is unclear, ask user via finalAnswer.
2. If lead is named but email/id is unknown, call crm.search_leads.
3. Create new draft with gmail.create_draft.
4. If lead came from CRM, include crmLeadIdOrEmail.
5. To edit existing draft, use gmail.update_draft, not delete/create.
6. Stop after pendingApproval.
```

Prompt Builder powinien ładować tylko potrzebne recipe cards.

---

# 8. Walidator JSON poza modelem

To jest obowiązkowe.

Po odpowiedzi Gemmy:

```ts
validateAgentResponse(response)
```

Sprawdzić:

```txt
1. Czy to poprawny JSON?
2. Czy ma pola: thought, action, finalAnswer?
3. Czy action i finalAnswer nie są oba ustawione?
4. Czy jeśli action != null, tool istnieje?
5. Czy args pasują do schematu narzędzia?
6. Czy nie przekroczono max kroków?
7. Czy nie powtórzono bez sensu tego samego narzędzia?
8. Czy tool nie wymaga approval?
```

Jeśli JSON jest popsuty:

1. Jedna próba naprawy przez lokalny model z krótkim repair promptem.
2. Jeśli dalej źle, zwrócić kontrolowany błąd.

Nie puszczać popsutego JSON dalej.

---

# 9. JSON repair prompt

Osobny krótki prompt:

```txt
Napraw poniższą odpowiedź tak, aby była dokładnie jednym poprawnym obiektem JSON.
Nie zmieniaj intencji.
Nie dodawaj komentarzy.
Zwróć tylko JSON.

Wymagany kształt:
{
  "thought": "string",
  "action": null lub { "tool": "string", "args": {} },
  "finalAnswer": null lub "string"
}

Odpowiedź do naprawy:
{{BROKEN_OUTPUT}}
```

---

# 10. Runtime pilnuje limitów

Nie ufać modelowi, że sam zakończy pętlę.

W kodzie:

```ts
const limits = {
  defaultMaxSteps: 4,
  crmGmailMaxSteps: 8,
  maxSameToolErrors: 2,
  maxSimilarReadCalls: 2
};
```

Każdy krok zapisywać:

```ts
state.steps.push({
  thought,
  action,
  observation,
  error,
  timestamp
});
```

Runtime powinien mieć prawo przerwać pętlę niezależnie od tego, co model chce zrobić.

---

# 11. Observation summarizer

Nie wkładać pełnych odpowiedzi narzędzi do kolejnego prompta, jeśli są duże.

Zrobić kompresję obserwacji:

```ts
summarizeObservation(toolName, rawObservation)
```

Przykład dla CRM:

```json
{
  "tool": "crm.search_leads",
  "summary": "Found 1 lead: TechCorp, email info@techcorp.pl, status sent, enrichment available, draft missing.",
  "importantFields": {
    "company": "TechCorp",
    "email": "info@techcorp.pl",
    "status": "sent",
    "hasDraft": false
  }
}
```

Do prompta wrzucać summary, nie pełny JSON, chyba że pełny wynik jest mały.

---

# 12. Memory i knowledge tylko na żądanie

Nie robić automatycznego `memory.search` przy każdym zadaniu.

Zasada:

```txt
memory.search tylko gdy:
- użytkownik mówi "wcześniej", "pamiętasz", "ostatnio", "nasze ustalenia",
- brakuje kontekstu, który mógł być w pamięci,
- zadanie wymaga decyzji strategicznej opartej na historii.
```

Inaczej model zacznie niepotrzebnie odpalać pamięć dla smalltalku.

---

# 13. Intent Router przed Gemmą

Najlepiej zrobić prosty deterministyczny router w kodzie.

Nie musi być LLM.

Przykład:

```ts
function detectIntent(input: string): AgentIntent {
  const text = input.toLowerCase();

  if (containsAny(text, ["lead", "crm", "status firmy", "kontakt"])) {
    return "crm";
  }

  if (containsAny(text, ["mail", "email", "draft", "wiadomość"])) {
    return "gmail";
  }

  if (containsAny(text, ["rss", "newsy", "digest", "artykuły"])) {
    return "rss";
  }

  if (containsAny(text, ["bot", "workflow", "automatyzacja", "router", "integracja"])) {
    return "automation";
  }

  return "general";
}
```

Potem:

```ts
const intent = detectIntent(userInput);
const tools = selectTools(intent);
const recipes = selectRecipes(intent);
const maxSteps = selectStepLimit(intent);
```

---

# 14. Prompt Builder

Przykład struktury:

```ts
const prompt = buildPrompt({
  systemCore,
  userInput,
  tools: selectedTools,
  recipes: selectedRecipes,
  stateSummary,
  lastObservation,
  outputSchema
});
```

Przykładowy finalny prompt do modelu:

```txt
Jesteś Meta Agentem ReAct. Zwracasz tylko jeden JSON.

ZADANIE UŻYTKOWNIKA:
"Zmień status firmy TechCorp na zainteresowany"

DOSTĘPNE NARZĘDZIA:
[
  {
    "name": "crm.search_leads",
    "description": "Search CRM leads.",
    "args": { "query": "string", "status": "string", "limit": "number" }
  },
  {
    "name": "crm.update_status",
    "description": "Update CRM lead status.",
    "args": { "idOrEmail": "string", "status": "string", "reason": "string" }
  }
]

RECIPE:
Before updating a CRM lead, search it first to confirm id or email.

STATE:
step=1, maxSteps=4, previousActions=[]

OUTPUT:
Return exactly one JSON:
{
  "thought": "string",
  "action": null or { "tool": "string", "args": {} },
  "finalAnswer": null or "string"
}
```

---

# 15. Approval handling

Approval flow powinien być pilnowany w kodzie.

Jeśli tool zwróci:

```json
{
  "pendingApproval": true
}
```

Runtime ustawia flagę:

```ts
state.pendingApproval = true;
```

I wymusza zakończenie:

```json
{
  "thought": "Akcja wymaga zatwierdzenia.",
  "action": null,
  "finalAnswer": "Akcja została przygotowana i czeka na zatwierdzenie."
}
```

Nie wolno pozwalać modelowi odpalić tego samego toola drugi raz.

---

# 16. Fallback do mocniejszego modelu

Gemma4:26B powinna być domyślna, ale nie do wszystkiego.

Proponowany routing:

```txt
Gemma4:26B:
- proste CRM,
- drafty,
- routing,
- podsumowania,
- planowanie prostych workflow,
- klasyfikacja.

Cloud Gemini / Claude / GPT:
- długie strategiczne plany,
- trudne research tasks,
- skomplikowana architektura automatyzacji,
- naprawa błędnych workflow,
- analiza dużych dokumentów.
```

Warunki fallbacku:

```ts
if jsonRepairFailed:
  escalateToCloudModel();

if stepCount > 4 and noProgress:
  escalateToCloudModel();

if taskComplexity === "high":
  useCloudModel();

if userExplicitlyRequestsDeepReasoning:
  useCloudModel();
```

---

# 17. Model settings

Dla agenta narzędziowego:

```txt
temperature: 0.1-0.3
top_p: 0.8-0.95
repeat_penalty: umiarkowany
max_tokens: wystarczające, ale nie ogromne
```

Niski temperature zwiększa stabilność JSON i wyboru narzędzi.

---

# 18. Testy jakości

Zrobić zestaw testów regresyjnych.

Przykłady:

```txt
1. "Cześć"
Expected: finalAnswer, no tool

2. "Pokaż leady ze statusem sent"
Expected: crm.search_leads

3. "Zmień status TechCorp na interested"
Expected step 1: crm.search_leads
Expected step 2: crm.update_status

4. "Napisz maila do jan@example.com"
Expected: gmail.create_draft

5. "Napisz maila do TechCorp"
Expected: crm.search_leads first

6. "Zbuduj bota Telegram do RSS"
Expected: architect.plan_automation

7. "Odpal workflow weekly-content"
Expected: workflow.trigger, jeśli tool istnieje

8. "Jak działa RHD?"
Expected: knowledge.query albo finalAnswer, zależnie od dostępnego kontekstu

9. "Dzięki"
Expected: finalAnswer, no memory.search

10. Tool returns pendingApproval
Expected: finalAnswer, no retry
```

Każdy test powinien sprawdzać:

```txt
- poprawność JSON,
- czy tool istnieje,
- czy użyto właściwego toola,
- czy nie użyto toola bez potrzeby,
- czy pętla zakończyła się w limicie.
```

---

# 19. Minimalna struktura plików

```txt
src/
  agent/
    runAgent.ts
    buildPrompt.ts
    detectIntent.ts
    selectTools.ts
    selectRecipes.ts
    validateAgentResponse.ts
    repairJson.ts
    executeTool.ts
    summarizeObservation.ts
    stopConditions.ts

  tools/
    registry.ts
    crm.ts
    gmail.ts
    rss.ts
    knowledge.ts
    memory.ts
    architect.ts
    system.ts

  prompts/
    core/
      system-core.md
      output-schema.md
    recipes/
      crm-status-update.md
      gmail-draft-from-crm.md
      rss-digest.md
      automation-design.md
      tool-discovery.md

  evals/
    cases.json
    runEvals.ts
```

---

# 20. Najważniejszy flow w pseudokodzie

```ts
async function runAgent(userInput: string) {
  const intent = detectIntent(userInput);

  const selectedTools = selectTools(intent);
  const selectedRecipes = selectRecipes(intent);

  const state = {
    userInput,
    intent,
    steps: [],
    maxSteps: intent === "gmail" ? 8 : 4,
    pendingApproval: false
  };

  while (state.steps.length < state.maxSteps) {
    const prompt = buildPrompt({
      userInput,
      tools: selectedTools,
      recipes: selectedRecipes,
      state
    });

    const raw = await callGemma(prompt);

    const parsed = await validateOrRepair(raw, selectedTools);

    if (parsed.finalAnswer) {
      return parsed.finalAnswer;
    }

    if (!parsed.action) {
      return "Nie udało się ustalić następnego kroku.";
    }

    const stop = checkStopConditions(parsed.action, state);
    if (stop.shouldStop) {
      return stop.message;
    }

    const observation = await executeTool(parsed.action);

    const summarizedObservation = summarizeObservation(
      parsed.action.tool,
      observation
    );

    state.steps.push({
      thought: parsed.thought,
      action: parsed.action,
      observation: summarizedObservation
    });

    if (observation.pendingApproval) {
      return "Akcja została przygotowana i czeka na zatwierdzenie.";
    }
  }

  return "Zatrzymałem zadanie po osiągnięciu limitu kroków. Ostatni stan: " + summarizeState(state);
}
```

---

# 21. Finalny system core prompt

Proponowany krótki system prompt:

```md
Jesteś Meta Agentem działającym w pętli ReAct.

Masz rozwiązać zadanie użytkownika krok po kroku. Używaj narzędzi tylko wtedy, gdy potrzebujesz danych albo wykonania akcji.

Zwracaj wyłącznie jeden poprawny obiekt JSON. Żadnego tekstu poza JSON.

Gdy używasz narzędzia:

{
  "thought": "Krótko: dlaczego wybieram to narzędzie.",
  "action": {
    "tool": "dokładna_nazwa_narzędzia",
    "args": {}
  },
  "finalAnswer": null
}

Gdy kończysz:

{
  "thought": "Mam wystarczające dane do odpowiedzi.",
  "action": null,
  "finalAnswer": "Odpowiedź dla użytkownika."
}

Zasady:
1. Jeśli możesz odpowiedzieć z kontekstu, użyj finalAnswer.
2. Jeśli brakuje kluczowych danych, zapytaj przez finalAnswer.
3. Jeśli potrzebujesz danych lub akcji, użyj dokładnie jednego narzędzia.
4. Nie ustawiaj jednocześnie action i finalAnswer.
5. Nie wymyślaj nazw narzędzi.
6. Używaj tylko narzędzi widocznych w aktualnym promptcie.
7. Po obserwacji nie powtarzaj tego samego zapytania, jeśli wynik już wystarcza.
8. Jeśli akcja wymaga approval, zakończ i poinformuj użytkownika.
```

---

# 22. Finalna rekomendacja

Najlepsze rozwiązanie:

```txt
1. Skrócić system prompt do rdzenia.
2. Filtrować narzędzia przed wysłaniem do modelu.
3. Wstrzykiwać tylko potrzebne recipe cards.
4. Walidować JSON poza modelem.
5. Wymuszać limity i approval w kodzie.
6. Streszczać obserwacje przed kolejnym krokiem.
7. Testować routing na zestawie evals.
8. Używać cloud model tylko jako fallback dla trudnych przypadków.
```

Nie robić z Gemmy wszechwiedzącego mózgu z setkami linii instrukcji.

Zrobić z niej lokalny decision engine, a całą dyscyplinę operacyjną przenieść do runtime.

To będzie:

- stabilniejsze,
- tańsze,
- łatwiejsze do debugowania,
- łatwiejsze do rozszerzania,
- mniej podatne na `lost in the middle`.

---

# 23. Priorytet wdrożenia

## Etap 1: Minimalny działający runtime

Wdrożyć:

- `detectIntent.ts`,
- `selectTools.ts`,
- `buildPrompt.ts`,
- `validateAgentResponse.ts`,
- `executeTool.ts`,
- `runAgent.ts`.

Cel: agent wybiera narzędzie albo odpowiada finalAnswer.

## Etap 2: Recipes

Dodać:

- `crm-status-update.md`,
- `gmail-draft-from-crm.md`,
- `rss-digest.md`,
- `automation-design.md`.

Cel: agent dostaje procedury tylko wtedy, gdy są potrzebne.

## Etap 3: Observation summarizer

Dodać kompresję dużych wyników narzędzi.

Cel: mniej tokenów i mniejsze ryzyko gubienia istotnych danych.

## Etap 4: Evals

Dodać testy regresyjne.

Cel: każda zmiana prompta albo runtime musi być sprawdzana automatycznie.

## Etap 5: Fallback

Dodać routing do mocniejszego modelu.

Cel: Gemma obsługuje większość zadań lokalnie, a trudne przypadki idą do cloud modelu.

---

# 24. Krytyczne wymagania dla deva

1. Nie wysyłać do Gemmy pełnej listy wszystkich narzędzi, jeśli nie trzeba.
2. Nie trzymać całej logiki tylko w promptcie.
3. Nie ufać modelowi w kwestii limitów kroków.
4. Nie ufać modelowi w kwestii poprawności JSON.
5. Nie pozwalać modelowi wymyślać narzędzi.
6. Nie wrzucać dużych surowych obserwacji do kolejnego prompta.
7. Nie odpalać memory.search automatycznie dla każdego zadania.
8. Nie powtarzać write action po `pendingApproval`.
9. Nie robić delete/create dla edycji draftu, tylko `gmail.update_draft`.
10. Nie nadpisywać całego pola `metadata` leada przy operacjach mailowych.

---

# 25. Definicja sukcesu

Agent działa dobrze, jeśli:

```txt
- dla prostych pytań odpowiada bez narzędzi,
- dla CRM wybiera CRM tools,
- dla maili wybiera Gmail tools,
- dla automatyzacji wybiera architect tools,
- zwraca poprawny JSON,
- nie przekracza limitów kroków,
- nie powtarza bez sensu tych samych tool calls,
- kończy po pendingApproval,
- potrafi działać lokalnie na Gemma4:26B,
- eskaluje tylko trudne przypadki do cloud modelu.
```
