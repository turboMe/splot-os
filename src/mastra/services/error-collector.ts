/**
 * ErrorCollector — Self-Healing Error Detection Service (Etap 7)
 *
 * Nasłuchuje błędy runtime Mastry i automatycznie inicjuje
 * repo-maintenance-workflow, podając stack trace i kontekst błędu.
 *
 * Mechanizmy bezpieczeństwa:
 * - Deduplikacja wg hash signature (ten sam błąd nie odpala workflow 2x)
 * - Cooldown: min ERROR_COLLECTOR_COOLDOWN_MS ms między triggerami
 * - Limit aktywnych tasków: max ERROR_COLLECTOR_MAX_ACTIVE
 * - TTL: tickety starsze niż ERROR_COLLECTOR_TTL_HOURS h są czyszczone
 * - Self-protection: błędy z samego ErrorCollector NIE triggerują kolejnego heal
 */

import { createHash } from 'crypto';
import { getDb } from '../lib/mongo.js';
import { logAgentEvent } from '../lib/agent-event-log.js';
import { getOrCreateCycle, linkTicketToCycle } from '../lib/autoheal-cycles.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ErrorContext {
  /** Where the error was caught: 'uncaughtException' | 'unhandledRejection' | 'workflow' | 'agent' | 'api' */
  source: string;
  /** Optional — which workflow/agent/endpoint produced this error */
  origin?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface HealingTicket {
  ticketId: string;
  errorSignature: string;
  errorMessage: string;
  stackTrace: string;
  context: ErrorContext;
  status: 'pending' | 'in_progress' | 'resolved' | 'failed' | 'expired';
  workflowRunId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: Date;
}

// ── Config ───────────────────────────────────────────────────────────────────

const COOLDOWN_MS = Number(process.env.ERROR_COLLECTOR_COOLDOWN_MS ?? 60_000);
const MAX_ACTIVE = Number(process.env.ERROR_COLLECTOR_MAX_ACTIVE ?? 3);
const TTL_HOURS = Number(process.env.ERROR_COLLECTOR_TTL_HOURS ?? 24);
const ENABLED = (process.env.ERROR_COLLECTOR_ENABLED ?? 'true') !== 'false';
// Etap 0.4: twardy limit prób na tę samą sygnaturę + backoff po porażce.
// Bez tego ticketId `heal-<sig>-<ts>` po failed/expired tworzy nowy ticket → nowy worktree (wyciek).
const MAX_ATTEMPTS_PER_SIGNATURE = Number(process.env.ERROR_COLLECTOR_MAX_ATTEMPTS_PER_SIGNATURE ?? 3);
const RETRY_BACKOFF_MS = Number(process.env.ERROR_COLLECTOR_RETRY_BACKOFF_MS ?? 600_000);

// ── Transient-vs-defect classification ───────────────────────────────────────
// A wall-clock LLM timeout or a reflector "unrecoverable" stop is an OPERATIONAL
// signal (model saturation / convergence stall), NOT a code/build defect. Opening
// a full repo-maintenance coding cycle for it is harmful: the diagnose-and-plan
// codingAgent itself runs on the same harness and just times out again (cascade).
// We still record the cycle observation for diagnostics, but skip the ticket +
// workflow. Patterns are case-insensitive; extend via ENV (split on `|||`). Set
// ERROR_COLLECTOR_ESCALATE_TRANSIENT=true to restore the old always-escalate path.
const TRANSIENT_ERROR_PATTERNS: RegExp[] = (() => {
  const custom = (process.env.ERROR_COLLECTOR_TRANSIENT_PATTERNS ?? '')
    .split('|||')
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = [
    'Harness LLM call timed out',
    'LLM call timed out',
    'timed out after \\d+\\s*s',
    'trajectory is unrecoverable',
    'Run stopped early by the strategy reflector',
  ];
  return [...defaults, ...custom].map((p) => new RegExp(p, 'i'));
})();
const ESCALATE_TRANSIENT = (process.env.ERROR_COLLECTOR_ESCALATE_TRANSIENT ?? 'false') === 'true';


