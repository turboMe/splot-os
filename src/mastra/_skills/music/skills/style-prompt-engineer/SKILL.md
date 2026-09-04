---
name: style-prompt-engineer
description: "This skill should be used when creating or refining a music style prompt, adapting Suno-oriented prompt language to fal/ACE-Step, fal MiniMax reference generation, fal Stable Audio, ElevenLabs Music, or the optional suno-gateway, choosing genre descriptors, translating artist references into safe descriptive language, or preparing the style side of a MusicPromptSpec before music_generate."
license: CC0-1.0
user-invocable: true
tags: [music, style-prompt, prompt-engineering, surface-adapter, fal, elevenlabs, suno]
metadata:
  version: "1.0.0"
  updated: "2026-06-23"
  parent: "musician"
  source_repo: "bitwize-music-studio/claude-ai-music-skills"
  source_skill: "suno-engineer"
recommendedTier: balanced
handoffCapable: true
---

# Style Prompt Engineer

Use this skill to turn a music brief, lyric draft, genre request, or reference
description into the style side of a `MusicPromptSpec`.

Always load `[ref:grammar/surface-grammar-adapter]` before applying provider
specific grammar. The default runtime style prompt is natural-language prose, not
Suno Style Box/Lyrics Box text.

## Inputs To Gather

- project id and track id, if a project already exists;
- target surface: `fal`, `fal-ace-step`, `fal-stable-audio`, `fal-minimax-reference`, `elevenlabs`, or `suno-gateway`;
- generation mode: `text2music`, `lyrics2song`, `instrumental`, `audio2audio`, or `extend`;
- primary genre and one or two subgenre modifiers;
- mood, energy, tempo/BPM, language, vocal type, and track length;
- instrumentation, production texture, and structure;
- reference audio roles, if any;
- artist, band, era, or scene references that need safety rewriting.

If the request names a genre and the exact reference exists, load
`[ref:genres/<genre>]`. If the genre name is uncertain, search references first.

## Output Contract

Produce:

1. a compact natural-language `style_prompt`;
2. 3-8 `tags` for `music_compile_prompt_spec`;
3. notes on provider-specific translation;
4. safety rewrites for any named-artist or soundalike wording;
5. one retry variant only when the prior take failed.

The `style_prompt` should be one paragraph. It must not be JSON. It should not
contain `Style Box:`, `Lyrics Box:`, or copy-paste Suno field labels unless the
active surface is explicitly `suno-gateway`.

## Prompt Shape

Use this order unless the brief demands otherwise:

```text
[genre/subgenre], [mood/energy], [tempo], [instrumentation], [vocal character],
[production/mix], [structure or arrangement intent].
```

Example:

```text
melancholic synthwave, 92 BPM, analog arpeggiated bass, gated drums, glassy
poly synth pads, intimate female vocal, neon-night production, verse/chorus
form with a restrained bridge and wide final chorus.
```

## Surface Translation

### fal / ACE-Step Default

`fal` defaults to ACE-Step for text/lyrics-to-audio. Keep `style_prompt` as
natural-language genre/mood/instrumentation/production prose; the runtime derives
ACE-Step `tags` and preserves `lyrics` separately. Do not attach reference audio
to this default surface.

### fal MiniMax Reference

Use `fal-minimax-reference` only when the user supplied reference audio. The
runtime requires `reference_audio_url` and uses a short prompt; do not select this
surface for text-only or full-lyrics generation.

### fal Stable Audio

Use `fal-stable-audio` for prompt-to-audio or instrumental work. It does not
accept supplied lyrics in this runtime, so choose ACE-Step or ElevenLabs for
`lyrics2song`.

### ElevenLabs Music

Write the prompt as a complete prose brief because the local runtime folds lyrics
into the request body. Include duration intent naturally when `length_ms` matters.
Do not reference audio; the local ElevenLabs config has `maxReferences:0`.

### suno-gateway

Only when `SUNO_GATEWAY_BASE_URL` is configured, native Suno grammar can apply.
Then section tags, Suno V5/V5.5 prompt practices, and gateway-specific fields may
be used. Keep this branch isolated from the default `style_prompt`.

## Genre Selection

- Prefer one primary genre plus one or two modifiers.
- Add one key instrument or production signature.
- Include BPM for dance, punk, rap, electronic, cinematic, or tightly paced vocal work.
- Use genre references for conventions, not as mandatory tag lists.
- Avoid five or more competing genres unless the user explicitly wants collage.

Better:

```text
midwest emo with math-rock influence, clean tapped guitar, live-room drums,
urgent male vocal, 152 BPM, raw but polished indie production.
```

Too diffuse:

```text
emo, math rock, shoegaze, post-rock, ambient, punk, indie, dream pop, cinematic.
```

## Artist And IP Safety

Never output "in the style of [real artist]" or "sounds like [artist]" in a final
style prompt. Convert artist references into descriptors:

| Unsafe request | Safe conversion |
|---|---|
| "like Taylor Swift" | polished 2020s pop songwriting, conversational lyric phrasing, bright chorus lift |
| "Drake type beat" | moody melodic rap, sparse 808s, half-sung vocal cadence, nocturnal synth pads |
| "Beatles harmonies" | close three-part vocal harmony, melodic bass movement, 1960s guitar-pop arrangement |

After rewriting, run `music_check_safety` before paid generation.

## Instrumental Tracks

For instrumental work, remove vocal requirements and make the arrangement carry
the identity:

```text
cinematic post-rock instrumental, 74 BPM, tremolo guitar swells, bowed bass,
soft mallet percussion, slow crescendo, wide reverb, no lead vocal.
```

## Pre-Generation Checklist

Before `music_generate`:

- project and track exist in the music project store;
- brief is recorded with `music_set_brief`;
- lyrics are present for `lyrics2song` unless instrumental;
- style prompt is natural-language prose;
- genre references and provider adapter were loaded when relevant;
- artist names have been converted to descriptors;
- `music_lint_prompt` and `music_check_safety` pass;
- paid-generation approval and spend caps are respected.
