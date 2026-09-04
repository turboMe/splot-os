/**
 * GitHub Service (Etap 9.1)
 * Version: 1.0.1
 *
 * Central service for GitHub API interactions via @octokit/rest.
 * Handles: push branches, create PRs, check CI status, merge, cleanup.
 */

import { Octokit } from '@octokit/rest';
import { execSync } from 'child_process';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

export const GITHUB_SERVICE_VERSION = '1.0.1';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PushResult {
  success: boolean;
  branch: string;
  remote: string;
  message: string;
}

export interface PRResult {
  success: boolean;
  prNumber: number;
  prUrl: string;
  branch: string;
  message: string;
}

export interface CIStatus {
  state: 'pending' | 'success' | 'failure' | 'error' | 'unknown';
  checks: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string | null;
  }>;
  allPassed: boolean;
  message: string;
}

export interface MergeResult {
  success: boolean;
  sha: string;
  message: string;
}

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  prMode: boolean;
  autoMerge: boolean;
}

// ── Configuration ────────────────────────────────────────────────────────────

function getConfig(): GitHubConfig {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    throw new Error(
      '[GitHub] Missing config. Required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO',
    );
  }

  return {
    token,
    owner,
    repo,
    prMode: process.env.GITHUB_PR_MODE === 'true',
    autoMerge: process.env.GITHUB_AUTO_MERGE === 'true',
  };
}

let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!_octokit) {
    const config = getConfig();
    _octokit = new Octokit({ auth: config.token });
  }
  return _octokit;
}

// ── Push Branch ──────────────────────────────────────────────────────────────

/**
 * Push a local task branch to the remote origin.
 * Uses git CLI (not Octokit) since it's a local git operation.
 */
export async function pushBranch(branchName: string, repoPath?: string): Promise<PushResult> {
  const cwd = repoPath ?? AGENTIC_AGENTS_REPO;

  try {
    // Ensure we're on the right branch in the worktree
    const currentBranch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();

    if (currentBranch !== branchName) {
      // We're pushing from main repo, need to specify the branch explicitly
      execSync(`git push origin ${branchName}`, {
        cwd,
        encoding: 'utf-8',
        timeout: 60_000,
      });
    } else {
      execSync(`git push -u origin ${branchName}`, {
        cwd,
        encoding: 'utf-8',
        timeout: 60_000,
      });
    }

    console.log(`[GitHub] ✅ Pushed branch ${branchName} to origin`);

    return {
      success: true,
      branch: branchName,
      remote: 'origin',
      message: `Branch ${branchName} pushed to origin`,
    };
  } catch (error) {
    const msg = (error as Error).message;
    console.error(`[GitHub] ❌ Push failed for ${branchName}: ${msg}`);

    return {
      success: false,
      branch: branchName,
      remote: 'origin',
      message: `Push failed: ${msg.substring(0, 300)}`,
    };
  }
}

// ── Create Pull Request ──────────────────────────────────────────────────────

/**
 * Create a Pull Request on GitHub.
 */
