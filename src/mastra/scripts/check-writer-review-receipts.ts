#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const originalMongoUri = process.env.MONGODB_URI;
const originalWriterDocsDir = process.env.WRITER_DOCS_DIR;
const testDatabase = `writer_receipts_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const writerDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'writer-receipts-'));

function withDatabaseName(uri: string, databaseName: string): string {
  const queryStart = uri.indexOf('?');
  const base = queryStart === -1 ? uri : uri.slice(0, queryStart);
  const query = queryStart === -1 ? '' : uri.slice(queryStart);
  const authorityStart = base.indexOf('://') + 3;
  const databaseStart = base.indexOf('/', authorityStart);
  const authority = databaseStart === -1 ? base : base.slice(0, databaseStart);
  return `${authority}/${databaseName}${query}`;
}

process.env.MONGODB_URI = withDatabaseName(
  originalMongoUri ?? 'mongodb://localhost:27017/agentforge?replicaSet=rs0',
  testDatabase,
);
process.env.WRITER_DOCS_DIR = writerDocsDir;

const {
  claimWorkerReviewRequest,
  issueWorkerReviewRequest,
  recordSuccessfulWorkerRunReceipt,
} = await import('../tools/system/worker-run-receipts.js');
const { WriterService } = await import('../tools/writer/writer-service.js');
const {
  writerDocumentInit,
  writerDocumentRead,
  writerDocumentSnapshot,
  writerDocumentSyncSelectedSnapshot,
  writerDocumentWriteSection,
} = await import('../tools/writer/writer-document-tools.js');
const { closeDb, getDb } = await import('../lib/mongo.js');

const writer = new WriterService();
const projectId = 'receipt-project';
const manuscriptId = 'receipt-manuscript';
const passingOutput = JSON.stringify({
  overallVerdict: 'pass',
  score: 87,
  briefCompliance: { checked: ['first reveal timing'], violations: [] },
  findings: [],
  strengths: ['constraint check passed'],
  revisionPriorities: [],
});
const workerRunId = `worker:run-writer_critic-${Date.now()}`;

async function prepareCriticReceipt(runId: string, output: string) {
  const project = await writer.getProject(projectId);
  assert.ok(project, 'receipt test project should exist');
  const contractRevision = project.reviewRevision ?? 0;
  const issued = await issueWorkerReviewRequest({
    preset: 'writer_critic',
    correlation: {
      domain: 'writer',
      entityId: projectId,
      action: 'critic',
      subjectId: manuscriptId,
      contractRevision,
    },
    taskSpec: {
      goal: 'Review the exact Writer manuscript and return structured JSON.',
      context: `Project id: ${projectId}`,
      inputs: [{ name: 'manuscriptText', value: 'Exact manuscript.', source: 'runtime' }],
      outputContract: { format: 'json', schema: '{"overallVerdict":"pass|revise|block","score":"0-100"}' },
      successCriteria: ['Evaluate the supplied manuscript against its brief.'],
      constraints: { language: 'en', avoid: [] },
      effort: 'thorough',
    },
  });
  const correlation = issued.taskSpec.correlation!;
  const request = await claimWorkerReviewRequest({
    workerRunId: runId,
    preset: 'writer_critic',
    correlation,
    taskSpec: issued.taskSpec,
  });
  assert.equal(request.ok, true, 'prepared review request should be claimable exactly once');
  const trustedRequestId = request.ok ? request.requestId : undefined;
  const recorded = await recordSuccessfulWorkerRunReceipt({
    workerRunId: runId,
    preset: 'writer_critic',
    correlation,
    output,
    trustedRequestId,
  });
  return { recorded, issued };
}

try {
  const mutationProject = await writer.createProject({
    name: 'Snapshot invalidation check',
    brief: 'Write and review a full project.',
    type: 'fiction',
    taskMode: 'full_project',
  });
  assert.equal((await writerDocumentInit({
    projectId: mutationProject.id,
    title: 'Snapshot invalidation check',
  })).success, true);
  assert.equal((await writerDocumentWriteSection({
    projectId: mutationProject.id,
    anchor: 'chapter:01',
    content: 'First reviewed version.',
  })).success, true);
  const firstSnapshot = await writerDocumentSnapshot({
    projectId: mutationProject.id,
    title: 'First reviewed version',
  });
  assert.equal(firstSnapshot.success, true);
  const repeatedSnapshot = await writerDocumentSnapshot({
    projectId: mutationProject.id,
    title: 'Repeated unchanged version',
  });
  assert.equal(
    repeatedSnapshot.manuscriptId,
    firstSnapshot.manuscriptId,
    'an unchanged snapshot must reuse the same current manuscript authority',
  );
  await assert.rejects(
    () => writer.markCurrentManuscript(mutationProject.id, 'missing-manuscript'),
    /does not belong/i,
    'activating a missing snapshot must fail before changing current authority',
  );
  assert.equal(
    (await writer.getCurrentManuscript(mutationProject.id))?.id,
    firstSnapshot.manuscriptId,
    'a failed activation must leave the previous current snapshot intact',
  );
  await getDb().then((db) => db.collection('writer_projects').updateOne(
    { id: mutationProject.id },
    { $set: { status: 'done' } },
  ));
  const changedAfterDone = await writerDocumentWriteSection({
    projectId: mutationProject.id,
    anchor: 'chapter:01',
    content: 'A changed version that requires fresh reviews.',
  });
  assert.equal(changedAfterDone.success, true);
  const invalidatedProject = await writer.getProject(mutationProject.id);
  assert.equal(invalidatedProject?.currentManuscriptId, undefined);
  assert.equal(invalidatedProject?.status, 'revision', 'editing a done manuscript must reopen it for review');
  assert.equal(await writer.getCurrentManuscript(mutationProject.id), null);
  const parallelWrites = await Promise.all([
    writerDocumentWriteSection({
      projectId: mutationProject.id,
      anchor: 'chapter:02',
      content: 'Parallel chapter two.',
    }),
    writerDocumentWriteSection({
      projectId: mutationProject.id,
      anchor: 'chapter:03',
      content: 'Parallel chapter three.',
    }),
  ]);
  assert.ok(parallelWrites.every((result) => result.success));
  const afterParallelWrites = await writerDocumentRead(mutationProject.id);
  assert.match(afterParallelWrites.content ?? '', /Parallel chapter two\./);
  assert.match(afterParallelWrites.content ?? '', /Parallel chapter three\./);
  const literalProjectPatch = await writer.updateProject(mutationProject.id, {
    brief: '$status must remain literal user text.',
    styleProfile: { voiceSample: '$currentManuscriptId is not a Mongo expression.' } as any,
  });
  assert.equal(literalProjectPatch.brief, '$status must remain literal user text.');
  assert.equal(
    literalProjectPatch.styleProfile.voiceSample,
    '$currentManuscriptId is not a Mongo expression.',
    'aggregation update pipelines must persist user strings beginning with $ literally',
  );
  const foreignProject = await writer.createProject({
    name: 'Cross-project authority check',
    brief: 'Records from another project must never be moved here by id.',
    type: 'fiction',
    taskMode: 'full_project',
  });
  await writer.upsertSection({
    id: 'shared-section-id',
    projectId: mutationProject.id,
    order: 99,
    kind: 'notes',
    anchor: 'notes:authority',
    title: 'Authority owner',
  });
  await assert.rejects(
    () => writer.upsertSection({
      id: 'shared-section-id',
      projectId: foreignProject.id,
      order: 1,
      kind: 'notes',
      anchor: 'notes:foreign',
      title: 'Cross-project overwrite',
    }),
    /belongs to another project/i,
  );
  await writer.addSources(mutationProject.id, [{ id: 'shared-source-id', title: 'Owned source' }]);
  await assert.rejects(
    () => writer.addSources(foreignProject.id, [{ id: 'shared-source-id', title: 'Stolen source' }]),
    /belongs to another project/i,
  );
  await writer.upsertClaims(mutationProject.id, [{
    id: 'shared-claim-id',
    text: 'Owned claim',
    status: 'planned',
    risk: 'low',
  }]);
  await assert.rejects(
    () => writer.upsertClaims(foreignProject.id, [{
      id: 'shared-claim-id',
      text: 'Stolen claim',
      status: 'planned',
      risk: 'low',
    }]),
    /belongs to another project/i,
  );
  assert.equal(
    (await writer.getProject(foreignProject.id))?.reviewRevision,
    0,
    'a rejected cross-project mutation must roll back its reviewRevision bump',
  );
  const concurrentSnapshots = await Promise.all([
    writer.saveManuscriptSnapshot({
      projectId: mutationProject.id,
      title: 'Concurrent snapshot A',
      format: 'markdown',
      content: 'Concurrent snapshot A.',
    }),
    writer.saveManuscriptSnapshot({
      projectId: mutationProject.id,
      title: 'Concurrent snapshot B',
      format: 'markdown',
      content: 'Concurrent snapshot B.',
    }),
  ]);
  assert.equal(
    new Set(concurrentSnapshots.map((snapshot) => snapshot.version)).size,
    2,
    'concurrent snapshot transactions must allocate distinct project versions',
  );

  const auditWindowProject = await writer.createProject({
    name: 'Completion audit window check',
    brief: 'An unresolved revision must remain visible beyond the top-100 audit window.',
    type: 'fiction',
    taskMode: 'full_project',
  });
  assert.equal((await writerDocumentInit({
    projectId: auditWindowProject.id,
    title: 'Completion audit window check',
  })).success, true);
  assert.equal((await writerDocumentWriteSection({
    projectId: auditWindowProject.id,
    anchor: 'chapter:01',
    content: 'Current manuscript for audit window testing.',
  })).success, true);
  const auditWindowSnapshot = await writerDocumentSnapshot({
    projectId: auditWindowProject.id,
    title: 'Audit window snapshot',
  });
  assert.ok(auditWindowSnapshot.manuscriptId);
  const unresolvedRevision = await writer.saveAudit({
    projectId: auditWindowProject.id,
    manuscriptId: auditWindowSnapshot.manuscriptId,
    kind: 'revision',
    provenance: 'deterministic',
    ok: false,
    summary: 'Needs human review.',
  });
  const auditWindowDb = await getDb();
  await auditWindowDb.collection('writer_audits').insertMany(
    Array.from({ length: 100 }, (_, index) => ({
      id: `window-slop-${index}`,
      projectId: auditWindowProject.id,
      manuscriptId: auditWindowSnapshot.manuscriptId,
      reviewRevision: 0,
      auditRevision: unresolvedRevision.auditRevision + index + 1,
      kind: 'slop',
      provenance: 'deterministic',
      ok: true,
      score: 100,
      createdAt: new Date(unresolvedRevision.createdAt.getTime() + index + 1),
    })),
  );
  await auditWindowDb.collection('writer_projects').updateOne(
    { id: auditWindowProject.id },
    { $set: { auditRevision: unresolvedRevision.auditRevision + 100 } },
  );
  await assert.rejects(
    () => writer.updateProjectStatus(auditWindowProject.id, 'done'),
    /revision decision/i,
    'the latest unresolved revision must be queried even when 100 later audits fill the normal window',
  );
  const fileSyncTarget = await writer.saveManuscriptSnapshot({
    projectId: auditWindowProject.id,
    title: 'Atomically selected revision target',
    format: 'markdown',
    content: 'Selected revision bytes written after DB authority commits.',
    isCurrent: false,
  });
  const selectedRevisionAudit = await writer.saveAudit({
    projectId: auditWindowProject.id,
    manuscriptId: fileSyncTarget.id,
    activateManuscriptId: fileSyncTarget.id,
    expectedCurrentManuscriptId: auditWindowSnapshot.manuscriptId,
    expectedReviewRevision: 0,
    kind: 'revision',
    provenance: 'deterministic',
    ok: true,
    summary: 'Atomic selection before filesystem synchronization.',
  });
  const syncResult = await writerDocumentSyncSelectedSnapshot({
    projectId: auditWindowProject.id,
    manuscriptId: fileSyncTarget.id,
  });
  assert.equal(syncResult.success, true);
  assert.equal((await writerDocumentRead(auditWindowProject.id)).content, fileSyncTarget.content);
  assert.equal(
    (await writer.getProject(auditWindowProject.id))?.auditRevision,
    selectedRevisionAudit.auditRevision,
    'filesystem synchronization must not perform a second DB authority write',
  );

  await getDb().then((db) => db.collection('writer_manuscripts').insertOne({
    id: manuscriptId,
    projectId,
    version: 1,
    title: 'Receipt manuscript',
    format: 'markdown',
    content: 'Exact manuscript.',
    wordCount: 2,
    auditIds: [],
    isCurrent: true,
    createdAt: new Date(),
  }));
  await getDb().then((db) => db.collection('writer_projects').insertOne({
    id: projectId,
    name: 'Receipt project',
    type: 'fiction',
    status: 'render',
    brief: 'Review the exact manuscript.',
    deliverableLanguage: 'pl',
    workingLanguage: 'en',
    autonomyMode: 'full_auto',
    taskMode: 'full_project',
    styleProfile: {},
    canonPolicy: { authorityOrder: [], allowContradictionsOnlyWithRevision: true },
    outlineVersion: 0,
    manuscriptVersions: [manuscriptId],
    currentManuscriptId: manuscriptId,
    reviewRevision: 0,
    auditRevision: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const { recorded } = await prepareCriticReceipt(workerRunId, passingOutput);

  const audit = await writer.saveAudit({
    projectId,
    manuscriptId,
    kind: 'critic',
    ok: true,
    workerRunId,
    workerOutput: passingOutput,
    summary: 'Verified critic pass.',
  });
  assert.equal(audit.provenance, 'worker');
  assert.equal(audit.workerOutputHash, recorded.outputHash);
  assert.equal(audit.score, 87, 'score must come from the receipt-bound worker output');
  assert.equal(audit.auditRevision, 1, 'the first audit must receive the first monotonic project sequence');

  await assert.rejects(
    () => writer.saveAudit({
      projectId,
      manuscriptId,
      kind: 'critic',
      ok: true,
      workerRunId,
      workerOutput: passingOutput,
    }),
    /unconsumed worker receipt/i,
    'one worker result must not satisfy two independent audits',
  );

  await assert.rejects(
    () => writer.saveAudit({ projectId, manuscriptId, kind: 'polish', ok: true, summary: 'manual pass' }),
    /requires workerRunId/i,
    'manual self-attestation must not create a passing polish audit',
  );

  const forgedRunId = `${workerRunId}-unprepared`;
  await recordSuccessfulWorkerRunReceipt({
    workerRunId: forgedRunId,
    preset: 'writer_critic',
    correlation: {
      domain: 'writer',
      entityId: projectId,
      action: 'critic',
      subjectId: manuscriptId,
      contractRevision: 0,
    },
    output: passingOutput,
  });
  await assert.rejects(
    () => writer.saveAudit({
      projectId,
      manuscriptId,
      kind: 'critic',
      ok: true,
      workerRunId: forgedRunId,
      workerOutput: passingOutput,
    }),
    /unconsumed worker receipt/i,
    'a direct worker call without writer_prepare_worker_review must not mint a trusted audit',
  );

  await assert.rejects(
    () => recordSuccessfulWorkerRunReceipt({
      workerRunId: `${workerRunId}-forged-trust`,
      preset: 'writer_critic',
      correlation: {
        domain: 'writer',
        entityId: projectId,
        action: 'critic',
        subjectId: manuscriptId,
        contractRevision: 0,
      },
      output: passingOutput,
      trustedRequestId: 'forged-nonempty-request-id',
    }),
    /does not belong/i,
    'a nonempty invented trustedRequestId must not authorize a receipt',
  );

  const lowOutput = JSON.stringify({
    overallVerdict: 'pass',
    score: 72,
    briefCompliance: { checked: ['first reveal timing'], violations: [] },
  });
  const lowRunId = `${workerRunId}-low`;
  await prepareCriticReceipt(lowRunId, lowOutput);
  const lowAudit = await writer.saveAudit({
    projectId,
    manuscriptId,
    kind: 'critic',
    ok: true,
    workerRunId: lowRunId,
    workerOutput: lowOutput,
  });
  assert.equal(lowAudit.provenance, 'worker');
  assert.equal(lowAudit.ok, false, 'the exact worker output must override a caller trying to relabel it green');
  assert.equal(lowAudit.score, 72);

  const atomicRunId = `${workerRunId}-atomic`;
  await prepareCriticReceipt(atomicRunId, passingOutput);
  const db = await getDb();
  await db.command({
    collMod: 'writer_audits',
    validator: { $jsonSchema: { required: ['transactionSentinel'] } },
    validationLevel: 'strict',
  });
  await assert.rejects(
    () => writer.saveAudit({
      projectId,
      manuscriptId,
      kind: 'critic',
      ok: true,
      workerRunId: atomicRunId,
      workerOutput: passingOutput,
    }),
    /validation|document failed/i,
    'a forced audit insert failure should abort the receipt-consumption transaction',
  );
  const revisionTargetId = 'receipt-revision-target';
  await db.collection('writer_manuscripts').insertOne({
    id: revisionTargetId,
    projectId,
    version: 2,
    title: 'Revision target',
    format: 'markdown',
    content: 'Atomic revision target.',
    wordCount: 3,
    auditIds: [],
    isCurrent: false,
    createdAt: new Date(),
  });
  await assert.rejects(
    () => writer.saveAudit({
      projectId,
      manuscriptId: revisionTargetId,
      activateManuscriptId: revisionTargetId,
      expectedCurrentManuscriptId: manuscriptId,
      expectedReviewRevision: 0,
      kind: 'revision',
      provenance: 'deterministic',
      ok: true,
      summary: 'This transaction must roll back when its audit insert fails.',
    }),
    /validation|document failed/i,
    'snapshot selection and its required revision audit must commit or roll back together',
  );
  assert.equal((await writer.getProject(projectId))?.currentManuscriptId, manuscriptId);
  assert.equal((await writer.getCurrentManuscript(projectId))?.id, manuscriptId);
  await db.command({ collMod: 'writer_audits', validator: {}, validationLevel: 'off' });
  const retriedAtomicAudit = await writer.saveAudit({
    projectId,
    manuscriptId,
    kind: 'critic',
    ok: true,
    workerRunId: atomicRunId,
    workerOutput: passingOutput,
  });
  assert.equal(
    retriedAtomicAudit.provenance,
    'worker',
    'the same exact receipt must remain consumable after the failed transaction rolls back',
  );

  const manualFailure = await writer.saveAudit({
    projectId,
    manuscriptId,
    kind: 'polish',
    ok: false,
    summary: 'Manual fallback after two empty workers.',
  });
  assert.equal(manualFailure.provenance, 'manual');
  assert.equal(manualFailure.ok, false);

  const staleRunId = `${workerRunId}-stale-contract`;
  await prepareCriticReceipt(staleRunId, passingOutput);
  const changedProject = await writer.updateProject(projectId, {
    brief: 'A changed brief invalidates every review made for the prior contract.',
  });
  assert.equal(changedProject.reviewRevision, 1);
  await assert.rejects(
    () => writer.saveAudit({
      projectId,
      manuscriptId,
      expectedReviewRevision: 0,
      kind: 'continuity',
      provenance: 'deterministic',
      ok: true,
    }),
    /contract changed/i,
    'a deterministic result computed before a dependency change must not be relabeled with the new revision',
  );
  await assert.rejects(
    () => writer.saveAudit({
      projectId,
      manuscriptId,
      kind: 'critic',
      workerRunId: staleRunId,
      workerOutput: passingOutput,
    }),
    /unconsumed worker receipt|review contract/i,
    'a receipt prepared before a brief/style/ledger revision must not authorize a current audit',
  );

  await getDb().then((database) => database.collection('writer_projects').updateOne(
    { id: projectId },
    { $set: { status: 'done' } },
  ));
  await assert.rejects(
    () => writer.saveAudit({
      projectId,
      kind: 'revision',
      provenance: 'manual',
      ok: true,
      summary: 'An unscoped revision must not supersede the current completion state.',
    }),
    /requires the current manuscriptId/i,
  );
  assert.equal((await writer.getProject(projectId))?.status, 'done');
  await writer.saveAudit({
    projectId,
    manuscriptId,
    kind: 'claim',
    provenance: 'manual',
    ok: true,
    summary: 'A manual green claim is not an authorized completion gate.',
  });
  assert.equal(
    (await writer.getProject(projectId))?.status,
    'revision',
    'an unauthorized green audit that supersedes a completion gate must reopen done',
  );
  await getDb().then((database) => database.collection('writer_projects').updateOne(
    { id: projectId },
    { $set: { status: 'done' } },
  ));
  await writer.saveAudit({
    projectId,
    manuscriptId,
    kind: 'critic',
    ok: false,
    summary: 'A current red review must reopen a previously completed project.',
  });
  assert.equal(
    (await writer.getProject(projectId))?.status,
    'revision',
    'a red audit for the current snapshot must atomically reopen done',
  );

  console.log('Writer worker review receipt checks passed.');
} finally {
  await getDb().then((db) => db.dropDatabase()).catch(() => undefined);
  await closeDb().catch(() => undefined);
  if (originalMongoUri === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = originalMongoUri;
  if (originalWriterDocsDir === undefined) delete process.env.WRITER_DOCS_DIR;
  else process.env.WRITER_DOCS_DIR = originalWriterDocsDir;
  await fs.rm(writerDocsDir, { recursive: true, force: true });
}
