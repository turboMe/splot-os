#!/usr/bin/env tsx
/**
 * Bring stored lead statuses onto the canonical vocabulary.
 *
 * `sendDraftById` used to stamp `contacted` on every lead it emailed — a value
 * in no list anywhere, so the kanban (which draws one column per known status)
 * had nowhere to put those cards and simply did not draw them. Five of six
 * leads were invisible while the counter above the board still said six.
 *
 * The code no longer writes it, but the rows it already wrote are still there,
 * and they stay invisible until they are rewritten. This does that, using the
 * same alias table the UI falls back on, so there is one definition of what an
 * old value meant.
 *
 * Dry run by default — pass --apply to write.
 *
 *   npx tsx src/mastra/scripts/migrate-crm-statuses.ts
 *   npx tsx src/mastra/scripts/migrate-crm-statuses.ts --apply
 */
import { getDb, closeDb } from '../lib/mongo.js';
import {
  CRM_STATUSES,
  CRM_STATUS_ALIASES,
  normalizeCrmStatus,
} from '../config/crm-statuses.js';

const apply = process.argv.includes('--apply');

async function run(): Promise<void> {
  const db = await getDb();
  const leads = db.collection('leads');

  const distinct = (await leads.distinct('status')) as (string | null)[];
  const canonical = new Set<string>(CRM_STATUSES);

  const aliased: string[] = [];
  const unknown: string[] = [];
  for (const status of distinct) {
    if (status === null || status === undefined) continue;
    if (canonical.has(status)) continue;
    if (CRM_STATUS_ALIASES[status]) aliased.push(status);
    else unknown.push(status);
  }

  console.log(`Statusy w bazie: ${distinct.length} różnych`);
  console.log(`  kanoniczne:      ${distinct.filter((s) => s && canonical.has(s)).length}`);
  console.log(`  do przepisania:  ${aliased.length} ${aliased.length ? `(${aliased.join(', ')})` : ''}`);
  console.log(`  nieznane:        ${unknown.length} ${unknown.length ? `(${unknown.join(', ')})` : ''}`);

  if (unknown.length) {
    // Not migrated and not silently mapped: an unrecognised status is a decision
    // somebody has to make, and the UI now shows these in their own column
    // rather than dropping them.
    console.log('\n⚠️  Nieznane statusy zostają nietknięte — widoczne w kolumnie "Inne" w kanbanie.');
  }

  let changed = 0;
  for (const legacy of aliased) {
    const target = normalizeCrmStatus(legacy);
    if (!target) continue;
    const count = await leads.countDocuments({ status: legacy });
    if (!count) continue;

    if (apply) {
      const now = new Date();
      const res = await leads.updateMany(
        { status: legacy },
        {
          $set: { status: target, updatedAt: now },
          $push: {
            history: {
              timestamp: now,
              action: 'status_migrated',
              description: `Status "${legacy}" → "${target}" (ujednolicenie słownika CRM)`,
              agentId: 'migrate-crm-statuses',
            } as never,
          },
        },
      );
      changed += res.modifiedCount;
      console.log(`  ✅ ${legacy} → ${target}: ${res.modifiedCount} leadów`);
    } else {
      changed += count;
      console.log(`  (dry-run) ${legacy} → ${target}: ${count} leadów`);
    }
  }

  console.log(
    apply
      ? `\nGotowe. Przepisano ${changed} leadów.`
      : `\nDry run. Do przepisania: ${changed} leadów. Uruchom z --apply, żeby zapisać.`,
  );
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
