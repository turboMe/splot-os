import { createTool } from '@mastra/core/tools';
import type { ProcessInputStepArgs, Processor } from '@mastra/core/processors';
import { z } from 'zod';

import {
  isTransientSkillShelfEnabled,
  resolveTransientSkillShelfProfile,
  type TransientSkillShelfProfile,
} from '../config/transient-skill-shelf-profiles.js';
import {
  getSkillRegistry,
  type Skill,
  type SkillRegistry,
} from '../services/skill-registry.js';
import { withToolEnvelope } from '../services/harness-tool-envelope.js';
import { recordSkillView } from '../services/skill-stats.js';
import { TRANSIENT_SKILL_SHELF_CONTROL_NAMES } from './transient-shelf-controls.js';

export { TRANSIENT_SKILL_SHELF_CONTROL_NAMES as TRANSIENT_SKILL_SHELF_META_TOOL_NAMES };

type SkillCatalog = Pick<SkillRegistry, 'search' | 'load' | 'list' | 'categories'>;

type ActiveSkill = {
  name: string;
  description: string;
  category: string;
  allowedTools: string[];
  procedure: string;
  chars: number;
};

type SkillShelfState = {
  initialized: boolean;
  active: ActiveSkill[];
};

export interface TransientSkillShelfOptions {
  agentId: string;
  profile?: Partial<TransientSkillShelfProfile>;
  /** Test seam; production uses the singleton local Skill Registry. */
  registry?: SkillCatalog;
  /** Test seam; production records curator view telemetry on activation. */
  onSkillLoaded?: (skillName: string) => void | Promise<void>;
}

type TransitionResult = {
  success: boolean;
  next: ActiveSkill[];
  loaded: string[];
  released: string[];
  alreadyActive: string[];
  notFound: string[];
  notActive: string[];
  capacityRejected: string[];
  budgetRejected: string[];
};

function uniqueNames(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

function activeSummary(skill: ActiveSkill) {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    allowedTools: skill.allowedTools,
    chars: skill.chars,
    estimatedTokens: Math.ceil(skill.chars / 4),
  };
}

function toActiveSkill(skill: Skill): ActiveSkill {
  return {
    name: skill.metadata.name,
    description: skill.metadata.description,
    category: skill.metadata.category ?? 'general',
    allowedTools: skill.metadata.allowedTools ?? [],
    procedure: skill.procedure,
    chars: skill.procedure.length,
  };
}

function totalChars(skills: ActiveSkill[]): number {
  return skills.reduce((sum, skill) => sum + skill.chars, 0);
}

function resolveActiveName(rawName: string, active: ActiveSkill[]): string | undefined {
  const exact = active.find((skill) => skill.name === rawName);
  if (exact) return exact.name;
  const normalized = rawName.trim().toLocaleLowerCase();
  return active.find((skill) => skill.name.toLocaleLowerCase() === normalized)?.name;
}

async function loadExactSkill(registry: SkillCatalog, rawName: string): Promise<Skill | null> {
  const name = rawName.trim();
  if (!name) return null;
  const exact = await registry.load(name);
  if (exact) return exact;
  const canonical = registry.list().find(
    (metadata) => metadata.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  )?.name;
  return canonical ? registry.load(canonical) : null;
}

