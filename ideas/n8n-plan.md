# 🎯 Ostateczny Plan: n8n Workflow Builder — Refaktoryzacja

**Status:** PLAN ZATWIERDZONY | **Data:** 2026-05-02

---

## Filozofia

```
BYŁO:  User → Meta Agent → architect.plan_automation() → czarna skrzynka → JSON lub null
BĘDZIE: User → Meta Agent (ReAct) → sam decyduje które narzędzia wywołać, w jakiej kolejności
```

**Nie usuwamy kodu** — rozmontowujemy `AutomationArchitectAgent` na **6 granularnych narzędzi** i dajemy Meta Agentowi pełną kontrolę nad procesem. Cała logika (35 wzorców, risk rules, builders, PatternRAG) zostaje — zmienia się tylko sposób orkiestracji.

---

## Co się zmienia

| Element | Przed | Po |
|---|---|---|
| `AutomationArchitectAgent` klasa | Czarna skrzynka wywoływana jednym toolem | Jej metody stają się osobnymi narzędziami |
| `architect.plan_automation` | Monolityczny tool (plan→audit→match→build) | **Usunięty** — zastąpiony przez 6 narzędzi |
| `architect.deploy_automation` | Bez zmian | Dodajemy walidację przed deployem |
| `architect.sync_patterns` | Bez zmian | Dodajemy sync n8n-skills |
| Skille n8n | Brak | 5 plików `.md` w registry |
| Node schemas | Brak | Lokalna baza + tool `n8n.lookup_node` |
| Walidator workflow | Brak | Deterministyczny (bez LLM) |
| Compose | Brak | Tool do składania z bloków |
| Lokalne modele | Nie używane do automatyzacji | `subtask.delegate` do ekstrakcji/review |

---

## Nowe narzędzia Meta Agenta (6 szt.)

### 1. `n8n.plan_spec` — wyciągnij specyfikację z opisu

```
Co robi: Zamienia tekst użytkownika na AutomationSpec (JSON)
LLM:     Cloud model (plannerModel) — to jest zadanie rozumowania
Źródło:  Istniejąca metoda planAutomation() z AutomationArchitectAgent
Zwraca:  { spec: AutomationSpec }
```

Różnica vs stare `architect.plan_automation`: zwraca **TYLKO** spec, nie buduje workflow. Meta Agent decyduje co dalej.

### 2. `n8n.match_pattern` — znajdź pasujący wzorzec

```
Co robi: Szuka wzorca w katalogu (RAG + static) na podstawie spec
LLM:     Lokalny model do selectPatternFromRag (klasyfikacja — 8B OK)
Źródło:  Istniejące matchPattern() + PatternRAGService
Zwraca:  { patternId, patternName, confidence, knowledgeCard?, workflowJson? }
```

Jeśli pattern ma `build()` → od razu zwraca gotowy `workflowJson`. Meta Agent decyduje: deploy, validate, czy compose dalej.

### 3. `n8n.lookup_node` — sprawdź schema node'a

```
Co robi: Zwraca typeVersion, wymagane params, example config dla danego typu node'a
LLM:     ❌ Brak — czysto deterministyczne
Źródło:  Lokalna baza (zbudowana z n8n-skills + n8n docs)
Zwraca:  { type, typeVersion, requiredParams, optionalParams, exampleConfig }
```

To jest kluczowe — agent NIE ZGADUJE parametrów node'a. Pyta bazę.

### 4. `n8n.compose_workflow` — złóż workflow z bloków

```
Co robi: Składa workflow z named blocks + user params
LLM:     ❌ Brak — deterministyczny composer
Input:   { blocks: ["webhook-trigger", "if-condition", "telegram-message"], params: {...} }
Zwraca:  { workflowJson, nodeCount, connectionCount }
```

