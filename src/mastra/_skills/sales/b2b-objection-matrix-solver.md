---
name: b2b-objection-matrix-solver
category: sales
description: >-
  Inteligentna obsługa obiekcji handlowych B2B i dopasowanie kontrargumentacji wartości/ROI.
  Analizuje treść wiadomości lub wątpliwości klienta (cena, budżet, timing, status quo, sceptycyzm wobec AI),
  pobiera ugruntowane fakty z Bazy Wiedzy (knowledgeLookupTool), weryfikuje historię leada w CRM
  i generuje spersonalizowany, empatyczny draft odpowiedzi w Gmail (gmail_manage_draft) z rejestracją w CRM.
keywords: [sales, objection-handling, b2b, roi, value-selling, negotiation, crm, gmail, draft, sales-agent]
allowedTools: [knowledge_lookup, crm_search_leads, crm_add_interaction, crm_update_lead, gmail_manage_draft, artifact_put, request_approval]
minComplexity: moderate
recommendedTier: balanced
handoffCapable: true
estimatedTokens: 4000
outputFormat: markdown
tags: [sales, objections, negotiation, b2b, crm, gmail, roi]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
---

# SKILL: B2B Objection Matrix Solver (Inteligentna Obsługa Obiekcji)

## Cel i Przeznaczenie

Skill definiuje procedurę konsultacyjnej analizy i neutralizacji obiekcji handlowych zgłaszanych przez leady i klientów w procesie sprzedaży B2B (GastroBridge, AI Automation, Consulting).

Proces realizuje **`salesAgent`**:
1. Identyfikacja i klasyfikacja obiekcji klienta według 5 głównych kategorii (Cena/Budżet, Czas/Timing, Status Quo, Sceptycyzm technologiczny/AI, Władza decyzyjna).
2. Pobranie ugruntowanych faktów, case studies i kalkulacji ROI z Bazy Wiedzy (`knowledge_lookup`).
3. Sprawdzenie historii relacji i dotychczasowych ustaleń w CRM (`crm_search_leads`).
4. Sformułowanie odpowiedzi w oparciu o framework **Feel-Felt-Found + Value Anchor + Micro-Commitment CTA**.
5. Zapisanie gotowego szkicu wiadomości w Gmail (`gmail_manage_draft(action: 'create')`) i odnotowanie interakcji w CRM (`crm_add_interaction`).
6. W przypadku żądania rabatu powyżej 10% – wywołanie bramki zgody (`request_approval`).

---

## 1. Matryca Klasyfikacji Obiekcji (Objection Matrix)

| Kategoria Obiekcji | Typowe Wypowiedzi Klienta | Strategia Kontrargumentacji | Źródło Groundingu (`knowledge_lookup`) |
| :--- | :--- | :--- | :--- |
| **1. Cena / Budżet** | *"Za drogo", "Nie mamy na to budżetu", "Konkurencja jest tańsza"* | Przesunięcie z kosztu na zwrot z inwestycji (ROI), redukcję strat food costu (3-5%) lub zaoszczędzone roboczogodziny. | `business/gastrobridge/pricing-and-terms.md`, `business/consulting/commercial-guardrails.md` |
| **2. Czas / Timing** | *"Odezwijcie się po sezonie", "Nie mamy teraz czasu na wdrożenia"* | Zaproponowanie bezobsługowego wdrożenia pilotażowego (zerowe obciążenie personelu) lub ustawienie `snoozeUntil` w CRM. | `business/consulting/horeca-consulting.md` |
| **3. Status Quo / Konkurencja** | *"Mamy już system X", "Dajemy sobie radę po staremu w Excelu"* | Pokazanie luki operacyjnej w obecnym rozwiązaniu, bezkrytyczne docenienie obecnego setupu + test porównawczy na 1 procesie. | `business/flowmint/services-and-offer.md` |
| **4. Sceptycyzm wobec AI / Automatyzacji** | *"AI popełnia błędy", "Nasi ludzie tego nie ogarną", "To za skomplikowane"* | Zasada "Human-in-the-loop" – AI jako asystent pod kontrolą człowieka, brak ryzyka halucynacji dzięki deterministycznym bramkom. | `business/flowmint/portfolio.md` |
| **5. Władza Decyzyjna** | *"Muszę zapytać wspólnika/zarządu", "To nie moja decyzja"* | Dostarczenie 1-stronicowego executive summary (Artifact) gotowego do przekazania decydentowi. | `starter-packs/business-starter-pack.json` |

---

## 2. Procedura Krok po Kroku

### Krok 1: Weryfikacja Kontekstu w CRM
Pobierz bieżący stan leada za pomocą `crm_search_leads`:
```json
{
  "query": "{email lub nazwa firmy}",
  "limit": 1
}
```
Zbadaj dotychczasowy segment (`gastro_consulting`, `automation`, `supplier_gb`), etap lejka oraz ostatnie notatki.

### Krok 2: Pobranie Faktów Groundingowych (`knowledge_lookup`)
Wyszukaj konkretne liczby, widełki cenowe lub argumenty:
```json
{
  "query": "pricing terms ROI food cost consulting",
  "category": "business"
}
```

### Krok 3: Walidacja Badań Cenowych i Rabatu
- Jeśli klient domaga się rabatu $>10\%$ lub niestandardowych warunków płatności:
  - Wywołaj `request_approval` z opisem sytuacji i proponowanym kompromisem.
  - Nie obiecuj rabatu przed uzyskaniem potwierdzenia.

### Krok 4: Konstrukcja Odpowiedzi (Framework 3F + Value Anchor)
Zbuduj treść odpowiedzi w naturalnym, partnerskim głosie Patryka:
1. **Empatia & Walidacja:** Zrozumienie perspektywy klienta (*"Całkowicie rozumiem, że w szczycie sezonu każda godzina zespołu jest na wagę złota..."*).
2. **Przeformułowanie Problemu (Reframe):** Wskazanie realnego kosztu braku działania (*"Większość lokali traci miesięcznie 2000-5000 PLN na niewykrytych skokach cen surowców..."*).
3. **Dowód / Propozycja Nisko-Oporowa:** (*"Nie wymagamy zmiany Waszego systemu – przygotujemy 1 audyt/pilotaż całkowicie po naszej stronie"*).
4. **Nisko-Oporowe CTA:** Propozycja krótkiej 15-minutowej rozmowy lub przesłania kalkulacji.

### Krok 5: Utworzenie Szkicu w Gmail (`gmail_manage_draft`)
Zapisz draft w odpowiedniej skrzynce:
```json
{
  "action": "create",
  "account": "gastrobridge",
  "to": "{lead.email}",
  "subject": "Re: {ostatni_temat_lub_kwestia}",
  "body": "{treść_odpowiedzi}",
  "threadId": "{opcjonalny_id_wątku}"
}
```

### Krok 6: Rejestracja w Historii CRM (`crm_add_interaction`)
Dodaj notatkę do historii leada w CRM:
```json
{
  "leadId": "{lead.id}",
  "action": "objection_handled",
  "description": "Zidentyfikowano obiekcję [{kategoria}]. Przygotowano szkic odpowiedzi w Gmail oparty o [{argumenty_roi}].",
  "agentId": "sales-agent"
}
```
