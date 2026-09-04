import { ComfyUiService } from '../services/comfyui-service.js';
import { comfyuiGenerateImageTool, comfyuiStatusTool } from '../tools/design/comfyui-tools.js';
import assert from 'node:assert';
import { resolve } from 'node:path';

async function main() {
  console.log('🧪 Starting ComfyUI Service & Tool Verification Tests...\n');

  // Test 1: Load graph with Web UI format path (simulating old .env)
  console.log('1️⃣ Testing Web UI format detection and automatic fallback:');
  const webUiTemplatePath = '/vm/ComfyUI/user/default/workflows/txt2img - najlepszy (2 twarze AUTO-PŁEĆ).json';
  const serviceWithBadTemplate = new ComfyUiService({ templatePath: webUiTemplatePath });

  const graphFromFallback = await (serviceWithBadTemplate as any).loadBaseGraph();
  assert(graphFromFallback, 'Expected base graph to be returned via fallback');
  assert(!Array.isArray(graphFromFallback.nodes), 'Graph must not be in Web UI format');
  assert(graphFromFallback['11'] || graphFromFallback['119'], 'Graph must contain API node IDs');
  console.log('   ✅ Web UI format was detected and successfully fell back to API template!\n');

  // Test 2: Load graph with valid API format template
  console.log('2️⃣ Testing valid API format template loading:');
  const apiTemplatePath = resolve(process.cwd(), 'src/mastra/services/comfyui/txt2img-base-graph.json');
  const serviceWithApiTemplate = new ComfyUiService({ templatePath: apiTemplatePath });

  const graphFromApi = await (serviceWithApiTemplate as any).loadBaseGraph();
  assert(graphFromApi, 'Expected API base graph to be returned');
  assert(graphFromApi['11'], 'Node 11 (EmptyLatentImage) must exist');
  assert(graphFromApi['119'], 'Node 119 (PrimitiveStringMultiline) must exist');
  console.log('   ✅ API template loaded directly without warnings!\n');

  // Test 3: Graph mutation (dimensions, seed, prompt, LoRAs)
  console.log('3️⃣ Testing mutateGraph behavior:');
  const mutated = (serviceWithApiTemplate as any).mutateGraph(graphFromApi, {
    prompt: 'Cinematic futuristic restaurant workstation with copper glowing HUD #D2823F',
    aspectRatio: '16:9',
    seed: 987654321,
    loraPatrykEnabled: false,
  });

  assert.strictEqual(mutated.dimensions.width, 1280);
  assert.strictEqual(mutated.dimensions.height, 720);
  assert.strictEqual(mutated.effectiveSeed, 987654321);
  assert.strictEqual(mutated.graph['119'].inputs.value, 'Cinematic futuristic restaurant workstation with copper glowing HUD #D2823F');
  assert.strictEqual(mutated.graph['12'].inputs.seed, 987654321);
  assert.strictEqual(mutated.graph['30'].inputs.lora_2.on, false, 'Patryk LoRA should be disabled');
  console.log('   ✅ mutateGraph correctly injected prompt, seed, dimensions and LoRA flags!\n');

  // Test 4: Tool output schema validation on failure (Graceful Error Handling)
  console.log('4️⃣ Testing tool outputSchema validation on failure:');
  const errorPayload = {
    success: false,
    error: 'Failed to queue prompt in ComfyUI: HTTP 500 — Internal Server Error',
  };
  const parseResultFail = (comfyuiGenerateImageTool.outputSchema as any).safeParse(errorPayload);
  assert(parseResultFail.success, `Schema validation for error payload failed: ${JSON.stringify(parseResultFail)}`);
  console.log('   ✅ Tool outputSchema accepts failure payload without throwing!\n');

  // Test 5: Tool output schema validation on success
  console.log('5️⃣ Testing tool outputSchema validation on success:');
  const successPayload = {
    success: true,
    promptId: 'test-prompt-id',
    filename: 'test-img.png',
    imagePath: '/projekty/splot-projects/media/generations/portraits/test-img.png',
    metadataPath: '/projekty/splot-projects/media/generations/portraits/test-img.json',
    category: 'portraits',
    aspectRatio: '16:9',
    dimensions: { width: 1920, height: 1080 },
    seed: 123456,
    durationMs: 42000,
  };
  const parseResultSuccess = (comfyuiGenerateImageTool.outputSchema as any).safeParse(successPayload);
  assert(parseResultSuccess.success, `Schema validation for success payload failed: ${JSON.stringify(parseResultSuccess)}`);
  console.log('   ✅ Tool outputSchema accepts success payload!\n');

  console.log('🎉 All ComfyUI Service & Tool verification tests PASSED!\n');
}

main().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
