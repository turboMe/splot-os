# Automation Architect — plan kolejnej fazy utwardzania

Data: 2026-06-25  
Status: **DRAFT / do realizacji później**  
Kontekst: live testy Automation Architect po utwardzeniu finalizacji, delegacji do `n8nMcpEngineer`, Golden Path i repair loop.

---

## 0. Teza

Automation Architect działa już wystarczająco dobrze, żeby budować i naprawiać realne workflow n8n, ale nadal za dużo zależy od improwizacji modelu.

Następny etap nie powinien polegać głównie na „lepszych promptach”. Trzeba przesunąć system w stronę deterministycznego kompilatora:

1. użytkownik opisuje automatyzację,
2. system tworzy twardy kontrakt intencji,
3. workflow jest budowany,
4. walidator sprawdza nie tylko JSON/n8n, ale też zgodność z kontraktem,
5. dopiero wtedy deploy/test/finalizacja.

Największa luka z live testów: workflow mógł być technicznie poprawny, ale semantycznie ominąć wymaganie, np. zamiast prawdziwego `AI Agent` użyć zwykłego `httpRequest` do Ollama.

---

## 1. Priorytet A — Automation Intent Contract

### Problem

Aktualnie Automation Architect rozumie zadanie głównie przez prompt i pamięć. To jest miękkie. Jeśli użytkownik mówi „użyj AI Agent i narzędzi MCP”, model może zbudować coś podobnego funkcjonalnie, ale niezgodne z intencją.

Przykład z live testu:

- prompt wymagał AI Agent/MCP,
- workflow przeszedł mock test,
- ale AI było zrealizowane jako `httpRequest` do Ollama,
- `mcpDelegations=0` w pierwszym teście tego typu.

### Zmiana

Dodać warstwę `Automation Intent Contract`, generowaną przed budową workflow.

Minimalny kontrakt:

```ts
type AutomationIntentContract = {
  goal: string;
  mustHave: Array<{
    capability: string;
    required: boolean;
    acceptableNodeTypes?: string[];
    disallowedSubstitutes?: string[];
    evidenceRequired?: string;
  }>;
  mustNot: string[];
  integrations: Array<{
    service: string;
    required: boolean;
    credentialRequired: boolean;
  }>;
  acceptanceTests: string[];
  reusePolicy: 'new_workflow' | 'update_existing_allowed' | 'must_update_existing';
};
```

Przykład dla promptu AI/MCP:

```json
{
  "mustHave": [
    {
      "capability": "webhook_intake",
      "required": true
    },
    {
      "capability": "database_persistence",
      "required": true,
      "acceptableNodeTypes": ["n8n-nodes-base.mongoDb", "n8n-nodes-base.postgres"]
    },
    {
      "capability": "real_ai_agent",
      "required": true,
      "acceptableNodeTypes": ["@n8n/n8n-nodes-langchain.agent"],
      "disallowedSubstitutes": ["n8n-nodes-base.httpRequest"]
    },
    {
      "capability": "mcp_or_external_tool_use",
      "required": true
    }
  ],
  "mustNot": [
    "activate workflow",
    "replace AI Agent with plain httpRequest unless user explicitly allows it",
    "reuse unrelated workflow"
  ]
}
```

### Gdzie wpiąć

- Nowy serwis: `src/mastra/services/automation-intent-contract.ts`
- Golden Path input rozszerzyć opcjonalnie o `intentContract`.
- Automation Architect powinien tworzyć kontrakt przed `architect_execute_automation_request`.
- Golden Path powinien walidować workflow przeciwko kontraktowi przed deploy.

### Acceptance

- Jeśli prompt mówi „użyj AI Agent”, workflow bez prawdziwego AI Agent node nie przechodzi coverage gate.
- Jeśli prompt mówi „nie aktywuj”, finalny workflow zawsze ma `active=false`.
- Jeśli workflow używa substytutu, raport jasno mówi, że to nie spełnia kontraktu.

### Ryzyko

Model może generować za ostry kontrakt i blokować sensowne workflow. Dlatego na start:

- kontrakt ma być mały,
- tylko oczywiste `mustHave`,
- tryb `warn` przed `block` dla nowych capability gates.

---

## 2. Priorytet A — Node Capability Registry

### Problem

System zna typy node’ów, ale słabo rozumie ich możliwości. `httpRequest` może być wywołaniem LLM, ale nie jest tym samym co `AI Agent`.

