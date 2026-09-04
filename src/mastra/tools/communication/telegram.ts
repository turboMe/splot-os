/**
 * Telegram Bot Tools (Phase F5.1)
 *
 * Provides agent-accessible tools for sending messages and alerts
 * via Telegram Bot API. Used by ErrorCollector for critical alerts
 * and by agents for user notifications.
 *
 * Requires: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
 *
 * API Reference: https://core.telegram.org/bots/api
 */
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ── Internal ─────────────────────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

export async function telegramRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<TelegramResponse> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');

  const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await response.json()) as TelegramResponse;
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
  }
  return data;
}

function getDefaultChatId(): string {
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.N8N_TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID / N8N_TELEGRAM_CHAT_ID is not set in .env');
  return chatId;
}

/**
 * Resolve the target chat id: explicit input → requestContext.telegramChatId
 * (set by the n8n Telegram gateway) → env default. Enforces the
 * TELEGRAM_ALLOWED_CHAT_IDS allowlist when configured, so an agent can never
 * message an arbitrary chat.
 */
function resolveChatId(explicit: string | undefined, options?: unknown): string {
  let chatId = explicit;
  if (!chatId && options && typeof options === 'object') {
    try {
      const rc = (options as { requestContext?: { get?: (key: string) => unknown } }).requestContext;
      const fromContext = rc?.get?.('telegramChatId');
      if (typeof fromContext === 'string' && fromContext.length > 0) chatId = fromContext;
      else if (typeof fromContext === 'number') chatId = String(fromContext);
    } catch { /* fall through to env default */ }
  }
  if (!chatId) chatId = getDefaultChatId();

  const allowlist = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(String(chatId))) {
    throw new Error(`Chat ID ${chatId} is not in TELEGRAM_ALLOWED_CHAT_IDS`);
  }
  return String(chatId);
}

// Extension → MIME for outbound uploads (Bot API needs no MIME, but a correct
// one helps Telegram clients render previews).
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;      // Bot API sendDocument hard limit
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;       // Bot API sendPhoto hard limit

// ── Tools ────────────────────────────────────────────────────────────────────

