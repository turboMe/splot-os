/**
 * Terminal Safety Guard (Phase F1.1)
 *
 * Intercepts shell commands before execution and classifies them as:
 *   BLOCK   → command is destructive, never execute
 *   CONFIRM → command is risky, require human/agent approval
 *   ALLOW   → command is safe, execute normally
 *
 * Inspired by:
 *   - dcg (Destructive Command Guard) — 3-tier pipeline
 *   - sh-guard — AST-based command parser
 *   - AgentGuard — rule-based .env/.ssh protection
 *
 * Usage:
 *   import { checkCommand, CommandVerdict } from './terminal-safety-guard.js';
 *   const verdict = checkCommand('rm -rf /');
 *   if (verdict.action === 'BLOCK') throw new Error(verdict.reason);
 */

import { logAgentEvent } from './agent-event-log.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type SafetyAction = 'BLOCK' | 'CONFIRM' | 'ALLOW';

export interface CommandVerdict {
  action: SafetyAction;
  /** Human-readable explanation */
  reason: string;
  /** Which rule matched (for diagnostics) */
  ruleId?: string;
  /** Original command */
  command: string;
}

// ── Rule Definitions ─────────────────────────────────────────────────────────

interface SafetyRule {
  id: string;
  /** Regex pattern to match against the command */
  pattern: RegExp;
  /** Action to take when matched */
  action: SafetyAction;
  /** Human-readable description of why this is dangerous */
  reason: string;
  /** Category for grouping (filesystem, database, network, system, crypto) */
  category: string;
}

// ── BLOCK Rules — Never execute these ────────────────────────────────────────

const BLOCK_RULES: SafetyRule[] = [
  // ── Filesystem destruction ──
  {
    id: 'fs-rm-rf-root',
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+(-[a-zA-Z]*r[a-zA-Z]*)?|(-[a-zA-Z]*r[a-zA-Z]*\s+)?-[a-zA-Z]*f[a-zA-Z]*)\s+\/(?:\s|$)/,
    action: 'BLOCK',
    reason: 'Recursive forced deletion from root filesystem (rm -rf /)',
    category: 'filesystem',
  },
  {
    id: 'fs-rm-rf-home',
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?~\//,
    action: 'BLOCK',
    reason: 'Recursive deletion of home directory',
    category: 'filesystem',
  },
  {
    id: 'fs-rm-rf-star',
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\*\s*$/,
    action: 'BLOCK',
    reason: 'Recursive deletion with wildcard — extremely dangerous without path context',
    category: 'filesystem',
  },
  {
    id: 'fs-dd-device',
    pattern: /\bdd\s+.*\bof=\/dev\/(?:sd[a-z]|nvme|vd[a-z]|hd[a-z]|mmcblk)/,
    action: 'BLOCK',
    reason: 'Direct disk write (dd) to block device — can destroy partitions',
    category: 'filesystem',
  },
  {
    id: 'fs-mkfs',
    pattern: /\bmkfs\b/,
    action: 'BLOCK',
    reason: 'Filesystem formatting command — destroys all data on target device',
    category: 'filesystem',
  },
  {
    id: 'fs-shred',
    pattern: /\bshred\b.*\//,
    action: 'BLOCK',
    reason: 'Secure file shredding — irreversible data destruction',
    category: 'filesystem',
  },

  // ── System-level destruction ──
  {
    id: 'sys-fork-bomb',
    pattern: /:\(\)\{.*\|.*\};:/,
    action: 'BLOCK',
    reason: 'Fork bomb — will crash the system',
    category: 'system',
  },
  {
    id: 'sys-shutdown',
    pattern: /\b(shutdown|poweroff|reboot|init\s+[06])\b/,
    action: 'BLOCK',
    reason: 'System shutdown/reboot command',
    category: 'system',
  },
  {
    id: 'sys-kill-all',
    pattern: /\bkillall\s+-9\s+/,
    action: 'BLOCK',
    reason: 'Force-kill all processes by name — can crash system services',
    category: 'system',
  },
  {
    id: 'sys-kill-pid1',
    pattern: /\bkill\s+(-9\s+)?1\b/,
    action: 'BLOCK',
    reason: 'Killing PID 1 (init/systemd) — will crash system',
    category: 'system',
  },

  // ── Permission escalation ──
  {
    id: 'perm-chmod-777',
    pattern: /\bchmod\s+(-R\s+)?777\s+\//,
    action: 'BLOCK',
    reason: 'Setting world-writable permissions on system directories',
    category: 'filesystem',
  },
  {
    id: 'perm-chown-root',
    pattern: /\bchown\s+(-R\s+)?root:?\s+\//,
    action: 'BLOCK',
    reason: 'Recursive ownership change on system directories',
    category: 'filesystem',
  },

  // ── Database destruction ──
  {
    id: 'db-drop-database',
    pattern: /\bDROP\s+(DATABASE|SCHEMA)\b/i,
    action: 'BLOCK',
    reason: 'DROP DATABASE — irreversible database deletion',
    category: 'database',
  },
  {
    id: 'db-drop-table-star',
    pattern: /\bDROP\s+TABLE\b/i,
    action: 'BLOCK',
    reason: 'DROP TABLE — irreversible table deletion',
    category: 'database',
  },
  {
    id: 'db-truncate',
    pattern: /\bTRUNCATE\s+TABLE\b/i,
    action: 'BLOCK',
    reason: 'TRUNCATE TABLE — deletes all rows without logging',
    category: 'database',
  },
  {
    id: 'db-mongo-dropdb',
    pattern: /\bdb\.dropDatabase\(\)/,
    action: 'BLOCK',
    reason: 'MongoDB dropDatabase — irreversible database deletion',
    category: 'database',
  },
  {
    id: 'db-mongo-drop-collection',
    pattern: /\.drop\(\)\s*$/m,
    action: 'BLOCK',
    reason: 'MongoDB drop collection — irreversible data deletion',
    category: 'database',
  },

  // ── Network exfiltration ──
  {
    id: 'net-curl-pipe-bash',
    pattern: /\bcurl\b.*\|\s*(bash|sh|zsh|source)\b/,
    action: 'BLOCK',
    reason: 'Piping remote content to shell — common malware vector',
    category: 'network',
  },
  {
    id: 'net-wget-pipe-bash',
    pattern: /\bwget\b.*\|\s*(bash|sh|zsh|source)\b/,
    action: 'BLOCK',
    reason: 'Piping remote content to shell — common malware vector',
    category: 'network',
  },
  {
    id: 'net-exfil-env',
    pattern: /\bcurl\b.*\$\(?.*\benv\b/,
    action: 'BLOCK',
    reason: 'Potential environment variable exfiltration via curl',
    category: 'network',
  },

  // ── Sensitive file access ──
  {
    id: 'file-ssh-key',
    pattern: /\b(cat|less|head|tail|cp|mv|rm)\s+.*\.ssh\/(id_rsa|id_ed25519|id_ecdsa|authorized_keys)/,
    action: 'BLOCK',
    reason: 'Direct access to SSH private keys',
    category: 'crypto',
  },
  {
    id: 'file-env-exfil',
    pattern: /\b(cat|curl|wget|nc)\b.*\.env\b/,
    action: 'BLOCK',
    reason: 'Reading or transmitting .env files — secrets exposure risk',
    category: 'crypto',
  },
];

