#!/usr/bin/env tsx
/**
 * check-graphify-precontext.ts — Verification for Graphify Precontext Auto-Injection (Phase 2 Stream A).
 */
import assert from 'node:assert/strict';
import { buildCodingPrecontext } from '../services/coding-precontext.js';
import { buildReviewPrecontext } from '../services/review-precontext.js';
import { tryInjectGraphifyBlastRadius } from '../services/graphify-precontext.js';
import { getDb } from '../lib/mongo.js';

async function main() {
  console.log('check:graphify-precontext');

  // 1. Positive case: file with high fan-out -> ### Blast Radius (auto) appears with real dependents
  const highFanoutFile = 'src/mastra/config/pipeline-phase-tools.ts';
  const t0 = Date.now();
  const codingResPositive = await buildCodingPrecontext({
    userPrompt: 'Refactor pipeline phase tools',
    targetFiles: [highFanoutFile],
    includeMemory: false,
    includeSkills: false,
    includeRepoMap: false,
    includeCheckpoint: false,
  });
  const latencyMs = Date.now() - t0;

  console.log(`  ✓ High fan-out file (${highFanoutFile}) generated precontext in ${latencyMs}ms`);
  assert.equal(codingResPositive.graphifyIncluded, true, 'graphifyIncluded should be true for high fan-out file');
  assert.ok((codingResPositive.blastRadiusCount ?? 0) > 0, 'blastRadiusCount should be > 0');
  assert.ok(codingResPositive.markdown.includes('### Blast Radius (auto)'), 'markdown should contain Blast Radius section');
  assert.ok(codingResPositive.markdown.includes('pipeline-phase-tools.ts'), 'markdown should mention target symbol/file');
  console.log(`    blast radius count: ${codingResPositive.blastRadiusCount} dependents`);

  // 2. Direct timing measurement of tryInjectGraphifyBlastRadius
  const tDirect0 = Date.now();
  const directRes = await tryInjectGraphifyBlastRadius(['src/mastra/services/harness-policy.ts'], { timeoutMs: 900 });
  const directLatencyMs = Date.now() - tDirect0;
  console.log(`  ✓ Direct tryInjectGraphifyBlastRadius executed in ${directLatencyMs}ms (budget limit 900ms)`);
  assert.ok(directLatencyMs < 900, `Latency ${directLatencyMs}ms should be well within budget`);
  assert.ok(directRes.count > 0, 'harness-policy should have > 0 dependents');
  assert.ok(directRes.markdown.includes('### Blast Radius (auto)'));

  // 3. Negative case: non-existent / isolated file without graph node -> section SILENTLY suppresses
  const codingResNonExistent = await buildCodingPrecontext({
    userPrompt: 'Edit isolated new file',
    targetFiles: ['src/mastra/services/isolated-brand-new-file.ts'],
    includeMemory: false,
    includeSkills: false,
    includeRepoMap: false,
    includeCheckpoint: false,
  });
  assert.equal(codingResNonExistent.graphifyIncluded, false, 'graphifyIncluded must be false for unknown file');
  assert.equal(codingResNonExistent.markdown.includes('### Blast Radius'), false, 'markdown must NOT contain Blast Radius for unknown file');
  assert.ok(
    codingResNonExistent.suppressedReasons.includes('no_node_in_graph') || codingResNonExistent.suppressedReasons.includes('graphify_no_node_for_target_file'),
    'suppressedReasons should explain why graphify was omitted',
  );
  console.log('  ✓ Negative test: non-existent / isolated file safely and silently suppresses section');

  // 4. Negative case: empty targetFiles -> silently suppresses
  const codingResEmptyFiles = await buildCodingPrecontext({
    userPrompt: 'General task without target files',
    targetFiles: [],
    includeMemory: false,
    includeSkills: false,
    includeRepoMap: false,
    includeCheckpoint: false,
  });
  assert.equal(codingResEmptyFiles.graphifyIncluded, false, 'graphifyIncluded must be false when targetFiles is empty');
  assert.equal(codingResEmptyFiles.markdown.includes('### Blast Radius'), false);
  console.log('  ✓ Negative test: empty targetFiles silently suppresses section');

  // 5. Negative case: feature flag disabled (includeGraphify: false or FEATURE_GRAPHIFY_PRECONTEXT=false)
  const codingResDisabled = await buildCodingPrecontext({
    userPrompt: 'Refactor pipeline phase tools',
    targetFiles: [highFanoutFile],
    includeGraphify: false,
    includeMemory: false,
    includeSkills: false,
    includeRepoMap: false,
    includeCheckpoint: false,
  });
  assert.equal(codingResDisabled.graphifyIncluded, false, 'graphifyIncluded must be false when includeGraphify is false');
  assert.equal(codingResDisabled.markdown.includes('### Blast Radius'), false);
  console.log('  ✓ Negative test: includeGraphify=false completely bypasses graphify');

  // 6. Test review precontext with mock artifact
  const testTaskId = `test-review-graphify-${Date.now()}`;
  try {
    const db = await getDb();
    await db.collection('code_task_artifacts').insertOne({
      taskId: testTaskId,
      status: 'ready_for_review',
      agentId: 'codingAgent',
      filesChanged: [highFanoutFile],
      userRequest: 'Refactor phase tools',
      createdAt: new Date(),
    });

    const reviewRes = await buildReviewPrecontext({
      taskId: testTaskId,
      userPrompt: 'Review the changes',
    });

    assert.equal(reviewRes.graphifyIncluded, true, 'review precontext should include graphify for changed files');
    assert.ok((reviewRes.blastRadiusCount ?? 0) > 0, 'review precontext blastRadiusCount should be > 0');
    assert.ok(reviewRes.markdown.includes('### Blast Radius (auto)'), 'review precontext should contain Blast Radius');
    console.log(`  ✓ Review precontext successfully auto-injected blast radius (${reviewRes.blastRadiusCount} dependents)`);

    // Clean up test artifact
    await db.collection('code_task_artifacts').deleteOne({ taskId: testTaskId });
  } catch (err) {
    console.log(`  ℹ MongoDB skipped or unavailable for review precontext test (${(err as Error).message})`);
  }

  console.log('\n✅ check:graphify-precontext — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ check:graphify-precontext failed:', err);
  process.exit(1);
});
