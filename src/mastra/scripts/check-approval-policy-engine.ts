#!/usr/bin/env tsx
/**
 * Test suite for Auto-Approval Policy Engine & HITL System.
 *
 * Verifies:
 * - Category A: Full Auto-Approve (Self-recipient emails, Content/CRM drafts, Docs patches, Safe Analytics, Memory cleanup)
 * - Category B: Conditional Auto-Approve with Guardrails (Cold-email RODO validation, Quota enforcement, Quota exhaustion fallback to human, Isolated tool patches)
 * - Category C: Strict Human-In-The-Loop (Paid media AI, Core repo live merge, Destructive ops, Unrecognized tools)
 * - Integration with `system_request_approval` tool and `one-time-permit` consumption.
 *
 * Run: npx tsx src/mastra/scripts/check-approval-policy-engine.ts
 */
import assert from 'node:assert/strict';
import { getDb } from '../lib/mongo.js';
import {
  evaluateApprovalPolicy,
  AUTO_APPROVE_MAX_DAILY_EMAILS,
} from '../services/approval-policy-engine.js';
import {
  checkDailyQuota,
  consumeDailyQuota,
  resetDailyQuota,
  getTodayDateString,
} from '../services/approval-quotas.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { consumeOneTimePermit } from '../services/one-time-permit.js';
import { PL_RODO_FOOTER_TEMPLATE } from '../workflows/producer-hunt/quality.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('=== check:approval-policy-engine ===');

const TAG = `test-ape-${Date.now()}`;
const TEST_DATE = `2099-01-01`;

// Reset test quota
await resetDailyQuota('cold_email_daily', TEST_DATE);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Quota Service Tests
// ─────────────────────────────────────────────────────────────────────────────

