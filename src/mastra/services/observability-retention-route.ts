import { timingSafeEqual } from 'node:crypto';

import { registerApiRoute } from '@mastra/core/server';

import {
  isObservabilityRetentionEnabled,
  OBSERVABILITY_RETENTION_ROUTE,
  type ObservabilityRetentionService,
} from './observability-retention.js';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * The endpoint is fail-closed because DELETE + CHECKPOINT is intentionally a
 * privileged maintenance operation. The cron runner and server read the same
 * secret from OBSERVABILITY_RETENTION_TOKEN.
 */
export function checkObservabilityRetentionAuth(
  authorizationHeader: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const expected = env.OBSERVABILITY_RETENTION_TOKEN?.trim();
  if (!expected) return false;

  const header = authorizationHeader?.trim() ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;

  const presented = header.slice(prefix.length).trim();
  return Boolean(presented) && safeEqual(presented, expected);
}

export function createObservabilityRetentionRoute(
  retention: ObservabilityRetentionService,
) {
  return registerApiRoute(OBSERVABILITY_RETENTION_ROUTE, {
    method: 'POST',
    handler: async (c) => {
      if (!process.env.OBSERVABILITY_RETENTION_TOKEN?.trim()) {
        return c.json({
          status: 'unavailable',
          error: 'OBSERVABILITY_RETENTION_TOKEN is not configured.',
        }, 503);
      }
      if (!checkObservabilityRetentionAuth(c.req.header('authorization'))) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      if (!isObservabilityRetentionEnabled()) {
        return c.json({
          status: 'disabled',
          message: 'OBSERVABILITY_RETENTION_ENABLED disables this maintenance job.',
        }, 503);
      }

      try {
        return c.json(await retention.run());
      } catch (error) {
        return c.json({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }, 500);
      }
    },
  });
}
