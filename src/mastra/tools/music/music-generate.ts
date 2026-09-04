import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  resolveMusicSurface,
  validateMusicSurfaceRequest,
  type MusicProvider,
  type MusicSurfaceConfig,
  type MusicSurfaceName,
} from '../../config/music-surfaces.js';
import { MusicService } from './music-service.js';
import { musicGenerationModeSchema, musicGenerationRunSchema } from '../../lib/music-schemas.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { META_AGENT_ID } from '../../config/agent-ids.js';
import { checkMusicSafety, lintMusicPromptSpec } from './music-validators.js';
import { fetchWithDeadline, remainingRequestBudgetMs } from '../../lib/http-deadline.js';

const referenceAudioInputSchema = z.object({
  tag: z.string().min(1),
  role: z.string().min(1),
  url: z.string().url().optional(),
  path: z.string().optional(),
});

const musicGenerateInputSchema = z.object({
  projectId: z.string().min(1),
  trackId: z.string().min(1),
  mode: musicGenerationModeSchema.default('lyrics2song'),
  stylePrompt: z.string().min(1),
  lyrics: z.string().default(''),
  vocalType: z.enum(['instrumental', 'male', 'female', 'duet', 'choir', 'any']).default('any'),
  language: z.string().default('en'),
  structure: z.array(z.string()).default([]),
  promptVersion: z.string().default('v1'),
  lengthMs: z.number().int().positive().nullable().optional(),
  outputFormat: z.string().default('mp3'),
  referenceAudio: z.array(referenceAudioInputSchema).default([]),
  provider: z.enum(['fal', 'elevenlabs', 'suno']).optional(),
  surface: z.string().optional(),
  workspaceDir: z.string().optional(),
  approvalToken: z.string().optional(),
  callerAgentId: z.string().optional(),
  taskId: z.string().optional(),
});

const musicGenerateOutputSchema = z.object({
  ok: z.boolean(),
  audioPath: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  provider: z.string().optional(),
  surface: z.string().optional(),
  modelId: z.string().optional(),
  lengthMs: z.number().optional(),
  outputUrl: z.string().optional(),
  moderation: z.unknown().optional(),
  costEstimate: z.unknown().optional(),
  error: z.string().optional(),
  // True when the failure is final and MUST NOT be retried unchanged: paid-spend
  // cap reached, provider plan/schema/input failure, scoped approval mismatch,
  // or generated output moderation.
  terminal: z.boolean().optional(),
  approvalRequest: z.object({
    tool: z.string(),
    action: z.string(),
    args: z.record(z.string(), z.unknown()),
  }).optional(),
  approvalToken: z.string().optional(),
});

type MusicGenerateInput = z.input<typeof musicGenerateInputSchema>;
type NormalizedMusicGenerateInput = z.output<typeof musicGenerateInputSchema>;
type MusicGenerateOutput = z.output<typeof musicGenerateOutputSchema>;

function requireApproval(): boolean {
  return process.env.MUSIC_REQUIRE_APPROVAL !== 'false';
}

// Env-configurable hard caps on paid generations. Enforced inside the tool, so
// meta, musician, and workers are all bounded identically — no agent can loop
// paid generation past the budget. Set to 0 to disable a cap.
function maxPaidGenerationsPerTrack(): number {
  const raw = process.env.MUSIC_MAX_PAID_GENERATIONS_PER_TRACK;
  const value = raw === undefined || raw === '' ? 3 : Number(raw);
  return Number.isFinite(value) ? value : 3;
}

function maxPaidGenerationsPerProject(): number {
  const raw = process.env.MUSIC_MAX_PAID_GENERATIONS_PER_PROJECT;
  const value = raw === undefined || raw === '' ? 12 : Number(raw);
  return Number.isFinite(value) ? value : 12;
}

type FalModelKind = 'ace-step' | 'stable-audio' | 'minimax-reference' | 'generic';

function falModelKind(surface: MusicSurfaceConfig): FalModelKind {
  const modelId = surface.modelId.toLowerCase();
  if (surface.surface === 'fal-ace-step' || modelId.includes('ace-step')) return 'ace-step';
  if (surface.surface === 'fal-stable-audio' || modelId.includes('stable-audio')) return 'stable-audio';
  if (surface.surface === 'fal-minimax-reference' || modelId.includes('minimax-music')) return 'minimax-reference';
  return surface.surface === 'fal' ? 'ace-step' : 'generic';
}

