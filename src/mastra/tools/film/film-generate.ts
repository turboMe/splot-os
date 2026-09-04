import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  resolveFilmModelId,
  resolveFilmSurface,
  validateFilmSurfaceRequest,
  type FilmProvider,
  type FilmSurfaceName,
} from '../../config/film-surfaces.js';
import { FilmService } from './film-service.js';
import { filmGenerationModeSchema, filmGenerationRunSchema } from '../../lib/film-schemas.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { META_AGENT_ID } from '../../config/agent-ids.js';
import { lintFilmPromptMarkdown } from './film-validators.js';
import { fetchWithDeadline, remainingRequestBudgetMs } from '../../lib/http-deadline.js';

const referenceRoleSchema = z.object({
  tag: z.string().optional(),
  role: z.string().min(1),
  url: z.string().url().optional(),
  path: z.string().optional(),
});

const filmGenerateInputSchema = z.object({
  projectId: z.string().min(1),
  clipId: z.string().min(1),
  mode: filmGenerationModeSchema.default('T2V'),
  prompt: z.string().min(1),
  promptVersion: z.string().default('v1'),
  durationSec: z.number().int().min(1).optional(),
  aspectRatio: z.string().optional(),
  resolution: z.string().optional(),
  referenceRoles: z.array(referenceRoleSchema).default([]),
  compiledPromptMarkdown: z.string().optional(),
  provider: z.enum(['seedance', 'veo']).optional(),
  surface: z.string().optional(),
  workspaceDir: z.string().optional(),
  approvalToken: z.string().optional(),
  callerAgentId: z.string().optional(),
  taskId: z.string().optional(),
});

const filmGenerateOutputSchema = z.object({
  ok: z.boolean(),
  videoPath: z.string().optional(),
  lastFramePath: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  provider: z.string().optional(),
  surface: z.string().optional(),
  modelId: z.string().optional(),
  durationSec: z.number().optional(),
  moderation: z.unknown().optional(),
  costEstimate: z.unknown().optional(),
  error: z.string().optional(),
  // True when the failure is final and MUST NOT be retried: paid-spend cap
  // reached, or fal moderated the generated output (content_policy_violation).
  // Re-submitting the identical request just burns another paid generation.
  terminal: z.boolean().optional(),
  approvalRequest: z.object({
    tool: z.string(),
    action: z.string(),
    args: z.record(z.string(), z.unknown()),
  }).optional(),
  approvalToken: z.string().optional(),
});

type FilmGenerateInput = z.input<typeof filmGenerateInputSchema>;
type NormalizedFilmGenerateInput = z.output<typeof filmGenerateInputSchema>;
type FilmGenerateOutput = z.output<typeof filmGenerateOutputSchema>;

function promptLintMarkdown(input: NormalizedFilmGenerateInput, sourceBrief: string): string {
  if (input.compiledPromptMarkdown?.trim()) return input.compiledPromptMarkdown;
  return [
    '## Source Brief',
    sourceBrief,
    '',
    '## Internal Prompt Specification',
    '```json',
    JSON.stringify({
      project_id: input.projectId,
      clip_id: input.clipId,
      prompt_version: input.promptVersion,
      generation_mode: input.mode,
      reference_roles: input.referenceRoles.map((ref) => ({
        tag: ref.tag,
        role: ref.role,
        url: ref.url,
        path: ref.path,
      })),
    }, null, 2),
    '```',
    '',
    '## Compiled Natural-Language Prompt',
    input.prompt,
    '',
    '## Lint Result',
    'lint: pass',
    '',
    '## Control-Critical Sentences',
    'why this remains: it preserves the requested clip action, mode, references, and prompt text submitted for generation.',
    '',
  ].join('\n');
}

function requireApproval(): boolean {
  return process.env.FILM_REQUIRE_APPROVAL !== 'false';
}