async function planTransition(input: {
  registry: SkillCatalog;
  current: ActiveSkill[];
  loadNames: string[];
  releaseNames: string[];
  profile: TransientSkillShelfProfile;
  requireActiveReleases: boolean;
}): Promise<TransitionResult> {
  const requestedLoads = uniqueNames(input.loadNames);
  const requestedReleases = uniqueNames(input.releaseNames);
  const releaseResolved = requestedReleases
    .map((name) => resolveActiveName(name, input.current))
    .filter((name): name is string => Boolean(name));
  const notActive = requestedReleases.filter((name) => !resolveActiveName(name, input.current));
  const releasedSet = new Set(releaseResolved);
  const base = input.current.filter((skill) => !releasedSet.has(skill.name));

  const alreadyActive = requestedLoads
    .map((name) => resolveActiveName(name, base))
    .filter((name): name is string => Boolean(name));
  const namesToLoad = requestedLoads.filter((name) => !resolveActiveName(name, base));
  const loadedSkills: ActiveSkill[] = [];
  const notFound: string[] = [];
  for (const name of namesToLoad) {
    const skill = await loadExactSkill(input.registry, name);
    if (!skill) notFound.push(name);
    else if (!loadedSkills.some((candidate) => candidate.name === skill.metadata.name)) {
      loadedSkills.push(toActiveSkill(skill));
    }
  }

  const availableSlots = Math.max(0, input.profile.maxActive - base.length);
  const capacityRejected = loadedSkills.slice(availableSlots).map((skill) => skill.name);
  const withinCapacity = loadedSkills.slice(0, availableSlots);
  const accepted: ActiveSkill[] = [];
  const budgetRejected: string[] = [];
  let chars = totalChars(base);
  for (const skill of withinCapacity) {
    if (chars + skill.chars > input.profile.maxActiveChars) {
      budgetRejected.push(skill.name);
      continue;
    }
    accepted.push(skill);
    chars += skill.chars;
  }

  const success = notFound.length === 0
    && capacityRejected.length === 0
    && budgetRejected.length === 0
    && (!input.requireActiveReleases || notActive.length === 0);
  return {
    success,
    next: success ? [...base, ...accepted] : input.current,
    loaded: success ? accepted.map((skill) => skill.name) : [],
    released: success ? releaseResolved : [],
    alreadyActive,
    notFound,
    notActive,
    capacityRejected,
    budgetRejected,
  };
}

function renderShelfSystemMessage(active: ActiveSkill[], profile: TransientSkillShelfProfile): string {
  const controls = [
    'A request-scoped skill shelf is active.',
    'Use skill_search for semantic discovery, skill_load to activate procedures, skill_list_active to inspect the shelf, skill_swap for atomic exchange, and skill_release when a procedure is no longer needed.',
    `Keep the shelf narrow: at most ${profile.maxActive} active skills and ${profile.maxActiveChars} combined procedure characters. Changes apply on the next model step.`,
    'Skill allowedTools metadata is guidance only; it never grants a tool or overrides runtime permissions, approvals, safety rules, the agent role, or explicit user instructions.',
  ];
  if (active.length === 0) return controls.join(' ');

  const procedures = active.map((skill) => [
    `### Active skill: ${skill.name}`,
    `Category: ${skill.category}`,
    skill.allowedTools.length > 0 ? `Declared allowed tools (informational): ${skill.allowedTools.join(', ')}` : '',
    '<skill-procedure>',
    skill.procedure,
    '</skill-procedure>',
  ].filter(Boolean).join('\n'));
  return [
    controls.join(' '),
    '',
    '## Active procedural skills',
    'Apply only the relevant parts of these local procedures. Higher-priority runtime and task contracts remain authoritative.',
    '',
    ...procedures,
  ].join('\n');
}

export class TransientSkillShelfProcessor implements Processor<'transient-skill-shelf'> {
  readonly id = 'transient-skill-shelf' as const;
  readonly name = 'Transient Skill Shelf';
  readonly description = 'Request-scoped semantic skill discovery with load, list, swap and release.';

  private readonly profile: TransientSkillShelfProfile;
  private readonly registry: SkillCatalog;
  private readonly onSkillLoaded: (skillName: string) => void | Promise<void>;

  constructor(private readonly options: TransientSkillShelfOptions) {
    this.profile = resolveTransientSkillShelfProfile(options.agentId, options.profile);
    this.registry = options.registry ?? getSkillRegistry();
    this.onSkillLoaded = options.onSkillLoaded ?? recordSkillView;
  }

