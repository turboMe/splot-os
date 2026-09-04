pomysły na rozwój ale do przeanalizowania strategicznie i trzeba tez sprawdzic czy nie mamy podwalin pod któryś z pomysłów lub moze juz cos mamy z nich w kodzie?:
Tak. Mam ciekawszy pomysł niż samo “Obsidian RAG”.

Moja najlepsza propozycja dla Twojego systemu na maj 2026:

# Agentic Memory Spine

Czyli **kręgosłup pamięci dla metaAgenta**, który łączy:

```txt
Obsidian vault
+ lokalny RAG
+ pamięć Mastry
+ failure memory dla autoheal
+ skill/pattern registry
+ evals na podstawie historii działania agentów
```

Nie robiłbym z Obsidiana głównego mózgu agenta. Obsidian potraktowałbym jako **czytelny interfejs dla człowieka**, a prawdziwa pamięć systemowa powinna siedzieć w warstwie Mastry / DuckDB / Qdrant / Mongo.

Mastra ma już natywną koncepcję pamięci: working memory, semantic recall i observational memory, czyli dokładnie rzeczy potrzebne do długoterminowego działania agentów. Observational memory jest opisana jako mechanizm, gdzie background agents utrzymują gęsty log obserwacji zamiast trzymać całe surowe historie rozmów w kontekście. To jest bardzo dobre pod Twój system. ([Mastra][1])

## Najlepszy pipeline

```txt
1. Wszystko, co robi system, trafia do Agent Event Log
   - user request
   - agent routing
   - tool calls
   - błędy
   - test results
   - approval requests
   - autoheal attempts
   - final outcome

2. Memory Extractor co jakiś czas kompresuje eventy
   - co zadziałało
   - co nie zadziałało
   - jaki był błąd
   - jaki patch pomógł
   - jaki prompt zawiódł
   - który agent źle użył narzędzia

3. Knowledge Classifier dzieli wiedzę na typy
   - architecture_decision
   - coding_pattern
   - n8n_pattern
   - prompt_rule
   - tool_contract
   - failure_case
   - autoheal_recipe
   - user_preference
   - project_fact

4. Zapis do lokalnej bazy
   - Mongo jako storage operacyjny
   - DuckDB albo Qdrant jako vector memory
   - opcjonalnie Obsidian jako markdown mirror dla Ciebie

5. metaAgent dostaje nowe narzędzie
   memory.recallSystemKnowledge

6. codingAgent / automationArchitect / metaAgent mogą pytać:
   - “czy mieliśmy już taki błąd?”
   - “jaki pattern działał dla n8n Telegram + Ollama?”
   - “jakie są zasady approval dla destructive command?”
   - “czy ten prompt łamie nasz standard?”
   - “jak ostatnio naprawiliśmy podobny błąd TypeScript?”
```

To jest dużo mocniejsze niż zwykły RAG, bo system nie tylko szuka notatek. On zaczyna **uczyć się z własnego działania**.

## Dlaczego to jest lepsze niż czysty Obsidian RAG

Obsidian RAG jest świetny dla Ciebie jako człowieka. Smart Connections dla Obsidiana potrafi indeksować vault lokalnie i pokazywać powiązane notatki podczas pisania, a Smart Context / Smart Chat robią z vaulta przestrzeń roboczą z AI. ([smartconnections.app][2]) Repo Smart Connections opisuje nawet prosty setup: instalujesz plugin, piszesz dalej, lokalny model indeksuje vault. ([GitHub][3])

Ale dla metaAgenta problem jest inny. On potrzebuje:

```txt
- szybkiego recallu
- typowanych rekordów
- filtrowania po domenie
- filtrowania po ryzyku
- relacji: błąd -> patch -> test result
- scoringu skuteczności
- integracji z toolami
- aktualizacji po każdym runie
```

Obsidian jako folder markdownów nie wystarczy. Może być **warstwą wizualną**, nie rdzeniem.

## Stack, który bym wybrał

### Wariant darmowy i prosty

```txt
MongoDB
- task logs
- approvals
- raw event logs
- agent run metadata

DuckDB Vector Store
- lokalne embeddings
- semantic recall
- brak osobnego serwera

Obsidian
- markdown mirror
- ręczne przeglądanie decyzji, failure cases, patternów

Mastra Memory
- working memory
- semantic recall
- observational memory
```

Mastra ma RAG flow oparty o chunking, embeddings, zapis w vector DB i retrieval przy query time. ([Mastra][4]) Ma też dokumentację vector databases i consistent interface do różnych baz wektorowych. ([Mastra][5]) DuckDB vector store w Mastrze działa jako embedded vector search bez osobnego serwera, używa VSS/HNSW i wspiera metadata filtering, więc pasuje do lokalnego setupu. ([Mastra][6])

To bym zrobił jako pierwsze, bo masz już DuckDB observability w systemie. Mniej ruchomych części.

### Wariant mocniejszy

```txt
MongoDB
+ Qdrant local Docker
+ Obsidian mirror
+ Mastra Memory
+ LightRAG dla graph memory
```

Qdrant jest open-source vector search engine napisany w Rust i ma mocne filtrowanie po payloadach/metadanych. ([qdrant.tech][7]) Dla Ciebie to jest ważne, bo będziesz chciał filtrować wiedzę po typie: `failure_case`, `prompt_rule`, `n8n_pattern`, `coding_pattern`, `approval_policy`. Qdrant oficjalnie wspiera dense, sparse i multi-vector search oraz payload filtering. ([GitHub][8])

LightRAG jest ciekawy, bo nie robi tylko zwykłego vector search. Ma graph-enhanced RAG, Web UI/API, indeksowanie dokumentów, eksplorację knowledge graphu i query interface. ([GitHub][9]) Oficjalna strona opisuje dual-level retrieval z niskopoziomowej i wysokopoziomowej wiedzy. ([lightrag.github.io][10])

Czyli Qdrant = szybki semantic recall.
LightRAG = relacje i wiedza systemowa typu “to wynika z tamtego”.

## Konkretne narzędzie dla metaAgenta

Dodałbym tool:

```txt
system.memory_recall
```

Nie jeden głupi search, tylko typowany recall.

### Input

```json
{
  "query": "string",
  "domain": "coding | automation | prompt | architecture | crm | marketing | sales | analytics | autoheal | all",
  "memory_types": [
    "architecture_decision",
    "coding_pattern",
    "n8n_pattern",
    "prompt_rule",
    "tool_contract",
    "failure_case",
    "autoheal_recipe",
    "user_preference",
    "project_fact"
  ],
  "risk_level": "any | low | medium | high",
  "max_results": 8,
  "include_sources": true
}
```

### Output

```json
{
  "results": [
    {
      "id": "mem_...",
      "type": "failure_case",
      "domain": "coding",
      "title": "TypeScript enum mismatch in delegate-task",
      "summary": "Previous issue caused by inconsistent status enum aliases between FE and BE.",
      "evidence": "Test failed with TS2345...",
      "resolution": "Normalize aliases before filtering.",
      "confidence": 0.84,
      "last_seen": "2026-05-09",
      "source": "autoheal_log | obsidian | manual_note | trace_eval"
    }
  ]
}
```