/**
 * What a ticket must say once its workflow run has ENDED.
 *
 * Extracted so it can be tested against real result shapes: a gate that stubs
 * `_triggerWorkflow` tests the stub, and `_triggerWorkflow` itself cannot run in
 * a gate because it imports the whole Mastra registry.
 *
 * The rule is deliberately blunt: anything that reaches here without a merge is
 * `failed`, i.e. needs a human. That is what makes MAX_ATTEMPTS_PER_SIGNATURE
 * and the retry backoff work — they count terminal tickets. A merge that landed
 * has already been closed as `completed` by `resolveHealTicket()`, and the
 * caller scopes this update to still-open tickets so it is never overwritten.
 */
export function describeRunOutcome(result: unknown): { status: 'failed'; statusReason: string } {
  const r = result as {
    status?: unknown;
    error?: unknown;
    result?: { action?: unknown; message?: unknown };
    steps?: Record<string, { status?: unknown; error?: unknown }>;
  };
  const runStatus = String(r?.status ?? 'unknown');

  /** Whatever a thrown value is, get a sentence out of it. */
  const asText = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    const maybe = (value as { message?: unknown }).message;
    return typeof maybe === 'string' ? maybe : '';
  };

  // The explanation lives in a different place depending on how the run ended,
  // and the useful one is usually NOT `result.message`. Measured: the workflow
  // halted with "implementacja nie wyprodukowała żadnych zmian w worktree (dwie
  // próby)" by THROWING, so the ticket recorded a bare "workflow failed" and the
  // operator view lost the only sentence that explained anything.
  const stepError = Object.values(r?.steps ?? {})
    .map((step) => asText(step?.error))
    .find((text) => text.length > 0) ?? '';
  const cause = asText(r?.error) || stepError || asText(r?.result?.message);
  const action = r?.result?.action;

  return {
    status: 'failed',
    statusReason: [
      `workflow ${runStatus}`,
      action ? `action=${String(action)}` : '',
      cause.slice(0, 500),
    ].filter(Boolean).join(' — '),
  };
}

// ── Error Collector ──────────────────────────────────────────────────────────

export class ErrorCollector {
  private lastTriggerTime = 0;
  private selfProtectionStack = false;

