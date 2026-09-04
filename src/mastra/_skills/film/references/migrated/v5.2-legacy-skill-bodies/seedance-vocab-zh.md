# Legacy v5.2 body for `seedance-vocab-zh`

Preserved from v5.1.0/v5.2 migration. Active skill lives in `src/mastra/_skills/film/skills/seedance-vocab-zh/SKILL.md`.

---

# seedance-vocab-zh

Use this skill for Chinese Seedance 2.0 prompt wording and cinematic vocabulary. Keep active skill guidance lean; extended legacy term lists were moved to `references/migrated/seedance-vocab-zh-original.md`.

Rules:
- Translate production intent, not word-for-word English filler.
- Preserve reference tags exactly: `[Image1]`, `[Video1]`, `[Audio1]`.
- Preserve concrete nouns, action verbs, camera moves, light sources, and sound cues before style adjectives.
- Avoid protected names, studio names, celebrity names, and brand names unless the workflow is authorized.

Return: compact Chinese prompt, optional English back-translation, key vocabulary choices, and safety/IP notes if relevant.
