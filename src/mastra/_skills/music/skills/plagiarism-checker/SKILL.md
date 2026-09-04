---
name: plagiarism-checker
description: "This skill should be used before release to detect lyric phrases that may unintentionally echo existing songs, using distinctive phrase extraction, researcherAgent delegation, and risk classification."
license: CC0-1.0
user-invocable: true
tags: [lyrics, plagiarism, release, research]
metadata:
  version: "1.0.0"
  updated: "2026-06-23"
  parent: "musician"
  source_repo: "bitwize-music-studio/claude-ai-music-skills"
  source_skill: "plagiarism-checker"
recommendedTier: fast
handoffCapable: true
---

# Mastra Musician Port

This is a Mastra musician-domain port of the CC0 `plagiarism-checker` skill from `bitwize-music-studio/claude-ai-music-skills`. Use the craft guidance below, but obey the local runtime contract first.

## Local Runtime Rules

- Use the music project store and tools: `music_start_project`, `music_set_brief`, `music_write_lyrics`, `music_compile_prompt_spec`, `music_lint_prompt`, `music_check_safety`, `music_generate`, and `music_record_take`.
- Do not use bitwize album directories, MCP tools, slash commands, or filesystem state conventions.
- Before surface-specific prompt wording, load `[ref:grammar/surface-grammar-adapter]`. The default style prompt is natural-language prose for the active surface, not a universal Suno Style Box.
- Convert named artists, bands, real voices, and soundalikes into descriptive genre, era, instrumentation, arrangement, and production language before any paid generation.
- Treat support files as local references loaded through `music_load_reference`; do not assume they are already in context.

## Supporting Files

No supporting files were present in the source skill.

## Ported Craft Guidance

# Plagiarism Checker

You scan lyrics for phrases that may unintentionally echo existing songs. This is a quality check, not a legal tool — it catches borrowing early so the writer can revise before release.

---

## Workflow

### Step 1: Get Lyrics

- Use `extract_section(album_slug, track_slug, "streaming")` to get streaming lyrics (preferred — no phonetic spellings that confuse web searches)
- If streaming lyrics empty, fall back to `extract_section(album_slug, track_slug, "lyrics")` for active music surface lyrics
- If raw text was provided instead of album/track reference, use that directly

### Step 2: Extract Distinctive Phrases

Call `extract_distinctive_phrases(text, max_phrases=15, include_raw_lines=False)` local music tooling tool. This returns:
- Distinctive 4-7 word n-grams ranked by section priority (top 15)
- Pre-formatted search suggestions with quoted phrases + "lyrics"
- Common cliches already filtered out

### Step 3: Web Search

- Search the top 10-15 `search_suggestions` returned by the tool using WebSearch
- For short lyrics (<100 words), limit to 5-8 searches
- Look for results that reference specific songs by title/artist
- Skip results that are:
  - Lyrics aggregator sites listing hundreds of matches (too generic)
  - Dictionary/reference pages
  - The user's own published work

### Step 4: Deep Compare

For any search result that names a specific song:
1. WebFetch the lyrics page
2. Compare the matching section against the user's lyrics
3. Check if the match is:
   - Exact consecutive words (5+) — HIGH risk
   - Partial overlap (4 words) — MEDIUM risk
   - Thematic similarity only — LOW risk

### Step 5: LLM Knowledge Check

Independently scan ALL lines of the lyrics (not just extracted phrases) using your training knowledge:
- Flag any line that closely resembles a well-known song lyric
- Include the suspected source song and artist
- Note whether the similarity is in words, melody hook phrasing, or concept

### Step 6: Generate Report

---

## Risk Levels

| Level | Criteria | Action |
|-------|----------|--------|
| **HIGH** | 5+ consecutive matching words from a known song, especially chorus/hook | Rewrite the line immediately |
| **MEDIUM** | 4-word match from known song, or structural similarity flagged by LLM | Review and consider rewording |
| **LOW** | Common phrasing overlap, likely coincidence | Note for awareness, no action needed |

---

## Output Format

```
PLAGIARISM CHECK REPORT
Album: [Album Name]
Track: [Track Title]
Date: [Scan Date]

PHRASES SEARCHED: [N]
WEB MATCHES FOUND: [N]
LLM FLAGS: [N]

FINDINGS:
------------------------------------------------------------------------

[HIGH] Line 12 (Chorus): "burning shadows fall tonight across the wire"
  Match: "Shadows Fall Tonight" by [Artist] — 5 consecutive words match chorus
  Source: [URL]
  Recommendation: Rewrite this line to avoid direct overlap

[MEDIUM] Line 24 (Verse 2): "walking through the ruins of the empire"
  Similarity: Resembles "Empire" by [Artist] — similar phrasing in bridge
  Source: LLM knowledge
  Recommendation: Consider rewording if concerned

[LOW] Line 8 (Verse 1): "the city sleeps beneath the stars"
  Note: Generic night imagery, appears in many songs
  Recommendation: No action needed

------------------------------------------------------------------------

SUMMARY:
  HIGH risk findings: 1
  MEDIUM risk findings: 1
  LOW risk findings: 1

VERDICT: NEEDS REVIEW
  1 high-risk match requires attention before release.

COMMON PHRASES FILTERED: [N] (not searched — too generic to flag)
```

### Verdicts

| Verdict | Criteria |
|---------|----------|
| **CLEAR** | No HIGH or MEDIUM findings |
| **NEEDS REVIEW** | Any MEDIUM findings, or 1 HIGH finding |
| **REWRITE REQUIRED** | 2+ HIGH findings |

---

## Important Notes

- **This is not a legal tool.** It catches likely borrowing, not copyright infringement. Only a lawyer can determine infringement.
- **Streaming lyrics preferred.** active music surface lyrics contain phonetic respellings (e.g., "Seh-KYOOR-ih-tee" for "security") that will produce garbage web search results.
- **Common cliches are pre-filtered.** The local music tooling tool removes ~75 ubiquitous phrases ("break my heart", "falling in love", etc.) before returning results. These are too common to flag.
- **Web searches may fail.** If WebSearch is unavailable or rate-limited, proceed with LLM knowledge check only and note the limitation in the report.
- **Not a pre-generation gate.** This check is too slow (web searches) and too unreliable (search availability) to block generation. Run it before release, not before music_generate.

---

## Running for Full Album

When given an album slug without a specific track:

1. List all tracks via `list_tracks(album_slug)`
2. Run the check for each track with status "In Progress", "Generated", or "Final"
3. Skip tracks with status "Not Started" or "Sources Pending"
4. Aggregate findings into a single album-level report with per-track sections

---

## Example Invocations

```
/plagiarism-checker dark-tide
/plagiarism-checker dark-tide 03-the-wire
```
