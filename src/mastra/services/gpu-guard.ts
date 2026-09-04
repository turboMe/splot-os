/**
 * GPU Guard — Runtime VRAM Protection Service
 *
 * Prevents system freezes by enforcing VRAM reservations and providing
 * live GPU memory snapshots before model dispatch.
 *
 * Multi-environment support:
 * - Desktop (GNOME/KDE/Wayland) — reserves VRAM for compositor + display server
 * - Headless server — minimal reservation for driver overhead
 * - Container with GPU passthrough — auto-detects via nvidia-smi
 * - No GPU — gracefully degrades to cloud-only mode
 *
 * Used by Smart Router (Etap 8) for pre-flight VRAM checks.
 */

import { execSync } from 'child_process';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GpuSnapshot {
  /** Total VRAM in MB */
  totalMb: number;
  /** Currently used VRAM in MB (all processes including compositor) */
  usedMb: number;
  /** Free VRAM in MB */
  freeMb: number;
  /** VRAM reserved for system (compositor, display server, driver overhead) */
  systemReservedMb: number;
  /** VRAM actually available for Ollama models */
  availableForModelsMb: number;
  /** GPU utilization percentage (0-100) */
  gpuUtilPercent: number;
  /** Whether GPU is available at all */
  gpuAvailable: boolean;
  /** Detected environment type */
  environment: GpuEnvironment;
  /** Timestamp of snapshot */
  timestamp: Date;
}

export type GpuEnvironment = 'desktop' | 'headless' | 'container' | 'no-gpu';

export interface GpuGuardConfig {
  /** MB to always reserve for system (compositor + display server + driver).
   *  Override via env: GPU_SYSTEM_RESERVED_MB */
  systemReservedMb?: number;
  /** Critical threshold — if free VRAM drops below this, refuse ALL local models.
   *  Override via env: GPU_CRITICAL_THRESHOLD_MB */
  criticalThresholdMb?: number;
  /** Warning threshold — log warning if free VRAM is below this.
   *  Override via env: GPU_WARNING_THRESHOLD_MB */
  warningThresholdMb?: number;
  /** How long to cache nvidia-smi results (ms). Prevents hammering GPU.
   *  Override via env: GPU_CACHE_TTL_MS */
  cacheTtlMs?: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** VRAM reservations by environment type */
const ENVIRONMENT_RESERVES: Record<GpuEnvironment, number> = {
  desktop: 800,    // GNOME Shell (~275) + Xwayland (~2) + apps (~100) + buffer
  headless: 200,   // Driver overhead only
  container: 150,  // Minimal driver overhead in container
  'no-gpu': 0,     // N/A
};

const DEFAULT_CONFIG: Required<GpuGuardConfig> = {
  systemReservedMb: 0,   // 0 = auto-detect from environment type
  criticalThresholdMb: 500,
  warningThresholdMb: 1500,
  cacheTtlMs: 5000,
};

// ── GPU Guard Class ──────────────────────────────────────────────────────────

export class GpuGuard {
  private config: Required<GpuGuardConfig>;
  private cachedSnapshot: GpuSnapshot | null = null;
  private cacheExpiry = 0;
  private detectedEnv: GpuEnvironment | null = null;

  constructor(config?: GpuGuardConfig) {
    this.config = {
      systemReservedMb: parseInt(process.env.GPU_SYSTEM_RESERVED_MB ?? '0', 10)
        || config?.systemReservedMb
        || DEFAULT_CONFIG.systemReservedMb,
      criticalThresholdMb: parseInt(process.env.GPU_CRITICAL_THRESHOLD_MB ?? '0', 10)
        || config?.criticalThresholdMb
        || DEFAULT_CONFIG.criticalThresholdMb,
      warningThresholdMb: parseInt(process.env.GPU_WARNING_THRESHOLD_MB ?? '0', 10)
        || config?.warningThresholdMb
        || DEFAULT_CONFIG.warningThresholdMb,
      cacheTtlMs: parseInt(process.env.GPU_CACHE_TTL_MS ?? '0', 10)
        || config?.cacheTtlMs
        || DEFAULT_CONFIG.cacheTtlMs,
    };
  }

  // ── Environment Detection ────────────────────────────────────────────────

