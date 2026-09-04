/**
 * Autoheal Persistent Repair Lane (Etap 2) — likwidacja mnożenia worktrees.
 *
 * Problem: autoheal tworzył worktree-per-ticket (`agentic-agents-worktrees/<taskId>`,
 * branch `task-<taskId>`). Każdy retry/cykl = nowy katalog i branch → osierocone worktrees.
 *
 * Rozwiązanie: JEDEN długowieczny worktree dla całego autoheal:
 *   path:   <project-root>/agentic-agents-repair   (override: AUTOHEAL_REPAIR_WORKTREE)
 *   branch: autoheal/repair
 *
 * Lane jest tworzony raz, NIGDY nie usuwany. Na starcie cyklu jest resetowany
 * do `stableCommit` (`reset --hard` + `clean -fdx`, z zachowaniem `.env`/`node_modules`).
 *
 * Zwykły coding-agent (zadania użytkownika) NADAL używa per-task worktree —
 * tryb repair lane dotyczy WYŁĄCZNIE tasków autoheal (`heal-*`) i tylko gdy
 * flaga `AUTOHEAL_REPAIR_LANE_ENABLED=true`.
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { copyFile } from 'fs/promises';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { getDb } from '../lib/mongo.js';

const execAsync = promisify(exec);

export const REPAIR_BRANCH = 'autoheal/repair';

/** Ścieżka repair lane. Override przez ENV `AUTOHEAL_REPAIR_WORKTREE`. */
export function getRepairLanePath(): string {
  return process.env.AUTOHEAL_REPAIR_WORKTREE
    ?? resolve(AGENTIC_AGENTS_REPO, '..', 'agentic-agents-repair');
}

/** Flaga włączająca repair lane. Domyślnie OFF — autoheal działa jak dotąd (per-task worktree). */
export function isRepairLaneEnabled(): boolean {
  return process.env.AUTOHEAL_REPAIR_LANE_ENABLED === 'true';
}

/** Czy task to autoheal (ticket `heal-<sig>-<ts>` z error-collectora). */
export function isAutohealTask(taskId: string): boolean {
  return taskId.startsWith('heal-');
}

/**
 * Wyznacza commit bazowy do resetu repair lane.
 * Priorytet: stableCommit z cyklu (powiązanego ticketId == taskId) → HEAD source repo.
 */
export async function resolveStableCommit(taskId: string): Promise<string> {
  try {
    const db = await getDb();
    const cycle = await db.collection('autoheal_cycles').findOne(
      { ticketId: taskId },
      { sort: { updatedAt: -1 } },
    );
    if (cycle?.stableCommit && cycle.stableCommit !== 'unknown') {
      return cycle.stableCommit as string;
    }
  } catch {
    // ignore — fallback poniżej
  }
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: AGENTIC_AGENTS_REPO,
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  } catch {
    return 'HEAD';
  }
}

async function branchExists(branch: string): Promise<boolean> {
  try {
    await execAsync(`git show-ref --verify --quiet refs/heads/${branch}`, { cwd: AGENTIC_AGENTS_REPO });
    return true;
  } catch {
    return false;
  }
}

async function worktreeRegistered(path: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', { cwd: AGENTIC_AGENTS_REPO });
    return stdout.split('\n').some((l) => l.startsWith('worktree ') && l.slice('worktree '.length).trim() === path);
  } catch {
    return false;
  }
}

/**
 * Zapewnia istnienie repair lane i resetuje go do `stableCommit`.
 * Idempotentne: tworzy worktree/branch tylko gdy brak, w przeciwnym razie reset.
 * `.env` i `node_modules` są zachowywane (potrzebne do build/run candidate).
 */
export async function ensureRepairLane(stableCommit: string): Promise<{ path: string; branch: string }> {
  const path = getRepairLanePath();
  const hasBranch = await branchExists(REPAIR_BRANCH);
  const hasWorktree = existsSync(path) && (await worktreeRegistered(path));

  if (!hasWorktree) {
    // Posprzątaj martwy wpis admin gdyby katalog zniknął, ale wpis został.
    await execAsync('git worktree prune', { cwd: AGENTIC_AGENTS_REPO }).catch(() => {});
    if (hasBranch) {
      await execAsync(`git worktree add "${path}" ${REPAIR_BRANCH}`, { cwd: AGENTIC_AGENTS_REPO });
    } else {
      await execAsync(`git worktree add "${path}" -b ${REPAIR_BRANCH} ${stableCommit}`, { cwd: AGENTIC_AGENTS_REPO });
    }
  }

  // Reset do czystej bazy stable (start cyklu). Zachowaj .env i node_modules.
  await execAsync(`git checkout ${REPAIR_BRANCH}`, { cwd: path }).catch(() => {});
  await execAsync(`git reset --hard ${stableCommit}`, { cwd: path });
  await execAsync('git clean -fdx -e .env -e node_modules', { cwd: path });

  // Skopiuj .env ze source jeśli w lane brak (np. po pierwszym utworzeniu).
  const srcEnv = join(AGENTIC_AGENTS_REPO, '.env');
  const laneEnv = join(path, '.env');
  if (existsSync(srcEnv) && !existsSync(laneEnv)) {
    await copyFile(srcEnv, laneEnv).catch(() => {});
  }

  return { path, branch: REPAIR_BRANCH };
}

/**
 * Próbuje pozyskać repair lane dla danego taska autoheal.
 * Lane jest WSPÓŁDZIELONY — jednocześnie może go używać tylko jeden aktywny task.
 * Gdy lane jest zajęty przez inny aktywny task autoheal → zwraca `acquired:false`
 * (wołający robi wtedy fallback na per-task worktree, żeby nie zniszczyć cudzej pracy).
 */
export async function acquireRepairLane(
  taskId: string,
  stableCommit: string,
): Promise<{ acquired: boolean; path?: string; branch?: string; reason?: string }> {
  const path = getRepairLanePath();
  const db = await getDb();

  // Czy inny AKTYWNY task już trzyma lane?
  const owner = await db.collection('code_task_artifacts').findOne({
    worktreePath: path,
    taskId: { $ne: taskId },
    status: { $nin: ['done', 'failed', 'merged'] },
  });
  if (owner) {
    return { acquired: false, reason: `Repair lane zajęty przez aktywny task ${owner.taskId}` };
  }

  const lane = await ensureRepairLane(stableCommit);
  return { acquired: true, path: lane.path, branch: lane.branch };
}
