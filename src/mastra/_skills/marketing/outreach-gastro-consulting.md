---
name: outreach-gastro-consulting
category: marketing
description: >-
  Cold outreach dla usług konsultingu gastronomicznego: menu engineering, food-cost optimization,
  automatyzacja odpowiedzi na recenzje Google/TripAdvisor, strategia social media dla restauracji.
  Ton szef-dla-szefa. Pierwszy mail to propozycja wymiany doświadczeń, nie oferta.
  Trigger: cold email do restauracji / hoteli z propozycją konsultacji gastro.
keywords: [gastro-consulting, horeca, menu-engineering, food-cost, tripadvisor, google-reviews, outreach, cold-email, rodo]
allowedTools: [gmail_create_draft, crm_create_lead, crm_update_status, crm_add_interaction, crm_record_email_draft, search_web, find_company_links, knowledge_query]
minComplexity: medium
recommendedTier: balanced
estimatedTokens: 2800
outputFormat: text
tags: [marketing, outreach, gastro, consulting, horeca, cold-email]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Outreach — Konsulting Gastronomiczny & AI dla HoReCa

## 1. Kiedy aktywować ten skill

Aktywuj, gdy zadanie dotyczy cold outreachu do restauracji / hoteli / cateringu z ofertą:
- **Menu engineering** — tworzenie i optymalizacja menu, standaryzacja receptur, obniżka food costu.
- **Automatyzacja obsługi opinii** — odpowiedzi na Google Reviews / TripAdvisor z zachowaniem ludzkiego, ciepłego tonu.
- **Strategia i automatyzacja social media** — planowanie contentu, automatyzacja postów.
- **Doradztwo operacyjne** — procesy kuchenne, zarządzanie personelem, HACCP.

NIE aktywuj dla:
- Outreachu GastroBridge marketplace (skill `outreach-gastrobridge`),
- Oferty web dev (skill `outreach-web-modernization`),
- Oferty automatyzacji IT (skill `outreach-automation-agency`).

## 2. Model dwuetapowy (RODO)

**Pierwszy mail:**
- Relacja szef-dla-szefa / szef-dla-menedżera.
- Propozycja wymiany doświadczeń lub krótkiej konsultacji (nie oferty handlowej).
- Nawiązanie do konkretnego faktu o restauracji (opinie, menu, obecność online).

**Drugi mail (po pozytywnej odpowiedzi):**
- Konkretna propozycja zakresu konsultacji.

## 3. Universal Core Voice + adaptacja gastro

**Fundament głosu Patryka** — taki sam jak w innych skillach, ale z nałożoną warstwą gastronomiczną:
- **Head Chef mówi do Head Chefa:** Patryk był #1 na TripAdvisor w Islandii. Rozumie ból operacyjny kuchni od środka.
- **Bez mentorskiego tonu:** Nie pouczam — proponuję wymianę doświadczeń.
- **Food-cost to język:** Zamiast mówić o „optymalizacji" — mów o food-coście, waste, marży na daniach.
- **Konkretne liczby** (TYLKO jeśli prawdziwe): „Obniżyłem food-cost z 38% do 29% w 3 miesiące" — ale tylko jeśli Patryk to faktycznie zrobił.

## 4. Kąty komunikacji wg profilu prospekta

### A. Restauracja z dużą liczbą opinii (Google / TripAdvisor)

**Hook:** „Widzę, że mają Państwo [X] opinii na Google — imponujący wynik. Odpowiadanie na każdą kosztuje czas. Zautomatyzowałem ten proces u siebie — każda odpowiedź brzmi naturalnie, ciepło i jest dopasowana do treści recenzji."

**Wartość:** Automatyzacja odpowiedzi na recenzje (AI z ludzkim tonem, nie szablonowe odpowiedzi).

### B. Restauracja z widocznym problemem w menu / pozycjonowaniu

**Hook:** „Przejrzałem Państwa kartę dań — jest sporo potencjału w inżynierii menu. Jako były Head Chef, widzę kilka pozycji, które przy innym ustawieniu mogłyby lepiej pracować na marżę."

**Wartość:** Menu engineering, food-cost optimization.

### C. Restauracja bez obecności w social media

