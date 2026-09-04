/**
 * Replay a Mastra harness run from Mongo telemetry.
 *
 * Usage:
 *   npx tsx src/mastra/scripts/replay-harness-run.ts <runId>
 *   npx tsx src/mastra/scripts/replay-harness-run.ts <runId> --json
 */

import { closeDb, getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';

type AgentRunDoc = {
  runId: string;
  threadId?: string;
  taskId?: string;
  agentId: string;
  status: string;
  phase?: string;
  currentSubtaskId?: string;
  repoPath?: string;
  model?: string;
  safeInterruptPoint?: boolean;
  turnCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
  errorClass?: string;
  errorMessage?: string;
};

type RunEventDoc = {
  id: string;
  runId: string;
  turnId?: string;
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  type: string;
  phase?: string;
  timestamp: Date;
  durationMs?: number;
  data?: Record<string, unknown>;
  preview?: string;
  artifactId?: string;
};

type AgentEventDoc = {
  eventId: string;
  type: string;
  timestamp: Date;
  agentId?: string;
  runId?: string;
  turnId?: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  feature?: string;
  toolId?: string;
  input?: string;
  output?: string;
  status?: string;
  errorMessage?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
};

type ToolExecutionDoc = {
  id: string;
  runId?: string;
  turnId?: string;
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  toolId: string;
  category: string;
  risk: string;
  status: string;
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
  durationMs?: number;
  errorClass?: string;
  errorMessage?: string;
  createdAt: Date;
  completedAt?: Date;
  policyDecision?: unknown;
};

type HarnessArtifactDoc = {
  id: string;
  runId?: string;
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  toolId?: string;
  kind: string;
  storage: string;
  bytes: number;
  filePath?: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
};

type BackgroundTaskDoc = {
  taskId: string;
  ownerTaskId?: string;
  agentId: string;
  command: string;
  cwd: string;
  status: string;
  pid?: number;
  exitCode?: number;
  error?: string;
  wake: boolean;
  startedAt: Date;
  completedAt?: Date;
};

type ReplaySnapshot = {
  runId: string;
  run?: AgentRunDoc;
  events: RunEventDoc[];
  agentEvents: AgentEventDoc[];
  tools: ToolExecutionDoc[];
  artifacts: HarnessArtifactDoc[];
  backgroundTasks: BackgroundTaskDoc[];
};

const args = process.argv.slice(2);
const runIdArg = args.find((arg) => !arg.startsWith('--'));
const asJson = args.includes('--json');
const useLast = args.includes('--last');

async function resolveRunId(): Promise<string | undefined> {
  if (runIdArg) return runIdArg;
  if (!useLast) return undefined;

  const db = await getDb();
  const latest = await db.collection<AgentRunDoc>('agent_runs')
    .findOne({}, { sort: { updatedAt: -1 }, projection: { runId: 1 } });
  return latest?.runId;
}

async function main(): Promise<void> {
  const runId = await resolveRunId();
  if (!runId) {
    console.error('Usage: npx tsx src/mastra/scripts/replay-harness-run.ts <runId> [--json]');
    console.error('       npx tsx src/mastra/scripts/replay-harness-run.ts --last [--json]');
    process.exitCode = 1;
    return;
  }

  const snapshot = await loadReplaySnapshot(runId);
  if (asJson) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  printReplay(snapshot);
}

async function loadReplaySnapshot(targetRunId: string): Promise<ReplaySnapshot> {
  const db = await getDb();
  const run = await db.collection<AgentRunDoc>('agent_runs').findOne({ runId: targetRunId }) ?? undefined;
  const taskId = run?.taskId;
  const runOrTaskQuery = taskId
    ? { $or: [{ runId: targetRunId }, { runId: taskId }, { taskId }] }
    : { runId: targetRunId };

  const [events, agentEvents, tools, artifacts, backgroundTasks] = await Promise.all([
    db.collection<RunEventDoc>('agent_run_events')
      .find({ runId: targetRunId })
      .sort({ timestamp: 1 })
      .toArray(),
    db.collection<AgentEventDoc>('agent_events')
      .find(runOrTaskQuery)
      .sort({ timestamp: 1 })
      .limit(500)
      .toArray(),
    db.collection<ToolExecutionDoc>('tool_executions')
      .find(runOrTaskQuery)
      .sort({ createdAt: 1 })
      .limit(500)
      .toArray(),
    db.collection<HarnessArtifactDoc>('harness_artifacts')
      .find(runOrTaskQuery)
      .sort({ createdAt: 1 })
      .limit(200)
      .toArray(),
    db.collection<BackgroundTaskDoc>('background_tasks')
      .find(taskId ? { ownerTaskId: taskId } : { ownerTaskId: targetRunId })
      .sort({ startedAt: 1 })
      .limit(50)
      .toArray(),
  ]);

  return {
    runId: targetRunId,
    run,
    events,
    agentEvents: dedupeBy(agentEvents, (event) => event.eventId),
    tools: dedupeBy(tools, (tool) => tool.id),
    artifacts: dedupeBy(artifacts, (artifact) => artifact.id),
    backgroundTasks,
  };
}

function printReplay(snapshot: ReplaySnapshot): void {
  printRunSummary(snapshot);
  printModelCalls(snapshot);
  printTools(snapshot);
  printBackgroundTasks(snapshot);
  printMemory(snapshot);
  printWarnings(snapshot);
  printArtifacts(snapshot);
  printTimeline(snapshot);
}

function printRunSummary(snapshot: ReplaySnapshot): void {
  const run = snapshot.run;
  section('Run');
  if (!run) {
    console.log(`Run: ${snapshot.runId} (not found in agent_runs)`);
    console.log(`Events: ${snapshot.events.length}, Agent events: ${snapshot.agentEvents.length}, Tools: ${snapshot.tools.length}`);
    return;
  }

  console.log(`Run: ${run.runId}`);
  console.log(`Status: ${run.status}${run.phase ? ` | phase: ${run.phase}` : ''}`);
  console.log(`Task: ${run.taskId ?? '-'} | Agent: ${run.agentId} | Thread: ${run.threadId ?? '-'}`);
  console.log(`Model: ${run.model ?? '-'} | Turns: ${run.turnCount ?? 0} | Safe interrupt: ${String(run.safeInterruptPoint ?? false)}`);
  console.log(`Repo: ${run.repoPath ?? '-'}`);
  console.log(`Created: ${formatDate(run.createdAt)} | Updated: ${formatDate(run.updatedAt)}`);
  if (run.errorMessage) {
    console.log(`Error: ${run.errorClass ?? 'unknown'} - ${safe(run.errorMessage, 240)}`);
  }
}

function printModelCalls(snapshot: ReplaySnapshot): void {
  section('Model Calls');
  const completed = snapshot.events.filter((event) =>
    event.type === 'llm_call_completed' || event.type === 'llm_call_failed'
  );
  const started = snapshot.events.filter((event) => event.type === 'llm_call_started');

  if (completed.length === 0 && started.length === 0) {
    console.log('No model call events found.');
    return;
  }

  const calls = completed.length > 0 ? completed : started;
  calls.forEach((event, index) => {
    const status = event.type === 'llm_call_failed' ? 'failed' : event.type === 'llm_call_completed' ? 'completed' : 'started';
    const subtask = event.subtaskId ? ` subtask=${event.subtaskId}` : '';
    const duration = event.durationMs !== undefined ? ` ${formatDuration(event.durationMs)}` : '';
    const hashes = formatHashes(event.data);
    console.log(`${index + 1}. ${status}${duration}${subtask}${hashes}`);
    if (event.preview) console.log(indent(safe(event.preview, 360), 3));
  });
}

function printTools(snapshot: ReplaySnapshot): void {
  section('Tools');
  if (snapshot.tools.length === 0) {
    console.log('No tool executions found.');
    return;
  }

  for (const tool of snapshot.tools) {
    const duration = tool.durationMs !== undefined ? ` ${formatDuration(tool.durationMs)}` : '';
    const subtask = tool.subtaskId ? ` subtask=${tool.subtaskId}` : '';
    const artifact = tool.outputArtifactId ? ` artifact=${tool.outputArtifactId}` : '';
    console.log(`- ${tool.toolId} [${tool.status}/${tool.category}/${tool.risk}]${duration}${subtask}${artifact}`);
    const target = summarizeToolInput(tool.inputPreview);
    if (target) console.log(indent(target, 2));
    if (tool.errorMessage) console.log(indent(`error: ${safe(tool.errorMessage, 220)}`, 2));
    const policy = summarizePolicy(tool.policyDecision);
    if (policy) console.log(indent(policy, 2));
  }
}

function printBackgroundTasks(snapshot: ReplaySnapshot): void {
  section('Background Tasks');
  if (snapshot.backgroundTasks.length === 0) {
    console.log('No background tasks found.');
    return;
  }

  for (const task of snapshot.backgroundTasks) {
    const duration = task.completedAt && task.startedAt
      ? ` ${formatDuration(new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime())}`
      : '';
    const exit = task.exitCode !== undefined ? ` exit=${task.exitCode}` : '';
    const wake = task.wake ? ' wake=true' : '';
    console.log(`- ${task.taskId} [${task.status}]${duration}${exit}${wake}`);
    console.log(indent(`cmd: ${safe(task.command, 180)}`, 2));
    if (task.error) console.log(indent(`error: ${safe(task.error, 220)}`, 2));
  }
}

function printMemory(snapshot: ReplaySnapshot): void {
  section('Memory');
  const memoryEvents = snapshot.agentEvents.filter((event) =>
    event.type.startsWith('semantic_memory_') ||
    event.type === 'precontext_injected' ||
    event.type === 'memory_pending_taken' ||
    event.type === 'memory_sync_fallback_used' ||
    event.type === 'memory_suppressed'
  );
  const memoryTools = snapshot.tools.filter((tool) => tool.category === 'memory' || tool.toolId.includes('memory'));

  if (memoryEvents.length === 0 && memoryTools.length === 0) {
    console.log('No memory events found.');
    return;
  }

  for (const event of memoryEvents) {
    console.log(`- ${event.type} ${formatDate(event.timestamp)}${event.status ? ` [${event.status}]` : ''}`);
    const summary = summarizeData(event.data);
    if (summary) console.log(indent(summary, 2));
  }
  for (const tool of memoryTools) {
    console.log(`- tool ${tool.toolId} [${tool.status}] ${formatDate(tool.createdAt)}`);
  }
}

function printWarnings(snapshot: ReplaySnapshot): void {
  section('Warnings');
  const warnings = snapshot.agentEvents.filter((event) =>
    event.type === 'file_conflict_warning' ||
    event.type === 'policy_blocked' ||
    event.status === 'error'
  );
  const failedTools = snapshot.tools.filter((tool) => tool.status === 'failed' || tool.status === 'blocked');

  if (warnings.length === 0 && failedTools.length === 0) {
    console.log('No warnings found.');
    return;
  }

  for (const event of warnings) {
    console.log(`- ${event.type} ${formatDate(event.timestamp)}${event.toolId ? ` tool=${event.toolId}` : ''}`);
    const detail = event.errorMessage ?? event.output ?? event.input ?? summarizeData(event.data);
    if (detail) console.log(indent(safe(detail, 260), 2));
  }
  for (const tool of failedTools) {
    console.log(`- tool ${tool.toolId} [${tool.status}] ${tool.errorClass ?? 'unknown'}`);
    if (tool.errorMessage) console.log(indent(safe(tool.errorMessage, 260), 2));
  }
}

function printArtifacts(snapshot: ReplaySnapshot): void {
  section('Artifacts');
  if (snapshot.artifacts.length === 0) {
    console.log('No harness artifacts found.');
    return;
  }

  for (const artifact of snapshot.artifacts) {
    const location = artifact.storage === 'file' && artifact.filePath ? ` file=${artifact.filePath}` : '';
    console.log(`- ${artifact.id} kind=${artifact.kind} storage=${artifact.storage} bytes=${artifact.bytes}${location}`);
    const meta = summarizeData(artifact.metadata);
    if (meta) console.log(indent(meta, 2));
  }
}

function printTimeline(snapshot: ReplaySnapshot): void {
  section('Timeline');
  const timeline = [
    ...snapshot.events.map((event) => ({
      timestamp: event.timestamp,
      label: event.type,
      detail: event.subtaskId ? `subtask=${event.subtaskId}` : '',
    })),
    ...snapshot.agentEvents.map((event) => ({
      timestamp: event.timestamp,
      label: event.toolId ? `${event.type}:${event.toolId}` : event.type,
      detail: event.feature ?? '',
    })),
    ...snapshot.tools.map((tool) => ({
      timestamp: tool.createdAt,
      label: `tool:${tool.toolId}`,
      detail: tool.status,
    })),
  ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (timeline.length === 0) {
    console.log('No timeline events found.');
    return;
  }

  for (const item of timeline.slice(0, 120)) {
    console.log(`${formatDate(item.timestamp)}  ${item.label}${item.detail ? `  ${item.detail}` : ''}`);
  }
  if (timeline.length > 120) {
    console.log(`... ${timeline.length - 120} more events omitted`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(value: Date | string | undefined): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function safe(text: string, maxLength: number): string {
  const redacted = redactSecrets(text).text.replace(/\s+$/g, '');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}

function indent(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function formatHashes(data: Record<string, unknown> | undefined): string {
  if (!data) return '';
  const promptHash = typeof data.promptHash === 'string' ? data.promptHash.slice(0, 10) : undefined;
  const contextHash = typeof data.contextHash === 'string' ? data.contextHash.slice(0, 10) : undefined;
  if (!promptHash && !contextHash) return '';
  return ` hashes=${[promptHash, contextHash].filter(Boolean).join('/')}`;
}

function summarizeToolInput(inputPreview: string | undefined): string | undefined {
  if (!inputPreview) return undefined;
  try {
    const parsed = JSON.parse(inputPreview) as Record<string, unknown>;
    const fields = ['path', 'filePath', 'command', 'query', 'repoPath', 'taskId']
      .map((key) => typeof parsed[key] === 'string' ? `${key}=${parsed[key]}` : undefined)
      .filter(Boolean);
    return fields.length > 0 ? fields.join(' ') : safe(inputPreview, 180);
  } catch {
    return safe(inputPreview, 180);
  }
}

function summarizePolicy(policyDecision: unknown): string | undefined {
  if (!policyDecision) return undefined;
  const decisions = Array.isArray(policyDecision) ? policyDecision : [policyDecision];
  const parts = decisions
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return undefined;
      const record = entry as Record<string, unknown>;
      return [
        `policy=${String(record.matchedRule ?? 'unknown')}`,
        `allow=${String(record.allow ?? '?')}`,
        `effective=${String(record.effectiveAllow ?? '?')}`,
        `severity=${String(record.severity ?? '?')}`,
      ].join(' ');
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function summarizeData(data: Record<string, unknown> | undefined): string | undefined {
  if (!data || Object.keys(data).length === 0) return undefined;
  return safe(JSON.stringify(data), 260);
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

main()
  .catch((error) => {
    console.error(`Replay failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
