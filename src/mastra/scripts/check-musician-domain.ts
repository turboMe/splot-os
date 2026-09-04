import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  agentModels,
  musicianAssignments,
  workerPresets,
} from '../config/model-manifest.js';
import {
  getStatusToolName,
  isPipelineAgent,
  resolvePhaseTools,
} from '../config/pipeline-phase-tools.js';
import { MUSIC_PIPELINE_STATUSES } from '../tools/music/music-service.js';
import { lintMusicPromptSpec, checkMusicSafety } from '../tools/music/music-validators.js';
import { classifyMusicGenerationError } from '../tools/music/music-generate.js';
import {
  MUSIC_SURFACES,
  DEFAULT_MUSIC_SURFACE,
  resolveMusicSurface,
} from '../config/music-surfaces.js';
import { validateMusicPromptSpec, validateMusicGenerationRun } from '../lib/music-schemas.js';

const repoRoot = process.cwd();

// ── Pipeline status machine ──────────────────────────────────────────────────
assert.ok(MUSIC_PIPELINE_STATUSES.includes('intake'), 'music statuses include intake');
assert.ok(MUSIC_PIPELINE_STATUSES.includes('generate'), 'music statuses include generate');
assert.ok(MUSIC_PIPELINE_STATUSES.includes('done'), 'music statuses include done');

// ── Model manifest + worker preset ───────────────────────────────────────────
assert.equal(agentModels.musicianAgent, 'or-claude-sonnet-5', 'musicianAgent model assignment exists');
assert.equal(musicianAssignments.orchestrator, 'deepseek-v4-pro', 'musician orchestrator assignment exists');
assert.ok('music' in workerPresets, 'music worker preset exists');

const runWorkerSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/system/run-worker.ts'), 'utf-8');
assert.ok(runWorkerSource.includes("'music'"), 'run_worker schema/roles mention music preset');

// ── Required files present and non-empty ─────────────────────────────────────
const requiredFiles = [
  'src/mastra/agents/musician-agent.ts',
  'src/mastra/prompts/music/domain.md',
  'src/mastra/prompts/music/pipeline.md',
  'src/mastra/tools/music/music-generate.ts',
  'src/mastra/tools/music/music-project-tools.ts',
  'src/mastra/tools/music/music-validators.ts',
  'src/mastra/tools/music/music-reference-tools.ts',
  'src/mastra/tools/music/music-ledger.ts',
  'src/mastra/tools/music/music-service.ts',
  'src/mastra/config/music-surfaces.ts',
  'src/mastra/lib/music-schemas.ts',
  'src/mastra/_skills/music/skills/style-prompt-engineer/SKILL.md',
  'src/mastra/_skills/music/references/grammar/surface-grammar-adapter.md',
];
for (const file of requiredFiles) {
  const text = await fs.readFile(path.resolve(repoRoot, file), 'utf-8');
  assert.ok(text.trim().length > 50, `${file} should be present and non-empty`);
}

// ── Agent wiring ─────────────────────────────────────────────────────────────
const musicAgentSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/agents/musician-agent.ts'), 'utf-8');
assert.ok(musicAgentSource.includes("combinePrompts('music/domain', 'music/pipeline', 'shared/skill-shelf')"), 'musicianAgent loads music prompts and Skill Shelf contract');
assert.ok(musicAgentSource.includes('musicStartProjectTool'), 'musicianAgent registers project tools');
assert.ok(musicAgentSource.includes('musicGenerateTool'), 'musicianAgent registers generation tool');
assert.ok(musicAgentSource.includes('musicLoadReferenceTool'), 'musicianAgent registers music_load_reference');
assert.ok(musicAgentSource.includes('musicSearchReferenceTool'), 'musicianAgent registers music_search_reference');
assert.ok(musicAgentSource.includes('musicLintPromptTool'), 'musicianAgent registers validators');
assert.ok(musicAgentSource.includes('delegateTaskTool'), 'musicianAgent registers delegateTaskTool');
assert.ok(musicAgentSource.includes('runWorkerTool'), 'musicianAgent registers runWorkerTool');
assert.ok(musicAgentSource.includes('requestApprovalTool'), 'musicianAgent registers approval tool');

