/**
 * Native Telegram gateway (long-polling), replacing the n8n-webhook-over-
 * Cloudflare-tunnel path for "Mastra - Telegram Meta-Agent Gateway v3".
 *
 * Gated behind FEATURE_TELEGRAM_NATIVE_GATEWAY (default OFF). The n8n webhook
 * must be deleted first via `npm run switch:telegram-native` — Telegram
 * allows only one delivery mode (webhook XOR getUpdates) per bot token, so
 * running both at once makes getUpdates 409 forever.
 *
 * Contract mirrors the live n8n workflow exactly (verified via
 * `n8n export:workflow --id=ZlDGfs3lbEviEnaz` on 2026-08-25): same thread-id
 * rotation + silent /reset, same POST body to /api/agents/meta-agent/generate,
 * same Markdown-escaping/chunking before sending the reply back.
 */

import { getDb } from '../lib/mongo.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { telegramRequest } from '../tools/communication/telegram.js';
import { MAX_BYTES as ATTACHMENT_MAX_BYTES } from './prompt-attachments.js';

const COLLECTION = 'telegram_gateway_state';
const MASTRA_GENERATE_URL = 'http://localhost:4111/api/agents/meta-agent/generate';
const MAX_STEPS = 10;
const POLL_TIMEOUT_S = 30;
const CHUNK_LIMIT = 3800; // Telegram's hard cap is 4096; leave headroom for the "(n/m)" prefix.
const SEND_MAX_TRIES = 3;
const SEND_RETRY_DELAY_MS = 2000;
const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;

type TelegramPhotoSize = { file_id: string; width: number; height: number; file_size?: number };
type TelegramFileField = { file_id: string; mime_type?: string; file_name?: string; file_size?: number };

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramFileField;
  voice?: TelegramFileField;
  audio?: TelegramFileField;
  video?: TelegramFileField;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

interface OffsetDoc {
  _id: 'offset';
  value: number;
}

interface ResetDoc {
  _id: string; // `reset:${chatId}`
  chatId: string;
  resetEpochMs: number;
}

let running = false;
let loopPromise: Promise<void> | null = null;
let inFlightAbort: AbortController | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allowedChatIds(): string[] {
  return (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function isChatAllowed(chatId: string): boolean {
  const allowlist = allowedChatIds();
  return allowlist.length === 0 || allowlist.includes(chatId);
}

async function loadOffset(): Promise<number> {
  const db = await getDb();
  const doc = await db.collection<OffsetDoc>(COLLECTION).findOne({ _id: 'offset' });
  return doc?.value ?? 0;
}

async function saveOffset(value: number): Promise<void> {
  const db = await getDb();
  await db.collection<OffsetDoc>(COLLECTION).updateOne(
    { _id: 'offset' },
    { $set: { value } },
    { upsert: true },
  );
}

async function loadResetEpoch(chatId: string): Promise<number | undefined> {
  const db = await getDb();
  const doc = await db.collection<ResetDoc>(COLLECTION).findOne({ _id: `reset:${chatId}` });
  return doc?.resetEpochMs;
}

async function saveResetEpoch(chatId: string, epochMs: number): Promise<void> {
  const db = await getDb();
  await db.collection<ResetDoc>(COLLECTION).updateOne(
    { _id: `reset:${chatId}` },
    { $set: { chatId, resetEpochMs: epochMs } },
    { upsert: true },
  );
}

/** Port of the n8n "Compute Thread ID" Code node — same daily rotation + silent /reset. */
export function computeThreadId(chatId: string, now: Date, resetEpochMs: number | undefined): string {
  const today = now.toISOString().slice(0, 10);
  const useReset = resetEpochMs !== undefined
    && new Date(resetEpochMs).toISOString().slice(0, 10) === today;
  return `telegram-chat-${chatId}-${today}${useReset ? '-' + resetEpochMs : ''}`;
}

type TelegramContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mimeType: string; filename?: string }
  | { type: 'file'; data: string; mediaType: string; filename?: string };

type ResolvedAttachment = { fileId: string; mimeType: string; filename?: string; kind: 'image' | 'file' };

/**
 * Picks the one attachment a Telegram message carries, if any. Priority
 * doesn't really matter — Telegram never puts more than one of these on a
 * single message — it's just a deterministic order.
 */
export function resolveTelegramAttachment(message: TelegramMessage): ResolvedAttachment | undefined {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, mimeType: 'image/jpeg', kind: 'image' };
  }
  if (message.document) {
    return {
      fileId: message.document.file_id,
      mimeType: message.document.mime_type || 'application/octet-stream',
      filename: message.document.file_name,
      kind: 'file',
    };
  }
  if (message.voice) {
    return { fileId: message.voice.file_id, mimeType: message.voice.mime_type || 'audio/ogg', kind: 'file' };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type || 'audio/mpeg',
      filename: message.audio.file_name,
      kind: 'file',
    };
  }
  if (message.video) {
    return {
      fileId: message.video.file_id,
      mimeType: message.video.mime_type || 'video/mp4',
      filename: message.video.file_name,
      kind: 'file',
    };
  }
  return undefined;
}

