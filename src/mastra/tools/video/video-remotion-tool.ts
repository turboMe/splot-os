import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { okResult, errorResult } from './video-types.js';
import { VIDEO_REMOTION_DIR } from './video-runner.js';

const execFileAsync = promisify(execFile);

export const videoScaffoldShotTool = createTool({
  id: 'video_scaffold_shot',
  description:
    'Scaffolds a new Remotion TSX shot component for a video episode using SPLOT OS brand template and motion system.',
  inputSchema: z.object({
    episodeId: z.string().describe('Episode or video identifier, e.g. "ep-01" or "video-1"'),
    shotName: z.string().describe('Name of the shot component, e.g. "ArchOverview" or "TerminalRun"'),
    shotType: z
      .enum(['splot_terminal', 'agent_graph', 'code_editor', 'full_statement', 'custom'])
      .default('splot_terminal')
      .describe('Type of visual shot template'),
    durationInFrames: z.number().default(300).describe('Shot duration in frames @ 60fps (300 frames = 5s)'),
    codeSnippetOrLogs: z.string().optional().describe('Code snippet or terminal logs to display in animation'),
  }),
  execute: async (context) => {
    try {
      const episodeShotsDir = path.join(VIDEO_REMOTION_DIR, 'src', 'shots', context.episodeId);
      await fs.mkdir(episodeShotsDir, { recursive: true });

      const shotFileName = `${context.shotName}.tsx`;
      const targetFilePath = path.join(episodeShotsDir, shotFileName);

      let shotCode = '';
      if (context.shotType === 'splot_terminal') {
        shotCode = `import React from 'react';
import { Composition } from 'remotion';
import { SplotTerminalShot } from '../../lib/splot';

export const ${context.shotName}: React.FC = () => {
  return (
    <SplotTerminalShot
      command="${context.codeSnippetOrLogs || 'splot workflow run youtube-production'}"
      agentName="metaAgent"
      logs={[
        '→ Intent recognized: AI System Deployment',
        '✓ Delegated to codingMasterAgent',
        '✓ Building TSX scenes and AST verification',
        '✓ Production Ready',
      ]}
    />
  );
};
`;
      } else if (context.shotType === 'agent_graph') {
        shotCode = `import React from 'react';
import { SplotAgentGraphShot } from '../../lib/splot';

export const ${context.shotName}: React.FC = () => {
  return (
    <SplotAgentGraphShot
      title="SPLOT OS Agent Hierarchy"
    />
  );
};
`;
      } else {
        shotCode = `import React from 'react';
import { AbsoluteFill } from 'remotion';
import { SplotBackdrop } from '../../lib/splot';
import { COLORS } from '../../brand';
import { FONT_DISPLAY } from '../../fonts';

export const ${context.shotName}: React.FC = () => {
  return (
    <AbsoluteFill style={{ fontFamily: FONT_DISPLAY }}>
      <SplotBackdrop glowColor={COLORS.accent} />
      <div style={{ position: 'absolute', top: '45%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
        <h1 style={{ color: COLORS.d300, fontSize: 64, fontWeight: 700 }}>
          SPLOT <span style={{ color: COLORS.accent }}>OS</span>
        </h1>
        <p style={{ color: COLORS.d400, fontSize: 28, marginTop: 16 }}>
          ${context.codeSnippetOrLogs || 'Autonomous Agentic Architecture'}
        </p>
      </div>
    </AbsoluteFill>
  );
};
`;
      }

      await fs.writeFile(targetFilePath, shotCode, 'utf-8');

      return okResult({
        episodeId: context.episodeId,
        shotName: context.shotName,
        shotType: context.shotType,
        targetFilePath,
        durationInFrames: context.durationInFrames,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
});

export const videoRenderRemotionTool = createTool({
  id: 'video_render_remotion',
  description:
    'Renders Remotion shots to video/frames or generates the shots registry in Remotion Studio.',
  inputSchema: z.object({
    action: z.enum(['gen_registry', 'render_shot', 'preview_server']).default('gen_registry'),
    compositionId: z.string().optional().describe('Composition ID to render if action is render_shot'),
    outPath: z.string().optional().describe('Output file path for rendered video'),
  }),
  execute: async (context) => {
    try {
      if (context.action === 'gen_registry') {
        const { stdout } = await execFileAsync('node', ['scripts/gen-registry.mjs'], {
          cwd: VIDEO_REMOTION_DIR,
        });
        return okResult({ action: 'gen_registry', logs: stdout });
      }

      if (context.action === 'render_shot' && context.compositionId) {
        const out = context.outPath || `out/${context.compositionId}.mp4`;
        const { stdout } = await execFileAsync('npx', ['remotion', 'render', context.compositionId, out], {
          cwd: VIDEO_REMOTION_DIR,
        });
        return okResult({ action: 'render_shot', compositionId: context.compositionId, outPath: out, logs: stdout });
      }

      return okResult({ message: 'Remotion action completed' });
    } catch (err) {
      return errorResult(err);
    }
  },
});
