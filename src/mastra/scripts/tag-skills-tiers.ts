#!/usr/bin/env tsx
/**
 * tag-skills-tiers.ts
 *
 * Scans all skills in `src/mastra/_skills/` and `.agents/skills/`
 * and applies execution model tiers (`fast`, `balanced`, `pro`, `private`)
 * and `handoffCapable: true` to frontmatters.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseFrontmatter } from '../lib/yaml-frontmatter.js';

const SKILLS_DIRS = [
  join(process.cwd(), 'src/mastra/_skills'),
  join(process.cwd(), '../.agents/skills'),
  join(process.cwd(), '.agents/skills'),
];

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMd(path));
    } else if (entry.name.endsWith('.md')) {
      out.push(path);
    }
  }
  return out;
}

function determineTier(
  filePath: string,
  meta: Record<string, any>,
  content: string
): 'fast' | 'balanced' | 'pro' | 'private' {
  if (
    meta.recommendedTier &&
    ['fast', 'balanced', 'pro', 'private'].includes(meta.recommendedTier)
  ) {
    return meta.recommendedTier;
  }

  // 1. Private / Local check
  if (
    meta.preferLocal === true ||
    meta.recommendedTier === 'private' ||
    filePath.includes('/private/') ||
    filePath.includes('/identity/') ||
    filePath.includes('/personal/')
  ) {
    return 'private';
  }

  const tags: string[] = Array.isArray(meta.tags)
    ? meta.tags.map((t) => String(t).toLowerCase())
    : [];
  const keywords: string[] = Array.isArray(meta.keywords)
    ? meta.keywords.map((k) => String(k).toLowerCase())
    : [];
  const combined = [...tags, ...keywords, filePath.toLowerCase()];

  const isPrivate = combined.some((k) =>
    ['credentials', 'private', 'identity', 'confidential', 'gdpr', 'pii'].includes(k)
  );
  if (isPrivate) return 'private';

  // 2. Explicit complexity
  if (meta.minComplexity === 'trivial' || meta.minComplexity === 'simple') {
    return 'fast';
  }
  if (meta.minComplexity === 'complex' || meta.minComplexity === 'critical') {
    return 'pro';
  }

  // 3. Category directory heuristic
  if (filePath.includes('/terminal/') || filePath.includes('/n8n-blocks/')) {
    return 'fast';
  }
  if (
    filePath.includes('/security/') ||
    filePath.includes('/coding/') ||
    filePath.includes('/devops/')
  ) {
    return 'pro';
  }

  // 4. Keywords / Tags heuristic
  const isFastTag = combined.some((k) =>
    [
      'extract',
      'extractor',
      'format',
      'formatter',
      'scrape',
      'lookup',
      'search',
      'classify',
      'classifier',
      'parse',
      'parser',
      'slug',
      'csv',
      'regex',
      'rss',
      'summarize',
      'clean',
    ].some((term) => k.includes(term))
  );
  if (isFastTag) return 'fast';

  const isProTag = combined.some((k) =>
    [
      'architecture',
      'architect',
      'security',
      'audit',
      'auditor',
      'refactor',
      'deep-dive',
      'deliberate',
      'deliberation',
      'eval',
      'evaluation',
      'root-cause',
      'vulnerability',
    ].some((term) => k.includes(term))
  );
  if (isProTag) return 'pro';

  // 5. Default
  return 'balanced';
}

function processSkillFile(filePath: string): {
  tier: 'fast' | 'balanced' | 'pro' | 'private';
  updated: boolean;
} {
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return { tier: 'balanced', updated: false };
  }

  const { metadata } = parseFrontmatter(content);
  const tier = determineTier(filePath, metadata, content);
  const handoff = metadata.handoffCapable ?? true;

  let frontmatterText = match[1]!;
  let modified = false;

  // 1. Ensure recommendedTier
  if (/^recommendedTier:/m.test(frontmatterText)) {
    frontmatterText = frontmatterText.replace(
      /^recommendedTier:.*$/m,
      `recommendedTier: ${tier}`
    );
    modified = true;
  } else {
    // Insert after minComplexity if present, else before end
    if (/^minComplexity:.*$/m.test(frontmatterText)) {
      frontmatterText = frontmatterText.replace(
        /^minComplexity:(.*)$/m,
        `minComplexity:$1\nrecommendedTier: ${tier}`
      );
    } else {
      frontmatterText += `\nrecommendedTier: ${tier}`;
    }
    modified = true;
  }

  // 2. Ensure handoffCapable
  if (!/^handoffCapable:/m.test(frontmatterText)) {
    frontmatterText += `\nhandoffCapable: ${handoff}`;
    modified = true;
  }

  if (modified) {
    const newContent = `---\n${frontmatterText.trim()}\n---${content.slice(match[0].length)}`;
    writeFileSync(filePath, newContent, 'utf-8');
    return { tier, updated: true };
  }

  return { tier, updated: false };
}

async function main() {
  console.log('🏷️  Starting Mass Skill Tier Tagging...\n');

  const stats = {
    total: 0,
    updated: 0,
    fast: 0,
    balanced: 0,
    pro: 0,
    private: 0,
  };

  const processedPaths = new Set<string>();

  for (const dir of SKILLS_DIRS) {
    const files = walkMd(dir);
    for (const file of files) {
      if (processedPaths.has(file)) continue;
      processedPaths.add(file);

      // Skip non-skill files or archive/quarantine if needed
      if (file.endsWith('README.md') || file.endsWith('INDEX.md')) continue;

      try {
        const { tier, updated } = processSkillFile(file);
        stats.total++;
        stats[tier]++;
        if (updated) stats.updated++;
      } catch (err) {
        console.error(`❌ Failed to process ${file}:`, err);
      }
    }
  }

  console.log('======================================================');
  console.log(`✅ Skill Tagging Completed:`);
  console.log(`   Total Skills Processed: ${stats.total}`);
  console.log(`   Updated Files:          ${stats.updated}`);
  console.log(`   Tier 'fast':            ${stats.fast}`);
  console.log(`   Tier 'balanced':        ${stats.balanced}`);
  console.log(`   Tier 'pro':             ${stats.pro}`);
  console.log(`   Tier 'private':         ${stats.private}`);
  console.log('======================================================\n');
}

main().catch(console.error);
