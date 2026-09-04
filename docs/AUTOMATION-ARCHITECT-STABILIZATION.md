# Stabilizacja Automation Architect

> Status: wykonane  
> Data: 2026-05-13  
> Zakres: domknięcie niezawodnej ścieżki Automation Architect przed startem planu jcode-inspired memory and harness.

## Cel

Automation Architect miał lukę w niezawodności pełnego dostarczenia automatyzacji. Potrafił zbudować fragmenty workflow, ale sekwencja budowa -> walidacja -> deploy -> test -> repair -> opcjonalna aktywacja była za bardzo zależna od tego, czy model sam zapamięta wszystkie kroki.

Ta stabilizacja przenosi tę sekwencję do deterministycznej i testowalnej ścieżki wykonawczej.

## Kontrakt Operacyjny

Dla zadań automatyzacyjnych obejmujących build, deploy, test, repair, aktywację albo podłączenie n8n Automation Architect powinien używać:

```txt
architect_execute_automation_request
```

To narzędzie jest jedną bramą wykonawczą dla Golden Path:

```txt
normalize input
  -> validate workflow
  -> score risk
  -> block unsafe workflow
  -> deploy inactive
  -> run mock test
  -> apply repair loop when needed
  -> optionally activate
  -> sync Mongo/n8n state
```

Ręczne wykonywanie pojedynczych narzędzi zostaje fallbackiem tylko wtedy, gdy narzędzie jednej bramki nie pasuje do wejścia.

## Wdrożone Zmiany

### Golden Path

- Dodano `AutomationGoldenPath` w `src/mastra/services/automation-golden-path.ts`.
- Dodano tool `architect_execute_automation_request` w `src/mastra/tools/architect/execute-request.ts`.
- Zarejestrowano tool w `src/mastra/agents/automation-architect.ts`.
- Zmieniono `src/mastra/prompts/automation/base.md`, żeby architekt preferował Golden Path dla build/deploy/test/activation.

Golden Path obsługuje wejście z patternu, pliku workflow albo surowego workflow JSON.

### Bezpieczna Delegacja

- Zmieniono `src/mastra/tools/system/delegate-task.ts`.
- Delegacja do Automation Architect nie jest uznawana za sukces bez terminalnego statusu.
- Żądania, które powinny zakończyć się wdrożoną automatyzacją, muszą zwrócić oczekiwane identyfikatory automatyzacji/workflow.

### Walidacja i Ryzyko

- Wzmocniono walidację workflow w `src/mastra/tools/architect/validation/workflow-validator.ts`.
- Wzmocniono scoring ryzyka w `src/mastra/tools/architect/risk-scoring.ts`.
- Niebezpieczny kod workflow, np. `$helpers.executeCommandSync`, jest blokowany przed deployem.

### Repair Loop

- Wyeksportowano `applyRepairs` z `src/mastra/tools/architect/testing/repair-workflow.ts`.
- Golden Path może używać tej samej deterministycznej logiki naprawy podczas test/repair execution.

### Aktualizacja 2026-05-14: normalizacja connections

Dodano deterministyczną normalizację połączeń n8n w `normalizeConnectionKeys`.

Problem: n8n wymaga, żeby klucze `workflow.connections` i pola `connections[*].main[*][*].node` wskazywały `node.name`. Modele często generują tam `node.id`, np. `scheduleTrigger_01`, co blokowało Golden Path błędami `Connection references unknown source node`.

Nowe zachowanie:

- source keys pasujące do `node.id` są przepinane pod odpowiadające `node.name`;
- targety połączeń pasujące do `node.id` są zamieniane na `node.name`;
- przypadki z przypadkowymi cudzysłowami lub spacjami nadal są normalizowane;
- kolizje `connections[id]` i `connections[name]` są scalane tylko wtedy, gdy merge jest jednoznaczny;
- każda automatyczna zmiana trafia do warningów walidacji.