/**
 * Downloads bytes for a Telegram file_id and returns them as a base64 data:
 * URL. Deliberately NOT delegated to prompt-attachments.ts's persistRawAttachment
 * with the raw Telegram file URL: that URL embeds the bot token
 * (.../file/bot<TOKEN>/<path>), and the server logs a 60-char prefix of any
 * http(s) source it fetches — the token would leak into logs. Downloading
 * here and shipping bytes as a data: URL keeps the token out of anything
 * that gets logged downstream.
 */
async function downloadTelegramFile(fileId: string): Promise<{ base64: string; bytes: number } | undefined> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');

  const meta = await telegramRequest('getFile', { file_id: fileId }) as {
    result?: { file_path?: string; file_size?: number };
  };
  const filePath = meta.result?.file_path;
  if (!filePath) return undefined;
  if (meta.result?.file_size && meta.result.file_size > ATTACHMENT_MAX_BYTES) {
    console.warn('[TelegramNativeGateway] attachment_too_large', meta.result.file_size);
    return undefined;
  }

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`file download HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > ATTACHMENT_MAX_BYTES) {
    console.warn('[TelegramNativeGateway] attachment_too_large', buffer.length);
    return undefined;
  }
  return { base64: buffer.toString('base64'), bytes: buffer.length };
}

/** Port of the n8n "Prepare Telegram Chunks" node's telegramMarkdown(). */
export function telegramMarkdown(text: string): string {
  let value = String(text ?? '').replace(/\r\n?/g, '\n').trim();

  value = value.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  value = value.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  value = value.replace(/(?<!\\)_/g, '\\_');
  value = value.replace(/(?<!\\)\[(?![^\]\n]+\]\(https?:\/\/[^)\n]+\))/g, '\\[');

  const stars = (value.match(/(?<!\\)\*/g) || []).length;
  if (stars % 2 !== 0) value = value.replace(/(?<!\\)\*/g, '\\*');
  const ticks = value.split('`').length - 1;
  if (ticks % 2 !== 0) value = value.split('`').join('\\`');

  return value;
}