To narzędzie powinno być dostępne dla:

```txt
metaAgent
codingAgent
codingMasterAgent
automationArchitect
promptArchitectAgent
analyticsAgent
```

Nie dawałbym go wszystkim bez ograniczeń. CRM/sales/marketing mogą mieć osobny scoped recall.

## Drugi tool: system.memory_write_observation

To powinno działać po każdym ważnym runie.

```json
{
  "type": "failure_case",
  "domain": "coding",
  "title": "npx tsc failed after changing tool schema",
  "observation": "Changing Zod schema without updating delegate-task output contract caused downstream type mismatch.",
  "evidence": {
    "command": "npx tsc --noEmit",
    "result": "failed",
    "files": [
      "src/mastra/tools/system/delegate-task.ts"
    ]
  },
  "resolution": "Update output schema and all call sites together.",
  "reuse_rule": "When changing tool output schema, search all call sites before tracked write.",
  "confidence": 0.9
}
```

To jest fundament pod autoheal, bo autoheal bez pamięci będzie ciągle “odkrywał Amerykę”.

## Najciekawszy wariant: Failure Brain dla autoheal

To bym zrobił jako pierwszy pipeline produkcyjny.

```txt
Autoheal Failure Brain
```

Działa tak:

```txt
1. Test albo runtime pada
2. autoheal zapisuje failure report
3. failure report trafia do vector memory
4. agent szuka podobnych błędów
5. agent pobiera poprzednie skuteczne naprawy
6. generuje patch strategy
7. codingAgent robi tracked write
8. test
9. wynik wraca do pamięci
10. skuteczne rozwiązanie dostaje wyższy score
```

Po 100 błędach masz własny prywatny StackOverflow dla Twojego repo.

To jest bardzo mocne, bo Twój system będzie miał unikalną wiedzę:

```txt
- jak dokładnie psuje się Twoja Mastra
- jakie patche działają
- które prompty powodują złe tool-use
- które workflowy są kruche
- które narzędzia wymagają lepszego schema
- które modele dobrze sobie radzą z danym typem błędu
```

## Pipeline numer 2: Skill Registry dla agentów

To jest drugi najlepszy pomysł.

Zamiast wkładać agentowi wielki prompt z instrukcjami, tworzysz bibliotekę skillów:

```txt
/skills
  /coding
    fix-typescript-error.md
    add-mastra-tool.md
    inspect-lsp-error.md
    safe-tracked-write.md
  /n8n
    telegram-trigger-to-ollama.md
    rss-classify-summarize-post.md
    webhook-validate-json.md
  /prompting
    design-domain-agent.md
    review-tool-contract.md
    compress-prompt-for-local-model.md
  /autoheal
    diagnose-failed-test.md
    rollback-bad-patch.md
    create-failure-report.md
```

MetaAgent dostaje tool:

```txt
skill.search
skill.load
skill.apply_template
skill.score_result
```

To jest lepsze niż wrzucanie wszystkiego do promptu. Prompt zostaje krótki, a agent pobiera właściwą procedurę wtedy, kiedy jej potrzebuje.

Mastra wspiera używanie narzędzi jako strukturalnych capabilities agentów, a dodatkowo może ładować narzędzia z MCP serverów, więc taki Skill Registry możesz później wystawić jako wewnętrzny MCP server. ([Mastra][11]) Mastra MCP docs pokazują, że agent może ładować narzędzia przez `MCPClient().listTools()`, więc to pasuje do Twojej wizji pluginowego systemu narzędzi. ([Mastra][12])

## Pipeline numer 3: Agent Black Box Recorder

To jest narzędzie, które powinno istnieć w każdym poważnym systemie agentowym.

```txt
agentBlackBox.recordRun
agentBlackBox.explainRun
agentBlackBox.findBadToolUse
agentBlackBox.compareRuns
```

Cel:

```txt
Nie pytasz: “czemu agent zrobił głupotę?”
Masz zapis:
- jaki był input
- jaki agent został wybrany
- jakie narzędzia dostał
- jakie tool calls wykonał
- co zwróciły narzędzia
- gdzie nastąpił błąd
- jaki był koszt
- jaki był wynik
```

Mastra ma tracing dla agent runs, LLM generations, tool calls i workflow steps z AI-specific context. ([Mastra][13]) Ma też eval scorers, które mogą oceniać historyczne traces, ale wymagają observability, żeby mieć dane trace. ([Mastra][14])

Czyli możesz zrobić coś bardzo konkretnego:

```txt
Codziennie o 03:00:
1. weź ostatnie 100 runów agentów
2. znajdź failed / low-confidence / high-cost / repeated-tool-error
3. streszcz failure patterns
4. zapisz do Obsidian:
   /AgentOps/Daily/2026-05-09-agent-health.md
5. zapisz reusable lessons do Memory Spine
```

To byłby bardzo dobry “mózg operacyjny” dla całego systemu.

## Pipeline numer 4: Prompt Contract Compiler

To jest narzędzie specjalnie dla Twojej hierarchii agentowej.

Input:

```txt
prompt agenta + lista narzędzi + domena
```

Output:

```txt
- czy prompt ma jasną rolę
- czy ma granice
- czy wie kiedy delegować
- czy wie kiedy używać approval
- czy tool-use jest jednoznaczny
- czy prompt jest za długi
- czy są sprzeczne instrukcje
- czy da się zrobić eval cases
- czy brakuje output schema
```

Tool:

```txt
promptCompiler.reviewAgentPrompt
promptCompiler.generateEvalCases
promptCompiler.detectContradictions
promptCompiler.compressForLocalModel
```

To może Ci uratować dużo czasu, bo jak rozbudujesz system do 20 agentów, problemem nie będzie kod. Problemem będzie **dryf promptów**.

## Co bym wdrożył najpierw

Nie zaczynałbym od Obsidiana.

Zacząłbym tak:

```txt
Etap 1:
Agent Event Log + Memory Extractor

Etap 2:
DuckDB vector memory w Mastrze

Etap 3:
system.memory_recall + system.memory_write_observation

Etap 4:
Failure Brain dla autoheal

Etap 5:
Obsidian markdown mirror

Etap 6:
Skill Registry

Etap 7:
LightRAG / GraphRAG dopiero gdy zwykły vector recall przestanie wystarczać
```

Dlaczego tak?

Bo Obsidian da Ci fajny widok, ale nie da automatycznie inteligencji operacyjnej. Inteligencję da dopiero pętla:

```txt
run -> observation -> memory -> recall -> better next run
```

## Moja konkretna rekomendacja

Zbuduj moduł:

```txt
Agentic Knowledge Layer
```

W środku:

```txt
1. Event Log
2. Memory Extractor
3. Vector Recall
4. Failure Brain
5. Skill Registry
6. Obsidian Mirror
```

To jest najbardziej wartościowy “wypełniacz systemu”, bo będzie wzmacniał wszystkie inne części:

```txt
metaAgent będzie lepiej routował.
codingAgent będzie pamiętał stare błędy.
automationArchitect będzie używał sprawdzonych patternów n8n.
promptArchitect będzie wykrywał słabe prompty.
autoheal będzie mniej głupi po każdej iteracji.
analyticsAgent będzie widział zdrowie całego runtime.
```

