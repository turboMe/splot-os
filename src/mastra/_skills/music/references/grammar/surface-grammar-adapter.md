# Music Surface Grammar Adapter

This reference maps music-writing and style-prompt craft onto the active
generation surface. Treat it as the source of truth whenever a ported music
skill mentions Suno-style concepts such as Style Box, Lyrics Box, section tags,
voice tags, instrumental tags, or negative style guidance.

Verified against the local runtime and official provider docs on 2026-06-23.

## Runtime Surfaces

| Concept | fal / ACE-Step default | fal MiniMax reference | fal Stable Audio | ElevenLabs Music | suno-gateway |
|---|---|---|---|---|---|
| Default use | Text/lyrics to music through fal queue | Reference-audio generation through fal queue | Prompt-to-audio/instrumental through fal queue | Synchronous music generation bytes | Optional ToS-compliant gateway seam |
| Style input | `tags` comma-separated genre/style controls derived from natural-language `style_prompt` | short `prompt` tied to reference audio | `prompt` natural-language request | `prompt` natural-language request or `composition_plan` | Native Suno style field if gateway supports it |
| Lyrics input | `lyrics`; omit for instrumental | short `prompt`; runtime caps this route tightly | not supported as separate lyrics | Fold lyrics into `prompt` unless composition plan is explicitly supported | Native Lyrics Box |
| Structure tags | Advisory tags such as `[verse]`, `[chorus]`, `[bridge]` | Reference-dependent, not a text-only DSL | Describe structure in prose | Not a portable DSL; describe structure in prose | Native `[Verse]`, `[Chorus]`, `[Bridge]`, etc. |
| Instrumental | runtime instrumental mode omits lyrics | Not the default route | Native prompt-only/instrumental route | `force_instrumental` with prompt route | Native instrumental toggle/tags |
| Reference audio | Not supported by the default ACE-Step surface in this runtime | required `reference_audio_url` | Not supported in the local config | Not supported in the local config | Gateway-dependent |
| Length | `duration` seconds | route-specific duration fields | `seconds_total` | `music_length_ms` 3000-600000 | Gateway-dependent |
| Output | `audio.url` result from async queue | `audio.url` result from async queue | `audio_file.url` result from async queue | audio bytes from `POST /v1/music` | Gateway-dependent |

## Hard Rule

The internal `MusicPromptSpec.style_prompt` is natural language. Do not serialize
JSON into the style prompt, and do not make Suno Style Box wording the universal
format. Translate any provider-native grammar at the final surface boundary.

## Portable Style Prompt Shape

Use one compact paragraph:

```text
[primary genre/subgenre], [mood/energy], [tempo if known], [instrumentation],
[vocal character if vocal], [production/mix character], [structure in prose].
```

Good:

```text
melancholic synthwave, 92 BPM, analog arpeggiated bass, gated drums, glassy
poly synth pads, intimate female vocal, neon-night production, verse/chorus
form with a restrained bridge and wide final chorus.
```

Avoid:

```text
{"genre":"synthwave","vocal":"female"}
```

Avoid unless `surface:"suno-gateway"`:

```text
Style Box: female vocal, synthwave
Lyrics Box:
[Verse]
...
```

## Section Tags

Section tags are safe in lyric drafts because several music systems tolerate
them, but they are not equally authoritative everywhere.

- For fal/ACE-Step: keep common tags in lyrics only when they help structure, and
  also describe the structure in the natural-language style prompt.
- For fal/MiniMax reference: do not use it for text-only structure control; it
  requires reference audio and a short prompt.
- For ElevenLabs: prefer prose structure in the prompt; if the lyrics are folded
  into the prompt, section headings may help readability but are not a guaranteed
  control surface.
- For suno-gateway: native Suno grammar applies. Use the Suno references only
  after confirming the gateway is enabled.

Preferred portable tags:

```text
[Intro], [Verse], [Pre-Chorus], [Chorus], [Bridge], [Instrumental], [Solo],
[Outro]
```

## Vocal Tags

Convert voice tags to plain words in the style prompt:

| Source-style tag | Portable wording |
|---|---|
| `[male vocal]` | male vocal, baritone/tenor if known |
| `[female vocal]` | female vocal, alto/soprano if known |
| `[duet]` | duet vocal, alternating lines, shared chorus |
| `[choir]` | choir vocals, layered harmonies |
| `[rap verse]` | rap verse, rhythmic spoken flow |

Do not request a real person, living artist, band, celebrity voice, or
soundalike. Use descriptive vocal character instead.

## Instrumental Guidance

For instrumental tracks:

- set `vocal_type:"instrumental"`;
- omit lyrics or use the surface-native instrumental flag when supported;
- make the style prompt carry genre, tempo, arrangement, lead instrument,
  texture, dynamics, and mix;
- avoid vocal descriptors unless the target is wordless choir, vocoder texture,
  or sampled vocal chops.

## Negative Prompting

Negative style guidance is not portable. When a provider has no explicit
negative field, fold only one or two exclusions into prose:

```text
No trap drums or distorted guitars; keep the arrangement acoustic and sparse.
```

Do not stack long "no ..." lists. They dilute the positive target.

## Provider Notes

### fal / ACE-Step Default

The default `fal` surface targets ACE-Step. ACE-Step uses `tags` as the primary
style control and accepts `lyrics`. For this runtime, compile a natural-language
style prompt first; the transport layer derives tags from genre, mood,
instrumentation, and production labels.

### fal MiniMax Reference

MiniMax Music is exposed through `surface:"fal-minimax-reference"` in this
runtime. The fal model docs for the main endpoint require `reference_audio_url`;
do not select MiniMax for text-only or full-lyrics generation. Keep the prompt
short enough for the active reference route.

### fal Stable Audio

Stable Audio uses a single `prompt` plus `seconds_total`. It is best for
instrumental/prompt-to-audio work in this runtime; use ACE-Step or ElevenLabs
when supplied lyrics must be sung.

### ElevenLabs Music

ElevenLabs Music uses `POST /v1/music` and returns audio bytes in the local
runtime. The prompt route accepts a simple `prompt`; `music_length_ms` is valid
from 3000 to 600000 ms. The local runtime folds lyrics into the prompt body, so
write prompts that read naturally as a complete music brief.

### suno-gateway

Suno has no official public API wired in this repo. The gateway is disabled
unless `SUNO_GATEWAY_BASE_URL` is configured. Only then should native Suno
references such as Style Box, Lyrics Box, V5 tags, Voices, Custom Models, or
negative style fields be treated as executable surface grammar.

## Safety Boundary

Artist deep-dives and genre references are descriptive knowledge. They must not
be turned into "in the style of [artist]" prompts. Convert names into era, genre,
instrumentation, vocal character, arrangement, and production descriptors, then
run `music_check_safety` before any paid call.
