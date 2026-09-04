---
name: outreach-automation-agency
category: marketing
description: >-
  Cold outreach dla usług automatyzacji procesów biznesowych, systemów agentowych LLM,
  integracji n8n, audytów operacyjnych i automatyzacji powtarzalnej pracy.
  Pierwszy mail to zapytanie o wąskie gardła procesowe, nie oferta sprzedaży.
  Trigger: cold email do firm z propozycją automatyzacji / AI / agentów.
keywords: [automation, n8n, ai-agents, llm, outreach, cold-email, b2b, integration, workflow, process-automation, rodo]
allowedTools: [gmail_create_draft, crm_create_lead, crm_update_status, crm_add_interaction, crm_record_email_draft, search_web, find_company_links, knowledge_query]
minComplexity: medium
recommendedTier: balanced
estimatedTokens: 2800
outputFormat: text
tags: [marketing, outreach, automation, ai, n8n, cold-email]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Outreach — Agencja Automatyzacji AI & Procesy B2B

## 1. Kiedy aktywować ten skill

Aktywuj, gdy zadanie dotyczy cold outreachu oferującego:
- Automatyzację procesów biznesowych (n8n, integracje systemowe, bazy danych, API).
- Systemy agentowe LLM (lokalne modele, audyty operacyjne, automatyzacja powtarzalnej pracy).
- Integracje między systemami (CRM, ERP, fakturowanie, monitoring).
- Audyt procesu i identyfikację wąskich gardeł operacyjnych.

NIE aktywuj dla:
- Outreachu GastroBridge (skill `outreach-gastrobridge`),
- Oferty tworzenia stron WWW (skill `outreach-web-modernization`),
- Aplikacji o pracę (skill `career-application-it-gastro`).

## 2. Model dwuetapowy — Obowiązkowy (RODO / UŚUDE)

**Pierwszy mail = zapytanie, NIE oferta.**

Cel pierwszego maila:
- Zbadanie wąskich gardeł w firmie klienta.
- Identyfikacja powtarzalnych procesów manualnych.
- Zapytanie o możliwość bezpłatnej analizy procesu lub krótkiej rozmowy.

**Drugi mail (dopiero po odpowiedzi pozytywnej):**
- Konkretna propozycja rozwiązania.
- Zakres, czas realizacji, model współpracy.

## 3. Universal Core Voice (głos Patryka)

- **Praktyk automatyzacji, nie sprzedawca usług:** Patryk sam zbudował wieloagentowy system operacyjny, platformę B2B i dziesiątki automatyzacji n8n.
- **Konkret:** Zamiast „zoptymalizujemy Państwa procesy" → „zauważyłem, że Państwa [konkretny proces] mógłby działać automatycznie".
- **Szacunek dla czasu:** 3-5 zdań, zero buzzwordów AI, zero emoji.
- **Nie obiecuj magii:** Automatyzacja to narzędzie, nie rozwiązanie każdego problemu. Mów o konkretnych procesach.

## 4. Typy prospectów i kąty komunikacji

### A. Firma z widocznymi powtarzalnymi procesami manualnymi

Przykłady: ręczne przepisywanie danych, ręczne fakturowanie, ręczne odpowiadanie na zapytania, ręczna obsługa leadów.

**Hook:** „Zauważyłem, że [konkretny proces, np. formularz kontaktowy na stronie] wygląda na obsługiwany ręcznie. Czy jest tak w rzeczywistości?"

### B. Firma technologiczna szukająca optymalizacji

**Hook:** „Pracuję z systemami n8n i agentami LLM na co dzień — jeśli szukacie kogoś, kto zaprojektuje [konkretny workflow], mogę pomóc."

### C. Firma bez widocznych procesów — ogólne podejście

**Hook:** „Specjalizuję się w znajdowaniu i automatyzowaniu tych procesów, które w firmie pochłaniają czas, ale nie wyglądają na pilne — np. ręczne raportowanie, powtarzalna komunikacja czy przepisywanie danych między systemami."

## 5. Struktura pierwszego maila

```
HOOK (1 zdanie): Kontekstowe nawiązanie do firmy (zauważony proces, technologia, profil).

KONTEKST (1-2 zdania): Kim jestem (Patryk, automatyzacja procesów, n8n, systemy agentowe, full-stack)
i co robię (identyfikuję wąskie gardła operacyjne i buduję rozwiązania).

CTA (1 zdanie): „Czy byliby Państwo otwarci na krótką rozmowę o tym, które procesy w firmie pochłaniają
najwięcej czasu?"

KLAUZULA OPT-OUT (1 zdanie): „Jeśli to nie jest aktualny temat, wystarczy krótka odpowiedź —
uszanuję to i nie ponowię kontaktu."

PODPIS:
Alex Doe
Tel: +1 (555) 019-2834
Email: admin@example.com
Portfolio & Automatyzacje: https://flowmint-ai.web.app/
```

## 6. Wartości do komunikacji (TYLKO jeśli prawdziwe)

| Argument | Warunek |
|---|---|
| Automatyzacja procesów n8n | Patryk ma potwierdzone wdrożenia n8n |
| Systemy agentowe LLM | Mastra-based multi-agent system jest działającym produktem |
| Integracje API / CRM / ERP | Potwierdzone w portfolio |
| Audyt procesów biznesowych | Oferujemy jako usługę startową |
| Lokalne modele AI (Ollama) | Patryk uruchomił produkcyjnie |

**Nie obiecuj:**
- Gwarancji ROI bez analizy.
- Konkretnych oszczędności procentowych bez danych.
- Funkcji AI, które nie istnieją w aktualnym stacku.

## 7. Ograniczenia

| Zakazane | Dlaczego |
|---|---|
| „AI zrewolucjonizuje Państwa firmę" | Buzzword, utrata wiarygodności |
| Cennik w pierwszym mailu | Naruszenie UŚUDE |
| Emoji | Głos Patryka |
| Obietnica ROI bez analizy | Fałszywe obietnice |
| Wysłanie maila (tylko draft!) | Twarda granica |
| Brak klauzuli opt-out | RODO |

## 8. Workflow wykonawczy i CRM

1. **Sprawdź CRM:** Czy lead istnieje (`segment: 'automation'`)? Czy nie ma `metadata.doNotContact: true`?
2. **Research firmy:** `search_web` / `find_company_links` — profil, strona, widoczne procesy.
3. **Wybierz kąt:** A (widoczny problem), B (firma tech), C (ogólne podejście).
4. **Napisz draft:** Zgodnie z szablonem, max 120 słów.
5. **Gmail draft:** `gmail_create_draft`.
6. **CRM:** `crm_create_lead` (jeśli nowy lead, ustaw `segment: 'automation'`) + `crm_add_interaction` + `crm_record_email_draft`.
7. **Cover note:** Przedstaw + 1 pytanie kalibrujące.
8. **STOP:** Czekaj na approval.
