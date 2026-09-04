/**
 * VoiceStudio Service (SPLOT OS)
 *
 * Provides deterministic integration with the local VoiceStudio (OmniVoice) running in Docker:
 *   - Container lifecycle & auto-start (ensureContainerRunning)
 *   - Dual-voice profile resolution:
 *       * Polish (PL): 'eab289ea' (patryk-polish-voice)
 *       * English (EN): 'c310508f' (patryk-english-voice)
 *   - Audiobook SSE streaming synthesis (POST /audiobook)
 *   - Artifact persistence to /projekty/splot-projects/writer-books/<slug>/audio/
 *     or /projekty/splot-projects/media/generations/audio/
 *   - Two-Stage VRAM Management (Wariant A):
 *       Stage 1: Immediate Soft Flush (POST /system/flush-memory?unload_model=true) right after generation
 *       Stage 2: Debounced Hard Zero (docker stop omnivoice) after idle timeout (default 5 min)
 */

import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getWorkspaceRoot, getWriterBooksDir, getAudioOutputDir } from '../config/workspace-paths.js';
import { fetchWithDeadline } from '../lib/http-deadline.js';

const execAsync = promisify(exec);

// ── Voice Profiles Definition ───────────────────────────────────────────────

export const PATRYK_VOICES = {
  pl: {
    id: 'eab289ea',
    name: 'patryk-polish-voice',
    language: 'Polish',
    iso: 'pl',
  },
  en: {
    id: 'c310508f',
    name: 'patryk-english-voice',
    language: 'English',
    iso: 'en',
  },
} as const;

export type VoiceLanguage = 'pl' | 'en' | 'auto';

export interface VoiceStudioHealth {
  available: boolean;
  containerRunning: boolean;
  device?: string;
  version?: string;
  error?: string;
}

export interface VoiceStudioAudiobookParams {
  text: string;
  language?: VoiceLanguage;
  voiceProfileId?: string;
  projectSlug?: string;
  title?: string;
  author?: string;
  format?: 'm4b' | 'mp3';
  bitrate?: '128k' | '192k';
  loudness?: 'acx' | 'podcast' | 'ebu_r128' | 'off';
  voiceMap?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Postprocessing silences control. Defaults to false.
   * When false, disables aggressive -50 dBFS silence trimming / noise gate,
   * preserving natural vocal decay, breathing, and room acoustics between sentences.
   */
  postprocessOutput?: boolean;
}

export interface VoiceStudioAudiobookResult {
  success: boolean;
  jobId?: string;
  filename: string;
  audioPath: string;
  metadataPath: string;
  durationSeconds: number;
  chaptersCount: number;
  format: 'm4b' | 'mp3';
  language: string;
  voiceProfileId: string;
  voiceName: string;
  loudness?: string;
  vramFlushed: boolean;
  durationMs: number;
  error?: string;
}

export interface VoiceStudioProgressEvent {
  type: string;
  chapter?: number;
  status?: string;
  output?: string;
  error?: string;
}

// ── VoiceStudio Service Class ───────────────────────────────────────────────

export class VoiceStudioService {
  private readonly apiUrl: string;
  private readonly containerName: string;
  private readonly hostOutputsDir: string;
  private hardShutdownTimer: NodeJS.Timeout | null = null;
  private readonly idleHardShutdownDelayMs: number;

  constructor(options?: {
    apiUrl?: string;
    containerName?: string;
    hostOutputsDir?: string;
    idleHardShutdownDelayMs?: number;
  }) {
    this.apiUrl = options?.apiUrl || process.env.VOICESTUDIO_API_URL || 'http://127.0.0.1:3900';
    this.containerName = options?.containerName || process.env.VOICESTUDIO_CONTAINER || 'omnivoice';
    const homeDir = process.env.HOME || '/home/linus';
    this.hostOutputsDir = options?.hostOutputsDir || join(homeDir, 'omnivoice-data', 'user', 'outputs');
    this.idleHardShutdownDelayMs = options?.idleHardShutdownDelayMs ?? 5 * 60 * 1000; // 5 min idle
  }

