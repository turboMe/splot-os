import path from 'node:path';
import fs from 'node:fs';

/**
 * Single Source of Truth for all agent workspace and output directories in Splot OS / Mastra.
 * Reads WORKSPACE_ROOT from environment variable with fallback hierarchy.
 */

export function getWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT && process.env.WORKSPACE_ROOT.trim()) {
    return path.resolve(process.env.WORKSPACE_ROOT.trim());
  }

  // Graceful fallback for existing Jarvis-Projects directory
  if (fs.existsSync('/projekty/splot-projects')) {
    return '/projekty/splot-projects';
  }

  // Default project-relative workspace
  return path.resolve(process.cwd(), 'workspace');
}

export function getProjectsDir(): string {
  if (process.env.AGENT_PROJECTS_DIR && process.env.AGENT_PROJECTS_DIR.trim()) {
    return path.resolve(process.env.AGENT_PROJECTS_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'projects');
}

export function getMenuBooksDir(): string {
  if (process.env.CHEF_DOCS_DIR && process.env.CHEF_DOCS_DIR.trim()) {
    return path.resolve(process.env.CHEF_DOCS_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'menu-books');
}

export function getContentPacksDir(): string {
  if (process.env.CONTENT_DOCS_DIR && process.env.CONTENT_DOCS_DIR.trim()) {
    return path.resolve(process.env.CONTENT_DOCS_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'content-packs');
}

export function getWriterBooksDir(): string {
  if (process.env.WRITER_DOCS_DIR && process.env.WRITER_DOCS_DIR.trim()) {
    return path.resolve(process.env.WRITER_DOCS_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'writer-books');
}

export function getHuntReportsDir(): string {
  if (process.env.HUNT_DOCS_DIR && process.env.HUNT_DOCS_DIR.trim()) {
    return path.resolve(process.env.HUNT_DOCS_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'hunt-reports');
}

export function getDesignOutputDir(): string {
  if (process.env.DESIGN_OUTPUT_DIR && process.env.DESIGN_OUTPUT_DIR.trim()) {
    return path.resolve(process.env.DESIGN_OUTPUT_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'design');
}

export function getMediaOutputDir(): string {
  if (process.env.MEDIA_OUTPUT_DIR && process.env.MEDIA_OUTPUT_DIR.trim()) {
    return path.resolve(process.env.MEDIA_OUTPUT_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'media');
}

export function getDraftsDir(): string {
  if (process.env.DRAFTS_DIR && process.env.DRAFTS_DIR.trim()) {
    return path.resolve(process.env.DRAFTS_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'drafts');
}

export function getArtifactsDir(): string {
  if (process.env.MASTRA_ARTIFACT_DIR && process.env.MASTRA_ARTIFACT_DIR.trim()) {
    return path.resolve(process.env.MASTRA_ARTIFACT_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'artifacts');
}

export function getAudioOutputDir(): string {
  if (process.env.AUDIO_OUTPUT_DIR && process.env.AUDIO_OUTPUT_DIR.trim()) {
    return path.resolve(process.env.AUDIO_OUTPUT_DIR.trim());
  }
  return path.join(getWorkspaceRoot(), 'audio');
}

/**
 * Ensures that all primary workspace directories exist on disk.
 */
export async function ensureWorkspaceDirs(): Promise<void> {
  const dirs = [
    getWorkspaceRoot(),
    getProjectsDir(),
    getMenuBooksDir(),
    getContentPacksDir(),
    getWriterBooksDir(),
    getHuntReportsDir(),
    getDesignOutputDir(),
    getMediaOutputDir(),
    getDraftsDir(),
    path.join(getDraftsDir(), 'email'),
    path.join(getDraftsDir(), 'social'),
    getArtifactsDir(),
    path.join(getArtifactsDir(), 'debates'),
    getAudioOutputDir(),
    path.join(getWorkspaceRoot(), 'media', 'generations', 'audio'),
  ];

  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.warn(`[workspace-paths] Could not create directory ${dir}:`, (err as Error).message);
    }
  }
}
