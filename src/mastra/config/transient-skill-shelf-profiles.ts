/**
 * Request-scoped Skill Shelf profiles.
 *
 * A profile controls context pressure, not authorization. The shelf can only
 * activate procedures already present in the local Skill Registry. No skill is
 * loaded eagerly.
 */
export interface TransientSkillShelfProfile {
  agentId: string;
  /** Maximum concurrently injected procedures. */
  maxActive: number;
  /** Hard combined character budget for active procedures. */
  maxActiveChars: number;
  /** Semantic search result count. */
  searchTopK: number;
  /** Minimum cosine score (keyword fallback uses its own positive threshold). */
  minScore: number;
}

const DEFAULT_PROFILE: Omit<TransientSkillShelfProfile, 'agentId'> = {
  maxActive: 2,
  maxActiveChars: 60_000,
  searchTopK: 5,
  minScore: 0.25,
};

const PROFILES: Record<string, Partial<TransientSkillShelfProfile>> = {
  'coding-agent': { maxActive: 3, maxActiveChars: 60_000, searchTopK: 6 },
  'automation-architect': { maxActive: 3, maxActiveChars: 60_000, searchTopK: 6 },
  'researcher-agent': { maxActiveChars: 60_000, searchTopK: 6 },
  'knowledge-agent': { maxActiveChars: 60_000, searchTopK: 6 },
  'n8n-mcp-engineer': { maxActiveChars: 60_000, searchTopK: 6 },
  'code-review-agent': { maxActiveChars: 40_000 },
  'security-review-agent': { maxActiveChars: 40_000 },
  'performance-review-agent': { maxActiveChars: 40_000 },
  'filmmaker-agent': { maxActiveChars: 60_000 },
  'musician-agent': { maxActiveChars: 60_000 },
  'capability-smith': { maxActiveChars: 60_000, searchTopK: 6 },
  'marketing-agent': { maxActiveChars: 60_000, searchTopK: 6 },
};

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function boundedScore(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function profileFamily(agentId: string): string {
  if (agentId.startsWith('weekly-content-')) return 'marketing-agent';
  if (agentId.startsWith('producer-hunt-')) return 'marketing-agent';
  return agentId;
}

export function resolveTransientSkillShelfProfile(
  agentId: string,
  overrides: Partial<TransientSkillShelfProfile> = {},
): TransientSkillShelfProfile {
  const configured = PROFILES[profileFamily(agentId)] ?? {};
  return {
    ...DEFAULT_PROFILE,
    ...configured,
    ...overrides,
    agentId,
    maxActive: positiveInt(process.env.INTERIM_SKILL_SHELF_MAX_ACTIVE)
      ?? overrides.maxActive
      ?? configured.maxActive
      ?? DEFAULT_PROFILE.maxActive,
    maxActiveChars: positiveInt(process.env.INTERIM_SKILL_SHELF_MAX_CHARS)
      ?? overrides.maxActiveChars
      ?? configured.maxActiveChars
      ?? DEFAULT_PROFILE.maxActiveChars,
    searchTopK: positiveInt(process.env.INTERIM_SKILL_SHELF_SEARCH_TOP_K)
      ?? overrides.searchTopK
      ?? configured.searchTopK
      ?? DEFAULT_PROFILE.searchTopK,
    minScore: boundedScore(process.env.INTERIM_SKILL_SHELF_MIN_SCORE)
      ?? overrides.minScore
      ?? configured.minScore
      ?? DEFAULT_PROFILE.minScore,
  };
}

export function isTransientSkillShelfEnabled(agentId: string): boolean {
  if (/^(false|0|no|off)$/i.test(process.env.FEATURE_INTERIM_SKILL_SHELF ?? '')) return false;
  const configured = process.env.INTERIM_SKILL_SHELF_AGENTS?.trim();
  if (!configured || configured === '*') return true;
  const allowed = new Set(configured.split(',').map((value) => value.trim()).filter(Boolean));
  return allowed.has(agentId) || allowed.has(profileFamily(agentId));
}