// ── CONFIRM Rules — Require approval ─────────────────────────────────────────

const CONFIRM_RULES: SafetyRule[] = [
  {
    id: 'confirm-rm-recursive',
    pattern: /\brm\s+-[a-zA-Z]*r/,
    action: 'CONFIRM',
    reason: 'Recursive file deletion — verify target directory is safe',
    category: 'filesystem',
  },
  {
    id: 'confirm-sudo',
    pattern: /\bsudo\b/,
    action: 'CONFIRM',
    reason: 'Elevated privileges requested — verify command is necessary',
    category: 'system',
  },
  {
    id: 'confirm-systemctl',
    pattern: /\bsystemctl\s+(stop|restart|disable|mask)\b/,
    action: 'CONFIRM',
    reason: 'System service modification — may affect running services',
    category: 'system',
  },
  {
    id: 'confirm-docker-rm',
    pattern: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
    action: 'CONFIRM',
    reason: 'Docker resource deletion — may affect running containers',
    category: 'system',
  },
  {
    id: 'confirm-npm-global',
    pattern: /\bnpm\s+install\s+-g\b/,
    action: 'CONFIRM',
    reason: 'Global npm install — modifies system-wide packages',
    category: 'system',
  },
  {
    id: 'confirm-chmod',
    pattern: /\bchmod\s+(-R\s+)?[0-7]{3,4}\b/,
    action: 'CONFIRM',
    reason: 'Permission change — verify target and permissions are appropriate',
    category: 'filesystem',
  },
  {
    id: 'confirm-git-force',
    pattern: /\bgit\s+(push\s+(-[a-zA-Z]*f|--force)|reset\s+--hard|clean\s+-[a-zA-Z]*f)\b/,
    action: 'CONFIRM',
    reason: 'Destructive git operation — may lose commits or untracked files',
    category: 'filesystem',
  },
  {
    id: 'confirm-delete-many',
    pattern: /\bdeleteMany\s*\(\s*\{\s*\}\s*\)/,
    action: 'CONFIRM',
    reason: 'MongoDB deleteMany with empty filter — deletes ALL documents',
    category: 'database',
  },
  {
    id: 'confirm-update-many-no-filter',
    pattern: /\bupdateMany\s*\(\s*\{\s*\}\s*,/,
    action: 'CONFIRM',
    reason: 'MongoDB updateMany with empty filter — updates ALL documents',
    category: 'database',
  },
  {
    id: 'confirm-curl-post',
    pattern: /\bcurl\b.*(-X\s*POST|--data|--data-raw|-d\s)/,
    action: 'CONFIRM',
    reason: 'HTTP POST request — verify target URL and data being sent',
    category: 'network',
  },
  {
    id: 'confirm-iptables',
    pattern: /\biptables\b/,
    action: 'CONFIRM',
    reason: 'Firewall rule modification — may lock out network access',
    category: 'network',
  },
  {
    id: 'confirm-crontab',
    pattern: /\bcrontab\s+(-e|-r)\b/,
    action: 'CONFIRM',
    reason: 'Cron job modification — may affect scheduled tasks',
    category: 'system',
  },
];

// ── Workspace Allowlist ──────────────────────────────────────────────────────

/** Paths where destructive operations are more tolerable (within workspace) */
const WORKSPACE_SAFE_PATHS = [
  '/projekty/',
  '/tmp/sandbox',
  '/tmp/mastra',
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.mastra/',
  'coverage/',
];

// ── Main Check Function ──────────────────────────────────────────────────────

/**
 * Check a shell command against safety rules.
 * Returns a verdict indicating whether to BLOCK, CONFIRM, or ALLOW.
 */
export function checkCommand(command: string): CommandVerdict {
  const normalized = command.trim();

  // Empty commands are safe
  if (!normalized) {
    return { action: 'ALLOW', reason: 'Empty command', command };
  }

  // ── Phase 1: Check BLOCK rules (instant rejection) ──
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(normalized)) {
      // Check if the command targets a workspace-safe path
      // (e.g., rm -rf node_modules/ is OK, rm -rf / is not)
      if (isWorkspaceSafe(normalized, rule)) {
        continue; // Skip this block rule — target is within workspace
      }

      return {
        action: 'BLOCK',
        reason: `🚫 BLOCKED: ${rule.reason}`,
        ruleId: rule.id,
        command,
      };
    }
  }

  // ── Phase 2: Check CONFIRM rules (require approval) ──
  for (const rule of CONFIRM_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        action: 'CONFIRM',
        reason: `⚠️ CONFIRM: ${rule.reason}`,
        ruleId: rule.id,
        command,
      };
    }
  }

  // ── Phase 3: ALLOW ──
  return {
    action: 'ALLOW',
    reason: 'Command passed all safety checks',
    command,
  };
}

