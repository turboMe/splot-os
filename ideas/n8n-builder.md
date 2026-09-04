Tak. Są repo dokładnie pod ten problem. Najważniejszy wniosek: **same “skille” nie wystarczą**, jeśli Twój agent ma budować workflow powyżej 4 node’ów. Potrzebujesz zestawu:

```txt
skills + node schema + examples + validator + repair loop + import/push do n8n
```

Bez walidacji agent będzie zgadywał `node type`, `typeVersion`, parametry, połączenia i expression syntax.

## Najlepsze repo, które znalazłem

### 1. `czlonkowski/n8n-skills` - najlepszy skill pack stricte do n8n

To jest najbardziej trafione repo pod Twoje pytanie. Zawiera **7 komplementarnych skillów** dla budowania n8n workflow, m.in. workflow patterns, MCP tools expert, validation expert, node configuration, Code node JavaScript, troubleshooting i expression syntax. Repo deklaruje wsparcie dla 525+ node’ów, 2,653+ template examples i 10 production-tested Code node patterns. ([GitHub][1])

Najważniejsze elementy:

```txt
- n8n Workflow Patterns
- n8n MCP Tools Expert
- n8n Validation Expert
- n8n Node Configuration
- n8n Code JavaScript
- error catalog
- real template examples
```

To repo jest dobre jako **skill brain** dla Twojego agenta.

Instalacja testowa:

```bash
cd /projekty
git clone https://github.com/czlonkowski/n8n-skills.git
```

Potem możesz przepisać te skille do własnej struktury:

```txt
/projekty/agentforge/skills/n8n/
├── workflow-patterns/
├── validation-expert/
├── node-configuration/
├── code-node-javascript/
├── expression-syntax/
└── troubleshooting/
```

Moja ocena: **brać jako baza numer 1**.

---

### 2. `czlonkowski/n8n-mcp` - najważniejsze narzędzie do grounding node’ów

To nie jest skill pack, tylko **MCP server**, który daje agentowi dostęp do dokumentacji node’ów, properties, operations, templates i realnych konfiguracji. Repo deklaruje dostęp do ponad 1,500 n8n node’ów, 99% coverage właściwości node’ów, 2,646 real-world extracted configurations i 2,709 workflow templates. ([GitHub][2])

To jest ważniejsze niż sam prompt, bo agent może zapytać:

```txt
- jakie parametry ma Telegram Trigger?
- jaki typeVersion ma MongoDB node?
- jak wygląda poprawny HTTP Request node?
- jakie są przykładowe konfiguracje AI Agent node?
- jak walidować workflow?
```

Dla workflow >4 node’y to jest krytyczne. Bez tego model zgaduje strukturę JSON.

Moja ocena: **must-have** dla Twojego meta-agenta.

---

### 3. `EtienneLescot/n8n-as-code` - najbardziej zaawansowane podejście

To jest prawdopodobnie najciekawsze repo strategicznie. Nie tylko pomaga generować JSON, ale pozwala traktować n8n workflow jako kod, z lokalną walidacją, GitOps, TypeScript workflows, sync z n8n i AI skill/ontology dla agentów. Dokumentacja mówi wprost, że agent dostaje pełną “n8n ontology”: node’y, schema, docs, templates, validation i realny kształt połączeń między node’ami. ([n8n-as-code][3])

Dane z docs:

```txt
537 n8n nodes
100% schema coverage
10,209 properties
17,155 option values
1,243 docs pages
7,702 templates
104 AI/LangChain nodes
built-in validation
```

([n8n-as-code][3])

To repo może rozwiązać Twój problem lepiej niż zwykły prompt, bo workflow staje się czymś, co agent może:

```txt
search -> pull -> edit -> validate -> push
```

Dokumentacja pokazuje dokładnie taki lifecycle:

```bash
n8nac list
n8nac pull abc123
n8nac push workflows/instance/project/order-alert.workflow.ts --verify
```

([n8n-as-code][3])

Moja ocena: **najlepsze pod produkcyjne workflow >4 node’y**, bo wymusza review, walidację i wersjonowanie.

---

### 4. `jorgevz/n8n-workflows-maker` - prostsze prompty dla terminalowego agenta

