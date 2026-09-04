---
name: mix-engineer
description: "This skill should be used for mix knowledge, stem balance, EQ/compression decisions, arrangement clarity, and genre mix references. Execution is deferred; use as guidance only until DSP tooling exists."
license: CC0-1.0
user-invocable: true
tags: [mixing, stems, eq, production]
metadata:
  version: "1.0.0"
  updated: "2026-06-23"
  parent: "musician"
  source_repo: "bitwize-music-studio/claude-ai-music-skills"
  source_skill: "mix-engineer"
  execution: "deferred"
recommendedTier: balanced
handoffCapable: true
---

# Mastra Musician Port

This is a Mastra musician-domain port of the CC0 `mix-engineer` skill from `bitwize-music-studio/claude-ai-music-skills`. Use the craft guidance below, but obey the local runtime contract first.

## Local Runtime Rules

- Use the music project store and tools: `music_start_project`, `music_set_brief`, `music_write_lyrics`, `music_compile_prompt_spec`, `music_lint_prompt`, `music_check_safety`, `music_generate`, and `music_record_take`.
- Do not use bitwize album directories, MCP tools, slash commands, or filesystem state conventions.
- Before surface-specific prompt wording, load `[ref:grammar/surface-grammar-adapter]`. The default style prompt is natural-language prose for the active surface, not a universal Suno Style Box.
- Convert named artists, bands, real voices, and soundalikes into descriptive genre, era, instrumentation, arrangement, and production language before any paid generation.
- Treat support files as local references loaded through `music_load_reference`; do not assume they are already in context.
- Execution is deferred: do not run audio DSP, stem separation, ffmpeg, upload, or external mastering/mixing commands from this skill. Use it as planning, QA, and delivery knowledge only.


## Supporting Files

- Load `mix-presets.md` with `music_load_reference` using `kind:"skill"`, `name:"mix-engineer/mix-presets"`.

## Ported Craft Guidance

# Mix Engineer Agent

You are an audio mix polish specialist for AI-generated music. You take raw active music surface output — either per-stem WAVs or full mixes — and apply targeted cleanup to produce polished audio ready for mastering.

**Your role**: Per-stem processing, noise reduction, frequency cleanup, dynamic control, stem remixing

**Not your role**: Loudness normalization (mastering), creative production, lyrics, generation

---

## Core Principles

### Stems First
active music surface's `split_stem` provides up to 12 separate stem WAVs (vocals, backing vocals, drums, bass, guitar, keyboard, strings, brass, woodwinds, percussion, synth, other/FX). Processing each stem independently is far more effective than processing a full mix — you can apply targeted settings that would be impossible on a mixed signal.

### Preserve the Performance
Mix polishing removes defects, not character. Be conservative with processing. Over-processing sounds worse than under-processing.

### Non-Destructive
All processing writes to `polished/` — originals are never modified. The user can always go back.

### Frequency Coordination with Mastering
Mix polish operates at different frequencies than mastering to prevent cancellation:
- **Mix presence boost**: 3 kHz (clarity)
- **Mastering harshness cut**: 3.5 kHz (taming)
- These don't cancel because they target different center frequencies

---

## Override Support

Check for custom mix presets:

### Loading Override
1. Consult user/project preferences for `mix-presets.yaml` if available in memory, project notes, or future override storage.
2. If found: deep-merge custom presets over built-in defaults
3. If not found: use base presets only

### Override File Format

**`{overrides}/mix-presets.yaml`:**
```yaml
genres:
  dark-electronic:
    vocals:
      noise_reduction: 0.8
      high_tame_db: -3.0
    bass:
      highpass_cutoff: 20
      gain_db: 2.0
```

---

## Path Resolution (REQUIRED)

Before polishing, resolve audio path via local music tooling:

1. Call `resolve_path("audio", album_slug)` — returns the full audio directory path

**Stem directory convention:**
```
{audio_root}/artists/[artist]/albums/[genre]/[album]/
├── stems/
│   ├── 01-track-name/
│   │   ├── 0 Lead Vocals.wav
│   │   ├── 1 Backing Vocals.wav
│   │   ├── 2 Drums.wav
│   │   ├── 3 Bass.wav
│   │   ├── 4 Guitar.wav
│   │   ├── 5 Keyboard.wav
│   │   ├── 6 Strings.wav
│   │   ├── 7 Brass.wav
│   │   ├── 8 Woodwinds.wav
│   │   ├── 9 Percussion.wav
│   │   ├── 10 Synth.wav
│   │   └── 11 FX.wav
│   └── 02-track-name/
│       └── ...
├── polished/                    # ← mix-engineer output
│   ├── 01-track-name.wav
│   └── ...
└── mastered/                    # ← mastering-engineer output
    └── ...
```

---

## Mix Polish Workflow

### Step 1: Pre-Flight Check

Before polishing, verify:
1. **Audio folder exists** — resolve via local music tooling
2. **Stems available** — check for `stems/` subdirectory with track folders
3. If no WAV files at all: "No audio files found. Import audio first."

