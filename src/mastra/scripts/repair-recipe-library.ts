/**
 * Source-data repair for the personal recipe library.
 *
 * Disk is the system of record (storage/recipes/recipes-structured/<category>.json);
 * Mongo is derived from it by embed-recipe-library.ts. So both defects below are
 * repaired HERE — a Mongo-only fix would be silently overwritten on the next import.
 *
 * Two passes, both non-destructive and both following the cleanup convention the
 * corpus already uses (`_quarantine.json`, `_quarantineReason`, `_originFile`):
 *
 *  1. MOJIBAKE — records whose text was decoded CP1250-as-Latin-1 ('MIÊSO',
 *     'KSI¥¯KA KUCHARSKA', 'Zrazy wo³owe'). Every string in the record is repaired,
 *     case-preserving, gated on diagnostic characters so clean records never change.
 *
 *  2. CHAPTER BLOBS — whole cookbook chapters imported as one recipe, identified by
 *     the shared isChapterBlob predicate (oversized + all-caps section title +
 *     mostly non-ingredient rows; see its comment for why all three are needed).
 *     They are MOVED to _quarantine.json, not deleted.
 *
 * DRY RUN by default — prints exactly what would change. Pass --apply to write,
 * which first copies every touched file to _backup/<file>.<timestamp>.json.
 *
 * After --apply, re-run `npm run embed:recipe-library` (re-embeds only the records
 * whose text changed) and `npm run enrich:recipe-flavor`.
 *
 * Run: npm run repair:recipe-library [-- --apply]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { hasMojibake, isChapterBlob, nonIngredientRatio, repairMojibake } from '../tools/chef/ingredient-normalizer.js';

const RECIPES_DIR = resolve(process.cwd(), 'storage/recipes/recipes-structured');
const QUARANTINE_PATH = join(RECIPES_DIR, '_quarantine.json');
const BACKUP_DIR = join(RECIPES_DIR, '_backup');

interface RecipeLike {
  id?: unknown;
  name?: unknown;
  ingredients?: Array<{ name?: unknown }> | null;
  [key: string]: unknown;
}

/** Recursively repair every string in a record. Non-strings pass through untouched. */
function repairDeep(value: unknown): unknown {
  if (typeof value === 'string') return repairMojibake(value);
  if (Array.isArray(value)) return value.map(repairDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = repairDeep(v);
    return out;
  }
  return value;
}

function containsMojibake(record: RecipeLike): boolean {
  return hasMojibake(JSON.stringify(record));
}

function ingredientNames(record: RecipeLike): string[] {
  return (record.ingredients ?? [])
    .map((i) => (typeof i?.name === 'string' ? i.name : ''))
    .filter((n): n is string => n.length > 0);
}

/** Delegates to the shared predicate so disk and retrieval quarantine the same records. */
function classifyBlob(record: RecipeLike): { blob: boolean; count: number; ratio: number } {
  const names = ingredientNames(record);
  const name = String(record.name ?? '');
  return {
    blob: isChapterBlob(name, names),
    count: names.length,
    ratio: names.length > 0 ? nonIngredientRatio(names) : 0,
  };
}

function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[repair-recipe-library] dir=${RECIPES_DIR} mode=${apply ? 'APPLY' : 'DRY RUN'}`);

  const files = readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const quarantined: Array<RecipeLike & { _quarantineReason: string; _originFile: string }> = [];
  let repairedCount = 0;
  let scanned = 0;
  const changedFiles: Array<{ file: string; kept: RecipeLike[] }> = [];

  for (const file of files) {
    const path = join(RECIPES_DIR, file);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) continue;

    const kept: RecipeLike[] = [];
    let fileRepaired = 0;
    let fileQuarantined = 0;

    for (const original of parsed as RecipeLike[]) {
      scanned++;
      let record = original;

      if (containsMojibake(record)) {
        const before = String(record.name ?? '');
        record = repairDeep(record) as RecipeLike;
        fileRepaired++;
        repairedCount++;
        const after = String(record.name ?? '');
        // The mojibake often sits in an ingredient or step rather than the name;
        // report the name only when the name itself changed.
        const detail = before === after ? '(name clean; repaired inside the record)' : `${JSON.stringify(before)} → ${JSON.stringify(after)}`;
        console.log(`  [mojibake] ${file} ${String(record.id)}\n             ${detail}`);
      }

      const { blob, count, ratio } = classifyBlob(record);
      if (blob) {
        fileQuarantined++;
        quarantined.push({ ...record, _quarantineReason: 'chapter-blob', _originFile: file });
        console.log(`  [chapter-blob] ${file} ${String(record.id)} — ${count} "ingredients", ${(ratio * 100).toFixed(0)}% non-ingredient — ${JSON.stringify(String(record.name ?? '').slice(0, 50))}`);
        continue;
      }
      kept.push(record);
    }

    if (fileRepaired > 0 || fileQuarantined > 0) {
      changedFiles.push({ file, kept });
      console.log(`  → ${file}: ${parsed.length} records, repaired ${fileRepaired}, quarantined ${fileQuarantined}, kept ${kept.length}`);
    }
  }

  console.log(
    `\n[repair-recipe-library] scanned ${scanned} records: ` +
      `mojibake repaired ${repairedCount}, chapter blobs quarantined ${quarantined.length}, files touched ${changedFiles.length}`,
  );

  if (!apply) {
    console.log('[repair-recipe-library] DRY RUN — nothing written. Re-run with --apply to commit these changes.');
    return;
  }

  if (changedFiles.length === 0) {
    console.log('[repair-recipe-library] nothing to do.');
    return;
  }

  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const { file, kept } of changedFiles) {
    const path = join(RECIPES_DIR, file);
    copyFileSync(path, join(BACKUP_DIR, `${file}.${stamp}.bak`));
    writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
  }

  const existingQuarantine = existsSync(QUARANTINE_PATH)
    ? (JSON.parse(readFileSync(QUARANTINE_PATH, 'utf8')) as unknown[])
    : [];
  const quarantineList = Array.isArray(existingQuarantine) ? existingQuarantine : [];
  copyFileSync(QUARANTINE_PATH, join(BACKUP_DIR, `_quarantine.json.${stamp}.bak`));
  writeFileSync(
    QUARANTINE_PATH,
    `${JSON.stringify([...quarantineList, ...quarantined], null, 2)}\n`,
    'utf8',
  );

  console.log(
    `[repair-recipe-library] written. backups in ${BACKUP_DIR}\n` +
      `  _quarantine.json: ${quarantineList.length} → ${quarantineList.length + quarantined.length}\n` +
      '  next: npm run embed:recipe-library && npm run enrich:recipe-flavor',
  );
}

main();
