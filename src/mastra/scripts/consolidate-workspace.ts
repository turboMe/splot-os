/**
 * Safe consolidation and migration script for Splot OS Workspace.
 * Copies and synchronizes files from legacy/scattered directories into WORKSPACE_ROOT.
 * Run with: npx tsx src/mastra/scripts/consolidate-workspace.ts
 */
import fs from 'node:fs';
import path from 'node:path';
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

function copyDirRecursive(src: string, dest: string): number {
  if (!fs.existsSync(src)) return 0;
  if (path.resolve(src) === path.resolve(dest)) return 0;

  let count = 0;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      if (!fs.existsSync(destPath) || fs.statSync(srcPath).mtimeMs > fs.statSync(destPath).mtimeMs) {
        fs.copyFileSync(srcPath, destPath);
        count++;
      }
    }
  }
  return count;
}

async function run() {
  console.log('=== Splot OS Workspace Consolidation ===\n');
  const wsRoot = getWorkspaceRoot();
  console.log(`Target Workspace Root: ${wsRoot}\n`);

  await ensureWorkspaceDirs();

  const migrationTasks: Array<{ name: string; source: string; target: string }> = [
    // 1. Chef Menu Books
    {
      name: 'Chef Menu Books',
      source: '/projekty/splot-projects/menu-books',
      target: getMenuBooksDir(),
    },
    // 2. Content Packs
    {
      name: 'Content Packs',
      source: '/projekty/splot-projects/content-packs',
      target: getContentPacksDir(),
    },
    // 3. Writer Books
    {
      name: 'Writer Books',
      source: '/projekty/splot-projects/writer-books',
      target: getWriterBooksDir(),
    },
    // 4. Hunt Reports
    {
      name: 'Hunt Reports',
      source: '/projekty/splot-projects/hunt-reports',
      target: getHuntReportsDir(),
    },
    // 5. Design Work (from repo root & public)
    {
      name: 'Design Work (Repo Root)',
      source: path.resolve(process.cwd(), 'design-work'),
      target: getDesignOutputDir(),
    },
    {
      name: 'Design Work (Public)',
      source: path.resolve(process.cwd(), 'src/mastra/public/design-work'),
      target: getDesignOutputDir(),
    },
    // 6. Media (Film & Music)
    {
      name: 'Film Work',
      source: path.resolve(process.cwd(), 'film-output'),
      target: path.join(getMediaOutputDir(), 'film'),
    },
    {
      name: 'Film Work (Public)',
      source: path.resolve(process.cwd(), 'src/mastra/public/film-work'),
      target: path.join(getMediaOutputDir(), 'film'),
    },
    {
      name: 'Music Work (Public)',
      source: path.resolve(process.cwd(), 'src/mastra/public/music-work'),
      target: path.join(getMediaOutputDir(), 'music'),
    },
    // 7. Drafts
    {
      name: 'Drafts (.drafts)',
      source: path.resolve(process.cwd(), '.drafts'),
      target: getDraftsDir(),
    },
    {
      name: 'Drafts (Public .drafts)',
      source: path.resolve(process.cwd(), 'src/mastra/public/.drafts'),
      target: getDraftsDir(),
    },
    // 8. Debates Artifacts
    {
      name: 'Debate Artifacts',
      source: path.resolve(process.cwd(), 'artifacts/debates'),
      target: path.join(getArtifactsDir(), 'debates'),
    },
    // 9. External Projects
    {
      name: 'External Projects (agent-projects)',
      source: '/projekty/agent-projects',
      target: getProjectsDir(),
    },
  ];

  let totalFilesCopied = 0;
  for (const task of migrationTasks) {
    if (fs.existsSync(task.source)) {
      const copied = copyDirRecursive(task.source, task.target);
      console.log(`✓ [${task.name}] Synced ${copied} files from ${task.source} -> ${task.target}`);
      totalFilesCopied += copied;
    } else {
      console.log(`- [${task.name}] Source directory does not exist: ${task.source} (skipped)`);
    }
  }

  console.log(`\n✅ Workspace consolidation complete! Total files synchronized: ${totalFilesCopied}`);
  console.log(`All agents and http://localhost:4111/splot now point to: ${wsRoot}`);
}

run().catch((err) => {
  console.error('❌ Consolidation error:', err);
  process.exit(1);
});
