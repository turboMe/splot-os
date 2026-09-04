import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, join, relative } from 'path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';
import { copyFile, stat, readFile, readdir, symlink } from 'fs/promises';
import { getFileActivityWarning, recordFileActivity } from '../../services/file-activity.js';
import { compactHarnessOutput } from '../../services/harness-output-compactor.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import {
  requireCodingTaskId,
  requireExistingCodingTaskId,
  resolveCodingTaskId,
  scopeOverrideNote,
} from './coding-task-scope.js';
import { resolveLiveMergePermission } from './live-merge-permission.js';
import {
  acquireRepairLane,
  getRepairLanePath,
  isAutohealTask,
  isRepairLaneEnabled,
  resolveStableCommit,
} from '../../services/autoheal-repair-lane.js';

const rawExecAsync = promisify(exec);
/**
 * No shell. Used wherever an argument carries model-written text.
 *
 * `promisify(exec)` spawns `/bin/sh -c`, so a commit message was being pasted
 * between double quotes into a command line that runs `git add .` in the
 * repository this system runs from: `commitMessage: 'x"; <anything>; #'` was a
 * command, not a message. It read as a formatting detail because the message is
 * "just a string the model wrote" — which is precisely the property that makes
 * it dangerous.
 */
const execFileAsync = promisify(execFile);

/**
 * Environment for any git call whose OUTPUT we read.
 *
 * git is localized. On this host it answers `nic do złożenia, drzewo robocze
 * czyste`, so `includes('nothing to commit')` is false for the exact condition
 * it was written to detect — and has been since the line was written. Where the
 * text must be read, it is pinned to C; where a decision can be made without
 * reading text at all, it is (see the staged-changes probe in apply_patch).
 */
const GIT_C_LOCALE = { ...process.env, LC_ALL: 'C', LANG: 'C' };

/**
 * How many commits does `branch` carry that `repo`'s HEAD does not?
 *
 * Separated from the merge body so it can be tested against a real repository.
 * A source-level assertion that the merge tool "checks first" passes just as
 * happily when the check is disabled — measured, while writing the gate for this.
 */
export async function countCommitsAhead(repoPath: string, branchName: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'git', ['rev-list', '--count', `HEAD..${branchName}`], { cwd: repoPath },
  );
  return Number.parseInt(String(stdout).trim(), 10) || 0;
}

/** Paths in a worktree that git is deliberately ignoring, so never merging. */
export async function listIgnoredPaths(worktreeDir: string, limit = 10): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git', ['status', '--porcelain', '--ignored'], { cwd: worktreeDir, env: GIT_C_LOCALE },
  ).catch(() => ({ stdout: '' }) as { stdout: string });
  return String(stdout).split('\n')
    .filter((line) => line.startsWith('!!'))
    .map((line) => line.slice(3).trim())
    .slice(0, limit);
}

/**
 * The answer for a branch with nothing on it — `undefined` when there IS
 * something, so the caller merges.
 *
 * Two failure modes, one measured and one latent, both ending in a report the
 * operator cannot act on:
 *
 *   - MEASURED (merge canary, 2026-08-17): the agent wrote its file under
 *     `scratch/`, which .gitignore covers, so nothing was staged and the tool
 *     returned `Failed to execute apply_patch. / Command failed: git commit -m
 *     ...` — true, and useless. Nothing in it says the work was written where
 *     git refuses to look, which is the one fact that explains everything.
 *   - LATENT: the swallow this code has always intended — continue past an empty
 *     commit — reports "Changes successfully merged into the main repository!
 *     Live environment updated." for a merge that moves nothing. It had never
 *     fired only because its detection read the wrong stream.
 *
 * So the ignored-path branch is not a nicety: it is the cause the canary actually
 * hit, and without naming it the agent cannot tell "I wrote nothing" from "I
 * wrote somewhere that is never merged".
 */
export function describeEmptyMerge(input: {
  commitsAhead: number;
  branchName: string;
  worktreeDir: string;
  ignoredPaths: string[];
}): string | undefined {
  if (input.commitsAhead > 0) return undefined;
  return [
    `Nothing to merge: branch ${input.branchName} carries no commits the live repository`
    + ' does not already have, so merging it would change nothing.',
    input.ignoredPaths.length > 0
      ? `The worktree DOES contain files git is ignoring (${input.ignoredPaths.join(', ')}).`
        + ' A file under an ignored path is never committed and never merged — write to a'
        + ' tracked path instead.'
      : `Check that the intended edits were written INTO the worktree (${input.worktreeDir}),`
        + ' not somewhere else.',
  ].join(' ');
}


