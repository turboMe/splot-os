---
name: client-health-churn-sentinel
category: crm
description: >-
  Ciągły nadzór nad relacjami z klientami, retencja i predykcja churnu (Client Health & Churn Sentinel).
  Skanuje bazę CRM w poszukiwaniu aktywnych klientów (closed_won, in_progress) bez kontaktu przez >30 dni,
  analizuje sentyment w ostatnich wątkach Gmail (frustracja, opóźnienia, spadek zaangażowania),
  generuje alerty na Telegram do Patryka i przygotowuje proaktywne szkice wiadomości wartości (Value Drops / Check-in).
keywords: [crm, retention, churn, client-care, health-score, customer-success, gmail, telegram, crm-agent, sales-agent]
allowedTools: [crm_search_leads, gmail_search, crm_add_interaction, crm_update_lead, gmail_manage_draft, telegram_send_message, artifact_put]
minComplexity: moderate
recommendedTier: balanced
handoffCapable: true
estimatedTokens: 4200
outputFormat: markdown
tags: [crm, retention, churn, client-care, success, health-score, sentiment]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
---

# SKILL: Client Health & Churn Sentinel (Nadzór Relacji i Retencja)

## Cel i Przeznaczenie

Skill definiuje autonomiczną procedurę monitoringu aktywności, oceny kondycji relacji (Account Health Score) i prewencyjnego przeciwdziałania odejściu klientów (Churn Prevention) w portfelu GastroBridge i Consulting.

Proces realizuje **`crmAgent`** we współpracy z **`salesAgent`**:
1. Cykliczny skan bazy CRM w poszukiwaniu rekordów o statusie `closed_won` lub `in_progress` z polem `lastInteractionAt` starszym niż 30 dni (tzw. "Cichy Dryf" / Silent Drift).
2. Weryfikacja ostatnich wątków w Gmail (`gmail_search`) pod kątem nieodebranych pytań lub negatywnego sentymentu.
3. Obliczenie wskaźnika **Account Health Score (0-100)**:
   - Częstotliwość kontaktu (waga 40%).
   - Sentyment komunikacji (waga 30%).
   - Realizacja celów biznesowych / korzystanie z usług (waga 30%).
4. W przypadku wykrycia ryzyka (Health Score $<60$ lub $>45$ dni bez kontaktu):
   - Wysłanie powiadomienia alarmowego na Telegram do Patryka (`telegram_send_message`).
   - Przygotowanie proaktywnego, nienachalnego draftu "Check-in & Value Drop" w Gmail (`gmail_manage_draft`).
   - Zarejestrowanie ostrzeżenia w historii leada w CRM (`crm_add_interaction`).

---

## 1. Wskaźniki i Poziomy Ryzyka Relacji

| Poziom Ryzyka | Kryteria Detekcji | Działanie Systemu |
| :--- | :--- | :--- |
| 🟢 **Zdrowy (Score 80-100)** | Kontakt $<21$ dni temu, pozytywny sentyment, aktywne wdrożenie. | Brak działań alarmowych, standardowy monitoring. |
| 🟡 **Ostrzeżenie (Score 60-79)** | Brak kontaktu 22-35 dni, lakoniczne odpowiedzi. | Przygotowanie draftu z bezpłatnym materiałem edukacyjnym / aktualizacją bazy wiedzy. |
| 🔴 **Ryzyko Churnu (Score <60)** | Brak kontaktu $>35$ dni, zaległości w odpowiedziach, negatywne uwagi. | Natychmiastowy alert Telegram do Patryka + draft z propozycją rozmowy statusowej. |

---

## 2. Procedura Krok po Kroku

### Krok 1: Wyszukanie Kont Zagrożonych w CRM
Użyj `crm_search_leads`:
```json
{
  "status": "won",
  "limit": 20
}
```
Sprawdź timestamp `lastInteractionAt` dla każdego leada.

### Krok 2: Analiza Ostatniej Korespondencji (`gmail_search`)
Dla zidentyfikowanych kont przeszukaj wątki:
```json
{
  "query": "from:{lead.email} OR to:{lead.email}",
  "account": "gastrobridge",
  "maxResults": 5
}
```
Zbadaj datę ostatniego maila od klienta oraz wydźwięk treści (pytania bez odpowiedzi, uwagi, opóźnienia).

### Krok 3: Wyliczenie Health Score i Diagnoza
Oceń stan konta i sformułuj przyczynę (np. *"Brak kontaktu od 42 dni po zakończeniu etapu audytu karty dań"*).

### Krok 4: Utworzenie Szkicu Re-Engagement w Gmail (`gmail_manage_draft`)
Przygotuj spersonalizowany szkic w duchu partnerskiej opieki Patryka:
- **Kontekst:** Odwołanie do wcześniejszego wdrożenia lub audytu.
- **Wartość (Value Drop):** Nowa wskazówka rynkowa, aktualizacja kalkulatora lub ciekawy case study.
- **Pytanie kontrolne:** *"Jak sprawdza się nowa karta / jak wygląda realizacja planu w tym miesiącu?"*

```json
{
  "action": "create",
  "account": "gastrobridge",
  "to": "{lead.email}",
  "subject": "Jak sprawdza się {wdrożone_rozwiązanie} w {companyName}?",
  "body": "{treść_check_in}"
}
```

### Krok 5: Wysłanie Powiadomienia na Telegram do Patryka (`telegram_send_message`)
```text
⚠️ Client-Care Sentinel: Wykryto ryzyko rozluźnienia kontaktu!

🏢 Klient: {companyName} ({contactName})
⏱️ Ostatni kontakt: {dni_bez_kontaktu} dni temu ({data})
📊 Account Health Score: {healthScore}/100

✉️ Przygotowano proaktywny szkic w Gmail:
Temat: "{subject}"

👉 Sprawdź i zatwierdź draft w Gmailu.
```

### Krok 6: Aktualizacja CRM (`crm_add_interaction` & `crm_update_lead`)
```json
{
  "leadId": "{lead.id}",
  "action": "churn_risk_flagged",
  "description": "Client-Care Sentinel: Health Score {healthScore}/100 ({dni} dni ciszy). Wygenerowano draft check-in i alert Telegram.",
  "agentId": "crm-agent"
}
```
