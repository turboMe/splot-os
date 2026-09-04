---
name: outreach-web-modernization
category: marketing
description: >-
  Cold outreach oferujący tworzenie nowych stron WWW lub modernizację przestarzałych witryn
  lokalnych firm. Pierwszy mail wskazuje 1-2 konkretne problemy (brak responsywności, wolne ładowanie)
  i proponuje darmowy audyt / wizualizację. Permission-based, zgodny z RODO.
  Trigger: cold email do firm z przestarzałymi stronami lub bez strony WWW.
keywords: [web-dev, website, modernization, outreach, cold-email, seo, responsive, nextjs, audit, rodo]
allowedTools: [gmail_create_draft, crm_create_lead, crm_update_status, crm_add_interaction, crm_record_email_draft, search_web, find_company_links]
minComplexity: medium
recommendedTier: pro
estimatedTokens: 2600
outputFormat: text
tags: [marketing, outreach, web-dev, website, modernization, cold-email]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Outreach — Tworzenie i Odświeżanie Stron WWW

## 1. Kiedy aktywować ten skill

Aktywuj, gdy zadanie dotyczy cold outreachu do firm:
- Z **przestarzałymi stronami WWW** (brak responsywności, stary design, wolne ładowanie).
- **Bez strony WWW** — lokalne biznesy, które potrzebują obecności online.
- Oferującego **budowę nowej strony od zera** (Next.js, nowoczesny design, SEO).
- Oferującego **lifting / modernizację** istniejącej witryny.

NIE aktywuj dla:
- Outreachu GastroBridge (skill `outreach-gastrobridge`),
- Oferty automatyzacji (skill `outreach-automation-agency`),
- Konsultingu gastro (skill `outreach-gastro-consulting`).

## 2. Model dwuetapowy — Obowiązkowy (RODO)

**Pierwszy mail:**
- Wskazanie 1-2 **konkretnych, zauważonych problemów** na obecnej stronie.
- Propozycja przesłania **darmowego mini-audytu lub wizualizacji** (nie oferty sprzedaży).
- Pytanie o zgodę na kontakt.

**Drugi mail (po odpowiedzi pozytywnej):**
- Szczegółowa propozycja: zakres, technologia, czas realizacji, orientacyjny budżet.

## 3. Universal Core Voice

- **Praktyk, nie agencja:** Patryk sam zbudował platformę GastroBridge (Next.js, full-stack). Nie jest „agencją web dev" — jest inżynierem, który rozumie, czego potrzebuje mały biznes.
- **Empatia dla lokalnego biznesu:** Rozumie, że dla małej firmy strona to koszt, nie zabawa. Musi się zwracać.
- **Konkret:** Zamiast „odświeżymy Państwa stronę" → „Państwa strona nie ładuje się poprawnie na telefonie — 68% klientów szuka restauracji z mobile".
- **Zero korpo-mowy, zero emoji.**

## 4. Research przed kontaktem — obowiązkowy

Przed napisaniem maila **musisz sprawdzić stronę prospekta:**

