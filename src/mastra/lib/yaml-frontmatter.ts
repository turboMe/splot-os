/**
 * YAML Frontmatter Parser (Phase 2.2)
 *
 * Parses YAML frontmatter from markdown files (--- delimited).
 * Also supports updating frontmatter fields in-place.
 *
 * Compatible with agentskills.io SKILL.md standard and existing
 * _skills/*.md files.
 */

import { readFile, writeFile } from 'fs/promises';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { metadata, body } where metadata is a flat key-value object
 * and body is the markdown content without frontmatter.
 */
export function parseFrontmatter(content: string): {
  metadata: Record<string, any>;
  body: string;
} {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = content.slice(match[0].length).replace(/^\r?\n/, '');

  // Simple YAML parser (handles flat key-value, arrays, and nested objects)
  const metadata: Record<string, any> = {};
  const lines = yamlBlock.split(/\r?\n/);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();

    // Block scalars: `key: >`, `>-`, `|`, `|-`, with the text on the lines below.
    //
    // Without this the value was the INDICATOR itself. Measured: 45 of 826
    // skills write their description as a folded block, so `skill_search`
    // returned `"description": ">-"` for every one of them — and the description
    // is exactly what an agent reads to decide which methodology to load. The
    // search worked, the ranking worked, and the answer was unusable.
    const blockMatch = /^([>|])([-+]?)$/.exec(value);
    if (blockMatch) {
      const fold = blockMatch[1] === '>';
      const chomp = blockMatch[2];
      const blockLines: string[] = [];
      while (lineIdx + 1 < lines.length) {
        const next = lines[lineIdx + 1]!;
        // A blank line belongs to the block; anything at column 0 ends it.
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        blockLines.push(next);
        lineIdx += 1;
      }
      const indent = Math.min(
        ...blockLines.filter((l) => l.trim() !== '').map((l) => l.match(/^\s*/)![0].length),
      );
      const dedented = blockLines.map((l) => (l.trim() === '' ? '' : l.slice(indent)));
      let text = fold
        // Folded: line breaks become spaces, blank lines stay as paragraph breaks.
        ? dedented.reduce((acc, cur) => (
          cur === '' ? `${acc}\n` : (acc === '' || acc.endsWith('\n') ? acc + cur : `${acc} ${cur}`)
        ), '')
        : dedented.join('\n');
      if (chomp === '-') text = text.replace(/\n+$/, '');
      metadata[key] = text.trim();
      continue;
    }

    if (value === '') {
      // Check if following lines are list items `- item`
      const listItems: string[] = [];
      let nextIdx = lineIdx + 1;
      while (nextIdx < lines.length) {
        const nextLine = lines[nextIdx]!;
        if (!nextLine.trim()) { nextIdx++; continue; }
        const match = nextLine.match(/^\s*-\s+(.*)$/);
        if (match) {
          listItems.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
          nextIdx++;
        } else {
          break;
        }
      }
      if (listItems.length > 0) {
        metadata[key] = listItems;
        lineIdx = nextIdx - 1;
        continue;
      }
      // Empty value
      metadata[key] = '';
      continue;
    }

    // Multiline bracket array: [ \n item1, \n item2 \n ]
    if (value.startsWith('[') && !value.endsWith(']')) {
      let arrayText = value;
      while (lineIdx + 1 < lines.length) {
        const next = lines[lineIdx + 1]!;
        arrayText += ' ' + next.trim();
        lineIdx += 1;
        if (next.includes(']')) break;
      }
      if (arrayText.startsWith('[') && arrayText.endsWith(']')) {
        const inner = arrayText.slice(1, -1);
        metadata[key] = inner.split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        continue;
      }
    }

    // Boolean
    if (value === 'true') { metadata[key] = true; continue; }
    if (value === 'false') { metadata[key] = false; continue; }
    if (value === 'null') { metadata[key] = null; continue; }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      metadata[key] = Number(value);
      continue;
    }

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      metadata[key] = inner.split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      continue;
    }

    // Quoted string
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      metadata[key] = value.slice(1, -1);
      continue;
    }

    // Plain string
    metadata[key] = value;
  }

  return { metadata, body };
}

/**
 * Update specific fields in YAML frontmatter of a file.
 * Preserves existing fields and adds new ones.
 */
export async function updateFrontmatter(
  filePath: string,
  updates: Record<string, any>,
): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    // No frontmatter — create one
    const yamlLines = Object.entries(updates)
      .map(([k, v]) => `${k}: ${serializeValue(v)}`)
      .join('\n');
    const newContent = `---\n${yamlLines}\n---\n${content}`;
    await writeFile(filePath, newContent, 'utf-8');
    return;
  }

  const { metadata } = parseFrontmatter(content);
  const merged = { ...metadata, ...updates };

  const yamlLines = Object.entries(merged)
    .map(([k, v]) => `${k}: ${serializeValue(v)}`)
    .join('\n');

  const body = content.slice(match[0].length);
  const newContent = `---\n${yamlLines}\n---${body}`;
  await writeFile(filePath, newContent, 'utf-8');
}

/**
 * Tworzy kompletny dokument Markdown z nagłówkiem YAML frontmatter i ciałem.
 */
export function stringifyFrontmatter(metadata: Record<string, any>, body: string): string {
  const yamlLines = Object.entries(metadata)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${serializeValue(v)}`)
    .join('\n');
  return `---\n${yamlLines}\n---\n\n${body}\n`;
}

function serializeValue(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ')}]`;
  }
  if (typeof value === 'string' && (value.includes(':') || value.includes('\n') || value.includes('#'))) {
    return JSON.stringify(value);
  }
  return String(value);
}
