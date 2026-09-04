# Plan Napraw po Audycie Meta Agenta

> **Bazuje na:** `ideas/audit.md`  
> **Data weryfikacji:** 2026-05-03  
> **Implementacja:** 2026-05-03  
> **Status:** ✅ Wszystkie zaplanowane punkty wykonane

---

## Faza 1: Krytyczne (natychmiastowe)

### ✅ 1.1 Timeout per-tool call

**Plik:** `apps/workers/src/agents/meta-agent/react-loop.ts`  
**Problem:** Bare `await params.tools.execute(...)` — zawieszone narzędzie blokuje pętlę na zawsze.

**Wdrożono:**
- `TOOL_TIMEOUTS_MS` w `packages/shared/src/constants.ts` (default 120s, per-tool overrides)
- `Promise.race` z timeout rejection w react-loop.ts
- Przy timeout: observation = `"TIMEOUT: ..."`, pętla kontynuuje (nie przerywa)
- Emitowany event `meta:tool_timeout` dla UI

---

### ✅ 1.2 Shell allowlist zamiast blocklist

**Plik:** `apps/workers/src/agents/meta-agent/tool-registry.ts`  
**Problem:** Blocklist 3 regexów trywialnie obchodzony.

**Wdrożono:**
- `SHELL_AUTO_APPROVE` set (ls, pwd, echo, cat, head, tail, wc, grep, find, tree, df, du, date, whoami, uname, git)
- `SHELL_BLOCKED_PATTERNS` (rm z -rf, mkfs, dd z of=, fork bomb)
- Funkcja `parseShellSecurity()` — logika: blocked → error; piped/chained → strict approval; whitelist → auto-approve; pozostałe → strict
- Łańcuchowanie przez `|`, `;`, `&&`, `$()`, backtick → zawsze strict approval

---

## Faza 2: Wysokie (następny sprint)

### ✅ 2.1 Startup validation tool definitions ↔ handlers

**Plik:** `apps/workers/src/agents/meta-agent/tool-registry.ts`

**Wdrożono:**
- Funkcja `validateToolRegistry()` na końcu `tool-registry.ts`
- Wywołana w `MetaAgent constructor` — fail-fast przy starcie workera
- Rzuca błąd z listą brakujących handlerów i sierot

---

### ✅ 2.2 Inteligentne truncation obserwacji

**Plik:** `apps/workers/src/agents/meta-agent/react-loop.ts`

**Wdrożono:**
- Funkcja `smartTruncate(obs, toolName, maxLen=3000)` na końcu pliku
- JSON array → `{ _truncated: true, total: N, sample: first5 }`
- JSON object z dużym polem items/results/data/leads/entries/rows → zachowuje metadane + pierwsze 5
- Tekst fallback: head(2000) + gap marker + tail(500)
- Zastosowane w stepContext (zamiast starego `slice(0, 2000)`)

---

### ✅ 2.3 Domain propagation fix

**Plik:** `apps/workers/src/agents/meta-agent/index.ts:705`

**Wdrożono:**
- Linia zmieniona na: `input.context?.domain || (input as any).metadata?.domain || (convo?.domain)`
- Eliminuje naming mismatch między `context.domain` a `metadata.domain`

---

### ✅ 2.4 Rate limiting per-tool w pętli

**Plik:** `apps/workers/src/agents/meta-agent/react-loop.ts`

**Wdrożono:**
- `toolCallCounts: Map<string, number>` na początku pętli
- `RATE_LIMIT_EXEMPT` set (subtask.batch, crm.create_lead, memory.save, system.update_plan)
- Limit: 3 wywołania per tool
- Po przekroczeniu: observation = info o limicie, `continue` — pętla kontynuuje (agent może zmienić strategię)

---

### ✅ 2.5 Repair prompt XOR clarification

**Plik:** `apps/workers/src/agents/meta-agent/react-loop.ts`

**Wdrożono:**
- Rozbudowany prompt repair z explicite zasadą XOR
- 3 przykłady: 2 poprawnych, 1 niepoprawny z wyjaśnieniem dlaczego pusty string != null

---

## Faza 3: Średnie (backlog)

