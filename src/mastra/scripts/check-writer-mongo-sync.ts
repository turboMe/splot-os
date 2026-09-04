import { getDb } from '../lib/mongo.js';
import fs from 'node:fs';
import path from 'node:path';
import { getWriterBooksDir } from '../config/workspace-paths.js';

async function check() {
  const db = await getDb();
  const mongoProjects = await db.collection('writer_projects').find({}).toArray();
  console.log('=== MongoDB writer_projects (' + mongoProjects.length + ') ===');
  for (const p of mongoProjects) {
    console.log(` - ID: "${p.id}" | Name: "${p.name}" | Status: "${p.status}" | currentManuscriptId: "${p.currentManuscriptId}"`);
  }

  const dir = getWriterBooksDir();
  console.log('\n=== Filesystem writer-books (' + dir + ') ===');
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const subFiles = fs.readdirSync(path.join(dir, e.name));
        console.log(` - 📁 "${e.name}" (contains ${subFiles.length} files: ${subFiles.join(', ')})`);
      } else {
        console.log(` - 📄 "${e.name}"`);
      }
    }
  } else {
    console.log('Dir does not exist!');
  }
}

check().catch(console.error).then(() => process.exit(0));
