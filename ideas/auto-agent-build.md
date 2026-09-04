# Agent Foundry — ostateczny plan implementacji

**Wersja planu:** 2026-08-24
**Punkt odniesienia audytu:** commit `f2c479f` (`fix(observability): enforce retention and isolate DuckDB`)
**Status:** plan wykonawczy; ten dokument nie implementuje żadnego etapu.

## 1. Cel

Zbudować bezpieczną zdolność systemową, dzięki której użytkownik może powiedzieć Meta Agentowi:

> „Potrzebuję agenta do X”.

Meta rozpozna potrzebę, sprawdzi, czy naprawdę trzeba tworzyć nowego agenta, zleci research,
zaprojektuje najlepiej dopasowaną kombinację promptu, narzędzi, skilli, wiedzy i workflow,
a następnie uruchomi kontrolowany Agent Foundry. Nowy agent ma przejść deterministyczne
bramki, staging, semantic canary i jednorazową zgodę człowieka przed aktywacją.

System ma również umieć sam zauważyć powtarzalną lukę i zaproponować nowego agenta lub inne
rozwiązanie. Nie może jednak samodzielnie zmieniać live tylko dlatego, że Meta wpadł na taki
pomysł.

Docelowo zwykły interfejs użytkownika brzmi:

```text
Ty: „Zbuduj agenta, który ...”
Meta: uruchamia agent_build_start(...) i zwraca buildId
Meta: pokazuje status, pytania blokujące i raport kandydata
Foundry: tworzy deploymentId i dokładny subject zgody
Ty: zatwierdzasz dokładnie wskazany deployment
Foundry: agent_build_activate(deploymentId, ...) → świeży canary → blue-green
```

## 2. Decyzje architektoniczne — zamrożone przed implementacją

### A1. Meta jest front door, ale nie jest budowniczym

Użytkownik zleca budowę Meta Agentowi. Meta:

- tworzy wstępny `SpecialistNeedBrief`,
- może wykonać tani duplicate check,
- uruchamia trwały job Foundry,
- prezentuje status, blokery i potrzebne zgody.

Meta nie pisze kodu, nie mutuje NotebookLM, nie scala gałęzi i nie promuje wdrożenia.

Jawna prośba „zbuduj agenta” może od razu uruchomić Foundry. Gdy Meta tylko zauważy
powtarzalną lukę, wykonuje najwyżej tani duplicate check i przedstawia `SolutionProposal`;
długi research/build zaczyna po potwierdzeniu użytkownika.

### A2. Foundry jest trwałym workflow, nie kolejnym swobodnym agentem

Rdzeniem będzie `agentFoundryWorkflow`, ponieważ proces ma określone etapy, trwa długo,
potrzebuje snapshotów, retry, statusu, `suspend()`/`resume()` i zgody człowieka. Zainstalowana
wersja Mastry wspiera trwałe snapshoty workflow oraz wznawianie po restarcie/deployu.

Nie tworzymy na początku publicznego V2 lane'a `build_agent`. MVP udostępnia Meta/Meta Front
kontrolowane narzędzia start/status/answer/prepare-activation/activate/cancel. Publiczny routing
V2 może wejść dopiero po pełnym dowodzie E2E.

### A3. Foundry wybiera najlepszy typ rozwiązania, a nie zawsze nowego agenta

Każda potrzeba kończy się jedną z decyzji:

```text
reuse_agent
extend_agent
add_skill
add_capability
add_knowledge_pack
add_workflow
build_agent
hybrid
unresolved
```

Nowy agent jest uzasadniony, gdy potrzeba ma własną tożsamość/routing, powtarzalny proces,
odrębne uprawnienia, kontrakt wejścia/wyjścia albo specjalistyczny lifecycle. Sama nowa wiedza
nie jest jeszcze powodem do tworzenia agenta.

### A4. Rozdzielamy cztery różne rzeczy

- **Prompt** — rola, granice, reguły i sposób myślenia.
- **Skill** — procedura wykonywania pracy; nie przyznaje uprawnień.
- **Tool/capability** — możliwość wykonania odczytu lub działania; podlega polityce ryzyka.
- **Knowledge Pack** — wersjonowany korpus źródeł i kontrakt jego odpytywania.

Nie wolno używać skilla jako substytutu narzędzia ani wklejać dużego korpusu do promptu.

### A5. Researcher i Knowledge Agent mają osobne role

- `researcherAgent` odpowiada za świeży open-web research, triangulację, authority/freshness,
  sprzeczności i pełne cytowania.
- `knowledgeAgent` jest operatorem zatwierdzonego NotebookLM: notebooki, źródła, indeksowanie,
  query, research/import oraz readback.

NotebookLM nie jest automatycznie aktualnym źródłem prawdy. Dla prawa, medycyny, finansów
i innych dziedzin wysokiego ryzyka corpus jest bazą, a aktualność wymaga osobnej weryfikacji.

### A6. Capability Smith zamyka lukę narzędziową, nie buduje całego agenta

Foundry przekazuje do `capabilitySmith` wyłącznie precyzyjny gap contract. Po dołączeniu lub
zbudowaniu capability proces agenta jest wznawiany. Approval dla nowej integracji jest osobny
od późniejszej aktywacji agenta.

Procedurę domenową Foundry projektuje jako skill na podstawie activities/dossier, a Coding
Agent implementuje lub aktualizuje ją w istniejącym systemie skilli. Readiness sprawdza skill
registry/shelf, wymagane processors i to, że skill nie rozszerza outer tool ceiling. Prompt,
skill i capability mają więc różnych właścicieli decyzji i osobne bramki.

### A7. Coding Agent implementuje, ale Foundry posiada repo i release

Coding Agent pracuje w worktree i zwraca trwały `codingTaskId`/artifact. Foundry sam rozwiązuje
branch/worktree z durable store. Nie przyjmuje tych ścieżek z tekstu modelu.

Foundry egzekwuje zakaz `coding_apply_patch` w outer `activeTools` ceiling Coding Agenta, nie
tylko w briefie, ponieważ ten tool może sam przejąć merge do live. Branch/worktree podane w
tekście modelu są ignorowane; authority ma durable code-task artifact rozwiązany server-side.
Współdzielone registry mają jednego writera; J2 może równoleglić wyłącznie rozłączne pliki.

### A8. Nie klonujemy `capability-build.ts`

Z `capability-build.ts` należy wydzielić wspólny guarded-build core. Capability Build i Agent
Build będą cienkimi adapterami artefaktów. Jedna implementacja ma obsługiwać:

- command runner i zabijanie grupy procesów,
- claims, lease renewal i fence,
- timeout,
- deterministic merge/conflict detection,
- raportowanie i stale sweep,
- merge zweryfikowanego kodu wyłącznie jako `shadow`.

Permit, candidate, semantic canary, promote i rollback nie należą do build core. Posiada je
osobny `agent-deployment-service`, który rozszerza jeden kanoniczny deploy orchestrator
współdzielony również przez Capability Build. Dzięki temu core budowania zawsze kończy się na
`shadow_ready`, a sekwencja aktywacji nie jest kopiowana do drugiego serwisu.

Commit `c02bbb0` dowodzi kosztu kopiowania: lokalna kopia sekwencji pominęła
`start-candidate.sh` przed verify.

### A9. Build i deployment/activation to osobne byty

`agent_build_start` może dojść najwyżej do bezpiecznego `shadow_ready`. Nie uruchamia próby
aktywacji, nie aktywuje routingu live i nie zużywa permitu.

Każda próba candidate/activation dostaje nowy `deploymentId`. Retry nie wznawia starej próby
pod starym approvalem. `agent_build_activate` ponawia świeże bramki na dokładnym commicie,
zużywa permit związany z deploymentem i dopiero wtedy promuje.

Deaktywacja również jest deploymentem, nie mutacją po samym `agentId`:
`agent_build_prepare_deactivation(...)` tworzy commit i subject związany z dokładną wersją,
a `agent_build_deactivate(deploymentId, token)` używa osobnego typu permitu.

### A10. Shadow jest stanem release, nie `AgentCard.internal`

`internal` nadal znaczy „helper domenowy niewidoczny dla Meta”. Nie używamy go jako shadow.

Powstanie osobny `AgentReleaseManifest`, który filtruje jednocześnie:

- root agent registry,
- roster Meta,
- legacy delegation,
- V2 registry/allowlist,
- direct API/listing.

Stany ekspozycji: `shadow | active | retired`. Candidate może dostać jawne pozwolenie na
załadowanie dokładnie jednego shadow builda. Live ładuje wyłącznie `active`.

### A11. Deterministyczne bramki są authority bezpieczeństwa

LLM-as-judge może oceniać styl i jakość, ale nie zastępuje:

- rzeczywistego routingu,
- rzeczywistego tool call/trajectory,
- schematu i readbacku artefaktu,
- zakazu niedozwolonych narzędzi,
- source/citation/freshness contract,
- approval i release state.

Zainstalowana Mastra ma `runEvals` oraz code-based trajectory/tool-call scorers. Można je
wykorzystać za cienkim repozytoryjnym adapterem, ale ostateczny wynik gate'u ma być
deterministyczny i niesamplingowy.

### A12. Oficjalny Agent Builder jest opcjonalnym frontendem

Prawidłowy template: <https://mastra.ai/templates/agent-builder>.

W repo są już `@mastra/editor` i `new MastraEditor()`. Oficjalny Builder/Editor obsługuje
stored agents, wersje draft/published/archived, prompts, tools, workspaces i skills.

Nie tworzymy obok drugiego projektu z template'u. Adapter będzie mógł wczytać konkretny
stored draft/version i zamienić go na kanoniczny `AgentBuildSpecV2`. Builder nie publikuje
bezpośrednio do live i nie omija Board, readiness, canary ani approval. Produkcyjne użycie
Agent Builder wymaga również sprawdzenia `MASTRA_EE_LICENSE` oraz fail-closed RBAC.

### A13. Pierwszy pilot jest niskiego ryzyka

