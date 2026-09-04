# Przewodnik: Autonomiczny Kreator Specjalistów i Samorozwój Systemu (Lightweight Self-Expansion)

Architektura samorozwoju pozwala użytkownikowi (Patrykowi) na zlecenie Meta Agentowi stworzenia dowolnego specjalisty domenowego — od audytora RODO, przez eksperta od przetargów, po analityka wewnętrznych umów B2B — **w ułamku sekundy, bez pisania kodu TypeScript i bez restartu serwera Mastra**.

---

## 1. Architektura 4 Filarów Specjalisty (`SpecialistDossierV1`)

Zamiast tworzyć ciężkie klasy `.ts` dla każdej nowej roli, system dekomponuje żądanie na 4 filary:

```
Użytkownik: "Zbuduj mi agenta prawnika od RODO w Polsce"
   │
   ▼
Meta Agent (Protokół Samorozwoju §5.2)
   │
   ├─► 1. Rekonesans i 4 Złote Pytania (researcherAgent + skill: research-specialist-dossier)
   │     ├─ Kim jest rola? -> Audytor Zgodności RODO / Host: researcherAgent
   │     ├─ Jakich narzędzi potrzebuje? -> view, search, find_files
   │     ├─ Jakich procedur (SOP) potrzebuje? -> Algorytm art. 28 RODO, kary, audyt
   │     └─ Jakiej wiedzy potrzebuje? -> ISAP, UODO, wzory umów
   │
   ├─► 2. Bramka Prywatności (Interactive Privacy Gate)
   │     └─ Wykrycie danych poufnych/umów -> Zapytanie użytkownika (Cloud vs 100% Local Ollama)
   │
   ├─► 3. Konfiguracja Bazy Wiedzy
   │     ├─ [Cloud]: Google NotebookLM (knowledgeAgent)
   │     └─ [Local Private]: Utworzenie src/mastra/knowledge/private/<domain>/
   │
   └─► 4. Generowanie i Rejestracja Skilla SOP (specialist-builder + skillSaveTool)
         ├─ Zapis do src/mastra/_skills/auto/<skillId>.md
         └─ Natychmiastowy Hot-Reload w SkillRegistry (0 ms przestoju)
```

---

## 2. Jak zlecić stworzenie specjalisty (Przykłady dla Meta Agenta)

Możesz napisać do Meta Agenta prosto i naturalnie:

### Przykład A: Specjalista Publiczny (Chmura + NotebookLM)
> **Ty:** *"Potrzebuję specjalisty od przepisów KSeF (Krajowy System e-Faktur) w Polsce na 2026 rok. Zbuduj mi takiego eksperta."*

**Co zrobi system:**
1. `researcherAgent` przeprowadzi rekonesans oficjalnych stron Ministerstwa Finansów i przepisów.
2. Sklasyfikuje dane jako `public` i zarekomenduje Google NotebookLM.
3. Utworzy notatnik w NotebookLM ze zweryfikowanymi aktami prawnymi.
4. Wygeneruje procedurę SOP `_skills/auto/ksef-poland-compliance.md` i natychmiast ją aktywuje.
5. Przypisze procedurę do `researcherAgent`.

---

### Przykład B: Specjalista Prywatny (Poufne dane firmowe / 100% Offline)
> **Ty:** *"Potrzebuję asystenta do audytu naszych poufnych umów NDA i kontraktów B2B z klientami GastroBridge."*

**Co zrobi system:**
1. `researcherAgent` wykryje słowa kluczowe związane z poufnością (`internal_business` / `confidential_strict`).
2. **Meta Agent zatrzyma się i zapyta Cię:**
   > *"Zauważyłem, że to zadanie dotyczy poufnych danych biznesowych i umów. Czy chcesz, abym skonfigurował specjalistę w trybie prywatnym (100% lokalny model Ollama + lokalna baza offline), czy w chmurze?"*
3. Po potwierdzeniu trybu prywatnego:
   - Utworzy katalog: `src/mastra/knowledge/private/gastrobridge_contracts/`
   - Wygeneruje procedurę operacyjną w `_skills/auto/gastrobridge-contract-audit.md` z flagą `preferLocal: true`.
   - Zwróci Ci dokładną ścieżkę do katalogu, abyś mógł wrzucić tam swoje pliki `.docx`, `.pdf` lub `.md`.

---

## 3. Struktura Plików i Rejestrów

| Ścieżka | Rola w systemie |
|---|---|
| `src/mastra/schemas/specialist-dossier.ts` | Schemat Zod walidujący Paszport Specjalisty (`SpecialistDossierV1`) i Granicę Prywatności. |
| `src/mastra/services/specialist-builder.ts` | Deterministyczny silnik konfigurujący katalogi wiedzy, pliki SOP i rejestrację. |
| `src/mastra/tools/system/skill-save.ts` | Narzędzie `skillSaveTool` formatujące nagłówki YAML frontmatter i odświeżające pamięć `SkillRegistry`. |
| `src/mastra/services/guarded-build-core.ts` | Bezpieczny runner procesów, izolacja grup procesowych oraz bramki jakościowe (`tsc`, `check:all`). |
| `src/mastra/config/agent-source-registry.ts` | Jedno źródło prawdy dla 25 agentów bazowych (ścieżki, prompt, domena). |
| `src/mastra/config/tool-binding-registry.ts` | Scentralizowany rejestr kategorii i poziomów ryzyka narzędzi. |
| `src/mastra/knowledge/private/<domain>/` | Bezpieczne, lokalne foldery na poufne pliki użytkownika (offline RAG). |
| `src/mastra/_skills/auto/` | Generowane dynamicznie procedury operacyjne SOP (ładowane bez restartu). |

---

## 4. Testy i Komendy Weryfikacyjne

Aby przetestować integralność systemu samorozwoju w dowolnym momencie:

```bash
# 1. Test weryfikacyjny E2E kreatora specjalistów (tworzenie, katalogi, SOP, hot-reload)
npm run check:specialist-builder

# 2. Sprawdzenie synchronizacji rejestrów agentów i narzędzi (0 długu)
npm run check:registries-sync

# 3. Pełne sprawdzenie typowania TypeScript
npx tsc --noEmit
```
