import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { okResult, errorResult } from './video-types.js';
import { ensureVideoProjectStructure, YOUTUBE_PROJECTS_ROOT } from './video-runner.js';

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];
const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'];
const SCRIPT_EXTENSIONS = ['.md', '.txt', '.json'];
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.json', '.sql'];

export const videoIntakeScanTool = createTool({
  id: 'video_intake_scan',
  description:
    'Scans a project or input folder to discover all media, scripts, notes, images, and code snippets, classifying the video production mode (Talking Head, Faceless Explainer, or Hybrid).',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier or absolute path to folder containing raw assets'),
    languageHint: z.enum(['pl', 'en', 'auto']).default('auto').describe('Language hint (pl, en, or auto-detect)'),
    aspectRatio: z.enum(['16:9', '9:16', '1:1']).default('16:9').describe('Target video aspect ratio'),
  }),
  execute: async (context) => {
    try {
      const isAbs = path.isAbsolute(context.projectFolder);
      const targetDir = isAbs
        ? context.projectFolder
        : path.join(YOUTUBE_PROJECTS_ROOT, 'videos', context.projectFolder);

      if (!existsSync(targetDir)) {
        await fs.mkdir(targetDir, { recursive: true });
      }

      const { projectPath, workDir, audioDir, transcriptsDir, shotsDir, packagingDir } =
        await ensureVideoProjectStructure(path.basename(targetDir));

      // Scan directory recursively or flat
      const entries = await fs.readdir(targetDir, { withFileTypes: true });

      const videos: string[] = [];
      const audios: string[] = [];
      const images: string[] = [];
      const scripts: string[] = [];
      const codeFiles: string[] = [];

      let detectedScriptContent = '';

      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const fullPath = path.join(targetDir, entry.name);

          if (VIDEO_EXTENSIONS.includes(ext)) {
            videos.push(entry.name);
          } else if (AUDIO_EXTENSIONS.includes(ext)) {
            audios.push(entry.name);
          } else if (IMAGE_EXTENSIONS.includes(ext)) {
            images.push(entry.name);
          } else if (SCRIPT_EXTENSIONS.includes(ext)) {
            scripts.push(entry.name);
            if (['notes.md', 'script.md', 'brief.md', 'readme.md'].includes(entry.name.toLowerCase())) {
              detectedScriptContent = await fs.readFile(fullPath, 'utf-8');
            }
          } else if (CODE_EXTENSIONS.includes(ext)) {
            codeFiles.push(entry.name);
          }
        }
      }

      // Determine Production Strategy Mode
      let productionMode: 'talking_head_primary' | 'faceless_explainer' | 'hybrid_screencast' | 'asset_montage' =
        'faceless_explainer';

      if (videos.length > 0) {
        if (images.length > 0 || codeFiles.length > 0) {
          productionMode = 'hybrid_screencast';
        } else {
          productionMode = 'talking_head_primary';
        }
      } else if (audios.length > 0 && images.length > 0) {
        productionMode = 'faceless_explainer';
      } else if (images.length > 0) {
        productionMode = 'asset_montage';
      }

      // Detect language if auto
      let language: 'pl' | 'en' = 'pl';
      if (context.languageHint && context.languageHint !== 'auto') {
        language = context.languageHint;
      } else if (detectedScriptContent) {
        const lower = detectedScriptContent.toLowerCase();
        const plKeywords = ['jest', 'oraz', 'który', 'system', 'agentów', 'będziemy', 'tworzyć', 'wideo'];
        const enKeywords = ['the', 'this', 'video', 'system', 'agents', 'building', 'workflow', 'with'];
        let plScore = 0;
        let enScore = 0;
        for (const kw of plKeywords) if (lower.includes(kw)) plScore++;
        for (const kw of enKeywords) if (lower.includes(kw)) enScore++;
        language = plScore >= enScore ? 'pl' : 'en';
      }

      const inventory = {
        projectFolder: path.basename(targetDir),
        projectPath,
        productionMode,
        language,
        aspectRatio: context.aspectRatio,
        assets: {
          videos,
          audios,
          images,
          scripts,
          codeFiles,
        },
        hasBriefOrNotes: Boolean(detectedScriptContent),
        briefSnippet: detectedScriptContent ? detectedScriptContent.slice(0, 500) : undefined,
      };

      // Save intake metadata inside work directory
      await fs.writeFile(
        path.join(workDir, 'intake-inventory.json'),
        JSON.stringify(inventory, null, 2),
        'utf-8'
      );

      return okResult(inventory);
    } catch (err) {
      return errorResult(err);
    }
  },
});
