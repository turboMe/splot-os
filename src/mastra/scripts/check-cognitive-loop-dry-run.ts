import assert from 'node:assert/strict';

import type { Agent } from '@mastra/core/agent';
import { MongoClient } from 'mongodb';
import { installMetaAgentHarness } from '../services/meta-harness.js';
import { evaluateAutomationArchitectDelegationContract } from '../tools/system/delegate-task.js';

const testPrompt = `
TRYB TESTOWY / DRY RUN.

Przetestuj pętlę myślową systemu na bezpiecznym zadaniu kontrolnym.

Cel:
Sprawdź, czy system poprawnie używa planowania, delegacji, GoalContract, Strategy Reflector, adaptive depth oraz bramek review/approval, ale NIE wykonuj żadnych działań mutujących.

Ograniczenia bezpieczeństwa:
- Nie zmieniaj plików.
- Nie deployuj.
- Nie aktywuj workflow.
- Nie usuwaj danych.
- Nie wysyłaj emaili.
- Nie zmieniaj credentiali.

Zadanie testowe:
Potraktuj to jako krytyczny scenariusz: audit przed deployem produkcyjnym workflow z credentialami.
`;

const automationBrief = `
GOAL: Perform a read-only risk analysis and validation audit for deploying production workflows in n8n that contain credentials.
CONTEXT: Dry-run safety audit. No active deployment is happening.
OUTPUT FORMAT: Markdown report.
CONSTRAINTS: Do not deploy, do not activate workflows, do not change credentials.
`;

const automationReport = `
# Automation Risk Audit
Read-only analysis of n8n workflow deployment risk, credential handling, validation blockers, approval requirements, and risk scoring. No deployment or activation was performed.
`;

const codingReport = `
# Coding Safety Audit
Read-only repository audit of .gitignore, env handling, credential leak prevention, and verification boundaries. No files were changed.
`;

const finalReport = `
## Raport testowy pętli myślowej

### Plan
1. Analiza ryzyka automatyzacji przez automationArchitect.
2. Audyt bezpieczeństwa repozytorium przez codingAgent.
3. Synteza statusu GoalContract, adaptive depth oraz review/approval gates.

### Delegacje
| Agent | Status | Wynik |
|---|---|---|
| automationArchitect | success:true | Read-only raport ryzyka n8n bez deployu i bez aktywacji. |
| codingAgent | success:true | Read-only audyt repo bez zmian w plikach. |

### GoalContract
Root run powinien utworzyć GoalContract dla profilu critical. Delegacje również powinny mieć kontrakty lub telemetryczne powiązanie z runem.

### Adaptive Depth
Scenariusz zawiera deploy, credentiale i safety audit, więc oczekiwany poziom to critical.

### Review i Approval Gate
Review gate powinien sprawdzić kompletność raportu. Approval gate powinien jasno zablokować deploy, activation, credential changes, email send i deletion bez explicit approval.

### Zablokowane działania
- Nie wykonano deployu.
- Nie aktywowano workflow.
- Nie zmieniono credentiali.
- Nie wysłano emaili.
- Nie zmieniono plików.

### Werdykt
Partial-pass/safety-pass: bezpieczeństwo dry-run jest zachowane, a finalny raport jawnie pokazuje status delegacji i bramek.
`;

type GenerateCall = {
  prompt: string;
  options: Record<string, any>;
};

class FakeMetaDryRunAgent {
  calls: GenerateCall[] = [];

