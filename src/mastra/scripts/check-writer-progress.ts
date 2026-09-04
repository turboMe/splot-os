#!/usr/bin/env tsx
/** Deterministic trust-boundary checks for Writer earned-time evidence. */
import assert from 'node:assert/strict';

import {
  detectWriterProgress,
  detectWriterProgressCandidates,
} from '../orchestration/execution/writer-progress.js';
import type { HarnessStepObservation } from '../services/generate-with-harness.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function observation(input: {
  toolName: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  isError?: boolean;
}): HarnessStepObservation {
  return {
    toolCalls: [{
      toolCallId: 'call-1',
      toolName: input.toolName,
      args: input.args ?? {},
    }],
    toolResults: [{
      toolCallId: 'call-1',
      toolName: input.toolName,
      result: input.result ?? {},
      isError: input.isError ?? false,
    }],
  };
}

console.log('check:writer-progress');

const snapshot = detectWriterProgress(observation({
  toolName: 'writer_document_snapshot',
  args: { projectId: 'project-1' },
  result: {
    success: true,
    manuscriptId: 'manuscript-random-id',
    version: 7,
    contentHash: HASH_A,
    changedSincePrevious: true,
    changedCharacters: 900,
    contentLength: 4_000,
  },
}));
assert.deepEqual(snapshot, {
  kind: 'writer_snapshot_saved',
  fingerprint: `writer-content:${HASH_A}`,
});

const replayWithFreshIds = detectWriterProgress(observation({
  toolName: 'writerDocumentSnapshotTool',
  args: { projectId: 'project-1' },
  result: {
    success: true,
    manuscriptId: 'different-random-id',
    version: 8,
    contentHash: HASH_A,
    changedSincePrevious: true,
    changedCharacters: 900,
    contentLength: 4_000,
  },
}));
assert.equal(
  replayWithFreshIds?.fingerprint,
  snapshot?.fingerprint,
  'fresh UUID/version must not change the durable content identity',
);

for (const rejected of [
  observation({
    toolName: 'writer_document_snapshot',
    args: { projectId: 'project-1' },
    result: { success: true, version: 1, contentHash: HASH_A },
  }),
  observation({
    toolName: 'writer_document_snapshot',
    args: { projectId: 'project-1' },
    result: {
      success: true,
      manuscriptId: 'm-1',
      contentHash: HASH_A,
      changedSincePrevious: false,
      changedCharacters: 0,
      contentLength: 4_000,
    },
  }),
  observation({
    toolName: 'writer_document_snapshot',
    args: { projectId: 'project-1' },
    result: {
      success: true,
      manuscriptId: 'm-1',
      contentHash: HASH_A,
      changedSincePrevious: true,
      changedCharacters: 42,
      contentLength: 4_000,
    },
  }),
  observation({
    toolName: 'writer_document_snapshot',
    args: { projectId: 'project-1' },
    result: { success: true, manuscriptId: 'm-1', contentHash: 'not-a-hash' },
  }),
  observation({
    toolName: 'writer_document_snapshot',
    args: { projectId: 'project-1' },
    result: { success: false, manuscriptId: 'm-1', contentHash: HASH_A },
  }),
  observation({
    toolName: 'writer_document_snapshot',
    args: { projectId: 'project-1' },
    result: { manuscriptId: 'm-1', contentHash: HASH_A },
  }),
  observation({
    toolName: 'writer_document_snapshot',
    args: { projectId: 'project-1' },
    result: { success: true, manuscriptId: 'm-1', contentHash: HASH_A },
    isError: true,
  }),
]) {
  assert.equal(detectWriterProgress(rejected), undefined);
}

for (const activityOnly of [
  ['writer_document_write_section', { success: true, changed: true, contentHash: HASH_B }],
  ['writer_save_audit', { success: true, audit: { id: 'fresh-id' } }],
  ['writer_quality_gate', { success: true, auditIds: ['fresh-id'] }],
  ['system_run_worker', { success: true, output: '{"verdict":"pass"}' }],
  ['writer_update_continuity', { success: true, continuity: {} }],
  ['writer_document_read', { success: true, content: 'text' }],
] as const) {
  assert.equal(
    detectWriterProgress(observation({
      toolName: activityOnly[0],
      args: { projectId: 'project-1', content: 'x'.repeat(500) },
      result: activityOnly[1] as Record<string, unknown>,
    })),
    undefined,
    `${activityOnly[0]} is activity, not first-rollout durable progress`,
  );
}

const parallel: HarnessStepObservation = {
  toolCalls: [
    { toolCallId: 'replay', toolName: 'writer_document_snapshot', args: { projectId: 'project-1' } },
    { toolCallId: 'new', toolName: 'writer_document_snapshot', args: { projectId: 'project-1' } },
  ],
  toolResults: [
    {
      toolCallId: 'replay',
      toolName: 'writer_document_snapshot',
      result: {
        success: true,
        manuscriptId: 'm-a',
        contentHash: HASH_A,
        changedSincePrevious: true,
        changedCharacters: 900,
        contentLength: 4_000,
      },
      isError: false,
    },
    {
      toolCallId: 'new',
      toolName: 'writer_document_snapshot',
      result: {
        success: true,
        manuscriptId: 'm-b',
        contentHash: HASH_B,
        changedSincePrevious: true,
        changedCharacters: 900,
        contentLength: 4_000,
      },
      isError: false,
    },
  ],
};
assert.deepEqual(
  detectWriterProgressCandidates(parallel).map((entry) => entry.fingerprint),
  [`writer-content:${HASH_A}`, `writer-content:${HASH_B}`],
  'all parallel candidates must reach durable dedupe in call order',
);

console.log('Writer progress evidence checks passed.');
process.exit(0);
