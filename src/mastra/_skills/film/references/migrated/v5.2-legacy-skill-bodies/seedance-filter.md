# Legacy v5.2 body for `seedance-filter`

Preserved from v5.1.0/v5.2 migration. Active skill lives in `src/mastra/_skills/film/skills/seedance-filter/SKILL.md`.

---

# seedance-filter

Use this skill when a prompt is blocked, degraded, or likely to trigger content filters. The job is not to bypass safety systems; it is to preserve legitimate creative intent with safer surface wording.

Diagnostic questions:
1. Is the risk identity-based: celebrity, public figure, named character, brand, logo, voice, or face?
2. Is the risk violence, sexuality, minors, self-harm, or weapon wording?
3. Is the risk copyright or platform policy?
4. Is the risk false-positive wording that can be replaced with neutral production language?

Rewrite rules:
- Replace protected identity with original archetype.
- Replace graphic harm with non-graphic action consequence.
- Replace weapon emphasis with choreography, blocking, or prop-neutral movement.
- Replace clone/copy/replicate with reference-informed pacing only when references are owned/licensed.

Return: likely trigger category, safe rewrite, retained intent, removed terms, and retry variant.

Legacy details moved to `references/migrated/seedance-filter-original.md`.