Bloki to walidowane fragmenty JSON (1-3 node'y) w `registry/n8n-blocks/`.

### 5. `n8n.validate_workflow` — sprawdź przed deployem

```
Co robi: Deterministyczna walidacja workflow JSON
LLM:     ❌ Brak
Sprawdza: node types, typeVersions, connections, expressions, credentials, security rules
Zwraca:  { valid: boolean, errors: [...], warnings: [...], securityIssues: [...] }
```

### 6. `n8n.assess_risk` — ocena ryzyka

```
Co robi: Static risk scoring + opcjonalnie LLM review
LLM:     Lokalny model do security review (subtask.delegate) — 8B OK
Źródło:  Istniejące scoreRisk() + riskRules + OPERATING_PRINCIPLES
Zwraca:  { level, score, reasons, blocked, requiredApprovals }
```

---

## Jak Meta Agent to orkiestruje (ReAct loop)

```
User: "Zrób automatyzację: webhook przyjmuje dane z formularza, filtruj po polu 'type',
       zapisz do MongoDB, wyślij alert na Telegram"

Meta Agent Thought: Muszę zaprojektować automatyzację n8n. Zacznę od specyfikacji.

Step 1: n8n.plan_spec(prompt) 
  → { spec: { name: "Form Webhook to MongoDB", trigger: "webhook", steps: [...] } }

Step 2: n8n.match_pattern(spec)
  → { patternId: null, confidence: 0 }  // brak pasującego wzorca

Step 3: n8n.lookup_node("n8n-nodes-base.webhook")
  → { typeVersion: 2, requiredParams: { path, method }, ... }
Step 3b: n8n.lookup_node("n8n-nodes-base.if") 
  → { typeVersion: 2, requiredParams: { conditions }, ... }

Step 4: n8n.compose_workflow({ 
    blocks: ["webhook-trigger", "if-condition", "mongodb-save", "telegram-message"],
    params: { webhook: { path: "/form-intake" }, if: { field: "type" }, ... }
  })
  → { workflowJson: { nodes: [...], connections: {...} } }

Step 5: n8n.validate_workflow(workflowJson)
  → { valid: true, warnings: ["MongoDB credentials not configured"] }

Step 6: n8n.assess_risk(spec)
  → { level: "medium", requiredApprovals: ["owner"] }

Step 7: architect.deploy_automation(spec, workflowJson, risk)
  → PENDING APPROVAL → user zatwierdza → deployed!
```

**Kluczowe:** Meta Agent SAM decyduje co robić. Jeśli `match_pattern` zwraca gotowy workflow — skipuje compose i idzie prosto do validate → deploy. Jeśli nie — składa z bloków.

---

## Delegacja do lokalnych modeli

Meta Agent deleguje **wąskie zadania** do lokalnych 8B modeli:

| Kiedy | Tool | Skill |
|---|---|---|
| Ekstrakcja parametrów z tekstu usera | `subtask.delegate("skill:extract", tekst)` | Istniejący |
| Klasyfikacja typu automatyzacji | `subtask.delegate("skill:classify", tekst)` | Nowy skill |
| Security review wg checklisty | `subtask.delegate("skill:n8n-security-review", workflow)` | Nowy skill |
| Generowanie opisu workflow | `subtask.delegate("skill:summarize", spec)` | Istniejący |

Meta Agent **NIE** deleguje do lokalnych modeli:
- Planowania grafu (zbyt złożone)
- Generowania JSON workflow (za dużo constraints)
- Naprawy błędów walidacji (wymaga zrozumienia struktury)

---

## Struktura plików — co dodajemy

```
packages/agent-skills/registry/
├── terminal/                          ← istniejące (6 plików)
│   └── ...
├── n8n/                               ← NOWE: skille wiedzy o n8n
│   ├── n8n-workflow-rules.md          ← twarde reguły budowania
│   ├── n8n-expression-syntax.md       ← {{ $json.field }} patterns
│   ├── n8n-common-patterns.md         ← trigger→process→output, branching
│   ├── n8n-security-checklist.md      ← security review checklist
│   └── n8n-node-catalog.md            ← top 50 node types + typeVersion + params
└── n8n-blocks/                        ← NOWE: composable blocks
    ├── triggers/
    │   ├── webhook-trigger.json
    │   ├── schedule-trigger.json
    │   └── telegram-trigger.json
    ├── processors/
    │   ├── ollama-call.json
    │   ├── http-request.json
    │   ├── if-condition.json
    │   ├── switch-router.json
    │   └── code-transform.json
    ├── outputs/
    │   ├── telegram-message.json
    │   ├── mongodb-save.json
    │   └── agentforge-webhook.json
    └── utilities/
        ├── error-handler.json
        └── json-validator.json
```

```
packages/automation-architect/src/
├── validators/                        ← NOWE
│   └── workflowValidator.ts           ← deterministyczny validator
├── composer/                          ← NOWE
│   └── blockComposer.ts              ← składanie bloków w workflow
├── schemas/
│   └── nodeSchemaRegistry.ts          ← NOWE: lokalna baza schematów node'ów
└── ...                                ← reszta bez zmian
```

---

## Krok po kroku — kolejność wykonania

### Etap 1: Baza wiedzy (bez zmian w kodzie agenta)

1. **Sklonuj `czlonkowski/n8n-skills`** do `/projekty/jarvis-dashboard-agent/research/n8n-skills`
2. **Wyciągnij z niego** najważniejsze informacje i stwórz 5 plików `.md` w `registry/n8n/`
3. **Stwórz `n8n-node-catalog.md`** — top 50 node types z poprawnym `typeVersion` i wymaganymi parametrami (z n8n-skills + dokumentacja)
4. **Dodaj do `syncMarkdownSkills()`** ścieżkę `registry/n8n/` obok `registry/terminal/`
5. **Test:** `architect.sync_patterns` → sprawdź czy n8n skille pojawiają się w RAG

### Etap 2: Deterministyczny walidator

6. **Utwórz `workflowValidator.ts`** — sprawdza: typy node'ów, typeVersion, connections, expressions, security
7. **Utwórz narzędzie `n8n.validate_workflow`** w tool-definitions + tool-registry
8. **Test:** podaj istniejący workflow z `catalog.ts` → powinien przejść walidację

### Etap 3: Node schema lookup

9. **Utwórz `nodeSchemaRegistry.ts`** — lokalna baza ~50 najczęstszych node types
10. **Utwórz narzędzie `n8n.lookup_node`** w tool-definitions + tool-registry
11. **Test:** `n8n.lookup_node("n8n-nodes-base.httpRequest")` → poprawny schema

### Etap 4: Composable blocks

12. **Utwórz 10-15 bloków JSON** w `registry/n8n-blocks/`
13. **Utwórz `blockComposer.ts`** — deterministic: ładuje bloki, łączy connections, ustawia positions
14. **Utwórz narzędzie `n8n.compose_workflow`** w tool-definitions + tool-registry
15. **Test:** compose webhook + if + telegram → poprawny workflow JSON

### Etap 5: Refaktoryzacja narzędzi architekta

16. **Dodaj `n8n.plan_spec`** — wyciągnięta metoda `planAutomation()` jako osobne narzędzie
17. **Dodaj `n8n.match_pattern`** — wyciągnięte matchPattern + selectPatternFromRag
18. **Dodaj `n8n.assess_risk`** — wyciągnięte scoreRisk + auditRisk
19. **Usuń `architect.plan_automation`** — zastąpiony przez n8n.plan_spec + n8n.match_pattern
20. **Zaktualizuj prompt systemowy** Meta Agenta — dodaj instrukcje kiedy użyć których narzędzi
21. **Build + test end-to-end**

### Etap 6: Skille dla lokalnych modeli

22. **Utwórz `n8n-security-review` skill** w `registry/n8n/` — checklist, którego model 8B przechodzi punkt po punkcie
23. **Test:** `subtask.delegate("skill:n8n-security-review", workflowJson)` → raport
24. **Dodaj do tool-definitions keyword `n8n-security-review`** żeby RAG go znajdował
