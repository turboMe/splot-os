---
name: setup-private-local-knowledge
description: Inicjalizuje prywatny, lokalny katalog wiedzy offline dla danych poufnych i wrażliwych w src/mastra/knowledge/private/<domain>/ z pełną izolacją i modelem lokalnym.
category: knowledge
keywords: [private-knowledge, offline-rag, privacy-gate, confidential-docs, local-directory]
recommendedTier: private
preferLocal: true
---

# Procedura: Konfiguracja Lokalnej Bazy Wiedzy Prywatnej (Offline)

## 1. Cel
Zapewnienie 100% bezpieczeństwa danych wrażliwych (PII, umowy, finanse) poprzez utworzenie dedykowanego katalogu lokalnego `src/mastra/knowledge/private/<domain>/` oraz wymuszenie użycia lokalnych modeli (Ollama).

## 2. Kroki Wykonawcze
1. **Utworzenie katalogu lokalnego:** Utwórz katalog `src/mastra/knowledge/private/<domain>/`.
2. **Generowanie pliku README.md:** Utwórz plik instrukcji informujący użytkownika o przeznaczeniu katalogu.
3. **Poinformowanie użytkownika:** Zwróć ścieżkę do katalogu, aby użytkownik mógł wkleić swoje poufne pliki PDF/DOCX/MD.
4. **Wiązanie ze skillem:** Zapisz w nagłówku YAML skilla pole `localKnowledgePath: src/mastra/knowledge/private/<domain>` oraz `preferLocal: true`.