Normalizacja jest używana przez Golden Path/deploy, `architect_validate_workflow` oraz `architect_repair_workflow`.

### Aktualizacja 2026-05-14: walidacja grafu wykonania

Dodano analizę grafu workflow w `validateWorkflow`.

Nowe zachowanie:

- walidator buduje graf z `workflow.connections` i liczy zasięg od triggerów;
- wynik walidacji zawiera `triggerCount`, `reachableNodeCount`, `orphanNodeCount` i `disconnectedComponents`;
- `draft` ostrzega o node'ach roboczych nieosiągalnych z triggera, a workflow z wieloma executable node'ami i `connectionCount=0` blokuje jako błąd;
- `strict` oraz `activation` blokują executable node'y bez ścieżki od triggera;
- `activation` wymaga triggera i ścieżki do przynajmniej jednego executable node'a, gdy workflow zawiera takie node'y;
- `formTrigger`, `gmailTrigger` i `executeWorkflowTrigger` są traktowane jako triggery w katalogu walidatora;
- mock test korzysta ze wspólnej listy triggerów, więc nie rozjeżdża się z walidatorem.

To zamyka lukę, w której poprawny składniowo workflow z pustymi lub błędnie spiętymi `connections` mógł dojść do statusu `tested`.

### Aktualizacja 2026-05-14: connection-aware repair

Rozszerzono `architect_repair_workflow` i Golden Path o precyzyjną naprawę błędów połączeń.

Nowe zachowanie:

- `applyRepairs` oznacza naprawy connection jako `connection_id_to_name_repair`;
- po repair uruchamiana jest walidacja `draft` i `strict`;
- jeżeli source/target nie da się zmapować do żadnego `node.id` ani `node.name`, wynik dostaje `stopReason=manual_connection_mapping_required`;
- remaining issues zawierają konkretne missing source/target oraz listę znanych node names;
- Golden Path zapisuje bardziej precyzyjne `recoveryStrategies`: `connection_id_to_name_repair`, `connection_graph_repair` albo `manual_connection_mapping_required`;
- komunikaty typu `No deterministic repair was possible` zawierają klasę powodu, więc meta-agent nie powinien powtarzać tej samej próby bez zmienionego wejścia;
- failure learning klasyfikuje takie przypadki jako `connection_validation`.

To domyka przypadek, w którym meta-agent przekazywał gotowy JSON workflow, ale błędy w `connections` powodowały serię podobnych retry bez jasnej instrukcji naprawy.

### Aktualizacja 2026-05-14: lokalny n8n CE bez `$vars.*`

Lokalna instalacja n8n działa bez płatnych global variables, więc `$vars.*` pozostaje funkcją niedozwoloną.

Nowe doprecyzowanie:

- validator nadal blokuje każde `$vars.*`;
- `repair_workflow` nie usuwa już `$vars.*` cicho ani nie podstawia pustej wartości;
- wynik repair dostaje `stopReason=unsupported_n8n_vars`;
- Golden Path klasyfikuje taki przypadek jako `unsupported_n8n_vars_rewrite`;
- prompt architekta mówi, że wartości trzeba przepisać na runtime topology/env-builder albo credential n8n.

### Aktualizacja 2026-05-14: strukturalny most meta-agent -> Golden Path

Dodano `system_start_automation_request` dla meta-agenta.

Nowe zachowanie:

- meta-agent może przekazać `pattern`, `workflow_file` albo `workflow_json` bez tekstowej delegacji do `automationArchitect`;
- tool uruchamia bezpośrednio `startAutomationJob` albo synchronicznie `executeAutomationGoldenPath`;
- kompletne workflow JSON nie musi przechodzić jako prompt LLM-a;
- `workflow`, `spec` i `approvalToken` są redacted w tool envelope;
- dla `workflow_json` większego niż 20 KB system zapisuje plik w `/tmp/mastra-automation-workflows` i uruchamia Golden Path jako `workflow_file`;
- meta prompt i opis `system_delegate_task` instruują, żeby nie delegować dużego JSON-a tekstowo, jeśli istnieje strukturalny input.