/**
 * K18 — every git call here previously ran unbounded. A `git merge` that stops
 * for a credential prompt, or a hook that never returns, blocked the coding
 * agent forever: the process emits no step and no tool result, so under liveness
 * budgeting the run looks idle while the child is still holding the repo.
 *
 * Default the bound at the wrapper so no call site can silently omit it; callers
 * that legitimately need longer pass an explicit `timeout`.
 */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

const execAsync: typeof rawExecAsync = ((
  command: string,
  options?: Parameters<typeof rawExecAsync>[1],
) => rawExecAsync(command, {
  timeout: DEFAULT_GIT_TIMEOUT_MS,
  ...(options ?? {}),
})) as typeof rawExecAsync;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const initWorktreeTool = createTool({
  id: 'coding_init_worktree',
  description: 'Creates and prepares an isolated git worktree environment for the specified task (branch task-<taskId>). This allows testing changes without affecting the main branch.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    worktreePath: z.string().optional(),
    branchName: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    // Reads and teardown act on existing work; creation is handled by
    // CREATION: the run owns the scope here. An id the model invented would key a
    // worktree nothing else can find. The disagreement is reported back, not just
    // logged — see `scopeOverrideNote`.
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    const scopeNote = scopeOverrideNote(rawContext.taskId, context.taskId);
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return {
          success: false,
          message: `Task artifact ${context.taskId} does not exist.${scopeNote}`,
        };
      }

      if (artifact.worktreePath) {
        return {
          success: true,
          worktreePath: artifact.worktreePath,
          branchName: artifact.branchName,
          message: `Worktree already exists for this task.${scopeNote}`,
        };
      }

      // ── Phase 2: Persistent Repair Lane for autoheal ──
      // Autoheal tasks (`heal-*`) do NOT create a per-task worktree — they use a single
      // long-lived `agentic-agents-repair` (branch autoheal/repair). When the lane
      // is occupied by another active task, we fallback to a per-task worktree.
      if (isRepairLaneEnabled() && isAutohealTask(context.taskId)) {
        const stableCommit = await resolveStableCommit(context.taskId);
        const lane = await acquireRepairLane(context.taskId, stableCommit);
        if (lane.acquired && lane.path && lane.branch) {
          // Bind the artifact with the cycle (ledger scope = cycleId/attemptId, Phase 2.4)
          const cycle = await db.collection('autoheal_cycles').findOne({ ticketId: context.taskId });
          await db.collection('code_task_artifacts').updateOne(
            { taskId: context.taskId },
            {
              $set: {
                worktreePath: lane.path,
                branchName: lane.branch,
                autohealLane: true,
                cycleId: cycle?.cycleId,
                stableCommit,
                updatedAt: new Date().toISOString(),
              },
            },
          );
          return {
            success: true,
            worktreePath: lane.path,
            branchName: lane.branch,
            message: `Repair lane prepared (${lane.path}, branch ${lane.branch}, reset to ${stableCommit}). Worktree is NOT duplicated.`,
          };
        }
        console.warn(`[coding_init_worktree] Repair lane unavailable (${lane.reason}) — fallback to per-task worktree for ${context.taskId}.`);
      }

      const branchName = `task-${context.taskId}`;
      // Katalog `../agentic-agents-worktrees/<taskId>`
      const parentDir = resolve(AGENTIC_AGENTS_REPO, '..');
      const worktreePath = resolve(parentDir, 'agentic-agents-worktrees', context.taskId);

      // Dodaj worktree z wlasnym branch'em
      await execAsync(`git worktree add "${worktreePath}" -b ${branchName}`, {
        cwd: AGENTIC_AGENTS_REPO,
      });

      // Kopiowanie pliku .env jesli istnieje
      const envPath = join(AGENTIC_AGENTS_REPO, '.env');
      if (await fileExists(envPath)) {
        await copyFile(envPath, join(worktreePath, '.env'));
      }

      // node_modules jest gitignorowany, wiec `git worktree add` go NIE tworzy —
      // bez tego `npx tsc` / `npm run check:*` w worktree pada na "tsc not found"
      // i cala weryfikacja (coding_run_test, bramka E7-BUILD) jest nieuruchamialna.
      // Symlink zamiast `npm ci`: sekundy zamiast minut, jeden zestaw zaleznosci.
      const nodeModulesLink = join(worktreePath, 'node_modules');
      if (!(await fileExists(nodeModulesLink))) {
        await symlink(join(AGENTIC_AGENTS_REPO, 'node_modules'), nodeModulesLink, 'dir')
          .catch((err) => {
            console.warn('[worktree] node_modules symlink failed:', (err as Error).message);
          });
      }

      // Aktualizacja artifactu
      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        {
          $set: {
            worktreePath,
            branchName,
            updatedAt: new Date().toISOString(),
          },
        }
      );

      return {
        success: true,
        worktreePath,
        branchName,
        message: `Created git worktree in ${worktreePath} (branch: ${branchName}). Copied .env.${scopeNote}`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'Failed to create worktree.',
        error: error.message || String(error),
      };
    }
  },
});

