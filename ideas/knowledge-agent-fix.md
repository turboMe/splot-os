# Knowledge Agent - plan naprawy i rozwoju

**Status:** CLOSED 2026-05-14; Sprint A-F zaimplementowane; core runtime/API verification passed; UI/meta-delegation checks passed  
**Data:** 2026-05-14  
**Cel:** zrobić z `knowledgeAgent` wyspecjalizowanego operatora Google NotebookLM: z pamięcią, stabilnym kontraktem narzędzi, embeddingowym wyszukiwaniem MCP tooli i jasną ścieżką delegacji z innych agentów.

---

## 1. Diagnoza

`knowledgeAgent` technicznie ma podpięte narzędzia NotebookLM, ale nie potrafi z nich konsekwentnie korzystać.

### Co działa

- MCP NotebookLM sidecar działa lokalnie.
- `nlm doctor` przechodzi poprawnie: auth, cookies, CSRF i profil NotebookLM są dostępne.
- `nlm notebook list --json` zwraca realne notebooki.
- Mastra API pokazuje narzędzia NotebookLM w `knowledge-agent`, m.in. `notebook_list`, `notebook_query`, `source_add`, `research_start`, `studio_create`.

### Co jest zepsute

| Problem | Dowód | Wniosek |
|---------|-------|---------|
| Agent nie wie, że ma NotebookLM tools | Na pytanie o dostęp do NotebookLM odpowiadał, że nie ma bezpośredniego dostępu | To nie jest awaria MCP, tylko problem konfiguracji agenta/modelu/promptu |
| Prompt używa innych nazw niż runtime | Prompt każe wołać `skill_search`, ale runtime pokazuje `skillSearchTool` | Potrzebny stabilny alias tooli po kluczu w `tools` |
| Model wymyśla namespace'y | Próbował wołać `skill:search`, `skill:notebook:notebook_list`, `list_tools` | Trzeba wzmocnić kontrakt: dokładne nazwy, bez prefiksów i dwukropków |
| Brak pamięci | `knowledge-agent.ts` ma komentarz i konfigurację stateless | Agent nie utrzymuje mapy notebooków, aktywnych badań, aliasów i znanych błędów |
| Brak ToolSearchProcessor | Wszystkie MCP tools są wrzucone bez strategii discovery | Przy 35+ toolach model traci orientację albo wybiera złe nazwy |
| Inni agenci nie mogą dobrze delegować do knowledge | `system_delegate_task` nie ma `knowledgeAgent` w `AGENT_IDS` i enumie | Research przez NotebookLM nie ma osobnego eksperta w orkiestracji |
| Skills mają niespójne metadata tooli | `_skills/knowledge/*` używają nazw typu `mcp_notebooklm_notebook_list`, a runtime używa `notebook_list` | Skills mogą wzmacniać złe nazwy narzędzi |

---

## 2. Docelowa rola Knowledge Agenta

`knowledgeAgent` ma być agentem tylko od NotebookLM.

### Odpowiedzialności

- listowanie, tworzenie, zmiana nazw i opisywanie notebooków,
- dodawanie i synchronizacja źródeł,
- odpytywanie notebooków,
- cross-notebook research,
- deep research: `research_start` -> `research_status` -> `research_import`,
- Studio artifacts: briefy, raporty, FAQ, quizy, audio, slajdy, mind mapy, tabele,
- utrzymywanie aliasów notebooków i ostatnio używanych `notebookId`,
- zwracanie wyników innym agentom w formacie nadającym się do dalszego użycia.

### Czego nie powinien dostać

- narzędzi codingowych,
- workspace/file tools jako podstawowego zestawu,
- n8n / Golden Path / deploy tools,
- Gmail, Calendar, CRM i szerokich narzędzi biznesowych,
- pełnej listy wszystkich tooli jako stałego pre-contextu.

---

## 3. Architektura docelowa

