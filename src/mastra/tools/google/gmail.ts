import { google, type gmail_v1 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { getGoogleAuth, type MailboxAccount, MAILBOX_ACCOUNTS } from './auth.js'
import { getDb } from '../../lib/mongo.js'
import { normalizeOutboundDashes } from '../writer/anti-slop.js'

/** An encoded-word may be at most 75 chars INCLUDING its delimiters (RFC 2047 §2). */
const ENCODED_WORD_PREFIX = '=?UTF-8?B?'
const ENCODED_WORD_SUFFIX = '?='
const MAX_ENCODED_WORD_CHARS = 75
/** base64 costs 4 chars per 3 bytes, so this is the payload budget per word. */
const MAX_BYTES_PER_WORD = Math.floor(
  (MAX_ENCODED_WORD_CHARS - ENCODED_WORD_PREFIX.length - ENCODED_WORD_SUFFIX.length) / 4,
) * 3

/**
 * A header value safe to put in an ASCII-only header.
 *
 * Pure ASCII passes through untouched, so English subjects keep reading as
 * themselves in any tool that inspects the raw message. Anything else becomes
 * RFC 2047 base64 encoded-words.
 *
 * Splitting happens on CHARACTER boundaries measured in BYTES: cutting a chunk
 * mid-character is precisely how "encoded" mojibake replaces "unencoded"
 * mojibake, and Polish subjects are long enough to need more than one word.
 */
function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value
  const words: string[] = []
  let chunk = ''
  let chunkBytes = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (chunkBytes + charBytes > MAX_BYTES_PER_WORD) {
      words.push(`${ENCODED_WORD_PREFIX}${Buffer.from(chunk, 'utf8').toString('base64')}${ENCODED_WORD_SUFFIX}`)
      chunk = ''
      chunkBytes = 0
    }
    chunk += char
    chunkBytes += charBytes
  }
  if (chunk) {
    words.push(`${ENCODED_WORD_PREFIX}${Buffer.from(chunk, 'utf8').toString('base64')}${ENCODED_WORD_SUFFIX}`)
  }
  // Folding whitespace between words: a receiver joins adjacent encoded-words
  // WITHOUT the separator, which is what keeps the subject from gaining spaces.
  return words.join('\r\n ')
}

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface EmailAttachment {
  filename: string
  path?: string
  content?: string | Buffer
  mimeType?: string
}

function detectMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  switch (ext) {
    case '.pdf':
      return 'application/pdf'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.doc':
      return 'application/msword'
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.xls':
      return 'application/vnd.ms-excel'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.txt':
      return 'text/plain'
    case '.csv':
      return 'text/csv'
    case '.zip':
      return 'application/zip'
    default:
      return 'application/octet-stream'
  }
}

/**
 * The RFC 822 message every outgoing draft is built from.
 *
 * A free function rather than a method so it can be exercised without Google
 * credentials: the two bugs it now fixes were both invisible until a human
 * opened the inbox, and a rule nothing can test is a rule that rots.
 */
