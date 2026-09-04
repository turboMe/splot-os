import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getDb } from '../lib/mongo.js';
import { getErrorCollector } from '../services/error-collector.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

import { generateCoding } from '../services/coding-harness.js';
import { generateReview } from '../services/review-harness.js';
import { reviewAttemptCapMs } from '../config/capability-routing.js';
import { isAutohealTask } from '../services/autoheal-repair-lane.js';

/**
 * Etap 5.5 — w trybie autoheal supervisor jest właścicielem promocji, więc
 * ludzka bramka `confirmMerge` nie może blokować pętli self-healingu.
 * Bypass działa WYŁĄCZNIE gdy: flaga AUTOHEAL_AUTO_PROMOTE=true (domyślnie OFF)
 * ORAZ task jest autohealowy (`heal-*`). Zadania użytkownika ZAWSZE wymagają
 * potwierdzenia człowieka — gate nietknięty.
 */
function autohealAutoConfirmMerge(taskId: string): boolean {
  return process.env.AUTOHEAL_AUTO_PROMOTE === 'true' && isAutohealTask(taskId);
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const codingTaskSchema = z.object({
  userRequest: z.string().describe('Instrukcja dla agenta kodującego.'),
  taskId: z.string().optional().describe('Opcjonalne wymuszenie ID taska, jeśli istnieje.'),
});

const codingOutputSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  iteration: z.number(),
});

const reviewOutputSchema = z.object({
  taskId: z.string(),
  verdict: z.enum(['approve', 'needs_changes', 'block']),
  comments: z.string(),
  iteration: z.number(),
});

const MAX_REVIEW_ITERATIONS = 3;

/**
 * Review runs in its own thread. Mastra stamps a thread with the resourceId of
 * the agent that created it, and each agent's input processor rejects a thread
 * owned by someone else — so sharing taskId between codingAgent and
 * codeReviewAgent made every review fail before it started.
 */
function reviewThreadId(taskId: string): string {
  return `${taskId}-review`;
}

// ── Step 1a: Diagnose and Plan ───────────────────────────────────────────────

const diagnoseAndPlan = createStep({
  id: 'diagnose-and-plan',
  description: 'Faza diagnostyczna: szerokie badanie błędu, analiza wpływu, ustrukturyzowany plan naprawy z subtaskami.',
  inputSchema: codingTaskSchema,
  outputSchema: codingOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codingAgent');
    if (!agent) throw new Error('codingAgent not found');

    const taskId = inputData.taskId || randomUUID();

    // Ładujemy diagnostyczny prompt dynamicznie — NIE jest częścią base.md agenta
    let diagnosticInstructions: string;
    try {
      const { loadPrompt } = await import('../lib/prompt-loader.js');
      diagnosticInstructions = await loadPrompt('coding/diagnose');
    } catch {
      // Fallback jeśli plik promptu nie istnieje
      diagnosticInstructions = `Przeprowadź szeroki skan kontekstu. Zbadaj plik błędu, importy, eksporty, zależności. Znajdź pliki powiązane i testy. Stwórz plan naprawy z subtaskami. NIE edytuj plików.`;
    }

    const prompt = [
      diagnosticInstructions,
      ``,
      `## Zadanie do diagnozy`,
      ``,
      inputData.userRequest,
      ``,
      `## Identyfikator zadania: ${taskId}`,
      ``,
      `Na samym początku użyj \`coding_create_artifact\` aby zainicjować artifact z ID: ${taskId}.`,
      `Po zakończeniu diagnostyki zaktualizuj artifact (\`coding_update_artifact\`) z pełnym polem \`diagnosticPlan\` i ustaw status na \`planning\`.`,
    ].join('\n');

    await generateCoding({
      agent,
      agentId: 'codingAgent',
      prompt,
      taskId,
      phase: 'diagnose',
      repoPath: AGENTIC_AGENTS_REPO,
      timeoutMs: 300_000,
    });

    // ── Post-diagnosis: Smart Router assigns models & parallel groups ──
    try {
      const { routeSubtasks, formatRoutingResult } = await import('../services/smart-router.js');
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

      if (artifact?.diagnosticPlan?.subtasks?.length) {
        const routingResult = routeSubtasks(artifact.diagnosticPlan.subtasks);
        console.log(formatRoutingResult(routingResult));

        // Write routed subtasks back to artifact
        await db.collection('code_task_artifacts').updateOne(
          { taskId },
          {
            $set: {
              'diagnosticPlan.subtasks': artifact.diagnosticPlan.subtasks, // mutated in-place by router
              'diagnosticPlan.routingSummary': routingResult.summary,
              updatedAt: new Date().toISOString(),
            },
          },
        );
      }
    } catch (routeErr) {
      // Non-fatal — execute-patch can still work without routing
      console.warn('[diagnose-and-plan] Smart Router failed, subtasks will run sequentially:', (routeErr as Error).message);
    }

    return {
      taskId,
      status: 'planning',
      iteration: 1,
    };
  },
});

// ── Step 1b: Execute Patch ───────────────────────────────────────────────────

