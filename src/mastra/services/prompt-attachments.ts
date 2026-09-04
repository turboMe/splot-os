/**
 * Shared attachment persistence.
 *
 * Two entry paths deliver user file attachments to agents:
 *   - stream path (Studio):  input processors receive MastraDBMessage V2 —
 *     handled by AttachmentPersistProcessor, which delegates the heavy
 *     lifting here.
 *   - generate path (REST, e.g. the n8n Telegram gateway): the meta-agent
 *     harness wrapper flattens the whole prompt to a TEXT string before any
 *     input processor runs, so file parts must be persisted HERE first and
 *     replaced in place with a short text marker that survives flattening.
 *
 * Files land in <inbox>/<threadSeg>/<sha1>.<ext> (idempotent re-runs), and
 * callers surface the absolute paths to the agent via a note block.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

// 20MB — Telegram Bot API getFile download cap; film_generate enforces its own
// 10MB guard separately, so a larger transport limit here is safe.
export const MAX_BYTES = 20 * 1024 * 1024;

// mediaType allowlist → file extension. Media types mirror film-generate
// guessMime; document/audio types cover the Telegram gateway (photos,
// documents, voice notes) and Studio uploads.
export const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'audio/ogg': '.ogg',   // Telegram voice notes
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-wav': '.wav',
  'audio/wav': '.wav',
};

export interface SavedAttachment {
  path: string;       // absolute path for the agent to use
  mediaType: string;
  filename?: string;
  bytes: number;
}

export interface PersistResult {
  ok: boolean;
  path?: string;
  mediaType?: string;
  bytes?: number;
  reason?: string;
}

export function normalizeMediaType(raw?: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const base = raw.split(';')[0]?.trim().toLowerCase();
  return base || undefined;
}

export function describeRaw(raw: unknown): string {
  if (typeof raw !== 'string') return `(${typeof raw})`;
  if (raw.startsWith('data:')) return `data-url len=${raw.length}`;
  if (/^https?:\/\//.test(raw)) return `http-url[${raw.slice(0, 60)}] len=${raw.length}`;
  return `base64? len=${raw.length}`;
}

/** Pull the byte-source string + declared mime + filename off a file part. */
export function fileSource(part: any): { raw: string; declaredMime?: string; filename?: string } | undefined {
  const raw = typeof part?.url === 'string'
    ? part.url
    : typeof part?.data === 'string'
      ? part.data
      : undefined;
  if (!raw) return undefined;
  return {
    raw,
    declaredMime: normalizeMediaType(part?.mediaType) ?? normalizeMediaType(part?.mimeType),
    filename: part?.filename ?? part?.name,
  };
}

async function bytesFromRaw(raw: string, declaredMime?: string): Promise<{ buffer: Buffer; mediaType?: string } | undefined> {
  if (raw.startsWith('data:')) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(raw);
    if (!match) return undefined;
    const mediaType = match[1] || declaredMime;
    const isBase64 = Boolean(match[2]);
    const payload = match[3] ?? '';
    const buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf-8');
    return { buffer, mediaType: normalizeMediaType(mediaType) };
  }
  if (/^https?:\/\//.test(raw)) {
    const response = await fetch(raw);
    if (!response.ok) throw new Error(`fetch attachment failed ${response.status}: ${raw.slice(0, 120)}`);
    const mediaType = normalizeMediaType(response.headers.get('content-type')) ?? declaredMime;
    return { buffer: Buffer.from(await response.arrayBuffer()), mediaType };
  }
  // Bare base64 string (AI SDK v4 `data` without a data: prefix) — needs a declared mime.
  if (declaredMime) {
    try {
      return { buffer: Buffer.from(raw, 'base64'), mediaType: declaredMime };
    } catch { /* fallthrough */ }
  }
  return undefined;
}

