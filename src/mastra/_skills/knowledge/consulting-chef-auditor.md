---
name: consulting-chef-auditor
category: knowledge
description: >-
  Autonomiczny audyt wstępny karty dań lokalu ze zgłoszeń na consulting.gastrobridge.com/darmowe-rozeznanie-menu.
  Pobiera zgłoszenia przez consulting_forms_api, deleguje ekstrakcję menu do researcherAgent (wzorzec menu-recon),
  bada reputację w Google Places (reviews_google_place), przeprowadza syntezę inżynierii menu, generuje 1-stronicowy
  raport jako Artifact, aktualizuje status na audit_ready i wysyła powiadomienie na Telegram wyłącznie do Patryka.
keywords: [consulting, gastrobridge, chef, menu-audit, food-cost, menu-recon, reviews, artifact, chef-agent, researcher-agent]
allowedTools: [consulting_forms_api, reviews_google_place, search_web, find_company_links, artifact_put, telegram_send_message, delegate_task]
minComplexity: medium
recommendedTier: fast
estimatedTokens: 4500
outputFormat: markdown
tags: [chef, menu, audit, food-cost, consulting, gastrobridge, recon, artifact]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
handoffCapable: true
---

# SKILL: Autonomiczny Audyt Karty Dań i Lokalu (Rozeznanie Menu)

## Cel i Przeznaczenie

Skill definiuje procedurę automatycznego przeprowadzenia wstępnego audytu karty dań i profilu lokalu zgłoszonego na stronie `consulting.gastrobridge.com/darmowe-rozeznanie-menu`.

Zadanie realizuje **`chefAgent`** we współpracy z **`researcherAgent`**:
1. Pobranie nowych zgłoszeń przez `consulting_forms_api(endpoint: 'rozeznanie-menu', status: 'new')`.
2. Zmiana statusu na `analyzing`.
3. Zlecenie ekstrakcji karty menu do **`researcherAgent`** (wykorzystując wzorzec `menu-recon.md` / `search_web`).
4. Analiza reputacji lokalu i opinii gości przez `reviews_google_place`.
5. Przeprowadzenie analizy inżynierii menu (struktura, wielkość karty, food cost, matrix gwiazd i psów).
6. Wygenerowanie estetycznego 1-stronicowego raportu w formacie Markdown i zapisanie go jako **Artifact** (`artifact_put`).
7. Zmiana statusu audytu w portalu na `audit_ready`.
8. Wysłanie powiadomienia na Telegram **wyłącznie do Patryka** z podsumowaniem i linkiem/identyfikatorem raportu (nie wysyłamy maila do klienta bez akceptacji Patryka).

---

## 1. Procedura Krok po Kroku

### Krok 1: Pobranie nowych zgłoszeń
Użyj narzędzia `consulting_forms_api`:
```json
{
  "endpoint": "rozeznanie-menu",
  "action": "list",
  "status": "new"
}
```
Jeśli brak nowych zgłoszeń (`count: 0`), zakończ zadanie.

### Krok 2: Ustawienie statusu `analyzing`
Dla każdego przetwarzanego zgłoszenia:
```json
{
  "endpoint": "rozeznanie-menu",
  "action": "update_status",
  "itemId": "{audit.id}",
  "newStatus": "analyzing"
}
```

### Krok 3: Ekstrakcja Menu Lokalu (`researcherAgent` / `menu-recon`)
Zleć `researcherAgent` (lub użyj `search_web` na podanym `website` / nazwie lokalu + mieście):
- Pobierz aktualne pozycje karty, podział na sekcje (przystawki, zupy, dania główne, desery).
- Pobierz ceny dań i ich opisy.
- Zidentyfikuj ewentualne braki (np. brak alergenów, brak gramatur, nieczytelny podział).

### Krok 4: Analiza Reputacji Google (`reviews_google_place`)
Użyj `reviews_google_place(query: "{restaurant} {city}")`:
- Pobierz ocenę ogólną, liczbę opinii i ostatnie recenzje gości.
- Zidentyfikuj powtarzające się wzorce (np. *długi czas oczekiwania*, *wysokie ceny w stosunku do porcji*, *chwalone konkretne dania*).

### Krok 5: Synteza Ekspercka i Przygotowanie Raportu (Artifact)
Zbuduj 1-stronicowy raport z audytu w standardzie GastroBridge:

```markdown
# 📋 Wstępny Audyt Karty Dań — {restaurant} ({city})

**Data audytu:** {data}  
**Zgłaszający:** {name} ({email})  
**Strona / Social Media:** {website}  
**Ocena Google:** ⭐ {rating}/5.0 ({reviewCount} opinii)

---

## 1. 🔍 Diagnoza Bieżącej Karty Dań
- **Rozmiar karty:** ok. {totalDishes} dań w {sectionCount} sekcjach.
- **Ocena struktury:** {Ocena czytelności, balansu między sekcjami i spójności konceptu}.
- **Ceny i rozstrzał:** Najtańsze danie główne: {minPrice} PLN | Najdroższe: {maxPrice} PLN.

## 2. 💬 Głos Gości (Analiza Opinii Google)
- ✅ **Mocne strony:** {Co goście chwalą najbardziej}.
- ⚠️ **Słabe punkty:** {Na co najczęściej narzekają goście (czas, cena, powtarzalność)}.

## 3. 🎯 Top 3 Rekomendacje Inżynierii Menu (Menu Matrix)
1. **Optymalizacja liczby pozycji:** {Konkretna rekomendacja wycięcia lub połączenia dań o dublujących się składnikach}.
2. **Korekta marżowości (Food Cost):** {Wskazanie dań z potencjalnie zbyt wysokim food costem lub ukrytych "gwiazd" zaniżających marżę}.
3. **Standaryzacja i nazewnictwo:** {Zalecenie dotyczące opisów, wyróżnień wizualnych i czytelności menu}.

---

## 💡 Propozycja Dalszych Kroków
Zaproszenie do 30-minutowej rozmowy strategicznej z Patrykiem w celu omówienia wdrożenia optymalizacji i kalkulatora food costu.
```

Zapisz raport jako Artifact za pomocą `artifact_put`:
```json
{
  "id": "audyt-menu-{audit.id}",
  "title": "Audyt Menu — {restaurant}",
  "content": "{treść markdown}",
  "metadata": {
    "restaurant": "{restaurant}",
    "city": "{city}",
    "clientEmail": "{email}",
    "consultingAuditId": "{audit.id}"
  }
}
```

### Krok 6: Zmiana statusu na `audit_ready`
Zaktualizuj status w bazie portalu:
```json
{
  "endpoint": "rozeznanie-menu",
  "action": "update_status",
  "itemId": "{audit.id}",
  "newStatus": "audit_ready"
}
```

### Krok 7: Powiadomienie Telegram WYŁĄCZNIE do Patryka
Wyślij powiadomienie przez `telegram_send_message`:
```text
🍽️ Raport Audytu Menu Gotowy do Weryfikacji!

🏢 Lokal: {restaurant} ({city})
👤 Zgłaszający: {name} ({email})
⭐ Ocena Google: {rating}/5 ({reviewCount} opinii)
📄 Liczba dań w menu: ~{totalDishes}

📁 Zapisano Artifact: audyt-menu-{audit.id}
Status portalu: audit_ready

👉 Sprawdź raport przed kontaktem z restauratorem.
```
