import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { getWorkspacePath } from '../../workspaces/code-workspace.js';
import { recordFileActivity } from '../../services/file-activity.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { compactHarnessOutput } from '../../services/harness-output-compactor.js';
import { startBackgroundTask } from '../../services/background-task-manager.js';
import { requireCodingTaskId, resolveCodingTaskId,
  normalizeCodingScope,
  appendScopeNote,
} from './coding-task-scope.js';
import { classifyCommand, isUnattendedSafeCommand } from '../../workspaces/command-safety.js';
import {
  assertSubtaskArtifactMutationMatched,
  currentSubtaskArtifactLease,
  staleSubtaskArtifactMessage,
  subtaskArtifactMutationFilter,
} from '../../services/subtask-artifact-fence.js';

const execAsync = promisify(exec);

const CODE_TASK_STATUSES = [
  'planning',
  'editing',
  'testing',
  'reviewing',
  'waiting_approval',
  'done',
  'failed',
] as const;

const CODE_AGENT_IDS = ['codingAgent', 'codeReviewAgent', 'metaAgent'] as const;
const REVIEW_VERDICTS = ['approve', 'needs_changes', 'block'] as const;
const TEST_STATUSES = ['passed', 'failed', 'skipped'] as const;

const fileChangeSchema = z.object({
  path: z.string(),
  beforeHash: z.string(),
  afterHash: z.string(),
  summary: z.string(),
  // Which subtask made this change (J2 step 1). Optional on purpose: a
  // single-agent run has no subtask, and entries written before attribution
  // existed have none either. `collectSubtaskResult` uses it to tell a
  // subtask's own work from its parallel neighbour's.
  subtaskId: z.string().optional(),
});

const commandRunSchema = z.object({
  command: z.string(),
  approvalRequired: z.boolean(),
  exitCode: z.number().optional(),
  summary: z.string(),
  // Same compatibility rule as filesChanged: direct/single-agent and legacy
  // command entries may have no subtask, while dispatch writes are attributed
  // from the harness run by normalizeCodingScope.
  subtaskId: z.string().optional(),
  outputPreview: z.string().optional(),
  outputArtifactId: z.string().optional(),
  outputTruncated: z.boolean().optional(),
});

const approvalRequestSchema = z.object({
  approvalId: z.string(),
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
});

const testResultSchema = z.object({
  command: z.string(),
  status: z.enum(TEST_STATUSES),
  summary: z.string(),
  outputArtifactId: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  originalBytes: z.number().optional(),
  previewBytes: z.number().optional(),
});

const subtaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  targetFiles: z.array(z.string()),
  type: z.enum(['edit', 'create', 'delete', 'test', 'config']),
  priority: z.number(),
  estimatedComplexity: z.enum(['trivial', 'simple', 'moderate', 'complex']).optional(),
  dependencies: z.array(z.string()),
  // ── Model routing (populated by Smart Router, not by LLM) ──
  assignedModel: z.string().optional().describe('Model ID assigned by router, e.g. ollama/local/qwen3:1.7b'),
  parallelGroup: z.number().optional().describe('Execution group number — subtasks in same group run concurrently'),
  estimatedVramMb: z.number().optional().describe('VRAM needed for assigned model'),
});

const diagnosticPlanSchema = z.object({
  rootCause: z.string(),
  hypothesis: z.string(),
  impactAnalysis: z.object({
    errorFile: z.string(),
    errorLine: z.number().optional(),
    directFiles: z.array(z.string()),
    dependentFiles: z.array(z.string()),
    testFiles: z.array(z.string()),
    configFiles: z.array(z.string()),
  }),
  riskLevel: z.enum(['low', 'medium', 'high']),
  riskJustification: z.string(),
  subtasks: z.array(subtaskSchema),
  verificationPlan: z.object({
    commands: z.array(z.string()),
    expectedOutcome: z.string(),
  }),
});