To repo ma prompty do generowania gotowych JSON workflow do importu w n8n. Ma osobne role/prompt files: `n8n_Build_Captain.md`, `n8n_QA_Compliance.md`, `n8n_Security_Architect.md`, plus katalogi `workflows`, `samples`, `templates`. Autor opisuje cel jako użycie terminalowego AI agenta jako workflow engineer, walidację przez QA/Security agentów i version-control promptów oraz workflow artifacts. ([GitHub][4])

To jest mniej zaawansowane niż `n8n-as-code`, ale dobre jako inspiracja do Twojej architektury:

```txt
Builder Agent -> QA Agent -> Security Agent -> final JSON
```

Moja ocena: **dobry prompt pattern**, ale nie wystarczy samodzielnie do dużych workflow.

---

### 5. `haunchen/n8n-skills` - gotowy skill pack z resources

To repo generuje paczkę `n8n-skills`, zawierającą główny `SKILL.md` i folder `resources` z dokumentacją node’ów według kategorii: input, output, transform, trigger, organization, misc, community i templates. Instrukcja przewiduje użycie w Claude Code, Claude.ai i Claude Desktop. ([GitHub][5])

Struktura wygląda tak:

```txt
n8n-skills/
├── SKILL.md
└── resources/
    ├── input/
    ├── output/
    ├── transform/
    ├── trigger/
    ├── organization/
    ├── misc/
    ├── community/
    └── templates/
```

([GitHub][5])

Moja ocena: **dobry skill pack**, ale najpierw brałbym `czlonkowski/n8n-skills`.

---

### 6. `FlowEngine-cloud/mcp-n8n-workflow-builder-flowengine` - MCP generator workflow

To MCP nie daje tylko kontekstu, ale deklaruje generowanie gotowych, walidowanych workflow z natural language. README opisuje go jako “complete workflow generation engine” z built-in validation, auto-fixing i architectural intelligence. ([GitHub][6])

Instalacja lokalna:

```bash
npm install -g flowengine-n8n-workflow-builder
```

Konfiguracja MCP przykładowo:

```json
{
  "mcpServers": {
    "flowengine-n8n": {
      "command": "flowengine-n8n"
    }
  }
}
```

Repo wspiera Claude Desktop, Claude Code, Cursor, Cline i Continue.dev. ([GitHub][6])

Uwaga: część FlowEngine wygląda jak usługa z kredytami / zewnętrznym backendem, więc do Twojego lokalnego systemu trzeba sprawdzić, czy chcesz zależność od zewnętrznego API. Repo `Ami3466/n8n-nodes-flowengine` opisuje też node “FlowEngine AI Workflow Builder”, który zwraca complete workflow JSON lub guidance i ma `credits_remaining`. ([GitHub][7])

Moja ocena: **ciekawe do testów**, ale nie robiłbym z tego głównego rdzenia, jeśli chcesz lokalność i kontrolę.

---

### 7. `crystalmyth/n8n-bmad` - metodologia multi-agent dla n8n

To jest bardziej framework metodologiczny niż paczka node schemas. Deklaruje 15 specialized AI agent personas, scale-adaptive intelligence, składnię `/n8n:agent *skill`, ponad 25 workflow definitions, 7 handler components i 37 document templates. ([GitHub][8])

To może być przydatne, jeśli chcesz, żeby Twój meta-agent nie tylko generował JSON, ale prowadził proces:

```txt
requirements -> architecture -> implementation -> validation -> security -> runbook
```

Moja ocena: **dobre jako inspiracja dla procesu**, nie jako główne źródło prawdy o node’ach.

---

## Dlaczego Twój agent sypie się powyżej 4 node’ów

Bo przy większym workflow rośnie liczba rzeczy, które muszą być poprawne jednocześnie:

```txt
1. poprawne node types
2. poprawne typeVersion
3. poprawne parameters
4. poprawne credentials placeholders
5. poprawne expressions
6. poprawne connections
7. poprawne branches IF/Switch
8. obsługa błędów
9. mapping danych między node’ami
10. walidacja importu
11. layout pozycji node’ów
12. security check
```

