# MODEL CONFIGURATION — mapa miejsc, gdzie ustawiamy modele

> **Cel:** Jeden punkt prawdy, gdzie w repo ustawiany jest model LLM. Pozwala
> zaplanować przejście części agentów / scorerów / workflowów na **lokalne
> modele Ollama** (gemma4, qwen3, qwen3-coder...) bez gubienia gdziekolwiek
> hardcodowanych stringów.
>
> **Zasada:** Mastra używa formatu `provider/modelId` (np. `google/gemini-2.5-pro`).
> Dla Ollama będzie to `ollama/<tag>` — patrz sekcja 5 (recipe na własny gateway).
>
> **Konwencja:** ⭐ = punkt rekomendowany do podmiany na lokalny LLM,
>                🔒 = zostawić gemini (planning, krytyczne decyzje, scorers),
>                🤖 = generuje konfigurację dla n8n (nie wpływa na działanie Mastry).
>
> 🛡️ **Odporność na awarie i Rate Limity (429):** Szczegółowy opis mechanizmu automatycznego
> fallbacku dla strumieniowania i generowania w Mastra Studio znajduje się w dokumencie
> [`RESILIENT-MODEL-FALLBACK.md`](RESILIENT-MODEL-FALLBACK.md).

---

## 1. Agenci (`src/mastra/agents/*.ts`)

Aktualny runtime bierze mapowanie z `src/mastra/config/model-manifest.ts`. Dla `knowledgeAgent` wybrany jest `gemini-3.1-flash-lite-preview`, bo lokalny `gemma4-26b` nie wykonywal stabilnie NotebookLM tool calls.

Design domain update (2026-06-18): `model-manifest.ts` zawiera już
`agentModels.designAgent = claude-opus-4.8`, `workerPresets.design =
claude-sonnet-4.6`, fallback `designAgent: Opus → Sonnet → GPT-5.5` oraz
`designAssignments` dla HTML generation, advisor, critique, image generation i
ElevenLabs TTS. `agents/design-agent.ts` jest zarejestrowany w Mastra i routowalny
przez `system_delegate_task`; stan walidacji opisuje [`DESIGN-AGENT.md`](DESIGN-AGENT.md).
Modele obrazów w `designAssignments.imageGen` / `imageGenPhoto` można przełączać
między aliasami Google/Imagen/OpenAI obsługiwanymi przez `design_generate_image`.

> ⚠️ **Tabela poniżej jest HISTORYCZNA — zweryfikowane 2026-07-29: nieaktualna w całości.**
> Opisuje architekturę **przed** `model-manifest.ts`, w której każdy plik agenta miał
> zaszyty string modelu. Dziś **żaden** z wymienionych plików go nie ma — wszystkie robią
> `model: resolveModelId(agentModels.<agent>)`, więc kolumny „Linia" i „Aktualnie" są błędne
> dla każdego wiersza (sprawdzone: meta-agent :139, automation-architect :61, sales-agent :19,
> analytics-agent :17, crm-agent :16, weather-agent :22; marketing-agent bierze model
> parametrem fabryki). **Jedynym punktem prawdy jest `agentModels` w
> [`config/model-manifest.ts`](../src/mastra/config/model-manifest.ts).** Kolumna
> „Rekomendacja" zachowana, bo nadal opisuje *intencję* doboru modeli — ale nie stan kodu.

| Plik | Linia | Aktualnie | Rola | Rekomendacja |
|---|---|---|---|---|
| [`agents/meta-agent.ts`](../src/mastra/agents/meta-agent.ts) | 89 | `'google/gemini-2.5-pro'` | Supervisor, planowanie, ToolSearchProcessor | 🔒 **Gemini Pro** — supervisor potrzebuje long-context i dobrego tool-callingu. |
| [`agents/automation-architect.ts`](../src/mastra/agents/automation-architect.ts) | 24 | `'google/gemini-2.5-pro'` | Buduje workflow n8n, ocenia ryzyko | 🔒 **Gemini Pro** — krytyczne decyzje (deploy/block). |
| [`agents/marketing-agent.ts`](../src/mastra/agents/marketing-agent.ts) | 30 | `'ollama/local/gemma4:26b'` | Producer-hunt, cold-emaile, content | ✅ **Lokalny** (gemma4:26b). |
| [`agents/sales-agent.ts`](../src/mastra/agents/sales-agent.ts) | 20 | `'ollama/local/gemma4:26b'` | Oferty, onboarding | ✅ **Lokalny** (gemma4:26b). |
| [`agents/analytics-agent.ts`](../src/mastra/agents/analytics-agent.ts) | 15 | `'ollama/local/qwen3-coder:30b'` | Raporty KPI, anomalie | ✅ **Lokalny** (qwen3-coder:30b). |
| [`agents/crm-agent.ts`](../src/mastra/agents/crm-agent.ts) | 15 | `'ollama/local/gemma4:26b'` | Wyszukiwanie leadów | ✅ **Lokalny** (string-id przez OllamaGateway). |
| [`agents/weather-agent.ts`](../src/mastra/agents/weather-agent.ts) | 21 | `'google/gemini-2.5-pro'` | Demo / wzorzec evali | 🔒 Zostaw — to wzór, nie produkcja. |