export const removeWorktreeTool = createTool({
  id: 'coding_remove_worktree',
  description: 'Cleans up git worktree resources associated with the specified task. Deletes the physical directory and the local branch.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. Supply it only to act on an EARLIER job\'s work; anything else is overridden.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    // Reads and teardown act on existing work; creation is handled by
    // `coding_init_worktree` below, which keeps the run's scope.
    const context = { ...rawContext, taskId: requireExistingCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return { success: false, message: `Artifact ${context.taskId} does not exist.` };
      }

      // ── Phase 2: repair lane is LONG-LIVED — we never remove it ──
      // For autoheal tasks we only unbind the artifact from the lane (releasing it),
      // bez `git worktree remove` i bez `git branch -D autoheal/repair`.
      const usesRepairLane = artifact.autohealLane === true || artifact.worktreePath === getRepairLanePath();
      if (usesRepairLane) {
        await db.collection('code_task_artifacts').updateOne(
          { taskId: context.taskId },
          {
            $unset: { worktreePath: '', branchName: '' },
            $set: { status: 'done', updatedAt: new Date().toISOString() },
          },
        );
        return {
          success: true,
          message: `Repair lane released for ${context.taskId} (worktree and branch autoheal/repair preserved — long-lived).`,
        };
      }

      // Teardown is idempotent, and idempotent is decided by asking git what
      // exists — not by matching the words it used to complain.
      //
      // The removal below used to tolerate only `not registered` / `not found`.
      // git's actual answer for an already-removed worktree is
      // `'<path>' is not a working tree`, which matches neither — and on this
      // host it arrives as `nie jest drzewem roboczym`, which matches nothing at
      // all. So releasing a task whose worktree was already gone threw, and the
      // artifact stayed marked active forever.
      if (artifact.worktreePath) {
        const worktreePath = String(artifact.worktreePath);
        const { stdout: registered } = await execFileAsync(
          'git', ['worktree', 'list', '--porcelain'], { cwd: AGENTIC_AGENTS_REPO },
        ).catch(() => ({ stdout: '' }) as { stdout: string });
        // `--porcelain` is the documented stable format; the human listing is not.
        const isRegistered = String(registered).split('\n')
          .some((line) => line.startsWith('worktree ') && line.slice(9).trim() === worktreePath);
        if (isRegistered) {
          await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
            cwd: AGENTIC_AGENTS_REPO,
          });
        } else {
          // Registered nowhere: drop any stale administrative entry and move on.
          await execFileAsync('git', ['worktree', 'prune'], { cwd: AGENTIC_AGENTS_REPO })
            .catch(() => undefined);
        }
      }

      if (artifact.branchName) {
        const branchName = String(artifact.branchName);
        const branchExists = await execFileAsync(
          'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
          { cwd: AGENTIC_AGENTS_REPO },
        ).then(() => true, () => false);
        if (branchExists) {
          await execFileAsync('git', ['branch', '-D', branchName], { cwd: AGENTIC_AGENTS_REPO });
        }
      }

      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        {
          $unset: { worktreePath: '', branchName: '' },
          $set: { updatedAt: new Date().toISOString() },
        }
      );

      return {
        success: true,
        message: `Successfully removed worktree and branch associated with ${context.taskId}.`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'Failed to remove worktree.',
        error: error.message || String(error),
      };
    }
  },
});