export const telegramSendMessageTool = createTool({
  id: 'telegram_send_message',
  description:
    'Sends a text message via a Telegram bot. Use for notifications, ' +
    'error alerts, and status reports. Supports Markdown formatting.',
  inputSchema: z.object({
    text: z.string().describe('The message content (supports MarkdownV2).'),
    chatId: z
      .string()
      .optional()
      .describe('Telegram chat ID. Defaults to TELEGRAM_CHAT_ID from the environment.'),
    parseMode: z
      .enum(['MarkdownV2', 'HTML', 'Markdown'])
      .optional()
      .default('MarkdownV2')
      .describe('The text parsing/formatting mode.'),
    silent: z
      .boolean()
      .optional()
      .default(false)
      .describe('Send the message silently without an audio notification.'),
  }),
  execute: async (context, options) => {
    try {
      const chatId = resolveChatId(context.chatId, options);

      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: context.text,
        parse_mode: context.parseMode ?? 'MarkdownV2',
        disable_notification: context.silent ?? false,
      });

      return { success: true, chatId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export type TelegramAlertInput = {
  title: string;
  details: string;
  severity?: 'critical' | 'warning' | 'info';
  source?: string;
  /** Tool calls pass Mastra's options so the n8n gateway's chat id wins. */
  options?: unknown;
};

/**
 * Formatted alert, callable without a tool wrapper.
 *
 * Extracted so background code — a periodic sweeper, the scheduled-task runner —
 * can raise the same alert an agent would. Those are exactly the places where
 * something fails with nobody in the conversation to tell, which is the reason
 * the alert exists at all.
 */
export async function sendTelegramAlert(
  input: TelegramAlertInput,
): Promise<{ success: boolean; severity: string; error?: string }> {
  const severity = input.severity ?? 'info';
  try {
    const chatId = resolveChatId(undefined, input.options);
    const severityIcon: Record<string, string> = {
      critical: '🔴',
      warning: '🟡',
      info: '🔵',
    };
    const icon = severityIcon[severity] ?? '🔵';

    const message = [
      `${icon} *${escapeMarkdownV2(input.title)}*`,
      '',
      escapeMarkdownV2(input.details),
      '',
      input.source ? `_Source: ${escapeMarkdownV2(input.source)}_` : '',
      `_${escapeMarkdownV2(new Date().toISOString())}_`,
    ]
      .filter(Boolean)
      .join('\n');

    await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: message,
      parse_mode: 'MarkdownV2',
      disable_notification: severity === 'info',
    });

    return { success: true, severity };
  } catch (error) {
    return { success: false, severity, error: (error as Error).message };
  }
}

export const telegramSendAlertTool = createTool({
  id: 'telegram_send_alert',
  description:
    'Sends a formatted alert about a critical event via Telegram. ' +
    'Use when ErrorCollector detects a recurring error or the system requires attention.',
  inputSchema: z.object({
    title: z.string().describe('The title of the alert (e.g., "Build Failed", "Memory Leak").'),
    details: z.string().describe('Details of the event.'),
    severity: z
      .enum(['critical', 'warning', 'info'])
      .default('warning')
      .describe('The severity level.'),
    source: z.string().optional().describe('The source of the alert (e.g., "ErrorCollector", "GpuGuard").'),
  }),
  execute: async (context, options) => sendTelegramAlert({
    title: context.title,
    details: context.details,
    severity: context.severity,
    source: context.source,
    options,
  }),
});

export const telegramSendDocumentTool = createTool({
  id: 'telegram_send_document',
  description:
    'Sends a file/document via a Telegram bot. Useful for sending ' +
    'reports, logs, and screenshots.',
  inputSchema: z.object({
    fileUrl: z.string().describe('The URL of the file to send.'),
    caption: z.string().optional().describe('The caption for the file.'),
    chatId: z.string().optional().describe('Telegram chat ID.'),
  }),
  execute: async (context, options) => {
    try {
      const chatId = resolveChatId(context.chatId, options);

      await telegramRequest('sendDocument', {
        chat_id: chatId,
        document: context.fileUrl,
        caption: context.caption,
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const telegramSendFileTool = createTool({
  id: 'telegram_send_file',
  description:
    'Sends a LOCAL file from disk to the user via Telegram (photo, document, ' +
    'report, generated asset). Use this to deliver any file produced or saved ' +
    'during a task. Images are sent as photos by default; everything else as a ' +
    'document. Max 50MB (10MB for photos).',
  inputSchema: z.object({
    filePath: z
      .string()
      .describe('Path to the file on disk (absolute, or relative to the server cwd).'),
    caption: z.string().optional().describe('Optional caption shown under the file.'),
    chatId: z
      .string()
      .optional()
      .describe('Telegram chat ID. Defaults to the current Telegram conversation, then env.'),
    sendAs: z
      .enum(['auto', 'photo', 'document'])
      .optional()
      .default('auto')
      .describe(
        "'photo' renders inline but Telegram recompresses it; 'document' preserves " +
        "the original bytes. 'auto' = photo for images ≤10MB, document otherwise.",
      ),
  }),
  execute: async (context, options) => {
    try {
      const chatId = resolveChatId(context.chatId, options);

      const absPath = isAbsolute(context.filePath)
        ? context.filePath
        : resolve(process.cwd(), context.filePath);
      const stat = statSync(absPath, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) {
        return { success: false, error: `File not found: ${absPath}` };
      }
      if (stat.size > MAX_UPLOAD_BYTES) {
        return {
          success: false,
          error: `File too large: ${Math.round(stat.size / 1024 / 1024)}MB > 50MB (Bot API limit)`,
        };
      }

      const ext = extname(absPath).toLowerCase();
      const mime = EXT_MIME[ext] ?? 'application/octet-stream';
      const isImage = mime.startsWith('image/');
      const asPhoto =
        context.sendAs === 'photo' ||
        (context.sendAs !== 'document' && isImage && stat.size <= MAX_PHOTO_BYTES);
      const method = asPhoto ? 'sendPhoto' : 'sendDocument';

      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');

      const buffer = await readFile(absPath);
      const form = new FormData();
      form.append('chat_id', chatId);
      if (context.caption) form.append('caption', context.caption);
      form.append(asPhoto ? 'photo' : 'document', new Blob([buffer], { type: mime }), basename(absPath));

      const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const data = (await response.json()) as TelegramResponse;
      if (!data.ok) {
        return { success: false, error: `Telegram API error: ${data.description || 'Unknown error'}` };
      }

      return {
        success: true,
        chatId,
        fileName: basename(absPath),
        bytes: stat.size,
        sentAs: asPhoto ? 'photo' : 'document',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape special characters for Telegram MarkdownV2.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
