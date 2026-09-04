---
name: build-specialist-skill
description: Formatuje i zapisuje procedurę operacyjną SOP do pliku Markdown w _skills/auto/ wraz z nagłówkiem YAML frontmatter i powiązaniem ze źródłem wiedzy.
category: meta
keywords: [sop-builder, skill-save, auto-skill, markdown-frontmatter]
recommendedTier: pro
preferLocal: false
---

# Procedura: Tworzenie i Aktywacja Nowego Skilla Specjalisty (SOP)

## 1. Cel
Zapisanie wygenerowanej procedury operacyjnej SOP w standardzie `_skills/auto/<skillId>.md` i jej natychmiastowa aktywacja w `SkillRegistry` za pomocą `skillSaveTool`.

## 2. Standard Nagłówka YAML Frontmatter
Plik musi zawierać pola:
```yaml
---
name: nazwa-skilla
description: Kiedy i jak stosować
category: auto
domain: identyfikator_domeny
recommendedTier: pro | private
preferLocal: false | true
privacyClassification: public | internal_business | confidential_strict
outputArtifact: document
allowedTools: [narzedzie1, narzedzie2]
knowledgeNotebookTitle: 'Tytuł w NotebookLM (opcjonalnie)'
localKnowledgePath: 'src/mastra/knowledge/private/... (opcjonalnie)'
---
```

## 3. Struktura Treści
1. Rola i Misja Specjalisty
2. Podstawy Wiedzy (Gdzie szukać faktów)
3. Ścisły Algorytm Krok po Kroku
4. Drzewo Decyzyjne i Warunki Brzegowe (IF / THEN)
5. Format Zwracanego Artefaktu
