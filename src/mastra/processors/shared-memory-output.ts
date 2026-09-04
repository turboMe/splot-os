/**
 * Processor: SharedMemoryOutputProcessor
 * Nasłuchuje na zakończenie generowania odpowiedzi przez meta-agenta.
 * Jeśli odpowiedź zawiera kluczową decyzję / kontekst, automatycznie
 * zapisuje ją do kolekcji shared_memory (TTL 24h) — by inne agenty
 * mogły z niej skorzystać.
 *
 * Etap 7C – meta-agent SharedMemory outputProcessor.
 */
import type { ProcessOutputResultArgs, ProcessorMessageResult } from '@mastra/core/processors';
import { BaseProcessor } from '@mastra/core/processors';
import { getDb } from '../lib/mongo.js';

// ── Heuristics: what signals a "decision" worth persisting ─────────────────
const DECISION_PATTERNS = [
  // Polish action/decision keywords
  /zdecydowałem|postanowiłem|wybrałem|zapisuję|zaktualizowałem/i,
  /następny krok|plan działania|priorytet|rekomendacja|wnioski/i,
  /delegował?em|uruchomiłem workflow|zlecam|przypisałem/i,
  // CRM state changes
  /status.*zmieniony|lead.*zaktualizowany|draft.*gotowy|spotkanie.*zaplanowane/i,
  // Summary markers
  /podsumowanie:|summary:|kluczowe informacje:|najważniejsze:/i,
];

// Minimum response length (chars) to bother analyzing
const MIN_RESPONSE_LENGTH = 80;
// Maximum chars to store in shared_memory
const MAX_STORED_CHARS = 600;

function isDecisionWorthPersisting(text: string): boolean {
  if (text.length < MIN_RESPONSE_LENGTH) return false;
  return DECISION_PATTERNS.some((p) => p.test(text));
}

function extractSummary(text: string): string {
  // Take first 2 substantive sentences (skip code blocks and bullet lists)
  const sentences = text
    .replace(/```[\s\S]*?```/g, '')     // remove code blocks
    .replace(/\|.*?\|/g, '')            // remove table rows
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && !s.startsWith('-') && !s.startsWith('#'));

  return sentences.slice(0, 2).join(' ').slice(0, MAX_STORED_CHARS);
}

// ── Processor class ────────────────────────────────────────────────────────
export class SharedMemoryOutputProcessor extends BaseProcessor<'shared-memory-output'> {
  readonly id = 'shared-memory-output' as const;
  readonly name = 'SharedMemory Output Processor';
  readonly description =
    'Persists key meta-agent decisions to shared_memory so other agents can benefit from them.';

  /**
   * Called after each complete agent response (generate/stream finish).
   * We inspect the final `result.text` and conditionally write to MongoDB.
   */
  processOutputResult(args: ProcessOutputResultArgs): ProcessorMessageResult {
    const { result, messages } = args;
    const text = result.text;

    // Only process responses that look like decisions
    if (!isDecisionWorthPersisting(text)) {
      return messages;
    }

    // Fire-and-forget: persist decision asynchronously without blocking return
    const persist = async () => {
      try {
        const db = await getDb();
        const now = new Date();
        const ttl = new Date(now.getTime() + 24 * 3600 * 1000); // 24h TTL

        // Use content length + timestamp as dedup key
        const key = `meta-decision-${now.toISOString().slice(0, 16)}-${text.length}`;

        await db.collection('shared_memory').updateOne(
          { key },
          {
            $setOnInsert: {
              id: key,
              key,
              type: 'decision',
              sourceAgent: 'meta-agent',
              content: extractSummary(text),
              fullText: text.slice(0, 2000),
              tokenUsage: result.usage,
              createdAt: now.toISOString(),
              expiresAt: ttl,  // Must be Date (not string) for TTL index and { $gt: new Date() } queries
            },
          },
          { upsert: true },
        );
      } catch (err) {
        // Non-fatal — processor must not crash the agent response
        console.warn('[SharedMemoryOutputProcessor] Failed to persist decision:', err);
      }
    };

    // Do NOT await — return synchronously so the method signature matches Processor
    void persist();

    // Always return messages unmodified — we only side-effect to DB
    return messages;
  }
}

export const sharedMemoryOutputProcessor = new SharedMemoryOutputProcessor();