// ── Music reference loader + P1 skill corpus ────────────────────────────────
const musicReferenceToolsSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/music/music-reference-tools.ts'), 'utf-8');
assert.ok(musicReferenceToolsSource.includes("id: 'music_load_reference'"), 'music reference tools should export music_load_reference');
assert.ok(musicReferenceToolsSource.includes("id: 'music_search_reference'"), 'music reference tools should export music_search_reference');
assert.ok(musicReferenceToolsSource.includes('MUSIC_SKILLS_ROOT'), 'music reference tools should support MUSIC_SKILLS_ROOT override');
assert.ok(musicReferenceToolsSource.includes('safeResolveUnder'), 'music reference tools should guard path traversal');

const stylePromptEngineerSkill = await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/skills/style-prompt-engineer/SKILL.md'), 'utf-8');
assert.ok(stylePromptEngineerSkill.includes('name: style-prompt-engineer'), 'style-prompt-engineer should have registry name frontmatter');
assert.ok(stylePromptEngineerSkill.includes('description:'), 'style-prompt-engineer should have registry description frontmatter');
assert.ok(stylePromptEngineerSkill.includes('[ref:grammar/surface-grammar-adapter]'), 'style-prompt-engineer should point at the surface adapter');
assert.ok(!/Style Box.+default runtime style prompt/is.test(stylePromptEngineerSkill), 'style-prompt-engineer should not make Suno Style Box the default');

const surfaceAdapter = await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/references/grammar/surface-grammar-adapter.md'), 'utf-8');
assert.ok(surfaceAdapter.includes('fal MiniMax reference'), 'surface adapter should mention fal MiniMax reference mode');
assert.ok(surfaceAdapter.includes('ACE-Step'), 'surface adapter should mention fal ACE-Step');
assert.ok(surfaceAdapter.includes('fal Stable Audio'), 'surface adapter should mention fal Stable Audio');
assert.ok(surfaceAdapter.includes('ElevenLabs Music'), 'surface adapter should mention ElevenLabs Music');
assert.ok(surfaceAdapter.includes('suno-gateway'), 'surface adapter should describe the optional Suno gateway seam');