export const applyWorktreePatchTool = createTool({
  id: 'coding_apply_patch',
  description:
    'Finalizes work in the worktree: commits it, then merges the task branch into the LIVE '
    + 'repository this system runs from. Permission is enforced, not assumed: an autoheal task '
    + 'with AUTOHEAL_AUTO_PROMOTE=true, or an `approvalToken` a human approved. Without one it '
    + 'refuses and the work stays on its branch — it is not lost.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. Supply it only to act on an EARLIER job\'s work; anything else is overridden.'),
    commitMessage: z.string().describe('Commit message content for the generated changes.').optional(),
    approvalToken: z.string().optional().describe(
      'Id of a human-approved entry in the approvals collection. Spent once — a second merge needs a new one.',
    ),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
    stdout: z.string().optional(),
    fileActivityWarnings: z.array(z.string()).optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'coding_apply_patch',
    // Operates on work that already exists — an explicit id is a continuation,
    // not an invention. See `resolveExistingCodingTaskId`.
    category: 'git',
    risk: 'high',
    // Which task's branch gets merged into the live repo is decided by the run.
    normalizeInput: (input) => ({ ...input, taskId: requireExistingCodingTaskId(input.taskId) }),
    policy: (context, metadata) => ({
      action: 'apply_patch',
      target: context.taskId,
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: metadata.agentId,
      threadId: context.threadId,
      runId: metadata.runId,
      turnId: metadata.turnId,
    }),
    execute: async (rawContext) => {
    // Reads and teardown act on existing work; creation is handled by
    // `coding_init_worktree` below, which keeps the run's scope.
    const context = { ...rawContext, taskId: requireExistingCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact || !artifact.worktreePath || !artifact.branchName) {
        return { success: false, message: `No active worktree for task ${context.taskId}.` };
      }

      const changedFiles = Array.isArray(artifact.filesChanged)
        ? artifact.filesChanged.map((entry: any) => String(entry?.path ?? '')).filter(Boolean)
        : [];
      const fileActivityWarnings = (await Promise.all(changedFiles.map((file) =>
        getFileActivityWarning({
          taskId: context.taskId,
          subtaskId: context.subtaskId,
          agentId: context.agentId,
          threadId: context.threadId,
          file,
          op: 'patch',
          summary: context.commitMessage ?? 'Apply worktree patch',
        }),
      ))).filter(Boolean);

      // 1. Commit zmian w izolowanym worktree
      const msg = context.commitMessage || `agent(patch): Apply automated task ${context.taskId}`;
      const worktreeDir = String(artifact.worktreePath);
      await execFileAsync('git', ['add', '.'], { cwd: worktreeDir });

      // Is there anything staged? Asked of git's exit code, not of its prose.
      //
      // The previous shape committed unconditionally and swallowed the failure
      // when the message contained "nothing to commit" — a string this host's git
      // never emits, because it speaks Polish. The swallow could not fire, so an
      // empty branch surfaced as "Failed to execute apply_patch." with the cause
      // nowhere in it. `git diff --cached --quiet` exits non-zero exactly when
      // something is staged, in every locale.
      const hasStagedChanges = await execFileAsync('git', ['diff', '--cached', '--quiet'], {
        cwd: worktreeDir,
      }).then(() => false, () => true);
      if (hasStagedChanges) {
        // Argument vector, not a command line — see `execFileAsync`.
        await execFileAsync('git', ['commit', '-m', msg], { cwd: worktreeDir });
      }

      // Does this branch actually carry anything the live repo does not have?
      // See `describeEmptyMerge` for what was being reported before this.
      const emptyMerge = describeEmptyMerge({
        commitsAhead: await countCommitsAhead(AGENTIC_AGENTS_REPO, String(artifact.branchName)),
        branchName: String(artifact.branchName),
        worktreeDir,
        ignoredPaths: await listIgnoredPaths(worktreeDir),
      });
      if (emptyMerge) return { success: false, message: emptyMerge };

      // Permission is spent HERE: after the branch is known to carry something,
      // before anything touches the live repository.
      //
      // It used to be spent first, to keep any git write behind the gate. But the
      // only write ahead of it is a commit on the task's own isolated branch —
      // where the work lives anyway, and which the refusal message already points
      // the agent at. Spending it first meant a no-op merge consumed a human's
      // one-time approval and returned nothing for it, and the human then had to
      // approve again for work they had already approved.
      const permission = await resolveLiveMergePermission({
        taskId: context.taskId,
        approvalToken: context.approvalToken,
        branchName: String(artifact.branchName),
        // What the RUN owns, so the flag-based grant cannot reach sideways into
        // another repair lane — see `runTaskId`.
        runTaskId: resolveCodingTaskId(),
      });
      if (!permission.allowed) {
        return {
          success: false,
          message: `Merge into the live repository refused: ${permission.reason}`,
        };
      }
      console.log(`[coding] live merge permitted for ${context.taskId} via ${permission.via}: ${permission.note}`);

      // 2. Merge na glownym repo
      let stdoutMerge = '';
      try {
        // Also argv: the branch name reaches here from a stored artifact, and a
        // stored value is still a value somebody wrote. Nothing that runs in the
        // live repository needs a shell.
        const { stdout } = await execFileAsync(
          'git', ['merge', String(artifact.branchName), '--no-edit'],
          { cwd: AGENTIC_AGENTS_REPO },
        );
        stdoutMerge = stdout;
      } catch (mergeErr: any) {
        // W razie konfliktu - rollback w glownym repo
        await execFileAsync('git', ['merge', '--abort'], { cwd: AGENTIC_AGENTS_REPO }).catch(() => {});
        return {
          success: false,
          message: 'Conflict during merge attempt into the main environment (Mastra live). The merge has been aborted.',
          error: mergeErr.message || String(mergeErr),
        };
      }

      // 3. Opcjonalnie mozna usunac worktree
      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        { $set: { status: 'done', updatedAt: new Date().toISOString() } }
      );
      await Promise.all(changedFiles.map((file) =>
        recordFileActivity({
          taskId: context.taskId,
          subtaskId: context.subtaskId,
          agentId: context.agentId,
          threadId: context.threadId,
          file,
          op: 'patch',
          summary: context.commitMessage ?? 'Applied worktree patch',
        }),
      ));

      return {
        success: true,
        message: [
          `Changes successfully merged into the main repository! Live environment updated.`,
          ...fileActivityWarnings,
        ].filter(Boolean).join('\n\n'),
        stdout: stdoutMerge,
        fileActivityWarnings: fileActivityWarnings.length > 0 ? fileActivityWarnings : undefined,
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'Failed to execute apply_patch.',
        error: error.message || String(error),
      };
    }
    },
  }),
});

