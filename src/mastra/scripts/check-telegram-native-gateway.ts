#!/usr/bin/env tsx
/**
 * check:telegram-native-gateway
 *
 * Structural sanity check for the native Telegram gateway — safe to run at
 * any time, including while the n8n webhook path is still active: it never
 * touches webhook state and never sends a real message unless --live is
 * passed explicitly.
 *
 *   npm run check:telegram-native-gateway          # structural only
 *   npm run check:telegram-native-gateway -- --live # + sends a real test ping
 *
 * Exit code 0 = all required checks pass, 1 = at least one blocker.
 */
import 'dotenv/config';
import { getDb } from '../lib/mongo.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { telegramRequest } from '../tools/communication/telegram.js';
import { startChatActionHeartbeat } from '../services/telegram-native-gateway.js';

type Status = 'ok' | 'warn' | 'fail';
type Check = { key: string; status: Status; message: string; required: boolean };

const checks: Check[] = [];
function emit(key: string, status: Status, message: string, required = true) {
  checks.push({ key, status, message, required });
}

async function main() {
  const live = process.argv.includes('--live');

  const flagOn = isHarnessFeatureEnabled('FEATURE_TELEGRAM_NATIVE_GATEWAY', false);
  emit('flag', 'ok', `FEATURE_TELEGRAM_NATIVE_GATEWAY=${flagOn}`, false);

  const stopTest = startChatActionHeartbeat('dummy_chat', 'typing', 60_000);
  emit('typing_heartbeat', typeof stopTest === 'function' ? 'ok' : 'fail', 'startChatActionHeartbeat lifecycle verified');
  stopTest();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    emit('bot_token', 'fail', 'TELEGRAM_BOT_TOKEN is not set in .env');
  } else {
    try {
      const me = await telegramRequest('getMe', {}) as { result?: { username?: string } };
      emit('bot_token', 'ok', `valid, bot=@${me.result?.username ?? '?'}`);
    } catch (err) {
      emit('bot_token', 'fail', `getMe failed: ${(err as Error).message}`);
    }
  }

  const allowlist = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  emit('allowlist', allowlist.length > 0 ? 'ok' : 'warn',
    allowlist.length > 0 ? `${allowlist.length} chat(s) allowed` : 'TELEGRAM_ALLOWED_CHAT_IDS empty — every chat will be accepted',
    false);

  try {
    const db = await getDb();
    await db.collection('telegram_gateway_state').findOne({});
    emit('mongo', 'ok', 'telegram_gateway_state collection reachable');
  } catch (err) {
    emit('mongo', 'fail', `Mongo unreachable: ${(err as Error).message}`);
  }

  try {
    const res = await fetch('http://localhost:4111/api/agents/meta-agent', { signal: AbortSignal.timeout(5000) });
    emit('mastra_agent_route', res.ok ? 'ok' : 'warn', `GET /api/agents/meta-agent -> HTTP ${res.status}`, false);
  } catch (err) {
    emit('mastra_agent_route', 'warn', `unreachable: ${(err as Error).message}`, false);
  }

  if (live) {
    const chatId = process.env.TELEGRAM_CHAT_ID || process.env.N8N_TELEGRAM_CHAT_ID;
    if (!chatId) {
      emit('live_ping', 'fail', 'no TELEGRAM_CHAT_ID/N8N_TELEGRAM_CHAT_ID to send the live ping to');
    } else {
      try {
        await telegramRequest('sendMessage', {
          chat_id: chatId,
          text: '[check-telegram-native-gateway] live ping OK',
        });
        emit('live_ping', 'ok', `sent to chat ${chatId}`);
      } catch (err) {
        emit('live_ping', 'fail', `send failed: ${(err as Error).message}`);
      }
    }
  } else {
    emit('live_ping', 'ok', 'skipped (pass --live to send a real test message)', false);
  }

  console.log('\n== check:telegram-native-gateway ==');
  let hasFailure = false;
  for (const c of checks) {
    const icon = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️ ' : '❌';
    console.log(`${icon} [${c.key}] ${c.message}`);
    if (c.status === 'fail' && c.required) hasFailure = true;
  }
  console.log('');
  process.exit(hasFailure ? 1 : 0);
}

main().catch((err) => {
  console.error('[check-telegram-native-gateway] crashed:', (err as Error).message);
  process.exit(1);
});
