import { createTool, type Tool } from '@mastra/core/tools';
import { ToolSearchProcessor, type ProcessInputStepArgs, type Processor } from '@mastra/core/processors';
import { z } from 'zod';

import {
  isTransientToolShelfEnabled,
  resolveTransientToolShelfProfile,
  type TransientToolShelfProfile,
} from '../config/transient-tool-shelf-profiles.js';
import {
  TRANSIENT_SHELF_CONTROL_NAMES,
  TRANSIENT_SHELF_CONTROL_SET,
  TRANSIENT_TOOL_SHELF_CONTROL_NAMES,
} from './transient-shelf-controls.js';

export { TRANSIENT_TOOL_SHELF_CONTROL_NAMES as TRANSIENT_TOOL_SHELF_META_TOOL_NAMES };

const META_TOOL_SET = TRANSIENT_SHELF_CONTROL_SET;

type RuntimeTool = {
  id?: string;
  description?: string;
};

interface ToolDescriptor {
  key: string;
  id: string;
  description: string;
  searchText: string;
  tokens: string[];
}

interface ShelfRequestState {
  initialized: boolean;
  active: string[];
  core: string[];
}

export interface TransientToolShelfOptions {
  agentId: string;
  profile?: Partial<TransientToolShelfProfile>;
  /** Legacy ToolSearch pool not present in the agent's static tools map. */
  additionalTools?: Record<string, Tool<any, any>>;
  /** Reproduce the native search/load behavior when the feature flag is off. */
  nativeFallbackWhenDisabled?: boolean;
  /** Original native processor tuning, retained for an exact flag rollback. */
  nativeFallbackSearch?: {
    topK: number;
    minScore: number;
    ttl?: number;
  };
}

const QUERY_EXPANSIONS: Record<string, string[]> = {
  strona: ['page', 'site', 'web'],
  strony: ['pages', 'sites', 'web'],
  witryna: ['website', 'site'],
  internet: ['web', 'search'],
  wyszukaj: ['search', 'find'],
  szukaj: ['search', 'find'],
  znajdz: ['find', 'search'],
  znajdź: ['find', 'search'],
  pobierz: ['fetch', 'get', 'extract'],
  wyciagnij: ['extract', 'scrape'],
  wyciągnij: ['extract', 'scrape'],
  ekstrakcja: ['extract', 'scrape'],
  scrapowanie: ['scrape', 'extract', 'crawl'],
  zapisz: ['write', 'save', 'store'],
  zapis: ['write', 'save', 'store'],
  plik: ['file', 'artifact'],
  dane: ['data', 'records'],
  przegladarka: ['browser', 'playwright', 'dom'],
  przeglądarka: ['browser', 'playwright', 'dom'],
  obraz: ['image', 'visual'],
  firma: ['company', 'lead'],
  email: ['mail', 'gmail'],
  kalendarz: ['calendar', 'event'],
  automatyzacja: ['automation', 'workflow', 'n8n'],
  kod: ['code', 'repository', 'repo'],
  testy: ['test', 'tests'],
};

function normalizeText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  const base = normalizeText(value).split(/\s+/).filter((token) => token.length > 1);
  const expanded = base.flatMap((token) => [token, ...(QUERY_EXPANSIONS[token] ?? [])]);
  return [...new Set(expanded.map(normalizeText).filter(Boolean))];
}

function toolIdentity(value: unknown, key: string): RuntimeTool {
  if (!value || typeof value !== 'object') return { id: key, description: '' };
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : key,
    description: typeof record.description === 'string' ? record.description : '',
  };
}

