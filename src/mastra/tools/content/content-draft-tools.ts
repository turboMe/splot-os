/**
 * content_save_draft + content_schedule — the ship-phase tools for the contentAgent.
 *
 * content_save_draft persists one finished post to the shared DraftsStore
 * (lib/drafts-store.ts) in the exact on-disk format the jarvis dashboard reads, so
 * contentAgent output shows up alongside weekly-content output. It FIXES the
 * observability bug from weekly-content.ts, which hardcoded
 * `llm: { provider: 'mastra', model: 'gemma', costUsd: 0 }` for every draft: this
 * tool writes the contentAgent's REAL model (resolved from the model manifest) and
 * the actual cost the caller reports.
 *
 * content_schedule wraps calendar_create_event to drop a publication reminder.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDraftsStore, type DraftMetadata } from '../../lib/drafts-store.js';
import { agentModels, resolveModelId } from '../../config/model-manifest.js';
import { calendarCreateEventTool } from '../google/google-tools.js';

const PLATFORM_TO_TYPE: Record<string, string> = {
  linkedin: 'linkedin-post',
  instagram: 'instagram-caption',
  tiktok: 'tiktok-script',
};

/** Splits a resolved model id ("google/gemini-3.5-flash") into provider + model. */
function splitModelId(modelId: string): { provider: string; model: string } {
  const idx = modelId.indexOf('/');
  if (idx === -1) return { provider: 'unknown', model: modelId };
  return { provider: modelId.slice(0, idx), model: modelId.slice(idx + 1) };
}

export const contentSaveDraftTool = createTool({
  id: 'content_save_draft',
  description:
    'Saves ONE finished post to the drafts store (same format the dashboard reads). Writes the post body, hashtags and full metadata including the image prompt. Records REAL observability — the contentAgent model + the cost you report — instead of placeholder values. Call once per platform variant in the SHIP phase, after content_quality_check passes.',
  inputSchema: z.object({
    projectId: z.string().describe('Content project UUID (used as taskId so drafts group under the project).'),
    platform: z.enum(['linkedin', 'instagram', 'tiktok']).describe('Target platform.'),
    language: z.enum(['pl', 'en']).default('pl').describe('Copy language.'),
    topic: z.string().describe('Short topic/title for the post.'),
    content: z.string().describe('The final post body / caption / script (Markdown allowed).'),
    hashtags: z.array(z.string()).optional().default([]).describe('Final, normalized hashtags.'),
    imagePrompt: z
      .string()
      .optional()
      .describe('The image-generation prompt for this post (prompts only — no image is generated/stored).'),
    rationale: z.string().optional().describe('Why this post/angle — kept in metadata for review.'),
    scheduledFor: z.string().optional().describe('Planned publish time (ISO). Stored in metadata.'),
    weekStarting: z.string().optional().describe('Week anchor (ISO date) this batch belongs to.'),
    type: z
      .string()
      .optional()
      .describe('Override the draft type label (defaults from platform: linkedin-post/instagram-caption/tiktok-script).'),
    model: z
      .string()
      .optional()
      .describe('Override the recorded model id. Defaults to the contentAgent model from the manifest.'),
    costUsd: z
      .number()
      .optional()
      .default(0)
      .describe('Actual generation cost in USD for observability. Pass the real figure if known.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    draftId: z.string().optional(),
    path: z.string().optional(),
    type: z.string().optional(),
    llm: z.object({ provider: z.string(), model: z.string(), costUsd: z.number() }).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const store = getDraftsStore();
      await store.ensureBaseDir();

      const platform = context.platform;
      const type = context.type?.trim() || PLATFORM_TO_TYPE[platform] || `${platform}-post`;
      const language = context.language ?? 'pl';
      const hashtags = context.hashtags ?? [];
      const draftId = `${platform}-${language}-${randomUUID().slice(0, 6)}`;
      const taskId = context.projectId;

      // Observability fix: record the REAL model (resolved from the manifest) + cost,
      // not the hardcoded gemma/0 placeholder weekly-content.ts wrote.
      const modelId = context.model?.trim() || resolveModelId(agentModels.contentAgent);
      const { provider, model } = splitModelId(modelId);
      const llm = { provider, model, costUsd: context.costUsd ?? 0 };

      const body = context.content.trim();
      const hashtagLine = hashtags.length > 0 ? `\n\n---\n${hashtags.join(' ')}` : '';
      const docContent = `# ${context.topic}${language === 'en' ? ' (EN)' : ''}\n\n${body}${hashtagLine}`;

      const metadata: DraftMetadata = {
        draftId,
        taskId,
        type,
        language,
        topic: context.topic,
        hashtags,
        charCount: body.length,
        rationale: context.rationale,
        scheduledFor: context.scheduledFor,
        weekStarting: context.weekStarting,
        createdAt: new Date().toISOString(),
        agentId: 'content-agent',
        llm,
        imagePrompt: context.imagePrompt,
      };

      const path = await store.save({ taskId, draftId, content: docContent, metadata });

      // Best-effort: refresh the Mongo draft index so the new post shows up in
      // workspace-ui immediately (the list view only auto-reindexes when empty).
      // A failure here must not sink the save — the FS write is the source of truth.
      try {
        const { reindexDrafts } = await import('../../services/draft-registry.js');
        await reindexDrafts();
      } catch {
        /* index refresh is advisory */
      }

      return { success: true, draftId, path, type, llm };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const contentScheduleTool = createTool({
  id: 'content_schedule',
  description:
    'Creates a Google Calendar publication reminder for a post. Use in the SHIP phase after saving the draft, so Patryk gets a nudge at publish time. Wraps calendar_create_event.',
  inputSchema: z.object({
    title: z.string().describe('Post title/topic for the reminder (the tool prefixes it with [PUBLISH]).'),
    platform: z.enum(['linkedin', 'instagram', 'tiktok']).optional().describe('Platform, included in the reminder title.'),
    scheduledFor: z.string().describe('Publish time (ISO, e.g. 2026-06-18T09:00:00Z).'),
    note: z.string().optional().describe('Extra context for the calendar description.'),
    projectId: z.string().optional().describe('Content project UUID, recorded in the description.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    eventId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const platformTag = context.platform ? `${context.platform[0].toUpperCase()}${context.platform.slice(1)}: ` : '';
      const descParts = [
        context.note,
        context.projectId ? `Project: ${context.projectId}` : undefined,
        `Publish at: ${context.scheduledFor}`,
      ].filter(Boolean);
      const result = (await calendarCreateEventTool.execute!(
        {
          title: `[PUBLISH] ${platformTag}${context.title}`,
          description: descParts.join('\n'),
          scheduledFor: context.scheduledFor,
        } as any,
        {} as any,
      )) as { success: boolean; eventId?: string; error?: string };
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});
