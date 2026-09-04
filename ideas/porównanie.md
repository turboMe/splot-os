`langchain-ai/deepagents` to **otwarte repo + biblioteka Python + gotowy terminalowy agent CLI** od LangChain. Nie jest to tylko przykład promptu. To gotowy “agent harness”, czyli warstwa uruchomieniowa dla agenta, która daje mu planowanie, narzędzia plikowe, shell, subagentów, skille i zarządzanie kontekstem. Repo jest open source, MIT licensed, provider-agnostic i zbudowane na LangGraph. ([GitHub][1])

## Co to dokładnie jest

Najprościej:

```txt
DeepAgents = gotowy szkielet dla zaawansowanego agenta
LangChain = integracje z modelami i toolami
LangGraph = runtime / graf / state / streaming / checkpointing
DeepAgents CLI = terminalowy agent podobny koncepcyjnie do Claude Code
```

Według dokumentacji Deep Agents zawiera trzy główne części: **Deep Agents SDK**, czyli paczkę do budowania własnych agentów, **Deep Agents CLI**, czyli terminalowego coding-agenta, oraz **ACP integration**, czyli connector do używania takich agentów w edytorach typu Zed. ([LangChain Docs][2])

Czyli masz dwie drogi:

1. **Używać gotowego CLI** jako narzędzia developerskiego.
2. **Wziąć SDK** i wbudować jego mechanikę do własnego AgentForge/meta-agenta.

## Co już ma w środku

DeepAgents daje agentowi gotowe mechanizmy:

```txt
write_todos     - planowanie i śledzenie zadań
read_file       - czytanie plików
write_file      - tworzenie / nadpisywanie plików
edit_file       - edycja plików
ls              - listowanie katalogów
glob            - wyszukiwanie plików po wzorcu
grep            - wyszukiwanie tekstu
execute         - uruchamianie komend shell
task            - delegowanie pracy do subagentów
compact_conversation - kompresja kontekstu
web_search      - web search przez Tavily
fetch_url       - pobieranie stron jako markdown
ask_user        - pytanie użytkownika
```

CLI ma te narzędzia jako built-in, a operacje potencjalnie destrukcyjne, np. `write_file`, `edit_file`, `execute`, `web_search`, `fetch_url` i `task`, domyślnie wymagają approval/human-in-the-loop. W trybie non-interactive shell jest domyślnie wyłączony, chyba że jawnie ustawisz allowlistę komend. ([LangChain Docs][3])

To jest dokładnie typ rzeczy, którego potrzebujesz do lokalnego meta-agenta.

## Co może wnieść do Twojego AgentForge

### 1. Gotowy wzorzec planowania

Zamiast samemu pisać mechanikę:

```txt
user task -> rozbij na kroki -> wykonaj -> sprawdź -> popraw -> final
```

DeepAgents ma wbudowane `write_todos`. Agent może tworzyć listę zadań, aktualizować status i nie gubić się przy większych operacjach. Quickstart opisuje, że agent automatycznie planuje pracę przez `write_todos`, wykonuje research/tool calls, używa filesystemu do odkładania dużych wyników, odpala subagentów i syntetyzuje wynik. ([LangChain Docs][4])

Dla Ciebie to oznacza: mniej własnej orkiestracji od zera.

### 2. Subagenci bez ręcznego budowania całej architektury

DeepAgents ma narzędzie `task`, które pozwala delegować pracę do subagentów. Subagenci mają izolowany kontekst, więc główny meta-agent nie zapycha się wynikami z grepów, web searcha, logów, testów czy dużych plików. Dokumentacja opisuje to jako rozwiązanie problemu “context bloat” - subagent wykonuje brudną robotę, a główny agent dostaje tylko końcowy wynik. ([LangChain Docs][5])

Dla AgentForge to bardzo ważne. Możesz mieć np.:

```txt
Meta Agent
├── Coding Agent
├── Terminal Debug Agent
├── n8n Workflow Agent
├── MongoDB Agent
├── Marketing Agent
├── Research Agent
└── Critic / QA Agent
```

Każdy może mieć osobny prompt, osobne narzędzia i nawet inny model.

### 3. Skills jako standard `SKILL.md`

DeepAgents obsługuje Agent Skills. Skill to folder z `SKILL.md` i opcjonalnymi skryptami, dokumentacją, szablonami lub assetami. Agent na starcie czyta tylko frontmatter/metadata, a pełną treść skilla ładuje dopiero wtedy, gdy skill pasuje do zadania. Dokumentacja nazywa to “progressive disclosure”. ([LangChain Docs][6])

