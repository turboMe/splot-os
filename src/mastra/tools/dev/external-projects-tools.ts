import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getOrCreateExternalProject, listExternalProjects } from '../../workspaces/external-project-workspace.js';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { checkPathInsideRoot, resolveInsideRoot } from '../../lib/path-containment.js';

// Import subagent directly for delegation
import { codeReviewAgent } from '../../agents/code-review-agent.js';
import { generateReview } from '../../services/review-harness.js';

const RUN_COMMAND_TIMEOUT_MS = 30_000;

/**
 * K15 fix: `execSync` blocks the whole Node event loop for the entire duration
 * of the child process (up to 30s) — every other agent running concurrently
 * on the same server freezes. `spawn` + real `SIGKILL` on timeout gives the
 * same bounded behavior without blocking (same pattern as
 * `meta-execute-command.ts`).
 *
 * `detached: true` makes the shell its own process-group leader, so the
 * timeout kills the group (`-pid`), not just the shell — a compound command
 * like `sleep 5 && echo done` forks `sleep` as a child THAT bash merely
 * waits on, so killing only the shell's own pid leaves `sleep` running as
 * an orphan until it finishes on its own.
 */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn('bash', ['-lc', command], { cwd, env: process.env, detached: true });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr: stderr + '\nspawn error: ' + err.message, exitCode: null, timedOut });
    });
  });
}

export const createExternalProjectTool = createTool({
  id: 'createExternalProject',
  description: 'Creates or retrieves an external project for secure coding outside the agent',
  inputSchema: z.object({
    projectName: z.string().describe('Project name (alphanumeric and hyphens only)'),
    template: z.enum(['empty', 'typescript', 'node']).optional().describe('Starter template'),
  }),
  execute: async (context) => {
    try {
      const project = getOrCreateExternalProject(context.projectName, { template: context.template });
      return { success: true, path: project.path };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});

export const listExternalProjectsTool = createTool({
  id: 'listExternalProjects',
  description: 'Lists existing external projects (repositories) in the agent-projects directory. Read-only — allows agents to find existing repositories for their work.',
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const projects = listExternalProjects();
      return { success: true, projects };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});

export const writeExternalProjectFileTool = createTool({
  id: 'writeExternalProjectFile',
  description: 'Writes a file in the external project',
  inputSchema: z.object({
    projectName: z.string().describe('Project name'),
    filePath: z.string().describe('Relative path of the file in the project'),
    content: z.string().describe('File content'),
  }),
  execute: async (context) => {
    try {
      const project = getOrCreateExternalProject(context.projectName);
      const fullPath = resolveInsideRoot(context.filePath, project.path);

      // This used to be a bare prefix comparison against the project path, and a
      // SIBLING directory whose name merely extends the project's slipped through
      // it: for project `app`, `../app-evil/x.ts` resolves outside and was
      // accepted. Measured 2026-08-17. Containment needs the separator, so the
      // question is asked once, in `lib/path-containment.ts`, by everyone.
      if (!checkPathInsideRoot(fullPath, project.path).inside) {
        throw new Error(
          `Path escape blocked: ${context.filePath} resolves outside project ${project.name}`,
        );
      }

      // Create the parent directory. A new project starts empty, so the first
      // file an agent writes is almost always nested — `src/index.js`,
      // `docs/README.md` — and `writeFileSync` answers a missing directory with
      // ENOENT. Measured 2026-08-17: the containment guard correctly refused
      // three escape attempts and then the LEGITIMATE write failed, which is the
      // combination most likely to read as "the tool is broken".
      //
      // Safe to do after the containment check, not before: `fullPath` is by then
      // known to be inside the project, so this cannot create a directory
      // anywhere else.
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, context.content, 'utf-8');
      return { success: true, message: `Saved ${context.filePath}` };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});

export const runExternalProjectCommandTool = createTool({
  id: 'runExternalProjectCommand',
  description: 'Runs a terminal command in the external project',
  inputSchema: z.object({
    projectName: z.string().describe('Project name'),
    command: z.string().describe('Shell command (e.g. npm run build)'),
  }),
  execute: async (context) => {
    try {
      const project = getOrCreateExternalProject(context.projectName);
      const { stdout, stderr, exitCode, timedOut } = await runCommand(context.command, project.path, RUN_COMMAND_TIMEOUT_MS);
      if (timedOut) {
        return { success: false, error: `Command timed out after ${RUN_COMMAND_TIMEOUT_MS / 1000}s`, output: stdout || stderr };
      }
      if (exitCode !== 0) {
        return { success: false, error: `Command exited with code ${exitCode}`, output: stdout || stderr };
      }
      return { success: true, output: stdout };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});

export const delegateToReviewerTool = createTool({
  id: 'delegateToReviewer',
  description: 'Delegates code or architecture to a sub-agent (Code Review Agent) for verification',
  inputSchema: z.object({
    context: z.string().describe('Description of what was done and the code to review'),
  }),
  execute: async (context) => {
    try {
      const harnessResult = await generateReview({
        agent: codeReviewAgent,
        prompt: `As a reviewing sub-agent, check the following context and code. Provide a concise, expert assessment of whether it is safe and correct:\n\n${context.context}`,
        timeoutMs: 120_000,

      });
      
      return { success: true, review: harnessResult.outputPreview };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});
