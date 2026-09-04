/**
 * Strukturalne logi dla producer-hunt workflow.
 * Zapisuje do MongoDB collection `logs` z polami pasującymi do dashboardu.
 * Plan: ideas/producer-hunt-fix-v2.md krok 6.
 */
import { getDb } from '../../lib/mongo.js';

export type ProducerHuntLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ProducerHuntLogEvent = {
  taskId: string;
  stepId: string;
  event: string;
  level?: ProducerHuntLogLevel;
  company?: string;
  metrics?: Record<string, unknown>;
  skippedReason?: string;
  error?: string;
};

/**
 * Zapisuje strukturalny event do collection `logs`.
 * Cicho swallow'uje błąd zapisu — log nie może wywalić workflow.
 *
 * NB: nie blokujemy na zapisie. Funkcja zwraca Promise<void>.
 */
export async function logProducerHuntEvent(event: ProducerHuntLogEvent): Promise<void> {
  try {
    const db = await getDb();
    await db.collection('logs').insertOne({
      timestamp: new Date(),
      level: event.level ?? 'info',
      agentId: 'producer-hunt-workflow',
      taskId: event.taskId,
      stepId: event.stepId,
      message: event.event,
      data: {
        ...(event.company ? { company: event.company } : {}),
        ...(event.metrics ?? {}),
        ...(event.skippedReason ? { skippedReason: event.skippedReason } : {}),
        ...(event.error ? { error: event.error } : {}),
      },
    });
  } catch (err) {
    // logowanie nie może być punktem awarii — workflow musi iść dalej
    console.warn(
      `[producer-hunt:${event.taskId}] failed to persist log event "${event.event}":`,
      (err as Error).message,
    );
  }
}
