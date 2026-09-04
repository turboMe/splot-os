/**
 * Autoheal State File (Etap 1) — krytyczny stan runtime POZA Mongo i POZA procesem Mastry.
 *
 * Zasada nadrzędna (ideas/autoheal-update.md): rollback i utrzymanie dostępności
 * runtime NIGDY nie mogą zależeć od Mongo, LLM ani endpointów Mastry.
 * Dlatego prawda o aktywnym slocie/PID/porcie/stable commicie żyje w pliku JSON,
 * który supervisor (Etap 3) czyta i zapisuje niezależnie od działania Mastry.
 *
 * Plik: <project-root>/.deploy/autoheal-state.json
 *   (project-root = katalog NAD `agentic-agents`, tam gdzie `.deploy/`)
 *
 * Zapis jest ATOMOWY (tmp + rename), żeby supervisor nigdy nie odczytał
 * połowicznie zapisanego stanu w trakcie crashu.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

// ── Ścieżka pliku stanu ──────────────────────────────────────────────────────

/** `.deploy` leży w katalogu NAD repo source (project root). ENV pozwala nadpisać. */
export function getStatePath(): string {
  if (process.env.AUTOHEAL_STATE_FILE) {
    return process.env.AUTOHEAL_STATE_FILE;
  }
  const deployDir = process.env.AUTOHEAL_RUNTIME_DIR
    ? resolve(process.env.AUTOHEAL_RUNTIME_DIR, '..')
    : resolve(AGENTIC_AGENTS_REPO, '..', '.deploy');
  return resolve(deployDir, 'autoheal-state.json');
}

// ── Model stanu ──────────────────────────────────────────────────────────────

export interface AutohealState {
  /** Commit, z którego działa aktualny healthy runtime. */
  stableCommit: string;
  /** Aktywny slot runtime obsługujący :4111. */
  activeSlot: 'slot-a' | 'slot-b' | 'default' | string;
  /** PID aktywnego procesu Mastry. */
  activePid: number | null;
  /** Port aktywnego runtime. */
  activePort: number;
  /** ISO data ostatniej udanej promocji (po canary). */
  lastPromotedAt: string | null;
  /**
   * Faza cyklu autoheal.
   * Etap 5: promoting/canary/rolled_back. Etap 6: invariant_violation.
   * Etap 7: retrying (pętla ponawiania) / failed_needs_human (limit prób wyczerpany).
   */
  state?:
    | 'stable'
    | 'promoting'
    | 'canary'
    | 'rolled_back'
    | 'invariant_violation'
    | 'retrying'
    | 'failed_needs_human';
  /** Numer bieżącej próby w pętli ponawiania (Etap 7), 1-based. */
  attemptCount?: number;
  /** Identyfikator ostatniej zarejestrowanej próby (Etap 7). */
  lastAttemptId?: string;
  /** Powód ostatniej awarii — do triage przez człowieka (Etap 7). */
  failureReason?: string;
  /** Commit budowanego/przełączanego candidate (jeśli trwa promocja). */
  candidateCommit?: string;
  /** Slot poprzedni (do rollbacku). */
  previousSlot?: string;
  /** PID poprzedniego procesu (do rollbacku). */
  previousPid?: number | null;
  /** Deadline okna rollbacku (ISO). */
  rollbackDeadline?: string | null;
  /** ISO ostatniej aktualizacji pliku. */
  updatedAt: string;
}

/** Domyślny stan, gdy plik jeszcze nie istnieje (pierwsze uruchomienie). */
export function defaultState(): AutohealState {
  return {
    stableCommit: 'unknown',
    activeSlot: process.env.DEPLOY_SLOT || 'default',
    activePid: process.pid,
    activePort: Number(process.env.PORT ?? 4111),
    lastPromotedAt: null,
    state: 'stable',
    updatedAt: new Date().toISOString(),
  };
}

// ── Read / Write atomowy ─────────────────────────────────────────────────────

/** Odczyt stanu. Zwraca null gdy plik nie istnieje lub jest uszkodzony. */
export function readState(): AutohealState | null {
  const path = getStatePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AutohealState;
  } catch {
    return null;
  }
}

/** Atomowy zapis stanu (tmp + rename). Tworzy katalog `.deploy` gdy brak. */
export function writeState(state: AutohealState): void {
  const path = getStatePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, payload, 'utf-8');
  renameSync(tmp, path);
}

/** Read-modify-write z domyślnym stanem, gdy pliku jeszcze nie ma. */
export function patchState(patch: Partial<AutohealState>): AutohealState {
  const current = readState() ?? defaultState();
  const next: AutohealState = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeState(next);
  return next;
}