/**
 * Check if a potentially destructive command targets a workspace-safe path.
 * For example, `rm -rf node_modules/` is safe, `rm -rf /etc/` is not.
 */
function isWorkspaceSafe(command: string, rule: SafetyRule): boolean {
  // Only apply workspace exemption to filesystem rules
  if (rule.category !== 'filesystem') return false;

  // Extract path arguments from the command
  const parts = command.split(/\s+/);
  const pathArgs = parts.filter(
    (p) => p.startsWith('/') || p.startsWith('./') || p.startsWith('../') || !p.startsWith('-'),
  );

  // Check if ALL path arguments are within safe workspace paths
  const hasUnsafePaths = pathArgs.some((arg) => {
    if (arg.startsWith('-')) return false; // Skip flags
    if (arg === '/' || arg === '~' || arg === '~/' || arg === '*') return true; // Always unsafe

    return !WORKSPACE_SAFE_PATHS.some((safe) => arg.includes(safe));
  });

  // If we can't determine the path, treat as unsafe
  if (pathArgs.filter((p) => !p.startsWith('-')).length <= 1) return false; // Only command name, no paths

  return !hasUnsafePaths;
}

/**
 * Log a safety event for audit trail.
 */
export async function logSafetyEvent(verdict: CommandVerdict, agentId: string): Promise<void> {
  if (verdict.action === 'ALLOW') return; // Don't log safe commands

  await logAgentEvent({
    type: 'tool_error',
    agentId,
    toolId: 'shell_execute',
    status: verdict.action === 'BLOCK' ? 'error' : 'pending',
    errorMessage: verdict.reason,
    input: verdict.command.slice(0, 200),
    metadata: {
      safetyAction: verdict.action,
      ruleId: verdict.ruleId,
      category: 'terminal-safety-guard',
    },
  });
}

// ── Statistics ───────────────────────────────────────────────────────────────

/**
 * Get all rule IDs and counts (for diagnostics).
 */
export function getRuleStats(): { blockRules: number; confirmRules: number; total: number } {
  return {
    blockRules: BLOCK_RULES.length,
    confirmRules: CONFIRM_RULES.length,
    total: BLOCK_RULES.length + CONFIRM_RULES.length,
  };
}
