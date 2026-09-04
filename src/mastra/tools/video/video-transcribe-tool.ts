import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { videoEngineModeSchema, okResult, errorResult } from './video-types.js';
import { ensureVideoProjectStructure, runVideoScript } from './video-runner.js';

const execFileAsync = promisify(execFile);

export const videoTranscribeTool = createTool({
  id: 'video_transcribe',
  description:
    'Extracts audio from video clip(s) and performs word-level verbatim transcription using local Whisper (or cloud fallback). Saves transcript JSON with precise timestamps.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier or relative folder name, e.g. "video-1" or "ep-01"'),
    videoFilePath: z.string().optional().describe('Optional path to raw video file if initializing a new project'),
    engine: videoEngineModeSchema.default('local_whisper').describe('STT engine to use (default: local_whisper)'),
    force: z.boolean().default(false).describe('Force re-transcription even if output JSON exists'),
  }),
  execute: async (context) => {
    try {
      const { projectPath, workDir, audioDir, transcriptsDir } = await ensureVideoProjectStructure(
        context.projectFolder
      );

      // If videoFilePath provided, copy or extract audio into work/audio/
      if (context.videoFilePath) {
        const sourceVideo = path.resolve(context.videoFilePath);
        const clipBase = path.basename(sourceVideo, path.extname(sourceVideo));
        const targetWav = path.join(audioDir, `${clipBase}.wav`);

        // Extract 44.1kHz 16-bit mono wav
        await execFileAsync('ffmpeg', [
          '-y',
          '-hide_banner',
          '-i',
          sourceVideo,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '44100',
          '-c:a',
          'pcm_s16le',
          targetWav,
        ]);
      }

      // Check WAV files in audioDir
      const audioFiles = (await fs.readdir(audioDir)).filter((f) => f.endsWith('.wav'));
      if (audioFiles.length === 0) {
        return errorResult(
          new Error(`No audio WAV files found in ${audioDir}. Provide videoFilePath or place clips in work/audio/`)
        );
      }

      const args = [context.projectFolder];
      if (context.force) args.push('--force');

      // Execute transcription
      const scriptOutput = await runVideoScript('transcribe.py', args);

      // Read resulting transcript files
      const transcriptFiles = (await fs.readdir(transcriptsDir)).filter((f) => f.endsWith('.json'));
      const transcriptsSummary = [];

      for (const tFile of transcriptFiles) {
        const fullPath = path.join(transcriptsDir, tFile);
        const content = JSON.parse(await fs.readFile(fullPath, 'utf-8'));
        const words = content.words || [];
        transcriptsSummary.push({
          clip: path.basename(tFile, '.json'),
          wordCount: words.length,
          durationSec: content.audio_duration || (words.length > 0 ? words[words.length - 1].end / 1000 : 0),
          transcriptPath: fullPath,
        });
      }

      return okResult({
        projectFolder: context.projectFolder,
        projectPath,
        transcripts: transcriptsSummary,
        engineUsed: context.engine,
        rawLogs: scriptOutput.stdout,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});
