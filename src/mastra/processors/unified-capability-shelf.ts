/**
 * Unified Capability Shelf Processor (Smart Capability Shelf)
 *
 * Replaces separate TransientToolShelfProcessor and TransientSkillShelfProcessor
 * with a single unified capability broker:
 *   1. Normalizes Tools and Skills into a shared ExecutionCapability model.
 *   2. Step 0 Hybrid Preselection: dynamically loads top relevant tools and skills
 *      based on hybrid semantic (Cosine) + lexical (BM25) matching on the user prompt.
 *   3. Exposes 3 unified meta-tools: capability_search, capability_load (with atomic swap & Auto-LRU),
 *      and capability_list_active.
 *   4. Maintains backward-compatible legacy aliases (search_tools, load_tool, skill_search, etc.).
 *   5. Injects active skill procedures into system prompt (<active-skill> XML blocks)
 *      without polluting tool_result message history.
 *   6. Respects Domain Pinning: narrow/creative agents retain 100% of configured tools as core.
 */

import { createTool, type Tool } from '@mastra/core/tools';
import type { ProcessInputStepArgs, Processor } from '@mastra/core/processors';
import { z } from 'zod';
import { join } from 'path';

import {
  isCapabilityShelfEnabled,
  resolveCapabilityShelfProfile,
  type CapabilityShelfProfile,
} from '../config/capability-shelf-profiles.js';
import {
  getCapabilityCatalog,
  CapabilityCatalog,
  type ExecutionCapability,
  type CapabilitySearchResult,
} from '../services/capability-catalog.js';
import {
  UNIFIED_CAPABILITY_SHELF_CONTROL_NAMES,
  TRANSIENT_SHELF_CONTROL_NAMES,
  TRANSIENT_SHELF_CONTROL_SET,
} from './transient-shelf-controls.js';

export { UNIFIED_CAPABILITY_SHELF_CONTROL_NAMES };

export const UNIFIED_CAPABILITY_SHELF_META_NAMES = [
  'capability_search',
  'capability_load',
  'capability_list_active',
] as const;

export const UNIFIED_CAPABILITY_SHELF_LEGACY_ALIASES = [
  'search_tools',
  'load_tool',
  'release_tools',
  'list_active_tools',
  'skill_search',
  'skill_load',
  'skill_list_active',
  'skill_swap',
  'skill_release',
] as const;

export interface ActiveSkillState {
  name: string;
  description: string;
  category: string;
  allowedTools: string[];
  procedure: string;
  chars: number;
}

export interface CapabilityShelfState {
  initialized: boolean;
  coreTools: string[];
  activeTools: string[];
  activeSkills: ActiveSkillState[];
  usageOrder: string[]; // LRU order of active tools
}

export interface UnifiedCapabilityShelfOptions {
  agentId: string;
  profile?: Partial<CapabilityShelfProfile>;
  catalog?: CapabilityCatalog;
  additionalTools?: Record<string, Tool<any, any>>;
  skillsDir?: string | string[];
  onCapabilityLoaded?: (name: string, type: 'tool' | 'skill') => void | Promise<void>;
}

function normalizeText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueNames(values: Iterable<string>): string[] {
  return [...new Set([...values].map((v) => v.trim()).filter(Boolean))];
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  if (typeof record.content === 'string') return record.content;
  const content = record.content;
  if (!content || typeof content !== 'object') return '';
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const value = (part as Record<string, unknown>).text;
      return typeof value === 'string' ? value : '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractInitialQuery(args: ProcessInputStepArgs): string {
  const userMessages = (args.messages || []).filter((message) => message.role === 'user');
  return userMessages.slice(-2).map(extractMessageText).filter(Boolean).join('\n').slice(-4000);
}

function renderActiveSkillsSystemMessage(skills: ActiveSkillState[], profile: CapabilityShelfProfile): string {
  if (skills.length === 0) return '';

  const skillBlocks = skills.map((skill) => {
    return `<active-skill id="${skill.name}" name="${skill.name}" category="${skill.category}">\n${skill.procedure.trim()}\n</active-skill>`;
  }).join('\n\n');

  return [
    '### ACTIVE CAPABILITY PROCEDURES (DO NOT DUPLICATE IN TOOL RESULTS)',
    'The following skill procedures are currently loaded on your capability shelf:',
    skillBlocks,
    'Follow these procedures when executing tasks within their respective domains.',
  ].join('\n\n');
}

