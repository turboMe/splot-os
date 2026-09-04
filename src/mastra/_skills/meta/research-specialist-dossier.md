---
name: research-specialist-dossier
description: Przeprowadza pogłębiony rekonesans roli i generuje ustrukturyzowany paszport SpecialistDossierV1 w oparciu o 4 Złote Pytania oraz wykrywanie granicy prywatności.
category: meta
keywords: [agent-builder, specialist-dossier, recon, 4-golden-questions, privacy-detection]
recommendedTier: pro
preferLocal: false
outputArtifact: specialist_dossier
---

# Procedura: Badanie i Generowanie Paszportu Specjalisty (SpecialistDossierV1)

## 1. Cel i Rola
Jako `researcherAgent`, twoim zadaniem jest przeprowadzenie kompleksowego rekonesansu domeny przed utworzeniem lub powołaniem nowego specjalisty w systemie Mastra.
Odpowiadasz na 4 Złote Pytania i analizujesz poziom poufności danych.

## 2. Cztery Złote Pytania (The 4 Golden Questions)
1. **Kim jest ta rola / persona?**
   - Jaki jest tytuł specjalisty, jego główna misja, standardy branżowe oraz do którego z istniejących 25 agentów gospodarzy (`researcherAgent`, `salesAgent`, `codingAgent`, `writerAgent`, itp.) najlepiej pasuje ta rola?
2. **Jakich narzędzi (tools) potrzebuje?**
   - Które z istniejących narzędzi systemu są wystarczające, a jakich brakuje (czy potrzebny jest MCP, webhook n8n, czy narzędzie lokalne)?
3. **Jakich zdolności i procedur operacyjnych (skills SOP) potrzebuje?**
   - Zdefiniuj algorytm postępowania krok po kroku, drzewo decyzyjne oraz warunki brzegowe.
4. **Jakiej wiedzy (knowledge grounding) potrzebuje?**
   - Jakie są oficjalne, zweryfikowane źródła (akty prawne, dokumentacja, standardy)?

## 3. Wykrywanie Poziomu Poufności (Privacy Boundary Gate)
Sklasyfikuj dane wejściowe:
- `public` — wiedza ogólnodostępna (ustawy, dokumentacja techniczna, publiczne standardy). Model: standardowy w chmurze, wiedza: NotebookLM.
- `internal_business` / `confidential_strict` — poufne dokumenty firmy, umowy, finanse, PII. Model: 100% lokalny Ollama, wiedza: lokalny katalog `src/mastra/knowledge/private/<domain>/`.

## 4. Format Wyjściowy
Wygeneruj ustrukturyzowany obiekt JSON zgodny ze schematem `SpecialistDossierSchema` i zapisz go jako artefakt o typie `specialist_dossier`.
