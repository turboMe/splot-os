---
name: abm-account-dossier-builder
category: marketing
description: >-
  Głębokie profilowanie firm docelowych w modelu Account-Based Marketing (ABM).
  Bada stronę WWW firmy, opinie, technologie, skalę działalności i komitet decyzyjny (CEO, Szef Kuchni, Dyrektor Operacyjny),
  syntetyzuje 3 kluczowe punkty bólu (Pain Points) dopasowane do oferty GastroBridge/Consulting/AI
  i generuje ustrukturyzowane Dossier Konta jako Artifact powiązany z CRM.
keywords: [marketing, abm, account-intelligence, research, lead-enrichment, b2b, dossier, researcher-agent, marketing-agent]
allowedTools: [search_web, find_company_links, tavily_extract, crm_search_leads, crm_create_lead, crm_update_lead, artifact_put, knowledge_lookup]
minComplexity: moderate
recommendedTier: balanced
handoffCapable: true
estimatedTokens: 4800
outputFormat: markdown
tags: [marketing, abm, research, intelligence, enrichment, b2b, crm]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
---

# SKILL: ABM Account Dossier Builder (Profilowanie Konta ABM)

## Cel i Przeznaczenie

Skill definiuje procedurę automatycznego, wieloźródłowego wywiadu gospodarczego i budowania kompleksowego profilu (Dossier) firmy docelowej przed przystąpieniem do spersonalizowanego kontaktu B2B.

Proces realizuje **`marketingAgent`** we współpracy z **`researcherAgent`**:
1. Weryfikacja obecności firmy w CRM (`crm_search_leads`) – zapobieganie dublowaniu.
2. Zgromadzenie danych cyfrowych (strona WWW, media społecznościowe, profil Google Places, portale branżowe) za pomocą `search_web`, `find_company_links` oraz `tavily_extract`.
3. Zidentyfikowanie modelu operacyjnego, skali lokalu/firmy, używanego oprogramowania i kluczowych osób decyzyjnych.
4. Sformułowanie 3 precyzyjnych hipotez problemowych (Pain Points) oraz dedykowanych haków narracyjnych (Value Hooks).
5. Wygenerowanie estetycznego dokumentu **Account Dossier Artifact** (`artifact_put`) oraz zapis/aktualizacja profilu leada w CRM (`crm_create_lead` / `crm_update_lead`).

---

## 1. Struktura Dossier Konta ABM

Dossier obejmuje 4 kluczowe sekcje analityczne:
1. **Paszport Firmy (Firmographics):** Nazwa, lokalizacja, segment, liczba lokali/pracowników, szacowane obroty, strona WWW.
2. **Cyfrowy & Operacyjny Ślad (Footprint):** Pozycjonowanie w Google, opinie klientów, aktywność w social media, zidentyfikowane technologie (POS, rezerwacje, strona).
3. **Komitet Zakupowy (Buying Committee):** Zidentyfikowane persony decyzyjne (Właściciel/Zarząd, Szef Kuchni/Manager, Dział Marketingu).
4. **Strategiczne Haki Wartości (Strategic Value Hooks):** Konkretne odniesienia do menu, oferty lub aktualnych wyzwań biznesowych lokalu.

---

## 2. Procedura Krok po Kroku

### Krok 1: Weryfikacja CRM i Sprawdzenie Duplikatów
Użyj `crm_search_leads`:
```json
{
  "query": "{nazwa firmy lub domena}",
  "limit": 1
}
```
Jeśli lead istnieje i ma status zaangażowany (`contacted`, `replied`, `in_progress`), pobierz jego ID. Jeśli nie istnieje, przygotuj dane do utworzenia nowego rekordu.

### Krok 2: Deep Web Research (`researcherAgent` / `search_web` / `tavily_extract`)
1. Wyszukaj oficjalne strony i kanały lokalu:
```json
{
  "query": "\"{companyName}\" restauracja menu kontakt {city}"
}
```
2. Pobierz pełną treść kluczowych podstron (O nas, Menu, Oferta) za pomocą `tavily_extract`.
3. Zbadaj obecność i nazwiska osób zarządzających (LinkedIn, KRS, strona www).

### Krok 3: Synteza Punktów Bólu (Pain Points & Hooks)
W oparciu o zebrane materiały zdefiniuj 3 hipotezy:
- **Hak 1 (Operacyjny/Koszty):** np. *"Szeroka karta dań (>45 pozycji) wskazuje na ryzyko wysokiego food costu i strat magazynowych."*
- **Hak 2 (Marketing/Sprzedaż):** np. *"Niewykorzystany potencjał rezerwacji online lub brak aktywnej bazy gości."*
- **Hak 3 (Skalowanie/Automatyzacja):** np. *"Planowane otwarcie drugiego lokalu w innym mieście wymaga standaryzacji procesów kuchennych."*

### Krok 4: Generowanie i Zapisanie Artifactu (`artifact_put`)
Zapisz dossier jako Artifact:
```json
{
  "id": "abm-dossier-{slug}",
  "title": "ABM Dossier — {companyName}",
  "content": "# 🏢 ABM Account Dossier: {companyName}\n\n**Segment:** {segment}\n**Lokalizacja:** {city}\n**Strona WWW:** {website}\n\n---\n\n## 1. 📊 Podsumowanie Operacyjne\n...\n\n## 2. 👥 Zidentyfikowane Osoby Decyzyjne\n...\n\n## 3. 🎯 Top 3 Haki Wartości i Punkty Bólu\n...\n\n## 4. 💡 Rekomendowany Kąt Pierwszego Kontaktu\n{outreach_angle}",
  "metadata": {
    "companyName": "{companyName}",
    "website": "{website}",
    "city": "{city}"
  }
}
```

### Krok 5: Utworzenie / Aktualizacja Leada w CRM (`crm_create_lead` / `crm_update_lead`)
Zarejestruj wzbogacony profil w bazie CRM:
```json
{
  "companyName": "{companyName}",
  "email": "{email}",
  "contactName": "{contactName}",
  "website": "{website}",
  "region": "{region}",
  "segment": "gastro_consulting",
  "status": "research_needed",
  "tags": ["abm_enriched", "{city}", "{segment_tag}"],
  "metadata": {
    "abmDossierArtifactId": "abm-dossier-{slug}",
    "identifiedPainPoints": ["{pain1}", "{pain2}", "{pain3}"],
    "recommendedAngle": "{outreach_angle}"
  },
  "skipIfEngaged": true
}
```
