---
name: client-onboarding-orchestrator
category: sales
description: >-
  Kompleksowa orkiestracja wdrożenia nowego klienta (Client Onboarding) po osiągnięciu etapu closed_won.
  Generuje spersonalizowany pakiet wdrożeniowy (Onboarding Pack Artifact), tworzy wydarzenie Kickoff
  w Kalendarzu Google (calendar_create_event), przygotowuje draft wiadomości powitalnej w Gmail
  wraz z linkami do zasobów na Google Drive i inicjalizuje harmonogram zadań w CRM.
keywords: [sales, crm, onboarding, customer-success, calendar, kickoff, gmail, drive, artifact, sales-agent, crm-agent]
allowedTools: [crm_search_leads, crm_update_status, crm_add_interaction, calendar_create_event, calendar_find_event, gmail_manage_draft, artifact_put, knowledge_lookup]
minComplexity: moderate
recommendedTier: balanced
handoffCapable: true
estimatedTokens: 4500
outputFormat: markdown
tags: [sales, crm, onboarding, kickoff, calendar, customer-success, gmail]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
---

# SKILL: Client Onboarding Orchestrator (Orkiestracja Wdrożenia Klienta)

## Cel i Przeznaczenie

Skill definiuje procedurę automatycznego, bezbłędnego uruchomienia procesu onboardingowego dla nowego klienta w momencie sfinalizowania umowy (przejście leada na status `closed_won` / `won`).

Proces realizuje **`salesAgent`** we współpracy z **`crmAgent`**:
1. Weryfikacja danych leada i szczegółów podpisanej umowy/oferty w CRM (`crm_search_leads`).
2. Wygenerowanie spersonalizowanego dokumentu **Onboarding Pack Artifact** (`artifact_put`) zawierającego:
   - Harmonogram wdrożenia (Etap 1: Audyt zerowy $\to$ Etap 2: Konfiguracja narzędzi $\to$ Etap 3: Warsztat zespołu $\to$ Etap 4: Go-Live).
   - Listę wymaganych dostępów i materiałów od klienta.
   - Dane kontaktowe do Patryka i zespołu wsparcia.
3. Sprawdzenie wolnych terminów i zaplanowanie spotkania Kickoff w Kalendarzu Google (`calendar_create_event`).
4. Przygotowanie eleganckiego szkicu wiadomości powitalnej w Gmail (`gmail_manage_draft(action: 'create')`).
5. Aktualizacja statusu leada na `in_progress` (lub `onboarding`) i rejestracja pełnego pakietu wdrożeniowego w CRM (`crm_add_interaction`).

---

## 1. Architektura Pakietu Onboardingowego (4 Filarowy Plan)

```
[Etap 1: Kickoff & Dostęp] ──► [Etap 2: Konfiguracja & Audyt] ──► [Etap 3: Szkolenie Zespołu] ──► [Etap 4: Go-Live & SLA]
   Spotkanie startowe             Integracja POS / Menu             Warsztat operacyjny               Cykliczny nadzór
   (Google Calendar)              (Kalkulator Food Cost)            (Materiały wideo)                 (Client-Care Sentinel)
```

---

## 2. Procedura Krok po Kroku

### Krok 1: Pobranie Szczegółów Zamkniętej Transakcji z CRM
Użyj `crm_search_leads`:
```json
{
  "query": "{email lub id leada}",
  "limit": 1
}
```
Sprawdź uzgodniony zakres usług (np. doradztwo gastronomiczne, wdrożenie automatyzacji AI, audyt menu).

### Krok 2: Generowanie Onboarding Pack jako Artifact (`artifact_put`)
Zapisz ustrukturyzowany przewodnik dla klienta:
```json
{
  "id": "onboarding-{lead.id}",
  "title": "Pakiet Onboardingowy — {lead.companyName}",
  "content": "# 🚀 Witamy na Pokładzie: {lead.companyName}!\n\n**Opiekun wdrożenia:** Patryk\n**Data startu:** {data}\n\n---\n\n## 1. 📅 Harmonogram Wdrożenia (Kamienie Milowe)\n- **Krok 1 (Dzień 1-3):** Spotkanie Kickoff Call & audyt zerowy.\n- **Krok 2 (Dzień 4-7):** Przygotowanie konfiguracji i bazy materiałów.\n- **Krok 3 (Dzień 8-12):** Wdrożenie procedur i przekazanie kalkulatorów.\n- **Krok 4 (Dzień 14+):** Przejście w tryb stałego nadzoru.\n\n## 2. 🔑 Wymagane Materiały i Dostęp\n- [ ] Aktualny plik karty menu z gramaturami i cenami zakupu surowców.\n- [ ] Dostęp do raportów sprzedaży z systemu POS (CSV/Excel za ostatni miesiąc).\n\n## 3. 📞 Kanały Kontaktu i Wsparcie\n...",
  "metadata": {
    "leadId": "{lead.id}",
    "companyName": "{lead.companyName}",
    "stage": "onboarding_initiated"
  }
}
```

### Krok 3: Rezerwacja Spotkania Kickoff w Kalendarzu Google (`calendar_create_event`)
Znajdź najbliższy dogodny termin (np. za 2 dni robocze o 10:00) w oparciu o bieżący czas systemowy:
```json
{
  "summary": "Kickoff Wdrożenia: GastroBridge x {lead.companyName}",
  "description": "Spotkanie startowe wdrożenia. Omówienie harmonogramu, celów i przekazanie materiałów.",
  "start": "{data_start_iso}",
  "end": "{data_end_iso}",
  "attendees": ["{lead.email}"]
}
```

### Krok 4: Utworzenie Szkicu Powitalnego w Gmail (`gmail_manage_draft`)
Przygotuj draft powitalny:
```json
{
  "action": "create",
  "account": "gastrobridge",
  "to": "{lead.email}",
  "subject": "Witamy w GastroBridge — potwierdzenie startu i spotkanie Kickoff",
  "body": "Cześć {contactName},\n\nNiezmiernie cieszę się na naszą współpracę! Zgodnie z ustaleniami, zarezerwowałem w naszym kalendarzu termin na krótkie spotkanie Kickoff:\n\n📅 Termin: {data_spotkania}\n\nW załączeniu przesyłam ramowy plan wdrożenia (Onboarding Pack). Do usłyszenia na spotkaniu!\n\nPozdrawiam,\nPatryk"
}
```

### Krok 5: Aktualizacja Statusu i Historii w CRM (`crm_update_status` & `crm_add_interaction`)
Zaktualizuj status leada:
```json
{
  "leadId": "{lead.id}",
  "status": "in_progress"
}
```
Zarejestruj interakcję:
```json
{
  "leadId": "{lead.id}",
  "action": "onboarding_started",
  "description": "Uruchomiono procedurę Onboarding Orchestrator. Utworzono Onboarding Pack Artifact (onboarding-{lead.id}), zaplanowano Kickoff w Kalendarzu i przygotowano powitalny draft w Gmail.",
  "agentId": "sales-agent"
}
```