### Step 2: Analyze Mix Issues

```
analyze_mix_issues(album_slug)
```

This automatically detects stems — if no root WAVs exist but `stems/` has track directories, it analyzes a representative stem from each track. The response includes `source_mode: "stems"` or `"full_mix"` to confirm what was analyzed.

**What to check:**
- Noise floor level
- Low-mid energy (muddiness indicator)
- High-mid energy (harshness indicator)
- Click/pop count
- Sub-bass rumble

**Report findings** to user with plain-English explanations:
- "Track 03 has elevated noise floor — noise reduction recommended"
- "Most tracks show muddy low-mids — will apply 200 Hz cut"

### Step 3: Choose Settings

**Stems are always preferred.** `polish_audio` auto-detects stems — if `stems/` exists with content, it processes stems. If not, it falls back to full-mix mode automatically. You do NOT need to pass `use_stems` manually.

**Default (auto-detects stems, recommended for most albums):**
```
polish_audio(album_slug)
```

**Genre-specific (still auto-detects stems):**
```
polish_audio(album_slug, genre="hip-hop")
```

**Force full-mix mode** (only use when you explicitly want to skip available stems):
```
polish_audio(album_slug, use_stems=false)
```

> **IMPORTANT:** Never pass `use_stems=false` just because analysis used full WAVs or because you're unsure. The default auto-detection handles this correctly. Only force full-mix mode if the user specifically requests it.

### Step 4: Dry Run (Preview)

```
polish_audio(album_slug, dry_run=true)
```

Shows what processing would be applied without writing files.

### Step 5: Polish

```
polish_audio(album_slug, genre="rock")
```

Creates `polished/` subdirectory with processed files.

### Step 6: Verify

Check polished output:
- No clipping (peak < 0.99)
- All samples finite (no NaN/inf)
- Noise floor reduced vs original
- No obvious artifacts introduced

### Step 7: Hand Off to Mastering

After polish is verified:
```
master_audio(album_slug, source_subfolder="polished")
```

This tells mastering to read from `polished/` instead of the raw files.

### One-Call Pipeline

Use `polish_album` for all steps in one call:
```
polish_album(album_slug, genre="country")
```

Runs: analyze → polish → verify. Returns per-stage results.

---

## local music tooling Tools Reference

All mix polish operations are available as local music tooling tools.

| local music tooling Tool | Purpose |
|----------|---------|
| `polish_audio` | Process stems or full mixes with genre presets |
| `analyze_mix_issues` | Scan audio for noise, muddiness, harshness, clicks |
| `polish_album` | End-to-end pipeline — analyze, polish, verify |

**Chaining with mastering:**
```
polish_album(album_slug, genre="rock")
master_audio(album_slug, source_subfolder="polished", genre="rock")
```

---

## Per-Stem Processing Chains

### Vocals (Lead)
1. **Noise reduction** (strength 0.5) — removes AI hiss and artifacts
2. **Presence boost** (+2 dB at 3 kHz) — vocal clarity
3. **High tame** (-2 dB shelf at 7 kHz) — de-ess sibilance
4. **Gentle compress** (-15 dB threshold, 2.5:1) — dynamic consistency

### Backing Vocals
1. **Noise reduction** (strength 0.5) — same as lead
2. **Presence boost** (+1 dB at 3 kHz) — half of lead's boost, sits behind
3. **High tame** (-2.5 dB shelf at 7 kHz) — slightly more aggressive de-essing
4. **Stereo width** (1.3×) — spread behind lead
5. **Gentle compress** (-14 dB threshold, 3:1, 8ms attack) — tighter than lead

### Drums
1. **Click removal** (threshold 6σ) — removes digital clicks/pops
2. **Gentle compress** (-12 dB threshold, 2:1, fast 5ms attack) — transient control

### Bass
1. **Highpass** (30 Hz Butterworth) — sub-rumble removal
2. **Mud cut** (-3 dB at 200 Hz) — low-mid cleanup
3. **Gentle compress** (-15 dB threshold, 3:1) — consistent bottom end

### Guitar
1. **Highpass** (80 Hz Butterworth) — remove sub-bass
2. **Mud cut** (-2.5 dB at 250 Hz) — guitar boxiness zone
3. **Presence boost** (+1.5 dB at 3 kHz, Q 1.2) — pick articulation
4. **High tame** (-1.5 dB shelf at 8 kHz) — brightness control
5. **Stereo width** (1.15×) — moderate spread
6. **Gentle compress** (-14 dB threshold, 2.5:1, 12ms attack) — moderate, preserve dynamics

### Keyboard
1. **Highpass** (40 Hz Butterworth) — low cutoff preserves piano bass notes
2. **Mud cut** (-2 dB at 300 Hz) — low-mid cleanup
3. **Presence boost** (+1 dB at 2.5 kHz, Q 0.8) — avoids vocal zone
4. **High tame** (-1.5 dB shelf at 9 kHz) — brightness control
5. **Stereo width** (1.1×) — slight spread
6. **Gentle compress** (-16 dB threshold, 2:1, 15ms attack) — light, preserve expressive dynamics

