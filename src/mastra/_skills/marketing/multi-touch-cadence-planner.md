---
name: multi-touch-cadence-planner
category: marketing
description: >-
  Projektowanie i planowanie wieloetapowych sekwencji kontaktu B2B (Multi-Touch Outreach Cadence).
  Tworzy spójną, 3-4 stopniową ścieżkę komunikacji (Dzień 0: Hook, Dzień +3: Value Asset/Case Study,
  Dzień +7: Quick Check, Dzień +14: Break-up/Nurture), generuje szkice wiadomości w Gmailu
  z przypisaniem do harmonogramu (schedule_task) oraz weryfikuje status leadów (skipIfEngaged / deduping).
keywords: [marketing, cadence, sequences, outreach, follow-up, multi-touch, cold-email, crm, gmail, schedule-task, marketing-agent]
allowedTools: [crm_search_leads, crm_record_email_draft, gmail_manage_draft, schedule_task, artifact_put, knowledge_lookup]
minComplexity: moderate
recommendedTier: balanced
handoffCapable: true
estimatedTokens: 4500
outputFormat: markdown
tags: [marketing, outreach, cadence, follow-up, cold-email, b2b, sequences]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
---

# SKILL: Multi-Touch Cadence Planner (Wieloetapowe Sekwencje B2B)

## Cel i Przeznaczenie

Skill definiuje procedurę projektowania, generowania i harmonogramowania wieloetapowych, spersonalizowanych sekwencji kontaktu B2B (Outreach Cadences) z zachowaniem pełnego bezpieczeństwa (Draft-First) i dynamicznej kontroli odpowiedzi.

Proces realizuje **`marketingAgent`**:
1. Sprawdzenie stanu leada w CRM (`crm_search_leads`) – przerwanie w przypadku aktywnej konwersacji (`replied`, `in_progress`, `opt_out`).
2. Przygotowanie 4-stopniowej architektury wiadomości dopasowanej do profilu firmy.
3. Wygenerowanie spersonalizowanych szkiców w Gmail (`gmail_manage_draft(action: 'create')`).
4. Rejestracja szkiców w rejestrze CRM (`crm_record_email_draft`).
5. Zaplanowanie kroków sekwencji w harmonogramie zadań (`schedule_task` / `chainName`) z wbudowaną weryfikacją odpowiedzi klienta przed każdym kolejnym krokiem.

---

## 1. Architektura Sekwencji (4-Touch Cadence Structure)

```
[Dzień 0: Krok 1] ─── (brak odpowiedzi +3 dni) ───► [Dzień +3: Krok 2]
Personalizowany Hook                               Wartość Dodana / Case Study
       │                                                    │
       ▼ (odpowiedź)                                        ▼ (brak odpowiedzi +4 dni)
[Stop sekwencji ──► salesAgent]                    [Dzień +7: Krok 3]
                                                   Krótkie pytanie sprawdzające
                                                            │
                                                            ▼ (brak odpowiedzi +7 dni)
                                                   [Dzień +14: Krok 4]
                                                   Polite Break-up & Nurture
```

| Krok | Dzień | Rola Wiadomości | Cel i Ton | Długość |
| :--- | :---: | :--- | :--- | :---: |
| **Touch 1** | Dzień 0 | *The Hook & Direct Bridge* | Nawiązanie do konkretnego faktu o firmie + propozycja 1 korzyści + nisko-oporowe CTA. | 80-120 słów |
| **Touch 2** | Dzień +3 | *The Value Asset / Proof* | Odniesienie do pierwszego maila w tym samym wątku (`threadId`), podesłanie case study lub bezpłatnego materiału (np. kalkulator food cost / artykuł wiedzy). | 60-90 słów |
| **Touch 3** | Dzień +7 | *The Frictionless Check* | 2-3 zdaniowe pytanie, czy temat optymalizacji/automatyzacji jest obecnie na tapecie w lokalu. | 30-50 słów |
| **Touch 4** | Dzień +14 | *The Polite Break-up* | Zamknięcie pętli, informacja o zaprzestaniu kontaktu, link do bazy wiedzy na przyszłość. | 40-60 słów |

---

## 2. Procedura Krok po Kroku

### Krok 1: Weryfikacja Leada w CRM
Użyj `crm_search_leads`:
```json
{
  "query": "{email leada}",
  "limit": 1
}
```
Zasada bezpieczeństwa: Jeśli status to `odpowiedział`, `in_progress`, `uśpiony` lub `odrzucony` (RODO opt-out) – **przerwij procedurę bez generowania wiadomości**.

### Krok 2: Opracowanie Treści Sekwencji (Touch 1-4)
Dla każdego z 4 kroków wygeneruj zwięzłą treść w stylu Patryka:
- **Touch 1:** Unikalny temat i mocny początek.
- **Touch 2-4:** Wysyłane jako odpowiedzi w tym samym wątku (Re: {temat_1}).

### Krok 3: Zapisanie Draftu Kroku 1 w Gmail (`gmail_manage_draft`)
Zapisz pierwszy szkic w Gmail:
```json
{
  "action": "create",
  "account": "gastrobridge",
  "to": "{lead.email}",
  "subject": "{Temat Touch 1}",
  "body": "{Treść Touch 1}"
}
```
Zarejestruj draft w CRM za pomocą `crm_record_email_draft`.

### Krok 4: Zapisanie Planu Sekwencji jako Artifact (`artifact_put`)
Zapisz kompletny plan sekwencji w repozytorium:
```json
{
  "id": "cadence-{lead.id}",
  "title": "Sekwencja Outreach: {lead.companyName}",
  "content": "# ✉️ Sekwencja Outreach (4-Touch): {lead.companyName}\n\n**Email:** {lead.email}\n**Segment:** {lead.segment}\n\n## Krok 1 (Dzień 0) — Gotowy Draft Gmail: {draftId}\n...\n\n## Krok 2 (Dzień +3) — Value Asset\n...\n\n## Krok 3 (Dzień +7) — Check-in\n...\n\n## Krok 4 (Dzień +14) — Break-up\n...",
  "metadata": {
    "leadId": "{lead.id}",
    "companyName": "{lead.companyName}"
  }
}
```

### Krok 5: Zaplanowanie Kolejnych Kroków w Harmonogramie (`schedule_task`)
Użyj `schedule_task` do rejestracji opóźnionych kroków sprawdzających:
```json
{
  "action": "schedule",
  "chainName": "cadence-{lead.id}",
  "stepName": "touch-2-check",
  "delayMs": 259200000,
  "promptOrInstruction": "Sprawdź w CRM czy lead {lead.email} odpowiedział. Jeśli status to nadal contacted/draft_gotowy, wygeneruj szkic Touch 2 w wątku.",
  "wake": false
}
```