Najkrócej: **nie buduj tylko Obsidian RAG. Zbuduj pamięć operacyjną systemu, a Obsidiana użyj jako czytelny panel wiedzy dla człowieka.**

[1]: https://mastra.ai/docs/memory/overview?utm_source=chatgpt.com "Memory overview"
[2]: https://smartconnections.app/?utm_source=chatgpt.com "Smart Connections for Obsidian | Local-first Smart Plugins"
[3]: https://github.com/brianpetro/obsidian-smart-connections?utm_source=chatgpt.com "brianpetro/obsidian-smart-connections: Chat with your ..."
[4]: https://mastra.ai/docs/rag/overview?utm_source=chatgpt.com "RAG (Retrieval-Augmented Generation) in Mastra"
[5]: https://mastra.ai/docs/rag/vector-databases?utm_source=chatgpt.com "Storing embeddings in a vector database | RAG"
[6]: https://mastra.ai/reference/vectors/duckdb?utm_source=chatgpt.com "Reference: DuckDB vector store"
[7]: https://qdrant.tech/documentation/?utm_source=chatgpt.com "Qdrant Documentation"
[8]: https://github.com/qdrant/qdrant?utm_source=chatgpt.com "GitHub - qdrant/qdrant: Qdrant - High-performance ..."
[9]: https://github.com/hkuds/lightrag?utm_source=chatgpt.com "LightRAG: Simple and Fast Retrieval-Augmented Generation"
[10]: https://lightrag.github.io/?utm_source=chatgpt.com "LightRAG"
[11]: https://mastra.ai/docs/agents/using-tools?utm_source=chatgpt.com "Tools | Agents | Mastra Docs"
[12]: https://mastra.ai/docs/mcp/overview?utm_source=chatgpt.com "MCP overview"
[13]: https://mastra.ai/docs/observability/tracing/overview?utm_source=chatgpt.com "Tracing | Observability | Mastra Docs"
[14]: https://mastra.ai/docs/evals/overview?utm_source=chatgpt.com "Scorers overview | Evals | Mastra Docs"








model na temat mojego pomysłu aby nawet subagentci mieli swoje skille i system rag do nich aby je wywoływać :

fakt zbudowaliśmy SmartRouter (rejestr możliwości modeli, który dobiera LLM np. Qwen3.6 vs Claude w zależności od trudności zadania i budżetu VRAM), ale nie wydzieliliśmy jeszcze twardych "osobowości" subagentów do osobnych plików (np. TerminalAgent, FileEditorAgent, ReviewAgent – poza tym ostatnim, którego już mamy).

Obecnie działa to tak, że główny codingAgent (lub jego kopia-worker) dostaje odpowiedni wycinek zadania (subtask) i odpowiedni model LLM, ale wciąż ma "założoną czapkę" tego samego głównego agenta.

A Twój pomysł z RAG-iem dla subagentów... to jest absolutny strzał w dziesiątkę. To właściwie najwyższy poziom agentowej inżynierii oprogramowania (tzw. Context-Aware Specialist Agents).

Dlaczego Twój pomysł jest genialny?
Gdy mówimy "napraw błąd w koszyku w Next.js", agent nie powinien "zgadywać" jak projekt jest napisany. Powinien zrobić to, co zrobiłby senior developer dołączający do projektu:

Przeczytać dokumentację o Next.js w naszym projekcie.
Przeczytać strukturę koszyka (Cart System Architecture).
Dopiero wtedy dotknąć kodu.
Jeśli każdy wyspecjalizowany sub-agent (np. FrontendSubAgent albo DatabaseSubAgent) będzie na starcie uzbrojony w narzędzie RAG (np. przez podpięcie do naszego lokalnego systemu Knowledge Items lub NotebookLM), zyskamy coś niesamowitego:

Zero halucynacji o architekturze – agent nie użyje przestarzałego pages/ z Next.js, jeśli w RAG-u przeczyta, że używamy app/ i Turbopacka.
Oszczędność VRAM/Tokenów – zamiast pakować całego prompta o całym projekcie do jednego modelu, DatabaseSubAgent szuka w RAGu tylko informacji o "MongoDB, replikach i indeksach", a UI_Agent szuka "komponentów UI i Tailwind".
Autonomiczne uczenie się (Skills Retrieval) – agent może wyszukać w RAG-u: "Jakiego polecenia bash używa się tu do deploymentu?" i dostać odpowiedź ze Skilli, zanim w ogóle ruszy terminal.
Jak moglibyśmy to zrealizować (Etap 11: RAG-Empowered Subagents)?
Podział na role (Specialist Skills): Tworzymy dedykowanych agentów w /src/mastra/agents/sub-agents/:
ArchitectSubAgent (szuka wzorców i planuje).
CodeWriterSubAgent (pisze logikę).
QA_SubAgent (pisze i puszcza testy).
Dynamic Knowledge Injection (Twój pomysł): Dodajemy narzędzie search_knowledge_base. Zanim sub-agent zacznie pisać plik, wywołuje system RAG pytając np. "Jak ten projekt obsługuje autoryzację i błędy?".
Podpięcie MCP NotebookLM / Local RAG: Mamy przecież dostęp do serwera MCP od NotebookLM (widzę go w dostępnych dla mnie narzędziach!). Możemy sprawić, że agenci Mastry przed każdym zadaniem będą pytać odpowiedni notes NotebookLM (np. "GastroBridge Architecture") o wskazówki do kodu.
Czy chcemy teraz pójść w tę stronę i rozbić Coding Agenta na mniejszych specjalistów z narzędziem wyszukiwania wiedzy (RAG)? Jeśli tak, od czego wolisz zacząć: od wydzielenia plików subagentów, czy od integracji narzędzia RAG dla nich?


**** A tutaj masz czesciowo zweryfikowanie z moim kodem co mam , czego nie i co  w jakiej kolejnosci warto robić aby rozwijać system strategicznie:

Nie wprowadzałem żadnych zmian w kodzie.

**Główny Wniosek**
Najlepszy kierunek to nie zaczynać od Obsidiana, Qdranta ani kolejnych subagentów, tylko zbudować najpierw “Agentic Memory Spine”: wspólny log zdarzeń → ekstraktor wiedzy → typowana pamięć semantyczna → narzędzia recall/write → feedback do routera, autoheal i skill selection.

Masz już dobre fundamenty: Mastra, Mongo, DuckDB/observability, ToolSearchProcessor, Smart Router, workflow autoheal, lokalne skille, pattern RAG i NotebookLM tools. Brakuje warstwy, która spina to w system uczący się z własnych działań.

