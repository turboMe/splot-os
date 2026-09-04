/**
 * Code-review-specific passive pre-context.
 *
 * This deliberately stays read-only and deterministic: it summarizes the
 * current code task artifact so the reviewer starts from task facts, while
 * current worktree tools remain authoritative during the review.
 */

import { CODE_REVIEW_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { compactHarnessOutput } from './harness-output-compactor.js';
import { tokenEstimate } from './harness-events.js';
import { tryInjectGraphifyBlastRadius } from './graphify-precontext.js';

export type ReviewPrecontextInput = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  userPrompt: string;
  maxTokens?: number;
  reviewIteration?: number;
  includeGraphify?: boolean;
};

export type ReviewPrecontextResult = {
  markdown: string;
  tokenEstimate: number;
  artifactIncluded: boolean;
  fileCount: number;
  commandCount: number;
  previousReviewCount: number;
  diffIncluded: boolean;
  testResultIncluded: boolean;
  graphifyIncluded: boolean;
  blastRadiusCount?: number;
  suppressedReasons: string[];
  artifactId?: string;
};

const DEFAULT_MAX_TOKENS = 1800;

export async function buildReviewPrecontext(
  input: ReviewPrecontextInput,
): Promise<ReviewPrecontextResult> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const includeGraphify = input.includeGraphify ?? true;
  const suppressedReasons: string[] = [];

  if (!input.taskId) {
    return emptyResult(['taskId_missing']);
  }

  let artifact: Record<string, any> | null = null;
  try {
    const db = await getDb();
    artifact = await db.collection('code_task_artifacts').findOne({ taskId: input.taskId });
  } catch (error) {
    return emptyResult([`artifact_lookup_unavailable:${(error as Error).message}`]);
  }

  if (!artifact) {
    return emptyResult(['artifact_not_found']);
  }

  const filesChanged = arrayValue(artifact.filesChanged);
  const commandsRun = arrayValue(artifact.commandsRun);
  const reviewNotes = arrayValue(artifact.plan)
    .map(String)
    .filter((entry) => entry.startsWith('[REVIEW]'))
    .slice(-5);
  const diffSummary = stringValue(artifact.diffSummary);
  const testResult = objectValue(artifact.testResult);
  const diagnosticPlan = objectValue(artifact.diagnosticPlan);

  const sections: string[] = [];

  sections.push('### Review Task');
  sections.push([
    `taskId: ${input.taskId}`,
    `iteration: ${input.reviewIteration ?? inferReviewIteration(reviewNotes)}`,
    `artifactStatus: ${stringValue(artifact.status, 'unknown')}`,
    `artifactAgent: ${stringValue(artifact.agentId, 'unknown')}`,
    artifact.reviewVerdict ? `previousVerdict: ${String(artifact.reviewVerdict)}` : '',
    artifact.branchName ? `branchName: ${String(artifact.branchName)}` : '',
    artifact.worktreePath ? `worktreePath: ${String(artifact.worktreePath)}` : '',
  ].filter(Boolean).join('\n'));
  sections.push('');

  const userRequest = stringValue(artifact.userRequest);
  if (userRequest) {
    sections.push('### Original User Request');
    sections.push(truncateLine(userRequest, 900));
    sections.push('');
  }

  if (diagnosticPlan) {
    sections.push('### Diagnostic Plan Snapshot');
    sections.push(formatDiagnosticPlan(diagnosticPlan));
    sections.push('');
  }

  sections.push('### Files Changed');
  if (filesChanged.length > 0) {
    sections.push(formatFilesChanged(filesChanged));
  } else {
    sections.push('No filesChanged entries recorded in the artifact.');
  }
  sections.push('');

  let graphifyIncluded = false;
  let blastRadiusCount = 0;
  if (includeGraphify && filesChanged.length > 0) {
    const filePaths = filesChanged
      .map((f: any) => (typeof f === 'string' ? f : f?.path || f?.file || ''))
      .filter(Boolean);
    if (filePaths.length > 0) {
      const graphifyRes = await tryInjectGraphifyBlastRadius(filePaths, { timeoutMs: 900 });
      if (graphifyRes.markdown) {
        sections.push(graphifyRes.markdown);
        sections.push('');
        graphifyIncluded = true;
        blastRadiusCount = graphifyRes.count;
      } else if (graphifyRes.suppressedReason) {
        suppressedReasons.push(graphifyRes.suppressedReason);
      }
    }
  }

  sections.push('### Verification Signals');
  if (testResult || commandsRun.length > 0) {
    if (testResult) sections.push(formatTestResult(testResult));
    if (commandsRun.length > 0) sections.push(formatCommands(commandsRun));
  } else {
    sections.push('No testResult or commandsRun entries recorded. Treat missing verification as a review signal, not proof of failure.');
  }
  sections.push('');

  if (reviewNotes.length > 0) {
    sections.push('### Previous Review Notes');
    sections.push(reviewNotes.map((entry) => `- ${truncateLine(entry, 500)}`).join('\n'));
    sections.push('');
  }

  if (diffSummary) {
    sections.push('### Artifact Diff Summary');
    sections.push('```diff');
    sections.push(truncateText(diffSummary, Math.max(1600, maxTokens * 3)));
    sections.push('```');
    sections.push('');
  }

  sections.push('Use this passive context only as orientation. Current worktree diff and file reads have priority before submitting a verdict.');

  const rawMarkdown = [
    '## Code Review Passive Context',
    '',
    sections.join('\n'),
  ].join('\n');
  const safeMarkdown = redactSecrets(rawMarkdown).text;
  const compacted = await compactHarnessOutput({
    text: safeMarkdown,
    kind: 'memory_context',
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    threadId: input.threadId ?? input.taskId,
    agentId: canonicalizeRuntimeAgentId(input.agentId) ?? CODE_REVIEW_AGENT_ID,
    toolId: 'review_precontext',
    previewBytes: Math.max(1600, maxTokens * 4),
    metadata: { scope: 'review_precontext' },
  });
  const markdown = compacted.preview;

  return {
    markdown,
    tokenEstimate: tokenEstimate(markdown),
    artifactIncluded: true,
    fileCount: filesChanged.length,
    commandCount: commandsRun.length,
    previousReviewCount: reviewNotes.length,
    diffIncluded: Boolean(diffSummary),
    testResultIncluded: Boolean(testResult),
    graphifyIncluded,
    blastRadiusCount,
    suppressedReasons,
    artifactId: compacted.fullTextArtifactId,
  };
}

