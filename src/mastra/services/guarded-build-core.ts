/**
 * Guarded Build Core — Uniwersalny, bezpieczny silnik procesowy dla operacji budowania.
 *
 * Wyciągnięty z capability-build.ts, zapewnia:
 * 1. Wykonywanie poleceń w dedykowanej grupie procesów (detached bash) z bezpiecznym zabijaniem drzewa (SIGTERM -> SIGKILL).
 * 2. Tworzenie i czyszczenie izolowanych worktree gita.
 * 3. Deterministyczne bramki jakościowe (tsc --noEmit, check:all).
 * 4. Bezpieczne scalanie gałęzi z automatycznym 'git merge --abort' w przypadku konfliktów.
 */

import { spawn } from 'child_process';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

export interface CommandOutcome {
  ok: boolean;
  output: string;
}

export interface MergeOutcome {
  ok: boolean;
  commit?: string;
  conflict?: boolean;
  error?: string;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
export const PROCESS_GROUP_GRACE_MS = 5_000;

/**
 * Bezpiecznie cytuje argumenty w bashu.
 */
export function shellQuote(str: string): string {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * Uruchamia polecenie w JEGO WŁASNEJ grupie procesów.
 *
 * Zapobiega pozostawaniu procesów-widm (np. tsx, node, runnerów testów) po timeoutach.
 */
export async function runCommandInProcessGroup(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number; graceMs?: number } = {},
): Promise<CommandOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const graceMs = opts.graceMs ?? PROCESS_GROUP_GRACE_MS;

  return new Promise<CommandOutcome>((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 16 * 1024 * 1024;

    child.stdout?.on('data', (c) => {
      if (stdout.length < cap) stdout += String(c);
    });
    child.stderr?.on('data', (c) => {
      if (stderr.length < cap) stderr += String(c);
    });

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* proces już zakończony */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), graceMs).unref?.();
    }, timeoutMs);
    timer.unref?.();

    const finish = (ok: boolean, extra = ''): void => {
      clearTimeout(timer);
      resolve({ ok, output: `${stdout}\n${stderr}\n${extra}`.trim() });
    };

    child.on('error', (err) => finish(false, err.message));
    child.on('close', (code) =>
      finish(
        !timedOut && code === 0,
        timedOut ? `command timed out after ${timeoutMs / 1000}s; process group signalled` : '',
      ),
    );
  });
}

/**
 * Bezpieczne scalenie gałęzi w głównym repozytorium.
 */
export async function mergeGuardedBranch(
  branch: string,
  targetBranch?: string,
  repo: string = AGENTIC_AGENTS_REPO,
): Promise<MergeOutcome> {
  if (targetBranch) {
    const checkout = await runCommandInProcessGroup(`git checkout ${shellQuote(targetBranch)}`, repo);
    if (!checkout.ok) return { ok: false, error: checkout.output };
  }

  const merge = await runCommandInProcessGroup(`git merge --no-ff --no-edit ${shellQuote(branch)}`, repo);
  if (!merge.ok) {
    const halfMerged = await runCommandInProcessGroup('git rev-parse --verify --quiet MERGE_HEAD', repo);
    const conflict = halfMerged.ok;
    if (conflict) await runCommandInProcessGroup('git merge --abort', repo);
    return { ok: false, conflict, error: merge.output };
  }

  const head = await runCommandInProcessGroup('git rev-parse HEAD', repo);
  return { ok: true, commit: head.ok ? head.output.trim() : undefined };
}

/**
 * Wykonuje sekwencję bramek jakościowych w zadanym katalogu roboczym.
 */
export async function runQualityGates(
  cwd: string,
  gates: { name: string; command: string }[],
): Promise<{ ok: boolean; failedGate?: string; output?: string }> {
  for (const gate of gates) {
    const res = await runCommandInProcessGroup(gate.command, cwd);
    if (!res.ok) {
      return { ok: false, failedGate: gate.name, output: res.output };
    }
  }
  return { ok: true };
}
