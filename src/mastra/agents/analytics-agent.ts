import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { agentModels, resolveModelId } from '../config/model-manifest.js';
import { Memory } from '@mastra/memory';
import { listContextTool } from '../tools/memory/add-context.js';
import {
  n8nHealthTool,
  n8nListWorkflowsTool,
  n8nGetWorkflowTool,
} from '../tools/n8n/n8n-tools.js';
import { agentPerformanceReportTool } from '../tools/system/agent-performance-report.js';
import {
  analyticsCollectRoiTool,
  analyticsCollectTrendsTool,
  analyticsCollectWeeklyTool,
} from '../tools/analytics/analytics-tools.js';
import { knowledgeLookupTool } from '../tools/knowledge/knowledge-tools.js';
import { crmGetStatsTool } from '../tools/crm/crm-stats.js';
import { combinePrompts } from '../lib/prompt-loader.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const analyticsAgent = new Agent({
  id: 'analytics-agent',
  name: 'Analytics Agent',
  instructions: await combinePrompts('analytics/base', 'analytics/pipeline'),
  model: resolveModelId(agentModels.analyticsAgent),

  // EIGHT tools against Mastra's undeclared default of five steps: this agent
  // could not call its own collectors and still answer. An analysis run reads
  // several sources (weekly, ROI, trends, workflow health) and then synthesises
  // them, so five was not a budget, it was a truncation nobody chose.
  //
  // 25 rather than the deepest profile's 40: measured usage across canaried
  // agents was 3-7 steps, so this is headroom over the real shape of the work,
  // not an invitation to wander. Under the harness a `deep` classification still
  // gives 40 — the rule is that the harness may RAISE a ceiling to what the agent
  // declares, never lower it below.
  defaultOptions: { maxSteps: 25, providerOptions: getThinkingProviderOptions('light') },
  defaultGenerateOptionsLegacy: { maxSteps: 25, providerOptions: getThinkingProviderOptions('light') },
  defaultStreamOptionsLegacy: { maxSteps: 25, providerOptions: getThinkingProviderOptions('light') },
  defaultNetworkOptions: { maxSteps: 25 },

  memory: new Memory({
    options: {
      lastMessages: 10,
    },
  }),
  tools: {
    // Delegation & worker tools
    runWorkerTool,
    runWorkerBatchTool,
    delegateTaskTool,
    // Artifact tools
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    // n8n monitoring
    n8nHealthTool,
    n8nListWorkflowsTool,
    n8nGetWorkflowTool,
    // Shared memory is read-only in Analytics V2. Persistence/signal emission
    // needs a separate idempotent side-effect contract.
    listContextTool,
    // Deterministic domain snapshots
    analyticsCollectWeeklyTool,
    analyticsCollectRoiTool,
    analyticsCollectTrendsTool,
    // CRM aggregation and pipeline metrics
    crmGetStatsTool,
    // Agent performance report (Faza 7.6)
    agentPerformanceReportTool,
    // Knowledge lookup for business baselines and KPI targets
    knowledgeLookupTool,
  },
});
