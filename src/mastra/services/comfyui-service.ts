/**
 * ComfyUI Visual Studio Service (SPLOT OS)
 *
 * Provides deterministic integration with the local ComfyUI instance:
 *   - Health checking and queue state monitoring
 *   - Base workflow manipulation for `txt2img - najlepszy (2 twarze AUTO-PŁEĆ)`
 *   - Aspect ratio mapping, Seed generation, LoRA matrix injection
 *   - Face Detailer identity adaptation (single-man pa1rykman rule)
 *   - Artifact persistence to /projekty/splot-projects/media/generations/
 *   - Debounced VRAM Cleaner (unloads GPU weights after queue settles to 0)
 */

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithDeadline } from '../lib/http-deadline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ────────────────────────────────────────────────────────────────────

export type AspectRatio = '16:9' | '9:16' | '2:3' | '4:5' | '3:4' | '4:3' | '1:1' | '21:9' | 'custom';

export type GenerationCategory =
  | 'portraits'
  | 'fantasy-covers'
  | 'marketing-assets'
  | 'video-storyboards'
  | 'art-concepts'
  | 'general';

export interface ComfyUiGenerateParams {
  prompt: string;
  negativePrompt?: string;
  category?: GenerationCategory;
  aspectRatio?: AspectRatio;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  loraPatrykEnabled?: boolean;
  loraPatrykStrength?: number;
  loraRealismEnabled?: boolean;
  loraRealismStrength?: number;
  loraAfterlightEnabled?: boolean;
  loraAfterlightStrength?: number;
  loraGirlEnabled?: boolean;
  loraGirlStrength?: number;
  upscaleBy?: number;
  timeoutMs?: number;
}

export interface ComfyUiGenerateResult {
  success: boolean;
  promptId: string;
  filename: string;
  imagePath: string;
  metadataPath: string;
  category: string;
  aspectRatio: string;
  dimensions: { width: number; height: number };
  seed: number;
  durationMs: number;
  error?: string;
}

export interface ComfyUiQueueStatus {
  running: any[];
  pending: any[];
  totalRemaining: number;
}

export interface ComfyUiHealthStatus {
  available: boolean;
  apiUrl: string;
  devices?: any[];
  vram?: {
    total: number;
    free: number;
  };
  error?: string;
}

// ── Resolution Map ───────────────────────────────────────────────────────────

export const ASPECT_RATIO_DIMENSIONS: Record<Exclude<AspectRatio, 'custom'>, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '2:3':  { width: 832, height: 1248 },
  '4:5':  { width: 896, height: 1120 },
  '3:4':  { width: 896, height: 1194 },
  '4:3':  { width: 1194, height: 896 },
  '1:1':  { width: 1024, height: 1024 },
  '21:9': { width: 1344, height: 576 },
};

// ── Service Class ────────────────────────────────────────────────────────────

export class ComfyUiService {
  private apiUrl: string;
  private outputRoot: string;
  private comfyOutputDir: string;
  private templatePath: string;
  private vramReleaseDelayMs: number;
  private vramCleanupTimer: NodeJS.Timeout | null = null;

  constructor(options?: {
    apiUrl?: string;
    outputRoot?: string;
    comfyOutputDir?: string;
    templatePath?: string;
    vramReleaseDelayMs?: number;
  }) {
    this.apiUrl = options?.apiUrl || process.env.COMFYUI_API_URL || 'http://localhost:8188';
    this.outputRoot = options?.outputRoot || process.env.COMFYUI_OUTPUT_ROOT || '/projekty/splot-projects/media/generations';
    this.comfyOutputDir = options?.comfyOutputDir || process.env.COMFYUI_SERVER_OUTPUT_DIR || '/home/linus/ComfyUI-output';
    this.templatePath = options?.templatePath || process.env.COMFYUI_WORKFLOW_TEMPLATE || join(__dirname, 'comfyui/txt2img-base-graph.json');
    this.vramReleaseDelayMs = options?.vramReleaseDelayMs ?? (parseInt(process.env.COMFYUI_VRAM_RELEASE_DELAY_SEC || '60', 10) * 1000);
  }

  // ── Health & Status ────────────────────────────────────────────────────────

