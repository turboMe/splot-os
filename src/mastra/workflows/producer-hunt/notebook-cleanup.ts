/**
 * NotebookLM cleanup z retry i audytem.
 * Plan: ideas/producer-hunt-fix-v2.md krok 7.
 *
 * Usuwa tymczasowy notebook (discovery / deep research per lead) z 3 próbami i
 * narastającym backoffem (1s, 3s, 5s). Cicho swallow'uje błędy — workflow nigdy
 * nie pada na cleanupie. Każdą próbę i wynik zapisuje do `logs` przez
 * logProducerHuntEvent.
 */
import { knowledgeDeleteNotebookTool } from '../../tools/knowledge/knowledge-tools.js';
import { logProducerHuntEvent } from './logging.js';

const RETRY_DELAYS_MS = [1_000, 3_000, 5_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type NotebookCleanupContext = {
  taskId: string;
  stepId: string;
  notebookId: string;
  title?: string;
  /** np. "discovery" lub "deep-research" — pomaga grupować eventy w logach */
  kind?: string;
};

export type NotebookCleanupResult = {
  success: boolean;
  attempts: number;
  lastError?: string;
};

export async function cleanupNotebook(
  ctx: NotebookCleanupContext,
): Promise<NotebookCleanupResult> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await knowledgeDeleteNotebookTool.execute!(
        { notebookId: ctx.notebookId },
        {} as any,
      );
      if (res && 'success' in res && res.success) {
        await logProducerHuntEvent({
          taskId: ctx.taskId,
          stepId: ctx.stepId,
          event: 'notebook_cleanup_success',
          metrics: {
            notebookId: ctx.notebookId,
            title: ctx.title,
            kind: ctx.kind,
            attempts: attempt,
          },
        });
        return { success: true, attempts: attempt };
      }
      lastError = (res as { error?: string } | null)?.error ?? 'unknown delete failure';
    } catch (err) {
      lastError = (err as Error).message;
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  await logProducerHuntEvent({
    taskId: ctx.taskId,
    stepId: ctx.stepId,
    event: 'notebook_cleanup_failed',
    level: 'warn',
    metrics: {
      notebookId: ctx.notebookId,
      title: ctx.title,
      kind: ctx.kind,
      attempts: RETRY_DELAYS_MS.length,
    },
    error: lastError,
  });

  return { success: false, attempts: RETRY_DELAYS_MS.length, lastError };
}