LLM bez narzędzi walidacyjnych zwykle robi workflow “ładny logicznie”, ale niekoniecznie importowalny.

Dla workflow >4 node’y agent nie powinien pisać od razu finalnego JSON. Powinien działać tak:

```txt
1. Requirement extraction
2. Workflow architecture
3. Node inventory
4. Data contract między node’ami
5. Generate minimal graph
6. Validate node schemas
7. Validate connections
8. Add error handling
9. Security review
10. Generate importable JSON
11. Dry-run / import test
12. Repair loop
```

## Co bym wdrożył u Ciebie

Najlepszy stack dla Twojego AgentForge:

```txt
Core skills:
- czlonkowski/n8n-skills

Grounding / schema:
- czlonkowski/n8n-mcp

Workflow as code / validation:
- EtienneLescot/n8n-as-code

Prompt patterns:
- jorgevz/n8n-workflows-maker

Optional:
- FlowEngine MCP do porównania wyników
```

Czyli nie jeden agent “napisz mi workflow”, tylko pipeline:

```txt
Meta Agent
   |
   v
n8n Requirement Analyst
   |
   v
n8n Architect
   |
   v
Node Schema Researcher przez n8n-mcp
   |
   v
Workflow JSON Builder
   |
   v
n8n Validator / n8n-as-code
   |
   v
Security Reviewer
   |
   v
Import / Push / Repair Loop
```

## Minimalna struktura skillów dla Twojego agenta

Zrobiłbym tak:

```txt
/projekty/agentforge/skills/n8n/
├── SKILL.md
├── resources/
│   ├── node-patterns.md
│   ├── expressions.md
│   ├── code-node-patterns.md
│   ├── error-handling.md
│   ├── credentials-policy.md
│   └── workflow-json-rules.md
├── templates/
│   ├── telegram-to-mongodb.json
│   ├── webhook-llm-router.json
│   ├── scheduled-report.json
│   ├── lead-capture-crm.json
│   └── ai-agent-with-memory.json
└── validators/
    ├── workflow-checklist.md
    ├── security-checklist.md
    └── importability-checklist.md
```

Najważniejszy dokument to `workflow-json-rules.md`, gdzie agent ma twarde reguły:

```txt
- never invent node type
- always verify node schema before generation
- every node must have id, name, type, typeVersion, position, parameters
- every edge must reference existing node names
- every IF/Switch branch must have explicit true/false or output index mapping
- credentials must be placeholders, never secrets
- every generated workflow must include manual test instructions
- after generating JSON, run validation before final answer
```

## Komendy testowe

Najpierw pobierz najważniejsze repo:

```bash
mkdir -p /projekty/n8n-agent-research
cd /projekty/n8n-agent-research

git clone https://github.com/czlonkowski/n8n-skills.git
git clone https://github.com/czlonkowski/n8n-mcp.git
git clone https://github.com/EtienneLescot/n8n-as-code.git
git clone https://github.com/jorgevz/n8n-workflows-maker.git
```

Potem osobny test `n8n-as-code`:

```bash
mkdir -p /projekty/agentforge-n8n-poc
cd /projekty/agentforge-n8n-poc

npx --yes n8nac init
npx --yes n8nac update-ai
```

Dla MCP:

```bash
npm install -g flowengine-n8n-workflow-builder
```

Ale FlowEngine traktowałbym jako eksperyment, nie fundament.

## Moja rekomendacja bez lukru

Najbardziej sensowna kombinacja:

```txt
1. czlonkowski/n8n-skills
2. czlonkowski/n8n-mcp
3. n8n-as-code
```

To powinno wyraźnie poprawić jakość workflow powyżej 4 node’ów, bo agent przestaje zgadywać i zaczyna pracować według schematów, przykładów i walidacji.

Nie budowałbym tego jako “jeden prompt do Gemmy”. Zrobiłbym z tego **n8n Workflow Builder Agent** z obowiązkowym procesem:

```txt
PLAN -> NODE RESEARCH -> GRAPH DESIGN -> JSON GENERATION -> VALIDATION -> SECURITY REVIEW -> REPAIR
```