Przykład prawnika od opieki nad dzieckiem jest dobrym testem projektu researchu, ale złym
pierwszym live pilotem. Pierwszy agent ma być read-only, bez nowej integracji, bez pieniędzy,
bez PII i bez wysokiego ryzyka porady. NotebookLM provisioning nie blokuje MVP-1.

## 3. Architektura docelowa

```text
Potrzeba użytkownika lub draft Agent Builder
                 ↓
Meta → agent_build_start(SpecialistNeedBrief)
                 ↓
agentFoundryWorkflow — durable state/snapshot/status
                 ↓
R0 Intake + brakujące pytania
                 ↓
R1 Board discovery + SolutionDecision
                 ↓
R2 Research Program
  ├─ Researcher: profession/workflow
  ├─ Researcher: authority/source map
  ├─ Researcher: failures/boundaries
  └─ Researcher: excellence hypotheses
                 ↓
R3 DomainDossier + source/claim ledger + niezależna krytyka
                 ↓
R4 activity → tool | skill | knowledge | gap
  └─ gap → Capability Smith → approval → resume
                 ↓
R5 KnowledgeDecision
  └─ opcjonalnie Knowledge Agent → wersjonowany KnowledgePack
                 ↓
AgentBuildSpecV2 + publiczna AcceptanceSuite → prompt freeze → reviewer-only holdout
                 ↓
deterministyczny scaffold + Coding Agent w worktree
                 ↓
review → readiness → full gates → shadow_ready
                 ↓
activationCommit → candidate :4222 → infrastructure readiness → semantic canary
                 ↓
stop candidate/cleanup → suspend(awaiting_approval)
                 ↓
człowiek zatwierdza dokładny deployment digest
                 ↓
fresh candidate/canary → activate manifest → blue-green promote
                 ↓
post-live infra canary + minimal semantic smoke
                 ↓
active | runtime rollback + durable deactivation
```

## 4. Odpowiedzialności

| Komponent | Odpowiedzialność | Czego nie robi |
|---|---|---|
| Meta / Meta Front | przyjmuje potrzebę, uruchamia job, pokazuje status i pytania | nie implementuje, nie zatwierdza siebie |
| Agent Foundry workflow | stan, kolejność, kontrakty, stop/resume, release | nie improwizuje źródeł ani kodu |
| Researcher Agent | open-web PSEV, źródła, aktualność, sprzeczności | nie mutuje NotebookLM |
| Deliberation Agent / niezależny reviewer | krytyka projektu i excellence hypotheses dla złożonych/high-risk potrzeb | nie wydaje finalnego approval |
| Knowledge Agent | tworzy/wersjonuje/odpytuje zatwierdzony corpus | nie wybiera sam źródeł jako authority |
| Capability Smith | znajduje/buduje/attachuje brakujące capability | nie buduje promptu i identity agenta |
| Coding Agent | implementuje w przypisanym worktree | nie merge'uje i nie promuje samodzielnie |
| Code Review Agent | niezależny review implementacji | nie zatwierdza release |
| Agent Deployment Service | activation commit, candidate, canary, exact permit, promote i rollback | nie zmienia spec ani kodu agenta |
| Właściciel wdrożenia | zatwierdza exact activation/deactivation subject | nie zastępuje review SME |
| SME domenowy | zatwierdza dokładny high-risk corpus, eval set i allowed scope | nie promuje wdrożenia |

## 5. Kanoniczne kontrakty danych

Schematy muszą być Zod + typy TS. Artefakty rozmów są transportem, nie trwałym source of
truth. Obecny Artifact Store ma retencję, dlatego zamrożone dossier/spec/public evals trafiają
do repo i są hashowane w build record. Prawdziwy holdout pozostaje poza worktree implementera.

### 5.1 `SpecialistNeedBrief`

```text
needId
goal
targetUsers[]
jobsToBeDone[]
outOfScope[]
language[]
deliverables[]
autonomy: advise | draft | act_with_approval | act
jurisdiction?: { country, region?, authorityOrForum?, governingLaw?, asOf }
risk: {
  operationalBlastRadius: wasted_run | spends_money | writes_outward | changes_system
  adviceRisk: low | medium | high | regulated
  dataSensitivity: public | internal | confidential | pii | special_category
  freshness: stable | periodic | current | real_time
}
constraints[]
successExamples[]
failureExamples[]
authoringSource: meta | api | agent_builder
authoringDraftId/versionId?
```

Brak kraju/jurysdykcji/as-of dla high-risk jest blockerem. Polski język nie oznacza
automatycznie polskiego prawa.

### 5.2 `SolutionDecision`

```text
decision: reuse_agent | extend_agent | add_skill | add_capability |
          add_knowledge_pack | add_workflow | build_agent | hybrid | unresolved
alternatives[]
selectedReason
existingCoverage[]
missingCapabilities[]
expectedBenefit
costAndRisk
humanDecisionRequired: boolean
```

Nie stosować arbitralnego „80% podobieństwa”. Każda must-have activity musi być pokryta,
odrzucona jako out-of-scope albo oznaczona blockerem.

### 5.3 `DomainResearchProgram`

Foundry tworzy deterministycznie cztery briefy, zamiast pozwalać Meta improwizować:

1. `profession_work` — realne czynności, kolejność, decyzje, wejścia i produkty.
2. `authority_map` — hierarchia źródeł prawdy, jurysdykcja, obowiązywanie i aktualność.
3. `failure_boundary` — pomyłki, sąsiednie zawody, odmowy, eskalacje i brakujące fakty.
4. `excellence_research` — metodyki, książki, komentarze, narzędzia i praktyki topowych
   specjalistów jako hipotezy do sprawdzenia, nie automatyczne authority.

Każdy child task ma osobny `runId`, typed JSON output oraz `research_report` ref. Zadania
niezależne mogą iść równolegle. Synteza startuje wyłącznie, gdy każdy wymagany child ma
`completed + schema_valid + quality_passed`. `partial` i `failed` są blockerem albo uruchamiają
ograniczony liczbą prób repair; samo osiągnięcie stanu terminalnego nie wystarcza.

### 5.4 `DomainDossierV1`

```text
scope / jurisdiction / asOf / languages / risks
activities[] { id, order, inputs, outputs, decisions, escalation }
competencies[]
knowledgeRequirements[] { id, activityIds, authorityNeeded, freshnessClass }
sourceLedger[]
claimLedger[]
failureModes[]
hardRules[]
refusalAndEscalation[]
toolSkillKnowledgeCoverage[]
unresolvedGaps[]
acceptanceCaseSeeds[]
excellenceHypotheses[] { idea, evidence, expectedGain, cost, risk, acceptanceTest }
```

### 5.5 `SourceRecord` i `ClaimRecord`

`SourceRecord`:

```text
sourceId
canonicalUrlOrReference
title / publisher / author / edition / ISBN?
sourceKind: law | regulation | court | regulator | standard | official_guidance |
            book | commentary | paper | documentation | web | internal
authorityTier
jurisdiction / courtOrAgencyLevel / bindingOrPrecedentialStatus
issuedAt / publishedAt / effectiveFrom / effectiveTo
accessedAt / lastVerifiedAt / recheckBy
language
independenceGroup
contentHash? / snapshotRef?
license / ingestionRight
status: active | superseded | disputed | unavailable
supersededBy?
```

`ClaimRecord`:

```text
claimId
claim
jurisdiction / asOf
risk
sourceRefs[] { sourceId, pinpoint: { kind: article | paragraph | page | section, value } }
status: supported | conflicting | unsupported
confidence
reviewer
```

Książki i komentarze mogą uczyć procesu i interpretacji, ale nie zastępują aktualnego tekstu
prawa. Nie wolno ingestować paywalla lub książki bez praw/licencji.

Po indeksowaniu `contentHash` jest obowiązkowy i pochodzi z treści rzeczywiście odczytanej ze
źródła/NotebookLM, nie tylko z wejściowego URL. Ręczne dodanie, usunięcie lub zmiana źródła
zmienia fingerprint; pack jest fail-closed oznaczany jako `stale`.

### 5.6 `KnowledgeDecision`, `KnowledgePackSpec`, `KnowledgePackManifest`

Tryby:

```text
none | live_research | existing_corpus | versioned_corpus | hybrid
```

NotebookLM jest uzasadniony, gdy corpus będzie wielokrotnie używany, ma wiele długich źródeł,
cross-document retrieval daje wartość, a przechowanie jest prawnie i prywatnościowo dozwolone.

Nie tworzyć notebooka dla one-off lookup, kilku krótkich źródeł, szybko zmiennych danych jako
jedynej prawdy, niejasnej licencji ani akt użytkownika zawierających PII.

Manifest packa zawiera co najmniej:

```text
packId / version / domain / jurisdiction / languages
notebookAlias / resolvedNotebookId (w durable store, nie w promptach)
sourceIdMap + sourceHashes
expectedInputFingerprint / indexedCorpusFingerprint
createdAt / verifiedAt / recheckBy
queryPolicy / citationPolicy / piiPolicy
freshnessPolicy / refreshOwner
probeResults / evalSetHash
contentState: draft | verified | stale | retired
```

Zmiana źródła tworzy `vN+1`; nie mutujemy aktywnego packa w miejscu.

Proponowany przez Researchera `SourceManifest` ma jawny kontrakt:

```text
sourceManifestId / revision / purpose
dossierHash / sourceLedgerHash / claimLedgerHash
jurisdiction / asOf / allowedScope
sourceRecords[] / expectedInputFingerprint
createdBy / createdAt
status: proposed | gated | approved | rejected
```

Nie utożsamiamy hasha wejścia z hashem corpus po indeksowaniu: NotebookLM może
normalizować/ekstrahować treść. Obowiązują trzy approval records w poprawnej kolejności:

**`SourceIngestionApproval` — przed provisioningiem:**

```text
sourceManifestHash / dossierHash / sourceLedgerHash / claimLedgerHash
expectedInputFingerprint / licenseAndPrivacyDecisionHash
jurisdiction / asOf / allowedScope
reviewerIdentity / reviewerRole / approvedAt / expiresAt?
```

