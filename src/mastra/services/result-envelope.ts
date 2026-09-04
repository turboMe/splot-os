/**
 * ResultEnvelope — the structured shell every delegation returns
 * (Etap 3, IDEALSYSTEMMASTERPLAN A2 warstwa 3).
 *
 * The "Delegation Result Accounting" section of the meta prompt maps onto this
 * 1:1 — but machine-readable. Experts end their reply with a fenced block:
 *
 * ```json result_envelope
 * { "status": "ok", "artifacts": [{"id":"art-…","type":"research_report","summary":"…"}],
 *   "lessons": ["…"], "followup": "…" }
 * ```
 *
 * Migration is gradual: prose replies (legacy agents) parse into a fallback
 * envelope { status: 'ok', artifacts: [], raw: text } — nothing breaks.
 */
import { z } from 'zod';
import { ARTIFACT_TYPES } from '../config/artifact-types.js';

export const resultEnvelopeSchema = z.object({
  status: z.enum(['ok', 'partial', 'failed', 'blocked_needs_approval']),
  artifacts: z.array(z.object({
    id: z.string(),
    type: z.enum(ARTIFACT_TYPES).or(z.string()),
    summary: z.string().optional().default(''),
    content: z.string().optional().describe('Inline payload for small deliverables (<1000 words) allowing instant access without a second artifact_get roundtrip'),
  })).default([]),
  metrics: z.object({
    costUsd: z.number().optional(),
    durationS: z.number().optional(),
    toolCalls: z.number().optional(),
  }).optional(),
  /** Fuel for skill distillation (Etap 6). */
  lessons: z.array(z.string()).default([]),
  followup: z.string().optional(),
});

export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema> & {
  /** Full reply text (always preserved — the envelope wraps, never replaces). */
  raw: string;
  /** True when the envelope was parsed from the reply, false for prose fallback. */
  parsed: boolean;
};

const FENCE_RE = /```(?:json[ \t]+result_envelope|result_envelope)\s*\n([\s\S]*?)```/i;

/**
 * Parse an expert's reply into a ResultEnvelope.
 * Priority: fenced ```json result_envelope``` block → trailing bare JSON object
 * with a valid status field → prose fallback (status ok, raw preserved).
 */
export function parseResultEnvelope(text: string): ResultEnvelope {
  const raw = text ?? '';

  const fenced = raw.match(FENCE_RE);
  if (fenced) {
    const candidate = tryParse(fenced[1]!);
    if (candidate) return { ...candidate, raw, parsed: true };
  }

  // Trailing bare JSON object (last {...} at end of the reply)
  const tail = raw.trimEnd();
  if (tail.endsWith('}')) {
    const start = tail.lastIndexOf('\n{');
    if (start !== -1) {
      const candidate = tryParse(tail.slice(start + 1));
      if (candidate) return { ...candidate, raw, parsed: true };
    }
  }

  return {
    status: 'ok',
    artifacts: [],
    lessons: [],
    raw,
    parsed: false,
  };
}

function tryParse(jsonText: string): z.infer<typeof resultEnvelopeSchema> | null {
  try {
    const parsed = JSON.parse(jsonText);
    const result = resultEnvelopeSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Strip the envelope block from a reply (for user-facing rendering). */
export function stripEnvelopeBlock(text: string): string {
  return (text ?? '').replace(FENCE_RE, '').trimEnd();
}