---

## 2. Scorery (`src/mastra/scorers/*.ts`)

LLM-judge — ocenia jakość. **Zostawić Gemini Pro** dla wszystkich (judge musi być silniejszy niż agent oceniany, inaczej noisy scoring).

| Plik | Linia | Aktualnie | Co ocenia | Rekomendacja |
|---|---|---|---|---|
| [`scorers/weather-scorer.ts`](../src/mastra/scorers/weather-scorer.ts) | 21 | `'google/gemini-2.5-pro'` | Translation quality | 🔒 Demo — bez ruchu. |
| [`scorers/meta-agent-scorer.ts`](../src/mastra/scorers/meta-agent-scorer.ts) | 26 | `'google/gemini-2.5-pro'` | Tool-call appropriateness | 🔒 |
| [`scorers/marketing-agent-scorer.ts`](../src/mastra/scorers/marketing-agent-scorer.ts) | 22 | `'google/gemini-2.5-pro'` | Drafting completeness | 🔒 |
| [`scorers/automation-architect-scorer.ts`](../src/mastra/scorers/automation-architect-scorer.ts) | 28 | `'google/gemini-2.5-pro'` | Risk soundness (Golden Path) | 🔒 |

---

## 3. Embedder (`src/mastra/lib/embedder.ts`)

| Plik | Co | Aktualnie | Rekomendacja |
|---|---|---|---|
| [`lib/embedder.ts`](../src/mastra/lib/embedder.ts) | Embedder dla Pattern RAG, Memory, ToolSearch | `text-embedding-004` (Google) | ⭐ **Łatwy lokalny:** `bge-m3:latest` (1.2 GB) lub `nomic-embed-text:latest` (300 MB) przez Ollama. Wymiary różne (768 vs 1024) — przy zmianie potrzebny `architect.sync_patterns --force` żeby przeembeddować katalog. |

---

## 4. Generatory n8n workflowów (🤖 nie wpływają na Mastrę)

To są stringi wstawiane do JSON-a workflowu n8n — odpalane PRZEZ n8n, nie przez Mastrę. Zmiana wpływa tylko na to, jaki model będzie wołał n8n po deployu workflow.

| Plik | Linie | Co | Rekomendacja |
|---|---|---|---|
| [`tools/architect/builders/helpers.ts`](../src/mastra/tools/architect/builders/helpers.ts) | 147 | `cfg.defaultLocalModel` (zmienna z env) | ⭐ Już zmienna; wystarczy ustawić `N8N_DEFAULT_LOCAL_MODEL` w `.env`. |
| [`tools/architect/builders/extendedPatterns.ts`](../src/mastra/tools/architect/builders/extendedPatterns.ts) | 219, 337, 503, 679 | `${cfg.defaultLocalModel}` / `${cfg.reasoningLocalModel}` | j.w. |
| [`tools/architect/builders/advancedPatterns.ts`](../src/mastra/tools/architect/builders/advancedPatterns.ts) | 49, 290, 667, 681, 723, 899, 1008, 1114 | j.w. | j.w. |

**Centralna konfiguracja:** funkcja `getN8nConfig()` w [`builders/helpers.ts`](../src/mastra/tools/architect/builders/helpers.ts) — zmień tylko ten jeden plik.

---

## 5. Skills / dokumentacja n8n

Hardcodowane stringi w plikach edukacyjnych dla agenta architect. **Bez wpływu na runtime** — to przykłady w markdown / JSON template:

