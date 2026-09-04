# Audio Design Rules · huashu-design

> The audio application recipe for all animation demos. Used together with `sfx-library.md` (the asset manifest).
> Battle-tested: the huashu-design launch hero v1-v9 iterations · Gemini deep-dive breakdowns of Anthropic's three official films · 8000+ A/B comparisons

---

## Core Principle · The Audio Dual-Track System (Iron Law)

Animation audio **must be designed independently in two layers** — you can't do just one:

| Layer | Role | Time scale | Relationship to visuals | Frequency band occupied |
|---|---|---|---|---|
| **SFX (beat layer)** | marks each visual beat | 0.2-2 seconds, short | **strong sync** (frame-level alignment) | **high frequency 800Hz+** |
| **BGM (ambient bed)** | emotional bedding, soundstage | continuous 20-60 seconds | weak sync (section-level) | **mid-low frequency <4kHz** |

**An animation with only BGM is crippled** — the audience subconsciously senses that "the picture is moving but there's no sound responding," and that's exactly where the cheap feeling comes from.

---

## Gold Standard · The Golden Ratio

These groups of numbers are **hard engineering parameters** derived from real measurements of Anthropic's three official films + our own v9 final-version comparison — apply them directly:

### Volume
- **BGM volume**: `0.40-0.50` (relative to full scale 1.0)
- **SFX volume**: `1.00`
- **Loudness difference**: BGM is **-6 to -8 dB lower** than the SFX peak (it's not the SFX's absolute loudness that makes it stand out, it's the loudness difference)
- **amix parameter**: `normalize=0` (never use normalize=1, it flattens the dynamic range)

### Frequency-band isolation (P1 hard optimization)
Anthropic's secret isn't "loud SFX," it's **frequency-band layering**:

```bash
[bgm_raw]lowpass=f=4000[bgm]      # BGM limited to the mid-low band below 4kHz
[sfx_raw]highpass=f=800[sfx]      # SFX pushed to the mid-high band of 800Hz+
[bgm][sfx]amix=inputs=2:duration=first:normalize=0[a]
```

Why: the human ear is most sensitive in the 2-5kHz range (i.e., the "presence band"). If the SFX is all in this range and the BGM also covers the full band, **the SFX gets masked by the high-frequency part of the BGM**. Use highpass to push the SFX up + lowpass to press the BGM down, so the two each occupy their own part of the spectrum, and SFX clarity jumps up a notch.

### Fade
- BGM in: `afade=in:st=0:d=0.3` (0.3s, avoids a hard cut)
- BGM out: `afade=out:st=N-1.5:d=1.5` (1.5s long tail, a sense of closure)
- SFX comes with its own envelope, needs no extra fade

---

## SFX Cue Design Rules

### Density (how many SFX per 10 seconds)
Real measurements of Anthropic's three films show three tiers of SFX density:

| Film | SFX per 10s | Product personality | Scenario |
|---|---|---|---|
| Artifacts (ref-1) | **~9 per 10s** | feature-dense, lots of information | complex tool demo |
| Code Desktop (ref-2) | **0** | pure ambient, meditative | developer-tool focus state |
| Word (ref-3) | **~4 per 10s** | balanced, office rhythm | productivity tool |

**Heuristic**:
- Product personality calm/focused → low SFX density (0-3 per 10s), BGM-led
- Product personality lively/information-rich → high SFX density (6-9 per 10s), SFX driving the rhythm
- **Don't fill every visual beat** — restraint is classier than density. **Deleting 30-50% of the cues makes the remaining ones more dramatic.**

### Cue selection priority
Not every visual beat needs an SFX. Select by this priority:

**P0 must-have** (omitting it feels off):
- Typing (terminal/input)
- Click/select (the user-decision moment)
- Focus shift (the visual protagonist transfers)
- Logo reveal (brand closure)

**P1 recommended**:
- Element entrance/exit (modal / card)
- Completion/success feedback
- AI generation start/end
- Major transition (scene switch)

**P2 optional** (too many gets messy):
- hover / focus-in
- progress tick
- decorative ambient

### Timestamp-alignment precision
- **Same-frame alignment** (0ms error): click/focus-shift/Logo landing
- **Lead by 1-2 frames** (-33ms): a fast whoosh (gives the audience psychological anticipation)
- **Trail by 1-2 frames** (+33ms): object landing/impact (matches real physics)

---

## BGM Selection Decision Tree

The huashu-design skill comes with 6 BGM tracks (`assets/bgm-*.mp3`):

```
What's the animation's personality?
├─ product launch / tech demo → bgm-tech.mp3 (minimal synth + piano)
├─ tutorial walkthrough / tool usage → bgm-tutorial.mp3 (warm, instructional)
├─ educational learning / principle explanation → bgm-educational.mp3 (curious, thoughtful)
├─ marketing ad / brand promotion → bgm-ad.mp3 (upbeat, promotional)
└─ a similar style needs a variant → bgm-*-alt.mp3 (each one's alternate version)
```

### Scenarios with no BGM (worth considering)
Reference Anthropic Code Desktop (ref-2): **0 SFX + pure Lo-fi BGM** can also be very classy.

**When to choose no BGM**:
- Animation duration <10s (BGM can't establish itself)
- Product personality is "focused/meditative"
- The scene itself has ambient sound / narration
- When SFX density is very high (to avoid auditory overload)

---

## Scene Recipes (Ready to Use)

### Recipe A · Product-launch hero (same as huashu-design v9)
```
Duration: 25 seconds
BGM: bgm-tech.mp3 · 45% · band <4kHz
SFX density: ~6 per 10s

cues:
  terminal typing → type × 4 (0.6s interval)
  enter           → enter
  cards converge  → card × 4 (staggered 0.2s)
  select          → click
  Ripple          → whoosh
  4 focus shifts  → focus × 4
  Logo            → thud (1.5s)

Volume: BGM 0.45 / SFX 1.0 · amix normalize=0
```

### Recipe B · Tool feature demo (reference Anthropic Code Desktop)
```
Duration: 30-45 seconds
BGM: bgm-tutorial.mp3 · 50%
SFX density: 0-2 per 10s (very few)

Strategy: let BGM + narration voiceover drive, SFX only at **decisive moments** (file save / command-execution completion)
```

### Recipe C · AI generation demo
```
Duration: 15-20 seconds
BGM: bgm-tech.mp3 or no BGM
SFX density: ~8 per 10s (high density)

cues:
  user input → type + enter
  AI starts processing → magic/ai-process (1.2s loop)
  generation complete → feedback/complete-done
  result reveal → magic/sparkle
  
Highlight: ai-process can loop 2-3 times across the entire generation process
```

### Recipe D · Pure-ambient long take (reference Artifacts)
```
Duration: 10-15 seconds
BGM: none
SFX: use 3-5 carefully designed cues on their own

Strategy: each SFX is the protagonist, no problem of BGM "smearing things together."
Suits: single-product slow-motion, close-up showcase
```

---

## ffmpeg Composition Templates

### Template 1 · Overlay a single SFX onto a video
```bash
ffmpeg -y -i video.mp4 -itsoffset 2.5 -i sfx.mp3 \
  -filter_complex "[0:a][1:a]amix=inputs=2:normalize=0[a]" \
  -map 0:v -map "[a]" output.mp4
```

### Template 2 · Multi-SFX timeline composition (aligned by cue time)
```bash
ffmpeg -y \
  -i sfx-type.mp3 -i sfx-enter.mp3 -i sfx-click.mp3 -i sfx-thud.mp3 \
  -filter_complex "\
[0:a]adelay=1100|1100[a0];\
[1:a]adelay=3200|3200[a1];\
[2:a]adelay=7000|7000[a2];\
[3:a]adelay=21800|21800[a3];\
[a0][a1][a2][a3]amix=inputs=4:duration=longest:normalize=0[mixed]" \
  -map "[mixed]" -t 25 sfx-track.mp3
```
**Key parameters**:
- `adelay=N|N`: the first is the left-channel delay (ms), the second is the right channel; write it twice to guarantee stereo alignment
- `normalize=0`: preserves the dynamic range, critical!
- `-t 25`: truncate to the specified duration

### Template 3 · Video + SFX track + BGM (with frequency-band isolation)
```bash
ffmpeg -y -i video.mp4 -i sfx-track.mp3 -i bgm.mp3 \
  -filter_complex "\
[2:a]atrim=0:25,afade=in:st=0:d=0.3,afade=out:st=23.5:d=1.5,\
     lowpass=f=4000,volume=0.45[bgm];\
[1:a]highpass=f=800,volume=1.0[sfx];\
[bgm][sfx]amix=inputs=2:duration=first:normalize=0[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k final.mp4
```

---

## Failure-Mode Quick Reference

| Symptom | Root cause | Fix |
|---|---|---|
| SFX can't be heard | the BGM high-frequency part masks it | add `lowpass=f=4000` to the BGM + `highpass=f=800` to the SFX |
| Sound effect too loud and harsh | the SFX absolute volume is too high | drop the SFX volume to 0.7, while lowering the BGM to 0.3, keeping the difference |
| BGM and SFX rhythm clash | the BGM was chosen wrong (used music with a strong beat) | switch to an ambient / minimal-synth BGM |
| BGM cuts off abruptly when the animation ends | no fade out was done | `afade=out:st=N-1.5:d=1.5` |
| SFX overlaps into a smear | cues too dense + each SFX too long | keep SFX duration within 0.5s, cue interval ≥ 0.2s |
| The WeChat-public-account mp4 has no sound | the public account sometimes mutes auto-play | don't worry, the user will get sound when they tap in; a gif has no sound to begin with |

---

## Coordination with Visuals (Advanced)

### The SFX timbre should match the visual style
- Warm-cream / paper-feel visuals → use **wooden / soft** SFX timbres (Morse, paper snap, soft click)
- Cold black-tech visuals → use **metallic / digital** SFX timbres (beep, pulse, glitch)
- Hand-drawn / childlike visuals → use **cartoon / exaggerated** SFX timbres (boing, pop, zap)

Our current `apple-gallery-showcase.md`'s warm-cream base color → pair with `keyboard/type.mp3` (mechanical) + `container/card-snap.mp3` (soft) + `impact/logo-reveal-v2.mp3` (cinematic bass)

### SFX can lead the visual rhythm
Advanced technique: **design the SFX timeline first, then adjust the visual animation to align to the SFX** (not the other way around).
Because each SFX cue is a "clock tick," fitting the visual animation to the SFX rhythm is very stable — conversely, having the SFX chase the visuals often feels off when it's ±1 frame out of alignment.

---

## Quality Checklist (self-check before release)

- [ ] Loudness difference: SFX peak - BGM peak = -6 to -8 dB?
- [ ] Frequency band: BGM lowpass 4kHz + SFX highpass 800Hz?
- [ ] amix normalize=0 (preserve dynamic range)?
- [ ] BGM fade-in 0.3s + fade-out 1.5s?
- [ ] Is the SFX count appropriate (pick density by scene personality)?
- [ ] Is each SFX same-frame aligned to its visual beat (within ±1 frame)?
- [ ] Is the Logo reveal sound effect long enough (1.5s recommended)?
- [ ] Listen once with BGM off: is the SFX alone rhythmic enough?
- [ ] Listen once with SFX off: does the BGM alone have emotional ebb and flow?

Either layer should be self-consistent when listened to on its own. If it only sounds good when both layers are stacked, it means it wasn't done well.

---

## References

- SFX asset manifest: `sfx-library.md`
- Visual style reference: `apple-gallery-showcase.md`
- Deep audio analysis of Anthropic's three films: AUDIO-BEST-PRACTICES.md (author's local material, not distributed with the repo)
- huashu-design v9 real-world case: hero-animation-v9-final.mp4 (author's local sample, not distributed with the repo)