const executePatch = createStep({
  id: 'execute-patch',
  description: 'Realizacja planu naprawy: routing → parallel dispatch subtasków → aggregation → validation. Fallback na single-agent jeśli brak routingu.',
  inputSchema: codingOutputSchema,
  outputSchema: codingOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codingAgent');
    if (!agent) throw new Error('codingAgent not found');

    const taskId = inputData.taskId;
    const db = await getDb();
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

    // ══════════════════════════════════════════════════════════════════════════
    // PATH A: Parallel Dispatch (Etap 8) — subtaski z routingSummary
    // ══════════════════════════════════════════════════════════════════════════
    if (artifact?.diagnosticPlan?.subtasks?.length && artifact.diagnosticPlan.routingSummary) {
      try {
        const { routeSubtasks, formatRoutingResult } = await import('../services/smart-router.js');
        const { dispatchSubtasks, formatDispatchResult } = await import('../services/parallel-dispatch.js');

        // 1. Rebuild routing result from stored subtasks
        const routingResult = routeSubtasks(artifact.diagnosticPlan.subtasks);
        console.log(formatRoutingResult(routingResult));

        // 2. Init worktree
        await generateCoding({
          agent,
          agentId: 'codingAgent',
          prompt: `Użyj coding_init_worktree z taskId="${taskId}" aby przygotować staging worktree. Odpowiedz krótko kiedy gotowe.`,
          taskId,
          phase: 'subtask',
          repoPath: AGENTIC_AGENTS_REPO,
          timeoutMs: 120_000,
        });

        // 3. PARALLEL DISPATCH — heart of Etap 8
        const dispatchResult = await dispatchSubtasks(taskId, routingResult, mastra!);
        console.log(formatDispatchResult(dispatchResult));

        // 4. Post-dispatch: store results in artifact
        await db.collection('code_task_artifacts').updateOne(
          { taskId },
          {
            $set: {
              dispatchResult: {
                groups: dispatchResult.groups.map((g) => ({
                  groupIndex: g.groupIndex,
                  subtasks: g.subtaskResults.map((sr) => ({
                    subtaskId: sr.subtaskId,
                    assignedModel: sr.assignedModel,
                    actualModel: sr.actualModel,
                    status: sr.status,
                    durationMs: sr.durationMs,
                    filesChanged: sr.filesChanged.map((f) => f.path),
                    errors: sr.errors,
                    qualityAttempt: sr.qualityCheck?.attempt,
                  })),
                  durationMs: g.durationMs,
                })),
                summary: {
                  totalSubtasks: dispatchResult.aggregated.totalSubtasks,
                  succeeded: dispatchResult.aggregated.succeeded,
                  failed: dispatchResult.aggregated.failed,
                  skipped: dispatchResult.aggregated.skipped,
                  needsHuman: dispatchResult.aggregated.needsHuman,
                  conflictingFiles: dispatchResult.aggregated.conflictingFiles,
                  totalDurationMs: dispatchResult.aggregated.totalDurationMs,
                  overallStatus: dispatchResult.overallStatus,
                },
              },
              updatedAt: new Date().toISOString(),
            },
          },
        );

        // 5. Post-dispatch verification: generate diff & run tsc
        const updatedArtifact = await db.collection('code_task_artifacts').findOne({ taskId });
        if (updatedArtifact?.worktreePath) {
          try {
            const { execSync } = await import('child_process');
            const diff = execSync('git diff HEAD', {
              cwd: updatedArtifact.worktreePath,
              encoding: 'utf-8',
              timeout: 10000,
            }).trim();
            if (diff) {
              const truncatedDiff = diff.length > 4000 ? diff.slice(0, 4000) + '\n... (skrócono)' : diff;
              await db.collection('code_task_artifacts').updateOne(
                { taskId },
                { $set: { diffSummary: truncatedDiff, status: 'waiting_approval', updatedAt: new Date().toISOString() } },
              );
            }
          } catch { /* diff optional */ }
        }

        // 6. If needs_human subtasks exist, note in artifact
        if (dispatchResult.aggregated.needsHuman > 0) {
          console.warn(
            `[execute-patch] ${dispatchResult.aggregated.needsHuman} subtask(s) need human intervention`,
          );
        }

        return {
          taskId,
          status: 'waiting_approval',
          iteration: inputData.iteration ?? 1,
        };
      } catch (dispatchErr) {
        console.error('[execute-patch] Parallel dispatch failed, falling back to single-agent:', (dispatchErr as Error).message);
        // Fall through to Path B
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PATH B: Legacy Single-Agent Mode (fallback)
    // ══════════════════════════════════════════════════════════════════════════
    let planContext = '';
    if (artifact?.diagnosticPlan) {
      const dp = artifact.diagnosticPlan as any;
      const subtaskList = (dp.subtasks || [])
        .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((s: any) => `  - [${s.id}] (${s.type}, priorytet ${s.priority}): ${s.description} → pliki: ${(s.targetFiles || []).join(', ')}`)
        .join('\n');

      planContext = [
        `## Plan diagnostyczny (przygotowany wcześniej)`,
        ``,
        `**Root cause:** ${dp.rootCause}`,
        `**Hipoteza:** ${dp.hypothesis}`,
        `**Ryzyko:** ${dp.riskLevel} — ${dp.riskJustification}`,
        ``,
        `**Analiza wpływu:**`,
        `- Plik błędu: ${dp.impactAnalysis?.errorFile || 'N/A'}`,
        `- Pliki bezpośrednie: ${(dp.impactAnalysis?.directFiles || []).join(', ') || 'brak'}`,
        `- Pliki zależne: ${(dp.impactAnalysis?.dependentFiles || []).join(', ') || 'brak'}`,
        `- Testy: ${(dp.impactAnalysis?.testFiles || []).join(', ') || 'brak'}`,
        ``,
        `**Subtaski (realizuj w kolejności priorytetów):**`,
        subtaskList || '  (brak subtasków)',
        ``,
        `**Weryfikacja po naprawie:**`,
        `- Komendy: ${(dp.verificationPlan?.commands || []).join(', ')}`,
        `- Oczekiwany wynik: ${dp.verificationPlan?.expectedOutcome || 'TSC clean'}`,
      ].join('\n');
    } else {
      planContext = `Brak planu diagnostycznego — działaj standardowo: zdiagnozuj i napraw.`;
    }

    const prompt = [
      `Realizuj plan naprawy. Masz gotową diagnozę — skup się na implementacji.`,
      ``,
      planContext,
      ``,
      `## Identyfikator zadania: ${taskId}`,
      ``,
      `Użyj pełnego cyklu Staging Worktree (\`coding_init_worktree\`).`,
      `Po zapisaniu wszystkich plików w worktree, KONIECZNIE:`,
      `1. Uruchom w worktree komendę: git diff HEAD (aby wygenerować diff zmian).`,
      `2. Zaktualizuj artefakt (\`coding_update_artifact\`) ustawiając pole diffSummary na wynik tego diffa.`,
      `3. Ustaw status artefaktu na waiting_approval.`,
      `UWAGA: nie wywołuj narzędzia apply_patch samodzielnie! Oczekujesz na codeReviewAgent.`,
    ].join('\n');

    await generateCoding({
      agent,
      agentId: 'codingAgent',
      prompt,
      taskId,
      phase: 'subtask',
      repoPath: AGENTIC_AGENTS_REPO,
      timeoutMs: 600_000,
    });

    // Backup: auto-generate diff if agent didn't
    const updatedArtifact = await db.collection('code_task_artifacts').findOne({ taskId });
    if (updatedArtifact?.worktreePath && (!updatedArtifact.diffSummary || updatedArtifact.diffSummary.trim() === '')) {
      try {
        const { execSync } = await import('child_process');
        const diff = execSync('git diff HEAD', {
          cwd: updatedArtifact.worktreePath,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        if (diff) {
          const truncatedDiff = diff.length > 4000 ? diff.slice(0, 4000) + '\n... (skrócono)' : diff;
          await db.collection('code_task_artifacts').updateOne(
            { taskId },
            { $set: { diffSummary: truncatedDiff, updatedAt: new Date().toISOString() } }
          );
        }
      } catch {
        // Ignoruj błąd — diff opcjonalny
      }
    }

    // ── Bramka pustego worktree ────────────────────────────────────────────
    // Bez niej pusty worktree jedzie dalej do review, które słusznie zwraca
    // needs_changes, wraca tu, znowu nic nie powstaje — i cykl kręci się aż do
    // limitu iteracji, paląc dwa modele na diffie, którego nie ma. Zaobserwowane
    // na żywo: agent przepalił kroki na `search_content`, reflektor go przerwał,
    // a workflow i tak podał puste worktree do recenzji.
    // Jedna próba z jawnym komunikatem, potem twarde zatrzymanie z powodem.
    if (!(await worktreeHasChanges(taskId, db))) {
      console.warn(`[repo-maintenance] ${taskId}: worktree pusty po implementacji — jedna próba ponowna.`);
      await generateCoding({
        agent,
        agentId: 'codingAgent',
        prompt: [
          `Zadanie ${taskId}: worktree jest PUSTY — żaden plik nie został zapisany.`,
          ``,
          planContext,
          ``,
          `Diagnoza jest gotowa i worktree istnieje. NIE szukaj ponownie, NIE analizuj —`,
          `zapisz zmiany w plikach TERAZ, korzystając z narzędzi zapisu w worktree.`,
          `Jeśli poprawka jest niemożliwa, napisz JEDNO zdanie dlaczego i zakończ.`,
        ].join('\n'),
        taskId,
        threadId: taskId,
        phase: 'subtask',
        repoPath: AGENTIC_AGENTS_REPO,
        timeoutMs: 600_000,
      });

      if (!(await worktreeHasChanges(taskId, db))) {
        throw new Error(
          `[repo-maintenance] ${taskId}: implementacja nie wyprodukowała żadnych zmian w worktree ` +
          `(dwie próby). Zatrzymuję cykl zamiast wysyłać puste worktree do recenzji.`,
        );
      }
    }

    return {
      taskId,
      status: 'waiting_approval',
      iteration: 1,
    };
  },
});

/**
 * Deterministic merge of a task's worktree branch into the live repo.
 *
 * Replaces delegating this to codingAgent via generateCoding("use coding_apply_patch").
 * The LLM did not reliably call the tool — under AUTOHEAL_AUTO_PROMOTE it improvised
 * `cd <worktree> && git ...` through execute_command, which is correctly approval-gated
 * (git commit/merge are not on the unattended allowlist), so the run SUSPENDED waiting
 * for a human that never comes and the merge never landed. Merging an approved diff is
 * a deterministic git operation with no judgement in it — do it directly.
 */
async function mergeWorktreeToLive(
  taskId: string,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<{ ok: boolean; commit?: string; error?: string }> {
  const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
  if (!artifact?.worktreePath || !artifact?.branchName) {
    return { ok: false, error: 'no worktree/branch for task' };
  }
  const { execFileSync } = await import('child_process');
  // Argument vector, never a command line: this runs `git merge` in the
  // repository the system itself runs from.
  const git = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 60_000 }).trim();
  /** Did the command succeed? Used where the ANSWER is the exit code. */
  const gitOk = (args: string[], cwd: string): boolean => {
    try { git(args, cwd); return true; } catch { return false; }
  };
  try {
    // Commit any pending work in the worktree (idempotent — empty commit is skipped).
    const dirty = git(['status', '--porcelain'], artifact.worktreePath);
    if (dirty) {
      git(['add', '-A'], artifact.worktreePath);
      git(['commit', '-m', `agent(patch): ${taskId}`], artifact.worktreePath);
    }
    // Merge the task branch into the live checkout.
    git(['merge', '--no-ff', '--no-edit', String(artifact.branchName)], AGENTIC_AGENTS_REPO);
    const commit = git(['rev-parse', 'HEAD'], AGENTIC_AGENTS_REPO);
    return { ok: true, commit };
  } catch (err) {
    const msg = (err as Error).message;
    // Was a merge left half-done? Asked of git's state, not of its prose.
    //
    // This used to be `/conflict/i.test(msg)`. git is translated, and on this
    // host a conflict reads `KONFLIKT (zawartość): Konflikt scalania w f.txt` —
    // which that regex does not match, because Polish spells it with a k. The
    // consequence was not a bad error string: `git merge --abort` never ran, so
    // the LIVE repository was left mid-merge with conflict markers in it, and
    // the next build would have compiled them.
    //
    // Aborting is now driven by whether a merge is actually in progress, which
    // is also strictly safer: whatever went wrong, the live checkout must not be
    // left half-merged.
    const mergeInProgress = gitOk(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], AGENTIC_AGENTS_REPO);
    if (mergeInProgress) {
      gitOk(['merge', '--abort'], AGENTIC_AGENTS_REPO);
      return { ok: false, error: `merge conflict (aborted, live repo left clean): ${msg.slice(0, 200)}` };
    }
    return { ok: false, error: msg.slice(0, 300) };
  }
}

/** Resolve an autoheal ticket, fail-soft — bookkeeping must never break the flow. */
async function resolveHealTicket(taskId: string): Promise<void> {
  if (!taskId.startsWith('heal-')) return;
  try {
    await getErrorCollector().resolveTicket(taskId);
    console.log(`[decision-gate] Auto-heal ticket ${taskId} resolved (fix merged to source).`);
  } catch (err) {
    console.warn(`[decision-gate] resolveTicket ${taskId} failed (non-fatal): ${(err as Error).message}`);
  }
}

/** Czy worktree zadania zawiera JAKIEKOLWIEK zmiany (staged, unstaged, nowe pliki)? */
async function worktreeHasChanges(
  taskId: string,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<boolean> {
  const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
  if (!artifact?.worktreePath) return false;
  try {
    const { execSync } = await import('child_process');
    const status = execSync('git status --porcelain', {
      cwd: artifact.worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    return status.length > 0;
  } catch {
    // Nie potrafimy sprawdzić → nie blokujemy cyklu na podstawie domysłu.
    return true;
  }
}

/**
 * Count of `[REVIEW] ...` entries already logged in the artifact's `plan`
 * array — the same marker `submitReviewTool` pushes and that
 * `review-precontext.ts` already filters on to show prior review notes.
 */
function countReviewEntries(artifact: Record<string, unknown> | null | undefined): number {
  const plan = Array.isArray(artifact?.plan) ? (artifact!.plan as unknown[]) : [];
  return plan.filter((entry) => typeof entry === 'string' && entry.startsWith('[REVIEW]')).length;
}

/**
 * Calls the review agent and returns the verdict it actually submitted THIS
 * round — never a leftover from an earlier one.
 *
 * Z38 (found live 2026-08-23, F2 canary): a review pass whose model falls
 * back to a different provider (generateWithHarness's own fallback chain)
 * can come back as prose with ZERO tool calls — `submitReviewTool` never
 * runs. Reading `artifact.reviewVerdict` straight from Mongo afterward used
 * to silently return whatever the PREVIOUS round wrote: a genuinely-fixed
 * change looked "still rejected", with no error and no trace that the
 * review never actually happened. Detected here by comparing the count of
 * `[REVIEW]` plan entries before/after the call — if it did not grow, no
 * verdict was submitted this round. Retries once with an explicit
 * instruction; if the model still never calls the tool, fails loudly
 * instead of handing back a verdict nobody gave.
 */
async function runReviewAndGetVerdict(params: {
  agent: Agent;
  taskId: string;
  threadId: string;
  reviewIteration: number;
  db: Awaited<ReturnType<typeof getDb>>;
  buildPrompt: (isRetry: boolean) => string;
  /** Injectable so check:review-verdict-freshness can prove the retry/fail
   * behaviour without a real LLM — defaults to the real gateway. */
  callReview?: typeof generateReview;
}): Promise<{ verdict: 'approve' | 'needs_changes' | 'block'; comments: string }> {
  const { agent, taskId, threadId, reviewIteration, db, buildPrompt, callReview = generateReview } = params;

  for (const isRetry of [false, true]) {
    const before = await db.collection('code_task_artifacts').findOne({ taskId });
    const beforeCount = countReviewEntries(before);

    const response = await callReview({
      agent,
      prompt: buildPrompt(isRetry),
      taskId,
      threadId,
      reviewIteration,
      repoPath: AGENTIC_AGENTS_REPO,
      // Derived, never a literal. This was a hard 180_000 — BELOW what a review
      // actually takes: the two reviewers we have data for have succeeded at
      // 315s and 324s, and codeReviewAgent has a recorded failure reading
      // "Harness LLM call timed out after 180s". Taking the number from the same
      // board card that sizes the V2 attempt window means a reviewer cannot be
      // given one budget here and a different one there.
      timeoutMs: reviewAttemptCapMs(agent.id),
    });

    const after = await db.collection('code_task_artifacts').findOne({ taskId });
    if (countReviewEntries(after) > beforeCount) {
      return {
        verdict: (after?.reviewVerdict || 'needs_changes') as 'approve' | 'needs_changes' | 'block',
        comments: response.outputPreview || 'No text response',
      };
    }

    console.warn(
      `[repo-maintenance] ${taskId}: review pass called coding_submit_review zero times` +
      (isRetry ? ' (retry also failed)' : ' — retrying once with an explicit instruction') +
      '; the verdict in Mongo would be stale, not fresh.',
    );
  }

  throw new Error(
    `[repo-maintenance] ${taskId}: code review did not run — coding_submit_review was never ` +
    'called across 2 attempts. Refusing to reuse a stale verdict from an earlier round.',
  );
}

// ── Step 2: Code Review Agent ────────────────────────────────────────────────

const executeReviewAgent = createStep({
  id: 'execute-review-agent',
  description: 'Wykonuje przegląd kodu na wygenerowanym worktree za pomocą codeReviewAgent.',
  inputSchema: codingOutputSchema,
  outputSchema: reviewOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const agent = mastra?.getAgent('codeReviewAgent');
    if (!agent) throw new Error('codeReviewAgent not found');

    const db = await getDb();

    const buildPrompt = (isRetry: boolean): string => `Zadanie ${inputData.taskId} oczekuje na twoje Code Review (iteracja: ${inputData.iteration}/${MAX_REVIEW_ITERATIONS}).

    Pasywny kontekst review zawiera artifact zadania, diff, zmienione pliki, sygnaly weryfikacji i poprzednie notatki review, jesli istnieja.

    Przeanalizuj powyższy diff pod kątem:
    - Poprawności logicznej i składniowej
    - Bezpieczeństwa (brak hardkodowanych sekretów, niebezpiecznych operacji)
    - Zgodności ze stylem projektu

    Na końcu użyj submitReviewTool i prześlij verdict (approve/needs_changes) wraz z uzasadnieniem.
    Jeśli diff wygląda poprawnie i spełnia wymagania zadania, daj approve.${isRetry ?
      '\n\n    POPRZEDNIA PRÓBA NIE WYWOŁAŁA submitReviewTool — to jest jedyna rzecz, ' +
      'która się liczy w tym zadaniu. Nie pisz samej prozy: zawołaj submitReviewTool ' +
      'z verdict i uzasadnieniem, TERAZ, jako ostatni krok.' : ''}`;

    // OWN thread, not the coding one. A thread belongs to whoever created it:
    // codingAgent runs first with threadId=taskId, so reusing that id here made
    // the review agent read messages stamped resourceId=codingAgent and its
    // input processor rejected them ("wrong resourceId") — the review step could
    // never run. Review context comes from the task artifact, not thread history.
    const { verdict: finalVerdict, comments } = await runReviewAndGetVerdict({
      agent,
      taskId: inputData.taskId,
      threadId: reviewThreadId(inputData.taskId),
      reviewIteration: inputData.iteration,
      db,
      buildPrompt,
    });

    return {
      taskId: inputData.taskId,
      verdict: finalVerdict,
      comments,
      iteration: inputData.iteration,
    };
  },
});

// ── Step 3: Decision Gate (Suspend on Approve / Loop on Needs Changes) ───────

const decisionGate = createStep({
  id: 'decision-gate',
  description: 'Bramka decyzyjna: Jeśli approve → suspend i czekaj na zatwierdzenie. Jeśli needs_changes → przygotuj dane do kolejnej iteracji.',
  inputSchema: reviewOutputSchema,
  outputSchema: z.object({
    taskId: z.string(),
    action: z.enum(['approved_and_merged', 'loop_back', 'blocked', 'max_iterations_reached']),
    message: z.string(),
  }),
  resumeSchema: z.object({
    confirmMerge: z.boolean().describe('Czy zatwierdzasz scalanie zmian do repozytorium live?'),
  }),
  suspendSchema: z.object({
    taskId: z.string(),
    verdict: z.string(),
    comments: z.string(),
    message: z.string(),
  }),
  execute: async ({ inputData, resumeData, suspend, mastra }) => {
    if (!inputData) throw new Error('Input data not found');

    const { taskId, verdict, comments, iteration } = inputData;

    // ── APPROVE → Push PR or Local Merge ──
    if (verdict === 'approve') {
      const prMode = process.env.GITHUB_PR_MODE === 'true';

      // ═══════════════════════════════════════════════════════════
      // PATH A: GitHub PR Mode (Etap 9)
      // ═══════════════════════════════════════════════════════════
      if (prMode) {
        if (!resumeData) {
          // 1. Push branch + Create PR
          try {
            const { pushBranch, createPR, waitForCI } = await import('../services/github.js');
            const { buildPRBody, buildPRTitle, buildPRLabels } = await import('../services/pr-body-builder.js');

            const db = await getDb();
            const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

            if (!artifact?.branchName) {
              throw new Error('No branch name found in artifact');
            }

            // Commit changes in worktree before push
            const agent = mastra?.getAgent('codingAgent');
            if (agent) {
              await generateCoding({
                agent,
                agentId: 'codingAgent',
                prompt: `W worktree zadania ${taskId}: wykonaj git add . && git commit -m "agent(patch): ${taskId}" jeśli są niezacommitowane zmiany. Odpowiedz krótko.`,
                taskId,
                phase: 'merge',
                repoPath: AGENTIC_AGENTS_REPO,
                timeoutMs: 60_000,
              });
            }

            // Push branch to remote
            const pushResult = await pushBranch(artifact.branchName);
            if (!pushResult.success) {
              throw new Error(`Push failed: ${pushResult.message}`);
            }

            // Build PR content
            const prBody = buildPRBody({
              taskId,
              diagnosticPlan: artifact.diagnosticPlan,
              dispatchResult: artifact.dispatchResult,
              reviewVerdict: verdict,
              reviewComments: comments,
              reviewIteration: iteration,
            });
            const prTitle = buildPRTitle(taskId, artifact.diagnosticPlan);
            const prLabels = buildPRLabels({
              taskId,
              diagnosticPlan: artifact.diagnosticPlan,
              dispatchResult: artifact.dispatchResult,
            });

            // Create PR on GitHub
            const prResult = await createPR({
              branch: artifact.branchName,
              title: prTitle,
              body: prBody,
              labels: prLabels,
            });

            if (!prResult.success) {
              throw new Error(`PR creation failed: ${prResult.message}`);
            }

            // Store PR info in artifact
            await db.collection('code_task_artifacts').updateOne(
              { taskId },
              {
                $set: {
                  prNumber: prResult.prNumber,
                  prUrl: prResult.prUrl,
                  updatedAt: new Date().toISOString(),
                },
              },
            );

            // Wait for CI (non-blocking poll, max 5 min)
            const ciStatus = await waitForCI(prResult.prNumber, { timeoutMs: 300_000 });

            return await suspend({
              taskId,
              verdict,
              comments,
              message: `✅ PR #${prResult.prNumber} created: ${prResult.prUrl}\n` +
                `CI Status: ${ciStatus.state} (${ciStatus.checks.length} checks)\n` +
                `Oczekuję na zatwierdzenie merge (confirmMerge: true).`,
            });
          } catch (prErr) {
            console.error('[decision-gate] PR mode failed, falling back to local merge:', (prErr as Error).message);
            // Fall through to legacy below
          }
        }

        // Resume: merge PR via API
        if (resumeData?.confirmMerge) {
          try {
            const { mergePR, deleteRemoteBranch } = await import('../services/github.js');

            const db = await getDb();
            const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

            if (artifact?.prNumber) {
              // Squash merge PR
              const mergeResult = await mergePR(artifact.prNumber, 'squash');

              if (mergeResult.success) {
                // Cleanup remote branch
                if (artifact.branchName) {
                  await deleteRemoteBranch(artifact.branchName);
                }

                // Pull merged changes to local
                try {
                  const { execSync } = await import('child_process');
                  execSync('git pull origin master', {
                    cwd: AGENTIC_AGENTS_REPO,
                    encoding: 'utf-8',
                    timeout: 30_000,
                  });
                } catch { /* non-fatal */ }

                // Cleanup local worktree
                const cleanupAgent = mastra?.getAgent('codingAgent');
                if (cleanupAgent) {
                  await generateCoding({
                    agent: cleanupAgent,
                    agentId: 'codingAgent',
                    prompt: `Użyj coding_remove_worktree z taskId="${taskId}" aby posprzątać zasoby worktree.`,
                    taskId,
                    phase: 'cleanup',
                    repoPath: AGENTIC_AGENTS_REPO,
                    timeoutMs: 60_000,
                  });
                }

                return {
                  taskId,
                  action: 'approved_and_merged' as const,
                  message: `PR #${artifact.prNumber} squash-merged do master. Branch ${artifact.branchName} usunięty.`,
                };
              } else {
                return {
                  taskId,
                  action: 'blocked' as const,
                  message: `PR merge failed: ${mergeResult.message}`,
                };
              }
            }
          } catch (mergeErr) {
            console.error('[decision-gate] PR merge failed:', (mergeErr as Error).message);
          }
        }

        if (resumeData && !resumeData.confirmMerge) {
          return {
            taskId,
            action: 'blocked' as const,
            message: `Użytkownik odrzucił merge dla ${taskId}.`,
          };
        }
      }

      // ═══════════════════════════════════════════════════════════
      // PATH B: Legacy Local Merge
      // ═══════════════════════════════════════════════════════════
      // Etap 5.5: autoheal (heal-*) z AUTOHEAL_AUTO_PROMOTE=true pomija ludzką
      // bramkę — supervisor jest właścicielem promocji. Inne taski: gate jak był.
      const autoConfirm = autohealAutoConfirmMerge(taskId);
      if (!resumeData && !autoConfirm) {
        return await suspend({
          taskId,
          verdict,
          comments,
          message: `✅ Code Review APPROVED (iteracja ${iteration}). Oczekuję na zatwierdzenie scalania (confirmMerge: true) przez człowieka.`,
        });
      }
      if (autoConfirm && !resumeData) {
        console.log(`[decision-gate] AUTOHEAL_AUTO_PROMOTE — auto-confirm merge dla ${taskId} (bez ludzkiej bramki).`);
      }

      if (autoConfirm || resumeData?.confirmMerge) {
        const merged = await mergeWorktreeToLive(taskId, await getDb());
        if (!merged.ok) {
          return {
            taskId,
            action: 'blocked' as const,
            message: `Scalanie ${taskId} nie powiodło się: ${merged.error}. Wymagana uwaga człowieka.`,
          };
        }
        // Healing is done once the fix is in the source (merged). The subsequent
        // swap only rolls it onto :4111 — and under detached FULL SWAP this step
        // returns before the swap finishes, so resolve the ticket here rather than
        // leaving it to expire by TTL. Fail-soft: a bookkeeping miss must not fail
        // a merge that already landed.
        await resolveHealTicket(taskId);
        return {
          taskId,
          action: 'approved_and_merged' as const,
          message: `Zmiany zadania ${taskId} scalone do live jako ${merged.commit?.slice(0, 8)}.`,
        };
      } else {
        return {
          taskId,
          action: 'blocked' as const,
          message: `Użytkownik odrzucił merge dla ${taskId}.`,
        };
      }
    }

    // ── NEEDS_CHANGES → Loop back (jeśli nie przekroczono limitu iteracji) ──
    if (verdict === 'needs_changes') {
      if (iteration >= MAX_REVIEW_ITERATIONS) {
        return {
          taskId,
          action: 'max_iterations_reached' as const,
          message: `Osiągnięto limit ${MAX_REVIEW_ITERATIONS} iteracji. Interwencja ludzka wymagana dla zadania ${taskId}. Ostatni komentarz: ${comments}`,
        };
      }

      // Oddeleguj poprawki do codingAgenta
      const agent = mastra?.getAgent('codingAgent');
      if (!agent) throw new Error('codingAgent not found for rework');

      await generateCoding({
        agent,
        agentId: 'codingAgent',
        prompt: `Zadanie ${taskId} wymaga poprawek. Komentarz codeReviewAgent (iteracja ${iteration}):\n${comments}\nPopraw kod w worktree zgodnie z uwagami. Gdy skończysz poprawki, zaktualizuj artefakt (coding_update_artifact) i ustaw status na waiting_approval.`,
        taskId,
        phase: 'retry',
        repoPath: AGENTIC_AGENTS_REPO,
        timeoutMs: 300_000,
      });

      // Teraz ponownie uruchamiamy review
      const reviewAgent = mastra?.getAgent('codeReviewAgent');
      if (!reviewAgent) throw new Error('codeReviewAgent not found for re-review');

      const nextIteration = iteration + 1;
      const db = await getDb();

      const { verdict: newVerdict } = await runReviewAndGetVerdict({
        agent: reviewAgent,
        taskId,
        threadId: reviewThreadId(taskId),
        reviewIteration: nextIteration,
        db,
        buildPrompt: (isRetry) => `Zadanie ${taskId} zostało poprawione (iteracja ${nextIteration}/${MAX_REVIEW_ITERATIONS}). Pobierz artefakt i przeprowadź ponowne Code Review. Użyj submitReviewTool aby zaktualizować werdykt.${isRetry ?
          '\n\nPOPRZEDNIA PRÓBA NIE WYWOŁAŁA submitReviewTool — to jest jedyna rzecz, która się liczy ' +
          'w tym zadaniu. Nie pisz samej prozy: zawołaj submitReviewTool z verdict i uzasadnieniem, TERAZ, jako ostatni krok.' : ''}`,
      });

      if (newVerdict === 'approve') {
        // Po poprawkach reviewer zaakceptował — zawieszamy na zatwierdzenie
        // (Etap 5.5: autoheal z AUTOHEAL_AUTO_PROMOTE pomija ludzką bramkę).
        const autoConfirmRework = autohealAutoConfirmMerge(taskId);
        if (!resumeData && !autoConfirmRework) {
          return await suspend({
            taskId,
            verdict: 'approve',
            comments: `Po ${nextIteration} iteracjach reviewer zaakceptował zmiany.`,
            message: `✅ Code Review APPROVED po iteracji ${nextIteration}. Oczekuję na zatwierdzenie scalania.`,
          });
        }

        if (autoConfirmRework || resumeData?.confirmMerge) {
          const merged = await mergeWorktreeToLive(taskId, db);
          if (!merged.ok) {
            return {
              taskId,
              action: 'blocked' as const,
              message: `Scalanie ${taskId} (iteracja ${nextIteration}) nie powiodło się: ${merged.error}.`,
            };
          }
          await resolveHealTicket(taskId);
          return {
            taskId,
            action: 'approved_and_merged' as const,
            message: `Zmiany po iteracji ${nextIteration} scalone do live jako ${merged.commit?.slice(0, 8)}.`,
          };
        }
      }

      if (nextIteration >= MAX_REVIEW_ITERATIONS) {
        return {
          taskId,
          action: 'max_iterations_reached' as const,
          message: `Limit ${MAX_REVIEW_ITERATIONS} iteracji osiągnięty. Werdykt po ostatnim review: ${newVerdict}. Wymaga interwencji człowieka.`,
        };
      }

      return {
        taskId,
        action: 'loop_back' as const,
        message: `Iteracja ${nextIteration}: reviewer nadal widzi problemy. Kolejna runda naprawcza wymagana.`,
      };
    }

    // ── BLOCK → natychmiastowe zatrzymanie ──
    return {
      taskId,
      action: 'blocked' as const,
      message: `Reviewer zablokował zadanie ${taskId}. Komentarz: ${comments}`,
    };
  },
});

// ── Step 4: Deploy & Verify (dry-run build + health check) ───────────────────

const deployOutputSchema = z.object({
  taskId: z.string(),
  deployStatus: z.enum(['deployed_and_verified', 'deploy_failed', 'skipped', 'swapping']),
  version: z.string().optional(),
  message: z.string(),
});

const deployAndVerify = createStep({
  id: 'deploy-and-verify',
  description: 'Buduje i weryfikuje nowy kod w staging. Z DEPLOY_AUTO_SWAP=true robi pełny swap + watchdog.',
  inputSchema: z.object({
    taskId: z.string(),
    action: z.enum(['approved_and_merged', 'loop_back', 'blocked', 'max_iterations_reached']),
    message: z.string(),
  }),
  outputSchema: deployOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Input data not found');

    // Tylko jeśli decision-gate zakończył się merge'em
    if (inputData.action !== 'approved_and_merged') {
      return {
        taskId: inputData.taskId,
        deployStatus: 'skipped' as const,
        message: `Deploy pominięty — action: ${inputData.action}`,
      };
    }

    try {
      const { execSync } = await import('child_process');
      const { resolve, dirname } = await import('path');
      const { existsSync } = await import('fs');

      // The deploy scripts, deploy.config.json and the git slots all live in the
      // live repo — always AGENTIC_AGENTS_REPO, regardless of where THIS code runs
      // from. In the production build, cwd is the slot runtime dir (.deploy/runtime/
      // slot-a), which has no deploy.config.json, so the old cwd-upward search ran
      // all the way to "/" and produced scriptPath="/scripts/deploy-blue-green.sh"
      // — "No such file", and the whole auto-swap died at the last step. Anchor on
      // the repo constant; only fall back to the cwd search if it is somehow absent.
      let projectRoot = AGENTIC_AGENTS_REPO;
      if (!existsSync(resolve(projectRoot, 'deploy.config.json'))) {
        projectRoot = process.cwd();
        while (projectRoot !== '/') {
          if (existsSync(resolve(projectRoot, 'deploy.config.json'))) break;
          projectRoot = dirname(projectRoot);
        }
      }

      const scriptPath = resolve(projectRoot, 'scripts/deploy-blue-green.sh');

      // Etap 10: tryb swap (--dry-run vs pełny swap z watchdog)
      const autoSwap = process.env.DEPLOY_AUTO_SWAP === 'true';
      const mode = autoSwap ? '' : '--dry-run';
      const timeout = autoSwap ? 300_000 : 180_000;  // 5 min dla swap, 3 min dla dry-run

      console.log(`[deploy-and-verify] Mode: ${autoSwap ? 'FULL SWAP + watchdog' : 'dry-run (safe)'}`);

      // FULL SWAP is a SELF-swap: this code runs inside the Live process, and the
      // swap kills that very process to replace it. Running the deploy via a
      // blocking execSync makes the whole deploy chain a child of Live over a
      // stdout pipe — the moment promote kills Live, the next log write hits a
      // dead pipe (SIGPIPE) and the deploy dies mid-swap, before the new Live is
      // up, leaving :4111 empty. So for a real swap we DETACH the deploy: spawn it
      // in its own session (setsid), stdout to a file (not a pipe to us), and
      // fire-and-forget. The deploy then outlives Live; the autoheal supervisor
      // and mark-promoted own the outcome, and resolveTicket happens on the next
      // supervisor pass once :4111 reports the new version. dry-run stays blocking
      // (it never kills Live, so we can read its output directly).
      if (autoSwap) {
        const { spawn } = await import('child_process');
        // .deploy lives ALONGSIDE the repo (…/mastra-agentic-environment/.deploy),
        // not inside it — same place deploy-blue-green.sh uses. Writing the log to
        // projectRoot/.deploy (a dir that does not exist) made bash fail the
        // redirect and the detached deploy died instantly.
        const deployLog = resolve(dirname(projectRoot), `.deploy/logs/selfswap-${Date.now()}.log`);
        const child = spawn(
          'bash',
          ['-c', `exec setsid bash "${scriptPath}" ${mode} > "${deployLog}" 2>&1 < /dev/null`],
          { cwd: projectRoot, detached: true, stdio: 'ignore' },
        );
        child.unref();
        console.log(`[deploy-and-verify] FULL SWAP detached (pid=${child.pid}, log=${deployLog}). Live will be replaced; supervisor owns canary/mark/ticket.`);
        return {
          taskId: inputData.taskId,
          deployStatus: 'swapping' as const,
          message: `Self-swap uruchomiony w tle (detached). Nowy kod przejmie :4111; canary/mark/resolve po stronie supervisora.`,
        };
      }

      const output = execSync(`bash "${scriptPath}" ${mode}`, {
        encoding: 'utf-8',
        timeout,
        cwd: projectRoot,
      });

      // Sprawdź wynik
      const isDryRunSuccess = output.includes('DRY RUN COMPLETE');
      const isSwapSuccess = output.includes('SWAP COMPLETE') || output.includes('DEPLOY COMPLETE');
      const isHealthy = isDryRunSuccess || isSwapSuccess;

      // Wyciągnij wersję z outputu
      const versionMatch = output.match(/Version:\s+(\S+)/);
      const version = versionMatch?.[1] || 'unknown';

      // Etap 0.2: ticket auto-heal rozwiązujemy TYLKO po realnym swapie (nowy kod na :4111),
      // NIE po dry-run — dry-run nie przełącza Live, więc bug wciąż żyje w runtime.
      if (isSwapSuccess && inputData.taskId.startsWith('heal-')) {
        try {
          const collector = getErrorCollector();
          await collector.resolveTicket(inputData.taskId);
          console.log(`[deploy-and-verify] Auto-heal ticket ${inputData.taskId} resolved (real swap).`);
        } catch {
          // Nie blokuj deploy jeśli cleanup ticketa nie zadziała
        }
      } else if (isDryRunSuccess && inputData.taskId.startsWith('heal-')) {
        console.log(`[deploy-and-verify] Dry-run OK ale BEZ swap — ticket ${inputData.taskId} pozostaje otwarty (Live nadal na starym kodzie).`);
      }

      const modeLabel = autoSwap
        ? 'Swap wykonany, watchdog uruchomiony (10 min obserwacji)'
        : 'Staging zbudowany i zweryfikowany (dry-run)';

      return {
        taskId: inputData.taskId,
        deployStatus: isHealthy ? 'deployed_and_verified' as const : 'deploy_failed' as const,
        version,
        message: isHealthy
          ? `${modeLabel}. Wersja: ${version}.`
          : `Deploy ${autoSwap ? 'swap' : 'dry-run'} nie potwierdził zdrowia.`,
      };
    } catch (error: any) {
      return {
        taskId: inputData.taskId,
        deployStatus: 'deploy_failed' as const,
        message: `Deploy failed: ${error.message?.slice(0, 500)}`,
      };
    }
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────────

const repoMaintenanceWorkflow = createWorkflow({
  id: 'repo-maintenance-workflow',
  description: 'Self-healing workflow: Diagnose → Patch → Review → Decision Gate → Deploy Verify',
  inputSchema: codingTaskSchema,
  outputSchema: deployOutputSchema,
})
  .then(diagnoseAndPlan)
  .then(executePatch)
  .then(executeReviewAgent)
  .then(decisionGate)
  .then(deployAndVerify);

repoMaintenanceWorkflow.commit();

export { repoMaintenanceWorkflow };
// Exported for check:review-verdict-freshness — proves Z38's fix (a review
// pass that submits no verdict must not be read as a fresh one) without a
// real LLM call.
export { countReviewEntries, runReviewAndGetVerdict };