function isInstrumentalInput(input: NormalizedMusicGenerateInput): boolean {
  return input.mode === 'instrumental' || input.vocalType === 'instrumental';
}

function lengthSeconds(input: NormalizedMusicGenerateInput, fallback = 60): number | undefined {
  if (typeof input.lengthMs !== 'number') return fallback;
  return Math.max(1, Math.round(input.lengthMs / 1000));
}

function buildElevenLabsPrompt(input: NormalizedMusicGenerateInput): string {
  return input.lyrics ? `${input.stylePrompt}\n\nLyrics:\n${input.lyrics}` : input.stylePrompt;
}

function normalizeFalTags(stylePrompt: string, input: NormalizedMusicGenerateInput): string {
  const style = stylePrompt.replace(/\s+/g, ' ').trim();
  const descriptors = [
    style,
    input.language ? `language: ${input.language}` : '',
    input.vocalType && input.vocalType !== 'any' ? `vocal: ${input.vocalType}` : '',
  ].filter(Boolean);
  return descriptors.join(', ');
}

function minimaxPrompt(input: NormalizedMusicGenerateInput): string {
  return (input.lyrics.trim() || input.stylePrompt.trim()).slice(0, 600);
}

function validateSurfacePayload(input: NormalizedMusicGenerateInput, surface: MusicSurfaceConfig): string[] {
  const errors: string[] = [];

  if (surface.provider === 'elevenlabs') {
    const prompt = buildElevenLabsPrompt(input);
    if (prompt.length > 4_100) {
      errors.push(`elevenlabs prompt is ${prompt.length} chars; ElevenLabs Music accepts at most 4100 chars for body.prompt`);
    }
  }

  if (surface.provider === 'fal') {
    const kind = falModelKind(surface);
    if (kind === 'minimax-reference') {
      if (input.referenceAudio.length === 0) {
        errors.push(`${surface.modelId} requires reference_audio_url; use fal/ace-step for text or lyrics-to-song generation without a reference`);
      }
      const promptLength = (input.lyrics.trim() || input.stylePrompt.trim()).length;
      if (promptLength > 600) {
        errors.push(`${surface.modelId} reference endpoint prompt is ${promptLength} chars; use at most 600 chars or switch to fal/ace-step for full lyrics`);
      }
    }
    if (kind === 'stable-audio' && input.lyrics.trim()) {
      errors.push(`${surface.modelId} is prompt-to-audio and does not support supplied lyrics; use fal/ace-step or elevenlabs for lyrics2song`);
    }
  }

  return errors;
}

function approvalScopeErrors(
  approval: Record<string, unknown>,
  input: NormalizedMusicGenerateInput,
  surface: MusicSurfaceConfig,
): string[] {
  const args = approval.args && typeof approval.args === 'object'
    ? approval.args as Record<string, unknown>
    : {};
  const expected: Record<string, unknown> = {
    projectId: input.projectId,
    trackId: input.trackId,
    surface: surface.surface,
    provider: surface.provider,
    modelId: surface.modelId,
    mode: input.mode,
  };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (args[key] !== value) {
      errors.push(`${key} expected ${String(value)} but approval has ${String(args[key] ?? 'missing')}`);
    }
  }
  return errors;
}