export async function createPR(opts: {
  branch: string;
  title: string;
  body: string;
  labels?: string[];
  autoMerge?: boolean;
}): Promise<PRResult> {
  const config = getConfig();
  const octokit = getOctokit();

  try {
    const { data: pr } = await octokit.pulls.create({
      owner: config.owner,
      repo: config.repo,
      head: opts.branch,
      base: 'master',
      title: opts.title,
      body: opts.body,
    });

    console.log(`[GitHub] ✅ PR #${pr.number} created: ${pr.html_url}`);

    // Add labels if provided
    if (opts.labels && opts.labels.length > 0) {
      try {
        await octokit.issues.addLabels({
          owner: config.owner,
          repo: config.repo,
          issue_number: pr.number,
          labels: opts.labels,
        });
      } catch (labelErr) {
        // Non-fatal: labels might not exist yet
        console.warn(`[GitHub] Labels failed (non-fatal): ${(labelErr as Error).message}`);
      }
    }

    // Enable auto-merge if requested and configured
    if (opts.autoMerge ?? config.autoMerge) {
      try {
        // Auto-merge requires branch protection + "Allow auto-merge" in repo settings
        // For now, we'll just log the intent — actual auto-merge via GraphQL
        console.log(`[GitHub] Auto-merge requested for PR #${pr.number} (requires repo settings)`);
      } catch {
        // Auto-merge may not be available
      }
    }

    return {
      success: true,
      prNumber: pr.number,
      prUrl: pr.html_url,
      branch: opts.branch,
      message: `PR #${pr.number} created: ${pr.html_url}`,
    };
  } catch (error) {
    const msg = (error as Error).message;
    console.error(`[GitHub] ❌ PR creation failed: ${msg}`);

    return {
      success: false,
      prNumber: 0,
      prUrl: '',
      branch: opts.branch,
      message: `PR creation failed: ${msg.substring(0, 300)}`,
    };
  }
}

// ── Get PR / CI Status ───────────────────────────────────────────────────────

/**
 * Check CI status on a Pull Request.
 * Combines both check runs and commit statuses.
 */
export async function getPRStatus(prNumber: number): Promise<CIStatus> {
  const config = getConfig();
  const octokit = getOctokit();

  try {
    // Get PR details to find the head SHA
    const { data: pr } = await octokit.pulls.get({
      owner: config.owner,
      repo: config.repo,
      pull_number: prNumber,
    });

    const headSha = pr.head.sha;

    // Get check runs (GitHub Actions)
    const { data: checkRuns } = await octokit.checks.listForRef({
      owner: config.owner,
      repo: config.repo,
      ref: headSha,
    });

    // Get combined commit status (legacy status API)
    const { data: combinedStatus } = await octokit.repos.getCombinedStatusForRef({
      owner: config.owner,
      repo: config.repo,
      ref: headSha,
    });

    // Normalize check runs
    const checks = checkRuns.check_runs.map((cr) => ({
      name: cr.name,
      status: cr.status,        // 'queued' | 'in_progress' | 'completed'
      conclusion: cr.conclusion, // 'success' | 'failure' | 'neutral' | null
      detailsUrl: cr.details_url,
    }));

    // Add legacy statuses
    for (const s of combinedStatus.statuses) {
      checks.push({
        name: s.context,
        status: 'completed',
        conclusion: s.state === 'success' ? 'success' : s.state === 'pending' ? null : 'failure',
        detailsUrl: s.target_url,
      });
    }

    // Determine overall state
    let state: CIStatus['state'] = 'unknown';

    if (checks.length === 0) {
      state = 'pending'; // No checks configured yet
    } else {
      const hasPending = checks.some((c) => c.status !== 'completed' || c.conclusion === null);
      const hasFailure = checks.some(
        (c) => c.conclusion === 'failure' || c.conclusion === 'cancelled',
      );
      const allSuccess = checks.every((c) => c.conclusion === 'success' || c.conclusion === 'neutral');

      if (hasFailure) state = 'failure';
      else if (hasPending) state = 'pending';
      else if (allSuccess) state = 'success';
      else state = 'error';
    }

    const allPassed = state === 'success';

    return {
      state,
      checks,
      allPassed,
      message: allPassed
        ? `All ${checks.length} checks passed`
        : `CI state: ${state} (${checks.length} checks)`,
    };
  } catch (error) {
    return {
      state: 'unknown',
      checks: [],
      allPassed: false,
      message: `Failed to fetch PR status: ${(error as Error).message}`,
    };
  }
}

/**
 * Poll CI status until completion or timeout.
 */
