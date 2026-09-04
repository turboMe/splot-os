/**
 * content_add_note / content_search_notes — the contentAgent's learning loop.
 *
 * Clone of chef_add_note / chef_search_notes (chef-tools.ts). Notes are reusable
 * working knowledge accumulated across content projects: which hooks/voice landed,
 * platform-specific quirks, and human feedback. They embed semantically (regex
 * fallback) and are recalled in future runs so quality compounds over time.
 *
 * This is the "pętla uczenia" half of the chef moat — the deterministic artifact
 * (Content Pack) captures one project; notes carry lessons between projects.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ContentService } from './content-service.js';

export const contentAddNoteTool = createTool({
  id: 'content_add_note',
  description:
    'Saves a reusable content-craft note — a voice cue that landed, a high-performing hook pattern, a platform quirk, post-publication performance, or human feedback. Notes build a knowledge base reused across future content projects. Record a note whenever you learn something worth carrying forward.',
  inputSchema: z.object({
    content: z.string().min(1).describe('The note body.'),
    type: z
      .enum(['voice', 'hook', 'performance', 'platform', 'feedback', 'general'])
      .optional()
      .default('general')
      .describe('voice = founder-voice cue; hook = hook pattern that worked; performance = engagement result; platform = LI/IG/TikTok quirk; feedback = human note.'),
    topic: z.string().optional().describe('Short topic label (e.g. "LinkedIn hook: contrarian opener", "Patryk voice: no hype").'),
    projectId: z.string().optional().describe('Content project UUID, if the note is tied to a specific run.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    type: z.string().optional(),
    topic: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const content = new ContentService();
      const note = await content.addNote({
        content: context.content,
        type: context.type,
        topic: context.topic,
        projectId: context.projectId,
      });
      return { success: true, id: note.id, type: note.type, topic: note.topic };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const contentSearchNotesTool = createTool({
  id: 'content_search_notes',
  description:
    'Searches the content-craft notes (semantic, with regex fallback). Use at the start of strategy/draft work to recall what worked before — voice cues, hook patterns, platform lessons, prior feedback — so quality compounds across projects.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search query (e.g. "LinkedIn hooks that worked", "Patryk voice rules").'),
    projectId: z.string().optional().describe('Limit to a specific project (optional).'),
    limit: z.number().int().min(1).max(25).optional().default(5),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    notes: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const content = new ContentService();
      const notes = await content.searchNotes(context.query, context.projectId, context.limit ?? 5);
      return { success: true, count: notes.length, notes };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});
