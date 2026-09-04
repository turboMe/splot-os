/**
 * NotebookLM CLI wrapper.
 * Ported 1:1 from: packages/notebooklm/src/client.ts (jarvis).
 * Wraps the `nlm` binary via child_process.spawn.
 * Used by: knowledge.* tools, chef enrichment, producer-hunt enrichment.
 *
 * NLM_BINARY_PATH env var controls the binary path (default: 'nlm').
 */
import { spawn } from 'node:child_process';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOTEBOOK_TITLE_ALIASES: Record<string, string> = {
  rynek: 'GastroBridge - Polski Rynek HoReCa',
  rhd: 'GastroBridge - Producenci i RHD',
  konkurencja: 'GastroBridge - Konkurencja',
  founder: 'GastroBridge - Głos Foundera',
  leady: 'GastroBridge - Leady i Kontakty',
  project: 'GastroBridge Master',
  docs: 'GastroBridge: Przewodnik po Platformie i Dokumentacja Q&A',
  // content-strategy = HOW to write great IG/LinkedIn/TikTok content + virality
  // (articles curated by Patryk). Consumed by contentAgent's STRATEGY state.
  // The NotebookLM notebook title is literally "content-strategy" so the alias
  // and the title coincide — resolveNotebookId still works via the title lookup.
  'content-strategy': 'content-strategy',
};

const notebookIdCache = new Map<string, string>();
let notebookIdCacheLoadedAt = 0;
const NOTEBOOK_ID_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

export class NotebookLMClient {
  private binaryPath: string;

  constructor(opts?: { binaryPath?: string }) {
    this.binaryPath = opts?.binaryPath ?? process.env.NLM_BINARY_PATH ?? 'nlm';
  }

  private async resolveNotebookId(nameOrId: string): Promise<string> {
    if (UUID_REGEX.test(nameOrId)) return nameOrId;
    const aliasTitle = NOTEBOOK_TITLE_ALIASES[nameOrId.toLowerCase()];
    const lookupName = aliasTitle ?? nameOrId;

    const cacheStale = Date.now() - notebookIdCacheLoadedAt > NOTEBOOK_ID_CACHE_TTL_MS;

    if (notebookIdCache.has(lookupName) && !cacheStale) {
      return notebookIdCache.get(lookupName)!;
    }

    const r = await this.exec(['notebook', 'list', '--json']);
    if (r.code !== 0) throw new Error(`nlm notebook list failed (code ${r.code}): ${r.stderr || r.stdout}`);

    let parsed: unknown;
    try { parsed = JSON.parse(r.stdout); } catch (e) { throw new Error(`Failed to parse nlm output: ${(e as Error).message}`); }

    const list: Array<{ id: string; title: string }> = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.value) ? (parsed as any).value : [];

    notebookIdCache.clear();
    for (const nb of list) { if (nb?.id && nb?.title) notebookIdCache.set(nb.title, nb.id); }
    notebookIdCacheLoadedAt = Date.now();

    let resolved = notebookIdCache.get(lookupName);
    if (!resolved) {
      const target = lookupName.toLowerCase().trim();
      for (const [title, id] of notebookIdCache.entries()) {
        if (title.toLowerCase().trim() === target) {
          resolved = id;
          break;
        }
      }
    }

