import { createHash, randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';

import { CODING_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { logHarnessEvent } from './harness-events.js';

export type HarnessArtifactKind =
  | 'tool_output'
  | 'llm_output'
  | 'command_log'
  | 'diff'
  | 'memory_context';

export type HarnessArtifactStorage = 'mongo' | 'file';

export type CompactionResult = {
  preview: string;
  fullTextArtifactId?: string;
  storage?: HarnessArtifactStorage;
  originalBytes: number;
  previewBytes: number;
  truncated: boolean;
};

export type HarnessArtifactDoc = {
  id: string;
  runId?: string;
  turnId?: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  toolId?: string;
  kind: HarnessArtifactKind;
  storage: HarnessArtifactStorage;
  content?: string;
  filePath?: string;
  bytes: number;
  sha256: string;
  createdAt: Date;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
};

export type CompactHarnessOutputInput = {
  text: string;
  kind: HarnessArtifactKind;
  runId?: string;
  turnId?: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  toolId?: string;
  previewBytes?: number;
  mongoMaxBytes?: number;
  forcePersist?: boolean;
  metadata?: Record<string, unknown>;
};

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_PREVIEW_BYTES = 16 * 1024;
const DEFAULT_MONGO_MAX_BYTES = 512 * 1024;

export async function compactHarnessOutput(
  input: CompactHarnessOutputInput,
): Promise<CompactionResult> {
  const safeText = redactSecrets(input.text ?? '').text;
  const originalBytes = Buffer.byteLength(input.text ?? '', 'utf8');
  const enabled = isHarnessFeatureEnabled('FEATURE_OUTPUT_COMPACTION', true);
  const previewLimit = input.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const basePreview = compactTextForPreview(safeText, previewLimit);

  if (!enabled || (!basePreview.truncated && !input.forcePersist)) {
    return {
      preview: basePreview.preview,
      originalBytes,
      previewBytes: basePreview.previewBytes,
      truncated: false,
    };
  }

  const artifact = await persistHarnessArtifact({
    ...input,
    text: safeText,
    bytes: Buffer.byteLength(safeText, 'utf8'),
    mongoMaxBytes: input.mongoMaxBytes ?? DEFAULT_MONGO_MAX_BYTES,
  });
  const preview = basePreview.truncated
    ? formatCompactedOutputPreview({
        preview: basePreview.preview,
        artifactId: artifact?.id,
        originalBytes,
        previewBytes: basePreview.previewBytes,
      })
    : basePreview.preview;
  const result: CompactionResult = {
    preview,
    fullTextArtifactId: artifact?.id,
    storage: artifact?.storage,
    originalBytes,
    previewBytes: Buffer.byteLength(preview, 'utf8'),
    truncated: basePreview.truncated,
  };

  await logHarnessEvent({
    type: 'tool_output_compacted',
    agentId: canonicalizeRuntimeAgentId(input.agentId) ?? CODING_AGENT_ID,
    runId: input.runId ?? input.taskId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: 'output_compaction',
    toolId: input.toolId,
    status: 'success',
    output: preview,
    data: {
      artifactId: artifact?.id,
      storage: artifact?.storage,
      kind: input.kind,
      originalBytes,
      previewBytes: result.previewBytes,
      truncated: result.truncated,
      forcePersist: input.forcePersist === true,
    },
  });

  return result;
}

export function compactTextForPreview(
  text: string,
  maxPreviewBytes = DEFAULT_PREVIEW_BYTES,
): { preview: string; originalBytes: number; previewBytes: number; truncated: boolean } {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxPreviewBytes) {
    return {
      preview: text,
      originalBytes,
      previewBytes: originalBytes,
      truncated: false,
    };
  }

  const preview = truncateUtf8Bytes(text, maxPreviewBytes);
  return {
    preview,
    originalBytes,
    previewBytes: Buffer.byteLength(preview, 'utf8'),
    truncated: true,
  };
}

function formatCompactedOutputPreview(input: {
  preview: string;
  artifactId?: string;
  originalBytes: number;
  previewBytes: number;
}): string {
  return [
    'Output truncated.',
    `Original bytes: ${input.originalBytes}. Preview bytes: ${input.previewBytes}.`,
    'Preview:',
    input.preview,
    input.artifactId
      ? `Full output artifact: ${input.artifactId}`
      : 'Full output artifact: unavailable',
  ].join('\n');
}

async function persistHarnessArtifact(input: CompactHarnessOutputInput & {
  text: string;
  bytes: number;
  mongoMaxBytes: number;
}): Promise<{ id: string; storage: HarnessArtifactStorage } | undefined> {
  const id = randomUUID();
  const sha256 = createHash('sha256').update(input.text).digest('hex');
  const now = new Date();
  const storage: HarnessArtifactStorage = input.bytes <= input.mongoMaxBytes ? 'mongo' : 'file';
  const doc: HarnessArtifactDoc = {
    id,
    runId: input.runId ?? input.taskId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    agentId: canonicalizeRuntimeAgentId(input.agentId),
    toolId: input.toolId,
    kind: input.kind,
    storage,
    bytes: input.bytes,
    sha256,
    createdAt: now,
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000),
    metadata: input.metadata,
  };

  try {
    if (storage === 'mongo') {
      doc.content = input.text;
    } else {
      doc.filePath = await writeHarnessArtifactFile(id, input.text);
    }

    const db = await getDb();
    await db.collection<HarnessArtifactDoc>('harness_artifacts').insertOne(doc);
    return { id, storage };
  } catch (error) {
    console.warn('[OutputCompactor] Failed to persist harness artifact:', (error as Error).message);
    return undefined;
  }
}

async function writeHarnessArtifactFile(id: string, content: string): Promise<string> {
  const artifactDir = resolve(
    process.env.MASTRA_HARNESS_ARTIFACT_DIR || resolve(process.cwd(), '.mastra/harness-artifacts'),
  );
  await mkdir(artifactDir, { recursive: true });
  const filePath = resolve(artifactDir, `${id}.txt`);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }

  return out;
}