**`KnowledgePackVerificationApproval` — po indeksowaniu i probes:**

```text
sourceManifestHash / sourceReconciliationHash
indexedCorpusFingerprint / knowledgePackManifestHash / probeEvalHash
jurisdiction / asOf / allowedScope
reviewerIdentity / reviewerRole / approvedAt / expiresAt?
```

**`HighRiskAgentScopeApproval` — po prompt freeze i evaluator suite:**

```text
dossierHash / specHash / evaluatorDatasetHash
claimLedgerHash / knowledgePackManifestHash / allowedScope
reviewerIdentity / reviewerRole / approvedAt / expiresAt
```

Reconciliation determinizmem porównuje zatwierdzone source IDs/URLs/input hashes z faktycznie
zaindeksowanymi source IDs/statusami/content hashes i tworzy finalny pack hash. Nie wymaga
byte-równości `expectedInputFingerprint` i `indexedCorpusFingerprint`. Approval właściciela
wdrożenia nie zastępuje żadnego wymaganego approval SME.

### 5.7 `AgentBuildSpecV2`

```text
identity: {
  registryKey, runtimeId, exportName, sourceFile, name, domain
}
solution: {
  type: thin_lookup | specialist | orchestrator,
  decisionRef, dossierRef, buildReason
}
card: AgentCard fields
prompt: {
  promptRef, promptHash, language,
  derivedFromActivityIds[], derivedFromClaimIds[], requiredSections[]
}
runtime: {
  modelSequenceKey,
  maxSteps,
  memoryPolicy,
  inputProcessors[], outputProcessors[],
  toolBindings[], skillRefs[], internalDelegates[]
}
toolBinding: {
  runtimeKey, registryId, exportName, modulePath,
  risk, effects, approvalPolicy, availabilityPolicy
}
knowledge: {
  mode,
  packRequirements[] { packFamilyId, compatibleVersions, jurisdiction, requiredStatus },
  currentTruthFallback: {
    freshnessTriggers[], executor: researcherAgent | sourceOfRecordTool,
    requiredAuthority[], timeoutMs, cacheTtlMs,
    outcomes: verified | insufficient_evidence | needs_live_verification,
    failBehavior: abstain | escalate
  }
}
routing: {
  surfaces: nonempty_set<legacy_meta | v2_lane | direct_api>,
  whenToUse[], whenNotToUse[], examples[]
}
risk: {
  operationalBlastRadius, adviceRisk, dataSensitivity, freshness,
  dataHandlingPolicyRef?
}
acceptance: {
  publicDatasetRefs[], evaluatorDatasetRef? { ref, hash, visibility },
  thresholds, mandatoryGates[]
}
release: {
  initialState: shadow,
  requiredReviewers[], approvalPolicy
}
```

Modele i tools muszą wskazywać istniejące registry. Model nie generuje dowolnego import path.
Spec deklaruje rodzinę i zakres kompatybilności packa; dokładną wersję/hash przypina osobny
`AgentKnowledgeReleaseRecord`. Upgrade wiedzy tworzy knowledge deployment, canary i approval,
ale nie wymaga przebudowy niezmienionego kodu agenta.

### 5.8 Acceptance cases

Publiczne przypadki i acceptance seeds powstają przed promptem. Są dyskryminowaną unią:

- `routing_positive`,
- `routing_negative`,
- `adjacent_domain`,
- `tool_trajectory`,
- `artifact_readback`,
- `tool_failure`,
- `approval_required`,
- `refusal_or_escalation`,
- `missing_facts_clarification`,
- `freshness_or_stale_corpus`,
- `conflicting_sources`,
- `citation_exactness`,
- `prompt_injection_in_source`,
- `privacy_boundary`.

Publiczne development cases trafiają do `agent-specs/<agentId>/evals/public/`. Holdout powstaje
w osobnym runie review dopiero po zamrożeniu promptu, pozostaje poza implementacyjnym worktree
i jest przekazywany evaluatorowi wyłącznie przez kontrolowany ref+hash. Jeżeli repo nie potrafi
zagwarantować takiej niewidoczności, zestaw trzeba uczciwie nazwać `independent regression
set`, a nie holdoutem.

### 5.9 Trwałe rekordy i ich mutowalność

- `AgentBuildRecord`: niezmienna identity i spec revision; mutable projection z `version` i
  compare-and-swap; append-only receipts dla base/branch/commit, file+claim manifest,
  `codingTaskId`, gates i builder version.
- `AgentDeploymentRecord`: deploymentId, buildId, agentId, `canonicalBaseCommit`,
  `activationCommit`, `previousLiveCommit`, canonical `activationSubjectHash`, approval subject
  i terminalny wynik. Każdy retry to nowy rekord; nie tworzymy nakładającego się
  `AgentActivationRecord`.
- `AgentCanaryRecord`: deploymentId, activation commit/version, routing surfaces, release hash,
  suite/evaluator version, material verdict, trajectory i evidence/artifact hashes.
- `AgentKnowledgeReleaseRecord`: knowledgeDeploymentId, agent release, dokładny pack/version/hash,
  canary, approval i rollback target.
- `StrictApprovalReceipt`: taskId, exact tool ID, subjectHash, approvedBy, role, authMethod,
  approvedAt, expiresAt, consumedAt?, consumptionId?.

Zmiana projection jest legalna wyłącznie przez dozwolone przejście CAS. Zmiana need/spec
tworzy nową revision/build. Stan terminalny builda lub deploymentu jest absorbing. Append-only
events/receipts są authority historii lifecycle; nie nadpisują authority runtime, którym jest
Gitowy `AgentReleaseManifest` z faktycznie wdrożonego commita.

Foundry nie akceptuje legacy/unbound approval. Konsumpcja porównuje zapisany
`activationSubjectHash` z bieżącym rekordem deploymentu oraz exact `forTaskId`/`forTool`,
principal/role i TTL, a następnie atomowo wykonuje CAS `unused → consumed`. Approval przekazany
jako sam bearer bez audytowalnej tożsamości failuje.

### 5.10 `SpecialistAnswerEnvelope` dla high-stakes

Odpowiedź specjalisty high-risk ma mierzalny kontrakt, nie tylko instrukcję w prompcie:

```text
jurisdiction / asOf
knowledgePack { packId, version, hash }
liveVerificationRun? { runId, outcome, verifiedAt }
claims[] { text, sourceId, pinpoint: { kind, value }, verifiedAt }
limitations[] / missingFacts[] / escalation
```

Brak wymaganego authority, awaria live verification albo wynik inny niż `verified` wymusza
abstencję lub eskalację zgodnie z `currentTruthFallback`.

Każde zapytanie i każdy claim przechodzi deterministyczny `allowedScope` guard: dozwolone
jurysdykcje, activity/claim classes i rodzaje pomocy. Wyjście poza zatwierdzony zakres wymusza
abstencję/eskalację przed query oraz przed zwróceniem odpowiedzi.

### 5.11 `DataHandlingPolicy`

High-stakes agent deklarujący `pii|special_category` nie może opierać się tylko na
`piiPolicy` notebooka. Wersjonowana, hashowana polityka obejmuje:

```text
policyId / version / hash
acceptedDataClasses[] / rejectedDataClasses[] / childDataPolicy
channels: {
  input, memory, artifactStore, traces, logs, telemetry,
  researcherBrief, sourceOfRecordCall, externalProvider, notebookLm
}
perChannel: action(reject|redact|tokenize|store), providerAllowlist,
            retention, access, encryption, residency
redactionVerification / consentRequirements / incidentEscalation
```

Processor egzekwuje policy przed każdym storage i external call, a output processor przed
zapisem trace/artifact. Bez wdrożonej i przetestowanej polityki wariant high-stakes może działać
wyłącznie na publicznych hipotetycznych przypadkach i deterministycznie odrzuca wszelkie dane
osobowe; pełna obsługa spraw użytkownika pozostaje zablokowana.

## 6. Pipeline researchu i projektowania specjalisty

### R0. Intake i pytania blokujące

Meta wypełnia wszystko, co wynika z rozmowy. Foundry pyta użytkownika tylko o brak, który
materialnie zmienia rozwiązanie: jurysdykcję, działania zewnętrzne, PII, budżet, wymagany
produkt albo odpowiedzialność wysokiego ryzyka.

### R1. Discovery i decyzja build-vs-extend

1. Odczyt pełnych kart z `agentBoard`.
2. Porównanie must-have activities, kontraktu wyjścia i uprawnień.
3. Przeszukanie Tool Registry, Skill Registry, capability registry i istniejących Knowledge
   Packs.
4. Zapis `SolutionDecision` z alternatywami.

**STOP:** jeżeli lepsze jest rozszerzenie istniejącego agenta, skill, workflow albo pack,
Foundry nie tworzy duplikatu. Dla jawnej prośby użytkownika przedstawia rekomendację i czeka
na decyzję tylko wtedy, gdy zmienia ona zakres/koszt/ryzyko.

### R2. Research Plan

Research depth jest wyliczany z ryzyka i świeżości:

- `none` — mechaniczny thin lookup z już znanym kontraktem,
- `fast` — niski risk, stabilna domena,
- `standard` — specjalista domenowy,
- `deep` — złożona domena lub nowy corpus,
- `regulated` — high-stakes, jurysdykcja, SME i aktualność.

### R3. Cztery ścieżki researchu

Foundry uruchamia briefy z §5.3. Researcher stosuje PSEV i quality-based confidence. Sama
liczba trzech podobnych stron nie oznacza weryfikacji. Mirror/syndication nie liczy się jako
niezależne źródło.

### R4. Synteza i adversarial review

`DomainDossierV1` powstaje dopiero po `completed + schema_valid + quality_passed` wszystkich
wymaganych child tasks. Osobny reviewer sprawdza:

- pominięte wyjątki i warunki przejściowe,
- amendment/repeal/superseded sources,
- sprzeczności,
- sąsiednie profesje i boundary,
- niebezpieczne założenia,
- czy citation faktycznie wspiera claim,
- czy „excellence idea” ma dowód i test oczekiwanej poprawy.

