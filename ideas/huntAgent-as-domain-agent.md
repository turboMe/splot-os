# HuntAgent jako domenowy orkiestrator - plan implementacji

> Status: PROJEKT DO WDROZENIA  
> Data: 2026-07-20  
> Cel: przebudowac sposob uruchamiania `huntAgent` tak, zeby pelny lead hunt byl trwalym procesem domenowym w tle, widocznym w Task Ledger, bez falszywych timeoutow meta-agenta i bez utraty kontroli nad researcherami, workerami, CRM, Gmail drafts oraz checkpointami approval.

---

## 1. Decyzja architektoniczna

`huntAgent` powinien zostac **agentem domenowym** dla lead huntingu, ale pelny hunt nie powinien byc wykonywany jako jedna synchroniczna delegacja z meta-agenta.

Docelowy podzial odpowiedzialnosci:

| Warstwa | Odpowiedzialnosc |
|---|---|
| `metaAgent` | Rozmowa z uzytkownikiem, rozpoznanie intencji, uruchomienie domenowego joba, raportowanie wynikow z Task Ledger. |
| `huntAgent` | Domenowa strategia: kolejnosc faz, kiedy research, kiedy worker, kiedy CRM/Gmail, kiedy approval, jak zlozyc wynik. |
| `HuntJobManager` | Runtime: background execution, heartbeat, timeouty, cancel, retry, child processes, Task Ledger, pending updates. |
| `researcherAgent` / `knowledgeAgent` / `run_worker` | Subprocesy uruchamiane przez domenowy hunt, z budzetem i jawnym kontraktem wyniku. |
| CRM/Gmail tools | Side effecty domenowe, wykonywane tylko w fazie `assemble`, z idempotency keys i bez automatycznego send. |

Najwazniejsza zmiana: `metaAgent` nie czeka 20 minut na `delegate_task(huntAgent)`. Meta uruchamia `start_hunt_job`, dostaje `jobId`, `runId`, numer lane i wraca do rozmowy. Wynik wraca pozniej przez Task Ledger / pending updates / soft interrupt.

---

## 2. Problem, ktory naprawiamy

Obecny blad:

```text
Wszystkie 3 delegacje do huntAgent przekroczyly timeout (240s kazda)
```

To nie oznacza, ze `huntAgent` przestal pracowac. Oznacza, ze caller przekroczyl czas oczekiwania. Pipeline moze nadal wykonywac tool calls i mutowac stan po tym, jak meta dostala `success:false`.

Root cause w aktualnym runtime:

1. `huntAgent` jest pipeline agentem z `maxSteps: 150`.
2. `delegate_task` kieruje pipeline agents przez `generatePipelineWithReflection`.
3. Pipeline path jest opakowany `withDelegationTimeout`.
4. `withDelegationTimeout` robi `Promise.race`, ale nie abortuje samej generacji.
5. `getDelegationTimeoutMsFor` nie ma osobnego budzetu dla `huntAgent`, wiec wpada w generic 240s.
6. Meta widzi timeout delegacji, ale sam hunt moze dalej dzialac i pozniej dojsc do CRM/Gmail/report.

Skutek:

- falszywy komunikat o porazce,
- brak jednego miejsca prawdy o stanie hunta,
- meta probuje uruchamiac kilka dlugich delegacji naraz,
- timeout researchera wewnatrz hunta miesza sie z timeoutem calego hunta,
- operator nie wie, czy praca trwa, utknela, czy zakonczyla sie czesciowo.

Nie naprawiamy tego samym zwiekszeniem timeoutu. Zwiekszenie timeoutu moze byc awaryjnym plastrem, ale poprawny model to background domain job.

---

## 3. Istniejace fundamenty, ktore wykorzystujemy

Repo ma juz wiekszosc potrzebnych prymitywow:

| Komponent | Obecny stan | Jak wykorzystac |
|---|---|---|
| `huntAgent` | Domenowy agent z `hunt/domain` + `hunt/pipeline`, `maxSteps: 150`, CRM, Gmail draft, researcher, workers. | Zostaje domenowym orkiestratorem, ale uruchamianym przez job manager. |
| `huntStateTools` | `hunt_start_run`, `hunt_get_run`, `hunt_list_runs`, `hunt_set_run_status`. | Run domenowy zostaje stanem merytorycznym hunta. |
| `huntDocumentTools` | Incremental Hunt Report na dysku, crash-resumable. | Glowny artefakt wynikowy joba. |
| `huntQualityTools` | Deterministic gates: scoring, identity, draft validation, email picking, market pack. | Zostaja twardym szkieletem jakosci. |
| `Task Ledger` | Lane'y z heartbeat, milestones, artifacts, push dla `blocked/awaiting_approval/done/failed`. | Glowny widok pracy w tle. |
| `pending-message-queue` | Soft interrupts konsumowane w bezpiecznych punktach. | Wyniki child procesow do hunta i wyniki hunta do meta. |
| `automation-job-manager` | Dobry wzorzec background joba z heartbeat, cancel, ledger, pending result. | Najlepszy template dla `hunt-job-manager`. |
| `Agent Board` | Roster agentow, aktualnie `huntAgent` ma `delegation: 'sync'`, `latencyClass: 'long'`. | Zmienic routing: full hunt async/job, male requesty sync. |

---

## 4. Docelowy obraz systemu