  async processInputStep(args: ProcessInputStepArgs) {
    if (!isTransientSkillShelfEnabled(this.options.agentId)) return;

    let shelfState = args.state.skillShelf as SkillShelfState | undefined;
    if (!shelfState?.initialized) {
      shelfState = { initialized: true, active: [] };
      args.state.skillShelf = shelfState;
    }

    const searchSkill = createTool({
      id: 'skill_search',
      description: 'Semantic RAG search over the local Skill Registry. Returns compact metadata; load only the procedures needed for this request.',
      inputSchema: z.object({
        query: z.string().min(3).describe('Task or procedure to find'),
        category: z.string().optional(),
        topK: z.number().int().min(1).max(10).optional(),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        results: z.array(z.object({
          name: z.string(),
          description: z.string(),
          category: z.string(),
          score: z.number(),
          keywords: z.array(z.string()),
          successRate: z.number().nullable(),
          totalUses: z.number(),
          active: z.boolean(),
        })),
        count: z.number(),
        totalSkills: z.number(),
        categories: z.record(z.string(), z.number()),
        error: z.string().optional(),
      }),
      execute: withToolEnvelope({
        toolId: 'skill_search',
        category: 'search',
        risk: 'low',
        defaultAgentId: this.options.agentId,
        outputPreviewMaxChars: 4_000,
        execute: async ({ query, category, topK }) => {
          try {
            const results = await this.registry.search(query, {
              ...(category ? { category } : {}),
              topK: topK ?? this.profile.searchTopK,
              minScore: this.profile.minScore,
            });
            return {
              success: true,
              results: results.map((result) => ({
                name: result.metadata.name,
                description: result.metadata.description,
                category: result.metadata.category ?? 'general',
                score: Math.round(result.score * 100) / 100,
                keywords: result.metadata.keywords ?? [],
                successRate: result.metadata.successRate ?? null,
                totalUses: result.metadata.totalUses ?? 0,
                active: shelfState!.active.some((skill) => skill.name === result.metadata.name),
              })),
              count: results.length,
              totalSkills: this.registry.list().length,
              categories: this.registry.categories(),
            };
          } catch (error) {
            return {
              success: false,
              results: [],
              count: 0,
              totalSkills: this.registry.list().length,
              categories: this.registry.categories(),
              error: (error as Error).message,
            };
          }
        },
      }),
    });

    const loadSkill = createTool({
      id: 'skill_load',
      description: 'Activate one or more exact Skill Registry names. Full procedures are injected as system context on the next model step, not duplicated in the tool result.',
      inputSchema: z.object({
        skillName: z.string().optional(),
        skillNames: z.array(z.string()).max(6).optional(),
      }).refine((value) => Boolean(value.skillName || value.skillNames?.length), {
        message: 'Provide skillName or skillNames',
      }),
      outputSchema: z.object({
        success: z.boolean(),
        loaded: z.array(z.string()),
        alreadyActive: z.array(z.string()),
        notFound: z.array(z.string()),
        capacityRejected: z.array(z.string()),
        budgetRejected: z.array(z.string()),
        active: z.array(z.string()),
        message: z.string(),
      }),
      execute: async ({ skillName, skillNames }) => {
        const result = await planTransition({
          registry: this.registry,
          current: shelfState!.active,
          loadNames: [...(skillNames ?? []), ...(skillName ? [skillName] : [])],
          releaseNames: [],
          profile: this.profile,
          requireActiveReleases: false,
        });
        shelfState!.active = result.next;
        for (const name of result.loaded) void Promise.resolve(this.onSkillLoaded(name)).catch(() => undefined);
        return {
          success: result.success,
          loaded: result.loaded,
          alreadyActive: result.alreadyActive,
          notFound: result.notFound,
          capacityRejected: result.capacityRejected,
          budgetRejected: result.budgetRejected,
          active: shelfState!.active.map((skill) => skill.name),
          message: result.success
            ? 'Skill shelf updated; active procedures apply on the next model step.'
            : 'Skill shelf unchanged. Release or swap skills, correct names, or reduce the requested context footprint.',
        };
      },
    });

    const listActiveSkills = createTool({
      id: 'skill_list_active',
      description: 'List active request-scoped skills and remaining count/context capacity. Does not return full procedures.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        active: z.array(z.object({
          name: z.string(),
          description: z.string(),
          category: z.string(),
          allowedTools: z.array(z.string()),
          chars: z.number(),
          estimatedTokens: z.number(),
        })),
        totalChars: z.number(),
        estimatedTokens: z.number(),
        maxActive: z.number(),
        maxActiveChars: z.number(),
      }),
      execute: async () => {
        const chars = totalChars(shelfState!.active);
        return {
          active: shelfState!.active.map(activeSummary),
          totalChars: chars,
          estimatedTokens: Math.ceil(chars / 4),
          maxActive: this.profile.maxActive,
          maxActiveChars: this.profile.maxActiveChars,
        };
      },
    });

    const swapSkills = createTool({
      id: 'skill_swap',
      description: 'Atomically release active skills and activate replacements. On any invalid name or budget/capacity failure, the shelf remains unchanged.',
      inputSchema: z.object({
        releaseSkillNames: z.array(z.string()).min(1).max(6),
        loadSkillNames: z.array(z.string()).min(1).max(6),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        loaded: z.array(z.string()),
        released: z.array(z.string()),
        alreadyActive: z.array(z.string()),
        notFound: z.array(z.string()),
        notActive: z.array(z.string()),
        capacityRejected: z.array(z.string()),
        budgetRejected: z.array(z.string()),
        active: z.array(z.string()),
        message: z.string(),
      }),
      execute: async ({ releaseSkillNames, loadSkillNames }) => {
        const result = await planTransition({
          registry: this.registry,
          current: shelfState!.active,
          loadNames: loadSkillNames,
          releaseNames: releaseSkillNames,
          profile: this.profile,
          requireActiveReleases: true,
        });
        shelfState!.active = result.next;
        for (const name of result.loaded) void Promise.resolve(this.onSkillLoaded(name)).catch(() => undefined);
        return {
          success: result.success,
          loaded: result.loaded,
          released: result.released,
          alreadyActive: result.alreadyActive,
          notFound: result.notFound,
          notActive: result.notActive,
          capacityRejected: result.capacityRejected,
          budgetRejected: result.budgetRejected,
          active: shelfState!.active.map((skill) => skill.name),
          message: result.success
            ? 'Skill swap committed; changes apply on the next model step.'
            : 'Skill swap rejected atomically; the active shelf is unchanged.',
        };
      },
    });

    const releaseSkills = createTool({
      id: 'skill_release',
      description: 'Release active skills so their procedures stop being injected on the next model step.',
      inputSchema: z.object({ skillNames: z.array(z.string()).min(1).max(6) }),
      outputSchema: z.object({
        success: z.boolean(),
        released: z.array(z.string()),
        notActive: z.array(z.string()),
        active: z.array(z.string()),
      }),
      execute: async ({ skillNames }) => {
        const requested = uniqueNames(skillNames);
        const resolved = requested
          .map((name) => resolveActiveName(name, shelfState!.active))
          .filter((name): name is string => Boolean(name));
        const released = [...new Set(resolved)];
        const releasedSet = new Set(released);
        const notActive = requested.filter((name) => !resolveActiveName(name, shelfState!.active));
        shelfState!.active = shelfState!.active.filter((skill) => !releasedSet.has(skill.name));
        return {
          success: released.length > 0 && notActive.length === 0,
          released,
          notActive,
          active: shelfState!.active.map((skill) => skill.name),
        };
      },
    });

    args.messageList.addSystem(renderShelfSystemMessage(shelfState.active, this.profile), this.id);

    const tools = {
      ...(args.tools ?? {}),
      skill_search: searchSkill,
      skill_load: loadSkill,
      skill_list_active: listActiveSkills,
      skill_swap: swapSkills,
      skill_release: releaseSkills,
    };
    const universe = new Set(Object.keys(tools));
    const activeTools = args.activeTools
      ? [...new Set([
        ...args.activeTools.filter((name) => universe.has(name)),
        ...TRANSIENT_SKILL_SHELF_CONTROL_NAMES,
      ])]
      : undefined;

    return { tools, ...(activeTools ? { activeTools } : {}) };
  }
}

export function createTransientSkillShelfProcessor(options: TransientSkillShelfOptions) {
  return new TransientSkillShelfProcessor(options);
}