Nierozwiązany konflikt high-risk blokuje dalszy etap.

### R5. Activity coverage

Każda activity ma dokładnie jeden jawny wynik:

```text
covered_by_tool
covered_by_skill
covered_by_knowledge
covered_by_internal_delegation
out_of_scope
blocked_gap
```

`blocked_gap` powoduje suspend i przekazanie kontraktu do Capability Smith. Sam status
„capability built” nie wystarcza: spec musi wskazywać realny tool binding dostępny przyszłemu
agentowi.

### R6. Excellence Design pass

Meta/Deliberation Agent odpowiada na pięć pytań na podstawie dossier, nie ogólnej wyobraźni:

1. Co robi topowy specjalista, czego nie zrobi ogólny chatbot?
2. Jaki proces, tool, corpus albo wewnętrzna delegacja daje największy przyrost jakości?
3. Które reguły powinny być skillem, a nie częścią stałego promptu?
4. Jak agent rozpoznaje brak danych, konflikt, aktualność i moment eskalacji?
5. Jak empirycznie udowodnimy, że pomysł poprawił wynik?

Każda idea trafia do `excellenceHypotheses` z acceptance test. Pomysł bez testu nie zostaje
automatycznie częścią architektury.

### R7. Knowledge path

Jeżeli `KnowledgeDecision` wybierze pack:

1. Researcher tworzy **proponowany** `SourceManifest`; jego własny research ani
   `knowledgeAgent research/import` nie nadają źródłu statusu `verified`.
2. Deterministyczny gate ponownie sprawdza każde źródło: authority, jurisdiction, license,
   privacy, freshness i spójność claimów.
3. Dla high-risk corpus SME wydaje `SourceIngestionApproval` na dokładny manifest,
   `expectedInputFingerprint`, prawa i `allowedScope`.
4. Provisioning przyjmuje wyłącznie ingestion approval. Knowledge Agent tworzy
   `agent:<runtimeId>:<jurisdiction>:vN` i dodaje źródła sekwencyjnie.
5. Po indeksowaniu wykonuje readback rzeczywistej treści/ID/statusów, liczy content hashes i
   tworzy `indexedCorpusFingerprint` oraz deterministyczny source reconciliation report.
6. Wykonuje probe questions, citation checks i negatywne privacy/freshness cases, po czym
   zapisuje finalny `KnowledgePackManifest`.
7. Dla high-risk SME wydaje osobny `KnowledgePackVerificationApproval`, związany z finalnym
   manifestem, corpus fingerprint i probe eval hash.
8. Dopiero zweryfikowany pack może zostać przypięty przez
   `AgentKnowledgeReleaseRecord`.

Mutujące NotebookLM tools (`create/add/delete/import`) nie mogą pozostać zwyczajnie dostępne
Meta w `meta-agent.ts`. Usunąć je z jego tool setu albo objąć ścisłym, manifest-bound permit;
preferowana ścieżka to delegacja zatwierdzonego manifestu do Knowledge Agenta. Każdy materiał
znaleziony automatycznie wraca jako kandydat i ponownie przechodzi gate przed włączeniem.

Nowy specjalista nie dostaje raw NotebookLM admin tools. Dostaje ograniczony kontrakt typu:

```text
specialist_knowledge_query(packId, version, question, jurisdiction, asOf, dataClassification)
```

Wrapper przed zewnętrznym wywołaniem egzekwuje data boundary: blokuje lub redaguje PII i dane
dziecka, nigdy nie wysyła surowych faktów sprawy do wspólnego notebooka, a następnie sprawdza
pinned version, freshness, citation/source ID oraz `allowedScope` dla jurysdykcji, activity,
claim class i rodzaju pomocy. Ten sam scope guard waliduje każdy claim odpowiedzi. Negatywny
test ma dowieść, że przy naruszeniu privacy/scope nie nastąpił żaden zewnętrzny call. Przy
stale/unavailable/absent zwraca
`needs_refresh` albo `insufficient_evidence`; nie degraduje się do wiedzy modelowej.

W trybie `hybrid` wrapper uruchamia wykonywalny `currentTruthFallback` po zdefiniowanym
freshness triggerze: wskazany Researcher/source-of-record tool, wymagane authority, timeout i
cache TTL. Wynik jest jednym z `verified | insufficient_evidence | needs_live_verification`;
awaria oznacza obowiązkową abstencję/eskalację, nigdy ciche użycie starego corpus.

### R8. Prompt i evals

Najpierw publiczna acceptance suite, później prompt. Po zamrożeniu promptu niezależny reviewer
tworzy niewidoczny dla implementera holdout (albo jawny independent regression set, jeżeli
izolacji nie da się zagwarantować). Dossier generuje:

- identity i zakres,
- workflow/metodykę,
- hard rules i boundary,
- narzędzia i skille,
- knowledge/freshness policy,
- failure, approval, refusal i escalation,
- final status/output contract.

Każda ważna reguła ma `derivedFrom` wskazujące activity/claim/source IDs w build record.
Dla high-risk po zamrożeniu spec i evaluator dataset SME wydaje dopiero wtedy
`HighRiskAgentScopeApproval`; wcześniejsze zgody na ingestion/pack nie zatwierdzają promptu ani
zakresu zachowania agenta.

## 7. Przykład projektowy: „prawnik od opieki nad dzieckiem”

To przykład testujący pełną architekturę, nie pierwszy live pilot.

1. Intake pyta o kraj, region/sąd, prawo właściwe, stan na dzień oraz oczekiwany rodzaj pomocy.
2. `adviceRisk=regulated`, `dataSensitivity` co najmniej `pii`, często
   `special_category`; sam brak outward write nie obniża ryzyka.
3. Foundry rozważa nazwę/zakres „asystent researchu prawa rodzinnego” zamiast obietnicy
   zastępowania lokalnego prawnika.
4. Researcher mapuje:
   - obowiązujące akty i przepisy przejściowe,
   - oficjalne procedury/formularze,
   - właściwe sądy/urzędy i aktualne terminy,
   - precedensy zgodnie z hierarchią,
   - oficjalne guidance i standardy etyczne,
   - dopiero później komentarze, podręczniki i książki.
5. Dossier opisuje kompetencje: zebranie faktów, pytania brakujące, objaśnienie procesu,
   checklisty, draft do przeglądu, cytowania i datowanie.
6. `KnowledgeDecision=hybrid`: wersjonowany corpus bazowy + live freshness check dla
   aktualnego prawa, procedur, formularzy, właściwości i terminów.
7. Wspólny notebook nigdy nie przechowuje akt rodzinnych ani danych dziecka. Per-user case
   corpus z consent/access/retention jest osobnym późniejszym projektem. Do czasu pełnego
   `DataHandlingPolicy` obejmującego pamięć, artifacts, traces, Researchera i providerów agent
   przyjmuje tylko publiczne hipotetyczne przypadki i odrzuca PII przed jakimkolwiek zapisem
   lub external call.
8. Agent nie gwarantuje wyniku, nie udaje pełnomocnika, nie składa pism, nie wylicza terminu
   bez świeżego authority i eskaluje zagrożenie bezpieczeństwa dziecka do lokalnej pomocy.
9. Evals obejmują zmianę kraju/daty, nieobecny fakt, stare prawo, konflikt źródeł, injection w
   źródle, brak cytowania, emergency i awarię Knowledge Agent.
10. Aktywacja wymaga `HighRiskAgentScopeApproval` związanego z dokładnymi `dossierHash`,
    `specHash`, `claimLedgerHash`, `evalSetHash`, finalnym pack hash i `allowedScope`. Bez niego agent
    pozostaje w shadow. Wariant „tylko research/draft do profesjonalnego przeglądu” jest nową,
    węższą spec revision i ponownie przechodzi evals oraz approval; nie jest furtką w istniejącej
    zgodzie.

## 8. Refaktory przygotowawcze — zanim powstanie generator

Stara lista „10 touchpointów” jest niepełna. Aktualnie istnieją również ręczne mapy w
`delegate-task.ts`, dwie niezależne mapy źródeł audytowych, kilka map modeli, dashboard
topology i aliasy ID. Nie uczymy generatora wszystkich duplikatów bez próby ich usunięcia.

### 8.1 Jeden registry źródeł agentów

Utworzyć `src/mastra/config/agent-source-registry.ts`, konsumowany przez:

- `audit-agent-limits.ts`,
- `audit-agent-readiness.ts`,
- `check-deliverable-capability.ts`.

Brak wpisu ma failować przed filtrowaniem.

### 8.2 Ujednolicić ID i delegację

- Wyprowadzić mapowanie Board key ↔ runtime ID z jednego registry.
- Usunąć lub generować ręczne `delegate-task.ts::AGENT_IDS`.
- Dodać jawne caller/return aliases tylko dla async/internal delegation.
- Testować camelCase/kebab-case i self-delegation.

### 8.3 Uprościć model manifest

`agentModelSequences` jest authority; `agentModels` i fallback chains powinny być wyprowadzone
albo kontrolowane jednym helperem. Generator nie może zapomnieć jednego z wpisów.

### 8.4 File-only Board i roster

Rozdzielić czyste `renderRoster(...)` od Mongo projection. Dodać `--file-only`. Build w
worktree nigdy nie uruchamia aktualnego CLI, które zapisuje do żywej `agent_board`.

### 8.5 Dashboard i topology z Board

Usunąć ręczną listę agentów dashboardu albo generować ją z tego samego registry.

### 8.6 Tool Binding Registry

Utworzyć `src/mastra/config/tool-binding-registry.ts` z polami:

```text
runtimeKey, exportName, modulePath, source, category,
risk, effects, approvalPolicy, availabilityPolicy
```

Foundry używa wyłącznie zarejestrowanych bindingów. Nie trzeba od razu przepisać wszystkich
tooli; fail-closed registry może rosnąć o zatwierdzone dla Foundry narzędzia.

### 8.7 Agent Release Manifest