export class UnifiedCapabilityShelfProcessor implements Processor<'unified-capability-shelf'> {
  readonly id = 'unified-capability-shelf' as const;
  readonly name = 'Unified Capability Shelf';
  readonly description = 'Unified hybrid broker for dynamic tools and skills with Auto-LRU eviction.';

  private readonly profile: CapabilityShelfProfile;
  private readonly catalog: CapabilityCatalog;
  private readonly additionalTools: Record<string, Tool<any, any>>;
  private skillsDir: string[];
  private skillsScanned = false;
  private lastScanTime = 0;
  private static readonly SCAN_INTERVAL_MS = 30_000;

  constructor(private readonly options: UnifiedCapabilityShelfOptions) {
    this.profile = resolveCapabilityShelfProfile(options.agentId, options.profile);
    this.catalog = options.catalog ?? getCapabilityCatalog();
    this.additionalTools = options.additionalTools ?? {};
    
    const defaultSkillsDirs = [
      join(process.cwd(), 'src', 'mastra', '_skills'),
      join(process.cwd(), '.agents', 'skills'),
      join(process.cwd(), '..', '.agents', 'skills'),
    ];
    this.skillsDir = options.skillsDir
      ? (Array.isArray(options.skillsDir) ? options.skillsDir : [options.skillsDir])
      : defaultSkillsDirs;
  }

  private async ensureSkillsLoaded(): Promise<void> {
    const now = Date.now();
    if (this.skillsScanned && now - this.lastScanTime < UnifiedCapabilityShelfProcessor.SCAN_INTERVAL_MS) {
      return;
    }
    try {
      await this.catalog.scanSkillsDirectory(this.skillsDir);
      this.skillsScanned = true;
      this.lastScanTime = now;
      // Asynchronously trigger background embedding generation for newly added skills
      void this.catalog.buildEmbeddingsIndex().catch(() => undefined);
    } catch {
      // Non-blocking scan error
    }
  }

  private resolveCoreToolKeys(allToolKeys: string[], configuredKeys: Set<string>): string[] {
    if (this.profile.preserveConfiguredToolsAsCore) {
      return [...configuredKeys];
    }

    const requested = new Set((this.profile.coreTools ?? []).map(normalizeText));
    const patterns = (this.profile.corePatterns ?? []).map(normalizeText).filter(Boolean);

    return allToolKeys.filter((key) => {
      const norm = normalizeText(key);
      return requested.has(norm) || patterns.some((p) => norm.includes(p));
    });
  }

