import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { IsolationBackend } from '@mastra/core/workspace';
import { getDb } from '../lib/mongo.js';
import { isUnattendedSafeCommand } from './command-safety.js';
import { getResourceLockService, type AcquireLockResult } from '../services/resource-locks.js';

export const AGENTIC_AGENTS_REPO = '/projekty/mastra-agentic-environment/agentic-agents';

export class LiveRepoWriteBlockedError extends Error {
  constructor(taskId: string, reason: string) {
    super(
      `[SAFETY] Write to live repo blocked for task ${taskId}: ${reason}. ` +
      `Wywolaj coding_init_worktree najpierw — agent nie edytuje runtime na ktorym zyje.`
    );
    this.name = 'LiveRepoWriteBlockedError';
  }
}

export class FileLockCollisionError extends Error {
  constructor(filePath: string, activeHolder: string, reason: string) {
    super(
      `[LOCK_COLLISION] Plik "${filePath}" jest zablokowany do zapisu przez inne zadanie (${activeHolder}): ${reason}. Poczekaj na zwolnienie blokady.`
    );
    this.name = 'FileLockCollisionError';
  }
}

export async function getWorkspacePath(taskId: string): Promise<string> {
  const db = await getDb();
  const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
  if (artifact && typeof artifact.worktreePath === 'string') {
    return artifact.worktreePath;
  }
  return AGENTIC_AGENTS_REPO;
}

/**
 * STRICT variant for write operations — throws if no worktree exists for the task.
 * Use this for any tool that mutates files, so the agent never silently writes to live repo.
 */
export async function getWorkspacePathForWrite(taskId: string): Promise<string> {
  const db = await getDb();
  const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
  if (!artifact) {
    throw new LiveRepoWriteBlockedError(taskId, 'artifact nie istnieje (uruchom coding_create_artifact)');
  }
  if (typeof artifact.worktreePath !== 'string' || !artifact.worktreePath) {
    throw new LiveRepoWriteBlockedError(taskId, 'brak worktreePath w artifact (uruchom coding_init_worktree)');
  }
  return artifact.worktreePath;
}

/**
 * Acquire exclusive file write lock for a coding task.
 * Throws FileLockCollisionError if another task is currently writing to the file.
 */
export async function acquireWorkspaceFileWriteLock(
  taskId: string,
  filePath: string,
  agentId = 'codingAgent',
): Promise<AcquireLockResult> {
  const lockService = getResourceLockService();
  const result = await lockService.acquireLock({
    resource: `file:${filePath}`,
    holderId: `task:${taskId}`,
    mode: 'write',
    taskId,
    agentId,
    metadata: { filePath },
  });

  if (!result.acquired) {
    const holder = result.activeWriter?.taskId ?? result.activeWriter?.holderId ?? 'inne_zadanie';
    throw new FileLockCollisionError(filePath, holder, result.error ?? 'aktywny zapis');
  }

  return result;
}

/**
 * Acquire shared file read lock.
 * Non-blocking: returns warning if an active writer is working on the file.
 */
export async function acquireWorkspaceFileReadLock(
  taskId: string,
  filePath: string,
  agentId = 'codingAgent',
): Promise<AcquireLockResult> {
  const lockService = getResourceLockService();
  return await lockService.acquireLock({
    resource: `file:${filePath}`,
    holderId: `task:${taskId}`,
    mode: 'read',
    taskId,
    agentId,
    metadata: { filePath },
  });
}

/**
 * Release file lock for a coding task.
 */
export async function releaseWorkspaceFileLock(
  taskId: string,
  filePath: string,
): Promise<boolean> {
  const lockService = getResourceLockService();
  return await lockService.releaseLock(`file:${filePath}`, `task:${taskId}`);
}

const CODE_SANDBOX_ISOLATION: IsolationBackend =
  process.env.CODING_SANDBOX_ISOLATION === 'bwrap' ||
  process.env.CODING_SANDBOX_ISOLATION === 'seatbelt'
    ? process.env.CODING_SANDBOX_ISOLATION
    : 'none';

/**
 * Does this shell command need a human before it runs?
 *
 * The classification itself lives in `command-safety.ts` — one statement of it,
 * shared with the harness policy and with `coding_run_test`, after the four
 * copies of this rule had already drifted apart (see that file's table).
 */
