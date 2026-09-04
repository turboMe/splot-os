/**
 * Safe cleanup and archiving script for /projekty/splot-projects root.
 * Moves legacy files into categorized subfolders under _archive_legacy/
 * while preserving private folders (dokumenty, Alfred-job, listy_motywacyjne)
 * and the 9 official domain folders.
 */
import fs from 'node:fs';
import path from 'node:path';

const JARVIS_ROOT = '/projekty/splot-projects';
const ARCHIVE_ROOT = path.join(JARVIS_ROOT, '_archive_legacy');

const OFFICIAL_DIRS = new Set([
  'projects',
  'menu-books',
  'content-packs',
  'writer-books',
  'hunt-reports',
  'design',
  'media',
  'drafts',
  'artifacts',
  '_archive_legacy',
]);

const PRESERVED_PRIVATE_DIRS = new Set([
  'dokumenty',
  'Alfred-job',
  'listy_motywacyjne',
]);

async function organize() {
  console.log('=== Cleaning up and Archiving /projekty/splot-projects ===\n');

  if (!fs.existsSync(JARVIS_ROOT)) {
    console.error('Directory does not exist:', JARVIS_ROOT);
    process.exit(1);
  }

  // Ensure archive subfolders exist
  const archiveSubdirs = [
    'n8n_workflows',
    'supplier_catalogs',
    'writer_drafts',
    'marketing_drafts',
    'chef_drafts',
    'audit_reports',
    'media_legacy',
  ];

  for (const sub of archiveSubdirs) {
    const full = path.join(ARCHIVE_ROOT, sub);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
    }
  }

  // 1. Move rhythm_wizytowka.html to design/rytm-wizytowka/index.html
  const rytmFile = path.join(JARVIS_ROOT, 'rytm_wizytowka.html');
  const designRytmDir = path.join(JARVIS_ROOT, 'design', 'rytm-wizytowka');
  if (fs.existsSync(rytmFile)) {
    if (!fs.existsSync(designRytmDir)) {
      fs.mkdirSync(designRytmDir, { recursive: true });
    }
    fs.renameSync(rytmFile, path.join(designRytmDir, 'index.html'));
    console.log('✓ Moved rytm_wizytowka.html -> design/rytm-wizytowka/index.html');
  }

  // 2. Process non-standard directories
  const oldDesignWork = path.join(JARVIS_ROOT, 'design-work');
  if (fs.existsSync(oldDesignWork)) {
    const target = path.join(ARCHIVE_ROOT, 'legacy_design_work');
    fs.renameSync(oldDesignWork, target);
    console.log('✓ Moved folder design-work/ -> _archive_legacy/legacy_design_work/');
  }

  const oldN8nWorkflows = path.join(JARVIS_ROOT, 'n8n_workflows');
  if (fs.existsSync(oldN8nWorkflows)) {
    const files = fs.readdirSync(oldN8nWorkflows);
    for (const f of files) {
      fs.renameSync(path.join(oldN8nWorkflows, f), path.join(ARCHIVE_ROOT, 'n8n_workflows', f));
    }
    fs.rmdirSync(oldN8nWorkflows);
    console.log('✓ Moved contents of n8n_workflows/ -> _archive_legacy/n8n_workflows/');
  }

  const oldWorkflows = path.join(JARVIS_ROOT, 'workflows');
  if (fs.existsSync(oldWorkflows)) {
    const files = fs.readdirSync(oldWorkflows);
    for (const f of files) {
      fs.renameSync(path.join(oldWorkflows, f), path.join(ARCHIVE_ROOT, 'n8n_workflows', f));
    }
    fs.rmdirSync(oldWorkflows);
    console.log('✓ Moved contents of workflows/ -> _archive_legacy/n8n_workflows/');
  }

  const emptyPolandJob = path.join(JARVIS_ROOT, 'Poland-AI-job');
  if (fs.existsSync(emptyPolandJob)) {
    try {
      fs.rmdirSync(emptyPolandJob);
      console.log('✓ Removed empty folder Poland-AI-job/');
    } catch { /* ignore if not empty */ }
  }

  const emptyProjekty = path.join(JARVIS_ROOT, 'projekty');
  if (fs.existsSync(emptyProjekty)) {
    try {
      fs.rmSync(emptyProjekty, { recursive: true, force: true });
      console.log('✓ Removed empty folder projekty/');
    } catch { /* ignore */ }
  }

  // 3. Categorize and move all root files
  const rootEntries = fs.readdirSync(JARVIS_ROOT, { withFileTypes: true });

  let fileCount = 0;
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;

    const fileName = entry.name;
    const srcPath = path.join(JARVIS_ROOT, fileName);
    let targetSubdir = 'audit_reports'; // default fallback

    // Categorization rules
    if (fileName.includes('n8n') || fileName.includes('workflow') || fileName.includes('telegram') || fileName.includes('aggregator') || fileName.startsWith('.tmp_') || fileName.startsWith('tmp_') || fileName.includes('_ref.json')) {
      targetSubdir = 'n8n_workflows';
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.zip') || fileName.includes('supplier') || fileName.includes('dostawcy') || fileName.includes('leady') || fileName.includes('CRM') || fileName.includes('crm') || fileName.includes('classification')) {
      targetSubdir = 'supplier_catalogs';
    } else if (fileName.includes('chronicler') || fileName.includes('critic') || fileName.includes('krew-na-szkle') || fileName.includes('Przyplyw') || fileName.includes('decision_memo') || fileName.includes('lyric')) {
      targetSubdir = 'writer_drafts';
    } else if (fileName.includes('linkedin') || fileName.includes('tiktok') || fileName.includes('cold_email') || fileName.includes('email_drafts') || fileName.includes('szkic_maila') || fileName.startsWith('post') || fileName.includes('revised-article')) {
      targetSubdir = 'marketing_drafts';
    } else if (fileName.includes('menu') || fileName.includes('recipe') || fileName.includes('przy_kominku') || fileName.includes('grillmarkadurinn') || fileName.includes('kol_')) {
      targetSubdir = 'chef_drafts';
    } else if (fileName.endsWith('.png') || fileName.endsWith('.mp4') || fileName.endsWith('.html') || fileName.endsWith('.py')) {
      targetSubdir = 'media_legacy';
    }

    const destPath = path.join(ARCHIVE_ROOT, targetSubdir, fileName);
    fs.renameSync(srcPath, destPath);
    fileCount++;
  }

  console.log(`\n✅ Finished! Moved ${fileCount} root files into _archive_legacy/`);

  // Print final clean directory layout
  console.log('\n=== Final Clean Layout of /projekty/splot-projects ===');
  const finalEntries = fs.readdirSync(JARVIS_ROOT, { withFileTypes: true });
  for (const entry of finalEntries) {
    if (entry.isDirectory()) {
      if (OFFICIAL_DIRS.has(entry.name)) {
        console.log(`  📁 [DOMAIN] ${entry.name}/`);
      } else if (PRESERVED_PRIVATE_DIRS.has(entry.name)) {
        console.log(`  📁 [PRIVATE] ${entry.name}/`);
      } else {
        console.log(`  📁 ${entry.name}/`);
      }
    } else {
      console.log(`  📄 ${entry.name}`);
    }
  }
}

organize().catch((err) => {
  console.error('❌ Error organizing archive:', err);
  process.exit(1);
});