    if (!resolved) {
      const available = Array.from(notebookIdCache.keys()).join(', ');
      const aliasHint = aliasTitle ? ` alias "${nameOrId}" -> "${lookupName}"` : '';
      throw new Error(`Notebook "${nameOrId}" not found${aliasHint}. Available: ${available}`);
    }
    return resolved;
  }

  private async exec(args: string[], timeoutMs = 60000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args, { timeout: timeoutMs, env: { ...process.env } });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (d: Buffer) => stdout += d.toString());
      proc.stderr.on('data', (d: Buffer) => stderr += d.toString());
      proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
      proc.on('error', reject);
    });
  }

  async listNotebooks(): Promise<Array<{ id: string; title: string }>> {
    const r = await this.exec(['notebook', 'list', '--json']);
    if (r.code !== 0) throw new Error(`nlm notebook list failed: ${r.stderr || r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.value) ? parsed.value : [];
    return list.filter((nb: any) => nb?.id && nb?.title).map((nb: any) => ({ id: nb.id, title: nb.title }));
  }

  async query(opts: { notebook: string; question: string; sourceIds?: string[]; timeout?: number }): Promise<{ answer: string; citations: string[] }> {
    const notebookId = await this.resolveNotebookId(opts.notebook);
    const args = ['query', 'notebook', notebookId, opts.question, '--json'];
    if (opts.sourceIds?.length) args.push('--source-ids', opts.sourceIds.join(','));
    if (opts.timeout) args.push('--timeout', opts.timeout.toString());

    const r = await this.exec(args, (opts.timeout ? opts.timeout * 1000 : 300000) + 10000);
    if (r.code !== 0) throw new Error(`nlm query failed (code ${r.code}): ${[r.stderr, r.stdout].filter(Boolean).join('\n')}`);

    try {
      const data = JSON.parse(r.stdout);
      const result = data.value || data;
      return {
        answer: result.answer || '',
        citations: Array.isArray(result.citations) ? result.citations.map((c: any) => typeof c === 'string' ? c : (c.cited_text || c.text || JSON.stringify(c))) : [],
      };
    } catch {
      const lines = r.stdout.split('\n');
      const citStart = lines.findIndex(l => l.startsWith('Sources:'));
      return {
        answer: citStart > 0 ? lines.slice(0, citStart).join('\n').trim() : r.stdout.trim(),
        citations: citStart > 0 ? lines.slice(citStart + 1).filter(Boolean) : [],
      };
    }
  }

  async crossNotebookQuery(opts: { notebooks: string[]; question: string }): Promise<Record<string, { answer: string; citations: string[] } | { error: string }>> {
    const results: Record<string, any> = {};
    for (const nb of opts.notebooks) {
      try { results[nb] = await this.query({ notebook: nb, question: opts.question }); }
      catch (e) { results[nb] = { error: (e as Error).message }; }
    }
    return results;
  }

  async createNotebook(title: string): Promise<string> {
    const r = await this.exec(['create', 'notebook', title]);
    if (r.code !== 0) throw new Error(`nlm create notebook failed: ${r.stderr}`);
    const idMatch = r.stdout.match(/ID: ([a-f0-9-]{36})/);
    return idMatch ? idMatch[1] : '';
  }

  async deleteNotebook(id: string): Promise<void> {
    const notebookId = await this.resolveNotebookId(id);
    const r = await this.exec(['delete', notebookId, '--confirm']);
    if (r.code !== 0) throw new Error(`nlm delete notebook failed: ${r.stderr}`);
  }

  async addSource(opts: { notebook: string; sourceType: 'url' | 'text'; url?: string; text?: string; title?: string }): Promise<{ sourceId: string; output: string }> {
    const notebookId = await this.resolveNotebookId(opts.notebook);
    const args = ['source', 'add', notebookId];
    if (opts.sourceType === 'url' && opts.url) args.push('--url', opts.url);
    if (opts.sourceType === 'text' && opts.text) args.push('--text', opts.text);
    if (opts.title) args.push('--title', opts.title);
    args.push('--wait');

    const r = await this.exec(args, 300000);
    const idMatch = r.stdout.match(/Source ID: ([a-f0-9-]{36})/);
    const sourceId = idMatch ? idMatch[1] : '';

    if (r.code !== 0 && !sourceId) throw new Error(`nlm source add failed: ${[r.stderr, r.stdout].filter(Boolean).join('\n')}`);
    return { sourceId, output: r.stdout.trim() };
  }

  async researchStart(opts: { query: string; notebookId?: string; mode?: 'fast' | 'deep'; autoImport?: boolean }): Promise<{ taskId: string; output: string }> {
    const args = ['research', 'start', opts.query];
    if (opts.notebookId) { const id = await this.resolveNotebookId(opts.notebookId); args.push('--notebook-id', id); }
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.autoImport) args.push('--auto-import');
    const timeout = opts.mode === 'deep' ? 600000 : 300000;
    const r = await this.exec(args, timeout);
    if (r.code !== 0) {
      const output = [r.stderr, r.stdout].filter(Boolean).join('\n').trim() || 'no output';
      throw new Error(`nlm research start failed (code ${r.code}): ${output}`);
    }
    const taskMatch = r.stdout.match(/Task ID: ([a-f0-9-]{36})/);
    return { taskId: taskMatch ? taskMatch[1] : '', output: r.stdout.trim() };
  }
}

// Singleton instance
let _client: NotebookLMClient | null = null;
export function getNlmClient(): NotebookLMClient {
  if (!_client) _client = new NotebookLMClient();
  return _client;
}
