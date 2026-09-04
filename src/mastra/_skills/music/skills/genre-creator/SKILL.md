---
name: genre-creator
description: "This skill should be used when creating or revising a reusable genre reference for the music reference corpus, including genre conventions, instrumentation, tempo, structure, lyric tendencies, and prompt vocabulary."
license: CC0-1.0
user-invocable: true
tags: [genre, reference, style-prompt, knowledge]
metadata:
  version: "1.0.0"
  updated: "2026-06-23"
  parent: "musician"
  source_repo: "bitwize-music-studio/claude-ai-music-skills"
  source_skill: "genre-creator"
recommendedTier: balanced
handoffCapable: true
---

# Mastra Musician Port

This is a Mastra musician-domain port of the CC0 `genre-creator` skill from `bitwize-music-studio/claude-ai-music-skills`. Use the craft guidance below, but obey the local runtime contract first.

## Local Runtime Rules

- Use the music project store and tools: `music_start_project`, `music_set_brief`, `music_write_lyrics`, `music_compile_prompt_spec`, `music_lint_prompt`, `music_check_safety`, `music_generate`, and `music_record_take`.
- Do not use bitwize album directories, MCP tools, slash commands, or filesystem state conventions.
- Before surface-specific prompt wording, load `[ref:grammar/surface-grammar-adapter]`. The default style prompt is natural-language prose for the active surface, not a universal Suno Style Box.
- Convert named artists, bands, real voices, and soundalikes into descriptive genre, era, instrumentation, arrangement, and production language before any paid generation.
- Treat support files as local references loaded through `music_load_reference`; do not assume they are already in context.

## Supporting Files

No supporting files were present in the source skill.

## Ported Craft Guidance

# {Genre Name}

## Genre Overview
[3 paragraphs — see rules below]

## Characteristics
[6 bullet fields — see rules below]

## Lyric Conventions
[6 bullet fields — see rules below]

## Subgenres & Styles
[Table — see rules below]

## Artists
[Table — see rules below]

## active music surface Prompt Keywords
[Code block — see rules below]

## Reference Tracks
[List — see rules below]
```

### Section Rules

**## Genre Overview** — 3 paragraphs of prose (no bullets):
- P1: Origin, cultural roots, pioneers with names and years
- P2: Evolution across decades, key moments, mainstream breakthrough, regional variants
- P3: Current state, influence on other genres, modern scene
- Style: Encyclopedic but alive. Concrete names, years, albums. No vague claims.

**## Characteristics** — Bullet list, exactly these 6 fields:
- **Instrumentation**: Typical instruments, specific models/brands where relevant
- **Vocals**: Singing style, vocal processing, delivery
- **Production**: Production techniques, mix aesthetic, sonic character
- **Energy/Mood**: Mood spectrum, emotional range
- **Structure**: Song form, typical length, structural quirks
- **Tempo**: BPM ranges per subgenre, rhythm feel (half-time, swing, straight etc.)

**## Lyric Conventions** — Bullet list, exactly these 6 fields:
- **Default rhyme scheme**: Typical scheme with shorthand (AABB, ABAB, XAXA etc.)
- **Rhyme quality**: Expected quality (multisyllabic, slant, internal etc.)
- **Verse structure**: Line count, bar structure
- **Key rule**: THE single most important rule for lyrics in this genre
- **Avoid**: What NOT to do in this genre
- **Density/pacing (active music surface)**: Format: `Default **X lines/verse** at Y BPM. [Context]. Topics: Z/verse.`

**## Subgenres & Styles** — Markdown table:

| Style | Description | Reference Artists |
|-------|-------------|-------------------|

- 6-12 subgenres
- Description: 2-3 sentences with musical specifics, not just adjectives
- Reference Artists: 3-4 per subgenre

**## Artists** — Markdown table:

| Artist | Key Albums | Era | Style Focus |
|--------|-----------|-----|-------------|

- 10-20 artists, mix of pioneers + peak-era + current acts
- Albums in italics (*Album Name*)
- If a deep-dive file exists: append a `Deep Dive` link to the artist file in Style Focus

**## active music surface Prompt Keywords** — Fenced code block with comma-separated keywords organized in thematic lines:
- Genre/subgenre labels
- Instrument keywords
- Production keywords
- Mood/atmosphere keywords
- Vocal keywords
- Tempo/rhythm keywords
- Era/aesthetic keywords
- All keywords in English. Only use terms active music surface actually understands.

**## Reference Tracks** — 10-15 entries:
- Format: `- **Artist - "Track Title"** — [Description]`
- Description: 2-3 sentences. Explain WHAT makes this track a genre reference point. Name concrete musical elements. Explain historical/cultural significance.
- Chronological spread from founding tracks to modern representatives

## Important Notes

1. **Factual accuracy**: All years, album names, artist names must be correct. Omit rather than guess. Use WebSearch to verify.
2. **No AI cliches**: Ban these phrases: "tapestry of sound", "sonic landscape", "testament to", "rich tapestry", "sonic journey", "pushing boundaries", "transcends genre". Write direct, concrete prose.
3. **active music surface focus**: Lyric Conventions and active music surface Keywords are the most important sections — they directly drive music generation quality.
4. **Subgenre deduplication**: If a subgenre already has its own genre directory (e.g. Trap exists as standalone genre), reference it instead of duplicating content.
5. **Language**: English (the entire genre system is in English)
6. **No empty sections**: Every section must have substantive content. If unsure about a section, research first.