export async function waitForCI(
  prNumber: number,
  opts?: { pollIntervalMs?: number; timeoutMs?: number },
): Promise<CIStatus> {
  const interval = opts?.pollIntervalMs ?? 30_000;
  const timeout = opts?.timeoutMs ?? 300_000; // 5 minutes
  const startTime = Date.now();

  console.log(`[GitHub] Polling CI status for PR #${prNumber} (timeout: ${timeout / 1000}s)...`);

  while (Date.now() - startTime < timeout) {
    const status = await getPRStatus(prNumber);

    if (status.state === 'success' || status.state === 'failure' || status.state === 'error') {
      console.log(`[GitHub] CI completed: ${status.state} (${status.checks.length} checks)`);
      return status;
    }

    // Still pending — wait and retry
    await new Promise((r) => setTimeout(r, interval));
  }

  return {
    state: 'pending',
    checks: [],
    allPassed: false,
    message: `CI timed out after ${timeout / 1000}s`,
  };
}

// ── Merge PR ─────────────────────────────────────────────────────────────────

/**
 * Merge a Pull Request via the GitHub API.
 */
export async function mergePR(
  prNumber: number,
  method: 'merge' | 'squash' = 'squash',
): Promise<MergeResult> {
  const config = getConfig();
  const octokit = getOctokit();

  try {
    const { data } = await octokit.pulls.merge({
      owner: config.owner,
      repo: config.repo,
      pull_number: prNumber,
      merge_method: method,
    });

    console.log(`[GitHub] ✅ PR #${prNumber} merged (${method}): ${data.sha}`);

    return {
      success: true,
      sha: data.sha,
      message: `PR #${prNumber} merged via ${method}: ${data.sha}`,
    };
  } catch (error) {
    const msg = (error as Error).message;
    console.error(`[GitHub] ❌ Merge failed for PR #${prNumber}: ${msg}`);

    return {
      success: false,
      sha: '',
      message: `Merge failed: ${msg.substring(0, 300)}`,
    };
  }
}

// ── Branch Cleanup ───────────────────────────────────────────────────────────

/**
 * Delete a remote branch after merge.
 */
export async function deleteRemoteBranch(branchName: string): Promise<void> {
  const config = getConfig();
  const octokit = getOctokit();

  try {
    await octokit.git.deleteRef({
      owner: config.owner,
      repo: config.repo,
      ref: `heads/${branchName}`,
    });
    console.log(`[GitHub] 🗑️ Deleted remote branch: ${branchName}`);
  } catch (error) {
    // Non-fatal — branch might already be deleted
    console.warn(`[GitHub] Branch deletion warning: ${(error as Error).message}`);
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

/**
 * Check GitHub connectivity and configuration.
 */
export async function getGitHubStatus(): Promise<{
  configured: boolean;
  authenticated: boolean;
  prMode: boolean;
  autoMerge: boolean;
  repoUrl: string;
  rateLimitRemaining: number;
  message: string;
}> {
  try {
    const config = getConfig();
    const octokit = getOctokit();

    // Test authentication
    const { data: rateLimit } = await octokit.rateLimit.get();
    const remaining = rateLimit.resources.core.remaining;

    // Verify repo access
    const { data: repo } = await octokit.repos.get({
      owner: config.owner,
      repo: config.repo,
    });

    return {
      configured: true,
      authenticated: true,
      prMode: config.prMode,
      autoMerge: config.autoMerge,
      repoUrl: repo.html_url,
      rateLimitRemaining: remaining,
      message: `GitHub connected: ${repo.full_name} (${remaining} API calls remaining)`,
    };
  } catch (error) {
    const msg = (error as Error).message;

    // Check if it's a config error vs auth error
    const isConfigError = msg.includes('Missing config');

    return {
      configured: !isConfigError,
      authenticated: false,
      prMode: false,
      autoMerge: false,
      repoUrl: '',
      rateLimitRemaining: 0,
      message: isConfigError
        ? 'GitHub not configured (missing GITHUB_TOKEN/OWNER/REPO)'
        : `GitHub auth failed: ${msg.substring(0, 200)}`,
    };
  }
}

/**
 * Check if PR mode is enabled.
 */
export function isPRModeEnabled(): boolean {
  return process.env.GITHUB_PR_MODE === 'true';
}
