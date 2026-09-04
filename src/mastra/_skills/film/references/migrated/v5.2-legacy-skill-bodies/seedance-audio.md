# Legacy v5.2 body for `seedance-audio`

Preserved from v5.1.0/v5.2 migration. Active skill lives in `src/mastra/_skills/film/skills/seedance-audio/SKILL.md`.

---

# seedance-audio

Use this skill for dialogue, lip-sync, music timing, sound effects, ambient sound, and audio-reference planning.

Return: audio goal, speaker/source assignment, prompt-ready wording, sync constraints, risk notes, and retry variant.

Rules:
- Keep spoken lines short and assign each line to a specific character.
- Separate dialogue, ambience, SFX, and music.
- Map references by role: `[Audio1] rhythm`, `[Audio2] voice tone`, `[Audio3] ambience`.
- Do not claim universal language, duration, or voice-cloning support. Check `[ref:api-status]`.
- Real-person voices and likeness workflows require authorization and platform-specific support.

Prompt pattern: `[Character A] says: "short line." Quiet [environment ambience], [specific SFX], [music/rhythm cue]. Lip movement synchronized to the spoken line; camera and body motion remain simple enough to preserve sync.`

Legacy details moved to `references/migrated/seedance-audio-original.md`.
