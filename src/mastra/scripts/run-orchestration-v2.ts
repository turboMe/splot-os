#!/usr/bin/env tsx
/**
 * Launch the Orchestration V2 service (skeleton).
 *
 *   MONGODB_URI_V2=mongodb://localhost:27018/?replicaSet=rs0 PORT=4222 \
 *     npm run orchestration:v2:serve
 *
 * Requires a MongoDB replica set. For a local try: `npm run spike:mongo-rs:up`
 * first (ephemeral RS on :27018). The default worker is the deterministic fixture
 * (okWorker); wire a real ModelCaller for actual agent work.
 */
import { startOrchestrationService } from '../orchestration/service/index.js';

async function main(): Promise<void> {
  const handle = await startOrchestrationService({
    uri: process.env.MONGODB_URI_V2,
    dbName: process.env.MONGODB_DB_V2,
    port: Number(process.env.PORT ?? 4222),
  });
  console.log(`[orch-v2] ready — POST http://127.0.0.1:${handle.port}/v2/conversations/{cid}/commands (header x-resource-id)`);

  const shutdown = async (sig: string) => {
    console.log(`[orch-v2] ${sig} — shutting down`);
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => { console.error(`[orch-v2] failed to start: ${(err as Error).message}`); process.exit(1); });
