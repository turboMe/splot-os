import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';

const execFileAsync = promisify(execFile);

export const YOUTUBE_PROJECTS_ROOT =
  process.env.YOUTUBE_PROJECTS_ROOT || '/projekty/splot-projects/youtube-agent';
export const VIDEO_ENGINE_ROOT =
  process.env.VIDEO_ENGINE_ROOT ||
  (existsSync(path.join(YOUTUBE_PROJECTS_ROOT, 'engine'))
    ? path.join(YOUTUBE_PROJECTS_ROOT, 'engine')
    : path.resolve(process.cwd(), 'video-engine'));
export const VIDEO_TOOLS_DIR = path.join(VIDEO_ENGINE_ROOT, 'tools');
export const VIDEO_MEDIA_DIR = path.join(YOUTUBE_PROJECTS_ROOT, 'media', 'library');
export const VIDEO_REMOTION_DIR = path.join(VIDEO_ENGINE_ROOT, 'remotion');

let remotionProcess: ChildProcess | null = null;

export interface RunPythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runVideoScript(
  scriptName: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
): Promise<RunPythonResult> {
  const scriptPath = path.join(VIDEO_TOOLS_DIR, scriptName);
  const cwd = options?.cwd || VIDEO_ENGINE_ROOT;
  const env = { ...process.env, ...options?.env };
  const timeout = options?.timeoutMs || 600000; // 10 mins default

  try {
    const { stdout, stderr } = await execFileAsync('python3', [scriptPath, ...args], {
      cwd,
      env,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    throw new Error(
      `Video tool error [${scriptName}]: ${error.stderr || error.stdout || error.message || 'Execution failed'}`
    );
  }
}

export async function ensureVideoProjectStructure(projectFolder: string): Promise<{
  projectPath: string;
  outputDir: string;
  workDir: string;
  audioDir: string;
  transcriptsDir: string;
  shotsDir: string;
  packagingDir: string;
}> {
  const projectPath = path.isAbsolute(projectFolder)
    ? projectFolder
    : path.join(YOUTUBE_PROJECTS_ROOT, 'videos', projectFolder);

  const projectName = path.basename(projectPath);
  const outputDir = path.join(YOUTUBE_PROJECTS_ROOT, 'output', projectName);
  const workDir = path.join(projectPath, 'work');
  const audioDir = path.join(workDir, 'audio');
  const transcriptsDir = path.join(workDir, 'transcripts');
  const shotsDir = path.join(workDir, 'shots');
  const packagingDir = path.join(projectPath, 'packaging');

  await fs.mkdir(audioDir, { recursive: true });
  await fs.mkdir(transcriptsDir, { recursive: true });
  await fs.mkdir(shotsDir, { recursive: true });
  await fs.mkdir(packagingDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(VIDEO_MEDIA_DIR, { recursive: true });

  return {
    projectPath,
    outputDir,
    workDir,
    audioDir,
    transcriptsDir,
    shotsDir,
    packagingDir,
  };
}

export const REMOTION_PORT = process.env.REMOTION_PORT || '3333';

export async function checkRemotionStudioRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${REMOTION_PORT}`, { timeout: 1500 }, (res) => {
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function startRemotionStudio(): Promise<{ status: string; url: string; pid?: number }> {
  const isRunning = await checkRemotionStudioRunning();
  if (isRunning) {
    return { status: 'already_running', url: `http://localhost:${REMOTION_PORT}` };
  }

  if (remotionProcess && !remotionProcess.killed) {
    try {
      remotionProcess.kill('SIGTERM');
    } catch {}
  }

  remotionProcess = spawn('npx', ['remotion', 'studio', 'src/index.ts', `--port=${REMOTION_PORT}`], {
    cwd: VIDEO_REMOTION_DIR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: REMOTION_PORT },
  });

  remotionProcess.unref();

  // Wait a moment for server to start up
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 600));
    if (await checkRemotionStudioRunning()) {
      return { status: 'started', url: `http://localhost:${REMOTION_PORT}`, pid: remotionProcess.pid };
    }
  }

  return { status: 'starting', url: `http://localhost:${REMOTION_PORT}`, pid: remotionProcess.pid };
}

export async function stopRemotionStudio(): Promise<{ status: string }> {
  if (remotionProcess && !remotionProcess.killed) {
    try {
      remotionProcess.kill('SIGTERM');
    } catch {}
  }
  try {
    const { exec } = await import('node:child_process');
    await new Promise((res) => exec(`fuser -k ${REMOTION_PORT}/tcp || true`, res));
  } catch {}
  return { status: 'stopped' };
}

export interface YoutubeProjectSummary {
  id: string;
  name: string;
  path: string;
  hasRawVideo: boolean;
  hasMasterCut: boolean;
  hasFinal4K: boolean;
  hasThumbnail: boolean;
  thumbnailUrl?: string;
  videoUrl?: string;
  rawVideoUrl?: string;
  transcripts: string[];
  metadata?: any;
  updatedAt: string;
}

export async function listYoutubeProjects(): Promise<YoutubeProjectSummary[]> {
  const videosDir = path.join(YOUTUBE_PROJECTS_ROOT, 'videos');
  const outputRoot = path.join(YOUTUBE_PROJECTS_ROOT, 'output');
  await fs.mkdir(videosDir, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });

  const entries = await fs.readdir(videosDir, { withFileTypes: true });
  const projects: YoutubeProjectSummary[] = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const projId = ent.name;
    const projPath = path.join(videosDir, projId);
    const projOutDir = path.join(outputRoot, projId);

    const hasRawVideo = existsSync(path.join(projPath, 'raw.mp4'));
    const masterCutInProj = path.join(projPath, 'work', 'master_cut.mp4');
    const masterCutInOut = path.join(projOutDir, 'master_cut.mp4');
    const final4kInOut = path.join(projOutDir, 'final_baked_4k.mp4');

    const hasMasterCut = existsSync(masterCutInOut) || existsSync(masterCutInProj);
    const hasFinal4K = existsSync(final4kInOut);

    // Thumbnails
    const thumbsDir = path.join(projPath, 'packaging', 'thumbs');
    let hasThumbnail = false;
    let thumbnailUrl: string | undefined;
    if (existsSync(thumbsDir)) {
      try {
        const thumbFiles = await fs.readdir(thumbsDir);
        const img = thumbFiles.find((f) => f.endsWith('.png') || f.endsWith('.jpg'));
        if (img) {
          hasThumbnail = true;
          thumbnailUrl = `/ws/youtube/projects/${encodeURIComponent(projId)}/thumbnail?file=${encodeURIComponent(img)}`;
        }
      } catch {}
    }

    // Metadata
    let metadata: any = null;
    const metaPath = path.join(projPath, 'packaging', 'metadata.json');
    if (existsSync(metaPath)) {
      try {
        metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      } catch {}
    }

    let stats;
    try {
      stats = await fs.stat(projPath);
    } catch {
      stats = { mtime: new Date() };
    }

    projects.push({
      id: projId,
      name: metadata?.title || projId,
      path: projPath,
      hasRawVideo,
      hasMasterCut,
      hasFinal4K,
      hasThumbnail,
      thumbnailUrl,
      videoUrl: hasFinal4K || hasMasterCut ? `/ws/youtube/projects/${encodeURIComponent(projId)}/video` : undefined,
      rawVideoUrl: hasRawVideo ? `/ws/youtube/projects/${encodeURIComponent(projId)}/video?raw=1` : undefined,
      transcripts: [],
      metadata,
      updatedAt: stats.mtime.toISOString(),
    });
  }

  return projects.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
}

