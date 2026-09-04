/**
 * Auto-Approval Policy Engine (HITL System) for Mastra Agentic Environment.
 *
 * Implements a 3-tier classification:
 * - Category A: Fully Automated (Safe, Self-recipient, Drafts, Docs, Safe Automation)
 * - Category B: Conditional Auto-Approve with Guardrails (Cold-Email RODO + Daily Quota, Isolated Patches)
 * - Category C: Strict Human-In-The-Loop (Core Live Merge, Paid AI Generation, Destructive Actions)
 *
 * Design Invariant: FAIL-SAFE.
 * Any parsing ambiguity, exception, or unhandled case ALWAYS falls back to REQUIRE_HUMAN.
 */

import { validateDraft } from '../workflows/producer-hunt/quality.js';
import { checkDailyQuota, consumeDailyQuota } from './approval-quotas.js';

export type PolicyCategory = 'CATEGORY_A' | 'CATEGORY_B' | 'CATEGORY_C';
export type PolicyDecision = 'AUTO_APPROVE' | 'REQUIRE_HUMAN';

export type ApprovalRequestInput = {
  tool: string;
  action: string;
  args?: Record<string, unknown>;
  agentId?: string;
  taskId?: string;
};

export type PolicyEvaluationResult = {
  decision: PolicyDecision;
  category: PolicyCategory;
  ruleName: string;
  reason: string;
  autoApproved: boolean;
  metadata?: Record<string, unknown>;
};

// Configuration defaults
const DEFAULT_OWNER_EMAILS = [
  'admin@example.com',
  'patryk@gastrobridge.pl',
  'admin@example.com',
];

export const AUTO_APPROVE_MAX_DAILY_EMAILS = Number(process.env.AUTO_APPROVE_MAX_DAILY_EMAILS) || 10;

function getOwnerEmails(): string[] {
  const envEmail = process.env.OWNER_EMAIL;
  if (!envEmail) return DEFAULT_OWNER_EMAILS;
  const list = envEmail.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return Array.from(new Set([...list, ...DEFAULT_OWNER_EMAILS]));
}

function isOwnerEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  return getOwnerEmails().some((owner) => normalized === owner || normalized.includes(owner));
}

/**
 * Evaluates an incoming approval request against the policy engine rules.
 */
