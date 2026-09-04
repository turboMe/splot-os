---
name: meddpicc-deal-qualifier
category: sales
description: >-
  Zaawansowana kwalifikacja szans sprzedaży B2B według 8 filarów MEDDPICC (Metrics, Economic Buyer,
  Decision Criteria, Decision Process, Paper Process, Identify Pain, Champion, Competition).
  Ocenia prawdopodobieństwo zamknięcia deala, wylicza wskaźnik Deal Health Score (0-100),
  identyfikuje luki w informacjach (Deal Gaps) i formułuje rekomendację Next Best Action (NBA) z aktualizacją CRM.
keywords: [sales, qualification, meddpicc, b2b, pipeline, deal-score, crm, win-rate, sales-agent, crm-agent]
allowedTools: [crm_search_leads, crm_update_lead, crm_add_interaction, artifact_put, knowledge_lookup]
minComplexity: moderate
recommendedTier: balanced
handoffCapable: true
estimatedTokens: 4200
outputFormat: markdown
tags: [sales, qualification, meddpicc, scoring, pipeline, crm, deals]
version: 1
success_rate: null
totalUses: 0
lastUsed: null
---

# SKILL: Kwalifikacja Szans Sprzedaży MEDDPICC & Deal Health Scoring

## Cel i Przeznaczenie

Skill definiuje obiektywną, wielowymiarową metodologię audytu i kwalifikacji szans sprzedaży B2B według standardu **MEDDPICC**. 

Proces realizuje **`salesAgent`** lub **`crmAgent`**:
1. Pobranie pełnej historii interakcji, notatek i metadanych leada z CRM (`crm_search_leads`).
2. Ocena transakcji w 8 filarach MEDDPICC w skali 0-10 punktów (łączny Deal Health Score: 0-100%).
3. Identyfikacja krytycznych luk informacyjnych blokujących zamknięcie (Deal Blockers / Gaps).
4. Sformułowanie rekomendacji **Next Best Action (NBA)** dla Patryka lub agenta.
5. Zapisanie szczegółowej karty kwalifikacyjnej jako **Artifact** (`artifact_put`) oraz aktualizacja pól leada w CRM (`crm_update_lead` i `crm_add_interaction`).

---

## 1. Kryteria Oceny MEDDPICC (Wagi i Pytania Kontrolne)

| Filar | Waga | Pytanie Kontrolne / Wymagany Dowód |
| :--- | :---: | :--- |
| **M - Metrics (Mierniki Sukcesu)** | 15% | Jaki twardy cel biznesowy chce osiągnąć klient? (np. spadek Food Costu o 4%, oszczędność 15h/tydzień, 20 nowych leadów). |
| **E - Economic Buyer (Decydent Finansowy)** | 15% | Czy rozmawiamy z osobą kontrolującą budżet? (Właściciel, CEO, Dyrektor Zarządzający). |
| **D - Decision Criteria (Kryteria Wyboru)** | 10% | Jakie są techniczne, biznesowe i prawne wymagania klienta? (np. integracja z POS, zgodność z RODO, prostota dla personelu). |
| **D - Decision Process (Proces Decyzyjny)** | 10% | Jak dokładnie wygląda ścieżka od oferty do podpisu? Kto bierze udział w komitecie? Ile trwa decyzja? |
| **P - Paper Process (Proces Formalno-Prawny)** | 10% | Jakie są wymogi formalne? (NDA, wzór umowy, audyt RODO, termin płatności faktury). |
| **I - Identify Pain (Zidentyfikowany Ból)** | 15% | Jaki jest realny, bolesny problem, który kosztuje firmę pieniądze lub paraliżuje rozwój? |
| **C - Champion (Wewnętrzny Ambasador)** | 15% | Czy po stronie klienta jest osoba, która aktywnie lobbuje za naszym rozwiązaniem? (np. Szef Kuchni, Manager lokalu). |
| **C - Competition (Konkurencja i Alternatywy)** | 10% | Z kim konkurujemy? (Inna agencja, dedykowany software, czy status quo / wewnętrzny pracownik). |

---

## 2. Procedura Krok po Kroku

### Krok 1: Pobranie Danych Transakcji z CRM
Użyj `crm_search_leads`:
```json
{
  "query": "{email lub nazwa firmy}",
  "limit": 1
}
```
Przeanalizuj dotychczasową korespondencję, notatki ze spotkań oraz status (`qualified`, `proposal_sent`, `negotiating`).

### Krok 2: Ewaluacja Filarów MEDDPICC
Dla każdego z 8 filarów przypisz ocenę 0-10 i wskaż twarde uzasadnienie:
- **0-3 (Czerwony/Brak)**: Brak informacji lub krytyczne ryzyko.
- **4-7 (Żółty/Częściowy)**: Informacja częściowa, wymaga potwierdzenia.
- **8-10 (Zielony/Mocny)**: Potwierdzony twardy fakt / ustalenie z klientem.

Wylicz łączny **Deal Health Score**:
$$\text{Score} = \sum (\text{ocena\_filaru} \times \text{waga})$$

### Krok 3: Wyznaczenie Next Best Action (NBA)
W oparciu o najsłabiej oceniony filar o wysokiej wadze wyznacz 1 kluczową akcję:
- *Brak Economic Buyer* $\to$ *"Poproś Championa o zaproszenie decydenta (CEO/Właściciela) na 15-minutowe podsumowanie ROI."*
- *Brak Metrics* $\to$ *"Przedstaw kalkulator food costu i ustal bazową marżę przed wysłaniem ostatecznej oferty."*
- *Brak Paper Process* $\to$ *"Wyślij standardowy wzór umowy ramowej ze skróconym SLA."*

### Krok 4: Zapisanie Raportu jako Artifact (`artifact_put`)
Zapisz ustrukturyzowany audyt:
```json
{
  "id": "meddpicc-{lead.id}",
  "title": "Kwalifikacja MEDDPICC — {lead.companyName}",
  "content": "# Kwalifikacja MEDDPICC: {lead.companyName}\n\n**Deal Health Score:** {Score}/100\n**Status:** {status}\n\n## 1. Matryca Filarów\n...\n\n## 2. Zidentyfikowane Luki (Deal Gaps)\n...\n\n## 3. Next Best Action (NBA)\n{nba_description}",
  "metadata": {
    "leadId": "{lead.id}",
    "companyName": "{lead.companyName}",
    "healthScore": "{Score}"
  }
}
```

### Krok 5: Aktualizacja Danych w CRM (`crm_update_lead` & `crm_add_interaction`)
Zaktualizuj metadane leada i dodaj wpis do historii:
```json
{
  "leadId": "{lead.id}",
  "metadata": {
    "meddpiccScore": "{Score}",
    "meddpiccLastAudit": "{data}",
    "meddpiccNextBestAction": "{nba_description}"
  }
}
```
Dodaj interakcję:
```json
{
  "leadId": "{lead.id}",
  "action": "meddpicc_qualification",
  "description": "Przeprowadzono audyt MEDDPICC. Health Score: {Score}/100. Rekomendacja NBA: {nba_description}",
  "agentId": "sales-agent"
}
```
