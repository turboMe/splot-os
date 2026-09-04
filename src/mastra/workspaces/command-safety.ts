/**
 * What a coding agent may run in a shell — ONE classification, four consumers.
 *
 * There were four copies of this, and they had already diverged:
 *
 * | command                | workspace gate | harness policy | run_test (bg) | run_test (fg) |
 * |------------------------|----------------|----------------|---------------|---------------|
 * | `npm run build`        | suspend        | allowed        | allowed       | allowed       |
 * | `npx vitest`/`jest`    | suspend        | allowed        | allowed       | allowed       |
 * | `node --check`         | suspend        | allowed        | allowed       | allowed       |
 * | `npm run check:all`    | suspend        | unknown → deny | **allowed**   | **missing**   |
 *
 * So an agent told by its own prompt to verify a change before merging got four
 * different answers depending on which channel it asked through, and the one
 * that mattered most — the project's own gate, `npm run check:all`, which the
 * capability BUILD path treats as mandatory — was permitted in exactly one of
 * them. The `run_test` pair is the clearest evidence that copies rot: the two
 * lists sit 40 lines apart in the same file and one had grown an entry the other
 * had not.
 *
 * The classes below are the union of what those four already permitted, which is
 * a widening only for the workspace gate — and there the previous answer was to
 * SUSPEND the run, which in a background job is a hang. Nothing mutating moved:
 * git writes, package installs, network fetches and destructive commands are
 * classified exactly as they were.
 */

export type CommandClass =
  | 'read_only'
  | 'safe_verification'
  | 'network'
  | 'package_install'
  | 'git_mutation'
  | 'destructive'
  | 'unknown';

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

const READ_ONLY = [
  /^pwd$/,
  /^ls(\s|$)/,
  /^find\s/,
  /^rg(\s|$)/,
  /^grep(\s|$)/,
  /^sed\s+-n\s/,
  /^cat\s/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^wc(\s|$)/,
  /^git\s+status(\s|$)/,
  /^git\s+diff(\s|$)/,
  /^git\s+log(\s|$)/,
  /^git\s+show(\s|$)/,
  // Plain `git branch` lists; the deleting forms are classified as mutations
  // below and those are tested FIRST, so this cannot let `git branch -D` past.
  /^git\s+branch(\s|$)/,
  /^git\s+worktree\s+list(\s|$)/,
];

const SAFE_VERIFICATION = [
  /^npx\s+tsc\s+--noEmit$/,
  /^npx\s+vitest(\s|$)/,
  /^npx\s+jest(\s|$)/,
  /^npx\s+eslint(\s|$)/,
  /^npm\s+test(\s|$)/,
  /^npm\s+run\s+test(\s|$)/,
  /^npm\s+run\s+lint(\s|$)/,
  /^npm\s+run\s+build(\s|$)/,
  /^npm\s+run\s+typecheck(\s|$)/,
  // The project's own quality gate. E7-BUILD treats a green `check:all` inside
  // the worktree as the precondition for merging, so an agent that cannot run it
  // cannot satisfy the standard it is judged by — the verification step would be
  // theatre. It only reads and reports; the writes it performs are into a
  // throwaway replica set it also removes.
  /^npm\s+run\s+check(:[\w:-]+)?(\s|$)/,
  /^pnpm\s+test(\s|$)/,
  /^pnpm\s+lint(\s|$)/,
  /^node\s+--check(\s|$)/,
];

const PACKAGE_INSTALL = [
  /^npm\s+install\b/,
  /^npm\s+update\b/,
  /^npm\s+add\b/,
  /^pnpm\s+install\b/,
  /^pnpm\s+add\b/,
  /^pnpm\s+update\b/,
  /^yarn\s+add\b/,
  /^yarn\s+install\b/,
  /^yarn\s+upgrade\b/,
];

const NETWORK = [
  /^curl\b/,
  /^wget\b/,
  /^git\s+fetch\b/,
  /^git\s+pull\b/,
  /^docker\s+pull\b/,
  /^docker\s+compose\s+pull\b/,
  // Any other `npx` downloads a package before running it. The verification
  // binaries are excluded because they are already matched above and this list
  // is consulted after them.
  /^npx\s+/,
  /\bfetch\s*\(/,
];

const GIT_MUTATION = [
  /^git\s+merge\b/,
  /^git\s+push\b/,
  /^git\s+branch\s+-D\b/,
  /^git\s+branch\s+--delete\b/,
  /^git\s+worktree\s+remove\b/,
  /^git\s+worktree\s+add\b/,
  /^git\s+commit\b/,
  /^git\s+add\b/,
  /^git\s+rebase\b/,
  /^git\s+cherry-pick\b/,
];

const DESTRUCTIVE = [
  /\brm\s+-rf\b/,
  /^rm\s/,
  /^sudo\b/,
  /^su\b/,
  /^chmod\s+-R\b/,
  /^chown\s+-R\b/,
  /^git\s+reset\b/,
  /^git\s+clean\b/,
  /^git\s+checkout\s+--\b/,
  /^git\s+push\s+--force\b/,
  /^docker\s+system\s+prune\b/,
  /^mongo\b.*--eval\b.*drop/i,
  /\bdropDatabase\s*\(/i,
];

/**
 * ORDER IS THE CONTRACT.
 *
 * Destructive first, so `git reset` cannot be read as a read-only `git`. Then
 * mutations, installs and network — the things with consequences — and only then
 * the two permissive classes. An empty or unrecognised command falls through to
 * `unknown`, which every consumer treats as "needs a human", so a new binary is
 * denied by default rather than allowed by omission.
 */
export function classifyCommand(rawCommand: string): CommandClass {
  const command = normalizeCommand(rawCommand);
  if (!command) return 'unknown';
  if (DESTRUCTIVE.some((p) => p.test(command))) return 'destructive';
  if (GIT_MUTATION.some((p) => p.test(command))) return 'git_mutation';
  if (PACKAGE_INSTALL.some((p) => p.test(command))) return 'package_install';
  if (SAFE_VERIFICATION.some((p) => p.test(command))) return 'safe_verification';
  if (NETWORK.some((p) => p.test(command))) return 'network';
  if (READ_ONLY.some((p) => p.test(command))) return 'read_only';
  return 'unknown';
}

/** The two classes an unattended run may execute on its own. */
export function isUnattendedSafeCommand(command: string): boolean {
  const klass = classifyCommand(command);
  return klass === 'read_only' || klass === 'safe_verification';
}
