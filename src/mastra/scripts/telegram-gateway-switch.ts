#!/usr/bin/env tsx
/**
 * switch:telegram-native / switch:telegram-n8n
 *
 * The ONE deliberate, manually-run cutover point between the two Telegram
 * delivery modes. Telegram allows only one at a time (webhook XOR
 * getUpdates), so this is never called automatically by the app itself —
 * only by a human running the npm script.
 *
 *   npm run switch:telegram-native   # delete webhook, unpublish n8n workflow
 *   npm run switch:telegram-n8n      # restore webhook, republish n8n workflow
 *
 * After either direction: flip FEATURE_TELEGRAM_NATIVE_GATEWAY in .env to
 * match, then restart the Mastra process.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';

const WORKFLOW_ID = 'ZlDGfs3lbEviEnaz';
const N8N_CONTAINER = 'af-n8n';
const N8N_WEBHOOK_URL = 'https://n8n.gastrobridge.com/webhook/90fe0ea1-5535-4c54-ac90-89a9599adab9/webhook';

function telegramApiUrl(method: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegramCall(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(telegramApiUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? 'unknown error'}`);
  return data.result;
}

function n8nCli(...args: string[]): void {
  console.log(`  $ docker exec ${N8N_CONTAINER} n8n ${args.join(' ')}`);
  execFileSync('docker', ['exec', N8N_CONTAINER, 'n8n', ...args], { stdio: 'inherit' });
}

async function switchToNative(): Promise<void> {
  console.log('== Switching Telegram delivery: n8n webhook -> native long-polling ==\n');

  console.log('1) Deleting Telegram webhook...');
  await telegramCall('deleteWebhook');
  console.log('   done.\n');

  console.log(`2) Unpublishing n8n workflow ${WORKFLOW_ID} ("Mastra - Telegram Meta-Agent Gateway v3")...`);
  n8nCli('unpublish:workflow', `--id=${WORKFLOW_ID}`);
  console.log('   done.\n');

  const info = await telegramCall('getWebhookInfo');
  console.log('3) getWebhookInfo now reports:', JSON.stringify(info));

  console.log(
    '\nNext: set FEATURE_TELEGRAM_NATIVE_GATEWAY=true in .env and restart the Mastra process.',
  );
}

async function switchToN8n(): Promise<void> {
  console.log('== Switching Telegram delivery: native long-polling -> n8n webhook ==\n');

  console.log(`1) Republishing n8n workflow ${WORKFLOW_ID} ("Mastra - Telegram Meta-Agent Gateway v3")...`);
  n8nCli('publish:workflow', `--id=${WORKFLOW_ID}`);
  console.log('   done.\n');

  console.log('2) Restoring Telegram webhook...');
  await telegramCall('setWebhook', { url: N8N_WEBHOOK_URL });
  console.log('   done.\n');

  const info = await telegramCall('getWebhookInfo');
  console.log('3) getWebhookInfo now reports:', JSON.stringify(info));

  console.log(
    '\nNext: set FEATURE_TELEGRAM_NATIVE_GATEWAY=false (or remove it) in .env and restart the Mastra process.',
  );
}

async function main() {
  const target = process.argv.find((a) => a.startsWith('--to='))?.slice('--to='.length);
  if (target !== 'native' && target !== 'n8n') {
    console.error('Usage: npm run switch:telegram-native   (or)   npm run switch:telegram-n8n');
    process.exit(1);
  }
  if (target === 'native') await switchToNative();
  else await switchToN8n();
}

main().catch((err) => {
  console.error('[telegram-gateway-switch] FAILED:', (err as Error).message);
  process.exit(1);
});
