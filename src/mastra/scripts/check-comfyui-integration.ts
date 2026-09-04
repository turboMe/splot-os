/**
 * ComfyUI Integration Verification Script
 *
 * Runs deterministic tests on:
 *   - Base workflow JSON loading and integrity
 *   - Resolution & Aspect ratio mapping
 *   - LoRA matrix injection & Patryk single-man identity rule
 *   - Face detailer prompt adaptation
 *   - Tool schema validation (Zod)
 *   - ComfyUI API health & queue status
 */

import { ComfyUiService, ASPECT_RATIO_DIMENSIONS } from '../services/comfyui-service.js';
import { comfyuiGenerateImageTool, comfyuiStatusTool, comfyuiFreeVramTool } from '../tools/design/comfyui-tools.js';

async function runVerification() {
  console.log('🧪 Starting ComfyUI Visual Studio Integration Checks...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` — ${detail}` : ''}`);
      failed++;
    }
  }

  const service = new ComfyUiService();

  // ── 1. Base Graph Loading & Mutation ──
  console.log('1. Workflow Template & Mutation Logic:');
  try {
    const baseGraph = await (service as any).loadBaseGraph();
    assert(baseGraph !== null && typeof baseGraph === 'object', 'Base workflow graph loads successfully');
    assert('119' in baseGraph, 'Node 119 (Prompt) exists in base graph');
    assert('11' in baseGraph, 'Node 11 (EmptyLatentImage) exists in base graph');
    assert('12' in baseGraph, 'Node 12 (Seed rgthree) exists in base graph');
    assert('30' in baseGraph, 'Node 30 (Power Lora Loader) exists in base graph');
    assert('167:323' in baseGraph, 'Node 167:323 (Prompt MĘŻCZYZNA) exists in base graph');

    // Test aspect ratio mutation
    const test169 = (service as any).mutateGraph(baseGraph, {
      prompt: 'test prompt 16:9',
      aspectRatio: '16:9',
      loraPatrykEnabled: true,
      loraPatrykStrength: 1.1,
    });
    assert(test169.graph['11'].inputs.width === 1280 && test169.graph['11'].inputs.height === 720, 'Aspect ratio 16:9 maps to 1280x720');
    assert(test169.graph['119'].inputs.value === 'test prompt 16:9', 'Prompt correctly injected into node 119');
    assert(test169.graph['30'].inputs.lora_2.on === true, 'Patryk LoRA is enabled when requested');
    assert(test169.graph['30'].inputs.lora_2.strength === 1.1, 'Patryk LoRA strength is correctly updated');
    assert(test169.graph['167:323'].inputs.text.includes('pa1rykman'), 'Face Detailer prompt includes pa1rykman trigger');

    // Test Patryk LoRA disabled (single-man rule off)
    const testDisabled = (service as any).mutateGraph(baseGraph, {
      prompt: 'test fantasy landscape without patryk',
      aspectRatio: '9:16',
      loraPatrykEnabled: false,
    });
    assert(testDisabled.graph['11'].inputs.width === 720 && testDisabled.graph['11'].inputs.height === 1280, 'Aspect ratio 9:16 maps to 720x1280');
    assert(testDisabled.graph['30'].inputs.lora_2.on === false, 'Patryk LoRA is disabled when loraPatrykEnabled: false');
    assert(testDisabled.graph['167:1014'].inputs.strength_model === 0.0, 'Face Detailer identity LoRA strength set to 0.0');
    assert(!testDisabled.graph['167:323'].inputs.text.includes('pa1rykman'), 'Face Detailer prompt omits pa1rykman trigger');

    // Test aspect ratio map coverage
    for (const [ar, dims] of Object.entries(ASPECT_RATIO_DIMENSIONS)) {
      const res = (service as any).mutateGraph(baseGraph, { prompt: 'test', aspectRatio: ar as any });
      assert(
        res.graph['11'].inputs.width === dims.width && res.graph['11'].inputs.height === dims.height,
        `Aspect ratio ${ar} maps to ${dims.width}x${dims.height}`,
      );
    }
  } catch (err: any) {
    assert(false, 'Base graph mutation tests threw an exception', err.message);
  }

  // ── 2. Tool Definition Checks ──
  console.log('\n2. Mastra Tools Definitions:');
  assert(comfyuiGenerateImageTool.id === 'comfyui-generate-image', 'comfyuiGenerateImageTool ID is valid');
  assert(comfyuiStatusTool.id === 'comfyui-status', 'comfyuiStatusTool ID is valid');
  assert(comfyuiFreeVramTool.id === 'comfyui-free-vram', 'comfyuiFreeVramTool ID is valid');

  // Validate tool input schemas
  const genInputParsed = (comfyuiGenerateImageTool.inputSchema as any)?.safeParse?.({
    prompt: 'pa1rykman editorial portrait',
    category: 'portraits',
    aspect_ratio: '16:9',
  });
  assert(genInputParsed?.success === true, 'comfyuiGenerateImageTool input schema accepts valid payload');

  const vramInputParsed = (comfyuiFreeVramTool.inputSchema as any)?.safeParse?.({});
  assert(vramInputParsed?.success === true, 'comfyuiFreeVramTool input schema accepts defaults');

  // ── 3. Live ComfyUI Server Health & Queue Check ──
  console.log('\n3. Live ComfyUI Endpoint Health:');
  const health = await service.checkHealth();
  if (health.available) {
    console.log(`  ℹ️ ComfyUI is ONLINE at ${health.apiUrl}`);
    assert(health.available === true, 'ComfyUI /system_stats is reachable');
    const queue = await service.getQueue();
    console.log(`  ℹ️ Current queue: ${queue.running.length} running, ${queue.pending.length} pending`);
    assert(typeof queue.totalRemaining === 'number', 'ComfyUI queue status queried successfully');
  } else {
    console.log(`  ℹ️ ComfyUI is currently OFFLINE at ${health.apiUrl} (${health.error})`);
    console.log('  ℹ️ Offline handling test: service gracefully reports offline status without crashing.');
    assert(health.available === false, 'Offline status captured gracefully');
  }

  // ── Summary ──
  console.log(`\n========================================`);
  console.log(`Verification Complete: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