/** Resolve the per-thread inbox directory (absolute). */
export function resolveInboxDir(threadId?: string, baseDirOverride?: string): string {
  const threadSeg = (threadId ?? randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseDir = baseDirOverride || process.env.FILM_INBOX_DIR || 'film-work/_inbox';
  return isAbsolute(baseDir)
    ? resolve(baseDir, threadSeg)
    : resolve(process.cwd(), baseDir, threadSeg);
}

/** Persist one attachment byte-source into outDir. sha1 name = idempotent. */
export async function persistRawAttachment(
  raw: string,
  declaredMime: string | undefined,
  outDir: string,
): Promise<PersistResult> {
  try {
    const fetched = await bytesFromRaw(raw, declaredMime);
    if (!fetched) return { ok: false, reason: 'unsupported byte source' };
    const mediaType = fetched.mediaType ?? normalizeMediaType(declaredMime);
    if (!mediaType || !(mediaType in MIME_EXT)) {
      return { ok: false, reason: `mediaType not allowed: ${mediaType ?? 'unknown'}` };
    }
    if (fetched.buffer.length > MAX_BYTES) {
      return { ok: false, reason: `too large: ${Math.round(fetched.buffer.length / 1024 / 1024)}MB > ${Math.round(MAX_BYTES / 1024 / 1024)}MB` };
    }
    await mkdir(outDir, { recursive: true });
    const hash = createHash('sha1').update(fetched.buffer).digest('hex').slice(0, 16);
    const absPath = resolve(outDir, `${hash}${MIME_EXT[mediaType]}`);
    if (!existsSync(absPath)) await writeFile(absPath, fetched.buffer);
    // Absolute path on purpose: server cwd differs from agent workspace roots,
    // so a relative path is ambiguous across that boundary.
    return { ok: true, path: absPath, mediaType, bytes: fetched.buffer.length };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * Scan messages (any of the shapes below) for user file attachments, persist
 * each to outDir, and REPLACE the heavy part in place with a short text marker
 * so downstream flattening/token budgets never see the base64.
 *
 * Handled shapes per message:
 *   - content.parts[]                (MastraDBMessage V2)
 *   - content[]                      (CoreMessage / ModelMessage REST body)
 *   - parts[]                        (UIMessage v5/v6)
 *   - content.experimental_attachments[] / experimental_attachments[]
 */
export async function scanAndPersistMessages(messages: unknown[], outDir: string): Promise<SavedAttachment[]> {
  const saved: SavedAttachment[] = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const m = message as Record<string, any>;
    if (m.role !== 'user') continue;

    const content: any = m.content;
    const parts: any[] = Array.isArray(content?.parts)
      ? content.parts
      : Array.isArray(content)
        ? content
        : Array.isArray(m.parts)
          ? m.parts
          : [];
    const experimental: any[] = Array.isArray(content?.experimental_attachments)
      ? content.experimental_attachments
      : Array.isArray(m.experimental_attachments)
        ? m.experimental_attachments
        : [];

    // 1) file parts — strip the heavy part in place once saved.
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part?.type !== 'file' && part?.type !== 'image') continue;
      const src = part?.type === 'image' && typeof part?.image === 'string'
        ? { raw: part.image as string, declaredMime: normalizeMediaType(part?.mimeType) ?? 'image/png', filename: part?.filename }
        : fileSource(part);
      if (!src) continue;
      console.log(
        `[AttachmentPersist] file part: mediaType=${src.declaredMime ?? '?'} source=${describeRaw(src.raw)} filename=${src.filename ?? '-'}`,
      );
      const result = await persistRawAttachment(src.raw, src.declaredMime, outDir);
      if (result.ok && result.path) {
        saved.push({ path: result.path, mediaType: result.mediaType!, filename: src.filename, bytes: result.bytes! });
        parts[i] = { type: 'text', text: `[załączony plik zapisany: ${result.path}]` };
        console.log(`[AttachmentPersist] saved → ${result.path} (${result.mediaType}, ${result.bytes}B)`);
      } else {
        console.log(`[AttachmentPersist] skipped file part: ${result.reason}`);
      }
    }

    // 2) experimental_attachments — persist by reference (leave the array).
    for (const att of experimental) {
      const raw = typeof att?.url === 'string' ? att.url : typeof att?.data === 'string' ? att.data : undefined;
      if (!raw) continue;
      const declaredMime = normalizeMediaType(att?.contentType) ?? normalizeMediaType(att?.mediaType);
      const result = await persistRawAttachment(raw, declaredMime, outDir);
      if (result.ok && result.path) {
        saved.push({ path: result.path, mediaType: result.mediaType!, filename: att?.name, bytes: result.bytes! });
        console.log(`[AttachmentPersist] saved experimental → ${result.path} (${result.mediaType}, ${result.bytes}B)`);
      } else {
        console.log(`[AttachmentPersist] skipped experimental attachment: ${result.reason}`);
      }
    }
  }

  return saved;
}

/** Human/agent-facing note block listing saved attachment paths + usage rules. */
export function attachmentNoteBlock(saved: SavedAttachment[]): string {
  const seen = new Set<string>();
  const lines = saved
    .filter((a) => (seen.has(a.path) ? false : (seen.add(a.path), true)))
    .map((a) => `- ${a.path}  (${a.mediaType}${a.filename ? `, "${a.filename}"` : ''})`);

  return [
    '## Załączniki użytkownika (zapisane na dysku)',
    'Użytkownik dołączył pliki; zapisano je lokalnie. Użyj tych ścieżek jako materiału wejściowego:',
    '- filmmaker: przekaż ścieżkę w `film_generate.referenceRoles[].path` z właściwą rolą (first_frame / identity / last_frame / motion / reference) i dobierz tryb (I2V / FLF2V / R2V / V2V).',
    '- meta: jeśli delegujesz zadanie, przekaż te ścieżki DOSŁOWNIE w treści zadania.',
    '- dokumenty (pdf/csv/docx/txt…): czytaj i przetwarzaj bezpośrednio z tej ścieżki (np. `meta_execute_command`), zapisz kopię gdzie trzeba, albo przekaż ścieżkę delegatowi.',
    '- odpowiedź z plikiem: jeśli masz odesłać użytkownikowi plik na Telegram, użyj `telegram_send_file` z tą ścieżką.',
    '- NIE sprawdzaj tych ścieżek narzędziami workspace (`mastra_workspace_file_stat`, `list_files`) — mają inny root i zgłoszą fałszywy błąd „outside the workspace” / „missing”. Ścieżki są poprawne; przekaż je wprost do narzędzi, które same odczytają plik.',
    '',
    ...lines,
  ].join('\n');
}
