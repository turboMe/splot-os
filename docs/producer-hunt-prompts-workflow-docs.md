# Producer Hunt: Porównanie Promptów i Logiki (Jarvis vs Mastra)

Ten dokument zawiera zestawienie ewolucji workflow `producer-hunt` po migracji z systemu Jarvis do Mastra. Służy jako punkt odniesienia przy przyszłych modyfikacjach promptów.

> Powiązane: [producer-hunt-supplier-types.md](producer-hunt-supplier-types.md) — od PR A workflow nie szuka już tylko producentów, ale też hurtowni/dystrybutorów/grup producenckich/importerów. Klasyfikacja, scoring i segment CRM opisane są w tamtym dokumencie. Plan rozszerzenia: [ideas/producer-hunt-fix-v3.md](../ideas/producer-hunt-fix-v3.md).
>
> Faza discovery (multi-profile zapytania Tavily, multi-round, budżet, filtrowanie URL) — [producer-hunt-discovery.md](producer-hunt-discovery.md) (PR B).
>
> Prompty discovery (NotebookLM + fallback po snippetach z klasyfikacją supplierType) — [producer-hunt-discovery-prompts.md](producer-hunt-discovery-prompts.md) (PR C).
>
> Enrichment dopasowany do typu (multi-source NotebookLM, per-typ pytania, per-typ final prompt, default hook) — [producer-hunt-enrichment.md](producer-hunt-enrichment.md) (PR D).
>
> Drafty cold-mail per typ + segment CRM per typ + neutralny `validateDraft` — [producer-hunt-drafts.md](producer-hunt-drafts.md) (PR E).
>
> Stabilność i diagnostyka (outer-catch fallback, validate-output gating, preserve NLM, regex email, strukturalne logi, notebook cleanup retry) — [producer-hunt-stability.md](producer-hunt-stability.md) (v2: P0.2/P0.3/P1.5/P1.6/P2.7/P2.8).

## 0. Tożsamość i Instrukcje Bazowe (System Prompt)

| Element | Jarvis (Legacy) | Mastra (New) | Cel zmiany |
| :--- | :--- | :--- | :--- |
| **Model** | Różne (OpenAI/Anthropic) | **gemma4:26b** (Ollama) | Lokalność i prywatność danych. |
| **Tożsamość** | "Jesteś asystentem marketingu..." | "Jesteś Patrykiem, chefem który koduje..." | Zwiększenie autentyczności i "ludzkiego" tonu. |
| **Ton** | Profesjonalny, pomocny. | Bezpośredni, "z kuchni do kodu", konkretny. | Budowanie relacji "praktyk-praktyk". |

---

## 1. Modele LLM w Krokach Workflow

| Krok | Zadanie | Model / Narzędzie | Uwagi |
| :--- | :--- | :--- | :--- |
| **01** | Discover Leads | **NotebookLM** (Gemini) | Ekstrakcja danych z wyników Tavily. |
| **01 (FB)** | Discover (Fallback) | **gemma4:26b** | Używany, gdy NotebookLM zawiedzie. |
| **03** | Enrich Leads | **NotebookLM** + **gemma4:26b** | NotebookLM robi research, Gemma szlifuje Hook. |
| **04** | Extract Emails | **gemma4:26b** | Ekstrakcja adresu z tekstu analizy. |
| **05** | Draft Cold Emails | **gemma4:26b** | Kreatywne pisanie maila i stopki RODO. |
| **05 (Rep)** | JSON Repair | **gemma4:26b** | Automatyczna naprawa formatu JSON. |

---

## 2. Porównanie Promptów Zadaniowych

### KROK 01: Discover Leads (Odkrywanie)
*   **Jarvis:** Prosta prośba o listę firm na podstawie snippetów.
*   **Mastra:** Wielostopniowe wyszukiwanie z użyciem "Notatnika Odkrywcy".
    *   *Kluczowa różnica:* W Mastra model szuka konkretnie w stopkach i podstronach kontaktowych, ignorując portale ogólne.

### KROK 03: Enrich Leads (Wzbogacanie)
*   **Jarvis:** Skupienie na ogólnym USP (Unique Selling Proposition).
*   **Mastra:** Skupienie na `personalizationHook` (max 20 słów).
    *   *Kluczowa różnica:* W Mastra wymuszamy szukanie rodzinnych tradycji, certyfikatów (np. "Produkt Lokalny") i konkretnych wartości ekologicznych.

### KROK 05: Draft Cold Emails (Pisanie maila)
*   **Jarvis:** Limit 180 słów, styl profesjonalny, wymogi prawne w stopce.
*   **Mastra (Final):** Limit **180 słów**, "Zasady Patryka" (zero emoji, hook na starcie), **pełny reżim RODO** (stopka informacyjna).
    *   *Kluczowa różnica:* Mastra łączy "pancerność" prawną Jarvisa z unikalnym, chefowskim charakterem Patryka.

---

## 3. Mechanizmy Stabilności (Mastra)

W Mastra zaimplementowano potrójne zabezpieczenie w kroku 05:
1.  **Generate**: Standardowe wywołanie promptu.
2.  **Repair**: Jeśli JSON jest uszkodzony, model dostaje szansę na naprawę (tylko obiekt `{ subject, body }`).
3.  **Fallback**: Jeśli naprawa zawiedzie, wstawiany jest statyczny, bezpieczny szablon z personalizacją regionu i nazwy firmy.

---
*Dokumentacja wygenerowana: 2026-05-05*
