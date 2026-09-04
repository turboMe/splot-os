import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureWorkspaceDirs,
  getWriterBooksDir,
  getMenuBooksDir,
  getContentPacksDir,
  getDesignOutputDir,
} from '../config/workspace-paths.js';
import {
  deleteChefProject,
  deleteContentProject,
  deleteWriterProject,
  deleteDesignProject,
} from '../services/workspace-service.js';

async function runTests() {
  console.log('=== 1. Ensuring workspace dirs ===');
  await ensureWorkspaceDirs();

  const testWriterId = 'test-temp-writer-delete-me';
  const testWriterDir = path.join(getWriterBooksDir(), testWriterId);
  fs.mkdirSync(path.join(testWriterDir, 'manuscript'), { recursive: true });
  fs.writeFileSync(path.join(testWriterDir, 'manuscript.md'), '# Test Manuscript\n\n## Rozdział 1\nTreść testowa.');
  fs.writeFileSync(path.join(testWriterDir, 'manuscript', `${testWriterId}.pdf`), 'dummy pdf');
  
  assert.equal(fs.existsSync(testWriterDir), true, 'Test writer dir should exist');
  console.log('✓ Created test writer project directory at:', testWriterDir);

  const deleteWriterRes = await deleteWriterProject(testWriterId);
  console.log('✓ deleteWriterProject result:', deleteWriterRes);
  assert.equal(fs.existsSync(testWriterDir), false, 'Test writer dir should be deleted from disk');
  console.log('✓ deleteWriterProject successfully removed folder and files from disk!');

  const testChefId = 'test-temp-chef-delete-me';
  const testChefMd = path.join(getMenuBooksDir(), `${testChefId}.md`);
  const testChefPdf = path.join(getMenuBooksDir(), `${testChefId}.pdf`);
  fs.writeFileSync(testChefMd, '# Test Menu Book');
  fs.writeFileSync(testChefPdf, 'dummy pdf');
  assert.equal(fs.existsSync(testChefMd), true);

  const deleteChefRes = await deleteChefProject(testChefId);
  console.log('✓ deleteChefProject result:', deleteChefRes);
  assert.equal(fs.existsSync(testChefMd), false, 'Test chef md should be deleted');
  assert.equal(fs.existsSync(testChefPdf), false, 'Test chef pdf should be deleted');
  console.log('✓ deleteChefProject successfully removed menu files from disk!');

  const testContentId = 'test-temp-content-delete-me';
  const testContentMd = path.join(getContentPacksDir(), `${testContentId}.md`);
  fs.writeFileSync(testContentMd, '# Test Content Pack');
  assert.equal(fs.existsSync(testContentMd), true);

  const deleteContentRes = await deleteContentProject(testContentId);
  console.log('✓ deleteContentProject result:', deleteContentRes);
  assert.equal(fs.existsSync(testContentMd), false, 'Test content md should be deleted');
  console.log('✓ deleteContentProject successfully removed pack files from disk!');

  const testDesignId = 'test-temp-design-delete-me';
  const testDesignDir = path.join(getDesignOutputDir(), testDesignId);
  fs.mkdirSync(testDesignDir, { recursive: true });
  fs.writeFileSync(path.join(testDesignDir, 'index.html'), '<!doctype html><html><body>Test</body></html>');
  assert.equal(fs.existsSync(testDesignDir), true);

  const deleteDesignRes = await deleteDesignProject(testDesignId);
  console.log('✓ deleteDesignProject result:', deleteDesignRes);
  assert.equal(fs.existsSync(testDesignDir), false, 'Test design dir should be deleted');
  console.log('✓ deleteDesignProject successfully removed design folder from disk!');

  console.log('\n🎉 All delete tests passed with 100% success!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
