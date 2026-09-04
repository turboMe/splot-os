import { defaultGateways, resolveModelConfig } from '@mastra/core/llm';
import { DeepSeekGateway } from '../lib/deepseek-gateway.js';
import { ZenMuxGateway } from '../lib/zenmux-gateway.js';
import { getDepthProfile } from '../services/depth-controller.js';
import { fallbackChainForAgent } from '../config/model-manifest.js';

// Simulate startup registration as performed in index.ts
if (!defaultGateways.some((g: any) => g.id === 'custom-deepseek')) {
  (defaultGateways as any[]).push(new DeepSeekGateway());
}
if (!defaultGateways.some((g: any) => g.id === 'custom-zenmux')) {
  (defaultGateways as any[]).push(new ZenMuxGateway());
}

async function verify() {
  console.log('=== VERIFYING DEFAULT GATEWAYS ===');
  console.log('defaultGateways IDs:', defaultGateways.map((g: any) => g.id));
  const hasDeepSeek = defaultGateways.some((g: any) => g.id === 'custom-deepseek');
  const hasZenMux = defaultGateways.some((g: any) => g.id === 'custom-zenmux');
  console.log('Has custom-deepseek in defaultGateways:', hasDeepSeek);
  console.log('Has custom-zenmux in defaultGateways:', hasZenMux);
  if (!hasDeepSeek) throw new Error('Missing custom-deepseek in defaultGateways');
  if (!hasZenMux) throw new Error('Missing custom-zenmux in defaultGateways');

  console.log('=== VERIFYING MODEL RESOLUTION WITHOUT MASTRA INSTANCE ===');
  const model = await resolveModelConfig('custom-deepseek/deepseek/deepseek-v4-pro');
  console.log('Successfully resolved custom-deepseek model:', Boolean(model), (model as any)?.modelId || (model as any)?.id);

  console.log('=== VERIFYING RESEARCHER MODEL & FALLBACK CHAIN ===');
  const chain = fallbackChainForAgent('researcher-agent');
  console.log('Researcher fallback chain:', chain);
  if (!chain.includes('custom-deepseek/deepseek/deepseek-v4-flash')) throw new Error('Missing deepseek-v4-flash in researcher fallback chain');

  console.log('=== VERIFYING DEPTH TIMEOUTS ===');
  const deepProfile = getDepthProfile('deep');
  const criticalProfile = getDepthProfile('critical');
  console.log('Deep timeoutMs:', deepProfile.timeoutMs, '(expected: 900000)');
  console.log('Critical timeoutMs:', criticalProfile.timeoutMs, '(expected: 1200000)');
  if (deepProfile.timeoutMs !== 900_000) throw new Error('Incorrect deep timeoutMs');
  if (criticalProfile.timeoutMs !== 1_200_000) throw new Error('Incorrect critical timeoutMs');

  console.log('✅ ALL VERIFICATION CHECKS PASSED');
  process.exit(0);
}

verify().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
