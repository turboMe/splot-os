---
name: meeting-calendar-handoff
category: marketing
description: >-
  Procedura koordynacji spotkań z leadami: rozpoznanie prośby o spotkanie,
  propozycja terminów, tworzenie eventu w Google Calendar, draft zaproszenia emailowego,
  aktualizacja CRM. Powiązana z workflow meeting-scheduler i salesAgent.
  Trigger: lead prosi o spotkanie / demo / rozmowę telefoniczną.
keywords: [meeting, calendar, google-calendar, scheduling, handoff, demo, sales, crm]
allowedTools: [calendar_create_event, gmail_create_draft, crm_update_status, crm_add_interaction, crm_update_lead, search_leads]
minComplexity: medium
recommendedTier: balanced
estimatedTokens: 2000
outputFormat: text
tags: [marketing, sales, meeting, calendar, scheduling]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Meeting & Calendar Handoff — Koordynacja Spotkań

## 1. Kiedy aktywować ten skill

Aktywuj, gdy:
- Email od leada zawiera prośbę o spotkanie / demo / rozmowę.
- Inbox-monitor zaklasyfikował email jako `meeting_request`.
- Użytkownik prosi o zaplanowanie spotkania z konkretnym leadem.
- Workflow `meeting-scheduler` potrzebuje wygenerować propozycję terminów.

NIE aktywuj dla:
- Wewnętrznych spotkań (nie dotyczy leadów).
- Klasyfikacji emaili (domena `inbound-email-triage`).
- Cold outreachu (skille outreach).

## 2. Typy spotkań

| Typ | Opis | Czas trwania | Kanał |
|---|---|---|---|
| Intro call | Krótka rozmowa zapoznawcza | 15-20 min | Telefon / Google Meet |
| Demo | Pokaz platformy / usługi | 30 min | Google Meet / Zoom |
| Konsultacja | Rozmowa merytoryczna (menu, procesy) | 30-45 min | Google Meet / Telefon |
| Spotkanie osobiste | Meeting face-to-face | 45-60 min | Na miejscu |

## 3. Workflow rozpoznania i handoffu

### Krok 1: Identyfikacja spotkania w emailu

Sygnały kwalifikujące:
- Konkretna propozycja terminu (np. „wtorek o 10:00").
- Ogólna prośba (np. „Zadzwońmy", „Kiedy masz czas?").
- Prośba o demo (np. „Chcę zobaczyć, jak to działa").

### Krok 2: Sprawdzenie leada w CRM

1. `search_leads` — znajdź lead po emailu.
2. Sprawdź status: czy lead jest aktywny? Czy nie ma `doNotContact`?
3. Sprawdź `metadata.meetingScheduled` — czy spotkanie nie było już zaplanowane.

### Krok 3: Propozycja terminów

Reguły doboru terminów:
- **Domyślna strefa czasowa:** `Atlantic/Reykjavik` (IST, UTC+0).
- **Preferowane godziny:** 9:00–17:00 IST (chyba że lead jest z innej strefy).
- **Preferowane dni:** Poniedziałek–Piątek.
- **Proponuj 2-3 terminy** w najbliższych 5 dniach roboczych.
- **Uwzględnij strefę czasową leada** jeśli znana (np. CET dla polskich leadów = IST+1 zimą, IST+2 latem).

Jeśli lead podał konkretny termin:
- Potwierdź ten termin (nie proponuj alternatyw, chyba że koliduje z kalendarzem).

### Krok 4: Tworzenie eventu w Google Calendar

Użyj `calendar_create_event` z parametrami:
```json
{
  "summary": "[Typ spotkania] — [Firma / Imię leada]",
  "description": "Spotkanie z [imię] z [firma].\nKontekst: [krótki opis — np. demo GastroBridge, konsultacja menu].\nEmail: [email leada].",
  "startTime": "ISO 8601",
  "endTime": "ISO 8601",
  "attendees": ["email-leada@example.com"],
  "location": "Google Meet (auto-generated)" 
}
```

**UWAGA:** Tworzenie eventu z `attendees` wysyła zaproszenie. To jest **akcja zewnętrzna** — wymaga weryfikacji przed wykonaniem. Przedstaw draft eventu użytkownikowi najpierw.

### Krok 5: Draft zaproszenia emailowego

Napisz krótki email potwierdzający:
```
Cześć [imię],

Dziękuję za zainteresowanie — chętnie porozmawiam.

Proponuję [dzień, data] o [godzina] ([strefa]). 
Link do spotkania: [Google Meet / do uzupełnienia].

Jeśli ten termin nie pasuje, daj znać — dopasujemy się.

Pozdrawiam,
Patryk
```

### Krok 6: Aktualizacja CRM

- `crm_update_status` → `odpowiedział` (jeśli nie był już w tym statusie).
- `crm_update_lead` → `metadata.meetingScheduled: true`, `metadata.meetingDate: 'ISO date'`.
- `crm_add_interaction` → typ `meeting_scheduled`, metadane: data, typ spotkania, kanał.

## 4. Reguły bezpieczeństwa

| Reguła | Dlaczego |
|---|---|
| Nie twórz eventu bez pokazania użytkownikowi | Event z attendees wysyła zaproszenie = akcja zewnętrzna |
| Nie zakładaj strefy czasowej leada | Różne kraje, różne strefy — sprawdź lub zapytaj |
| Nie planuj spotkań poza godzinami roboczymi | Szacunek dla czasu obu stron |
| Nie planuj spotkań z leadami `doNotContact` | RODO |
| Nie wysyłaj emaila (tylko draft!) | Twarda granica |

## 5. Integracja z istniejącymi workflow

### `meeting-scheduler` workflow
- Ten skill dostarcza procedurę, którą `meeting-scheduler` workflow wykorzystuje w kroku `generate-meeting-proposals`.
- Jeśli inbox-monitor wykryje `meeting_request`, powinien triggerować `meeting-scheduler` z odpowiednimi danymi leada.

### `inbox-monitor` workflow
- Kategoria `meeting_request` → eskalacja do tego skilla.
- Draft odpowiedzi generowany w inbox-monitorze powinien być spójny z procedurą tego skilla.

## 6. Schemat wyjściowy

```json
{
  "leadId": "...",
  "leadEmail": "...",
  "mailboxAccount": "gastrobridge|personal",
  "meetingType": "intro_call|demo|consultation|in_person",
  "proposedSlots": [
    { "date": "YYYY-MM-DD", "time": "HH:MM", "timezone": "Atlantic/Reykjavik" }
  ],
  "calendarEventDraft": {
    "summary": "...",
    "startTime": "ISO 8601",
    "endTime": "ISO 8601",
    "attendees": ["..."],
    "location": "..."
  },
  "emailDraft": "Treść potwierdzenia",
  "crmUpdates": {
    "status": "odpowiedział",
    "meetingScheduled": true,
    "meetingDate": "ISO 8601",
    "mailboxAccount": "gastrobridge|personal"
  }
}
```