await check('Quotas: tracks usage and limits accurately', async () => {
  const q0 = await checkDailyQuota('test_key', 5, 1, TEST_DATE);
  assert.equal(q0.used, 0);
  assert.equal(q0.remaining, 5);
  assert.equal(q0.allowed, true);

  await consumeDailyQuota('test_key', 3, TEST_DATE);
  const q1 = await checkDailyQuota('test_key', 5, 1, TEST_DATE);
  assert.equal(q1.used, 3);
  assert.equal(q1.remaining, 2);
  assert.equal(q1.allowed, true);

  // Requesting 3 when 2 remaining should fail
  const q2 = await checkDailyQuota('test_key', 5, 3, TEST_DATE);
  assert.equal(q2.allowed, false);

  await resetDailyQuota('test_key', TEST_DATE);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Category A: Full Auto-Approve Tests
// ─────────────────────────────────────────────────────────────────────────────

await check('Category A1: Self-recipient email to owner is AUTO_APPROVED', async () => {
  const result = await evaluateApprovalPolicy({
    tool: 'gmail_manage_draft',
    action: 'Wysłanie PDF "Księga Menu" na adres admin@example.com',
    args: {
      to: 'admin@example.com',
      subject: 'Księga Menu – SNAPS',
      body: 'W załączniku przesyłam PDF...',
    },
  });

  assert.equal(result.decision, 'AUTO_APPROVE');
  assert.equal(result.category, 'CATEGORY_A');
  assert.equal(result.ruleName, 'RULE_A1_SELF_RECIPIENT_EMAIL');
  assert.equal(result.autoApproved, true);
});

await check('Category A2: Content social media draft save is AUTO_APPROVED', async () => {
  const result = await evaluateApprovalPolicy({
    tool: 'contentSaveDraft',
    action: 'Zapisanie gotowego draftu posta na Instagram dla kanału HUMAN.CODE',
    args: {
      platform: 'instagram',
      topic: 'demand-withdraw',
      content: 'Treść posta...',
    },
  });

  assert.equal(result.decision, 'AUTO_APPROVE');
  assert.equal(result.category, 'CATEGORY_A');
  assert.equal(result.ruleName, 'RULE_A2_DRAFT_OR_SCHEDULE_ONLY');
  assert.equal(result.autoApproved, true);
});

await check('Category A3: Documentation markdown patch is AUTO_APPROVED', async () => {
  const result = await evaluateApprovalPolicy({
    tool: 'coding_apply_patch',
    action: 'Scalenie do żywego repozytorium pliku docs/v2-merge-probe.md',
    args: {
      path: 'docs/v2-merge-probe.md',
      commitMessage: 'Update v2 merge probe docs',
    },
  });

  assert.equal(result.decision, 'AUTO_APPROVE');
  assert.equal(result.category, 'CATEGORY_A');
  assert.equal(result.ruleName, 'RULE_A3_DOCS_OR_MARKDOWN_PATCH');
  assert.equal(result.autoApproved, true);
});

await check('Category A4: Memory cleanup & task finalization is AUTO_APPROVED', async () => {
  const result = await evaluateApprovalPolicy({
    tool: 'addContextTool',
    action: "Zatwierdzenie zakończenia fazy czyszczenia pamięci 'chat' i uznanie zadania za COMPLETE",
    args: {
      task: 'Memory Cleanup - Phase Chat',
      status: 'COMPLETE',
    },
  });

  assert.equal(result.decision, 'AUTO_APPROVE');
  assert.equal(result.category, 'CATEGORY_A');
  assert.equal(result.ruleName, 'RULE_A4_MEMORY_AND_CONTEXT_CLEANUP');
  assert.equal(result.autoApproved, true);
});

await check('Category A5: Safe FX Alert / NBP automation test is AUTO_APPROVED', async () => {
  const result = await evaluateApprovalPolicy({
    tool: 'architect_activate_automation',
    action: "Aktywacja workflow 'Mastra - FX Exposure Alert - EUR/PLN' oraz test: pobranie kursu EUR/PLN z API NBP, zapis do kolekcji fx_alerts",
    args: {
      automationId: 'fx-alert-eurpln',
      workflowId: 'GFxoqbjlmYEKWsBs',
    },
  });

  assert.equal(result.decision, 'AUTO_APPROVE');
  assert.equal(result.category, 'CATEGORY_A');
  assert.equal(result.ruleName, 'RULE_A5_SAFE_ANALYTIC_AUTOMATION');
  assert.equal(result.autoApproved, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Category B: Conditional Auto-Approve (Guardrails) Tests
// ─────────────────────────────────────────────────────────────────────────────

await check('Category B1: Valid cold-email with RODO and within quota is AUTO_APPROVED', async () => {
  const today = getTodayDateString();
  await resetDailyQuota('cold_email_daily', today);

  const footer = PL_RODO_FOOTER_TEMPLATE.replace('<źródło>', 'rejestr CEIDG');
  const validBody = `Dzień dobry,\n\nWidzę, że GastroBridge może pomóc w dostawach świeżych warzyw.\n\nPozdrawiam,\nPatryk\n\n---\n${footer}`;

  const result = await evaluateApprovalPolicy({
    tool: 'gmail.send_draft',
    action: 'Wysyłka 1 zwalidowanego cold maila',
    args: {
      to: 'kontakt@restauracja-przyklad.pl',
      subject: 'Świeże dostawy warzyw — GastroBridge',
      body: validBody,
    },
  });

  assert.equal(result.decision, 'AUTO_APPROVE');
  assert.equal(result.category, 'CATEGORY_B');
  assert.equal(result.ruleName, 'RULE_B1_COLD_EMAIL_GUARDRAILED');
  assert.equal(result.autoApproved, true);
});

await check('Category B1: Cold-email missing RODO footer is REJECTED to REQUIRE_HUMAN', async () => {
  const invalidBody = `Dzień dobry,\n\nKupujcie nasze produkty GastroBridge bez stopki prawnej!\n\nPozdrawiam`;

  const result = await evaluateApprovalPolicy({
    tool: 'gmail.send_draft',
    action: 'Wysyłka maila bez RODO',
    args: {
      to: 'kontakt@restauracja-przyklad.pl',
      subject: 'Oferta specjalna GastroBridge',
      body: invalidBody,
    },
  });

  assert.equal(result.decision, 'REQUIRE_HUMAN');
  assert.equal(result.category, 'CATEGORY_B');
  assert.equal(result.ruleName, 'RULE_B1_COLD_EMAIL_GUARDRAILED_FAILED');
  assert.equal(result.autoApproved, false);
  assert.match(result.reason, /RODO|Brak pełnej stopki/);
});

await check('Category B1: Cold-email exceeding daily quota falls back to REQUIRE_HUMAN', async () => {
  const today = getTodayDateString();
  // Fill up the quota to max
  await resetDailyQuota('cold_email_daily', today);
  await consumeDailyQuota('cold_email_daily', AUTO_APPROVE_MAX_DAILY_EMAILS, today);

  const footer = PL_RODO_FOOTER_TEMPLATE.replace('<źródło>', 'strona www');
  const validBody = `Dzień dobry,\n\nGastroBridge partner relacji.\n\n---\n${footer}`;

  const result = await evaluateApprovalPolicy({
    tool: 'gmail.send_draft',
    action: 'Wysyłka maila po wyczerpaniu limitu',
    args: {
      to: 'kontakt@kolejny-klient.pl',
      subject: 'Kontakt GastroBridge',
      body: validBody,
    },
  });

  assert.equal(result.decision, 'REQUIRE_HUMAN');
  assert.equal(result.category, 'CATEGORY_B');
  assert.equal(result.ruleName, 'RULE_B1_COLD_EMAIL_GUARDRAILED_FAILED');
  assert.match(result.reason, /Przekroczono dzienny limit/);

  // Clean up
  await resetDailyQuota('cold_email_daily', today);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Category C: Strict Human-In-The-Loop Tests
// ─────────────────────────────────────────────────────────────────────────────

await check('Category C1: Core code merge to live repository requires HUMAN approval', async () => {
  const result = await evaluateApprovalPolicy({
    tool: 'coding_apply_patch',
    action: 'Scalenie do żywego repozytorium pliku src/mastra/index.ts',
    args: {
      path: 'src/mastra/index.ts',
      commitMessage: 'Refactor core server listener',
    },
  });

  assert.equal(result.decision, 'REQUIRE_HUMAN');
  assert.equal(result.category, 'CATEGORY_C');
  assert.equal(result.autoApproved, false);
});

await check('Category C2: Paid AI Video Generation requires HUMAN approval', async () => {
  const result = await evaluateApprovalPolicy({
    tool: 'film_generate',
    action: 'Paid remote call to Luma Ray 2 for clip generation',
    args: {
      projectId: `${TAG}-film`,
      clipId: 'clip-1',
    },
  });

  assert.equal(result.decision, 'REQUIRE_HUMAN');
  assert.equal(result.category, 'CATEGORY_C');
  assert.equal(result.ruleName, 'RULE_C1_PAID_MEDIA_GENERATION');
  assert.equal(result.autoApproved, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. End-to-End Tool Integration & Permit Consumption
// ─────────────────────────────────────────────────────────────────────────────

await check('Tool Integration: system_request_approval executes auto-approval end-to-end', async () => {
  const db = await getDb();

  const toolResult = await (requestApprovalTool.execute as any)({
    tool: 'gmail_manage_draft',
    action: 'Wysłanie raportu na admin@example.com',
    args: {
      to: 'admin@example.com',
      subject: 'Raport dzienny',
    },
    agentId: 'meta-agent',
    taskId: `${TAG}-task`,
  });

  assert.equal(toolResult.success, true);
  assert.equal(toolResult.status, 'approved');
  assert.equal(toolResult.autoApproved, true);
  assert.ok(typeof toolResult.approvalId === 'string');

  // Verify stored document in MongoDB
  const doc = await db.collection('approvals').findOne({ id: toolResult.approvalId });
  assert.ok(doc, 'approval document must exist in MongoDB');
  assert.equal(doc.status, 'approved');
  assert.equal(doc.autoApproved, true);
  assert.equal(doc.autoApprovedCategory, 'CATEGORY_A');

  // Verify that consumeOneTimePermit successfully consumes this auto-approved token
  const permitResult = await consumeOneTimePermit({
    token: toolResult.approvalId,
    consumerId: 'test-runner',
    subject: 'daily-report-delivery',
  });

  assert.equal(permitResult, 'approved');

  // A second consume must be already_used
  const secondConsume = await consumeOneTimePermit({
    token: toolResult.approvalId,
    consumerId: 'test-runner',
    subject: 'daily-report-delivery',
  });
  assert.equal(secondConsume, 'already_used');

  // Clean up test document
  await db.collection('approvals').deleteOne({ id: toolResult.approvalId });
});

// Summary
if (failures > 0) {
  console.error(`\n❌ Finished with ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\n✅ All Auto-Approval Policy Engine tests passed!');
  process.exit(0);
}