function compactDescription(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
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

function initialQuery(args: ProcessInputStepArgs): string {
  const userMessages = args.messages.filter((message) => message.role === 'user');
  return userMessages.slice(-2).map(extractMessageText).filter(Boolean).join('\n').slice(-8_000);
}

function buildDescriptors(
  tools: Record<string, unknown>,
  profile: TransientToolShelfProfile,
): ToolDescriptor[] {
  return Object.entries(tools)
    .filter(([key]) => !META_TOOL_SET.has(key))
    .map(([key, value]) => {
      const identity = toolIdentity(value, key);
      const tags = [
        ...(profile.toolTags?.[key] ?? []),
        ...(profile.toolTags?.[identity.id ?? key] ?? []),
        ...Object.entries(profile.toolTags ?? {})
          .filter(([matcher]) => matcher !== key && matcher !== identity.id && normalizeText(key).includes(normalizeText(matcher)))
          .flatMap(([, values]) => values),
      ];
      const searchText = [key, identity.id, identity.description, ...tags].join(' ');
      return {
        key,
        id: identity.id ?? key,
        description: identity.description ?? '',
        searchText,
        tokens: tokenize(searchText),
      };
    });
}

/** Deterministic BM25-style lexical ranking with exact key/id boosts. */
export function rankTransientTools(
  query: string,
  descriptors: ToolDescriptor[],
  topK: number,
): Array<ToolDescriptor & { score: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || descriptors.length === 0) return [];

  const documentFrequency = new Map<string, number>();
  for (const descriptor of descriptors) {
    for (const token of new Set(descriptor.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const averageLength = descriptors.reduce((sum, descriptor) => sum + descriptor.tokens.length, 0)
    / descriptors.length;
  const normalizedQuery = normalizeText(query);

  return descriptors
    .map((descriptor) => {
      const frequencies = new Map<string, number>();
      for (const token of descriptor.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const tf = frequencies.get(token) ?? 0;
        if (tf === 0) continue;
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (descriptors.length - df + 0.5) / (df + 0.5));
        const denominator = tf + 1.2 * (1 - 0.75 + 0.75 * descriptor.tokens.length / Math.max(averageLength, 1));
        score += idf * (tf * 2.2) / denominator;
      }
      const normalizedKey = normalizeText(descriptor.key);
      const normalizedId = normalizeText(descriptor.id);
      if (normalizedQuery === normalizedKey || normalizedQuery === normalizedId) score += 10;
      if (normalizedQuery.includes(normalizedKey) || normalizedQuery.includes(normalizedId)) score += 3;
      return { ...descriptor, score: Math.round(score * 1000) / 1000 };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    .slice(0, topK);
}

function resolveNames(requested: string[], descriptors: ToolDescriptor[]): {
  resolved: string[];
  notFound: string[];
} {
  const resolved: string[] = [];
  const notFound: string[] = [];
  for (const rawName of requested) {
    const name = rawName.trim();
    if (!name) continue;
    const exact = descriptors.find((descriptor) => descriptor.key === name)
      ?? descriptors.find((descriptor) => descriptor.id === name);
    if (exact) resolved.push(exact.key);
    else notFound.push(name);
  }
  return { resolved: [...new Set(resolved)], notFound: [...new Set(notFound)] };
}

function resolveCoreKeys(
  descriptors: ToolDescriptor[],
  profile: TransientToolShelfProfile,
  configuredToolKeys: Set<string>,
): string[] {
  if (profile.preserveConfiguredToolsAsCore) return [...configuredToolKeys];
  const requested = new Set((profile.coreTools ?? []).map(normalizeText));
  const patterns = (profile.corePatterns ?? []).map(normalizeText).filter(Boolean);
  return descriptors
    .filter((descriptor) => {
      const key = normalizeText(descriptor.key);
      const id = normalizeText(descriptor.id);
      return requested.has(key)
        || requested.has(id)
        || patterns.some((pattern) => key.includes(pattern) || id.includes(pattern));
    })
    .map((descriptor) => descriptor.key);
}

function uniqueKnown(names: Iterable<string>, universe: Set<string>): string[] {
  return [...new Set(names)].filter((name) => universe.has(name));
}

function mergeActiveTools(
  current: string[] | undefined,
  selected: string[],
  universe: Set<string>,
): string[] {
  const selectedKnown = uniqueKnown(selected, universe);
  if (!current) return selectedKnown;
  const currentSet = new Set(current);
  return selectedKnown.filter((name) => currentSet.has(name) || META_TOOL_SET.has(name));
}

/**
 * Compose a later allowlist with a shelf selection without re-expanding tools.
 * Shelf meta-tools are host-side selection controls and remain available unless
 * a caller explicitly forces toolChoice='none'.
 */
export function intersectTransientActiveTools(
  currentTools: Record<string, unknown> | undefined,
  currentActiveTools: string[] | undefined,
  constraint: string[] | null | undefined,
): string[] | undefined {
  const universe = new Set(Object.keys(currentTools ?? {}));
  const base = currentActiveTools
    ? uniqueKnown(currentActiveTools, universe)
    : [...universe];
  if (!constraint) return currentActiveTools ? base : undefined;
  const allowed = new Set(constraint);
  return base.filter((name) => allowed.has(name) || META_TOOL_SET.has(name));
}

export class TransientToolShelfProcessor implements Processor<'transient-tool-shelf'> {
  readonly id = 'transient-tool-shelf' as const;
  readonly name = 'Transient Tool Shelf';
  readonly description = 'Request-scoped lexical tool discovery with load and release.';

  private readonly profile: TransientToolShelfProfile;
  private readonly additionalTools: Record<string, Tool<any, any>>;
  private readonly nativeFallback?: ToolSearchProcessor;

  constructor(private readonly options: TransientToolShelfOptions) {
    this.profile = resolveTransientToolShelfProfile(options.agentId, options.profile);
    this.additionalTools = options.additionalTools ?? {};
    if (options.nativeFallbackWhenDisabled && Object.keys(this.additionalTools).length > 0) {
      const fallback = options.nativeFallbackSearch;
      this.nativeFallback = new ToolSearchProcessor({
        tools: this.additionalTools,
        search: {
          topK: fallback?.topK ?? this.profile.searchTopK,
          minScore: fallback?.minScore ?? 0,
        },
        ttl: fallback?.ttl ?? 3_600_000,
      });
    }
  }

  async processInputStep(args: ProcessInputStepArgs) {
    if (!isTransientToolShelfEnabled(this.options.agentId)) {
      return this.nativeFallback?.processInputStep(args);
    }

    const configuredTools = { ...(args.tools ?? {}) };
    // A statically configured handle wins a duplicate key. The discoverable
    // legacy pool may extend an agent's permissions, never replace them.
    const allTools: Record<string, unknown> = { ...this.additionalTools, ...configuredTools };
    const configuredToolKeys = new Set(Object.keys(configuredTools));
    const descriptors = buildDescriptors(allTools, this.profile);
    const universe = new Set(descriptors.map((descriptor) => descriptor.key));

    let shelfState = args.state.shelf as ShelfRequestState | undefined;
    if (!shelfState?.initialized) {
      const core = resolveCoreKeys(descriptors, this.profile, configuredToolKeys);
      const initial = rankTransientTools(initialQuery(args), descriptors, this.profile.initialTopK)
        .map((result) => result.key)
        .filter((name) => !core.includes(name));
      shelfState = {
        initialized: true,
        core,
        active: initial.slice(0, this.profile.maxActive),
      };
      args.state.shelf = shelfState;
    } else {
      shelfState.core = uniqueKnown(shelfState.core, universe);
      shelfState.active = uniqueKnown(shelfState.active, universe).slice(0, this.profile.maxActive);
    }

    const searchTool = createTool({
      id: 'search_tools',
      description: 'Search the tools available to this agent. Returns compact names and descriptions; then use load_tool.',
      inputSchema: z.object({
        query: z.string().trim().min(1).describe('What capability is needed, in Polish or English'),
      }),
      outputSchema: z.object({
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          description: z.string(),
          score: z.number(),
          active: z.boolean(),
        })),
      }),
      execute: async ({ query }) => ({
        results: rankTransientTools(query, descriptors, this.profile.searchTopK).map((result) => ({
          name: result.key,
          id: result.id,
          description: compactDescription(result.description),
          score: result.score,
          active: shelfState!.core.includes(result.key) || shelfState!.active.includes(result.key),
        })),
      }),
    });

    const loadTool = createTool({
      id: 'load_tool',
      description: 'Load one or more searched tools for the next model step. releaseToolNames can atomically exchange tools.',
      inputSchema: z.object({
        toolName: z.string().optional(),
        toolNames: z.array(z.string()).max(12).optional(),
        releaseToolNames: z.array(z.string()).max(12).optional(),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        loaded: z.array(z.string()),
        released: z.array(z.string()),
        alreadyActive: z.array(z.string()),
        notFound: z.array(z.string()),
        active: z.array(z.string()),
        message: z.string(),
      }),
      execute: async ({ toolName, toolNames, releaseToolNames }) => {
        const requested = [...(toolNames ?? []), ...(toolName ? [toolName] : [])];
        const releases = resolveNames(releaseToolNames ?? [], descriptors);
        const coreSet = new Set(shelfState!.core);
        const released = releases.resolved.filter((name) => !coreSet.has(name));
        shelfState!.active = shelfState!.active.filter((name) => !released.includes(name));

        const loads = resolveNames(requested, descriptors);
        const alreadyActive = loads.resolved.filter(
          (name) => coreSet.has(name) || shelfState!.active.includes(name),
        );
        const toLoad = loads.resolved.filter((name) => !coreSet.has(name) && !shelfState!.active.includes(name));
        const freeSlots = Math.max(0, this.profile.maxActive - shelfState!.active.length);
        const loaded = toLoad.slice(0, freeSlots);
        shelfState!.active.push(...loaded);
        const capacityRejected = toLoad.slice(freeSlots);
        const notFound = [...loads.notFound, ...releases.notFound, ...capacityRejected];
        const success = requested.length > 0 && notFound.length === 0;
        return {
          success,
          loaded,
          released,
          alreadyActive,
          notFound,
          active: [...shelfState!.core, ...shelfState!.active],
          message: success
            ? 'Tool shelf updated; changes apply on the next model step.'
            : `Shelf not fully updated. Release tools first if the ${this.profile.maxActive}-tool dynamic limit is full.`,
        };
      },
    });

    const releaseTools = createTool({
      id: 'release_tools',
      description: 'Release non-core tools so their schemas disappear from the next model step.',
      inputSchema: z.object({ toolNames: z.array(z.string()).min(1).max(12) }),
      outputSchema: z.object({
        released: z.array(z.string()),
        pinned: z.array(z.string()),
        notFound: z.array(z.string()),
        active: z.array(z.string()),
      }),
      execute: async ({ toolNames }) => {
        const resolved = resolveNames(toolNames, descriptors);
        const coreSet = new Set(shelfState!.core);
        const pinned = resolved.resolved.filter((name) => coreSet.has(name));
        const released = resolved.resolved.filter(
          (name) => !coreSet.has(name) && shelfState!.active.includes(name),
        );
        shelfState!.active = shelfState!.active.filter((name) => !released.includes(name));
        return {
          released,
          pinned,
          notFound: resolved.notFound,
          active: [...shelfState!.core, ...shelfState!.active],
        };
      },
    });

    const listActiveTools = createTool({
      id: 'list_active_tools',
      description: 'List the currently visible core and dynamically loaded tools.',
      inputSchema: z.object({}),
      outputSchema: z.object({ core: z.array(z.string()), loaded: z.array(z.string()) }),
      execute: async () => ({ core: [...shelfState!.core], loaded: [...shelfState!.active] }),
    });

    args.messageList.addSystem(
      'A compact tool shelf is active. Use search_tools when a capability is missing, load_tool to expose it, '
      + 'list_active_tools to inspect the current shelf, and release_tools to remove schemas you no longer need. '
      + 'load_tool.releaseToolNames can exchange tools atomically. Loaded/released tools become callable on your '
      + 'VERY NEXT tool call, automatically, within this same turn — you do not stop, end your reply, or wait for '
      + 'a new invocation. After load_tool succeeds, immediately call the tool you just loaded.',
      this.id,
    );

    const tools = {
      ...allTools,
      search_tools: searchTool,
      load_tool: loadTool,
      release_tools: releaseTools,
      list_active_tools: listActiveTools,
    };
    const toolUniverse = new Set(Object.keys(tools));
    const selected = [
      ...shelfState.core,
      ...shelfState.active,
      ...TRANSIENT_SHELF_CONTROL_NAMES,
    ];

    return {
      tools,
      activeTools: mergeActiveTools(args.activeTools, selected, toolUniverse),
    };
  }
}

export function createTransientToolShelfProcessor(options: TransientToolShelfOptions) {
  return new TransientToolShelfProcessor(options);
}