// Env-configurable hard caps on paid generations. A value <= 0 (or unset/NaN
// falling back to the default) keeps the cap on; set explicitly to 0 to disable.
// These are enforced inside the tool, so meta, filmmaker, and workers are all
// bounded identically — no agent can loop paid generation past the budget.
function maxPaidGenerationsPerClip(): number {
  const raw = process.env.FILM_MAX_PAID_GENERATIONS_PER_CLIP;
  const value = raw === undefined || raw === '' ? 3 : Number(raw);
  return Number.isFinite(value) ? value : 3;
}

function maxPaidGenerationsPerProject(): number {
  const raw = process.env.FILM_MAX_PAID_GENERATIONS_PER_PROJECT;
  const value = raw === undefined || raw === '' ? 12 : Number(raw);
  return Number.isFinite(value) ? value : 12;
}

// fal moderates the GENERATED output (e.g. "Output audio has sensitive content")
// and returns HTTP 422 content_policy_violation. That is terminal for the
// identical request: re-submitting it reproduces the same moderated output and
// wastes another paid generation. Detect it so the catch can mark it terminal.
function isContentPolicyViolation(message: string): boolean {
  return /content_policy_violation/i.test(message) || /sensitive content/i.test(message);
}

function outputDirFor(input: NormalizedFilmGenerateInput): string {
  const base = input.workspaceDir || process.env.FILM_OUTPUT_DIR || `film-work/${input.projectId}`;
  return isAbsolute(base) ? resolve(base) : resolve(process.cwd(), base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function safetyErrors(prompt: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\b(evade|bypass|avoid)\s+(moderation|filter|safety)\b/i, 'Prompt appears to request moderation/filter evasion.'],
    [/\bdeepfake\b/i, 'Prompt uses deepfake wording; require explicit rights/consent and rewrite safely.'],
    [/\bexact\s+(likeness|voice)\s+of\b/i, 'Prompt requests exact likeness/voice; require rights/consent and source-gated rewrite.'],
    [/\bunderage\b.{0,80}\b(sexual|seductive|erotic)\b/i, 'Prompt contains disallowed underage sexualized content.'],
  ];
  return checks.filter(([pattern]) => pattern.test(prompt)).map(([, message]) => message);
}

function guessMime(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

async function referenceValue(ref: z.infer<typeof referenceRoleSchema>): Promise<string | undefined> {
  if (ref.url) return ref.url;
  if (!ref.path) return undefined;
  const cwd = resolve(process.cwd());
  const tmp = resolve('/tmp');
  let fullPath = isAbsolute(ref.path) ? resolve(ref.path) : resolve(cwd, ref.path);
  // Recover slash-stripped workspace paths: agents misled by the workspace file
  // tools' error hint sometimes drop the leading "/" from an absolute path
  // (e.g. "projekty/.../public/x.jpg"). If the cwd-relative resolution does not
  // exist but the filesystem-absolute form does, use that. The workspace/tmp
  // guard below still applies, so this cannot escape the sandbox.
  if (!isAbsolute(ref.path) && !existsSync(fullPath) && existsSync(resolve('/', ref.path))) {
    fullPath = resolve('/', ref.path);
  }
  if (fullPath !== cwd && !fullPath.startsWith(`${cwd}/`) && !fullPath.startsWith(`${tmp}/`)) {
    throw new Error(`Reference path is outside workspace/tmp and cannot be sent: ${ref.path}`);
  }
  if (!existsSync(fullPath)) throw new Error(`Reference path does not exist: ${ref.path}`);
  const info = await stat(fullPath);
  if (info.size > 10 * 1024 * 1024) {
    throw new Error(`Reference path is too large for inline upload (${Math.round(info.size / 1024 / 1024)}MB): ${ref.path}`);
  }
  const bytes = await readFile(fullPath);
  return `data:${guessMime(fullPath)};base64,${bytes.toString('base64')}`;
}

async function buildFalBody(input: NormalizedFilmGenerateInput): Promise<Record<string, unknown>> {
  const references = await Promise.all(input.referenceRoles.map(async (ref) => ({
    tag: ref.tag,
    role: ref.role,
    url: await referenceValue(ref),
  })));
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    duration: typeof input.durationSec === 'number' ? String(input.durationSec) : undefined,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
  };
  const cleanReferences = references.filter((ref) => ref.url);
  if (cleanReferences.length > 0) {
    body.references = cleanReferences;
    const firstImage = cleanReferences.find((ref) => /frame|image|first|last|reference|identity/i.test(ref.role));
    const firstVideo = cleanReferences.find((ref) => /video|motion|source/i.test(ref.role));
    if (firstImage?.url) body.image_url = firstImage.url;
    if (firstVideo?.url) body.video_url = firstVideo.url;
  }
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
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
    for (const key of ['url', 'video_url', 'download_url']) {
      const found = extractUrl(record[key]);
      if (found) return found;
    }
  }
  return undefined;
}

