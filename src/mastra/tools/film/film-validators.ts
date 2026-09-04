import { createTool } from '@mastra/core/tools';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

type ExecFailure = Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

export function resolveFilmSkillRoot(): string {
  const candidates = [
    process.env.FILM_SKILL_ROOT,
    process.env.FILM_SKILLS_ROOT,
    join(process.cwd(), 'src/mastra/_skills/film'),
    join(process.cwd(), 'agentic-agents/src/mastra/_skills/film'),
    join(process.cwd(), 'storage/repos_external/seedance-2.0'),
    join(process.cwd(), 'agentic-agents/storage/repos_external/seedance-2.0'),
    resolve(process.cwd(), '../../storage/repos_external/seedance-2.0'),
    resolve(__dirname, '../../_skills/film'),
    resolve(__dirname, '../_skills/film'),
    resolve(__dirname, '../../../src/mastra/_skills/film'),
    resolve(__dirname, '../../../../storage/repos_external/seedance-2.0'),
    resolve(__dirname, '../../../storage/repos_external/seedance-2.0'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);

  const root = candidates.find((candidate) => (
    existsSync(join(candidate, 'scripts', 'prompt_lint.py')) ||
    existsSync(join(candidate, 'SKILL.md'))
  ));
  if (!root) {
    throw new Error(`seedance-2.0 source repo not found. Tried: ${candidates.join(', ')}`);
  }
  return root;
}

function parseValidatorOutput(stdout: string, stderr: string): {
  errors: string[];
  warnings: string[];
  rawOutput: string;
} {
  const rawOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    const clean = line.replace(/^-\s*/, '').trim();
    if (!clean) continue;
    if (/warning|warn/i.test(clean)) {
      warnings.push(clean);
    } else if (/error|missing|invalid|must|failed|stale|old/i.test(clean)) {
      errors.push(clean);
    }
  }
  return { errors, warnings, rawOutput };
}

export async function runFilmPythonValidator(
  scriptName: string,
  options: { strict?: boolean; repoRoot?: string } = {},
): Promise<{ ok: boolean; errors: string[]; warnings: string[]; rawOutput: string; exitCode?: number | string }> {
  const scriptRoot = resolveFilmSkillRoot();
  const repoRoot = options.repoRoot ?? scriptRoot;
  const scriptPath = join(scriptRoot, 'scripts', scriptName);
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      errors: [`Missing validator script: ${scriptName}`],
      warnings: [],
      rawOutput: '',
    };
  }

  const args = [scriptPath, repoRoot];
  if (options.strict) args.push('--strict');

  try {
    const { stdout, stderr } = await execFileAsync('python3', args, {
      cwd: scriptRoot,
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 4,
    });
    const parsed = parseValidatorOutput(stdout, stderr);
    return {
      ok: true,
      errors: [],
      warnings: parsed.warnings,
      rawOutput: parsed.rawOutput,
    };
  } catch (error) {
    const err = error as ExecFailure;
    const parsed = parseValidatorOutput(err.stdout ?? '', err.stderr ?? err.message);
    return {
      ok: false,
      errors: parsed.errors.length ? parsed.errors : [err.message],
      warnings: parsed.warnings,
      rawOutput: parsed.rawOutput,
      exitCode: err.code,
    };
  }
}

export async function lintFilmPromptMarkdown(markdown: string): Promise<{
  ok: boolean;
  errors: string[];
  warnings: string[];
  rawOutput: string;
  exitCode?: number | string;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'film-prompt-lint-'));
  try {
    const targetDir = join(tempRoot, 'examples', 'golden-prompts');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'current.md'), markdown, 'utf-8');
    return await runFilmPythonValidator('prompt_lint.py', {
      strict: true,
      repoRoot: tempRoot,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function validatorTool(id: string, description: string, scriptName: string) {
  return createTool({
    id,
    description,
    inputSchema: z.object({
      strict: z.boolean().default(false),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
      rawOutput: z.string(),
      exitCode: z.union([z.string(), z.number()]).optional(),
    }),
    execute: async (context) => runFilmPythonValidator(scriptName, { strict: context.strict }),
  });
}

export const filmLintPromptTool = validatorTool(
  'film_lint_prompt',
  'Runs seedance-2.0 scripts/prompt_lint.py against the read-only source examples.',
  'prompt_lint.py',
);

export const filmCheckProjectStateTool = validatorTool(
  'film_check_project_state',
  'Runs seedance-2.0 scripts/project_state_check.py against source project-state examples and schemas.',
  'project_state_check.py',
);

export const filmCheckContinuityTool = validatorTool(
  'film_check_continuity',
  'Runs seedance-2.0 scripts/continuity_chain_check.py against source sequence examples.',
  'continuity_chain_check.py',
);

export const filmCheckSourcesTool = validatorTool(
  'film_check_sources',
  'Runs seedance-2.0 scripts/source_registry_check.py against source registry data.',
  'source_registry_check.py',
);

export const filmCheckGenerationRunTool = validatorTool(
  'film_check_generation_run',
  'Runs seedance-2.0 scripts/generation_run_check.py against source generation-run fixtures.',
  'generation_run_check.py',
);

export const filmCheckSequenceEvalTool = validatorTool(
  'film_check_sequence_eval',
  'Runs seedance-2.0 scripts/sequence_eval_check.py against source eval cases.',
  'sequence_eval_check.py',
);