Największy błąd obecnego rozwiązania prawdopodobnie jest taki, że agent za wcześnie generuje finalny workflow. Powinien najpierw zbudować **specyfikację grafu**, dopiero potem JSON. Workflow powyżej 4 node’ów to już nie jest prompt-writing. To jest mała architektura systemowa.

[1]: https://github.com/czlonkowski/n8n-skills?utm_source=chatgpt.com "czlonkowski/n8n-skills"
[2]: https://github.com/czlonkowski/n8n-mcp "GitHub - czlonkowski/n8n-mcp: A MCP for Claude Desktop / Claude Code / Windsurf / Cursor to build n8n workflows for you · GitHub"
[3]: https://n8nascode.dev/ "n8n-as-code - Manage n8n workflows as code with version control and AI assistance | n8n-as-code"
[4]: https://github.com/jorgevz/n8n-workflows-maker "GitHub - jorgevz/n8n-workflows-maker: Terminal agent + Prompts = ready to import n8n workflow JSON files · GitHub"
[5]: https://github.com/haunchen/n8n-skills "GitHub - haunchen/n8n-skills: Designed specifically for AI assistants, the n8n Workflow Automation Skills Suite. · GitHub"
[6]: https://github.com/FlowEngine-cloud/mcp-n8n-workflow-builder-flowengine "GitHub - FlowEngine-cloud/mcp-n8n-workflow-builder-flowengine · GitHub"
[7]: https://github.com/Ami3466/n8n-nodes-flowengine "GitHub - Ami3466/n8n-nodes-flowengine · GitHub"
[8]: https://github.com/crystalmyth/n8n-bmad "GitHub - crystalmyth/n8n-bmad: AI-powered methodology framework for n8n workflow automation teams · GitHub"




-----

Tak, rozumiesz to dobrze: **większość tego setupu możesz postawić lokalnie** i dać jako narzędzia Twojemu meta-agentowi. Najlepszy setup nie powinien jednak polegać na tym, że agent “ma prompt do n8n”. To musi być **pętla ReAct z walidacją, RAG-iem skillów, dostępem do schematów node’ów i mechanizmem naprawy błędów**.

Moja rekomendacja:

```txt
Meta Agent
  -> n8n Skill RAG
  -> n8n MCP / node schema search
  -> n8n Architect Agent
  -> Workflow Builder Agent
  -> Validator Agent
  -> Security Reviewer
  -> n8n API / n8n-as-code / import layer
  -> Repair loop
```

## Setup, który bym zbudował

### 1. Lokalna baza skillów n8n

Pobrałbym jako bazę:

```bash
mkdir -p /projekty/agentforge/research/n8n
cd /projekty/agentforge/research/n8n

git clone https://github.com/czlonkowski/n8n-skills.git
```

To repo ma 7 skillów specjalnie do budowania workflow n8n: expression syntax, MCP tools expert, workflow patterns, validation expert, node configuration, code JavaScript i code Python. Autor opisuje też, że skille mają działać razem: pattern wybiera architekturę, MCP skill szuka node’ów, node configuration ustawia parametry, expression skill mapuje dane, a validation skill naprawia błędy. ([GitHub][1])

Twojemu agentowi dałbym te skille nie jako jeden wielki prompt, tylko jako RAG:

```txt
/agentforge/skills/n8n/
  expression-syntax/
    SKILL.md
  mcp-tools-expert/
    SKILL.md
  workflow-patterns/
    SKILL.md
  validation-expert/
    SKILL.md
  node-configuration/
    SKILL.md
  code-javascript/
    SKILL.md
  code-python/
    SKILL.md
```

RAG wybiera tylko te skille, które są potrzebne do bieżącego zadania.

## 2. Lokalny `n8n-mcp` jako źródło prawdy o node’ach

To jest kluczowe. `czlonkowski/n8n-mcp` to MCP server dający agentowi dostęp do dokumentacji node’ów, properties, operations, przykładów konfiguracji i template’ów n8n. Repo podaje dostęp do ponad 1500 node’ów, 99% coverage properties, 2646 przykładowych konfiguracji i 2709 workflow templates. ([GitHub][2])

