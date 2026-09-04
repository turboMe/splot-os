# Deliberation Agent — Plan Implementacji

> Companion do `01-architecture.md` i `02-prompts.md`.
> Każdy etap to commit-sized chunk. Kolejność jest obowiązkowa.

---

## Etap 0 — Przygotowanie infrastruktury

**Cel:** Dodać deliberationAgent do rejestru systemu bez żadnej logiki debaty.

### Pliki do utworzenia/zmodyfikowania:

| Plik | Akcja | Opis |
|------|-------|------|
| `src/mastra/config/agent-ids.ts` | modify | Dodać `DELIBERATION_AGENT_ID`, `DELIBERATION_AGENT_MASTRA_AGENT_ID`, aliasy |
| `src/mastra/config/model-manifest.ts` | modify | Dodać `deliberationAgent` w sekcji agentModels |
| `src/mastra/prompts/deliberation/base.md` | create | Minimalny prompt — tylko identity + "zwróć echo zadania" |
| `src/mastra/agents/deliberation-agent.ts` | create | Szkielet Agent z runWorkerTool + requestApprovalTool |
| `src/mastra/index.ts` | modify | Zarejestrować deliberationAgent w `agents: {}` |
| `src/mastra/tools/system/delegate-task.ts` | modify | Dodać `deliberationAgent` do enum + AGENT_IDS map |

### Weryfikacja:
```bash
npx tsc --noEmit
# Mastra dev → sprawdź czy agent jest widoczny w Studio
```

### Ryzyko: Niskie — zero logiki, tylko rejestracja.
### Rollback: Usunąć 3 nowe pliki + cofnąć 3 modyfikacje.

---

## Etap 1 — Narzędzie writeDebateArtifact

**Cel:** Narzędzie do zapisu artefaktów debaty na dysk.

### Pliki do utworzenia:

| Plik | Akcja | Opis |
|------|-------|------|
| `src/mastra/tools/deliberation/write-debate-artifact.ts` | create | Narzędzie do zapisu plików debaty |

### Specyfikacja narzędzia:

```typescript
id: 'deliberation_write_artifact'
description: 'Write a debate artifact file to disk under /artifacts/debates/{date}/{slug}/.'

inputSchema: {
  slug: z.string().describe('Task slug for folder name (kebab-case)'),
  fileName: z.enum([
    '01-debate-notes.md',
    '02-decision-brief.md',
    '03-implementation-plan.md',
    '04-risk-register.md',
    '05-agent-task-briefs.md',
    'metadata.json'
  ]),
  content: z.string().describe('File content to write'),
}

outputSchema: {
  success: z.boolean(),
  path: z.string(),
  error: z.string().optional(),
}

// Ścieżka bazowa:
const ARTIFACTS_ROOT = path.resolve(AGENTIC_AGENTS_REPO, 'artifacts', 'debates');
// Pełna ścieżka: {ARTIFACTS_ROOT}/{YYYY-MM-DD}/{slug}/{fileName}
```

### Side-effect level: `local-write`
### Approval: `never` (pisze do lokalnego katalogu artifacts)

### Weryfikacja:
```bash
npx tsc --noEmit
# Test: ręczne wywołanie narzędzia → sprawdź czy plik powstał
```

---

## Etap 2 — Pełny prompt deliberationAgent

**Cel:** Zamienić minimalny prompt na pełną specyfikację z sekcji 1 pliku `02-prompts.md`.

### Pliki do zmodyfikowania:

| Plik | Akcja | Opis |
|------|-------|------|
| `src/mastra/prompts/deliberation/base.md` | replace | Pełny prompt agenta domenowego |
| `src/mastra/agents/deliberation-agent.ts` | modify | Dodać writeDebateArtifact, memoryRecallTool, memoryWriteTool, currentTimeTool |

### Dodać narzędzia do agenta:

```typescript
tools: {
  runWorkerTool,
  writeDebateArtifactTool,
  memoryRecallTool,
  memoryWriteTool,
  currentTimeTool,
  requestApprovalTool,
}
```

### Memory config:

```typescript
memory: new Memory({
  options: {
    lastMessages: 20,
    observationalMemory: {
      model: resolveModelId(infrastructure.observationalMemory),
      scope: 'thread',
      temporalMarkers: true,
      observation: { threadTitle: true },
    },
    workingMemory: {
      enabled: true,
      template: `# Deliberation Agent Working Memory

## Active Debate
- **Current task:**
- **Debate depth:**
- **Workers selected:**
- **Phase:**

