#!/usr/bin/env tsx
/**
 * Build Script: Compiles modular Splot OS frontend (HTML, CSS, JS) from
 * public/agent-chat-panel/ into single-file /projekty/splot-projects/artifacts/agent_chat_panel.html
 *
 * Run with --watch to rebuild automatically whenever a source file under
 * public/agent-chat-panel/ changes (refresh the browser to see the update).
 */

import { readFile, writeFile, mkdir, watch } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import * as esbuild from 'esbuild';

const rootDir = '/projekty/mastra-agentic-environment/agentic-agents/public/agent-chat-panel';
const outPath = '/projekty/splot-projects/artifacts/agent_chat_panel.html';

async function buildBundle() {
  console.log('[BuildSplotBundle] Reading source files from:', rootDir);

  // 1. Read index.html
  let html = await readFile(resolve(rootDir, 'index.html'), 'utf8');

  // 2. Read and inline CSS
  const cssFiles = ['tokens.css', 'layout.css', 'chat.css', 'steps.css', 'inspectors.css', 'modals.css', 'dashboard-tabs.css'];
  let combinedCss = '/* === SPLOT OS BUNDLED STYLES === */\n';
  for (const f of cssFiles) {
    try {
      const content = await readFile(resolve(rootDir, 'styles', f), 'utf8');
      combinedCss += `\n/* --- ${f} --- */\n` + content;
    } catch (err) {
      console.warn(`[BuildSplotBundle] Warning: could not read styles/${f}:`, (err as Error).message);
    }
  }

  // Replace <link rel="stylesheet" href="styles/..."> with inline <style>
  html = html.replace(/<link rel="stylesheet" href="styles\/[^"]+">\s*/g, '');
  html = html.replace('</head>', () => `  <style>\n${combinedCss}\n  </style>\n</head>`);

  // 3. Bundle JS with esbuild (IIFE)
  const appBuild = await esbuild.build({
    entryPoints: [resolve(rootDir, 'js/app.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });

  const appJsBundled = appBuild.outputFiles[0].text;
  const dashJs = await readFile(resolve(rootDir, 'js/dashboard-tabs.js'), 'utf8');

  const bundledJs = `
// === SPLOT OS BUNDLED JAVASCRIPT ENGINE ===

// 1. DASHBOARD TABS & COMMAND CENTER ENGINE
${dashJs}

// 2. APP & REALTIME AGENT CHAT CORE
${appJsBundled}
`;

  // Remove external module script tags from index.html
  html = html.replace(/<script[^>]*src="js\/[^"]+"[^>]*><\/script>\s*/g, '');

  // Add bundled script before </body> safely using a function replacer
  html = html.replace('</body>', () => `  <script>\n${bundledJs}\n  </script>\n</body>`);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');
  console.log(`[BuildSplotBundle] ✅ Successfully built bundled panel: ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
}

async function watchAndRebuild() {
  await buildBundle().catch(err => console.error('[BuildSplotBundle] ❌ Build failed:', err));
  console.log('[BuildSplotBundle] 👀 Watching for changes in', rootDir);

  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  const scheduleRebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (pending) return;
      pending = true;
      try {
        await buildBundle();
      } catch (err) {
        console.error('[BuildSplotBundle] ❌ Rebuild failed:', err);
      } finally {
        pending = false;
      }
    }, 150);
  };

  const watcher = watch(rootDir, { recursive: true });
  for await (const event of watcher) {
    if (event.filename) scheduleRebuild();
  }
}

if (process.argv.includes('--watch')) {
  watchAndRebuild();
} else {
  buildBundle().catch(err => {
    console.error('[BuildSplotBundle] ❌ Build failed:', err);
    process.exit(1);
  });
}
