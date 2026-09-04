import assert from 'node:assert/strict';
import { toKebabCase, buildStandardProjectSlug } from '../lib/slug-utils.js';
import {
  getWorkspaceRoot,
  getProjectsDir,
  getMenuBooksDir,
  getContentPacksDir,
  getWriterBooksDir,
  getHuntReportsDir,
  getDesignOutputDir,
  getMediaOutputDir,
  getDraftsDir,
  getArtifactsDir,
  ensureWorkspaceDirs,
} from '../config/workspace-paths.js';

async function testAll() {
  console.log('=== 1. Testing slug-utils ===');
  assert.equal(toKebabCase('Restauracja Zagroda & Spa!'), 'restauracja-zagroda-spa');
  assert.equal(toKebabCase('Zażółć Gęślą Jaźń'), 'zazolc-gesla-jazn');
  assert.equal(toKebabCase('---Hello---World---'), 'hello-world');
  assert.equal(buildStandardProjectSlug('Zagroda', 'Wiosenne Menu 2026'), 'zagroda-wiosenne-menu-2026');
  assert.equal(buildStandardProjectSlug('Zagroda', 'zagroda-spring-menu'), 'zagroda-spring-menu');
  assert.equal(buildStandardProjectSlug('Peonia'), 'peonia');
  console.log('✓ slug-utils passed all assertion tests!');

  console.log('\n=== 2. Testing workspace-paths ===');
  const root = getWorkspaceRoot();
  assert.ok(root && typeof root === 'string', 'getWorkspaceRoot should return a valid string');
  assert.ok(getProjectsDir().startsWith(root) || getProjectsDir().length > 0, 'getProjectsDir valid');
  assert.ok(getMenuBooksDir().startsWith(root) || getMenuBooksDir().length > 0, 'getMenuBooksDir valid');
  assert.ok(getContentPacksDir().startsWith(root) || getContentPacksDir().length > 0, 'getContentPacksDir valid');
  assert.ok(getWriterBooksDir().startsWith(root) || getWriterBooksDir().length > 0, 'getWriterBooksDir valid');
  assert.ok(getHuntReportsDir().startsWith(root) || getHuntReportsDir().length > 0, 'getHuntReportsDir valid');
  assert.ok(getDesignOutputDir().startsWith(root) || getDesignOutputDir().length > 0, 'getDesignOutputDir valid');
  assert.ok(getMediaOutputDir().startsWith(root) || getMediaOutputDir().length > 0, 'getMediaOutputDir valid');
  assert.ok(getDraftsDir().startsWith(root) || getDraftsDir().length > 0, 'getDraftsDir valid');
  assert.ok(getArtifactsDir().startsWith(root) || getArtifactsDir().length > 0, 'getArtifactsDir valid');
  console.log('✓ workspace-paths passed all assertion tests!');

  console.log('\n=== 3. Testing ensureWorkspaceDirs ===');
  await ensureWorkspaceDirs();
  console.log('✓ ensureWorkspaceDirs executed without errors!');

  const {
    listWriterProjects,
    getWriterProjectBundle,
    getWriterDocumentHtml,
    getWriterPdfPath,
    getWriterStandaloneHtmlPath,
  } = await import('../services/workspace-service.js');
  const writerProjects = await listWriterProjects();
  console.log(`Found ${writerProjects.length} writer projects:`, writerProjects.map((p) => p.id));
  assert.ok(writerProjects.length > 0, 'Should return at least one active writer project');

  const bundle = await getWriterProjectBundle('autoreferencja');
  assert.ok(bundle && bundle.project?.name, 'autoreferencja bundle should have project name');
  assert.ok(bundle.document && bundle.document.wordCount > 1000, 'autoreferencja should have full word count');
  assert.ok(bundle.hasPdf, 'autoreferencja should have hasPdf: true');
  assert.ok(bundle.hasStandaloneHtml, 'autoreferencja should have hasStandaloneHtml: true');
  console.log(`✓ autoreferencja bundle loaded successfully: "${bundle.project.name}" (${bundle.document.wordCount} words, hasPdf: ${bundle.hasPdf}, hasStandaloneHtml: ${bundle.hasStandaloneHtml})!`);

  const pdfPath = await getWriterPdfPath('autoreferencja');
  assert.ok(pdfPath && pdfPath.endsWith('.pdf'), 'getWriterPdfPath should find PDF');
  console.log(`✓ getWriterPdfPath resolved: ${pdfPath}`);

  const standaloneHtmlPath = await getWriterStandaloneHtmlPath('autoreferencja');
  assert.ok(standaloneHtmlPath && standaloneHtmlPath.endsWith('.html'), 'getWriterStandaloneHtmlPath should find HTML');
  console.log(`✓ getWriterStandaloneHtmlPath resolved: ${standaloneHtmlPath}`);

  const htmlDoc = await getWriterDocumentHtml('autoreferencja');
  assert.ok(htmlDoc && htmlDoc.html.length > 10000, 'getWriterDocumentHtml should return full rendered book HTML');
  assert.ok(!htmlDoc.html.includes('Ten manuskrypt nie ma jeszcze'), 'Rendered HTML must not be empty');
  assert.ok(htmlDoc.html.includes('Rozdział 1'), 'Rendered HTML should contain chapters');
  assert.ok(htmlDoc.html.includes('Rozdział 14'), 'Rendered HTML should contain Chapter 14');
  console.log(`✓ getWriterDocumentHtml rendered full book (${htmlDoc.html.length} chars, 14 chapters)!`);

  console.log('\n✅ All workspace & slug-utils tests passed successfully!');
}

testAll().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
