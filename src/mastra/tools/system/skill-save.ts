/**
 * System tool: Save and hot-reload an autonomous skill procedure.
 *
 * Zapisuje procedurę SOP w katalogu src/mastra/_skills/auto/<skillId>.md,
 * formatuje nagłówek YAML frontmatter i natychmiast rejestruje skill
 * w działającym rejestrze SkillRegistry (hot-reload, bez restartu serwera).
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { getSkillRegistry } from '../../services/skill-registry.js';
import { stringifyFrontmatter } from '../../lib/yaml-frontmatter.js';

export const skillSaveInputSchema = z.object({
  skillId: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe('Identyfikator skilla (slug, np. rodo-poland-compliance)'),
  name: z.string().min(3).describe('Czytelna nazwa procedury operacyjnej SOP'),
  description: z.string().min(10).describe('Kiedy i w jakich warunkach uruchamiać ten skill'),
  category: z.string().default('auto').describe('Kategoria skilla (domyślnie auto)'),
  keywords: z.array(z.string()).optional().default([]).describe('Słowa kluczowe do wyszukiwania semantycznego'),
  allowedTools: z.array(z.string()).optional().describe('Dozwolone narzędzia dla tego skilla'),
  recommendedTier: z.enum(['fast', 'balanced', 'pro', 'private']).default('pro').describe('Rekomendowany tier modelu'),
  preferLocal: z.boolean().default(false).describe('Czy preferować lokalny model Ollama'),
  knowledgeNotebookTitle: z.string().optional().describe('Tytuł powiązanego notatnika w NotebookLM (dla chmury)'),
  knowledgeNotebookId: z.string().optional().describe('ID powiązanego notatnika w NotebookLM'),
  localKnowledgePath: z.string().optional().describe('Ścieżka do lokalnego katalogu wiedzy prywatnej'),
  privacyClassification: z
    .enum(['public', 'internal_business', 'confidential_strict'])
    .default('public')
    .describe('Klasyfikacja poufności danych'),
  procedure: z.string().min(30).describe('Treść procedury w Markdown (kroki, algorytm, drzewo decyzyjne)'),
});

export const skillSaveTool = createTool({
  id: 'skillSaveTool',
  description:
    'Zapisuje nową procedurę operacyjną SOP do src/mastra/_skills/auto/<skillId>.md i natychmiast ją aktywuje (hot-reload).',
  inputSchema: skillSaveInputSchema,
  execute: async (context) => {
    try {
      const {
        skillId,
        name,
        description,
        category,
        keywords,
        allowedTools,
        recommendedTier,
        preferLocal,
        knowledgeNotebookTitle,
        knowledgeNotebookId,
        localKnowledgePath,
        privacyClassification,
        procedure,
      } = context;

      const targetDir = join(process.cwd(), 'src/mastra/_skills/auto');
      await mkdir(targetDir, { recursive: true });

      const filePath = join(targetDir, `${skillId}.md`);

      const metadata: Record<string, any> = {
        name,
        description,
        category,
        keywords: keywords || [],
        recommendedTier,
        preferLocal,
        privacyClassification,
        created_at: new Date().toISOString(),
      };

      if (allowedTools && allowedTools.length > 0) {
        metadata.allowedTools = allowedTools;
      }
      if (knowledgeNotebookTitle) {
        metadata.knowledgeNotebookTitle = knowledgeNotebookTitle;
      }
      if (knowledgeNotebookId) {
        metadata.knowledgeNotebookId = knowledgeNotebookId;
      }
      if (localKnowledgePath) {
        metadata.localKnowledgePath = localKnowledgePath;
      }

      const fileContent = stringifyFrontmatter(metadata, procedure.trim());
      await writeFile(filePath, fileContent, 'utf-8');

      // Natychmiastowy hot-reload w rejestrze
      const registry = getSkillRegistry();
      const loadedSkill = await registry.registerSingleSkillFile(filePath);

      return {
        success: true,
        skillId,
        filePath,
        hotReloaded: !!loadedSkill,
        message: `Skill ${name} [${skillId}] zapisany pomyślnie w ${filePath} i zarejestrowany w pamięci.`,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
      };
    }
  },
});