| Plik | Linia | String |
|---|---|---|
| [`_skills/n8n/n8n-expression-syntax.md`](../src/mastra/_skills/n8n/n8n-expression-syntax.md) | 74 | `gemma4:26b` |
| [`_skills/n8n/n8n-node-catalog.md`](../src/mastra/_skills/n8n/n8n-node-catalog.md) | 145 | `gemma4:26b` |
| [`_skills/n8n-blocks/processors/ollama-call.json`](../src/mastra/_skills/n8n-blocks/processors/ollama-call.json) | 12 | `{{defaultLocalModel}}` (template) |

---

## 6. Workflowy (dziedziczenie po agentach)

Workflowy nie definiują własnych modeli — wołają `marketingAgent.generate(...)` itp. → **dziedziczą** model z agenta.

Konsekwencja: jeśli zmienisz `marketingAgent.model`, automatycznie zmienisz model w:

- [`workflows/producer-hunt.ts`](../src/mastra/workflows/producer-hunt.ts) — wszystkie 10 stepów (discover, enrich, extract, draft)
- [`workflows/marketing/morning-briefing.ts`](../src/mastra/workflows/marketing/morning-briefing.ts)
- [`workflows/marketing/automated-followup.ts`](../src/mastra/workflows/marketing/automated-followup.ts)
- [`workflows/marketing/inbox-monitor.ts`](../src/mastra/workflows/marketing/inbox-monitor.ts)
- [`workflows/marketing/sync-crm.ts`](../src/mastra/workflows/marketing/sync-crm.ts)
- [`workflows/weekly-content.ts`](../src/mastra/workflows/weekly-content.ts)

Analogicznie sales i analytics workflowy → po zmianie odpowiednich agentów.

**Producer-hunt:** plik ma jedną metadanową stałą `'gemini-2.5-pro'` w
[`workflows/producer-hunt.ts:408`](../src/mastra/workflows/producer-hunt.ts) — jest to TYLKO etykieta zapisywana do `draft.meta.json` (informacyjna). Jeśli zmienisz model agenta, zmień też tę etykietę dla spójności logów.

---

## 7. Lokalne modele dostępne (Ollama, sprawdzone)

```
gemma4:e4b                              9.6 GB   8B params Q4_K_M
gemma4:26b                             18.0 GB   ⭐ rekomendowane do PL copy
huihui_ai/qwen3.5-abliterated:9b        6.6 GB
huihui_ai/qwen3.5-abliterated:35b      23.9 GB   ⭐ najmocniejszy lokalny
gemma3:4b                               3.3 GB   ekspresowy, słaby
qwen3:1.7b                              1.4 GB   tylko tooling
qwen3-coder:30b                        18.6 GB   ⭐ analytics + builders
bge-m3:latest                           1.2 GB   embeddings (multilang)
nomic-embed-text:latest                 0.3 GB   embeddings (lekki)
```

**Status systemowy:** Ollama jest `active` + `enabled` (systemd) — startuje z systemem, nic nie trzeba konfigurować.

---

## 8. Recipe — jak podpiąć lokalne Ollama do dropdowna w Mastra Studio

Mastra ma `MastraModelGateway` API — można zarejestrować własny gateway, który zgłasza modele Ollama jako `ollama/<tag>` w UI dropdownie i routuje wywołania na lokalny port `:11434`.

### Krok 1: instalacja

```bash
cd /projekty/mastra-agentic-environment/agentic-agents
pnpm add @ai-sdk/openai-compatible ollama-ai-provider-v2
```

> **UWAGA:** `ollama-ai-provider-v2` jest też potrzebny do naprawy istniejącego `crm-agent.ts` (importuje go, ale pakiet nie jest zainstalowany).

### Krok 2: nowy plik `src/mastra/lib/ollama-gateway.ts`

```ts
import { MastraModelGateway } from '@mastra/core/llm/model/gateways';
import type { ProviderConfig } from '@mastra/core/llm/model/gateways';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

export class OllamaGateway extends MastraModelGateway {
  getId() {
    return 'ollama';
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    const { models } = (await res.json()) as { models: Array<{ name: string }> };
    return {
      ollama: {
        id: 'ollama',
        name: 'Ollama (local)',
        models: models.map((m) => m.name),
        gateway: 'ollama',
      },
    };
  }

  buildUrl(_modelId: string) {
    return `${OLLAMA_BASE_URL}/v1`;
  }

  async getApiKey() {
    return 'ollama'; // dummy — Ollama nie wymaga klucza
  }

  async resolveLanguageModel({ modelId, providerId }: { modelId: string; providerId: string }) {
    return createOpenAICompatible({
      name: providerId,
      apiKey: 'ollama',
      baseURL: this.buildUrl(modelId),
      supportsStructuredOutputs: false,
    }).chatModel(modelId);
  }
}
```