Czyli agent nie powinien zgadywać:

```txt
Czy Slack node ma parametr channel czy channelId?
Czy Telegram Trigger używa updates czy event?
Czy HTTP Request potrzebuje sendBody + contentType?
Jaki typeVersion ma dany node?
Jak wygląda poprawne połączenie IF -> true/false?
```

On powinien pytać `n8n-mcp`.

Lokalny setup jest możliwy. Dokumentacja pokazuje test lokalny przez klonowanie repo, `npm install`, `npm run build` i skrypt integracyjny, który startuje realną instancję n8n w Dockerze oraz n8n-MCP server. ([GitHub][3])

Minimalnie:

```bash
cd /projekty/agentforge/research/n8n

git clone https://github.com/czlonkowski/n8n-mcp.git
cd n8n-mcp

npm install
npm run build
```

Potem tryb lokalny z Twoim n8n:

```bash
export N8N_MODE=true
export MCP_MODE=http
export N8N_API_URL=http://localhost:5678
export N8N_API_KEY=twoj_n8n_api_key
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
export AUTH_TOKEN=$MCP_AUTH_TOKEN
export PORT=3001

npm start
```

Dokumentacja podaje dokładnie te zmienne: `N8N_MODE`, `MCP_MODE`, `N8N_API_URL`, `N8N_API_KEY`, `MCP_AUTH_TOKEN`, `AUTH_TOKEN` i `PORT`. ([GitHub][3])

## 3. `n8n-as-code` jako warstwa walidacji i pracy na plikach

Do workflow powyżej 4 node’ów dałbym agentowi jeszcze `n8n-as-code`.

To repo daje agentowi lokalną ontologię n8n: node’y, properties, options, relacje, templates, walidację i workflow jako kod/plik. Autorzy piszą wprost: “Zero external calls. Zero latency. Zero hallucination”, a repo ma workflow sync, AI skills, TypeScript workflows i GitOps. ([GitHub][4])

Najważniejsze komendy z README:

```bash
npx --yes n8nac init
npx --yes n8nac update-ai

npx --yes n8nac skills search "send slack message when google sheet is updated"
npx --yes n8nac skills node-info slack
npx --yes n8nac skills examples search "AI agent"
npx --yes n8nac skills validate workflow.json
```

Repo pokazuje, że agent może szukać node’ów, docsów, template’ów i walidować workflow przed deploymentem. ([GitHub][4])

Dla Twojego systemu to jest bardzo dobre, bo workflow powyżej 4 node’ów powinien być budowany jako artefakt:

```txt
workflow.plan.md
workflow.graph.json
workflow.n8n.json
validation-report.md
security-review.md
```

Nie jako odpowiedź czatu.

## 4. Pętla ReAct dla budowania automatyzacji

Twój meta-agent powinien mieć twardy workflow roboczy:

```txt
1. UNDERSTAND
   - zrozum intencję użytkownika
   - wyciągnij trigger, akcje, dane wejściowe, dane wyjściowe, credentials, error handling

2. RETRIEVE
   - znajdź właściwe skille w RAG
   - znajdź podobne template’y
   - sprawdź node’y przez n8n-mcp / n8n-as-code

3. PLAN
   - stwórz graph spec
   - lista node’ów
   - kontrakt danych między node’ami
   - branch logic
   - retry/error path

4. BUILD
   - wygeneruj workflow JSON albo TypeScript workflow

5. VALIDATE
   - validate_node minimal
   - validate_node full
   - validate_workflow
   - n8nac skills validate workflow.json

6. SECURITY REVIEW
   - brak sekretów w JSON
   - brak niebezpiecznego Code node bez potrzeby
   - brak komend shell
   - brak wysyłania tokenów do zewnętrznych endpointów

7. REPAIR
   - jeśli walidacja padła, popraw tylko uszkodzoną część
   - nie generuj wszystkiego od zera

8. SAVE / IMPORT
   - zapisz do repo
   - opcjonalnie push/import do lokalnego n8n przez API

9. FINAL
   - pokaż użytkownikowi, co powstało
   - jak testować
   - czego jeszcze brakuje, np. credentials
```

To jest ważniejsze niż sam model.

