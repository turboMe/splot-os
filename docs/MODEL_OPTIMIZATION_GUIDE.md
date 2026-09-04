# 🏛️ Strategia i Optymalizacja Doboru Modeli LLM (Model Optimization & Rationale)

Oto kompleksowe zestawienie wszystkich dostępnych w środowisku modeli (lokalnych Ollama oraz chmurowych), ich zalet, wad, relacji ceny do jakości oraz optymalnych przydziałów w architekturze agentowej Mastra.

---

## 📌 1. Strategia "Złotego Środka" (Cost / Performance Balance)

Współczesny agentowy system operacyjny powinien opierać się na 3-poziomowej drabinie kosztowo-wydajnościowej (Tiered Model Architecture):

```
       [ Level 3: Heavy Duty / Architect ] 
       Claude Sonnet 4.6 / Gemini 2.5 Pro / DeepSeek V4 Pro
                   ▲
                   │ (Gdy zadanie wymaga głębokiej logiki lub architektury)
                   │
       [ Level 2: Workhorse / Daily Driver ]
       Gemini 2.5/3.5 Flash / DeepSeek V4 Flash
                   ▲
                   │ (Gdy zapytanie przekracza możliwości lokalne)
                   │
       [ Level 1: Zero-Cost / Local First ]
       Ollama (Gemma 4 12B, Qwen-AgentWorld, Bielik 11B)
```

---

## 🏡 2. Matryca Modeli Lokalnych (Ollama - $0 Cost)

| Model | Zmienna / Alias | Rozmiar / VRAM | Kontekst | Główne Zalety | Słabe Strony | Najlepsze Zastosowanie |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Gemma 4 12B** | `gemma4-12b` | 7.6 GB / 8 GB | **64k** | Szybki, świetny w TS/JSON, wszechstronny | Złożone refaktoryzacje wieloplikowe | Codzienny lokalny worker, `weatherAgent`, parsowanie struktur |
| **Qwen-AgentWorld 35B** | `qwen-agentworld` | 22 GB / 16 GB | **32k** | **Symulator środowiska!** Trenowany pod CLI/Git/MCP | Pisanie tekstów i artykułów | **Dry-Run & Sandbox:** Przewidywanie skutków komend narzędzi przed ich wykonaniem |
| **Bielik 11B v3.0** | `bielik-11b` | 11 GB / 12 GB | **32k** | Najlepsza naturalna polszczyzna | Pisanie kodu w języku angielskim | `marketingAgent` i `salesAgent` w polskojęzycznych tekstach / mailach |
| **Gemma 4 E4B** | `gemma4-e4b` | 9.6 GB / 10 GB | **64k** | Architektura MoE, niski koszt aktywacji | Wolniejszy start | Pomocnik `automationArchitect` i `n8nMcpEngineer` |
| **Qwen 3 Coder 30B** | `qwen3-coder-30b` | 18 GB / 18 GB | 4k / 16k | Potężny w kodowaniu i TypeScript | Duże zużycie VRAM na karcie 16GB | Tryb *Offline Fallback* do łatania kodu bez chmury |
| **Qwen 3 1.7B** | `qwen3-1.7b` | 1.4 GB / 2 GB | 32k | Ultra-szybki (~1s), zerowy koszt | Złożona logika i rozumowanie | Szybki klasifikator intencji, parser prostych struktur JSON |

---

## ☁️ 3. Matryca Modeli Chmurowych (Google, OpenAI, Anthropic, DeepSeek)

| Dostawca | Model | Cena / 1M tokenów (In/Out) | Okno Kontekstowe | Kluczowa Zaleta | Rola w Systemie |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Google** | **Gemini 2.5 Flash / 3.5 Flash** | **$0.075 / $0.30** | **1 000 000** | Ultra-tani, ogromne okno, stabilny Tool Calling | **Główny koń roboczy (Daily Driver)** dla większości agentów |
| **Google** | **Gemini 2.5 Pro** | **$1.25 / $5.00** | **1 000 000** | Świetne rozumowanie i analiza całości repozytorium | Złożona analiza architektoniczna, zadania wieloplikowe |
| **DeepSeek** | **DeepSeek V4 Flash / Pro** | **$0.14 / $0.43** | **1 000 000** | Tani wariant z funkcją Thinking Mode | `codingAgent`, `metaAgent`, `codeReviewAgent` |
| **Anthropic**| **Claude Sonnet 4.6** | **$3.00 / $15.00** | **200 000** | Wybitna estetyka, czucie kodu i UI/UX | `designAgent`, zaawansowany refactoring i przegląd kodu |
| **OpenAI** | **GPT-5.4-mini / o3-mini** | **$0.15 / $0.60** | **128 000** | Świetny w precyzyjnym wypluwaniu trudnych struktur JSON | Zadania parsowania i weryfikacja schematów Zod |