/** Port of the n8n node's splitRaw() — cuts on paragraph/sentence/word boundaries. */
export function splitRaw(text: string, limit = 3200): string[] {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return ['Nie udało się wygenerować odpowiedzi.'];

  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (cut < Math.floor(limit * 0.55)) cut = window.lastIndexOf('. ');
    if (cut < Math.floor(limit * 0.55)) cut = window.lastIndexOf(' ');
    if (cut < 1) cut = limit;
    else if (rest.slice(cut, cut + 2) === '. ') cut += 1;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Full pipeline: raw agent reply text -> Telegram-safe, size-bounded chunks. */
export function prepareTelegramChunks(sourceText: string): string[] {
  let pending = splitRaw(sourceText);
  const safeChunks: string[] = [];

  while (pending.length) {
    const raw = pending.shift() as string;
    const safe = telegramMarkdown(raw);
    if (safe.length <= CHUNK_LIMIT) {
      safeChunks.push(safe);
      continue;
    }
    const halves = splitRaw(raw, Math.max(500, Math.floor(raw.length / 2)));
    pending = [...halves, ...pending];
  }

  const total = safeChunks.length;
  return safeChunks.map((text, index) => (total > 1 ? `(${index + 1}/${total})\n${text}` : text));
}

/**
 * Starts a background heartbeat that repeatedly sends a chat action (default 'typing')
 * to Telegram every `intervalMs` (default 4000ms) until the returned stop function is called.
 * Telegram client displays 'typing' indicator for ~5 seconds per sendChatAction call.
 */
export function startChatActionHeartbeat(
  chatId: number | string,
  action: 'typing' | 'upload_document' = 'typing',
  intervalMs = 4000,
): () => void {
  let active = true;

  const trigger = async () => {
    if (!active) return;
    try {
      await telegramRequest('sendChatAction', {
        chat_id: chatId,
        action,
      });
    } catch {
      // Fire-and-forget: failure to send chat action must never fail or block the agent loop
    }
  };

  // Immediate first ping so Telegram client shows typing right away
  void trigger();

  const timer = setInterval(() => {
    void trigger();
  }, intervalMs);

  return () => {
    active = false;
    clearInterval(timer);
  };
}

async function sendReply(chatId: number, text: string): Promise<void> {
  const chunks = prepareTelegramChunks(text);
  for (const chunk of chunks) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= SEND_MAX_TRIES; attempt++) {
      try {
        await telegramRequest('sendMessage', {
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < SEND_MAX_TRIES) await sleep(SEND_RETRY_DELAY_MS);
      }
    }
    if (lastErr) {
      console.error('[TelegramNativeGateway] send_failed', (lastErr as Error).message);
    }
  }
}

async function callMetaAgent(input: {
  content: string | TelegramContentPart[];
  threadId: string;
  chatId: string;
  userId: string;
}): Promise<string> {
  const response = await fetch(MASTRA_GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: input.content }],
      memory: { thread: input.threadId, resource: `telegram-chat-${input.chatId}` },
      requestContext: {
        channel: 'telegram',
        telegramChatId: input.chatId,
        telegramUserId: input.userId,
      },
      maxSteps: MAX_STEPS,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    throw new Error(`meta-agent generate HTTP ${response.status}`);
  }
  const data = (await response.json()) as { text?: string; response?: string; message?: { content?: string } };
  return data.text || data.response || data.message?.content || JSON.stringify(data);
}

async function processUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const chatId = message?.chat?.id;
  if (!message || chatId === undefined) return;

  const chatIdStr = String(chatId);
  if (!isChatAllowed(chatIdStr)) {
    console.warn('[TelegramNativeGateway] chat_not_allowed', chatIdStr);
    return;
  }

  let text = (message.text || message.caption || '').trim();

  if (text === '/reset') {
    await saveResetEpoch(chatIdStr, Date.now());
    return; // silent, mirrors the n8n Code node returning [] for /reset
  }

  let content: string | TelegramContentPart[] = text;
  if (isHarnessFeatureEnabled('FEATURE_TELEGRAM_GATEWAY_ATTACHMENTS', false)) {
    const attachment = resolveTelegramAttachment(message);
    if (attachment) {
      try {
        const downloaded = await downloadTelegramFile(attachment.fileId);
        if (downloaded) {
          const dataUrl = `data:${attachment.mimeType};base64,${downloaded.base64}`;
          const parts: TelegramContentPart[] = [];
          if (text) parts.push({ type: 'text', text });
          parts.push(
            attachment.kind === 'image'
              ? { type: 'image', image: dataUrl, mimeType: attachment.mimeType, filename: attachment.filename }
              : { type: 'file', data: dataUrl, mediaType: attachment.mimeType, filename: attachment.filename },
          );
          content = parts;
        } else {
          text = [text, '(nie udało się pobrać załączonego pliku — za duży albo błąd Telegrama)'].filter(Boolean).join('\n\n');
          content = text;
        }
      } catch (err) {
        console.error('[TelegramNativeGateway] attachment_download_failed', (err as Error).message);
        text = [text, '(nie udało się pobrać załączonego pliku)'].filter(Boolean).join('\n\n');
        content = text;
      }
    }
  }

  if (!text && content === text) return; // nothing to say (e.g. a sticker) and no attachment resolved — skip the turn

  const resetEpochMs = await loadResetEpoch(chatIdStr);
  const threadId = computeThreadId(chatIdStr, new Date(), resetEpochMs);
  const userId = String(message.from?.id ?? chatId);

  const stopTyping = startChatActionHeartbeat(chatId, 'typing');
  try {
    const replyText = await callMetaAgent({ content, threadId, chatId: chatIdStr, userId });
    await sendReply(chatId, replyText);
  } finally {
    stopTyping();
  }
}