### ✅ 3.1 Cache plan/status w pętli

**Plik:** `apps/workers/src/agents/meta-agent/react-loop.ts`

**Wdrożono:**
- `db` i `cachedTask` inicjalizowane PRZED pętlą (1 roundtrip zamiast 15)
- Refresh `cachedTask` co 3 iteracje (`i % 3 === 0`)
- Cancellation check używa `cachedTask.status` z cache

---

### ⏳ 3.2 RAG — migracja do Vector Search

**Decyzja:** Odłożona do momentu gdy registry > 100 narzędzi.  
Obecne 50 narzędzi nie uzasadnia migracji. Koszt DB roundtrip < koszt migracji Atlas.

---

### ✅ 3.3 Wersjonowanie promptów

**Pliki:** `apps/workers/src/agents/meta-agent/prompts/*.md`

**Wdrożono:**
- Dodany header `<!-- prompt:{name} v1.0 updated:2026-05-03 -->` do wszystkich 7 plików promptów:
  - `react.md`, `intent-router.md`, `base.md`, `chef-domain.md`, `response.md`, `knowledge-plan.md`, `tools.md`

---

### ✅ 3.4 Chef instruction — single source of truth

**Pliki:** `packages/shared/src/agentConfig.ts`, `prompts/chef-domain.md`

**Wdrożono:**
- `agentConfig.ts` — instruction chef skrócony do 1-liniowego summary wskazującego na `chef-domain.md`
- `chef-domain.md` pozostaje jedynym źródłem pełnych reguł kulinarnych
- Komentarz w agentConfig dokumentuje relację

---

### ✅ 3.5 repairJSON — diagnostyka napraw

**Plik:** `packages/shared/src/jsonRepair.ts`

**Wdrożono:**
- Nowy export `repairJSONWithMeta(text): RepairResult` zwracający `{ data, repairs: string[], wasValid: bool }`
- `repairJSON(text)` — backward compat, nadal zwraca tylko `data`
- Każda heurystyka rejestruje nazwę naprawy w `repairs[]`
- `react-loop.ts` używa `repairJSONWithMeta` i loguje repairs jako `warn` przy automatycznej naprawie

---

### ✅ 3.6 Cost budget na pętlę

**Plik:** `apps/workers/src/agents/meta-agent/react-loop.ts`

**Wdrożono:**
- `totalTokensIn` + `totalTokensOut` accumulators przed pętlą
- `TOKEN_BUDGET` z `process.env.REACT_LOOP_TOKEN_BUDGET` (default: 100 000 tokenów)
- Na 80% progu: emit `meta:cost_warning` event
- Po przekroczeniu: return z `finalAnswer` zawierającym info o limicie

---

## Faza 4: Niskie (nice-to-have)

### ⏳ 4.1 Standaryzacja języka CRM statusów
Backlog — wymaga decyzji o migracji danych.

### ⏳ 4.2 Usunięcie `owner` field
Backlog — pole nie szkodzi, decyzja o cleanup przy następnym refactorze tool definitions.

### ✅ 4.3 Podniesienie `system.search_tools` threshold do 0.30

**Wdrożono:** Zmieniono `minScore: 0.25 → 0.30` w handlerze `system.search_tools`.

---

## Podsumowanie zmian

| Plik | Zmiany |
|------|--------|
| `packages/shared/src/constants.ts` | +`TOOL_TIMEOUTS_MS` |
| `packages/shared/src/jsonRepair.ts` | +`RepairResult`, +`repairJSONWithMeta()`, diagnostyczne `repairs[]` |
| `packages/shared/src/agentConfig.ts` | Chef instruction → single source of truth |
| `apps/workers/src/agents/meta-agent/react-loop.ts` | Timeout, smart truncation, task cache, rate limiting, cost budget, repair prompt XOR, repair diagnostics |
| `apps/workers/src/agents/meta-agent/tool-registry.ts` | Shell allowlist, `validateToolRegistry()`, search_tools threshold |
| `apps/workers/src/agents/meta-agent/index.ts` | Domain propagation fix, `validateToolRegistry()` call |
| `apps/workers/src/agents/meta-agent/prompts/*.md` | Version headers (7 plików) |