  // ── Voice Resolution ────────────────────────────────────────────────────────

  public resolveVoice(language?: string, explicitProfileId?: string): { id: string; name: string; language: string; iso: string } {
    if (explicitProfileId) {
      if (explicitProfileId === PATRYK_VOICES.pl.id) return PATRYK_VOICES.pl;
      if (explicitProfileId === PATRYK_VOICES.en.id) return PATRYK_VOICES.en;
      return { id: explicitProfileId, name: explicitProfileId, language: language || 'Auto', iso: (language || 'pl').slice(0, 2).toLowerCase() };
    }

    const lang = (language || 'pl').toLowerCase();
    if (lang === 'en' || lang === 'english' || lang === 'angielski') {
      return PATRYK_VOICES.en;
    }

    // Default to Polish voice
    return PATRYK_VOICES.pl;
  }

  // ── Health and Lifecycle ───────────────────────────────────────────────────

  public isContainerRunning(): boolean {
    try {
      const state = execSync(`docker inspect --format '{{.State.Status}}' ${this.containerName} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      return state === 'running';
    } catch {
      return false;
    }
  }

  public async checkHealth(): Promise<VoiceStudioHealth> {
    const running = this.isContainerRunning();
    if (!running) {
      return { available: false, containerRunning: false };
    }

    try {
      const res = await fetchWithDeadline(`${this.apiUrl}/health`, {
        timeoutMs: 3000,
      });

      if (!res.ok) {
        return { available: false, containerRunning: true, error: `HTTP ${res.status}` };
      }

      const body = (await res.json()) as any;
      return {
        available: body.status === 'ok',
        containerRunning: true,
        device: body.device,
        version: body.version,
      };
    } catch (err: any) {
      return {
        available: false,
        containerRunning: true,
        error: err?.message || String(err),
      };
    }
  }

  public async ensureContainerRunning(maxWaitSeconds = 25): Promise<boolean> {
    this.cancelDebouncedHardShutdown();

    if (this.isContainerRunning()) {
      const health = await this.checkHealth();
      if (health.available) return true;
    }

    console.log(`[VoiceStudioService] Starting Docker container "${this.containerName}"...`);
    try {
      await execAsync(`docker start ${this.containerName}`);
    } catch (err: any) {
      console.error(`[VoiceStudioService] Failed to start container ${this.containerName}:`, err.message);
      return false;
    }

    // Poll health check
    const start = Date.now();
    const timeoutMs = maxWaitSeconds * 1000;
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetchWithDeadline(`${this.apiUrl}/health`, { timeoutMs: 1500 });
        if (res.ok) {
          const body = (await res.json()) as any;
          if (body.status === 'ok') {
            console.log(`[VoiceStudioService] Container "${this.containerName}" is ready on device: ${body.device}`);
            return true;
          }
        }
      } catch {
        // Still warming up
      }
      await new Promise((r) => setTimeout(r, 600));
    }

    console.error(`[VoiceStudioService] Timed out waiting for container ${this.containerName} health check.`);
    return false;
  }

  // ── Two-Stage VRAM Management (Wariant A) ───────────────────────────────────

  /**
   * Stage 1: Soft Flush (Unload AI models, run PyTorch GC and empty CUDA cache)
   * Executes via loopback call inside container to bypass Docker NAT auth barrier.
   */
  public async flushVram(): Promise<{ success: boolean; error?: string; vramAfter?: number }> {
    try {
      console.log('[VoiceStudioService] [Stage 1] Executing Soft Flush (unloading model weights & clearing VRAM)...');
      const { stdout } = await execAsync(
        `docker exec ${this.containerName} curl -s -X POST "http://127.0.0.1:3900/system/flush-memory?unload_model=true"`,
        { timeout: 10000 },
      );

      const parsed = JSON.parse(stdout);
      console.log('[VoiceStudioService] [Stage 1] Flush result:', parsed);
      return {
        success: parsed.flushed === true,
        vramAfter: parsed.vram_after,
      };
    } catch (err: any) {
      console.warn('[VoiceStudioService] [Stage 1] Soft flush warning:', err?.message || err);
      return { success: false, error: err?.message || String(err) };
    }
  }

  /**
   * Stage 2: Hard Zero (Stop container to completely free 100% of VRAM to 0 MiB)
   */
  public async stopContainer(): Promise<{ success: boolean; error?: string }> {
    this.cancelDebouncedHardShutdown();
    if (!this.isContainerRunning()) {
      return { success: true };
    }

    console.log(`[VoiceStudioService] [Stage 2] Executing Hard Zero: stopping container "${this.containerName}"...`);
    try {
      await execAsync(`docker stop ${this.containerName}`, { timeout: 15000 });
      console.log(`[VoiceStudioService] [Stage 2] Container stopped. VRAM zeroed (0 MiB).`);
      return { success: true };
    } catch (err: any) {
      console.error(`[VoiceStudioService] [Stage 2] Error stopping container:`, err?.message || err);
      return { success: false, error: err?.message || String(err) };
    }
  }

  public cancelDebouncedHardShutdown(): void {
    if (this.hardShutdownTimer) {
      clearTimeout(this.hardShutdownTimer);
      this.hardShutdownTimer = null;
    }
  }

  public scheduleDebouncedHardShutdown(delayMs?: number): void {
    this.cancelDebouncedHardShutdown();
    const wait = delayMs ?? this.idleHardShutdownDelayMs;

    console.log(`[VoiceStudioService] Scheduled Hard Zero container shutdown in ${Math.round(wait / 1000)}s.`);
    this.hardShutdownTimer = setTimeout(async () => {
      try {
        await this.stopContainer();
      } catch {
        // Non-critical background teardown
      } finally {
        this.hardShutdownTimer = null;
      }
    }, wait);
  }

  // ── Generation Engine ──────────────────────────────────────────────────────

  public async generateAudiobook(params: VoiceStudioAudiobookParams): Promise<VoiceStudioAudiobookResult> {
    const startTime = Date.now();
    const isUp = await this.ensureContainerRunning();
    if (!isUp) {
      throw new Error(`VoiceStudio container "${this.containerName}" is unavailable and failed to start.`);
    }

    const voice = this.resolveVoice(params.language, params.voiceProfileId);
    const format = params.format || 'm4b';
    const bitrate = params.bitrate || '128k';
    const loudness = params.loudness || 'acx';
    const bookTitle = params.title || 'Audiobook';
    const author = params.author || 'Patryk';

    console.log(`[VoiceStudioService] Starting Audiobook render for "${bookTitle}" with voice: ${voice.name} (${voice.id})`);

    const requestPayload = {
      text: params.text,
      default_voice: voice.id,
      language: voice.iso === 'en' ? 'en' : 'pl',
      format,
      bitrate,
      loudness: loudness === 'off' ? null : loudness,
      postprocess_output: params.postprocessOutput ?? false,
      metadata: {
        title: bookTitle,
        author,
        narrator: author,
      },
      voice_map: params.voiceMap || undefined,
    };

    const endpoint = `${this.apiUrl}/audiobook`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(requestPayload),
    });

    if (!response.ok || !response.body) {
      throw new Error(`VoiceStudio API error: ${response.status} ${response.statusText}`);
    }

    // Process SSE stream
    let doneEvent: any = null;
    let totalChapters = 0;
    let durationSeconds = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const rawJson = trimmed.slice(6).trim();
            if (!rawJson) continue;
            try {
              const event: VoiceStudioProgressEvent = JSON.parse(rawJson);
              if (event.type === 'plan') {
                // Chapters planned
              } else if (event.type === 'chapter' && event.status === 'done') {
                totalChapters = Math.max(totalChapters, (event.chapter ?? 0) + 1);
              } else if (event.type === 'done') {
                doneEvent = event;
              } else if (event.type === 'error') {
                throw new Error(`VoiceStudio generation error: ${event.error}`);
              }
            } catch (parseErr: any) {
              if (parseErr.message?.includes('VoiceStudio generation error')) {
                throw parseErr;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!doneEvent || !doneEvent.output) {
      throw new Error('VoiceStudio render finished without providing an output file.');
    }

    const generatedFilename = doneEvent.output;
    durationSeconds = doneEvent.duration_s || 0;
    totalChapters = doneEvent.chapters || totalChapters;

    // Relocate to destination in Jarvis-Projects
    const sourceFilePath = join(this.hostOutputsDir, generatedFilename);
    if (!existsSync(sourceFilePath)) {
      throw new Error(`Expected generated file does not exist at host path: ${sourceFilePath}`);
    }

    let targetDir = join(getAudioOutputDir());
    if (params.projectSlug) {
      targetDir = join(getWriterBooksDir(), params.projectSlug, 'audio');
    }

    await mkdir(targetDir, { recursive: true });

    const safeTitle = bookTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'audio';

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const finalFilename = `${safeTitle}_${voice.iso}_${timestamp}.${format}`;
    const targetAudioPath = join(targetDir, finalFilename);
    const targetMetadataPath = join(targetDir, `${safeTitle}_${voice.iso}_${timestamp}.meta.json`);

    await copyFile(sourceFilePath, targetAudioPath);

    const metadataPayload = {
      title: bookTitle,
      author,
      language: voice.language,
      voiceProfileId: voice.id,
      voiceName: voice.name,
      format,
      bitrate,
      loudness,
      durationSeconds,
      chaptersCount: totalChapters,
      originalOutputName: generatedFilename,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };

    await writeFile(targetMetadataPath, JSON.stringify(metadataPayload, null, 2), 'utf-8');

    // ── VRAM Management (Wariant A) ──
    // Step 1: Immediate soft flush to unload model weights
    const flushRes = await this.flushVram();

    // Step 2: Schedule debounced hard zero shutdown (5 min)
    this.scheduleDebouncedHardShutdown();

    return {
      success: true,
      jobId: doneEvent.output.replace(/^audiobook_|\.[^.]+$/g, ''),
      filename: finalFilename,
      audioPath: targetAudioPath,
      metadataPath: targetMetadataPath,
      durationSeconds,
      chaptersCount: totalChapters,
      format,
      language: voice.language,
      voiceProfileId: voice.id,
      voiceName: voice.name,
      loudness,
      vramFlushed: flushRes.success,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Generates dual-language audiobooks when requested ("w obu językach").
   * Renders Polish version first with Polish voice, then English version with English voice.
   */
  public async generateDualAudiobook(
    polishText: string,
    englishText: string,
    params: Omit<VoiceStudioAudiobookParams, 'text' | 'language' | 'voiceProfileId'>,
  ): Promise<{
    polish: VoiceStudioAudiobookResult;
    english: VoiceStudioAudiobookResult;
  }> {
    console.log('[VoiceStudioService] Generating Dual-Language Audiobook (PL + EN)...');

    const polishResult = await this.generateAudiobook({
      ...params,
      text: polishText,
      language: 'pl',
      voiceProfileId: PATRYK_VOICES.pl.id,
    });

    const englishResult = await this.generateAudiobook({
      ...params,
      text: englishText,
      language: 'en',
      voiceProfileId: PATRYK_VOICES.en.id,
    });

    return {
      polish: polishResult,
      english: englishResult,
    };
  }
}

// ── Singleton Instance ───────────────────────────────────────────────────────

let defaultInstance: VoiceStudioService | null = null;

export function getVoiceStudioService(): VoiceStudioService {
  if (!defaultInstance) {
    defaultInstance = new VoiceStudioService();
  }
  return defaultInstance;
}