### Zmiana

Dodać registry mapujące intencje na capability:

```ts
type NodeCapability = {
  capability: string;
  nodeTypes: string[];
  substitutes?: Array<{
    nodeType: string;
    allowedWhen: string;
    warning: string;
  }>;
};
```

Przykładowe capability:

- `webhook_intake`
- `database_persistence`
- `email_send_or_draft`
- `human_alert`
- `real_ai_agent`
- `llm_call`
- `mcp_tool_use`
- `error_handling`
- `conditional_routing`
- `inactive_draft`

Przykład:

```ts
{
  capability: 'real_ai_agent',
  nodeTypes: ['@n8n/n8n-nodes-langchain.agent'],
  substitutes: [
    {
      nodeType: 'n8n-nodes-base.httpRequest',
      allowedWhen: 'contract_allows_llm_call_instead_of_agent',
      warning: 'httpRequest to LLM is not a real AI Agent node.'
    }
  ]
}
```

### Gdzie wpiąć

- Nowy plik: `src/mastra/tools/architect/validation/node-capabilities.ts`
- `workflow-validator.ts` albo nowy `semantic-coverage-validator.ts`
- Golden Path: etap po structural validation, przed deploy.

### Acceptance

- Validator potrafi powiedzieć: „workflow ma LLM call, ale nie ma real AI Agent”.
- Validator potrafi wskazać, które wymagane capability są spełnione przez które node’y.
- Raport Golden Path pokazuje brakujące capability w sposób czytelny dla modelu.

### Ryzyko

n8n LangChain node types mogą się różnić między wersjami. Registry musi być aktualizowalne przez MCP lookup albo przynajmniej mieć tryb `unknown-but-mcp-validated`.

---

## 3. Priorytet A — Semantic Coverage Gate

### Problem

Obecny coverage gate łapie część braków, ale jest za ogólny. Workflow może przejść, bo ma podobne elementy, mimo że nie spełnia szczegółowego wymagania.

### Zmiana

Dodać `evaluateSemanticCoverage(workflow, intentContract)`.

Wynik:

```ts
type SemanticCoverageResult = {
  valid: boolean;
  mode: 'warn' | 'block';
  satisfied: Array<{
    capability: string;
    nodeNames: string[];
  }>;
  missing: Array<{
    capability: string;
    required: boolean;
    reason: string;
    suggestedNodeTypes?: string[];
  }>;
  disallowedSubstitutions: Array<{
    capability: string;
    nodeName: string;
    nodeType: string;
    reason: string;
  }>;
};
```

### Polityka startowa

Na początku:

- `SEMANTIC_COVERAGE_GATE_MODE=warn`
- po kilku live testach przełączyć wybrane capability na `block`

Od razu `block` dla:

- `activate workflow` naruszone,
- forbidden node,
- brak triggera,
- brak wymaganego persistence przy zadaniu intake/lead/support,
- brak prawdziwego AI Agent, jeśli prompt jawnie mówi „użyj bloku AI Agent”.

### Acceptance

- Prompt „użyj AI Agent” + workflow z samym `httpRequest` → `blocked` albo co najmniej `manual_review_required` z jasnym powodem.
- Prompt bez wymagania AI Agent może nadal użyć `httpRequest` do Ollama jako zwykły LLM call.

### Ryzyko

Za agresywny gate może zablokować kreatywne, ale poprawne workflow. Dlatego ważne jest rozróżnienie:

- `AI Agent` jako jawny wymagany node,
- `AI/LLM analysis` jako ogólna funkcja, gdzie `httpRequest` może być akceptowalny.

---

## 4. Priorytet A — Centralny n8n write sanitizer

### Problem

W live teście wrócił błąd:

```text
request/body/settings must NOT have additional properties
```

To znaczy, że mimo dotychczasowej sanitizacji, przy update nadal przeciekają pola nieakceptowane przez n8n API, np. `settings.callerPolicy` albo podobne.

### Zmiana

Zrobić jedną centralną warstwę zapisu do n8n:

- allowlista top-level workflow fields,
- allowlista `settings`,
- allowlista node fields,
- zachowanie `credentials`,
- usuwanie runtime/read-only fields,
- snapshot payloadu przed HTTP requestem w trybie debug/test.

Docelowo create/update nie powinny nigdy wysyłać surowego workflow bez przejścia przez tę funkcję.

### Gdzie wpiąć