```text
User / metaAgent / automationArchitect / codingAgent
        |
        v
system_delegate_task(targetAgent="knowledgeAgent")
        |
        v
generateKnowledge() [wymagany harness]
        |
        +-- concise NotebookLM pre-context
        +-- memory: notebook aliases, active research, known failures
        +-- run state + delegation telemetry
        +-- pending update delivery back to caller
        +-- always-visible tools:
        |     - server_info
        |     - notebook_list
        |     - skill_search
        |     - skill_load
        |     - system_memory_recall
        |     - system_memory_write_observation
        |
        +-- ToolSearchProcessor:
              - source_add
              - notebook_query
              - research_start/status/import
              - studio_create/status/revise/delete
              - sharing/note/batch/tag/pipeline tools
        |
        v
NotebookLM MCP sidecar
```

Zasada: agent ma zawsze widzieć tylko bazowe narzędzia i meta-narzędzia. Reszta jest odkrywana semantycznie przez `search_tools` / `load_tool`. Gdy `knowledgeAgent` pracuje w tle, wynik musi wrócić do agenta zlecającego przez pending updates, tak aby `metaAgent` w następnej rozmowie mógł powiedzieć użytkownikowi, co przyszło z tasku Knowledge Agenta.

---

## 4. Sprint A - naprawa kontraktu narzędzi

**Status:** DONE 2026-05-14

### Cel

Agent ma znać swoje podstawowe narzędzia i wołać je dokładnymi nazwami.

### Zmiany

1. W `src/mastra/agents/knowledge-agent.ts` wystawić stabilne aliasy:

```ts
tools: {
  server_info: nlmTools.server_info,
  notebook_list: nlmTools.notebook_list,
  skill_search: skillSearchTool,
  skill_load: skillLoadTool,
}
```

2. Nie wystawiać `skillSearchTool` i `skillLoadTool` pod camelCase, jeśli prompt ma używać snake_case.

3. Zaktualizować prompt `src/mastra/prompts/knowledge/notebooklm-agent.md`:

- dokładne nazwy bazowych tooli,
- zakaz prefiksów typu `skill:` / `mcp_` / `notebooklm:`,
- instrukcja: do procedur używaj `skill_search` -> `skill_load`,
- instrukcja: do ukrytych MCP tooli używaj `search_tools` -> `load_tool`.

4. Poprawić `_skills/knowledge/*.md`, żeby `allowedTools` i przykłady używały realnych nazw runtime:

- `notebook_list`, nie `mcp_notebooklm_notebook_list`,
- `source_add`, nie `mcp_notebooklm_source_add`,
- `research_start`, nie `mcp_notebooklm_research_start`.

### Kryteria akceptacji

- Agent potrafi odpowiedzieć, że ma dostęp do NotebookLM MCP.
- Agent nie wymyśla nazw z dwukropkiem.
- Agent potrafi wywołać `notebook_list`.
- Agent potrafi wywołać `skill_search` i `skill_load`.

---

## 5. Sprint B - pamięć Knowledge Agenta

**Status:** DONE 2026-05-14

### Cel

Agent ma zachowywać ciągłość pracy z NotebookLM: aliasy, aktywne notebooki, źródła, taski researchowe i znane problemy.

### Zmiany

1. Dodać `Memory` do `knowledgeAgent`.

2. Skonfigurować:

- `lastMessages`: 20-30,
- `semanticRecall`: wąskie, tylko na poprzednie sesje Knowledge Agenta,
- `workingMemory`: włączona,
- `observationalMemory`: włączona dla lekcji operacyjnych.

3. Dodać template working memory:

```md
# Knowledge Agent Working Memory

## NotebookLM Runtime
- Active account:
- Last MCP/auth status:
- Known MCP limitations:

## Notebook Aliases
- alias -> notebookId -> title -> purpose

## Active Research
- taskId:
- notebookId:
- status:
- next check:

## Source State
- recently added sources:
- indexing status:
- source failures:

## Operational Lessons
- reliable tool sequences:
- known failure modes:
- user preferences:
```

4. Dodać narzędzia pamięci systemowej jako jawne tool aliases:

```ts
system_memory_recall: memoryRecallTool,
system_memory_write_observation: memoryWriteTool,
```

### Kryteria akceptacji

- API agenta pokazuje aktywną pamięć.
- Agent pamięta aliasy notebooków w ramach threadu.
- Agent potrafi zapisać trwałą lekcję typu "NotebookLM source_add wymaga wait=true".
- W kolejnej turze potrafi odtworzyć ostatni `notebookId` bez pytania od nowa, jeśli thread jest ten sam.