function isFatalTelegramError(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  return /\b(401|403)\b/.test(msg);
}

function isConflictError(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  // Wave-5 skills work narrowed this to just the exact Telegram phrasing,
  // dropping the generic `/conflict/i` match with no test or note explaining
  // why — restoring it as a union rather than guessing which was "right":
  // this can only catch a superset of what either version caught alone.
  return /\b409\b/.test(msg) || /conflict/i.test(msg) || /terminated by other getupdates/i.test(msg);
}

async function bootstrapOffset(): Promise<number> {
  try {
    const peek = await telegramRequest('getUpdates', { limit: 1, timeout: 0 }) as { result?: TelegramUpdate[] };
    const latest = peek.result?.[peek.result.length - 1]?.update_id;
    const offset = latest !== undefined ? latest + 1 : 0;
    await saveOffset(offset);
    return offset;
  } catch {
    return 0;
  }
}

async function pollOnce(offset: number): Promise<{ nextOffset: number; updates: TelegramUpdate[] }> {
  // Raw fetch, not telegramRequest(): that helper hardcodes a 10s AbortSignal,
  // but long-polling needs Telegram's own connection held open for up to
  // POLL_TIMEOUT_S (30s) — reusing it would abort every idle poll as an error.
  inFlightAbort = new AbortController();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');

  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] }),
    signal: inFlightAbort.signal,
  });
  inFlightAbort = null;

  if (!response.ok) {
    throw new Error(`getUpdates HTTP ${response.status}`);
  }
  const data = (await response.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
  if (!data.ok) {
    throw new Error(`getUpdates error: ${data.description || 'unknown'}`);
  }
  const updates = data.result ?? [];
  const nextOffset = updates.length > 0 ? updates[updates.length - 1].update_id + 1 : offset;
  return { nextOffset, updates };
}

async function runLoop(): Promise<void> {
  let offset = await loadOffset();
  if (offset === 0) offset = await bootstrapOffset();

  let consecutiveErrors = 0;
  while (running) {
    try {
      const { nextOffset, updates } = await pollOnce(offset);
      consecutiveErrors = 0;

      for (const update of updates) {
        try {
          await processUpdate(update);
        } catch (err) {
          console.error('[TelegramNativeGateway] update_failed', update.update_id, (err as Error).message);
        }
        offset = update.update_id + 1;
        await saveOffset(offset);
      }
      offset = nextOffset;
    } catch (err) {
      if (!running) break;
      if (isFatalTelegramError(err)) {
        console.error('[TelegramNativeGateway] fatal_auth_error — stopping poll loop:', (err as Error).message);
        running = false;
        break;
      }
      if (isConflictError(err)) {
        console.error(
          '[TelegramNativeGateway] webhook_still_registered — run `npm run switch:telegram-native` first. Backing off 30s.',
        );
        await sleep(30_000);
        continue;
      }
      consecutiveErrors += 1;
      const backoff = Math.min(30_000, 250 * 2 ** consecutiveErrors + Math.floor(Math.random() * 250));
      console.warn('[TelegramNativeGateway] poll_error, retrying in', backoff, 'ms:', (err as Error).message);
      await sleep(backoff);
    }
  }
}

export function startTelegramNativeGateway(): void {
  if (!isHarnessFeatureEnabled('FEATURE_TELEGRAM_NATIVE_GATEWAY', false)) return;
  if (running) return;
  running = true;
  loopPromise = runLoop().catch((err) => {
    console.error('[TelegramNativeGateway] loop_crashed', (err as Error).message);
    running = false;
  });
  console.log('[TelegramNativeGateway] started (long-polling, flag ON)');
}

export function stopTelegramNativeGateway(): void {
  if (!running && !loopPromise) return;
  running = false;
  inFlightAbort?.abort();
}
