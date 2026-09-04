---
name: consulting-lead-qualifier
category: marketing
description: >-
  Autonomiczna obsługa i kwalifikacja zapytań ofertowych B2B ze strony consulting.gastrobridge.com/kontakt.
  Pobiera nowe leady przez consulting_forms_api, zleca research lokalu do researcherAgent,
  zapisuje do CRM w segmencie gastro_consulting ze strukturyzowanym subsegmentem, tworzy spersonalizowany
  szkic odpowiedzi w Gmail (gmail_manage_draft) i aktualizuje status na in_progress.
keywords: [consulting, gastrobridge, leads, kontakt, crm, qualification, b2b, gmail, draft, marketing-agent, researcher-agent]
allowedTools: [consulting_forms_api, crm_create_lead, crm_update_lead, crm_record_email_draft, gmail_manage_draft, search_web, find_company_links, telegram_send_message, delegate_task]
minComplexity: medium
recommendedTier: fast
estimatedTokens: 4200
outputFormat: markdown
tags: [marketing, crm, leads, consulting, gastrobridge, b2b, intake]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
handoffCapable: true
---

# SKILL: Kwalifikacja Leadów B2B GastroBridge-Consulting

## Cel i Przeznaczenie

Skill definiuje procedurę automatycznej obsługi, researchu i wstępnej kwalifikacji zapytań ofertowych spływających przez formularz kontaktowy na `consulting.gastrobridge.com/kontakt`.

Proces jest realizowany przez **`marketingAgent`** we współpracy z **`researcherAgent`**:
1. Pobranie nowych leadów przez `consulting_forms_api(endpoint: 'kontakt', status: 'new')`.
2. Przeprowadzenie researchu restauracji / firmy pytającej przez `researcherAgent`.
3. Kategoryzacja usługi i przypisanie subsegmentu w CRM.
4. Zapis do CRM (`leads`) w segmencie `gastro_consulting`.
5. Utworzenie spersonalizowanego szkicu odpowiedzi w Gmail (`gmail_manage_draft`).
6. Aktualizacja statusu leada w portalu na `in_progress`.
7. Wysłanie powiadomienia do Patryka na Telegram o gotowym szkicu do weryfikacji.

---

## 1. Segmentacja i Subkategorie w CRM

Aby utrzymać porządek w CRM, każdy lead z formularza kontaktowego zapisywany jest z segmentem **`gastro_consulting`** oraz jednym z dedykowanych subsegmentów:

| Usługa ze zgłoszenia (`service`) | Subsegment CRM (`subsegment`) | Tagi |
| :--- | :--- | :--- |
| *Marketing gastronomiczny* | `marketing_gastro` | `["gastro_consulting", "marketing", "social_media"]` |
| *Optymalizacja Food Costu / Menu* | `menu_food_cost` | `["gastro_consulting", "food_cost", "menu_engineering"]` |
| *Automatyzacja procesów / AI* | `automatyzacja_ai` | `["gastro_consulting", "automatyzacja", "ai_gastro"]` |
| *Rekrutacja pracowników* | `rekrutacja_personelu` | `["gastro_consulting", "rekrutacja_b2b"]` |
| *Inne / Ogólne* | `inne` | `["gastro_consulting", "ogolne"]` |

---

## 2. Procedura Krok po Kroku

### Krok 1: Pobranie nowych zgłoszeń
Użyj narzędzia `consulting_forms_api`:
```json
{
  "endpoint": "kontakt",
  "action": "list",
  "status": "new"
}
```
Jeśli brak nowych zgłoszeń (`count: 0`), zakończ zadanie bez efektów ubocznych.

### Krok 2: Research lokalu (`researcherAgent`)
Dla każdego nowego leada pobierz domenę z maila lub nazwę z treści i zleć delegację do `researcherAgent` (lub użyj `search_web` / `find_company_links`):
- Sprawdź profil lokalu w Google (ocena, liczba opinii, adres, miasto).
- Sprawdź media społecznościowe (Instagram / Facebook).
- Zidentyfikuj typ lokalu (np. casual dining, fine dining, pizzeria, bistro, sieć).

### Krok 3: Zapis do CRM (`crm_create_lead`)
Utwórz rekord w CRM:
```json
{
  "companyName": "{Nazwa lokalu lub Imię i Nazwisko}",
  "contactName": "{name}",
  "email": "{email}",
  "segment": "gastro_consulting",
  "subsegment": "{subsegment}",
  "status": "in_progress",
  "tags": ["gastro_consulting", "{subsegment}", "{miasto}"],
  "metadata": {
    "source": "consulting_web",
    "consultingLeadId": "{id}",
    "serviceRequested": "{service}",
    "rawMessage": "{message}",
    "lang": "{lang}"
  }
}
```

### Krok 4: Utworzenie Szkicu Wiadomości w Gmail (`gmail_manage_draft`)
Przygotuj spersonalizowany szkic odpowiedzi w Gmail:
- **Ton:** Profesjonalny, partnerski, szef-do-szefa (styl Patryka).
- **Struktura:**
  1. Podziękowanie za kontakt ze strony GastroBridge Consulting.
  2. Bezpośrednie odniesienie do problemu/potrzeby z wiadomości klienta.
  3. Konkretny wniosek z researchu (np. *"Zauważyłem, że prowadzicie świetne bistro w centrum Wrocławia..."*).
  4. Propozycja 20-30 minutowej niezobowiązującej rozmowy strategicznej.
- Zapisz szkic za pomocą `gmail_manage_draft(action: 'create', to: lead.email, subject: '...', body: '...')`.
- Zarejestruj ID szkicu w CRM: `crm_record_email_draft(leadId: leadId, draftId: draftId)`.

### Krok 5: Aktualizacja statusu w portalu
Zaktualizuj status w bazie portalu:
```json
{
  "endpoint": "kontakt",
  "action": "update_status",
  "itemId": "{lead.id}",
  "newStatus": "in_progress"
}
```

### Krok 6: Powiadomienie Telegram do Patryka
Wyślij powiadomienie przez `telegram_send_message`:
```text
📥 Nowy Lead B2B w GastroBridge Consulting!

👤 Klient: {name} ({email})
🏢 Lokal/Firma: {companyName} ({city})
📂 Usługa: {service} (subsegment: {subsegment})
💬 Wiadomość: "{message}"

✉️ Przygotowano szkic w Gmail:
Temat: {subject}
Status CRM: in_progress
```
