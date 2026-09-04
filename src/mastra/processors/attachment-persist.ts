/**
 * Attachment Persist Input Processor
 *
 * Runs at processInput (once per generate/stream call). When the user attaches
 * images/video/documents to a Studio chat (or any multimodal client), the bytes
 * arrive as message parts of `type: 'file'`. Field names vary by client/SDK
 * version:
 *   - AI SDK v6 UIMessage file part: { type:'file', mediaType, url }
 *   - AI SDK v4 / Mastra playground:  { type:'file', mimeType,  data }
 * where `url`/`data` is a `data:` base64 URL (or, for `data`, raw base64) or a
 * hosted http(s) URL. They may also sit in `content.experimental_attachments[]`
 * ({ contentType|mediaType, url|data, name }).
 *
 * An LLM cannot re-emit those bytes into a tool call, so persistence must happen
 * here, before the model runs. The heavy lifting (scanning shapes, byte
 * decoding, allowlist, sha1-idempotent writes, note block) lives in
 * services/prompt-attachments.ts — shared with the meta-agent harness wrapper,
 * which handles the REST generate path (where the prompt is flattened to text
 * BEFORE input processors run, so this processor never sees those file parts).
 *
 * Filmmaker domain — image-input (ideas/filmmaker.md §16).
 */

import type { ProcessInputArgs, ProcessInputResult } from '@mastra/core/processors';
import { BaseProcessor } from '@mastra/core/processors';

import {
  attachmentNoteBlock,
  resolveInboxDir,
  scanAndPersistMessages,
} from '../services/prompt-attachments.js';

function extractThreadId(args: ProcessInputArgs): string | undefined {
  const rc = args.requestContext as unknown as Record<string, unknown> | undefined;
  if (rc) {
    try {
      const viaGetter = (rc as any).get?.('mastra__threadId');
      if (typeof viaGetter === 'string' && viaGetter.length > 0) return viaGetter;
      const alt = rc.threadId ?? rc.thread ?? rc['mastra__threadId'];
      if (typeof alt === 'string' && alt.length > 0) return alt;
    } catch { /* safe */ }
  }
  const lastUser = [...args.messages].reverse().find((m) => m.role === 'user');
  const tid = (lastUser as any)?.threadId ?? (lastUser as any)?.thread_id;
  return typeof tid === 'string' && tid.length > 0 ? tid : undefined;
}

export class AttachmentPersistProcessor extends BaseProcessor<'attachment-persist'> {
  readonly id = 'attachment-persist' as const;
  readonly name = 'Attachment Persist Processor';
  readonly description =
    'Persists user-attached images/video/documents to disk before the model runs and exposes their file paths to the agent.';

  constructor(private readonly options: { inboxDir?: string } = {}) {
    super();
  }

  async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
    const { messages, systemMessages } = args;

    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) return messages;

    const threadId = extractThreadId(args);
    const outDir = resolveInboxDir(threadId, this.options.inboxDir);

    const saved = await scanAndPersistMessages(userMessages, outDir);
    if (saved.length === 0) return messages;

    const injectedSystemMessage = {
      role: 'system' as const,
      content: attachmentNoteBlock(saved),
    };

    console.log(`[AttachmentPersist] ✅ injected note with ${saved.length} saved attachment(s)`);

    return {
      messages,
      systemMessages: [...systemMessages, injectedSystemMessage],
    };
  }
}

export const attachmentPersistProcessor = new AttachmentPersistProcessor();
