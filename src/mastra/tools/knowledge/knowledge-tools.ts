/**
 * NotebookLM knowledge tools.
 * Replaces: MCP notebooklm (disabled due to Selenium issues).
 * Ported from: apps/workers/src/agents/meta-agent/tool-definitions.ts (jarvis).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getNlmClient } from './notebooklm-client.js';

// Known notebooks (from jarvis knowledge-plan.md)
export const KNOWN_NOTEBOOKS = [
  'rynek', 'rhd', 'konkurencja', 'founder', 'leady', 'project', 'docs',
  'content-strategy',
  'chef_master', 'chef_flavor', 'chef_texture', 'chef_classic', 'chef_modern',
  'chef_europe', 'chef_asia', 'chef_americas_mena', 'chef_psychology',
] as const;

// ────────────────────────────────────────────────────────────────────────────
// knowledge.query – query existing notebook
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeQueryTool = createTool({
  id: 'knowledge_query',
  description: `Asks a question to an existing NotebookLM notebook (RAG over documents).
Available notebooks: ${KNOWN_NOTEBOOKS.join(', ')}.
Use for: questions about the HoReCa market (rynek), RHD regulations (rhd), competition (konkurencja), chef knowledge (chef_*).`,
  inputSchema: z.object({
    notebook: z.string().describe(`Notebook name. Known: ${KNOWN_NOTEBOOKS.join(', ')}`),
    question: z.string().describe('Question for the notebook (natural language)'),
    timeout: z.number().optional().default(120).describe('Timeout in seconds (default: 120)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    answer: z.string().optional(),
    citations: z.array(z.string()).optional(),
    notebook: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const result = await nlm.query({
        notebook: context.notebook,
        question: context.question,
        timeout: context.timeout,
      });
      return { success: true, answer: result.answer, citations: result.citations, notebook: context.notebook };
    } catch (error) {
      return { success: false, notebook: context.notebook, error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// knowledge.query_multi – cross-notebook query
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeQueryMultiTool = createTool({
  id: 'knowledge_query_multi',
  description: 'Queries multiple notebooks simultaneously and returns answers from each. Use when the question spans multiple domains (e.g., rynek + konkurencja).',
  inputSchema: z.object({
    notebooks: z.array(z.string()).min(1).max(4).describe('List of notebook names (max 4)'),
    question: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.record(z.string(), z.object({
      answer: z.string().optional(),
      citations: z.array(z.string()).optional(),
      error: z.string().optional(),
    })),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const results = await nlm.crossNotebookQuery({ notebooks: context.notebooks, question: context.question });
      return { success: true, results: results as any };
    } catch (error) {
      return { success: false, results: {}, error: (error as Error).message } as any;
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// knowledge.list_notebooks
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeListNotebooksTool = createTool({
  id: 'knowledge_list_notebooks',
  description: 'Returns a list of all available NotebookLM notebooks (ID + title).',
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    notebooks: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const nlm = getNlmClient();
      const notebooks = await nlm.listNotebooks();
      return { success: true, notebooks };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// knowledge.create_temp_notebook (for enrichment workflows)
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeCreateNotebookTool = createTool({
  id: 'knowledge_create_notebook',
  description: 'Creates a temporary NotebookLM notebook for one-off research (e.g., for a single company in producer-hunt). Use knowledge.add_source to add a URL, then knowledge.query, and finally knowledge.delete_notebook.',
  inputSchema: z.object({
    title: z.string().describe('Notebook title (e.g. "Temp: Acme Farm research")'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    notebookId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const notebookId = await nlm.createNotebook(context.title);
      return { success: true, notebookId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const knowledgeAddSourceTool = createTool({
  id: 'knowledge_add_source',
  description: 'Adds a source (URL or text) to a NotebookLM notebook.',
  inputSchema: z.object({
    notebook: z.string().describe('Notebook ID or title'),
    sourceType: z.enum(['url', 'text']),
    url: z.string().optional(),
    text: z.string().optional(),
    title: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    sourceId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const result = await nlm.addSource({
        notebook: context.notebook,
        sourceType: context.sourceType,
        url: context.url,
        text: context.text,
        title: context.title,
      });
      return { success: true, sourceId: result.sourceId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const knowledgeDeleteNotebookTool = createTool({
  id: 'knowledge_delete_notebook',
  description: 'Deletes a NotebookLM notebook (use to clean up temporary notebooks after research).',
  inputSchema: z.object({
    notebookId: z.string().describe('ID of the notebook to delete'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      await nlm.deleteNotebook(context.notebookId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// knowledge.research_start
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeResearchStartTool = createTool({
  id: 'knowledge_research_start',
  description: 'Starts deep research (Deep Research) in NotebookLM on a given topic or for a specific company.',
  inputSchema: z.object({
    query: z.string().describe('Research topic (e.g., "Deep research about Acme Farm products and history")'),
    notebookId: z.string().optional().describe('Optional ID of an existing notebook'),
    mode: z.enum(['fast', 'deep']).optional().default('deep').describe('Research mode (default: deep)'),
    autoImport: z.boolean().optional().default(true).describe('Whether to automatically import discovered sources into the notebook'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const result = await nlm.researchStart({
        query: context.query,
        notebookId: context.notebookId,
        mode: context.mode,
        autoImport: context.autoImport,
      });
      return { success: true, taskId: result.taskId, output: result.output };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export { knowledgeLookupTool } from './knowledge-lookup-tool.js';
