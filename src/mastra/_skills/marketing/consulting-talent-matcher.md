---
name: consulting-talent-matcher
category: marketing
description: >-
  Autonomiczna obsługa i profilowanie aplikacji kandydatów HoReCa ze strony consulting.gastrobridge.com/dla-kandydatow.
  Pobiera nowe zgłoszenia przez consulting_forms_api, kategoryzuje subsegment (kuchnia, sala, bar, management),
  analizuje staż i języki, zapisuje do CRM w dedykowanym segmencie consulting_recruitment,
  aktualizuje status na screened i wysyła pigułkę profilu na Telegram do Patryka.
keywords: [consulting, gastrobridge, recruitment, kandydaci, talent, hr, horeca, chef, crm, marketing-agent]
allowedTools: [consulting_forms_api, crm_create_lead, crm_update_lead, telegram_send_message, run_worker]
minComplexity: medium
recommendedTier: balanced
estimatedTokens: 3800
outputFormat: markdown
tags: [marketing, crm, recruitment, talent, horeca, consulting, gastrobridge]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
handoffCapable: true
---

# SKILL: Profilowanie i Zarządzanie Kandydatami HoReCa

## Cel i Przeznaczenie

Skill definiuje procedurę automatycznego przetwarzania aplikacji kucharzy, personelu sali, barmanów i menedżerów spływających przez formularz rekrutacyjny na `consulting.gastrobridge.com/dla-kandydatow`.

Zadanie realizuje **`marketingAgent`**:
1. Pobranie nowych zgłoszeń przez `consulting_forms_api(endpoint: 'kandydaci', status: 'new')`.
2. Kwalifikacja kandydata: przypisanie subsegmentu, ocena poziomu doświadczenia, ekstrakcja kompetencji i języków.
3. Zapis profilu w CRM (`leads`) w dedykowanym segmencie **`consulting_recruitment`**.
4. Zmiana statusu kandydata w portalu na `screened`.
5. Wysłanie 3-punktowej pigułki profilu kandydata do Patryka na Telegram.

---

## 1. Segmentacja i Subkategorie w CRM (`consulting_recruitment`)

> [!IMPORTANT]
> Segment `career_chef_pl` jest zarezerwowany dla ofert i aplikacji Patryka. Zgłoszenia z portalu consultingowego trafiają **wyłącznie** do segmentu **`consulting_recruitment`**.

### Matryca Subkategorii:

| Stanowisko zgłoszone (`position`) | Subsegment CRM (`subsegment`) | Tagi |
| :--- | :--- | :--- |
| Szef kuchni, Head Chef, Sous Chef, Kucharz, Cukiernik, Pomoc kuchenna | `kuchnia` | `["rekrutacja", "kuchnia", "{stanowisko}", "{seniority}"]` |
| Kelner, Starszy kelner, Manager sali, Sommelier, Hostessa | `sala` | `["rekrutacja", "sala", "{stanowisko}"]` |
| Barman, Head Bartender, Barista | `bar` | `["rekrutacja", "bar", "{stanowisko}"]` |
| General Manager, Dyrektor gastronomii, Kierownik lokalu, F&B Manager | `management` | `["rekrutacja", "management", "{stanowisko}"]` |
| Inne role gastronomiczne | `inne` | `["rekrutacja", "inne"]` |

### Klasyfikacja Doświadczenia (Seniority):
- **Junior:** 0-2 lata doświadczenia
- **Mid:** 3-5 lat doświadczenia
- **Senior:** 6-10 lat doświadczenia
- **Head / Executive:** 10+ lat lub stanowisko Head Chef / GM

---

## 2. Procedura Krok po Kroku

### Krok 1: Pobranie nowych aplikacji
Użyj narzędzia `consulting_forms_api`:
```json
{
  "endpoint": "kandydaci",
  "action": "list",
  "status": "new"
}
```
Jeśli brak nowych kandydatów (`count: 0`), zakończ zadanie.

### Krok 2: Profilowanie Kandydata
Na podstawie pól `position`, `experience`, `languages`, `location`:
1. Przypisz odpowiedni `subsegment` (`kuchnia`, `sala`, `bar`, `management`, `inne`).
2. Określ poziom seniority (`Junior`, `Mid`, `Senior`, `Executive`).
3. Wygeneruj 3-punktową pigułkę profilu:
   - Główne specjalizacje i rodzaj kuchni / lokalu (np. *Fine dining, a'la carte, bankiety*).
   - Kluczowe atuty (np. *Angielski biegły, prawo jazdy, dyspozycyjność od zaraz*).
   - Rekomendowany typ lokalu partnerskiego.

### Krok 3: Zapis do CRM (`crm_create_lead`)
```json
{
  "companyName": "{name} (Kandydat: {position})",
  "contactName": "{name}",
  "email": "{email}",
  "phone": "{phone}",
  "segment": "consulting_recruitment",
  "subsegment": "{subsegment}",
  "region": "{location}",
  "status": "research_needed",
  "tags": ["rekrutacja", "{subsegment}", "{seniority}", "{location}"],
  "metadata": {
    "source": "consulting_recruitment_web",
    "consultingCandidateId": "{id}",
    "position": "{position}",
    "seniority": "{seniority}",
    "experience": "{experience}",
    "languages": "{languages}",
    "location": "{location}"
  }
}
```

### Krok 4: Zmiana statusu w portalu
Zaktualizuj status w bazie portalu:
```json
{
  "endpoint": "kandydaci",
  "action": "update_status",
  "itemId": "{candidate.id}",
  "newStatus": "screened"
}
```

### Krok 5: Powiadomienie Telegram do Patryka
Wyślij podsumowanie przez `telegram_send_message`:
```text
👨‍🍳 Nowy Kandydat w Bazie Talentów GastroBridge!

👤 Kandydat: {name}
📞 Kontakt: {phone} | {email}
📍 Lokalizacja: {location}
🎯 Stanowisko: {position} ({seniority}, subsegment: {subsegment})
🗣️ Języki: {languages.join(', ')}

📝 Pigułka Profilu:
• Doświadczenie: {experience_summary}
• Status w CRM: Zapisano w consulting_recruitment (screened)
```
