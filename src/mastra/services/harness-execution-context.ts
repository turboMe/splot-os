import { AsyncLocalStorage } from 'async_hooks';

export type HarnessExecutionContext = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  runId?: string;
  turnId?: string;
  /** Store-owned identity used to fence parallel-subtask artifact mutations. */
  artifactLease?: SubtaskArtifactLeaseIdentity;
  /**
   * The running run's abort signal (Wave 2 signal composition, F3).
   *
   * Without this a timeout cancels the WAIT but not the WORK: `delegate-task`
   * had no way to learn that its parent had been aborted, so a cancelled or
   * timed-out parent left its child running — still burning tokens and still
   * mutating n8n/Mongo with nobody left to receive the result.
   *
   * Carried on the context rather than passed explicitly because tools execute
   * deep inside the model loop and never receive harness arguments.
   */
  abortSignal?: AbortSignal;
};

export type SubtaskArtifactLeaseIdentity = {
  taskId: string;
  subtaskId: string;
  leaseKey: string;
  ownerId: string;
  fence: number;
  leaseTtlMs?: number;
};

const harnessExecutionContext = new AsyncLocalStorage<HarnessExecutionContext>();

export async function runWithHarnessExecutionContext<T>(
  context: HarnessExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return harnessExecutionContext.run(context, fn);
}

export function getHarnessExecutionContext(): HarnessExecutionContext | undefined {
  return harnessExecutionContext.getStore();
}

/**
 * Abort signal of the run this code is executing inside of, if any.
 *
 * This is what a tool should compose into its own work so that aborting the
 * parent genuinely stops the child, instead of merely abandoning the wait.
 */
export function getCurrentRunAbortSignal(): AbortSignal | undefined {
  return harnessExecutionContext.getStore()?.abortSignal;
}
