# MusicPromptSpec examples

Loader-only examples for `music_load_reference` with `kind:"example"`.
They are written against the local `MusicPromptSpec` schema, not against a
single provider's raw request body.

- `fal-lyrics2song.json` - default fal surface, separate lyrics and style prompt.
- `fal-audio2audio-reference.json` - fal reference-audio flow with one tagged source.
- `elevenlabs-lyrics2song.json` - ElevenLabs Music flow with explicit length and no reference audio.

Use these as shape references before `music_compile_prompt_spec`,
`music_lint_prompt`, and `music_generate`.
