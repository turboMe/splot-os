/**
 * Meta Execute Command (Workaround for Mastra v1.31/1.32 bug)
 *
 * Replaces workspace `execute_command` (LocalSandbox) because that emits
 * `data-workspace-metadata` + `data-sandbox-exit` parts, which in v1.31/1.32
 * break the persistence of the `text` part in `mastra_messages` after multi-step generation.
 * See analysis in chat 2026-05-10 — text arrives in the stream, but after reloading
 * the conversation in Studio it disappears because persistence loses the text part.
 *
 * Custom tool uses Node `child_process.spawn` directly, without sandbox
 * events → message persistence has no race condition.
 *
 * Safety: goes through `checkCommand` (terminal-safety-guard).
 */
import { spawn } from 'child_process';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { checkCommand, logSafetyEvent } from '../../lib/terminal-safety-guard.js';

const MAX_OUTPUT_BYTES = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_CWD = '/projekty/splot-projects';

function truncateOutput(buf: string): string {
  if (Buffer.byteLength(buf, 'utf8') <= MAX_OUTPUT_BYTES) return buf;
  const head = buf.slice(0, MAX_OUTPUT_BYTES);
  return head + `\n... (truncated, original ${Buffer.byteLength(buf, 'utf8')} bytes)`;
}

export const metaExecuteCommandTool = createTool({
  id: 'execute_command',
  description:
    'Runs a shell command on the host (workingDir: /projekty/splot-projects by default). ' +
    'Network allowed. Destructive commands are blocked by terminal-safety-guard. ' +
    'Returns stdout, stderr, exitCode, durationMs.',
  inputSchema: z.object({
    command: z.string().describe('Shell command (e.g. "curl -s http://...", "ls -la").'),
    cwd: z.string().optional().describe(`Working directory. Default: ${DEFAULT_CWD}.`),
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional()
      .describe(`Timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().nullable(),
    durationMs: z.number(),
    command: z.string(),
    blocked: z.string().optional(),
    timedOut: z.boolean().optional(),
  }),
  execute: async (context) => {
    const command = context.command;
    const cwd = context.cwd || DEFAULT_CWD;
    const timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    // Safety check
    const verdict = checkCommand(command);
    if (verdict.action === 'BLOCK') {
      void logSafetyEvent(verdict, 'meta-agent').catch(() => {});
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: Date.now() - startedAt,
        command,
        blocked: `[SAFETY BLOCK] ${verdict.reason || 'destructive command pattern detected'}`,
      };
    }
    if (verdict.action === 'CONFIRM') {
      void logSafetyEvent(verdict, 'meta-agent').catch(() => {});
      // Continue with warning logged
    }

    return await new Promise((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let timedOut = false;

      const child = spawn('bash', ['-lc', command], {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (Buffer.byteLength(stdoutBuf, 'utf8') < MAX_OUTPUT_BYTES * 2) {
          stdoutBuf += chunk.toString();
        }
      });
      child.stderr.on('data', (chunk) => {
        if (Buffer.byteLength(stderrBuf, 'utf8') < MAX_OUTPUT_BYTES * 2) {
          stderrBuf += chunk.toString();
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          success: !timedOut && code === 0,
          stdout: truncateOutput(stdoutBuf),
          stderr: truncateOutput(stderrBuf),
          exitCode: code,
          durationMs: Date.now() - startedAt,
          command,
          ...(timedOut ? { timedOut: true } : {}),
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          stdout: truncateOutput(stdoutBuf),
          stderr: truncateOutput(stderrBuf + '\nspawn error: ' + err.message),
          exitCode: null,
          durationMs: Date.now() - startedAt,
          command,
        });
      });
    });
  },
});