```text
USER
  |
  v
metaAgent
  - rozpoznaje: to jest hunt / lead discovery / cold outreach
  - NIE robi 3 sync delegate_task do huntAgent
  - wywoluje start_hunt_job
  |
  v
HuntJobManager
  - tworzy hunt_jobs record
  - otwiera Task Ledger lane
  - odpala run w tle
  - heartbeat + stale detection + cancel
  |
  v
huntAgent domain loop
  - intake
  - discover
  - score
  - enrich
  - extract_email
  - draft
  - assemble
  - checkpoint_review
  |
  +--> child process: researcherAgent / knowledgeAgent / run_worker
  |       - bounded timeout
  |       - result artifact
  |       - pending update do huntAgent thread
  |
  +--> side effects: CRM upsert / Gmail draft / Hunt Report
          - idempotency key
          - retry-safe
          - no send

Task Ledger / pending updates
  |
  v
metaAgent
  - raportuje gotowy checkpoint / partial / failure / approval
```

---

## 5. Zasada domenowego agenta

`huntAgent` ma dzialac podobnie do meta-agenta, ale tylko w domenie lead huntingu.

Nie jest globalnym meta-agentem. Nie decyduje o calej organizacji systemu. Decyduje o tym, jak wykonac hunting:

- czy request wymaga pelnego hunta,
- czy wystarczy `discover_only`,
- czy trzeba wzbogacic juz znane leady,
- czy trzeba tylko napisac cold email,
- czy trzeba stworzyc Gmail drafts,
- czy potrzebny jest researcher,
- czy wystarczy worker,
- czy run jest gotowy na checkpoint approval.

Domenowy agent ma swoje procesy w tle, ale ich lifecycle nie moze byc "ukryta delegacja". Kazdy dlugi subproces musi miec status, timeout, wynik, i miejsce w stanie joba.

---

## 6. Tryby pracy `huntAgent`

Nie kazdy request do `huntAgent` odpala pelny pipeline. Wprowadzamy jawny `HuntJobMode`.

```ts
type HuntJobMode =
  | 'full_hunt'
  | 'discover_only'
  | 'score_only'
  | 'enrich_leads'
  | 'find_emails'
  | 'draft_only'
  | 'assemble_crm_gmail'
  | 'continue_job'
  | 'review_checkpoint';
```

Routing:

| Tryb | Kiedy |
|---|---|
| `full_hunt` | Uzytkownik chce znalezc leady od zera i przygotowac drafty. |
| `discover_only` | Tylko lista firm / kandydatow, bez CRM/Gmail. |
| `score_only` | Mamy kandydatow, potrzebna kwalifikacja. |
| `enrich_leads` | Mamy leady, potrzebny research i personalizacja. |
| `find_emails` | Mamy leady, potrzebny email extraction. |
| `draft_only` | Mamy leady i research, trzeba napisac maile. |
| `assemble_crm_gmail` | Mamy validated leads/drafts, trzeba zapisac CRM + Gmail drafts + report. |
| `continue_job` | Kontynuacja istniejacego `jobId` / `runId`. |
| `review_checkpoint` | Pokazanie checkpointu i zebranie decyzji. |

Pelny `full_hunt` jest domyslnie background jobem. Male `draft_only` dla 1 leadu moze byc sync, jezeli nie ma researchu i side effectow poza draftem.

---

## 7. Model danych

### 7.1 `hunt_jobs`

Nowa kolekcja Mongo: `hunt_jobs`.

```ts
type HuntJobStatus =
  | 'queued'
  | 'running'
  | 'awaiting_child'
  | 'awaiting_approval'
  | 'partial'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

type HuntPhase =
  | 'intake'
  | 'discover'
  | 'score'
  | 'enrich'
  | 'extract_email'
  | 'draft'
  | 'assemble'
  | 'checkpoint_review'
  | 'ship'
  | 'done';

interface HuntJobRecord {
  jobId: string;
  runId?: string;
  mode: HuntJobMode;
  status: HuntJobStatus;
  phase: HuntPhase;

  input: {
    rawIntent: string;
    targetKind?: 'supplier' | 'restaurant';
    segment?: string;
    region?: string;
    count?: number;
    market?: string;
    outputLanguage?: string;
    constraints?: string[];
    existingLeadsArtifactId?: string;
  };

  routing: {
    callerAgentId?: string;
    callerThreadId?: string;
    huntThreadId: string;
    returnToAgentId: string;   // default meta-agent
    returnToThreadId?: string;
    resourceId?: string;
  };

  progress: {
    requestedCount?: number;
    candidatesFound: number;
    leadsQualified: number;
    leadsDrafted: number;
    crmRecordsWritten: number;
    gmailDraftsWritten: number;
    rejected: number;
    childRunning: number;
    childCompleted: number;
    childFailed: number;
  };

  artifacts: {
    reportPath?: string;
    reportArtifactId?: string;
    resultArtifactId?: string;
    leadBatchArtifactId?: string;
    crmLeadIds?: string[];
    gmailDraftIds?: string[];
  };

  currentChildProcessIds: string[];
  error?: string;
  warnings: string[];
  resultPreview?: string;

  timeoutAt: Date;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeatAt: Date;
  expiresAt: Date;
}
```

### 7.2 `hunt_child_processes`

Nowa kolekcja Mongo: `hunt_child_processes`.

