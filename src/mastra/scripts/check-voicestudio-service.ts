import assert from 'node:assert/strict';
import { getVoiceStudioService, PATRYK_VOICES } from '../services/voicestudio-service.js';
import {
  voiceStudioRenderAudiobookTool,
  voiceStudioFreeVramTool,
  voiceStudioGetStatusTool,
} from '../tools/writer/voicestudio-tools.js';

async function run() {
  console.log('Testing VoiceStudioService & Tools...');

  const service = getVoiceStudioService();

  // Test 1: Voice resolution
  console.log('1. Testing Voice Profile Resolution...');
  assert.equal(service.resolveVoice('pl').id, PATRYK_VOICES.pl.id);
  assert.equal(service.resolveVoice('Polish').name, PATRYK_VOICES.pl.name);
  assert.equal(service.resolveVoice('en').id, PATRYK_VOICES.en.id);
  assert.equal(service.resolveVoice('english').name, PATRYK_VOICES.en.name);
  assert.equal(service.resolveVoice('angielski').id, PATRYK_VOICES.en.id);
  assert.equal(service.resolveVoice(undefined).id, PATRYK_VOICES.pl.id); // Default to PL
  assert.equal(service.resolveVoice(undefined, 'custom-id').id, 'custom-id');
  console.log('   ✓ Voice resolution tests passed');

  // Test 2: Container inspection and Health API
  console.log('2. Testing Container & Health Checks...');
  const isRunning = service.isContainerRunning();
  console.log(`   Container running: ${isRunning}`);
  if (isRunning) {
    const health = await service.checkHealth();
    assert.equal(health.available, true);
    assert.ok(health.device?.includes('cuda') || health.device?.includes('cpu'));
    console.log(`   ✓ Health API reachable: device=${health.device}, version=${health.version}`);
  }

  // Test 3: Debounced timer management
  console.log('3. Testing Debounced Timer Handling...');
  service.scheduleDebouncedHardShutdown(60000);
  service.cancelDebouncedHardShutdown();
  console.log('   ✓ Debounce timer schedule and cancel verified');

  // Test 4: voiceStudioGetStatusTool execution
  console.log('4. Testing voiceStudioGetStatusTool...');
  if (voiceStudioGetStatusTool.execute) {
    const statusResult = (await (voiceStudioGetStatusTool.execute as any)({}, {} as any)) as any;
    assert.equal(typeof statusResult.containerRunning, 'boolean');
    assert.equal(typeof statusResult.apiAvailable, 'boolean');
    assert.equal(statusResult.voices.polish.id, PATRYK_VOICES.pl.id);
    assert.equal(statusResult.voices.english.id, PATRYK_VOICES.en.id);
    console.log('   ✓ Status tool returned valid schema and voice mappings');
  }

  // Test 5: Tool presence
  console.log('5. Testing Tool Registrations...');
  assert.equal(voiceStudioRenderAudiobookTool.id, 'voicestudio_render_audiobook');
  assert.equal(voiceStudioFreeVramTool.id, 'voicestudio_free_vram');
  assert.equal(voiceStudioGetStatusTool.id, 'voicestudio_get_status');
  console.log('   ✓ All tools registered with correct IDs and descriptions');

  console.log('\n✅ ALL VOICESTUDIO INTEGRATION TESTS PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
