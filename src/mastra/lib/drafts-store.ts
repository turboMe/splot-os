/**
 * DraftsStore — port z jarvis (`packages/drafts/src/store.ts`).
 *
 * Zapisuje draft jako:
 *   {basePath}/{YYYY-MM-DD}/{taskId}/{draftId}/draft.md
 *   {basePath}/{YYYY-MM-DD}/{taskId}/{draftId}/draft.meta.json
 *
 * Używa go workflow producer-hunt (step `save-drafts-fs`). Format identyczny z jarvis,
 * dzięki czemu istniejący dashboard z jarvis może czytać drafty bez zmian.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface DraftMetadata {
  draftId: string;
  taskId: string;
  type: string;
  language: 'pl' | 'en';
  topic?: string;
  hashtags?: string[];
  charCount?: number;
  rationale?: string;
  scheduledFor?: string;
  weekStarting?: string;
  calendarEventId?: string | null;
  createdAt: string;
  agentId: string;
  llm: { provider: string; model: string; costUsd: number };
  status?: string;
  company?: string;
  region?: string;
  segment?: string;
  supplierType?: string;
  sourceContact?: string;
  personalizationElements?: string[];
  enrichment?: unknown;
  gmailDraftId?: string;
  imagePrompt?: string;
  imagePath?: string | null;
  imageProvider?: string;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export class DraftsStore {
  constructor(private basePath: string) {}

  async ensureBaseDir(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  async save(opts: {
    taskId: string;
    draftId: string;
    content: string;
    metadata: DraftMetadata;
    additionalFiles?: Record<string, string>;
  }): Promise<string> {
    const date = todayDate();
    const folderPath = path.join(this.basePath, date, opts.taskId, opts.draftId);
    await fs.mkdir(folderPath, { recursive: true });

    await fs.writeFile(path.join(folderPath, 'draft.md'), opts.content, 'utf-8');
    await fs.writeFile(
      path.join(folderPath, 'draft.meta.json'),
      JSON.stringify(opts.metadata, null, 2),
      'utf-8',
    );

    if (opts.additionalFiles) {
      for (const [name, content] of Object.entries(opts.additionalFiles)) {
        await fs.writeFile(path.join(folderPath, name), content, 'utf-8');
      }
    }
    return folderPath;
  }

  async read(folderPath: string): Promise<{
    content: string;
    metadata: DraftMetadata;
    additionalFiles: Record<string, string>;
  }> {
    const content = await fs.readFile(path.join(folderPath, 'draft.md'), 'utf-8');
    const metadata = JSON.parse(
      await fs.readFile(path.join(folderPath, 'draft.meta.json'), 'utf-8'),
    ) as DraftMetadata;

    const files = await fs.readdir(folderPath);
    const additionalFiles: Record<string, string> = {};
    for (const f of files) {
      if (f === 'draft.md' || f === 'draft.meta.json') continue;
      additionalFiles[f] = await fs.readFile(path.join(folderPath, f), 'utf-8');
    }
    return { content, metadata, additionalFiles };
  }

  async listByDate(date: string): Promise<string[]> {
    try {
      const dayPath = path.join(this.basePath, date);
      const tasks = await fs.readdir(dayPath);
      const folders: string[] = [];
      for (const t of tasks) {
        const taskPath = path.join(dayPath, t);
        const stat = await fs.stat(taskPath);
        if (!stat.isDirectory()) continue;
        const drafts = await fs.readdir(taskPath);
        for (const d of drafts) {
          const draftPath = path.join(taskPath, d);
          const draftStat = await fs.stat(draftPath);
          if (draftStat.isDirectory()) folders.push(draftPath);
        }
      }
      return folders;
    } catch {
      return [];
    }
  }

  async listRecentMetadata(limit: number = 30): Promise<DraftMetadata[]> {
    try {
      const dates = (await fs.readdir(this.basePath))
        .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
        .sort((a, b) => b.localeCompare(a));
      const metadata: DraftMetadata[] = [];

      for (const date of dates) {
        const folders = await this.listByDate(date);
        for (const folderPath of folders) {
          try {
            const raw = await fs.readFile(path.join(folderPath, 'draft.meta.json'), 'utf-8');
            metadata.push(JSON.parse(raw) as DraftMetadata);
          } catch {
            continue;
          }
          if (metadata.length >= limit) {
            return metadata.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          }
        }
      }

      return metadata.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }
}

import { getDraftsDir } from '../config/workspace-paths.js';

let singleton: DraftsStore | null = null;
export function getDraftsStore(): DraftsStore {
  if (singleton) return singleton;
  const base = process.env.DRAFTS_PATH ?? getDraftsDir();
  singleton = new DraftsStore(base);
  return singleton;
}
