/**
 * Consulting Forms API Tool
 *
 * Provides access to submissions from GastroBridge-Consulting forms:
 *   - /kontakt (B2B leads)
 *   - /kandydaci (recruitment talent pool)
 *   - /rozeznanie-menu (free menu audits)
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

function resolveApiConfig() {
  let apiUrl = process.env.CONSULTING_API_URL || 'https://consulting.gastrobridge.com/api';
  // Normalize base URL: if it ends in /wiedza, strip it to get base /api
  apiUrl = apiUrl.replace(/\/wiedza\/?$/, '').replace(/\/$/, '');
  if (!apiUrl.endsWith('/api')) {
    apiUrl = `${apiUrl}/api`;
  }
  const apiSecret = process.env.AGENT_API_SECRET;
  return { apiUrl, apiSecret };
}

export const consultingFormsApiTool = createTool({
  id: 'consulting_forms_api',
  description:
    'Fetches new submissions or updates statuses for GastroBridge-Consulting forms ' +
    '(/api/kontakt for B2B leads, /api/kandydaci for job candidates, /api/rozeznanie-menu for menu audits).',
  inputSchema: z.object({
    endpoint: z
      .enum(['kontakt', 'kandydaci', 'rozeznanie-menu'])
      .describe('Target form endpoint: "kontakt" (B2B leads), "kandydaci" (candidates), "rozeznanie-menu" (menu audits)'),
    action: z
      .enum(['list', 'update_status'])
      .describe('"list" to fetch submissions, "update_status" to update an item status'),
    status: z
      .string()
      .optional()
      .default('new')
      .describe('Filter status for "list" (e.g., "new", "in_progress", "screened", "analyzing", "audit_ready", "all")'),
    position: z
      .string()
      .optional()
      .describe('Optional position filter for "kandydaci" list (e.g., "Szef kuchni", "Kucharz", "Kelner")'),
    itemId: z
      .string()
      .optional()
      .describe('Item ID required for "update_status" (e.g., "lead-mthn2v9s-bqz9i", "cand-xxx", "audit-xxx")'),
    newStatus: z
      .string()
      .optional()
      .describe('New status for "update_status" (e.g., "in_progress", "screened", "analyzing", "audit_ready", "responded")'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    endpoint: z.string(),
    action: z.string(),
    count: z.number().optional(),
    items: z.array(z.record(z.string(), z.unknown())).optional(),
    updatedItem: z.record(z.string(), z.unknown()).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const { apiUrl, apiSecret } = resolveApiConfig();

      if (!apiSecret) {
        return {
          success: false,
          endpoint: context.endpoint,
          action: context.action,
          message: 'Missing AGENT_API_SECRET in environment',
          error: 'AGENT_API_SECRET is required to query Consulting API',
        };
      }

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiSecret}`,
        'Content-Type': 'application/json',
      };

      if (context.action === 'list') {
        const queryParams = new URLSearchParams();
        if (context.status) {
          queryParams.set('status', context.status);
        }
        if (context.endpoint === 'kandydaci' && context.position) {
          queryParams.set('position', context.position);
        }

        const url = `${apiUrl}/${context.endpoint}?${queryParams.toString()}`;
        const res = await fetch(url, {
          method: 'GET',
          headers,
        });

        const data = (await res.json()) as Record<string, unknown>;

        if (!res.ok) {
          return {
            success: false,
            endpoint: context.endpoint,
            action: 'list',
            message: `Failed to fetch from ${context.endpoint} (HTTP ${res.status})`,
            error: String(data.error || data.message || 'Unknown error'),
          };
        }

        // Response array is in 'leads', 'candidates', or 'audits'
        const items =
          (data.leads as Array<Record<string, unknown>>) ||
          (data.candidates as Array<Record<string, unknown>>) ||
          (data.audits as Array<Record<string, unknown>>) ||
          [];

        return {
          success: true,
          endpoint: context.endpoint,
          action: 'list',
          count: items.length,
          items,
          message: `Retrieved ${items.length} items from /api/${context.endpoint} with status="${context.status}"`,
        };
      }

      if (context.action === 'update_status') {
        if (!context.itemId) {
          return {
            success: false,
            endpoint: context.endpoint,
            action: 'update_status',
            message: 'Missing itemId parameter for update_status',
            error: 'itemId is required when action is update_status',
          };
        }
        if (!context.newStatus) {
          return {
            success: false,
            endpoint: context.endpoint,
            action: 'update_status',
            message: 'Missing newStatus parameter for update_status',
            error: 'newStatus is required when action is update_status',
          };
        }

        const url = `${apiUrl}/${context.endpoint}/${encodeURIComponent(context.itemId)}`;
        const res = await fetch(url, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: context.newStatus }),
        });

        const data = (await res.json()) as Record<string, unknown>;

        if (!res.ok) {
          return {
            success: false,
            endpoint: context.endpoint,
            action: 'update_status',
            message: `Failed to update ${context.itemId} (HTTP ${res.status})`,
            error: String(data.error || data.message || 'Unknown error'),
          };
        }

        return {
          success: true,
          endpoint: context.endpoint,
          action: 'update_status',
          updatedItem: (data.lead || data.candidate || data.audit || data) as Record<string, unknown>,
          message: `Successfully updated ${context.itemId} status to "${context.newStatus}"`,
        };
      }

      return {
        success: false,
        endpoint: context.endpoint,
        action: context.action,
        message: `Unsupported action: ${context.action}`,
        error: `Action must be "list" or "update_status"`,
      };
    } catch (err) {
      return {
        success: false,
        endpoint: context.endpoint,
        action: context.action,
        message: 'Unexpected error during forms API execution',
        error: (err as Error).message,
      };
    }
  },
});