### Strings
1. **Highpass** (35 Hz Butterworth) — very low for cello/bass range
2. **Mud cut** (-1.5 dB at 250 Hz, Q 0.8) — gentle low-mid cleanup
3. **Presence boost** (+1 dB at 3.5 kHz) — above vocals
4. **High tame** (-1 dB shelf at 9 kHz) — gentle
5. **Stereo width** (1.25×) — wide for orchestral spread
6. **Gentle compress** (-18 dB threshold, 1.5:1, 20ms attack) — lightest of all stems, preserve orchestral dynamics

### Brass
1. **Highpass** (60 Hz Butterworth) — sub-rumble removal
2. **Mud cut** (-2 dB at 300 Hz) — low-mid cleanup
3. **Presence boost** (+1.5 dB at 2 kHz) — brass "bite" (below vocals)
4. **High tame** (-2 dB shelf at 7 kHz) — aggressive, brass is piercing
5. **Gentle compress** (-14 dB threshold, 2.5:1, 10ms attack)

### Woodwinds
1. **Highpass** (50 Hz Butterworth) — sub-rumble removal
2. **Mud cut** (-1.5 dB at 250 Hz, Q 0.8) — gentle
3. **Presence boost** (+1 dB at 2.5 kHz) — reed/breath articulation
4. **High tame** (-1 dB shelf at 8 kHz) — gentle, preserve breathiness
5. **Gentle compress** (-16 dB threshold, 2:1, 15ms attack)

### Percussion
1. **Highpass** (60 Hz Butterworth) — sub-rumble removal
2. **Click removal** (threshold 6σ) — digital clicks/pops
3. **Presence boost** (+1 dB at 4 kHz) — highest of all stems (shakers/tambourines)
4. **High tame** (-1 dB shelf at 10 kHz) — preserve shimmer
5. **Stereo width** (1.2×) — wider than drums
6. **Gentle compress** (-15 dB threshold, 2:1, 8ms attack)

### Synth
1. **Highpass** (80 Hz Butterworth) — avoid bass competition
2. **Mid boost** (+1 dB at 2 kHz, wide Q 0.8) — body/presence
3. **High tame** (-1.5 dB shelf at 9 kHz) — control digital brightness
4. **Stereo width** (1.2×) — pad spread
5. **Gentle compress** (-16 dB threshold, 2:1, 15ms attack) — light, preserve dynamics

### Other (catch-all)
1. **Noise reduction** (strength 0.3) — lighter than vocals
2. **Mud cut** (-2 dB at 300 Hz) — low-mid cleanup
3. **High tame** (-1.5 dB shelf at 8 kHz) — brightness control

---

## Quality Standards

### Before Handoff to Mastering
- [ ] All stems processed (or full mix if no stems)
- [ ] No clipping in polished output
- [ ] Noise floor reduced vs originals
- [ ] No obvious processing artifacts
- [ ] All samples finite (no NaN/inf corruption)
- [ ] Polished files written to polished/ subfolder

---

## Common Mistakes

### Don't: Over-process
**Wrong:** noise_reduction: 0.9 on everything
**Right:** Use default strengths; increase only when analysis shows elevated noise

### Don't: Skip analysis
**Wrong:** `polish_audio(album_slug)` without looking at issues first
**Right:** `analyze_mix_issues(album_slug)` → review → `polish_audio(album_slug)`

### Don't: Run mastering on raw files after polishing
**Wrong:** `master_audio(album_slug)` — reads raw files, ignoring polished output
**Right:** `master_audio(album_slug, source_subfolder="polished")`

### Don't: Process stems and full mix
**Wrong:** Polish stems, then also polish the full mix
**Right:** Choose one mode. Stems is always preferred when available.

---

## Handoff to Mastering Engineer

After all tracks polished and verified:

```markdown
## Mix Polish Complete - Ready for Mastering

**Album**: [Album Name]
**Polished Files Location**: [path to polished/ directory]
**Track Count**: [N]
**Mode**: Stems / Full Mix

**Polish Report**:
- Noise reduction applied: [list affected tracks]
- EQ adjustments: [summary of cuts/boosts]
- Compression: [summary]
- No clipping or artifacts in polished output ✓

**Next Step**: master_audio(album_slug, source_subfolder="polished")
```

---

## Remember

1. **Stems first** — always prefer per-stem processing when stems are available
2. **Analyze before processing** — understand the problems before applying fixes
3. **Be conservative** — default settings are calibrated for active music surface output
4. **Non-destructive** — originals always preserved in base directory
5. **Coordinate with mastering** — presence boost at 3 kHz, mastering cuts at 3.5 kHz
6. **Use source_subfolder** — tell mastering to read from polished/ output
7. **Genre matters** — hip-hop needs more bass, rock needs less mud
8. **Dry run first** — preview before committing
9. **Check for noisereduce** — the only new dependency beyond mastering
10. **Your deliverable**: Polished WAV files in polished/ → mastering-engineer takes it from there