**Co Już Masz**
- Orkiestracja: `metaAgent` ma `delegate_task`, `run_worker`, shared memory i ToolSearchProcessor z pulą narzędzi. Zobacz [meta-agent.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/agents/meta-agent.ts:78).
- Infrastruktura Mastra: Mongo jako główny store, DuckDB dla observability, agenci/workflow/scorery rejestrowane centralnie. Zobacz [index.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/index.ts:241).
- Routing kodowy: Smart Router dobiera model według złożoności, VRAM i typu zadania. Zobacz [smart-router.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/services/smart-router.ts:255).
- Parallel dispatch: repo-maintenance potrafi dzielić pracę na subtaski i wykonywać grupy równolegle. Zobacz [parallel-dispatch.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/services/parallel-dispatch.ts:112).
- Autoheal: są tickety, workflow naprawczy, worktree, review i deploy/verify. Zobacz [repo-maintenance.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/workflows/repo-maintenance.ts:32).
- Shared memory: są narzędzia do zapisu kontekstu i sygnałów. Zobacz [add-context.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/tools/memory/add-context.ts:14).
- Pattern RAG dla automatyzacji: masz 43 wzorce w Mongo i embedding-based matching. Zobacz [pattern-rag.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/tools/architect/pattern-rag.ts:25).
- Skille lokalne: istnieje `_skills`, ale obecnie search jest głównie keywordowy i dostępny dla automation architect. Zobacz [skills-search.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/tools/architect/skills-search.ts:156).

Z żywego Mongo wynika, że system już generuje dużo danych: `mastra_messages` 190, `mastra_threads` 21, `automation_patterns` 43, `auto_healing_tickets` 9, `code_task_artifacts` 16, `logs` 12920. Jednocześnie `signals` ma 0 rekordów, `mastra_observational_memory` ma 0, a `token_usage` i `workflow_runs` też są puste. Czyli są dane operacyjne, ale nie ma jeszcze prawdziwej pętli uczenia.

**Największe Braki**
- Brak jednego, typowanego `Agent Event Log`, który mówi: kto, kiedy, jaki model, jakie narzędzie, jaki wynik, jaki błąd, jaki koszt, jaki retry, jaki outcome.
- Brak Memory Extractora, który zamienia zdarzenia w wiedzę typu `failure_case`, `autoheal_recipe`, `tool_contract`, `coding_pattern`, `n8n_pattern`, `prompt_rule`, `user_preference`.
- Brak systemowych narzędzi `system.memory_recall` i `system.memory_write_observation`.
- Obecna pamięć agentów to głównie `lastMessages`; dokument o observational memory sam wskazuje, że nie jest włączona. Zobacz [observation-memory-mastra.md](/projekty/mastra-agentic-environment/agentic-agents/ideas/observation-memory-mastra.md:16).
- `recall_worker_lessons` istnieje, ale `signals` jest puste, więc mechanizm lekcji praktycznie nie pracuje. Zobacz [recall-worker-lessons.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/tools/system/recall-worker-lessons.ts:20).
- Subtask execution używa w praktyce tego samego `codingAgent` z innym modelem, a nie wyspecjalizowanych ról typu Terminal/FileEditor/QA. Zobacz [subtask-executor.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/services/subtask-executor.ts:91).
- MCP/NotebookLM jest niespójne: masz [mcp.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/mcp.ts:1), ale realnie używane są narzędzia CLI/NotebookLM z [knowledge-tools.ts](/projekty/mastra-agentic-environment/agentic-agents/src/mastra/tools/knowledge/knowledge-tools.ts:1).
- Są drobne ryzyka architektoniczne: shared-memory processor zapisuje `expiresAt` inaczej niż główne narzędzia, `coding.run_test` przyjmuje dowolną komendę, a `coding.apply_patch` jest mocnym narzędziem dostępnym agentowi. To warto uszczelnić przed dalszą autonomią.

**Rekomendowana Kolejność**
1. Najpierw `agent_events`: jedna kolekcja/warstwa zdarzeń dla agentów, narzędzi, workflow, błędów, decyzji routera i wyników testów.
2. Potem `system_knowledge`: ekstraktor, który z tych eventów robi trwałe rekordy wiedzy z typem, źródłem, confidence, embeddingiem i linkiem do runa.
3. Dodać `system.memory_recall` i `system.memory_write_observation`, najpierw dla `metaAgent`, `codingAgent`, `codeReviewAgent` i `automationArchitect`.
4. Pierwszy realny use case: Failure Brain dla autoheal. Przed diagnozą workflow powinien przypominać podobne awarie, udane naprawy i błędne ścieżki.
5. Dopiero potem rozbudować Skill Registry: indeksować `_skills`, n8n blocks, terminal skills, wzorce automatyzacji i mierzyć skuteczność skilla po wyniku zadania.
6. Następnie wyspecjalizowane subagenty: `RepoExplorer`, `TerminalWorker`, `FileEditor`, `QA`, `Reviewer`. Każdy z małym toolsetem i własnym recall, zamiast jednego dużego agenta od wszystkiego.
7. Obsidian jako mirror dla człowieka, nie jako runtime core. Markdownowe decyzje, failure cases i dzienne raporty będą świetne, ale powinny być eksportem z pamięci systemowej.
8. Qdrant/LightRAG dopiero gdy danych będzie dużo albo Mongo+embedding zacznie boleć wydajnościowo. Na teraz wystarczy istniejący embedder i Mongo/DuckDB.

**Wpływ Na Infrastrukturę**
To podejście nie wymaga od razu nowego dużego serwisu. Możesz zacząć na obecnym Mongo, obecnym embedderze i istniejących workflow. Największa zmiana to nie infrastruktura, tylko kontrakt danych: system musi konsekwentnie zapisywać decyzje, wyniki i lekcje w jednym formacie.

Efekt praktyczny będzie taki, że dobór narzędzi i modeli przestanie opierać się tylko na promptach oraz statycznym registry. Router będzie mógł pytać: “który model i skill działał najlepiej dla podobnego zadania?”, autoheal będzie pamiętał wcześniejsze naprawy, a meta-agent będzie dyrygował na podstawie historii skuteczności, nie tylko opisu narzędzi. To jest najzdrowszy fundament pod dalszą rozbudowę systemu agentowego w Mastra.



*** A tu mamy sprawdzenie OM w mastra i jak najlepiej z nia zaczac czyli dla meta agenta, , codding agenta i przyszłego master codding agenta :

# Observational Memory w Mastra

Data notatki: 2026-05-07

## Kontekst

Mastra dodala Observational Memory jako warstwe dlugoterminowej pamieci agenta. To nie jest zwykle trzymanie wiekszej liczby wiadomosci w promptcie i nie jest to klasyczny RAG. Mechanizm uzywa background agentow Observer i Reflector, ktore kompresuja starsza historie rozmowy do obserwacji i refleksji.

Oficjalne materialy:

- https://mastra.ai/research/observational-memory
- https://mastra.ai/blog/observational-memory
- https://mastra.ai/blog/changelog-2026-02-04
- https://mastra.ai/blog/changelog-2026-03-23

## Co mamy teraz

W obecnym repo nie mamy wlaczonej Observational Memory.

Mamy:

- zwykla `Memory` Mastry z `lastMessages`:
  - `src/mastra/agents/meta-agent.ts` ma `lastMessages: 30`
  - `src/mastra/agents/marketing-agent.ts` ma `lastMessages: 15`
  - `src/mastra/agents/sales-agent.ts` ma `lastMessages: 15`
  - `src/mastra/agents/analytics-agent.ts` ma `lastMessages: 10`
  - `src/mastra/agents/automation-architect.ts` ma `lastMessages: 20`