To pasuje idealnie do Twojego problemu z Gemma / lokalnymi modelami i “lost in the middle”.

Zamiast jednego ogromnego promptu:

```txt
meta-agent-system-prompt-40k-tokenów.txt
```

robisz:

```txt
skills/
├── terminal-safe-executor/
│   └── SKILL.md
├── ubuntu-diagnostics/
│   └── SKILL.md
├── git-workflow/
│   └── SKILL.md
├── docker-debugger/
│   └── SKILL.md
├── n8n-workflow-builder/
│   └── SKILL.md
├── mongodb-admin/
│   └── SKILL.md
├── llm-router/
│   └── SKILL.md
└── code-review-typescript/
    └── SKILL.md
```

Agent widzi krótki opis każdego skilla. Pełne instrukcje ładuje tylko wtedy, gdy trzeba.

### 4. Terminal i filesystem out of the box

Dla Twojego lokalnego Ubuntu to może dać agentowi bezpośrednie możliwości:

```txt
- czytaj strukturę projektu
- grep po plikach
- edytuj pliki
- uruchamiaj testy
- odpalaj pnpm build
- sprawdzaj logi
- wykonuj git diff
- diagnozuj docker-compose
- odpytuj lokalne API
```

Ale tu trzeba postawić granice. Nie dawałbym agentowi pełnego `execute` bez kontroli. Najlepiej:

```txt
allowed commands:
- git
- pnpm
- npm
- node
- python3
- pytest
- make
- docker ps
- docker logs
- docker compose logs
- curl
- cat
- ls
- grep
- find
```

A blokować:

```txt
rm -rf
sudo
chmod -R
chown -R
dd
mkfs
ssh private key access
cat .env
printenv
curl z tokenami
```

### 5. MCP jako warstwa rozszerzeń

DeepAgents CLI może ładować zewnętrzne narzędzia przez MCP. Wystarczy `.mcp.json` w projekcie albo `~/.deepagents/.mcp.json`. CLI wykrywa MCP-serwery przy starcie, uruchamia je, odkrywa ich narzędzia i udostępnia agentowi. ([LangChain Docs][7])

Dla Ciebie to oznacza, że AgentForge może mieć narzędzia typu:

```txt
filesystem MCP
github MCP
postgres/mongodb MCP
browser MCP
n8n MCP/custom API tool
docker MCP
local shell MCP
docs MCP
```

Czyli DeepAgents może być albo Twoim rdzeniem, albo wzorcem, jak zbudować własną warstwę tools.

## Czy to jest repo do pobrania?

Tak.

Masz repo:

```bash
git clone https://github.com/langchain-ai/deepagents.git
cd deepagents
```

Ale nie musisz klonować repo, żeby używać. Możesz zainstalować paczkę:

```bash
pip install deepagents
```

albo przez `uv`:

```bash
uv add deepagents
```

Oficjalny README pokazuje instalację przez `pip install deepagents` albo `uv add deepagents`, a potem użycie `create_deep_agent()`. ([GitHub][1])

## Jak z tego korzystać praktycznie

### Opcja A - używasz jako gotowy terminalowy agent

Instalacja CLI:

```bash
curl -LsSf https://langch.in/gh-da-cli | bash
```

Uruchomienie:

```bash
deepagents
```

Ustawienie kluczy:

```bash
mkdir -p ~/.deepagents
nano ~/.deepagents/.env
```

Przykład:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
TAVILY_API_KEY=...
```

CLI przechowuje konfigurację w `~/.deepagents/`, m.in. `config.toml`, `.env`, `hooks.json` i `.mcp.json`. Zmienna z prefixem `DEEPAGENTS_CLI_` może nadpisywać klucz tylko dla DeepAgents CLI, bez wpływania na inne narzędzia. ([LangChain Docs][8])

To jest dobre do testów i inspiracji.

### Opcja B - używasz SDK w swoim meta-agencie

Minimalny przykład:

```python
from deepagents import create_deep_agent

def run_n8n_workflow(workflow_name: str, payload: dict) -> str:
    """Run a local n8n workflow by name with a JSON payload."""
    # tutaj dajesz request do lokalnego n8n webhooka
    return "Workflow executed"

agent = create_deep_agent(
    model="openai:gpt-5.4",
    tools=[run_n8n_workflow],
    system_prompt="""
You are AgentForge Meta Agent.
Plan first. Use tools carefully.
Delegate specialized work to subagents.
Never expose secrets.
"""
)

