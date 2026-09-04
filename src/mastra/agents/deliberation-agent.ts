import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { Memory } from '@mastra/memory';
import { DELIBERATION_AGENT_MASTRA_AGENT_ID } from '../config/agent-ids.js';
import { resolveModelId, agentModels, infrastructure } from '../config/model-manifest.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { runDeliberationWorkerTool } from '../tools/deliberation/run-deliberation-worker.js';
import { validateDeliberationGateTool } from '../tools/deliberation/validate-deliberation-gate.js';
import { writeDebateArtifactTool } from '../tools/deliberation/write-debate-artifact.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { currentTimeTool } from '../tools/system/current-time.js';
import { knowledgeLookupTool } from '../tools/knowledge/knowledge-lookup-tool.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const deliberationAgent = new Agent({
  id: DELIBERATION_AGENT_MASTRA_AGENT_ID,
  name: 'Deliberation Agent (Design Council)',
  instructions: await combinePrompts('deliberation/base', 'deliberation/pipeline'),
  model: resolveModelId(agentModels.deliberationAgent),
  maxRetries: 3,
  defaultOptions: { maxSteps: 40, providerOptions: getThinkingProviderOptions('deep') },
  defaultGenerateOptionsLegacy: { maxSteps: 40, providerOptions: getThinkingProviderOptions('deep') },
  defaultStreamOptionsLegacy: { maxSteps: 40, providerOptions: getThinkingProviderOptions('deep') },
  defaultNetworkOptions: { maxSteps: 40 },
  memory: new Memory({
    options: {
      lastMessages: 20,
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread',
        temporalMarkers: true,
        observation: { 
          messageTokens: 50000,
          threadTitle: true,
          providerOptions: {
            google: {
              thinkingConfig: {
                thinkingBudget: 1024,
              },
            },
          },
        },
        reflection: {
          observationTokens: 60000,
        },
      },
      workingMemory: {
        enabled: true,
        template: `# Deliberation Agent Working Memory

## Active Debate
- **Current task:**
- **Debate depth:**
- **Workers selected:**
- **Phase:**

## Past Debate Patterns
- **Effective combinations:**
- **Known failure patterns:**
- **User preferences:**
`,
      },
      generateTitle: {
        model: resolveModelId('gemma4-e4b'),
        instructions:
          'Generate a concise thread title in the user language. Return only the title text, max 60 characters.',
      },
    },
  }),
  tools: {
    // Artifact Store (Etap 3) — exchange documents by ref, not by paste
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    runDeliberationWorkerTool,
    validateDeliberationGateTool,
    writeDebateArtifactTool,
    memoryRecallTool,
    memoryWriteTool,
    currentTimeTool,
    knowledgeLookupTool,
  },
});
