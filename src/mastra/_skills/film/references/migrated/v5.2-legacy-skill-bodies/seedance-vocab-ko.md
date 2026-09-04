# Legacy v5.2 body for `seedance-vocab-ko`

Preserved from v5.1.0/v5.2 migration. Active skill lives in `src/mastra/_skills/film/skills/seedance-vocab-ko/SKILL.md`.

---

# seedance-vocab-ko

Use this skill for Korean Seedance 2.0 prompt wording and cinematic vocabulary. Keep active skill guidance lean; extended legacy term lists were moved to `references/migrated/seedance-vocab-ko-original.md`.

Rules:
- Translate production intent, not word-for-word English filler.
- Preserve reference tags exactly: `[Image1]`, `[Video1]`, `[Audio1]`.
- Preserve concrete nouns, action verbs, camera moves, light sources, and sound cues before style adjectives.
- Avoid protected names, studio names, celebrity names, and brand names unless the workflow is authorized.

Return: compact Korean prompt, optional English back-translation, key vocabulary choices, and safety/IP notes if relevant.