Utworzyć `src/mastra/config/agent-release-manifest.ts` i wspólny resolver ekspozycji.

```text
agentId, buildId, state: shadow | active | retired,
surfaces[], specHash, activatedAt?, retiredAt?
```

Candidate może włączyć tylko matching `buildId`. Live ignoruje `shadow` nawet przy kolejnym
niepowiązanym deployu.

### 8.8 Macierz touchpointów w okresie przejściowym

Zanim refaktory z §8 usuną duplikaty, scaffold musi planować i readiness musi sprawdzać:

**Zawsze:**

- `agent-specs/<agentId>/` z need/dossier/spec/evals,
- `src/mastra/prompts/<domain>/...`,
- `src/mastra/agents/<runtime-id>.ts`,
- `model-manifest.ts` — sequence oraz pochodne primary/fallback,
- `agent-board.ts`,
- `index.ts` — import i root registration,
- centralny agent source registry,
- release manifest,
- file-only generated roster.

**Warunkowo:**

- `agent-ids.ts` i async caller/return policy,
- tool/skill shelf profile tylko przy niestandardowych pinach, tagach lub budżecie,
- processors w konstruktorze i `shared/skill-shelf` w prompcie, gdy agent używa półek,
- artifact vocabulary/output validators,
- memory/workflow/scorers,
- Knowledge Pack pin,
- jawna V2 allowlist dopiero w osobnym zatwierdzonym release.

Jeżeli centralizacja nie została jeszcze ukończona, readiness ma failować na brak ręcznego
`delegate-task.ts::AGENT_IDS`, obu dawnych map `AGENT_SOURCES` i dashboard topology. Generator
nie może udawać, że tych miejsc nie ma.

### 8.9 Dokładne lokalne punkty integracji

Plan implementacyjny i code review muszą jawnie objąć co najmniej:

- ekspozycję Meta: `src/mastra/agents/meta-agent.ts`, `meta-front-agent.ts`,
  `prompts/meta/base.md`, `prompts/meta-front/base.md`;
- root/workflow/API/dashboard: `src/mastra/index.ts`;
- delegację i roster: `tools/system/delegate-task.ts`, `tools/system/agent-board-tools.ts`;
- politykę runtime: `config/capability-routing.ts`, w tym
  `SIDE_EFFECT_PRODUCT_CAPABILITIES` i `DEFAULT_V2_CAPABILITIES`;
- współdzielony build: `services/capability-build.ts`, `task-ledger-scheduler.ts`;
- bezpieczna delegacja kodu: `agents/coding-agent.ts`, `services/coding-harness.ts`,
  `services/parallel-dispatch.ts`, `tools/dev/code-task-artifacts.ts`,
  `tools/dev/code-worktree.ts`;
- approval: `services/one-time-permit.ts`, `tools/system/request-approval.ts`;
- candidate/deploy: `scripts/autoheal/start-candidate.sh`, `scripts/autoheal/lib.sh` i
  kanoniczny deploy orchestrator;
- wszystkich klientów Mongo, w tym `src/mastra/lib/mongo.ts` i jego osobny
  `rss_intelligence` database selection;
- rejestrację komend: `package.json`, `scripts/check-all.sh`.

Readiness dowodzi, że `shadow` nie występuje w root `/api/agents`, Meta rosterze, legacy
delegation ani default V2. Sama nieobecność na dashboardzie nie wystarcza.

## 9. Etapy implementacji

### ETAP 0 — Zamrożenie baseline i ADR-y (0,5 dnia)

**Pliki:**

- ten dokument,
- `docs/adr/agent-foundry-*.md` lub istniejący katalog decyzji,
- żadnych zmian runtime.

**Prace:**

1. Po handoffie właściciel wskazuje dokładny `BASE_COMMIT`; nie zakładać automatycznie, że
   dzisiejszy HEAD ani bieżące dirty pliki są właściwą bazą.
2. Zapisać pełny snapshot `git status --short`. Jeśli którykolwiek planowany touchpoint jest
   dirty, zatrzymać etap do handoffu — bez stashowania, checkoutowania i nadpisywania cudzej
   pracy. Następnie utworzyć osobny worktree dokładnie z uzgodnionego SHA.
3. Zapisać wersje `@mastra/core`, `@mastra/editor`, `@mastra/evals` i Node.
4. ADR: workflow vs agent, static authority vs Editor draft, release manifest, build/activate,
   research/knowledge boundary.
5. Sprawdzić produkcyjny warunek licencji/RBAC Agent Builder. Brak licencji nie blokuje core
   Foundry; wyłącza tylko adapter UI.
6. Zamrozić nazwy statusów i publicznych narzędzi.

**Akceptacja:** nie ma nierozstrzygniętej decyzji o source of truth ani lifecycle.

### ETAP 1 — Kontrakty i governance foundation (1,5–2 dni)

**Nowe pliki sugerowane:**

- `src/mastra/config/agent-foundry-schemas.ts`,
- `src/mastra/config/agent-source-registry.ts`,
- `src/mastra/config/tool-binding-registry.ts`,
- `src/mastra/config/agent-release-manifest.ts`,
- `src/mastra/services/agent-foundry-records.ts`,
- `src/mastra/services/agent-foundry-status.ts`,
- `src/mastra/scripts/check-agent-foundry-contracts.ts`.

**Zmiany:**

- wszystkie schematy z §5,
- rozdzielenie advice/data/freshness risk od operational blast radius,
- refaktory §8,
- immutable identity/spec revision + append-only events/receipts + versioned CAS projection,
- hashowanie canonical JSON,
- file-only roster.

**Negatywne testy:**

- brak runtime ID mapping,
- nieznany tool binding,
- skill żąda narzędzia poza tool ceiling,
- high-risk bez jurysdykcji,
- shadow widoczny w dowolnej powierzchni live,
- identity/spec zmienione zamiast nowej rewizji albo projection update bez właściwego CAS,
- legacy/unbound/expired approval lub subject bez audytowalnego principalu.

**Akceptacja:** registry drift ma pojedynczy source of truth; shadow jest naprawdę niewidoczny
w live composition.

### ETAP 2 — Research and Solution Design workflow (2–3 dni)

**Nowe pliki sugerowane:**

- `src/mastra/services/agent-domain-research.ts`,
- `src/mastra/services/agent-solution-decision.ts`,
- `src/mastra/prompts/agent-foundry/profession-work.md`,
- `src/mastra/prompts/agent-foundry/authority-map.md`,
- `src/mastra/prompts/agent-foundry/failure-boundary.md`,
- `src/mastra/prompts/agent-foundry/excellence-review.md`,
- `src/mastra/workflows/agent-foundry-workflow.ts` (pierwszy trwały slice: intake/research),
- `src/mastra/scripts/check-agent-domain-research.ts`.

**Prace:**

1. Deterministyczny intake i blocker questions.
2. Board/tool/skill/capability/knowledge discovery.
3. `SolutionDecision` z alternatywami.
4. Cztery durable child research tasks z osobnymi run/thread IDs i typed terminal receipts.
5. Dossier/source/claim normalization.
6. Adversarial review.
7. Activity coverage, blocker question oraz capability-gap `suspend/resume` w tym samym
   trwałym workflow.
8. Excellence hypotheses z wymaganym acceptance test.

**Bramka researchu fail-closed:**

- każda must-have activity pokryta albo blocker,
- każdy material high-risk claim ma aktualne authority, jurisdiction, effective date i pinpoint,
- konflikty i brak licencji jawne,
- brak „verified”, jeśli citation nie wspiera claim,
- source freshness spełnia policy.

**Akceptacja:** restart procesu zachowuje workflow state, blocker question i terminalne child
receipts. Synteza nie rusza dla `partial/failed/schema_invalid/quality_failed`. Fixture
legal-country zatrzymuje się na braku kraju, starym prawie, sprzeczności i nielegalnym
ingestion; low-risk fixture produkuje kompletne dossier.

### ETAP 3 — Knowledge Pack track (MVP schema, potem provisioning) (1–3 dni)

**MVP-1:** zaimplementować `KnowledgeDecision`, manifest, pinning i gate, ale pierwszy live
pilot może użyć `none`, `live_research` lub istniejącego corpus.

**MVP-2 — nowe pliki sugerowane:**

- `src/mastra/services/knowledge-pack.ts`,
- `src/mastra/tools/knowledge/specialist-knowledge-query.ts`,
- `src/mastra/scripts/check-knowledge-pack.ts`.

**Prace:**

1. Wybrać jedną kanoniczną mutującą ścieżkę: zatwierdzony manifest delegowany do
   `knowledgeAgent`, nie bezpośrednie Meta CLI wrappers. Usunąć albo permit-bound zablokować
   mutujące NotebookLM tools nadal dostępne w `meta-agent.ts`.
2. Source/claim/authority/license/privacy/freshness gate przed ingestem; wyniki
   research/import są wyłącznie kandydatami.
3. Trzy właściwie uporządkowane approval records dla high-risk: ingestion przed importem,
   verification po indeksowaniu/probes, scope po finalnej spec/evaluator suite.
4. Sekwencyjne source add + status/readback + content hash rzeczywiście odczytanej treści;
   osobne `expectedInputFingerprint` i `indexedCorpusFingerprint` łączy deterministyczny
   reconciliation report.
5. Immutable versioning packów i fail-closed wykrywanie out-of-band zmian jako `stale`.
6. Ograniczony read-only query wrapper z egzekwowanym privacy boundary oraz
   version/freshness/citation contract.
7. Wykonywalny `currentTruthFallback`, `SpecialistAnswerEnvelope`, pack probes i delta evals.
8. Knowledge deployment/activation/rollback niezależne od kodu agenta.
9. `allowedScope` guard oraz `DataHandlingPolicy` contract; pełne egzekwowanie storage/provider
   policy jest warunkiem wariantu high-stakes przyjmującego PII w ETAPIE 9.

**Akceptacja:** stary, nieistniejący albo zmieniony pack nie degraduje się do modelowej
wiedzy i blokuje/eskaluje zgodnie ze spec. Negatywny privacy test dowodzi braku zewnętrznego
NotebookLM calla; ręczna zmiana źródła unieważnia pack.