  async generate(prompt: string, options: Record<string, any> = {}): Promise<{ text: string; steps: any[]; finishReason: string }> {
    this.calls.push({ prompt, options });

    if (prompt.includes('Auto Review Gate')) {
      return {
        text: finalReport.replace('Partial-pass/safety-pass', 'Reviewed partial-pass/safety-pass'),
        steps: [],
        finishReason: 'stop',
      };
    }

    if (prompt.includes('Approval Gate')) {
      return {
        text: `${finalReport}\n\n### Approval\nExplicit approval would be required before any real deployment, activation, credential change, deletion, or email send.`,
        steps: [],
        finishReason: 'stop',
      };
    }

    if (typeof options.onStepFinish === 'function') {
      await options.onStepFinish({
        toolCalls: [
          {
            toolCallId: 'automation-read-only',
            toolName: 'system_delegate_task',
            args: { targetAgent: 'automationArchitect', taskDescription: automationBrief },
          },
          {
            toolCallId: 'coding-read-only',
            toolName: 'system_delegate_task',
            args: { targetAgent: 'codingAgent', taskDescription: 'Read-only credential safety audit.' },
          },
        ],
        toolResults: [
          {
            toolCallId: 'automation-read-only',
            toolName: 'system_delegate_task',
            result: { success: true, result: automationReport, agentUsed: 'automationArchitect' },
            isError: false,
          },
          {
            toolCallId: 'coding-read-only',
            toolName: 'system_delegate_task',
            result: { success: true, result: codingReport, agentUsed: 'codingAgent' },
            isError: false,
          },
        ],
      });
    }

    return { text: finalReport, steps: [], finishReason: 'stop' };
  }
}

function validateFinalReport(text: string): void {
  assert.match(text, /Raport testowy pętli myślowej/);
  assert.match(text, /### Plan/);
  assert.match(text, /### Delegacje/);
  assert.match(text, /automationArchitect\s*\|\s*success:true/);
  assert.match(text, /codingAgent\s*\|\s*success:true/);
  assert.match(text, /### GoalContract/);
  assert.match(text, /### Adaptive Depth/);
  assert.match(text, /### Review i Approval Gate/);
  assert.match(text, /### Zablokowane działania/);
  assert.match(text, /### Werdykt/);
  assert.doesNotMatch(text, /przejdźmy teraz|przejdzmy teraz|let'?s now prepare|opracowania kompleksowego raportu/i);
}

process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

const runId = `cognitive-loop-dry-run-check-${Date.now()}`;
const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentforge', {
  serverSelectionTimeoutMS: 3000,
});
await client.connect();
const db = client.db();
const startedAt = new Date();
const automationRequestCountBefore = await db.collection('automation_requests').countDocuments({ createdAt: { $gte: startedAt } });
const automationEventCountBefore = await db.collection('automation_events').countDocuments({ createdAt: { $gte: startedAt } });

const fake = new FakeMetaDryRunAgent();
const wrapped = installMetaAgentHarness(fake as unknown as Agent) as unknown as {
  generate: (prompt: unknown, options?: Record<string, unknown>) => Promise<{ text?: string }>;
};

const response = await wrapped.generate(testPrompt, {
  taskId: runId,
  runId,
  memory: {
    thread: `${runId}-thread`,
    resource: 'dry-run-user',
  },
});

const finalText = String(response.text ?? '');
validateFinalReport(finalText);

const automationContract = evaluateAutomationArchitectDelegationContract(automationBrief, automationReport);
assert.equal(automationContract.ok, true);
assert.equal(automationContract.mode, 'read_only_analysis');

const automationRequestCountAfter = await db.collection('automation_requests').countDocuments({ createdAt: { $gte: startedAt } });
const automationEventCountAfter = await db.collection('automation_events').countDocuments({ createdAt: { $gte: startedAt } });
assert.equal(automationRequestCountAfter, automationRequestCountBefore, 'dry-run created automation_requests');
assert.equal(automationEventCountAfter, automationEventCountBefore, 'dry-run created automation_events');

const eventTypes = await db.collection('agent_events').distinct('type', { $or: [{ runId }, { taskId: runId }] });
assert.ok(eventTypes.includes('depth_classified'), 'missing root depth_classified event');
assert.ok(eventTypes.includes('goal_contract_created'), 'missing root goal_contract_created event');
assert.ok(eventTypes.includes('auto_review_completed'), 'missing root auto_review_completed event');
assert.ok(eventTypes.includes('approval_gate_completed'), 'missing root approval_gate_completed event');
assert.ok(eventTypes.includes('run_completed'), 'missing root run_completed event');

const run = await db.collection('agent_runs').findOne({ runId });
assert.equal(run?.status, 'completed');

const artifact = await db.collection('harness_artifacts').findOne({ runId, kind: 'llm_output' });
assert.ok(artifact, 'missing final llm_output artifact');
validateFinalReport(String(artifact.content ?? ''));

await client.close();

console.log('Cognitive loop dry-run checks passed.');
process.exit(0);
