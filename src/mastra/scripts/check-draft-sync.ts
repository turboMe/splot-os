import assert from 'node:assert/strict';
import {
  upsertDraftFromGmail,
  listDrafts,
  getDraft,
  setDraftStatus,
  deleteDraftById,
  inferDraftSegment,
} from '../services/draft-registry.js';
import { getDb } from '../lib/mongo.js';

async function run() {
  console.log('=== Testing Gmail Draft Synchronization & Outreach Registry ===\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${name}:`, err.message);
      failed++;
    }
  }

  // 1. Segment inference
  await test('1. inferDraftSegment correctly detects Polish IT, Iceland IT, Gastro, B2B', async () => {
    assert.equal(inferDraftSegment('hr@firma.pl', 'Aplikacja AI Solutions Engineer', 'Dzień dobry...'), 'career_it_pl');
    assert.equal(inferDraftSegment('jobs@reykjavik.is', 'Application: AI Engineer', 'Hello...'), 'career_it_is');
    assert.equal(inferDraftSegment('hotel@iceland.is', 'Head Chef application', 'Dear Hiring Manager...'), 'career_chef_is');
    assert.equal(inferDraftSegment('kontakt@sery.pl', 'Współpraca B2B GastroBridge', 'Dzień dobry...', 'gastrobridge'), 'supplier_gb');
    assert.equal(inferDraftSegment('klient@firma.pl', 'Wdrożenie automatyzacji n8n', 'Flowmint AI...'), 'automation');
  });

  // 2. Auto-registration from Gmail
  const testGmailDraftId = 'test-gmail-draft-12345';
  await test('2. upsertDraftFromGmail creates a new draft in MongoDB', async () => {
    const draft = await upsertDraftFromGmail({
      gmailDraftId: testGmailDraftId,
      account: 'personal',
      to: 'rekrutacja@tech-corp.pl',
      subject: '[Aplikacja] AI Solutions Engineer - Alex Doe',
      body: 'Dzień dobry,\n\nPrzesyłam moją aplikację na stanowisko AI Solutions Engineer.\n\nPozdrawiam,\nAlex Doe',
      attachments: [{ filename: 'Candidate_AI_Solutions_Engineer_CV.pdf' }],
    });

    assert.equal(draft.gmailDraftId, testGmailDraftId);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.meta.segment, 'career_it_pl');
    assert.equal(draft.language, 'pl');
  });

  // 3. Retrieval
  await test('3. getDraft finds draft by draftId or gmailDraftId', async () => {
    const d1 = await getDraft(`gmail-${testGmailDraftId}`);
    assert.ok(d1, 'Should find by draftId');
    assert.equal(d1?.title, '[Aplikacja] AI Solutions Engineer - Alex Doe');

    const d2 = await getDraft(testGmailDraftId);
    assert.ok(d2, 'Should find by gmailDraftId');
    assert.equal(d2?.draftId, `gmail-${testGmailDraftId}`);
  });

  // 4. Filtering and search in listDrafts
  await test('4. listDrafts filters by segment, status, and search query', async () => {
    const all = await listDrafts({ channel: 'email' });
    assert.ok(all.some(d => d.gmailDraftId === testGmailDraftId));

    const itPl = await listDrafts({ segment: 'career_it_pl' });
    assert.ok(itPl.some(d => d.gmailDraftId === testGmailDraftId));

    const gastro = await listDrafts({ segment: 'career_chef_is' });
    assert.ok(!gastro.some(d => d.gmailDraftId === testGmailDraftId));

    const searchMatch = await listDrafts({ search: 'rekrutacja@tech-corp.pl' });
    assert.ok(searchMatch.length > 0);

    const searchNoMatch = await listDrafts({ search: 'nonexistent-string-99999' });
    assert.equal(searchNoMatch.length, 0);
  });

  // 5. Status transitions
  await test('5. setDraftStatus transitions status to approved and sent', async () => {
    const app = await setDraftStatus(`gmail-${testGmailDraftId}`, 'approved');
    assert.equal(app?.status, 'approved');

    const sent = await setDraftStatus(`gmail-${testGmailDraftId}`, 'sent');
    assert.equal(sent?.status, 'sent');
  });

  // 6. Cleanup
  await test('6. deleteDraftById removes the test draft', async () => {
    const res = await deleteDraftById(`gmail-${testGmailDraftId}`);
    assert.equal(res.success, true);

    const d = await getDraft(`gmail-${testGmailDraftId}`);
    assert.equal(d, null);
  });

  console.log(`\n========================================`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