// ── Worktree browsing tools (for codeReviewAgent) ──────────────────

export const listWorktreeFilesTool = createTool({
  id: 'coding_list_worktree_files',
  description: 'Lists files in the worktree for the given task. Allows the reviewer to see which files were added or modified in the isolated environment.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. Supply it only to act on an EARLIER job\'s work; anything else is overridden.'),
    directory: z.string().optional().default('.').describe('Subdirectory to list (default: root worktree).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    files: z.array(z.string()).optional(),
    worktreePath: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    // Reads and teardown act on existing work; creation is handled by
    // `coding_init_worktree` below, which keeps the run's scope.
    const context = { ...rawContext, taskId: requireExistingCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact?.worktreePath) {
        return { success: false, message: `No active worktree for task ${context.taskId}.` };
      }

      const targetDir = resolve(artifact.worktreePath, context.directory || '.');

      // Zabezpieczenie: nie pozwol wyjsc poza worktree
      if (!targetDir.startsWith(artifact.worktreePath)) {
        return { success: false, message: 'Path goes outside the worktree. Access denied.' };
      }

      const entries = await readdir(targetDir, { withFileTypes: true });
      const files = entries
        .filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

      return {
        success: true,
        files,
        worktreePath: artifact.worktreePath,
        message: `Found ${files.length} elements in ${context.directory || '.'}`,
      };
    } catch (error: any) {
      return { success: false, message: 'Failed to list files.', error: error.message };
    }
  },
});

