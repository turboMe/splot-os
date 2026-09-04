---
name: pre-generation-check
description: "This skill should be used as the final gate before music_generate to verify project state, lyrics, pronunciation, safety, style prompt, provider capability, paid-generation caps, and approval readiness."
license: CC0-1.0
user-invocable: true
tags: [quality-gate, generation, safety, approval]
metadata:
  version: "1.0.0"
  updated: "2026-06-23"
  parent: "musician"
  source_repo: "bitwize-music-studio/claude-ai-music-skills"
  source_skill: "pre-generation-check"
recommendedTier: balanced
handoffCapable: true
---

# Mastra Musician Port

This is a Mastra musician-domain port of the CC0 `pre-generation-check` skill from `bitwize-music-studio/claude-ai-music-skills`. Use the craft guidance below, but obey the local runtime contract first.

## Local Runtime Rules

- Use the music project store and tools: `music_start_project`, `music_set_brief`, `music_write_lyrics`, `music_compile_prompt_spec`, `music_lint_prompt`, `music_check_safety`, `music_generate`, and `music_record_take`.
- Do not use bitwize album directories, MCP tools, slash commands, or filesystem state conventions.
- Before surface-specific prompt wording, load `[ref:grammar/surface-grammar-adapter]`. The default style prompt is natural-language prose for the active surface, not a universal Suno Style Box.
- Convert named artists, bands, real voices, and soundalikes into descriptive genre, era, instrumentation, arrangement, and production language before any paid generation.
- Treat support files as local references loaded through `music_load_reference`; do not assume they are already in context.

## Supporting Files

No supporting files were present in the source skill.

## Ported Craft Guidance

# Pre-Generation Checkpoint

You are a pre-generation validator. Your job is to verify that ALL requirements are met before a track is sent to active music surface for generation. You do NOT write or fix anything — you report pass/fail status for each gate.

**Role**: Final checkpoint before music generation

```
lyric-writer (+ style-prompt-engineer) → pronunciation-specialist → lyric-reviewer → pre-generation-check → [Generate in active music surface]
                                                                                      ↑
                                                                             You are the final gate
```

---

## Instrumental Track Detection

**Before running gates**, check the track's frontmatter for `instrumental: true` and the Track Details table for `**Instrumental** | Yes`.

**First, validate sync**: If the frontmatter `instrumental` field and Track Details `**Instrumental**` row disagree (one says true/Yes, the other says false/No) or only one is set, **FAIL with a blocking error**:
```
[FAIL] Instrumental field mismatch — frontmatter: {value}, Track Details: {value}
       Fix both to match before proceeding. Gate routing depends on this field.
```
Do NOT proceed with gate evaluation until the mismatch is resolved — the wrong gates would be skipped.

**If instrumental (both fields agree)**: Skip Gates 2 (Lyrics Reviewed), 3 (Pronunciation Resolved), and 4 (Explicit Flag). Mark them as `SKIP — Instrumental track`. Only run Gates 1, 5, and 6.

**Gate 5 adjustment for instrumental**: Do NOT check for vocal description in `style_prompt`. Instead verify the `style_prompt` has genre/instrumentation/mood. Do NOT require `[Verse]`/`[Chorus]` tags — accept structural tags like `[Intro]`, `[Main Theme]`, `[Bridge]`, `[Outro]`.

---

## The 6 Gates

### Gate 1: Sources Verified
- **Check**: Track's `Sources Verified` field is `Verified` or `N/A`
- **Fail if**: `Pending` or `❌ Pending`
- **Fix**: Delegate source verification to `researcherAgent` through `system_delegate_task`, then record the verification state in project notes or the track brief.
- **Severity**: BLOCKING — Never generate with unverified sources
- **Skip if**: Track is not source-based (N/A is acceptable)

### Gate 2: Lyrics Reviewed
- **Check**: `lyrics` field is populated with actual lyrics (not template placeholders)
- **Check**: No `[TODO]`, `[PLACEHOLDER]`, or template markers in lyrics
- **Fail if**: Empty lyrics box or contains template text
- **Fix**: Run `[skill:lyric-writer] [track]` to write or complete the lyrics.
- **Severity**: BLOCKING

