/**
 * Is this path inside that directory — asked correctly.
 *
 * `resolved.startsWith(root)` is the obvious spelling and it is wrong, because a
 * SIBLING whose name merely begins with the root's name passes it:
 *
 *     root   = /projekty/agent-projects/app
 *     target = /projekty/agent-projects/app-evil/x.ts   → startsWith(root) === true
 *
 * Measured 2026-08-17 against `writeExternalProjectFile`, whose whole job is to
 * keep an agent's writes inside the project it was given. The deep escape
 * (`../../mastra-agentic-environment/...`) was correctly refused; the sibling one
 * was not, so the guard held against the case someone thought about and let
 * through the case nobody did.
 *
 * The correct question needs the separator (or `relative()`, which this also
 * checks). `harness-policy.ts` already asked it properly and kept the answer to
 * itself; this module is that answer, shared, so a third caller cannot invent a
 * fourth spelling.
 */
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export type ContainmentResult = {
  /** True only when `target` is `root` itself or genuinely beneath it. */
  inside: boolean;
  /** `target` relative to `root`, POSIX-normalised. `..` segments survive here. */
  relativePath: string;
};

export function checkPathInsideRoot(target: string, rootPath: string): ContainmentResult {
  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(resolvedRoot, target);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  const inside = resolvedTarget === resolvedRoot || resolvedTarget.startsWith(rootWithSep);
  const relativePath = normalize(relative(resolvedRoot, resolvedTarget)).replace(/\\/g, '/');

  return {
    inside: inside && relativePath !== '..' && !relativePath.startsWith('../'),
    relativePath,
  };
}

/** The absolute, resolved form of `target` interpreted relative to `root`. */
export function resolveInsideRoot(target: string, rootPath: string): string {
  const resolvedRoot = resolve(rootPath);
  return isAbsolute(target) ? resolve(target) : resolve(resolvedRoot, target);
}