export async function evaluateApprovalPolicy(
  input: ApprovalRequestInput,
): Promise<PolicyEvaluationResult> {
  try {
    const { tool, action, args = {} } = input;

    // ─────────────────────────────────────────────────────────────────────────
    // CATEGORY A: FULL AUTO-APPROVE (Safe / Internal / Non-destructive)
    // ─────────────────────────────────────────────────────────────────────────

    // A1. Self-Recipient Emails (Sending materials, PDFs, reports to owner)
    if (isSelfRecipientEmail(tool, args)) {
      return {
        decision: 'AUTO_APPROVE',
        category: 'CATEGORY_A',
        ruleName: 'RULE_A1_SELF_RECIPIENT_EMAIL',
        reason: 'Wysyłka e-maila / materiałów na zweryfikowany adres właściciela systemu.',
        autoApproved: true,
        metadata: { recipient: args.to },
      };
    }

    // A2. Content & Social Media Draft Saving (Drafts without direct live publish)
    if (isContentOrDraftSaving(tool, action, args)) {
      return {
        decision: 'AUTO_APPROVE',
        category: 'CATEGORY_A',
        ruleName: 'RULE_A2_DRAFT_OR_SCHEDULE_ONLY',
        reason: 'Zapisanie szkicu treści / wpisu w kalendarzu bez bezpośredniej nieodwracalnej publikacji live.',
        autoApproved: true,
      };
    }

    // A3. Documentation & Markdown Patches
    if (isDocumentationPatch(tool, action, args)) {
      return {
        decision: 'AUTO_APPROVE',
        category: 'CATEGORY_A',
        ruleName: 'RULE_A3_DOCS_OR_MARKDOWN_PATCH',
        reason: 'Modyfikacja dotyczy wyłącznie dokumentacji lub plików Markdown (brak wpływu na kod runtime).',
        autoApproved: true,
      };
    }

    // A4. Memory Cleanup & Context Management
    if (isMemoryOrContextOperation(tool, action, args)) {
      return {
        decision: 'AUTO_APPROVE',
        category: 'CATEGORY_A',
        ruleName: 'RULE_A4_MEMORY_AND_CONTEXT_CLEANUP',
        reason: 'Rutynowe czyszczenie pamięci roboczej / zatwierdzenie zakończenia fazy zadania w pamięci.',
        autoApproved: true,
      };
    }

    // A5. Safe Analytic / Read-only Automation (e.g. NBP FX alert insert into isolated fx_alerts)
    if (isSafeAnalyticAutomation(tool, action, args)) {
      return {
        decision: 'AUTO_APPROVE',
        category: 'CATEGORY_A',
        ruleName: 'RULE_A5_SAFE_ANALYTIC_AUTOMATION',
        reason: 'Bezpieczna automatyzacja analityczna (pobranie danych zewnętrznych i zapis do wyizolowanej kolekcji).',
        autoApproved: true,
      };
    }

    // A6. Safe Read-Only Data Lookup / Search / Status Checks (CRM leads lookup, report generation, read-only analytics)
    if (isReadOnlyDataLookup(tool, action, args)) {
      return {
        decision: 'AUTO_APPROVE',
        category: 'CATEGORY_A',
        ruleName: 'RULE_A6_READ_ONLY_DATA_LOOKUP',
        reason: 'Bezpieczny odczyt / zapytanie o dane (lookup CRM, lead search, agregacja tylko do odczytu).',
        autoApproved: true,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CATEGORY B: CONDITIONAL AUTO-APPROVE (With Strict Guardrails)
    // ─────────────────────────────────────────────────────────────────────────

    // B1. Cold-Emailing with RODO & Daily Quota Guardrail
    if (isColdEmailOutreach(tool, args)) {
      const evaluation = await evaluateColdEmailOutreach(args);
      if (evaluation.allowed) {
        // Consume quota
        await consumeDailyQuota('cold_email_daily', evaluation.emailCount);
        return {
          decision: 'AUTO_APPROVE',
          category: 'CATEGORY_B',
          ruleName: 'RULE_B1_COLD_EMAIL_GUARDRAILED',
          reason: `Cold email pomyślnie zwalidowany (RODO obecne, brak placeholderów, w ramach limitu ${evaluation.emailCount}/${AUTO_APPROVE_MAX_DAILY_EMAILS}).`,
          autoApproved: true,
          metadata: { emailCount: evaluation.emailCount },
        };
      } else {
        return {
          decision: 'REQUIRE_HUMAN',
          category: 'CATEGORY_B',
          ruleName: 'RULE_B1_COLD_EMAIL_GUARDRAILED_FAILED',
          reason: `Cold email wymaga zatwierdzenia przez człowieka: ${evaluation.failureReason}`,
          autoApproved: false,
          metadata: { failureReason: evaluation.failureReason },
        };
      }
    }

    // B2. Isolated Helper Script / Tool Patch
    if (isIsolatedToolPatch(tool, action, args)) {
      return {
        decision: 'AUTO_APPROVE',
        category: 'CATEGORY_B',
        ruleName: 'RULE_B2_ISOLATED_TOOL_PATCH',
        reason: 'Poprawka w izolowanym module narzędziowym/skrypcie pomocniczym bez ingerencji w rdzeń systemu.',
        autoApproved: true,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CATEGORY C: STRICT HUMAN-IN-THE-LOOP (Explicitly Dangerous or Fallback)
    // ─────────────────────────────────────────────────────────────────────────

    // C1. Paid AI Media Generation (Video / Audio with external credits)
    if (isPaidMediaGeneration(tool, action, args)) {
      return {
        decision: 'REQUIRE_HUMAN',
        category: 'CATEGORY_C',
        ruleName: 'RULE_C1_PAID_MEDIA_GENERATION',
        reason: 'Płatne generowanie wideo/audio przez zewnętrzne modele chmurowe wymaga akceptacji kosztu.',
        autoApproved: false,
      };
    }

    // C2. Core System Merge & Slot Promotion
    if (isCoreSystemMergeOrPromotion(tool, action, args)) {
      return {
        decision: 'REQUIRE_HUMAN',
        category: 'CATEGORY_C',
        ruleName: 'RULE_C2_CORE_SYSTEM_MERGE',
        reason: 'Scalenie kodu do rdzenia systemu lub promocja slotu Blue-Green wymaga bezpośredniej autoryzacji.',
        autoApproved: false,
      };
    }

    // Fallback: anything unknown requires human approval
    return {
      decision: 'REQUIRE_HUMAN',
      category: 'CATEGORY_C',
      ruleName: 'RULE_C_DEFAULT_FALLBACK',
      reason: 'Operacja niekwalifikująca się do automatycznej zgody – wymagana weryfikacja operatora.',
      autoApproved: false,
    };
  } catch (error) {
    console.error('[ApprovalPolicyEngine] Policy evaluation exception, falling back to human:', error);
    return {
      decision: 'REQUIRE_HUMAN',
      category: 'CATEGORY_C',
      ruleName: 'RULE_C_FAILSAFE_EXCEPTION',
      reason: `Błąd podczas ewaluacji polityki: ${(error as Error).message}. Bezpieczny fallback do zgody człowieka.`,
      autoApproved: false,
    };
  }
}

// ── Helper Detection Functions ───────────────────────────────────────────────

function isSelfRecipientEmail(tool: string, args: Record<string, unknown>): boolean {
  if (!tool.toLowerCase().includes('gmail') && !tool.toLowerCase().includes('email') && !tool.toLowerCase().includes('mail')) {
    return false;
  }
  if (typeof args.to === 'string' && isOwnerEmail(args.to)) {
    return true;
  }
  if (Array.isArray(args.drafts) && args.drafts.length > 0) {
    return args.drafts.every((d: any) => typeof d?.to === 'string' && isOwnerEmail(d.to));
  }
  return false;
}

function isContentOrDraftSaving(tool: string, action: string, args: Record<string, unknown>): boolean {
  if (tool === 'contentSaveDraft' || tool === 'content_save_draft') {
    return true;
  }
  if (tool === 'hunt_set_run_status' && args.status !== 'ship') {
    return true;
  }
  if (action.toLowerCase().includes('zapisanie gotowego draftu') || action.toLowerCase().includes('utworzenie szkicu')) {
    if (!action.toLowerCase().includes('wysyłka') && !action.toLowerCase().includes('wyślij')) {
      return true;
    }
  }
  return false;
}

function isDocumentationPatch(tool: string, action: string, args: Record<string, unknown>): boolean {
  const path = String(args.path ?? args.targetFile ?? args.file ?? '');
  const commitMessage = String(args.commitMessage ?? '');
  const actionText = action.toLowerCase();

  const isDocPath = path.startsWith('docs/') || path.endsWith('.md') || path.includes('/docs/');
  const isDocAction = actionText.includes('.md') || actionText.includes('dokumentacji') || commitMessage.includes('.md');

  if ((isDocPath || isDocAction) && !path.endsWith('.ts') && !path.endsWith('.js') && !path.endsWith('.json')) {
    return true;
  }
  return false;
}

function isMemoryOrContextOperation(tool: string, action: string, args: Record<string, unknown>): boolean {
  if (tool === 'addContextTool' || tool === 'system_add_context') {
    return true;
  }
  if (action.toLowerCase().includes('czyszczenia pamięci') || action.toLowerCase().includes('memory cleanup')) {
    return true;
  }
  return false;
}

function isSafeAnalyticAutomation(tool: string, action: string, args: Record<string, unknown>): boolean {
  const automationId = String(args.automationId ?? '');
  const actionText = action.toLowerCase();

  // Known safe FX Alert / Read-only NBP automation
  if (automationId.includes('fx-alert') || actionText.includes('fx exposure alert')) {
    return true;
  }
  if (actionText.includes('pobranie kursu eur/pln z api nbp') && actionText.includes('zapis rekordu do kolekcji')) {
    return true;
  }
  return false;
}

function isColdEmailOutreach(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'gmail.send_draft' || tool === 'gmailSendDraftTool' || tool === 'hunt_approve_ship') {
    return true;
  }
  if (Array.isArray(args.drafts) || Array.isArray(args.pendingDrafts) || Array.isArray(args.leads)) {
    return true;
  }
  return false;
}

async function evaluateColdEmailOutreach(args: Record<string, unknown>): Promise<{
  allowed: boolean;
  emailCount: number;
  failureReason?: string;
}> {
  // Extract list of drafts/leads
  const items: Array<{ subject?: string; body?: string; email?: string; to?: string }> = [];

  if (Array.isArray(args.drafts)) {
    items.push(...args.drafts);
  } else if (Array.isArray(args.pendingDrafts)) {
    items.push(...args.pendingDrafts);
  } else if (Array.isArray(args.leads)) {
    items.push(...args.leads);
  } else if (typeof args.to === 'string') {
    items.push({
      to: args.to,
      subject: typeof args.subject === 'string' ? args.subject : '',
      body: typeof args.body === 'string' ? args.body : '',
    });
  }

  const emailCount = items.length || Number(args.leadCount) || 1;

  // 1. Quota Check
  const quota = await checkDailyQuota('cold_email_daily', AUTO_APPROVE_MAX_DAILY_EMAILS, emailCount);
  if (!quota.allowed) {
    return {
      allowed: false,
      emailCount,
      failureReason: `Przekroczono dzienny limit auto-approvali cold maili (${quota.used}/${quota.limit}, żądano ${emailCount}).`,
    };
  }

  // 2. Draft content validation (if body is present in payload)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item.body === 'string' && item.body.length > 0) {
      const draftObj = { subject: item.subject ?? '', body: item.body };
      const validation = validateDraft(draftObj, item);
      if (!validation.ok) {
        return {
          allowed: false,
          emailCount,
          failureReason: `Błąd walidacji draftu #${i + 1}: ${validation.hardFailures.join('; ')}`,
        };
      }
    }
  }

  return {
    allowed: true,
    emailCount,
  };
}

function isIsolatedToolPatch(tool: string, action: string, args: Record<string, unknown>): boolean {
  if (tool !== 'coding_apply_patch' && tool !== 'write_file') return false;
  const path = String(args.path ?? args.targetFile ?? '');
  if (!path) return false;

  // Only allow tools/scripts patches
  const isToolOrScript = path.startsWith('src/mastra/tools/') || path.startsWith('src/mastra/scripts/');
  const isForbidden =
    path.includes('index.ts') ||
    path.includes('meta-agent.ts') ||
    path.includes('orchestrat') ||
    path.includes('lib/mongo.ts');

  return isToolOrScript && !isForbidden;
}

function isPaidMediaGeneration(tool: string, action: string, args: Record<string, unknown>): boolean {
  const toolLower = tool.toLowerCase();
  const actionLower = action.toLowerCase();
  return (
    toolLower.includes('film') ||
    toolLower.includes('music') ||
    actionLower.includes('generowanie wideo') ||
    actionLower.includes('generowanie audio') ||
    actionLower.includes('paid remote call')
  );
}

function isCoreSystemMergeOrPromotion(tool: string, action: string, args: Record<string, unknown>): boolean {
  const toolLower = tool.toLowerCase();
  const actionLower = action.toLowerCase();
  return (
    toolLower.includes('promote') ||
    toolLower.includes('live-merge') ||
    actionLower.includes('scalenie do żywego repozytorium') ||
    actionLower.includes('promocja') ||
    actionLower.includes('slot-b') ||
    actionLower.includes('slot-a')
  );
}

function isReadOnlyDataLookup(tool: string, action: string, args: Record<string, unknown>): boolean {
  const toolLower = tool.toLowerCase();
  const actionLower = action.toLowerCase();
  const isCrmLookup =
    toolLower.includes('crm') ||
    toolLower.includes('lead') ||
    actionLower.includes('crm') ||
    actionLower.includes('odczyt') ||
    actionLower.includes('lookup') ||
    actionLower.includes('search_lead') ||
    actionLower.includes('searchleads');

  const isExplicitReadOnly =
    actionLower.includes('read-only') ||
    actionLower.includes('odczyt') ||
    actionLower.includes('zliczanie') ||
    actionLower.includes('wyszukiwanie');

  // Must not be an external email send or destructive write
  const isDestructive =
    actionLower.includes('send') ||
    actionLower.includes('delete') ||
    actionLower.includes('usun') ||
    actionLower.includes('wyślij') ||
    actionLower.includes('drop') ||
    actionLower.includes('reset');

  return (isCrmLookup || isExplicitReadOnly) && !isDestructive;
}
