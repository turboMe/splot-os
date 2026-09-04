/**
 * Artifact Store tools (Etap 3 — IDEALSYSTEMMASTERPLAN A2).
 *
 * Agents exchange typed documents, not chat transcripts:
 *   artifact_put  — save a deliverable, get back {id, type, summary}
 *   artifact_get  — fetch full content by id (on demand)
 *   artifact_list — browse artifacts (by laneId / type / producer)
 *
 * Hard rules:
 *   - large content NEVER travels inside briefs/replies — pass the ref;
 *   - a handoff names the artifact type it produces.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ARTIFACT_TYPES } from '../../config/artifact-types.js';
import { getArtifact, listArtifacts, putArtifact } from '../../services/artifact-store.js';

export const artifactPutTool = createTool({
  id: 'artifact_put',
  description:
    'Save a deliverable to the Artifact Store and get back a compact reference {id, type, summary}. ' +
    'Use for ANY substantial output (reports, plans, drafts, packs) instead of pasting it into your reply — ' +
    'return the reference; the consumer fetches full content with artifact_get only when needed.',
  inputSchema: z.object({
    type: z.enum(ARTIFACT_TYPES).describe('Artifact type — name what this deliverable IS'),
    content: z.string().min(1).describe('Full content of the deliverable'),
    summary: z.string().max(1000).optional()
      .describe('≤1000 chars: what is inside + key findings. This is ALL the next agent sees by default.'),
    title: z.string().optional(),
    laneId: z.string().optional().describe('Task Ledger lane this belongs to (for artifact_list scoping)'),
    producedBy: z.string().describe('Your agentId'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    ref: z.object({ id: z.string(), type: z.string(), summary: z.string() }).optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      const ref = await putArtifact(input);
      return { success: true, ref };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const artifactGetTool = createTool({
  id: 'artifact_get',
  description:
    'Fetch an artifact by id. Default returns metadata + summary; set includeContent=true for the full body. ' +
    'Fetch full content ONLY when you actually need to read it — the summary is often enough.',
  inputSchema: z.object({
    id: z.string(),
    includeContent: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    type: z.string().optional(),
    summary: z.string().optional(),
    title: z.string().optional(),
    producedBy: z.string().optional(),
    laneId: z.string().optional().nullable(),
    bytes: z.number().optional(),
    createdAt: z.string().optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      const record = await getArtifact(input.id, { includeContent: input.includeContent });
      if (!record) return { found: false, error: `Artifact not found: ${input.id}` };
      return {
        found: true,
        type: record.type,
        summary: record.summary,
        title: record.title,
        producedBy: record.producedBy,
        laneId: record.laneId,
        bytes: record.bytes,
        createdAt: record.createdAt.toISOString(),
        content: record.content,
      };
    } catch (error) {
      return { found: false, error: (error as Error).message };
    }
  },
});

export const artifactListTool = createTool({
  id: 'artifact_list',
  description:
    'List artifacts (newest first, summaries only — no content). Filter by laneId (all artifacts of one ' +
    'background lane), type, or producedBy.',
  inputSchema: z.object({
    laneId: z.string().optional(),
    type: z.enum(ARTIFACT_TYPES).optional(),
    producedBy: z.string().optional(),
    limit: z.number().optional().default(20),
  }),
  outputSchema: z.object({
    count: z.number(),
    artifacts: z.array(z.object({
      id: z.string(),
      type: z.string(),
      summary: z.string(),
      producedBy: z.string(),
      laneId: z.string().optional().nullable(),
      bytes: z.number(),
      createdAt: z.string(),
    })),
  }),
  execute: async (input) => {
    const records = await listArtifacts(input);
    return {
      count: records.length,
      artifacts: records.map((r) => ({
        id: r.id,
        type: r.type,
        summary: r.summary,
        producedBy: r.producedBy,
        laneId: r.laneId,
        bytes: r.bytes,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});
