---
name: setup-domain-knowledge-pack
description: Konfiguruje chmurową bazę wiedzy w Google NotebookLM na podstawie zweryfikowanych źródeł zewnętrznych (akty prawne, dokumentacja, artykuły).
category: knowledge
keywords: [notebooklm, knowledge-pack, sources-import, cloud-knowledge]
recommendedTier: balanced
preferLocal: false
---

# Procedura: Konfiguracja Chmurowej Bazy Wiedzy (NotebookLM)

## 1. Cel
Inicjalizacja dedykowanego notatnika w Google NotebookLM dla nowo tworzonego specjalisty i zaimportowanie zweryfikowanych źródeł zebranych w `SpecialistDossierV1`.

## 2. Kroki Wykonawcze
1. **Pobranie źródeł z paszportu:** Odczytaj listę `knowledgeNeeded.sources` z paszportu specjalisty.
2. **Utworzenie notatnika:** Utwórz notatnik o nazwie wskazanej w `knowledgeNeeded.corpusTitle`.
3. **Import materiałów:** Dodaj linki URL lub treść dokumentów do notatnika.
4. **Weryfikacja indeksowania:** Upewnij się, że źródła zostały przetworzone i są gotowe do zapytań syntetycznych.
5. **Przekazanie identyfikatorów:** Zwróć `notebookId` i tytuł notatnika do dołączenia do nagłówka YAML nowego skilla.
