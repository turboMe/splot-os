import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureVideoProjectStructure, runVideoScript, VIDEO_REMOTION_DIR } from '../tools/video/video-runner.js';

const execFileAsync = promisify(execFile);

const productionInputSchema = z.object({
  projectFolder: z.string().describe('Project identifier, e.g. "ep-01" or "video-1"'),
  videoFilePath: z.string().optional().describe('Path to source raw talking-head MP4'),
  topicTitle: z.string().describe('Topic of the episode, e.g. "Budowa Autonomicznego Systemu Agentów SPLOT OS"'),
  pauseCompressionStyle: z.enum(['tight', 'natural', 'snappy']).default('tight'),
  primaryTitle: z.string().optional(),
});

// Step 1: Ingest & Local Whisper Transcription
const stepTranscribe = createStep({
  id: 'step-transcribe',
  description: 'Transcribes raw video using local Whisper Large v3 Turbo with word-level timestamps',
  inputSchema: productionInputSchema,
  outputSchema: z.object({
    projectFolder: z.string(),
    transcriptsCount: z.number(),
    topicTitle: z.string(),
    pauseCompressionStyle: z.enum(['tight', 'natural', 'snappy']),
    primaryTitle: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Missing input data');

    const { projectPath, workDir, audioDir, transcriptsDir } = await ensureVideoProjectStructure(
      inputData.projectFolder
    );

    if (inputData.videoFilePath) {
      const sourceVideo = path.resolve(inputData.videoFilePath);
      const clipBase = path.basename(sourceVideo, path.extname(sourceVideo));
      const targetWav = path.join(audioDir, `${clipBase}.wav`);

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

    const scriptOutput = await runVideoScript('transcribe.py', [inputData.projectFolder]);
    const transcriptFiles = (await fs.readdir(transcriptsDir)).filter((f) => f.endsWith('.json'));

    return {
      projectFolder: inputData.projectFolder,
      transcriptsCount: transcriptFiles.length,
      topicTitle: inputData.topicTitle,
      pauseCompressionStyle: inputData.pauseCompressionStyle,
      primaryTitle: inputData.primaryTitle,
    };
  },
});

// Step 2: Render Jump-Cuts & Audio Cleanup
const stepRenderCutsAndCleanAudio = createStep({
  id: 'step-render-cuts-and-clean',
  description: 'Renders cut video and applies RNNoise speech enhancement',
  inputSchema: z.object({
    projectFolder: z.string(),
    transcriptsCount: z.number(),
    topicTitle: z.string(),
    pauseCompressionStyle: z.enum(['tight', 'natural', 'snappy']),
    primaryTitle: z.string().optional(),
  }),
  outputSchema: z.object({
    projectFolder: z.string(),
    topicTitle: z.string(),
    primaryTitle: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Missing input data');

    // 1) Render cuts
    await runVideoScript('render_cuts.py', [
      inputData.projectFolder,
      '--style',
      inputData.pauseCompressionStyle || 'tight',
      '--mode',
      'preview',
    ]);

    // 2) Mix SFX
    await runVideoScript('mix_sfx.py', [inputData.projectFolder]).catch(() => ({ stdout: '', stderr: '', exitCode: 0 }));

    // 3) Mix Music Bed
    await runVideoScript('mix_music.py', [
      inputData.projectFolder,
      '--duck',
      '-16',
      '--level',
      '-22',
    ]).catch(() => ({ stdout: '', stderr: '', exitCode: 0 }));

    return {
      projectFolder: inputData.projectFolder,
      topicTitle: inputData.topicTitle,
      primaryTitle: inputData.primaryTitle,
    };
  },
});

// Step 3: Scaffold SPLOT OS Remotion Shots
const stepScaffoldRemotionShots = createStep({
  id: 'step-scaffold-remotion-shots',
  description: 'Scaffolds SPLOT OS TSX scenes (Terminal + Agent Graph + Architecture)',
  inputSchema: z.object({
    projectFolder: z.string(),
    topicTitle: z.string(),
    primaryTitle: z.string().optional(),
  }),
  outputSchema: z.object({
    projectFolder: z.string(),
    topicTitle: z.string(),
    primaryTitle: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Missing input data');

    const episodeShotsDir = path.join(VIDEO_REMOTION_DIR, 'src', 'shots', inputData.projectFolder);
    await fs.mkdir(episodeShotsDir, { recursive: true });

    const terminalCode = `import React from 'react';
import { SplotTerminalShot } from '../../lib/splot';

export const TerminalDemo: React.FC = () => {
  return (
    <SplotTerminalShot
      command="splot workflow run youtube-production --topic '${inputData.topicTitle}'"
      agentName="metaAgent"
      logs={[
        '→ Initializing SPLOT OS Video Engine',
        '✓ Local Whisper Large v3 Turbo transcription complete',
        '✓ Jump-cuts snapped to audio floor (RNNoise clean)',
        '✓ Remotion TSX scenes compiled in 4K60',
        '✓ Video Ready for Broadcast',
      ]}
    />
  );
};
`;
    await fs.writeFile(path.join(episodeShotsDir, 'TerminalDemo.tsx'), terminalCode, 'utf-8');

    // Update Remotion Shots Registry
    await execFileAsync('node', ['scripts/gen-registry.mjs'], {
      cwd: VIDEO_REMOTION_DIR,
    }).catch(() => null);

    return {
      projectFolder: inputData.projectFolder,
      topicTitle: inputData.topicTitle,
      primaryTitle: inputData.primaryTitle,
    };
  },
});

// Step 4: Packaging (SEO Metadata + Thumbnail)
const stepPackaging = createStep({
  id: 'step-packaging',
  description: 'Generates high-CTR metadata, timestamps and thumbnail',
  inputSchema: z.object({
    projectFolder: z.string(),
    topicTitle: z.string(),
    primaryTitle: z.string().optional(),
  }),
  outputSchema: z.object({
    projectFolder: z.string(),
    title: z.string(),
    status: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Missing input data');

    const title = inputData.primaryTitle || `${inputData.topicTitle} — Nowy System SPLOT OS`;
    const { packagingDir } = await ensureVideoProjectStructure(inputData.projectFolder);

    const description = `${inputData.topicTitle}\n\nRozdziały:\n00:00 Wprowadzenie i Problem\n00:45 Architektura Systemu SPLOT OS\n02:30 Pokaz Terminala i Delegacja Agentów\n05:20 Podsumowanie i Kod Źródłowy\n\n---\nSystem: SPLOT OS (Autonomous Local Agentic OS)\nKod & Materiały w opisie.`;

    const metadataPayload = {
      title,
      alternativeTitles: [
        `Jak Zbudować Własny System Agentów AI (SPLOT OS)?`,
        `Koniec Ręcznego Programowania? Architektura SPLOT OS`,
      ],
      description,
      tags: ['SPLOT OS', 'Agentic AI', 'Mastra', 'Remotion', 'TypeScript', 'Sztuczna Inteligencja'],
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(packagingDir, 'metadata.json'), JSON.stringify(metadataPayload, null, 2), 'utf-8');

    return {
      projectFolder: inputData.projectFolder,
      title,
      status: 'packaging_completed_ready_for_review',
    };
  },
});

export const youtubeVideoProductionWorkflow = createWorkflow({
  id: 'youtube-video-production-workflow',
  description:
    'End-to-End Autonomous YouTube Video Post-Production Workflow for SPLOT OS (Whisper STT -> Cuts -> TSX Code -> SFX/Lyria -> Packaging)',
  inputSchema: productionInputSchema,
  outputSchema: z.object({
    projectFolder: z.string(),
    title: z.string(),
    status: z.string(),
  }),
})
  .then(stepTranscribe)
  .then(stepRenderCutsAndCleanAudio)
  .then(stepScaffoldRemotionShots)
  .then(stepPackaging);

youtubeVideoProductionWorkflow.commit();