---

## 6. Sprint C - embeddingowe wyszukiwanie narzędzi NotebookLM

**Status:** DONE 2026-05-14

### Cel

Zmniejszyć chaos narzędzi i poprawić wybór tooli przez semantyczne discovery.

### Zmiany

1. Dodać `ToolSearchProcessor` do `knowledgeAgent`.

2. Podzielić MCP tools:

```ts
const alwaysVisibleNlmTools = {
  server_info: nlmTools.server_info,
  notebook_list: nlmTools.notebook_list,
};

const discoverableNlmTools = Object.fromEntries(
  Object.entries(nlmTools).filter(([name]) => !['server_info', 'notebook_list'].includes(name)),
);
```

3. W `inputProcessors` dodać:

```ts
new ToolSearchProcessor({
  tools: discoverableNlmTools,
  search: {
    topK: 8,
    minScore: 0.2,
  },
  ttl: 60 * 60 * 1000,
})
```

4. Zostawić zawsze dostępne:

- `search_tools`,
- `load_tool`,
- `server_info`,
- `notebook_list`,
- `skill_search`,
- `skill_load`,
- `system_memory_recall`,
- `system_memory_write_observation`.

### Kryteria akceptacji

- Agent znajduje `source_add` po zapytaniu "dodaj URL jako źródło".
- Agent znajduje `studio_create` po zapytaniu "stwórz briefing albo podcast".
- Agent znajduje `research_start` po zapytaniu "zrób deep research".
- Agent nie musi widzieć wszystkich 35 MCP tooli w podstawowym prompt context.

---

## 7. Sprint D - model i prompt operacyjny

**Status:** DONE 2026-05-14

### Cel

Wybrać model, który realnie wykonuje tool calls, i zmniejszyć prompt do jasnych reguł wykonawczych.

### Zmiany

1. Zmienić `agentModels.knowledgeAgent` z `gemma4-26b` na model lepszy do tool-calling.

Rekomendacja:

```ts
knowledgeAgent: 'gemini-3.1-flash-lite-preview' as ModelKey
```

Alternatywa lokalna do testu:

```ts
knowledgeAgent: 'qwen3-coder-30b' as ModelKey
```

2. Prompt nie powinien próbować opisywać wszystkich 35 tooli.

3. Prompt powinien mieć stały kontrakt:

- "Jesteś operatorem NotebookLM MCP",
- "Twoje bazowe narzędzia to ...",
- "Nigdy nie zgaduj nazw tooli",
- "Jeśli nie widzisz toola, użyj `search_tools`",
- "Jeśli procedura jest niejasna, użyj `skill_search`",
- "Dla destructive actions wymagaj potwierdzenia".

### Kryteria akceptacji

- Agent nie neguje dostępu do NotebookLM.
- Agent woła tool, gdy użytkownik prosi o listę notebooków.
- Agent nie odpowiada samą wiedzą ogólną o NotebookLM, gdy powinien użyć MCP.

---

## 8. Sprint E - delegacja z innych agentów

**Status:** DONE 2026-05-14

### Cel

Inni agenci mają używać `knowledgeAgent` jako eksperta od researchu NotebookLM.

### Zmiany

1. W `src/mastra/tools/system/delegate-task.ts` dodać:

```ts
knowledgeAgent: 'knowledgeAgent'
```

2. Rozszerzyć enum `targetAgent` o `knowledgeAgent`.

3. Dodać opis domeny:

```text
- knowledgeAgent -> Google NotebookLM research, notebook/source operations, cross-notebook Q&A, Studio artifacts
```

4. Zaktualizować `src/mastra/prompts/meta/base.md`, tabelę delegacji i zasady:

- research w NotebookLM -> deleguj do `knowledgeAgent`,
- nie próbuj wykonywać NotebookLM MCP tooli bezpośrednio w meta,
- jeśli potrzebny jest raport dla automatyzacji, meta zleca research do `knowledgeAgent`, a potem syntezuje wynik.

5. Zaktualizować prompt Automation Architect:

