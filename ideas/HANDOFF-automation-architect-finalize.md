# HANDOFF — Automation Architect: „knows when to finish" fix

Data: 2026-06-24. Dla nowej instancji Claude kontynuującej pracę. **Zacznij tutaj.**

---

## 1. Nad czym pracujemy (kontekst)

System: **Mastra agentic environment** (`/projekty/mastra-agentic-environment/agentic-agents`) — SDK agentów, które budują i deployują **workflowy n8n**.

Łańcuch który testujemy: **user → meta-agent → automationArchitect → (deleguje) → n8nMcpEngineer**.
- `meta-agent` routuje prośbę usera, deleguje build automatyzacji do `automationArchitect` (przez `system_delegate_task`).
- `automationArchitect` komponuje workflow JSON, przechodzi **Golden Path** (compose → validate → deploy INACTIVE → mock test → opcjonalna aktywacja), używając narzędzi `architect_*`.
- Dla node'ów spoza znanych patternów (np. **Google Sheets**) architekt deleguje do `n8nMcpEngineer` — read-only agenta z 7 narzędziami n8n-MCP (`search_nodes`, `get_node`, `validate_node`, `get_template`, `search_templates`, `validate_workflow`, `tools_documentation`) do walidacji typeVersion/parametrów.
- Model agentów: **deepseek-v4-pro** (`config/model-manifest.ts`).

## 2. CEL

Architekt ma **niezawodnie budować poprawne workflowy n8n** sterowany przez meta, oraz:
1. **Walidować node'y przez MCP** zamiast zgadywać typeVersion (loteria v2/v4). ✅ ZROBIONE.
2. **Wiedzieć kiedy skończyć** — po osiągnięciu `tested` napisać raport i zakończyć, BEZ wiszenia/churnu. ❌ **NIEROZWIĄZANE — to główny otwarty problem.**

## 3. Gdzie jesteśmy / branch

- Branch: **`fix/automation-delegation-lifecycle`** (NIE commitowany — `git diff` pokazuje 10 plików). `tsc --noEmit` = **0 błędów**.
- Główny plan z pełną historią: **`ideas/automation-delegation-lifecycle-fix.md`** (czytaj go — ma 5 testów live + wszystkie WS).

## 4. Co JUŻ działa (potwierdzone live, test #6 2026-06-24)

| Co | Status | Dowód |
|----|--------|-------|
| **WS-A** abort delegacji | ✅ | timeout abortuje generację (AbortSignal), zero zombie; potwierdzone wielokrotnie |
| **WS-J** node-validation gate | ✅ | googleSheets (non-core) wymusza handoff MCP przed deploy (`node_validation_required`) |
| **E1** dedykowany `n8nMcpClient` | ✅ | engineer ładuje 7 narzędzi w ~0.6s (izolowany od 6 innych serwerów MCP) |
| **F1** kontrakt weryfikuje realne tool-calle | ✅ | `n8nMcpToolsCalled: ["validate_node","get_node","search_nodes"]` — engineer REALNIE waliduje |
| **googleSheets typeVersion** | ✅ | **v4 zwalidowany przez MCP** (nie zgadnięty v2) |
| WS-B (async flag), WS-D (timeout 900s), WS-G (fail-closed) | ✅ | w kodzie, tsc 0 |

## 5. Co NIE działa — GŁÓWNY PROBLEM: architekt nie wie kiedy skończyć