```ts
type HuntChildKind =
  | 'researcher'
  | 'knowledge'
  | 'worker'
  | 'email_extraction'
  | 'draft_generation'
  | 'crm_write'
  | 'gmail_draft'
  | 'quality_gate';

type HuntChildStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'skipped';

interface HuntChildProcessRecord {
  childId: string;
  jobId: string;
  runId?: string;
  phase: HuntPhase;
  kind: HuntChildKind;
  ownerAgentId?: string;
  targetAgentId?: string;
  status: HuntChildStatus;

  inputPreview: string;
  outputPreview?: string;
  outputArtifactId?: string;
  error?: string;

  budgetMs: number;
  timeoutAt: Date;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeatAt: Date;

  idempotencyKey: string;
  retry: {
    attempt: number;
    maxAttempts: number;
    backoffMs: number;
  };
}
```

### 7.3 Indeksy Mongo

Dodac do bootstrap/ensure indexes:

```ts
db.collection('hunt_jobs').createIndex({ jobId: 1 }, { unique: true });
db.collection('hunt_jobs').createIndex({ status: 1, lastHeartbeatAt: 1 });
db.collection('hunt_jobs').createIndex({ 'routing.returnToAgentId': 1, startedAt: -1 });
db.collection('hunt_jobs').createIndex({ runId: 1 }, { sparse: true });
db.collection('hunt_jobs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

db.collection('hunt_child_processes').createIndex({ childId: 1 }, { unique: true });
db.collection('hunt_child_processes').createIndex({ jobId: 1, phase: 1, startedAt: 1 });
db.collection('hunt_child_processes').createIndex({ status: 1, timeoutAt: 1 });
db.collection('hunt_child_processes').createIndex({ idempotencyKey: 1 }, { unique: true });
```

---

## 8. Nowy serwis: `hunt-job-manager.ts`

Nowy plik:

```text
src/mastra/services/hunt-job-manager.ts
```

Ma byc wzorowany na `services/automation-job-manager.ts`, nie na `async-delegation.ts`.

Wymagane API:

```ts
export async function startHuntJob(input: StartHuntJobInput): Promise<HuntJobRecord>;
export async function getHuntJob(jobId: string): Promise<HuntJobRecord | null>;
export async function listHuntJobs(filter?: ListHuntJobsFilter): Promise<HuntJobRecord[]>;
export async function cancelHuntJob(jobId: string): Promise<boolean>;
export async function markStaleHuntJobs(opts?: { staleAfterMs?: number }): Promise<number>;
```

Wewnetrzne API:

```ts
async function executeHuntJob(jobId: string): Promise<void>;
async function heartbeatHuntJob(jobId: string): Promise<void>;
async function transitionHuntJob(jobId: string, next: HuntJobStatus, opts?: TransitionOpts): Promise<void>;
async function queueHuntJobUpdate(jobId: string, kind: HuntUpdateKind): Promise<void>;
```

`startHuntJob`:

1. Tworzy `jobId`.
2. Tworzy lub przyjmuje `huntThreadId`.
3. Zapisuje rekord `hunt_jobs`.
4. Otwiera Task Ledger lane.
5. Uruchamia `executeHuntJob(jobId)` fire-and-forget.
6. Zwraca od razu record do toola.

`executeHuntJob`:

1. Ustawia `running`.
2. Startuje heartbeat co 5-10 sekund.
3. Odpala `huntAgent.generate` przez pipeline adapter z `threadId`, `resourceId`, `jobId`, `abortSignal`.
4. Slucha phase transitions i milestone'ow.
5. Aktualizuje `hunt_jobs.phase`, `progress`, ledger milestones.
6. Przy `checkpoint_review` przechodzi do `awaiting_approval`, kolejkuje pending update.
7. Przy `done` przechodzi do `completed`.
8. Przy timeout/cancel abortuje pipeline i zapisuje stan jako `partial`, `failed`, `cancelled` albo `stale`.

---

## 9. Task Ledger integration

Idealnie dodac nowe `LaneSource`:

```ts
type LaneSource =
  | 'async_delegation'
  | 'background_task'
  | 'automation_job'
  | 'hunt_job'
  | 'cron'
  | 'manual';
```

MVP alternatywa: uzyc `source: 'background_task'` i `meta.type = 'hunt_job'`, ale lepiej dodac jawny `hunt_job`, bo to bedzie pierwszoklasowy runtime domain job.

Lane:

```ts
ledgerOpenLane({
  source: 'hunt_job',
  sourceId: jobId,
  goal: input.rawIntent,
  agentId: 'hunt-agent',
  threadId: returnToThreadId,
  state: 'queued',
  staleAfterMs: HUNT_STALE_AFTER_MS,
  meta: {
    mode,
    huntThreadId,
    runId,
    requestedCount,
    market,
  },
});
```

Milestones:

- `hunt job queued`
- `phase:intake`
- `phase:discover candidates=...`
- `phase:score qualified=... rejected=...`
- `phase:enrich childRunning=...`
- `phase:draft drafted=...`
- `phase:assemble crm=... gmailDrafts=...`
- `awaiting approval`
- `completed`
- `partial`
- `failed`
- `cancelled`

Artifacts:

- Hunt Report path / artifact id,
- compact result artifact,
- lead batch artifact,
- CRM lead ids,
- Gmail draft ids.

---

## 10. Pending updates i soft interrupts

Potrzebujemy dwoch poziomow komunikacji.

### 10.1 Wewnetrzny interrupt: child process -> huntAgent

Kiedy `researcherAgent`, `knowledgeAgent` albo worker konczy subproces:

1. Wynik trafia do `hunt_child_processes`.
2. Pelny wynik trafia do artifact store, jesli jest duzy.
3. Pending message trafia do `huntThreadId`, target `hunt-agent`.
4. `huntAgent` przy najblizszym bezpiecznym punkcie odbiera wynik i decyduje, czy kontynuowac, retry, partial, drop.