---

## 🎯 4. Przydziały Modeli (Złoty Środek Ceny do Jakości)

> ⚠️ **To jest PROPOZYCJA doboru, nie zrzut stanu kodu — zweryfikowane 2026-07-29:
> 12 z 15 wpisów poniżej różni się od rzeczywistości** (zgadzają się tylko `codingAgent`,
> `codeReviewAgent`, `deliberationAgent`). Blok poniżej nigdy nie został
> przyjęty w całości. Realne przypisania (`agentModels`) żyją w
> [`config/model-manifest.ts`](../src/mastra/config/model-manifest.ts) i tam należy je
> czytać/zmieniać. Największe rozbieżności: `metaAgent`/`automationArchitect`/
> `capabilitySmith`/`designAgent` są na `deepseek-v4-pro` (nie gemini/claude),
> `marketingAgent`/`salesAgent`/`crmAgent` **nie** są na `bielik-11b`/`qwen3-1.7b`,
> a `weatherAgent`+`analyticsAgent` przeszły 2026-07-29 na `gemini-3.1-flash-lite`
> (były na nieistniejącym modelu `openrouter/cerebras/llama-3.1-70b` — patrz komentarz
> w manifeście). Traktuj ten blok jako uzasadnienie *strategii warstw*, nie jako konfigurację.

```typescript
export const agentModels = {
  // ── Orkiestracja i Kodowanie (DeepSeek V4 Pro / Gemini 3.5 Flash) ──
  metaAgent: 'gemini-3.5-flash',       // Świetny w natywnym Tool-Calling i rozstrzyganiu intencji
  codingAgent: 'deepseek-v4-pro',      // Lider w logice kodowania i rozumowaniu (Thinking Mode)
  codeReviewAgent: 'deepseek-v4-pro',  // Bezkompromisowy przegląd kodu i wykrywanie błędów
  
  // ── Automatyzacje i Narzędzia (Dry-run + Gemini/DeepSeek) ──
  automationArchitect: 'gemini-3.5-flash',
  n8nMcpEngineer: 'gemini-3.5-flash',
  capabilitySmith: 'gemini-3.5-flash',

  // ── Agenci Lokalni / Hybrydowi (Darmowi lub Ultra-tani) ──
  marketingAgent: 'bielik-11b',        // Lokalny polski ekspert od tekstów (0 zł)
  salesAgent: 'bielik-11b',            // Lokalny polski ekspert od ofert (0 zł)
  weatherAgent: 'gemma4-12b',          // Szybki lokalny model (0 zł)
  analyticsAgent: 'gemini-2.5-flash-lite', // Ultra-tani chmurowy (ułamek centa)
  crmAgent: 'qwen3-1.7b',              // Szybki lokalny lookup (0 zł)

  // ── Agenci Specjalistyczni ──
  designAgent: 'claude-sonnet-4.6',    // Złoty standard dla poczucia estetyki i kodu UI
  researcherAgent: 'gemini-3.5-flash', // Duże okno kontekstowe pod wyniki wyszukiwania
  knowledgeAgent: 'gemini-3.5-flash',
  deliberationAgent: 'deepseek-v4-pro',
};
```

---

## 🛡️ 5. Zastosowanie Nowego Modela `qwen-agentworld`

Ze względu na swoją unikalną specyfikę (**Language World Model**), model `qwen-agentworld` w Twojej sieci agentowej powinieneś przypisać do **weryfikacji dry-run**:

1. **`workflowAssignments.coding.dryRun`:** Przewidywanie stanu środowiska terminala/git przed aplikacją patcha.
2. **`workerPresets.dryRunSimulator`:** Worker uruchamiany przez `automationArchitect`, który sprawdza poprawność zapytań HTTP/MCP przed wywołaniem prawdziwych webhooków.
