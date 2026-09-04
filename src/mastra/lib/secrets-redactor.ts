/**
 * Secrets Redactor (Phase F1.2)
 *
 * Sanitizes text before it enters agent event logs, prompts, or output.
 * Detects and replaces API keys, tokens, passwords, and other sensitive data.
 *
 * Patterns sourced from:
 *   - gitleaks (https://github.com/gitleaks/gitleaks)
 *   - detect-secrets (Yelp)
 *   - Custom patterns for Mastra environment
 *
 * Usage:
 *   import { redactSecrets } from './secrets-redactor.js';
 *   const safe = redactSecrets('My key is sk-ant-api03-abc123...');
 *   // => 'My key is [REDACTED:anthropic-api-key]'
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface RedactionResult {
  /** Sanitized text with secrets replaced */
  text: string;
  /** Number of secrets found and redacted */
  redactedCount: number;
  /** Categories of redacted secrets */
  redactedTypes: string[];
}

// ── Secret Patterns ──────────────────────────────────────────────────────────

interface SecretPattern {
  id: string;
  pattern: RegExp;
  replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // ── API Keys (by provider) ──
  {
    id: 'openai-api-key',
    pattern: /\bsk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}\b/g,
    replacement: '[REDACTED:openai-api-key]',
  },
  {
    id: 'openai-api-key-v2',
    pattern: /\bsk-proj-[a-zA-Z0-9_-]{40,200}\b/g,
    replacement: '[REDACTED:openai-api-key]',
  },
  {
    id: 'anthropic-api-key',
    pattern: /\bsk-ant-api03-[a-zA-Z0-9_-]{90,100}AA\b/g,
    replacement: '[REDACTED:anthropic-api-key]',
  },
  {
    id: 'anthropic-admin-key',
    pattern: /\bsk-ant-admin01-[a-zA-Z0-9_-]{90,100}AA\b/g,
    replacement: '[REDACTED:anthropic-admin-key]',
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/g,
    replacement: '[REDACTED:google-api-key]',
  },
  {
    id: 'aws-access-key',
    pattern: /\b(AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g,
    replacement: '[REDACTED:aws-access-key]',
  },
  {
    id: 'stripe-api-key',
    pattern: /\b[sr]k_(test|live)_[a-zA-Z0-9]{24,}\b/g,
    replacement: '[REDACTED:stripe-api-key]',
  },
  {
    id: 'github-token',
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g,
    replacement: '[REDACTED:github-token]',
  },
  {
    id: 'slack-token',
    pattern: /\bxox[bporas]-[a-zA-Z0-9-]{10,}\b/g,
    replacement: '[REDACTED:slack-token]',
  },
  {
    id: 'telegram-bot-token',
    pattern: /\b\d{8,10}:[a-zA-Z0-9_-]{35}\b/g,
    replacement: '[REDACTED:telegram-bot-token]',
  },
  {
    id: 'sendgrid-api-key',
    pattern: /\bSG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}\b/g,
    replacement: '[REDACTED:sendgrid-api-key]',
  },
  {
    id: 'twilio-api-key',
    pattern: /\bSK[a-f0-9]{32}\b/g,
    replacement: '[REDACTED:twilio-api-key]',
  },
  {
    id: 'firebase-key',
    pattern: /\bAIza[a-zA-Z0-9_\\-]{35}\b/g,
    replacement: '[REDACTED:firebase-key]',
  },
  {
    id: 'openrouter-key',
    pattern: /\bsk-or-v1-[a-zA-Z0-9]{64}\b/g,
    replacement: '[REDACTED:openrouter-key]',
  },

  // ── Generic patterns ──
  {
    id: 'bearer-token',
    pattern: /\bBearer\s+[a-zA-Z0-9_.=+-]{20,}\b/g,
    replacement: 'Bearer [REDACTED:bearer-token]',
  },
  {
    id: 'basic-auth',
    pattern: /\bBasic\s+[a-zA-Z0-9+/=]{20,}\b/g,
    replacement: 'Basic [REDACTED:basic-auth]',
  },
  {
    id: 'env-var-assignment',
    pattern: /(?<=^|\n|\s)((?:API_KEY|SECRET_KEY|PASSWORD|TOKEN|PRIVATE_KEY|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|DATABASE_URL|MONGO(?:DB)?_URI|REDIS_URL)[=:])\s*[^\s\n]{8,}/gi,
    replacement: '$1[REDACTED:env-value]',
  },
  {
    id: 'connection-string-password',
    pattern: /(:\/\/[^:]+:)([^@\s]{6,})(@)/g,
    replacement: '$1[REDACTED:password]$3',
  },
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key-block]',
  },
  {
    id: 'jwt-token',
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    replacement: '[REDACTED:jwt-token]',
  },
  {
    id: 'hex-secret-32',
    pattern: /(?<=(?:secret|key|token|password|passwd|pwd)\s*[:=]\s*['"]?)[a-f0-9]{32,64}(?=['"]?\s)/gi,
    replacement: '[REDACTED:hex-secret]',
  },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Redact all detected secrets from a text string.
 * Returns sanitized text and metadata about what was redacted.
 */
export function redactSecrets(text: string): RedactionResult {
  if (!text) return { text: '', redactedCount: 0, redactedTypes: [] };

  let result = text;
  const foundTypes: Set<string> = new Set();
  let totalRedacted = 0;

  for (const sp of SECRET_PATTERNS) {
    // Reset regex lastIndex for global patterns
    sp.pattern.lastIndex = 0;

    const matches = result.match(sp.pattern);
    if (matches && matches.length > 0) {
      totalRedacted += matches.length;
      foundTypes.add(sp.id);
      result = result.replace(sp.pattern, sp.replacement);
    }
  }

  return {
    text: result,
    redactedCount: totalRedacted,
    redactedTypes: [...foundTypes],
  };
}

/**
 * Quick check if text contains any potential secrets.
 * Faster than full redaction when you just need a boolean.
 */
export function containsSecrets(text: string): boolean {
  if (!text) return false;

  for (const sp of SECRET_PATTERNS) {
    sp.pattern.lastIndex = 0;
    if (sp.pattern.test(text)) return true;
  }
  return false;
}

/**
 * Redact environment variables from process.env that might leak into prompts.
 * Returns a safe subset of env vars.
 */
export function getSafeEnvSnapshot(): Record<string, string> {
  const SAFE_KEYS = [
    'NODE_ENV', 'PORT', 'HOST', 'TZ', 'LANG', 'SHELL',
    'HOME', 'USER', 'PWD', 'PATH',
    'GPU_SYSTEM_RESERVED_MB', 'MODEL_VRAM_BUDGET_MB',
    'MASTRA_ENV', 'SANDBOX_PATH',
  ];

  const snapshot: Record<string, string> = {};
  for (const key of SAFE_KEYS) {
    if (process.env[key]) {
      snapshot[key] = process.env[key]!;
    }
  }
  return snapshot;
}

/**
 * Get pattern statistics for diagnostics.
 */
export function getPatternStats(): { totalPatterns: number; categories: string[] } {
  const categories = [...new Set(SECRET_PATTERNS.map((p) => p.id.split('-')[0]))];
  return {
    totalPatterns: SECRET_PATTERNS.length,
    categories,
  };
}