## Past Debate Patterns
- **Effective combinations:**
- **Known failure patterns:**
- **User preferences:**
`,
    },
    generateTitle: true,
  },
})
```

### Weryfikacja:
```bash
npx tsc --noEmit
# Deleguj proste zadanie z meta → deliberation → sprawdź intake frame
```

---

## Etap 3 — Worker Brief System

**Cel:** Deliberation agent potrafi wysyłać briefs do workerów i zbierać odpowiedzi.

### Test scenario:

```
User → metaAgent: "Rozważ jak najlepiej zbudować automatyzację wysyłki weekly digest"
metaAgent → delegateTask(deliberationAgent, task)
deliberationAgent:
  1. Tworzy intake frame (depth: light)
  2. Wywołuje 3 run_worker parallel:
     - llmEngineer (reasoning preset)
     - redTeamCritic (cloud preset)
     - synthesisPlanner (default preset)
  3. Zbiera odpowiedzi
  4. Skleja syntezę
  5. Zapisuje artefakty
  6. Zwraca do metaAgent
```

### Pliki do ewentualnej modyfikacji:
- Prompt `deliberation/base.md` — fine-tune na podstawie pierwszych testów
- Dodatkowe helper prompts jeśli briefs są za duże dla jednego promptu

### Weryfikacja:
- [ ] light depth działa end-to-end
- [ ] Artefakty zapisane na dysku
- [ ] metaAgent otrzymuje structured response
- [ ] Czas < 90 sekund dla light

---

## Etap 4 — Standard i Deep Depth

**Cel:** Rozszerzyć o pełne 6 workerów i warunkową krytykę.

### Dodać do promptu:
- Logikę wyboru debate depth (auto na podstawie risk + complexity)
- Warunkową krytykę krzyżową
- Double-critique w deep mode (redTeamCritic dostaje drugi pass)

### Test scenarios:

**Standard depth:**
```
"Zaprojektuj system automatycznego onboardingu nowych klientów CRM"
→ 5 workers, conditional critique, artifacts
```

**Deep depth:**
```
"Zaprojektuj architekturę self-healing dla autonomous coding agent"
→ 6 workers, forced critique, double redTeam, full artifacts
```

### Weryfikacja:
- [ ] Standard depth: 5-6 workers, ~7-9 LLM calls
- [ ] Deep depth: 6 workers + critique, ~12-14 LLM calls
- [ ] Krytyka uruchamia się tylko gdy potrzebna (standard)
- [ ] Krytyka zawsze w deep
- [ ] Wszystkie artefakty kompletne

---

## Etap 5 — metaAgent Integration

**Cel:** Meta-agent automatycznie routuje zadania do deliberationAgent.

### Pliki do zmodyfikowania:

| Plik | Akcja | Opis |
|------|-------|------|
| `src/mastra/prompts/meta/base.md` | modify | Dodać routing rules z sekcji 10 architecture doc |
| `src/mastra/tools/system/delegate-task.ts` | modify | Dodać deliberation route (direct generate, no harness) |

### Dodać do delegate-task.ts:

```typescript
// ── Route deliberationAgent: direct generate (no harness needed) ──
if (context.targetAgent === 'deliberationAgent') {
  const response = await agent.generate(
    context.taskDescription,
    {
      memory: {
        thread: delegationThreadId,
        resource: delegationResourceId,
      },
    },
  );

  const responseText = response.text ?? '';

  logAgentEvent({
    type: 'delegation',
    agentId: context.targetAgent,
    status: 'success',
    input: context.taskDescription.slice(0, 500),
    output: responseText.slice(0, 500),
    durationMs: Date.now() - start,
  });

  return {
    success: true,
    result: responseText,
    agentUsed: context.targetAgent,
  };
}
```

### Weryfikacja:
```
User: "Wymyślmy jak podejść do automatyzacji contentu na LinkedIn"
→ metaAgent routes to deliberationAgent (without user saying "deleguj do deliberation")
→ Full debate cycle
→ Artifacts on disk
→ metaAgent presents result
```

---

## Etap 6 — Evals & Scoring

**Cel:** Zmierzyć czy deliberation daje lepsze wyniki niż single-pass.

### Pliki do utworzenia:

| Plik | Akcja | Opis |
|------|-------|------|
| `src/mastra/scorers/deliberation-scorer.ts` | create | Scorer dla jakości deliberacji |

### Metryki:

