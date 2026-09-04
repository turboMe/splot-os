/**
 * Tool: architect.skills_search
 * Searches the _skills/ knowledge base (.md files) and returns
 * matching sections as context for the agent.
 * Replaces Jarvis RAG from packages/notebooklm — here it runs on local files.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

// Tool files are bundled into .mastra/output/tools, so import.meta-relative
// resolution points at the build directory. Keep this tied to the source repo.
const SKILLS_ROOT = process.env.MASTRA_SKILLS_DIR
  ? resolve(process.env.MASTRA_SKILLS_DIR)
  : resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', '_skills');

interface SkillFile {
  path: string;
  category: string;
  name: string;
  content: string;
  keywords: string[];
  description: string;
}

function parseSkillFile(filePath: string, category: string): SkillFile {
  const raw = readFileSync(filePath, 'utf-8');

  // Parse frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/m);
  let keywords: string[] = [];
  let description = '';
  let name = '';
  let content = raw;

  if (fmMatch) {
    const fm = fmMatch[1];
    content = fmMatch[2].trim();

    const kwMatch = fm.match(/keywords:\s*\[(.*?)\]/s);
    if (kwMatch) {
      keywords = kwMatch[1]
        .split(',')
        .map((k) => k.trim().replace(/['"]/g, '').toLowerCase())
        .filter(Boolean);
    }
    const descMatch = fm.match(/description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();
    const nameMatch = fm.match(/name:\s*(.+)/);
    if (nameMatch) name = nameMatch[1].trim();
  }

  return { path: filePath, category, name, content, keywords, description };
}

function loadAllSkills(): SkillFile[] {
  const skills: SkillFile[] = [];

  try {
    const categories = readdirSync(SKILLS_ROOT).filter((d) => {
      try {
        return statSync(join(SKILLS_ROOT, d)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const cat of categories) {
      const catDir = join(SKILLS_ROOT, cat);
      const files = readdirSync(catDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        try {
          skills.push(parseSkillFile(join(catDir, file), cat));
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // skills directory not found — return empty
  }

  return skills;
}

function scoreSkill(skill: SkillFile, queryTerms: string[]): number {
  let score = 0;
  const queryLower = queryTerms.map((t) => t.toLowerCase());

  for (const term of queryLower) {
    // Keyword match (exact) — highest weight
    if (skill.keywords.some((k) => k.includes(term) || term.includes(k))) score += 10;
    // Name match
    if (skill.name.toLowerCase().includes(term)) score += 6;
    // Description match
    if (skill.description.toLowerCase().includes(term)) score += 4;
    // Category match
    if (skill.category.toLowerCase().includes(term)) score += 3;
    // Content full-text match (lower weight, normalize by occurrences)
    const occurrences = (skill.content.toLowerCase().match(new RegExp(term, 'g')) ?? []).length;
    score += Math.min(occurrences, 5) * 1;
  }

  return score;
}

function extractRelevantSections(content: string, queryTerms: string[], maxChars: number): string {
  const lines = content.split('\n');
  const queryLower = queryTerms.map((t) => t.toLowerCase());

  // Find sections (## headings) that contain query terms
  const sections: { header: string; body: string[] }[] = [];
  let currentHeader = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('# ')) {
      if (currentHeader || currentBody.length > 0) {
        sections.push({ header: currentHeader, body: currentBody });
      }
      currentHeader = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeader || currentBody.length > 0) {
    sections.push({ header: currentHeader, body: currentBody });
  }

  // Score sections
  const scored = sections.map((sec) => {
    const text = `${sec.header} ${sec.body.join(' ')}`.toLowerCase();
    const score = queryLower.reduce(
      (acc, term) => acc + (text.includes(term) ? (text.match(new RegExp(term, 'g')) ?? []).length : 0),
      0,
    );
    return { ...sec, score };
  });

  // Sort by relevance, take top sections up to maxChars
  const sorted = scored.sort((a, b) => b.score - a.score);
  let result = '';
  for (const sec of sorted) {
    if (sec.score === 0 && result.length > 0) break;
    const chunk = `${sec.header}\n${sec.body.join('\n')}\n`;
    if (result.length + chunk.length > maxChars) break;
    result += chunk;
  }

  return result || content.slice(0, maxChars);
}

// ── Tool definition ────────────────────────────────────────────────────────
export const skillsSearchTool = createTool({
  id: 'architect_skills_search',
  description: 'Searches the _skills/ knowledge base (n8n patterns, security rules, workflow rules, terminal guides) and returns matching sections as context. Use before designing workflows to find the right pattern or security rules.',
  inputSchema: z.object({
    query: z.string().describe('Natural language query or list of keywords, e.g., "webhook authentication", "error handling pattern", "risk scoring"'),
    category: z.enum(['n8n', 'terminal', 'all']).default('all').describe('Category to search'),
    maxResults: z.number().default(3).describe('Maximum number of matching files (1-5)'),
    maxCharsPerFile: z.number().default(2000).describe('Maximum number of characters returned from each file'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      skillName: z.string(),
      category: z.string(),
      description: z.string(),
      relevantContent: z.string(),
      score: z.number(),
    })),
    totalFound: z.number(),
    query: z.string(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_skills_search',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      target: input.query,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    const allSkills = loadAllSkills();

    // Filter by category
    const pool =
      context.category === 'all'
        ? allSkills
        : allSkills.filter((s) => s.category === context.category);

    if (pool.length === 0) {
      return { results: [], totalFound: 0, query: context.query };
    }

    // Tokenize query
    const queryTerms = context.query
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter((t: string) => t.length > 2);

    // Score and sort
    const scored = pool
      .map((skill) => ({ skill, score: scoreSkill(skill, queryTerms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(context.maxResults ?? 3, 5));

    const results = scored.map(({ skill, score }) => ({
      skillName: skill.name || skill.path.split('/').pop()?.replace('.md', '') || '',
      category: skill.category,
      description: skill.description,
      relevantContent: extractRelevantSections(skill.content, queryTerms, context.maxCharsPerFile ?? 2000),
      score,
    }));

    return { results, totalFound: scored.length, query: context.query };
    }
  }),
});
