---
name: ghostwriter-pro
description: Advanced AI co-writing with scene generation, pacing analysis, tension mapping, and chapter assembly
author: Writing Secrets
version: 1.0.0
triggers:
  - "ghostwriter"
  - "co-write"
  - "write with me"
  - "generate scene"
  - "pacing analysis"
  - "tension map"
  - "assemble chapter"
  - "deep write"
permissions:
  - file:read
  - file:write
---

# Ghostwriter Pro — Premium Skill

Advanced AI co-writing tools that go far beyond basic drafting.

## Scene Generator

Generate complete scenes with cinematic precision:

### Input
```yaml
scene:
  chapter: 12
  pov_character: "Elena"
  location: "The Compound - Server Room"
  time: "2:47 AM"
  goal: "Elena needs to access the encrypted files before Marcus returns"
  conflict: "The security system is smarter than she expected"
  outcome: "She gets partial data but triggers a silent alarm"
  emotional_arc: "confident → frustrated → desperate → terrified"
  beats:
    - Elena picks the lock (confident, practiced)
    - First firewall falls easily (too easy?)
    - Second layer is military-grade (frustration)
    - She improvises a bypass (desperation, creativity)
    - Gets partial files downloading
    - Hears footsteps (terror)
    - Grabs what she has and runs
  sensory_focus: "cold server room, blue LED light, humming drives, her own heartbeat"
  plant_or_payoff: "Plant: the partial data will be crucial in Chapter 18"
```

### Output
- Full prose scene matching author's Voice Profile
- Word count matching genre expectations for this scene type
- Book Bible consistency verified before output
- Emotional beats hit in order
- Sensory details woven throughout

## Pacing Analyzer

Paste a chapter and get a visual pacing breakdown:

```
Chapter 12: "The Server Room"
Word Count: 3,847

Pacing Heatmap:
██████░░░░░░░░░░░░░░ ← Paragraphs 1-5: SLOW (setup/atmosphere)
░░░░████░░░░░░░░░░░░ ← Paragraphs 6-10: MEDIUM (first obstacle)
░░░░░░░░████████░░░░ ← Paragraphs 11-18: FAST (escalating tension)
░░░░░░░░░░░░░░░░████ ← Paragraphs 19-22: SPRINT (climax)
░░░░░░░░░░░░░░░░░░██ ← Paragraphs 23-24: COOL-DOWN (aftermath)

Avg Sentence Length by Section:
Setup:    ████████████████████ 22 words (long, atmospheric)
Rising:   ████████████ 14 words (tightening)
Climax:   ██████ 7 words (punchy, urgent)
Cooldown: ████████████████ 18 words (breathing room)

✅ Pacing verdict: Strong thriller pacing
⚠️ Suggestion: Cooldown might be too short — reader needs more breath
```

## Tension Mapper

Maps tension across an entire manuscript:

```
Tension Curve: "The Silent Hour"

Ch1  ▃▃▅▅▃                    Hook + Setup
Ch2  ▃▃▃▃▃                    Character building
Ch3  ▃▃▅▅▇                    Inciting incident
Ch4  ▅▅▅▃▃                    Processing + B-story
Ch5  ▅▅▇▇▅                    First major setback
Ch6  ▃▃▅▅▅                    ← ⚠️ SAG: Tension drops too long
Ch7  ▅▅▇▇▇                    Midpoint twist
Ch8  ▇▇▅▅▇                    Consequences cascade
Ch9  ▅▅▅▇▇                    All is lost
Ch10 ▃▃▃▅▅                    Dark night of the soul
Ch11 ▅▇▇▇█                    Climax build
Ch12 ████████                  CLIMAX
Ch13 ▅▃▃▃▃                    Resolution

Issues Found:
⚠️ Ch6: 4,200 words at low tension — consider cutting or adding complication
⚠️ Ch2→Ch3: Jump from 3 to 7 is jarring — add a bridge beat
✅ Midpoint (Ch7): Strong reversal
✅ Climax (Ch12): Excellent sustained tension
✅ Resolution: Appropriate length, doesn't drag
```

## Chapter Assembly Engine

Build chapters from individual scenes:

1. **Arrange scenes** — Drag-and-drop scene ordering
2. **Transition generator** — Smooth transitions between scenes
3. **Pacing check** — Verify the assembled chapter flows correctly
4. **Continuity scan** — Check against Book Bible
5. **Word count balance** — Flag chapters that are too long/short
6. **Export** — Clean chapter file saved to project

## Deep Write Mode

An intensive co-writing session where AuthorClaw:
1. Reviews the outline beat for this section
2. Loads all relevant Book Bible context
3. Applies the Voice Profile
4. Writes a complete draft
5. Self-critiques against the Style Guide
6. Revises automatically
7. Presents the polished draft with revision notes
8. Waits for author approval before saving

## Dialogue Polish Tool

Takes rough dialogue and refines it:
- Differentiate character voices based on Book Bible profiles
- Add subtext (what they mean vs. what they say)
- Insert action beats to replace dialogue tags
- Trim excess words (real people speak in fragments)
- Flag on-the-nose dialogue (characters saying exactly what they feel)

## Commands
- `generate scene [number]` — Create scene from outline beats
- `analyze pacing [chapter]` — Run pacing analysis
- `tension map` — Map tension across full manuscript
- `assemble chapter [number]` — Combine scenes into chapter
- `deep write [chapter/scene]` — Intensive co-writing mode
- `polish dialogue [chapter]` — Refine all dialogue in a chapter
