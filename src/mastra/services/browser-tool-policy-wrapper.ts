/**
 * Gates raw Playwright MCP tools with the browser/computer-use harness policy.
 *
 * MCP toolsets (`mcpClient.listToolsets()`) are NOT `createTool()`-based, so
 * they never pass through `withToolEnvelope` — spreading them straight into
 * an agent's `tools: {}` (as `coding-agent.ts` / `researcher-agent.ts` do)
 * gives the agent an ungated browser. This wraps each tool's `execute` so a
 * real navigate/click/type call is classified and policy-checked before it
 * runs, using the exact same `effectiveAllow` gate the rest of the harness
 * uses (`enforce` mode throws on a disallowed decision; `log_only` logs and
 * proceeds) — no separate mechanism invented.
 *
 * Tool-name matching is pattern-based, not an exact id list: `@playwright/mcp`
 * (what `mcp.ts` installs) is a third-party package whose exact tool ids this
 * code does not control, and a hardcoded list silently stops matching on a
 * version bump. Matching by substring is deliberately conservative — a tool
 * whose name doesn't match ANY known pattern falls through unwrapped, which
 * is why the read-only category is enumerated explicitly below rather than
 * left as "everything else must be safe."
 */

import { getHarnessExecutionContext } from './harness-execution-context.js';
import { evaluateAndLogHarnessPolicy, getHarnessPolicyMode } from './harness-policy.js';
import { registerRunStartedPort, classifyBrowserTargetForRun } from '../config/browser-surfaces.js';

type RawTool = {
  execute?: (input: any, metadata?: any) => Promise<any>;
  [key: string]: any;
};

const NAVIGATE_PATTERN = /navigate(?!_back)/i;
const INTERACT_PATTERN = /click|type|fill|select_option|drag|hover|press_key|file_upload|handle_dialog/i;
const EVALUATE_PATTERN = /evaluate/i;

// The last URL this run navigated to — interaction tools (click/type/...) act
// on the currently loaded page and carry no URL of their own, so they inherit
// this run's most recent navigation target for classification.
const MAX_TRACKED_RUNS = 500;
const lastNavigatedTarget = new Map<string, string>();

function rememberNavigation(runId: string | undefined, url: string | undefined): void {
  if (!runId || !url) return;
  if (!lastNavigatedTarget.has(runId) && lastNavigatedTarget.size >= MAX_TRACKED_RUNS) {
    const oldestKey = lastNavigatedTarget.keys().next().value;
    if (oldestKey !== undefined) lastNavigatedTarget.delete(oldestKey);
  }
  lastNavigatedTarget.delete(runId);
  lastNavigatedTarget.set(runId, url);
}

function currentTarget(runId: string | undefined): string | undefined {
  return runId ? lastNavigatedTarget.get(runId) : undefined;
}

/** Best-effort extraction of a human-readable element description for
 *  tier-1 pattern matching, from whatever shape this MCP server's
 *  interaction-tool arguments actually take. */
function describeElement(input: Record<string, unknown>): string {
  const parts = ['element', 'ref', 'selector', 'text', 'value', 'key']
    .map((field) => input[field])
    .filter((v): v is string => typeof v === 'string');
  return parts.join(' ');
}

function extractUrl(input: Record<string, unknown>): string | undefined {
  const url = input.url ?? input.href;
  return typeof url === 'string' ? url : undefined;
}

async function enforce(
  action: 'browser:navigate' | 'browser:interact' | 'browser:evaluate',
  target: string | undefined,
  command: string | undefined,
): Promise<void> {
  const ctx = getHarnessExecutionContext() ?? {};
  const decision = await evaluateAndLogHarnessPolicy({
    agentId: ctx.agentId ?? 'unknown',
    runId: ctx.runId,
    turnId: ctx.turnId,
    threadId: ctx.threadId,
    taskId: ctx.taskId,
    subtaskId: ctx.subtaskId,
    action,
    target,
    command,
  });

  if (!decision.effectiveAllow) {
    throw new Error(
      `Browser policy blocked ${action}${target ? ` (${target})` : ''}: ${decision.reason}`,
    );
  }
}

function wrapOne(name: string, tool: RawTool): RawTool {
  if (typeof tool?.execute !== 'function') return tool;
  const originalExecute = tool.execute.bind(tool);

  if (NAVIGATE_PATTERN.test(name)) {
    return {
      ...tool,
      execute: async (input: any, metadata?: any) => {
        const url = extractUrl(input ?? {});
        const ctx = getHarnessExecutionContext() ?? {};
        if (url) {
          rememberNavigation(ctx.runId, url);
          // Registering the target's own port as "run-started" only matters
          // for ports this run itself launched (bg_task registers those
          // explicitly) — navigation does not grant ownership of a port it
          // did not start, so no registration happens here.
        }
        await enforce('browser:navigate', url, undefined);
        return originalExecute(input, metadata);
      },
    };
  }

  if (INTERACT_PATTERN.test(name)) {
    return {
      ...tool,
      execute: async (input: any, metadata?: any) => {
        const ctx = getHarnessExecutionContext() ?? {};
        const target = currentTarget(ctx.runId);
        const elementDescription = describeElement(input ?? {});
        await enforce('browser:interact', target, elementDescription || undefined);
        return originalExecute(input, metadata);
      },
    };
  }

  if (EVALUATE_PATTERN.test(name)) {
    return {
      ...tool,
      execute: async (input: any, metadata?: any) => {
        const ctx = getHarnessExecutionContext() ?? {};
        await enforce('browser:evaluate', currentTarget(ctx.runId), undefined);
        return originalExecute(input, metadata);
      },
    };
  }

  // Read-only / low-risk tools (snapshot, screenshot, console/network read,
  // wait_for, resize, tab list/new/select/close, navigate_back, install) pass
  // through unwrapped — matches the existing `computer_use:screen` verdict.
  return tool;
}

/**
 * Wrap an entire Playwright MCP toolset. Call this on the object returned by
 * `mcpClient.listToolsets()['playwright']` before spreading it into an
 * agent's `tools`.
 */
export function wrapPlaywrightToolsWithPolicy(toolset: Record<string, RawTool>): Record<string, RawTool> {
  const wrapped: Record<string, RawTool> = {};
  for (const [name, tool] of Object.entries(toolset ?? {})) {
    wrapped[name] = wrapOne(name, tool);
  }
  return wrapped;
}

export { registerRunStartedPort, classifyBrowserTargetForRun, getHarnessPolicyMode };