export const readWorktreeFileTool = createTool({
  id: 'coding_read_worktree_file',
  description: 'Reads the contents of a file from the worktree of a given task. Essential for the reviewer to verify source code in the isolated environment.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. Supply it only to act on an EARLIER job\'s work; anything else is overridden.'),
    filePath: z.string().describe('Relative path to the file in the worktree, e.g. "scratch/test.js" or "src/index.ts".'),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    content: z.string().optional(),
    filePath: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'coding_read_worktree_file',
    // Operates on work that already exists — an explicit id is a continuation,
    // not an invention. See `resolveExistingCodingTaskId`.
    category: 'file',
    risk: 'low',
    normalizeInput: (input) => ({ ...input, taskId: requireExistingCodingTaskId(input.taskId) }),
    policy: (context, metadata) => ({
      action: 'read_file',
      target: context.filePath,
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: metadata.agentId,
      threadId: context.threadId,
      runId: metadata.runId,
      turnId: metadata.turnId,
    }),
    execute: async (rawContext) => {
    // Reads and teardown act on existing work; creation is handled by
    // `coding_init_worktree` below, which keeps the run's scope.
    const context = { ...rawContext, taskId: requireExistingCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact?.worktreePath) {
        return { success: false, message: `No active worktree for task ${context.taskId}.` };
      }

      const fullPath = resolve(artifact.worktreePath, context.filePath);

      // Zabezpieczenie: nie pozwol wyjsc poza worktree
      if (!fullPath.startsWith(artifact.worktreePath)) {
        return { success: false, message: 'Path goes outside the worktree. Access denied.' };
      }

      const content = await readFile(fullPath, 'utf-8');
      await recordFileActivity({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        file: context.filePath,
        op: 'read',
        summary: 'Read worktree file',
      });

      // Limit rozmiaru (200KB) zeby nie przeciazyc LLM
      if (content.length > 200_000) {
        return {
          success: true,
          content: content.slice(0, 200_000) + '\n... (file truncated to 200KB)',
          filePath: context.filePath,
          message: `File ${context.filePath} read (truncated).`,
        };
      }

      return {
        success: true,
        content,
        filePath: context.filePath,
        message: `File ${context.filePath} read successfully.`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to read file ${context.filePath}.`,
        error: error.message,
      };
    }
    },
  }),
});

export const worktreeDiffTool = createTool({
  id: 'coding_worktree_diff',
  description: 'Returns git diff from the worktree of a given task. Shows exactly what changes were introduced relative to the main branch.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. Supply it only to act on an EARLIER job\'s work; anything else is overridden.'),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    diff: z.string().optional(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'coding_worktree_diff',
    // Operates on work that already exists — an explicit id is a continuation,
    // not an invention. See `resolveExistingCodingTaskId`.
    category: 'git',
    risk: 'low',
    outputPreviewMaxChars: 4000,
    normalizeInput: (input) => ({ ...input, taskId: requireExistingCodingTaskId(input.taskId) }),
    policy: (context, metadata) => ({
      action: 'run_command',
      command: 'git diff HEAD',
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: metadata.agentId,
      threadId: context.threadId,
      runId: metadata.runId,
      turnId: metadata.turnId,
    }),
    execute: async (rawContext) => {
    // Reads and teardown act on existing work; creation is handled by
    // `coding_init_worktree` below, which keeps the run's scope.
    const context = { ...rawContext, taskId: requireExistingCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact?.worktreePath) {
        return { success: false, message: `No active worktree for task ${context.taskId}.` };
      }

      // git diff HEAD pokazuje zmiany (staged i unstaged)
      const { stdout: diff } = await execAsync('git diff HEAD', {
        cwd: artifact.worktreePath,
        maxBuffer: 1024 * 1024, // 1MB
      });

      // Jesli brak diffa, moze sa nowe pliki (untracked)
      let fullDiff = diff;
      if (!diff.trim()) {
        const { stdout: statusOutput } = await execAsync('git status --porcelain', {
          cwd: artifact.worktreePath,
        });
        if (statusOutput.trim()) {
          // Pokaz zawartosc nowych plikow
          const newFiles = statusOutput
            .split('\n')
            .filter((l) => l.startsWith('??') || l.startsWith('A '))
            .map((l) => l.replace(/^(\?\?|A\s+)\s*/, '').trim());

          const fileDiffs: string[] = [];
          for (const file of newFiles) {
            try {
              const content = await readFile(resolve(artifact.worktreePath, file), 'utf-8');
              fileDiffs.push(`--- /dev/null\n+++ b/${file}\n${content.split('\n').map((l) => `+${l}`).join('\n')}`);
            } catch {
              // skip binary files
            }
          }
          fullDiff = fileDiffs.join('\n\n');
        }
      }

      const compaction = await compactHarnessOutput({
        text: fullDiff || '(no changes)',
        kind: 'diff',
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId ?? 'codingAgent',
        threadId: context.threadId,
        runId: context.runId,
        turnId: context.turnId,
        toolId: 'coding_worktree_diff',
        previewBytes: 8000,
        metadata: {
          worktreePath: artifact.worktreePath,
        },
      });

      return {
        success: true,
        diff: compaction.preview,
        outputArtifactId: compaction.fullTextArtifactId,
        outputTruncated: compaction.truncated,
        originalBytes: compaction.originalBytes,
        previewBytes: compaction.previewBytes,
        message: fullDiff
          ? `Diff retrieved (${compaction.previewBytes} bytes preview of ${compaction.originalBytes}).`
          : 'No changes in worktree.',
      };
    } catch (error: any) {
      return { success: false, message: 'Failed to retrieve diff.', error: error.message };
    }
    },
  }),
});