Istniejący kierunek:

- `src/mastra/tools/architect/workflow-write-helpers.ts`
- `src/mastra/tools/n8n/client.ts`
- `automation-golden-path.ts`
- `architect/deploy.ts`

Rozszerzyć helpery o:

```ts
sanitizeWorkflowForN8nWrite(workflow, {
  operation: 'create' | 'update',
  preserveCredentialsFrom?: existingWorkflow
})
```

Allowlista `settings` powinna na start dopuścić tylko pola znane n8n, np.:

- `executionOrder`
- `saveExecutionProgress`
- `saveManualExecutions`
- `saveDataErrorExecution`
- `saveDataSuccessExecution`
- `timezone`
- `errorWorkflow`
- `callerPolicy` tylko jeśli dana wersja n8n faktycznie je akceptuje; jeśli nie, usuwać.

### Acceptance

- Payload z `settings.callerPolicy` nie dociera do n8n API, jeśli API go odrzuca.
- Test regresyjny symuluje update workflow z dodatkowymi polami w `settings`.
- Credential preservation nadal działa.

### Ryzyko

Zbyt ciasna allowlista może usuwać legalne ustawienia z nowszego n8n. Dodać test i log `removedFields`, żeby widzieć co sanitizer obciął.

---

## 5. Priorytet B — Lepsza polityka reuse workflow

### Problem

Reuse istniejącego workflow bywa dobry, ale może być niebezpieczny. W testach Architect próbował czytać workflow z pamięci/precontext, dostał 404, potem listował workflow i szukał podobnych. To jest sensowne, ale wymaga twardszej polityki.

### Zmiana

Dodać scoring podobieństwa przed update istniejącego workflow.

Kryteria:

- nazwa podobna,
- domena biznesowa podobna,
- trigger podobny,
- integracje podobne,
- wymagane capability podobne,
- workflow zarządzany przez Mastra,
- użytkownik jawnie prosił o to samo / update / poprawkę.

Przykład:

```ts
type WorkflowReuseDecision = {
  decision: 'reuse' | 'create_new' | 'ask_or_report';
  score: number;
  reasons: string[];
  conflicts: string[];
};
```

### Polityka

- `score >= 0.8` → reuse allowed
- `0.5 <= score < 0.8` → create new unless user explicitly asked to update
- `< 0.5` → create new

### Acceptance

- Powtórzenie tego samego promptu aktualizuje istniejący workflow.
- Nowy prompt w innej domenie tworzy nowy workflow.
- Workflow z pamięci, który już nie istnieje w n8n, nie powoduje długiego churnu.

### Ryzyko

Nadmierna ostrożność może tworzyć duplikaty. To lepsze niż nadpisanie złego workflow. Duplikaty da się sprzątać, zły update bywa kosztowny.

---

## 6. Priorytet B — Terminal policy dla `manual_review_required`

### Problem

W live teście Architect wszedł na chwilę w pętlę po `manual_review_required`. Ostatecznie sam naprawił workflow, ale gdyby się nie udało, powinien szybko zakończyć raportem diagnostycznym.

### Zmiana

Dodać twardy repair budget:

```ts
maxRepairAttempts: 2
maxManualReviewLoops: 1
```

Jeśli po budżecie nadal jest `manual_review_required`, Architect powinien zakończyć:

- bez dalszego deploy/test loop,
- z raportem diagnostycznym,
- z listą failing nodes,
- z exact validator findings,
- z następnym bezpiecznym krokiem.

### Acceptance

- Po wyczerpaniu repair budget run kończy się raportem, nie tool-loop.
- `tested` nadal finalizuje sukcesem.
- `manual_review_required` finalizuje kontrolowanym raportem, nie timeoutem.

### Ryzyko

Można przerwać za wcześnie przypadek, który dałoby się naprawić trzecim ruchem. Dlatego budżet powinien być konfigurowalny env:

```text
AUTOMATION_MAX_REPAIR_ATTEMPTS=2
AUTOMATION_MAX_MANUAL_REVIEW_LOOPS=1
```

---

## 7. Priorytet B — Memory hygiene dla Automation Architect

### Problem

W workflow B2B pojawił się `GastroBridge`, czyli kontekst biznesowy z poprzedniego zadania przeciekł do nowego workflow. To jest sygnał, że pamięć działa, ale jest za słabo izolowana.

### Zmiana

Wprowadzić typowanie pamięci używanej przez Automation Architect:

