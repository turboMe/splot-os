#!/usr/bin/env tsx
/**
 * e2e:artifact-handoff — Etap 3 (IDEALSYSTEMMASTERPLAN).
 *
 * Deterministic, LLM-free end-to-end of the researcher → writer handoff
 * pattern on the REAL Artifact Store (Mongo + file split):
 *
 *   1. "researcher" saves a large research report (~40 KB) via putArtifact
 *      → ref {id, type, summary ≤300};
 *   2. the delegation brief for "writer" is rendered from TaskBrief v2 with
 *      inputs: [{artifactId}] → the brief contains SUMMARY + id, NOT the 40 KB;
 *   3. "writer" fetches full content via getArtifact (byte-identical);
 *   4. artifact_list(laneId) finds it; oversize content lands in file storage;
 *   5. the delegation-brief cost drop vs verbatim paste is measured (≥95%);
 *   6. writer's reply with an envelope referencing the artifact parses.
 *
 * Scope note: the live researcher→writer LLM run costs real tokens and is a
 * live verification, not CI — the store/brief/envelope path exercised here is
 * byte-identical to what delegate-task uses.
 */
import assert from 'node:assert/strict';
import { getDb } from '../lib/mongo.js';
import { putArtifact, getArtifact, listArtifacts } from '../services/artifact-store.js';
import { renderWorkerBriefWithArtifacts } from '../tools/system/worker-task-spec.js';
import { parseResultEnvelope } from '../services/result-envelope.js';

const LANE = `e2e-handoff-${Date.now()}`;

async function cleanup(ids: string[]): Promise<void> {
  const db = await getDb();
  await db.collection('artifacts').deleteMany({ id: { $in: ids } });
}

async function main(): Promise<void> {
  console.log('e2e:artifact-handoff');
  const created: string[] = [];

  try {
    // ── 1. Researcher produces a ~40 KB research report ─────────────────────
    const bigReport = [
      '# Research: restaurant X — menu + reputation\n',
      ...Array.from({ length: 400 }, (_, i) =>
        `## Section ${i}\nFinding ${i}: the menu features seasonal items priced 40-80 PLN with strong reviews mentioning fermentation techniques and locally-sourced ingredients from regional suppliers.\n`),
    ].join('\n');
    const bytes = Buffer.byteLength(bigReport, 'utf8');
    assert.ok(bytes > 40_000, `report should be >40KB (is ${bytes})`);

    const ref = await putArtifact({
      type: 'research_report',
      content: bigReport,
      summary: 'Menu + reputation recon for restaurant X: 40 sections, seasonal menu 40-80 PLN, fermentation praised in reviews, regional suppliers identified.',
      producedBy: 'researcherAgent',
      laneId: LANE,
      title: 'Restaurant X recon',
    });
    created.push(ref.id);
    assert.ok(ref.id.startsWith('art-'));
    assert.ok(ref.summary.length <= 300, 'summary within 300 chars');
    console.log(`  ✓ researcher saved ${bytes} bytes as ${ref.id} (summary ${ref.summary.length} chars)`);

    // ── 2. Writer's brief carries summary + ref, never the content ──────────
    const brief = await renderWorkerBriefWithArtifacts({
      goal: 'Write a 2-page client-facing summary of the restaurant X recon.',
      inputs: [{ name: 'recon-report', artifactId: ref.id, source: 'artifact' }],
      outputContract: { format: 'prose', artifactType: 'document' },
      successCriteria: ['covers menu pricing and reputation themes', 'under 2 pages'],
      laneId: LANE,
    });
    assert.ok(brief.includes(ref.id), 'brief references the artifact id');
    assert.ok(brief.includes('fermentation praised in reviews') || brief.includes(ref.summary.slice(0, 50)),
      'brief carries the summary');
    assert.ok(!brief.includes('## Section 250'), 'brief does NOT inline the full report');
    assert.ok(brief.length < 3_000, `brief stays compact (${brief.length} chars)`);
    assert.ok(brief.includes('Artifact type: document'), 'output contract names the artifact type');

    const verbatimSize = bigReport.length;
    const briefSize = brief.length;
    const saving = 1 - briefSize / verbatimSize;
    assert.ok(saving >= 0.95, `handoff saving should be ≥95% (is ${(saving * 100).toFixed(1)}%)`);
    console.log(`  ✓ brief: ${briefSize} chars vs ${verbatimSize} verbatim → −${(saving * 100).toFixed(1)}% handoff payload`);

    // ── 3. Writer fetches full content on demand ────────────────────────────
    const fetched = await getArtifact(ref.id);
    assert.equal(fetched?.content, bigReport, 'full content round-trips byte-identical');
    assert.equal(fetched?.producedBy, 'researcherAgent');
    console.log(`  ✓ artifact_get returns full content (${fetched!.bytes} bytes, storage=${fetched!.storage})`);

    // ── 4. Lane listing + file-storage split for oversize content ───────────
    const listed = await listArtifacts({ laneId: LANE });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, ref.id);
    assert.ok(!('content' in listed[0]!) || listed[0]!.content === undefined, 'list never carries content');

    const huge = await putArtifact({
      type: 'document',
      content: 'x'.repeat(600 * 1024),
      summary: 'oversize test doc',
      producedBy: 'writerAgent',
      laneId: LANE,
    });
    created.push(huge.id);
    const hugeRec = await getArtifact(huge.id, { includeContent: false });
    assert.equal(hugeRec?.storage, 'file', 'oversize content stored as file');
    const hugeFull = await getArtifact(huge.id);
    assert.equal(hugeFull?.content?.length, 600 * 1024, 'file-stored content readable');
    console.log('  ✓ lane listing works; >512KB content splits to file storage and reads back');

    // ── 5. Writer's envelope references the produced artifact ───────────────
    const writerReply = [
      'Client summary drafted and saved to the artifact store.',
      '```json result_envelope',
      JSON.stringify({
        status: 'ok',
        artifacts: [{ id: huge.id, type: 'document', summary: 'Client-facing 2-page summary' }],
        lessons: ['Summary-first handoff kept the writer brief under 3KB'],
      }),
      '```',
    ].join('\n');
    const envelope = parseResultEnvelope(writerReply);
    assert.equal(envelope.parsed, true);
    assert.equal(envelope.artifacts[0]?.id, huge.id);
    assert.equal(envelope.lessons.length, 1);
    console.log('  ✓ writer envelope parses with artifact ref + lesson');

    console.log('\n✅ e2e:artifact-handoff — PASSED');
  } finally {
    await cleanup(created).catch(() => undefined);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ e2e:artifact-handoff failed:', err);
  process.exit(1);
});
