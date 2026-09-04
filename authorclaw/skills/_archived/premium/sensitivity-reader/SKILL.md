---
name: sensitivity-reader
description: AI-assisted sensitivity review for representation, cultural accuracy, and potential reader concerns
author: Writing Secrets
version: 1.0.0
triggers:
  - "sensitivity read"
  - "sensitivity review"
  - "sensitivity check"
  - "representation check"
  - "cultural review"
  - "bias check"
  - "inclusive review"
  - "sensitivity reader"
permissions:
  - file:read
  - file:write
---

# Sensitivity Reader — Premium Skill

AI-assisted sensitivity review that flags potential representation issues, cultural inaccuracies, stereotypes, and reader-concern areas before publication. Not a replacement for human sensitivity readers — but a powerful first pass that catches the obvious issues and helps you ask the right questions.

## Important Disclaimer

This tool is an AI assistant, not a cultural authority. It can identify patterns and flag potential concerns, but it cannot fully replicate the lived experience of a human sensitivity reader. For published works, we strongly recommend also working with human readers from relevant communities.

## What It Catches

### Representation Patterns
- **Stereotyping** — Characters reduced to cultural/racial/gender tropes
- **Token representation** — Single diverse character without depth
- **White savior patterns** — Majority-group character "saving" minority characters
- **Magical minority** — Diverse characters existing only to help the protagonist
- **Disability as metaphor** — Using disability symbolically rather than realistically
- **Bury your gays** — LGBTQ+ characters disproportionately killed or punished

### Language & Terminology
- Outdated or offensive terminology (with current alternatives)
- Microaggressions in dialogue (flagged with context — sometimes intentional for character)
- Slurs and reclaimed language (flagged with usage guidance)
- Gendered language patterns
- Ableist language in narration vs. dialogue

### Cultural Accuracy
- Religious practices and terminology
- Cultural customs and traditions
- Food, clothing, and daily life details
- Historical accuracy for period pieces
- Language and dialect representation
- Name accuracy for cultural background

### Power Dynamics
- Workplace/authority dynamics
- Age-gap relationships (flagged, not judged)
- Consent in romantic/intimate scenes
- Economic disparity portrayal
- Institutional power representation

## Report Format

```
Sensitivity Review: "The Silent Hour"
Chapters Reviewed: 1-25 (Full Manuscript)
Review Date: 2026-02-24

══════════════════════════════════════
SUMMARY
══════════════════════════════════════
Flags Found:     14
  High Priority:  2
  Medium:         7
  Low/Note:       5

Overall Assessment: Generally thoughtful representation with
a few areas that would benefit from a second look.

══════════════════════════════════════
HIGH PRIORITY
══════════════════════════════════════

[FLAG H-1] Chapter 8, Page 112
Category: Cultural Accuracy
"She performed the ceremony exactly as her grandmother taught
her, burning sage in a clay bowl."

Issue: Sage burning (smudging) is a sacred practice in specific
Indigenous cultures. The character (Maria, Mexican-American) may
not practice smudging — this may conflate distinct cultural
traditions.

Suggestion: Research whether this aligns with the character's
specific cultural background. Consider consulting with someone
from the relevant tradition. If the character uses copal or
another culturally specific incense, that may be more accurate.

Author Decision: [ ] Keep as-is  [ ] Revise  [ ] Research more

──────────────────────────────────────

[FLAG H-2] Chapter 14, Page 201
Category: Representation Pattern
"James, the only Black character, dies protecting Elena in
the warehouse scene."

Issue: This follows the "sacrificial minority" trope where a
character of color dies to advance the white protagonist's
story arc.

Suggestion: Consider whether James's death serves HIS arc or
only Elena's. Could he survive? If the death is essential,
ensure James has his own complete character arc and motivations
beyond helping Elena.

Author Decision: [ ] Keep as-is  [ ] Revise  [ ] Research more

══════════════════════════════════════
MEDIUM FLAGS
══════════════════════════════════════

[FLAG M-1] through [FLAG M-7] ...
(Each with: location, category, quoted text, issue, suggestion)

══════════════════════════════════════
LOW / NOTES
══════════════════════════════════════

[NOTE L-1] through [NOTE L-5] ...
(Informational flags — not problems, just areas to be aware of)
```

## Review Modes

### Full Manuscript Review
- Scans entire manuscript
- Cross-references character descriptions and arcs
- Identifies patterns that only emerge across the full book
- Generates comprehensive report

### Chapter-by-Chapter
- Quick review of individual chapters
- Useful during drafting/revision
- Faster turnaround, focused feedback

### Character Audit
- Deep dive on a single character's representation
- Tracks how they're described, what they do, how others treat them
- Identifies if their arc relies on stereotypes
- Compares their depth/agency to other characters

### Dialogue Check
- Reviews all dialogue for a character or group
- Checks for authenticity vs. stereotype
- Flags dialect/accent writing issues
- Verifies terminology accuracy

## Smart Context

The tool understands nuance:
- A **villain** using offensive language may be intentional characterization
- **Period pieces** may contain historically accurate but offensive language
- **Own voices** work has different considerations than outside perspectives
- **Satire** may intentionally employ stereotypes to critique them

When flagging, it distinguishes between:
- 🔴 Likely unintentional and harmful
- 🟡 Intentional but may still land poorly with readers
- 🟢 Noted for awareness — probably fine in context

## Integration

- Works with **Book Bible** — uses character backgrounds for accurate flagging
- Works with **Voice Profile** — distinguishes author narration from character voice
- Works with **Ghostwriter Pro** — can review AI-generated scenes in real time

## Commands
- `sensitivity review` — Full manuscript sensitivity review
- `sensitivity check [chapter]` — Review a specific chapter
- `character audit [name]` — Deep representation audit of one character
- `dialogue check [character]` — Review all dialogue for a character
- `terminology check [term]` — Check if a specific term is current/appropriate
- `sensitivity report` — Generate formal report for editor/agent
