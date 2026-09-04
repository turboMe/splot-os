import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getWriterBooksDir } from '../config/workspace-paths.js';
import { WriterService } from '../tools/writer/writer-service.js';
import { writerDocumentInit, writerDocumentWriteSection } from '../tools/writer/writer-document-tools.js';
import {
  listWriterProjects,
  getWriterProjectBundle,
  writerDocumentMarkdownToHtml,
} from '../services/workspace-service.js';
import { buildStandardProjectSlug } from '../lib/slug-utils.js';

async function testWriterFlow() {
  console.log('=== Testing Writer Domain End-to-End Creation & Splot OS Reading ===\n');

  // 1. Simulate agent creating a project slug and project
  const brandName = 'Flowmint';
  const topic = 'Mikrousługi w Gastronomii 2026';
  const slug = buildStandardProjectSlug(brandName, topic);
  console.log(`1. Generated Project Slug: "${slug}"`);
  assert.equal(slug, 'flowmint-mikrouslugi-w-gastronomii-2026');

  // 2. WriterService creates project in MongoDB with this slug/id
  const writer = new WriterService();
  const db = await (writer as any).getDb();
  await db.collection('writer_projects').deleteOne({ id: slug });

  const project = await writer.createProject({
    id: slug,
    name: 'Flowmint — Architektura Mikrousług',
    brief: 'Kompleksowy esej techniczny o architekturze mikrousług dla nowoczesnych lokali gastronomicznych.',
    type: 'article',
    deliverableLanguage: 'pl',
  });
  console.log(`2. Created project in MongoDB: ID="${project.id}"`);

  // 3. Initialize manuscript on disk
  const initResult = await writerDocumentInit({
    projectId: slug,
    title: 'Flowmint: Architektura Mikrousług w Gastronomii',
    deliverableLanguage: 'pl',
  });
  assert.ok(initResult.success, 'Document init should succeed');
  console.log(`3. Initialized manuscript.md on disk: ${initResult.path}`);

  // 4. Write content sections
  const writeResult = await writerDocumentWriteSection({
    projectId: slug,
    anchor: 'manuscript',
    content: `# Wprowadzenie do Mikrousług w HoReCa\n\nWspółczesna gastronomia wymaga odporności na awarie w godzinach szczytu. Zastosowanie architektury event-driven umożliwia niezależne skalowanie modułów zamówień, kuchni i płatności.`,
  });
  assert.ok(writeResult.success, 'Write section should succeed');
  console.log(`4. Wrote section 'manuscript' to disk.`);

  // 5. Query Splot OS workspace-service
  const projectList = await listWriterProjects();
  const found = projectList.find((p) => p.id === slug);
  assert.ok(found, 'Splot OS workspace list should include the new project');
  console.log(`5. Splot OS listWriterProjects() found project:`, {
    id: found.id,
    name: found.name,
    hasDocument: found.hasDocument,
    wordCount: found.wordCount,
  });

  // 6. Fetch full bundle for Splot OS detail view
  const bundle = await getWriterProjectBundle(slug);
  assert.ok(bundle, 'Splot OS bundle should load');
  assert.ok(bundle.document.content.includes('Współczesna gastronomia'), 'Document content should match');
  console.log(`6. Splot OS getWriterProjectBundle() loaded full document (${bundle.document.wordCount} words).`);

  // 7. Verify HTML rendering for Splot OS manuscript viewer
  const html = writerDocumentMarkdownToHtml(bundle.document.content);
  assert.ok(html.includes('<h1') && html.includes('Współczesna gastronomia'), 'HTML rendering should work');
  console.log(`7. Splot OS HTML rendering verified successfully!`);

  // 8. Clean up test project
  await db.collection('writer_projects').deleteOne({ id: slug });
  const diskPath = path.join(getWriterBooksDir(), slug);
  if (fs.existsSync(diskPath)) {
    fs.rmSync(diskPath, { recursive: true, force: true });
  }
  console.log(`8. Cleaned up test project from Mongo and disk.`);

  console.log('\n✅ All Writer End-to-End and Splot OS integration checks PASSED 100%!');
}

testWriterFlow()
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .then(() => process.exit(0));