### ETAP 4 — Deterministyczny scaffold, readiness i eval runner (2–3 dni)

**Nowe pliki sugerowane:**

- `src/mastra/services/agent-scaffold.ts`,
- `src/mastra/scripts/scaffold-agent.ts`,
- `src/mastra/scripts/check-agent-scaffold.ts`,
- `src/mastra/scripts/check-new-agent-ready.ts`,
- `src/mastra/services/agent-eval-runner.ts`,
- `agent-specs/<agentId>/{need,dossier,sources,knowledge,spec}.json`,
- `agent-specs/<agentId>/evals/public/*.json`,
- evaluator-only store/ref dla prawdziwego holdoutu (poza worktree Coding Agenta).

**Generator:**

- `planAgentScaffold(spec)` jest czysty i zwraca plan/diff,
- osobne `applyAgentScaffold(plan, worktree)` zapisuje,
- brak Mongo i LLM,
- dry-run + idempotence,
- tool imports wyłącznie z Tool Binding Registry,
- conditional touchpoints wynikają ze spec,
- domyślne shelf profiles nie tworzą zbędnych wpisów; użycie shelf wymaga jednak właściwych
  processors i prompt contract,
- roster tylko file-only.

**Readiness:**

- `audit-agent-readiness --agent --fail-closed`,
- blokery oddzielone od advisories/waivers,
- `audit-agent-limits` i prompt-tool check z filtrem pojedynczego agenta,
- Board/index/model/source/ID/release/roster/tool/skill/knowledge consistency,
- output artifact capability,
- risk/reviewer policy.

**Evals:**

- routing i behavior osobno,
- rzeczywiste tool invocations/trajectory,
- artifact readback,
- deterministic safety contract 100%,
- LLM quality score tylko jako dodatkowy próg,
- publiczne cases zamrożone przed promptem; holdout wydawany po zamrożeniu promptu przez
  niezależnego reviewera i udostępniany evaluatorowi przez hash/ref, nigdy implementerowi.

**Red tests:** brak każdego obowiązkowego registry, zła route, forbidden tool, pusty artifact,
zły pack hash, stale source, agent twierdzący że zapisał bez readbacku.

**Akceptacja:** tymczasowy fikcyjny agent przechodzi w izolowanym worktree; świadome usunięcie
każdego kontraktu daje czerwony gate. Usuwanie fixture przez skasowanie worktree, nigdy
`git checkout` na współdzielonym drzewie.

### ETAP 5 — Shared guarded-build core i durable Foundry (2–3 dni)

**Nowe pliki sugerowane:**

- `src/mastra/services/guarded-build-core.ts`,
- `src/mastra/services/agent-build.ts`,
- rozszerzenie `src/mastra/workflows/agent-foundry-workflow.ts` z ETAPU 2,
- `src/mastra/tools/system/agent-foundry-tools.ts`,
- `src/mastra/scripts/check-agent-build-gates.ts`,
- testy lease/fence/status/suspend-resume.

**Publiczny kontrakt:**

```text
agent_build_start(need | needArtifactRef | editorDraftRef) -> buildId
agent_build_status(buildId)
agent_build_answer(buildId, questionId, answer)
agent_build_cancel(buildId, reason)
```

Typy przyszłych operacji activation/deactivation mogą już istnieć w schemacie, ale ich tools
pozostają niezarejestrowane albo fail-closed do ukończenia ETAPU 6.

**Pipeline build:**

```text
intake → solution_decision → research → spec_freeze
→ repo_claim → coding delegation → review
→ tsc/static gates/full check in worktree
→ merge as shadow → build receipts/CAS projection → shadow_ready
```

**Wymagania:**

- shared core, zero nowej kopii scaffold/claim/gates/shadow merge,
- jeden dokładny globalny repo claim współdzielony z Capability Build; scheduler disabled
  oznacza fail-closed,
- heartbeat także podczas oczekiwania na claim,
- kroki widoczne w statusie w trakcie pracy,
- `runId` per child/retry,
- fence przed shadow merge,
- codingTaskId rozwiązywany server-side,
- outer `activeTools` ceiling usuwa `coding_apply_patch`; branch/worktree z outputu modelu są
  ignorowane na rzecz durable artifactu z `code-task-artifacts`/`code-worktree`,
- niezależny code review przed merge,
- każda zmiana spec tworzy nową rewizję,
- terminalny build jest absorbing; retry deploymentu nie otwiera starego rekordu.

**Akceptacja:** build nigdy nie promuje ani nie zużywa approval; utrata claimu, czerwony gate,
stary review, pusty diff i konflikt merge zatrzymują proces. ETAP kończy się wyłącznie na
`shadow_ready`; nie uruchamia candidate ani semantic canary. Negatywny test dowodzi, że
delegat nie może wywołać `coding_apply_patch`, a fałszywa ścieżka w tekście modelu nie jest
używana.

### ETAP 6 — Isolation, candidate, approval, activation i recovery (3–5 dni)

#### ETAP 6A — Izolacja, globalne claims i deploy orchestrator

Commit `f2c479f` dodał izolację candidate DuckDB (`:memory:` lub osobna ścieżka) i realny
observability probe. Semantic canary używa tego kontraktu; nie dotyka live DuckDB.

**Nowe pliki/touchpointy sugerowane:**

- `src/mastra/services/agent-deployment-service.ts`,
- `src/mastra/services/agent-semantic-canary.ts`,
- `src/mastra/scripts/check-agent-candidate-isolation.ts`,
- rozszerzenie kanonicznego deploy orchestratora i przepięcie
  `capability-build.realPromote()` na tę samą granicę.

To nie izoluje automatycznie Mongo. Candidate musi dostać osobny `MONGODB_URI` i bazę nazwaną
z `deploymentId`; cleanup nie jest granicą bezpieczeństwa. `start-candidate.sh` nie może tylko
kopiować live `.env`, a `lib/mongo.ts::getRssDb()` nie może hardcodować wspólnego
`rss_intelligence`. Każdy candidate data client dostaje izolowaną bazę albo jest wyłączony.
Przed startem fail-closed porównujemy candidate/live URI i wszystkie resolved database names.
Sentinel zapisany przez każdy client nie może pojawić się w żadnej live DB. Candidate nie
zapisuje do live `agent_events`, artifacts, `agent_board` ani danych RSS; crash cleanup usuwa
śmieci, ale nigdy nie zastępuje izolacji.

Kanoniczny orchestrator ma wystawić jedną typowaną granicę: `start+verify → semantic hook →
pre-promote policy → promote → infra+semantic smoke → mark`, z możliwością zatrzymania po
pierwszym semantic hooku. Korzystają z niej Agent Foundry, Capability Build i autoheal przez
typowane strategie pre-promote, nie dowolny callback/string shellowy: Foundry używa
`exact_permit_ff_only`, a pozostałe ścieżki zachowują własną jawnie zatwierdzoną politykę.
Repo claim nie zastępuje globalnego claimu na live runtime ani claimu na candidate slot.

**Akceptacja 6A:** fail-closed isolation proof dla DuckDB i każdego Mongo clienta, konkurencyjny
autoheal/deploy nie omija claims, a wszystkie trzy ścieżki wchodzą przez typowany orchestrator.

#### ETAP 6B — Deployment service i semantic canary

**Publiczny kontrakt:**

```text
agent_build_prepare_activation(buildId) -> deploymentId
agent_build_deployment_status(deploymentId) -> status + approvalSubject?
agent_build_activate(deploymentId, approvalToken)
agent_build_prepare_deactivation(agentId, targetState, knowledgeRollbackTarget?, reason)
  -> deploymentId
agent_build_deactivate(deploymentId, approvalToken)
```

**Kolejność bezwzględna:**

```text
prepare one-child activation commit (release manifest = active; allowlisted diff only)
readiness/static activation gates → activationGateHash
acquire candidate slot → build/start/verify candidate :4222
agent semantic canary → approvalCanaryDigest + initialCanaryEvidenceHash
stop candidate → zamknij izolowane zasoby → zwolnij slot/claim
awaiting_approval / suspend
```

Semantic candidate canary jest **po** start+verify i **przed** promote. Istniejący
`canary-watch.sh` pozostaje post-promote infra canary; to dwa różne testy. Pierwszy candidate
nie może działać podczas godzinnego/dniowego oczekiwania na zgodę.

Nie kodować tej sekwencji drugi raz w `agent-deployment-service`; serwis składa typowane kroki
orchestratora z 6A.

**Semantic canary sprawdza:**

1. agent istnieje w candidate runtime i mapping ID jest poprawny,
2. release resolver wczytał dokładnie `activationCommit` ze stanem `active`; shadow override
   wolno użyć tylko we wcześniejszym teście strukturalnym, nie w release canary,
3. każda deklarowana routing surface ma 3 positive + 2 negative cases,
4. pre-execution executor allowlist/denylist blokuje forbidden tool przed wywołaniem, a
   zarejestrowane calls/trajectory spełniają ceiling,
5. 1–2 bezpieczne E2E zwracają właściwy produkt,
6. artifact jest ponownie odczytany i zweryfikowany,
7. pinned knowledge pack/citations/freshness są zgodne,
8. forbidden tools i source injection są odrzucone.

Mongo `agent_board` nie jest obowiązkowym dowodem runtime. Jest wtórną projekcją i nie może
być synchronizowana do live przed promote.

Activation commit jest dokładnie jednym potomkiem `canonicalBaseCommit`. Dozwolony diff to
release manifest i deterministycznie wygenerowane powierzchnie ekspozycji; żadnej zmiany kodu,
promptu, tooli ani spec. Readiness/static gates biegną ponownie na tym commicie, a ich wynik
tworzy `activationGateHash`.

**Akceptacja 6B:** candidate testuje exact active activation commit, forbidden executor jest
blokowany przed wywołaniem, każdy surface ma dowód, a proces i izolowane zasoby są zamknięte
przed `awaiting_approval`.

