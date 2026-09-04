import { DuckDBStore } from '@mastra/duckdb';
import { resolveObservabilityDuckDBPath } from '../services/observability-retention.js';
import path from 'node:path';

const repoRoot = path.resolve('.');
const dbPath = resolveObservabilityDuckDBPath(repoRoot);
console.log(`[migrate-signals] Connecting to DuckDB at: ${dbPath}`);

const store = new DuckDBStore({ path: dbPath });
const obsStore = await store.getStore('observability');

console.log('[migrate-signals] Running migrateSpans()...');
const result = await (obsStore as any).migrateSpans();
console.log('[migrate-signals] Migration result:', result);

if (obsStore) {
  await obsStore.init();
}
console.log('[migrate-signals] store.init() succeeded without errors!');

process.exit(0);
