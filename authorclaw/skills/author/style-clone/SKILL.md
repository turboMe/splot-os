---
name: style-clone
description: Analyze and match the author's unique writing voice
author: AuthorClaw
version: 1.0.0
triggers:
  - "learn my style"
  - "match my voice"
  - "style check"
  - "voice profile"
  - "analyze my writing"
  - "sound like me"
permissions:
  - file:read
  - file:write
---

# Style Clone Skill

Analyze the author's writing to create a Voice Profile, then use it to match their style.

## Voice Analysis Categories

1. **Sentence Structure**: Average length, variation, complexity
2. **Vocabulary**: Level, favorite words, unique phrases, words avoided
3. **Paragraph Rhythm**: Length patterns, transition style, white space
4. **Narrative Distance**: Close/deep POV vs. distant, camera-like
5. **Dialogue Style**: Tag preferences, beats, subtext level
6. **Imagery**: Types of metaphors, sensory preferences, density
7. **Pacing**: Scene length, chapter hooks, tension techniques
8. **Humor**: Type (dry, slapstick, dark, witty), frequency
9. **Emotional Register**: How emotions are conveyed (body, thought, action)
10. **Signature Moves**: Unique patterns that define THIS author

## Analysis Process
1. Input: 5,000+ words of the author's writing (more = better)
2. Analyze each category above
3. Generate a Voice Profile saved to `workspace/soul/VOICE-PROFILE.md`
4. Use the profile for all future drafting and revision

## Style Check
When asked to check new text against the author's style:
1. Load the Voice Profile
2. Compare new text against each category
3. Report: ✅ matches, ⚠️ minor drift, ❌ significant departure
4. Offer specific suggestions (never rewrite without permission)

## Commands
- "Learn my style from [text/file]" — Create or update Voice Profile
- "Check this against my style" — Run consistency check
- "Show my voice profile" — Display current profile
