import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { imageModelProviderSchema, videoChapterSchema, okResult, errorResult } from './video-types.js';
import { runVideoScript, ensureVideoProjectStructure, VIDEO_MEDIA_DIR } from './video-runner.js';

export const videoPackageMetadataTool = createTool({
  id: 'video_package_metadata',
  description:
    'Formats and saves YouTube metadata packaging: titles with high CTR, description with automated chapters/timestamps, tags, and pinned comment.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier, e.g. "video-1"'),
    primaryTitle: z.string().describe('Selected high-CTR YouTube Title'),
    alternativeTitles: z.array(z.string()).default([]).describe('Alternative title variants for A/B testing'),
    descriptionBody: z.string().describe('Main video description and summary'),
    chapters: z.array(videoChapterSchema).describe('List of chapters with formatted timestamps (e.g. 00:00 Wstęp)'),
    tags: z.array(z.string()).describe('YouTube search tags / keywords'),
    pinnedComment: z.string().optional().describe('Text for the pinned comment on YouTube'),
  }),
  execute: async (context) => {
    try {
      const { packagingDir } = await ensureVideoProjectStructure(context.projectFolder);

      const formattedChapters = context.chapters
        .map((ch) => `${ch.formattedTimestamp} ${ch.title}`)
        .join('\n');

      const fullDescription = `${context.descriptionBody.trim()}\n\nRozdziały:\n${formattedChapters}\n\n---\nSystem: SPLOT OS (Autonomous Local Agentic OS)\nKod & Materiały w opisie.`;

      const metadataPayload = {
        title: context.primaryTitle,
        alternativeTitles: context.alternativeTitles,
        description: fullDescription,
        tags: context.tags,
        pinnedComment: context.pinnedComment || '',
        chapters: context.chapters,
        updatedAt: new Date().toISOString(),
      };

      const metaPath = path.join(packagingDir, 'metadata.json');
      await fs.writeFile(metaPath, JSON.stringify(metadataPayload, null, 2), 'utf-8');

      return okResult({
        projectFolder: context.projectFolder,
        metadataPath: metaPath,
        title: context.primaryTitle,
        formattedChaptersCount: context.chapters.length,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});

export const videoGenerateThumbnailTool = createTool({
  id: 'video_generate_thumbnail',
  description:
    'Generates a high-CTR YouTube thumbnail using OpenAI GPT Image / Google Imagen with face reference from SPLOT OS library and brand aesthetics.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier, e.g. "video-1"'),
    prompt: z.string().describe('Visual generation prompt describing subject, composition, background and lighting'),
    faceRefImage: z.string().optional().describe('Optional custom reference face image (defaults to media/library/faces/*)'),
    modelProvider: imageModelProviderSchema.default('auto').describe('Image generation model: "openai_dalle", "google_imagen", or "auto"'),
    variantName: z.string().default('thumbnail_A').describe('Thumbnail variant name (e.g. thumbnail_A, thumbnail_B)'),
  }),
  execute: async (context) => {
    try {
      const { packagingDir } = await ensureVideoProjectStructure(context.projectFolder);
      const thumbsDir = path.join(packagingDir, 'thumbs');
      await fs.mkdir(thumbsDir, { recursive: true });

      const outPng = path.join(thumbsDir, `${context.variantName}.png`);

      const args = ['--prompt', context.prompt, '--out', outPng, '--jpg'];

      if (context.faceRefImage) {
        args.push('--ref', context.faceRefImage);
      }

      const output = await runVideoScript('gen_thumbnail.py', args);

      const outJpg = path.join(thumbsDir, `${context.variantName}.jpg`);

      return okResult({
        projectFolder: context.projectFolder,
        variantName: context.variantName,
        thumbnailPngPath: outPng,
        thumbnailJpgPath: outJpg,
        logs: output.stdout,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});