  async processInputStep(args: ProcessInputStepArgs) {
    if (!isCapabilityShelfEnabled(this.options.agentId)) {
      return;
    }

    await this.ensureSkillsLoaded();

    const configuredTools = { ...(args.tools ?? {}) };
    const allTools: Record<string, unknown> = { ...this.additionalTools, ...configuredTools };
    const configuredKeys = new Set(Object.keys(configuredTools));
    const allToolKeys = Object.keys(allTools);

    // Register any newly encountered tools into the catalog
    let newToolsRegistered = false;
    for (const [key, tool] of Object.entries(allTools)) {
      if (!this.catalog.has(key)) {
        this.catalog.registerTool(key, tool as any);
        newToolsRegistered = true;
      }
    }
    if (newToolsRegistered) {
      void this.catalog.buildEmbeddingsIndex().catch(() => undefined);
    }

    // Initialize or refresh per-request state
    let state = args.state.capabilityShelf as CapabilityShelfState | undefined;

    if (!state?.initialized) {
      const coreTools = this.resolveCoreToolKeys(allToolKeys, configuredKeys);
      const query = extractInitialQuery(args);

      let initialActiveTools: string[] = [];
      let initialActiveSkills: ActiveSkillState[] = [];

      const nonCoreTools = allToolKeys.filter((k) => !coreTools.includes(k));
      const hasSkills = this.catalog.getAll().some((c) => c.type === 'skill');

      if (query.trim() && (nonCoreTools.length > 0 || hasSkills)) {
        try {
          const searchResults = await this.catalog.search(query, {
            topK: this.profile.initialTopK * 2,
            minScore: 0.2,
            lexicalOnly: true,
          });

          for (const res of searchResults) {
            if (res.capability.type === 'tool') {
              const toolKey = res.capability.id;
              if (allTools[toolKey] && !coreTools.includes(toolKey) && !initialActiveTools.includes(toolKey)) {
                initialActiveTools.push(toolKey);
              }
            } else if (res.capability.type === 'skill' && res.capability.procedure) {
              if (!initialActiveSkills.some((s) => s.name === res.capability.name)) {
                initialActiveSkills.push({
                  name: res.capability.name,
                  description: res.capability.description,
                  category: res.capability.category || 'general',
                  allowedTools: res.capability.allowedTools || [],
                  procedure: res.capability.procedure,
                  chars: res.capability.procedure.length,
                });
              }
            }
          }
        } catch {
          // Fallback to empty initial dynamic set
        }
      }

      // Check auto-dependencies for initially matched tools
      for (const t of [...initialActiveTools]) {
        const deps = this.profile.autoDependencies?.[t];
        if (deps) {
          for (const dep of deps) {
            if (allTools[dep] && !coreTools.includes(dep) && !initialActiveTools.includes(dep)) {
              initialActiveTools.push(dep);
            }
          }
        }
      }

      // Load core skills if specified in profile
      if (this.profile.coreSkills && this.profile.coreSkills.length > 0) {
        for (const skillName of this.profile.coreSkills) {
          const cap = this.catalog.get(skillName);
          if (cap && cap.type === 'skill' && cap.procedure && !initialActiveSkills.some((s) => s.name === cap.name)) {
            initialActiveSkills.unshift({
              name: cap.name,
              description: cap.description,
              category: cap.category || 'general',
              allowedTools: cap.allowedTools || [],
              procedure: cap.procedure,
              chars: cap.procedure.length,
            });
          }
        }
      }

      state = {
        initialized: true,
        coreTools,
        activeTools: initialActiveTools.slice(0, this.profile.maxActive),
        activeSkills: initialActiveSkills.slice(0, 4),
        usageOrder: [...initialActiveTools.slice(0, this.profile.maxActive)],
      };
      args.state.capabilityShelf = state;
    } else {
      // Validate active tools against universe
      const universe = new Set(allToolKeys);
      state.coreTools = state.coreTools.filter((k) => universe.has(k));
      state.activeTools = state.activeTools.filter((k) => universe.has(k)).slice(0, this.profile.maxActive);
    }

    // ── 1. Unified Meta-Tool: capability_search ──────────────────────────────────
    const capabilitySearch = createTool({
      id: 'capability_search',
      description: 'Search for specialized tools and procedural skills in the unified capability catalog. Use capability_load to activate them.',
      inputSchema: z.object({
        query: z.string().trim().min(1).describe('Search query describing the desired tool or skill in Polish or English'),
        type: z.enum(['all', 'tool', 'skill']).optional().default('all').describe('Filter results by capability type'),
        topK: z.number().int().min(1).max(10).optional().describe('Maximum number of results to return'),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        results: z.array(z.object({
          id: z.string(),
          name: z.string(),
          type: z.enum(['tool', 'skill']),
          description: z.string(),
          category: z.string(),
          score: z.number(),
          active: z.boolean(),
          isCore: z.boolean().optional(),
        })),
        count: numberSchema(),
      }),
      execute: async ({ query, type, topK }) => {
        try {
          const limit = topK ?? this.profile.searchTopK;
          const searchResults = await this.catalog.search(query, {
            type,
            topK: limit,
          });

          const results = searchResults.map((r) => {
            const isTool = r.capability.type === 'tool';
            const isActive = isTool
              ? state!.coreTools.includes(r.capability.id) || state!.activeTools.includes(r.capability.id)
              : state!.activeSkills.some((s) => s.name === r.capability.name || s.name === r.capability.id);
            const isCore = isTool && state!.coreTools.includes(r.capability.id);

            return {
              id: r.capability.id,
              name: r.capability.name,
              type: r.capability.type,
              description: r.capability.description,
              category: r.capability.category || 'general',
              score: Math.round(r.score * 100) / 100,
              active: isActive,
              isCore,
            };
          });

          return {
            success: true,
            results,
            count: results.length,
          };
        } catch (error) {
          return {
            success: false,
            results: [],
            count: 0,
          };
        }
      },
    });

    // ── 2. Unified Meta-Tool: capability_load (with Atomic Swap & Auto-LRU) ──────
    const capabilityLoad = createTool({
      id: 'capability_load',
      description: 'Activate tools or skills onto your active workspace in a single step. Supports atomic loading, releasing, and Auto-LRU rotation.',
      inputSchema: z.object({
        load: z.union([z.string(), z.array(z.string())]).optional().describe('List of tool IDs, bundle names, or skill names to load'),
        names: z.union([z.string(), z.array(z.string())]).optional().describe('Alias for load list'),
        name: z.string().optional().describe('Single tool or skill name to load'),
        capabilityId: z.string().optional().describe('Single capability ID to load'),
        release: z.union([z.string(), z.array(z.string())]).optional().describe('List of active tool IDs or skill names to release'),
        releaseNames: z.union([z.string(), z.array(z.string())]).optional().describe('Alias for release list'),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        loadedTools: z.array(z.string()),
        loadedSkills: z.array(z.string()),
        releasedTools: z.array(z.string()),
        releasedSkills: z.array(z.string()),
        activeTools: z.array(z.string()),
        activeSkills: z.array(z.string()),
        evictedTools: z.array(z.string()),
        notFound: z.array(z.string()),
        message: z.string(),
      }),
      execute: async (input) => {
        const normalizeList = (val: unknown): string[] => {
          if (!val) return [];
          if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
          if (typeof val === 'string') return [val.trim()].filter(Boolean);
          return [];
        };

        const rawLoads = uniqueNames([
          ...normalizeList(input.load),
          ...normalizeList(input.names),
          ...normalizeList(input.name),
          ...normalizeList(input.capabilityId),
        ]);
        const rawReleases = uniqueNames([
          ...normalizeList(input.release),
          ...normalizeList(input.releaseNames),
        ]);

        const notFound: string[] = [];
        const loadedTools: string[] = [];
        const loadedSkills: string[] = [];
        const releasedTools: string[] = [];
        const releasedSkills: string[] = [];
        const evictedTools: string[] = [];

        // 1. Process Releases
        if (rawReleases.length > 0) {
          for (const rel of rawReleases) {
            // Check tools
            const toolIdx = state!.activeTools.indexOf(rel);
            if (toolIdx !== -1) {
              state!.activeTools.splice(toolIdx, 1);
              releasedTools.push(rel);
              state!.usageOrder = state!.usageOrder.filter((k) => k !== rel);
            }
            // Check skills
            const skillIdx = state!.activeSkills.findIndex((s) => s.name.toLowerCase() === rel.toLowerCase());
            if (skillIdx !== -1) {
              const removed = state!.activeSkills.splice(skillIdx, 1)[0];
              if (removed) releasedSkills.push(removed.name);
            }
          }
        }

        // 2. Expand loads (including toolBundles)
        const expandedLoads: string[] = [];
        for (const req of rawLoads) {
          const bundle = this.profile.toolBundles?.[req];
          if (bundle && Array.isArray(bundle)) {
            expandedLoads.push(...bundle);
          } else {
            expandedLoads.push(req);
          }
        }

        // 3. Process Loads
        for (const req of uniqueNames(expandedLoads)) {
          // Check if it's already an active or core tool
          if (state!.coreTools.includes(req) || state!.activeTools.includes(req)) {
            // Update LRU
            state!.usageOrder = [...state!.usageOrder.filter((k) => k !== req), req];
            continue;
          }

          // Check if it's a known tool
          if (allTools[req]) {
            // Check Auto-Dependencies
            const deps = this.profile.autoDependencies?.[req] || [];
            const toolsToActivate = [req, ...deps.filter((d) => allTools[d])];

            for (const toolName of toolsToActivate) {
              if (state!.coreTools.includes(toolName) || state!.activeTools.includes(toolName)) continue;

              // Auto-LRU Eviction if maxActive reached
              while (state!.activeTools.length >= this.profile.maxActive && state!.usageOrder.length > 0) {
                const oldest = state!.usageOrder.shift();
                if (oldest && !state!.coreTools.includes(oldest)) {
                  const idx = state!.activeTools.indexOf(oldest);
                  if (idx !== -1) {
                    state!.activeTools.splice(idx, 1);
                    evictedTools.push(oldest);
                  }
                }
              }

              state!.activeTools.push(toolName);
              state!.usageOrder.push(toolName);
              loadedTools.push(toolName);
              if (this.options.onCapabilityLoaded) {
                void Promise.resolve(this.options.onCapabilityLoaded(toolName, 'tool')).catch(() => undefined);
              }
            }
            continue;
          }

          // Check if it's a skill in catalog
          const cap = this.catalog.get(req) || this.catalog.getAll().find((c) => c.name.toLowerCase() === req.toLowerCase());
          if (cap && cap.type === 'skill' && cap.procedure) {
            if (!state!.activeSkills.some((s) => s.name.toLowerCase() === cap.name.toLowerCase())) {
              state!.activeSkills.push({
                name: cap.name,
                description: cap.description,
                category: cap.category || 'general',
                allowedTools: cap.allowedTools || [],
                procedure: cap.procedure,
                chars: cap.procedure.length,
              });
              loadedSkills.push(cap.name);
              if (this.options.onCapabilityLoaded) {
                void Promise.resolve(this.options.onCapabilityLoaded(cap.name, 'skill')).catch(() => undefined);
              }
            }
            continue;
          }

          notFound.push(req);
        }

        const success = notFound.length === 0 || (loadedTools.length > 0 || loadedSkills.length > 0 || releasedTools.length > 0 || releasedSkills.length > 0);

        return {
          success,
          loadedTools,
          loadedSkills,
          releasedTools,
          releasedSkills,
          activeTools: state!.activeTools,
          activeSkills: state!.activeSkills.map((s) => s.name),
          evictedTools,
          notFound,
          message: success
            ? `Capabilities updated: ${loadedTools.length + loadedSkills.length} loaded, ${releasedTools.length + releasedSkills.length} released.`
            : 'No matching capabilities found to load or release.',
        };
      },
    });

    // ── 3. Unified Meta-Tool: capability_list_active ─────────────────────────────
    const capabilityListActive = createTool({
      id: 'capability_list_active',
      description: 'List all currently active tools and skills loaded in the agent workspace.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        coreTools: z.array(z.string()),
        activeTools: z.array(z.string()),
        activeSkills: z.array(z.object({
          name: z.string(),
          description: z.string(),
          category: z.string(),
          chars: z.number(),
        })),
        maxActive: numberSchema(),
        totalActiveTools: numberSchema(),
      }),
      execute: async () => {
        return {
          coreTools: state!.coreTools,
          activeTools: state!.activeTools,
          activeSkills: state!.activeSkills.map((s) => ({
            name: s.name,
            description: s.description,
            category: s.category,
            chars: s.chars,
          })),
          maxActive: this.profile.maxActive,
          totalActiveTools: state!.coreTools.length + state!.activeTools.length,
        };
      },
    });

    // ── Backward-Compatibility Legacy Aliases ────────────────────────────────────
    const searchToolsAlias = createTool({
      id: 'search_tools',
      description: 'Legacy alias: search available tools. Use capability_search instead.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ results: z.array(z.any()) }),
      execute: async ({ query }) => {
        const res = await (capabilitySearch.execute as any)({ query, type: 'tool' });
        return { results: res.results };
      },
    });

    const loadToolAlias = createTool({
      id: 'load_tool',
      description: 'Legacy alias: load tools. Use capability_load instead.',
      inputSchema: z.object({
        name: z.string().optional(),
        names: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({ success: z.boolean(), loaded: z.array(z.string()) }),
      execute: async ({ name, names }) => {
        const toLoad = [...(names ?? []), ...(name ? [name] : [])];
        const res = await (capabilityLoad.execute as any)({ load: toLoad });
        return { success: res.success, loaded: res.loadedTools };
      },
    });

    const releaseToolsAlias = createTool({
      id: 'release_tools',
      description: 'Legacy alias: release tools. Use capability_load instead.',
      inputSchema: z.object({ names: z.array(z.string()) }),
      outputSchema: z.object({ success: z.boolean(), released: z.array(z.string()) }),
      execute: async ({ names }) => {
        const res = await (capabilityLoad.execute as any)({ release: names });
        return { success: res.success, released: res.releasedTools };
      },
    });

    const listActiveToolsAlias = createTool({
      id: 'list_active_tools',
      description: 'Legacy alias: list active tools. Use capability_list_active instead.',
      inputSchema: z.object({}),
      outputSchema: z.object({ active: z.array(z.string()) }),
      execute: async () => {
        return { active: [...state!.coreTools, ...state!.activeTools] };
      },
    });

    const skillSearchAlias = createTool({
      id: 'skill_search',
      description: 'Legacy alias: search skills. Use capability_search instead.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ results: z.array(z.any()) }),
      execute: async ({ query }) => {
        const res = await (capabilitySearch.execute as any)({ query, type: 'skill' });
        return { results: res.results };
      },
    });

    const skillLoadAlias = createTool({
      id: 'skill_load',
      description: 'Legacy alias: load skills. Use capability_load instead.',
      inputSchema: z.object({
        name: z.string().optional(),
        names: z.array(z.string()).optional(),
        skillName: z.string().optional(),
        skillNames: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({ success: z.boolean(), loaded: z.array(z.string()) }),
      execute: async ({ name, names, skillName, skillNames }) => {
        const toLoad = [
          ...(names ?? []),
          ...(skillNames ?? []),
          ...(name ? [name] : []),
          ...(skillName ? [skillName] : []),
        ];
        const res = await (capabilityLoad.execute as any)({ load: toLoad });
        return { success: res.success, loaded: res.loadedSkills };
      },
    });

    const skillListActiveAlias = createTool({
      id: 'skill_list_active',
      description: 'Legacy alias: list active skills. Use capability_list_active instead.',
      inputSchema: z.object({}),
      outputSchema: z.object({ active: z.array(z.any()) }),
      execute: async () => {
        return { active: state!.activeSkills };
      },
    });

    const skillSwapAlias = createTool({
      id: 'skill_swap',
      description: 'Legacy alias: swap skills. Use capability_load instead.',
      inputSchema: z.object({
        releaseSkillNames: z.array(z.string()),
        loadSkillNames: z.array(z.string()),
      }),
      outputSchema: z.object({ success: z.boolean(), loaded: z.array(z.string()), released: z.array(z.string()) }),
      execute: async ({ releaseSkillNames, loadSkillNames }) => {
        const res = await (capabilityLoad.execute as any)({ load: loadSkillNames, release: releaseSkillNames });
        return { success: res.success, loaded: res.loadedSkills, released: res.releasedSkills };
      },
    });

    const skillReleaseAlias = createTool({
      id: 'skill_release',
      description: 'Legacy alias: release skills. Use capability_load instead.',
      inputSchema: z.object({ skillNames: z.array(z.string()) }),
      outputSchema: z.object({ success: z.boolean(), released: z.array(z.string()) }),
      execute: async ({ skillNames }) => {
        const res = await (capabilityLoad.execute as any)({ release: skillNames });
        return { success: res.success, released: res.releasedSkills };
      },
    });

    // Inject system message with active skills if present
    if (state.activeSkills.length > 0) {
      args.messageList.addSystem(renderActiveSkillsSystemMessage(state.activeSkills, this.profile), this.id);
    }

    // Assemble tool table
    const tools: Record<string, unknown> = {
      ...allTools,
      capability_search: capabilitySearch,
      capability_load: capabilityLoad,
      capability_list_active: capabilityListActive,
      search_tools: searchToolsAlias,
      load_tool: loadToolAlias,
      release_tools: releaseToolsAlias,
      list_active_tools: listActiveToolsAlias,
      skill_search: skillSearchAlias,
      skill_load: skillLoadAlias,
      skill_list_active: skillListActiveAlias,
      skill_swap: skillSwapAlias,
      skill_release: skillReleaseAlias,
    };

    // Determine activeTools subset for model step
    let activeTools: string[] | undefined;
    if (this.profile.preserveConfiguredToolsAsCore) {
      // In pinned mode, all tools in tools table remain visible
      activeTools = Object.keys(tools);
    } else {
      activeTools = [
        ...state.coreTools,
        ...state.activeTools,
        ...UNIFIED_CAPABILITY_SHELF_CONTROL_NAMES,
        ...TRANSIENT_SHELF_CONTROL_NAMES,
      ];
    }

    return {
      tools,
      activeTools: [...new Set(activeTools)],
    };
  }
}

function numberSchema() {
  return z.number();
}

export function createUnifiedCapabilityShelfProcessor(options: UnifiedCapabilityShelfOptions) {
  return new UnifiedCapabilityShelfProcessor(options);
}