- `technical_lesson` — wolno reuse’ować szeroko,
- `failure_case` — wolno reuse’ować szeroko, ale tylko jako ostrzeżenie techniczne,
- `node_pattern` — wolno reuse’ować, jeśli capability pasuje,
- `business_context` — reuse tylko przy zgodnej domenie/tym samym workflow,
- `prior_workflow` — reuse tylko przez reuse policy,
- `credential_hint` — reuse tylko dla tej samej integracji.

### Acceptance

- Techniczna lekcja „nie wysyłaj settings.callerPolicy” może być użyta wszędzie.
- Nazwa/domena klienta z poprzedniego workflow nie trafia do nowego promptu, jeśli domena nie pasuje.
- Recall w monitorze pokazuje, które wspomnienia zostały użyte jako techniczne, a które odrzucone jako business-context mismatch.

### Ryzyko

Za agresywna filtracja zmniejszy użyteczność pamięci. Najpierw logować decyzje, potem blokować.

---

## 8. Priorytet C — Lepsze raportowanie jakości workflow

### Problem

Obecne raporty mówią, czy workflow jest `tested`, ale nie zawsze jasno rozdzielają:

- poprawność techniczną,
- zgodność z intencją,
- realne wymagania do aktywacji,
- znane kompromisy.

### Zmiana

Final report Automation Architect powinien mieć stałą strukturę:

```md
## Status
- workflowId
- automationId
- active=false
- tested/passed

## Contract coverage
- satisfied capabilities
- missing optional capabilities
- blocked/waived capabilities

## Integrations
- credentials present
- credentials missing
- placeholders/config to fill

## Safety
- forbidden nodes: none
- activation: not activated
- risk score

## Next action
- safe to inspect
- requires credentials/config before activation
```

### Acceptance

Raport pozwala w 30 sekund ocenić, czy workflow jest:

- gotowy do ręcznej inspekcji,
- gotowy do aktywacji po zgodzie,
- wymagający naprawy.

---

## 9. Sugerowana kolejność implementacji

### Transza 1 — najważniejsze techniczne zabezpieczenia

1. Centralny n8n write sanitizer dla `settings`.
2. Test regresyjny na `settings must NOT have additional properties`.
3. Repair/finalization policy dla `manual_review_required`.

Dlaczego najpierw to: zmniejsza realne błędy runtime i pętle bez dużej przebudowy architektury.

### Transza 2 — intencja i semantyka

1. `Node Capability Registry`.
2. Minimalny `Automation Intent Contract`.
3. `Semantic Coverage Gate` w trybie `warn`.
4. Regresja: prompt z AI Agent nie może być „spełniony” samym `httpRequest`.

Dlaczego druga: to największy wzrost jakości, ale wymaga więcej decyzji projektowych.

### Transza 3 — reuse i pamięć

1. Workflow reuse scoring.
2. Memory hygiene classification.
3. Raportowanie decyzji reuse/recall.

Dlaczego trzecia: ważne, ale mniej pilne niż write safety i semantic coverage.

### Transza 4 — raport końcowy

1. Stały format raportu.
2. Contract coverage w finalu.
3. Missing config/credentials w osobnej sekcji.

---

## 10. Czego nie robić teraz

Nie budować od razu:

- pełnego wizualnego workflow plannera,
- osobnego DSL dla całego n8n,
- pełnego symulatora runtime n8n,
- ogromnego katalogu wszystkich node’ów ręcznie.

To są kuszące kierunki, ale za ciężkie na obecny etap. Najpierw trzeba dopiąć deterministyczną zgodność:

```text
prompt → intent contract → workflow → semantic coverage → safe n8n write → test → final report
```

---

## 11. Definicja sukcesu całej fazy

Faza jest zakończona, jeśli live testy pokazują:

1. prompt z AI Agent wymusza prawdziwy AI Agent node albo blokuje jako niespełniony kontrakt,
2. prompt z MCP/tool use powoduje realną delegację do `n8nMcpEngineer` albo jasne uzasadnienie braku potrzeby,
3. update workflow nie wysyła nielegalnych pól `settings`,
4. manual review nie prowadzi do długiej pętli,
5. pamięć techniczna pomaga, ale nie przenosi domeny biznesowej z poprzednich testów,
6. final report jednoznacznie mówi, co zostało zbudowane, czego brakuje i czy workflow jest aktywny.