function emptyResult(suppressedReasons: string[]): ReviewPrecontextResult {
  return {
    markdown: '',
    tokenEstimate: 0,
    artifactIncluded: false,
    fileCount: 0,
    commandCount: 0,
    previousReviewCount: 0,
    diffIncluded: false,
    testResultIncluded: false,
    graphifyIncluded: false,
    blastRadiusCount: 0,
    suppressedReasons,
  };
}

function formatDiagnosticPlan(plan: Record<string, any>): string {
  const impact = objectValue(plan.impactAnalysis);
  const verification = objectValue(plan.verificationPlan);
  const lines = [
    plan.rootCause ? `rootCause: ${truncateLine(String(plan.rootCause), 500)}` : '',
    plan.hypothesis ? `hypothesis: ${truncateLine(String(plan.hypothesis), 500)}` : '',
    plan.riskLevel ? `riskLevel: ${String(plan.riskLevel)}` : '',
    plan.riskJustification ? `riskJustification: ${truncateLine(String(plan.riskJustification), 500)}` : '',
    impact?.directFiles ? `directFiles: ${formatStringList(impact.directFiles, 10)}` : '',
    impact?.dependentFiles ? `dependentFiles: ${formatStringList(impact.dependentFiles, 10)}` : '',
    impact?.testFiles ? `testFiles: ${formatStringList(impact.testFiles, 10)}` : '',
    verification?.commands ? `verificationCommands: ${formatStringList(verification.commands, 8)}` : '',
    verification?.expectedOutcome ? `expectedOutcome: ${truncateLine(String(verification.expectedOutcome), 400)}` : '',
  ];
  return lines.filter(Boolean).join('\n') || 'Diagnostic plan exists but has no recognized summary fields.';
}

function formatFilesChanged(files: any[]): string {
  return files.slice(0, 20).map((file) => {
    const path = stringValue(file?.path, '(unknown path)');
    const summary = truncateLine(stringValue(file?.summary, '(no summary)'), 220);
    return `- ${path}: ${summary}`;
  }).join('\n') + (files.length > 20 ? `\n- ... ${files.length - 20} more file(s)` : '');
}

function formatTestResult(testResult: Record<string, any>): string {
  return [
    `testResult: ${stringValue(testResult.status, 'unknown')}`,
    testResult.command ? `command: ${String(testResult.command)}` : '',
    testResult.summary ? `summary: ${truncateLine(String(testResult.summary), 500)}` : '',
    testResult.outputTruncated !== undefined ? `outputTruncated: ${Boolean(testResult.outputTruncated)}` : '',
    testResult.outputArtifactId ? `outputArtifactId: ${String(testResult.outputArtifactId)}` : '',
  ].filter(Boolean).join('\n');
}

function formatCommands(commands: any[]): string {
  const lines = commands.slice(-6).map((command) => {
    const commandText = stringValue(command?.command, '(unknown command)');
    const exitCode = command?.exitCode !== undefined ? ` exitCode=${Number(command.exitCode)}` : '';
    const summary = truncateLine(stringValue(command?.summary, ''), 220);
    return `- ${commandText}${exitCode}${summary ? `: ${summary}` : ''}`;
  });
  return ['recentCommands:', ...lines].join('\n');
}

function inferReviewIteration(reviewNotes: string[]): number {
  return Math.max(1, reviewNotes.length + 1);
}

function arrayValue(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function formatStringList(value: unknown, limit: number): string {
  const items = arrayValue(value).map(String).filter(Boolean);
  const visible = items.slice(0, limit).join(', ');
  return items.length > limit ? `${visible}, ... ${items.length - limit} more` : visible;
}

function truncateLine(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... (truncated)` : text;
}