#### ETAP 6C — Strict approval, activation, deactivation i recovery

**Activation po approval:**

```text
agent_build_activate:
acquire repo claim + global `runtime:mastra-live` claim + candidate slot
verify main == canonicalBaseCommit AND live version/state == previousLiveCommit
fresh build/start/verify/semantic canary tego samego activationCommit
require materialnie identyczny approvalCanaryDigest
re-read main + live version/state bezpośrednio przed permit
consume permit for `agent_build_activate` + `git merge --ff-only` activationCommit
pre-swap ponownie assert HEAD/live target → promote candidate
post-promote infrastructure canary :4111 + minimal live semantic smoke
mark deployment complete / release active → zwolnij claims
```

**Approval subject:**

```text
deploymentId + buildId + agentId + activationCommit + specHash + gateHash +
activationGateHash + canarySuiteHash + approvalCanaryDigest + initialCanaryEvidenceHash +
releaseManifestHash + knowledgeReleaseHashes +
canonicalBaseCommit + previousLiveCommit +
rollbackTargetReleaseState + knowledgeRollbackTarget
```

`approvalCanaryDigest` hashuje deterministyczny wektor kontraktów per case: activation commit,
suite/evaluator version, case IDs, route target, znormalizowany dozwolony graf/kolejność tool
IDs, effect classes, schema/artifact-readback invariants i pass/fail verdict. Wyklucza tekst
modelu, volatile args, generowane IDs, timestamps i surowe trajectories. Pierwszy oraz świeży
run zachowują pełne, różne evidence hashes; świeży musi mieć ten sam contract digest, nie
byte-identyczny output. Materialna różnica, zmiana któregokolwiek pola subjectu albo gate
tworzy nowy deployment i nowy approval.

Permit ma `forTaskId=deploymentId`, `forTool=agent_build_activate`, jest jednorazowy i wymaga
fail-closed auth, audytowalnego `approvedBy/role/authMethod/approvedAt/expiresAt` i ważnego TTL.
`consumeOneTimePermit()` dla Foundry odrzuca legacy/unbound approvals, porównuje exact
`activationSubjectHash` z rekordem deploymentu i atomowo wykonuje CAS. Nieudany promote zużywa
permit; retry tworzy nowy deployment. Deaktywacja ma oddzielny subject związany z exact
live/target commit i permit `forTool=agent_build_deactivate`.

Activation branch powstaje bezpośrednio z `canonicalBaseCommit` (main zawierającego bezpieczny
shadow build) i zawiera deterministyczną zmianę release `shadow → active`.
`previousLiveCommit` wskazuje osobno wersję N-1 obsługiwaną przez live. Po approval merge jest
wyłącznie `--ff-only`, dzięki czemu przetestowany commit staje się dokładnie canonical HEAD.
Jeżeli main zdryfował, live version/state zmienił się albo ff-only jest niemożliwe, nic nie jest
promowane: deployment przechodzi terminalnie do `superseded`, a kolejna próba dostaje nowy
activation commit, canary i approval.

**Deactivation deployment:** przygotowuje dokładny commit `active → shadow|retired` i jawny
knowledge rollback target; candidate dowodzi nieobecności agenta na wszystkich zadeklarowanych
surfaces oraz zdrowia pozostałych tras. Następnie tworzy exact subject, zatrzymuje candidate,
czeka na approval, wykonuje świeży absence canary, permit-bound `--ff-only`, promote i
post-live absence proof. Target state nie jest wybierany dopiero podczas rollbacku.

**Rollback:**

- operational rollback przywraca slot/version N-1,
- release rollback zmienia `active → shadow/retired`,
- knowledge rollback przywraca przypięty pack version,
- code revert jest osobną ścieżką, jeśli sam kod ma zniknąć,
- po awarii post-promote: runtime rollback → deployment terminalnie `rolled_back` → kontrolny
  `deactivation_required` → nowy recovery/deactivation record i commit `active →
  shadow|retired` → `--ff-only` pod globalnymi claims → odblokowanie,
- `deactivation_required` blokuje zwykłe deploye, lecz jawnie przepuszcza wyłącznie recovery
  albo deactivation release, aby nie zablokować własnej naprawy.

**Crash/reconciliation matrix:** każdy punkt graniczny zapisuje append-only receipt:

| Ostatni trwały dowód | Zachowanie po restarcie |
|---|---|
| candidate uruchomiony, permit niezużyty | odczytaj slot/config, bezpiecznie stop+cleanup, wróć do weryfikacji |
| permit `consumed`, merge niepotwierdzony | porównaj permit CAS i Git HEAD; nie konsumuj ponownie |
| `ff-only` merged, swap niepotwierdzony | porównaj HEAD, release manifest, sloty i `/deploy/health`; nie promuj w ciemno |
| live swapped, post-canary brak | `reconciliation_required`, uruchom tylko idempotentny verify/rollback decision |
| rollback rozpoczęty, brak wyniku | sprawdź realny slot/health; `rollback_failed` lub `live_state_unknown` fail-closed |
| post-canary zielony, mark brak | po zgodności wszystkich receipts idempotentnie oznacz `completed` |

Brak jednoznacznego obrazu HEAD/slot/health nigdy nie uruchamia kolejnego promote; wymaga
recovery recordu i audytowalnej decyzji.

**Akceptacja:** porażka candidate nie dotyka live. Porażka po promocji uruchamia runtime
rollback i pozostawia jawny, obsługiwany stan trwałej deaktywacji. Każdy data client przechodzi
test izolacji; pierwszy candidate jest zatrzymany przed `awaiting_approval`; concurrent autoheal
lub deploy nie może ominąć globalnych claims. Negatywne testy obejmują wrong
commit/spec/gate/canary/subject hash, wrong tool/task, expired/unbound approval oraz dowód, że
forbidden executor nie został wywołany ani w candidate, ani w live smoke.

### ETAP 7 — Adapter oficjalnego Agent Builder (1–2 dni, po core)

**Nowe pliki sugerowane:**

- `src/mastra/services/agent-builder-adapter.ts`,
- `src/mastra/scripts/check-agent-builder-adapter.ts`.

**Prace:**

1. Wczytać dokładny stored agent draft/version przez Editor API.
2. Znormalizować instructions/tools/workspace/skills/memory/scorers do `AgentBuildSpecV2`.
3. Odrzucić nieznane tools, niezgodne modele, brak risk/Board/routing/acceptance.
4. Zapisać mapping `draftId/versionId → specHash`.
5. Każda zmiana draftu po freeze tworzy nową rewizję i nowe evals/canary.
6. Builder UI może projektować; tylko Foundry może aktywować.

**Flaga:** `FEATURE_AGENT_BUILDER_ADAPTER=false` do czasu licencji, RBAC, testów i pełnego
core E2E. Adapter może tworzyć spec po ETAPIE 5, ale ścieżka activation pozostaje wyłączona do
ukończenia ETAPU 6. Brak licencji nie blokuje Meta → Foundry.

**Akceptacja:** draft nie może opublikować agenta ani rozszerzyć uprawnień poza registries;
ten sam draft version daje ten sam spec hash.

### ETAP 8 — Realny low-risk E2E (1–2 dni)

Pierwszym live pilotem jest pierwsza rzeczywista potrzeba, dla której `SolutionDecision`
zwróci `build_agent` i spełnia:

- `adviceRisk=low`,
- `dataSensitivity=public|internal`, bez PII,
- `operationalBlastRadius=wasted_run`,
- tylko istniejące read-only tools,
- brak nowego providera i płatnej generacji,
- prosty readbackowalny artifact.

Pełna ścieżka:

```text
Meta request → buildId → dossier → spec → worktree → gates → shadow_ready
→ deploymentId → candidate semantic canary → approval → activation → live smoke
→ operational rollback N-1 → durable deactivate → nowy deployment/permit do reaktywacji
```

**Dowody obowiązkowe:**

- pozytywny i negatywny routing live,
- realne tool invocation,
- produkt pracy + artifact reread,
- status i immutable records,
- brak agenta przed approval,
- agent obecny po activation,
- agent nieobecny po rollback/deactivation,
- intencjonalny red na każdej głównej bramce,
- candidate i live mają rozdzielone DuckDB oraz osobne Mongo URI/databases dla każdego
  klienta; cleanup fixture nie jest uznawany za izolację.

### ETAP 9 — Knowledge-backed i high-stakes specialists (po MVP)

Kolejność:

1. wersjonowany NotebookLM pack w domenie niesensytywnej,
2. refresh/delta evals i niezależny pack rollback,
3. hybrid corpus + live freshness,
4. `DataHandlingPolicy` egzekwowany dla input, memory, artifacts, traces/logs, Researchera,
   source-of-record tools i zewnętrznych providerów,
5. dopiero potem country-specific high-stakes specialist,
6. trzy SME approvals, scope guard i zero outward writes,
7. później izolowane per-user corpora z consent/access/retention.

### Zależności etapów

```text
0 → 1
1 → 2
1 → schema ETAPU 3; provisioning ETAPU 3 wymaga również 2
1 + zamrożone spec/public fixtures z 2 → 4
2 + 4 → 5
5 + release resolver → 6A (izolacja/claims/orchestrator)
6A → 6B (candidate/deployment service)
6B → 6C (strict approval/activation/recovery)
5 → adapter ETAPU 7; activation adaptera wymaga 6
0–6 → low-risk E2E ETAPU 8 (bez obowiązku UI i NotebookLM provisioning)
provisioning ETAPU 3 + dowód ETAPU 8 → high-stakes ETAP 9
```

## 10. Bramka jakości końcowej

Agent może przejść do `active` wyłącznie, gdy:

- `SolutionDecision=build_agent|hybrid` jest uzasadniona,
- wszystkie must-have activities mają pokrycie,
- dossier i source/claim gate są zielone,
- nie ma unresolved high-risk conflict,
- tools są w registry i mieszczą się w static/outer ceiling,
- skill nie zwiększa authority,
- model sequence, maxSteps, memory i processors są jawne,
- public evals oraz evaluator-only holdout (lub jawnie nazwany independent regression set)
  spełniają progi,
