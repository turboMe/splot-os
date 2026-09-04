/**
 * Capability Sandbox — isolated trial of a discovered MCP server
 * (Etap 7, CGP — the security crux).
 *
 * An unknown MCP server must NEVER see real secrets. The trial runs the
 * server as a child process wrapped in `env -i` (empty environment), with:
 *   - a minimal PATH/HOME (HOME points at a throwaway sandbox dir),
 *   - MOCK values for every env var the registry entry declares
 *     (secret or not) — so servers that validate config presence still boot,
 *   - a hard timeout,
 * and smoke-tests it: connect over stdio, list tools, disconnect.
 *
 * `buildSandboxSpawnSpec` is pure and unit-tested: given a capability record
 * and the CURRENT process env, it must produce a spawn spec that contains
 * NONE of the process env values (asserted by check:cgp-sandbox-isolation).
 *
 * v1 limitation (documented): no network-layer domain allowlist/proxy jail —
 * isolation is env-scrub + mock secrets + timeout + no-attach-without-approval.
 */

import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  getCapability,
  transitionCapability,
  type CapabilityRecord,
  type SandboxReport,
} from './capability-registry.js';

const SANDBOX_HOME = resolve(process.cwd(), '.mastra', 'capability-sandbox');
const DEFAULT_TRIAL_TIMEOUT_MS = 120_000;

export type SandboxSpawnSpec = {
  command: string;               // always 'env'
  args: string[];                // ['-i', 'K=V', …, runtime, …runtimeArgs, identifier]
  mockedEnv: Record<string, string>;
};

/**
 * How to invoke a capability's package — shared by the sandbox trial and the
 * live attach so both paths stay identical except for the environment.
 *   npm   → npx -y <pkg>[@version]
 *   local → node <absolute path>   (manually registered / test fixtures)
 */
export function resolveRuntimeInvocation(pkg: NonNullable<CapabilityRecord['package']>): {
  runtime: string; runtimeArgs: string[]; target: string;
} {
  if (pkg.registryType === 'local') {
    return {
      runtime: pkg.runtimeHint || 'node',
      runtimeArgs: pkg.runtimeArguments ?? [],
      target: pkg.identifier,
    };
  }
  const runtime = pkg.runtimeHint === 'npx' || !pkg.runtimeHint ? 'npx' : pkg.runtimeHint;
  // -y only makes sense for npx; other runtimes get their declared args verbatim.
  const runtimeArgs = pkg.runtimeArguments?.length
    ? pkg.runtimeArguments
    : (runtime === 'npx' ? ['-y'] : []);
  return { runtime, runtimeArgs, target: pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier };
}

/**
 * Build the isolated spawn spec for a capability's stdio package.
 * PURE — no I/O. The returned args embed the ONLY environment the child gets.
 */
export function buildSandboxSpawnSpec(record: CapabilityRecord): SandboxSpawnSpec {
  const pkg = record.package;
  if (!pkg || !pkg.identifier || !['npm', 'local'].includes(pkg.registryType)) {
    throw new Error(`Capability ${record.registryName} has no locally runnable package (remote-only or unsupported registry type '${pkg?.registryType}').`);
  }

  // Minimal, explicit environment — nothing inherited from process.env.
  // PATH must include the directory of the RUNNING node binary, otherwise
  // node/npx are unreachable on nvm-style installs (no /usr/bin/node) and every
  // trial dies with "connection closed". A bin directory is a path, not a
  // secret — the isolation guarantee (no real env VALUES) is unaffected.
  const runtimeBinDir = dirname(process.execPath);
  const mockedEnv: Record<string, string> = {
    PATH: `${runtimeBinDir}:/usr/local/bin:/usr/bin:/bin`,
    HOME: SANDBOX_HOME,
    NODE_ENV: 'sandbox',
  };
  for (const v of pkg.envVars ?? []) {
    // Mock EVERY declared var (secret or not) so config-presence checks pass,
    // while guaranteeing no real value can leak.
    mockedEnv[v.name] = v.isSecret ? `sandbox-mock-secret-${v.name.toLowerCase()}` : `sandbox-mock-${v.name.toLowerCase()}`;
  }

  const { runtime, runtimeArgs, target } = resolveRuntimeInvocation(pkg);

  return {
    command: 'env',
    args: [
      '-i',
      ...Object.entries(mockedEnv).map(([k, val]) => `${k}=${val}`),
      runtime,
      ...runtimeArgs,
      target,
    ],
    mockedEnv,
  };
}

/**
 * Run the sandbox trial: spawn in isolation, list tools, report.
 * Records the report on the capability: ok → sandboxed, fail → quarantined.
 */
export async function sandboxTrialCapability(
  capabilityId: string,
  opts: { timeoutMs?: number } = {},
): Promise<SandboxReport> {
  const record = await getCapability(capabilityId);
  if (!record) throw new Error(`Capability not found: ${capabilityId}`);
  if (!['discovered', 'quarantined'].includes(record.status)) {
    throw new Error(`Capability ${record.registryName} is ${record.status} — sandbox runs from discovered/quarantined only.`);
  }

  const start = Date.now();
  let report: SandboxReport;
  try {
    const spec = buildSandboxSpawnSpec(record);
    mkdirSync(SANDBOX_HOME, { recursive: true });

    // Dedicated, throwaway MCP client (WS-E isolation pattern).
    const { MCPClient } = await import('@mastra/mcp');
    const client = new MCPClient({
      id: `sandbox-${capabilityId}-${Date.now()}`,
      timeout: opts.timeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS,
      servers: {
        trial: { command: spec.command, args: spec.args },
      },
    });

    try {
      const toolsets = await client.listToolsets();
      const tools = Object.keys(toolsets.trial ?? {});
      report = {
        ok: tools.length > 0,
        toolCount: tools.length,
        toolNames: tools.slice(0, 25),
        durationMs: Date.now() - start,
        ...(tools.length === 0 ? { error: 'server started but exposed no tools' } : {}),
        at: new Date(),
      };
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  } catch (error) {
    report = {
      ok: false,
      durationMs: Date.now() - start,
      error: (error as Error).message.slice(0, 300),
      at: new Date(),
    };
  }

  await transitionCapability(
    capabilityId,
    report.ok ? 'sandboxed' : 'quarantined',
    { note: report.ok ? `smoke ok: ${report.toolCount} tools` : `trial failed: ${report.error}`, sandboxReport: report },
  );
  return report;
}

export { SANDBOX_HOME };