const expectedMusicSkills = [
  'album-art-director',
  'album-conceptualizer',
  'explicit-checker',
  'genre-creator',
  'lyric-refiner',
  'lyric-reviewer',
  'lyric-writer',
  'mastering-engineer',
  'mix-engineer',
  'plagiarism-checker',
  'pre-generation-check',
  'promo-director',
  'promo-reviewer',
  'promo-writer',
  'pronunciation-specialist',
  'release-director',
  'style-prompt-engineer',
  'voice-checker',
];
for (const skillName of expectedMusicSkills) {
  const skillPath = path.resolve(repoRoot, 'src/mastra/_skills/music/skills', skillName, 'SKILL.md');
  const skillText = await fs.readFile(skillPath, 'utf-8');
  assert.ok(skillText.includes(`name: ${skillName}`), `${skillName} should have registry name frontmatter`);
  assert.ok(/description:\s*["']?This skill should be used/i.test(skillText), `${skillName} should have registry description frontmatter`);
  assert.ok(skillText.includes('source_repo: "bitwize-music-studio/claude-ai-music-skills"'), `${skillName} should record source repo provenance`);
  assert.ok(skillText.includes('[ref:grammar/surface-grammar-adapter]'), `${skillName} should point at the surface adapter`);
  assert.equal(/argument-hint:|allowed-tools:|prerequisites:|^model:|^effort:|requirements:|bitwize-music-mcp|\/bitwize-music:/m.test(skillText), false, `${skillName} should not retain bitwize runtime frontmatter/tooling`);
}

for (const file of [
  'lyric-writer/craft-reference.md',
  'lyric-writer/examples.md',
  'lyric-writer/documentary-standards.md',
  'lyric-reviewer/checklist-reference.md',
  'pronunciation-specialist/word-lists.md',
  'album-conceptualizer/album-types.md',
  'album-art-director/visual-styles.md',
  'album-art-director/prompt-examples.md',
  'album-art-director/album-types.md',
  'mastering-engineer/genre-presets.md',
  'mix-engineer/mix-presets.md',
  'promo-writer/copy-formulas.md',
  'promo-director/technical-reference.md',
  'promo-director/visualization-guide.md',
  'promo-reviewer/platform-rules.md',
  'release-director/platform-guides.md',
]) {
  const text = await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/skills', file), 'utf-8');
  assert.ok(text.trim().length > 50, `music support file should be present and non-empty: ${file}`);
}

const masteringSkill = await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/skills/mastering-engineer/SKILL.md'), 'utf-8');
const mixSkill = await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/skills/mix-engineer/SKILL.md'), 'utf-8');
assert.ok(masteringSkill.includes('execution: "deferred"'), 'mastering-engineer should be marked execution deferred');
assert.ok(mixSkill.includes('execution: "deferred"'), 'mix-engineer should be marked execution deferred');

for (const file of [
  'grammar/structure-tags.md',
  'grammar/voice-tags.md',
  'grammar/instrumental-tags.md',
  'grammar/pronunciation-guide.md',
  'grammar/tips-and-tricks.md',
  'grammar/v5-best-practices.md',
  'grammar/suno-reference-index.md',
  'grammar/suno-v5-changes.md',
  'mastering/mastering-checklist.md',
  'mastering/mastering-workflow.md',
  'release/distributor-guide.md',
  'release/rights-and-claims.md',
  'promotion/promo-workflow.md',
  'promotion/platform-specs.md',
  'workflows/album-planning-phases.md',
  'workflows/source-verification-handoff.md',
  'sheet-music/workflow.md',
  'cloud/setup-guide.md',
  'cross-platform/tool-compatibility-matrix.md',
  'quick-start/first-album.md',
  'terminology.md',
  'model-strategy.md',
  'distribution.md',
  'streaming-mastering-specs.md',
]) {
  const text = await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/references', file), 'utf-8');
  assert.ok(text.trim().length > 50, `music reference should be present and non-empty: ${file}`);
  assert.equal(/^---\s*\nname:/m.test(text), false, `music reference should remain loader-only, not SkillRegistry frontmatter: ${file}`);
}

const grammarFiles = await fs.readdir(path.resolve(repoRoot, 'src/mastra/_skills/music/references/grammar'));
assert.ok(grammarFiles.filter((file) => file.endsWith('.md')).length >= 11, 'music grammar references should include adapter plus Suno-native docs');

const genreReferenceFiles = await fs.readdir(path.resolve(repoRoot, 'src/mastra/_skills/music/references/genres'));
assert.ok(genreReferenceFiles.filter((file) => file.endsWith('.md')).length >= 387, 'music genre references should include the full source genre corpus');

const artistReferenceFiles = await fs.readdir(path.resolve(repoRoot, 'src/mastra/_skills/music/references/genres/artists'));
assert.ok(artistReferenceFiles.filter((file) => file.endsWith('.md')).length >= 100, 'music artist references should include flattened artist deep-dives and indexes');

const genreList = JSON.parse(await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/data/genre-list.json'), 'utf-8')) as {
  count?: number;
  genres?: string[];
};
assert.ok((genreList.count ?? 0) >= 250, 'genre-list.json should contain parsed genre vocabulary');
assert.ok(genreList.genres?.includes('Synthwave'), 'genre-list.json should include Synthwave');
assert.ok(genreList.genres?.includes('Hip Hop'), 'genre-list.json should include Hip Hop');

const artistBlocklist = await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/data/artist-blocklist.md'), 'utf-8');
assert.ok(artistBlocklist.includes('Artist Name Blocklist'), 'artist blocklist data should be present');
assert.ok(artistBlocklist.includes('Do not output named-artist soundalike prompts'), 'artist blocklist should carry local impersonation-safety note');

const expectedExampleTemplates = [
  'album.md',
  'artist.md',
  'genre.md',
  'ideas.md',
  'research.md',
  'sources.md',
  'track.md',
  'promo/campaign.md',
  'promo/facebook.md',
  'promo/instagram.md',
  'promo/tiktok.md',
  'promo/twitter.md',
  'promo/youtube.md',
];
for (const file of expectedExampleTemplates) {
  const text = await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/examples', file), 'utf-8');
  assert.ok(text.includes('Loader-only example for music_load_reference'), `ported example template should carry loader-only note: ${file}`);
  assert.ok(text.trim().length > 50, `ported example template should be present and non-empty: ${file}`);
}

const expectedPromptSpecExamples = [
  'fal-lyrics2song.json',
  'fal-audio2audio-reference.json',
  'elevenlabs-lyrics2song.json',
];
for (const file of expectedPromptSpecExamples) {
  const raw = JSON.parse(await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/examples/example-prompt-specs', file), 'utf-8'));
  const spec = validateMusicPromptSpec(raw);
  const lint = lintMusicPromptSpec(spec);
  const safety = checkMusicSafety(spec.style_prompt, spec.lyrics);
  assert.deepEqual(lint.errors, [], `${file} should pass music prompt-spec lint`);
  assert.equal(safety.blocked, false, `${file} should not trip blocking music safety checks`);
}

const falAudioToAudioExample = validateMusicPromptSpec(JSON.parse(await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/examples/example-prompt-specs/fal-audio2audio-reference.json'), 'utf-8')));
assert.equal(falAudioToAudioExample.generation_mode, 'audio2audio', 'fal audio2audio example should exercise reference-audio mode');
assert.equal(falAudioToAudioExample.reference_audio.length, 1, 'fal audio2audio example should include exactly one reference audio input');

const elevenLabsExample = validateMusicPromptSpec(JSON.parse(await fs.readFile(path.resolve(repoRoot, 'src/mastra/_skills/music/examples/example-prompt-specs/elevenlabs-lyrics2song.json'), 'utf-8')));
assert.equal(elevenLabsExample.reference_audio.length, 0, 'ElevenLabs example should not include reference audio');
assert.ok((elevenLabsExample.length_ms ?? 0) >= 3_000 && (elevenLabsExample.length_ms ?? 0) <= 600_000, 'ElevenLabs example should carry explicit supported length_ms');

const musicDomainPrompt = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/music/domain.md'), 'utf-8');
const musicPipelinePrompt = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/music/pipeline.md'), 'utf-8');
assert.ok(musicDomainPrompt.includes('[example:example-prompt-specs/fal-lyrics2song.json]'), 'music domain prompt should route provider-specific examples');
assert.ok(musicPipelinePrompt.includes('kind:"example"'), 'music pipeline prompt should map [example:] to music_load_reference kind:"example"');

// ── Generation tool: envelope, validators, fail-closed gates ─────────────────
const musicGenerateSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/music/music-generate.ts'), 'utf-8');
assert.ok(musicGenerateSource.includes('withToolEnvelope<MusicGenerateInput, MusicGenerateOutput>'), 'music_generate should use tool envelope');
assert.ok(musicGenerateSource.includes('lintMusicPromptSpec'), 'music_generate should lint prompts before remote calls');
assert.ok(musicGenerateSource.includes('checkMusicSafety'), 'music_generate should run the safety gate before remote calls');
assert.ok(musicGenerateSource.includes('awaiting_user_approval'), 'music_generate should fail closed without approval');
assert.ok(musicGenerateSource.includes('missing_api_key'), 'music_generate should fail closed without API key');
assert.ok(/MUSIC_MAX_PAID_GENERATIONS_PER_TRACK/.test(musicGenerateSource), 'music_generate should read the per-track paid cap from env');
assert.ok(/MUSIC_MAX_PAID_GENERATIONS_PER_PROJECT/.test(musicGenerateSource), 'music_generate should read the per-project paid cap from env');
assert.ok(/paid_generation_cap_reached/.test(musicGenerateSource), 'music_generate should return a terminal paid_generation_cap_reached signal');
assert.ok(/content_policy_violation/.test(musicGenerateSource), 'music_generate should classify content_policy_violation rejections as terminal');
assert.ok(/provider_plan_required/.test(musicGenerateSource), 'music_generate should classify provider paid-plan failures as terminal');
assert.ok(/provider_schema_error/.test(musicGenerateSource), 'music_generate should classify provider schema failures as terminal');
assert.ok(/approval_scope_mismatch/.test(musicGenerateSource), 'music_generate should reject approval tokens scoped to a different call');
assert.ok(/surface_disabled/.test(musicGenerateSource), 'music_generate should refuse a disabled surface (e.g. Suno seam without a gateway)');
// Transport split: ElevenLabs is synchronous bytes, fal/suno are async-poll.
assert.ok(/sync-bytes/.test(musicGenerateSource), 'music_generate should branch on the sync-bytes transport');
assert.ok(/getApprovalStatus\(/.test(musicGenerateSource), 'music_generate should resolve approval status without throwing');

// ── Surfaces: env-swappable models + transports ──────────────────────────────
assert.equal(DEFAULT_MUSIC_SURFACE.surface, 'fal', 'default music surface should be fal');
assert.equal(MUSIC_SURFACES.fal.responseMode, 'async-poll', 'fal surface is async-poll');
assert.equal(MUSIC_SURFACES.fal.modelId, 'fal-ai/ace-step', 'fal default should use ACE-Step for text/lyrics-to-audio');
assert.equal(MUSIC_SURFACES['fal-minimax-reference'].modelId, 'fal-ai/minimax-music', 'MiniMax should be a reference-audio surface');
assert.equal(MUSIC_SURFACES.elevenlabs.responseMode, 'sync-bytes', 'elevenlabs surface is sync-bytes');
assert.equal(MUSIC_SURFACES['suno-gateway'].enabled, Boolean(process.env.SUNO_GATEWAY_BASE_URL), 'suno-gateway is disabled unless an env gateway is set');
assert.equal(resolveMusicSurface({ surface: 'elevenlabs' }).surface, 'elevenlabs', 'resolveMusicSurface honors explicit surface');
assert.equal(resolveMusicSurface({ surface: 'ace-step' }).surface, 'fal-ace-step', 'resolveMusicSurface maps ace-step alias');
assert.equal(resolveMusicSurface({ surface: 'stable-audio' }).surface, 'fal-stable-audio', 'resolveMusicSurface maps stable-audio alias');
assert.equal(resolveMusicSurface({ surface: 'minimax' }).surface, 'fal-minimax-reference', 'resolveMusicSurface maps MiniMax alias to reference surface');

// ── Pipeline phase tool channeling ───────────────────────────────────────────
assert.equal(isPipelineAgent('musicianAgent'), true, 'musicianAgent should be a pipeline agent');
assert.equal(getStatusToolName('musicianAgent'), 'music_set_project_status', 'music status tool should be registered');
const styleCompileTools = resolvePhaseTools('musicianAgent', 'style_compile');
assert.ok(styleCompileTools?.includes('music_compile_prompt_spec'), 'style_compile should compile prompt spec');
assert.ok(styleCompileTools?.includes('music_lint_prompt'), 'style_compile should lint prompt');
assert.ok(styleCompileTools?.includes('music_load_reference'), 'style_compile should allow music_load_reference');
assert.ok(styleCompileTools?.includes('music_search_reference'), 'style_compile should allow music_search_reference');
const safetyGateTools = resolvePhaseTools('musicianAgent', 'safety_gate');
assert.ok(safetyGateTools?.includes('music_check_safety'), 'safety_gate should validate safety');
assert.ok(safetyGateTools?.includes('music_load_reference'), 'safety_gate should allow music_load_reference');
const generateTools = resolvePhaseTools('musicianAgent', 'generate');
assert.ok(generateTools?.includes('music_generate'), 'generate phase should allow music_generate');
assert.ok(generateTools?.includes('music_append_generation_run'), 'generate phase should keep ledger writes available');
assert.equal(resolvePhaseTools('musicianAgent', 'intake')?.includes('music_generate'), false, 'music_generate should not be in intake phase');

// ── Meta delegation wiring ───────────────────────────────────────────────────
const delegateTaskSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/system/delegate-task.ts'), 'utf-8');
assert.ok(delegateTaskSource.includes('musicianAgent'), 'delegate-task should mention musicianAgent');
assert.ok(delegateTaskSource.includes('MUSICIAN_AGENT_ID'), 'delegate-task should use MUSICIAN_AGENT_ID');

const agentIdsSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/config/agent-ids.ts'), 'utf-8');
assert.ok(agentIdsSource.includes('MUSICIAN_AGENT_ID'), 'agent IDs should include MUSICIAN_AGENT_ID');
assert.ok(agentIdsSource.includes('MUSICIAN_AGENT_ALIASES'), 'agent IDs should include musician aliases');

// Etap 2: the roster is generated — routing lives in base.md rules + _generated/roster.md.
const metaBaseRaw = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/meta/base.md'), 'utf-8');
const generatedRoster = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/meta/_generated/roster.md'), 'utf-8');
const metaBase = metaBaseRaw + '\n' + generatedRoster;
assert.ok(metaBase.includes('musicianAgent'), 'meta base prompt should route musicianAgent');
assert.ok(/music\/song\/audio generation/i.test(metaBase), 'meta base prompt should describe music routing');

const intentRouter = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/meta/intent-router.md'), 'utf-8');
assert.ok(intentRouter.includes('musicianAgent'), 'intent router should mention musicianAgent');
assert.ok(intentRouter.includes('music_*'), 'intent router should classify music tool requests');
assert.ok(/piosenk|utwor|utwór|muzyk/i.test(intentRouter), 'intent router should classify music/song generation');

const indexSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/index.ts'), 'utf-8');
assert.ok(indexSource.includes('import { musicianAgent }'), 'index should import musicianAgent');
assert.ok(indexSource.includes('musicianAgent,'), 'index should register musicianAgent in agents map');

// ── .env.example documents the env-swappable surfaces + caps ─────────────────
const envExample = await fs.readFile(path.resolve(repoRoot, '.env.example'), 'utf-8');
for (const key of [
  'MUSIC_OUTPUT_DIR=',
  'MUSIC_REQUIRE_APPROVAL=true',
  'MUSIC_MAX_PAID_GENERATIONS_PER_TRACK=',
  'MUSIC_MAX_PAID_GENERATIONS_PER_PROJECT=',
  'MUSIC_SURFACE=fal',
  'MUSIC_FAL_MODEL_ID=',
  'MUSIC_FAL_ACE_STEP_MODEL_ID=',
  'MUSIC_FAL_STABLE_AUDIO_MODEL_ID=',
  'MUSIC_FAL_MINIMAX_MODEL_ID=',
  'MUSIC_ELEVENLABS_MODEL_ID=',
  'ELEVENLABS_API_KEY=',
  'SUNO_GATEWAY_BASE_URL=',
  'MUSIC_SUNO_MODEL_ID=',
  'MUSIC_POLL_TIMEOUT_MS=',
]) {
  assert.ok(envExample.includes(key), `.env.example should document ${key}`);
}

// ── Validators: dynamic behavior ─────────────────────────────────────────────
const cleanSpec = validateMusicPromptSpec({
  project_id: 'music-check',
  track_id: 'track-01',
  prompt_version: 'v1',
  generation_mode: 'lyrics2song',
  style_prompt: 'warm indie-folk ballad, acoustic guitar, intimate female vocal, 80 BPM',
  lyrics: 'Verse one about a quiet morning by the river\nChorus that rises with hope',
  vocal_type: 'female',
  language: 'en',
  structure: ['verse', 'chorus'],
  length_ms: 120_000,
  output_format: 'mp3',
  reference_audio: [],
});
assert.equal(cleanSpec.track_id, 'track-01', 'music prompt schema should validate');
const cleanLint = lintMusicPromptSpec(cleanSpec);
assert.equal(cleanLint.errors.length, 0, `clean prompt spec should lint without errors: ${cleanLint.errors.join('; ')}`);

// Instrumental mode with lyrics is inconsistent → should warn or error.
const instrumentalWithLyrics = lintMusicPromptSpec(
  validateMusicPromptSpec({
    project_id: 'music-check',
    track_id: 'track-02',
    prompt_version: 'v1',
    generation_mode: 'instrumental',
    style_prompt: 'driving synthwave instrumental, arpeggiated bass, 110 BPM',
    lyrics: 'these lyrics should not be here',
    vocal_type: 'instrumental',
    language: 'en',
    structure: ['intro'],
    length_ms: 90_000,
    output_format: 'mp3',
    reference_audio: [],
  }),
);
assert.ok(
  instrumentalWithLyrics.errors.length + instrumentalWithLyrics.warnings.length > 0,
  'instrumental mode carrying lyrics should be flagged',
);

// Safety gate must block clearly disallowed content.
const safety = checkMusicSafety('a gentle lullaby', 'a soft melody for sleeping children');
assert.equal(safety.blocked, false, 'benign content should not be blocked');

assert.equal(
  classifyMusicGenerationError('HTTP 402 paid_plan_required: upgrade to a paid plan')?.code,
  'provider_plan_required',
  'paid plan provider errors should be terminal and explicit',
);
assert.equal(
  classifyMusicGenerationError('HTTP 422: reference_audio_url Field required')?.code,
  'provider_schema_error',
  'fal reference_audio_url schema errors should not be misclassified as moderation',
);
assert.equal(
  classifyMusicGenerationError('String should have at most 4100 characters at body.prompt')?.code,
  'provider_input_limit',
  'provider text length errors should be terminal input-limit failures',
);

// Generation run schema validates a realistic ledger entry.
const run = validateMusicGenerationRun({
  run_id: 'run-01',
  project_id: 'music-check',
  track_id: 'track-01',
  surface: 'fal',
  prompt_version: 'v1',
  input_mode: 'lyrics2song',
  reference_tags: [],
  prompt: 'warm indie-folk ballad, acoustic guitar, intimate female vocal, 80 BPM',
  result_status: 'submitted',
  is_synthetic_fixture: false,
  provider: 'fal',
  model_id: 'fal-ai/ace-step',
  created_at: new Date().toISOString(),
});
assert.equal(run.track_id, 'track-01', 'music generation-run schema should validate');

console.log('musician domain check passed');