1. **`search_web` / `find_company_links`:** Znajdź aktualną stronę firmy.
2. **Zidentyfikuj konkretne problemy** (minimum 1, idealnie 2):
   - Brak responsywności na mobile.
   - Wolne ładowanie (> 3s).
   - Przestarzały design (styl sprzed 2015).
   - Brak SSL (http://).
   - Brak meta description / SEO basics.
   - Niedziałające linki / 404.
   - Brak informacji kontaktowych na widoku.
   - Brak Google Maps / godzin otwarcia.
3. **Jeśli firma nie ma strony:** Skieruj kąt na „obecność online i to, co tracisz bez strony".

**NIGDY nie wymyślaj problemów.** Jeśli strona jest dobra — nie pisz tego maila. Zaraportuj użytkownikowi.

## 5. Struktura pierwszego maila

```
HOOK (1-2 zdania): Wskazanie konkretnego problemu.
Np. „Odwiedziłem stronę [firma.pl] — na telefonie menu nie wyświetla się poprawnie,
a większość klientów szuka [branża] właśnie z mobile."

KONTEKST (1-2 zdania): Kim jestem (Patryk, full-stack developer, buduję platformę GastroBridge)
i co mogę zaproponować (mini-audyt lub wizualizacja odświeżonej strony).

CTA (1 zdanie): „Czy mogę przesłać krótki audyt z 2-3 konkretnymi sugestiami?
Bez zobowiązań — chcę pokazać, co mogłoby wyglądać lepiej."

KLAUZULA OPT-OUT (1 zdanie).

PODPIS:
Alex Doe
Tel: +1 (555) 019-2834
Email: admin@example.com
Portfolio & Realizacje: https://flowmint-ai.web.app/
```

## 6. Typy prospectów

### A. Lokalna firma z przestarzałą stroną
- **Hook:** Wskaż problem widoczny gołym okiem (mobile, prędkość, design).
- **Wartość:** Darmowy audyt / wizualizacja.
- **Ton:** Pomocny sąsiad-specjalista, nie agresywny sprzedawca.

### B. Firma bez strony WWW
- **Hook:** „Szukałem Państwa firmy online i nie znalazłem strony — klienci, którzy sprawdzają [branżę] w Google, trafiają na konkurencję."
- **Wartość:** Prosta, szybka strona od kilkuset złotych.
- **Ton:** Propozycja, nie wyrok.

### C. Firma z akceptowalną stroną, ale widocznym potencjałem
- **Hook:** Wskaż 1 konkretną rzecz (np. brak sekcji opinii, brak CTA).
- **Wartość:** Micro-lifting zamiast pełnej przebudowy.

## 7. Ograniczenia

| Zakazane | Dlaczego |
|---|---|
| Cennik / cena w pierwszym mailu | UŚUDE |
| Wymyślone problemy ze stroną | Utrata wiarygodności, potencjalnie poniżające |
| „Państwa strona jest okropna" | Obraźliwe, koniec rozmowy |
| Obietnica pozycji #1 w Google | Nikt nie może tego zagwarantować |
| Emoji | Głos Patryka |
| Wysłanie (tylko draft!) | Twarda granica |
| Brak klauzuli opt-out | RODO |
| Mail do firmy z dobrą stroną | Brak wartości, spam |

## 8. Oferta — co możemy zaoferować (po zgodzie)

| Usługa | Opis |
|---|---|
| Nowa strona od zera | Next.js, responsywność, SEO, szybka, nowoczesna |
| Modernizacja / lifting | Odświeżenie designu, przyspieszenie, mobile-first |
| Mini-audyt | Darmowy: 2-3 sugestie z priorytetami |
| SEO basics | Meta tagi, struktura nagłówków, sitemap |
| Integracja z Google | Maps, opinie, godziny otwarcia |

## 9. Workflow wykonawczy i CRM

1. **Sprawdź CRM:** Lead istnieje (`segment: 'web_dev'`)? `metadata.doNotContact`?
2. **Research strony:** `search_web` / `find_company_links` → znajdź stronę.
3. **Identyfikacja problemów:** Minimum 1 konkretny, zweryfikowany problem.
4. **Jeśli strona jest dobra:** Zaraportuj → STOP.
5. **Wybierz typ:** A (przestarzała), B (brak strony), C (potencjał).
6. **Napisz draft:** Max 120 słów, z konkretnym problemem w hooku.
7. **Gmail draft:** `gmail_create_draft`.
8. **CRM:** `crm_create_lead` (jeśli nowy lead, ustaw `segment: 'web_dev'`) + `crm_add_interaction` + `crm_record_email_draft`.
9. **Cover note + pytanie kalibrujące.**
10. **STOP:** Czekaj na approval.
