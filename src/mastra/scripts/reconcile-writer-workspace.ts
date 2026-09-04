/**
 * Reconcile writer projects between MongoDB and the filesystem (/projekty/splot-projects/writer-books).
 * Normalizes project folder names, removes obsolete ghost projects, and registers existing projects.
 * Run with: npx tsx src/mastra/scripts/reconcile-writer-workspace.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../lib/mongo.js';
import { getWriterBooksDir } from '../config/workspace-paths.js';

async function reconcile() {
  console.log('=== Reconciling Writer Projects with Workspace ===\n');

  const writerBooksDir = getWriterBooksDir();
  console.log('Writer Books Directory:', writerBooksDir);

  if (!fs.existsSync(writerBooksDir)) {
    fs.mkdirSync(writerBooksDir, { recursive: true });
  }

  // 1. Rename folders with special characters/spaces to clean slugs
  const renames: Array<[string, string]> = [
    ['GastroBridge – platforma', 'gastrobridge-platforma'],
    ['gastrobridge-artykuł pracowy', 'gastrobridge-artykul-prasowy'],
  ];

  for (const [oldName, newName] of renames) {
    const oldPath = path.join(writerBooksDir, oldName);
    const newPath = path.join(writerBooksDir, newName);
    if (fs.existsSync(oldPath)) {
      if (!fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
        console.log(`✓ Renamed "${oldName}" -> "${newName}"`);
      } else {
        // Merge if new already exists
        const files = fs.readdirSync(oldPath);
        for (const f of files) {
          fs.copyFileSync(path.join(oldPath, f), path.join(newPath, f));
        }
        fs.rmSync(oldPath, { recursive: true, force: true });
        console.log(`✓ Merged "${oldName}" into "${newName}" and removed old folder`);
      }
    }
  }

  // 2. Ensure autoreferencja has manuscript.md
  const autoDir = path.join(writerBooksDir, 'autoreferencja');
  const autoManuscript = path.join(autoDir, 'manuscript', 'autoreferencja.md');
  const autoTargetManuscript = path.join(autoDir, 'manuscript.md');
  if (fs.existsSync(autoManuscript) && !fs.existsSync(autoTargetManuscript)) {
    fs.copyFileSync(autoManuscript, autoTargetManuscript);
    console.log('✓ Created autoreferencja/manuscript.md from manuscript/autoreferencja.md');
  }

  // 3. Scan all valid project directories on disk
  const onDiskEntries = fs.readdirSync(writerBooksDir, { withFileTypes: true });
  const diskProjects: Array<{ id: string; name: string; type: string; brief: string }> = [];

  for (const entry of onDiskEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const projectId = entry.name;
    let name = projectId;
    let type = 'book';
    let brief = 'Projekt literacki';

    if (projectId === 'autoreferencja') {
      name = 'Autoreferencja — Powieść SF';
      type = 'book';
      brief = 'Powieść · literackie science fiction o emergencji samoświadomości agentów AI';
    } else if (projectId === 'gastrobridge-platforma') {
      name = 'GastroBridge — Platforma';
      type = 'article';
      brief = 'Artykuł przekrojowy o platformie GastroBridge';
    } else if (projectId === 'gastrobridge-artykul-prasowy') {
      name = 'GastroBridge — Artykuł Prasowy';
      type = 'article';
      brief = 'Artykuł prasowy o transformacji technologicznej gastronomii';
    }

    diskProjects.push({ id: projectId, name, type, brief });
  }

  console.log(`\nFound ${diskProjects.length} valid projects on disk:`, diskProjects.map((p) => p.id));

  // 4. Update MongoDB collection
  const db = await getDb();
  const collection = db.collection('writer_projects');

  // Remove old ghost projects not on disk
  const validIds = diskProjects.map((p) => p.id);
  const deleteResult = await collection.deleteMany({ id: { $nin: validIds } });
  console.log(`✓ Removed ${deleteResult.deletedCount} ghost/archived project records from MongoDB`);

  const now = new Date();
  for (const proj of diskProjects) {
    await collection.updateOne(
      { id: proj.id },
      {
        $set: {
          id: proj.id,
          name: proj.name,
          type: proj.type,
          status: 'done',
          brief: proj.brief,
          deliverableLanguage: 'pl',
          workingLanguage: 'en',
          autonomyMode: 'checkpointed',
          taskMode: 'full_project',
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
          manuscriptVersions: [],
          outlineVersion: 1,
        },
      },
      { upsert: true },
    );
    console.log(`✓ Upserted project in MongoDB: "${proj.name}" (ID: ${proj.id})`);
  }

  console.log('\n✅ Writer projects reconciliation complete! All projects in UI are 100% in sync with disk.');
}

reconcile()
  .catch((err) => {
    console.error('❌ Reconcile error:', err);
    process.exit(1);
  })
  .then(() => process.exit(0));