- wszystkie safety/contract cases mają 100%,
- artifact readback jest realny,
- code review jest świeży i niezależny,
- candidate odpowiada dokładnemu commit/spec/release/pack hash,
- approval jest świeży, właściwy i jednorazowy,
- fresh canary przed promote i infra canary po promote są zielone,
- wymagany SME zatwierdził dokładne dossier/source/claim/eval hashe i high-risk zakres,
- `allowedScope` guard jest wykonany przed query i na odpowiedzi,
- high-stakes z PII ma zielony `DataHandlingPolicy` dla wszystkich storage/provider channels;
  bez niego aktywny wariant odrzuca PII i obsługuje tylko publiczne hipotetyczne przypadki.

## 11. Lifecycle i authority

Nie używamy jednej maszyny stanów dla trzech różnych bytów.

**Build:**

```text
proposed → intake ↔ needs_input
intake → researching ↔ blocked_on_capability | blocked_on_knowledge
researching → solution_proposed
solution_proposed → completed_without_build | spec_frozen
spec_frozen → implementing → gating → shadow_ready

terminale: shadow_ready | completed_without_build | build_failed | cancelled
```

`shadow_ready` kończy skuteczny build i nie może później zmienić się w `active`; activation ma
własny rekord.

**DeploymentAttempt:**

```text
prepared → activation_gating → candidate_verifying → candidate_verified
→ awaiting_approval → activating → live_canary → completed

resumable/recovery: reconciliation_required
terminale: completed | candidate_failed | approval_rejected | activation_failed |
           rolled_back | rollback_failed | live_state_unknown | superseded | cancelled
```

Każdy retry ma nowy `deploymentId`; terminale są absorbing.

**AgentRelease (Git manifest wdrożonego commita):**

```text
shadow → active
shadow → retired
active → shadow | retired
```

Gitowy `AgentReleaseManifest` wraz z deployed commitem jest authority tego, co runtime może
eksponować. Append-only events/receipts są authority historii. CAS projections służą statusowi
i UI. `deactivation_required` jest fail-closed flagą recovery, nie nowym stanem manifestu;
przepuszcza tylko release naprawczy/deaktywacyjny.

Każde przejście ma allowlistę, preconditions, CAS i append-only receipt. Knowledge Pack ma
content lifecycle `draft → verified → stale|retired`, a `AgentKnowledgeReleaseRecord` osobny
lifecycle `prepared → active → rolled_back|retired` i niezależny rollback.

## 12. Co robimy jutro — kolejność pierwszego dnia

1. Zakończyć/handoffować bieżący WIP. Właściciel jawnie wskazuje dokładny `BASE_COMMIT`; zrobić
   snapshot `git status --short` i zatrzymać start, jeśli planowany touchpoint jest dirty.
2. Utworzyć dedykowany Foundry worktree z tego SHA. Nie stashować, checkoutować ani kopiować
   niezatwierdzonych zmian ze współdzielonego drzewa.
3. Ten plan przenieść/commitować dopiero po jawnej decyzji właściciela, w dedykowanym worktree.
   Przed każdym commitem sprawdzić `git diff --name-only`, aby nie zabrać cudzych plików.
4. Wykonać ETAP 0 i zapisać ADR-y.
5. Zacząć ETAP 1 wyłącznie od schematów i negatywnych fixture'ów:
   `SpecialistNeedBrief`, `SolutionDecision`, `AgentBuildSpecV2`, release state i records.
6. Następny commit: centralne source/ID/model registries oraz `--file-only` roster.
7. Następny commit: Tool Binding Registry i release resolver z testem, że shadow nie jest
   widoczny w żadnym live surface.
8. Nie dotykać jeszcze `run-deploy.sh`; integracja semantic hooka jest dopiero w ETAPIE 6.
9. Nie uruchamiać oficjalnego Agent Builder ani systemu tylko po to, by „zobaczyć UI”. Adapter
   ma własny etap po gotowym core.

Gotowy handoff dla następnej instancji znajduje się w
`ideas/agent-foundry-prompt-dla-nowej-instancji.md`.

## 13. Weryfikacja podczas implementacji

Wszystkie komendy Node/TS mają iść przez package scripts/repo wrapper używający `.nvmrc` /
`scripts/with-node.sh`.

Kolejność rosnącego kosztu:

1. test pojedynczego czystego modułu/fixture przez właściwy package script,
2. `npm run typecheck`,
3. odpowiedni domenowy `check:*`,
4. `npm run audit:agent-readiness -- --agent=<id> --fail-closed`,
5. `npm run check:new-agent-ready -- --agent=<id>`,
6. `npm run check:all`,
7. `git diff --check`,
8. candidate/runtime proof dopiero w ETAPIE 6–8.

Obecny `check:all` po nieudanym starcie testowego `:27018` może fallbackować do dostępnego
replica setu, więc nie wolno uznać go bezwarunkowo za izolowany. Foundry musi dodać tryb
fail-closed bez fallbacku do aplikacyjnego Mongo: gate raportuje dokładny testowy URI/database
albo kończy się błędem. Testy runtime, Mongo, NotebookLM i blue-green wymagają osobnego okna
lub jawnie izolowanego środowiska.

Po każdym etapie:

- zielone testy właściwe dla etapu,
- przynajmniej jeden intencjonalny red,
- `git diff --check`,
- commit ograniczony do etapu,
- update statusu i dowodów w planie/ADR.

## 14. Szacunek

| Zakres | Skupione dni |
|---|---:|
| ETAP 0 — baseline i ADR | 0,5 |
| ETAP 1 — kontrakty i governance | 1,5–2 |
| ETAP 2 — research/solution design | 2–3 |
| ETAP 3 — schema knowledge pack / provisioning | 1 / +2 |
| ETAP 4 — scaffold/readiness/evals | 2–3 |
| ETAP 5 — shared core + durable Foundry | 2–3 |
| ETAP 6A–6C — isolation/canary/activation/recovery | 3–5 |
| ETAP 7 — Agent Builder adapter | 1–2 |
| ETAP 8 — realny low-risk E2E | 1–2 |
| **MVP core bez automatycznego NotebookLM i UI adaptera** | **13–19,5** |
| **Bufor integracyjny: durable workflow, release surfaces, Mongo i blue-green** | **+3–5** |
| **MVP produkcyjny core z buforem** | **16–24,5** |
| **Knowledge provisioning + Agent Builder adapter** | **+3–4** |
| **Foundry + Knowledge provisioning + Agent Builder, z buforem** | **19–28,5** |
| High-stakes dla 1 jurysdykcji, publiczne/hipotetyczne przypadki, SME, bez PII | **+4–7** |
| Pełne PII: DataHandlingPolicy + per-user corpus/access/consent/retention | **+6–10** |
| **Pełna roadmapa łącznie z high-stakes i PII** | **29–45,5** |

Poprzednie 5,5–7,5 dnia było zaniżone, ponieważ nie obejmowało prawdziwego shadow lifecycle,
pełnego touchpoint inventory, durable research records, build/activate split, Agent Builder
adaptera ani rollbacku wiedzy/ekspozycji.

To są focused engineering days. Oczekiwanie na handoff WIP, approval/licencję, SME oraz
uzgodnione okna live nie jest wliczone.

Przy jednym ciągłym strumieniu implementacji i pięciu skupionych dniach tygodniowo daje to
orientacyjnie:

- **MVP produkcyjny core:** około **3,5–5 tygodni**,
- **Foundry z automatycznym Knowledge provisioning i Agent Builderem:** około **4–6 tygodni**,
- **pełna roadmapa z pierwszym agentem high-stakes i obsługą PII:** około **6–9 tygodni pracy
  inżynierskiej**.

Kalendarzowo dla pełnej roadmapy bezpieczniej planować **7–12 tygodni**, bo zgody, SME,
licencja, handoff bieżącego WIP i okna blue-green nie są focused engineering time. Równoległe
subagenty skrócą research i review, ale zależności `0 → 1 → 2/4 → 5 → 6` nie pozwalają po
prostu podzielić czasu przez liczbę agentów.

## 15. Świadomie poza MVP-1

- automatyczne publikowanie stored agents z Agent Builder,
- domyślny publiczny V2 lane `build_agent`,
- automatyczna promocja bez człowieka,
- agent wysokiego ryzyka bez SME,
- raw NotebookLM admin tools dla specjalisty,
- wspólny notebook z dokumentami użytkownika/PII,
- automatyczne ingestowanie książek/paywalli,
- pełna migracja wszystkich istniejących agentów do deklaratywnego runtime,
- samodzielna optymalizacja promptu i auto-publish na podstawie scorerów.

## 16. Definicja ukończenia całego projektu

Projekt jest ukończony dopiero, gdy użytkownik może zlecić Meta realną potrzebę, a system:

1. poprawnie wybiera `build_agent` zamiast prostszego rozwiązania,
2. tworzy zweryfikowane dossier i mierzalny excellence design,
3. dobiera istniejące narzędzia/skille/wiedzę albo jawnie zamyka gap,
4. tworzy prompt i acceptance suite z provenance,
5. implementuje w izolacji bez mutacji live,
6. wykrywa świadome braki konfiguracji,
7. uruchamia candidate z dokładnego activation commita i stanem `active` wyłącznie w
   izolowanym candidate runtime,
8. zatrzymuje się przed activation,
9. przyjmuje tylko strict-bound, audytowalny i niewygasły jednorazowy approval,
10. promuje jednym kanonicznym blue-green path,
11. dowodzi live routing/tool/artifact behavior,
12. potrafi przywrócić runtime, exposure i exact knowledge release N-1 oraz zrekoncyliować
    crash na każdej granicy,
13. pozostawia audytowalny łańcuch: need → sources/claims → design → spec → code → evals →
    canary → approval → release.

Wtedy „Meta zbudował idealnie skrojonego agenta” oznacza zmierzoną, odtwarzalną właściwość
systemu, a nie deklarację modelu.
