// MUST be first: load .env into process.env before any other module runs.
// `mastra dev` injects the environment for us, but the production bundle is
// started with a bare `node .mastra/output/index.mjs` (autoheal's
// start-candidate.sh), which does NOT. Without this, the gateway-registration
// guards below (`if (process.env.DEEPSEEK_API_KEY)`) see nothing and every
// custom gateway is silently skipped — the model then fails at first use with
// "Could not find config for provider custom-deepseek", which is exactly what
// stalled the self-heal cycle in slot-based (production) mode.
import dotenv from 'dotenv';
dotenv.config();

import { ensureWorkspaceDirs } from './config/workspace-paths.js';
await ensureWorkspaceDirs().catch((err) => console.warn('[index.ts] ensureWorkspaceDirs warning:', err));

import { Mastra } from '@mastra/core/mastra';
import { defaultGateways } from '@mastra/core/llm';
import { OllamaGateway } from './lib/ollama-gateway';
import { OpenRouterGateway } from './lib/openrouter-gateway';
import { DeepSeekGateway } from './lib/deepseek-gateway';
import { GroqGateway } from './lib/groq-gateway';
import { ZenMuxGateway } from './lib/zenmux-gateway';


import { PinoLogger } from '@mastra/loggers';
import { MongoDBStore } from '@mastra/mongodb';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { MastraEditor } from '@mastra/editor';
import { MongoTelemetryExporter } from './services/mongo-telemetry-exporter.js';
import {
  getObservabilityRetentionDays,
  ObservabilityRetentionService,
  resolveObservabilityDuckDBPath,
} from './services/observability-retention.js';
import { SpanPayloadTruncator } from './services/span-payload-truncator.js';
import { createObservabilityRetentionRoute } from './services/observability-retention-route.js';
import { createAlexLiveRoutes, isAlexLiveEnabled } from './services/alex-live.js';
import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { resolve } from 'path';
import { AGENTIC_AGENTS_REPO } from './workspaces/code-workspace.js';

// Self-healing (Etap 7)
import { initGlobalErrorHandlers } from './services/global-error-handler.js';
import { getErrorCollector } from './services/error-collector.js';

// GPU Guard (Etap 8 — VRAM protection)
import { initGpuGuard, getGpuGuard } from './services/gpu-guard.js';

// Model Availability (Etap 8.1 — verify models at startup)
import { initModelAvailability } from './services/model-availability.js';



// Workflows
import { weatherWorkflow } from './workflows/weather-workflow';
import { weeklyContentWorkflow } from './workflows/weekly-content';
import { producerHuntWorkflow } from './workflows/producer-hunt';
import { morningBriefingWorkflow } from './workflows/marketing/morning-briefing';
import { automatedFollowupWorkflow } from './workflows/marketing/automated-followup';
import { inboxMonitorWorkflow } from './workflows/marketing/inbox-monitor';
import { syncCrmWorkflow } from './workflows/marketing/sync-crm';
import { weeklyReportWorkflow } from './workflows/analytics/weekly-report';
import { roiCalculatorWorkflow } from './workflows/analytics/roi-calculator';
import { trendAnalysisWorkflow } from './workflows/analytics/trend-analysis';
import { proposalGeneratorWorkflow } from './workflows/sales/proposal-generator';
import { meetingSchedulerWorkflow } from './workflows/sales/meeting-scheduler';
import { onboardingChecklistWorkflow } from './workflows/sales/onboarding-checklist';
import { repoMaintenanceWorkflow } from './workflows/repo-maintenance';
import { automationClientHuntStrategyWorkflow } from './workflows/automation-client-hunt-strategy';
import { youtubeVideoProductionWorkflow } from './workflows/youtube-production-workflow';

// Agents




import { weatherAgent } from './agents/weather-agent';
import { crmAgent } from './agents/crm-agent';
import { metaAgent } from './agents/meta-agent';
import { metaFrontAgent } from './agents/meta-front-agent';
import {
  marketingAgent,
  producerHuntDiscoveryAgent,
  producerHuntDraftAgent,
  producerHuntEmailExtractionAgent,
  producerHuntEnrichmentAgent,
  producerHuntJsonRepairAgent,
  producerHuntCloudFallbackAgent,
} from './agents/marketing-agent';
import { salesAgent } from './agents/sales-agent';
import { analyticsAgent } from './agents/analytics-agent';
import { automationArchitect } from './agents/automation-architect';
import { n8nMcpEngineer } from './agents/n8n-mcp-engineer';
import { codingAgent } from './agents/coding-agent';
import { codeReviewAgent } from './agents/code-review-agent';
import { securityReviewAgent } from './agents/security-review-agent';
import { performanceReviewAgent } from './agents/performance-review-agent';
import { knowledgeAgent } from './agents/knowledge-agent';
import { researcherAgent } from './agents/researcher-agent';
import { deliberationAgent } from './agents/deliberation-agent';
import { chefAgent } from './agents/chef-agent';
import { contentAgent } from './agents/content-agent';
import { huntAgent } from './agents/hunt-agent';
import { designAgent } from './agents/design-agent';
import { writerAgent } from './agents/writer-agent';
import { filmmakerAgent } from './agents/film-agent';
import { musicianAgent } from './agents/musician-agent';
import { capabilitySmith } from './agents/capability-smith';

// Scorers
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { metaToolCallAppropriatenessScorer } from './scorers/meta-agent-scorer';
import { marketingDraftingCompletenessScorer } from './scorers/marketing-agent-scorer';
import { architectRiskSoundnessScorer } from './scorers/automation-architect-scorer';
import { deliberationQualityScorer } from './scorers/deliberation-scorer';
import { chefMenuQualityScorer } from './scorers/chef-agent-scorer';

// Server (custom API routes)
import { registerApiRoute } from '@mastra/core/server';
import { createV2ApiRoutes, configureV2Mount, startV2Mount, getV2Store } from './orchestration/http/mastra-routes.js';
import { acceptStartCommand, cancelJob, getJobStatus, getJobResult } from './orchestration/store/index.js';
import {
  configureDurableDelegation,
  durableDelegationEnabled,
  runDelegationCompletionBridge,
} from './services/durable-delegation.js';
import { isKillSwitchActive } from './services/task-ledger.js';
import {
  AUTOMATION_GOLDEN_PATH_ATTEMPT_CAP_MS,
  AUTOMATION_GOLDEN_PATH_CAPABILITY,
  automationGoldenPathExecutor,
  configureDurableAutomationJobs,
  durableAutomationJobsEnabled,
  runAutomationCompletionBridge,
} from './services/durable-automation-jobs.js';
import {
  createRegistryWorker, capabilityRoute, harnessCallerFactory,
  createModelLaneDecider, createMastraAgentCaller, nativeCapabilityWorker,
  type NativeCapabilityExecutor, type RegistryAgent,
} from './orchestration/execution/index.js';
import { buildCapabilityRegistry, parseCapabilityAllowlist } from './config/capability-routing.js';
import { agentBoard } from './config/agent-board.js';
import { laneOrchestratorAgent } from './agents/lane-orchestrator-agent';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const startedAt = Date.now();

function getVersion(): string {
  // Próbuj git (live repo)
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    // Fallback: plik .deploy-version (staging bez .git)
    try {
      return readFileSync('.deploy-version', 'utf-8').trim();
    } catch {
      return 'unknown';
    }
  }
}

const APP_VERSION = getVersion();

// Keep a top-level handle to the exact DuckDB instance used by DefaultExporter.
// Retention must run in this process; a second process cannot safely open an
// embedded DuckDB database while Mastra owns the writer lock.
const observabilityDuckDBStore = new DuckDBStore({
  // Never use DuckDB's cwd-relative default here. `mastra dev` may run the
  // application from src/mastra/public, and Mastra copies that entire
  // directory into the production bundle. A live observability database
  // in public therefore made every build copy tens of gigabytes.
  path: resolveObservabilityDuckDBPath(AGENTIC_AGENTS_REPO),
});
const observabilityStore = await observabilityDuckDBStore.getStore('observability');

// Auto-migrate legacy signal tables (metric_events, log_events, score_events, feedback_events)
// to ensure PRIMARY KEY constraints exist before Mastra's composite store initializes.
try {
  if (typeof (observabilityStore as any).migrateSpans === 'function') {
    await (observabilityStore as any).migrateSpans();
  }
} catch (migErr) {
  console.warn('[Mastra] Observability signal table auto-migration notice:', migErr);
}

const observabilityRetention = new ObservabilityRetentionService(observabilityDuckDBStore.db, {
  retentionDays: getObservabilityRetentionDays(),
});

