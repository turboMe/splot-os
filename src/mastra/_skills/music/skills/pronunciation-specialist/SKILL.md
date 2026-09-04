---
name: pronunciation-specialist
description: "This skill should be used when lyrics include homographs, names, acronyms, non-English words, technical terms, slang, or any phrase likely to be mispronounced by sung/TTS music surfaces."
license: CC0-1.0
user-invocable: true
tags: [lyrics, pronunciation, phonetics, vocal]
metadata:
  version: "1.0.0"
  updated: "2026-06-23"
  parent: "musician"
  source_repo: "bitwize-music-studio/claude-ai-music-skills"
  source_skill: "pronunciation-specialist"
recommendedTier: balanced
handoffCapable: true
---

# Mastra Musician Port

This is a Mastra musician-domain port of the CC0 `pronunciation-specialist` skill from `bitwize-music-studio/claude-ai-music-skills`. Use the craft guidance below, but obey the local runtime contract first.

## Local Runtime Rules

- Use the music project store and tools: `music_start_project`, `music_set_brief`, `music_write_lyrics`, `music_compile_prompt_spec`, `music_lint_prompt`, `music_check_safety`, `music_generate`, and `music_record_take`.
- Do not use bitwize album directories, MCP tools, slash commands, or filesystem state conventions.
- Before surface-specific prompt wording, load `[ref:grammar/surface-grammar-adapter]`. The default style prompt is natural-language prose for the active surface, not a universal Suno Style Box.
- Convert named artists, bands, real voices, and soundalikes into descriptive genre, era, instrumentation, arrangement, and production language before any paid generation.
- Treat support files as local references loaded through `music_load_reference`; do not assume they are already in context.

## Supporting Files

- Load `word-lists.md` with `music_load_reference` using `kind:"skill"`, `name:"pronunciation-specialist/word-lists"`.

## Ported Craft Guidance

# Pronunciation Specialist

Scan lyrics for pronunciation risks, suggest phonetic spellings, prevent active music surface mispronunciations.

## Why This Matters

**The problem**: active music surface AI guesses pronunciation. Wrong guess = wrong song = wasted generation.

**One wrong word ruins the take.**

## When to Invoke

**Always invoke between lyric-writer and lyric-reviewer:**

```
lyric-writer (WRITES + SUNO PROMPT) → pronunciation-specialist (RESOLVES) → lyric-reviewer (VERIFIES) → pre-generation-check
                                                  |
                                     Scan, resolve, fix risky words
```

**Your role — RESOLVE:**
- The lyric-writer flags potential pronunciation risks and asks about homographs
- You do the deep scan, resolve ambiguities with the user, and apply all phonetic fixes
- The lyric-reviewer then verifies all resolutions were correctly applied

---

## High-Risk Word Categories

See [word-lists.md](word-lists.md) for complete tables. Summary:

### 1. Homographs (CRITICAL)
Same spelling, different pronunciation. **ALWAYS require clarification.**
*(Canonical reference: `[ref:grammar/pronunciation-guide] when ported; otherwise [ref:grammar/surface-grammar-adapter]`. Keep this summary in sync.)*

| Word | Options | Fix |
|------|---------|-----|
| live | LYVE (verb) / LIV (adjective) | "lyve" or "liv" |
| read | REED (present) / RED (past) | "reed" or "red" |
| lead | LEED (guide) / LED (metal) | "leed" or "led" |
| wind | WYND (air) / WINED (coil) | "wynd" or "wined" |
| tear | TEER (cry) / TARE (rip) | "teer" or "tare" |
| bass | BAYSS (music) / BASS (fish) | "bayss" or "bass" |

### 2. Tech Terms
active music surface often mispronounces tech words:
- Linux → "Lin-ucks" (not "Line-ucks")
- SQL → "S-Q-L" or "sequel"
- API, CLI, SSH → spell out with hyphens

### 3. Names & Proper Nouns
Non-English names need phonetic spelling:
- Jose → "Ho-zay"
- Ramos → "Rah-mohs"
- Sinaloa → "Sin-ah-lo-ah"

### 4. Acronyms
3-letter acronyms → spell out with hyphens (FBI → F-B-I)
Word-like acronyms → phonetic (RICO → Ree-koh, NASA → Nah-sah)