- gdy automatyzacja wymaga researchu lub NotebookLM źródeł, deleguj do `knowledgeAgent`,
- nie mieszaj n8n deploymentu z NotebookLM MCP w jednym agencie.

### Async delegacja i zwrot wyników

Synchronous delegation wystarczy do prostych zapytań, ale docelowo `knowledgeAgent` musi obsługiwać async delegation przez ten sam mechanizm pending updates, którego używa coding/automation. Jest to ważne, bo `metaAgent` powinien przy następnej interakcji dostać gotowy wynik researchu i przekazać go użytkownikowi bez ręcznego dopytywania.

Async jest wymagane dla:

- deep research,
- długiego source indexing,
- Studio artifacts,
- cross-notebook batch operations.

---

## 9. Sprint F - harness dla Knowledge Agenta

**Status:** DONE 2026-05-14

### Cel

Wprowadzić cienki wrapper `generateKnowledge()`, żeby `knowledgeAgent` miał taki sam operacyjny kontrakt jak agenci, którym zlecamy realną pracę: trace, pre-context, timeout, pending updates, async result delivery i kompaktowanie dużych wyników NotebookLM.

### Dlaczego robimy

- automatycznie dodaje NotebookLM pre-context,
- śledzi run state i telemetry,
- pozwala long-running research zwracać przez pending updates,
- pozwala meta agentowi zobaczyć wynik tasku przy następnej rozmowie,
- kompaktuje duże odpowiedzi z NotebookLM,
- daje jedno miejsce na retry/auth recovery policy.

### Minimalne API

```ts
await generateKnowledge({
  agent,
  prompt,
  threadId,
  phase: 'chat' | 'list' | 'source' | 'query' | 'research' | 'studio',
  timeoutMs: 300_000,
});
```

### Zakres pierwszej wersji

- `generateKnowledge()` w `src/mastra/services/knowledge-harness.ts`,
- routing synchronicznej delegacji przez harness w `delegate-task.ts`,
- routing async delegacji przez `startAsyncDelegation`,
- pending update result dla `returnToAgentId` / `returnToThreadId`,
- phase metadata: `chat`, `list`, `source`, `query`, `research`, `studio`,
- output preview z `notebookId`, `taskId`, `artifactId` i źródłami, jeśli są dostępne.

---

## 10. Pliki do zmiany

### Główne

- `src/mastra/agents/knowledge-agent.ts`
- `src/mastra/prompts/knowledge/notebooklm-agent.md`
- `src/mastra/config/model-manifest.ts`
- `src/mastra/tools/system/delegate-task.ts`
- `src/mastra/prompts/meta/base.md`
- `src/mastra/prompts/automation/base.md`

### Skills

- `src/mastra/_skills/knowledge/nlm-auth-and-error-recovery.md`
- `src/mastra/_skills/knowledge/nlm-batch-cross-notebook.md`
- `src/mastra/_skills/knowledge/nlm-notebook-management.md`
- `src/mastra/_skills/knowledge/nlm-research.md`
- `src/mastra/_skills/knowledge/nlm-sharing-notes-chat.md`
- `src/mastra/_skills/knowledge/nlm-source-management.md`
- `src/mastra/_skills/knowledge/nlm-studio-content-generation.md`
- `src/mastra/_skills/knowledge/nlm-workflow-patterns.md`

### Opcjonalne

- `src/mastra/services/knowledge-harness.ts`
- `src/mastra/services/async-delegation.ts`
- `src/mastra/services/harness-output-compactor.ts`

---

## 11. Feature flags

Zaimplementowany wariant używa istniejącego systemu flag harnessu:

```env
FEATURE_KNOWLEDGE_PRECONTEXT=true
```

`FEATURE_KNOWLEDGE_PRECONTEXT` jest dodane do `.env.example` i runtime `.env`. Pamięć, ToolSearchProcessor i delegacja są częścią konfiguracji agenta oraz `system_delegate_task`, więc nie mają osobnych flag.

---

## 12. Testy akceptacyjne

**Status testów 2026-05-14:**

