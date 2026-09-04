/**
 * Knowledge Lookup Tool — Fast, deterministic retrieval from src/mastra/knowledge/.
 *
 * Reads structured master facts, identity rules, business overviews, and domain slices
 * (personal/ or business/) with optional markdown section filtering and in-memory caching.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Robust resolution of the Knowledge Base root directory.
 * Handles running from:
 * - workspace root (/projekty/mastra-agentic-environment)
 * - app root (/projekty/mastra-agentic-environment/agentic-agents)
 * - compiled/bundled runtime (.mastra/output)
 * - custom KNOWLEDGE_ROOT environment variable
 */
function resolveKnowledgeRoot(): string {
  if (process.env.KNOWLEDGE_ROOT && existsSync(process.env.KNOWLEDGE_ROOT)) {
    return path.resolve(process.env.KNOWLEDGE_ROOT);
  }

  const candidates = [
    path.resolve(__dirname, '../../knowledge'),                        // source: src/mastra/tools/knowledge -> src/mastra/knowledge
    path.resolve(__dirname, '../../../src/mastra/knowledge'),           // bundle: .mastra/output/... -> src/mastra/knowledge
    path.resolve(process.cwd(), 'agentic-agents/src/mastra/knowledge'),  // CWD = /projekty/mastra-agentic-environment
    path.resolve(process.cwd(), 'src/mastra/knowledge'),                 // CWD = /projekty/mastra-agentic-environment/agentic-agents
    path.resolve(process.cwd(), 'knowledge'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

const KNOWLEDGE_ROOT = resolveKnowledgeRoot();

interface CachedFile {
  mtimeMs: number;
  content: string;
  headings: string[];
}

const fileCache = new Map<string, CachedFile>();

/**
 * Extracts all markdown headings (# Heading, ## Subheading) from text.
 */
function extractHeadings(content: string): string[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const headings: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null) {
    headings.push(match[0].trim());
  }
  return headings;
}

/**
 * Extracts a specific section from markdown content based on header title.
 */
function extractSection(content: string, targetSection: string): { sectionContent: string; matchedHeading?: string } | null {
  const normalizedTarget = targetSection.replace(/^#+\s*/, '').trim().toLowerCase();
  const lines = content.split('\n');
  
  let startIdx = -1;
  let startLevel = 0;
  let matchedHeading = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim().toLowerCase();
      
      if (startIdx === -1) {
        if (title.includes(normalizedTarget) || line.toLowerCase().includes(normalizedTarget)) {
          startIdx = i;
          startLevel = level;
          matchedHeading = headingMatch[0];
        }
      } else {
        // Stop when we encounter a heading of equal or higher level (fewer or equal #)
        if (level <= startLevel) {
          return {
            sectionContent: lines.slice(startIdx, i).join('\n').trim(),
            matchedHeading,
          };
        }
      }
    }
  }

  if (startIdx !== -1) {
    return {
      sectionContent: lines.slice(startIdx).join('\n').trim(),
      matchedHeading,
    };
  }

  return null;
}

/**
 * Helper to recursively list files in a directory for fallback suggestions.
 */
async function listRelativeFiles(dirPath: string, baseRel = ''): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const rel = baseRel ? `${baseRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        if (baseRel.split('/').length < 2) {
          const subResults = await listRelativeFiles(path.join(dirPath, entry.name), rel);
          results.push(...subResults);
        }
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

export const knowledgeLookupTool = createTool({
  id: 'knowledge_lookup',
  description:
    'Fast deterministic lookup in the central knowledge base (src/mastra/knowledge/). ' +
    'Use this tool BEFORE making claims about candidate identity, skills, experience, ' +
    'GastroBridge, FlowMint, or consulting to guarantee factual accuracy and prevent hallucinations. ' +
    'Supports relative paths (e.g. "INDEX.md", "personal/identity/core-anchor.yaml", ' +
    '"personal/identity/grounding-it-ai.md", "business/gastrobridge/product-overview.md") ' +
    'and optional section extraction.',
  inputSchema: z.object({
    path: z.string().default('INDEX.md').describe(
      'Relative path inside src/mastra/knowledge/, e.g. "INDEX.md", "personal/INDEX.md", ' +
      '"personal/identity/core-anchor.yaml", "personal/identity/grounding-it-ai.md", ' +
      '"personal/identity/grounding-hospitality.md", "business/gastrobridge/product-overview.md"'
    ),
    section: z.string().optional().describe(
      'Optional markdown heading or keyword to extract only a specific section ' +
      '(e.g. "Tożsamość i Kontakt", "Umiejętności Techniczne", "Doświadczenie i Oś Czasu")'
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    content: z.string(),
    matchedHeading: z.string().optional(),
    availableSections: z.array(z.string()).optional(),
    availableFiles: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
  execute: async ({ path: reqPath, section }) => {
    try {
      const cleanPath = (reqPath || 'INDEX.md').trim().replace(/^\/+/, '');
      const targetPath = path.resolve(KNOWLEDGE_ROOT, cleanPath);

      // Security check: Path containment
      if (!targetPath.startsWith(KNOWLEDGE_ROOT)) {
        return {
          success: false,
          path: cleanPath,
          content: '',
          error: 'Access denied: path traversal outside knowledge base is prohibited.',
        };
      }

      let stat;
      try {
        stat = await fs.stat(targetPath);
      } catch {
        const availableFiles = await listRelativeFiles(KNOWLEDGE_ROOT);
        return {
          success: false,
          path: cleanPath,
          content: '',
          availableFiles: availableFiles.slice(0, 30),
          error: `Knowledge file "${cleanPath}" not found. See availableFiles for valid paths.`,
        };
      }

      // If it's a directory, return directory index / listing
      if (stat.isDirectory()) {
        const filesInDir = await listRelativeFiles(targetPath, cleanPath);
        // Check if there is an INDEX.md in this directory
        const indexPath = path.join(targetPath, 'INDEX.md');
        try {
          const indexStat = await fs.stat(indexPath);
          if (indexStat.isFile()) {
            const indexContent = await fs.readFile(indexPath, 'utf-8');
            return {
              success: true,
              path: path.join(cleanPath, 'INDEX.md'),
              content: indexContent,
              availableFiles: filesInDir,
            };
          }
        } catch {
          // No INDEX.md in dir, return directory listing
        }

        return {
          success: true,
          path: cleanPath,
          content: `Directory listing for ${cleanPath}:\n` + filesInDir.map((f) => `- ${f}`).join('\n'),
          availableFiles: filesInDir,
        };
      }

      // Read file with caching
      let cached = fileCache.get(targetPath);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        const rawContent = await fs.readFile(targetPath, 'utf-8');
        const headings = extractHeadings(rawContent);
        cached = {
          mtimeMs: stat.mtimeMs,
          content: rawContent,
          headings,
        };
        fileCache.set(targetPath, cached);
      }

      // If specific section was requested
      if (section && section.trim()) {
        const sectionResult = extractSection(cached.content, section);
        if (sectionResult) {
          return {
            success: true,
            path: cleanPath,
            content: sectionResult.sectionContent,
            matchedHeading: sectionResult.matchedHeading,
            availableSections: cached.headings,
          };
        } else {
          return {
            success: true,
            path: cleanPath,
            content: cached.content,
            availableSections: cached.headings,
            error: `Section "${section}" was not found. Returned full file content. See availableSections.`,
          };
        }
      }

      return {
        success: true,
        path: cleanPath,
        content: cached.content,
        availableSections: cached.headings,
      };
    } catch (err) {
      return {
        success: false,
        path: reqPath || 'INDEX.md',
        content: '',
        error: (err as Error).message,
      };
    }
  },
});