To zamyka lukę, w której meta-agent mógł mieć gotowy workflow JSON, ale przekazywał go jako prose, po czym model architekta mógł zamienić obiekt w string albo uszkodzić `connections`.

### Aktualizacja 2026-05-15: klasyfikacja bledow i test UI/API

Poprawiono klasyfikacje bledow narzedzi Automation Golden Path.

Nowe zachowanie:

- `Workflow validation blocked deploy` jest klasyfikowane jako `workflow_validation`, a nie `policy_blocked`;
- samo slowo `blocked` nie jest markerem polityki;
- `policy_blocked` pojawia sie tylko przy realnym markerze policy/allowlist/approval;
- wynik Golden Path moze zachowac `failureClass`;
- kompaktowany output dla modelu zachowuje `status`, `failureClass`, `failedStep`, top errors, `recoveryStrategies` i `nextAction`;
- memory/dashboard dostaja te same sensowne klasy przyczyny, np. `workflow_validation`, `runtime_preflight`, `risk_blocked`, `approval_required`, `tool_input_contract`.

Zweryfikowana sciezka UI/API dla gotowego strukturalnego JSON-a:

```txt
meta-agent -> system_start_automation_request -> executeAutomationGoldenPath
```

Test CLI z `automationId=cli-meta-structured-validation-1778807463403` potwierdzil:

- odpowiedz agenta zawierala `FailureClass: workflow_validation`;
- `automation_events.failure_case.data.failureClass = workflow_validation`;
- `agent_events.task_failed.metadata.failureClass = workflow_validation`;
- `tool_executions.errorClass = workflow_validation`;
- kompaktowany `outputPreview` zawieral `"failureClass":"workflow_validation"`;
- wynik nie zawieral `policy_blocked`.

Minimalny prompt do recznego testu w UI `meta-agent`:

```txt
Use system_start_automation_request for this structured Golden Path regression.

Input:
{
  "mode": "workflow_json",
  "automationId": "ui-meta-workflow-validation-manual-01",
  "workflow": {
    "active": false,
    "settings": { "executionOrder": "v1" },
    "nodes": [
      {
        "id": "manual",
        "name": "Manual Trigger",
        "type": "n8n-nodes-base.manualTrigger",
        "typeVersion": 1,
        "position": [0, 0],
        "parameters": {}
      }
    ],
    "connections": {}
  },
  "activate": false,
  "allowDraftWithMissingCredentials": true,
  "requiresPublicWebhook": false,
  "executionMode": "sync"
}

Expected: blocked workflow_validation, not policy_blocked.
Final answer in Polish with status, failureClass, failedStep, and message.
```

Oczekiwany wynik:

```txt
Status: blocked
FailureClass: workflow_validation
FailedStep: validate_draft
Message: Workflow validation blocked deploy.
```

Tekstowa delegacja `meta-agent -> system_delegate_task -> automationArchitect` pozostaje tylko testem diagnostycznym dla tego przypadku. W lokalnym tescie CLI `cli-meta-delegation-validation-1778807571602` delegowany agent nie wykonal realnie `architect_execute_automation_request` i wskazal brak/niewlasciwe uzycie narzedzia. Dla gotowego `workflow_json` sciezka akceptacyjna to strukturalny `system_start_automation_request`, nie tekstowa delegacja.

### Aktualizacja 2026-05-15: pelne wyniki delegacji async

Domknieto kontrakt dlugich odpowiedzi z delegacji asynchronicznych.

Nowe zachowanie:

- `generateWithHarness` zapisuje dlugi `llm_output` jako artifact i zwraca `outputArtifactId`;
- delegacja async zachowuje osobno `resultPreview`, `resultArtifactId` i `fullResultAvailable`;
- pending update dla meta-agenta zawiera `Full result artifact`, gdy pelny wynik zostal zapisany;
- `checkPendingUpdates` zwraca teraz `updates[].metadata`, wiec agent moze pobrac pelny wynik zamiast pracowac tylko na uciętym preview;
- automation jobs nadal pozostaja preferowana sciezka dla automatyzacji, bo ich manager juz ma deterministyczny kontrakt artefaktow.

Regresja w `check:automation-autonomy` uruchamia realna delegacje async na dlugim wyniku i potwierdza przeplyw artefaktu od harnessu do `checkPendingUpdates`.

### Zgodność z Lokalnym n8n

Lokalne definicje node'ów n8n zostały użyte jako źródło prawdy dla znanych warningów:

- `n8n-nodes-base.telegramTrigger`: wersje `1`, `1.1`, `1.2`.
- `n8n-nodes-base.html`: wersje `1`, `1.1`, `1.2`.
- Pattern RSS używa teraz `n8n-nodes-base.rssFeedReadTrigger`.
- Parametr RSS triggera to teraz `feedUrl`.
- Mock test data obsługuje `n8n-nodes-base.rssFeedReadTrigger`.

Pliki zmienione w tym zakresie:

- `src/mastra/tools/architect/validation/node-registry.ts`
- `src/mastra/tools/architect/builders/extendedPatterns.ts`
- `src/mastra/tools/architect/testing/mock-data.ts`

## Weryfikacja

Po stabilizacji uruchomiono:

```bash
npm run check:automation-patterns
npm run check:automation
npm run build
```

Wyniki:

- `check:automation-patterns`: `37 passed`, `1 warnings`, `0 failed`, `5 skipped`.
- `check:automation`: passed.
- Golden Path dla unsafe workflow: zablokowany zgodnie z oczekiwaniem.
- Golden Path dla safe workflow: deployed inactive, tested, cleanup wykonany.
- `build`: passed.

Po aktualizacji grafu wykonania uruchomiono dodatkowo:

```bash
npm run check:automation-golden-path
npm run check:automation-patterns
npm run check:automation
npm run build
```

Wyniki:

- `check:automation-golden-path`: passed, w tym `connectionIdNormalization=passed` i `graphValidation=passed`.
- `check:automation-patterns`: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`.
- `check:automation`: passed; runtime raportuje tylko niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- `build`: passed.

Nowe warningi w pattern smoke są oczekiwane dla draft-patternów bez klasycznego triggera. Nie blokują buildu, ale sygnalizują, że takie workflow wymagają świadomego uruchomienia lub dalszego modelowania jako subworkflow.

Po aktualizacji repair loopa uruchomiono:

```bash
npm run check:automation-golden-path
npm run check:automation
npm run build
```

Wyniki:

- `check:automation-golden-path`: passed, w tym `connectionRepair=passed`.
- `check:automation`: passed; runtime raportuje tylko niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- `build`: passed.

Po aktualizacji lokalnego `$vars.*` i strukturalnego mostu meta-agent uruchomiono:

```bash
npm run check:automation-autonomy
npm run check:automation-golden-path
npm run check:automation
npm run build
```

Wyniki:

- `check:automation-autonomy`: passed; test startuje job przez `system_start_automation_request` i sprawdza powrót pending update do `meta-agent`.
- `check:automation-golden-path`: passed, w tym `unsupportedVars=passed`.
- `check:automation`: passed; runtime raportuje tylko niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- `build`: passed.

Po aktualizacji klasyfikacji bledow uruchomiono:

```bash
npx tsc --noEmit
npm run build
npm run check:automation-autonomy
npm run check:automation-golden-path
npm run check:automation-patterns
npm run check:n8n-runtime
```

Wyniki:

- `tsc`: passed.
- `build`: passed.
- `check:automation-autonomy`: passed; regresja sprawdza `Workflow validation blocked deploy -> workflow_validation`, realny marker policy oraz `tool_input_contract`.
- `check:automation-golden-path`: passed.
- `check:automation-patterns`: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`.
- `check:n8n-runtime`: required checks passed; pozostaje niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- CLI UI/API przez `meta-agent` i `system_start_automation_request`: passed dla `workflow_validation`, bez `policy_blocked`.