**Hook:** „Zauważyłem, że [nazwa] nie prowadzi regularnych social media — przy jakości Państwa kuchni to niewykorzystany kanał."

**Wartość:** Strategia contentu, planowanie postów, automatyzacja.

### D. Nowa restauracja / hotel

**Hook:** „Otwarcie nowego miejsca to ogromne wyzwanie operacyjne. Jeśli przydałby się ktoś, kto przeszedł już tę drogę (Head Chef w #1 TripAdvisor, Islandia) — chętnie podzielę się doświadczeniem."

**Wartość:** Doradztwo startowe: menu, procesy, HACCP, personel.

## 5. Struktura pierwszego maila

```
HOOK (1-2 zdania): Nawiązanie do konkretnego faktu o restauracji
(opinie, menu, brak social media, nowe otwarcie).

KONTEKST (1-2 zdania): Kim jestem (Patryk, były Head Chef, #1 TripAdvisor Islandia)
i co mogę zaproponować (wymiana doświadczeń, krótka konsultacja).

CTA (1 zdanie): „Czy byliby Państwo otwarci na krótką rozmowę o [konkretny temat —
np. optymalizacji menu / automatyzacji recenzji]?"

KLAUZULA OPT-OUT (1 zdanie).

PODPIS:
Alex Doe
Executive Head Chef & Doradca Gastronomiczny (#1 TripAdvisor Islandia)
Tel: +1 (555) 019-2834
Email: contact@example.com
```

## 6. Oferta usług (po zgodzie)

| Usługa | Opis |
|---|---|
| Menu Engineering | Analiza rentowności pozycji, BCG matrix menu, standaryzacja receptur |
| Food-Cost Optimization | Audyt kosztów, kalkulacja marży, identyfikacja strat |
| Automatyzacja Recenzji | AI-driven odpowiedzi na Google/TripAdvisor (ciepły, ludzki ton) |
| Strategia Social Media | Plan contentu, automatyzacja postów, format reels/stories |
| Doradztwo Operacyjne | Procesy kuchenne, HACCP, zarządzanie personelem |

## 7. Ograniczenia

| Zakazane | Dlaczego |
|---|---|
| Krytykowanie kuchni / menu w mailu | Obraźliwe, koniec rozmowy |
| Cennik w pierwszym mailu | UŚUDE |
| Mentorski ton („powinniście") | Patryk proponuje, nie naucza |
| Wymyślone liczby food-costu | Utrata wiarygodności |
| Emoji | Głos Patryka |
| Wysłanie (tylko draft!) | Twarda granica |
| Brak klauzuli opt-out | RODO |
| Obietnica „podwoję przychód" | Fałszywa obietnica |

## 8. Research przed kontaktem — obowiązkowy

1. **Znajdź restaurację:** `search_web` / `find_company_links`.
2. **Sprawdź opinie:** Google Reviews, TripAdvisor — ilość, średnia, ton recenzji.
3. **Sprawdź menu:** Czy jest dostępne online? Widoczne problemy (mała karta, brak cen, niezorganizowane)?
4. **Sprawdź social media:** Facebook, Instagram — aktywność, częstotliwość.
5. **Wybierz kąt:** A, B, C lub D na podstawie researchu.

## 9. Workflow wykonawczy i CRM

1. **Sprawdź CRM:**
   - Czy restauracja istnieje już jako lead?
     - Jeśli istnieje jako `restaurant_gb` → dodaj tag `tags: ['consulting']` (nie twórz duplikatu leada!).
     - Jeśli to nowy lead dedykowany pod konsulting → `segment: 'gastro_consulting'`.
   - Sprawdź, czy nie ma `metadata.doNotContact: true`.
2. **Research restauracji:** Opinie, menu, social media.
3. **Wybierz kąt komunikacji.**
4. **Napisz draft:** Max 120 słów, konkretny hook.
5. **Gmail draft:** `gmail_create_draft`.
6. **CRM:** `crm_create_lead` (lub `crm_update_lead` jeśli istniał) + `crm_add_interaction` + `crm_record_email_draft`.
7. **Cover note + pytanie kalibrujące** (np. „Czy kłaść nacisk na menu engineering czy automatyzację recenzji?").
8. **STOP:** Czekaj na approval.
