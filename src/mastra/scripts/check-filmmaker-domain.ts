import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  agentModels,
  filmmakerAssignments,
  workerPresets,
} from '../config/model-manifest.js';
import {
  getStatusToolName,
  isPipelineAgent,
  resolvePhaseTools,
} from '../config/pipeline-phase-tools.js';
import { FILM_PIPELINE_STATUSES } from '../tools/film/film-service.js';
import { filmLoadReferenceTool } from '../tools/film/film-reference-tools.js';
import { lintFilmPromptMarkdown } from '../tools/film/film-validators.js';
import { validateFilmPromptSpec, validateFilmProjectState } from '../lib/film-schemas.js';

const repoRoot = process.cwd();

assert.ok(FILM_PIPELINE_STATUSES.includes('intake'), 'film statuses include intake');
assert.ok(FILM_PIPELINE_STATUSES.includes('generate'), 'film statuses include generate');
assert.ok(FILM_PIPELINE_STATUSES.includes('done'), 'film statuses include done');

assert.equal(agentModels.filmmakerAgent, 'or-claude-sonnet-5', 'filmmakerAgent model assignment exists');
assert.equal(filmmakerAssignments.orchestrator, 'deepseek-v4-pro', 'filmmaker orchestrator assignment exists');
assert.ok('film' in workerPresets, 'film worker preset exists');

const runWorkerSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/system/run-worker.ts'), 'utf-8');
assert.ok(runWorkerSource.includes("'film'"), 'run_worker schema/roles mention film preset');

const requiredFiles = [
  'src/mastra/agents/film-agent.ts',
  'src/mastra/prompts/film/domain.md',
  'src/mastra/prompts/film/pipeline.md',
  'src/mastra/tools/film/film-generate.ts',
  'src/mastra/tools/film/film-project-tools.ts',
  'src/mastra/tools/film/film-reference-tools.ts',
  'src/mastra/tools/film/film-validators.ts',
  'src/mastra/tools/film/film-ledger.ts',
  'src/mastra/_skills/film/scripts/prompt_lint.py',
  'src/mastra/_skills/film/scripts/project_state_check.py',
  'src/mastra/_skills/film/scripts/continuity_chain_check.py',
  'src/mastra/_skills/film/scripts/source_registry_check.py',
  'src/mastra/_skills/film/scripts/generation_run_check.py',
  'src/mastra/_skills/film/scripts/sequence_eval_check.py',
  'src/mastra/_skills/film/evals/evals.json',
  'src/mastra/_skills/film/evals/generation-benchmark.json',
  'src/mastra/config/film-surfaces.ts',
  'src/mastra/config/film-schemas/project-state.schema.json',
  'src/mastra/config/film-schemas/prompt-spec.schema.json',
  'src/mastra/config/film-schemas/generation-run.schema.json',
  'src/mastra/_skills/film/skills/seedance-prompt/SKILL.md',
  'src/mastra/_skills/film/references/api-status.md',
];
for (const file of requiredFiles) {
  const text = await fs.readFile(path.resolve(repoRoot, file), 'utf-8');
  assert.ok(text.trim().length > 50, `${file} should be present and non-empty`);
}

// Both documented env aliases must select the same source tree. Point the
// singular alias at a reference that intentionally exists outside the default
// film root, then call the production tool rather than copying its resolver.
const previousSingularFilmRoot = process.env.FILM_SKILL_ROOT;
const previousPluralFilmRoot = process.env.FILM_SKILLS_ROOT;
try {
  process.env.FILM_SKILL_ROOT = path.resolve(repoRoot, 'src/mastra/_skills/music');
  delete process.env.FILM_SKILLS_ROOT;
  const loaded = await (filmLoadReferenceTool.execute as any)({
    kind: 'reference',
    name: 'mastering/mastering-checklist',
    maxChars: 500,
  }, {}) as { success: boolean; path?: string; error?: string };
  assert.equal(loaded.success, true, loaded.error ?? 'FILM_SKILL_ROOT must select the reference root');
  assert.equal(loaded.path, 'references/mastering/mastering-checklist.md');
} finally {
  if (previousSingularFilmRoot === undefined) delete process.env.FILM_SKILL_ROOT;
  else process.env.FILM_SKILL_ROOT = previousSingularFilmRoot;
  if (previousPluralFilmRoot === undefined) delete process.env.FILM_SKILLS_ROOT;
  else process.env.FILM_SKILLS_ROOT = previousPluralFilmRoot;
}

const filmAgentSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/agents/film-agent.ts'), 'utf-8');
assert.ok(filmAgentSource.includes("combinePrompts('film/domain', 'film/pipeline', 'shared/skill-shelf')"), 'filmmakerAgent loads film prompts and Skill Shelf contract');
assert.ok(filmAgentSource.includes('filmStartProjectTool'), 'filmmakerAgent registers project tools');
assert.ok(filmAgentSource.includes('filmGenerateTool'), 'filmmakerAgent registers generation tool');
assert.ok(filmAgentSource.includes('filmLintPromptTool'), 'filmmakerAgent registers validators');
assert.ok(filmAgentSource.includes('designGenerateImageTool'), 'filmmakerAgent can create reference frames');
assert.ok(filmAgentSource.includes('delegateTaskTool'), 'filmmakerAgent registers delegateTaskTool');
assert.ok(filmAgentSource.includes('runWorkerTool'), 'filmmakerAgent registers runWorkerTool');
assert.ok(filmAgentSource.includes('requestApprovalTool'), 'filmmakerAgent registers approval tool');
assert.ok(filmAgentSource.includes('attachmentPersistProcessor'), 'filmmakerAgent wires attachmentPersistProcessor for user photos');

const attachmentProcessorSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/processors/attachment-persist.ts'), 'utf-8');
assert.ok(attachmentProcessorSource.includes("BaseProcessor<'attachment-persist'>"), 'attachment processor extends BaseProcessor');
// The persistence itself moved to services/prompt-attachments.ts so the generate
// path (REST / Telegram gateway) shares it with the stream path; the processor is
// now the stream-side adapter and must keep delegating there.
assert.ok(
  attachmentProcessorSource.includes('prompt-attachments.js'),
  'attachment processor delegates to the shared prompt-attachments service',
);

const promptAttachmentsSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/services/prompt-attachments.ts'), 'utf-8');
assert.ok(promptAttachmentsSource.includes('referenceRoles'), 'attachment note points the agent at referenceRoles');
// Fix A: persist() must surface the ABSOLUTE path so film_generate's cwd-relative
// path guard accepts it across the server-cwd / agent-workspace boundary.
assert.ok(/return\s*\{\s*ok:\s*true,\s*path:\s*absPath/.test(promptAttachmentsSource), 'attachment service surfaces the absolute saved path (Fix A)');
assert.ok(!promptAttachmentsSource.includes('const relPath'), 'attachment service no longer downgrades to a cwd-relative path (Fix A)');

const metaAgentSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/agents/meta-agent.ts'), 'utf-8');
assert.ok(metaAgentSource.includes('attachmentPersistProcessor'), 'meta-agent wires attachmentPersistProcessor for delegated photos');

const filmGenerateSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/film/film-generate.ts'), 'utf-8');
assert.ok(filmGenerateSource.includes('withToolEnvelope<FilmGenerateInput, FilmGenerateOutput>'), 'film_generate should use tool envelope');
assert.ok(filmGenerateSource.includes('lintFilmPromptMarkdown'), 'film_generate should lint prompts before remote calls');
assert.ok(filmGenerateSource.includes('approval_required'), 'film_generate should fail closed without approval');
// Fix E (structural): recover a slash-stripped workspace path so a misled agent
// dropping the leading "/" does not break reference reads.
assert.ok(/existsSync\(resolve\('\/', ref\.path\)\)/.test(filmGenerateSource), 'film_generate should recover slash-stripped workspace reference paths (Fix E structural)');
assert.ok(filmGenerateSource.includes('missing_api_key'), 'film_generate should fail closed without API key');
// The 10MB cap belongs here, not in the shared transport: prompt-attachments
// carries Telegram's 20MB limit, and film_generate owns the inline-upload guard.
assert.ok(
  /info\.size\s*>\s*10\s*\*\s*1024\s*\*\s*1024/.test(filmGenerateSource),
  'film_generate enforces the 10MB inline-upload guard on reference paths',
);

assert.equal(isPipelineAgent('filmmakerAgent'), true, 'filmmakerAgent should be a pipeline agent');
assert.equal(getStatusToolName('filmmakerAgent'), 'film_set_project_status', 'film status tool should be registered');
const sourceGateTools = resolvePhaseTools('filmmakerAgent', 'source_gate');
assert.ok(sourceGateTools?.includes('system_delegate_task'), 'source_gate should allow researcher delegation');
assert.ok(sourceGateTools?.includes('film_check_sources'), 'source_gate should validate sources');
const promptBuildTools = resolvePhaseTools('filmmakerAgent', 'prompt_build');
assert.ok(promptBuildTools?.includes('film_compile_prompt_spec'), 'prompt_build should compile prompt spec');
assert.ok(promptBuildTools?.includes('film_lint_prompt'), 'prompt_build should lint prompt');
assert.ok(promptBuildTools?.includes('system_run_worker'), 'prompt_build should allow film worker variants');
const generateTools = resolvePhaseTools('filmmakerAgent', 'generate');
assert.ok(generateTools?.includes('film_generate'), 'generate phase should allow film_generate');
assert.ok(generateTools?.includes('film_list_generation_runs'), 'generate phase should keep ledger reads available');
assert.equal(resolvePhaseTools('filmmakerAgent', 'intake')?.includes('film_generate'), false, 'film_generate should not be in intake phase');

const delegateTaskSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/system/delegate-task.ts'), 'utf-8');
assert.ok(delegateTaskSource.includes('filmmakerAgent'), 'delegate-task should mention filmmakerAgent');
assert.ok(delegateTaskSource.includes('FILMMAKER_AGENT_ID'), 'delegate-task should use FILMMAKER_AGENT_ID');
// Etap 2: the domain description moved from delegate-task's prose to the Agent Board card.
const agentBoardSourceForFilm = await fs.readFile(path.resolve(repoRoot, 'src/mastra/config/agent-board.ts'), 'utf-8');
assert.ok(/film\/video generation/i.test(agentBoardSourceForFilm), 'agent board card should describe filmmaker domain');
// Fix D: filmmaker delegation gets its own (longer, env-overridable) timeout because
// real video generation exceeds the generic 240s budget.
assert.ok(delegateTaskSource.includes('DELEGATION_FILMMAKER_TIMEOUT_MS'), 'delegate-task should expose a filmmaker timeout env override (Fix D)');
assert.ok(delegateTaskSource.includes('getDelegationTimeoutMsFor'), 'delegate-task should select the per-agent delegation timeout (Fix D)');

// Fix B1: film_upsert_clip persists user-supplied reference roles into the project
// reference_registry so a photo survives across clips and feeds film_generate.
const filmServiceSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/film/film-service.ts'), 'utf-8');
assert.ok(filmServiceSource.includes('mergeReferenceRegistry'), 'film-service should merge reference roles into the registry (Fix B1)');
assert.ok(/reference_registry,/.test(filmServiceSource), 'upsertClip should write reference_registry into project state (Fix B1)');
const filmProjectToolsSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/film/film-project-tools.ts'), 'utf-8');
assert.ok(filmProjectToolsSource.includes('referenceRoles'), 'film_upsert_clip input schema should accept referenceRoles (Fix B1)');

const agentIdsSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/config/agent-ids.ts'), 'utf-8');
assert.ok(agentIdsSource.includes('FILMMAKER_AGENT_ID'), 'agent IDs should include FILMMAKER_AGENT_ID');
assert.ok(agentIdsSource.includes('FILMMAKER_AGENT_ALIASES'), 'agent IDs should include filmmaker aliases');

// Etap 2: the roster is generated — routing lives in base.md rules + _generated/roster.md.
const metaBaseRaw = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/meta/base.md'), 'utf-8');
const generatedRoster = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/meta/_generated/roster.md'), 'utf-8');
const metaBase = metaBaseRaw + '\n' + generatedRoster;
assert.ok(metaBase.includes('filmmakerAgent'), 'meta base prompt should route filmmakerAgent');
assert.ok(/film\/video generation/i.test(metaBase), 'meta base prompt should describe film routing');
// Fix G: meta must STOP and surface a delegated paid-approval gate, not re-delegate in a loop.
assert.ok(/Delegated PAID \/ approval-gated actions/.test(metaBase), 'meta base prompt should cover delegated paid-approval gates (Fix G)');
assert.ok(/do not call the paid tool yourself|Invalid or unapproved approvalToken/i.test(metaBase), 'meta base prompt should forbid meta re-running the paid tool / re-delegating in a loop (Fix G)');

const intentRouter = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/meta/intent-router.md'), 'utf-8');
assert.ok(intentRouter.includes('filmmakerAgent'), 'intent router should mention filmmakerAgent');
assert.ok(intentRouter.includes('film_*'), 'intent router should classify film tool requests');
assert.ok(/wygenerowanie filmu|Seedance prompt/i.test(intentRouter), 'intent router should classify film/video generation');
assert.ok(/Załączniki użytkownika/i.test(intentRouter), 'intent router should forward attachment paths to filmmaker');

const filmPipelinePrompt = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/film/pipeline.md'), 'utf-8');
assert.ok(/User-Supplied Photos/i.test(filmPipelinePrompt), 'film pipeline prompt should explain user-supplied photos');
assert.ok(filmPipelinePrompt.includes('referenceRoles'), 'film pipeline prompt should map photos to referenceRoles');
// Fix B2: prompt must tell the filmmaker to persist the photo via film_upsert_clip
// and to reuse reference_registry instead of substituting a generated image.
assert.ok(filmPipelinePrompt.includes('film_upsert_clip'), 'film pipeline prompt should persist photos via film_upsert_clip (Fix B2)');
assert.ok(/reference_registry/.test(filmPipelinePrompt), 'film pipeline prompt should reuse reference_registry before generation (Fix B2)');

// Fix E: attachment paths must NOT be validated with workspace file tools (they
// use a different root and falsely report the path as missing/outside).
assert.ok(/do not verify|NIE.*sprawdzaj|NIE waliduj/i.test(filmPipelinePrompt) && filmPipelinePrompt.includes('mastra_workspace_file_stat'), 'film pipeline prompt should forbid validating attachment paths with workspace file tools (Fix E)');
assert.ok(promptAttachmentsSource.includes('mastra_workspace_file_stat'), 'attachment note should warn against workspace file-stat false negatives (Fix E)');

// Fix F: after system_request_approval the agent must stop the turn and surface
// the pending approval, not retry film_generate in a loop with a pending token.
assert.ok(/Do NOT retry `film_generate` in the same turn/.test(filmPipelinePrompt), 'film pipeline prompt should forbid same-turn film_generate retry after approval request (Fix F)');

// Fix H (structural): film_generate must distinguish a pending token (terminal
// awaiting_user_approval, no rejected ledger run) from approved / denied / missing.
assert.ok(/getApprovalStatus\(/.test(filmServiceSource), 'film-service should expose getApprovalStatus (Fix H)');
assert.ok(filmGenerateSource.includes('awaiting_user_approval'), 'film_generate should return a terminal awaiting_user_approval signal for a pending token (Fix H)');
assert.ok(/getApprovalStatus\(context\.approvalToken\)/.test(filmGenerateSource), 'film_generate should resolve approval status without throwing (Fix H)');
assert.ok(/awaiting_user_approval/.test(filmPipelinePrompt), 'film pipeline prompt should document the terminal awaiting_user_approval signal (Fix H)');

// Fix I (structural): system_request_approval must reuse an existing pending
// approval for the same project/clip so the token stays stable across retries.
const requestApprovalSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/system/request-approval.ts'), 'utf-8');
assert.ok(/status:\s*'pending'/.test(requestApprovalSource) && /args\.projectId/.test(requestApprovalSource), 'system_request_approval should reuse a stable pending token per project/clip (Fix I)');

// Fix J (structural): image-driven modes (I2V/FLF2V/R2V/V2V) must route to an
// image-to-video endpoint, not the text-to-video model which ignores the photo.
const filmSurfacesSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/config/film-surfaces.ts'), 'utf-8');
assert.ok(/export function resolveFilmModelId/.test(filmSurfacesSource), 'film-surfaces should expose resolveFilmModelId (Fix J)');
assert.ok(/image-to-video/.test(filmSurfacesSource), 'film-surfaces should map image-driven modes to an image-to-video endpoint (Fix J)');
assert.ok(/resolveFilmModelId\(surface, context\.mode\)/.test(filmGenerateSource), 'film_generate should resolve the endpoint from the generation mode (Fix J)');
assert.ok(/runFalGeneration\(context, apiKey, effectiveModelId\)/.test(filmGenerateSource), 'film_generate should submit to the mode-resolved endpoint (Fix J)');

// Fix K (structural): env-configurable hard cap on paid generations, enforced in
// the tool so meta/filmmaker/workers are all bounded and cannot loop paid calls.
assert.ok(/countGenerationAttempts\(/.test(filmServiceSource), 'film-service should expose countGenerationAttempts (Fix K)');
assert.ok(/FILM_MAX_PAID_GENERATIONS_PER_CLIP/.test(filmGenerateSource), 'film_generate should read the per-clip paid cap from env (Fix K)');
assert.ok(/FILM_MAX_PAID_GENERATIONS_PER_PROJECT/.test(filmGenerateSource), 'film_generate should read the per-project paid cap from env (Fix K)');
assert.ok(/paid_generation_cap_reached/.test(filmGenerateSource), 'film_generate should return a terminal paid_generation_cap_reached signal (Fix K)');
assert.ok(/paid_generation_cap_reached/.test(filmPipelinePrompt), 'film pipeline prompt should document the terminal paid_generation_cap_reached signal (Fix K)');

// Fix L (structural): a content_policy_violation from fal moderating the output
// is terminal — the tool flags it so agents do not re-submit the same paid call.
assert.ok(/isContentPolicyViolation/.test(filmGenerateSource), 'film_generate should classify content_policy_violation rejections (Fix L)');
assert.ok(/terminal:\s*z\.boolean\(\)/.test(filmGenerateSource), 'film_generate output should expose a terminal flag (Fix L)');
assert.ok(/content_policy_violation/.test(filmPipelinePrompt), 'film pipeline prompt should document content_policy_violation as terminal (Fix L)');

const indexSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/index.ts'), 'utf-8');
assert.ok(indexSource.includes("import { filmmakerAgent }"), 'index should import filmmakerAgent');
assert.ok(indexSource.includes('filmmakerAgent,'), 'index should register filmmakerAgent in agents map');

// Approve channel: a real endpoint must exist to flip a pending approval to approved.
assert.ok(indexSource.includes("registerApiRoute('/dashboard/approvals/:id/approve'"), 'index should register a POST approve endpoint for pending approvals');
assert.ok(/status:\s*'approved'/.test(indexSource), 'approve endpoint should set status to approved');

const envExample = await fs.readFile(path.resolve(repoRoot, '.env.example'), 'utf-8');
for (const key of [
  'FILM_SKILLS_ROOT=',
  'FILM_SKILL_ROOT=',
  'FILM_OUTPUT_DIR=',
  'FILM_REQUIRE_APPROVAL=true',
  'FILM_SURFACE=fal',
  'FAL_KEY=',
  'FAL_BASE_URL=',
  'FILM_FAL_MODEL_ID=',
  'FILM_POLL_TIMEOUT_MS=',
  'RUNWAY_API_KEY=',
  'RUNWAY_BASE_URL=',
  'ARK_API_KEY=',
  'ARK_BASE_URL=',
]) {
  assert.ok(envExample.includes(key), `.env.example should document ${key}`);
}

const dynamicPromptLint = await lintFilmPromptMarkdown([
  '## Source Brief',
  'Verify dynamic prompt lint wiring.',
  '',
  '## Internal Prompt Specification',
  '```json',
  '{"project_id":"film-check","clip_id":"clip-01"}',
  '```',
  '',
  '## Compiled Natural-Language Prompt',
  'A cinematic rain shot of an intact glass sculpture moving toward a lit window.',
  '',
  '## Lint Result',
  'lint: pass',
  '',
  '## Control-Critical Sentences',
  'why this remains: it preserves the generated prompt before remote submission.',
  '',
].join('\n'));
assert.equal(dynamicPromptLint.ok, true, `dynamic prompt lint should pass: ${dynamicPromptLint.rawOutput}`);

const projectState = validateFilmProjectState({
  schema_version: '1.0.0',
  state_revision: 1,
  project_id: 'film-check',
  project_mode: 'standalone_clip',
  surface: { provider: 'seedance', surface: 'fal' },
  clip_budget_sec: null,
  prompt_budget: null,
  story: {
    logline: 'A glass sculpture crosses a rainy city.',
    story_promise: 'A visual continuity test.',
    objective: 'Create one cinematic continuity-safe clip.',
    initial_condition: 'The sculpture is intact.',
    final_outcome: 'The sculpture reaches a lit window.',
    target_duration_sec: 6,
    tone: 'cinematic',
    medium: 'video',
  },
  world_bible: {},
  reference_registry: [],
  beats: [
    {
      beat_id: 'beat-1',
      description: 'The sculpture moves through rain.',
      narrative_function: 'core action',
      status: 'current',
      assigned_clip_id: 'clip-01',
      dependencies: [],
    },
  ],
  clips: [
    {
      clip_id: 'clip-01',
      parent_clip_id: null,
      sequence_index: 1,
      prompt_version: 'v1',
      generation_mode: 'T2V',
      source_clip_tag: null,
      status: 'planned',
      narrative_job: 'Move the sculpture through rain.',
      already_happened: [],
      this_clip_only: ['rain movement'],
      reserved_for_later: ['arrival at the window'],
      planned_start_state: { sculpture: 'intact' },
      planned_end_state: { location: 'near lit window' },
      observed_start_state: null,
      observed_end_state: null,
      continuity_locks: [],
      allowed_changes: [],
      continuity_breaks: [],
      accepted_deviations: [],
      transition_in: '',
      transition_out: '',
      open_motion_vectors: [],
      handoff_requirements: [],
      extension_depth: 0,
    },
  ],
  take_history: [],
  current_clip_id: 'clip-01',
  canon_revision: 1,
  updated_at: new Date().toISOString(),
});
assert.equal(projectState.project_id, 'film-check', 'film project schema should validate');

const promptSpec = validateFilmPromptSpec({
  project_id: 'film-check',
  clip_id: 'clip-01',
  prompt_version: 'v1',
  sequence_relation: 'standalone',
  generation_mode: 'T2V',
  reference_roles: [],
  opening_state_source: 'planned_start_state',
  current_clip_action: 'The sculpture moves through rain.',
  endpoint: 'near lit window',
  completed_beat_exclusions: [],
  reserved_future_exclusions: ['arrival at the window'],
  natural_language_prompt: 'A cinematic rain shot of an intact glass sculpture moving toward a lit window.',
});
assert.equal(promptSpec.generation_mode, 'T2V', 'film prompt schema should validate');

console.log('filmmaker domain check passed');
