/**
 * AuthorClaw Sandbox Guard
 * Constrains all file operations to the workspace directory
 */

import { resolve, relative, sep } from 'path';

export class SandboxGuard {
  private workspaceRoot: string;
  private forbiddenPatterns = [
    /\.\.\//, /\.\.\\/, // path traversal
    /\/etc\//, /\/proc\//, /\/sys\//, // system dirs
    /~\/\.ssh/, /~\/\.gnupg/, // sensitive dirs
    /\.env$/, /\.vault/, // sensitive files
    /node_modules/, // dependency dirs
  ];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  /**
   * Validate that a path is within the workspace
   */
  validatePath(targetPath: string): { valid: boolean; reason?: string; resolved?: string } {
    const resolved = resolve(this.workspaceRoot, targetPath);

    // Check it's within the workspace. Compare resolved paths directly using
    // the platform separator — this correctly catches all traversal including
    // symlinks and trailing-slash edge cases. The old compound check was a
    // tautology that collapsed to `rel.startsWith('..')`, missing some cases.
    const rootWithSep = this.workspaceRoot.endsWith(sep)
      ? this.workspaceRoot
      : this.workspaceRoot + sep;
    if (resolved !== this.workspaceRoot && !resolved.startsWith(rootWithSep)) {
      return { valid: false, reason: 'Path escapes workspace boundary' };
    }

    // Also reject any path with literal '..' segments in the untrusted input
    // (handles cases where resolve() might normalize them away on some platforms).
    const rel = relative(this.workspaceRoot, resolved);
    if (rel.split(sep).some(seg => seg === '..')) {
      return { valid: false, reason: 'Path contains traversal segments' };
    }

    // Check forbidden patterns
    for (const pattern of this.forbiddenPatterns) {
      if (pattern.test(targetPath) || pattern.test(resolved)) {
        return { valid: false, reason: `Path matches forbidden pattern: ${pattern}` };
      }
    }

    return { valid: true, resolved };
  }

  /**
   * Sanitize a filename
   */
  sanitizeFilename(name: string): string {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.{2,}/g, '_')
      .substring(0, 255);
  }
}
