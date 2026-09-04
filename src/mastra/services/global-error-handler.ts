/**
 * Global Error Handler Bootstrap (Etap 7)
 *
 * Rejestruje globalne handlery na:
 * - process.on('uncaughtException')
 * - process.on('unhandledRejection')
 *
 * Przekazuje złapane błędy do ErrorCollector, który decyduje
 * czy odpalić repo-maintenance-workflow.
 *
 * UWAGA: Ten moduł powinien być importowany raz, przy starcie Mastry (w index.ts).
 * Nie importuj go w wielu miejscach — handlery są globalne.
 */

import { getErrorCollector } from './error-collector.js';

let _initialized = false;

/**
 * Rejestruje globalne handlery błędów.
 * Bezpieczne do wielokrotnego wywołania — rejestracja następuje tylko raz.
 */
export function initGlobalErrorHandlers(): void {
  if (_initialized) return;
  _initialized = true;

  const collector = getErrorCollector();

  // ── Uncaught Exception ──
  process.on('uncaughtException', (error: Error, origin: string) => {
    console.error(`[GlobalErrorHandler] Uncaught exception (${origin}):`, error.message);

    // Nie przerywaj procesu — logujemy i próbujemy naprawić
    // WAŻNE: W produkcji Node.js zaleca restart po uncaughtException,
    // ale w naszym przypadku self-healing jest lepszą strategią.
    collector.reportError(error, {
      source: 'uncaughtException',
      origin,
      metadata: { processUptime: process.uptime() },
    }).then((result) => {
      if (result.triggered) {
        console.log(`[GlobalErrorHandler] 🔧 Self-healing triggered: ${result.ticketId}`);
      } else {
        console.log(`[GlobalErrorHandler] Self-healing skipped: ${result.reason}`);
      }
    }).catch((reportError) => {
      // Absolutny fallback — nie może rzucić dalej
      console.error('[GlobalErrorHandler] Failed to report error:', reportError.message);
    });
  });

  // ── Unhandled Rejection ──
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[GlobalErrorHandler] Unhandled rejection:', error.message);

    collector.reportError(error, {
      source: 'unhandledRejection',
      metadata: { processUptime: process.uptime() },
    }).then((result) => {
      if (result.triggered) {
        console.log(`[GlobalErrorHandler] 🔧 Self-healing triggered: ${result.ticketId}`);
      } else {
        console.log(`[GlobalErrorHandler] Self-healing skipped: ${result.reason}`);
      }
    }).catch((reportError) => {
      console.error('[GlobalErrorHandler] Failed to report error:', reportError.message);
    });
  });

  console.log('[GlobalErrorHandler] ✅ Global error handlers registered (uncaughtException + unhandledRejection)');
}
