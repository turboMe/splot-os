---
name: consulting-wiedza-publisher
category: knowledge
description: >-
  Publikacja i aktualizacja dwujęzycznych artykułów (PL + EN) w Bazie Wiedzy GastroBridge-Consulting
  (consulting.gastrobridge.com/wiedza) wraz z automatycznym powiadomieniem na Telegram z bezpośrednim linkiem.
  Wymusza pełną dwujęzyczność, styl formatowania GastroBridge oraz obsługę endpointów API.
keywords: [consulting, gastrobridge, wiedza, articles, blog, publishing, telegram, bilingual, polish, english, content-agent, writer-agent]
allowedTools: [consulting_publish_article, telegram_send_message, run_command, fs_write_file, artifact_put]
minComplexity: medium
recommendedTier: balanced
estimatedTokens: 3500
outputFormat: markdown
tags: [content, publishing, consulting, wiedza, gastrobridge, telegram, bilingual]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
handoffCapable: true
---

# SKILL: Publikacja Artykułów w Bazie Wiedzy GastroBridge-Consulting

## Cel i Przeznaczenie

Ten skill definiuje procedurę publikacji i aktualizacji specjalistycznych artykułów w sekcji Bazy Wiedzy (`/wiedza`) na portalu `consulting.gastrobridge.com`.

Umożliwia agentom (`metaAgent`, `writerAgent`, `marketingAgent`, `contentAgent`):
1. Przygotowanie lub weryfikację gotowego artykułu gastronomiczno-technologicznego.
2. **Rygorystyczne egzekwowanie dwujęzyczności** – odrzucenie publikacji, jeśli brakuje pełnego, rzetelnego tłumaczenia angielskiego (`EN`).
3. Zastosowanie standardu stylizacji Markdown GastroBridge (nagłówki, callouty szefa kuchni, wyróżnienia miedziane `heat`).
4. Bezpieczną publikację przez autoryzowany endpoint REST API (`POST /api/wiedza` lub `PUT /api/wiedza/[slug]`).
5. Natychmiastowe wysłanie sformatowanego powiadomienia na Telegram z linkiem do opublikowanego wpisu.

---

## 1. Quality Gate — Wymóg Pełnej Dwujęzyczności (PL + EN)

> [!IMPORTANT]
> Każdy artykuł publikowany w Bazie Wiedzy GastroBridge **MUSI** zawierać kompletne pary pól w języku polskim oraz angielskim. Żadne pole `*EN` nie może być puste, skrócone ani zawierać nieprzetłumaczonego tekstu.

### Matryca Wymaganych Pól:

| Pole PL | Pole EN | Opis / Wymagania |
| :--- | :--- | :--- |
| `title` | `titleEN` | Chwytliwy, ekspercki tytuł artykułu (np. "Jak zoptymalizować food cost w 30 dni" / "How to Optimize Food Cost in 30 Days"). |
| `category` | `categoryEN` | Kategoria wpisu (np. "Menu & koszty" / "Menu & Costs", "AI & Automatyzacja" / "AI & Automation", "Operacje kuchenne" / "Kitchen Operations"). |
| `excerpt` | `excerptEN` | Krótkie podsumowanie / zajawka (1-3 zdania) widoczna na liście artykułów. |
| `content` | `contentEN` | Pełna treść artykułu w formacie Markdown z kompletnym przekładem wszystkich sekcji i calloutów. |
| `readTime` | `readTimeEN` | Szacowany czas czytania (np. "6 min" / "6 min"). Reguła: ok. 200 słów na minutę. |
| `slug` | *(wspólny)* | Identyfikator URL w formacie kebab-case (np. `jak-zoptymalizowac-food-cost-w-30-dni`). |
| `tags` | *(wspólne)* | Tablica tagów (string[]), np. `["food cost", "marża", "receptury", "gastronomia"]`. |
| `author` | *(wspólny)* | Obiekt autora: `name: "Zespół GastroBridge"`, `role: "Praktycy gastronomii & Inżynierowie AI"`. |
| `featured` | *(opcjonalne)* | Boolean (`true` / `false`, domyślnie `false`). |
| `status` | *(wymagane)* | `"published"` (dla natychmiastowej publikacji) lub `"draft"`. |

---

## 2. Standard Stylizacji Treści GastroBridge Markdown

Treść artykułów (`content` i `contentEN`) powinna korzystać ze specyficznych reguł wizualnych GastroBridge:

1. **Struktura nagłówków**:
   - `## Śródtytuł sekcji`
   - `### Podsekcja / Krok wdrożeniowy`