**Objaw:** architekt osiąga `tested` (workflow zbudowany + zwalidowany, inactive), po czym **WISI active** (nie pisze finalnego raportu, nie kończy), aż **WS-A utnie go przy 900s** (15 min). Bez zombie, ale brzydko i wolno. W brudnym runie dodatkowo churnuje (25× execute — test #4).

**Próby naprawy (WS-C → WS-C-hard) — WSZYSTKIE celowały w mechanizm konwergencji reflektora i ZAWIODŁY:**
1. WS-C (prompt „Stop And Report On A Clean Terminal") — za miękki, model ignoruje.
2. `isAutomationTerminalDeliverable` (parsing `tested` ze steps → `deliverableSeen`) — parsing zawiódł live (toolName/status w znormalizowanym wyniku).
3. errorRate refinement (`isResolvableGateBlock`) — celował w nie-problem (`errorRateThreshold=0.5`, errorRate był poniżej).
4. **Run-scoped latch** `markAutomationDeliverable()`/`hasAutomationDeliverable()` (`services/mcp-handoff-state.ts`) — Golden Path (`buildResult`) ustawia deterministycznie, reflektor czyta. **Też nie odpalił konwergencji.**

**ROOT CAUSE (odkryty w teście #6):** konwergencja reflektora (`strategy-reflector.ts`, §A graceful convergence, warunek ~linia 950) wymaga **`reflectionsTriggered >= 2`**. W CZYSTYM przebiegu (proaktywne MCP, brak churnu) **reflektor NIE interweniuje ani razu** (`reflector_intervention: 0` w teście #6) → `reflectionsTriggered=0 < 2` → konwergencja NIGDY nie odpala, niezależnie od `deliverableSeen`. **Konwergencja to zła maszyneria dla czystego finalize** — działa tylko gdy run jest brudny (reflektor zanaga 2×, jak test #5: 7 interwencji).

## 6. NASTĘPNY KROK (rekomendacja dla nowej instancji)

Potrzebny **dedykowany mechanizm finalize NIEZALEŻNY od reflektora/konwergencji**. Latch (`hasAutomationDeliverable()`) to WŁAŚCIWY SYGNAŁ — trzeba go tylko podpiąć inaczej niż pod konwergencję. Opcje (od najpewniejszej):

- **A) Dedykowany `stopWhen` w harnessie** (`generate-with-harness.ts`, tablica `generateOptions.stopWhen` ~linia 1165): dodać predykat, który HALTuje gdy `hasAutomationDeliverable()===true` (deliverable istnieje) ORAZ brief nie wymaga aktywacji. UWAGA na ryzyko PUSTEGO finalnego tekstu — po halt trzeba wymusić raport: harness ma `goal-completion-gate` (no-tool repair pass, ~linia 1738) który syntezuje raport, ALE zwraca pusto gdy output pusty. Trzeba zsyntetyzować raport z deliverable (status/automationId/workflowId) gdy tekst pusty.
- **B) Tool-level idempotency short-circuit** w `execute-request.ts` / Golden Path: po pierwszym `tested` zapamiętać wynik run-scoped; kolejne `execute_automation_request` na tym samym spec → SHORT-CIRCUIT (zwróć cache + „STOP, already built, report now", BEZ realnego Golden Path). Kasuje churn taniej, ale nie kończy runu (potrzebne z A).
- **C)** Złagodzić warunek konwergencji: gdy `deliverableSeen` (latch) === true, NIE wymagać `reflectionsTriggered>=2` (np. >=0). Mała zmiana, ale dotyka generycznego reflektora (wszyscy agenci) — ryzyko regresji.

Rekomendacja: **A + B razem** (B kasuje churn, A kończy run z raportem). Najpierw zweryfikować, czy latch (`hasAutomationDeliverable`) faktycznie zwraca true w runie (dodać log) — bo jeśli ALS key się rozjeżdża między Golden Path a stopWhen, latch zawiedzie. (WS-J `hasSuccessfulMcpHandoff` działa przez ten sam ALS, więc keying prawdopodobnie OK.)

## 7. MONITOR (kod obserwacyjny)

**Plik: `/tmp/auto-monitor.mjs`** (poza repo, w /tmp). Node ESM, używa `createRequire` by rozwiązać `mongodb` z `agentic-agents/node_modules`. Czyta Mongo (`agentforge`) + n8n REST, loguje synchronicznie do **`/tmp/auto-monitor.log`** (+ stdout).
- Uruchom (w tle): `node /tmp/auto-monitor.mjs watch` — śledzi od TERAZ: delegacje (`agent_events`), kontrakty (`goal_contracts`), Golden Path (`automation_requests`), nowe workflowy n8n. Filtruje szum meta-agenta.
- Tryb `oneshot <secondsAgo>` — jednorazowy zrzut wstecz.
- Przed uzbrojeniem zabij stary: `pgrep -f 'auto-monitor.mjs'` + kill (PID-safe — wzorzec `auto-monitor.mjs` dopasowuje też własny shell, kasuj po sprawdzeniu `/proc/$p/cmdline`).
- W praktyce: **monitor bywał flaky** (ginął). Pewniejsze jest **bezpośrednie odpytywanie Mongo** przez `mongosh` (patrz §9).

## 8. Jak testować live (WAŻNE constraints)

1. **DuckDB single-writer**: `mastra.duckdb` (2.3GB). Działający serwer trzyma lock → NIE odpalaj skryptów importujących `index.js` jako osobny proces (skonfliktują). Testuj PRZEZ działający serwer :4111.
2. **Architekt KOPIUJE istniejące workflowy** (robi `n8n_get_workflow` po ID z pamięci). Przed każdym testem **USUŃ workflow cateringowy z n8n** (inaczej skopiuje googleSheets i ominie MCP). UI n8n ma tylko „Archive" (nie usuwa z API!) — usuwaj przez API DELETE.
3. Sekwencja testu: usuń catering wf → user restartuje Mastrę (ładuje kod z working tree) → uzbrój monitor → user wysyła prompt do meta (Studio/dashboard chat) → obserwuj Mongo.

**Usunięcie workflow (API):**
```bash
KEY=$(grep -E '^N8N_API_KEY=' .env | head -1 | cut -d= -f2-)
# lista catering/googleSheets:
curl -s -H "X-N8N-API-KEY: $KEY" http://localhost:5678/api/v1/workflows | node -e '...' # filtr po nazwie/Catering lub node googleSheets
curl -s -X DELETE -H "X-N8N-API-KEY: $KEY" http://localhost:5678/api/v1/workflows/<ID>
```

**Prompt testowy (catering — niezawodnie wyzwala MCP przez googleSheets):**
> Ok, coś trudniejszego. Potrzebuję workflow w n8n do obsługi zapytań cateringowych z formularza na stronie. Jak wpadnie zgłoszenie (webhook), to: zwaliduj dane, dociągnij z zewnętrznego API publiczne informacje o firmie, która pyta, a potem oceń lokalnym modelem przez Ollamę, czy to gorący lead czy zwykły. Jeśli gorący — wyślij mi od razu alert na Telegram i maila do działu sprzedaży; jeśli zwykły — tylko zapisz. Każde zgłoszenie zapisz do mojej bazy Mongo i dodatkowo dopisz wiersz do mojego arkusza Google Sheets, który mam jako prosty rejestr leadów. Zadbaj o sytuację, gdy zewnętrzne API nie odpowie. Na razie tylko zbuduj i pokaż, nie włączaj.

## 9. Mongo — zapytania obserwacyjne (źródło prawdy)

DB `agentforge` (`mongodb://localhost:27017/agentforge`). Klucz: `_id > ObjectId.createFromTime(epochSec)` filtruje „od czasu". Pola czasu to obiekty Date → używaj `new Date(x).toISOString()`.
- `goal_contracts`: delegacje (agentId, status active/completed/failed, evidenceFor/Against, originalGoal). Architekt hang = status `active` na długo.
- `agent_events`: tool calls (type `tool_call_completed`, toolId), `delegation` (data.n8nMcpToolsCalled ← dowód realnych narzędzi MCP), `reflector_intervention`/`reflector_triggered`/`reflector_convergence_stop`.
- `automation_requests`: wyniki Golden Path (status `tested`/`blocked`, failureClass `node_validation_required`/`mcp_handoff_failed`/`pattern_coverage_gap`).
- Kluczowe metryki przy debugowaniu finalize: `reflector_intervention` count (musi być ≥2 dla konwergencji — w czystym runie jest 0!), `convergence` events, czy `tested`, czy architekt status `active` (hang).

## 10. Mapa plików (zmiany tej sesji)

- `services/strategy-reflector.ts` — WS-C-hard: `isAutomationTerminalDeliverable`, `isResolvableGateBlock`, czyta `hasAutomationDeliverable()` w `evaluateHistory` + `shouldConvergeStop`. **Tu jest warunek konwergencji `reflectionsTriggered>=2` — root cause.**
- `services/mcp-handoff-state.ts` — run-scoped latche (ALS via `harness-execution-context.ts`): `markMcpHandoffFailed/Succeeded`, `hasSuccessfulMcpHandoff`, **`markAutomationDeliverable`/`hasAutomationDeliverable`**, `isMcpHandoffFailed`, `mcpHandoffGateEnabled`.
- `services/automation-golden-path.ts` — WS-J gate (`CORE_NODE_TYPES`, `nonCoreNodeTypes`, `node_validation_required`), WS-G gate; `buildResult` ustawia `markAutomationDeliverable()` przy tested/draft_created/active.
- `services/generate-with-harness.ts` — WS-A (`withTimeout` + AbortController), stopWhen array (~1165), goal-completion-gate (~1738).
- `mcp.ts` — dedykowany `n8nMcpClient` (E1), `n8nMcpEnabled`.
- `agents/n8n-mcp-engineer.ts` — loader na dedykowanym kliencie + retry + fail-loud.
- `tools/system/delegate-task.ts` — `generateWithAbortableTimeout`, F1 (`extractCalledToolNames` + kontrakt `n8n_mcp_handoff_no_real_tool_use`), mark MCP handoff fail/success.
- `prompts/automation/base.md` — reakcje na `node_validation_required` / `mcp_handoff_failed`.
- `config/harness-flags.ts` — `FEATURE_AUTOMATION_ASYNC_DEFAULT`.

## 11. Env flagi (w `.env`, default-on gdzie trzeba)

`FEATURE_N8N_MCP=true`, `N8N_MCP_ENABLED=true`, `N8N_MCP_MODE=readonly`, `N8N_MCP_VALIDATE_WORKFLOW_MODE=advisory`, `AUTOMATION_COVERAGE_GATE_MODE=block`, `FEATURE_DELEGATION_LLM_PLAN=true`, `DELEGATION_AUTOMATION_TIMEOUT_MS=900000`, `FEATURE_AUTOMATION_ASYNC_DEFAULT=false`, `FEATURE_MCP_HANDOFF_GATE=true`, `NODE_VALIDATION_GATE_MODE=block`.

## 12. Infra (porty)

Mastra API/Studio `localhost:4111` (`mastra dev`, health: `GET /deploy/health`), n8n `localhost:5678` (kontener `af-n8n`, API key w `.env` `N8N_API_KEY`), Mongo `localhost:27017/agentforge`, Ollama `localhost:11434`. Pamięć projektu: `/home/linus/.claude/projects/-projekty-mastra-agentic-environment/memory/` (zwłaszcza `project_automation_mcp_status.md`, `automation_architect_stack.md`).

## 13. Workflowy testowe w n8n (do sprzątnięcia przed testem)

Ostatni (test #6): `Catering Lead Form Handler` `nlubQYZZQNfTqYSn` (googleSheets **v4**, inactive) — USUŃ przed kolejnym testem.
