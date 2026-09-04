import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const repoRoot = process.cwd();

const designAgentSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/agents/design-agent.ts'), 'utf-8');
assert.ok(designAgentSource.includes("combinePrompts('design/domain', 'design/pipeline', 'shared/skill-shelf')"), 'designAgent loads design prompts and Skill Shelf contract');
assert.ok(designAgentSource.includes('designRenderVideoTool'), 'designAgent registers render video tool');
assert.ok(designAgentSource.includes('designExportPdfTool'), 'designAgent registers PDF export tool');
assert.ok(designAgentSource.includes('designExportPptxTool'), 'designAgent registers PPTX export tool');
assert.ok(designAgentSource.includes('designVerifyTool'), 'designAgent registers visual QA tool');

const designToolsSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/tools/design/design-tools.ts'), 'utf-8');
assert.ok(designToolsSource.includes("default('design-work/assets/img')"), 'design_fetch_images defaults into design-work');
assert.ok(designToolsSource.includes("default('design-work/assets/generated')"), 'design_generate_image defaults into design-work');
assert.ok(designToolsSource.includes('replaceExtension(htmlPath, \'\', \'.mp4\')'), 'render tools produce MP4 beside HTML');
assert.ok(designToolsSource.includes("id: 'design_export_pdf'"), 'design PDF export tool exists');
assert.ok(designToolsSource.includes("id: 'design_export_pptx'"), 'design PPTX export tool exists');

const designPrompt = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/design/domain.md'), 'utf-8');
assert.ok(designPrompt.includes('design-demos'), 'design prompt documents design-demos output convention');
assert.ok(/HTML deck/i.test(designPrompt), 'design prompt documents HTML deck base deliverable');
assert.ok(/PDF \/ PPTX|PDF.*PPTX/is.test(designPrompt), 'design prompt documents export derivatives');

const indexSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/index.ts'), 'utf-8');
assert.ok(indexSource.includes("import { designAgent }"), 'index should import designAgent');
assert.ok(indexSource.includes('designAgent,'), 'index should register designAgent in agents map');
assert.ok(indexSource.includes('/ws/design/projects'), 'index should expose design project listing route');
assert.ok(indexSource.includes('/ws/design/projects/:id'), 'index should expose design project bundle route');
assert.ok(indexSource.includes('/ws/design/assets/*'), 'index should expose design asset serving route');

const workspaceServiceSource = await fs.readFile(path.resolve(repoRoot, 'src/mastra/services/workspace-service.ts'), 'utf-8');
assert.ok(workspaceServiceSource.includes('listDesignProjects'), 'workspace-service should list design projects');
assert.ok(workspaceServiceSource.includes('getDesignProjectBundle'), 'workspace-service should aggregate design project bundles');
assert.ok(workspaceServiceSource.includes('getDesignAssetPath'), 'workspace-service should resolve safe design asset paths');
assert.ok(workspaceServiceSource.includes('DESIGN_OUTPUT_DIR'), 'workspace-service should support DESIGN_OUTPUT_DIR override');
assert.ok(workspaceServiceSource.includes('design-demos'), 'workspace-service should discover design-demos project dirs');

const dashboardUiSource = await fs.readFile(path.resolve(repoRoot, 'dashboard/index.html'), 'utf-8');
assert.ok(dashboardUiSource.includes('data-tab="designer"'), 'dashboard-ui Workspace should expose Designer tab');
assert.ok(dashboardUiSource.includes('id="tab-designer"'), 'dashboard-ui should include designer panel');
assert.ok(dashboardUiSource.includes('loadDesigner'), 'dashboard-ui should load designer projects');
assert.ok(dashboardUiSource.includes('/ws/design/projects'), 'dashboard-ui should call design project API routes');
assert.ok(dashboardUiSource.includes('showDesignAsset'), 'dashboard-ui should switch design asset previews');
const dashboardTabsBlocks = [...dashboardUiSource.matchAll(/const TABS = \[([^\]]+)\]/g)];
assert.ok(dashboardTabsBlocks.length >= 1, 'dashboard-ui should define Workspace TABS');
for (const [, tabsBlock] of dashboardTabsBlocks) {
  assert.ok(tabsBlock.includes("'designer'"), 'every dashboard-ui Workspace TABS block should include designer');
}

const envExample = await fs.readFile(path.resolve(repoRoot, '.env.example'), 'utf-8');
assert.ok(envExample.includes('DESIGN_SKILL_ROOT='), '.env.example should document DESIGN_SKILL_ROOT');
assert.ok(envExample.includes('DESIGN_OUTPUT_DIR='), '.env.example should document DESIGN_OUTPUT_DIR');

// ── The deliverable must be able to LEAVE the run ──────────────────────────
//
// designAgent shipped without any way to persist a file: `run_worker` is
// text-only, and every export tool takes an htmlPath that must already exist.
// The V2 canary therefore produced 2316 chars of prototype and committed the
// 316-char sentence that followed it. These pin the closure.