function extractOutputUrls(response: Record<string, unknown>): { videoUrl?: string; lastFrameUrl?: string } {
  const videoUrl =
    extractUrl(response.video) ||
    extractUrl(response.output) ||
    extractUrl(response.result) ||
    extractUrl(response.video_url) ||
    extractUrl(response.url);
  const lastFrameUrl =
    extractUrl(response.last_frame) ||
    extractUrl(response.last_frame_url) ||
    extractUrl(response.thumbnail) ||
    extractUrl(response.image);
  return { videoUrl, lastFrameUrl };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  // K11 — a poll tick without a deadline can hang forever on a stalled socket,
  // and the `while (Date.now() < deadline)` loop above would then never re-check
  // its own budget: the documented 600s poll silently becomes infinite.
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
  // Rendered video can be large, so this gets a longer bound than a poll tick —
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

async function runFalGeneration(input: NormalizedFilmGenerateInput, apiKey: string, modelId: string): Promise<{
  taskId: string;
  response: Record<string, unknown>;
}> {
  const baseUrl = process.env.FAL_BASE_URL || 'https://queue.fal.run';
  const submitPath = process.env.FILM_FAL_SUBMIT_PATH || modelId;
  const submitUrl = `${baseUrl.replace(/\/$/, '')}/${submitPath.replace(/^\//, '')}`;
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const createResponse = await fetchJson(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(await buildFalBody(input)),
  });
  const taskId = extractTaskId(createResponse);
  if (!taskId) throw new Error(`fal response did not include request_id/task_id: ${JSON.stringify(createResponse).slice(0, 500)}`);

  const statusUrl = typeof createResponse.status_url === 'string'
    ? createResponse.status_url
    : `${submitUrl}/requests/${taskId}/status`;
  const responseUrl = typeof createResponse.response_url === 'string'
    ? createResponse.response_url
    : `${submitUrl}/requests/${taskId}`;
  const intervalMs = Number(process.env.FILM_POLL_INTERVAL_MS ?? 5000);
  const timeoutMs = Number(process.env.FILM_POLL_TIMEOUT_MS ?? 600000);
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
      return { taskId, response: finalResponse };
    }
    if (statusIsFailed(status)) {
      throw new Error(`fal task ${taskId} failed: ${JSON.stringify(statusResponse).slice(0, 1000)}`);
    }
    await sleep(Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000);
  }
  throw new Error(`fal task ${taskId} timed out after ${Math.round((Number(process.env.FILM_POLL_TIMEOUT_MS ?? 600000)) / 1000)}s`);
}

