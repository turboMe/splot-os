/**
 * ComfyUI Mastra Tools (SPLOT OS Visual Studio)
 *
 * Exposes local ComfyUI image generation, queue monitoring,
 * and VRAM lifecycle management to Mastra agents.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getComfyUiService, type AspectRatio, type GenerationCategory } from '../../services/comfyui-service.js';
import { getGpuArbiter } from '../../services/gpu-arbiter.js';

const categoryEnum = z.enum([
  'portraits',
  'fantasy-covers',
  'marketing-assets',
  'video-storyboards',
  'art-concepts',
  'general',
]);

const aspectRatioEnum = z.enum(['16:9', '9:16', '2:3', '4:5', '3:4', '4:3', '1:1', '21:9', 'custom']);

// ── Generate Image Tool ──────────────────────────────────────────────────────

export const comfyuiGenerateImageTool = createTool({
  id: 'comfyui-generate-image',
  description:
    'Generate high-quality visuals using the local ComfyUI engine (Lustify Turbo / Krea2 + Qwen3-VL with Auto-Gender Face Detailer and LoRA). Automatically stores output images and sidecar JSON metadata in /projekty/splot-projects/media/generations/{category}/. Note: When portrait LoRA is active, ensure only 1 male character is present in the scene.',
  inputSchema: z.object({
    prompt: z.string().describe('Detailed optical prompt describing the scene, subject, lighting, location, and camera framing.'),
    negative_prompt: z.string().optional().describe('Optional negative prompt.'),
    category: categoryEnum.default('portraits').describe('Output category directory for saving the asset.'),
    aspect_ratio: aspectRatioEnum.default('16:9').describe('Aspect ratio: 16:9 (web/video), 9:16 (story/mobile), 2:3 (book cover), 4:5 (Instagram portrait), 3:4 (poster portrait), 4:3 (landscape photo), 1:1 (avatar/post), 21:9 (ultrawide).'),
    lora_patryk_enabled: z.boolean().default(true).describe('Whether to apply pa1rykman identity LoRA. Must be true for Patryk portraits, false for other/neutral scenes.'),
    lora_patryk_strength: z.number().default(1.05).describe('Strength of Patryk LoRA (0.0 to 1.5, default: 1.05).'),
    lora_realism_enabled: z.boolean().default(true).describe('Whether to apply realism engine LoRA.'),
    lora_realism_strength: z.number().default(0.3).describe('Strength of realism engine LoRA (default: 0.3).'),
    lora_girl_enabled: z.boolean().default(false).describe('Whether to apply female character LoRA (ver0girl). Set to true when generating women.'),
    lora_girl_strength: z.number().default(0.8).describe('Strength of female LoRA (default: 0.8).'),
    seed: z.number().optional().describe('Explicit seed integer for reproducibility. If omitted, a random seed is used.'),
    steps: z.number().optional().describe('Sampling steps (default: 10-12).'),
    custom_width: z.number().optional().describe('Custom width when aspect_ratio is custom.'),
    custom_height: z.number().optional().describe('Custom height when aspect_ratio is custom.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    promptId: z.string().optional(),
    filename: z.string().optional(),
    imagePath: z.string().optional(),
    metadataPath: z.string().optional(),
    category: z.string().optional(),
    aspectRatio: z.string().optional(),
    dimensions: z
      .object({
        width: z.number(),
        height: z.number(),
      })
      .optional(),
    seed: z.number().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (inputData) => {
    try {
      const comfyService = getComfyUiService();
      const gpuArbiter = getGpuArbiter();

      return await gpuArbiter.withGpuLock(
        'comfyui',
        async () => {
          return await comfyService.executeTxt2Img({
            prompt: inputData.prompt,
            negativePrompt: inputData.negative_prompt,
            category: inputData.category as GenerationCategory,
            aspectRatio: inputData.aspect_ratio as AspectRatio,
            width: inputData.custom_width,
            height: inputData.custom_height,
            seed: inputData.seed,
            steps: inputData.steps,
            loraPatrykEnabled: inputData.lora_patryk_enabled,
            loraPatrykStrength: inputData.lora_patryk_strength,
            loraRealismEnabled: inputData.lora_realism_enabled,
            loraRealismStrength: inputData.lora_realism_strength,
            loraGirlEnabled: inputData.lora_girl_enabled,
            loraGirlStrength: inputData.lora_girl_strength,
          });
        },
        { operation: 'txt2img', requestedBy: 'comfyui_generate_image' },
      );
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || String(err),
      };
    }
  },
});

// ── Status & Queue Tool ──────────────────────────────────────────────────────

export const comfyuiStatusTool = createTool({
  id: 'comfyui-status',
  description:
    'Check local ComfyUI server health, active/pending job queue count, and available GPU VRAM.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    available: z.boolean(),
    apiUrl: z.string(),
    queue: z.object({
      runningCount: z.number(),
      pendingCount: z.number(),
      totalRemaining: z.number(),
    }),
    vram: z
      .object({
        totalMb: z.number(),
        freeMb: z.number(),
      })
      .optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const comfyService = getComfyUiService();
      const health = await comfyService.checkHealth();
      const queue = await comfyService.getQueue();

      return {
        available: health.available,
        apiUrl: health.apiUrl,
        queue: {
          runningCount: queue.running.length,
          pendingCount: queue.pending.length,
          totalRemaining: queue.totalRemaining,
        },
        vram: health.vram
          ? {
              totalMb: health.vram.total,
              freeMb: health.vram.free,
            }
          : undefined,
        error: health.error,
      };
    } catch (err: any) {
      return {
        available: false,
        apiUrl: process.env.COMFYUI_API_URL || 'http://localhost:8188',
        queue: {
          runningCount: 0,
          pendingCount: 0,
          totalRemaining: 0,
        },
        error: err?.message || String(err),
      };
    }
  },
});

// ── Free VRAM Tool ───────────────────────────────────────────────────────────

export const comfyuiFreeVramTool = createTool({
  id: 'comfyui-free-vram',
  description:
    'Explicitly release and unload all ComfyUI neural models from GPU VRAM back to system RAM immediately.',
  inputSchema: z.object({
    unload_models: z.boolean().default(true).describe('Whether to unload loaded model weights from VRAM.'),
    free_memory: z.boolean().default(true).describe('Whether to invoke PyTorch cache clearing and garbage collection.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (inputData) => {
    const comfyService = getComfyUiService();
    const res = await comfyService.freeVram({
      unloadModels: inputData.unload_models,
      freeMemory: inputData.free_memory,
    });

    if (!res.success) {
      return {
        success: false,
        message: 'Failed to free ComfyUI VRAM.',
        error: res.error,
      };
    }

    return {
      success: true,
      message: 'ComfyUI GPU VRAM successfully released to baseline.',
    };
  },
});