2. **Wyróżnienia i Emfaza**:
   - `**kluczowy termin / wniosek**` (pogrubienie)
   - `*uwaga praktyczna*` (akcent w kolorze miedzi `heat`)
3. **Callouty / Ramki Praktyki Kuchennej**:
   - `> **Zasada z kuchni:** Nie obniżaj cen bez uprzedniej rewizji gramatur i standaryzacji receptur.`
   - `> **Kitchen Rule:** Never cut prices without first auditing portion sizes and standardizing recipes.`
4. **Listy i Wypunktowania**:
   - Listy punktowane (`- element 1`) są automatycznie renderowane ze stylową kreską w kolorze żaru.
5. **Tabele**:
   - Standardowy Markdown (`| Kolumna 1 | Kolumna 2 |`) ze stalowym obramowaniem.
6. **Bloki Kodu / Konfiguracji**:
   - ` ```ts ... ``` ` lub ` ```json ... ``` `.

---

## 3. Parametry Techniczne i Autoryzacja API

### Zmienne Środowiskowe (w pliku `agentic-agents/.env`):
- `AGENT_API_SECRET`: Klucz autoryzacyjny API Bearer Token (znajduje się w pliku `/projekty/mastra-agentic-environment/agentic-agents/.env`).
- `CONSULTING_API_URL`: URL API publikacji (domyślnie: `https://consulting.gastrobridge.com/api/wiedza`).
- `TELEGRAM_BOT_TOKEN`: Token bota Telegram do powiadomień.
- `TELEGRAM_CHAT_ID` lub `N8N_TELEGRAM_CHAT_ID`: Identyfikator czatu docelowego (np. `578179283`).

> [!NOTE]
> Narzędzie `consulting_publish_article` oraz skrypt `publish_article.mjs` automatycznie odczytują `AGENT_API_SECRET` ze środowiska (`agentic-agents/.env`). Agent nie musi przekazywać klucza ręcznie w payloadzie JSON.

### Endpointy:
- **Publikacja nowego artykułu**: `POST /api/wiedza`
  - Header: `Authorization: Bearer <AGENT_API_SECRET>`
  - Header: `Content-Type: application/json`
  - Status sukcesu: `201 Created`
  - Odpowiedź zawiera obiekt `urls`:
    ```json
    {
      "success": true,
      "message": "Article published successfully",
      "article": { ... },
      "urls": {
        "pl": "https://consulting.gastrobridge.com/wiedza/jak-zoptymalizowac-food-cost-w-30-dni",
        "en": "https://consulting.gastrobridge.com/wiedza/jak-zoptymalizowac-food-cost-w-30-dni"
      }
    }
    ```
- **Aktualizacja istniejącego artykułu**: `PUT /api/wiedza/[slug]`
  - Header: `Authorization: Bearer <AGENT_API_SECRET>`
  - Body: pola do aktualizacji (np. zaktualizowany `contentEN`).
  - Status sukcesu: `200 OK`.

---

## 4. Procedura Wykonania Krok po Kroku

### Krok 1: Przygotowanie / Odbiór Treści
- Gdy zadanie zleca `metaAgent`:
  - Może napisać treść samodzielnie lub oddelegować zadanie do `writer-agent` / `marketing-agent`.
  - Po napisaniu wersji polskiej generowane jest profesjonalne, naturalne tłumaczenie na język angielski.

### Krok 2: Weryfikacja Dwujęzyczności i Schematu
- Sprawdź, czy żaden z wymaganych kluczy (`title`, `titleEN`, `category`, `categoryEN`, `excerpt`, `excerptEN`, `content`, `contentEN`, `slug`, `tags`, `readTime`, `readTimeEN`) nie jest pusty.
- Upewnij się, że `slug` zawiera wyłącznie małe litery, cyfry i myślniki (URL-safe).
- Domyślny autor:
  ```json
  "author": {
    "name": "Zespół GastroBridge",
    "role": "Praktycy gastronomii & Inżynierowie AI"
  }
  ```

### Krok 3: Publikacja przez API
Użyj narzędzia `consulting_publish_article` przekazując pełny payload JSON, lub uruchom skrypt `publish_article.mjs`.

### Krok 4: Wysłanie Powiadomienia na Telegram
Narzędzie lub skrypt automatycznie formatuje i wysyła powiadomienie na Telegram do Patryka z linkiem do opublikowanego wpisu.

### Krok 5: Raport Końcowy dla Użytkownika
Zwróć użytkownikowi zwięzłe podsumowanie:
- Potwierdzenie publikacji (Slug i Tytuł)
- Klikalne linki do wersji PL i EN
- Status dostarczenia powiadomienia Telegram