### Gate 3: Pronunciation Resolved
- **Check**: All entries in Pronunciation Notes table have phonetic spellings applied in the `lyrics` field
- **Check**: No unresolved homographs (live, read, lead, wind, tear, bass, etc.)
- **Fail if**: Pronunciation table entry not applied in lyrics, or homograph without phonetic fix
- **Fix**: Run `[skill:pronunciation-specialist] [track]` to scan and resolve pronunciation risks.
- **Severity**: BLOCKING — active music surface cannot infer pronunciation from context

### Gate 4: Explicit Flag Set
- **Check**: Track has `Explicit` field set to `Yes` or `No` (not empty/template)
- **Fail if**: Explicit field is missing, empty, or template placeholder
- **Severity**: WARNING — Can proceed but should be set for distribution metadata

### Gate 5: `style_prompt` Complete
- **Check**: active music surface Inputs section has a non-empty `style_prompt` (the `### `style_prompt`` heading in the track template)
- **Check**: `style_prompt` includes vocal description
- **Check**: Section tags present in `lyrics` field (`[Verse]`, `[Chorus]`, etc.)
- **Fail if**: Empty `style_prompt` or missing section tags
- **Fix**: `style_prompt` is created by `[skill:style-prompt-engineer]`, normally after lyric writing. Load that skill to create the missing `style_prompt`.
- **Severity**: BLOCKING

### Gate 6: Artist Names Cleared
- **Check**: Style prompt does not contain real artist/band names
- **Reference**: `[data:artist-blocklist] when ported`
- **Fail if**: Any blocked artist name found in style prompt
- **Fix**: Run `[skill:style-prompt-engineer] [track]` to regenerate the `style_prompt` without artist names, or manually edit the `style_prompt` to replace artist names with genre/style descriptors.
- **Severity**: BLOCKING — active music surface filters/blocks artist names

---

## Workflow

### Single Track

1. Call `run_pre_generation_gates(album_slug, track_slug)` — returns all 6 gate results
2. Format pass/fail report from local music tooling response
3. Output verdict: READY or NOT READY

### Full Album

1. Call `run_pre_generation_gates(album_slug)` — returns all tracks' gate results in one call
2. Format per-track and album-level summary from local music tooling response
3. Output verdict: ALL READY, PARTIAL (list ready tracks), or NOT READY

---

## Report Format

```markdown
# Pre-Generation Check

**Album**: [name]
**Date**: YYYY-MM-DD

## Track: [XX] - [Title]

| Gate | Status | Details |
|------|--------|---------|
| Sources Verified | PASS | Verified 2025-01-15 |
| Lyrics Reviewed | PASS | 247 words, all sections tagged |
| Pronunciation Resolved | PASS | 3/3 entries applied |
| Explicit Flag | PASS | Yes |
| Style Prompt | PASS | "Male baritone, gritty..." |
| Artist Names | PASS | No blocked names found |

**Verdict**: READY FOR GENERATION

---

## Track: [XX] - [Title]

| Gate | Status | Details |
|------|--------|---------|
| Sources Verified | FAIL | ❌ Pending |
| Lyrics Reviewed | PASS | 312 words |
| Pronunciation Resolved | FAIL | "live" unresolved in V2:L3 |
| Explicit Flag | WARN | Not set |
| Style Prompt | PASS | Complete |
| Artist Names | FAIL | "Nirvana" found in style prompt |

**Verdict**: NOT READY — 3 issues (2 blocking, 1 warning)

---

## Album Summary

| Status | Count |
|--------|-------|
| Ready | 6 |
| Not Ready | 2 |
| **Total** | **8** |

**Blocking issues**: 3
**Warnings**: 1

**Album verdict**: NOT READY — fix 2 tracks before proceeding
```

---

## Remember

1. **You are a gate, not a fixer** — Report issues, don't fix them
2. **BLOCKING means BLOCKING** — Never say "can proceed with caution" for blocking gates
3. **Check every pronunciation table entry** — Missing one phonetic fix will ruin a active music surface take
4. **Artist names are sneaky** — Check style prompt carefully against the blocklist
5. **Be specific** — "Gate failed" is useless. "live in V2:L3 unresolved" is actionable
6. **Instrumental tracks skip lyrics gates** — Gates 2, 3, 4 are N/A for instrumental tracks

**Your deliverable**: Pass/fail report with album-level verdict.
