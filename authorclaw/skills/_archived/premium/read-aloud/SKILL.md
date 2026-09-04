---
name: read-aloud
description: Text-to-speech read-aloud for manuscripts using free open-source Piper TTS with natural-sounding voices
author: Writing Secrets
version: 1.0.0
triggers:
  - "read aloud"
  - "read this"
  - "speak"
  - "text to speech"
  - "tts"
  - "listen"
  - "audio preview"
  - "read chapter"
  - "hear it"
permissions:
  - file:read
  - file:write
  - system:exec
---

# Read Aloud — Premium Skill

Turn your manuscript into speech using free, open-source text-to-speech. Hear your prose the way a reader would — because the ear catches what the eye misses.

## Why Read Aloud?

Every professional editor will tell you: **read your work aloud.** It reveals:
- Awkward phrasing that looks fine on screen
- Sentences that are too long to speak in one breath
- Repeated words your eye skips but your ear catches
- Dialogue that sounds unnatural when spoken
- Pacing problems that only rhythm reveals
- Tongue-twisters and consonant clusters

This skill automates that process with natural-sounding AI voices.

## Engine: Piper TTS

AuthorClaw uses **Piper TTS** — a fast, free, open-source text-to-speech engine:
- **MIT licensed** — completely free, no API costs, no subscriptions
- **Runs locally** — your manuscript never leaves your machine
- **CPU-only** — no GPU required (works on any computer)
- **Natural voices** — neural network voices, not robotic
- **Fast** — generates audio faster than real-time
- **Offline** — works without internet

### Setup (One-Time)
```bash
# Install Piper (included in AuthorClaw setup wizard)
pip install piper-tts

# Download a voice model (~100MB each)
# AuthorClaw will prompt you to pick one on first use
```

### Available Voice Styles
- **en_US-lessac-medium** — Clear American narrator (recommended for fiction)
- **en_US-libritts-high** — High quality, natural cadence
- **en_GB-alba-medium** — British narrator
- **en_US-amy-medium** — Female American voice
- Multiple languages available for translated works

## Read Modes

### Chapter Read
Read an entire chapter from your project:
```
read chapter 7
```
- Generates audio file saved to `workspace/audio/`
- Plays through system audio
- Shows word-by-word highlighting in dashboard (if connected)

### Selection Read
Read a specific passage:
```
read aloud [paste or select text]
```
- Quick listen for a specific section
- Great for testing dialogue flow

### Dialogue Mode
Reads with distinct pausing for dialogue vs. narration:
- Slight pause before and after quoted speech
- Different cadence for dialogue vs. description
- Helps you hear if your dialogue sounds natural

### Revision Mode
Reads slowly with pauses between paragraphs:
- Gives you time to note issues
- Automatically marks the timestamp when you say "flag" or press a key
- Generates a revision note file with flagged locations

## Ear-Edit Workflow

A structured process for audio-based revision:

1. **Listen** — Read Aloud plays your chapter
2. **Flag** — Mark spots that sound wrong (keyboard shortcut or voice command)
3. **Review** — After playback, see all flagged locations with context
4. **Fix** — Edit each flagged passage
5. **Re-listen** — Hear just the fixed sections to verify

```
Ear-Edit Report: Chapter 7
───────────────────────────
Duration: 18:42
Flags: 6

Flag 1 — 02:14 (Paragraph 4)
"She walked through the door and walked across the room and sat down."
Issue: Triple action chain, repeated "walked"
Suggestion: Vary the verbs, combine actions

Flag 2 — 05:38 (Paragraph 11)
"The simultaneously spectacular and spectacularly simultaneous..."
Issue: Tongue-twister / consonant cluster
Suggestion: Simplify

[... remaining flags ...]
```

## Audio Export

Generate audio files from your manuscript:
- **WAV** — Uncompressed, highest quality
- **MP3** — Compressed, smaller files
- **Chapter-by-chapter** — Separate files per chapter
- **Full manuscript** — Single continuous audio file

Useful for:
- Sending audio versions to beta readers
- Creating audiobook demos
- Personal review while commuting/walking
- Accessibility for readers with visual impairments

## Integration

- **Voice Profile** — Adjusts reading speed and emphasis to match your genre
- **Ghostwriter Pro** — Read AI-generated scenes aloud immediately
- **Dictation Cleanup** — Listen to cleaned-up dictation to verify it sounds right
- **Book Bible** — Consistent pronunciation of character/location names

## Performance

- Generates ~10 minutes of audio per minute of processing (CPU)
- A full chapter (~4,000 words) takes ~30 seconds to generate
- Audio quality: Near-professional narration quality
- Storage: ~1MB per minute of audio (MP3)

## Commands
- `read aloud` — Read selected/pasted text
- `read chapter [number]` — Read a full chapter
- `read dialogue [chapter]` — Read with dialogue emphasis
- `ear edit [chapter]` — Start an ear-edit revision session
- `export audio [chapter/all]` — Generate audio files
- `set voice [voice-name]` — Change the TTS voice
- `list voices` — Show available voice models
- `read speed [slow/normal/fast]` — Adjust reading speed