- wlasny processor `sharedMemoryOutputProcessor`, ktory zapisuje wybrane decyzje meta-agenta do kolekcji `shared_memory` z TTL 24h
- narzedzia `shared_memory.add_context`, `shared_memory.list_context`, `shared_memory.push_signal`
- globalny storage Mastry na MongoDB przez `MongoDBStore`

Wersja paczki lokalnie:

- `@mastra/memory@1.17.4`

To znaczy, ze technicznie mozemy wlaczyc OM bez duzej przebudowy.

## Co daje Observational Memory

OM utrzymuje trzy warstwy pamieci:

1. Recent messages - ostatnia dokladna historia rozmowy.
2. Observations - skompresowane obserwacje z dluzszej historii.
3. Reflections - dalsze kondensowanie obserwacji, kiedy same obserwacje rosna.

Wedlug dokumentacji i changelogow Mastry:

- `observationalMemory: true` wlacza system recent messages -> observations -> reflections.
- Domyslnym modelem dla OM jest `google/gemini-2.5-flash`.
- Przy konfiguracji obiektowej trzeba jawnie podac model.
- OM wspiera storage: `@mastra/pg`, `@mastra/libsql`, `@mastra/mongodb`.
- OM moze dzialac w `scope: 'thread'` albo eksperymentalnie w `scope: 'resource'`.
- Jest tryb retrieval, ktory pozwala agentowi wracac do surowych wiadomosci stojacych za obserwacjami.
- Sa temporal markers, ktore pomagaja agentowi rozumiec przerwy w rozmowie.

## Czy ma to sens u nas

Tak, ale selektywnie.

Najwiekszy sens:

- `metaAgent`
- przyszly `codingAgent`
- agent do dlugich rozmow operacyjnych
- agent, ktory ma pamietac decyzje projektowe, preferencje i kontekst debugowania

Mniejszy sens:

- `weekly-content`
- `producer-hunt`
- workflowy cronowe
- workflowy, ktore powinny bazowac na aktualnym CRM, RSS, NotebookLM lub Mongo, a nie na historii rozmowy

OM nie powinno zastepowac CRM ani jawnego systemu uczenia o leadach. Jesli uzytkownik powie: "ten kontakt ma nowy status", agent dalej powinien uzyc narzedzia CRM. Observational Memory moze pamietac, ze taka rozmowa byla, ale zrodlem prawdy musi zostac baza CRM.

## Rekomendowany pilot

Wlaczyc OM tylko dla `metaAgent`.

Proponowana konfiguracja startowa:

```ts
memory: new Memory({
  options: {
    lastMessages: 30,
    observationalMemory: {
      model: 'google/gemini-2.5-flash',
      temporalMarkers: true,
      retrieval: { scope: 'thread' },
    },
  },
})
```

Dlaczego tak:

- `scope: 'thread'` jest bezpieczniejszy niz `resource`, bo nie miesza wielu watkow.
- `temporalMarkers: true` pomaga przy powrotach po kilku godzinach/dniach.
- `retrieval: { scope: 'thread' }` pozwala agentowi odzyskac dokladne fragmenty historii, ale tylko z biezacego watku.
- `google/gemini-2.5-flash` jest domyslnym i rekomendowanym lekkim modelem dla OM.

## Modele

Observer i Reflector powinny byc szybkie, tanie i miec duze okno kontekstu.

Rekomendacja:

- pilot: `google/gemini-2.5-flash`
- alternatywa tania: `openai/gpt-5.2-mini`
- alternatywa Anthropic: `anthropic/claude-haiku-4-5`
- lokalnie tylko po testach, bo lokalny model moze gorzej streszczac dluga historie i miec gorsze limity kontekstu

Docelowo mozna dodac routing po liczbie tokenow przez `ModelByInputTokens`, np. mniejszy model dla krotkich obserwacji, mocniejszy dla duzych refleksji.

## Gdzie to skonfigurowac

Najczystsza opcja:

1. Dodac sekcje `memory` do `src/mastra/config/workflow-models.ts`, np.:

```ts
memory: {
  observer: modelPresets.googleFlash,
  reflector: modelPresets.googleFlash,
}
```

2. Albo utworzyc osobny plik:

```txt
src/mastra/config/memory-config.ts
```

3. Utworzyc helper:

```ts
export function createMetaMemory() {
  return new Memory({
    options: {
      lastMessages: 30,
      observationalMemory: {
        model: workflowModels.memory.observer,
        temporalMarkers: true,
        retrieval: { scope: 'thread' },
      },
    },
  });
}
```

4. W `meta-agent.ts` podmienic inline `new Memory(...)` na `createMetaMemory()`.

5. Zostawic `sharedMemoryOutputProcessor`, bo to inny mechanizm:
   - OM = pamiec rozmowy i kontekstu
   - `shared_memory` = jawne decyzje/sygnaly dla innych agentow i workflowow

## Ryzyka

- Dodatkowe koszty i latency background LLM calls.
- Ryzyko blednych obserwacji, jesli model Observer jest slaby.
- Nie mozna traktowac OM jako zrodla prawdy dla CRM.
- W `resource` scope agent moze mieszac kontekst z wielu watkow, dlatego na start lepszy jest `thread`.
- OM wymaga poprawnego `threadId`; bez tego moze rzucac blad.

## Test akceptacyjny pilota

1. Wlaczyc OM tylko dla `metaAgent`.
2. Przeprowadzic dluga rozmowe z minimum kilkoma zadaniami:
   - CRM
   - repo/kod
   - decyzja projektowa
   - przerwa czasowa
3. Wrocic do watku i zapytac agenta o:
   - decyzje z poczatku rozmowy
   - powody podjetej decyzji
   - co bylo ostatnim stanem zadania
4. Sprawdzic w Studio Memory tab, czy pojawily sie obserwacje.
5. Zweryfikowac, czy agent nie wymysla faktow i dalej uzywa CRM jako zrodla prawdy.

## Decyzja

Warto wdrozyc jako pilot dla `metaAgent`, a potem przeniesc na `codingAgent`. Nie wlaczac globalnie dla wszystkich agentow i workflowow.




tutaj mamy tez ressearch w poszukiwaniu darmowych modeli chmurowych które moglibysmy podpiąć przez api jako subagenci, dzieki czemu nasi agenci delegujący subtaski mogliby uruchamiac wiecej jednoczesnych zapytań jesli mamy mozliwosc skorzystania z darmowych api . główna idea to wykorzystać te modele dla subagentów bo oni maja mniejsze taski które nie bedą przekazywały providerom duzych ilosci naszych danych, dlatego tez nie bedziemy ich używac do agentów dyrygujących którzy maja dostep do duzego zasobu wiedzy o kodzie lub zadaniu. 
Bede jeszcze potwierdzał jakie są limity tych modeli przez api i czy mozna uzywac po kilka instancji tego samego modelu.

Tak, są darmowe modele **LLM przez API**, ale trzeba rozróżnić 3 typy:

1. **prawdziwy free tier ciągły** - darmowe, ale z limitami,
2. **darmowe trial credits** - np. $1, $5, $10 na start,
3. **free router / community free models** - darmowe modele przez agregator, ale bez gwarancji stabilności.