result = agent.invoke({
    "messages": [
        {
            "role": "user",
            "content": "Build an n8n workflow for Telegram lead capture and save leads to MongoDB."
        }
    ]
})

print(result["messages"][-1].content)
```

W docs możesz przekazać model jako string `provider:model`, np. `openai:...`, `anthropic:...`, `google_genai:...`, `openrouter:...`, `fireworks:...`, `baseten:...`, `ollama:...`, albo przekazać własną instancję modelu LangChain. ([LangChain Docs][4])

### Opcja C - lokalny model przez Ollama

DeepAgents CLI obsługuje LangChain-compatible providers, a Ollama jest wymieniona jako provider przez `langchain-ollama`. CLI działa z modelami, które wspierają tool calling. ([LangChain Docs][9])

Instalacja z Ollama:

```bash
uv tool install deepagents-cli --with langchain-ollama
```

Uruchomienie z modelem Ollama:

```bash
deepagents --model ollama:qwen3:14b
```

albo:

```bash
deepagents --model ollama:devstral
```

Dla Twojego setupu lokalnego krytyczny warunek to **tool calling**. Jeżeli lokalny model słabo obsługuje tool calling, agent będzie robił głupoty: wybierze złe narzędzie, poda zły JSON, odpali zły command albo będzie halucynował wynik. Dlatego jako meta-agent lokalny sensowniejszy będzie model z mocnym instruction-following i function/tool calling niż po prostu największy model.

### Opcja D - projekt produkcyjny przez template

Jest też `langchain-ai/deep-agent-template`. Template daje gotowy deployable graph w `src/deep_agent/graph.py`, workflow prompt typu plan/delegate/critique/finalize, dwóch subagentów `researcher` i `critic`, human-in-the-loop na `execute` i `write_file`, lokalny workflow przez `uv`, `Makefile` i starter tests. ([GitHub][10])

To jest chyba najlepszy start, jeśli Twój dev ma z tego zrobić repo testowe.

## Jak bym to wykorzystał u Ciebie

Nie przepisywałbym od razu całego AgentForge na DeepAgents. Zrobiłbym **proof of concept**:

```txt
/projekty/agentforge-deepagents-poc
├── agent.py
├── skills/
│   ├── n8n-workflow-builder/
│   │   └── SKILL.md
│   ├── terminal-safe-executor/
│   │   └── SKILL.md
│   ├── mongodb-workflow/
│   │   └── SKILL.md
│   └── marketing-agent/
│       └── SKILL.md
├── .mcp.json
├── AGENTS.md
└── tests/
```

Pierwszy cel:

```txt
Meta-agent dostaje zadanie:
"Zbuduj n8n workflow: Telegram input -> LLM classifier -> MongoDB save -> reply to user."

Agent ma:
- zaplanować kroki
- wybrać skill n8n
- wygenerować JSON workflow
- sprawdzić strukturę
- zapisać plik
- opcjonalnie odpalić test walidacyjny
```

To pokaże, czy DeepAgents realnie nadaje się jako kręgosłup, czy tylko jako inspiracja.

## Gdzie to pasuje w Twojej architekturze

Ja widzę to tak:

```txt
User / Telegram / Dashboard
        |
        v
AgentForge Meta Agent
        |
        |-- DeepAgents-style planner
        |-- DeepAgents-style skills loader
        |-- DeepAgents-style subagent delegation
        |-- MCP tools
        |-- n8n workflow executor
        |-- local shell executor with allowlist
        |-- MongoDB memory/logs
        |
        v
