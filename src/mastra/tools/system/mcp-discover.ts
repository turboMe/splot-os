/**
 * mcp_discover — search the official MCP Registry for a server that fills a
 * capability gap (Etap 7, CGP step 2 — "SZUKAJ GOTOWCA").
 *
 * The official registry (registry.modelcontextprotocol.io) federates Smithery
 * entries too, so ONE read-only REST API covers both sources from the plan.
 * Results are ranked against the gap description and recorded in the
 * Capability Registry as `discovered` candidates for the sandbox step.
 *
 * Read-only and free — no API key, no side effects beyond the Mongo record.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  recordDiscoveredCapability,
  type CapabilityEnvVar,
  type CapabilityPackage,
  type CapabilityRemote,
} from '../../services/capability-registry.js';

const REGISTRY_BASE = process.env.MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io';

type RegistryServer = {
  name: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  packages?: Array<Record<string, unknown>>;
  remotes?: Array<Record<string, unknown>>;
};

function parseEnvVars(raw: unknown): CapabilityEnvVar[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => {
    const r = v as Record<string, unknown>;
    return {
      name: String(r.name ?? ''),
      description: r.description ? String(r.description) : undefined,
      isRequired: r.isRequired === true,
      isSecret: r.isSecret === true,
    };
  }).filter((v) => v.name);
}

export function parseRegistryServer(entry: Record<string, unknown>): {
  registryName: string; description: string; version?: string; repositoryUrl?: string;
  pkg?: CapabilityPackage; remotes?: CapabilityRemote[];
} {
  const srv = (entry.server ?? entry) as RegistryServer;
  const pkgRaw = srv.packages?.[0] as Record<string, unknown> | undefined;
  const pkg: CapabilityPackage | undefined = pkgRaw ? {
    registryType: String(pkgRaw.registryType ?? 'npm'),
    identifier: String(pkgRaw.identifier ?? ''),
    version: pkgRaw.version ? String(pkgRaw.version) : undefined,
    runtimeHint: pkgRaw.runtimeHint ? String(pkgRaw.runtimeHint) : undefined,
    runtimeArguments: Array.isArray(pkgRaw.runtimeArguments)
      ? (pkgRaw.runtimeArguments as Array<Record<string, unknown>>).map((a) => String(a.value ?? '')).filter(Boolean)
      : undefined,
    envVars: parseEnvVars(pkgRaw.environmentVariables),
    transport: (pkgRaw.transport as Record<string, unknown> | undefined)?.type
      ? String((pkgRaw.transport as Record<string, unknown>).type) : undefined,
  } : undefined;

  const remotes: CapabilityRemote[] | undefined = Array.isArray(srv.remotes)
    ? (srv.remotes as Array<Record<string, unknown>>).map((r) => ({
        type: String(r.type ?? ''),
        url: String(r.url ?? ''),
        headers: parseEnvVars(r.headers),
      })).filter((r) => r.url)
    : undefined;

  return {
    registryName: String(srv.name ?? ''),
    description: String(srv.description ?? ''),
    version: srv.version ? String(srv.version) : undefined,
    repositoryUrl: srv.repository?.url ? String(srv.repository.url) : undefined,
    pkg,
    remotes,
  };
}

/** Naive relevance: term overlap between the gap and name+description. */
export function scoreCandidate(gapQuery: string, name: string, description: string): number {
  const terms = gapQuery.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const haystack = `${name} ${description}`.toLowerCase();
  if (terms.length === 0) return 0;
  const hits = terms.filter((t) => haystack.includes(t)).length;
  return Math.round((hits / terms.length) * 100) / 100;
}

export const mcpDiscoverTool = createTool({
  id: 'mcp_discover',
  description:
    'Search the official MCP Registry (federates Smithery) for an existing MCP server that fills a ' +
    'capability gap. Returns ranked candidates with what each needs to run (package, required env vars, ' +
    'which are SECRET). Candidates are recorded in the Capability Registry as `discovered` — the next ' +
    'step is capability_sandbox on the best candidate. Read-only; attaching ALWAYS requires human approval.',
  inputSchema: z.object({
    query: z.string().min(3).describe('The capability gap, e.g. "send slack messages" or "read postgres database"'),
    limit: z.number().optional().default(8).describe('Max candidates to return (1–20)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    candidates: z.array(z.object({
      capabilityId: z.string(),
      registryName: z.string(),
      description: z.string(),
      score: z.number(),
      transport: z.string(),
      runnable: z.boolean().describe('true = has an npm/stdio package we can sandbox locally'),
      requiredEnv: z.array(z.string()),
      secretEnv: z.array(z.string()),
    })),
    summary: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      const limit = Math.max(1, Math.min(20, input.limit ?? 8));
      const url = `${REGISTRY_BASE}/v0/servers?search=${encodeURIComponent(input.query)}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        return { success: false, count: 0, candidates: [], summary: '', error: `registry HTTP ${res.status}` };
      }
      const data = await res.json() as { servers?: Array<Record<string, unknown>> };
      const servers = data.servers ?? [];

      const candidates = [];
      for (const entry of servers) {
        const parsed = parseRegistryServer(entry);
        if (!parsed.registryName) continue;
        const record = await recordDiscoveredCapability({
          registryName: parsed.registryName,
          description: parsed.description,
          version: parsed.version,
          repositoryUrl: parsed.repositoryUrl,
          package: parsed.pkg,
          remotes: parsed.remotes,
          gapDescription: input.query,
        });
        const requiredEnv = (parsed.pkg?.envVars ?? []).filter((v) => v.isRequired).map((v) => v.name);
        const secretEnv = (parsed.pkg?.envVars ?? []).filter((v) => v.isSecret).map((v) => v.name);
        candidates.push({
          capabilityId: record.capabilityId,
          registryName: parsed.registryName,
          description: parsed.description.slice(0, 200),
          score: scoreCandidate(input.query, parsed.registryName, parsed.description),
          transport: parsed.pkg?.transport ?? parsed.remotes?.[0]?.type ?? 'unknown',
          runnable: parsed.pkg?.registryType === 'npm' && Boolean(parsed.pkg?.identifier),
          requiredEnv,
          secretEnv,
        });
      }
      candidates.sort((a, b) => b.score - a.score || Number(b.runnable) - Number(a.runnable));

      const top = candidates[0];
      return {
        success: true,
        count: candidates.length,
        candidates,
        summary: candidates.length === 0
          ? `No MCP servers found for "${input.query}". Consider the BUILD path (delegate a tool spec to codingAgent).`
          : `${candidates.length} candidate(s). Best: ${top!.registryName} (score ${top!.score}, ` +
            `${top!.runnable ? 'sandboxable locally' : 'remote-only'}${top!.secretEnv.length ? `, needs secrets: ${top!.secretEnv.join(', ')}` : ', no secrets'}). ` +
            `Next: capability_sandbox("${top!.capabilityId}").`,
      };
    } catch (error) {
      return { success: false, count: 0, candidates: [], summary: '', error: (error as Error).message };
    }
  },
});