export function classifyMusicGenerationError(message: string): { code: string; terminal: boolean; detail: string } | null {
  if (/content[_ -]?policy[_ -]?violation/i.test(message) || /sensitive content/i.test(message) || /blocked by moderation/i.test(message)) {
    return {
      code: 'content_policy_violation',
      terminal: true,
      detail: 'the surface rejected the generated content; change the request materially or stop',
    };
  }
  if (/HTTP 402/i.test(message) || /paid_plan_required/i.test(message) || /payment required/i.test(message) || /upgrade to a paid plan/i.test(message)) {
    return {
      code: 'provider_plan_required',
      terminal: true,
      detail: 'the provider account or plan cannot run this music endpoint',
    };
  }
  if (/String should have at most/i.test(message) || /at most \d+ characters/i.test(message) || /maximum length/i.test(message) || /body\.prompt/i.test(message)) {
    return {
      code: 'provider_input_limit',
      terminal: true,
      detail: 'the request exceeds the provider input limit',
    };
  }
  if (/reference_audio_url/i.test(message) || /Field required/i.test(message) || /HTTP 422/i.test(message) || /validation/i.test(message) || /schema/i.test(message)) {
    return {
      code: 'provider_schema_error',
      terminal: true,
      detail: 'the request body does not match the selected provider model schema',
    };
  }
  if (/HTTP 401/i.test(message) || /HTTP 403/i.test(message) || /unauthori[sz]ed/i.test(message) || /invalid api key/i.test(message)) {
    return {
      code: 'provider_auth_failed',
      terminal: true,
      detail: 'provider credentials are missing, invalid, or not allowed for this endpoint',
    };
  }
  return null;
}

