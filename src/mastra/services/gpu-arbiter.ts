import { EventEmitter } from 'events';
import { getComfyUiService } from './comfyui-service.js';

export type GpuConsumer = 'voicestudio' | 'comfyui' | 'ollama' | 'system';

export interface GpuLockMetadata {
  taskId?: string;
  operation?: string;
  requestedBy?: string;
}

export interface GpuLockStatus {
  isLocked: boolean;
  activeConsumer: GpuConsumer | null;
  activeLockToken: string | null;
  acquiredAt: Date | null;
  metadata?: GpuLockMetadata;
  queueLength: number;
}

interface QueuedGpuRequest {
  token: string;
  consumer: GpuConsumer;
  metadata?: GpuLockMetadata;
  resolve: (token: string) => void;
  reject: (err: Error) => void;
  timeoutTimer: NodeJS.Timeout;
}

/**
 * GpuResourceArbiter enforces mutual exclusion (concurrency = 1) on the host's
 * single physical GPU (NVIDIA GeForce RTX 5060 Ti, 16 GB VRAM).
 *
 * Problem:
 * - ComfyUI (SDXL / Flux / LoRA) allocates 8-12 GB VRAM.
 * - VoiceStudio (OmniVoice PyTorch) allocates 5-7 GB VRAM during synthesis.
 * - Running both simultaneously immediately exhausts 16 GB VRAM and crashes with CUDA OOM.
 *
 * Solution:
 * - Hardware Mutex: Exactly one GPU consumer may hold execution at any time.
 * - Automatic VRAM Flush: When ComfyUI releases the lock, it flushes models to host RAM
 *   via ComfyUI's `/free` endpoint before giving the GPU to VoiceStudio.
 *
 * Architecture Note on Priority Preemption (Future Extension):
 * Currently, requests are served in strict FIFO order as requested.
 * In the future, if interactive user requests (e.g. live ComfyUI preview in chat)
 * should preempt or jump ahead of batch audiobook processing:
 * - A `priority?: 'interactive' | 'normal' | 'batch'` field can be added to `GpuLockMetadata`.
 * - The `waitingQueue` can be sorted as a priority queue.
 * - Long-running tasks (like VoiceStudio audiobooks) yield the GPU between 700-word scenes,
 *   allowing interactive requests to execute with sub-minute latency.
 */
export class GpuResourceArbiter {
  private static instance: GpuResourceArbiter | null = null;

  private activeConsumer: GpuConsumer | null = null;
  private activeLockToken: string | null = null;
  private acquiredAt: Date | null = null;
  private activeMetadata?: GpuLockMetadata;
  private waitingQueue: QueuedGpuRequest[] = [];
  private events = new EventEmitter();

  private constructor() {
    this.events.setMaxListeners(100);
  }

  public static getInstance(): GpuResourceArbiter {
    if (!GpuResourceArbiter.instance) {
      GpuResourceArbiter.instance = new GpuResourceArbiter();
    }
    return GpuResourceArbiter.instance;
  }

  /**
   * Acquire exclusive lock on the GPU.
   * If another consumer currently holds the GPU, this returns a Promise that
   * resolves when the GPU becomes available.
   *
   * @param consumer Name of the system acquiring the GPU
   * @param metadata Contextual task/operation information
   * @param maxWaitMs Maximum time to wait in queue before timing out (default 15m)
   * @returns Lock token required to release the GPU
   */
  public async acquireLock(
    consumer: GpuConsumer,
    metadata?: GpuLockMetadata,
    maxWaitMs = 15 * 60 * 1000,
  ): Promise<string> {
    const token = `gpu-lock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    if (!this.activeLockToken) {
      // GPU is free, acquire immediately
      this.activeConsumer = consumer;
      this.activeLockToken = token;
      this.acquiredAt = new Date();
      this.activeMetadata = metadata;
      console.log(`[GpuResourceArbiter] Lock ACQUIRED by ${consumer} (token: ${token}, task: ${metadata?.taskId ?? 'n/a'})`);
      return token;
    }

    console.log(`[GpuResourceArbiter] GPU busy (${this.activeConsumer}). Queuing request for ${consumer} (queue pos: ${this.waitingQueue.length + 1})`);

    return new Promise<string>((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        // Remove from queue on timeout
        this.waitingQueue = this.waitingQueue.filter((req) => req.token !== token);
        reject(
          new Error(
            `[GpuResourceArbiter] Timeout waiting for GPU lock for ${consumer} after ${Math.round(maxWaitMs / 1000)}s. Active: ${this.activeConsumer}`,
          ),
        );
      }, maxWaitMs);

      this.waitingQueue.push({
        token,
        consumer,
        metadata,
        resolve,
        reject,
        timeoutTimer,
      });
    });
  }

  /**
   * Release the GPU lock.
   * Automatically performs VRAM cleanup (e.g. ComfyUI /free) when appropriate
   * and advances to the next queued consumer.
   */
  public async releaseLock(token: string): Promise<void> {
    if (this.activeLockToken !== token) {
      console.warn(`[GpuResourceArbiter] Ignored release for non-active token: ${token}`);
      return;
    }

    const previousConsumer = this.activeConsumer;
    const durationSec = this.acquiredAt
      ? Math.round((Date.now() - this.acquiredAt.getTime()) / 1000)
      : 0;

    console.log(`[GpuResourceArbiter] Lock RELEASED by ${previousConsumer} after ${durationSec}s`);

    // Reset current active state
    this.activeConsumer = null;
    this.activeLockToken = null;
    this.acquiredAt = null;
    this.activeMetadata = undefined;

    // Automatic VRAM Flush: If ComfyUI just released, unload models to host RAM
    if (previousConsumer === 'comfyui') {
      try {
        console.log('[GpuResourceArbiter] Auto-flushing ComfyUI VRAM models to host RAM...');
        const comfyService = getComfyUiService();
        await comfyService.freeVram({ unloadModels: true, freeMemory: true });
        console.log('[GpuResourceArbiter] ComfyUI VRAM successfully freed.');
      } catch (err) {
        console.warn(`[GpuResourceArbiter] Failed to auto-free ComfyUI VRAM: ${(err as Error).message}`);
      }
    }

    // Process next queued request if any
    if (this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift()!;
      clearTimeout(next.timeoutTimer);

      this.activeConsumer = next.consumer;
      this.activeLockToken = next.token;
      this.acquiredAt = new Date();
      this.activeMetadata = next.metadata;

      console.log(`[GpuResourceArbiter] Dispatched GPU lock to queued ${next.consumer} (token: ${next.token})`);
      next.resolve(next.token);
    }
  }

  /**
   * Run an asynchronous function with exclusive GPU lock protection.
   */
  public async withGpuLock<T>(
    consumer: GpuConsumer,
    fn: () => Promise<T>,
    metadata?: GpuLockMetadata,
  ): Promise<T> {
    const token = await this.acquireLock(consumer, metadata);
    try {
      return await fn();
    } finally {
      await this.releaseLock(token);
    }
  }

  /**
   * Get current GPU lock status.
   */
  public getStatus(): GpuLockStatus {
    return {
      isLocked: this.activeLockToken !== null,
      activeConsumer: this.activeConsumer,
      activeLockToken: this.activeLockToken,
      acquiredAt: this.acquiredAt,
      metadata: this.activeMetadata,
      queueLength: this.waitingQueue.length,
    };
  }
}

export function getGpuArbiter(): GpuResourceArbiter {
  return GpuResourceArbiter.getInstance();
}
