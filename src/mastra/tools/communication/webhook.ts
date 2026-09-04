/**
 * Webhook Sender Tool (Phase F5.5)
 *
 * Generic webhook tool for sending structured payloads to
 * Slack, Discord, n8n, Make.com, Zapier, or any HTTP endpoint.
 * Supports POST/PUT with JSON body and custom headers.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const webhookSendTool = createTool({
  id: 'webhook_send',
  description:
    'Sends a JSON payload to any webhook URL (Slack, Discord, n8n, Make, Zapier). ' +
    'Use to integrate with external notification and automation systems.',
  inputSchema: z.object({
    url: z.string().url().describe('The destination webhook URL.'),
    payload: z.record(z.string(), z.unknown()).describe('The JSON payload to send.'),
    method: z
      .enum(['POST', 'PUT'])
      .optional()
      .default('POST')
      .describe('The HTTP method.'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Additional HTTP headers (e.g., Authorization).'),
    timeoutMs: z
      .number()
      .optional()
      .default(10_000)
      .describe('Timeout in milliseconds.'),
  }),
  execute: async (context) => {
    try {
      const response = await fetch(context.url, {
        method: context.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(context.headers ?? {}),
        },
        body: JSON.stringify(context.payload),
        signal: AbortSignal.timeout(context.timeoutMs ?? 10_000),
      });

      const status = response.status;
      let responseBody: string;
      try {
        responseBody = await response.text();
        if (responseBody.length > 1000) {
          responseBody = responseBody.slice(0, 1000) + '…';
        }
      } catch {
        responseBody = '(no body)';
      }

      return {
        success: response.ok,
        status,
        response: responseBody,
      };
    } catch (error) {
      return {
        success: false,
        status: 0,
        error: (error as Error).message,
      };
    }
  },
});

// ── Preset: Slack Webhook ────────────────────────────────────────────────────

export const slackWebhookTool = createTool({
  id: 'webhook_slack',
  description:
    'Sends a message to a Slack channel via an Incoming Webhook. ' +
    'Requires SLACK_WEBHOOK_URL in .env.',
  inputSchema: z.object({
    text: z.string().describe('The message content (Slack mrkdwn format).'),
    channel: z.string().optional().describe('Channel override (e.g., #alerts).'),
    username: z.string().optional().default('Mastra Bot').describe('The bot username.'),
    iconEmoji: z.string().optional().default(':robot_face:').describe('The bot emoji icon.'),
  }),
  execute: async (context) => {
    try {
      const url = process.env.SLACK_WEBHOOK_URL;
      if (!url) throw new Error('SLACK_WEBHOOK_URL is not set in .env');

      const payload: Record<string, unknown> = {
        text: context.text,
        username: context.username ?? 'Mastra Bot',
        icon_emoji: context.iconEmoji ?? ':robot_face:',
      };
      if (context.channel) payload.channel = context.channel;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      return { success: response.ok, status: response.status };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ── Preset: Discord Webhook ──────────────────────────────────────────────────

export const discordWebhookTool = createTool({
  id: 'webhook_discord',
  description:
    'Sends a message to a Discord channel via a Webhook URL. ' +
    'Requires DISCORD_WEBHOOK_URL in .env.',
  inputSchema: z.object({
    content: z.string().describe('The message content (Discord markdown).'),
    username: z.string().optional().default('Mastra Bot').describe('The bot username.'),
    embeds: z
      .array(
        z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          color: z.number().optional().describe('The embed color (decimal, e.g., 16711680 = red).'),
        }),
      )
      .optional()
      .describe('Discord embeds (optional rich formatting).'),
  }),
  execute: async (context) => {
    try {
      const url = process.env.DISCORD_WEBHOOK_URL;
      if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set in .env');

      const payload: Record<string, unknown> = {
        content: context.content,
        username: context.username ?? 'Mastra Bot',
      };
      if (context.embeds) payload.embeds = context.embeds;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      return { success: response.ok, status: response.status };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