export const filmGenerateTool = createTool({
  id: 'film_generate',
  description:
    'Generates a Seedance video through the configured remote surface. Pre-validates prompt, requires first paid-run approval, polls, downloads MP4, and writes a generation-run ledger row.',
  inputSchema: filmGenerateInputSchema,
  outputSchema: filmGenerateOutputSchema,
  execute: withToolEnvelope<FilmGenerateInput, FilmGenerateOutput>({
    toolId: 'film_generate',
    category: 'other',
    risk: 'medium',
    defaultAgentId: META_AGENT_ID,
    redactInputFields: ['prompt', 'compiledPromptMarkdown', 'referenceRoles'],
    metadata: (input) => ({
      agentId: input.callerAgentId ?? META_AGENT_ID,
      taskId: input.taskId,
    }),
    execute: async (rawContext) => {
      const context = filmGenerateInputSchema.parse(rawContext);
      const film = new FilmService();
      const project = await film.getProject(context.projectId);
      const surface = resolveFilmSurface({
        provider: context.provider as FilmProvider | undefined,
        surface: context.surface as FilmSurfaceName | undefined,
      });
      // Pick the endpoint that matches the generation mode. Image-driven modes
      // (I2V/FLF2V/R2V/V2V) must NOT submit to the text-to-video model, which
      // ignores the supplied photo and yields a clip unrelated to it.
      const effectiveModelId = resolveFilmModelId(surface, context.mode);
      const runId = `film-run-${randomUUID()}`;
      const referenceTags = context.referenceRoles.map((ref) => ref.tag ?? ref.role);

      const baseRun = filmGenerationRunSchema.parse({
        run_id: runId,
        project_id: context.projectId,
        clip_id: context.clipId,
        surface: surface.surface,
        provider: surface.provider,
        model_id: effectiveModelId,
        prompt_version: context.promptVersion,
        input_mode: context.mode,
        reference_tags: referenceTags,
        prompt: context.prompt,
        result_status: 'submitted',
        is_synthetic_fixture: false,
        created_at: new Date().toISOString(),
      });

      try {
        if (!project) {
          return { ok: false, error: `Film project not found: ${context.projectId}` };
        }
        if (surface.provider === 'veo') {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            error: 'veo provider not implemented in filmmaker v1',
          };
        }

        // Hard spend cap (code-enforced loop guard). Count paid attempts already
        // recorded for this clip/project and refuse a new remote call once the
        // budget is exhausted. This fires BEFORE approval/fal, so a runaway
        // repair/retry loop cannot keep paying — regardless of which agent calls.
        const perClipCap = maxPaidGenerationsPerClip();
        const perProjectCap = maxPaidGenerationsPerProject();
        if (perClipCap > 0) {
          const clipAttempts = await film.countGenerationAttempts(context.projectId, context.clipId);
          if (clipAttempts >= perClipCap) {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: effectiveModelId,
              terminal: true,
              error: `paid_generation_cap_reached: clip ${context.clipId} already has ${clipAttempts} paid generation attempt(s); the per-clip limit is ${perClipCap} (FILM_MAX_PAID_GENERATIONS_PER_CLIP). This is TERMINAL — do NOT retry. The clip's paid-generation budget is exhausted; stop and report to the user (raise the env limit or start a new clip to continue).`,
            };
          }
        }
        if (perProjectCap > 0) {
          const projectAttempts = await film.countGenerationAttempts(context.projectId);
          if (projectAttempts >= perProjectCap) {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: effectiveModelId,
              terminal: true,
              error: `paid_generation_cap_reached: project ${context.projectId} already has ${projectAttempts} paid generation attempt(s); the per-project limit is ${perProjectCap} (FILM_MAX_PAID_GENERATIONS_PER_PROJECT). This is TERMINAL — do NOT retry. Stop and report to the user.`,
            };
          }
        }

        const promptLint = await lintFilmPromptMarkdown(promptLintMarkdown(
          context,
          project.state.story.objective || project.name,
        ));
        if (!promptLint.ok) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            error: `prompt_lint_failed: ${promptLint.errors.join('; ') || promptLint.rawOutput || 'unknown lint failure'}`,
          };
        }

        const safety = safetyErrors(context.prompt);
        if (safety.length > 0) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            error: `pre_send_safety_failed: ${safety.join(' ')}`,
          };
        }

        const capabilityErrors = validateFilmSurfaceRequest({
          surfaceConfig: surface,
          mode: context.mode,
          durationSec: context.durationSec,
          aspectRatio: context.aspectRatio,
          resolution: context.resolution,
          referenceCount: context.referenceRoles.length,
        });
        if (capabilityErrors.length > 0) {
          return {
            ok: false,
            provider: surface.provider,
            surface: surface.surface,
            modelId: surface.modelId,
            error: `surface_capability_failed: ${capabilityErrors.join('; ')}`,
          };
        }

        if (requireApproval() && !project.paidGenerationApproved) {
          if (!context.approvalToken) {
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: surface.modelId,
              error: 'approval_required',
              approvalRequest: {
                tool: 'film_generate',
                action: `Generate paid Seedance video for project ${context.projectId}, clip ${context.clipId} on ${surface.surface}.`,
                args: {
                  projectId: context.projectId,
                  clipId: context.clipId,
                  surface: surface.surface,
                  mode: context.mode,
                  durationSec: context.durationSec,
                },
              },
              approvalToken: context.approvalToken,
            };
          }
          // A token was passed. Resolve its live status WITHOUT throwing so we can
          // tell apart pending / denied / approved. Throwing here is caught below
          // and logged as a 'rejected' generation-run, which the models treat as
          // retryable → the approval-retry loop. Each branch below is terminal.
          const approvalStatus = await film.getApprovalStatus(context.approvalToken);
          if (approvalStatus === 'pending') {
            // The user has not approved yet. This is NOT a failure to retry — it is a
            // wait state. Emit no ledger run, return a clear non-retryable signal, and
            // hand the same stable token back so the next turn (after the user
            // approves) can pass it straight through.
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
            // 'denied' or 'missing' — terminal. Do not retry or mint a new token.
            return {
              ok: false,
              provider: surface.provider,
              surface: surface.surface,
              modelId: surface.modelId,
              error: `approval_${approvalStatus}: ${context.approvalToken}`,
              approvalToken: context.approvalToken,
            };
          }
          // approvalStatus === 'approved' → pass the token through to generation.
          await film.approvePaidGeneration(context.projectId, context.approvalToken);
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

        await film.appendGenerationRun(baseRun);
        const remote = await runFalGeneration(context, apiKey, effectiveModelId);
        const urls = extractOutputUrls(remote.response);
        if (!urls.videoUrl) {
          throw new Error(`Generation completed but no video URL was found: ${JSON.stringify(remote.response).slice(0, 1000)}`);
        }

        const outDir = outputDirFor(context);
        await mkdir(outDir, { recursive: true });
        const videoExt = extname(new URL(urls.videoUrl).pathname) || '.mp4';
        const videoPath = resolve(outDir, `${runId}${videoExt}`);
        await downloadFile(urls.videoUrl, videoPath);

        let lastFramePath: string | undefined;
        if (urls.lastFrameUrl) {
          const frameExt = extname(new URL(urls.lastFrameUrl).pathname) || '.png';
          lastFramePath = resolve(outDir, `${runId}-last-frame${frameExt}`);
          await downloadFile(urls.lastFrameUrl, lastFramePath);
        }

        await film.appendGenerationRun({
          ...baseRun,
          task_id: remote.taskId,
          result_status: 'generated',
          video_path: videoPath,
          last_frame_path: lastFramePath,
          output_url: urls.videoUrl,
        });

        return {
          ok: true,
          videoPath,
          lastFramePath,
          taskId: remote.taskId,
          runId,
          provider: surface.provider,
          surface: surface.surface,
          modelId: surface.modelId,
          durationSec: context.durationSec,
          moderation: remote.response.moderation,
          costEstimate: remote.response.cost ?? remote.response.cost_estimate,
        };
      } catch (error) {
        const message = (error as Error).message;
        const contentPolicy = isContentPolicyViolation(message);
        await film.appendGenerationRun({
          ...baseRun,
          result_status: 'rejected',
          error: message,
        }).catch(() => undefined);
        return {
          ok: false,
          runId,
          provider: surface.provider,
          surface: surface.surface,
          modelId: effectiveModelId,
          // A content-policy rejection is terminal: fal moderated the generated
          // output, so re-submitting the identical request burns another paid
          // generation for the same blocked result. Do not retry unchanged.
          terminal: contentPolicy || undefined,
          error: contentPolicy
            ? `content_policy_violation (TERMINAL — fal moderated the generated output; do NOT retry the identical request. Either change the request to avoid moderation, e.g. the audio track, or stop and report to the user): ${message}`
            : message,
        };
      }
    },
  }),
});
