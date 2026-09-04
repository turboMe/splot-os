# Plan Wdrożenia Strumieniowania SSE, Reaktywnego Akordeonu Live oraz Zagnieżdżonych Delegacji dla Czat Panelu Splot OS (`/splot`)

**Data utworzenia:** 2026-08-28  
**Autor:** Antigravity Architect  
**Dotyczy:** Interfejs czatu i orkiestracji Splot OS (`http://localhost:4111/splot`), backend `splot-router.ts`, frontend `app.js` i `turn-controller.js`, izolacja wątków w MongoDB.

---

## 1. Diagnoza Architektoniczna i Stan Obecny

### 1.1. Problem 1: Pozorne zamrożenie UI podczas pracy agentów
Podczas zlecania zadań (szczególnie złożonych zapytań do `metaAgent` wymagających dekompozycji i delegacji do agentów domenowych takich jak `codingAgent`, `researcherAgent`, `designAgent`), interfejs `/splot` sprawia wrażenie całkowicie zamrożonego:
- Nagłówek akordeonu wyświetla statyczne `Wykonywanie procesu... 0 kroków 0.0s`.
- Oś czasu procesu (`step-timeline`) jest pusta przez cały czas trwania pętli agentów (15s – 120s+).
- W panelu logów i terminalu serwera widać intensywny ruch (uruchamianie podzadań, badanie repozytorium, pętle decyzyjne), jednak do przeglądarki nie docierają żadne informacje.
- Po zakończeniu całości pracy backend odsyła pojedynczy duży JSON, a frontend w jednej milisekundzie wrzuca wszystkie kroki i natychmiast zwija akordeon, uniemożliwiając obserwację przebiegu procesu na żywo.

### 1.2. Problem 2: Zaśmiecanie paska bocznego wewnętrznymi wątkami subagentów
Po odświeżeniu strony `/splot` na liście wszystkich wątków rozmów pojawia się wiele zduplikowanych lub technicznych wpisów (np. `Cyber-Neural Mindsc...`, `Nowy wątek`, `Generowanie interak...`):
- `delegate-task.ts` tworzy dla każdego oddelegowanego zadania odizolowany `delegationThreadId` (`delegation-UUID` lub `orch-v2-job:...`), aby subagent nie zaśmiecał pamięci głównej rozmowy.
- Silnik pamięci Mastra (`om`) automatycznie zapisuje te podwątki do kolekcji `mastra_threads` w MongoDB i generuje dla nich tytuły.
- Endpoint `GET /splot/api/threads` w `splot-router.ts` pobiera **wszystkie** dokumenty z `mastra_threads` bez filtrowania, przez co podwątki maszynowe mieszają się z prawdziwymi wątkami czatu użytkownika.

---

## 2. Architektura Docelowa (Live Event Streaming + Hierarchical Progressive Disclosure)

```
[Przeglądarka /splot]                                 [Backend Mastra /splot/api/chat]
        │                                                              │
        ├── 1. POST /splot/api/chat (Accept: text/event-stream) ──────►│
        │      (turn = new AgentTurnController)                        │
        │      [TIMER STARTUJE OD RAZU: 0.1s -> 0.4s -> 1.2s...]       ├── 2. Inicjalizacja wątku i subskrypcji zdarzeń
        │                                                              │      │
        │◄── event: init (turnId, threadId, agentId) ──────────────────┤      │
        │                                                              │      ├── 3. Pętla wykonawcza agenta (Harness / ReAct)
        │◄── event: thought (Plan i analiza intencji) ─────────────────┤      │   ├── Model generuje plan myślowy
        │    [W akordeonie natychmiast pojawia się bloczek Planu]      │      │
        │                                                              │      ├── 4. Agent wywołuje system_delegate_task
        │◄── event: delegation (target: codingAgent, brief: "...") ────┤      │   │
        │    [W akordeonie pojawia się zagnieżdżona karta subagenta]   │      │   │
        │◄── event: subagent_step (codingAgent -> search_content) ─────┤      │   ├── Subagent wykonuje operacje w tle
        │    [Krok ląduje w zagnieżdżonym pod-akordeonie codingAgent]  │      │   │   (nie tworzy nowego wątku w sidebarze!)
        │◄── event: subagent_done (codingAgent -> summary) ────────────┤      │   │
        │    [Karta codingAgent zwija się do: ✓ 3 operacje (2.4s)]     │      │   └── Subagent zwraca wynik do metaAgent
        │                                                              │      │
        │◄── event: chunk (kolejne tokeny syntezy odpowiedzi) ─────────┤      ├── 5. Synteza i odpowiedź końcowa
        │◄── event: finish (finalText, finishReason, totalMs) ─────────┤      └── Zakończenie całego turnu
        │    [Akordeon przechodzi w stan "Wykonano proces (8.4s)"]     │
        └──────────────────────────────────────────────────────────────┘
```

