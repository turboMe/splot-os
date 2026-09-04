import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ALEX_APPROVALS_FUNCTION,
  ALEX_LIVE_MODEL,
  ALEX_META_FUNCTION,
  ALEX_STATUS_FUNCTION,
  ALEX_SYSTEM_PROMPT,
  ALEX_TASK_FUNCTION,
  buildAlexLiveConfig,
  createAlexLiveRoutes,
  createAlexMetaBridge,
  getAlexPendingApprovals,
  getAlexSystemStatus,
  getAlexTaskStatus,
  isAlexLiveEnabled,
} from '../services/alex-live.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

assert.equal(isAlexLiveEnabled({ FEATURE_ALEX_LIVE: 'true' }), true);
assert.equal(isAlexLiveEnabled({ FEATURE_ALEX_LIVE: 'false' }), false);
assert.equal(isAlexLiveEnabled({}), false, 'Alex must default to completely disabled');

const disabledRoutes = createAlexLiveRoutes({
  metaAgent: { generate: async () => ({ text: 'unused' }) },
  repoRoot,
  env: { FEATURE_ALEX_LIVE: 'false' },
});
assert.deepEqual(disabledRoutes, [], 'the flag must remove the complete HTTP surface');

const enabledRoutes = createAlexLiveRoutes({
  metaAgent: { generate: async () => ({ text: 'ok' }) },
  repoRoot,
  env: { FEATURE_ALEX_LIVE: 'true' },
  issueToken: async () => ({ token: 'test-token', model: ALEX_LIVE_MODEL, expiresAt: new Date().toISOString() }),
});
assert.deepEqual(
  enabledRoutes.map((route) => `${route.method} ${route.path}`),
  [
    'GET /alex/live/config',
    'POST /alex/live/token',
    'POST /alex/live/meta',
    'GET /alex/live/status',
    'GET /alex/live/approvals',
    'GET /alex/live/task/:id',
    'GET /dashboard-ui/alex.js',
    'GET /dashboard-ui/alex.css',
  ],
);

const liveConfig = buildAlexLiveConfig({ ALEX_GEMINI_VOICE: 'Charon' });
const declarations = liveConfig.tools?.flatMap((tool) => (
  'functionDeclarations' in tool ? tool.functionDeclarations ?? [] : []
)) ?? [];
assert.equal(declarations.length, 4, 'Alex must expose 4 functions (meta, status, approvals, task)');
const toolNames = declarations.map((d) => d.name);
assert.ok(toolNames.includes(ALEX_META_FUNCTION));
assert.ok(toolNames.includes(ALEX_STATUS_FUNCTION));
assert.ok(toolNames.includes(ALEX_APPROVALS_FUNCTION));
assert.ok(toolNames.includes(ALEX_TASK_FUNCTION));
assert.ok(liveConfig.inputAudioTranscription, 'input transcription must be enabled');
assert.ok(liveConfig.outputAudioTranscription, 'output transcription must be enabled');
assert.ok(liveConfig.contextWindowCompression, 'long live sessions need bounded context');
assert.equal(liveConfig.enableAffectiveDialog, undefined, 'unsupported Gemini 3.1 capability must stay off');
assert.match(ALEX_SYSTEM_PROMPT, /1-3 krótkich zdań/);
assert.match(ALEX_SYSTEM_PROMPT, /get_system_status/);
assert.match(ALEX_SYSTEM_PROMPT, /get_pending_approvals/);
assert.match(ALEX_SYSTEM_PROMPT, /get_task_status/);
assert.ok(ALEX_SYSTEM_PROMPT.length < 10_000, 'voice prompt should remain bounded in length');
assert.equal(
  liveConfig.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs,
  700,
  'silenceDurationMs must be 700ms',
);

const statusCheck = await getAlexSystemStatus();
assert.ok(typeof statusCheck.text === 'string');
assert.ok(typeof statusCheck.killSwitch === 'boolean');

const approvalsCheck = await getAlexPendingApprovals();
assert.ok(typeof approvalsCheck.count === 'number');
assert.ok(typeof approvalsCheck.text === 'string');

const taskCheck = await getAlexTaskStatus('999999');
assert.equal(taskCheck.found, false);

const calls: Array<{ prompt: unknown; options?: Record<string, any> }> = [];
const bridge = createAlexMetaBridge({
  generate: async (prompt, options) => {
    calls.push({ prompt, options });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    return { text: 'Pełna odpowiedź Jarvis Meta.' };
  },
}, {
  ALEX_META_RESOURCE_ID: 'alex-test-user',
});

const input = {
  conversationId: 'alex-11111111-1111-4111-8111-111111111111',
  utteranceId: 'utt-22222222-2222-4222-8222-222222222222',
  message: 'Sprawdź dokładnie wdrożenie i zachowaj liczbę 184.',
};
const [first, duplicate] = await Promise.all([bridge(input), bridge(input)]);
assert.equal(calls.length, 1, 'duplicate function delivery must not run Meta twice');
assert.deepEqual(first, duplicate);
assert.equal(calls[0]?.prompt, input.message, 'the bridge must not summarize user input');
assert.equal(calls[0]?.options?.memory.thread, `alex-live:${input.conversationId}`);
assert.equal(calls[0]?.options?.memory.resource, 'alex-test-user');
assert.equal(calls[0]?.options?.requestContext?.get('channel'), 'alex-live');
assert.equal(first.fullText, 'Pełna odpowiedź Jarvis Meta.');

await assert.rejects(
  () => bridge({ ...input, utteranceId: 'bad', message: input.message }),
  /invalid_utterance_id/,
);

const dashboard = await readFile(resolve(repoRoot, 'dashboard/index.html'), 'utf8');
const browserSource = await readFile(resolve(repoRoot, 'dashboard/alex.ts'), 'utf8');
const browserBundle = await readFile(resolve(repoRoot, 'dashboard/alex.js'), 'utf8');
const indexSource = await readFile(resolve(repoRoot, 'src/mastra/index.ts'), 'utf8');
assert.match(dashboard, /id="alex-live-module" hidden/);
assert.match(browserSource, /send_to_meta/);
assert.match(browserSource, /audio\/pcm;rate=/);
assert.match(browserSource, /state\.alwaysListening/);
assert.ok(browserBundle.length > 1_000, 'browser SDK bundle was not generated');
assert.match(indexSource, /createAlexLiveRoutes\(\{ metaAgent/);
assert.match(indexSource, /isAlexLiveEnabled\(\)/);

console.log('Alex Live contract: OK');