## 5. Jak to wygląda technicznie w Twoim AgentForge

Proponowana struktura:

```txt
/projekty/agentforge/
├── agents/
│   ├── meta-agent/
│   ├── n8n-architect-agent/
│   ├── n8n-builder-agent/
│   ├── n8n-validator-agent/
│   └── security-reviewer-agent/
│
├── skills/
│   └── n8n/
│       ├── expression-syntax/
│       ├── workflow-patterns/
│       ├── validation-expert/
│       ├── node-configuration/
│       ├── code-javascript/
│       └── code-python/
│
├── rag/
│   ├── skill-index/
│   ├── template-index/
│   └── node-docs-index/
│
├── tools/
│   ├── n8n-mcp-client/
│   ├── n8n-api-client/
│   ├── n8nac-wrapper/
│   ├── workflow-validator/
│   └── file-writer/
│
├── generated-workflows/
│   ├── drafts/
│   ├── validated/
│   └── deployed/
│
└── logs/
    ├── agent-runs/
    ├── validation/
    └── imports/
```

## 6. Jakie narzędzia dać meta-agentowi

Dałbym mu takie tool’e:

```txt
search_skills(query)
read_skill(skill_id)
search_n8n_templates(query)
get_node_info(node_name)
validate_node(node_json)
validate_workflow(workflow_json)
write_workflow_file(path, json)
read_workflow_file(path)
import_workflow_to_n8n(path)
activate_workflow(workflow_id)
list_n8n_workflows()
get_workflow_execution_logs(workflow_id)
```

Nie dawałbym mu od razu pełnego terminala do wszystkiego. Dla n8n wystarczy kontrolowany zestaw wrapperów.

## 7. Lokalnie czy cloud?

### Lokalne

Tak, lokalnie możesz mieć:

```txt
n8n
MongoDB
Redis
Ollama
n8n-skills
n8n-mcp
n8n-as-code
RAG index
workflow validator
AgentForge dashboard
```

`n8n-mcp` ma self-hosting, Docker i local installation options. ([GitHub][2])
`n8n-as-code` deklaruje lokalną ontologię bez zewnętrznych calli. ([GitHub][4])
`n8n-skills` można sklonować i ręcznie używać jako foldery skillów. ([GitHub][1])

### Model

Tu bez lukru: lokalna Gemma/Qwen może wystarczyć do prostych workflow, ale do meta-agenta budującego większe automatyzacje dałbym fallback na mocny model cloud.

Najlepszy układ:

```txt
local model:
- klasyfikacja requestu
- wybór skillów
- proste workflow
- poprawki tekstowe
- routing

cloud reasoning model:
- workflow powyżej 4-6 node’ów
- skomplikowane branche
- Code node
- integracje API
- error handling
- naprawa po walidacji
```

Czyli lokalnie działa większość, ale ciężkie planowanie może iść do Gemini/OpenAI/Claude, jeśli chcesz jakość.

## 8. Dlaczego Twój obecny agent słabo robi >4 node’y

Bo prawdopodobnie działa tak:

```txt
prompt użytkownika -> model generuje JSON -> koniec
```

A powinno być:

```txt
prompt użytkownika
-> specyfikacja wymagań
-> graf logiczny
-> research node’ów
-> wygenerowanie node po node
-> walidacja każdego node’a
-> walidacja całego workflow
-> naprawa
-> dopiero finalny JSON
```

Workflow 8-node’owy to już mały system. Tam model musi pamiętać:

```txt
- gdzie jest payload
- jak dane przechodzą między node’ami
- które node’y są triggerami
- które node’y mają credentials
- które node’y mają output branches
- gdzie idzie error path
- które expressions są poprawne
- czy nazwy node’ów w connections istnieją
```

LLM bez schema lookup i walidacji będzie robił błędy.

## 9. Minimalny setup, który bym wdrożył teraz

Nie kombinowałbym od razu z 10 repo. Zrobiłbym MVP:

```txt
1. n8n-skills jako lokalny skill RAG
2. n8n-mcp jako node schema/documentation tool
3. n8n-as-code jako validator/search/templates layer
4. własny ReAct loop
5. własny repair loop
```

