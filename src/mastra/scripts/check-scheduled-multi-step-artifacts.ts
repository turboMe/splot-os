#!/usr/bin/env tsx
/**
 * Test multi-step scheduled task chains with artifact handoff and cycle isolation.
 *
 * Verifies:
 * 1. 3-step nested nextStep scheduled pipeline creation.
 * 2. Step 1 (e.g. chefAgent) generates an artifact and returns a ResultEnvelope.
 * 3. Scheduled task runner parses the envelope and records artifacts + cycleId into task_chains.
 * 4. Step 2 (e.g. contentAgent) receives the upstream artifact in its prompt as "## Upstream Input Artifacts".
 * 5. Step 2 generates another artifact and produces Step 3 successor.
 * 6. Step 3 (e.g. writerAgent) receives both upstream artifacts.
 * 7. Cycle isolation: querying task_chains by cycleId isolates separate execution cycles.
 *
 * Run: npx tsx src/mastra/scripts/check-scheduled-multi-step-artifacts.ts
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  createScheduledTask,
  SCHEDULED_TASKS_COLLECTION,
  type ScheduledTask,
} from '../services/scheduled-task-store.js';
import {
  getTaskChainContext,
  formatTaskChainContext,
  TASK_CHAINS_COLLECTION,
} from '../services/task-chain-store.js';
import { putArtifact, getArtifact } from '../services/artifact-store.js';
import { processOneDueScheduledTask } from './scheduled-task-runner.js';
import { getDb, closeDb } from '../lib/mongo.js';

const TEST_CHAIN_NAME = `test-chain-artifacts-${randomUUID().slice(0, 8)}`;
const createdTaskIds: string[] = [];

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection(SCHEDULED_TASKS_COLLECTION).deleteMany({ chainName: TEST_CHAIN_NAME });
  await db.collection(TASK_CHAINS_COLLECTION).deleteMany({ chainId: { $regex: TEST_CHAIN_NAME } });
}

async function main(): Promise<void> {
  console.log(`[TEST] Starting check-scheduled-multi-step-artifacts for ${TEST_CHAIN_NAME}...`);
  await cleanup();

  let capturedStep2Prompt = '';
  let capturedStep3Prompt = '';

  let step1ArtifactId = '';
  let step2ArtifactId = '';

  // Mock Mastra agents registry
  const mockAgents: Record<string, any> = {
    'chef-agent': {
      generate: async (prompt: string) => {
        const artRef = await putArtifact({
          type: 'menu_book_ref',
          title: 'Jesienna Karta Dań 2026',
          summary: '8 dań głównych z food costem 28%, receptury i alergeny.',
          content: '# Jesienna Karta Dań 2026\n\n1. Stek z dyni piżmowej...',
          producedBy: 'chef-agent',
        });
        step1ArtifactId = artRef.id;

        return {
          finishReason: 'stop',
          text: `Opracowałem jesienne menu lokalu.\n\n\`\`\`json result_envelope\n{\n  "status": "ok",\n  "artifacts": [\n    {\n      "id": "${artRef.id}",\n      "type": "menu_book_ref",\n      "summary": "8 dań głównych z food costem 28%, receptury i alergeny."\n    }\n  ],\n  "lessons": ["Menu dyniowe zbalansowane kosztowo"]\n}\n\`\`\``,
        };
      },
    },
    'content-agent': {
      generate: async (prompt: string) => {
        capturedStep2Prompt = prompt;
        const artRef = await putArtifact({
          type: 'content_pack',
          title: 'Tygodniowy pakiet postów i rolek',
          summary: '7 postów Instagram/FB promujących jesienne menu dyniowe.',
          content: '# Posty Social Media\n\nPoniedziałek: Premiera karty...',
          producedBy: 'content-agent',
        });
        step2ArtifactId = artRef.id;

        return {
          finishReason: 'stop',
          text: `Przygotowałem pakiet postów na social media.\n\n\`\`\`json result_envelope\n{\n  "status": "ok",\n  "artifacts": [\n    {\n      "id": "${artRef.id}",\n      "type": "content_pack",\n      "summary": "7 postów Instagram/FB promujących jesienne menu dyniowe."\n    }\n  ]\n}\n\`\`\``,
        };
      },
    },
    'writer-agent': {
      generate: async (prompt: string) => {
        capturedStep3Prompt = prompt;
        return {
          finishReason: 'stop',
          text: `Napisałem artykuł PR zapowiadający nowości kulinarne.\n\n\`\`\`json result_envelope\n{\n  "status": "ok",\n  "artifacts": []\n}\n\`\`\``,
        };
      },
    },
  };

  const mockMastra = {
    getAgent: (id: string) => mockAgents[id],
    getWorkflow: () => undefined,
  };

  // 1. Create 3-step pipeline with nested nextStep
  const now = new Date();
  const chainId = `chain-${TEST_CHAIN_NAME}`;
  const rootTask = await createScheduledTask({
    fireAt: now,
    timezone: 'Europe/Warsaw',
    targetType: 'AGENT',
    targetIdentifier: 'chef-agent',
    promptOrInstruction: 'Przygotuj jesienne Menu Book dla lokalu.',
    chainId,
    chainName: TEST_CHAIN_NAME,
    stepName: 'step_1_menu',
    nextStep: {
      delayMs: 0,
      targetType: 'AGENT',
      targetIdentifier: 'content-agent',
      promptOrInstruction: 'Na podstawie Menu Book przygotuj tygodniowy pakiet postów.',
      stepName: 'step_2_content',
      nextStep: {
        delayMs: 0,
        targetType: 'AGENT',
        targetIdentifier: 'writer-agent',
        promptOrInstruction: 'Napisz artykuł PR podsumowujący menu i kampanię.',
        stepName: 'step_3_article',
      },
    },
  });

  createdTaskIds.push(rootTask.taskId);
  assert.equal(rootTask.targetIdentifier, 'chef-agent');
  assert.equal(rootTask.chainId, chainId);
  assert.ok(rootTask.nextStep, 'Root task must have nextStep');

  // 2. Process Step 1
  const step1Result = await processOneDueScheduledTask({
    runnerId: 'test-runner',
    mastra: mockMastra as any,
    now: new Date(Date.now() + 1000),
  });

  assert.equal(step1Result.status, 'completed', 'Step 1 should complete');
  assert.ok(step1Result.nextTaskId, 'Step 1 must spawn Step 2 successor task');
  createdTaskIds.push(step1Result.nextTaskId!);

  // Verify task_chains record has extracted artifacts and cycleId
  const chainCtx1 = await getTaskChainContext({ chainId });
  assert.equal(chainCtx1.length, 1);
  assert.equal(chainCtx1[0]?.stepName, 'step_1_menu');
  assert.ok(chainCtx1[0]?.artifacts && chainCtx1[0].artifacts.length === 1, 'Step 1 artifacts must be stored');
  assert.equal(chainCtx1[0]?.artifacts?.[0]?.id, step1ArtifactId);
  assert.equal(chainCtx1[0]?.artifacts?.[0]?.type, 'menu_book_ref');
  assert.ok(chainCtx1[0]?.cycleId, 'Step 1 cycleId must be set');
  const cycleId1 = chainCtx1[0]?.cycleId;

  // 3. Process Step 2
  const step2Result = await processOneDueScheduledTask({
    runnerId: 'test-runner',
    mastra: mockMastra as any,
    now: new Date(Date.now() + 2000),
  });

  assert.equal(step2Result.status, 'completed', 'Step 2 should complete');
  assert.ok(step2Result.nextTaskId, 'Step 2 must spawn Step 3 successor task');
  createdTaskIds.push(step2Result.nextTaskId!);

  // Verify capturedStep2Prompt contains the artifact from Step 1
  assert.ok(
    capturedStep2Prompt.includes('## Upstream Input Artifacts (Handoff from previous steps):'),
    'Step 2 prompt must include upstream artifacts header',
  );
  assert.ok(
    capturedStep2Prompt.includes(step1ArtifactId),
    `Step 2 prompt must include step 1 artifact ID ${step1ArtifactId}`,
  );
  assert.ok(
    capturedStep2Prompt.includes('menu_book_ref'),
    'Step 2 prompt must mention menu_book_ref artifact type',
  );

  // 4. Process Step 3
  const step3Result = await processOneDueScheduledTask({
    runnerId: 'test-runner',
    mastra: mockMastra as any,
    now: new Date(Date.now() + 3000),
  });

  assert.equal(step3Result.status, 'completed', 'Step 3 should complete');
  assert.equal(step3Result.nextTaskId, undefined, 'Step 3 has no further nextStep');

  // Verify capturedStep3Prompt contains artifacts from BOTH Step 1 and Step 2
  assert.ok(
    capturedStep3Prompt.includes('## Upstream Input Artifacts (Handoff from previous steps):'),
    'Step 3 prompt must include upstream artifacts header',
  );
  assert.ok(
    capturedStep3Prompt.includes(step1ArtifactId),
    `Step 3 prompt must include step 1 artifact ID ${step1ArtifactId}`,
  );
  assert.ok(
    capturedStep3Prompt.includes(step2ArtifactId),
    `Step 3 prompt must include step 2 artifact ID ${step2ArtifactId}`,
  );

  // 5. Verify task_chains context and cycleId isolation
  const chainCtxAll = await getTaskChainContext({ chainId, cycleId: cycleId1 });
  assert.equal(chainCtxAll.length, 3, 'Chain context must contain 3 steps for cycleId1');
  assert.equal(chainCtxAll[0]?.stepName, 'step_1_menu');
  assert.equal(chainCtxAll[1]?.stepName, 'step_2_content');
  assert.equal(chainCtxAll[2]?.stepName, 'step_3_article');

  // Querying with a non-existent cycleId must yield 0 results
  const chainCtxOther = await getTaskChainContext({ chainId, cycleId: 'cycle-different-date' });
  assert.equal(chainCtxOther.length, 0, 'Different cycleId must return empty context for cycle isolation');

  console.log('[TEST] All multi-step scheduled task artifact handoff & cycle isolation assertions PASSED!');
  await cleanup();
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[TEST ERROR]', err);
    await cleanup().catch(() => undefined);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