export const mastra: Mastra = new Mastra({
  server: {
    /**
     * HTTP request ceiling for every Mastra route.
     *
     * Mastra defaults this to 3 minutes (`timeout(server?.timeout ?? 3 * 60 * 1e3)`),
     * which sits BELOW every budget this system gives its own work: automation
     * delegation runs to `DELEGATION_AUTOMATION_TIMEOUT_MS` (900s default) and one
     * Golden Path attempt to `AUTOMATION_GOLDEN_PATH_ATTEMPT_CAP_MS` (20 min). The
     * mismatch is invisible from the inside: the caller gets a 504 at exactly
     * 180.0s while the run keeps going server-side, finishes, and writes its
     * result — so the work looks failed and is not. Measured 2026-08-24: three
     * architect runs cut mid-grounding this way, each still completing in Mongo
     * afterwards.
     *
     * Raised to the automation delegation budget so the transport stops being the
     * shortest fuse. Override with `MASTRA_SERVER_TIMEOUT_MS`.
     */
    timeout: Number(process.env.MASTRA_SERVER_TIMEOUT_MS)
      || Number(process.env.DELEGATION_AUTOMATION_TIMEOUT_MS)
      || 900_000,
    apiRoutes: [
	      registerApiRoute('/deploy/health', {
	        method: 'GET',
	        handler: async (c) => {
          const uptimeMs = Date.now() - startedAt;
          return c.json({
            status: 'ok',
            version: APP_VERSION,
            uptime: uptimeMs,
            uptimeHuman: `${Math.floor(uptimeMs / 60000)}m ${Math.floor((uptimeMs % 60000) / 1000)}s`,
            timestamp: new Date().toISOString(),
            slot: process.env.DEPLOY_SLOT || 'default',
            port: process.env.PORT || '4111',
            pid: process.pid,
	          });
	        },
	      }),
      createObservabilityRetentionRoute(observabilityRetention),
      registerApiRoute('/deploy/automation-architect/generate', {
        method: 'POST',
        handler: async (c: any) => {
          const body = await c.req.json().catch(() => ({}));
          const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
          const resourceId = typeof body.resourceId === 'string' ? body.resourceId.trim() : '';
          const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
          const messages = Array.isArray(body.messages) ? body.messages : undefined;
          const maxStepsRaw = Number(body.maxSteps ?? 8);
          const maxSteps = Number.isFinite(maxStepsRaw) ? Math.max(1, Math.min(20, Math.floor(maxStepsRaw))) : 8;

          if (!threadId || !resourceId) {
            return c.json({ error: 'threadId and resourceId are required.' }, 400);
          }
          if (!prompt && !messages) {
            return c.json({ error: 'prompt or messages is required.' }, 400);
          }
          if (prompt && prompt.length > 20_000) {
            return c.json({ error: 'prompt is too large.' }, 413);
          }

          const input = messages ?? prompt;
          // Run inside a harness execution context so the architect HAS a runtime
          // identity here. `resolveDelegationCaller` deliberately takes WHO is
          // delegating from the run rather than from a model-supplied field — but
          // this route called `generate` directly, so there was no run to read and
          // the caller silently fell back to the `META_AGENT_ID` default. The
          // `n8nMcpEngineer` gate then rejected the architect's own handoff with
          // `n8n_mcp_engineer_caller_not_allowed`, so every MCP grounding attempt
          // made through this endpoint died of a missing identity rather than of
          // anything about the work. Observed live 2026-08-24: the architect
          // correctly checked the Agent Board and delegated, and was refused.
          const { runWithHarnessExecutionContext } = await import('./services/harness-execution-context.js');
          const { AUTOMATION_ARCHITECT_AGENT_ID } = await import('./config/agent-ids.js');
          const result = await runWithHarnessExecutionContext(
            { agentId: AUTOMATION_ARCHITECT_AGENT_ID, threadId },
            async () => (automationArchitect.generate as any)(input, {
              maxSteps,
              memory: {
                thread: threadId,
                resource: resourceId,
              },
            }),
          );

          return c.json({
            text: result?.text ?? '',
            finishReason: result?.finishReason,
            steps: result?.steps ?? [],
            threadId,
            resourceId,
          });
        },
      }),
      // ── Google OAuth Flow (Faza 6.1) ──
      registerApiRoute('/auth/google', {
        method: 'GET',
        handler: async (c: any) => {
          const { getGoogleAuthUrl } = await import('./tools/google/auth.js');
          const urlObj = new URL(c.req.url, 'http://localhost');
          const account = (urlObj.searchParams.get('account') as any) || 'personal';
          const url = getGoogleAuthUrl(account);
          return c.redirect(url);
        },
      }),
      registerApiRoute('/auth/google/callback', {
        method: 'GET',
        handler: async (c: any) => {
          const { exchangeGoogleCode, saveGoogleAccountTokens } = await import('./tools/google/auth.js');
          const url = new URL(c.req.url, 'http://localhost');
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state') as any;
          const account = (state === 'gastrobridge' || state === 'personal') ? state : 'personal';

          if (!code) {
            return c.json({ error: 'No code provided' }, 400);
          }

          try {
            const tokens = await exchangeGoogleCode(code);
            await saveGoogleAccountTokens(account, tokens);
            return c.json({
              message: `OAuth successful for account '${account}'! Tokens saved to database.`,
              account,
              envVarName: account === 'personal' ? 'GOOGLE_REFRESH_TOKEN_PERSONAL' : 'GOOGLE_REFRESH_TOKEN_GASTROBRIDGE',
              ...tokens
            });
          } catch (err: any) {
            return c.json({ error: err.message }, 500);
          }
        },
      }),
      // ── Self-healing: crash-test endpoint (Etap 7) ──
      registerApiRoute('/deploy/crash-test', {
        method: 'GET',
        handler: async (c: any) => {
          // Symulowany błąd do testowania ErrorCollector
          const errorType = new URL(c.req.url, 'http://localhost').searchParams.get('type') || 'TypeError';
          const simulatedError = new TypeError('Cannot read property \'value\' of undefined');
          simulatedError.name = errorType;

          const collector = getErrorCollector();
          const result = await collector.reportError(simulatedError, {
            source: 'api',
            origin: '/deploy/crash-test',
            metadata: { simulated: true },
          });

          return c.json({
            crashSimulated: true,
            healingTriggered: result.triggered,
            reason: result.reason,
            ticketId: result.ticketId,
            timestamp: new Date().toISOString(),
          });
        },
      }),
      // ── Self-healing: status aktywnych napraw ──
      registerApiRoute('/deploy/auto-heal-status', {
        method: 'GET',
        handler: async (c: any) => {
          const collector = getErrorCollector();
          const tickets = await collector.getActiveTickets();
          return c.json({
            activeTickets: tickets.length,
            tickets,
            timestamp: new Date().toISOString(),
          });
        },
      }),
      // ── Autoheal Cycles: lista cykli naprawczych (Etap 1, read-only) ──
      registerApiRoute('/deploy/autoheal-cycles', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { listCycles } = await import('./lib/autoheal-cycles.js');
            const limit = Number(new URL(c.req.url, 'http://localhost').searchParams.get('limit') ?? 50);
            const cycles = await listCycles(limit);
            return c.json({ count: cycles.length, cycles, timestamp: new Date().toISOString() });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Autoheal Attempts: szczegóły cyklu + próby + obserwacje (Etap 1) ──
      registerApiRoute('/deploy/autoheal-attempts/:cycleId', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getCycle, listAttempts, listRuntimeEvents } = await import('./lib/autoheal-cycles.js');
            const cycleId = c.req.param('cycleId');
            const cycle = await getCycle(cycleId);
            if (!cycle) {
              return c.json({ error: `Cycle not found: ${cycleId}` }, 404);
            }
            const [attempts, observations] = await Promise.all([
              listAttempts(cycleId),
              listRuntimeEvents(cycleId),
            ]);
            return c.json({ cycle, attempts, observations, timestamp: new Date().toISOString() });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Runtime Status: stan z .deploy/autoheal-state.json + proces live (Etap 1) ──
      // Read-only. Rollback NIE zależy od tego endpointu (supervisor czyta plik bezpośrednio).
      registerApiRoute('/deploy/runtime-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { readState, getStatePath } = await import('./services/autoheal-state.js');
            const state = readState();
            const uptimeMs = Date.now() - startedAt;
            return c.json({
              statePath: getStatePath(),
              stateFilePresent: state !== null,
              persistedState: state,
              liveProcess: {
                pid: process.pid,
                slot: process.env.DEPLOY_SLOT || 'default',
                port: process.env.PORT || '4111',
                version: APP_VERSION,
                uptimeMs,
              },
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── GPU Guard: VRAM monitoring endpoint ──
      registerApiRoute('/deploy/gpu-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const guard = getGpuGuard();
            const snapshot = guard.getSnapshot(true);
            return c.json({
              ...snapshot,
              timestamp: snapshot.timestamp.toISOString(),
              vramBudgetMb: (await import('./config/model-capabilities.js')).VRAM_BUDGET_MB,
            });
          } catch (err) {
            return c.json({
              error: 'GpuGuard unavailable',
              message: (err as Error).message,
              gpuAvailable: false,
            }, 500);
          }
        },
      }),
      // ── Model Availability: check model status (Etap 8.1) ──
      registerApiRoute('/deploy/model-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { verifyAllModels, formatAvailabilitySummary } = await import('./services/model-availability.js');
            const forceRefresh = new URL(c.req.url, 'http://localhost').searchParams.get('refresh') === 'true';
            const summary = await verifyAllModels(forceRefresh);
            return c.json({
              ...summary,
              checkedAt: summary.checkedAt.toISOString(),
              formatted: formatAvailabilitySummary(summary),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Periodic Workers status (P2) ──
      registerApiRoute('/deploy/workers-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getWorkerStatus } = await import('./services/periodic-worker-manager.js');
            const workers = getWorkerStatus();
            const overall = workers.some((w) => w.lastStatus === 'critical' || w.lastStatus === 'error')
              ? 'critical'
              : workers.some((w) => w.lastStatus === 'warning')
                ? 'warning'
                : 'healthy';
            return c.json({ overall, count: workers.length, workers, timestamp: new Date().toISOString() });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/deploy/github-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getGitHubStatus } = await import('./services/github.js');
            const status = await getGitHubStatus();
            return c.json(status);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Cloud-free tier diagnostics (Phase 4.2/4.3) ──
      registerApiRoute('/deploy/cloud-free-status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getCircuitBreaker } = await import('./services/circuit-breaker.js');
            const { getBudgetTracker } = await import('./services/budget-tracker.js');
            const breaker = getCircuitBreaker();
            const budget = getBudgetTracker();
            return c.json({
              budget: budget.getDailySummary('openrouter'),
              circuitBreakers: breaker.getOpenCircuits(),
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Agent Evaluation Dashboard (Faza 7.6 — Sprint 1) ──
      // Read-only aggregation endpoints. All accept ?since=7d|24h|YYYY-MM-DD
      // and optional ?until=YYYY-MM-DD. Defaults to last 7 days.
      registerApiRoute('/dashboard/overview', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json(await stats.getOverview(window));
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/summary', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const filters = analytics.parseDashboardV2Filters(url.searchParams);
            return c.json(await analytics.getDashboardV2Summary(window, filters));
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/agents', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const filters = analytics.parseDashboardV2Filters(url.searchParams);
            return c.json({ data: await analytics.getDashboardV2Agents(window, filters), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/models', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const filters = analytics.parseDashboardV2Filters(url.searchParams);
            return c.json({ data: await analytics.getDashboardV2Models(window, filters), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/latency', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const filters = analytics.parseDashboardV2Filters(url.searchParams);
            return c.json({ data: await analytics.getDashboardV2Latency(window, filters), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/timeline', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const granularity = url.searchParams.get('granularity') === 'hour' ? 'hour' : 'day';
            const filters = analytics.parseDashboardV2Filters(url.searchParams);
            return c.json({ data: await analytics.getDashboardV2Timeline(window, granularity, filters), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/tools', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const filters = analytics.parseDashboardV2Filters(url.searchParams);
            return c.json({ data: await analytics.getDashboardV2Tools(window, filters), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/skills', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const filters = analytics.parseDashboardV2Filters(url.searchParams);
            return c.json({ data: await analytics.getDashboardV2Skills(window, filters), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/quality', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const filters = analytics.parseDashboardV2Filters(url.searchParams);
            return c.json({ data: await analytics.getDashboardV2Quality(window, filters), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/code-graph', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const analytics = await import('./services/dashboard-analytics-v2.js');
            return c.json({ data: await analytics.getDashboardV2CodeGraph() });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/traces', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const params = analytics.parseDashboardV2TraceParams(url.searchParams);
            return c.json({ data: await analytics.getDashboardV2Traces(window, params), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/v2/traces/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const analytics = await import('./services/dashboard-analytics-v2.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const params = analytics.parseDashboardV2TraceParams(url.searchParams);
            const detail = await analytics.getDashboardV2TraceDetail(window, decodeURIComponent(c.req.param('id')), params);
            return detail ? c.json({ data: detail, window }) : c.json({ error: 'Trace not found' }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Universal Scheduled Task Orchestrator dashboard API ───────────────
      // Meta Front message endpoint (§4.1/§17). The front's job tools derive
      // identity from the RUN, and Mastra's ordinary agent endpoint opens no such
      // run — it only injects threadId for sub-agent tools, not regular ones — so
      // a front reached that way can chat but can never queue work. This endpoint
      // binds conversationId (and the caller's resource) around the generate call,
      // which is exactly the "authorize and bind resourceId to conversationId"
      // responsibility §4.1 assigns to the front.
      registerApiRoute('/v2/front/messages', {
        method: 'POST',
        handler: async (c: any) => {
          if (process.env.FEATURE_ORCHESTRATION_V2_AGENT_TOOLS !== 'true'
            || process.env.FEATURE_ORCHESTRATION_V2 !== 'true') {
            return c.json({ error: 'meta_front_disabled' }, 503);
          }
          const resourceId = c.req.header('x-resource-id');
          if (!resourceId) return c.json({ error: 'unauthenticated' }, 401);
          try {
            const body = await c.req.json().catch(() => ({}));
            const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
            const message = typeof body.message === 'string' ? body.message : '';
            if (!conversationId || !message) {
              return c.json({ error: 'conversationId_and_message_required' }, 400);
            }
            const { runWithHarnessExecutionContext } = await import('./services/harness-execution-context.js');
            const frontReply = await import('./services/meta-front-reply.js');
            const ask = (prompt: string) => runWithHarnessExecutionContext(
              { agentId: 'metaFrontAgent', threadId: conversationId },
              () => metaFrontAgent.generate(prompt, {
                memory: { thread: conversationId, resource: resourceId },
              } as never),
            ) as Promise<{ text?: string; toolResults?: unknown }>;

            // The front is the only thing the user sees, and it reports on work
            // it does not do. Live it has both invented a job id it never
            // created and returned an empty string — so the reply is audited
            // against what this turn's tool calls actually returned, corrected
            // once, and only then delivered.
            let reply = await ask(message);
            let verdict = frontReply.auditFrontReply(
              reply.text ?? '',
              frontReply.collectRealJobIds(reply.toolResults),
            );
            if (!verdict.ok) {
              console.warn(`[meta-front] reply rejected (${verdict.reason}): ${verdict.detail}`);
              reply = await ask(frontReply.correctionPrompt(verdict, message));
              verdict = frontReply.auditFrontReply(
                reply.text ?? '',
                frontReply.collectRealJobIds(reply.toolResults),
              );
              if (!verdict.ok) {
                console.error(`[meta-front] corrected reply also rejected (${verdict.reason}): ${verdict.detail}`);
              }
            }

            // A promise to notify is handled separately and NEVER falls back:
            // the job did start, so replacing a true report with "nothing was
            // started" would trade a bad sentence for a false one. Nudge once,
            // then deliver whatever the model said.
            if (verdict.ok) {
              const promise = frontReply.findUnkeepablePromise(reply.text ?? '');
              if (promise) {
                console.warn(`[meta-front] reply promised a notification it cannot send: ${promise}`);
                const retry = await ask(frontReply.promiseCorrectionPrompt(promise, message));
                // Audited against BOTH turns' ids. The rewrite is asked to keep
                // the job id it already reported, and that id was minted by the
                // FIRST turn's tool call — checking the retry against only its
                // own (empty) tool results would condemn a true statement as
                // fabricated and throw the good reply away.
                const retryVerdict = frontReply.auditFrontReply(
                  retry.text ?? '',
                  new Set([
                    ...frontReply.collectRealJobIds(reply.toolResults),
                    ...frontReply.collectRealJobIds(retry.toolResults),
                  ]),
                );
                // Only take the rewrite if it is itself truthful about jobs —
                // a correction must not be a way in for a fabricated id.
                if (retryVerdict.ok && (retry.text ?? '').trim().length > 0) reply = retry;
              }
            }

            return c.json({
              conversationId,
              text: verdict.ok ? (reply.text ?? '') : frontReply.FRONT_REPLY_FALLBACK,
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // Durable orchestration V2 — operator READ view. Note: unrelated to the
      // `/dashboard/v2/*` routes above, which are the ANALYTICS dashboard v2.
      // Read-only by design: a status read must never wake or mutate a job.
      registerApiRoute('/dashboard/orchestration/jobs', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const dashboard = await import('./services/dashboard-orchestration.js');
            const url = new URL(c.req.url, 'http://localhost');
            return c.json(await dashboard.getOrchestrationDashboardSummary({
              resourceId: url.searchParams.get('resourceId') || undefined,
              conversationId: url.searchParams.get('conversationId') || undefined,
              phase: url.searchParams.get('phase') || undefined,
              limit: Number(url.searchParams.get('limit') ?? 50),
            }));
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/orchestration/jobs/:jobId', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const dashboard = await import('./services/dashboard-orchestration.js');
            const jobId = decodeURIComponent(c.req.param('jobId'));
            const job = await dashboard.getOrchestrationDashboardJob(jobId);
            return job ? c.json({ job }) : c.json({ error: `Job not found: ${jobId}` }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/scheduled-tasks', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const dashboard = await import('./services/scheduled-task-dashboard.js');
            const url = new URL(c.req.url, 'http://localhost');
            const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 50)));
            return c.json(await dashboard.getScheduledTaskDashboardSummary({
              status: (url.searchParams.get('status') || undefined) as any,
              chainId: url.searchParams.get('chainId') || undefined,
              targetType: (url.searchParams.get('targetType') || undefined) as any,
              limit,
            }));
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/scheduled-tasks/:taskId', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const dashboard = await import('./services/scheduled-task-dashboard.js');
            const taskId = decodeURIComponent(c.req.param('taskId'));
            const task = await dashboard.getSerializedScheduledTask(taskId);
            return task ? c.json({ task }) : c.json({ error: `Scheduled task not found: ${taskId}` }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/scheduled-tasks/:taskId/cancel', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const taskId = decodeURIComponent(c.req.param('taskId'));
            const { cancelScheduledTask, getScheduledTask } = await import('./services/scheduled-task-store.js');
            const before = await getScheduledTask(taskId);
            if (!before) return c.json({ ok: false, error: `Scheduled task not found: ${taskId}` }, 404);
            const cancelled = await cancelScheduledTask(taskId);
            const dashboard = await import('./services/scheduled-task-dashboard.js');
            const task = await dashboard.getSerializedScheduledTask(taskId);
            return c.json({
              ok: cancelled,
              task,
              message: cancelled
                ? `Scheduled task ${taskId} cancelled.`
                : `Scheduled task ${taskId} could not be cancelled from status ${before.status}.`,
            }, cancelled ? 200 : 409);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/scheduled-tasks/:taskId/reschedule', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const taskId = decodeURIComponent(c.req.param('taskId'));
            const body = await c.req.json().catch(() => ({}));
            const { rescheduleScheduledTask } = await import('./services/scheduled-task-store.js');
            const task = await rescheduleScheduledTask({
              taskId,
              fireAt: typeof body.fireAt === 'string' ? body.fireAt : undefined,
              cronExpression: typeof body.cronExpression === 'string' ? body.cronExpression : undefined,
              timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
              resetRetry: body.resetRetry !== false,
            });
            if (!task) {
              return c.json({ ok: false, error: `Scheduled task ${taskId} could not be rescheduled.` }, 409);
            }
            const dashboard = await import('./services/scheduled-task-dashboard.js');
            return c.json({ ok: true, task: await dashboard.getSerializedScheduledTask(task.taskId) });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Approvals: list pending + approve. Makes the "approve in the dashboard"
      // path real — system_request_approval inserts a pending record but nothing
      // could flip it to 'approved', so paid actions (e.g. film_generate) stayed
      // blocked forever. GET lists pending; POST approves one by id. ──
      registerApiRoute('/dashboard/approvals', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getDb } = await import('./lib/mongo.js');
            const db = await getDb();
            const url = new URL(c.req.url, 'http://localhost');
            const statusFilter = url.searchParams.get('status') ?? 'pending';
            const query: Record<string, unknown> = {};
            if (statusFilter !== 'all') {
              query.status = statusFilter;
            }
            const approvals = await db.collection('approvals')
              .find(query)
              .sort({ createdAt: -1 })
              .limit(100)
              .toArray();
            return c.json({
              data: approvals.map((a: any) => ({
                id: a.id,
                agentId: a.agentId,
                tool: a.tool,
                action: a.action,
                args: a.args,
                status: a.status,
                autoApproved: a.autoApproved ?? false,
                autoApprovedRule: a.autoApprovedRule,
                autoApprovedReason: a.autoApprovedReason,
                createdAt: a.createdAt,
                updatedAt: a.updatedAt,
              })),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/approvals/:id/approve', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const { checkDashboardApprovalAuth } = await import('./lib/dashboard-auth.js');
            const auth = checkDashboardApprovalAuth(c.req.header('authorization'));
            if (!auth.ok) return c.json({ ok: false, error: auth.message }, auth.status);
            const id = c.req.param('id');
            if (!id) return c.json({ error: 'missing approval id' }, 400);
            const { getDb } = await import('./lib/mongo.js');
            const db = await getDb();
            const res = await db.collection('approvals').updateOne(
              { id, status: 'pending' },
              { $set: { status: 'approved', updatedAt: new Date().toISOString() } },
            );
            if (res.matchedCount === 0) {
              return c.json({ ok: false, error: `no pending approval with id ${id}` }, 404);
            }
            return c.json({ ok: true, id, status: 'approved' });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/agents', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getAgentSuccessRates(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/skills', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getSkillUsageStats(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/models', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getModelBreakdown(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/latency', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getLatencyPercentiles(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/cost', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getCostBreakdown(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/scores', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            return c.json({ data: await stats.getScoreStats(window), window });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard/timeline', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const stats = await import('./services/dashboard-stats.js');
            const url = new URL(c.req.url, 'http://localhost');
            const window = stats.buildWindow(url.searchParams.get('since') ?? undefined, url.searchParams.get('until') ?? undefined);
            const granParam = url.searchParams.get('granularity');
            const granularity = granParam === 'day' ? 'day' : 'hour';
            return c.json({ data: await stats.getTimeline(window, granularity), window, granularity });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Live Agent Activity (delegations + tool calls timeline) ──
      // Powers the "Live Activity" tab. Returns recent agent_events for live polling.
      registerApiRoute('/dashboard/agent-activity', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getDb } = await import('./lib/mongo.js');
            const db = await getDb();
            const url = new URL(c.req.url, 'http://localhost');
            const sinceParam = url.searchParams.get('since');
            const limitParam = parseInt(url.searchParams.get('limit') ?? '100', 10);
            const limit = Math.min(Math.max(limitParam, 1), 500);

            const since = sinceParam
              ? new Date(sinceParam)
              : new Date(Date.now() - 5 * 60 * 1000); // default: ostatnie 5 min

            const events = await db.collection('agent_events')
              .find({ timestamp: { $gte: since } })
              .sort({ timestamp: -1 })
              .limit(limit)
              .project({
                _id: 0,
                eventId: 1,
                timestamp: 1,
                agentId: 1,
                type: 1,
                toolId: 1,
                taskId: 1,
                status: 1,
                durationMs: 1,
                input: 1,
                output: 1,
                errorMessage: 1,
                model: 1,
                tokenUsage: 1,
                metadata: 1,
              })
              .toArray();

            return c.json({
              events,
              count: events.length,
              since: since.toISOString(),
              now: new Date().toISOString(),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Dashboard Command Center Topology (Jarvis) ──
      registerApiRoute('/dashboard/active-topology', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { getDb } = await import('./lib/mongo.js');
            const db = await getDb();
            const { N8nService } = await import('./tools/n8n/client.js');

            const n8n = new N8nService();
            let n8nWorkflows: any[] = [];
            try {
              n8nWorkflows = await n8n.listWorkflows();
            } catch (e) {
              console.warn('Could not fetch n8n workflows', e);
            }

            const since = new Date(Date.now() - 5 * 60 * 1000);
            const recentEvents = await db.collection('agent_events')
              .find({ timestamp: { $gte: since } })
              .sort({ timestamp: -1 })
              .toArray();

            const activeAgents = new Set<string>();
            const connections: any[] = [];
            const workers: any[] = [];
            const agentPhases: Record<string, string> = {};
            const harnessAgents = new Set<string>();

            // A beam "flows" (animates) only while the event is fresh. Events are
            // logged AFTER the work completes, so we treat anything within the
            // last ACTIVE_WINDOW_MS as a live data-transfer to animate; older
            // links stay as faint idle wires.
            const now = Date.now();
            const ACTIVE_WINDOW_MS = 75 * 1000;

            for (const ev of [...recentEvents].reverse()) {
              const aid = ev.agentId as string;
              const ageMs = now - new Date(ev.timestamp).getTime();
              const fresh = ageMs < ACTIVE_WINDOW_MS;

              // ── Delegation: orchestrator → target expert agent ──
              // The delegatee is stored in agentId; the caller is the meta
              // orchestrator (default) unless an explicit caller was recorded.
              if (ev.type === 'delegation') {
                const to = (ev.metadata?.targetAgent as string) || aid;
                const from = (ev.metadata?.callerAgent as string) || 'metaAgent';
                activeAgents.add(to);
                if (from !== to) {
                  activeAgents.add(from);
                  connections.push({
                    from,
                    to,
                    type: 'delegation',
                    status: fresh ? 'active' : 'idle',
                  });
                }
                continue;
              }

              // ── Worker runs (periodic system workers + ad-hoc run_worker) ──
              // agentId is the worker id ("worker:..."); the spawner defaults to
              // the meta orchestrator unless a caller was recorded.
              if (
                ev.type === 'worker_run_started' ||
                ev.type === 'worker_run_completed' ||
                ev.type === 'worker_run_failed'
              ) {
                const workerId = aid;
                const preset =
                  (ev.metadata?.preset as string) ||
                  (ev.metadata?.kind as string) ||
                  'system';
                const from = (ev.metadata?.callerAgent as string) || 'metaAgent';
                workers.push({ id: workerId, preset });
                activeAgents.add(from);
                connections.push({
                  from,
                  to: workerId,
                  type: 'worker_spawn',
                  status: ev.type === 'worker_run_started' || fresh ? 'active' : 'idle',
                });
                continue;
              }

              // ── Any other event marks its own agent as recently active ──
              activeAgents.add(aid);
              if (ev.metadata?.harnessPhase) {
                agentPhases[aid] = ev.metadata.harnessPhase as string;
                harnessAgents.add(aid);
              }
            }

            // Mark connections whose target ran through the harness.
            for (const conn of connections) {
              if (harnessAgents.has(conn.to)) conn.hasHarness = true;
            }

            const uniqueWorkers = [...new Map(workers.map(w => [w.id, w])).values()];
            // Dedupe by from→to; iteration was oldest→newest so the freshest
            // event's status wins.
            const uniqueConns = [...new Map(connections.map(c => [c.from + '-' + c.to, c])).values()];

            const allAgents = [
              { id: 'metaAgent', tier: 'meta' },
              { id: 'marketingAgent', tier: 'domain' },
              { id: 'salesAgent', tier: 'domain' },
              { id: 'analyticsAgent', tier: 'domain' },
              { id: 'automationArchitect', tier: 'domain' },
              { id: 'knowledgeAgent', tier: 'domain' },
              { id: 'researcherAgent', tier: 'domain' },
              { id: 'codingAgent', tier: 'domain' },
              { id: 'codeReviewAgent', tier: 'domain' },
              { id: 'securityReviewAgent', tier: 'domain' },
              { id: 'performanceReviewAgent', tier: 'domain' },
              { id: 'deliberationAgent', tier: 'domain' },
              { id: 'chefAgent', tier: 'domain' },
              { id: 'contentAgent', tier: 'domain' },
              { id: 'huntAgent', tier: 'domain' },
              { id: 'designAgent', tier: 'domain' },
              { id: 'writerAgent', tier: 'domain' },
              { id: 'filmmakerAgent', tier: 'domain' },
              { id: 'musicianAgent', tier: 'domain' }
            ].map(a => ({
              ...a,
              active: activeAgents.has(a.id),
              harnessPhase: agentPhases[a.id] || null
            }));

            const mastraWorkflows = [
              { id: 'weatherWorkflow', name: 'Weather' },
              { id: 'weeklyContentWorkflow', name: 'Weekly Content' },
              { id: 'producerHuntWorkflow', name: 'Producer Hunt' },
              { id: 'syncCrmWorkflow', name: 'Sync CRM' },
              { id: 'automationClientHuntStrategyWorkflow', name: 'Hunt Strategy' }
            ];

            return c.json({
              agents: allAgents,
              workers: uniqueWorkers,
              workflows: {
                mastra: mastraWorkflows,
                n8n: n8nWorkflows.map(w => ({ id: w.id, name: w.name, active: w.active }))
              },
              connections: uniqueConns,
              stats: {
                tasks: recentEvents.length,
                latency: Math.round(recentEvents.reduce((acc, ev) => acc + (ev.durationMs || 0), 0) / (recentEvents.length || 1))
              }
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // ── Splot OS — Modern Agent Chat & Command Center UI ──
      registerApiRoute('/splot', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const htmlPath = path.resolve(
              '/projekty/splot-projects/artifacts',
              'agent_chat_panel.html',
            );
            const html = await fs.readFile(htmlPath, 'utf8');
            const rendered = isAlexLiveEnabled()
              ? html
                .replace(
                  '</head>',
                  '  <link rel="stylesheet" href="/dashboard-ui/alex.css">\n</head>',
                )
                .replace(
                  '</body>',
                  '  <script type="module" src="/dashboard-ui/alex.js"></script>\n</body>',
                )
              : html;
            return c.html(rendered);
          } catch (err) {
            return c.json({ error: 'Splot OS UI not found', details: (err as Error).message }, 500);
          }
        },
      }),
      // ── Splot OS Dedicated Realtime Backend API ──
      registerApiRoute('/splot/api/chat', {
        method: 'POST',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleSplotChat(mastra, c);
        },
      }),
      registerApiRoute('/splot/api/agents', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetAgentsMetadata(c);
        },
      }),
      registerApiRoute('/splot/api/threads', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleListThreads(c);
        },
      }),
      registerApiRoute('/splot/api/threads/:threadId/messages', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetThreadMessages(c);
        },
      }),
      registerApiRoute('/splot/api/threads/:threadId', {
        method: 'DELETE',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleDeleteThread(c);
        },
      }),
      registerApiRoute('/splot/api/threads/batch', {
        method: 'DELETE',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleBatchDeleteThreads(c);
        },
      }),
      registerApiRoute('/splot/api/inspectors/memory', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetMemoryInspector(c);
        },
      }),
      registerApiRoute('/splot/api/memory/thread-stats', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetThreadMemoryStats(c);
        },
      }),
      registerApiRoute('/splot/api/inspectors/ledger', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetLedgerInspector(c);
        },
      }),
      registerApiRoute('/splot/api/inspectors/artifacts', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetArtifactsInspector(c);
        },
      }),
      registerApiRoute('/splot/api/inspectors/artifacts/:id/content', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetArtifactContent(c);
        },
      }),
      registerApiRoute('/splot/api/orchestration/overview', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetOrchestrationOverview(c);
        },
      }),
      registerApiRoute('/splot/api/evaluations/summary', {
        method: 'GET',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleGetEvaluationsSummary(c);
        },
      }),
      registerApiRoute('/splot/api/voice/transcribe', {
        method: 'POST',
        handler: async (c: any) => {
          const router = await import('./services/splot-router.js');
          return router.handleSplotVoiceTranscribe(c);
        },
      }),
      // ── Dashboard UI (Faza 7.6 — Sprint 2) ──
      // Single-file HTML + Chart.js, no build step. Consumes /dashboard/* JSON endpoints.
      registerApiRoute('/dashboard-ui', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            // Hardcoded source path (bundled mode resolves import.meta.dirname to .mastra/output/)
            const htmlPath = path.resolve(
              '/projekty/mastra-agentic-environment/agentic-agents',
              'dashboard',
              'index.html',
            );
            const html = await fs.readFile(htmlPath, 'utf8');
            const rendered = isAlexLiveEnabled()
              ? html
                .replace(
                  '</head>',
                  '  <link rel="stylesheet" href="/dashboard-ui/alex.css">\n</head>',
                )
                .replace(
                  '</body>',
                  '  <script type="module" src="/dashboard-ui/alex.js"></script>\n</body>',
                )
              : html;
            return c.html(rendered);
          } catch (err) {
            return c.json({ error: 'Dashboard UI not found', details: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard-ui/analytics.js', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const assetPath = path.resolve(
              '/projekty/mastra-agentic-environment/agentic-agents',
              'dashboard',
              'analytics.js',
            );
            const js = await fs.readFile(assetPath, 'utf8');
            return c.body(js, 200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
          } catch (err) {
            return c.json({ error: 'Dashboard analytics.js not found', details: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/dashboard-ui/analytics.css', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const assetPath = path.resolve(
              '/projekty/mastra-agentic-environment/agentic-agents',
              'dashboard',
              'analytics.css',
            );
            const css = await fs.readFile(assetPath, 'utf8');
            return c.body(css, 200, {
              'Content-Type': 'text/css; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
          } catch (err) {
            return c.json({ error: 'Dashboard analytics.css not found', details: (err as Error).message }, 500);
          }
        },
      }),

      // ════════════════════════════════════════════════════════════════════
      // Dashboard Operacyjny GastroBridge (CRM + Treści)
      // Plan: ideas/dashboard-operacyjny-plan.md
      // Read/write API nad agentforge.leads, rss_intelligence.*, FS .drafts
      // ════════════════════════════════════════════════════════════════════

      // ── CRM / Leads ──
      registerApiRoute('/ws/leads', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const u = new URL(c.req.url, 'http://localhost');
            const result = await ws.listLeads({
              status: u.searchParams.get('status') ?? undefined,
              segment: u.searchParams.get('segment') ?? undefined,
              source: u.searchParams.get('source') ?? undefined,
              region: u.searchParams.get('region') ?? undefined,
              q: u.searchParams.get('q') ?? undefined,
              limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
              skip: u.searchParams.get('skip') ? Number(u.searchParams.get('skip')) : undefined,
            });
            return c.json(result);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // Kanban czyta słownik stąd zamiast trzymać własną kopię. Trzy rozjechane
      // listy statusów to była przyczyna znikających leadów — jedna lista, jeden
      // właściciel, reszta pyta.
      registerApiRoute('/ws/leads/statuses', {
        method: 'GET',
        handler: async (c: any) => {
          const { CRM_STATUSES, CRM_STATUS_LABELS, CRM_ENGAGED_STATUSES } =
            await import('./config/crm-statuses.js');
          return c.json({
            statuses: CRM_STATUSES.map((value) => ({
              value,
              label: CRM_STATUS_LABELS[value],
              engaged: CRM_ENGAGED_STATUSES.includes(value),
            })),
          });
        },
      }),
      registerApiRoute('/ws/leads/stats', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            return c.json(await ws.getLeadStats());
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/leads/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const lead = await ws.getLead(c.req.param('id'));
            return lead ? c.json(lead) : c.json({ error: 'not found' }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/leads/:id', {
        method: 'PATCH',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const body = await c.req.json().catch(() => ({}));
            const lead = await ws.updateLead(c.req.param('id'), {
              status: body.status,
              tags: body.tags,
              note: body.note,
            });
            return lead ? c.json(lead) : c.json({ error: 'not found' }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/leads/:id/note', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const body = await c.req.json().catch(() => ({}));
            const lead = await ws.updateLead(c.req.param('id'), { note: body.note });
            return lead ? c.json(lead) : c.json({ error: 'not found' }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // ── Content / Idea Inbox ──
      registerApiRoute('/ws/content/signals', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const u = new URL(c.req.url, 'http://localhost');
            const usedParam = u.searchParams.get('used');
            return c.json({
              data: await ws.listContentSignals({
                used: usedParam == null ? undefined : usedParam === 'true',
                category: u.searchParams.get('category') ?? undefined,
                language: u.searchParams.get('language') ?? undefined,
                q: u.searchParams.get('q') ?? undefined,
                limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
              }),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/content/signals/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const sig = await ws.getContentSignal(c.req.param('id'));
            return sig ? c.json(sig) : c.json({ error: 'not found' }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/content/articles', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const u = new URL(c.req.url, 'http://localhost');
            return c.json(await ws.listArticles({
              category: u.searchParams.get('category') ?? undefined,
              source: u.searchParams.get('source') ?? undefined,
              q: u.searchParams.get('q') ?? undefined,
              limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
              skip: u.searchParams.get('skip') ? Number(u.searchParams.get('skip')) : undefined,
            }));
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // ── Drafts (email + social) ──
      registerApiRoute('/ws/drafts', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            const u = new URL(c.req.url, 'http://localhost');
            return c.json({
              data: await reg.listDrafts({
                channel: u.searchParams.get('channel') ?? undefined,
                status: u.searchParams.get('status') ?? undefined,
                segment: u.searchParams.get('segment') ?? undefined,
                search: u.searchParams.get('search') ?? undefined,
                language: u.searchParams.get('language') ?? undefined,
                week: u.searchParams.get('week') ?? undefined,
                limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
              }),
            });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/drafts/calendar', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            return c.json(await reg.getDraftsCalendar());
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/drafts/reindex', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            return c.json(await reg.reindexDrafts());
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/drafts/sync-gmail', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            const result = await reg.syncGmailDrafts();
            return c.json(result);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/drafts/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            const d = await reg.getDraft(c.req.param('id'));
            return d ? c.json(d) : c.json({ error: 'not found' }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/drafts/:id', {
        method: 'PATCH',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            const body = await c.req.json().catch(() => ({}));
            if (typeof body.body !== 'string') {
              return c.json({ error: 'body (string) required' }, 400);
            }
            const d = await reg.updateDraftBody(c.req.param('id'), body.body);
            return d ? c.json(d) : c.json({ error: 'not found' }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/drafts/:id', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            const result = await reg.deleteDraftById(c.req.param('id'));
            return c.json(result);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/drafts/:id/status', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            const body = await c.req.json().catch(() => ({}));
            const d = await reg.setDraftStatus(c.req.param('id'), body.status ?? 'draft');
            return d ? c.json(d) : c.json({ error: 'not found' }, 404);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/drafts/:id/send', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const reg = await import('./services/draft-registry.js');
            const result = await reg.sendDraftById(c.req.param('id'));
            return result.success ? c.json(result) : c.json(result, 400);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // ── Chef (read-only) ──
      registerApiRoute('/ws/chef/projects', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listChefProjects() });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/chef/menus/:projectId', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listChefMenus(c.req.param('projectId')) });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // Menu Book deliverables (on-disk Markdown + rendered PDF) for the "Księgi Menu" tab.
      registerApiRoute('/ws/chef/books', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listChefBooks() });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/chef/book/:projectId', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const book = await ws.getChefBook(c.req.param('projectId'));
            if (!book) return c.json({ error: 'Menu Book not found' }, 404);
            return c.json({ data: book });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/chef/projects/:id', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const result = await ws.deleteChefProject(c.req.param('id'), { deleteFiles: true });
            return c.json({ data: result });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/chef/book/:projectId', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const result = await ws.deleteChefProject(c.req.param('projectId'), { deleteFiles: true });
            return c.json({ data: result });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // ── Writer (read-only) ──
      registerApiRoute('/ws/writer/projects', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const u = new URL(c.req.url, 'http://localhost');
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listWriterProjects({
              status: u.searchParams.get('status') as any || undefined,
              type: u.searchParams.get('type') as any || undefined,
              limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : 50,
            }) });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/documents', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const u = new URL(c.req.url, 'http://localhost');
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listWriterDocuments({
              status: u.searchParams.get('status') as any || undefined,
              type: u.searchParams.get('type') as any || undefined,
              limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : 50,
            }) });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const bundle = await ws.getWriterProjectBundle(c.req.param('id'));
            if (!bundle) return c.json({ error: 'Writer project not found' }, 404);
            return c.json({ data: bundle });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/sections', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const bundle = await ws.getWriterProjectBundle(c.req.param('id'));
            if (!bundle) return c.json({ error: 'Writer project not found' }, 404);
            return c.json({ data: bundle.sections });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/sources', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const bundle = await ws.getWriterProjectBundle(c.req.param('id'));
            if (!bundle) return c.json({ error: 'Writer project not found' }, 404);
            return c.json({ data: bundle.sources });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/claims', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const bundle = await ws.getWriterProjectBundle(c.req.param('id'));
            if (!bundle) return c.json({ error: 'Writer project not found' }, 404);
            return c.json({ data: bundle.claims, summary: bundle.claimSummary });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/audits', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const bundle = await ws.getWriterProjectBundle(c.req.param('id'));
            if (!bundle) return c.json({ error: 'Writer project not found' }, 404);
            return c.json({ data: bundle.audits, summary: bundle.auditSummary });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/document', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const document = await ws.getWriterDocumentPreview(c.req.param('id'));
            if (!document) return c.json({ error: 'Writer document not found' }, 404);
            return c.json({ data: document });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/html', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const rendered = await ws.getWriterDocumentHtml(c.req.param('id'));
            if (!rendered) return c.text('Writer document not found', 404);
            return c.html(rendered.html);
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/markdown', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const document = await ws.getWriterDocumentPreview(c.req.param('id'));
            if (!document) return c.text('Writer document not found', 404);
            return c.body(document.content, 200, {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': `inline; filename="${c.req.param('id')}.md"`,
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/pdf', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const fs = await import('node:fs/promises');
            const pdfPath = await ws.getWriterPdfPath(c.req.param('id'));
            if (!pdfPath) return c.text('Writer PDF not found', 404);
            const buf = await fs.readFile(pdfPath);
            return c.body(buf, 200, {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `inline; filename="${c.req.param('id')}.pdf"`,
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id/standalone-html', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const fs = await import('node:fs/promises');
            const htmlPath = await ws.getWriterStandaloneHtmlPath(c.req.param('id'));
            if (!htmlPath) return c.text('Writer standalone HTML not found', 404);
            const content = await fs.readFile(htmlPath, 'utf8');
            return c.html(content);
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/manuscripts/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const manuscript = await ws.getWriterManuscript(c.req.param('id'));
            if (!manuscript) return c.json({ error: 'Writer manuscript not found' }, 404);
            return c.json({ data: manuscript });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/writer/projects/:id', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const result = await ws.deleteWriterProject(c.req.param('id'), { deleteFiles: true });
            return c.json({ data: result });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // ── Filmmaker (read-only project state + generated MP4 previews) ──
      registerApiRoute('/ws/filmmaker/projects', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const u = new URL(c.req.url, 'http://localhost');
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listFilmProjects({
              status: u.searchParams.get('status') as any || undefined,
              limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : 50,
            }) });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/filmmaker/projects/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const bundle = await ws.getFilmProjectBundle(c.req.param('id'));
            if (!bundle) return c.json({ error: 'Filmmaker project not found' }, 404);
            return c.json({ data: bundle });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/filmmaker/runs/:runId/video', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const fs = await import('node:fs/promises');
            const videoPath = await ws.getFilmRunVideoPath(c.req.param('runId'));
            if (!videoPath) return c.text('Film video not found', 404);
            const st = await fs.stat(videoPath);
            const range = c.req.header('range');
            const baseHeaders = {
              'Content-Type': 'video/mp4',
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, max-age=60',
            };
            if (range) {
              const match = range.match(/^bytes=(\d*)-(\d*)$/);
              if (match) {
                const start = match[1] ? Number(match[1]) : 0;
                const end = match[2] ? Math.min(Number(match[2]), st.size - 1) : st.size - 1;
                if (start <= end && start >= 0 && end < st.size) {
                  const length = end - start + 1;
                  const handle = await fs.open(videoPath, 'r');
                  try {
                    const buf = Buffer.alloc(length);
                    await handle.read(buf, 0, length, start);
                    return c.body(buf, 206, {
                      ...baseHeaders,
                      'Content-Length': String(length),
                      'Content-Range': `bytes ${start}-${end}/${st.size}`,
                    });
                  } finally {
                    await handle.close();
                  }
                }
              }
              return c.body(null, 416, {
                ...baseHeaders,
                'Content-Range': `bytes */${st.size}`,
              });
            }
            const buf = await fs.readFile(videoPath);
            return c.body(buf, 200, {
              ...baseHeaders,
              'Content-Length': String(st.size),
              'Content-Disposition': `inline; filename="${c.req.param('runId')}.mp4"`,
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/filmmaker/projects/:id/reference', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const u = new URL(c.req.url, 'http://localhost');
            const tag = u.searchParams.get('tag') || '';
            const ws = await import('./services/workspace-service.js');
            const fs = await import('node:fs/promises');
            const imagePath = await ws.getFilmReferenceImagePath(c.req.param('id'), tag);
            if (!imagePath) return c.text('Reference image not found', 404);
            const lower = imagePath.toLowerCase();
            let contentType: string | null = null;
            if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) contentType = 'image/jpeg';
            else if (lower.endsWith('.png')) contentType = 'image/png';
            else if (lower.endsWith('.webp')) contentType = 'image/webp';
            if (!contentType) return c.text('Reference image type not supported', 415);
            const buf = await fs.readFile(imagePath);
            return c.body(buf, 200, {
              'Content-Type': contentType,
              'Cache-Control': 'private, max-age=300',
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/filmmaker/projects/:id', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const u = new URL(c.req.url, 'http://localhost');
            const ws = await import('./services/workspace-service.js');
            const result = await ws.deleteFilmProject(c.req.param('id'), {
              deleteFiles: u.searchParams.get('files') === '1',
            });
            return c.json({ data: result });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // ── YouTube Studio / Remotion (projects, live studio control, video previews) ──
      registerApiRoute('/ws/youtube/projects', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { listYoutubeProjects } = await import('./tools/video/video-runner.js');
            const data = await listYoutubeProjects();
            return c.json({ data });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/youtube/remotion/status', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const { checkRemotionStudioRunning } = await import('./tools/video/video-runner.js');
            const running = await checkRemotionStudioRunning();
            return c.json({ running, url: 'http://localhost:3000' });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/youtube/remotion/start', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const { startRemotionStudio } = await import('./tools/video/video-runner.js');
            const result = await startRemotionStudio();
            return c.json(result);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/youtube/remotion/stop', {
        method: 'POST',
        handler: async (c: any) => {
          try {
            const { stopRemotionStudio } = await import('./tools/video/video-runner.js');
            const result = await stopRemotionStudio();
            return c.json(result);
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/youtube/projects/:id/video', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const { existsSync } = await import('node:fs');
            const { YOUTUBE_PROJECTS_ROOT } = await import('./tools/video/video-runner.js');
            const projId = c.req.param('id');
            const u = new URL(c.req.url, 'http://localhost');
            const isRaw = u.searchParams.get('raw') === '1';

            const candidates = isRaw
              ? [path.join(YOUTUBE_PROJECTS_ROOT, 'videos', projId, 'raw.mp4')]
              : [
                  path.join(YOUTUBE_PROJECTS_ROOT, 'output', projId, 'final_baked_4k.mp4'),
                  path.join(YOUTUBE_PROJECTS_ROOT, 'output', projId, 'master_cut.mp4'),
                  path.join(YOUTUBE_PROJECTS_ROOT, 'videos', projId, 'work', 'final_baked_4k.mp4'),
                  path.join(YOUTUBE_PROJECTS_ROOT, 'videos', projId, 'work', 'master_cut.mp4'),
                  path.join(YOUTUBE_PROJECTS_ROOT, 'videos', projId, 'raw.mp4'),
                ];

            const videoPath = candidates.find((p) => existsSync(p));
            if (!videoPath) return c.text('Video not found', 404);

            const st = await fs.stat(videoPath);
            const range = c.req.header('range');
            const baseHeaders = {
              'Content-Type': 'video/mp4',
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, max-age=60',
            };
            if (range) {
              const match = range.match(/^bytes=(\d*)-(\d*)$/);
              if (match) {
                const start = match[1] ? Number(match[1]) : 0;
                const end = match[2] ? Math.min(Number(match[2]), st.size - 1) : st.size - 1;
                if (start <= end && start >= 0 && end < st.size) {
                  const length = end - start + 1;
                  const handle = await fs.open(videoPath, 'r');
                  try {
                    const buf = Buffer.alloc(length);
                    await handle.read(buf, 0, length, start);
                    return c.body(buf, 206, {
                      ...baseHeaders,
                      'Content-Length': String(length),
                      'Content-Range': `bytes ${start}-${end}/${st.size}`,
                    });
                  } finally {
                    await handle.close();
                  }
                }
              }
              return c.body(null, 416, {
                ...baseHeaders,
                'Content-Range': `bytes */${st.size}`,
              });
            }
            const buf = await fs.readFile(videoPath);
            return c.body(buf, 200, {
              ...baseHeaders,
              'Content-Length': String(st.size),
              'Content-Disposition': `inline; filename="${projId}.mp4"`,
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/youtube/projects/:id/thumbnail', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const { existsSync } = await import('node:fs');
            const { YOUTUBE_PROJECTS_ROOT } = await import('./tools/video/video-runner.js');
            const projId = c.req.param('id');
            const u = new URL(c.req.url, 'http://localhost');
            const requestedFile = u.searchParams.get('file') || 'thumbnail_A.png';

            const thumbsDir = path.join(YOUTUBE_PROJECTS_ROOT, 'videos', projId, 'packaging', 'thumbs');
            const outThumbsDir = path.join(YOUTUBE_PROJECTS_ROOT, 'output', projId, 'thumbs');
            const targetPath = [
              path.join(thumbsDir, requestedFile),
              path.join(outThumbsDir, requestedFile),
              path.join(thumbsDir, 'thumbnail.png'),
              path.join(thumbsDir, 'thumbnail_A.png'),
            ].find((p) => p && existsSync(p));

            if (!targetPath) return c.text('Thumbnail not found', 404);

            const buf = await fs.readFile(targetPath);
            const contentType = targetPath.endsWith('.jpg') || targetPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
            return c.body(buf, 200, {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=300',
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),

      // ── Musician (read-only project state + generated audio previews) ──
      registerApiRoute('/ws/musician/projects', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const u = new URL(c.req.url, 'http://localhost');
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listMusicProjects({
              status: u.searchParams.get('status') as any || undefined,
              limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : 50,
            }) });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/musician/projects/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const bundle = await ws.getMusicProjectBundle(c.req.param('id'));
            if (!bundle) return c.json({ error: 'Musician project not found' }, 404);
            return c.json({ data: bundle });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/musician/runs/:runId/audio', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const fs = await import('node:fs/promises');
            const audioPath = await ws.getMusicRunAudioPath(c.req.param('runId'));
            if (!audioPath) return c.text('Music audio not found', 404);
            const lower = audioPath.toLowerCase();
            const contentType = lower.endsWith('.wav')
              ? 'audio/wav'
              : lower.endsWith('.flac')
                ? 'audio/flac'
                : lower.endsWith('.ogg')
                  ? 'audio/ogg'
                  : lower.endsWith('.pcm')
                    ? 'audio/L16'
                    : 'audio/mpeg';
            const st = await fs.stat(audioPath);
            const range = c.req.header('range');
            const baseHeaders = {
              'Content-Type': contentType,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, max-age=60',
            };
            if (range) {
              const match = range.match(/^bytes=(\d*)-(\d*)$/);
              if (match) {
                const start = match[1] ? Number(match[1]) : 0;
                const end = match[2] ? Math.min(Number(match[2]), st.size - 1) : st.size - 1;
                if (start <= end && start >= 0 && end < st.size) {
                  const length = end - start + 1;
                  const handle = await fs.open(audioPath, 'r');
                  try {
                    const buf = Buffer.alloc(length);
                    await handle.read(buf, 0, length, start);
                    return c.body(buf, 206, {
                      ...baseHeaders,
                      'Content-Length': String(length),
                      'Content-Range': `bytes ${start}-${end}/${st.size}`,
                    });
                  } finally {
                    await handle.close();
                  }
                }
              }
              return c.body(null, 416, {
                ...baseHeaders,
                'Content-Range': `bytes */${st.size}`,
              });
            }
            const buf = await fs.readFile(audioPath);
            return c.body(buf, 200, {
              ...baseHeaders,
              'Content-Length': String(st.size),
              'Content-Disposition': `inline; filename="${c.req.param('runId')}${lower.slice(lower.lastIndexOf('.'))}"`,
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/musician/projects/:id', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const u = new URL(c.req.url, 'http://localhost');
            const ws = await import('./services/workspace-service.js');
            const result = await ws.deleteMusicProject(c.req.param('id'), {
              deleteFiles: u.searchParams.get('files') === '1',
            });
            return c.json({ data: result });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // ── Designer (read-only filesystem projects + HTML/media previews) ──
      registerApiRoute('/ws/design/projects', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const u = new URL(c.req.url, 'http://localhost');
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listDesignProjects({
              limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : 100,
            }) });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/design/projects/:id', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const bundle = await ws.getDesignProjectBundle(c.req.param('id'));
            if (!bundle) return c.json({ error: 'Designer project not found' }, 404);
            return c.json({ data: bundle });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/design/projects/:id', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const result = await ws.deleteDesignProject(c.req.param('id'), { deleteFiles: true });
            return c.json({ data: result });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/design/assets/*', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const url = new URL(c.req.url, 'http://localhost');
            const prefix = '/ws/design/assets/';
            const encodedRest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
            const [encodedRootToken = '', ...encodedRelParts] = encodedRest.split('/');
            const rootToken = decodeURIComponent(encodedRootToken);
            const relativePath = decodeURIComponent(encodedRelParts.join('/'));
            const assetPath = await ws.getDesignAssetPath(rootToken, relativePath);
            if (!assetPath) return c.text('Design asset not found', 404);

            const contentType = ws.getDesignAssetContentType(assetPath);
            const st = await fs.stat(assetPath);
            const range = c.req.header('range');
            const streamable = contentType.startsWith('video/') || contentType.startsWith('audio/');
            const baseHeaders = {
              'Content-Type': contentType,
              'Cache-Control': 'private, max-age=120',
              ...(streamable ? { 'Accept-Ranges': 'bytes' } : {}),
            };

            if (streamable && range) {
              const match = range.match(/^bytes=(\d*)-(\d*)$/);
              if (match) {
                const start = match[1] ? Number(match[1]) : 0;
                const end = match[2] ? Math.min(Number(match[2]), st.size - 1) : st.size - 1;
                if (start <= end && start >= 0 && end < st.size) {
                  const length = end - start + 1;
                  const handle = await fs.open(assetPath, 'r');
                  try {
                    const buf = Buffer.alloc(length);
                    await handle.read(buf, 0, length, start);
                    return c.body(buf, 206, {
                      ...baseHeaders,
                      'Content-Length': String(length),
                      'Content-Range': `bytes ${start}-${end}/${st.size}`,
                    });
                  } finally {
                    await handle.close();
                  }
                }
              }
              return c.body(null, 416, {
                ...baseHeaders,
                'Content-Range': `bytes */${st.size}`,
              });
            }

            const buf = await fs.readFile(assetPath);
            return c.body(buf, 200, {
              ...baseHeaders,
              'Content-Length': String(st.size),
              'Content-Disposition': `inline; filename="${path.basename(assetPath).replace(/"/g, '')}"`,
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      // Branded HTML render of the Menu Book (served into the dashboard iframe).
      registerApiRoute('/ws/chef/book/:projectId/html', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const rendered = await ws.getChefBookHtml(c.req.param('projectId'));
            if (!rendered) return c.text('Menu Book not found', 404);
            return c.html(rendered.html);
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      // Streams the rendered Menu Book PDF (open-in-new-tab / download).
      registerApiRoute('/ws/chef/book/:projectId/pdf', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const fs = await import('node:fs/promises');
            const pdfPath = await ws.getChefPdfPath(c.req.param('projectId'));
            if (!pdfPath) return c.text('PDF not found', 404);
            const buf = await fs.readFile(pdfPath);
            return c.body(buf, 200, {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `inline; filename="${c.req.param('projectId')}.pdf"`,
            });
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),

      // ── Content Agent (read-only) ──
      registerApiRoute('/ws/content/projects', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            return c.json({ data: await ws.listContentProjects() });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/content/pack/:projectId', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const pack = await ws.getContentPack(c.req.param('projectId'));
            if (!pack) return c.json({ error: 'Content Pack not found' }, 404);
            return c.json({ data: pack });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      // Branded HTML render of the Content Pack (served into the dashboard iframe).
      registerApiRoute('/ws/content/pack/:projectId/html', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const rendered = await ws.getContentPackHtml(c.req.param('projectId'));
            if (!rendered) return c.text('Content Pack not found', 404);
            return c.html(rendered.html);
          } catch (err) {
            return c.text((err as Error).message, 500);
          }
        },
      }),
      registerApiRoute('/ws/content/projects/:id', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const result = await ws.deleteContentProject(c.req.param('id'), { deleteFiles: true });
            return c.json({ data: result });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),
      registerApiRoute('/ws/content/pack/:projectId', {
        method: 'DELETE',
        handler: async (c: any) => {
          try {
            const ws = await import('./services/workspace-service.js');
            const result = await ws.deleteContentProject(c.req.param('projectId'), { deleteFiles: true });
            return c.json({ data: result });
          } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // ── Workspace UI (single-file HTML, zero build) ──
      registerApiRoute('/workspace-ui', {
        method: 'GET',
        handler: async (c: any) => {
          try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const htmlPath = path.resolve(
              '/projekty/mastra-agentic-environment/agentic-agents',
              'src/mastra/workspace',
              'index.html',
            );
            const html = await fs.readFile(htmlPath, 'utf8');
            return c.html(html);
          } catch (err) {
            return c.json({ error: 'Workspace UI not found', details: (err as Error).message }, 500);
          }
        },
      }),
      // Durable Orchestration V2 (Meta Front) — additive, off by default.
      // Enable with FEATURE_ORCHESTRATION_V2=true + MONGODB_URI_V2 (replica set).
      // See docs/ORCHESTRATION-V2.md. With the flag off this spreads to nothing.
      ...(process.env.FEATURE_ORCHESTRATION_V2 === 'true' ? createV2ApiRoutes() : []),
      // Alex Live is only a voice bridge to the existing Meta Agent. With the
      // flag off, its API, Gemini credential endpoint and browser assets do not
      // exist at all.
      ...createAlexLiveRoutes({ metaAgent, repoRoot: AGENTIC_AGENTS_REPO }),
    ],
  },
  workflows: {
    weatherWorkflow,
    weeklyContentWorkflow,
    producerHuntWorkflow,
    // marketing
    morningBriefingWorkflow,
    automatedFollowupWorkflow,
    inboxMonitorWorkflow,
    syncCrmWorkflow,
    // analytics
    weeklyReportWorkflow,
    roiCalculatorWorkflow,
    trendAnalysisWorkflow,
    // sales
    proposalGeneratorWorkflow,
    meetingSchedulerWorkflow,
    onboardingChecklistWorkflow,
    repoMaintenanceWorkflow,
    automationClientHuntStrategyWorkflow,
    // Video YouTube Post-Production
    youtubeVideoProductionWorkflow,
  },
  agents: {

    weatherAgent,
    crmAgent,
    metaAgent,
    // Meta Front (§4.1 front_only) — registered only with the V2 agent-tool flag
    // on, since its entire toolset is the durable-job surface: without the flag
    // every one of its tools refuses, so a registered-but-inert front would just
    // be a dead end for anyone who found it.
    ...(process.env.FEATURE_ORCHESTRATION_V2_AGENT_TOOLS === 'true'
      && process.env.FEATURE_ORCHESTRATION_V2 === 'true'
      ? { metaFrontAgent }
      : {}),
    marketingAgent,
    producerHuntDiscoveryAgent,
    producerHuntEnrichmentAgent,
    producerHuntEmailExtractionAgent,
    producerHuntDraftAgent,
    producerHuntJsonRepairAgent,
    producerHuntCloudFallbackAgent,
    salesAgent,
    analyticsAgent,
    automationArchitect,
    n8nMcpEngineer,
    codingAgent,
    codeReviewAgent,
    securityReviewAgent,
    performanceReviewAgent,
    knowledgeAgent,
    researcherAgent,
    deliberationAgent,
    chefAgent,
    contentAgent,
    huntAgent,
    designAgent,
    writerAgent,
    filmmakerAgent,
    musicianAgent,
    capabilitySmith,
  },
  scorers: {
    toolCallAppropriatenessScorer,
    completenessScorer,
    translationScorer,
    metaToolCallAppropriatenessScorer,
    marketingDraftingCompletenessScorer,
    architectRiskSoundnessScorer,
    deliberationQualityScorer,
    chefMenuQualityScorer,
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new MongoDBStore({
      id: 'mastra-mongodb-storage',
      url: process.env.MONGODB_URI || 'mongodb://localhost:27017/agentforge',
      dbName: 'agentforge',
    }),
    domains: {
      observability: observabilityStore,
    },
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(),
          new CloudExporter(),
          // Telemetry → MongoDB agent_events collection (Faza 7.6 — feeds dashboard)
          new MongoTelemetryExporter(),
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
          new SpanPayloadTruncator({ maxStringLength: 4096 }),
        ],
      },
    },
  }),
  workspace: new Workspace({
    filesystem: new LocalFilesystem({ basePath: '/projekty/splot-projects' }),
    sandbox: new LocalSandbox({
      workingDirectory: '/projekty/splot-projects',
      // bwrap nie dziala na tym hoscie (Permission denied przy uid map).
      // Spojnie z coding-workspace: env-driven, default 'none'.
      isolation:
        process.env.META_SANDBOX_ISOLATION === 'bwrap' ||
        process.env.META_SANDBOX_ISOLATION === 'seatbelt'
          ? process.env.META_SANDBOX_ISOLATION
          : 'none',
      nativeSandbox: {
        allowNetwork: true,
      },
    }),
    tools: {
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: 'read_file' },
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { name: 'write_file' },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: 'list_files' },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: 'search_content' },
      // SANDBOX.EXECUTE_COMMAND DEZAKTYWOWANY — emituje data-workspace-metadata
      // + data-sandbox-exit, ktore w Mastra v1.31/1.32 lamia persistencje text part.
      // Zastapione custom toolem `metaExecuteCommandTool` (child_process.spawn) w meta-agent.
    },
  }),
  // editor: new MastraEditor(), — WYŁĄCZONE: pakiet @mastra/editor v0.7.24 w metodzie applyStoredOverrides
  // powoduje RangeError: Maximum call stack size exceeded przy forkowaniu agentów / dynamicznych narzędziach.
  // Mastra Studio (UI czatu i workflow na porcie 4111) działa w 100% poprawnie bez tego modułu.
});

// Durable Orchestration V2 (flag-gated): when enabled, run registered agents as
// V2 workers *inside* the app runtime via mastra.getAgent (resolves the PR-18
// finding that registered agents cannot run standalone). Skeleton routing sends
// every job to ORCHESTRATION_V2_DEFAULT_AGENT with the job goal as the prompt;
// real capability routing is Fala 6-8. No effect unless the flag is on.
if (process.env.FEATURE_ORCHESTRATION_V2 === 'true') {
  const defaultAgentId = process.env.ORCHESTRATION_V2_DEFAULT_AGENT ?? 'weatherAgent';
  // Governance profile for the V2 worker. OFF = bare `agent.generate` (historic
  // behavior). ON = full harness profile (depth, reflector, liveness, pending
  // messages, tool envelopes), so a capability migrated onto V2 is not LESS
  // governed than the same agent reached through legacy delegation. Keep this on
  // before routing any real capability through V2 — see docs/ORCHESTRATION-V2.md.
  const useHarnessWorker = process.env.FEATURE_ORCHESTRATION_V2_HARNESS_WORKER === 'true';
  // F5B: the agentic Lane Orchestrator (§4.2). OFF = deterministic planning
  // (one SERIAL task, no model in the lane at all) exactly as before. ON = a
  // model chooses what each activation does, bounded by the activation's own
  // business cutoff and validated before anything is frozen or committed; an
  // unusable decision degrades to the deterministic one with an operator alert.
  const useLaneOrchestrator = process.env.FEATURE_ORCHESTRATION_V2_LANE_ORCHESTRATOR === 'true';
  // F6: route legacy async delegation onto durable jobs instead of
  // `void executeDelegation`. OFF = production keeps the fire-and-forget lane,
  // unchanged. See services/durable-delegation.ts.
  const useDurableDelegation = durableDelegationEnabled();
  // F6 work item 2: run the Automation Golden Path as a durable job (native
  // capability) instead of `void executeAutomationJob`. OFF = the legacy lane,
  // which now at least has a cross-process cancel and durable checkpoints.
  const useDurableAutomation = durableAutomationJobsEnabled();
  // Capabilities that run as CODE. Registered here, at the composition root, for
  // the same reason the agent allowlist is: a name a model produced must only
  // ever select from this map, never extend it.
  const nativeExecutors: Record<string, NativeCapabilityExecutor> = useDurableAutomation
    ? { [AUTOMATION_GOLDEN_PATH_CAPABILITY]: automationGoldenPathExecutor }
    : {};
  const getRegistryAgent = (id: string): RegistryAgent | undefined => {
    try { return mastra.getAgent(id as never) as unknown as RegistryAgent; }
    catch { return undefined; }
  };
  // Capability→agent routing. The registry is built ONCE here, from the Agent
  // Board filtered by what this process can actually resolve, and the SAME
  // object both feeds the lane's menu and resolves the route at dispatch time —
  // so the lane can never be offered a specialist the worker cannot run.
  const capabilities = buildCapabilityRegistry({
    allow: parseCapabilityAllowlist(process.env.ORCHESTRATION_V2_CAPABILITIES),
    isAvailable: (id) => getRegistryAgent(id) !== undefined,
    defaultAgentId,
  });
  configureV2Mount({
    // How long a chosen specialist gets. One constant for everyone cut chefAgent
    // (latencyClass: long) at 296s before it produced any text at all.
    attemptCapFor: (name) => {
      // A native capability has no Agent Board card, so the registry would hand
      // it the store default (300s) — a third of what the Golden Path has always
      // been given. Its owner declares its own window.
      if (name === AUTOMATION_GOLDEN_PATH_CAPABILITY) return AUTOMATION_GOLDEN_PATH_ATTEMPT_CAP_MS;
      const progressive = capabilities.progressiveAttemptPolicyFor(name);
      // A bare Agent caller cannot observe trusted Writer tool results. Keep the
      // historical fixed initial window instead of freezing a misleading 45m
      // policy that has no path capable of earning it.
      return progressive && !useHarnessWorker
        ? progressive.initialWindowMs
        : capabilities.attemptCapMsFor(name);
    },
    ...(useHarnessWorker
      ? {
          progressiveAttemptFor: (name: string | null) => (
            capabilities.progressiveAttemptPolicyFor(name)
          ),
        }
      : {}),
    // Which capabilities must come back with a STORED DOCUMENT, not prose.
    //
    // Read from the Agent Board's `outputArtifacts` here, at the composition
    // root, because the substrate treats a capability name as opaque. A `*_ref`
    // is by definition a pointer to a file, so for those a text-only result is
    // not a weak deliverable — it is the wrong kind of thing. chefAgent once
    // finished COMPLETED holding "Projekt utworzony. Uzupełniam profil…".
    expectsArtifact: (name) => (agentBoard[name ?? '']?.outputArtifacts ?? [])
      .some((type: string) => type.endsWith('_ref')),
    ...(useLaneOrchestrator
      ? {
          laneDecider: createModelLaneDecider({
            callModel: createMastraAgentCaller(laneOrchestratorAgent as never),
            capabilities: capabilities.forDecider(),
          }),
        }
      : {}),
    worker: nativeCapabilityWorker({
      // A capability may name a FUNCTION instead of an agent — the Automation
      // Golden Path is a deploy/test/repair pipeline, and giving it durable
      // attempts and a real stop barrier should not require pretending it is a
      // conversation. Closed and code-owned, exactly like the agent allowlist.
      executors: nativeExecutors,
      fallback: createRegistryWorker({
        getAgent: getRegistryAgent,
        // Without the lane orchestrator no capability is ever frozen, so this
        // degrades to exactly the previous single-target behaviour.
        route: capabilityRoute({
          resolve: (name) => capabilities.resolve(name),
          defaultAgentId,
          // Turns on the headless output contract: every specialist here was
          // written for a conversation, and a job has nobody to talk to.
          deliverableFor: (name) => capabilities.deliverableFor(name),
        }),
        ...(useHarnessWorker ? { makeCaller: harnessCallerFactory } : {}),
      }),
    }),
    // F6 cutover: settled durable jobs are copied back into their legacy
    // contracts from here. Lives on the reconcile tick because the stores are
    // different databases — no transaction can span them, so each bridge is a
    // polled projection with an idempotency key, not a callback.
    ...(useDurableDelegation || useDurableAutomation
      ? {
          afterReconcile: async () => {
            if (useDurableDelegation) await runDelegationCompletionBridge();
            if (useDurableAutomation) await runAutomationCompletionBridge();
          },
        }
      : {}),
    // F6 work item 4: the operator's "stop background lanes" has to reach the
    // work that was just migrated off the legacy loops that used to honour it.
    // Pause only — in-flight attempts settle; killing them is `cancel`.
    pauseDispatch: () => isKillSwitchActive(),
  });
  if (useDurableDelegation) {
    // The SAME registry that feeds the lane menu and the dispatch router decides
    // whether a legacy delegation may be routed durably. A capability the router
    // cannot resolve would be silently sent to the DEFAULT agent — for a pinned
    // delegation that means legacy asked for chefAgent and got someone else — so
    // the check happens here, before anything is accepted.
    configureDurableDelegation({
      resolveCapability: (agentId) => capabilities.resolve(agentId),
      getStore: () => getV2Store(),
      accept: (client, db, input) => acceptStartCommand(client, db, input),
      readStatus: (db, resourceId, jobId) => getJobStatus(db, resourceId, jobId) as never,
      readResult: (db, resourceId, jobId) => getJobResult(db, resourceId, jobId) as never,
    });
  }
  if (useDurableAutomation) {
    configureDurableAutomationJobs({
      getStore: () => getV2Store(),
      accept: (client, db, input) => acceptStartCommand(client, db, input),
      cancel: (client, db, input) => cancelJob(client, db, input),
      readStatus: (db, resourceId, jobId) => getJobStatus(db, resourceId, jobId) as never,
      readResult: (db, resourceId, jobId) => getJobResult(db, resourceId, jobId) as never,
    });
  }
  console.log(
    `[orch-v2] worker profile: ${useHarnessWorker ? 'HARNESS (depth+reflector+liveness)' : 'bare agent.generate'}`
    + ` | lane: ${useLaneOrchestrator ? 'AGENTIC (model decides)' : 'deterministic (single SERIAL task)'}`
    + ` | earned-time: ${useHarnessWorker ? 'enabled for frozen policies' : 'disabled (fixed initial windows)'}`
    + ` | delegation: ${useDurableDelegation ? 'DURABLE (V2 jobs, legacy fallback)' : 'legacy (void executeDelegation)'}`
    + ` | automation: ${useDurableAutomation ? 'DURABLE (native capability)' : 'legacy (void executeAutomationJob)'}`,
  );
  // Start the store + lane/worker/reconciler loops eagerly. Without this they
  // only spin up on the first AUTHENTICATED HTTP request, so a restarted server
  // would leave already-accepted jobs idle and a non-HTTP producer (the durable-
  // job agent tools) would never be executed at all. Fire-and-forget: a failure
  // is logged inside and must not block boot.
  void startV2Mount();
}


function registerGateway(gateway: any) {
  mastra.addGateway(gateway);
  if (!defaultGateways.some((g: any) => g.id === gateway.id)) {
    (defaultGateways as any[]).push(gateway);
  }
}

registerGateway(new OllamaGateway());

// ── OpenRouter: paid models + live zero-price catalogue ──
if (process.env.OPENROUTER_API_KEY) {
  registerGateway(new OpenRouterGateway());
  console.log('[Mastra] OpenRouter gateway registered (paid + dynamic free catalogue)');
} else {
  console.log('[Mastra] OpenRouter gateway skipped (OPENROUTER_API_KEY not set)');
}

// ── DeepSeek: cloud (OpenAI-compatible) ──
if (process.env.DEEPSEEK_API_KEY) {
  registerGateway(new DeepSeekGateway());
  console.log('[Mastra] DeepSeek gateway registered');
} else {
  console.log('[Mastra] DeepSeek gateway skipped (DEEPSEEK_API_KEY not set)');
}

// ── Groq: cloud native ──
if (process.env.GROQ_API_KEY) {
  registerGateway(new GroqGateway());
  console.log('[Mastra] Groq native gateway registered');
} else {
  console.log('[Mastra] Groq native gateway skipped (GROQ_API_KEY not set)');
}

// ── ZenMux: cloud aggregator (OpenAI-compatible) ──
if (process.env.ZENMUX_API_KEY) {
  registerGateway(new ZenMuxGateway());
  console.log('[Mastra] ZenMux gateway registered');
} else {
  console.log('[Mastra] ZenMux gateway skipped (ZENMUX_API_KEY not set)');
}


// ── Dashboard approval auth (Z35): warn once if the approve endpoint is open ──
if (!process.env.DASHBOARD_APPROVAL_TOKEN?.trim()) {
  console.warn(
    '[security] DASHBOARD_APPROVAL_TOKEN not set — POST /dashboard/approvals/:id/approve ' +
    'accepts any request with no authorization. Set DASHBOARD_APPROVAL_TOKEN in .env to require ' +
    'a Bearer token before this endpoint is reachable from outside localhost.',
  );
}

// ── Self-healing: Global Error Handlers (Etap 7) ──
initGlobalErrorHandlers();

// ── GPU Guard: VRAM Protection (Etap 8) ──
initGpuGuard();

initModelAvailability().catch((err) =>
  console.error('[ModelAvailability] Startup check failed:', (err as Error).message),
);

// ── Mongo TTL Indexes (Phase 0 — Bug #2.9) ──
import { ensureIndexes } from './lib/mongo-indexes.js';
ensureIndexes().catch((err) =>
  console.error('[MongoIndexes] Failed to ensure indexes:', (err as Error).message),
);

// ── Skill Registry (Phase 2.2) ──
// NOTE: import.meta.dirname resolves to .mastra/output/ in bundled mode,
// so we use explicit source path to find _skills/ directory.
import { getSkillRegistry } from './services/skill-registry.js';
const SKILLS_DIR = process.env.MASTRA_SKILLS_DIR
  ? resolve(process.env.MASTRA_SKILLS_DIR)
  : resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', '_skills');
// Etap 7 (CGP) — restore previously attached MCP capabilities (fail-soft).
import('./services/capability-attach.js')
  .then(({ reattachApprovedCapabilities }) => reattachApprovedCapabilities())
  .catch((err) => console.warn('[CapabilityAttach] startup reattach failed:', (err as Error).message));

getSkillRegistry().initialize(SKILLS_DIR).catch((err) =>
  console.error('[SkillRegistry] Initialization failed:', (err as Error).message),
);

// ── Repo Indexer (Phase 5 — Structural Code Navigation) ──
import { getRepoIndexer } from './services/repo-indexer.js';
getRepoIndexer('/projekty/mastra-agentic-environment/agentic-agents').index().then((result) =>
  console.log(`[RepoIndexer] Startup scan: ${result.total} files, ${result.indexed} indexed in ${result.durationMs}ms`),
).catch((err) =>
  console.error('[RepoIndexer] Startup scan failed:', (err as Error).message),
);

// ── Periodic Worker Manager (P2 — cyclic health/model/cache/telemetry/memory) ──
import { getPeriodicWorkerManager } from './services/periodic-worker-manager.js';
try {
  getPeriodicWorkerManager().startAll();
} catch (err) {
  console.error('[PeriodicWorkerManager] Startup failed:', (err as Error).message);
}

// ── Telegram Native Gateway (flag-gated, default OFF — see harness-flags.ts) ──
import { startTelegramNativeGateway, stopTelegramNativeGateway } from './services/telegram-native-gateway.js';
try {
  startTelegramNativeGateway();
} catch (err) {
  console.error('[TelegramNativeGateway] Startup failed:', (err as Error).message);
}

// ── Scheduled Task Runner (Universal Task Orchestrator) ──
import { startScheduledTaskRunnerInProcess, stopScheduledTaskRunnerInProcess } from './scripts/scheduled-task-runner.js';
try {
  startScheduledTaskRunnerInProcess(mastra);
} catch (err) {
  console.error('[ScheduledTaskRunner] Startup failed:', (err as Error).message);
}

// ── Graceful Shutdown for Dev/Hot-Reload ──
function cleanupAndExit(signal: string) {
  console.log(`[Mastra] Otrzymano sygnał ${signal}. Zamykanie zasobów przed restartem (Graceful Shutdown)...`);
  try {
    getPeriodicWorkerManager().stopAll();
  } catch {
    // best-effort: never block shutdown on worker teardown
  }
  try {
    stopTelegramNativeGateway();
  } catch {
    // best-effort: never block shutdown on gateway teardown
  }
  try {
    stopScheduledTaskRunnerInProcess();
  } catch {
    // best-effort: never block shutdown on task runner teardown
  }
  // Zmuszamy proces do całkowitego zakończenia, co uwalnia porty (np. 4111) oraz zdejmuje locki z DuckDB.
  // Środowisko deweloperskie (nodemon / mastra dev) automatycznie uruchomi nowy proces po tym, jak ten zginie.
  process.exit(0);
}

process.once('SIGUSR2', () => cleanupAndExit('SIGUSR2')); // Nodemon / TS-node dev restart
process.once('SIGTERM', () => cleanupAndExit('SIGTERM')); // Systemctl stop / standard kill
process.once('SIGINT', () => cleanupAndExit('SIGINT'));   // Ctrl+C
