/**
 * Quota management for Auto-Approval Policy Engine.
 *
 * Tracks daily usage counters (e.g. cold email volume) to ensure auto-approved
 * actions strictly adhere to safety limits and guardrails.
 */
import { getDb } from '../lib/mongo.js';

const COLLECTION = 'approval_quotas';

export function getTodayDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

export type QuotaStatus = {
  key: string;
  date: string;
  used: number;
  limit: number;
  remaining: number;
  allowed: boolean;
};

/**
 * Returns current quota usage and checks if `amount` can be consumed under `limit`.
 */
export async function checkDailyQuota(
  key: string,
  limit: number,
  amount: number = 1,
  dateStr: string = getTodayDateString(),
): Promise<QuotaStatus> {
  try {
    const db = await getDb();
    const doc = await db.collection(COLLECTION).findOne({ key, date: dateStr });
    const used = typeof doc?.used === 'number' ? doc.used : 0;
    const remaining = Math.max(0, limit - used);
    const allowed = used + amount <= limit;

    return {
      key,
      date: dateStr,
      used,
      limit,
      remaining,
      allowed,
    };
  } catch (error) {
    console.warn(`[ApprovalQuotas] Failed to check quota for ${key}:`, (error as Error).message);
    // Fail-safe: if database check fails, do not allow auto-approval
    return {
      key,
      date: dateStr,
      used: limit,
      limit,
      remaining: 0,
      allowed: false,
    };
  }
}

/**
 * Increments quota counter by `amount`.
 */
export async function consumeDailyQuota(
  key: string,
  amount: number = 1,
  dateStr: string = getTodayDateString(),
): Promise<number> {
  try {
    const db = await getDb();
    const result = await db.collection(COLLECTION).findOneAndUpdate(
      { key, date: dateStr },
      {
        $inc: { used: amount },
        $setOnInsert: { key, date: dateStr, createdAt: new Date() },
        $set: { updatedAt: new Date() },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return typeof result?.used === 'number' ? result.used : amount;
  } catch (error) {
    console.warn(`[ApprovalQuotas] Failed to consume quota for ${key}:`, (error as Error).message);
    return amount;
  }
}

/**
 * Resets quota for testing or admin overrides.
 */
export async function resetDailyQuota(
  key: string,
  dateStr: string = getTodayDateString(),
): Promise<void> {
  try {
    const db = await getDb();
    await db.collection(COLLECTION).deleteOne({ key, date: dateStr });
  } catch (error) {
    console.warn(`[ApprovalQuotas] Failed to reset quota for ${key}:`, (error as Error).message);
  }
}
