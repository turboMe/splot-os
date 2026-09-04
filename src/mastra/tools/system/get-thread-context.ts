import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { META_AGENT_ID } from '../../config/agent-ids.js';
import { getDb } from '../../lib/mongo.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

const THREADS_COLLECTION = 'mastra_threads';
const MESSAGES_COLLECTION = 'mastra_messages';

type MemoryThreadDoc = {
  id: string;
  title?: string;
  resourceId?: string;
  metadata?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

type MemoryMessageDoc = {
  id?: string;
  thread_id: string;
  resourceId?: string;
  role?: string;
  type?: string;
  content?: unknown;
  createdAt?: Date;
};

type ThreadContextMessage = {
  id?: string;
  role: string;
  createdAt?: string;
  text: string;
};

export const getThreadContextTool = createTool({
  id: 'get_thread_context',
  description:
    'Reads prior Mastra thread messages from MongoDB for continuity. Use when a scheduled task needs context from the parent user thread. ' +
    'This is a deterministic last-message fallback and does not claim vector semantic search.',
  inputSchema: z.object({
    parentThreadId: z.string().min(1),
    resourceId: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    lastMessages: z.number().int().min(1).max(30).optional().default(12),
    maxChars: z.number().int().min(1000).max(12_000).optional().default(8000),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    threadId: z.string(),
    threadFound: z.boolean(),
    messageCount: z.number(),
    semanticSearchUsed: z.boolean(),
    context: z.string(),
    messages: z.array(z.object({
      id: z.string().optional(),
      role: z.string(),
      createdAt: z.string().optional(),
      text: z.string(),
    })),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'get_thread_context',
    category: 'memory',
    risk: 'low',
    defaultAgentId: META_AGENT_ID,
    redactOutputFields: ['context', 'messages'],
    execute: async (input: {
      parentThreadId: string;
      resourceId?: string;
      query?: string;
      lastMessages?: number;
      maxChars?: number;
    }) => {
      try {
        const db = await getDb();
        const thread = await db.collection<MemoryThreadDoc>(THREADS_COLLECTION).findOne({
          id: input.parentThreadId,
          ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        });
        const limit = Math.max(1, Math.min(30, input.lastMessages ?? 12));
        const fetchLimit = input.query ? Math.min(100, Math.max(limit * 4, 30)) : limit;
        const messageQuery: Record<string, unknown> = { thread_id: input.parentThreadId };
        if (input.resourceId) messageQuery.resourceId = input.resourceId;

        const docs = await db.collection<MemoryMessageDoc>(MESSAGES_COLLECTION)
          .find(messageQuery)
          .sort({ createdAt: -1 })
          .limit(fetchLimit)
          .toArray();

        const normalized = docs
          .map(toThreadContextMessage)
          .filter((message) => message.text.trim().length > 0);
        const selected = selectMessages(normalized, input.query, limit);
        const context = trimContext(formatThreadContext({
          thread,
          threadId: input.parentThreadId,
          query: input.query,
          messages: selected,
        }), Math.max(1000, Math.min(12_000, input.maxChars ?? 8000)));

        return {
          success: true,
          threadId: input.parentThreadId,
          threadFound: Boolean(thread),
          messageCount: selected.length,
          semanticSearchUsed: false,
          context,
          messages: selected,
        };
      } catch (error) {
        return {
          success: false,
          threadId: input.parentThreadId,
          threadFound: false,
          messageCount: 0,
          semanticSearchUsed: false,
          context: '',
          messages: [],
          error: (error as Error).message,
        };
      }
    },
  }),
});

function selectMessages(
  messagesNewestFirst: ThreadContextMessage[],
  query: string | undefined,
  limit: number,
): ThreadContextMessage[] {
  if (!query) {
    return messagesNewestFirst.slice(0, limit).reverse();
  }

  const terms = tokenize(query);
  if (terms.length === 0) return messagesNewestFirst.slice(0, limit).reverse();

  return messagesNewestFirst
    .map((message, index) => ({
      message,
      index,
      score: scoreMessage(message.text, terms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => {
      const aTime = a.message.createdAt ? Date.parse(a.message.createdAt) : 0;
      const bTime = b.message.createdAt ? Date.parse(b.message.createdAt) : 0;
      return aTime - bTime;
    })
    .map((item) => item.message);
}

function toThreadContextMessage(doc: MemoryMessageDoc): ThreadContextMessage {
  return {
    id: doc.id,
    role: doc.role ?? doc.type ?? 'message',
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : undefined,
    text: normalizeContent(doc.content).slice(0, 4000),
  };
}

function normalizeContent(content: unknown): string {
  const parsed = maybeParseJson(content);
  if (parsed == null) return '';
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) {
    return parsed.map(normalizeContent).filter(Boolean).join('\n');
  }
  if (typeof parsed !== 'object') return String(parsed);

  const record = parsed as Record<string, unknown>;
  for (const key of ['text', 'message', 'output']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) return record.content.map(normalizeContent).filter(Boolean).join('\n');
  if (Array.isArray(record.parts)) return record.parts.map(normalizeContent).filter(Boolean).join('\n');

  try {
    return JSON.stringify(record);
  } catch {
    return String(record);
  }
}

function maybeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9ąćęłńóśźż_-]{3,}/gi) ?? [])];
}

function scoreMessage(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function formatThreadContext(input: {
  thread: MemoryThreadDoc | null;
  threadId: string;
  query?: string;
  messages: ThreadContextMessage[];
}): string {
  const header = [
    `Thread: ${input.thread?.title ?? input.threadId}`,
    input.thread?.resourceId ? `Resource: ${input.thread.resourceId}` : '',
    input.query ? `Query: ${input.query}` : '',
    'Semantic search: not used; deterministic Mongo message fallback.',
  ].filter(Boolean);
  const body = input.messages.map((message, index) => [
    `## Message ${index + 1}`,
    message.createdAt ? `createdAt: ${message.createdAt}` : '',
    `role: ${message.role}`,
    message.text,
  ].filter(Boolean).join('\n'));
  return [...header, '', ...body].join('\n');
}

function trimContext(context: string, maxChars: number): string {
  if (context.length <= maxChars) return context;
  return `...context truncated to the last ${maxChars} chars...\n${context.slice(-maxChars)}`;
}
