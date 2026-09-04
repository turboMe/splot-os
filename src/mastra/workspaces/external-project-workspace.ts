/**
 * External Project Factory (Etap 10.4)
 *
 * Creates isolated directories for coding OTHER projects — not the agent itself.
 * Each project gets its own directory under /projekty/agent-projects/<name>.
 *
 * Isolation is three path guards, not a sandboxed runtime (H4, 2026-08-23):
 * this used to also construct a full `Workspace` (own filesystem, LocalSandbox,
 * LSP, bm25 indexing, a tool-policy block with its own approval-gated
 * `execute_command`) per project. Nothing in `src/` ever read `project.workspace`
 * — every consumer (`external-projects-tools.ts`) only ever used `project.path`,
 * reading and writing through its own guarded `runCommand`/`writeExternalProjectFileTool`
 * instead of the Workspace's tools. That made the isolation claim in the old
 * docstring false: real containment comes from `getOrCreateExternalProject`
 * refusing to create a project inside the agent's own directory, name
 * sanitization, and `writeExternalProjectFile`'s `checkPathInsideRoot` guard
 * (`lib/path-containment.ts`) — documented in `docs/MIGRACJA-DOMENY-CODING.md`
 * §"Na czym NAPRAWDĘ stoi izolacja trybu 2". This was the seventh instance of
 * "built and never wired" found in this project; the other six all cost a real
 * investigation before someone noticed the gap. Removed here rather than wired
 * up because nothing has ever needed a sandboxed runtime per external project —
 * `runExternalProjectCommand` already runs arbitrary commands (K15's bounded
 * `spawn`, not a Workspace sandbox), and if that changes, constructing a real
 * Workspace at that call site is one `new Workspace(...)` away.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { getProjectsDir } from '../config/workspace-paths.js';

// ── Config ───────────────────────────────────────────────────────────────────

export const AGENT_PROJECTS_BASE = getProjectsDir();

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExternalProject {
  name: string;
  path: string;
  createdAt: string;
}

// ── Registry (in-memory, populated at runtime) ───────────────────────────────

const projectRegistry = new Map<string, ExternalProject>();

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create or get an external project's directory.
 *
 * @param projectName - Name of the project (alphanumeric + dashes)
 * @param options - Optional overrides
 * @returns ExternalProject with its path ready on disk
 */
export function getOrCreateExternalProject(
  projectName: string,
  options?: {
    initGit?: boolean;       // git init (default: true)
    initNpm?: boolean;       // npm init -y (default: false)
    template?: 'empty' | 'typescript' | 'node';  // scaffold template
  },
): ExternalProject {
  // Sanitize project name
  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');

  // Return from cache if already registered
  const cached = projectRegistry.get(sanitized);
  if (cached) return cached;

  // Build path — check if an existing directory matches case-insensitively
  let projectDir = resolve(AGENT_PROJECTS_BASE, sanitized);
  if (existsSync(AGENT_PROJECTS_BASE)) {
    try {
      const entries = readdirSync(AGENT_PROJECTS_BASE) as string[];
      const match = entries.find((e) => e.toLowerCase() === sanitized);
      if (match) {
        projectDir = resolve(AGENT_PROJECTS_BASE, match);
      }
    } catch {
      // fallback to sanitized path
    }
  }

  // ── Safety check: block access to agent's own code ──
  const agentDir = '/projekty/mastra-agentic-environment';
  if (projectDir.startsWith(agentDir)) {
    throw new Error(
      `[ExternalProject] BLOCKED: Cannot create external project inside agent's own directory (${agentDir}). ` +
      `Use the code-workspace for self-modifications.`
    );
  }

  // Create directory if needed
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
    console.log(`[ExternalProject] Created project directory: ${projectDir}`);

    // Optional: git init
    if (options?.initGit !== false) {
      try {
        execSync('git init', { cwd: projectDir, stdio: 'pipe' });
        console.log(`[ExternalProject] Initialized git repo`);
      } catch (e) {
        console.warn(`[ExternalProject] git init failed (non-critical)`);
      }
    }

    // Optional: npm init
    if (options?.initNpm) {
      try {
        execSync('npm init -y', { cwd: projectDir, stdio: 'pipe' });
        console.log(`[ExternalProject] Initialized npm package`);
      } catch (e) {
        console.warn(`[ExternalProject] npm init failed (non-critical)`);
      }
    }

    // Optional: TypeScript template
    if (options?.template === 'typescript') {
      try {
        execSync('npm init -y && npm install --save-dev typescript @types/node', {
          cwd: projectDir,
          stdio: 'pipe',
          timeout: 60000,
        });
        execSync('npx tsc --init --target es2022 --module nodenext --outDir dist --rootDir src', {
          cwd: projectDir,
          stdio: 'pipe',
        });
        mkdirSync(resolve(projectDir, 'src'), { recursive: true });
        console.log(`[ExternalProject] TypeScript template applied`);
      } catch (e) {
        console.warn(`[ExternalProject] TypeScript template setup failed (non-critical)`);
      }
    }
  }

  const project: ExternalProject = {
    name: sanitized,
    path: projectDir,
    createdAt: new Date().toISOString(),
  };

  projectRegistry.set(sanitized, project);
  return project;
}

// ── Listing ──────────────────────────────────────────────────────────────────

/**
 * List all external projects (from disk + registry).
 */
export function listExternalProjects(): Array<{ name: string; path: string; hasGit: boolean }> {
  const results: Array<{ name: string; path: string; hasGit: boolean }> = [];

  if (!existsSync(AGENT_PROJECTS_BASE)) return results;

  try {
    const entries = readdirSync(AGENT_PROJECTS_BASE) as string[];

    for (const entry of entries) {
      const fullPath = resolve(AGENT_PROJECTS_BASE, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          results.push({
            name: entry,
            path: fullPath,
            hasGit: existsSync(resolve(fullPath, '.git')),
          });
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Base dir not readable
  }

  return results;
}

/**
 * Get an existing external project (without creating).
 * Returns null if project doesn't exist.
 */
export function getExternalProject(projectName: string): ExternalProject | null {
  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');

  // Check cache first
  const cached = projectRegistry.get(sanitized);
  if (cached) return cached;

  // Check disk
  const projectDir = resolve(AGENT_PROJECTS_BASE, sanitized);
  if (!existsSync(projectDir)) return null;

  // Lazy init: register it now that we know the directory exists
  return getOrCreateExternalProject(sanitized);
}
