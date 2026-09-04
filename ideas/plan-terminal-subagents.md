# Plan Architektoniczny: TerminalWorkerAgent & System Skilli (Multi-Agent Orchestration)

Celem jest odciążenie wielkiego (i drogiego) Meta Agenta poprzez wdrożenie tańszego, wyspecjalizowanego "Robotnika" (Subagenta), który potrafi operować w terminalu w pętli. Meta Agent będzie zlecał zadanie (podając instrukcję z biblioteki Skilli), a Robotnik będzie iteracyjnie walczył z terminalem, dopóki zadanie nie zakończy się sukcesem.

---

## FAZA 1: TerminalWorkerAgent (Zminiaturyzowana Pętla ReAct)

Małe modele (np. 8B) źle znoszą ogromne prompty z dziesiątkami narzędzi CRM i wiedzy. Musimy zbudować dla nich odizolowane środowisko.

1. **Nowa klasa Agenta:** Tworzymy `apps/workers/src/agents/terminal-worker/`.
2. **Narzędzia (Tylko 4!):**
   - `shell.execute` (wykonywanie komend)
   - `fs.read_file` (czytanie)
   - `fs.write_file` (zapis)
   - `system.complete_task` (nowe narzędzie: zgłoszenie sukcesu do Meta Agenta wraz z raportem).
3. **Pętla (Terminal ReAct):**
   - Agresywny system prompt: *"Jesteś maszyną CLI. Wykonujesz komendę, analizujesz STDOUT/STDERR. Jeśli jest błąd – poprawiasz komendę. Pracujesz dopóki nie zrealizujesz GOAL. Jeśli po 10 próbach nie możesz przejść dalej, zwracasz raport o niepowodzeniu."*
   - Pętla działa w pełni bez ingerencji człowieka (chyba że polecenie uderza w zablokowaną komendę Bash - wtedy blokada i error).

---

## FAZA 2: Repozytoria Skilli Terminalowych (Wiedza dla modeli)

Zamiast programować skomplikowane skrypty, "wgrywamy" umiejętności do modelu podając mu pliki Markdown z procedurami najlepszych inżynierów.

### Skąd bierzemy wiedzę (Idealne repozytoria Open-Source):
1. **[SWE-agent (Princeton-NLP)](https://github.com/princeton-nlp/SWE-agent)**
   - Mają absolutnie najlepsze na świecie prompty do tzw. *File Navigation* i naprawiania kodu w izolacji. Skopiujemy od nich systemy nawigacyjne (np. jak radzić sobie ze zbyt dużym plikiem – poprzez komendy wyszukiwania).
2. **[Aider (Paul Gauthier)](https://github.com/paul-gauthier/aider)**
   - Repozytorium Aidera to kopalnia wiedzy o tym, jak poinstruować mały model, aby skutecznie modyfikował pliki za pomocą Basha i bloków tekstu bez niszczenia syntaktyki.
3. **[OpenHands / OpenDevin](https://github.com/All-Hands-AI/OpenHands)**
   - Genialne procedury w formacie Markdown (tzw. "AgentHub prompts") dotyczące takich rutyn jak: *"Jak naprawić konflikt w Gicie"*, *"Jak analizować logi Dockera"*.

### Jak to podpinamy?
- Tworzymy w Twoim projekcie folder `docs/skills/terminal/`.
- Każdy Skill to plik Markdown, np. `git-conflict.md` (z instrukcją: *"1. git status, 2. fs.read_file konfliktowych plików, 3. znajdź znacznik <<<<<<<, 4. zastąp poprawnym kodem, 5. git add"*).
- Podpinamy ten folder pod `ToolRAGService`. 

---

## FAZA 3: Integracja z Meta Agentem (Most Orkiestracji)

1. **Narzędzie `subtask.delegate_loop`**
   - Meta Agent wywołuje to nowe narzędzie podając argumenty:
     `{ skill_id: "git-conflict", target_goal: "Napraw konflikt w pliku App.tsx" }`
2. **Uruchomienie Workera**
   - System (kod Node.js) znajduje wskazany Skill, łączy go z Celem (target_goal) i tworzy dedykowany prompt dla małego modelu (TerminalWorkerAgent).
   - Backend asynchronicznie odpala pętlę Terminal ReAct.
3. **Sen Meta Agenta**
   - Meta Agent wstrzymuje swoją główną pętlę i czeka na odpowiedź w tle, nie zużywając drogich tokenów. Gdy Worker wywoła `system.complete_task`, Meta Agent budzi się, czyta raport końcowy i podsumowuje pracę na głównym ekranie UI.

---

## FAZA 4: Telemetria i Streamowanie SSE (User Experience)

Kiedy sub-agent zaczyna swoją walkę z błędami w terminalu, Ty chcesz to widzieć!
1. W kodzie `shell.execute` zmieniamy `exec` na `spawn(cmd, { shell: true })`.
2. Do strumienia podpinamy `publishEvent({ type: 'meta:terminal_stream', data: chunk })`.
3. Na Dashboardzie w Next.js instalujemy bibliotekę `xterm.js` lub budujemy prosty `<TerminalWindow>`. Wszystko co Worker robi w terminalu, będzie renderować się "na żywo" jako zielony tekst na czarnym tle.

---
**Podsumowanie kosztów i efektywności:** 
Dzięki takiemu rozłożeniu ról, Twój główny model (np. Anthropic Claude 3.5) kosztujący $$ zastanawia się tylko "co trzeba zrobić" (2 kroki), a tania lokalna instancja (np. Gemma 4B za grosze/darmo) wykonuje 15 iteracji w terminalu "metodą prób i błędów", aż zadanie zostanie zrealizowane. 