### 5. Numbers
- Years: Use apostrophes ('93) or words (nineteen ninety-three)
- Digits: Write out (four-oh-four, not 404)

---

## Pronunciation Guides

You reference TWO pronunciation guides:

### Base Guide (Plugin-Maintained)
- **Location**: `[ref:grammar/pronunciation-guide] when ported; otherwise [ref:grammar/surface-grammar-adapter]`
- **Contains**: Universal pronunciation rules, common homographs, tech terms
- **Updated**: By plugin maintainers when new issues are discovered

## Override Support

Check for custom pronunciation entries:

### Loading Override
1. Consult user/project preferences for `pronunciation-guide.md` if available in memory, project notes, or future override storage.
2. If found: load and merge with base guide (override entries take precedence)
3. If not found: use base guide only (skip silently)

### Override File Format

**`{overrides}/pronunciation-guide.md`:**
```markdown
# Pronunciation Guide (Override)

## Artist Names
| Name | Pronunciation | Notes |
|------|---------------|-------|
| Ramos | Rah-mohs | Character name |

## Album-Specific Terms
| Term | Pronunciation | Notes |
|------|---------------|-------|
| Sinaloa | Sin-ah-lo-ah | Location |
```

### How to Use Override
- Add artist names, album-specific terms, and genre-specific jargon
- Override entries take precedence over base guide entries for the same word
- Base guide updates via plugin updates without conflicts
- Override guide is version-controlled with your music content

---

## Scanning Workflow

### Step 1: Automated Scan via local music tooling

1. Extract lyrics: `extract_section(album_slug, track_slug, "lyrics")`
2. Homograph scan: `check_homographs(lyrics_text)` — returns found homographs with line numbers, pronunciation options
3. Additional manual scan for tech terms, acronyms, numbers, and names (not covered by local music tooling homograph list) — cross-reference [word-lists.md](word-lists.md)
4. If style prompt exists: `scan_artist_names(style_text)` — catch blocklisted names

After fixes are applied:
5. Verify: `check_pronunciation_enforcement(album_slug, track_slug)` — confirms all pronunciation table entries appear in lyrics

### Step 2: Review Results

From local music tooling results and manual scan:
- Which words were flagged?
- What's the recommended fix for each?

### Step 3: Generate Report

For each flagged word, provide:
1. Line number and context
2. Why it's risky (ambiguity type)
3. Suggested phonetic spelling
4. Alternative if multiple pronunciations exist

**Example output**:
```
PRONUNCIATION RISKS FOUND (3):

Line V1:3 -> "We live in darknet spaces"
  Risk: "live" is homograph
  Options: "lyve" (verb) or "liv" (adjective)
  -> Needs clarification

Line C:1 -> "SQL injection in the code"
  Risk: "SQL" is tech acronym
  Fix: "S-Q-L" or "sequel"
  -> Auto-fix: "S-Q-L injection in the code"

Line V2:5 -> "Reading Linux logs at 3AM"
  Risk: "Linux" commonly mispronounced
  Fix: "Lin-ucks"
  -> Auto-fix: "Reading Lin-ucks logs at 3 A-M"
```

### Step 4: User Confirmation

**For ambiguous words (like "live")**: Ask user which pronunciation
**For clear fixes (tech terms)**: Auto-fix

---

## Auto-Fix Rules

### Always Auto-Fix
- Tech terms (SQL → S-Q-L, Linux → Lin-ucks)
- Common acronyms (FBI → F-B-I, GPS → G-P-S)
- Numbers (1993 → '93 or nineteen ninety-three)

### Ask User First
- Homographs (live, read, lead, wind, tear)
- Names (confirm pronunciation preference)
- Words with regional variants (data, either, route)

---

## Output Format

### Track File Updates

If given a track file, update these sections:

**Pronunciation Notes** (add table):
```markdown
| Word/Phrase | Phonetic | Notes |
|-------------|----------|-------|
| Jose Diaz | Ho-say Dee-ahz | Spanish name |
| live | lyve | Verb form (to reside) |
| SQL | S-Q-L | Spell out |
```

**`lyrics` field** (apply fixes):
Replace standard spelling with phonetic in the active music surface lyrics section.

### Standalone Report

```
PRONUNCIATION SCAN COMPLETE
===========================
File: [path or "direct input"]
Risks found: X
Auto-fixed: Y
Needs user input: Z

FIXES APPLIED:
- "SQL" → "S-Q-L" (line V1:3)
- "Linux" → "Lin-ucks" (line V2:5)

NEEDS USER INPUT:
- "live" (line C:1) - lyve or liv?

CLEAN LYRICS:
[Full lyrics with all fixes applied]
```

---

## Adding Custom Pronunciations

When you discover new pronunciation issues specific to the user's content:

**Add to OVERRIDE guide** (`{overrides}/pronunciation-guide.md`):
1. Read config to get `paths.overrides` location
2. Check for `{overrides}/pronunciation-guide.md`
3. Create file if it doesn't exist (with header and table structure)
4. Add the word to appropriate section (Artist Terms, Album Names, etc.)
5. Include: word, standard spelling, phonetic spelling, notes

**Example entry:**
```markdown
| Larocca | larocca | Luh-rock-uh | Character in "sample-album" album |
```

**DO NOT** edit the base guide (`[ref:grammar/pronunciation-guide] when ported; otherwise [ref:grammar/surface-grammar-adapter]`) - plugin updates will overwrite it.

**When to add:**
- Artist names, album titles, track titles
- Character names in documentary/narrative albums
- Location names specific to album content
- Any pronunciation discovered during production

This keeps discoveries version-controlled with the music content in the overrides directory.

---

## Remember

1. **Load both guides at start** - Base guide + override guide (if exists)
2. **Homographs are landmines** - live, read, lead, wind WILL mispronounce without fixes
3. **Tech terms need phonetic spelling** - Don't trust active music surface with acronyms
4. **Non-English names always need help** - Phonetic spelling mandatory
5. **Numbers are tricky** - Write them out or use apostrophes
6. **When in doubt, ask** - Better to clarify than regenerate
7. **Add discoveries to OVERRIDE guide** - Never edit base guide (plugin will overwrite)
