# Plan Implementacji: Etap 4 – Shared Working Memory (Współdzielona Pamięć Operacyjna)

## 1. Cel Etapu
Stworzenie mechanizmu "układu nerwowego" systemu, który umożliwi agentom (Meta, Marketing, Sales, Analytics) nie tylko dostęp do statycznej bazy wiedzy, ale także do dynamicznego, międzyagentowego kontekstu operacyjnego. Dzięki temu system przestanie być zbiorem izolowanych narzędzi, a stanie się spójnym organizmem.

---

## 2. Koncepcja "Shared Working Memory" w Jarvis Dashboard

### A. Sygnały Operacyjne (Signals)
Krótkie, ważne komunikaty o wysokim priorytecie generowane przez jeden agent, które powinny wpłynąć na zachowanie innych.
*   **Przykład**: `AnalyticsAgent` wykrywa spadek konwersji w regionie Śląsk -> generuje sygnał `LOW_CONVERSION_REGION`. `MarketingAgent` przy kolejnym uruchomieniu widzi ten sygnał i automatycznie priorytetyzuje kampanie dla tego regionu.

### B. Współdzielony Schowek (Shared Context Store)
Zbiór "aktywnych faktów", które nie są jeszcze trwałą wiedzą (learning), ale są istotne w bieżącym oknie czasowym (np. ostatnie 24h).
*   **Przykład**: `SalesAgent` właśnie odbył rozmowę z kluczowym klientem. Zapisuje notatkę w Shared Memory: "Klient X jest zainteresowany tylko produktem Y". `MetaAgent` przy zapytaniu użytkownika o klienta X od razu widzi tę notatkę, zanim jeszcze zostanie ona "przetrawiona" do wektorowej pamięci długotrwałej.

### C. Handover Pipeline (Przekazywanie Zadań)
Możliwość bezpośredniego delegowania kontekstu między agentami.
*   **Przykład**: `MarketingAgent` kończy proces `ProducerHunt`. Zamiast tylko zakończyć zadanie, przesyła do Shared Memory: "Znaleziono 5 hot leadów". `SalesAgent` widzi to i automatycznie sugeruje użytkownikowi przygotowanie propozycji.

---

## 3. Architektura Techniczna

Zamiast dodawać Redis (dodatkowa infrastruktura), wykorzystamy istniejący MongoDB z kolekcją `shared_context` oraz mechanizm `EventEmitter` (lub MongoDB Change Streams) dla powiadomień w czasie rzeczywistym.

### Nowe Kolekcje w DB:
1.  **`shared_memory`**: Przechowuje krótkotrwałe wpisy (TTL: 48h).
    *   `id`, `sourceAgentId`, `targetAgentId` (opcjonalnie), `type` (signal/note/alert), `content`, `expiresAt`.
2.  **`signals`**: Stanowe flagi systemowe.

---

## 4. Lista Plików i Zmian

### A. Core System
1.  **`apps/workers/src/core/shared-memory.ts` [NOWY]**:
    *   Klasa `SharedMemoryService`.
    *   Metody: `pushSignal(agentId, type, data)`, `getLatestSignals()`, `addContext(key, value, ttl)`.
2.  **`apps/workers/src/core/base-agent.ts`**:
    *   Dodanie metody `getSharedMemory(): Promise<SharedMemoryService>`.
    *   Automatyczne wstrzykiwanie "Najnowszych Sygnałów" do kontekstu każdego agenta przed uruchomieniem `run()`.
3.  **`packages/shared/src/types.ts`**:
    *   Definicje typów dla `SharedContextItem` i `SystemSignal`.

### B. Integracja z Agentami
1.  **`AnalyticsAgent` (`apps/workers/src/agents/analytics-agent/index.ts`)**:
    *   Po analizie danych, jeśli wykryje anomalie, wywołuje `sharedMemory.pushSignal('ANOMALY_DETECTED', { ... })`.
2.  **`MarketingAgent` (`apps/workers/src/agents/marketing-agent/index.ts`)**:
    *   W metodzie `morningBriefing` sprawdza sygnały z `AnalyticsAgent`, aby dostosować rekomendacje.
3.  **`SalesAgent` (`apps/workers/src/agents/sales-agent/index.ts`)**:
    *   Zapisuje "Hot Context" po każdej interakcji, aby Meta Agent miał świeże dane bez czekania na re-indeksację wektorową.
4.  **`MetaAgent` (`apps/workers/src/agents/meta-agent/index.ts`)**:
    *   W pętli ReAct otrzymuje dodatkowy blok systemowy: `### CURRENT SYSTEM SIGNALS ###`.

### C. Dashboard
1.  **`apps/dashboard/src/components/IntelligenceFeed.tsx`**:
    *   Wyświetlanie aktywnych sygnałów systemowych na górze feedu (jako "Live Insights").

---

## 5. Przykładowy Przepływ (Workflow)

1.  **08:00**: `AnalyticsAgent` (CRON) analizuje CRM i zauważa, że 10 leadów "zainteresowanych" nie miało kontaktu od 3 dni.
2.  **08:01**: `AnalyticsAgent` zapisuje sygnał `LEADS_STAGNATION` w Shared Memory.
3.  **09:00**: Użytkownik otwiera Dashboard. `MorningBriefing` (uruchomiony przez `MarketingAgent`) widzi sygnał `LEADS_STAGNATION`.
4.  **09:05**: W briefingu pojawia się punkt: "⚠️ Analytics wykrył stagnację 10 leadów. Przygotowałem dla nich automatyczne follow-upy do Twojej akceptacji".
5.  **09:10**: `MetaAgent` wie o tym sygnale i gdy użytkownik zapyta "Co słychać?", odpowiada: "Mamy stagnację u 10 leadów, ale Marketing już nad tym pracuje".

---

## 6. Harmonogram Prac (Mini-Etapy)

1.  **4.1**: Implementacja `SharedMemoryService` i kolekcji w MongoDB.
2.  **4.2**: Rozszerzenie `BaseAgent` o automatyczne pobieranie sygnałów.
3.  **4.3**: Implementacja generatorów sygnałów w `AnalyticsAgent`.
4.  **4.4**: Implementacja konsumentów sygnałów w `MarketingAgent` i `MetaAgent`.
5.  **4.5**: Wizualizacja sygnałów w Dashboardzie.