### Krok 3: rejestracja w `src/mastra/index.ts`

```ts
import { OllamaGateway } from './lib/ollama-gateway';
// ... po `export const mastra = new Mastra({...})`:
mastra.addGateway(new OllamaGateway());
```

### Krok 4: użycie

W kodzie (po podmianie modelu agenta):
```ts
model: 'ollama/gemma4:26b',
```

W Mastra Studio (UI) — w dropdownie chatu pojawią się wszystkie 9 modeli z `ollama list`.

---

## 9. Plan migracji na lokalne (rekomendowany)

**Faza 1 — eksperyment, niskie ryzyko (1 dzień):**
1. Naprawa `crm-agent.ts` (instalacja brakującego provider'a).
2. Zarejestrowanie `OllamaGateway` (sekcja 8).
3. Test w Mastra Studio z `ollama/gemma4:26b` na crm-agencie.

**Faza 2 — agenci egzekucyjni (1-2 dni):**
4. Marketing-agent → `ollama/gemma4:26b` (z fallbackiem na Flash w `try/catch` per generate-call).
5. Sales-agent → `ollama/gemma4:26b`.
6. Analytics-agent → `ollama/qwen3-coder:30b`.
7. Producer-hunt — przetestować na 3 leadach end-to-end.

**Faza 3 — embeddings lokalne (opcjonalnie, oszczędność kosztów Google):**
8. Podmiana `lib/embedder.ts` na `bge-m3` przez Ollama.
9. `architect.sync_patterns --force` (re-embedding katalogu 43 patternów).
10. Re-indeksacja Memory (jeśli używasz `semanticRecall`).

**NIE rusza:**
- `metaAgent`, `automationArchitect` — krytyczne decyzje (zostają Gemini Pro).
- Wszystkie scorery (judge musi być silniejszy).

---

## 10. Worker presets — `system.run_worker` (meta-agent v3)

Ad-hoc blank executors spawned by meta-agent. Nie mają własnej osobowości ani narzędzi — meta pisze cały brief.

| Preset | Model | Rozmiar | Najlepszy do |
|---|---|---|---|
| `fast` | `ollama/local/gemma4:e4b` | 8B / 9.6 GB | Klasyfikacja, JSON extraction, proste streszczenia, reformatowanie |
| `default` | `ollama/local/gemma4:26b` | 26B / 18 GB | Polski copy, ogólna generacja, wieloetapowe instrukcje |
| `reasoning` | `ollama/local/qwen3-coder:30b` | 30B / 18.6 GB | Analiza, matematyka, kod, złożone plany strukturalne |
| `powerful` | `ollama/huihui_ai/qwen3.5-abliterated:35b` | 35B / 23.9 GB | Długie formy, trudne reasoning, kreatywne pisanie |
| `cloud` | `google/gemini-2.5-flash` | — | Fallback gdy lokalne modele zawodzą lub za wolne |

**Gdzie zdefiniowane:** `src/mastra/tools/system/run-worker.ts` → stała `PRESET_TO_MODEL`

**Zmiana presetu:** edytuj tylko tę mapę — nie dotykaj promptu meta-agenta.

---

## 11. Quick reference — ENV vars

```bash
# Wymagane
GOOGLE_GENERATIVE_AI_API_KEY=...     # dla Gemini agentów + scorerów
MONGODB_URI=mongodb://localhost:27017/agentforge

# Ollama (gateway + crm-agent)
OLLAMA_BASE_URL=http://localhost:11434

# n8n builder defaults (sekcja 4)
N8N_DEFAULT_LOCAL_MODEL=gemma4:26b
N8N_REASONING_LOCAL_MODEL=qwen3-coder:30b
```

---

**Ostatnia aktualizacja:** 2026-05-05 — meta-agent v3: run_worker presets, recall_worker_lessons, parallel delegation.
