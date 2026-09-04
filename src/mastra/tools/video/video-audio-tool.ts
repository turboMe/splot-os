import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import path from 'node:path';
import { audioCleanMethodSchema, okResult, errorResult } from './video-types.js';
import { runVideoScript, VIDEO_ENGINE_ROOT } from './video-runner.js';

export const videoCleanAudioTool = createTool({
  id: 'video_clean_audio',
  description:
    'Cleans voice audio track on video/audio using local RNNoise (offline & free) or ElevenLabs voice isolator, preserving loudness and 4K60 video stream.',
  inputSchema: z.object({
    inputVideoOrAudio: z.string().describe('Path to source MP4/WAV file'),
    outputFilePath: z.string().optional().describe('Optional output file path'),
    method: audioCleanMethodSchema.default('rnnoise').describe('Cleanup method: "rnnoise" (local offline) or "eleven"'),
    model: z.string().default('sh').describe('RNNoise model profile: "sh" (speech standard) or "cb" (clear background)'),
    preserveLoudness: z.boolean().default(true).describe('Preserve original RMS voice levels'),
  }),
  execute: async (context) => {
    try {
      const method = context.method || 'rnnoise';

      const args: string[] = [context.inputVideoOrAudio, '--method', method];
      if (method === 'rnnoise') {
        args.push('--model', context.model || 'sh');
      }
      if (context.outputFilePath) {
        args.push('-o', context.outputFilePath);
      }
      if (!context.preserveLoudness) {
        args.push('--no-preserve-loudness');
      }

      const output = await runVideoScript('clean_voice.py', args);


      return okResult({
        input: context.inputVideoOrAudio,
        method: context.method,
        model: context.model,
        outputFilePath: context.outputFilePath || 'Default output generated next to source',
        logs: output.stdout,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});

export const videoMixAudioTool = createTool({
  id: 'video_mix_audio',
  description:
    'Mixes sound effects (SFX) and background music stems with automated ducking (-16dB under voice) for broadcast-quality audio.',
  inputSchema: z.object({
    projectFolder: z.string().describe('Project identifier, e.g. "video-1"'),
    duckingDb: z.number().default(-16).describe('Ducking level in dB for background music during speech'),
    musicVolumeDb: z.number().default(-22).describe('Target background music baseline level'),
  }),
  execute: async (context) => {
    try {
      // 1) Mix SFX cues
      const sfxOutput = await runVideoScript('mix_sfx.py', [context.projectFolder]);

      // 2) Mix Music bed with ducking
      const musicOutput = await runVideoScript('mix_music.py', [
        context.projectFolder,
        '--duck',
        String(context.duckingDb),
        '--level',
        String(context.musicVolumeDb),
      ]);

      return okResult({
        projectFolder: context.projectFolder,
        sfxResult: sfxOutput.stdout,
        musicResult: musicOutput.stdout,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});