const codeTaskArtifactSchema = z.object({
  taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
  status: z.enum(CODE_TASK_STATUSES),
  agentId: z.enum(CODE_AGENT_IDS),
  userRequest: z.string(),
  plan: z.array(z.string()),
  filesRead: z.array(z.string()),
  filesChanged: z.array(fileChangeSchema),
  commandsRun: z.array(commandRunSchema),
  approvalsRequested: z.array(approvalRequestSchema),
  worktreePath: z.string().optional(),
  branchName: z.string().optional(),
  diffSummary: z.string(),
  testResult: testResultSchema.optional(),
  diagnosticPlan: diagnosticPlanSchema.optional(),
  reviewVerdict: z.enum(REVIEW_VERDICTS).optional(),
  rollbackAvailable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const compressedFileChangeSchema = z.object({
  path: z.string(),
  summary: z.string(),
});

const compressedArtifactSchema = codeTaskArtifactSchema.omit({ filesChanged: true }).extend({
  filesChanged: z.array(compressedFileChangeSchema),
});

type CodeTaskArtifact = z.infer<typeof codeTaskArtifactSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeArtifact(doc: Record<string, unknown>): CodeTaskArtifact {
  return {
    taskId: String(doc.taskId),
    status: doc.status as CodeTaskArtifact['status'],
    agentId: doc.agentId as CodeTaskArtifact['agentId'],
    userRequest: String(doc.userRequest ?? ''),
    plan: Array.isArray(doc.plan) ? doc.plan.map(String) : [],
    filesRead: Array.isArray(doc.filesRead) ? doc.filesRead.map(String) : [],
    filesChanged: Array.isArray(doc.filesChanged) ? doc.filesChanged as CodeTaskArtifact['filesChanged'] : [],
    commandsRun: Array.isArray(doc.commandsRun) ? doc.commandsRun as CodeTaskArtifact['commandsRun'] : [],
    approvalsRequested: Array.isArray(doc.approvalsRequested)
      ? doc.approvalsRequested as CodeTaskArtifact['approvalsRequested']
      : [],
    worktreePath: typeof doc.worktreePath === 'string' ? doc.worktreePath : undefined,
    branchName: typeof doc.branchName === 'string' ? doc.branchName : undefined,
    diffSummary: String(doc.diffSummary ?? ''),
    testResult: doc.testResult as CodeTaskArtifact['testResult'],
    diagnosticPlan: doc.diagnosticPlan as CodeTaskArtifact['diagnosticPlan'],
    reviewVerdict: doc.reviewVerdict as CodeTaskArtifact['reviewVerdict'],
    rollbackAvailable: Boolean(doc.rollbackAvailable),
    createdAt: String(doc.createdAt),
    updatedAt: String(doc.updatedAt),
  };
}


/**
 * A refusal that says what KIND of command was refused.
 *
 * The previous message printed the whole allowlist, which told a model what it
 * could run instead but never what was wrong with what it tried — and the two
 * copies of that list printed different allowlists for the same tool.
 */
function describeRefusedCommand(command: string): string {
  const klass = classifyCommand(command);
  const why = klass === 'unknown'
    ? 'it is not a recognised read-only or verification command'
    : `it is classified as ${klass.replace('_', ' ')}`;
  return `Command refused: ${why}. An unattended run may execute read-only and `
    + 'verification commands (tsc, tests, lint, build, npm run check:*). For anything '
    + 'else use system_request_approval, or bg_task for a long-running job.';
}

export const createCodeTaskArtifactTool = createTool({
  id: 'coding_create_artifact',
  description:
    'Creates a code task artifact: plan, files, commands, diff, test results, and rollback status. Call at the beginning of each coding task.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional task ID. If empty, the tool will generate a UUID.'),
    userRequest: z.string().min(1).describe('The original user request or a concise task description.'),
    agentId: z.enum(CODE_AGENT_IDS).optional().default('codingAgent'),
    plan: z.array(z.string()).optional().default([]),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string().optional(),
    artifact: codeTaskArtifactSchema.optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const timestamp = nowIso();
      // A random id here was right when nothing else knew the task; inside a
      // durable job it would key the artifact to a number the job cannot find.
      const taskId = resolveCodingTaskId(context.taskId) ?? randomUUID();
      const artifact: CodeTaskArtifact = {
        taskId,
        status: 'planning',
        agentId: context.agentId ?? 'codingAgent',
        userRequest: context.userRequest,
        plan: normalizeStringList(context.plan) ?? [],
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
        approvalsRequested: [],
        diffSummary: '',
        rollbackAvailable: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await db.collection('code_task_artifacts').insertOne(artifact);

      return {
        success: true,
        taskId,
        artifact,
        message: `Task artifact created: ${taskId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to create code task artifact.',
        error: (error as Error).message,
      };
    }
  },
});

export const updateCodeTaskArtifactTool = createTool({
  id: 'coding_update_artifact',
  description:
    'Updates a code task artifact. Under a subtask lease, filesChanged and commandsRun are ignored because tools own those factual registries; plan, filesRead and approvalsRequested are added to the existing lists. Without a lease, provided fields replace previous values.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
    status: z.enum(CODE_TASK_STATUSES).optional(),
    plan: z.array(z.string()).optional(),
    filesRead: z.array(z.string()).optional(),
    filesChanged: z.array(fileChangeSchema).optional(),
    commandsRun: z.array(commandRunSchema).optional(),
    approvalsRequested: z.array(approvalRequestSchema).optional(),
    diffSummary: z.string().optional(),
    testResult: testResultSchema.optional(),
    diagnosticPlan: diagnosticPlanSchema.optional(),
    reviewVerdict: z.enum(REVIEW_VERDICTS).optional(),
    rollbackAvailable: z.boolean().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    artifact: codeTaskArtifactSchema.optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const lease = currentSubtaskArtifactLease(context.taskId);
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      const addToSet: Record<string, { $each: unknown[] }> = {};

      if (context.status) set.status = context.status;
      if (lease) {
        if (context.plan) addToSet.plan = { $each: normalizeStringList(context.plan) ?? [] };
        if (context.filesRead) addToSet.filesRead = { $each: normalizeStringList(context.filesRead) ?? [] };
        if (context.approvalsRequested) {
          addToSet.approvalsRequested = { $each: context.approvalsRequested };
        }

        const ignoredRegistries = [
          ...(context.filesChanged !== undefined ? ['filesChanged'] : []),
          ...(context.commandsRun !== undefined ? ['commandsRun'] : []),
        ];
        if (ignoredRegistries.length > 0) {
          console.warn(
            `[coding_update_artifact] ${context.taskId}/${lease.subtaskId}: ignored model-provided `
            + `${ignoredRegistries.join(', ')} under a subtask lease; tool-owned registries are unchanged.`,
          );
        }
      } else {
        if (context.plan) set.plan = normalizeStringList(context.plan) ?? [];
        if (context.filesRead) set.filesRead = normalizeStringList(context.filesRead) ?? [];
        if (context.filesChanged) set.filesChanged = context.filesChanged;
        if (context.commandsRun) set.commandsRun = context.commandsRun;
        if (context.approvalsRequested) set.approvalsRequested = context.approvalsRequested;
      }
      if (context.diffSummary !== undefined) set.diffSummary = context.diffSummary;
      if (context.testResult) set.testResult = context.testResult;
      if (context.diagnosticPlan) set.diagnosticPlan = context.diagnosticPlan;
      if (context.reviewVerdict) set.reviewVerdict = context.reviewVerdict;
      if (context.rollbackAvailable !== undefined) set.rollbackAvailable = context.rollbackAvailable;

      const update: Record<string, unknown> = { $set: set };
      if (Object.keys(addToSet).length > 0) update.$addToSet = addToSet;
      const result = await db.collection('code_task_artifacts').findOneAndUpdate(
        subtaskArtifactMutationFilter(context.taskId),
        update,
        { returnDocument: 'after' },
      );

      if (!result) {
        return {
          success: false,
          taskId: context.taskId,
          message: staleSubtaskArtifactMessage(context.taskId),
        };
      }

      return {
        success: true,
        taskId: context.taskId,
        artifact: normalizeArtifact(result),
        message: `Artifact ${context.taskId} updated.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        message: 'Failed to update code task artifact.',
        error: (error as Error).message,
      };
    }
  },
});