export function requiresCodeCommandApproval(command: string): boolean {
  return !isUnattendedSafeCommand(command);
}

/**
 * Workspace tools that can SUSPEND a run waiting for a human.
 *
 * Mastra's answer to `requireApproval` is to suspend the agent
 * (`finishReason: 'suspended'`), which is exactly right in a supervised session
 * and is a hang in a background job — nobody is there to resume it. This project
 * has already paid for that once: under `AUTOHEAL_AUTO_PROMOTE` the coding agent
 * improvised `cd <worktree> && git …` through `execute_command`, the run
 * suspended, and the merge never landed (`repo-maintenance.ts` §mergeWorktreeToLive).
 *
 * Declared HERE, next to the `requireApproval` config that creates the hazard,
 * so the harness that has to withhold them in a headless run reads one list
 * rather than keeping a second copy of this file's policy.
 *
 * The remaining routes to a shell — `coding_run_test` (allowlist) and `bg_task`
 * (`requiresBackgroundApproval`) — REFUSE instead of suspending, so withholding
 * these costs the agent nothing it cannot do another way.
 */
export const APPROVAL_SUSPENDING_WORKSPACE_TOOLS: readonly string[] = [
  'execute_command',
  'write_file',
  'index_content',
];

/**
 * Pull the shell command out of whatever shape the approval gate is handed.
 *
 * Mastra calls the gate as `approvalFn({ args, requestContext, workspace })`,
 * but `args` itself is the tool payload, and a tool payload may or may not be
 * wrapped in `{ context: … }` depending on the call path. Reading only
 * `args.command` yielded `undefined` → `''`, and an empty command is not
 * read-only and not a known-safe verification, so requiresCodeCommandApproval
 * fell through to `return true`. Net effect: EVERY execute_command needed human
 * approval — a plain `cat` suspended the autoheal coding agent mid-repair, and
 * nothing logged it, because returning `true` looks identical to a genuine
 * "this command is dangerous" decision.
 *
 * Exported so a test can pin the shapes down.
 */
export function extractApprovalCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const direct = (args as { command?: unknown }).command;
  if (typeof direct === 'string') return direct;
  const context = (args as { context?: unknown }).context;
  if (context && typeof context === 'object') {
    const nested = (context as { command?: unknown }).command;
    if (typeof nested === 'string') return nested;
  }
  // Never silently fall through to "approval required" again: an unrecognised
  // payload is a contract change worth seeing in the logs.
  console.warn(
    '[code-workspace] approval gate found no command in payload; keys=',
    Object.keys(args as Record<string, unknown>).join(','),
  );
  return '';
}

export const codeWorkspace = new Workspace({
  id: 'agentic-agents-code-workspace',
  name: 'Agentic Agents Repo Workspace',

  filesystem: new LocalFilesystem({
    basePath: AGENTIC_AGENTS_REPO,
    contained: true,
    // SAFETY: live repo is READ-ONLY through workspace tool `write_file`.
    // All agent writes must go through coding_write_file_tracked → worktree.
    // Worktree writes (fs/promises.writeFile) and shell commands (git worktree/merge) bypass this.
    readOnly: true,
  }),

  sandbox: new LocalSandbox({
    workingDirectory: AGENTIC_AGENTS_REPO,
    isolation: CODE_SANDBOX_ISOLATION,
    nativeSandbox: {
      allowNetwork: false,
    },
  }),

  lsp: true,
  bm25: true,
  autoIndexPaths: [
    'src',
    'docs',
    'ideas',
    'scratch',
    'package.json',
    'tsconfig.json',
  ],
  skills: [
    'src/mastra/_skills/terminal',
  ],

  tools: {
    enabled: false,
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
      enabled: true,
      name: 'view',
    },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      enabled: true,
      name: 'write_file',
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
      enabled: true,
      name: 'find_files',
    },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
      enabled: true,
      name: 'search_content',
    },
    [WORKSPACE_TOOLS.SEARCH.SEARCH]: {
      enabled: true,
      name: 'workspace_search',
    },
    [WORKSPACE_TOOLS.SEARCH.INDEX]: {
      enabled: true,
      name: 'index_content',
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
      enabled: true,
      name: 'lsp_inspect',
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      enabled: true,
      name: 'execute_command',
      requireApproval: ({ args }) => requiresCodeCommandApproval(extractApprovalCommand(args)),
    },
  },
});