Nie wolno probowac wstrzykiwac wyniku do aktywnego provider streamu. Obecny `pending-message-queue` slusznie konsumuje wiadomosci tylko przy safe points.

### 10.2 Zewnetrzny interrupt: huntAgent/HuntJob -> metaAgent

Meta dostaje tylko zdarzenia istotne dla uzytkownika:

- `hunt_job_started`
- `hunt_checkpoint_ready`
- `hunt_awaiting_approval`
- `hunt_partial_ready`
- `hunt_completed`
- `hunt_failed`
- `hunt_stale`
- `hunt_cancelled`

Nie spamujemy meta kazdym leadem i kazdym workerem. Meta ma widziec zwarta informacje.

### 10.3 Zmiany w pending message source

Rozszerzyc:

```ts
type PendingMessageSource =
  | 'user'
  | 'system'
  | 'file_activity'
  | 'background_task'
  | 'automation_job'
  | 'hunt_job'
  | 'hunt_child_process';
```

Zaktualizowac filtry:

- `check-pending-updates.ts`: dodac `hunt_job` do source allowlist.
- `pending-updates.ts`: dodac `hunt_job` i opcjonalnie `hunt_child_process` dla `huntAgent`.
- Dodac `huntPendingUpdatesProcessor` dla `huntAgent`, analogicznie do `automationPendingUpdatesProcessor` i `knowledgePendingUpdatesProcessor`.

---

## 11. Narzedzia dla meta i hunta

### 11.1 Narzedzia dla meta-agenta

Nowy plik:

```text
src/mastra/tools/hunt/hunt-job-tools.ts
```

Toole:

```ts
hunt_start_job
hunt_get_job
hunt_list_jobs
hunt_cancel_job
hunt_continue_job
```

`hunt_start_job` input:

```ts
{
  mode?: HuntJobMode;
  intent: string;
  targetKind?: 'supplier' | 'restaurant';
  region?: string;
  count?: number;
  market?: string;
  outputLanguage?: string;
  constraints?: string[];
  returnToAgentId?: string;
  returnToThreadId?: string;
  wake?: boolean;
}
```

Output:

```ts
{
  success: true;
  jobId: string;
  runId?: string;
  laneNo?: number;
  status: 'queued' | 'running';
  message: string;
}
```

### 11.2 Narzedzia dla `huntAgent`

`huntAgent` potrzebuje narzedzi do wlasnych subprocesow:

```ts
hunt_start_child_process
hunt_get_child_process
hunt_list_child_processes
hunt_collect_child_updates
```

Nie musza byc publiczne dla meta. Mozna je dac tylko `huntAgent`.

`hunt_start_child_process` powinien ukrywac szczegoly delegacji:

- dla `kind: 'researcher'` odpala bounded delegation do `researcherAgent`,
- dla `kind: 'knowledge'` odpala `knowledgeAgent` lub `knowledge_query`,
- dla `kind: 'worker'` odpala `run_worker`,
- dla side-effectow lepiej uzyc bezposrednich domenowych tooli, ale zapisac child record.

To daje `huntAgent` mozliwosc uruchamiania procesow w tle bez blokowania calego pipeline'u.

---

## 12. Relacja z `delegate_task`

Nie usuwamy `delegate_task(huntAgent)`. Zmieniamy semantyke uzycia.

### Dozwolone sync delegacje do `huntAgent`

- status istniejacego joba,
- analiza jednego leada bez researchu,
- draft dla jednego juz wzbogaconego leada,
- review checkpointu,
- odpowiedz domenowa bez side effectow,
- krotkie `discover_only` gdy count jest maly i uzytkownik wyraznie chce czekac.

### Niedozwolone sync delegacje do `huntAgent`

- multi-sector hunt,
- `count > 1` z researchem,
- request zawierajacy CRM/Gmail drafts,
- request z researcherAgent / knowledgeAgent subcalls,
- request, ktory moze przekroczyc 240s,
- rownolegle 3 delegacje z meta dla jednego celu biznesowego.

Meta powinien miec routing rule:

```text
If the user asks for lead hunting from scratch, CRM writes, Gmail drafts, or multi-lead outreach,
call hunt_start_job instead of system_delegate_task(huntAgent).
```

---

## 13. Agent Board changes

W `config/agent-board.ts` zmienic karte `huntAgent`.

Docelowo:

```ts
delegation: 'both'
latencyClass: 'long'
```

`whenToUse`:

- full lead hunt,
- supplier/restaurant discovery,
- enrichment + email extraction,
- cold outreach draft pack,
- CRM/Gmail draft assembly.

`whenNotToUse`:

- single CRM lookup -> `crmAgent`,
- generic web research not related to lead hunt -> `researcherAgent`,
- pure text email rewrite for existing draft -> `marketingAgent` or `run_worker`,
- full hunt through sync `delegate_task` -> use `hunt_start_job`.

`hardRules`:

- Full hunt starts through `hunt_start_job`, not sync `delegate_task`.
- `huntAgent` may use researcher/workers as child processes, but must aggregate results into `HuntJob`.
- Gmail send is never automatic; drafts only + human approval.
- CRM/Gmail side effects require idempotency key.
- Multi-sector jobs should be parent/child jobs, not parallel sync delegations.

---

## 14. Pipeline adapter changes

Obecny `generatePipelineWithReflection` jest za waski dla background domain jobs. Trzeba rozszerzyc go bez psucia chef/content.

Dodac opcjonalne pola:

```ts
interface PipelineReflectionInput {
  // existing
  agent: Agent;
  agentKey: string;
  agentId: string;
  prompt: string;
  threadId: string;
  resourceId: string;
  taskId?: string;
  goalContractId?: string;

  // new
  abortSignal?: AbortSignal;
  jobId?: string;
  onPhaseTransition?: (event: {
    runId: string;
    phase: string;
    stepNumber: number;
  }) => void | Promise<void>;
  onStep?: (event: {
    runId: string;
    stepNumber: number;
    phase?: string | null;
  }) => void | Promise<void>;
}
```

W `generateOptions` dodac:

```ts
if (input.abortSignal) {
  generateOptions.abortSignal = input.abortSignal;
}
```

W miejscu wykrycia phase transition wywolac `onPhaseTransition`.

To pozwoli `HuntJobManager`:

- odswiezac heartbeat,
- aktualizowac `hunt_jobs.phase`,
- dopisywac milestones do ledger,
- przerwac pipeline przy cancel/timeout.

Nie dodawac depth controller / GoalContract hard stop do pipeline agents. Aktualny komentarz w adapterze jest sluszny: chef/content/hunt potrzebuja 150-step pipeline, a nie harnessu coding/automation.

---

## 15. Timeout strategy

Nie zwiekszac globalnego `DELEGATION_DIRECT_TIMEOUT_MS` jako glownej naprawy.

Docelowe budzety:

| Poziom | Env | Default | Zachowanie po timeout |
|---|---:|---:|---|
| Sync direct delegation | `DELEGATION_DIRECT_TIMEOUT_MS` | 240s | Blad sync delegacji. Nie dla full hunt. |
| Hunt job normal | `HUNT_JOB_TIMEOUT_MS` | 45 min | Abort + `partial` albo `failed`, zalezne od artefaktow. |
| Hunt job multi-sector parent | `HUNT_BATCH_TIMEOUT_MS` | 60 min | Parent agreguje child jobs; partial jest normalny. |
| Researcher child | `HUNT_RESEARCH_TIMEOUT_MS` | 5 min | Fallback do partial/Tavily/next query. |
| Knowledge child | `HUNT_KNOWLEDGE_TIMEOUT_MS` | 5 min | Partial enrichment albo skip. |
| Worker child | `HUNT_WORKER_TIMEOUT_MS` | 90s | Retry once albo cloud fallback. |
| CRM write | `HUNT_CRM_TIMEOUT_MS` | 30s | Retry idempotent, potem partial side effect warning. |
| Gmail draft | `HUNT_GMAIL_TIMEOUT_MS` | 45s | Retry idempotent, potem draft remains in report only. |

Status po timeout:

- `partial`: mamy uzywalne leady/report/drafty, ale nie pelny count albo nie wszystkie side effecty.
- `failed`: brak uzywalnego wyniku albo blad krytyczny przed artefaktami.
- `stale`: brak heartbeat dluzej niz `staleAfterMs`, bez kontrolowanego terminalnego stanu.
- `cancelled`: operator/user anulowal job.

Komunikaty dla uzytkownika musza mowic prawde:

```text
Hunt job #12 nadal pracuje: phase=enrich, 6 candidates, 3 qualified, ostatni heartbeat 8s temu.
```

albo:

```text
Hunt job #12 zakonczyl sie czesciowo: 4/6 leadow gotowe, 2 researcher subtaski przekroczyly budzet.
Report: ...
```

Nigdy:

```text
Wszystkie delegacje failed
```

jezeli lane/job nadal pracuje.

---

## 16. Child process policy

`huntAgent` moze uruchamiac researcherow i workerow, ale przez jawne child processy.

### Researcher

Uzywac gdy:

- trzeba czytac konkretne strony,
- trzeba wyciagnac menu/reviews/contact/fakty z public web,
- trzeba triangulowac zrodla.

Kontrakt:

```text
GOAL: Find/verify candidate companies for this HuntJob phase.
CONTEXT: market, region, segment, constraints.
OUTPUT CONTRACT: JSON array of candidates with name, website, evidence, confidence, sourceUrls.
SCOPE: public web only; no CRM writes; no Gmail; no drafts.
SUCCESS CRITERIA: at least N relevant candidates or explicit no-result explanation.
TIME BUDGET: HUNT_RESEARCH_TIMEOUT_MS.
```

### Worker

Uzywac gdy:

- czysta generacja tekstu,
- email extraction fallback,
- JSON repair,
- bulk draft,
- compact synthesis.

Nie uzywac workera, gdy potrzebne sa narzedzia domenowe, web access, CRM/Gmail albo memory identity.

### KnowledgeAgent

Uzywac gdy:

- potrzebny jest curated corpus / NotebookLM,
- research ma byc oparty na naszej bazie wiedzy,
- nie chodzi o swiezy public web.

---

## 17. Idempotency i side effects

Kazdy side effect musi byc bezpieczny przy retry.

### Idempotency key format

```text
hunt:{jobId}:{runId}:{phase}:{leadSlug}:{operation}
```

Przyklady:

```text
hunt:job-123:run-456:assemble:mleczna-dolina:crm_upsert
hunt:job-123:run-456:assemble:mleczna-dolina:gmail_draft
hunt:job-123:run-456:draft:mleczna-dolina:email_draft_v1
```

### CRM

- Upsert po emailu, domenie albo stabilnym company key.
- Zapisac `jobId`, `runId`, `leadSlug` w metadata/interactions.
- `recordEmailDraftTool` nie moze tworzyc duplikatu dla tego samego `idempotencyKey`.