---

## 3. Szczegółowy Zakres Implementacji

### Moduł A: Backend – Strumieniowanie Server-Sent Events (`splot-router.ts`)

1. **Wsparcie SSE w handlerze `handleSplotChat`:**
   - Detekcja nagłówka `Accept: text/event-stream` lub parametru zapytania `?stream=true`.
   - Jeśli klient żąda strumienia:
     - Ustawienie nagłówków HTTP:
       ```http
       Content-Type: text/event-stream; charset=utf-8
       Cache-Control: no-cache
       Connection: keep-alive
       X-Accel-Buffering: no
       ```
     - Utworzenie strumienia `ReadableStream` / `TransformStream` ze zdarzeniami:
       `event: <nazwa_zdarzenia>\ndata: <json_string>\n\n`.
   - Zachowanie trybu tradycyjnego JSON dla zapytań bez nagłówka SSE (100% wstecznej kompatybilności).

2. **Podpięcie hooków telemetrycznych i zdarzeń agenta:**
   - Podpięcie do `onStepObservation` / `onStepFinish` w `generateWithHarness` / Mastra agent options.
   - Emisja ustrukturyzowanych zdarzeń:
     - `init`: id wątku, id tury, agent wyjściowy.
     - `thought`: wstępna analiza intencji i plan działania.
     - `delegation`: wykrycie wywołania `system_delegate_task` lub `system_run_worker` z nazwą agenta docelowego i celem zlecenia.
     - `subagent_step`: poszczególne operacje narzędziowe subagenta (np. `lsp_inspect`, `find_files`).
     - `subagent_done`: zakończenie pracy subagenta z podsumowaniem i czasem trwania.
     - `tool_start` / `tool_end`: bezpośrednie narzędzia agenta głównego.
     - `chunk` / `text_delta`: przyrostowe fragmenty tekstu odpowiedzi.
     - `finish`: ostateczny obiekt odpowiedzi, całkowity czas, statystyki.

---

### Moduł B: Backend – Filtrowanie Wątków Paska Bocznego (`splot-router.ts`)

1. **Czysta lista wątków w `handleListThreads`:**
   - Zapytanie do `mastra_threads` zostaje wzbogacone o filtr wykluczający identyfikatory techniczne:
     ```typescript
     query.id = { 
       $not: /^delegation-|^async-delegation-|^orch-v2-|^subtask-|^scheduled-task-/ 
     };
     ```
   - Pasek boczny prezentuje **wyłącznie rzeczywiste wątki konwersacji użytkownika** (`thread_...`).
   - Wewnętrzne zadania subagentów są bezpiecznie odizolowane w pamięci i powiązane z nadrzędnym krokiem tury w czacie głównym.

---

### Moduł C: Frontend – Kontroler Tury i Zagnieżdżone Delegacje (`turn-controller.js`)

1. **Aktywny Licznik Czasu (Live Ticker):**
   - W konstruktorze `AgentTurnController` startuje interwał `setInterval` (co 100ms), który aktualizuje `.elapsed-time` w nagłówku akordeonu (`0.1s`, `0.2s`, `1.5s`, `14.2s`...).
   - W `finishTurn()`: zatrzymanie interwału (`clearInterval`) i utrwalenie ostatecznego czasu trwania.