assert.ok(
  designAgentSource.includes('designWriteDeliverableTool'),
  'designAgent must register a tool that persists deliverables — without one, render/export tools have no input and the work dies in the transcript',
);

const designDocToolsSource = await fs.readFile(
  path.resolve(repoRoot, 'src/mastra/tools/design/design-document-tools.ts'), 'utf-8');
assert.ok(designDocToolsSource.includes("id: 'design_write_deliverable'"), 'the design deliverable writer exists');
assert.ok(designDocToolsSource.includes('putArtifact'), 'writing a deliverable must also register it as an artifact — that is what the orchestrator reads');
assert.ok(designDocToolsSource.includes('resolveWorkspacePath'), 'the writer must reuse the guard against writing into the read-only huashu-design repo');
assert.ok(/isPrimary/.test(designDocToolsSource), 'supporting files must be distinguishable from the deliverable itself');

const designPipelinePrompt = await fs.readFile(path.resolve(repoRoot, 'src/mastra/prompts/design/pipeline.md'), 'utf-8');
assert.ok(
  designPipelinePrompt.includes('design_write_deliverable'),
  'pipeline.md must name the tool that writes deliverables, not just assert that deliverables get written',
);

// Behavioural: the traversal guard, exercised rather than grepped.
const { designWriteDeliverableTool } = await import('../tools/design/design-document-tools.js');
const execute = (designWriteDeliverableTool as unknown as {
  execute: (input: Record<string, unknown>) => Promise<{ success: boolean; error?: string; path: string }>;
}).execute;

const escaped = await execute({
  slug: 'guard-test', fileName: '../../../etc/evil.html', content: '<html></html>',
  type: 'document', isPrimary: false,
});
assert.equal(escaped.success, false, 'a traversing fileName must be refused');
assert.match(String(escaped.error), /inside the project folder/, 'and say why');

const absolute = await execute({
  slug: 'guard-test', fileName: '/etc/evil.html', content: '<html></html>',
  type: 'document', isPrimary: false,
});
assert.equal(absolute.success, false, 'an absolute fileName must be refused');

// ── Fetched images must have names a browser can use ───────────────────────
//
// `fetch_images.py` is in the READ-ONLY huashu-design repo and derives the
// extension with `os.path.splitext(thumb)[1].split("?")[0]`, which assumes the
// thumbnail URL ends in `.jpg` and separates its query with `?`. Wikimedia
// returns URLs that do neither, so the host's TLD plus the `&`-joined query
// became the "extension". Observed live on the design canary.

assert.ok(
  designToolsSource.includes('normalizeFetchedImageNames'),
  'design_fetch_images must repair the upstream script\'s mangled filenames',
);

{
  const os = await import('node:os');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'design-img-'));
  try {
    // The exact shape seen live: no usable extension, utm params in the name.
    const mangled = path.join(
      scratch,
      'coffee_beans_specialty_Congressional_Research_Service_R.org&utm_campaign=imageinfo&utm_content=thumbnail',
    );
    // Real JPEG magic bytes — the repair sniffs the file, not the URL.
    await fs.writeFile(mangled, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));

    const pngMangled = path.join(scratch, 'espresso_WBC-pouring_split.org&utm_content=thumbnail');
    await fs.writeFile(pngMangled, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));

    const alreadyFine = path.join(scratch, 'clean_name.png');
    await fs.writeFile(alreadyFine, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // Built in the exact format the script prints, so the parser and the repair
    // are exercised together — the pair is what the tool actually runs.
    const manifest = [mangled, pngMangled, alreadyFine]
      .map((p) => `[OK] ${p}  | CC BY-SA | Someone | https://commons.wikimedia.org/x`)
      .join('\n');

    const { repairFetchedImageManifest } = await import('../tools/design/design-tools.js');
    const repaired = await repairFetchedImageManifest(manifest);

    const names = repaired.map((r: { path: string }) => path.basename(r.path));
    assert.ok(names.includes('coffee_beans_specialty_Congressional_Research_Service_R.jpg'),
      `JPEG must be renamed to .jpg, got ${names.join(', ')}`);
    assert.ok(names.includes('espresso_WBC-pouring_split.png'),
      `PNG must be renamed to .png, got ${names.join(', ')}`);
    assert.ok(names.includes('clean_name.png'), 'an already-correct name must be left alone');
    for (const name of names) {
      assert.ok(!/[?&#]/.test(name), `no URL debris may survive in ${name}`);
      assert.match(name, /\.(jpg|jpeg|png|gif|webp|svg|avif)$/, `${name} must end in an image extension`);
    }
    for (const entry of repaired) {
      assert.ok(await fs.stat(entry.path).then(() => true, () => false),
        `${entry.path} must exist on disk under its new name`);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

console.log('design domain static checks passed.');