```typescript
deliberationQualityScorer:
  - critique_found_real_problem: boolean  // Czy krytyka znalazła realny problem?
  - plan_addressed_critique: boolean      // Czy plan uwzględnił krytykę?
  - plan_executable: boolean              // Czy downstream agent wykonał bez major zmian?
  - user_accepted: boolean                // Czy user zaakceptował?
  - depth_appropriate: boolean            // Czy depth nie był overkill?
  - artifact_completeness: 0.0-1.0       // Czy wszystkie artefakty są kompletne?
```

### Baseline:
- Po 10 debatach porównaj koszt tokenów deliberation vs single-pass meta-agent
- Mierz: ile razy user powiedział "to nie do końca to" po deliberation vs bez

### Weryfikacja:
- [ ] Scorer zarejestrowany w `index.ts`
- [ ] Pierwsze 3 debaty mają wyniki ewalów

---

## Etap 7 — Feedback Loop & Reject/Iterate

**Cel:** metaAgent może odrzucić plan i odesłać do deliberation z feedbackiem.

### Logika:

```
metaAgent receives deliberation result
  → if satisfied: proceed to execution
  → if not satisfied: delegateTask(deliberationAgent, {
      original_task + feedback + "previous_debate_id: xyz"
    })
deliberationAgent:
  → recalls previous debate from memory
  → runs targeted re-deliberation (only affected workers)
  → updates artifacts (appends revision notes)
  → returns revised plan
```

### Limit: Max 2 iteracje (deliberation → reject → re-deliberation → final)

### Pliki do zmodyfikowania:
- `deliberation/base.md` — dodać logikę "revision mode"
- Artifact format — dodać sekcję "Revision History"

---

## Etap 8 — Async Deliberation (opcjonalnie)

**Cel:** Obsługa async delegacji dla deep debates.

### Kiedy:
- deep debate zajmuje > 3 min
- User nie chce czekać

### Logika:
Dodać obsługę `async: true` w delegate-task.ts dla deliberationAgent, analogicznie do codingAgent.

### Priorytet: NISKI — implementuj dopiero gdy deep debates regularnie przekraczają 3 min.

---

## Podsumowanie etapów

| Etap | Scope | Estymowany czas | Ryzyko | Zależności |
|------|-------|-----------------|--------|------------|
| 0 | Rejestracja agenta | 30 min | Niskie | Brak |
| 1 | writeDebateArtifact tool | 30 min | Niskie | Etap 0 |
| 2 | Pełny prompt | 1h | Średnie | Etap 0+1 |
| 3 | Light depth E2E | 2h | Średnie | Etap 2 |
| 4 | Standard + Deep | 2h | Średnie | Etap 3 |
| 5 | metaAgent routing | 1h | Niskie | Etap 3 |
| 6 | Evals | 1h | Niskie | Etap 5 |
| 7 | Reject/Iterate | 1h | Średnie | Etap 5 |
| 8 | Async (opcja) | 1h | Niskie | Etap 5 |

**Łącznie: ~10h roboczych** (bez Etapu 8)

**Milestone 1 (MVP):** Etapy 0-3 → light deliberation działa E2E
**Milestone 2 (Full):** Etapy 4-6 → wszystkie depths + evals
**Milestone 3 (Polish):** Etapy 7-8 → iteration loop + async

---

## Checklist przed rozpoczęciem implementacji

- [x] Przeczytaj `01-architecture.md` — architektura i schematy
- [x] Przeczytaj `02-prompts.md` — pełne prompty agenta i workerów
- [x] Przeczytaj ten dokument — etapy implementacji
- [x] Upewnij się, że `run_worker` działa poprawnie (przetestuj z prostym briefem)
- [x] Sprawdź czy `artifacts/debates/` folder istnieje lub może być utworzony
- [x] Etap 0 — Przygotowanie infrastruktury
- [x] Etap 1 — Narzędzie writeDebateArtifact
- [x] Etap 2 — Pełny prompt
- [x] Etap 3 — Worker Brief System (light depth E2E)
- [x] Etap 4 — Standard i Deep Depth (warunkowa krytyka w prompt)
- [x] Etap 5 — metaAgent Integration (routing rules + delegate-task description)
- [x] Etap 6 — Evals & Scoring (deliberationQualityScorer + rejestracja)
- [x] Etap 7 — Feedback Loop / Reject-Iterate (Revision Mode w base.md)
- [ ] Etap 8 — Async Deliberation (NISKI priorytet, opcjonalnie)
- [x] Dokumentacja — `docs/DELIBERATION-AGENT.md`
- [x] Dedykowane narzędzie `run_deliberation_worker` (model-manifest Section 6)
- [ ] Zaplanuj pierwszy test case: prosty request typu "rozważ jak zbudować X"