## Najsensowniejsze darmowe API LLM teraz

| Provider                             |                    Darmowość | Modele / sens użycia                                                                             | Haczyk                                                                           |
| ------------------------------------ | ---------------------------: | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Google Gemini API**                |             ciągły free tier | `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite`, embeddingi, część narzędzi | darmowy tier może używać danych do poprawy produktów, limity zależą od projektu  |
| **OpenRouter Free Models**           |             ciągły free tier | darmowe modele z suffixem `(free)`, np. gpt-oss, GLM, Nemotron, MiniMax, Poolside                | jakość i dostępność mogą się zmieniać, prompt może być logowany przez providerów |
| **GroqCloud**                        |             ciągły free tier | szybkie open modele, dobre do agentów, klasyfikacji, prostych pipeline’ów                        | limity RPM/TPM/TPD zależą od konta                                               |
| **GitHub Models**                    |             ciągły free tier | API do testowania modeli z GitHub Marketplace                                                    | mocno limitowane, raczej prototypowanie niż produkcja                            |
| **Mistral La Plateforme**            |      darmowy experiment plan | Mistral modele do testów/evaluacji                                                               | tylko evaluation/prototyping, ograniczone rate limits                            |
| **Cerebras Inference**               |      free API access / trial | bardzo szybka inferencja, Llama/Qwen/open modele                                                 | free trial / limity, później płatny developer tier                               |
| **Cloudflare Workers AI**            |        darmowy dzienny limit | Llama, Mistral, DeepSeek distill i inne przez Workers AI                                         | limit 10 000 neurons/day, trzeba rozumieć ich jednostki billingowe               |
| **Hugging Face Inference Providers** |     free tier / free credits | dostęp do wielu providerów przez jeden endpoint OpenAI-compatible                                | po darmowych kredytach naliczanie wg providera                                   |
| **Cohere**                           | darmowy trial/evaluation key | Command, embeddings, rerank                                                                      | trial key nie do produkcji/commercial use                                        |
| **Anthropic Claude API**             |   małe free credits na start | Claude API do testów                                                                             | brak trwałego darmowego tieru, po credits trzeba płacić                          |
| **AI21**                             |    $10 credits na 3 miesiące | Jamba przez API                                                                                  | trial credits wygasają                                                           |
| **Fireworks AI**                     |          $1 credits na start | szybkie open modele, dobre do testów                                                             | tylko mały starter credit                                                        |

## Najlepszy wybór dla Twojego meta-agenta

Najbardziej sensowny darmowy stack:

**1. Gemini API jako główny darmowy cloud fallback**
Google ma oficjalny free tier dla Gemini API z darmowymi input/output tokens dla wybranych modeli. W praktyce najciekawsze są `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite` i embeddingi. Google pokazuje też, że free tier obejmuje ograniczony dostęp do wybranych modeli, a paid tier daje wyższe limity i brak używania treści do poprawy produktów. ([Google AI for Developers][1])

**2. OpenRouter jako darmowy router awaryjny**
OpenRouter ma kolekcję darmowych modeli i `openrouter/free`, który automatycznie wybiera darmowy model pod wymagania requestu, np. tool calling, vision albo structured outputs. To jest dobre jako fallback, ale nie wkładałbym tam sekretów ani prywatnego kodu. ([OpenRouter][2])

**3. Groq do szybkich małych zadań**
Groq ma free tier bez karty, z API key i limitami. To jest dobre do klasyfikacji, ekstrakcji JSON, routing decisions, streszczeń i szybkich odpowiedzi w agentach. ([Groq Community][3])

**4. GitHub Models do prototypowania w dev workflow**
GitHub daje darmowy, rate-limited dostęp do modeli przez API/playground. Limity są konkretne: np. dla Copilot Free modele “low” mają 15 RPM i 150 RPD, “high” 10 RPM i 50 RPD, a część modeli typu DeepSeek/Grok ma jeszcze ostrzejsze limity. To jest dobre do testów, nie jako core runtime. ([GitHub Docs][4])

**5. Cloudflare Workers AI jako tani/darmowy edge worker dla prostych tasków**
Cloudflare daje 10 000 neurons dziennie za darmo, a po przekroczeniu trzeba przejść na Workers Paid. Modele obejmują m.in. Llama, Mistral i DeepSeek distill. Dobre do małych automatyzacji, webhooków i edge-pipeline’ów. ([Cloudflare Docs][5])

## Moja konkretna rekomendacja

Do Twojego systemu agentowego zrobiłbym taki routing:

```text
local Ollama
  -> pierwsza próba: lokalny model, np. Qwen/Gemma

Gemini API free
  -> fallback dla trudniejszych tasków, długi kontekst, planowanie, refaktor promptów

Groq free
  -> szybkie JSON/classification/router/summarizer

OpenRouter free
  -> awaryjny fallback, eksperymenty z nowymi modelami

GitHub Models
  -> tylko dev/prototyping, nie runtime produkcyjny
```

Najlepszy start: **Gemini API + Groq + OpenRouter**. To da Ci realny darmowy cloud layer dla meta-agenta bez od razu pakowania pieniędzy w API. Tylko nie wysyłaj tam sekretów, `.env`, prywatnych kluczy, danych klientów ani krytycznego kodu bez anonimizacji.

[1]: https://ai.google.dev/gemini-api/docs/pricing "Gemini Developer API pricing  |  Gemini API  |  Google AI for Developers"
[2]: https://openrouter.ai/collections/free-models "Free AI Models on OpenRouter | OpenRouter"
[3]: https://community.groq.com/t/is-there-a-free-tier-and-what-are-its-limits/790 "Is there a free tier and what are its limits? - FAQs - Groq Community"
[4]: https://docs.github.com/billing/managing-billing-for-your-products/about-billing-for-github-models "GitHub Models billing - GitHub Docs"
[5]: https://developers.cloudflare.com/workers-ai/platform/pricing/ "Pricing · Cloudflare Workers AI docs"


tutaj mamy dodatkowy research na temat darmowych modeli przez openrouter , moze byc pomocne przy planowaniu infrastruktury zarządzania kosztami. napewno wykupiłbym 10$ kredytu lub wiecej jesli to miałoby podnieść free tier tak drastycznie. :
"Tak. Poniżej masz dokładniejszą mapę modeli **OpenRouter free / zero-cost**, pod kątem środowiska agentowego.

Stan na **9 maja 2026**.

## Najważniejsze fakty o free tier OpenRouter

OpenRouter nie daje ci „X darmowych tokenów dziennie”. Oficjalny limit jest głównie request-based:

| Konto                             |                                                      Limit free modeli |
| --------------------------------- | ---------------------------------------------------------------------: |
| konto bez zakupionych credits     |                        **50 requestów dziennie**, **20 requestów/min** |
| konto po zakupie min. $10 credits | **1000 requestów dziennie** na modele free, dalej **20 requestów/min** |
| paid models                       |    brak platformowego limitu OpenRouter, ale provider może throttlowac |

OpenRouter pisze też wprost, że robienie wielu kont albo wielu API key nie omija limitu, bo limit jest zarządzany globalnie. Można natomiast rozkładać ruch między różne modele, bo limity mogą różnić się per model/provider. ([OpenRouter][1])