function outputDirFor(input: NormalizedMusicGenerateInput): string {
  const configured = process.env.MUSIC_OUTPUT_DIR?.trim();
  const base = configured || input.workspaceDir || `music-work/${input.projectId}`;
  const resolved = isAbsolute(base) ? resolve(base) : resolve(process.cwd(), base);
  if (!configured && input.workspaceDir) {
    const cwd = resolve(process.cwd());
    const tmp = resolve('/tmp');
    if (resolved !== cwd && !resolved.startsWith(`${cwd}/`) && resolved !== tmp && !resolved.startsWith(`${tmp}/`)) {
      return resolve(cwd, `music-work/${input.projectId}`);
    }
  }
  return resolved;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function guessAudioMime(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

async function referenceValue(ref: z.infer<typeof referenceAudioInputSchema>): Promise<string | undefined> {
  if (ref.url) return ref.url;
  if (!ref.path) return undefined;
  const cwd = resolve(process.cwd());
  const tmp = resolve('/tmp');
  let fullPath = isAbsolute(ref.path) ? resolve(ref.path) : resolve(cwd, ref.path);
  if (!isAbsolute(ref.path) && !existsSync(fullPath) && existsSync(resolve('/', ref.path))) {
    fullPath = resolve('/', ref.path);
  }
  if (fullPath !== cwd && !fullPath.startsWith(`${cwd}/`) && !fullPath.startsWith(`${tmp}/`)) {
    throw new Error(`Reference audio path is outside workspace/tmp and cannot be sent: ${ref.path}`);
  }
  if (!existsSync(fullPath)) throw new Error(`Reference audio path does not exist: ${ref.path}`);
  const info = await stat(fullPath);
  if (info.size > 10 * 1024 * 1024) {
    throw new Error(`Reference audio is too large for inline upload (${Math.round(info.size / 1024 / 1024)}MB): ${ref.path}`);
  }
  const bytes = await readFile(fullPath);
  return `data:${guessAudioMime(fullPath)};base64,${bytes.toString('base64')}`;
}

function extractTaskId(response: Record<string, unknown>): string | undefined {
  for (const key of ['request_id', 'task_id', 'id']) {
    const value = response[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function extractUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['url', 'audio_url', 'download_url']) {
      const found = extractUrl(record[key]);
      if (found) return found;
    }
  }
  return undefined;
}

function extractAudioUrl(response: Record<string, unknown>): string | undefined {
  return (
    extractUrl(response.audio) ||
    extractUrl(response.audio_file) ||
    extractUrl(response.audio_url) ||
    extractUrl(response.output) ||
    extractUrl(response.result) ||
    extractUrl(response.url)
  );
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  // K11 — an unbounded poll tick can hang on a stalled socket, and the
  // `while (Date.now() < deadline)` loop would then never re-check its budget:
  // the documented 600s poll silently becomes infinite.
  const response = await fetchWithDeadline(url, { ...init, timeoutMs });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 500)}`);
  }
  return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : { value: parsed };
}

async function downloadFile(url: string, outPath: string, timeoutMs?: number): Promise<void> {
  // Audio payloads are sizeable, so this gets a longer bound than a poll tick —
  // but it must still have one (K11).
  const response = await fetchWithDeadline(url, { timeoutMs: timeoutMs ?? 120_000 });
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outPath, bytes);
}

function statusIsComplete(status: string): boolean {
  return ['COMPLETED', 'completed', 'succeeded', 'success', 'done', 'generated'].includes(status);
}

function statusIsFailed(status: string): boolean {
  return ['FAILED', 'failed', 'error', 'cancelled', 'canceled'].includes(status);
}

async function buildFalBody(input: NormalizedMusicGenerateInput, surface: MusicSurfaceConfig): Promise<Record<string, unknown>> {
  const references = await Promise.all(input.referenceAudio.map(async (ref) => ({
    tag: ref.tag,
    role: ref.role,
    url: await referenceValue(ref),
  })));
  const cleanReferences = references.filter((ref) => ref.url);

  const kind = falModelKind(surface);
  let body: Record<string, unknown>;
  if (kind === 'ace-step') {
    body = {
      tags: normalizeFalTags(input.stylePrompt, input),
      lyrics: isInstrumentalInput(input) ? undefined : input.lyrics || undefined,
      duration: lengthSeconds(input),
    };
  } else if (kind === 'stable-audio') {
    body = {
      prompt: buildElevenLabsPrompt(input),
      seconds_total: lengthSeconds(input, 30),
      steps: Number(process.env.MUSIC_FAL_STABLE_AUDIO_STEPS || 100),
    };
  } else if (kind === 'minimax-reference') {
    body = {
      prompt: minimaxPrompt(input),
      reference_audio_url: cleanReferences[0]?.url,
    };
  } else {
    body = {
      prompt: input.stylePrompt,
      lyrics: input.lyrics || undefined,
      duration_ms: typeof input.lengthMs === 'number' ? input.lengthMs : undefined,
      output_format: input.outputFormat,
    };
  }

  if (cleanReferences.length > 0 && kind !== 'minimax-reference') {
    body.references = cleanReferences;
  }
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

// fal: async queue (submit → poll status_url → fetch response_url), same protocol
// as filmmaker. Returns the parsed final response and the surface task id.
async function runFalGeneration(input: NormalizedMusicGenerateInput, surface: MusicSurfaceConfig, apiKey: string): Promise<{
  taskId: string;
  audioUrl: string;
  response: Record<string, unknown>;
}> {
  const baseUrl = process.env.FAL_BASE_URL || 'https://queue.fal.run';
  const surfaceSubmitPath = surface.submitPathEnv ? process.env[surface.submitPathEnv] : undefined;
  const legacySubmitPath = surface.surface === 'fal' ? process.env.MUSIC_FAL_SUBMIT_PATH : undefined;
  const submitPath = surfaceSubmitPath || legacySubmitPath || surface.modelId;
  const submitUrl = `${baseUrl.replace(/\/$/, '')}/${submitPath.replace(/^\//, '')}`;
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const createResponse = await fetchJson(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(await buildFalBody(input, surface)),
  });
  const taskId = extractTaskId(createResponse);
  if (!taskId) throw new Error(`fal response did not include request_id/task_id: ${JSON.stringify(createResponse).slice(0, 500)}`);

  const statusUrl = typeof createResponse.status_url === 'string'
    ? createResponse.status_url
    : `${submitUrl}/requests/${taskId}/status`;
  const responseUrl = typeof createResponse.response_url === 'string'
    ? createResponse.response_url
    : `${submitUrl}/requests/${taskId}`;
  const intervalMs = Number(process.env.MUSIC_POLL_INTERVAL_MS ?? 5000);
  const timeoutMs = Number(process.env.MUSIC_POLL_TIMEOUT_MS ?? 600000);
  const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 600000);

  while (Date.now() < deadline) {
    // Each tick is bounded by whatever is left of the poll budget, so a stalled
    // socket cannot outlive the deadline this loop is supposed to enforce.
    const tickBudgetMs = remainingRequestBudgetMs(deadline);
    if (tickBudgetMs === undefined) break;
    const statusResponse = await fetchJson(statusUrl, { method: 'GET', headers }, tickBudgetMs);
    const status = String(statusResponse.status ?? statusResponse.state ?? '');
    if (statusIsComplete(status)) {
      const finalResponse = await fetchJson(
        responseUrl,
        { method: 'GET', headers },
        remainingRequestBudgetMs(deadline) ?? 30_000,
      );
      const audioUrl = extractAudioUrl(finalResponse);
      if (!audioUrl) {
        throw new Error(`Generation completed but no audio URL was found: ${JSON.stringify(finalResponse).slice(0, 1000)}`);
      }
      return { taskId, audioUrl, response: finalResponse };
    }
    if (statusIsFailed(status)) {
      throw new Error(`fal task ${taskId} failed: ${JSON.stringify(statusResponse).slice(0, 1000)}`);
    }
    await sleep(Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000);
  }
  throw new Error(`fal task ${taskId} timed out after ${Math.round((Number(process.env.MUSIC_POLL_TIMEOUT_MS ?? 600000)) / 1000)}s`);
}

