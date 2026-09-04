# Mastra Migration Plan: Jarvis Meta Agent -> Mastra

Ten dokument opisuje proces przenoszenia systemu AgentForge / Jarvis do natywnego środowiska Mastra. Rezygnujemy z własnej implementacji pętli ReAct, kolejkowania BullMQ dla poszczególnych akcji (na rzecz Mastra Workflows) oraz własnych menedżerów pamięci.

## Krok 1: Inicjalizacja Mastra i Połączenie z Bazą Danych (✓ Zakończono)

**Cel:** Podpięcie MongoDB jako domyślnego magazynu danych (`Storage`) dla pamięci, telemetrii i historii. Konfiguracja "pustego" Głównego Agenta (Meta Agenta).

**Co zostało zrobione:**
- Zainstalowano pakiet `@mastra/mongodb`.
- Zmodyfikowano `src/mastra/index.ts`, dodając obiekt `metaAgent`.
- Zmodyfikowano storage na `MastraMongoDBStore` korzystający z klucza `MONGODB_URI` definiowanego w `.env`.

**Korzyści:**
- Od teraz wszystkie wywołania LLM, pamięć robocza (Working Memory) oraz historia czatów będą automatycznie zapisywane przez Mastra do bazy danych, bez potrzeby utrzymywania pliku `shared-memory.ts` czy wpisów telemetrii w `base-agent.ts`.

---

## Krok 2: Transformacja Narzędzi i Integracja MCP

**Cel:** Migracja skilli z domeny do standardowych narzędzi Mastra (`createTool()`) oraz podłączenie serwerów MCP.

**Plan działania:**
1. **Domenowe Narzędzia CRM:** Utworzyć pliki w `src/mastra/tools/crm/` (np. `queryLeads.ts`, `upsertLead.ts`).
2. **Standard Zod:** Zdefiniować wejście i wyjście narzędzi używając `z.object({...})` zgodnie z nowym standardem Mastra.
3. **Integracja MCP NotebookLM:** Dodać `mastra.getMCPServer()` dla już istniejącego w `jarvis` MCP NotebookLM. Zamiast budować RAG od zera, wykorzystamy RAG Tool Search Processors Mastry, który sam zadba o doczytanie narzędzi, kiedy użytkownik zapyta o wiedzę z dokumentów.

---

## Krok 3: Odtworzenie Subagentów (Marketing, Sales, Analytics)

**Cel:** Rejestracja mniejszych, wysoce wyspecjalizowanych agentów w ekosystemie Mastra.

**Plan działania:**
- Założenie `src/mastra/agents/marketing-agent.ts`, `sales-agent.ts` i `analytics-agent.ts`.
- Wyposażenie ich w narzędzia specyficzne dla ich zakresu działania (np. narzędzia Gmaila tylko dla Marketera i Sprzedawcy).
- Skonfigurowanie przypisanych promptów instruktażowych (na podstawie poprzednich promptów w Jarvis).

---

## Krok 4: Skonfigurowanie Meta Agenta jako "Supervisor Agent"

**Cel:** Sprawienie, że Meta Agent będzie inteligentnie delegował polecenia (dawniej poprzez wrzucanie `suggestedJobs` na BullMQ) bezpośrednio do mniejszych agentów i Workflows wewnątrz Mastra.

**Plan działania:**
- Wykorzystanie natywnych funkcji Supervisor w Mastra (np. udostępnienie narzędzi do wywoływania workflowów lub sieci agentów).
- Skonfigurowanie `ToolSearchProcessor` dla zapytań wymagających RAG lub niszowych funkcji. Będzie on dołączał narzędzia tylko gdy intencja użytkownika tego wymaga.

---

## Krok 5: Zamiana BullMQ na Mastra Workflows

**Cel:** Migracja długo działających zadań w tle (jak `weekly-content` czy `producer-hunt`) na `Mastra Workflow`.

**Plan działania:**
- Zbudowanie struktur DAG (Directed Acyclic Graph) poprzez klasy `Workflow` ze stepami `step()`, `.then()`, `.parallel()`.
- Aktywowanie funkcji logowania błędów, pauzowania dla asynchronicznego zatwierdzania ("Approval Mode") oraz Time-Travel, pozwalającego na odtworzenie stanu Workflow bez bazy danych ręcznie modyfikowanej przez kod.

## Architektura Końcowa

* **UI (Next.js Dashboard):** Wywołuje API Mastra (np. `/api/mastra/agents/metaAgent/generate`).
* **Meta Agent (Supervisor):** Akceptuje wejście. Posiada historię. Decyduje, jakie mniejsze agenty (lub narzędzia RAG) aktywować.
* **Mastra Workflows:** Sterują procesami `weekly-content`, `morning-briefing`. Wznawiane, bezpieczne, widoczne w Mastra Studio.
* **Mastra Memory & Storage:** Pełna przejrzystość na poziomie bazy danych w MongoDB - żadnego ukrytego logowania błędów w konsoli, pełna telemetria w Mastra.
