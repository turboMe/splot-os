#!/usr/bin/env tsx
/**
 * check:skill-frontmatter — validates skill files in _skills/** before activation.
 *
 * A1: `name` unique across _skills/** (excluding quarantine/ and archive/)
 * A2: `name` matches ^[a-z0-9][a-z0-9-]{2,}$ (kebab-case, ≥3 chars)
 * A3: `description` ≥ 20 chars and describes trigger condition / capability
 * A4: every entry in `allowedTools` exists in the tool registry vocabulary
 * A5: `estimatedTokens` within ±50% of Math.ceil(body.length / 4) when specified
 * A6: every .md file has frontmatter (name + description) OR is in an exempt directory / supporting doc
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseFrontmatter } from '../lib/yaml-frontmatter.js';

const TOOLS_ROOT = 'src/mastra/tools';
const WORKSPACES_DIR = 'src/mastra/workspaces';
const DEFAULT_SKILLS_DIR = 'src/mastra/_skills';

// ── 1. Gather Tool Vocabulary ──────────────────────────────────────────────────

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

export function getToolVocabulary(): Set<string> {
  const knownIds = new Set<string>();

  for (const file of walkTs(TOOLS_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/id:\s*'([^']+)'/g)) {
      knownIds.add(m[1]!);
    }
  }

  for (const file of walkTs(WORKSPACES_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/name:\s*'([a-z_]+)'/g)) {
      knownIds.add(m[1]!);
    }
  }

  // NotebookLM MCP tools from knowledgeAgent / mcp.ts
  const nlmTools = [
    'server_info', 'refresh_auth', 'save_auth_tokens',
    'notebook_list', 'notebook_get', 'notebook_describe', 'notebook_create', 'notebook_rename', 'notebook_delete', 'notebook_query',
    'source_add', 'source_list_drive', 'source_sync_drive', 'source_rename', 'source_delete', 'source_describe', 'source_get_content',
    'research_start', 'research_status', 'research_import',
    'studio_create', 'studio_status', 'studio_delete', 'studio_revise',
    'download_artifact', 'export_artifact',
    'batch', 'cross_notebook_query', 'tag', 'note', 'chat_configure',
    'notebook_share_status', 'notebook_share_public', 'notebook_share_invite', 'notebook_share_batch',
    'pipeline',
  ];
  for (const t of nlmTools) knownIds.add(t);

  return knownIds;
}

// ── 2. Scan Skill Files ───────────────────────────────────────────────────────

export function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(path));
    else if (entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

const EXEMPT_DIR_PATTERNS = [
  /\/quarantine\//,
  /\/archive\//,
  /\/_skills\/design\//,
  /\/design\//,
  /\/references\//,
  /\/[^/]+-references?\//,
  /\/examples\//,
  /\/[^/]+-examples?\//,
  /\/scripts\//,
  /\/[^/]+-scripts?\//,
  /\/data\//,
  /\/evals\//,
  /\/[^/]+-agents?\//,
  /\/[^/]+-assets?\//,
  /\/prompt-patches\//,
];

export function isExemptFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  if (norm.endsWith('/README.md')) return true;
  if (EXEMPT_DIR_PATTERNS.some((pattern) => pattern.test(norm))) return true;

  // If a directory has a SKILL.md and this file is not SKILL.md, it's a supporting reference
  const dir = dirname(filePath);
  const skillMdPath = join(dir, 'SKILL.md');
  if (!norm.endsWith('/SKILL.md') && existsSync(skillMdPath)) {
    return true;
  }

  return false;
}

export interface ValidationReport {
  totalFiles: number;
  activeSkills: number;
  exemptFiles: number;
  errors: string[];
  findings: Array<{ file: string; rule: string; message: string }>;
}

export function validateSkillsDirectory(skillsDir: string, vocabulary = getToolVocabulary()): ValidationReport {
  const report: ValidationReport = {
    totalFiles: 0,
    activeSkills: 0,
    exemptFiles: 0,
    errors: [],
    findings: [],
  };

  const mdFiles = walkMd(skillsDir);
  report.totalFiles = mdFiles.length;

  const namesSeen = new Map<string, string>();
  const triggerRegex = /\b(when|use|for|if|trigger|should|helps|provides|handles|used|covers|patterns|guidance|framework|resolves|installs|checks|checking|redacts|redaction|operations|syntax|top|auditing|inspects|analyzes|generates|manages|builds|creates|validates|fixes|reconstructs|evaluates|transforms|searches|synchronizes|exports|imports|reviews|guides|fast|triage|diagnose|convert|edit|discover|sharing|notes|studio)\b/i;
  const namePattern = /^[a-z0-9][a-z0-9-]{2,}$/;

  for (const filePath of mdFiles) {
    const isExempt = isExemptFile(filePath);
    const content = readFileSync(filePath, 'utf8');
    const { metadata, body } = parseFrontmatter(content);

    const hasName = Boolean(metadata.name && String(metadata.name).trim());
    const hasDesc = Boolean(metadata.description && String(metadata.description).trim());

    if (isExempt) {
      report.exemptFiles += 1;
      if (!hasName && !hasDesc) {
        continue;
      }
    }

    // A6: File has frontmatter or is in an exempt directory
    if (!hasName && !hasDesc) {
      report.findings.push({
        file: filePath,
        rule: 'A6',
        message: 'Markdown file in active skills directory lacks frontmatter (name and description)',
      });
      continue;
    }

    report.activeSkills += 1;
    const name = String(metadata.name || '').trim();
    const description = String(metadata.description || '').trim();

    // A1: Unique name
    if (namesSeen.has(name)) {
      report.findings.push({
        file: filePath,
        rule: 'A1',
        message: `Duplicate skill name "${name}" (already seen in ${namesSeen.get(name)})`,
      });
    } else {
      namesSeen.set(name, filePath);
    }

    // A2: Valid name pattern
    if (!namePattern.test(name)) {
      report.findings.push({
        file: filePath,
        rule: 'A2',
        message: `Invalid skill name "${name}" (must match ^[a-z0-9][a-z0-9-]{2,}$)`,
      });
    }

    // A3: Description >= 20 chars and contains trigger condition
    if (description.length < 20) {
      report.findings.push({
        file: filePath,
        rule: 'A3',
        message: `Description too short (${description.length} chars, min 20 required)`,
      });
    } else if (!triggerRegex.test(description)) {
      report.findings.push({
        file: filePath,
        rule: 'A3',
        message: `Description lacks trigger/usage condition ("when...", "use for...", etc.): "${description.slice(0, 60)}..."`,
      });
    }

    // A4: Allowed tools exist in vocabulary
    if (metadata.allowedTools) {
      const allowedTools: string[] = Array.isArray(metadata.allowedTools)
        ? metadata.allowedTools
        : [String(metadata.allowedTools)];
      for (const tool of allowedTools) {
        const t = String(tool).trim();
        if (!vocabulary.has(t)) {
          report.findings.push({
            file: filePath,
            rule: 'A4',
            message: `Declared allowedTool "${t}" does not exist in the tool registry vocabulary`,
          });
        }
      }
    }

    // A5: estimatedTokens within ±50% of Math.ceil(body.length / 4)
    if (metadata.estimatedTokens != null && metadata.estimatedTokens !== '') {
      const declaredTokens = Number(metadata.estimatedTokens);
      const approxBodyTokens = Math.max(1, Math.ceil(body.trim().length / 4));
      if (!isNaN(declaredTokens) && declaredTokens > 0) {
        const minAllowed = approxBodyTokens * 0.5;
        const maxAllowed = approxBodyTokens * 1.5;
        if (declaredTokens < minAllowed || declaredTokens > maxAllowed) {
          report.findings.push({
            file: filePath,
            rule: 'A5',
            message: `estimatedTokens (${declaredTokens}) out of bounds vs body length (${body.trim().length} chars ≈ ${approxBodyTokens} tokens, allowed ${Math.round(minAllowed)}-${Math.round(maxAllowed)})`,
          });
        }
      }
    }
  }

  for (const f of report.findings) {
    report.errors.push(`[${f.rule}] ${f.file}: ${f.message}`);
  }

  return report;
}

// ── CLI Execution ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const targetDir = process.argv[2] || DEFAULT_SKILLS_DIR;
  console.log(`check:skill-frontmatter scanning "${targetDir}"...`);

  const vocab = getToolVocabulary();
  console.log(`  (vocabulary: ${vocab.size} registered tools and workspaces)`);

  const report = validateSkillsDirectory(targetDir, vocab);

  console.log(`  Scanned ${report.totalFiles} files (${report.activeSkills} active skills, ${report.exemptFiles} exempt/reference files)`);

  if (report.errors.length > 0) {
    console.error(`\n❌ check:skill-frontmatter — ${report.errors.length} error(s) found:\n`);
    for (const err of report.errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  console.log(`\n✅ check:skill-frontmatter — all ${report.activeSkills} active skills satisfy frontmatter contracts (A1-A6)`);
  process.exit(0);
}