### Gmail

- Gmail draft tworzyc raz.
- Przy retry aktualizowac istniejacy draft, jesli `gmailDraftId` jest w `hunt_jobs.artifacts.gmailDraftIds` albo lead metadata.
- Nigdy nie wysylac automatycznie.

### Hunt Report

- `hunt_doc_write_section` juz jest dobrym wzorcem.
- Sekcje leadow powinny miec stabilny anchor `lead:<slug>`.
- Retry powinien replace/update sekcje, nie dopisywac duplikatu.

---

## 18. Multi-sector i batch jobs

Przy requestach typu:

```text
znajdz leady dla mieso, nabial, warzywa i owoce
```

Nie robic:

```text
meta -> 3x delegate_task(huntAgent) sync
```

Robic:

```text
meta -> hunt_start_job(mode='full_hunt', batch=[meat,dairy,produce])
```

Potem jeden z dwoch wariantow:

### Wariant A - parent job + child hunt jobs

Parent `hunt_job`:

- lane: "Multi-sector GastroBridge hunt"
- child jobs: `meat`, `dairy`, `produce`
- parent agreguje statusy i wynik koncowy

Zalety:

- najlepsza widocznosc,
- kazdy sektor moze miec wlasny timeout,
- partial jest naturalny.

### Wariant B - jeden job, fazy per sector

Jeden `hunt_job`, wewnetrzny `sectorPlan`.

Zalety:

- mniej kolekcji/rekordow,
- prostsze MVP.

Rekomendacja: MVP moze zaczac od wariantu B, ale docelowo wariant A jest czystszy dla Task Ledger i cancel/retry per sektor.

---

## 19. Approval flow

`checkpoint_review` jest naturalnym `awaiting_approval`.

Kiedy hunt dojdzie do checkpointu:

1. Renderuje Hunt Report.
2. Zapisuje wynik w `hunt_jobs.resultPreview`.
3. Task Ledger lane przechodzi do `awaiting_approval`.
4. Pending update trafia do meta:

```text
## Hunt Job Awaiting Approval
Job ID: ...
Lane: #...
Gotowe: 5 leadow, 5 Gmail draftow, report: ...
Potrzebna decyzja: approve / revise / cancel.
```

5. Meta pyta uzytkownika.
6. Po approval:
   - jezeli nie ma send toola, system oznacza approved/ready i zostawia Gmail drafts,
   - jezeli w przyszlosci bedzie send flow, nadal musi byc osobny human-gated tool.

Wazne: approval nalezy do flow hunta, ale komunikacja z uzytkownikiem idzie przez meta.

---

## 20. Integracja z Universal Task Orchestrator

`universal-task-orchestrator.md` opisuje scheduler i `targetType=AGENT`, ale raw `agent.generate(...)` nie jest wystarczajacym dispatcherem dla hunta.

Dla scheduled tasks dodac jeden z wariantow:

### Preferowany wariant

Nowy target:

```ts
type TargetType =
  | 'AGENT'
  | 'HUNT_JOB'
  | 'N8N_WEBHOOK'
  | 'MASTRA_WORKFLOW'
  | 'WORKER_COMMAND';
```

`targetType='HUNT_JOB'` wywoluje `startHuntJob`, nie `mastra.getAgent('huntAgent').generate`.

### Alternatywa

Dispatcher `AGENT` rozpoznaje:

```ts
if (targetIdentifier === 'huntAgent' && payload?.mode === 'full_hunt') {
  return startHuntJob(...);
}
```

Preferowany jest osobny `HUNT_JOB`, bo komunikuje runtime prawde w typie.

---

## 21. Prompt changes

### `prompts/hunt/pipeline.md`

Obecny continuation contract mowi, ze agent ma run back-to-back w jednej turze. Po wprowadzeniu job managera trzeba go doprecyzowac:

- W trybie sync: moze dzialac back-to-back do checkpointu.
- W trybie job: fazy moga byc kontynuowane przez `HuntJobManager`.
- Jezeli uruchamia child process, nie raportuje konca do uzytkownika, tylko zapisuje status i kontynuuje po child result.
- `checkpoint_review` pozostaje jedynym normalnym miejscem oczekiwania na user decision.

Dodac sekcje:

```text
When running inside a HuntJob, do not treat child process wait as final output.
Use hunt_start_child_process for long research/worker tasks, record the child id,
and continue only when hunt_collect_child_updates returns usable output.
Summarize externally only at checkpoint, partial, blocked, failed, or done.
```

### `prompts/meta/base.md`

Dodac routing rule:

```text
Lead hunting from scratch, multi-lead discovery, CRM/Gmail draft assembly, or any hunt likely to require research must be started with hunt_start_job. Do not use sync delegate_task(huntAgent) for full hunt.
```

### Generated roster

Po zmianie Agent Board przebudowac generated roster skryptem, jezeli taki flow jest w repo.

---

## 22. Tool registration

Dodac `huntJobTools` do:

- `metaAgent` - start/list/get/cancel/continue,
- opcjonalnie `huntAgent` - get/list own jobs,
- nie dawac publicznych child tools meta-agentowi, chyba ze do operator/debug.

Dodac `huntPendingUpdatesProcessor` do `huntAgent`, jesli procesory sa przypinane per agent.

Dodac `hunt_job` do:

- `PendingMessageSource`,
- `LaneSource`,
- `checkPendingUpdates` source allowlist,
- `pendingUpdatesProcessor` source allowlist,
- ledger control, jesli cancel ma wolac `cancelHuntJob`.