  async checkHealth(): Promise<ComfyUiHealthStatus> {
    try {
      const res = await fetchWithDeadline(`${this.apiUrl}/system_stats`, {
        method: 'GET',
        timeoutMs: 5000,
      });

      if (!res.ok) {
        return {
          available: false,
          apiUrl: this.apiUrl,
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const data = (await res.json()) as any;
      const device = data?.devices?.[0];

      return {
        available: true,
        apiUrl: this.apiUrl,
        devices: data?.devices,
        vram: device
          ? {
              total: Math.round((device.vram_total || 0) / (1024 * 1024)),
              free: Math.round((device.vram_free || 0) / (1024 * 1024)),
            }
          : undefined,
      };
    } catch (err: any) {
      return {
        available: false,
        apiUrl: this.apiUrl,
        error: err?.message || String(err),
      };
    }
  }

  async getQueue(): Promise<ComfyUiQueueStatus> {
    try {
      const res = await fetchWithDeadline(`${this.apiUrl}/queue`, {
        method: 'GET',
        timeoutMs: 5000,
      });

      if (!res.ok) {
        return { running: [], pending: [], totalRemaining: 0 };
      }

      const data = (await res.json()) as any;
      const running = Array.isArray(data?.queue_running) ? data.queue_running : [];
      const pending = Array.isArray(data?.queue_pending) ? data.queue_pending : [];

      return {
        running,
        pending,
        totalRemaining: running.length + pending.length,
      };
    } catch {
      return { running: [], pending: [], totalRemaining: 0 };
    }
  }

  // ── VRAM Lifecycle ─────────────────────────────────────────────────────────

  async freeVram(options?: { unloadModels?: boolean; freeMemory?: boolean }): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetchWithDeadline(`${this.apiUrl}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unload_models: options?.unloadModels ?? true,
          free_memory: options?.freeMemory ?? true,
        }),
        timeoutMs: 10000,
      });

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}` };
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  cancelDebouncedVramCleanup(): void {
    if (this.vramCleanupTimer) {
      clearTimeout(this.vramCleanupTimer);
      this.vramCleanupTimer = null;
    }
  }

  scheduleDebouncedVramCleanup(delayMs?: number): void {
    this.cancelDebouncedVramCleanup();
    const wait = delayMs ?? this.vramReleaseDelayMs;

    this.vramCleanupTimer = setTimeout(async () => {
      try {
        const queue = await this.getQueue();
        if (queue.totalRemaining === 0) {
          await this.freeVram({ unloadModels: true, freeMemory: true });
        }
      } catch {
        // Non-critical background cleanup failure
      } finally {
        this.vramCleanupTimer = null;
      }
    }, wait);
  }

  // ── Template & Graph Manipulation ──────────────────────────────────────────

  private async loadBaseGraph(): Promise<Record<string, any>> {
    const candidates = [
      this.templatePath,
      join(__dirname, 'comfyui/txt2img-base-graph.json'),
      resolve(process.cwd(), 'src/mastra/services/comfyui/txt2img-base-graph.json'),
      resolve(process.cwd(), '.mastra/output/services/comfyui/txt2img-base-graph.json'),
    ];

    for (const p of candidates) {
      if (!p || !existsSync(p)) continue;

      try {
        const raw = await readFile(p, 'utf-8');
        const parsed = JSON.parse(raw);

        // Check if format is ComfyUI Web UI (contains 'nodes' or 'links' array)
        if (Array.isArray(parsed?.nodes) || Array.isArray(parsed?.links)) {
          console.warn(
            `[ComfyUiService] Candidate "${p}" is in ComfyUI Web UI format (contains nodes/links array), which is incompatible with /prompt API endpoint. Skipping candidate...`
          );
          continue;
        }

        // Check if format contains valid API nodes (numeric/string keys with class_type & inputs)
        const entries = Object.values(parsed);
        const hasApiNodes = entries.some(
          (n: any) => n && typeof n === 'object' && typeof n.class_type === 'string' && typeof n.inputs === 'object'
        );

        if (!hasApiNodes) {
          console.warn(
            `[ComfyUiService] Candidate "${p}" does not contain valid ComfyUI API nodes (class_type/inputs). Skipping candidate...`
          );
          continue;
        }

        return parsed;
      } catch (err: any) {
        console.warn(
          `[ComfyUiService] Error reading/parsing candidate "${p}": ${err?.message || err}. Skipping candidate...`
        );
        continue;
      }
    }

    throw new Error(`ComfyUI base graph template not found in candidates: ${candidates.filter(Boolean).join(', ')}`);
  }

  private mutateGraph(
    baseGraph: Record<string, any>,
    params: ComfyUiGenerateParams,
  ): { graph: Record<string, any>; effectiveSeed: number; dimensions: { width: number; height: number } } {
    const graph = JSON.parse(JSON.stringify(baseGraph));

    // 1. Dimensions
    const ar = params.aspectRatio || '16:9';
    let width = params.width;
    let height = params.height;

    if (!width || !height) {
      if (ar !== 'custom' && ASPECT_RATIO_DIMENSIONS[ar]) {
        width = ASPECT_RATIO_DIMENSIONS[ar].width;
        height = ASPECT_RATIO_DIMENSIONS[ar].height;
      } else {
        width = 1280;
        height = 720;
      }
    }

    if (graph['11']?.inputs) {
      graph['11'].inputs.width = width;
      graph['11'].inputs.height = height;
    } else {
      for (const node of Object.values<any>(graph)) {
        if (node?.class_type === 'EmptyLatentImage' && node.inputs) {
          node.inputs.width = width;
          node.inputs.height = height;
          break;
        }
      }
    }

    // 2. Seed
    const effectiveSeed = params.seed ?? Math.floor(Math.random() * 900_000_000_000_000 + 100_000_000_000_000);
    if (graph['12']?.inputs) {
      graph['12'].inputs.seed = effectiveSeed;
    }
    if (graph['12']?.is_changed) {
      graph['12'].is_changed = [effectiveSeed];
    }

    // 3. Main Prompt
    if (graph['119']?.inputs) {
      graph['119'].inputs.value = params.prompt;
    } else {
      let promptSet = false;
      for (const node of Object.values<any>(graph)) {
        if (node?.class_type === 'PrimitiveStringMultiline' && node.inputs) {
          node.inputs.value = params.prompt;
          promptSet = true;
          break;
        }
      }
      if (!promptSet) {
        console.warn('[ComfyUiService] Could not locate primary prompt node (119 or PrimitiveStringMultiline) in graph.');
      }
    }

    // 4. Power LoRA Loader (Node 30)
    const patrykEnabled = params.loraPatrykEnabled !== false;
    const patrykStrength = params.loraPatrykStrength ?? 1.05;
    const realismEnabled = params.loraRealismEnabled !== false;
    const realismStrength = params.loraRealismStrength ?? 0.3;
    const afterlightEnabled = params.loraAfterlightEnabled !== false;
    const afterlightStrength = params.loraAfterlightStrength ?? 0.2;
    const girlEnabled = !!params.loraGirlEnabled;
    const girlStrength = params.loraGirlStrength ?? 0.8;

    if (graph['30']?.inputs) {
      graph['30'].inputs.lora_2 = {
        on: patrykEnabled,
        lora: 'pa1rykman_krea2.safetensors',
        strength: patrykStrength,
      };
      graph['30'].inputs.lora_8 = {
        on: realismEnabled,
        lora: 'realism_engine_krea2_v3.1.safetensors',
        strength: realismStrength,
      };
      graph['30'].inputs.lora_12 = {
        on: afterlightEnabled,
        lora: 'Afterlight_v1.safetensors',
        strength: afterlightStrength,
      };
      graph['30'].inputs.lora_1 = {
        on: girlEnabled,
        lora: 'ver0girl_krea2.safetensors',
        strength: girlStrength,
      };
    }

    // 5. Face Detailer Male Identity Adaptation (Single-Man Rule)
    if (!patrykEnabled) {
      if (graph['167:1014']?.inputs) {
        graph['167:1014'].inputs.strength_model = 0.0;
        graph['167:1014'].inputs.strength_clip = 0.0;
      }
      if (graph['167:321']?.inputs) {
        graph['167:321'].inputs.strength_model = 0.0;
        graph['167:321'].inputs.strength_clip = 0.0;
      }
      if (graph['167:323']?.inputs) {
        graph['167:323'].inputs.text = 'close-up photo of a face of a man, detailed skin, sharp eyes';
      }
    } else {
      if (graph['167:1014']?.inputs) {
        graph['167:1014'].inputs.strength_model = Math.min(1.0, patrykStrength * 0.95);
        graph['167:1014'].inputs.strength_clip = Math.min(1.0, patrykStrength * 0.93);
      }
      if (graph['167:321']?.inputs) {
        graph['167:321'].inputs.strength_model = Math.min(1.0, patrykStrength * 0.8);
        graph['167:321'].inputs.strength_clip = Math.min(1.0, patrykStrength * 0.7);
      }
      if (graph['167:323']?.inputs) {
        graph['167:323'].inputs.text = 'pa1rykman, close-up photo of a face of a man, detailed skin, stubble, sharp eyes';
      }
    }

    // 6. Optional sampler / steps overrides
    if (params.steps && graph['123']?.inputs) {
      graph['123'].inputs.steps = params.steps;
    }
    if (params.samplerName && graph['123']?.inputs) {
      graph['123'].inputs.sampler_name = params.samplerName;
    }
    if (params.scheduler && graph['123']?.inputs) {
      graph['123'].inputs.scheduler = params.scheduler;
    }

    return {
      graph,
      effectiveSeed,
      dimensions: { width, height },
    };
  }

  // ── Generation Execution ───────────────────────────────────────────────────

  async executeTxt2Img(params: ComfyUiGenerateParams): Promise<ComfyUiGenerateResult> {
    const startTime = Date.now();
    const category = params.category || 'general';
    const aspectRatio = params.aspectRatio || '16:9';
    const timeoutMs = params.timeoutMs || 300_000; // 5 min default for local generation

    // Cancel pending idle cleanup while new request is queued
    this.cancelDebouncedVramCleanup();

    // 1. Health check
    const health = await this.checkHealth();
    if (!health.available) {
      throw new Error(`ComfyUI is not available at ${this.apiUrl}. Ensure ComfyUI server is running. Error: ${health.error}`);
    }

    // 2. Load & mutate graph
    const baseGraph = await this.loadBaseGraph();
    const { graph, effectiveSeed, dimensions } = this.mutateGraph(baseGraph, params);

    // 3. Queue prompt
    const clientId = `mastra-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const postPayload = {
      prompt: graph,
      client_id: clientId,
    };

    const promptRes = await fetchWithDeadline(`${this.apiUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postPayload),
      timeoutMs: 15_000,
    });

    if (!promptRes.ok) {
      const errorText = await promptRes.text();
      let hint = '';
      if (promptRes.status === 500 && errorText.includes('Server got itself in trouble')) {
        hint = ' (Check if workflow template is in ComfyUI API Prompt format and all required custom nodes are loaded)';
      }
      throw new Error(`Failed to queue prompt in ComfyUI: HTTP ${promptRes.status} — ${errorText}${hint}`);
    }

    const promptData = (await promptRes.json()) as { prompt_id: string; number?: number; node_errors?: any };
    const promptId = promptData.prompt_id;

    if (!promptId) {
      throw new Error(`ComfyUI did not return a valid prompt_id. Response: ${JSON.stringify(promptData)}`);
    }

    // 4. Poll history until complete
    const pollDeadline = Date.now() + timeoutMs;
    let completedHistory: any = null;

    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 1000));

      try {
        const histRes = await fetchWithDeadline(`${this.apiUrl}/history/${promptId}`, {
          method: 'GET',
          timeoutMs: 5000,
        });

        if (histRes.ok) {
          const histData = (await histRes.json()) as Record<string, any>;
          if (histData[promptId]?.outputs) {
            completedHistory = histData[promptId];
            break;
          }
          if (histData[promptId]?.status?.status_str === 'error') {
            throw new Error(`ComfyUI execution failed for prompt ${promptId}: ${JSON.stringify(histData[promptId]?.status)}`);
          }
        }
      } catch (err: any) {
        if (err.message?.includes('ComfyUI execution failed')) {
          throw err;
        }
        // Transient poll error, retry
      }
    }

    if (!completedHistory) {
      throw new Error(`ComfyUI generation timed out after ${Math.round(timeoutMs / 1000)}s for prompt_id ${promptId}`);
    }

    // 5. Extract output image filename
    let foundFilename: string | null = null;
    const outputs = completedHistory.outputs;

    // Prefer node 212 (Image Saver Simple) or any node returning images
    for (const [nodeId, nodeOutput] of Object.entries<any>(outputs)) {
      if (Array.isArray(nodeOutput.images) && nodeOutput.images.length > 0) {
        foundFilename = nodeOutput.images[0].filename;
        break;
      }
    }

    // Fallback: check most recent PNG in ComfyUI-output
    if (!foundFilename && existsSync(this.comfyOutputDir)) {
      const files = await this.findLatestOutputFiles(this.comfyOutputDir, startTime);
      if (files.length > 0) {
        foundFilename = basename(files[0]);
      }
    }

    if (!foundFilename) {
      throw new Error(`No output image found for prompt_id ${promptId}`);
    }

    // 6. Copy to /projekty/splot-projects/media/generations/{category}/
    const targetDir = join(this.outputRoot, category);
    await mkdir(targetDir, { recursive: true });

    const sourcePath = join(this.comfyOutputDir, foundFilename);
    const targetImagePath = join(targetDir, foundFilename);

    if (existsSync(sourcePath)) {
      await copyFile(sourcePath, targetImagePath);
    } else {
      // Download directly from /view endpoint
      const viewRes = await fetchWithDeadline(`${this.apiUrl}/view?filename=${encodeURIComponent(foundFilename)}&type=output`, {
        method: 'GET',
        timeoutMs: 30_000,
      });
      if (viewRes.ok) {
        const arrayBuf = await viewRes.arrayBuffer();
        await writeFile(targetImagePath, Buffer.from(arrayBuf));
      } else {
        throw new Error(`Could not locate generated image on disk or via /view endpoint: ${foundFilename}`);
      }
    }

    // 7. Write Sidecar Metadata JSON
    const metadataFilename = foundFilename.replace(/\.[^/.]+$/, '') + '.json';
    const targetMetadataPath = join(targetDir, metadataFilename);

    const metadataPayload = {
      promptId,
      filename: foundFilename,
      category,
      aspectRatio,
      dimensions,
      seed: effectiveSeed,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      lora: {
        patryk: {
          enabled: params.loraPatrykEnabled !== false,
          strength: params.loraPatrykStrength ?? 1.05,
        },
        realism: {
          enabled: params.loraRealismEnabled !== false,
          strength: params.loraRealismStrength ?? 0.3,
        },
        afterlight: {
          enabled: params.loraAfterlightEnabled !== false,
          strength: params.loraAfterlightStrength ?? 0.2,
        },
        girl: {
          enabled: !!params.loraGirlEnabled,
          strength: params.loraGirlStrength ?? 0.8,
        },
      },
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };

    await writeFile(targetMetadataPath, JSON.stringify(metadataPayload, null, 2), 'utf-8');

    // 8. Schedule Debounced VRAM Cleaner
    this.scheduleDebouncedVramCleanup();

    return {
      success: true,
      promptId,
      filename: foundFilename,
      imagePath: targetImagePath,
      metadataPath: targetMetadataPath,
      category,
      aspectRatio,
      dimensions,
      seed: effectiveSeed,
      durationMs: Date.now() - startTime,
    };
  }

  private async findLatestOutputFiles(dir: string, sinceMs: number): Promise<string[]> {
    try {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(dir, { withFileTypes: true });
      const matches: { path: string; mtime: number }[] = [];

      for (const e of entries) {
        if (e.isFile() && (e.name.endsWith('.png') || e.name.endsWith('.webp') || e.name.endsWith('.jpg'))) {
          const full = join(dir, e.name);
          const s = await stat(full);
          if (s.mtimeMs >= sinceMs - 5000) {
            matches.push({ path: full, mtime: s.mtimeMs });
          }
        }
      }

      matches.sort((a, b) => b.mtime - a.mtime);
      return matches.map((m) => m.path);
    } catch {
      return [];
    }
  }
}

// ── Singleton Instance ───────────────────────────────────────────────────────

let defaultInstance: ComfyUiService | null = null;

export function getComfyUiService(): ComfyUiService {
  if (!defaultInstance) {
    defaultInstance = new ComfyUiService();
  }
  return defaultInstance;
}
