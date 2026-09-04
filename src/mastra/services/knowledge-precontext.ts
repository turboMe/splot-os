/**
 * NotebookLM-specific passive pre-context.
 *
 * Keep this compact: the system prompt defines the role, while this block
 * adds current procedural hints and relevant remembered tool contracts.
 */

import { recallKnowledge, type RecallResult } from '../lib/failure-brain.js';
import { tokenEstimate } from './harness-events.js';
import { getSkillRegistry, type SkillSearchResult } from './skill-registry.js';

export type KnowledgePrecontextInput = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  userPrompt: string;
  maxTokens?: number;
};

export type KnowledgePrecontextResult = {
  markdown: string;
  tokenEstimate: number;
  skillCount: number;
  memoryCount: number;
  suppressedReasons: string[];
};

const DEFAULT_MAX_TOKENS = 1400;

export async function buildKnowledgePrecontext(
  input: KnowledgePrecontextInput,
): Promise<KnowledgePrecontextResult> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const suppressedReasons: string[] = [];

  const [skills, memory] = await Promise.all([
    tryKnowledgeSkills(input.userPrompt, suppressedReasons),
    tryNotebookMemory(input.userPrompt, suppressedReasons),
  ]);

  const sections: string[] = [];

  sections.push('### NotebookLM Tool Use');
  sections.push([
    'Use exact runtime tool names only.',
    'For procedures: skill_search -> skill_load.',
    'For hidden NotebookLM MCP tools: search_tools -> load_tool, then call the loaded exact tool name.',
    'Never invent names with prefixes such as skill:, mcp_notebooklm_, or mcp__notebooklm-mcp__.',
  ].join('\n'));
  sections.push('');

  if (skills.length > 0) {
    sections.push('### Relevant Knowledge Skills');
    sections.push(skills.map(formatSkill).join('\n'));
    sections.push('');
  }

  if (memory.length > 0) {
    sections.push('### Relevant Operational Memory');
    sections.push(memory.map(formatMemory).join('\n'));
    sections.push('');
  }

  sections.push('Treat this block as orientation. Current tool results and explicit user instructions have priority.');

  const body = truncateToApproxTokens(sections.join('\n'), maxTokens);
  const markdown = [
    '## Knowledge Agent Passive Context',
    '',
    body,
  ].join('\n');

  return {
    markdown,
    tokenEstimate: tokenEstimate(markdown),
    skillCount: skills.length,
    memoryCount: memory.length,
    suppressedReasons,
  };
}

async function tryKnowledgeSkills(
  query: string,
  suppressedReasons: string[],
): Promise<SkillSearchResult[]> {
  try {
    const registry = getSkillRegistry();
    return await withTimeout(
      registry.search(query, { category: 'knowledge', topK: 4, minScore: 0.25 }),
      900,
      'knowledge_skill_search_timeout',
    );
  } catch (error) {
    suppressedReasons.push(`knowledge_skills_unavailable:${(error as Error).message}`);
    return [];
  }
}

async function tryNotebookMemory(
  query: string,
  suppressedReasons: string[],
): Promise<RecallResult[]> {
  try {
    return await withTimeout(
      recallKnowledge(`NotebookLM MCP ${query}`, { topK: 3, minScore: 0.35 }),
      900,
      'knowledge_memory_recall_timeout',
    );
  } catch (error) {
    suppressedReasons.push(`knowledge_memory_unavailable:${(error as Error).message}`);
    return [];
  }
}

function formatSkill(skill: SkillSearchResult): string {
  const tools = skill.metadata.allowedTools?.length
    ? ` tools=${skill.metadata.allowedTools.slice(0, 8).join(',')}`
    : '';
  return `- ${skill.metadata.name}: score=${skill.score.toFixed(2)}${tools} - ${truncateLine(skill.metadata.description, 180)}`;
}

function formatMemory(item: RecallResult): string {
  return `- ${item.title}: ${truncateLine(item.content, 220)}`;
}

function truncateToApproxTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * 4);
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function truncateLine(text: string | undefined, maxLen: number): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