## Modele, które wymieniłeś

| Model                                   | ID do API                                            | Kontekst |                 Max output | Najlepsze zastosowanie w agencie                                                          | Ryzyko / uwaga                                                                          |
| --------------------------------------- | ---------------------------------------------------- | -------: | -------------------------: | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **inclusionAI Ring-2.6-1T free**        | `inclusionai/ring-2.6-1t:free`                       |     262k |                        65k | ciężki planner, long-horizon agent, coding agent, tool-heavy workflows                    | nowy model, trzeba samemu benchmarkować stabilność                                      |
| **NVIDIA Nemotron 3 Super free**        | `nvidia/nemotron-3-super-120b-a12b:free`             |     262k |                       262k | meta-agent, multi-agent coordination, reasoning, coding, structured outputs, tool calling | bardzo dobry kandydat na główny free fallback                                           |
| **Poolside Laguna M.1 free**            | `poolside/laguna-m.1:free`                           |     131k |                         8k | agent kodujący, patch generation, repo analysis, refactor, SWE tasks                      | małe wyjście 8k, nie używałbym do wielkich raportów                                     |
| **OpenAI gpt-oss-120b free**            | `openai/gpt-oss-120b:free`                           |     131k |                       131k | ogólne reasoning, tool use, agentic tasks, analiza techniczna                             | knowledge cutoff 2024-06-30, free wariant nie pokazuje structured outputs w parametrach |
| **Z.ai GLM 4.5 Air free**               | `z-ai/glm-4.5-air:free`                              |     131k |                        96k | coding, web/task agent, frontend, tool invocation, szybki agent roboczy                   | mniej pewny do ścisłego JSON niż modele ze structured outputs                           |
| **MiniMax M2.5 free**                   | `minimax/minimax-m2.5:free`                          |     196k |                         8k | produktywność, dokumenty, Word/Excel/PPT, coding, browser/research workflows              | output 8k, moderowany endpoint                                                          |
| **NVIDIA Nemotron 3 Nano 30B A3B free** | `nvidia/nemotron-3-nano-30b-a3b:free`                |     256k |     brak jawnego max w API | tani/szybki sub-agent, router, klasyfikator, małe taski coding/reasoning/tool calling     | mniejszy model, nie dawałbym mu roli głównego decydenta                                 |
| **NVIDIA Nemotron 3 Nano Omni free**    | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |     256k |                        65k | multimodalny sub-agent: image/audio/video understanding, perception agent                 | lepszy do percepcji niż do głównego planowania                                          |
| **Owl Alpha**                           | `openrouter/owl-alpha`                               |   1,048k |                       262k | mega long-context, structured outputs, tool use, workflow/code generation                 | najmniej transparentny model z listy, traktować jako eksperymentalny                    |
| **OpenRouter Free Router**              | `openrouter/free`                                    |     200k | zależy od wybranego modelu | losowy router darmowych modeli, dobry jako awaryjny fallback                              | brak deterministycznego wyboru modelu                                                   |

Dane o kontekście, max output, cenie $0 i wspieranych parametrach pochodzą z aktualnego endpointu modeli OpenRouter. Ring-2.6-1T ma 1T parametrów skali i 63B aktywnych, zoptymalizowany jest pod coding agents, tool use i long-horizon execution. ([OpenRouter][2]) Nemotron 3 Super free ma 262k kontekstu, $0 input/output i obsługuje między innymi reasoning, tools, response_format oraz structured_outputs. ([OpenRouter][2]) Laguna M.1 jest modelem Poolside pod agentic coding, z 128k kontekstu, tool calling i reasoning. ([OpenRouter][2]) gpt-oss-120b to 117B MoE, około 5.1B aktywnych parametrów, z trybami reasoning i dobrym tool use. ([OpenRouter][2]) GLM 4.5 Air jest zoptymalizowany pod tool invocation, browsing, software engineering i frontend. ([OpenRouter][2]) MiniMax M2.5 jest mocny w codingu i produktywności biurowej, w tym Word/Excel/PowerPoint i BrowseComp/SWE-Bench. ([OpenRouter][2]) Owl Alpha ma bardzo duże okno kontekstowe i deklarowane wsparcie dla tool use, structured outputs, code generation i automated workflows. ([OpenRouter][2])

## Jak bym je przypisał w Twoim systemie agentowym

### 1. Główny meta-agent / planner

Najpierw:

```text
inclusionai/ring-2.6-1t:free
nvidia/nemotron-3-super-120b-a12b:free
openai/gpt-oss-120b:free
```

Ring i Nemotron Super są najbardziej logiczne do planowania wieloetapowego. gpt-oss-120b dałbym jako trzeci fallback, bo jest sensowny reasoningowo, ale ma starszy cutoff i mniej wygodne parametry structured output w wariancie free.

### 2. Agent kodujący

```text
poolside/laguna-m.1:free
minimax/minimax-m2.5:free
z-ai/glm-4.5-air:free
nvidia/nemotron-3-super-120b-a12b:free
```

Laguna M.1 jest najbardziej naturalna do kodu. MiniMax M2.5 dobrze wygląda do „real-world productivity”, czyli nie tylko kod, ale też pliki, dokumenty i praca na różnych środowiskach. GLM 4.5 Air jest dobry do tool/web/frontendu. Nemotron Super jako reviewer albo fallback.

### 3. Agent do strict JSON / structured output

```text
openrouter/owl-alpha
nvidia/nemotron-3-super-120b-a12b:free
minimax/minimax-m2.5:free
```

Tu ważne: nie każdy model free obsługuje `structured_outputs`. Z twojej listy najlepiej wyglądają **Owl Alpha** i **Nemotron 3 Super**, bo OpenRouter pokazuje im `structured_outputs`/`response_format`. MiniMax M2.5 free ma `response_format`, ale nie widzę `structured_outputs` w free wariancie. Dlatego dla n8n JSON generation nie dawałbym Laguny ani GLM jako pierwszego modelu.

### 4. Agent router / klasyfikator / tani worker

```text
nvidia/nemotron-3-nano-30b-a3b:free
z-ai/glm-4.5-air:free
openai/gpt-oss-20b:free
```

Nie marnowałbym Ring/Nemotron Super na proste decyzje typu:

```text
"czy to zadanie jest: code / research / n8n / email / docs / shell?"
```

Do tego wystarczy mniejszy model. Jeśli klasyfikator się myli, dopiero wtedy eskalacja.

### 5. Multimodalny sub-agent

```text
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
```

To jest ciekawy model do analizy screenów, wideo, audio i obrazów. OpenRouter pokazuje, że przyjmuje text, image, audio i video. Nie mylić z tekstowym `nvidia/nemotron-3-nano-30b-a3b:free`. ([OpenRouter][2])

### 6. Awaryjny fallback

```text
openrouter/free
```

Ten router losowo wybiera darmowe modele, ale filtruje je pod wymagane cechy requestu, np. image understanding, tool calling albo structured outputs. To jest dobre jako ostatni fallback, ale słabe do powtarzalnych testów, bo nie kontrolujesz dokładnie modelu. ([OpenRouter][3])

## Czy możesz mieć wiele wywołań jednocześnie?

