#!/usr/bin/env tsx
/**
 * Parallel section writes must not lose each other — in EVERY domain that builds
 * an anchored-section deliverable.
 *
 * All of these tools do the same thing: read the whole document, splice one
 * section in, write the whole document back. All of these pipelines draft in
 * parallel batches. Without serialization the batch members read identical bytes
 * and only the last writer survives.
 *
 * Measured on a live chef run 2026-08-19 (project 8a484c50): eleven recipe
 * sections written, three present in the file — exactly one survivor per
 * parallel batch, plus the card written on its own. Mongo held all fifteen
 * recipes; the delivered document did not. A different run of the same code got
 * lucky and lost nothing, which is what makes this easy to miss: the loss is
 * nondeterministic, not path-specific.
 *
 * Run: npx tsx src/mastra/scripts/check-document-concurrency.ts
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { chefDocumentInitTool, chefDocumentWriteSectionTool } from '../tools/chef/chef-document-tools.js';
import { contentDocumentInitTool, contentDocumentWriteSectionTool } from '../tools/content/content-document-tools.js';
import { huntDocumentInitTool, huntDocumentWriteSectionTool } from '../tools/hunt/hunt-document-tools.js';
import { writerDocumentInit, writerDocumentWriteSection } from '../tools/writer/writer-document-tools.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

const call = (tool: unknown, input: Record<string, unknown>): Promise<any> =>
  (tool as any).execute(input);

interface DomainCase {
  domain: string;
  /** Creates the document; returns its path. */
  init: (id: string) => Promise<string>;
  /** Writes one anchored section. */
  write: (id: string, anchor: string, content: string) => Promise<any>;
  /** Anchors safe to use for this domain's validator. */
  anchors: string[];
}

const CASES: DomainCase[] = [
  {
    domain: 'chef',
    init: async (id) => {
      const r = await call(chefDocumentInitTool, { projectId: id, title: '[gate] concurrency' });
      assert.ok(r?.success, `chef init failed: ${JSON.stringify(r)}`);
      return r.path as string;
    },
    write: (id, anchor, content) =>
      call(chefDocumentWriteSectionTool, { projectId: id, anchor, content, mode: 'append' }),
    anchors: ['recipe:alfa', 'recipe:beta', 'recipe:gamma', 'recipe:delta', 'recipe:epsilon', 'recipe:zeta'],
  },
  {
    domain: 'content',
    init: async (id) => {
      const r = await call(contentDocumentInitTool, { projectId: id, title: '[gate] concurrency' });
      assert.ok(r?.success, `content init failed: ${JSON.stringify(r)}`);
      return r.path as string;
    },
    write: (id, anchor, content) =>
      call(contentDocumentWriteSectionTool, { projectId: id, anchor, content, mode: 'append' }),
    anchors: ['post:alfa', 'post:beta', 'post:gamma', 'post:delta', 'post:epsilon', 'post:zeta'],
  },
  {
    domain: 'hunt',
    init: async (id) => {
      const r = await call(huntDocumentInitTool, { runId: id, title: '[gate] concurrency' });
      assert.ok(r?.success, `hunt init failed: ${JSON.stringify(r)}`);
      return r.path as string;
    },
    write: (id, anchor, content) =>
      call(huntDocumentWriteSectionTool, { runId: id, anchor, content, mode: 'append' }),
    anchors: ['lead:alfa', 'lead:beta', 'lead:gamma', 'lead:delta', 'lead:epsilon', 'lead:zeta'],
  },
  {
    // Writer already serialized its own mutations before this gate existed
    // (`withWriterDocumentMutation`). Covered here so the guarantee is asserted
    // rather than assumed, and so a future refactor cannot quietly drop it.
    domain: 'writer',
    init: async (id) => {
      const r = await writerDocumentInit({ projectId: id, title: '[gate] concurrency' } as any);
      assert.ok((r as any)?.success, `writer init failed: ${JSON.stringify(r)}`);
      return (r as any).path as string;
    },
    write: (id, anchor, content) =>
      writerDocumentWriteSection({
        projectId: id,
        anchor,
        content,
        mode: 'append',
        invalidateCurrentSnapshot: false,
      } as any),
    anchors: ['scene-alfa', 'scene-beta', 'scene-gamma', 'scene-delta', 'scene-epsilon', 'scene-zeta'],
  },
];

async function runCase(c: DomainCase): Promise<void> {
  const id = randomUUID();
  let filePath: string | null = null;
  try {
    filePath = await c.init(id);

    const results = await Promise.all(
      // No em dash: the writer domain rejects U+2014 as a style violation, and
      // that guard is correct — the fixture has to respect it.
      c.anchors.map((anchor) => c.write(id, anchor, `Treść sekcji ${anchor}, musi przetrwać równoległy zapis.`)),
    );

    check(`${c.domain}: every parallel write reports success`, () => {
      const bad = results.filter((r) => !r?.success);
      assert.equal(bad.length, 0, `${bad.length} write(s) failed: ${JSON.stringify(bad[0])}`);
    });

    const doc = await fs.readFile(filePath, 'utf-8');
    check(`${c.domain}: all ${c.anchors.length} sections survive concurrent writes`, () => {
      const lost = c.anchors.filter((a) => !doc.includes(`Treść sekcji ${a}`));
      assert.deepEqual(
        lost,
        [],
        `${lost.length} of ${c.anchors.length} lost to a read-modify-write race: ${lost.join(', ')}`,
      );
    });

    check(`${c.domain}: anchors are not duplicated by interleaving`, () => {
      for (const anchor of c.anchors) {
        const starts = doc.split(`<!-- section:${anchor} start -->`).length - 1;
        assert.ok(starts <= 1, `anchor ${anchor} appears ${starts}x — writes interleaved`);
      }
    });
  } finally {
    if (filePath) await fs.rm(filePath, { force: true });
  }
}

async function main(): Promise<void> {
  console.log('check:document-concurrency');
  for (const c of CASES) {
    try {
      await runCase(c);
    } catch (error) {
      failures++;
      console.error(`  ✗ ${c.domain}: ${(error as Error).message}`);
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`❌ check:document-concurrency — ${failures} failed`);
    process.exit(1);
  }
  console.log('✅ check:document-concurrency — a parallel batch lands in full in every domain');
  process.exit(0);
}

main().catch((err) => {
  console.error('check:document-concurrency crashed:', err);
  process.exit(1);
});
