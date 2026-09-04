#!/usr/bin/env tsx
/**
 * check:n8n-runtime
 *
 * Probe wszystkich runtime endpointow ktore agent automatyzacji bedzie
 * wstrzykiwac do workflowow n8n. Nie wypisuje sekretow — tylko status.
 *
 *   npm run check:n8n-runtime
 *
 * Exit code 0 = wszystkie required dzialaja, 1 = co najmniej jeden blocker.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { getRuntimeTopology } from '../config/runtime-topology.js';

type Status = 'ok' | 'warn' | 'fail' | 'skip';
type Check = { key: string; status: Status; message: string; required: boolean };

const checks: Check[] = [];

function emit(key: string, status: Status, message: string, required = true) {
  checks.push({ key, status, message, required });
}

async function probe(url: string, timeoutMs = 3000): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function main() {
  const t = getRuntimeTopology();
  console.log(`Runtime mode: ${t.mode}\n`);

  // 1. n8n
  const n8n = await probe(`${t.n8nRestBaseUrl}/healthz`);
  if (n8n.ok) emit('n8n', 'ok', `${t.n8nRestBaseUrl} responded ${n8n.status}`);
  else emit('n8n', 'fail', `${t.n8nRestBaseUrl} unreachable: ${n8n.error ?? n8n.status}`);

  // 2. n8n API key
  if (process.env.N8N_API_KEY) {
    const apiCheck = await fetch(`${t.n8nRestBaseUrl}/api/v1/workflows?limit=1`, {
      headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY },
      signal: AbortSignal.timeout(5000),
    }).catch((e) => ({ ok: false, status: 0, error: (e as Error).message } as any));
    if (apiCheck.ok) emit('n8n_api_key', 'ok', 'API key valid');
    else emit('n8n_api_key', 'fail', `API key check returned ${apiCheck.status ?? apiCheck.error}`);
  } else {
    emit('n8n_api_key', 'fail', 'N8N_API_KEY not set');
  }

  // 3. Public webhook URL
  const publicUrl = t.n8nPublicWebhookBaseUrl;
  if (!publicUrl) {
    emit('public_webhook', 'warn', 'N8N_PUBLIC_WEBHOOK_BASE_URL not set', false);
  } else if (publicUrl.includes('localhost') || publicUrl.includes('127.0.0.1') || publicUrl.includes('replace-me')) {
    emit('public_webhook', 'warn', `URL is not public: ${publicUrl}`, false);
  } else {
    const tunnel = await probe(publicUrl, 5000);
    if (tunnel.ok) emit('public_webhook', 'ok', `${publicUrl} responded ${tunnel.status}`, false);
    else emit('public_webhook', 'warn', `${publicUrl} unreachable: ${tunnel.error ?? tunnel.status}`, false);
  }

  // 4. Mastra API
  const mastra = await probe(`${t.mastraApiUrlForN8n.replace(/\/$/, '')}/api`, 3000);
  if (mastra.ok || (mastra.status && mastra.status < 500)) {
    emit('mastra_api', 'ok', `${t.mastraApiUrlForN8n} responded ${mastra.status ?? 'ok'}`, false);
  } else {
    emit('mastra_api', 'warn', `${t.mastraApiUrlForN8n} unreachable: ${mastra.error ?? mastra.status}`, false);
  }

  // 5. Ollama
  const ollama = await probe(`${t.ollamaBaseUrlForN8n}/api/tags`, 3000);
  if (ollama.ok) {
    emit('ollama', 'ok', `${t.ollamaBaseUrlForN8n} responded ${ollama.status}`, false);
  } else {
    emit('ollama', 'warn', `${t.ollamaBaseUrlForN8n} unreachable: ${ollama.error ?? ollama.status}`, false);
  }

  // 6. Mongo
  try {
    const client = new MongoClient(t.mongoUriForMastra, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    await client.db(t.mongoDbName).command({ ping: 1 });
    await client.close();
    emit('mongo', 'ok', `${t.mongoHostForN8n} (db=${t.mongoDbName}) reachable`);
  } catch (err) {
    emit('mongo', 'fail', `${t.mongoUriForMastra} unreachable: ${(err as Error).message}`);
  }

  // 7. Telegram
  if (process.env.N8N_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID) {
    emit('telegram_chat_id', 'ok', 'configured', false);
  } else {
    emit('telegram_chat_id', 'warn', 'N8N_TELEGRAM_CHAT_ID not set (Telegram alerts disabled)', false);
  }

  // 8. Credential registry
  const credKeys: Array<[string, string]> = [
    ['telegram', 'N8N_CREDENTIAL_TELEGRAM_ID'],
    ['mongo', 'N8N_CREDENTIAL_MONGO_ID'],
    ['gmail', 'N8N_CREDENTIAL_GMAIL_ID'],
    ['http', 'N8N_CREDENTIAL_HTTP_ID'],
  ];
  for (const [service, envKey] of credKeys) {
    if (process.env[envKey]) emit(`cred_${service}`, 'ok', `${envKey} set`, false);
    else emit(`cred_${service}`, 'warn', `${envKey} not set (workflowy z ${service} beda missingCredentials)`, false);
  }

  // ── Render
  const symbol = (s: Status) => (s === 'ok' ? '✓' : s === 'warn' ? '!' : s === 'skip' ? '-' : '✗');
  const color = (s: Status) =>
    s === 'ok' ? '\x1b[32m' : s === 'warn' ? '\x1b[33m' : s === 'fail' ? '\x1b[31m' : '\x1b[90m';
  const reset = '\x1b[0m';

  console.log('Runtime checks:');
  for (const c of checks) {
    console.log(`  ${color(c.status)}${symbol(c.status)}${reset} ${c.key.padEnd(20)} ${c.message}`);
  }

  const blockers = checks.filter((c) => c.required && c.status === 'fail');
  console.log('');
  if (blockers.length > 0) {
    console.log(`\x1b[31m${blockers.length} blocker(s)${reset} — agent automatyzacji nie podniesie sie poprawnie.`);
    process.exit(1);
  }

  const warnings = checks.filter((c) => c.status === 'warn').length;
  if (warnings > 0) console.log(`\x1b[33m${warnings} warning(s)${reset} — niekrytyczne, ale niektore patterny moga miec missingConfig.`);
  console.log('\x1b[32mAll required checks passed.\x1b[0m');
}

main().catch((err) => {
  console.error(`\x1b[31mUnexpected error:\x1b[0m`, err);
  process.exit(1);
});
