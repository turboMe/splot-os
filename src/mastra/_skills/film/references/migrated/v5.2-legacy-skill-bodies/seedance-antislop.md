# Legacy v5.2 body for `seedance-antislop`

Preserved from v5.1.0/v5.2 migration. Active skill lives in `src/mastra/_skills/film/skills/seedance-antislop/SKILL.md`.

---

# seedance-antislop

Use this skill to remove generic AI-video filler and convert vague language into observable production instructions.

Test: if a camera operator, lighting technician, actor, or editor cannot act on a word, replace it.

Remove first: cinematic masterpiece, ultra realistic, breathtaking, stunning, beautiful, epic, professional quality, dramatic atmosphere, magical, dreamy, highly detailed.

Replace with: subject noun, action verb, one camera move, light source, material texture, timing, reference role, physical consequence, audio cue.

Compression order: reference tags -> subject nouns -> action verbs -> camera move -> light source -> audio cue -> style constraint. Delete generic adjectives first.

Return the cleaned prompt, removed phrases, and one sentence explaining the compression tradeoff.

Legacy details moved to `references/migrated/seedance-antislop-original.md`.