  /**
   * Detect the runtime environment type.
   * Cached after first detection (doesn't change during process lifetime).
   */
  detectEnvironment(): GpuEnvironment {
    if (this.detectedEnv) return this.detectedEnv;

    // 1. Check if GPU is available at all
    if (!this.isNvidiaSmiAvailable()) {
      this.detectedEnv = 'no-gpu';
      console.log('[GpuGuard] No GPU detected — cloud-only mode');
      return this.detectedEnv;
    }

    // 2. Check if running in container
    if (this.isContainer()) {
      this.detectedEnv = 'container';
      console.log('[GpuGuard] Container environment with GPU passthrough detected');
      return this.detectedEnv;
    }

    // 3. Check if display compositor is running (desktop vs headless)
    if (this.hasDisplayCompositor()) {
      this.detectedEnv = 'desktop';
      console.log('[GpuGuard] Desktop environment detected (compositor active)');
    } else {
      this.detectedEnv = 'headless';
      console.log('[GpuGuard] Headless server environment detected');
    }

    return this.detectedEnv;
  }

  private isNvidiaSmiAvailable(): boolean {
    try {
      execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  private isContainer(): boolean {
    try {
      // Standard container detection methods
      const cgroup = execSync('cat /proc/1/cgroup 2>/dev/null || echo ""', {
        encoding: 'utf-8',
        timeout: 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (cgroup.includes('docker') || cgroup.includes('kubepods') || cgroup.includes('containerd')) {
        return true;
      }
      // Check /.dockerenv
      try {
        execSync('test -f /.dockerenv', { timeout: 500, stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
      } catch { /* not docker */ }

      // Check for Kubernetes service account
      try {
        execSync('test -d /var/run/secrets/kubernetes.io', { timeout: 500, stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
      } catch { /* not k8s */ }

      return false;
    } catch {
      return false;
    }
  }

  private hasDisplayCompositor(): boolean {
    try {
      // Check for DISPLAY or WAYLAND_DISPLAY env (inherited or system-wide)
      if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;

      // Check if gnome-shell, kwin, sway, etc. is running
      const processes = execSync('ps -eo comm 2>/dev/null || echo ""', {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const compositors = ['gnome-shell', 'kwin_wayland', 'kwin_x11', 'sway', 'mutter', 'weston', 'Xorg', 'Xwayland'];
      return compositors.some((c) => processes.includes(c));
    } catch {
      return false;
    }
  }

  // ── VRAM Snapshot ────────────────────────────────────────────────────────

  /**
   * Get a live VRAM snapshot from nvidia-smi.
   * Results are cached for `cacheTtlMs` to prevent hammering the GPU.
   */
  getSnapshot(forceRefresh = false): GpuSnapshot {
    const now = Date.now();

    // Return cached if fresh enough
    if (!forceRefresh && this.cachedSnapshot && now < this.cacheExpiry) {
      return this.cachedSnapshot;
    }

    const env = this.detectEnvironment();

    if (env === 'no-gpu') {
      const snapshot: GpuSnapshot = {
        totalMb: 0,
        usedMb: 0,
        freeMb: 0,
        systemReservedMb: 0,
        availableForModelsMb: 0,
        gpuUtilPercent: 0,
        gpuAvailable: false,
        environment: env,
        timestamp: new Date(),
      };
      this.cachedSnapshot = snapshot;
      this.cacheExpiry = now + this.config.cacheTtlMs;
      return snapshot;
    }

    try {
      const raw = execSync(
        'nvidia-smi --query-gpu=memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits',
        { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();

      const [totalStr, usedStr, freeStr, utilStr] = raw.split(',').map((s) => s.trim());
      const totalMb = parseInt(totalStr, 10);
      const usedMb = parseInt(usedStr, 10);
      const freeMb = parseInt(freeStr, 10);
      const gpuUtilPercent = parseInt(utilStr, 10);

      // Determine system reservation
      const systemReservedMb = this.config.systemReservedMb > 0
        ? this.config.systemReservedMb
        : ENVIRONMENT_RESERVES[env];

      // Available = free - reserved (but never negative)
      const availableForModelsMb = Math.max(0, freeMb - systemReservedMb);

      const snapshot: GpuSnapshot = {
        totalMb,
        usedMb,
        freeMb,
        systemReservedMb,
        availableForModelsMb,
        gpuUtilPercent,
        gpuAvailable: true,
        environment: env,
        timestamp: new Date(),
      };

      this.cachedSnapshot = snapshot;
      this.cacheExpiry = now + this.config.cacheTtlMs;

      // Emit warnings
      if (availableForModelsMb < this.config.criticalThresholdMb) {
        console.error(
          `[GpuGuard] 🚨 CRITICAL: Only ${availableForModelsMb}MB VRAM available for models ` +
          `(free: ${freeMb}MB, reserved: ${systemReservedMb}MB). All local models BLOCKED.`,
        );
      } else if (availableForModelsMb < this.config.warningThresholdMb) {
        console.warn(
          `[GpuGuard] ⚠️ WARNING: Low VRAM — ${availableForModelsMb}MB available for models ` +
          `(free: ${freeMb}MB, reserved: ${systemReservedMb}MB).`,
        );
      }

      return snapshot;
    } catch (err) {
      console.error('[GpuGuard] nvidia-smi query failed:', (err as Error).message);
      // Return degraded snapshot — force cloud-only
      const snapshot: GpuSnapshot = {
        totalMb: 0,
        usedMb: 0,
        freeMb: 0,
        systemReservedMb: 0,
        availableForModelsMb: 0,
        gpuUtilPercent: 0,
        gpuAvailable: false,
        environment: env,
        timestamp: new Date(),
      };
      this.cachedSnapshot = snapshot;
      this.cacheExpiry = now + this.config.cacheTtlMs;
      return snapshot;
    }
  }

  // ── Pre-flight Checks ──────────────────────────────────────────────────

  /**
   * Check if a model with given VRAM requirement can be loaded safely.
   * Returns { allowed, reason, snapshot }.
   */
  canLoadModel(requiredVramMb: number): { allowed: boolean; reason: string; snapshot: GpuSnapshot } {
    const snapshot = this.getSnapshot();

    if (!snapshot.gpuAvailable) {
      return {
        allowed: false,
        reason: 'No GPU available — use cloud model',
        snapshot,
      };
    }

    if (snapshot.availableForModelsMb < this.config.criticalThresholdMb) {
      return {
        allowed: false,
        reason: `VRAM critically low (${snapshot.availableForModelsMb}MB available, ` +
          `${this.config.criticalThresholdMb}MB threshold) — circuit breaker active`,
        snapshot,
      };
    }

    if (requiredVramMb > snapshot.availableForModelsMb) {
      return {
        allowed: false,
        reason: `Model needs ${requiredVramMb}MB but only ${snapshot.availableForModelsMb}MB available ` +
          `(${snapshot.freeMb}MB free - ${snapshot.systemReservedMb}MB reserved)`,
        snapshot,
      };
    }

    return {
      allowed: true,
      reason: `OK — ${requiredVramMb}MB needed, ${snapshot.availableForModelsMb}MB available`,
      snapshot,
    };
  }

  /**
   * Calculate the safe VRAM budget for Ollama models.
   * This is total VRAM minus system reservation.
   * Used by model-capabilities.ts to set VRAM_BUDGET_MB dynamically.
   */
  getSafeVramBudgetMb(): number {
    const snapshot = this.getSnapshot();
    if (!snapshot.gpuAvailable) return 0;
    return Math.max(0, snapshot.totalMb - snapshot.systemReservedMb);
  }

  /**
   * Format a snapshot for logging.
   */
  formatSnapshot(snapshot?: GpuSnapshot): string {
    const s = snapshot ?? this.getSnapshot();
    if (!s.gpuAvailable) return '[GpuGuard] No GPU — cloud-only mode';

    return [
      `[GpuGuard] GPU Status (${s.environment}):`,
      `  Total: ${s.totalMb}MB | Used: ${s.usedMb}MB | Free: ${s.freeMb}MB`,
      `  Reserved (system): ${s.systemReservedMb}MB`,
      `  Available for models: ${s.availableForModelsMb}MB`,
      `  GPU Util: ${s.gpuUtilPercent}%`,
    ].join('\n');
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: GpuGuard | null = null;

export function getGpuGuard(config?: GpuGuardConfig): GpuGuard {
  if (!_instance) {
    _instance = new GpuGuard(config);
  }
  return _instance;
}

/**
 * Initialize GpuGuard and log startup state.
 * Call once at application boot (index.ts).
 */
export function initGpuGuard(): GpuGuard {
  const guard = getGpuGuard();
  const snapshot = guard.getSnapshot(true);
  console.log(guard.formatSnapshot(snapshot));

  if (snapshot.gpuAvailable) {
    console.log(
      `[GpuGuard] ✅ Safe VRAM budget: ${guard.getSafeVramBudgetMb()}MB ` +
      `(${snapshot.totalMb}MB total - ${snapshot.systemReservedMb}MB reserved)`,
    );
  }

  return guard;
}