- Test 1: DONE przez API/runtime (`/api/agents/knowledge-agent` po synchronizacji DB pokazuje angielski prompt, model Google i poprawne aliasy tooli).
- Test 2: DONE w UI; agent poprawnie rozpoznaje dostęp do NotebookLM i nie halucynuje namespace'ów.
- Test 3: DONE przez API/UI (`skill_search` + `notebook_list` zwróciły realne notebooki).
- Test 4: DONE przez API/UI (`search_tools` znalazł lokalną nazwę `source_add`).
- Test 5: DONE w UI; pamięć threadu zachowuje aliasy notebooków.
- Test 6: DONE w UI; `metaAgent` deleguje do `knowledgeAgent` i raportuje wynik.

Uwaga: surowe wywołania `/generate` muszą przekazywać `memory.thread`, bo observational memory jest skonfigurowana per-thread.

### Test 1 - runtime MCP

```bash
nlm doctor
nlm notebook list --json
curl -sS http://localhost:4111/api/agents/knowledge-agent
```

Oczekiwane:

- NotebookLM auth działa,
- lista notebooków wraca,
- agent pokazuje `server_info`, `notebook_list`, `skill_search`, `skill_load`,
- agent ma `inputProcessors` z `ToolSearchProcessor`,
- agent ma pamięć.

### Test 2 - self-awareness tooli

Prompt:

```text
Czy masz dostęp do narzędzi NotebookLM? Wymień dokładne nazwy 5 narzędzi, których możesz użyć. Nie zgaduj nazw.
```

Oczekiwane:

- odpowiedź: tak,
- nazwy bez prefiksów i dwukropków,
- przykłady: `notebook_list`, `server_info`, `skill_search`, `skill_load`, `search_tools`.

### Test 3 - lista notebooków

Prompt:

```text
Użyj NotebookLM MCP i wypisz 3 ostatnio widoczne notebooki. Najpierw sprawdź procedurę skillami, potem użyj właściwego narzędzia MCP.
```

Oczekiwane:

- `skill_search`,
- `skill_load`,
- `notebook_list`,
- wynik z realnymi tytułami notebooków.

### Test 4 - ToolSearchProcessor

Prompt:

```text
Chcę dodać URL jako źródło do notebooka. Znajdź właściwe narzędzie przez search_tools i powiedz, jakiego toola użyjesz.
```

Oczekiwane:

- `search_tools`,
- znaleziony `source_add`,
- brak wymyślonych nazw.

### Test 5 - pamięć threadu

Krok 1:

```text
Zapamiętaj, że dla tego wątku alias "rynek" oznacza notebook "GastroBridge - Polski Rynek HoReCa".
```

Krok 2 w tym samym threadzie:

```text
Jaki notebook oznacza alias "rynek"?
```

Oczekiwane:

- agent pamięta alias,
- jeśli potrzebuje ID, używa `notebook_list`.

### Test 6 - delegacja z meta agenta

Prompt do meta:

```text
Zleć knowledgeAgentowi sprawdzenie, jakie notebooki GastroBridge są dostępne w NotebookLM, a potem podsumuj wynik.
```

Oczekiwane:

- meta używa `system_delegate_task(targetAgent="knowledgeAgent")`,
- knowledge agent używa NotebookLM MCP,
- meta zwraca syntezę.

---

## 13. Kolejność wdrożenia

1. Sprint A: aliasy tooli + prompt + poprawka skills. DONE
2. Sprint D: model na tool-calling friendly. DONE
3. Sprint B: Memory + system memory tools. DONE
4. Sprint C: ToolSearchProcessor dla MCP NotebookLM. DONE
5. Sprint E: delegacja z meta/automation/coding. DONE
6. Sprint F: harness i async delivery dla długich zadań NotebookLM. DONE
7. Testy 1-6. DONE przez API/runtime/UI

---

## 14. Decyzja architektoniczna

Nie robimy z `knowledgeAgent` drugiego meta agenta ani drugiego coding agenta.

To ma być wąski, skuteczny agent operacyjny:

- zna NotebookLM,
- pamięta notebooki i research,
- używa MCP zamiast udawać wiedzę,
- daje innym agentom gotowy wynik researchowy,
- nie dostaje narzędzi, które rozmywają jego odpowiedzialność.