Specialized agents
```

Czyli DeepAgents może dostarczyć Ci:

```txt
- wzorzec architektury
- gotowe CLI do testów
- SDK do implementacji
- standard skills
- subagent delegation
- context management
- filesystem backend
- LangGraph runtime
```

## Największa wartość dla Ciebie

Najważniejsze są cztery rzeczy:

### 1. Context management

Twoje prompty robią się duże. DeepAgents rozwiązuje to przez skills, memory, offloading, summarization i subagentów. Dokumentacja opisuje kilka warstw context engineeringu: system prompt, memory, skills, tool prompts, context compression, offloading, summarization i context isolation przez subagentów. ([LangChain Docs][11])

### 2. Subtaski i subagenci

To jest gotowy pattern dla meta-agenta. Nie musisz wymyślać wszystkiego od zera.

### 3. Terminal agent

Masz Ubuntu, lokalne n8n, MongoDB, Ollama, Redis, dashboard. DeepAgents CLI pokazuje, jak agent może działać jako terminalowy operator z approval controls. ([LangChain Docs][3])

### 4. Skills

To może być Twoja baza wiedzy dla lokalnego modelu. Zamiast karmić Gemmę ogromnym promptem, dajesz jej krótkie skill descriptions i ładujesz szczegóły tylko wtedy, gdy potrzeba.

## Ograniczenia i ryzyka

Bez lukru:

1. **To nie zrobi magicznie dobrego agenta z przeciętnego modelu.** Model musi dobrze obsługiwać tool calling, długie instrukcje i korektę błędów.

2. **Lokalne modele mogą być słabsze jako orchestrator.** Gemma/Qwen lokalnie mogą być dobre do konkretnych zadań, ale meta-agent z terminalem wymaga bardzo stabilnego rozumowania.

3. **Shell access to ryzyko.** Trzeba robić allowlistę, sandbox, approval, logging i blokadę sekretów.

4. **LangGraph/LangChain to dodatkowa warstwa złożoności.** Daje mocne możliwości, ale też uzależnia część systemu od ich abstrakcji.

5. **Nie podłączać od razu do produkcyjnego GastroBridge.** Najpierw osobny sandbox repo i testowe katalogi.

## Moja rekomendacja

Dla Ciebie najlepsza ścieżka:

```txt
Etap 1:
Zainstaluj DeepAgents CLI i potestuj ręcznie na małym repo.

Etap 2:
Stwórz 3 własne skille:
- n8n-workflow-builder
- terminal-safe-executor
- mongodb-automation-patterns

Etap 3:
Zbuduj Python POC przez create_deep_agent().

Etap 4:
Podłącz lokalne MCP / n8n / MongoDB.

Etap 5:
Dopiero potem decyduj, czy DeepAgents staje się rdzeniem AgentForge, czy tylko inspiracją architektoniczną.
```

Najkrótszy test na Ubuntu:

```bash
mkdir -p /projekty/agentforge-deepagents-poc
cd /projekty/agentforge-deepagents-poc

curl -LsSf https://langch.in/gh-da-cli | bash

mkdir -p ~/.deepagents
nano ~/.deepagents/.env
```

Do `.env`:

```env
OPENAI_API_KEY=twoj_klucz
GOOGLE_API_KEY=twoj_klucz
TAVILY_API_KEY=twoj_klucz
```

Start:

```bash
deepagents
```

Potem test:

```txt
Create a safe n8n workflow specification for a Telegram bot that receives a message, classifies it with an LLM, saves it to MongoDB, and replies to the user. Do not execute shell commands. Write the result to workflow-spec.md.
```

Jeżeli to przejdzie dobrze, warto iść dalej w SDK. Jeżeli CLI będzie chaotyczne, nadal warto skopiować z DeepAgents same idee: `SKILL.md`, subagenci, planning, filesystem-state, approval gate i MCP.

[1]: https://github.com/langchain-ai/deepagents "GitHub - langchain-ai/deepagents: Agent harness built with LangChain and LangGraph. Equipped with a planning tool, a filesystem backend, and the ability to spawn subagents - well-equipped to handle complex agentic tasks. · GitHub"
[2]: https://docs.langchain.com/oss/python/deepagents/overview "Deep Agents overview - Docs by LangChain"
[3]: https://docs.langchain.com/oss/python/deepagents/cli/overview "Deep Agents CLI - Docs by LangChain"
[4]: https://docs.langchain.com/oss/python/deepagents/quickstart "Quickstart - Docs by LangChain"
[5]: https://docs.langchain.com/oss/python/deepagents/subagents "Subagents - Docs by LangChain"
[6]: https://docs.langchain.com/oss/python/deepagents/skills "Skills - Docs by LangChain"
[7]: https://docs.langchain.com/oss/python/deepagents/cli/mcp-tools "MCP tools - Docs by LangChain"
[8]: https://docs.langchain.com/oss/python/deepagents/cli/configuration "Configuration - Docs by LangChain"
[9]: https://docs.langchain.com/oss/python/deepagents/cli/providers "Model providers - Docs by LangChain"
[10]: https://github.com/langchain-ai/deep-agent-template/blob/main/README.md "deep-agent-template/README.md at main · langchain-ai/deep-agent-template · GitHub"
[11]: https://docs.langchain.com/oss/python/deepagents/context-engineering "Context engineering in Deep Agents - Docs by LangChain"
