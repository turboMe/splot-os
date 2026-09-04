# Migracja z BullMQ do Mastra Workflows

W starszej wersji systemu "Jarvis", zadania wymagające długotrwałego procesu lub integracji wielu agentów (takie jak np. `weekly-content` lub `producer-hunt`) opierały się na systemie kolejek **BullMQ** obsługiwanym przez serwer Redis.

Choć rozwiązanie to działało w mniejszych skalach, brakowało mu natywnej weryfikacji stanów pomiędzy krokami, a pauzowanie zadania (aby poczekać na interakcję człowieka) wymagało pisania dużej ilości własnego kodu (zapisywanie stanu do bazy danych, wznawianie handlera po webhooku itd.).

Mastra w pełni zastępuje ten mechanizm własnym rozwiązaniem `Mastra Workflows`.

## Główne różnice i zalety

| Funkcja | Stare podejście (BullMQ + Jarvis) | Nowe podejście (Mastra Workflows) |
| --- | --- | --- |
| **Definiowanie procesu** | Obiekty JSON odkładane w Redis. | Struktura **DAG** (Graf skierowany), jasno zdefiniowane obiekty `Step`. |
| **Stan pośredni** | Kod musiał ręcznie ładować stan z bazy Mongo / Redisa przy każdym powrocie. | **State Management**: Zmienne kontekstowe (`context`) przechodzą przez kroki z wbudowaną pauzą/wznowieniem. |
| **Human-in-the-Loop** | Osobny skrypt przerywający i oczekujący na ping API. | Natywne kroki z zawieszeniem. Pozwalają wstrzymać Workflow do momentu zatwierdzenia przez pracownika w UI. |
| **Error Handling** | Wymagało konfigurowania retries w opcjach kolejki BullMQ. | Obsługiwane bezpośrednio poprzez warunki i rozgałęzienia Workflow. |

## Przykład: Weekly Content Workflow
Stworzyliśmy plik `src/mastra/workflows/weekly-content.ts`, który definiuje 3 powiązane kroki procesu, który dawniej żył na BullMQ:
1. `fetch-news` – Pobieranie surowych nowości ze źródeł (np. RSS/RAG).
2. `generate-digest` – Przekazanie zgromadzonych artykułów do `marketingAgent`, który asynchronicznie odpytuje LLM o ich podsumowanie w tonie branżowym.
3. `save-draft` – Umieszczenie gotowego materiału jako draft w CRM/Gmailu.

```typescript
weeklyContentWorkflow
  .step(fetchNewsStep)
  .then(generateDigestStep)
  .then(saveDraftStep);

weeklyContentWorkflow.commit();
```

To wystarczy, aby system zrozumiał, w jakiej kolejności odpalać poszczególne akcje i cofnąć proces w razie wystąpienia błędu. Meta Agent może teraz odpalić takie Workflow wywołując polecenie `weeklyContentWorkflow.execute()`, zamiast odkładać event `suggestedJobs` do Redisa.