  /**
   * Wyznacza unikalną sygnaturę błędu — hash wiadomości + pierwszych 3 linii stack trace.
   * Dzięki temu identyczne błędy z różnych wywołań mają tę samą sygnaturę.
   */
  hashError(error: Error): string {
    const stackLines = (error.stack ?? '').split('\n').slice(0, 4).join('\n');
    const payload = `${error.name}::${error.message}::${stackLines}`;
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /**
   * Główna metoda — zgłoś błąd do systemu self-healing.
   * Decyduje czy odpalić workflow na podstawie deduplikacji, cooldownu i limitów.
   */
  async reportError(error: Error, context: ErrorContext): Promise<{ triggered: boolean; reason: string; ticketId?: string }> {
    if (!ENABLED) {
      return { triggered: false, reason: 'ErrorCollector disabled via ENV' };
    }

    // Self-protection: nie łap błędów z samego siebie
    if (this.selfProtectionStack) {
      return { triggered: false, reason: 'Self-protection: error inside ErrorCollector' };
    }

    this.selfProtectionStack = true;

    try {
      return await this._processError(error, context);
    } catch (collectorError: any) {
      console.error('[ErrorCollector] Internal error (self-protected):', collectorError.message);
      return { triggered: false, reason: `ErrorCollector internal failure: ${collectorError.message}` };
    } finally {
      this.selfProtectionStack = false;
    }
  }

  private async _processError(error: Error, context: ErrorContext): Promise<{ triggered: boolean; reason: string; ticketId?: string }> {
    const signature = this.hashError(error);

    // ── Etap 1: Cycle grouping — jedna sygnatura = jeden cykl ──
    // Każde wystąpienie błędu dopisuje OBSERWACJĘ do (istniejącego lub nowego)
    // cyklu, ZANIM zadziała cooldown/dedup. Ta sama sygnatura z aktywnym cyklem
    // = kolejna obserwacja, BEZ nowego worktree. (Worktree i tak powstaje tylko
    // przy realnym triggerze workflow poniżej.) Mongo-only, niekrytyczne.
    let cycleId: string | undefined;
    try {
      const { cycle } = await getOrCreateCycle(signature, {
        source: context.source,
        origin: context.origin,
        errorMessage: error.message,
        stackHint: (error.stack ?? '').split('\n').slice(0, 4).join('\n'),
        metadata: context.metadata,
      });
      cycleId = cycle.cycleId;
    } catch (cycleErr) {
      // Niekrytyczne — cykl to warstwa diagnostyczna. Healing leci dalej.
      console.warn('[ErrorCollector] Cycle grouping failed (non-fatal):', (cycleErr as Error).message);
    }

    // ── Transient classification: do NOT escalate timeouts / convergence stalls ──
    // The cycle observation above is already recorded for diagnostics. A transient
    // LLM timeout / reflector "unrecoverable" stop must not open a codingAgent
    // repair cascade (the healer would just time out again). Opt back in via
    // ERROR_COLLECTOR_ESCALATE_TRANSIENT=true.
    if (!ESCALATE_TRANSIENT) {
      const probe = `${error.name}: ${error.message}`;
      const match = TRANSIENT_ERROR_PATTERNS.find((re) => re.test(probe));
      if (match) {
        console.warn(
          `[ErrorCollector] Transient error (${match.source}) — recorded as cycle observation, NOT escalating to code repair.`,
        );
        return {
          triggered: false,
          reason: `Transient error (${match.source}) — recorded as cycle observation, not escalating to repo-maintenance coding cycle`,
        };
      }
    }

    // ── Cooldown check ──
    const now = Date.now();
    if (now - this.lastTriggerTime < COOLDOWN_MS) {
      return { triggered: false, reason: `Cooldown active (${COOLDOWN_MS}ms). Wait ${COOLDOWN_MS - (now - this.lastTriggerTime)}ms.` };
    }

    const db = await getDb();
    const collection = db.collection<HealingTicket>('auto_healing_tickets');

    // ── Deduplikacja — ten sam błąd już w toku? ──
    const existing = await collection.findOne({
      errorSignature: signature,
      status: { $in: ['pending', 'in_progress'] },
    });
    if (existing) {
      return { triggered: false, reason: `Duplicate: healing already in progress for signature ${signature}`, ticketId: existing.ticketId };
    }

    // ── Etap 0.4: Twardy limit prób na sygnaturę (zapobiega mnożeniu worktrees) ──
    const signatureAttempts = await collection.countDocuments({ errorSignature: signature });
    if (signatureAttempts >= MAX_ATTEMPTS_PER_SIGNATURE) {
      return { triggered: false, reason: `Max attempts per signature reached (${MAX_ATTEMPTS_PER_SIGNATURE}) for ${signature} — needs human` };
    }

    // ── Etap 0.4: Backoff po niedawnej porażce tej samej sygnatury ──
    const recentFailure = await collection
      .find({ errorSignature: signature, status: { $in: ['failed', 'expired'] } })
      .sort({ updatedAt: -1 })
      .limit(1)
      .next();
    if (recentFailure) {
      const failedAtMs = new Date(recentFailure.updatedAt).getTime();
      const sinceFailure = Date.now() - failedAtMs;
      if (sinceFailure < RETRY_BACKOFF_MS) {
        return { triggered: false, reason: `Backoff active for signature ${signature} (${Math.ceil((RETRY_BACKOFF_MS - sinceFailure) / 1000)}s left after recent failure)` };
      }
    }

    // ── Limit aktywnych tasków ──
    const activeCount = await collection.countDocuments({
      status: { $in: ['pending', 'in_progress'] },
    });
    if (activeCount >= MAX_ACTIVE) {
      return { triggered: false, reason: `Max active healing tasks reached (${MAX_ACTIVE})` };
    }

    // ── Utwórz ticket ──
    const ticketId = `heal-${signature}-${Date.now()}`;
    const ticket: HealingTicket = {
      ticketId,
      errorSignature: signature,
      errorMessage: error.message,
      stackTrace: (error.stack ?? '').slice(0, 8000), // limit do 8KB
      context,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
    };

    await collection.insertOne(ticket as any);

    // ── Etap 1: powiąż ticket z cyklem (most do per-cykl flow w Etapach 2+) ──
    if (cycleId) {
      linkTicketToCycle(cycleId, ticketId).catch((e) =>
        console.warn('[ErrorCollector] linkTicketToCycle failed (non-fatal):', (e as Error).message),
      );
    }

    // ── Trigger workflow ──
    this.lastTriggerTime = Date.now();

    // Fire-and-forget: uruchamiamy workflow asynchronicznie
    this._triggerWorkflow(ticketId, error, context).catch((err) => {
      console.error(`[ErrorCollector] Failed to trigger workflow for ${ticketId}:`, err.message);
      // Oznacz ticket jako failed
      collection.updateOne(
        { ticketId },
        { $set: { status: 'failed', updatedAt: new Date().toISOString() } },
      ).catch(() => {});
    });

    return { triggered: true, reason: 'Workflow triggered', ticketId };
  }

  private async _triggerWorkflow(ticketId: string, error: Error, context: ErrorContext): Promise<void> {
    const db = await getDb();
    const collection = db.collection('auto_healing_tickets');

    try {
      // Dynamiczny import, żeby uniknąć circular dependency z index.ts
      const { mastra } = await import('../index.js');
      const workflow = mastra.getWorkflow('repoMaintenanceWorkflow');

      if (!workflow) {
        throw new Error('repoMaintenanceWorkflow not found in Mastra registry');
      }

      // ── Phase 2.1: Failure Brain — recall known failures before workflow ──
      let knownFailuresSection = '';
      try {
        const { recallKnowledge } = await import('../lib/failure-brain.js');

        const failureCases = await recallKnowledge(
          `${error.name}: ${error.message}`,
          { type: 'failure_case', topK: 3, minScore: 0.4 },
        );
        if (failureCases.length > 0) {
          knownFailuresSection = [
            ``,
            `### Znane podobne awarie z historii systemu:`,
            ...failureCases.map((i: any) =>
              `- **[score: ${i.score.toFixed(2)}]** ${i.title}\n  ${i.content}`
            ),
            ``,
            `Jeśli któraś z powyższych awarii pasuje do bieżącego problemu, użyj opisanego rozwiązania jako bazy.`,
          ].join('\n');
        }

        // Also check autoheal_recipes
        const recipes = await recallKnowledge(
          `${error.name}: ${error.message}`,
          { type: 'autoheal_recipe', topK: 2, minScore: 0.4 },
        );
        if (recipes.length > 0) {
          knownFailuresSection += [
            ``,
            `### Sprawdzone receptury auto-naprawy:`,
            ...recipes.map((i: any) =>
              `- **[score: ${i.score.toFixed(2)}]** ${i.title}\n  ${i.content}`
            ),
          ].join('\n');
        }
      } catch (recallErr) {
        // Non-fatal — workflow proceeds without historical context
        console.warn('[ErrorCollector] Failure Brain recall failed:', (recallErr as Error).message);
      }

      const prompt = [
        `System wykrył błąd runtime wymagający automatycznej naprawy.`,
        ``,
        `Źródło: ${context.source}${context.origin ? ` (${context.origin})` : ''}`,
        `Typ błędu: ${error.name}`,
        `Wiadomość: ${error.message}`,
        ``,
        `Stack trace:`,
        `\`\`\``,
        (error.stack ?? '').slice(0, 4000),
        `\`\`\``,
        ``,
        context.metadata ? `Dodatkowy kontekst: ${JSON.stringify(context.metadata, null, 2)}` : '',
        knownFailuresSection,
        ``,
        `Ticket ID: ${ticketId}`,
        ``,
        `Instrukcja: Zbadaj przyczynę tego błędu w kodzie źródłowym.`,
        knownFailuresSection ? `Sprawdź znane awarie powyżej — jeśli pasują, użyj ich rozwiązania jako bazy.` : '',
        `Znajdź plik i linię odpowiedzialną za problem.`,
        `Przygotuj minimalną poprawkę i przekaż do Code Review.`,
        `Oznacz źródło naprawy jako "system-auto-heal".`,
      ].filter(Boolean).join('\n');

      // Uruchomienie workflow
      const run = await workflow.createRun();

      // `in_progress` BEFORE the run, because that is when it becomes true.
      // It used to be written afterwards, which made the status a lie in both
      // directions: the ticket read `pending` for the entire repair, and if the
      // process died mid-run it stayed `pending` forever.
      await collection.updateOne(
        { ticketId },
        {
          $set: {
            status: 'in_progress',
            workflowRunId: (run as any).runId ?? 'unknown',
            updatedAt: new Date().toISOString(),
          },
        },
      );

      const result = await run.start({
        inputData: {
          userRequest: prompt,
          taskId: ticketId,
        },
      });

      // The run is OVER, so the ticket must not still say it is running.
      //
      // Only `resolveHealTicket()` ever closed a ticket, and it is called on a
      // successful MERGE. Every other ending — an empty worktree, a rejected
      // review, a blocked merge, a conflict — left the ticket `in_progress`
      // until the 24h TTL. Three of those and self-healing is silently dead:
      // `in_progress` is counted by the dedup (§line ~175), by MAX_ACTIVE
      // (§line ~203) and by the operator view, so the system reports three
      // repairs in flight while nothing is running and refuses to start more.
      //
      // Measured on the first live autoheal cycle: the workflow halted
      // correctly ("implementacja nie wyprodukowała żadnych zmian w worktree —
      // zatrzymuję cykl zamiast wysyłać puste worktree do recenzji") and the
      // ticket sat `in_progress` for as long as it was watched.
      //
      // Scoped to still-open tickets so a merge that already resolved this one
      // is not overwritten.
      await collection.updateOne(
        { ticketId, status: { $in: ['pending', 'in_progress'] } },
        { $set: { ...describeRunOutcome(result), updatedAt: new Date().toISOString() } },
      );

      console.log(`[ErrorCollector] ✅ Workflow triggered for ticket ${ticketId} (run: ${(run as any).runId ?? 'unknown'})`);

      logAgentEvent({
        type: 'autoheal_triggered',
        agentId: 'error-collector',
        taskId: ticketId,
        status: 'pending',
        input: error.message.slice(0, 500),
        metadata: { source: context.source, origin: context.origin, workflowRunId: (run as any).runId },
      });
    } catch (triggerError: any) {
      await collection.updateOne(
        { ticketId },
        { $set: { status: 'failed', updatedAt: new Date().toISOString() } },
      );
      throw triggerError;
    }
  }

  /**
   * Oznacza ticket jako rozwiązany — wywoływane po udanym deploy-and-verify.
   */
  async resolveTicket(ticketId: string): Promise<void> {
    const db = await getDb();
    const ticket = await db.collection<HealingTicket>('auto_healing_tickets').findOne({ ticketId }) as unknown as HealingTicket | null;

    await db.collection('auto_healing_tickets').updateOne(
      { ticketId },
      { $set: { status: 'resolved', updatedAt: new Date().toISOString() } },
    );

    // ── Phase 2.1: Save resolution as autoheal_recipe for future Failure Brain recall ──
    if (ticket) {
      try {
        const { writeKnowledge } = await import('../lib/failure-brain.js');
        await writeKnowledge(
          'autoheal_recipe',
          `Fix: ${ticket.errorMessage.slice(0, 100)}`,
          [
            `Error: ${ticket.errorMessage}`,
            `Source: ${ticket.context.source}${ticket.context.origin ? ` (${ticket.context.origin})` : ''}`,
            `Stack hint: ${(ticket.stackTrace ?? '').split('\n').slice(0, 3).join(' | ')}`,
            `Resolution: ticket ${ticketId} resolved via workflow ${ticket.workflowRunId ?? 'unknown'}`,
          ].join('\n'),
        );
      } catch (writeErr) {
        // Non-fatal — ticket is already resolved
        console.warn('[ErrorCollector] Failed to save autoheal recipe:', (writeErr as Error).message);
      }
    }
  }

  /**
   * Czyści wygasłe tickety (wywoływane okresowo lub przy starcie).
   */
  async cleanupExpired(): Promise<number> {
    const db = await getDb();
    const result = await db.collection('auto_healing_tickets').deleteMany({
      expiresAt: { $lt: new Date() },
    });
    return result.deletedCount;
  }

  /**
   * Zwraca status aktywnych ticketów (do diagnostyki).
   */
  async getActiveTickets(): Promise<HealingTicket[]> {
    const db = await getDb();
    return db.collection<HealingTicket>('auto_healing_tickets')
      .find({ status: { $in: ['pending', 'in_progress'] } })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray() as unknown as HealingTicket[];
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: ErrorCollector | null = null;

export function getErrorCollector(): ErrorCollector {
  if (!_instance) {
    _instance = new ErrorCollector();
  }
  return _instance;
}