Tak, technicznie możesz odpalić wiele requestów równolegle, ale:

1. Na free koncie masz **20 requestów/min**.
2. Masz tylko **50 requestów/dzień**, chyba że kupisz min. $10 credits, wtedy **1000 requestów/dzień** na free modele.
3. Providerzy free mogą throttlowac popularne modele w godzinach szczytu.
4. Nieudane próby mogą liczyć się do dziennego limitu. ([OpenRouter][4])

Czyli praktycznie:

```text
Free bez credits:
- 50 requestów/dzień
- realnie 5-12 większych agent-runów dziennie, zależnie od liczby kroków

Free po zakupie min. $10 credits:
- 1000 requestów/dzień
- realnie 100-250 agent-runów dziennie, jeśli jeden run ma 4-10 wywołań
```

Dla twojego Meta Agenta ustawiłbym kolejkę:

```text
FREE_NO_CREDITS:
max_concurrency = 2
max_requests_per_minute = 12-15
daily_soft_limit = 42
daily_hard_limit = 50

FREE_WITH_10_CREDITS:
max_concurrency = 4-6
max_requests_per_minute = 15-18
daily_soft_limit = 850
daily_hard_limit = 1000
```

Nie ustawiałbym od razu 20 RPM na sztywno, bo w praktyce 429 i timeouty zjedzą ci quota.

## Najważniejsza rzecz: predykcja tokenów

Nie buduj predykcji na zasadzie „mam X darmowych tokenów”. Buduj na zasadzie:

```text
daily_request_budget
model_context_limit
model_output_limit
success_rate
latency
429_rate
quality_score
```

OpenRouter free to bardziej **limit operacji agenta** niż limit tokenów. Jeden request może mieć teoretycznie bardzo duży kontekst, ale duże requesty na free endpointach będą wolniejsze, bardziej podatne na timeout i mniej przewidywalne.

Moje praktyczne capy:

| Typ taska              |                        Input cap | Output cap |
| ---------------------- | -------------------------------: | ---------: |
| klasyfikacja / routing |                            1k-3k |    300-800 |
| JSON / n8n node spec   |                           4k-12k |      1k-4k |
| code patch             |                           8k-32k |      2k-8k |
| repo analysis          |                          32k-80k |     4k-12k |
| long-context reasoning |                         80k-180k |     8k-20k |
| ogromny kontekst       | tylko Owl/Nemotron/Ring, testowo | nie szaleć |

Nawet jeśli model ma max output 65k albo 262k, w agentach nie chcesz takich odpowiedzi. To niszczy latency, parsowanie i kontrolę.

## Proponowany routing dla Twojego Meta Agenta

```ts
export const FREE_MODEL_ROUTES = {
  planner: [
    "inclusionai/ring-2.6-1t:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "openai/gpt-oss-120b:free",
    "openrouter/free"
  ],

  coder: [
    "poolside/laguna-m.1:free",
    "minimax/minimax-m2.5:free",
    "z-ai/glm-4.5-air:free",
    "nvidia/nemotron-3-super-120b-a12b:free"
  ],

  reviewer: [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "inclusionai/ring-2.6-1t:free",
    "openai/gpt-oss-120b:free"
  ],

  strictJson: [
    "openrouter/owl-alpha",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "minimax/minimax-m2.5:free"
  ],

  classifier: [
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "z-ai/glm-4.5-air:free",
    "openai/gpt-oss-20b:free"
  ],

  multimodal: [
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
  ],

  longContext: [
    "openrouter/owl-alpha",
    "inclusionai/ring-2.6-1t:free",
    "nvidia/nemotron-3-super-120b-a12b:free"
  ],

  lastResort: [
    "openrouter/free"
  ]
};
```

## Auto-switch: jak to zrobić dobrze

OpenRouter ma natywny fallback przez parametr `models`, gdzie podajesz listę modeli w kolejności. Jeśli pierwszy model ma błąd, rate limit, downtime albo moderation refusal, OpenRouter próbuje kolejny. ([OpenRouter][5])

Ale ja bym nie ufał tylko temu. Zrób własny router w Meta Agencie:

```text
1. Sprawdź task_type:
   code / json / planning / classifier / multimodal / research / long_context

2. Wybierz route listę modeli.

3. Sprawdź lokalny licznik:
   daily_requests_used
   model_429_count
   model_timeout_count
   avg_latency
   parse_failure_rate
   quality_score

4. Jeśli model przekracza próg błędów:
   circuit_breaker(model, 15-60 min)

5. Wyślij request.

6. Jeśli:
   429 -> switch model + backoff
   timeout -> switch model
   invalid_json -> retry raz z modelem strictJson
   low_confidence -> escalate do Ring/Nemotron Super
   context_error -> switch do Owl/Ring/Nemotron Super albo zrób chunking

7. Zapisz wynik do Mongo/Redis.
```

Minimalna tabela w Redis/Mongo:

```json
{
  "date_utc": "2026-05-09",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "task_type": "planner",
  "requests": 14,
  "success": 12,
  "rate_limit_429": 1,
  "timeouts": 1,
  "invalid_json": 0,
  "avg_latency_ms": 18400,
  "avg_prompt_tokens": 9200,
  "avg_completion_tokens": 1800,
  "quality_score": 0.82,
  "circuit_open_until": null
}
```

## Moja konkretna rekomendacja

Dla twojego środowiska agentowego zrobiłbym tak:

```text
Core free cloud brain:
- Ring-2.6-1T
- Nemotron 3 Super
- gpt-oss-120b

Coding lane:
- Laguna M.1
- MiniMax M2.5
- GLM 4.5 Air

Strict JSON / n8n generator:
- Owl Alpha
- Nemotron 3 Super
- MiniMax M2.5

Cheap workers:
- Nemotron 3 Nano 30B A3B
- GLM 4.5 Air

Multimodal:
- Nemotron 3 Nano Omni

Emergency:
- openrouter/free
```

Najbardziej wartościowy ruch: kupić **minimum $10 credits** na OpenRouter nie po to, żeby od razu płacić za modele, tylko żeby podnieść limit free modeli z **50 do 1000 requestów/dzień**. To zmienia OpenRouter z zabawki testowej w realny fallback layer dla twojego Meta Agenta.

[1]: https://openrouter.ai/docs/api/reference/limits "API Rate Limits | Configure Usage Limits in OpenRouter | OpenRouter | Documentation"
[2]: https://openrouter.ai/api/v1/models "openrouter.ai"
[3]: https://openrouter.ai/openrouter/free "Free Models Router - API Pricing & Providers | OpenRouter"
[4]: https://openrouter.ai/pricing "Pricing | OpenRouter"
[5]: https://openrouter.ai/docs/guides/routing/model-fallbacks "Model Fallbacks | Reliable AI with Automatic Failover | OpenRouter | Documentation"
"
pamietaj ze to są propozycje wykorzystaniia zaproponowane przez llm który nawet nie widział mojego repo wiec traktuj te researche jako informacyjne a nie jako ostateczne wybory.

myślę że warto podjąć decyzje architektonicznie strategine juz teraz i zbudować ścieżkę którą bedę podążał rozwijając projekt . 