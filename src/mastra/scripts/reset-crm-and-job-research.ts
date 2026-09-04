/**
 * Reset script for CRM contacts and Job Hunter research files.
 * - Cleans MongoDB `leads`, `drafts`, and `crm/leads` collections (retaining schemas and categories).
 * - Removes past job opportunity ledgers and portal opportunity files for Poland & Iceland.
 * - Preserves all CV folders, grounding files, and system settings.
 *
 * Run with: npx tsx src/mastra/scripts/reset-crm-and-job-research.ts
 */
import { getDb } from '../lib/mongo.js';
import * as fs from 'fs/promises';
import * as path from 'path';

async function main() {
  console.log('=== Rozpoczynanie czyszczenia CRM i badań rynkowych ===\n');

  // 1. Czyszczenie MongoDB CRM
  const db = await getDb();
  
  // Leads
  const leadsCol = db.collection('leads');
  const leadsCountBefore = await leadsCol.countDocuments();
  const leadsResult = await leadsCol.deleteMany({});
  console.log(`✓ Wyczyszczono kolekcję 'leads': usunięto ${leadsResult.deletedCount} kontaktów testowych (było: ${leadsCountBefore}).`);

  // Drafts
  const draftsCol = db.collection('drafts');
  const draftsCountBefore = await draftsCol.countDocuments();
  const draftsResult = await draftsCol.deleteMany({});
  console.log(`✓ Wyczyszczono kolekcję 'drafts': usunięto ${draftsResult.deletedCount} rekordów draftów (było: ${draftsCountBefore}).`);

  // Legacy crm/leads
  try {
    const legacyCol = db.collection('crm/leads');
    const legacyCount = await legacyCol.countDocuments();
    if (legacyCount > 0) {
      await legacyCol.deleteMany({});
      console.log(`✓ Wyczyszczono kolekcję 'crm/leads' (legacy): usunięto ${legacyCount} rekordów.`);
    }
  } catch {}

  // 2. Czyszczenie plików researchu ofert pracy w Poland-AI-job
  console.log('\n--- Czyszczenie badań rynku pracy (Polska AI) ---');
  const polandJobDir = '/projekty/splot-projects/Poland-AI-job';
  try {
    const polandFiles = await fs.readdir(polandJobDir);
    for (const file of polandFiles) {
      if (file.endsWith('.md')) {
        const fullPath = path.join(polandJobDir, file);
        await fs.unlink(fullPath);
        console.log(`  ✓ Usunięto plik: ${fullPath}`);
      }
    }
  } catch (err) {
    console.log(`  ! Katalog ${polandJobDir} pominięty lub pusty: ${(err as Error).message}`);
  }

  // 3. Czyszczenie plików researchu ofert pracy w Alfred-job (Islandia)
  console.log('\n--- Czyszczenie badań rynku pracy (Islandia / Alfred-job) ---');
  const alfredJobDir = '/projekty/splot-projects/Alfred-job';
  const alfredFilesToRemove = [
    'alfred-job-opportunities.md',
    'oferty-portalowe-2026-08-29.md',
    'oferty-portalowe-2026-08-30.md',
  ];
  for (const filename of alfredFilesToRemove) {
    const fullPath = path.join(alfredJobDir, filename);
    try {
      await fs.unlink(fullPath);
      console.log(`  ✓ Usunięto plik: ${fullPath}`);
    } catch {
      // Ignoruj jeśli nie istnieje
    }
  }

  console.log('\n✅ Czyszczenie zakończone sukcesem!');
  console.log('CRM jest gotowy na nowe leady (kategorie zachowane).');
  console.log('Skille Job Hunter (Polska i Islandia) zaczną skanowanie od czystego stanu.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Błąd podczas czyszczenia:', err);
  process.exit(1);
});