---

## 23. Error handling

### Child timeout

Nie konczy calego joba automatycznie.

Policy:

1. Oznacz child jako `timeout`.
2. Dopisz warning do `hunt_jobs.warnings`.
3. Jezeli faza ma fallback, uruchom fallback.
4. Jezeli nadal brak danych, oznacz konkretny lead jako `partial` albo `dropped`.
5. Kontynuuj, jezeli nadal mozna dowiezc wartosciowy wynik.

### Pipeline timeout

Jesli caly job przekroczy `HUNT_JOB_TIMEOUT_MS`:

1. Abort signal.
2. Zatrzymaj heartbeat.
3. Sprawdz artefakty:
   - jest report/draft/lead data -> `partial`,
   - brak wyniku -> `failed`.
4. Queue pending update do meta.

### Stale

Stale to brak heartbeat, nie zwykly timeout childa.

`markStaleHuntJobs` i Task Ledger reconciler powinny pokazac:

```text
stale: last phase=enrich, last heartbeat=...
```

### Cancel

`cancelHuntJob(jobId)`:

1. Ustawia live cancel flag.
2. Abortuje active `agent.generate`, jesli jest.
3. Oznacza queued/running child processes jako `cancelled`.
4. Przed CRM/Gmail side effects kazda faza sprawdza cancel flag.
5. Ledger lane -> `cancelled`.
6. Pending update do meta.

---

## 24. Result envelope

Kazdy terminalny wynik hunta powinien miec strukture, ktora meta moze bezpiecznie sparsowac.

```ts
interface HuntJobResultEnvelope {
  status:
    | 'completed'
    | 'partial'
    | 'awaiting_approval'
    | 'failed'
    | 'cancelled'
    | 'stale';
  jobId: string;
  runId?: string;
  laneNo?: number;
  phase: HuntPhase;
  summary: string;
  counts: {
    requested?: number;
    candidatesFound: number;
    qualified: number;
    drafted: number;
    crmWritten: number;
    gmailDrafts: number;
    rejected: number;
  };
  artifacts: {
    reportPath?: string;
    reportArtifactId?: string;
    resultArtifactId?: string;
    crmLeadIds?: string[];
    gmailDraftIds?: string[];
  };
  warnings: string[];
  nextAction?: 'approve' | 'revise' | 'wait' | 'retry' | 'cancel';
}
```

Meta nie powinien interpretowac surowej prozy jako jedynego zrodla prawdy.

---

## 25. Feature flags i env

Nowe flagi:

```env
FEATURE_HUNT_JOBS=true
FEATURE_HUNT_CHILD_PROCESSES=true
FEATURE_HUNT_JOB_LEDGER=true
FEATURE_HUNT_JOB_SOFT_INTERRUPTS=true
```

Timeouty:

```env
HUNT_JOB_TIMEOUT_MS=2700000
HUNT_BATCH_TIMEOUT_MS=3600000
HUNT_STALE_AFTER_MS=900000
HUNT_RESEARCH_TIMEOUT_MS=300000
HUNT_KNOWLEDGE_TIMEOUT_MS=300000
HUNT_WORKER_TIMEOUT_MS=90000
HUNT_CRM_TIMEOUT_MS=30000
HUNT_GMAIL_TIMEOUT_MS=45000
```

Nie rekomenduje ustawiania:

```env
DELEGATION_DIRECT_TIMEOUT_MS=1800000
```

jako glownej naprawy, bo wtedy meta dalej blokuje conversation turn i nadal nie mamy trwalego lifecycle'u.

---

## 26. Implementacja krok po kroku

### Faza 0 - preflight

- Potwierdzic aktualne testy dla hunta i ledgera.
- Spisac obecne env timeouty.
- Dodac fixtures/smoke requesty:
  - single lead draft,
  - full hunt 3 leads,
  - multi-sector hunt,
  - forced researcher timeout.

### Faza 1 - HuntJobManager MVP

Pliki:

- `src/mastra/services/hunt-job-manager.ts`
- `src/mastra/tools/hunt/hunt-job-tools.ts`
- `src/mastra/scripts/check-hunt-job-manager.ts`

Zakres:

- `start/get/list/cancel`,
- `hunt_jobs` collection,
- Task Ledger lane,
- heartbeat,
- terminal pending update,
- bez child processow jeszcze.

Na koniec: meta moze uruchomic pelny hunt jako background job.

### Faza 2 - Pipeline adapter + abort

Pliki:

- `src/mastra/services/generate-pipeline-with-reflection.ts`
- test/check dla abort i phase transition.

Zakres:

- `abortSignal`,
- `jobId`,
- `onPhaseTransition`,
- `onStep`,
- heartbeat z callbackow.

Na koniec: timeout joba realnie zatrzymuje pipeline, zamiast tylko przegrywac `Promise.race`.

### Faza 3 - Pending updates dla `hunt_job`

Pliki:

- `src/mastra/services/pending-message-queue.ts`
- `src/mastra/tools/system/check-pending-updates.ts`
- `src/mastra/processors/pending-updates.ts`
- `src/mastra/services/task-ledger.ts`
- `src/mastra/tools/system/ledger-tools.ts`

Zakres:

- source `hunt_job`,
- pending update do meta,
- ledger cancel route do `cancelHuntJob`,
- `huntPendingUpdatesProcessor` jezeli potrzebny.

Na koniec: meta widzi wynik hunta w następnym turnie bez ręcznego lookupu.

### Faza 4 - Agent Board + meta routing

Pliki:

- `src/mastra/config/agent-board.ts`
- `src/mastra/prompts/meta/base.md`
- generated roster, jesli wymagany.

Zakres:

- `huntAgent` -> `delegation: 'both'`,
- hard rule: full hunt przez `hunt_start_job`,
- meta dostaje `huntJobTools`.

Na koniec: meta przestaje robic sync `delegate_task(huntAgent)` dla pelnych huntow.

### Faza 5 - Child process manager

Pliki:

- `src/mastra/services/hunt-child-process-manager.ts`
- `src/mastra/tools/hunt/hunt-child-process-tools.ts`

Zakres:

- `hunt_child_processes`,
- bounded researcher/knowledge/worker subprocess,
- artifact output,
- pending update do `huntAgent`,
- retry/fallback policy.

Na koniec: `huntAgent` moze odpalac researchera/workerow jako trwale child processy.

### Faza 6 - Prompt aktualizacja

Pliki:

- `src/mastra/prompts/hunt/pipeline.md`
- `src/mastra/prompts/hunt/domain.md`

Zakres:

- tryby pracy,
- child process protocol,
- no final output on child wait,
- aggregate before external update,
- checkpoint approval flow through job.

Na koniec: domenowy agent rozumie, ze jest orchestrator inside HuntJob.

### Faza 7 - Idempotency side effects

Pliki:

- CRM tools, jesli nie maja idempotency metadata.
- Gmail draft tool wrapper albo domenowy helper.
- Hunt report write rules.

Zakres:

- idempotency key,
- no duplicate CRM records,
- update existing Gmail draft on retry,
- store side-effect ids in `hunt_jobs.artifacts`.

Na koniec: retry/cancel/partial nie tworza balaganu w CRM/Gmail.

### Faza 8 - Scheduler integration

Pliki:

- `src/mastra/scripts/scheduled-task-runner.ts`
- scheduler target schema/tool, jesli istnieje.

Zakres:

- `targetType='HUNT_JOB'`,
- albo AGENT adapter for `huntAgent + full_hunt`,
- chained scheduled hunts.

Na koniec: Universal Task Orchestrator moze planowac hunty bez raw `agent.generate`.

---

## 27. Test plan

### Deterministic unit/check tests

1. `check:hunt-job-manager`
   - start job,
   - get/list,
   - heartbeat,
   - cancel,
   - terminal update.

2. `check:hunt-job-ledger`
   - lane opened on start,
   - running transition,
   - milestones on phase,
   - done/failed/cancelled,
   - digest reports finished once.

3. `check:hunt-job-pending-updates`
   - `hunt_job` pending message queued,
   - `checkPendingUpdates` returns it,
   - message consumed once.

4. `check:hunt-pipeline-abort`
   - fake long pipeline,
   - abort fires,
   - no zombie generation.

5. `check:hunt-child-processes`
   - researcher child success,
   - researcher timeout -> partial/fallback,
   - worker retry,
   - child result delivered to hunt thread.

6. `check:hunt-idempotency`
   - retry assemble does not duplicate CRM lead,
   - retry Gmail draft updates existing draft,
   - report section replace works.

### Smoke tests

1. Full hunt > 240s
   - meta starts job,
   - meta returns immediately,
   - lane remains running after 240s,
   - result arrives later,
   - no false timeout message.

2. Multi-sector
   - one parent job,
   - multiple sector child jobs or phases,
   - partial success possible,
   - parent result aggregates.

3. Approval checkpoint
   - job reaches `awaiting_approval`,
   - Task Ledger push fires,
   - pending update to meta,
   - no send.

4. Cancellation
   - cancel running hunt,
   - active generation aborts,
   - no further CRM/Gmail writes,
   - ledger lane cancelled.

---

## 28. Definition of Done

Implementacja jest gotowa, kiedy:

- meta-agent dla pelnego hunta uzywa `hunt_start_job`, nie sync `delegate_task(huntAgent)`,
- `huntAgent` nadal jest domenowym ownerem faz i jakosci,
- pelny hunt moze trwac dluzej niz 240s bez falszywego timeoutu,
- Task Ledger pokazuje prawdziwy stan hunta,
- pending update zwraca wynik do meta,
- researcher/workers moga byc child processami z timeoutami,
- CRM/Gmail side effects sa idempotentne,
- cancel realnie zatrzymuje dalsze mutacje,
- checkpoint approval jest raportowany jako `awaiting_approval`,
- testy potwierdzaja brak duplicate drafts/CRM records i brak zombie pipeline po timeout.

---

## 29. Kolejnosc decyzji dla deva

Najpierw zrobic **HuntJobManager MVP bez child processow**. To od razu naprawia falszywe timeouty meta-agenta dla pelnych huntow.

Potem dodac **abort do pipeline adaptera**. To usuwa zombie runy.

Dopiero potem dodac **child processy dla researcher/worker**. To jest docelowa wersja domenowego orchestration, ale nie musi blokowac pierwszej poprawy runtime'u.

Najkrotsza sensowna sekwencja:

```text
1. hunt_start_job + HuntJobManager + ledger + pending result
2. meta routing: full hunt -> hunt_start_job
3. pipeline abort + phase callbacks
4. hunt_job pending source + ledger cancel
5. child processes for researcher/workers
6. side-effect idempotency hardening
7. scheduler HUNT_JOB target
```

To jest kierunek docelowy: `huntAgent` jako domenowy agent, `HuntJobManager` jako runtime, Task Ledger jako zrodlo prawdy, pending updates jako komunikacja z meta-agentem.