Komendy startowe:

```bash
mkdir -p /projekty/agentforge-n8n-lab
cd /projekty/agentforge-n8n-lab

git clone https://github.com/czlonkowski/n8n-skills.git
git clone https://github.com/czlonkowski/n8n-mcp.git
git clone https://github.com/EtienneLescot/n8n-as-code.git
```

Inicjalizacja `n8n-as-code`:

```bash
cd /projekty/agentforge-n8n-lab

npx --yes n8nac init
npx --yes n8nac update-ai
```

Test wyszukiwania:

```bash
npx --yes n8nac skills search "telegram bot save message to mongodb"
npx --yes n8nac skills node-info telegram
npx --yes n8nac skills node-info mongodb
npx --yes n8nac skills examples search "telegram mongodb"
```

## 10. Bezpieczeństwo

Tu trzeba uważać. n8n miało krytyczne podatności RCE związane z expression evaluation i Code/Python node. GitHub Advisory dla CVE-2026-25049 mówi, że przed wersjami `1.123.17` i `2.5.2` użytkownik z prawem tworzenia lub modyfikowania workflow mógł wywołać komendy systemowe przez spreparowane expressions. ([GitHub][5])
NVD dla CVE-2025-68668 opisuje sandbox bypass w Python Code Node przed n8n 2.0.0, pozwalający authenticated userowi wykonywać komendy na hoście z uprawnieniami procesu n8n. ([NVD][6])

Czyli:

```txt
- trzymaj n8n aktualne
- nie dawaj agentowi dostępu do produkcyjnego n8n
- testuj w dev n8n
- credentials tylko jako placeholdery
- blokuj Python Code node, jeśli niepotrzebny
- Code node tylko po security review
- nie aktywuj workflow automatycznie bez zatwierdzenia
- zapisuj backup przed importem
```

Samo `n8n-mcp` też ostrzega, żeby nie edytować produkcyjnych workflow bezpośrednio AI, tylko robić kopię, testować w development, eksportować backupy i walidować zmiany. ([GitHub][2])

## Finalna rekomendacja

Dla Twojego celu najlepszy setup to:

```txt
AgentForge Meta Agent
  używa:
    - RAG skillów z czlonkowski/n8n-skills
    - schema/tools z czlonkowski/n8n-mcp
    - walidacji i template search z n8n-as-code
    - własnej pętli PLAN -> BUILD -> VALIDATE -> REPAIR
    - lokalnego n8n jako środowiska dev
```

I twarda zasada:

```txt
Agent nigdy nie generuje finalnego workflow od razu.
Najpierw tworzy graph spec.
Potem sprawdza node’y.
Potem buduje JSON.
Potem waliduje.
Potem naprawia.
Dopiero potem zapisuje/importuje.
```

To jest setup, który realnie może przełamać problem workflow powyżej 4 node’ów.

[1]: https://github.com/czlonkowski/n8n-skills "GitHub - czlonkowski/n8n-skills: n8n skillset for Claude Code to build flawless n8n workflows · GitHub"
[2]: https://github.com/czlonkowski/n8n-mcp "GitHub - czlonkowski/n8n-mcp: A MCP for Claude Desktop / Claude Code / Windsurf / Cursor to build n8n workflows for you · GitHub"
[3]: https://github.com/czlonkowski/n8n-mcp/blob/main/docs/N8N_DEPLOYMENT.md "n8n-mcp/docs/N8N_DEPLOYMENT.md at main · czlonkowski/n8n-mcp · GitHub"
[4]: https://github.com/EtienneLescot/n8n-as-code "GitHub - EtienneLescot/n8n-as-code: Give your AI agent n8n superpowers. 537 nodes with full schemas, 7,700+ templates, Git-like sync, and TypeScript workflows. · GitHub"
[5]: https://github.com/advisories/GHSA-6cqr-8cfr-67f8?utm_source=chatgpt.com "CVE-2026-25049 · GitHub Advisory Database - n8n"
[6]: https://nvd.nist.gov/vuln/detail/CVE-2025-68668?utm_source=chatgpt.com "CVE-2025-68668 Detail - NVD"