Po aktualizacji pelnych wynikow delegacji async uruchomiono:

```bash
npx tsc --noEmit
npm run check:automation-autonomy
npm run build
```

Wyniki:

- `tsc`: passed.
- `check:automation-autonomy`: passed; regresja potwierdza `resultArtifactId`, `fullResultAvailable`, widoczny `Full result artifact` w pending update i zachowanie metadanych przez `checkPendingUpdates`.
- `build`: passed.

Po domknieciu zestawu regresji runtime uruchomiono:

```bash
npx tsc --noEmit
npm run check:n8n-runtime
npm run check:automation-patterns
npm run check:automation-golden-path
npm run check:automation-autonomy
npm run build
```

Wyniki:

- `check:n8n-runtime`: required checks passed; pozostaje niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- `check:automation-patterns`: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`; 38 executable patternow pozostaje bez faila.
- `check:automation-golden-path`: passed, w tym `connectionIdNormalization=passed`, `graphValidation=passed`, `connectionRepair=passed`, `unsupportedVars=passed`, `inactiveAfterDeploy=passed`.
- `check:automation-autonomy`: passed, w tym `metaStructuredWorkflowJson=passed`, `classificationWorkflowValidation=passed`, `asyncFullResultArtifact=passed`.
- `build`: passed.

### Aktualizacja 2026-05-15: audit legacy workflowow n8n

Dodano skrypt:

```bash
npm run audit:n8n-managed-workflows
```

Domyslnie dziala read-only. Opcjonalny `--apply` wykonuje tylko jawny backfill dla workflowow `managedBy=mastra`, ktore maja `status=tested`, ale obecna walidacja strict wykrywa rozlaczony graf. Wtedy status przechodzi na `manual_review_required`, a do `automation_events` trafia `graph_validation_backfill`; workflow nie jest aktywowany.

Read-only audit dwoch historycznych workflowow dal:

- `XjRwjBPesto0419e`: graf poprawny (`connections=3`, `strictValid=true`), ale widoczny mismatch `lastTest.status=passed` przy `status=draft_created`;
- `h3fvQ0xzuZcZz0Hs`: `connections=0`, `orphanNodes=28`, `strictValid=false`, `lastTestLikelyFalsePositive=true`; rekord kwalifikuje sie do backfillu, ale nie zostal automatycznie zmieniony bez jawnej decyzji.

Po dodaniu audytu uruchomiono:

```bash
npx tsc --noEmit
npm run audit:n8n-managed-workflows
npm run build
```

Wyniki:

- `tsc`: passed.
- `audit:n8n-managed-workflows`: passed w trybie read-only.
- `build`: passed.

## Pozostałe Warningi

Pozostałe warningi są środowiskowo-credentialowe albo intentional draft warnings, a nie dotyczą node type/version:

- `N8N_CREDENTIAL_HTTP_ID` nie jest ustawione.
- Część draft-patternów bez triggera raportuje ostrzeżenie grafu, dopóki nie zostaną zamodelowane jako pełne workflow albo subworkflow z `executeWorkflowTrigger`.

Nie blokują dalszych prac. HTTP credential trzeba uzupełnić dopiero przed uruchamianiem automatyzacji, które wymagają tego credentiala.

## Decyzja

Stabilizacja Automation Architect jest zamknięta na tyle, żeby przejść do planu jcode-inspired memory and harness.

Następny etap powinien zaczynać się od faz harness/memory, nie od kolejnych rewrite'ów Automation Architect, chyba że pojawi się nowa regresja runtime.