// ElevenLabs POST /v1/music is SYNCHRONOUS: it returns the audio bytes in the
// response body, so there is no queue/poll. We write the bytes straight to disk
// and synthesize a local task id. This is the key transport difference from the
// filmmaker domain, encoded as surface.responseMode === 'sync-bytes'.
async function runSyncBytesGeneration(
  input: NormalizedMusicGenerateInput,
  surface: MusicSurfaceConfig,
  apiKey: string,
  outPath: string,
): Promise<{ taskId: string; audioPath: string }> {
  const baseUrl = (process.env[surface.baseUrlEnv] || surface.defaultBaseUrl || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error(`missing base url: set ${surface.baseUrlEnv}`);
  const submitPath = process.env[surface.submitPathEnv ?? ''] || '/v1/music';
  const url = `${baseUrl}/${submitPath.replace(/^\//, '')}`;

  const body: Record<string, unknown> = {
    prompt: buildElevenLabsPrompt(input),
    music_length_ms: typeof input.lengthMs === 'number' ? input.lengthMs : undefined,
    output_format: input.outputFormat,
    model_id: surface.modelId,
  };
  // K11/I3 — the synchronous ElevenLabs render had no bound at all, while
  // `lengthMs` can request up to ten minutes of audio. Scale the ceiling with
  // the requested length instead of guessing one number.
  const elevenLabsTimeoutMs = Math.min(
    600_000,
    Math.max(120_000, (typeof input.lengthMs === 'number' ? input.lengthMs : 0) * 2),
  );
  const response = await fetchWithDeadline(url, {
    method: 'POST',
    timeoutMs: elevenLabsTimeoutMs,
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 500)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outPath, bytes);
  return { taskId: `elevenlabs-${randomUUID()}`, audioPath: outPath };
}

export const musicGenerateTool = createTool({
  id: 'music_generate',
  description:
    'Generates a track through the configured remote music surface. Pre-validates prompt-spec, safety, surface payload, and scoped approval, enforces spend caps, then either polls (fal async) or writes sync audio bytes (ElevenLabs), downloads the audio, and writes a generation-run ledger row.',
  inputSchema: musicGenerateInputSchema,
  outputSchema: musicGenerateOutputSchema,
  execute: withToolEnvelope<MusicGenerateInput, MusicGenerateOutput>({
    toolId: 'music_generate',
    category: 'other',
    risk: 'medium',
    defaultAgentId: META_AGENT_ID,
    redactInputFields: ['stylePrompt', 'lyrics', 'referenceAudio'],
    metadata: (input) => ({
      agentId: input.callerAgentId ?? META_AGENT_ID,
      taskId: input.taskId,
    }),
    execute: async (rawContext) => {
      const context = musicGenerateInputSchema.parse(rawContext);
      const music = new MusicService();
      const project = await music.getProject(context.projectId);
      const surface = resolveMusicSurface({
        provider: context.provider as MusicProvider | undefined,
        surface: context.surface as MusicSurfaceName | undefined,
      });
      const runId = `music-run-${randomUUID()}`;
      const referenceTags = context.referenceAudio.map((ref) => ref.tag ?? ref.role);

      const baseRun = musicGenerationRunSchema.parse({
        run_id: runId,
        project_id: context.projectId,
        track_id: context.trackId,
        surface: surface.surface,
        provider: surface.provider,
        model_id: surface.modelId,
        prompt_version: context.promptVersion,
        input_mode: context.mode,
        reference_tags: referenceTags,
        prompt: context.stylePrompt,
        result_status: 'submitted',
        is_synthetic_fixture: false,
        created_at: new Date().toISOString(),
      });

      try {
        if (!project) {
          return { ok: false, error: `Music project not found: ${context.projectId}` };
        }
        if (!surface.enabled) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            terminal: true,
            error: `surface_disabled: ${surface.surface} is not configured (set ${surface.baseUrlEnv}). For Suno this is a ToS-compliant gateway seam, never a scraper.`,
          };
        }

        // Hard spend cap (code-enforced loop guard). Fires BEFORE approval/remote,
        // so a runaway repair/retry loop cannot keep paying — regardless of caller.
        const perTrackCap = maxPaidGenerationsPerTrack();
        const perProjectCap = maxPaidGenerationsPerProject();
        if (perTrackCap > 0) {
          const trackAttempts = await music.countGenerationAttempts(context.projectId, context.trackId);
          if (trackAttempts >= perTrackCap) {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: surface.modelId,
              terminal: true,
              error: `paid_generation_cap_reached: track ${context.trackId} already has ${trackAttempts} paid generation attempt(s); the per-track limit is ${perTrackCap} (MUSIC_MAX_PAID_GENERATIONS_PER_TRACK). This is TERMINAL — do NOT retry and do NOT start another track to continue the same user task. Stop and report to the user; raise the env limit only with explicit user approval.`,
            };
          }
        }
        if (perProjectCap > 0) {
          const projectAttempts = await music.countGenerationAttempts(context.projectId);
          if (projectAttempts >= perProjectCap) {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: surface.modelId,
              terminal: true,
              error: `paid_generation_cap_reached: project ${context.projectId} already has ${projectAttempts} paid generation attempt(s); the per-project limit is ${perProjectCap} (MUSIC_MAX_PAID_GENERATIONS_PER_PROJECT). This is TERMINAL — do NOT retry. Stop and report to the user.`,
            };
          }
        }

        const lint = lintMusicPromptSpec({
          project_id: context.projectId,
          track_id: context.trackId,
          prompt_version: context.promptVersion,
          generation_mode: context.mode,
          language: context.language,
          vocal_type: context.vocalType,
          style_prompt: context.stylePrompt,
          lyrics: context.lyrics,
          structure: context.structure,
          length_ms: context.lengthMs ?? null,
          output_format: context.outputFormat,
          reference_audio: context.referenceAudio.map((ref) => ({
            tag: ref.tag,
            role: ref.role,
            url: ref.url,
            path: ref.path,
          })),
        });
        if (lint.errors.length > 0) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            error: `prompt_lint_failed: ${lint.errors.join('; ')}`,
          };
        }

        const safety = checkMusicSafety(context.stylePrompt, context.lyrics);
        if (safety.blocked) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            terminal: true,
            error: `pre_send_safety_failed: ${safety.issues.join(' ')}`,
          };
        }

        const capabilityErrors = validateMusicSurfaceRequest({
          surfaceConfig: surface,
          mode: context.mode,
          lengthMs: context.lengthMs,
          outputFormat: context.outputFormat,
          referenceCount: context.referenceAudio.length,
        });
        if (capabilityErrors.length > 0) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            terminal: true,
            error: `surface_capability_failed: ${capabilityErrors.join('; ')}`,
          };
        }

        const payloadErrors = validateSurfacePayload(context, surface);
        if (payloadErrors.length > 0) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            terminal: true,
            error: `provider_input_failed: ${payloadErrors.join('; ')}`,
          };
        }

        if (requireApproval()) {
          if (!context.approvalToken) {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: surface.modelId,
              error: 'approval_required',
              approvalRequest: {
                tool: 'music_generate',
                action: `Generate paid track for project ${context.projectId}, track ${context.trackId} on ${surface.surface}.`,
                args: {
                  projectId: context.projectId,
                  trackId: context.trackId,
                  provider: surface.provider,
                  surface: surface.surface,
                  modelId: surface.modelId,
                  mode: context.mode,
                  lengthMs: context.lengthMs,
                  outputFormat: context.outputFormat,
                },
              },
              approvalToken: context.approvalToken,
            };
          }
          // Resolve live status WITHOUT throwing so pending / denied / approved
          // stay distinct — throwing would be logged as a 'rejected' run, which
          // models treat as retryable → the approval-retry loop. Each branch is
          // terminal except the approved pass-through.
          const approvalStatus = await music.getApprovalStatus(context.approvalToken);
          if (approvalStatus === 'pending') {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: surface.modelId,
              error: 'awaiting_user_approval',
              approvalToken: context.approvalToken,
            };
          }
          if (approvalStatus !== 'approved') {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: surface.modelId,
              terminal: true,
              error: `approval_${approvalStatus}: ${context.approvalToken}`,
              approvalToken: context.approvalToken,
            };
          }
          const approval = await music.getApprovalRecord(context.approvalToken);
          const scopeErrors = approval ? approvalScopeErrors(approval, context, surface) : ['approval record missing'];
          if (scopeErrors.length > 0) {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: surface.modelId,
              terminal: true,
              error: `approval_scope_mismatch: ${scopeErrors.join('; ')}. Request a new approval for this exact project/track/surface/mode/model; do NOT reuse this token.`,
              approvalToken: context.approvalToken,
            };
          }
          await music.approvePaidGeneration(context.projectId, context.approvalToken);
        }

        const apiKey = process.env[surface.apiKeyEnv];
        if (!apiKey) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            error: `missing_api_key: ${surface.apiKeyEnv}`,
          };
        }

        await music.appendGenerationRun(baseRun);

        const outDir = outputDirFor(context);
        await mkdir(outDir, { recursive: true });
        const ext = context.outputFormat === 'wav' ? '.wav' : context.outputFormat === 'pcm' ? '.pcm' : '.mp3';
        // The actual on-disk path: for fal it follows the downloaded URL extension,
        // for sync-bytes it is the requested output format. We reassign it in the
        // fal branch so the ledger's audio_path always points at the real file the
        // dashboard player streams.
        let audioPath = resolve(outDir, `${runId}${ext}`);

        let taskId: string;
        let outputUrl: string | undefined;
        let moderation: unknown;
        let costEstimate: unknown;

        if (surface.responseMode === 'sync-bytes') {
          const result = await runSyncBytesGeneration(context, surface, apiKey, audioPath);
          taskId = result.taskId;
        } else {
          const remote = await runFalGeneration(context, surface, apiKey);
          taskId = remote.taskId;
          outputUrl = remote.audioUrl;
          moderation = remote.response.moderation;
          costEstimate = remote.response.cost ?? remote.response.cost_estimate;
          const urlExt = extname(new URL(remote.audioUrl).pathname) || ext;
          audioPath = resolve(outDir, `${runId}${urlExt}`);
          await downloadFile(remote.audioUrl, audioPath);
        }

        await music.appendGenerationRun({
          ...baseRun,
          task_id: taskId,
          result_status: 'generated',
          audio_path: audioPath,
          output_url: outputUrl,
          length_ms: context.lengthMs ?? undefined,
        });

        return {
          ok: true,
          audioPath,
          taskId,
          runId,
          provider: surface.provider,
          surface: surface.surface,
          modelId: surface.modelId,
          lengthMs: context.lengthMs ?? undefined,
          outputUrl,
          moderation,
          costEstimate,
        };
      } catch (error) {
        const message = (error as Error).message;
        const classified = classifyMusicGenerationError(message);
        await music.appendGenerationRun({
          ...baseRun,
          result_status: 'rejected',
          error: classified ? `${classified.code}: ${message}` : message,
        }).catch(() => undefined);
        return {
          ok: false,
          runId,
          provider: surface.provider,
          surface: surface.surface,
          modelId: surface.modelId,
          terminal: classified?.terminal || undefined,
          error: classified
            ? `${classified.code} (TERMINAL — ${classified.detail}; do NOT retry the identical request): ${message}`
            : message,
        };
      }
    },
  }),
});