export function buildOutboundMime(opts: {
  to: string
  subject: string
  body: string
  html?: string
  inReplyTo?: string
  references?: string
  attachments?: EmailAttachment[]
}): string {
  const normalizedSubject = encodeHeaderWord(normalizeOutboundDashes(opts.subject))
  const normalizedBody = normalizeOutboundDashes(opts.body)
  const normalizedHtml = opts.html ? normalizeOutboundDashes(opts.html) : undefined

  const headers: string[] = [
    `To: ${opts.to}`,
    `Subject: ${normalizedSubject}`,
  ]
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`)
  if (opts.references) headers.push(`References: ${opts.references}`)

  const hasAttachments = Boolean(opts.attachments && opts.attachments.length > 0)
  const hasHtml = Boolean(normalizedHtml && normalizedHtml.trim().length > 0)

  // Case 1: Simple plain-text without attachments
  if (!hasAttachments && !hasHtml) {
    headers.push(
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit'
    )
    return `${headers.join('\r\n')}\r\n\r\n${normalizedBody}`
  }

  // Case 2: HTML email without attachments (multipart/alternative)
  if (!hasAttachments && hasHtml) {
    const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
    headers.push(
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`
    )
    const parts = [
      headers.join('\r\n'),
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizedBody,
      `--${altBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizedHtml!,
      `--${altBoundary}--`,
      '',
    ]
    return parts.join('\r\n')
  }

  // Case 3: Message with attachments (multipart/mixed)
  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
  headers.push(
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
  )

  const parts: string[] = [
    headers.join('\r\n'),
    '',
  ]

  if (hasHtml) {
    // Nested multipart/alternative inside multipart/mixed
    const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizedBody,
      `--${altBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizedHtml!,
      `--${altBoundary}--`,
    )
  } else {
    // Single plain-text body part inside multipart/mixed
    parts.push(
      `--${mixedBoundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizedBody,
    )
  }

  // Add attachments
  for (const att of opts.attachments!) {
    let base64Data = ''
    if (att.content) {
      base64Data = Buffer.isBuffer(att.content)
        ? att.content.toString('base64')
        : att.content
    } else if (att.path) {
      if (fs.existsSync(att.path)) {
        base64Data = fs.readFileSync(att.path).toString('base64')
      } else {
        throw new Error(`Attachment file not found: ${att.path}`)
      }
    } else {
      throw new Error(`Attachment '${att.filename}' must provide either 'path' or 'content'`)
    }

    const mimeType = att.mimeType || detectMimeType(att.filename)
    const chunkedBase64 = base64Data.match(/.{1,76}/g)?.join('\r\n') ?? base64Data

    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${mimeType}; name="${encodeHeaderWord(att.filename)}"`,
      `Content-Disposition: attachment; filename="${encodeHeaderWord(att.filename)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      chunkedBase64,
    )
  }

  parts.push(`--${mixedBoundary}--`, '')
  return parts.join('\r\n')
}

export class GmailService {
  private gmail: gmail_v1.Gmail

  constructor(authClient: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth: authClient })
  }

  static async create(account: MailboxAccount = 'gastrobridge'): Promise<GmailService> {
    const auth = await getGoogleAuth(account)
    return new GmailService(auth)
  }

  async searchThreads(query: string, maxResults = 20) {
    const result = await this.gmail.users.threads.list({
      userId: 'me',
      q: query,
      maxResults
    })
    return result.data.threads ?? []
  }

  async searchMessages(query: string, maxResults = 20) {
    const result = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults
    })
    return result.data.messages ?? []
  }

  async getMessage(messageId: string) {
    const result = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    })
    return result.data
  }

  async getThread(threadId: string) {
    const result = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full'
    })
    return result.data
  }

  /**
   * Parse thread into a simple structure for LLM context.
   */
  async getThreadAsContext(threadId: string): Promise<{
    subject: string
    participants: string[]
    messages: Array<{
      from: string
      to: string
      date: Date
      body: string
    }>
  }> {
    const thread = await this.getThread(threadId)
    const messages = (thread.messages ?? []).map(m => {
      const headers = m.payload?.headers ?? []
      const from = headers.find(h => h.name === 'From')?.value ?? ''
      const to = headers.find(h => h.name === 'To')?.value ?? ''
      const date = new Date(headers.find(h => h.name === 'Date')?.value ?? '')
      const body = this.extractBody(m.payload!)
      return { from, to, date, body }
    })

    const subject = (thread.messages?.[0]?.payload?.headers ?? [])
      .find(h => h.name === 'Subject')?.value ?? ''
    const participants = Array.from(new Set([
      ...messages.map(m => m.from),
      ...messages.map(m => m.to)
    ]))

    return { subject, participants, messages }
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart): string {
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8')
    }
    if (payload.parts) {
      const textPart = payload.parts.find(p => p.mimeType === 'text/plain')
      if (textPart) return this.extractBody(textPart)
    }
    return ''
  }

  /**
   * Create draft reply in Gmail (does NOT send).
   */
  async createDraftReply(opts: {
    threadId: string
    to: string
    subject: string
    body: string
    html?: string
    inReplyTo?: string
    references?: string
    attachments?: EmailAttachment[]
  }): Promise<string> {
    const raw = this.buildRfc822({
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      html: opts.html,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      attachments: opts.attachments,
    })

    const result = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          threadId: opts.threadId,
          raw: Buffer.from(raw).toString('base64url')
        }
      }
    })

    return result.data.id!
  }

  /**
   * Create a new draft (not a reply).
   */
  async createDraft(opts: {
    to: string
    subject: string
    body: string
    html?: string
    attachments?: EmailAttachment[]
  }): Promise<string> {
    const raw = this.buildRfc822(opts)

    const result = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: Buffer.from(raw).toString('base64url')
        }
      }
    })

    return result.data.id!
  }

  /**
   * Update an existing Gmail draft in-place.
   */
  async updateDraft(opts: {
    draftId: string
    to: string
    subject: string
    body: string
    html?: string
    threadId?: string
    attachments?: EmailAttachment[]
  }): Promise<string> {
    const raw = this.buildRfc822(opts)

    const result = await this.gmail.users.drafts.update({
      userId: 'me',
      id: opts.draftId,
      requestBody: {
        id: opts.draftId,
        message: {
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
          raw: Buffer.from(raw).toString('base64url')
        }
      }
    })

    return result.data.id ?? opts.draftId
  }

  /**
   * List drafts in Gmail.
   */
  async listDrafts(maxResults = 20) {
    const result = await this.gmail.users.drafts.list({
      userId: 'me',
      maxResults
    })
    return result.data.drafts ?? []
  }

  /**
   * Get a specific draft with its content.
   */
  async getDraft(draftId: string) {
    const result = await this.gmail.users.drafts.get({
      userId: 'me',
      id: draftId,
      format: 'full'
    })
    
    const message = result.data.message
    if (!message) throw new Error(`Draft ${draftId} has no message content`)

    const headers = message.payload?.headers ?? []
    const to = headers.find(h => h.name === 'To')?.value ?? ''
    const subject = headers.find(h => h.name === 'Subject')?.value ?? ''
    const body = message.payload ? this.extractBody(message.payload) : ''

    return {
      id: draftId,
      to,
      subject,
      body,
      threadId: message.threadId
    }
  }

  private buildRfc822(opts: {
    to: string
    subject: string
    body: string
    html?: string
    inReplyTo?: string
    references?: string
    attachments?: EmailAttachment[]
  }): string {
    return buildOutboundMime(opts)
  }

  /**
   * Send a draft by ID.
   */
  async sendDraft(draftId: string): Promise<void> {
    await this.gmail.users.drafts.send({
      userId: 'me',
      requestBody: {
        id: draftId
      }
    })
  }

  /**
   * Delete a draft by ID.
   */
  async deleteDraft(draftId: string): Promise<void> {
    await this.gmail.users.drafts.delete({
      userId: 'me',
      id: draftId
    })
  }

  /**
   * Remove labels from a thread (e.g. UNREAD)
   */
  async removeLabel(threadId: string, labelIds: string[]): Promise<void> {
    await this.gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: {
        removeLabelIds: labelIds
      }
    })
  }
}

/**
 * Fetch and sync recent messages for a given mailbox account into MongoDB gmail_messages.
 */
export async function syncMailboxMessages(
  account: MailboxAccount,
  opts: { hoursBack?: number; maxResults?: number } = {}
): Promise<{ count: number; error?: string }> {
  try {
    const service = await GmailService.create(account)
    const db = await getDb()
    const hoursBack = opts.hoursBack ?? 24
    const maxResults = opts.maxResults ?? 50
    const cutoffSeconds = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)

    const messages = await service.searchMessages(`after:${cutoffSeconds}`, maxResults)
    let count = 0

    for (const msgRef of messages) {
      if (!msgRef.id) continue
      const full = await service.getMessage(msgRef.id)
      if (!full || !full.payload) continue

      const headers = full.payload.headers ?? []
      const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? ''
      const to = headers.find(h => h.name?.toLowerCase() === 'to')?.value ?? ''
      const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value ?? ''
      const dateStr = headers.find(h => h.name?.toLowerCase() === 'date')?.value ?? ''
      const date = dateStr ? new Date(dateStr) : new Date()

      const isOutbound = (full.labelIds ?? []).includes('SENT')
      const direction = isOutbound ? 'outbound' : 'inbound'

      await db.collection('gmail_messages').updateOne(
        { messageId: full.id },
        {
          $set: {
            messageId: full.id,
            threadId: full.threadId,
            account,
            from,
            to,
            subject,
            snippet: full.snippet ?? '',
            direction,
            receivedAt: date.toISOString(),
            sentAt: isOutbound ? date.toISOString() : undefined,
            labelIds: full.labelIds ?? [],
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      )
      count++
    }

    return { count }
  } catch (err: any) {
    console.warn(`[GmailSync] Skipped mailbox '${account}': ${err.message}`)
    return { count: 0, error: err.message }
  }
}

/**
 * Sync all configured mailboxes in parallel / sequence.
 */
export async function syncAllMailboxes(
  opts: { hoursBack?: number; maxResults?: number } = {}
): Promise<Record<MailboxAccount, { count: number; error?: string }>> {
  const results = {} as Record<MailboxAccount, { count: number; error?: string }>
  for (const account of MAILBOX_ACCOUNTS) {
    results[account] = await syncMailboxMessages(account, opts)
  }
  return results
}
