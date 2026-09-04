#!/usr/bin/env bash
# import-anthropic-skills.sh
#
# Imports selected skills from anthropic-skills repo into our _skills directory.
# Adds 'category' and 'keywords' fields to frontmatter for SkillRegistry compatibility.
# Only imports skills that are actually useful for our coding agent system.
#
# Usage: bash scripts/import-anthropic-skills.sh

set -euo pipefail

SOURCE_DIR="$(dirname "$0")/../_external/anthropic-skills/skills"
TARGET_DIR="$(dirname "$0")/../src/mastra/_skills"

# Skills to import and their target categories:
# - webapp-testing  → coding  (Playwright testing — very useful for QA subagent)
# - mcp-builder     → coding  (MCP server dev — useful when building tools)
# - frontend-design → coding  (Frontend design guidance — better UI generation)
# - skill-creator   → meta    (Meta-skill for creating new skills)

import_skill() {
  local skill_name="$1"
  local target_category="$2"
  local source_path="${SOURCE_DIR}/${skill_name}"
  local target_path="${TARGET_DIR}/${target_category}"
  
  if [[ ! -d "$source_path" ]]; then
    echo "⚠️  Source skill not found: ${source_path}"
    return 1
  fi

  # Create category dir if needed
  mkdir -p "$target_path"

  # Copy SKILL.md as skill-name.md (our convention: flat files per category)
  local target_file="${target_path}/${skill_name}.md"
  cp "${source_path}/SKILL.md" "$target_file"

  # Copy supporting directories (scripts/, examples/, reference/) if they exist
  for subdir in scripts examples reference agents assets core themes references; do
    if [[ -d "${source_path}/${subdir}" ]]; then
      local target_subdir="${target_path}/${skill_name}-${subdir}"
      cp -r "${source_path}/${subdir}" "$target_subdir"
      echo "  📁 Copied ${subdir}/ → ${skill_name}-${subdir}/"
    fi
  done

  echo "✅ Imported: ${skill_name} → ${target_category}/${skill_name}.md"
}

echo "🔄 Importing Anthropic skills into SkillRegistry..."
echo ""

import_skill "webapp-testing" "coding"
import_skill "mcp-builder" "coding"
import_skill "frontend-design" "coding"
import_skill "skill-creator" "meta"

echo ""
echo "🎯 Import complete! Skills will be indexed on next SkillRegistry.initialize()."
echo "   Run 'mastra dev' to verify."
