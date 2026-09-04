/**
 * Izolowany test ErrorCollector — Etap 7 Smoke Test
 *
 * Testuje logikę ErrorCollector BEZ uruchamiania workflow
 * (wymaga tylko Mongo).
 *
 * Uruchomienie: npx tsx src/mastra/scripts/test-error-collector.ts
 */

import { ErrorCollector } from '../services/error-collector.js';
import { getDb, closeDb } from '../lib/mongo.js';

// ── Kolory terminalowe ──
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function pass(name: string) { console.log(`  ${GREEN}✓${RESET} ${name}`); }
function fail(name: string, reason: string) { console.log(`  ${RED}✗${RESET} ${name} — ${reason}`); }
function section(name: string) { console.log(`\n${BOLD}${YELLOW}▶ ${name}${RESET}`); }

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, reason = 'assertion failed') {
  if (condition) { pass(name); passed++; }
  else { fail(name, reason); failed++; }
}

async function main() {
  console.log(`\n${BOLD}═══ ErrorCollector Unit Test ═══${RESET}\n`);

  const collector = new ErrorCollector();

  // ── Test 1: hashError determinism ──
  section('hashError — determinizm');
  {
    const err1 = new TypeError('Cannot read property \'value\' of undefined');
    err1.stack = 'TypeError: Cannot read property \'value\' of undefined\n    at Object.run (app.ts:42)\n    at main (index.ts:10)\n    at bootstrap (start.ts:5)';
    const err2 = new TypeError('Cannot read property \'value\' of undefined');
    err2.stack = err1.stack; // identyczny stack
    const hash1 = collector.hashError(err1);
    const hash2 = collector.hashError(err2);

    assert(hash1 === hash2, 'Ten sam komunikat + stack → ta sama sygnatura');
    assert(hash1.length === 16, `Sygnatura ma 16 znaków (got ${hash1.length})`);

    const err3 = new RangeError('Maximum call stack exceeded');
    const hash3 = collector.hashError(err3);
    assert(hash1 !== hash3, 'Różne błędy → różne sygnatury');
  }

  // ── Test 2: hashError — różne stack trace, ten sam message ──
  section('hashError — top-3 stack lines');
  {
    const err1 = new Error('test error');
    err1.stack = 'Error: test error\n    at A (file.ts:1)\n    at B (file.ts:2)\n    at C (file.ts:3)';

    const err2 = new Error('test error');
    err2.stack = 'Error: test error\n    at A (file.ts:1)\n    at B (file.ts:2)\n    at C (file.ts:3)\n    at D (file.ts:4)';

    const hash1 = collector.hashError(err1);
    const hash2 = collector.hashError(err2);

    assert(hash1 === hash2, 'Identyczne top-3 stack lines → ta sama sygnatura (4. linia ignorowana)');
  }

  // ── Test 3: Mongo — zapis i odczyt ticketów ──
  section('Mongo — kolekcja auto_healing_tickets');
  let testTicketId: string | undefined;
  {
    try {
      const db = await getDb();
      const col = db.collection('auto_healing_tickets');

      // Czyścimy stare testowe tickety
      await col.deleteMany({ 'context.metadata.testRun': true });

      // Wstawienie testowego ticketa
      testTicketId = `test-heal-${Date.now()}`;
      await col.insertOne({
        ticketId: testTicketId,
        errorSignature: 'test-sig-12345678',
        errorMessage: 'Test error for smoke',
        stackTrace: 'Error: Test error\n    at test.ts:1',
        context: { source: 'test', metadata: { testRun: true } },
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000), // 1 min TTL
      });

      const found = await col.findOne({ ticketId: testTicketId });
      assert(found !== null, 'Ticket zapisany i odczytany z Mongo');
      assert(found?.status === 'pending', `Status = "pending" (got "${found?.status}")`);

      // Deduplikacja: szukamy aktywnego ticketa o tej samej sygnaturze
      const dup = await col.findOne({
        errorSignature: 'test-sig-12345678',
        status: { $in: ['pending', 'in_progress'] },
      });
      assert(dup !== null, 'Deduplikacja: aktywny ticket o tej sygnaturze istnieje');

      // Resolve
      await col.updateOne(
        { ticketId: testTicketId },
        { $set: { status: 'resolved', updatedAt: new Date().toISOString() } },
      );
      const resolved = await col.findOne({ ticketId: testTicketId });
      assert(resolved?.status === 'resolved', 'Ticket resolved prawidłowo');

      // Cleanup
      await col.deleteMany({ 'context.metadata.testRun': true });
      pass('Testowe tickety wyczyszczone');
    } catch (err: any) {
      fail('Mongo operations', err.message);
      failed++;
    }
  }

  // ── Test 4: reportError — self-protection ──
  section('reportError — zabezpieczenia (bez workflow trigger)');
  {
    // Tworzymy collector z overridden _triggerWorkflow, żeby NIE odpalał prawdziwego workflow
    const safeCollector = new ErrorCollector();
    // @ts-ignore — dostęp do prywatnej metody w celach testowych
    safeCollector._triggerWorkflow = async () => {
      // No-op — nie odpalamy workflow w teście
    };

    // Pierwsza próba — powinna "triggerować" (ale nasz no-op nie zrobi nic groźnego)
    const err1 = new Error('safe-test-error-' + Date.now());
    const result1 = await safeCollector.reportError(err1, {
      source: 'test',
      metadata: { testRun: true },
    });
    assert(result1.triggered === true, `Pierwsze zgłoszenie → triggered=true (got ${result1.triggered})`);
    assert(result1.ticketId !== undefined, `ticketId zwrócony: ${result1.ticketId}`);

    // Druga próba z TYM SAMYM błędem — deduplikacja powinna zablokować
    const result2 = await safeCollector.reportError(err1, {
      source: 'test',
      metadata: { testRun: true },
    });
    // Cooldown powinien zablokować (60s cooldown)
    assert(result2.triggered === false, `Drugie zgłoszenie → triggered=false (cooldown/dedup)`);
    assert(result2.reason.length > 0, `Reason: "${result2.reason}"`);

    // Cleanup testowych ticketów
    try {
      const db = await getDb();
      await db.collection('auto_healing_tickets').deleteMany({ 'context.metadata.testRun': true });
      pass('Testowe tickety wyczyszczone po teście reportError');
    } catch {
      // ok
    }
  }

  // ── Test 5: getActiveTickets ──
  section('getActiveTickets — diagnostyka');
  {
    const tickets = await collector.getActiveTickets();
    assert(Array.isArray(tickets), `getActiveTickets zwraca tablicę (${tickets.length} aktywnych)`);
  }

  // ── Test 6: cleanupExpired ──
  section('cleanupExpired — czyszczenie TTL');
  {
    const db = await getDb();
    const col = db.collection('auto_healing_tickets');

    // Wstaw wygasły ticket
    await col.insertOne({
      ticketId: `expired-test-${Date.now()}`,
      errorSignature: 'expired-test',
      errorMessage: 'Expired test',
      stackTrace: '',
      context: { source: 'test', metadata: { testRun: true } },
      status: 'pending',
      createdAt: new Date(Date.now() - 100_000).toISOString(),
      updatedAt: new Date(Date.now() - 100_000).toISOString(),
      expiresAt: new Date(Date.now() - 1000), // W przeszłości
    });

    const count = await collector.cleanupExpired();
    assert(count >= 1, `cleanupExpired usunął ${count} wygasłych ticketów`);

    // Final cleanup
    await col.deleteMany({ 'context.metadata.testRun': true });
  }

  // ── Podsumowanie ──
  console.log(`\n${BOLD}═══ Wyniki ═══${RESET}`);
  console.log(`  ${GREEN}Passed: ${passed}${RESET}`);
  if (failed > 0) console.log(`  ${RED}Failed: ${failed}${RESET}`);
  else console.log(`  ${GREEN}Wszystkie testy przeszły! ✅${RESET}`);

  await closeDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