export const getCodeTaskArtifactTool = createTool({
  id: 'coding_get_artifact',
  description: 'Retrieves a code task artifact by taskId. The artifact is compressed (omits ledger hashes) to protect the LLM context window.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    artifact: compressedArtifactSchema.optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return {
          success: false,
          taskId: context.taskId,
          message: `Artifact ${context.taskId} does not exist.`,
        };
      }

      const normalized = normalizeArtifact(artifact);
      const compressedArtifact = {
        ...normalized,
        filesChanged: normalized.filesChanged.map((f) => ({
          path: f.path,
          summary: f.summary,
        })),
      };

      return {
        success: true,
        taskId: context.taskId,
        artifact: compressedArtifact,
        message: `Artifact ${context.taskId} retrieved and compressed.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        message: 'Failed to retrieve code task artifact.',
        error: (error as Error).message,
      };
    }
  },
});

export const runTestCommandTool = createTool({
  id: 'coding_run_test',
  description: 'Runs a test command (e.g., npm test, npx tsc) in the root repository directory and saves the result to artifact.testResult and commandsRun.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
    command: z.string().describe('Command to run, e.g. npx tsc --noEmit'),
    summary: z.string().describe('Short purpose of the test, e.g., Syntax verification'),
    background: z.boolean().optional().default(false).describe('Run in background as a durable background task. Returns bgTaskId immediately.'),
    wake: z.boolean().optional().default(true).describe('If background=true, notify the agent with a pending message upon completion.'),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    exitCode: z.number().optional(),
    output: z.string(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    bgTaskId: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'coding_run_test',
    category: 'shell',
    risk: 'medium',
    normalizeInput: normalizeCodingScope,
    // Tell the MODEL when the run overruled the id it named — see `scopeOverrideNote`.
    modelOutput: appendScopeNote,
    policy: (context, metadata) => ({
      action: 'run_command',
      command: context.command,
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: metadata.agentId,
      threadId: context.threadId,
      runId: metadata.runId,
      turnId: metadata.turnId,
    }),
    execute: async (rawContext) => {
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return {
          success: false,
          taskId: context.taskId,
          output: '',
          message: `Artifact ${context.taskId} does not exist.`,
        };
      }

      // ── Background mode ──
      if (context.background) {
        const command = context.command.trim();
        // One classification, shared with the workspace gate and the harness
        // policy (`workspaces/command-safety.ts`). This list and the one 40 lines
        // below were the same allowlist twice, and had already drifted: only this
        // copy carried `npm run check`, the gate E7-BUILD requires.
        if (!isUnattendedSafeCommand(command)) {
          return {
            success: false,
            taskId: context.taskId,
            output: '',
            message: describeRefusedCommand(command),
          };
        }

        const workspacePath = await getWorkspacePath(context.taskId);
        const bgRecord = await startBackgroundTask({
          command,
          cwd: workspacePath,
          ownerTaskId: context.taskId,
          agentId: context.agentId ?? 'codingAgent',
          wake: context.wake ?? true,
          notify: false,
        });

        return {
          success: true,
          taskId: context.taskId,
          output: '',
          bgTaskId: bgRecord.taskId,
          message: `Test started in background: ${bgRecord.taskId}. Use bg_task(action='status', taskId='${bgRecord.taskId}') to check progress.${context.wake ? ' You will be notified on completion.' : ''}`,
        };
      }

      // ── Command safety (Phase 0 — Bug #2.5), now one shared classification ──
      const command = context.command.trim();
      if (!isUnattendedSafeCommand(command)) {
        return {
          success: false,
          taskId: context.taskId,
          output: '',
          message: describeRefusedCommand(command),
        };
      }

      let exitCode = 0;
      let output = '';
      let status: 'passed' | 'failed' = 'passed';

      try {
        const workspacePath = await getWorkspacePath(context.taskId);
        const { stdout, stderr } = await execAsync(command, { cwd: workspacePath, timeout: 60000 });
        output = stdout || stderr;
      } catch (err: any) {
        exitCode = err.code ?? 1;
        output = err.stdout || err.stderr || err.message;
        status = 'failed';
      }

      const timestamp = nowIso();
      const compaction = await compactHarnessOutput({
        text: output,
        kind: 'command_log',
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        runId: context.runId,
        turnId: context.turnId,
        toolId: 'coding_run_test',
        metadata: {
          command,
          exitCode,
          status,
          summary: context.summary,
        },
      });

      const newCommandRun = {
        command: context.command,
        approvalRequired: false,
        exitCode,
        summary: context.summary,
        ...(context.subtaskId ? { subtaskId: context.subtaskId } : {}),
        outputPreview: compaction.preview,
        outputArtifactId: compaction.fullTextArtifactId,
        outputTruncated: compaction.truncated,
      };

      const testResult = {
        command: context.command,
        status,
        summary: compaction.preview,
        outputArtifactId: compaction.fullTextArtifactId,
        outputTruncated: compaction.truncated,
        originalBytes: compaction.originalBytes,
        previewBytes: compaction.previewBytes,
      };

      const artifactUpdate = await db.collection('code_task_artifacts').updateOne(
        subtaskArtifactMutationFilter(context.taskId),
        {
          $push: { commandsRun: newCommandRun } as any,
          $set: {
            testResult,
            updatedAt: timestamp,
          },
        }
      );
      assertSubtaskArtifactMutationMatched(
        context.taskId,
        artifactUpdate.matchedCount,
        'append test result',
      );
      await recordFileActivity({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        op: 'test',
        summary: `${context.summary}: ${command} (${status})`,
        diffPreview: compaction.preview,
      });

      return {
        success: exitCode === 0,
        taskId: context.taskId,
        exitCode,
        output: compaction.preview,
        outputArtifactId: compaction.fullTextArtifactId,
        outputTruncated: compaction.truncated,
        originalBytes: compaction.originalBytes,
        previewBytes: compaction.previewBytes,
        message: exitCode === 0 ? 'Test completed successfully.' : 'Test returned errors.',
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        output: '',
        message: 'Failed to execute test.',
        error: (error as Error).message,
      };
    }
    },
  }),
});

export const submitReviewTool = createTool({
  id: 'coding_submit_review',
  description: 'Saves the code review verdict in the task artifact (approve, needs_changes, block). Used by CodeReviewAgent.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
    verdict: z.enum(REVIEW_VERDICTS),
    summary: z.string().describe('Justification for the decision (required)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return {
          success: false,
          taskId: context.taskId,
          message: `Artifact ${context.taskId} does not exist.`,
        };
      }

      const artifactUpdate = await db.collection('code_task_artifacts').updateOne(
        subtaskArtifactMutationFilter(context.taskId),
        {
          $set: {
            reviewVerdict: context.verdict,
            updatedAt: nowIso(),
          },
          $push: {
            plan: `[REVIEW] ${context.verdict}: ${context.summary}`,
          } as any,
        }
      );
      assertSubtaskArtifactMutationMatched(
        context.taskId,
        artifactUpdate.matchedCount,
        'append review verdict',
      );

      return {
        success: true,
        taskId: context.taskId,
        message: `Saved review verdict: ${context.verdict}.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        message: 'Failed to save review.',
        error: (error as Error).message,
      };
    }
  },
});