2. **Zagnieżdżone Karty Delegacji (Nested Sub-Accordions):**
   - Dodanie metody `addDelegationBlock(delegationId, targetAgent, brief)`:
     - Tworzy estetyczną kartę podagenta wewnątrz osi czasu:
       ```html
       <div class="delegation-card status-running" id="del-${delegationId}">
         <div class="del-header">
           <span class="del-badge">🤖 ${targetAgent}</span>
           <span class="del-brief">${brief}</span>
           <span class="del-status">w toku...</span>
         </div>
         <div class="del-nested-collapse">
           <div class="del-nested-timeline" id="del-timeline-${delegationId}"></div>
         </div>
       </div>
       ```
     - Domyślnie karta jest kompaktowa; użytkownik może jednym kliknięciem rozwinąć listę szczegółowych operacji subagenta.
   - Dodanie metody `addSubagentStep(delegationId, stepData)`:
     - Wstrzykuje operacje narzędziowe subagenta bezpośrednio do `del-timeline-${delegationId}`.
   - Dodanie metody `completeDelegation(delegationId, { summary, durationMs, status })`:
     - Przełącza status karty na `✓ Zakończono (durationMs)`, aktualizując liczbę operacji w nagłówku.

---

### Moduł D: Frontend – Czytnik Strumienia SSE w Czat Panelu (`app.js`)

1. **Zastąpienie blokującego `fetch().json()` czytnikiem SSE:**
   - W `executeRealAgentTurn`:
     ```javascript
     const response = await fetch('/splot/api/chat', {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'Accept': 'text/event-stream'
       },
       body: JSON.stringify({ agentId, threadId, message, resourceId })
     });
     ```
   - Czytanie chunków za pomocą `response.body.getReader()` i `TextDecoder`.
   - Reaktywne mapowanie zdarzeń na metody `turn` (`addThoughtStep`, `addDelegationBlock`, `addSubagentStep`, `completeDelegation`, `finishTurn`).

---

## 4. Plan Bezpieczeństwa i Wstecznej Kompatybilności

1. **Brak ingerencji w trwające zadania:**
   - Wdrożenie nastąpi wyłącznie w stanie spoczynku agentów.
2. **Dual-Mode na Backendzie:**
   - Jeśli klient HTTP wyśle zapytanie bez nagłówka SSE, serwer odpowie tradycyjnym JSON-em (bezpieczeństwo istniejących testów integracyjnych).
3. **Graceful Fallback:**
   - W razie przerwania strumienia sieciowego frontend pobiera stan wątku przez `GET /splot/api/threads/:id/messages`.

---

## 5. Plan Weryfikacji i Testów

### 5.1. Testy Automatyczne
1. **Skrypt weryfikacyjny SSE (`src/mastra/scripts/check-splot-streaming.ts`):**
   - Testuje poprawność strumienia `text/event-stream`, czasy nadejścia pierwszego tokenu (< 1.5s) oraz sekwencję zdarzeń delegacji.
2. **Test filtrów wątków (`src/mastra/scripts/check-splot-thread-filtering.ts`):**
   - Sprawdza, czy `GET /splot/api/threads` zwraca wyłącznie wątki `thread_...` i nie zawiera identyfikatorów `delegation-...` ani `orch-v2-...`.

### 5.2. Test Manualny w Przeglądarce
1. Otwarcie `http://localhost:4111/splot`.
2. Wysłanie zapytania z delegacją do `codingAgent`.
3. Obserwacja:
   - Natychmiastowy start tykającego czasu w nagłówku.
   - Pojawienie się karty delegacji `codingAgent` z zagnieżdżonymi krokami na żywo.
   - Czysty pasek boczny po odświeżeniu strony (brak zdublowanych podwątków).

---

## 6. Kolejność Wdrażania (Kroki Commit-Sized)

1. **Krok 1:** Filtrowanie wątków technicznych w `splot-router.ts` (`handleListThreads`).
2. **Krok 2:** Implementacja live tickera czasu oraz zagnieżdżonych kart delegacji w `turn-controller.js` i stylach CSS.
3. **Krok 3:** Dodanie obsługi strumienia SSE z emisją zdarzeń delegacji i subagentów w `splot-router.ts`.
4. **Krok 4:** Implementacja czytnika strumienia SSE w `app.js` (`executeRealAgentTurn`).
5. **Krok 5:** Testy automatyczne (`check-splot-streaming.ts`) i manualna weryfikacja na UI.
