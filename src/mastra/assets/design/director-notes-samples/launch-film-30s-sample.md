# v5 · "Markdown is the new typewriter."

> Director's Notes for the **huashu-md-html v2.0** launch film
> 30 seconds · 1920×1080 · 25 fps · no voiceover
> Director: huashu-design (acting as Apple-tier launch film director)
> Composer: TBD (target: Max Richter / Ólafur Arnalds / Jóhann Jóhannsson minimal-cinematic register)
> Color base: ivory white #FAFAF6 · ink #1A1A1A · terracotta #C2410C
> Type: Newsreader (display + body) · JetBrains Mono (interface) · Noto Serif SC (Chinese)

---

## Table of Contents

- [Part I · Director's Statement](#part-i--directors-statement)
- [Part II · Visual System](#part-ii--visual-system)
- [Part III · Story Arc](#part-iii--story-arc)
- [Part IV · Shot-by-Shot Storyboard](#part-iv--shot-by-shot-storyboard)
- [Part V · Production Manifest](#part-v--production-manifest)

---

# Part I · Director's Statement

## 1.1 This Is Not a "Feature Walkthrough"

The overwhelming majority of SaaS upgrade videos make the same mistake — they treat the camera as a slide deck. Open → 6 features slide past → logo + slogan → done. Every second is "showing," not a single second is "telling." What the audience remembers when they leave is not the product, but "yet another page that looks like it was made by AI."

**This film must not do that.**

We want to tell a story. The story is just one line:

> **"md is the source code, everything else is product."**

This is not a slogan, it is a worldview. Markdown is not "a lightweight document format" — it is the wellspring of writing. Every downstream form (html, docx, pdf, epub) is a product derived from this same source. huashu-md-html v2.0 extends this product chain from 4 to 6 — but what gets extended is not the "feature list," it is **the radius of influence of the source**.

If the audience only remembers one thing after watching this film, I hope that one thing is: "Oh, md is actually the source code." However much of the feature list they remember is bonus.

## 1.2 The Contextual Dialogue of Visual Language

Every good promotional film is in dialogue with a set of predecessors. The context I want this film to converse with is:

**Apple — "Designed by Apple in California" (2013)**

That film is, in my mind, the ceiling for tech-company promotional films. Director Mark Romanek did three things right:
1. **Pure white background + serif type** — telling the audience this is "design about design," not a demo
2. **Slow cadence** — the subtitle of every line lags half a beat behind the audience's reading speed, forcing them to linger
3. **Jony Ive's voiceover is almost a whisper** — not a sales pitch, but a sharing

This film of ours **has no voiceover**, so the first two principles have to be amplified by typography and timing to 200%.

**Apple Silicon Launch Films (M1 / M2 / M3, 2020-2024)**

This series of shorts taught me **typography can dance too**. The three characters "M1" can disappear, then appear, then enlarge, then rotate, then explode into dust, then recompose — the audience watches a logo become the lead of a dance drama in 30 seconds.

**The hero of this film is not the product UI, it is the two characters `md.` + an orange period.** It has to become the lead of the dance drama in 30 seconds.

**Anthropic Brand Language (2024-2026)**

Anthropic turned "terracotta orange + serif + geometric abstraction" into the anti-slop template for AI companies. It told the industry: you can be a tech company, yet you can also look like a little philosophy book published by Penguin Classics.

We inherit this palette. But we have to do it **more restrained** — Anthropic occasionally uses pure terracotta orange as large color blocks; our terracotta orange is forever only an accent (occupying < 8% of the total frame area), with the remaining 92% left to ivory white and ink black.

**Penguin Classics (since 1947, after Romek Marber's 1961 grid)**

Penguin taught me **the courage of typography**. A book's cover can be large-point serif + a single black horizontal line + no illustration — and the reader will stop instead.

The slogan reveal at 25-29s borrows this language: **ONE SOURCE.** and **SIX FORMS.** are not "decorative text," they ARE the frame itself.

**Pentagram (Paula Scher / Michael Bierut)**

Pentagram's signature is **information architecture** — the distance between text and text, the distance between text and boundary, the point-size ratio between text hierarchies, none of it is "by intuition," it is mathematics.

Our grid system (Part II.3) comes from this tradition.

**Kenya Hara, *White* (2008)**

Hara wrote: "White is not a color, it is a sensibility." (白は色彩ではなく、感受性なのだ)

The true protagonist of this film is not `md.`, it is **the ivory white that surrounds it**. Every shot must leave at least 60% negative space. Negative space is not "not yet filled," it is the content itself.

**Massimo Vignelli — Modernism in design**

Vignelli's eight-word maxim: "If you can design one thing, you can design everything."

Our design system does not allow "add a font just for this shot" or "add a corner-radius value just for this shot." All 12 shots share the same set of 5 color values, 3 typefaces, and 4 easing curves.

## 1.3 Audience Profile

Three audience types, ranked by importance:

**Primary audience A · Existing huashu-md-html v1 users (~60% of traffic)**

They open the film to find out "what got upgraded." Our promise to them: within 30 seconds, you must clearly know —
- New capability 5: md → publication-grade PDF
- New capability 6: md → standard EPUB
- The visual quality of these two capabilities is higher than imagined (not "I could do this with wkhtmltopdf" tier)

→ Shot 08 and Shot 09, 3 seconds each, must have a "★ NEW" label + the destination card must show **visible, professional-grade details** like "printing-house crop marks" and "Apple Books frame" — so existing users instantly grasp "this isn't a filler feature, it was done properly."

**Secondary audience B · AI-Native creators who've heard of huashu-md-html but haven't used it (~25%)**

What they care about is "what does this skill have to do with me." Our promise to them: within 30 seconds, you must realize —
- When you write articles / do research / make whitepapers, **md should be your source of truth**
- 6 downstream formats, solved with one command

→ Shot 04 (any → md) should let them see PDF/DOCX/PPTX/XLSX/HTML all being absorbed by md — this is the visual concretization of "source thinking."

**Outer audience C · Designers / editors / publishers completely unfamiliar with it (~15%)**

What they see is a "beautiful tech short," and they won't necessarily follow up. Our promise to them: within 30 seconds, you must leave an impression —
- What this company makes **has the taste of a publishing house**
- It is unlike the AI tools you've seen in the past

→ The whole film's anti-AI-slop self-check (Part II.7) is done for them. Any purple gradient, emoji icon, or hand-drawn SVG figure — none of it appears.

## 1.4 Rhythm Philosophy

Apple's promotional film rhythm is not constant-speed. It is a curve of **slow beat — acceleration — peak — gentle resolution** (see the emotional curve diagram in Part III).

Specific to this film:

- **0-3s slow beat**: the audience enters. Typography breathes one character at a time.
- **3-6s first acceleration**: the md character is born, 6 file cards fly in one after another.
- **6-22s second acceleration stretch**: 6 capabilities in one breath, each held for 3 seconds without letting go.
- **22-26s peak**: the slogan double-line reveal, all chrome pulsing in sync.
- **26-30s gentle resolution**: the capability map slowly fades in, the last second left for the brand seal + an extremely faint piano reverb tail.

**Key decision**: The 22nd second is this film's climax (not the 29th). 29s is the resolution, 22s is the climax. Do not confuse the two.

## 1.5 What This Film Does **Not** Do (Anti-AI-Slop Self-Check)

Ranked by importance:

| Don't do | Reason |
|------|------|
| No purple gradient | The catch-all formula for "tech feel" in the training corpus; in 2026 it reads as cyber slop |
| No emoji as icons | The disease of "throw in an emoji when it's not professional enough" |
| No SVG figures / hands / abstract human forms | AI-drawn SVG figures always have misaligned features and uncanny proportions |
| No Inter/Roboto/Arial as display | Too common, clashes with system fonts |
| No cyber neon / dark blue background #0D1117 | The played-out copy of GitHub dark-mode aesthetics |
| No piling on effects (blur/glow/particle) | An effect that appears twice is decoration, three times is slop |
| No Lorem ipsum | Every piece of placeholder text uses genuinely readable content (including hooks like "md is the source. Anything else is product.") |
| No stock photo | The whole film contains no real photographs (it's about typography, not lifestyle) |
| No progress bar + timecode + copyright credit strip | These are player chrome, not content chrome — they'll clash with external players |
| Don't let the md character look the same in every scene | It must have 12 states across 12 shots, while keeping the same core glyph |

## 1.6 One-Line Positioning

> **"Markdown is the new typewriter."**
>
> A 30-second film about source-of-truth thinking, made for designers who write and writers who design.

---

# Part II · Visual System

## 2.1 Full Palette

Not 3 colors, but 10. Each color has a **functional definition** (not "use it because it looks nice").

```
Name            HEX        Role                                Max share of frame
─────────────────────────────────────────────────────────────────────
Ivory paper    #FAFAF6    Primary background (ivory white, a touch of warmth)  60-70%
Mist           #F2EDE4    Secondary background layer (faint dimming under card shadow)  < 15%
Mica           #E6E1D6    Hairlines / dividers / card borders   < 5%
Smoke          #6B6B6B    Secondary text / metadata             < 5%
Cinder         #3D3530    Secondary dark (deep brown-black, not pure black)  < 10%
Ink            #1A1A1A    Primary black / primary text          20-25%
Charred        #2A2620    Extreme deep brown-black (cover-card only)  < 5%
Terracotta     #C2410C    Primary accent (Anthropic tone)        5-8%
Terra Hot      #E55D21    Highlight variant (only the instant the NEW label lights up)  < 1%
Terra Deep     #8B2D08    Shadow variant (terracotta orange cast shadow)  < 1%
```

**Iron rules**:
- No shot shows any color outside the 10 above. **There is no "add a bit of cool gray just for this shot."**
- The terracotta family (Terracotta + variants), three colors combined, occupies < 10% of the frame, otherwise visual overload.
- Any text may only use one of 4 colors: Ink / Cinder / Smoke / Terracotta.

## 2.2 Type System

```
Size tier        Typeface              weight    Use                          Tracking (em)
────────────────────────────────────────────────────────────────────────────────────
Display XXL    Newsreader            700       slogan top line (200px)        -0.035
Display XL     Newsreader            700       capability number (48px)       -0.020
Display L      Newsreader            600       hero md character (300-480px)  -0.040
Display M      Newsreader            600       chapter title (32-44px)        -0.015
Body L         Newsreader            400       essay body (18-22px)            0
Body M (zh)    Noto Serif SC         500       Chinese sub-line (20-26px)     +0.04
Italic         Newsreader italic     400       quotations, subtitles          +0.01
Mono S         JetBrains Mono        500       labels / capability counter    +0.18
Mono XS        JetBrains Mono        700       NEW / version chip (11-14px)   +0.22
Caret          (block 3px wide)      —         typing cursor                  —
```

**Font loading strategy**:
- Google Fonts preconnect `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`
- A single `<link>` request merges all weights, reducing round-trips
- Before recording the MP4, `document.fonts.ready` must complete before the clock starts (the Stage already implements this)

## 2.3 Grid System

**Main canvas**: 1920 × 1080

**Outer margins (safe zone)**: 80px top/bottom/left/right

**Main content area**: 1760 × 920

**12-column grid**: column-width = 132px, gutter = 16px

**Baseline grid**: 8px base rhythm. All vertical positions must be multiples of 8 (unless there is a special visual reason).

**Golden-ratio anchors**:
- Upper 1/3 line: y = 360
- Lower 1/3 line: y = 720
- Center line: y = 540 (hero md default anchor)
- Golden ratio upper: y = 412
- Golden ratio lower: y = 668

**Key safe zones**:
- Within the top 60px: chrome element zone (capability counter, version chip)
- Within the bottom 60px: watermark / metadata zone
- The central 800×600 region: main-content no-go zone (every shot's hero element must land inside this region)

## 2.4 Animation System

**Easing library** (4 total, all others banned):

```
Name           Curve formula                       Use
──────────────────────────────────────────────────────────────────
expoOut       1 - 2^(-10t)                       default ease (90% of entrances use this)
overshoot     cubic-bezier(0.34, 1.56, 0.64, 1)  NEW label pop / button float-in
linear        t                                   base color fade / paper texture motion
expoIn        2^(10(t-1))                        exit ease (10% of exits use this)
```

**Duration dictionary**:

```
Event type                Duration      Notes
────────────────────────────────────────────────────────
character stagger         30-50ms       typing effect / slogan characters appearing in turn
small element entrance    300ms         file card / pill / chip
medium element entrance   500ms         destination card / capability number
hero element entrance     700-900ms     md character morph
slogan character entrance 800ms         "ONE SOURCE." as a whole
scene-to-scene transition 300ms overlap cross-dissolve + scale
exit                      200-300ms     exits are always faster than entrances
```

**Stagger law**:
- When multiple elements enter simultaneously, adjacent elements delay 30-80ms (not 0, and no more than 100ms)
- 6 pills entering: cumulative stagger 250ms (50ms each)
- slogan characters entering: cumulative stagger 280ms (~30ms each × 10 characters)

**Scene-to-scene transition**:
- Always a **cross-dissolve + soft scale** (never a hard cut)
- The previous shot, in its final 300ms: opacity 1 → 0, scale 1 → 0.96
- The next shot, in its first 300ms: opacity 0 → 1, scale 1.04 → 1
- The two shots overlap 300ms (on the timeline, the Sprite end is 0.3s greater than the next shot's start)

## 2.5 Chrome Elements (Throughout the Film)

These are the **small things that persist in the frame**, providing the feeling of "this is a complete film."

**Chrome A · top-left · capability counter (00-22s)**

```
   ┌─────────────┐
   │  ●  CAP·01  │     pulse dot (terracotta) + label
   │  ●●●●○○○○○  │     6-dot progress (filled = current)
   └─────────────┘
```

- Font: JetBrains Mono 12px, letter-spacing 0.24em
- Color: Ink for label, Terracotta for current dot, Mica for upcoming dots
- Animation: each scene switch, the next dot goes from hollow → filled (500ms expoOut)

**Chrome B · top-right · version chip (02-30s)**

```
   ╔═════════════════════════╗
   ║ ● HUASHU-MD-HTML · v2.0 ║
   ╚═════════════════════════╝
```

- Font: JetBrains Mono 13px Bold, letter-spacing 0.22em
- Color: Terracotta dot + Ink label
- Entrance: at 02s the whole thing fades in over 600ms
- pulse dot: an extremely faint breath every 4 seconds (opacity 1 → 0.6 → 1, 1500ms ease-in-out)

**Chrome C · bottom-center · timeline ticker (07-22s)**

```
   any→md  ━━━━●━━━━━━━━━━━━  md→html  ─  html→md  ─  md→docx  ─  md→pdf  ─  md→epub
```

- Font: JetBrains Mono 11px, letter-spacing 0.18em
- The current capability uses Terracotta + bold, the others use Smoke
- A single horizontal line connects the 6 names, the progress dot (●) slides from left to right over time
- Entrance: at 07s the whole strip fades in over 500ms

**Chrome D · bottom-right · watermark (persistent)**

```
   CREATED BY HUASHU-DESIGN
```

- Font: JetBrains Mono 10px, letter-spacing 0.24em
- Color: rgba(26,26,26,0.32)
- Completely static, no motion

**Chrome E · extremely faint paper texture (persistent)**

- SVG noise + an extremely slow 0.3% scale breath
- opacity ≤ 0.04
- Almost invisible during recording, but it lets the frame "breathe"

## 2.6 Audio System

### BGM Trajectory (30-second segmented curve)

```
intensity
 │                            ╱╲
1│                          ╱╱  ╲╲
 │                       ╱╱      ╲╲
 │                    ╱╱             ╲
 │                ╱╱                   ╲
 │            ╱╱                          ╲
 │       ╱╱                                  ╲
 │   ╱╱                                          ╲
0└──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴
   0  2  4  6  8 10 12 14 16 18 20 22 24 26 28 30s
   │  │     │              │           │  │
   entry│  strings in│   rhythmic pulse added │ peak │  decay
      piano                              swell
```

**Layers (each layer persists 30 seconds, intensity changes controlled by envelope)**:

- **L0 · Room tone** (00-30s): extremely faint background noise, giving the frame a "not dead-silent" breath
- **L1 · Piano single note** (00-08s): a single piano note struck continuously, once every 1.2 seconds, slowly accumulating
- **L2 · Piano arpeggio** (03-22s): the piano arpeggio enters, giving a "picking up rhythm" feel
- **L3 · Cello drone** (08-22s): low-frequency strings underlay, giving "weight"
- **L4 · Pulse** (15-22s): an extremely faint sub-kick, 4/4 rhythm (not a dance beat, a cinematic pulse)
- **L5 · String swell** (22-26s): the full string section swells up to the climax
- **L6 · Decay + reverb tail** (26-30s): all layers decay, leaving piano + reverb

**Style target**: Max Richter's *On the Nature of Daylight* + Ólafur Arnalds's *Re:member* + Jóhann Jóhannsson's *Orphée*

### SFX Dictionary

```
Cue                          Time        Type               Volume
────────────────────────────────────────────────────────────────────
keyboard click               00.5-02.0   keypress × 12     -18dB (30ms each)
cursor blink                 02.0-02.8   subtle tick        -28dB
md morph swell               02.8-03.2   soft whoosh + bloom -16dB
file card whoosh × 6         05.5-08.0   short whoosh       -20dB (200ms each)
absorb / ink drop             08.0-08.4   "absorb" splash    -16dB
paper rustle                 08.5-09.0   paper turn         -22dB
chime: capability 02 →        09.0       single chime tone  -18dB
chime: capability 03 →        12.0       single chime tone  -18dB
chime: capability 04 →        15.0       single chime tone  -18dB
chime: NEW (05)               18.0       double chime + glow -14dB
chime: NEW (06)               21.0       double chime + glow -14dB
build sweep                  22.0-22.6   ascending sweep    -10dB
impact (slogan ONE)          22.6        deep impact         -8dB
impact (slogan SIX)          23.4        deep impact         -8dB
pen flourish                 24.0-24.4   pen on paper        -22dB
final stamp / sign-off       29.0-29.5   ink stamp           -14dB
```

**SFX band isolation** (to prevent fighting each other):
- BGM occupies the low band (40Hz-2kHz)
- SFX whooshes / chimes occupy the mid-high band (2kHz-8kHz)
- SFX impacts occupy the low sub band (40Hz-120Hz) — overlapping with the BGM cello, but the BGM simultaneously ducks -3dB

## 2.7 Anti-AI-Slop Self-Check Table (per-shot)

Before execution, every shot must pass this checklist:

```
□  No purple (any saturation)
□  No combination of rounded card + left-border accent (except the destination card's honest mica border)
□  No emoji as icon
□  No SVG-drawn figures / abstract human forms
□  No color not in the Part II.1 palette
□  No Inter / Roboto / Arial as display
□  Tracking, line-height, point size all come from the Part II.2 type system (no values added "by feel")
□  Vertical position is a multiple of 8 (except for a deliberate visual reason)
□  Terracotta orange occupies < 10% of the frame in this shot
□  This shot has at least one detail "worth a screenshot when paused" (the 120% signature)
□  The transition from the previous shot to this one is a cross-dissolve + scale, not a hard cut
□  At the end of this shot, the frame has made visual "room" for the next shot (not "filled to the very last")
```

---

# Part III · Story Arc

## 3.1 Three-Act Structure

**ACT I · SET-UP (00.0 — 06.0s)**

The audience enters the frame. The question is posed: what is the source of truth?

- SHOT 01 (0.0-1.5s) · BLANK PAGE
- SHOT 02 (1.5-3.0s) · THE CURSOR
- SHOT 03 (3.0-5.0s) · THE TRANSFORMATION
- SHOT 04 (5.0-6.0s) · entering the gathering (overlaps with ACT II)

**ACT II · ESCALATION (06.0 — 22.0s)**

The answer unfolds: md is the source. It radiates 6 product chains outward.

- SHOT 04 (5.0-8.5s) · GATHERING (any → md)
- SHOT 05 (8.5-11.5s) · FIRST FLOWER (md → html)
- SHOT 06 (11.5-14.5s) · REVERSE FLOW (html → md)
- SHOT 07 (14.5-17.5s) · PUBLISHER GRADE (md → docx)
- SHOT 08 (17.5-20.5s) · ★ NEW · PRINT (md → pdf)
- SHOT 09 (20.5-22.5s) · ★ NEW · EBOOK (md → epub, overlaps ACT III by 0.5s)

**ACT III · PAYOFF (22.5 — 30.0s)**

The theme is elevated. The slogan appears. The brand seal.

- SHOT 10 (22.5-24.0s) · THE CONVERGENCE
- SHOT 11 (24.0-26.5s) · ONE SOURCE.
- SHOT 12 (26.5-29.0s) · SIX FORMS.
- SHOT 13 (29.0-30.0s) · SIGN-OFF

## 3.2 Emotional Curve

```
emotional intensity
 │                                       ╔═══╗
 │                                    ╔══╝   ╚══╗
 │                              ╔═════╝         ╚══╗
 │                          ╔═══╝                   ╚══╗
 │                       ╔══╝                          ╚══╗
 │                   ╔═══╝                                 ╚════════╗
 │             ╔═════╝                                              ╚══╗
 │       ╔═════╝                                                       ╚══
 │  ╔════╝
 │══╝
 0──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──>
    0     2     4     6     8    10    12    14    16    18    20    22    24    26    28    30s
    │     │     │            │           │            │            │     │     │
    blank cursor morph      gather       cap 02-04   cap 05/06 ★  slogan slogan sign-off
                                                                  ONE   SIX
                                                                  ──────►
                                                                  PEAK 24.5s
```

**Key emotional beats**:
- **02.0s**: the first keyboard click → the audience enters
- **03.0s**: the md character is born → the first "awe"
- **08.0s**: 6 file cards gather into md → the first "ah, so md is the source" click
- **18.0s**: the first NEW label appears → existing users go "oh"
- **22.5s**: all chrome converges, ready to enter Act III → tension build-up peak
- **24.5s**: SIX FORMS. lands → emotional climax
- **30.0s**: the md seal rests quietly → resolution

---

# Part IV · Shot-by-Shot Storyboard

The format of each shot:

```
SHOT NN · NAME
[TIMECODE]  |  FUNCTION
[VISUAL]     frame composition
[TYPE]       precise typography spec
[ANIM]       per-element in/out/easing/delay
[AUDIO]      music beat + SFX cue
[CHROME]     four-corner element state
[ANTI-SLOP]  the self-check items passed
[WHY]        carry-over + advance
```

---

## SHOT 01 · "BLANK PAGE"

**[TIMECODE]** 00.00 — 01.50s (1.5s) `|` **FUNCTION** Opening. Draw the audience in. Give "emptiness" a span of time.

**[VISUAL]**

The entire 1920×1080 is Ivory paper #FAFAF6. **There is nothing in the frame.**

The only presence: a layer of extremely faint paper texture (SVG noise + 0.3% scale extremely-slow breath), almost invisible, but lending the frame the subconscious sense that "this is a real sheet of paper."

Composition: completely empty. This is "white" in the Kenya Hara sense — not "not yet drawn," but "the content itself."

**[TYPE]** No text.

**[ANIM]**

- 0.00s · paper texture opacity goes from 0 → 0.04 (500ms linear)
- 0.50-1.50s · the whole frame holds, no motion. Let the audience's eyes adapt to this white.
- 1.40-1.50s · slightly left of center (x=860, y=540) a cursor position begins to surface (transparent, only revealed in the next shot)

**[AUDIO]**

- BGM: room tone enters (300ms fade-in to -38dB)
- SFX: none

**[CHROME]** All hidden. Chrome A/B/C/D/E are not yet revealed.

**[ANTI-SLOP]**

- ✅ No logo, no "Loading...", no brand preamble of any kind
- ✅ No gradient, no effects
- ✅ This shot's "pause-and-look" signature: the frame has texture (paper texture) but never steals the show

**[WHY]**

Apple's "Designed by Apple in California" opens this way too — giving emptiness a span of time. It tells the audience "this film needs you to slow down." If you pile on logo and chrome from the opening, the audience's attention is scattered, and you can't reel it back for the next 30 seconds.

These 1.5 seconds are one of the most important 1.5 seconds in this film.

---

## SHOT 02 · "THE CURSOR"

**[TIMECODE]** 01.50 — 03.00s (1.5s) `|` **FUNCTION** The typewriter is born. The first content.

**[VISUAL]**

Slightly left of center (x=860, y=540), a vertical black block (3px × 56px, Ink #1A1A1A) begins to blink. This is the cursor.

After blinking twice (0.7s per cycle × 2), the characters `# markdown.md` begin to appear one at a time behind the cursor, font JetBrains Mono 56px, color Ink #1A1A1A, letter-spacing -0.01em.

Each character typed plays one keyboard click. After the last character is typed (13 characters total), the cursor keeps blinking once after the `.md`.

**[TYPE]**

- Text: `# markdown.md`
- Font: JetBrains Mono 500 weight
- Size: 56px
- Color: Ink #1A1A1A
- Letter-spacing: -0.01em
- Position: horizontal center, y = 540 (baseline, the text's vertical center is slightly below this)

**[ANIM]**

- 01.50s · cursor block opacity 0 → 1 (200ms)
- 01.50-01.85s · cursor blink first time (off 200ms / on 200ms)
- 01.85-02.20s · cursor blink second time
- 02.20-02.85s · 13 characters appear staggered, 50ms apart each (completing over 650ms), each character its own fade + 1px slide-down (180ms expoOut)
- 02.85-03.00s · the cursor blinks once more at the end (the last time, signaling input complete)

**[AUDIO]**

- BGM: piano first note struck at 01.50s (-22dB)
- SFX: keyboard click × 13 (once per character, -18dB, 30ms each)
- SFX: 200ms silence after the final cursor blink (making room for the next shot's morph)

**[CHROME]** Still hidden.

**[ANTI-SLOP]**

- ✅ The cursor is not a sci-fi flicker (not a 0.1s ultra-fast blink), it is a faithful simulation of the macOS terminal cursor cadence
- ✅ Typing is not "characters appearing all at once," it is genuinely rhythmic typing
- ✅ The font is JetBrains Mono, not a system-default mono like Courier or Menlo
- ✅ pause-and-look signature: the cursor's 3px width (not 2px or 4px) — a very precise detail that those in the know will notice as "designed from a real terminal"

**[WHY]**

This shot is the core of the setup: **markdown is not a noun, it is an action** — it is the very act of "striking keys to turn characters into structure."

The cursor is the smallest unit of writing. To begin from a single cursor is the birth of "source code."

The next shot's morph is built on the premise that the audience has already accepted "we are writing markdown."

---

## SHOT 03 · "THE TRANSFORMATION"

**[TIMECODE]** 03.00 — 05.00s (2.0s) `|` **FUNCTION** Reveal the hero. `# markdown.md` morphs into the hero `md.`

**[VISUAL]**

At 03.00s: `# markdown.md` (56px mono) begins to converge toward center, enlarge, and transform.

**The morph process** (detailed breakdown):

- 03.00-03.30s (300ms): the `#` and the `arkdown` part of `# markdown.md` fade out (opacity 1 → 0), while the `m` and the `md` of `d.md` remain.
- 03.30-04.10s (800ms): the remaining `md` morphs from mono font to Newsreader serif, enlarges from 56px to 480px, and shifts from Ink to Ink (no color change), position unchanged (still center frame).
- 04.10-04.80s (700ms): at the lower-right corner of the `md` characters, a Terracotta period `.` surfaces (fade-in + scale 0.6 → 1 + overshoot easing).
- 04.80-05.00s (200ms): the period officially settles, the hero is complete. 30px below appears a 320px-wide terracotta hairline (terracotta accent rule, 2px thick), expanding from center outward to both ends.

**End frame**: `md.` (Newsreader 600 weight, 480px, Ink with Terracotta dot) + a terracotta hairline below. Everything else in the frame is empty.

**[TYPE]**

- Text: `md.` (`md` Ink, `.` Terracotta)
- Font: Newsreader 600 weight
- Size: 480px (display L)
- Letter-spacing: -0.04em
- Color: `m`+`d` Ink #1A1A1A, `.` Terracotta #C2410C
- Centered horizontally and vertically on the hero center line (y = 540)
- accent rule 30px below, width 320px (grown from 0)

**[ANIM]**

- 03.00-03.30s · `#` `arkdown` `md` (the middle segment) fade out (opacity 1 → 0, expoOut)
- 03.30-04.10s · `md` morph: fontFamily switch, fontSize from 56 → 480, weight from 500 → 600 (800ms expoOut; note the morph is not an abrupt switch, but a ghost-residual overlay + scale up + opacity switch)
- 04.10-04.80s · `.` enters (700ms overshoot, scale 0.6 → 1)
- 04.80-05.00s · accent rule width 0 → 320px (300ms expoOut)

**[AUDIO]**

- BGM: piano second note at 03.00s (-20dB), third note at 04.20s (-18dB) — piano accumulating
- SFX: 03.00-03.20s soft whoosh (as the morph begins, -16dB)
- SFX: 04.10s subtle bloom (the instant the period appears, -20dB)
- SFX: 04.80s short paper rustle (the accent rule expanding, -22dB)

**[CHROME]**

- 04.50s · Chrome B (version chip top-right) begins to surface (fade-in 600ms)
  - Form: `● HUASHU-MD-HTML · v2.0`
  - terracotta dot, mono text, Ink color
  - Entry position: top: 78px, right: 80px
- Still hidden: Chrome A, C, E (visible only ≥ 06s)

**[ANTI-SLOP]**

- ✅ The morph is not a cheap "fade-out + fade-in" transition, it is a genuine character transformation (with ghost-residual overlay)
- ✅ The period is the hero's "signature detail" (the one done at 120%): the Terracotta period is as small as a fingernail, but it is this film's visual anchor, and **this period is preserved as the hero identifier in all subsequent shots**
- ✅ The accent rule is not decoration, it is the hero's base line — it reappears at the Shot 11 slogan, establishing a head-to-tail echo
- ✅ pause-and-look signature: the -0.04em tracking of the 480px Newsreader 'md' makes the m and d nearly touch but not contact — this is the signature texture of the Newsreader typeface at large point sizes

**[WHY]**

This is the hero shot. The "protagonist" of the entire film for the next 25 seconds (`md.`) is born here.

The design philosophy of the morph: **going from mono to serif is the metaphor of going from "I am typing" to "I am writing."** Mono is the typewriter, serif is publishing. md is both at once — it is struck on the keyboard, but it is the source code of publishing.

The next shot enters ACT II; the hero has already taken its stance — it will be pushed to the upper part of the frame, making room for the "materialized products."

---

## SHOT 04 · "GATHERING" (any → md)

**[TIMECODE]** 05.00 — 08.50s (3.5s) `|` **FUNCTION** CAPABILITY 01 reveal. Everything → md. Establish the worldview that "md is the source."

**[VISUAL]**

05.00s: the hero `md.` slides up from the frame center (y=540) to y=280 (i.e. the 1/4-height position), shrinking to 220px at the same time.

Then in the lower half of the frame (the y=520 ~ y=900 region), 6 file cards appear, flying in order from off-frame (below, y=1140), converging toward the md hero along an invisible parabolic trajectory.

The design of the 6 cards (**each is a real-file-type mini demo, not fake bar lines**):

```
.pdf   │ two-column layout + header "doc.pdf" + page number "— 12 —" + a few lines of real typeset small text
.docx  │ heading "On Markdown" + italic subtitle + 6 lines of paragraph ascii
.pptx  │ title "MD AS SOURCE" + a simplified bar-chart placeholder
.xlsx  │ a 6×4 spreadsheet grid + some numbers
.epub  │ an Apple Books-style page + chapter title "Chapter 01"
.html  │ a browser chrome (three dots + URL bar "example.com") + title + paragraph
```

Each card is 130×180px, white ground + Mica border + 24° top-right corner fold.

**Flight trajectory**: departing from below at y=1140, converging along a parabola toward the md hero's "." position (about x=960+50, y=280+90). At the midpoint (when in the middle of the frame), the 6 cards arrange in a fan, 220px between each adjacent pair. Finally all 6 are "absorbed" by md (scale 1 → 0.5 + opacity 1 → 0, while position converges to a point).

Absorption timing: starting at 05.60s, one launches every 0.18s. Each is absorbed after 1.1s of flight. The last one finishes absorbing at about 07.60s.

After absorption completes (07.60-08.20s), 60px below appears the tagline: "everything → md" (Chinese serif, 36px, Ink, italic)

08.20-08.50s · overall hold, preparing to enter Shot 05.

**[TYPE]**

- hero `md.`: shrunk to 220px (same font spec as SHOT 03)
- 6 cards' interior typesetting: JetBrains Mono 12-14px for labels, Newsreader 12-16px for content
- tagline "everything → md": Noto Serif SC 36px italic + the central → is Newsreader italic + Terracotta
- top Chrome A text: JetBrains Mono 12px

**[ANIM]**

- 05.00-05.30s · hero md scale + move up (300ms expoOut)
- 05.30s · Chrome A capability counter enters (CAPABILITY · 01 shown, first dot filled)
- 05.60-07.60s · 6 cards launch in turn (each launch delay = 5.60 + i × 0.18s, flight 1.1s, absorb at launch+1.1)
- 07.60-08.20s · tagline "everything → md" enters (fade-in 400ms + slight y slide 12px → 0)
- 08.20-08.50s · hold

**[AUDIO]**

- BGM: piano arpeggio L2 enters at 05.00s (-26dB → -20dB fade-in)
- SFX: file card whoosh × 6 (once per card launch, 200ms each, -20dB)
- SFX: absorb / ink drop (as the last card is absorbed, -16dB)
- SFX: paper rustle (as the tagline enters, -22dB)

**[CHROME]**

- A (top-left capability counter): ON, showing `CAPABILITY · 01`, first dot filled
- B (version chip): ON, persistently shown
- C (timeline ticker): OFF (will enter in SHOT 05)
- D (watermark): ON, always ON
- E (paper texture): ON

**[ANTI-SLOP]**

- ✅ The 6 cards are neither emoji nor icons, they are **mini demos with interior content** — each is readable
- ✅ The flight trajectory is a parabola (sense of gravity), not a straight line (computer feel)
- ✅ The convergence is "absorption" (scale + position converging together), not "stacking"
- ✅ No glow or particle effects given to the md character (no need to explain "md is absorbing," the audience gets it on their own)
- ✅ pause-and-look signature: pause on any card mid-flight and you can read "this is a PDF / this is a DOCX" — that is the 120% detail
- ✅ The tagline uses "→" rather than "to" or "至," which is markdown's own character

**[WHY]**

This is the opening shot of ACT II. If the audience finishes these 3.5 seconds without realizing "oh, md is the source," the later shots are wasted.

The 3.5 seconds contain 3 micro-narrative beats:
1. the hero makes room (md moves up) — implying "I yield to my products"
2. the 6 products appear — revealing "the things I can take in"
3. all return to md — "but in the end they are all md"

The next shot enters the forward flow of md → html — the audience has already accepted "md is the source," now they are ready to see "how md transforms."

---

## SHOT 05 · "FIRST FLOWER · HTML" (md → html)

**[TIMECODE]** 08.50 — 11.50s (3.0s) `|` **FUNCTION** CAPABILITY 02. The first forward output. Establish the ScenePipeline pattern (shared by the following 5 shots).

**[VISUAL]**

08.50s: the hero `md.` slides from the upper-center position to the left side of the frame (x=480, y=540), keeping its size at 220px.

At the same time, on the right side of the frame (x=1400, y=540), a destination card appears: simulating a "Tufte CSS-style essay html."

destination card design (**real readable content, not bar lines**):

```
┌─────────────────────────────────┐
│                                  │
│  On Markdown                     │  ← Newsreader 600, 32px, Ink
│  AN ESSAY · 2026                 │  ← Mono 11px, 0.18em, Smoke
│  ▬▬▬                             │  ← Terracotta rule 60×3px
│                                  │
│  md is the source of truth.      │  ← Newsreader 400, 18px, line-height 1.7
│  Anything else is product.       │
│  We write once. Publish six      │
│  ways. The river forks; the      │
│  spring stays the same.          │
│                                  │
│  ─ huashu, 2026.05.11            │  ← italic 14px, Smoke
│                                  │
│  article.html · TUFTE THEME      │  ← Mono 10px, 0.18em, Smoke (bottom)
└─────────────────────────────────┘
   480px wide × 560px tall
   white ground + Mica border + 24° corner fold
```

The md characters and the destination card are connected by a terracotta hairline, departing from md's dot, growing rightward 380px, the arrow head reaching the card's left boundary. 30px above the line shows the label "md → html" (JetBrains Mono 14px Terracotta, letter-spacing 0.14em).

At 09.80s: Chrome C (timeline ticker) enters for the first time, fixed at y=1000.

**[TYPE]**

- See the inline visual description
- label "md → html" size 14px, Mono Bold, Terracotta, letter-spacing 0.14em
- destination card top chapter title is Newsreader 600, 32px, Ink
- destination card bottom small seal mono 10px Smoke 0.18em

**[ANIM]**

- 08.50-08.80s · hero md slides from center-top to left-mid (300ms expoOut)
- 08.80-09.10s · arrow line grows rightward from md.dot origin (300ms expoOut, 0 → 380px)
- 09.10s · arrow head surfaces (200ms overshoot)
- 09.20-09.40s · label "md → html" enters (fade-in + 8px y slide-down, 300ms expoOut)
- 09.40-10.10s · destination card enters as a whole (700ms expoOut, scale 0.85 → 1 + opacity 0 → 1)
- 10.10-10.80s · destination card interior staggered entrance: title (400ms delay 0) → subtitle metadata (delay 200ms) → terracotta rule (delay 400ms) → 6 body lines (each delay 60ms cascade) → signature (delay 1000ms) → bottom mono (delay 1100ms)
- 10.80-11.50s · hold + micro-breath (overall scale 1 → 1.005 → 1, 600ms ease-in-out infinite, but this shot plays only half a cycle)

**[AUDIO]**

- BGM: cello drone L3 enters at 09.00s (-30dB → -24dB)
- SFX: chime: capability 02 at 09.00s (-18dB)
- SFX: paper rustle (as the card enters, -22dB)
- SFX: micro ticks (as each text line enters staggered, -26dB each)

**[CHROME]**

- A: advances to `CAPABILITY · 02`, second dot filled
- B: ON
- **C: enters for the first time** at 09.80s, `any→md  ━━━━●━━━━━  md→html  ─  html→md  ─  md→docx  ─  md→pdf  ─  md→epub`, the progress dot ● sits above the second slot
- D: ON
- E: ON

**[ANTI-SLOP]**

- ✅ The destination card's "On Markdown" essay content is genuinely readable English philosophical prose, not Lorem ipsum
- ✅ The "article.html · TUFTE THEME" small seal is a "detail signature readable when paused"
- ✅ No glow or particle used to "emphasize" the md → html conversion — typography and composition tell it themselves
- ✅ The arrow line is not dashed or dotted (avoiding a "web tutorial" feel), it is a 1.5px solid Terracotta line
- ✅ pause-and-look signature: the destination card top's "AN ESSAY · 2026" subtitle uses Newsreader's small caps OpenType feature, 0.18em tracking — that is this shot's 120% detail

**[WHY]**

This is the first establishment of the ScenePipeline pattern. The following 5 capability shots all advance by this structure:
1. md on the left, destination on the right
2. arrow + label in the middle
3. destination card interior staggered entrance (each card has 6-8 text hierarchies)
4. card content is genuinely readable, not fake bar lines

The audience understands this pattern by the second time (SHOT 06), and by the sixth time (SHOT 09) gets the feeling of "ah, here it comes again, but this time it's NEW" — which is exactly the rhythm design of ACT II.

---

## SHOT 06 · "REVERSE FLOW · MD" (html → md)

**[TIMECODE]** 11.50 — 14.50s (3.0s) `|` **FUNCTION** CAPABILITY 03. Reverse archiving: html → md. Establish the "bidirectional flow" concept.

**[VISUAL]**

Enter via cross-dissolve. The previous shot's destination card shrinks and exits to the lower-right corner within 11.50-11.80s, and a new destination card (this time showing markdown source code) enters from the right.

New destination card design: **dark-ground markdown source view** (forming a visual contrast with SHOT 05's light-ground html).

```
┌─────────────────────────────────┐
│                                  │  ← background Charred #2A2620
│  # On Markdown                   │  ← Terracotta, mono 14px
│                                  │
│  An essay · 2026                 │  ← Smoke, mono 14px
│                                  │
│  > md is the source.             │  ← italic Smoke, mono 14px
│  > Anything else is **product**. │     `**product**` highlighted mica + bold
│                                  │
│  - 1 source                      │  ← mono 14px Smoke
│  - 6 forms                       │
│  - ∞ outputs                     │
│                                  │
│  essay.md · CLEAN MARKDOWN       │  ← bottom Mono 10px Smoke
└─────────────────────────────────┘
   480×560px, Charred ground, the top 24° corner fold is Cinder
```

arrow direction reversed: from the right destination card toward the left md character (short Terracotta line + arrow head pointing left). The label changes to "html → md".

**Key differences** (forming a visual rhyme with SHOT 05):
- destination on the right, md on the left (same as SHOT 05)
- but the arrow direction is reversed (visual: we are archiving / pulling back)
- the card is dark-ground (visual contrast, emphasizing this is the source)

**[TYPE]**

- The whole card interior is JetBrains Mono 14px
- markdown syntax element colors: `#` heading Terracotta, `>` quote italic Smoke, `**bold**` Mica + bold, list dash Smoke
- bottom mono 10px Smoke

**[ANIM]**

- 11.50-11.80s · the previous shot's card exits (shrink → lower-right corner, fade out) + md character holds
- 11.80-12.10s · arrow line grows in reverse (this time right to left, 300ms expoOut)
- 12.10s · arrow head (pointing left) surfaces
- 12.20-12.40s · label "html → md" enters
- 12.40-13.10s · new destination card enters (same entrance logic as SHOT 05)
- 13.10-13.80s · the markdown interior's 6 lines enter staggered (each line 100ms delay)
  - special micro-detail: as each line enters, it simulates a typewriter — character-by-character cascade reveal of the line (making the audience feel "this is the process of markdown being 'written out'")
- 13.80-14.50s · hold

**[AUDIO]**

- BGM: persisting L1+L2+L3 layers
- SFX: chime: capability 03 at 12.00s (-18dB)
- SFX: paper rustle (12.40s)
- SFX: as each line enters, an extremely faint keyboard click ticker (-26dB each, 100ms apart)

**[CHROME]**

- A: advances to `CAPABILITY · 03`, third dot filled
- B: ON
- C: progress dot ● slides to the "html→md" position
- D: ON
- E: ON

**[ANTI-SLOP]**

- ✅ This is the only "dark-ground" shot in the whole film — a deliberate visual contrast, letting the audience know "this is source code," not "yet another destination"
- ✅ The markdown interior syntax highlighting uses colors that are not cyber palette (not the VS Code Dark+ kind), but a publishing-house palette (Terracotta + Smoke + Mica)
- ✅ The "essay.md · CLEAN MARKDOWN" bottom small seal → pause-and-look signature
- ✅ The reverse arrow is not a "U-turn curve," it is a straight line + reversed arrow head — maintaining structural consistency

**[WHY]**

The true purpose of this shot is not "showing off capability 03," it is **telling the audience this pipeline is bidirectional.**

If all 6 capabilities in the film radiated outward from md, the audience would think "md only goes out." Making the 3rd capability flow in reverse establishes the worldview that "md is the hub of everything."

This is why I chose the capability order 02 (md→html) → 03 (html→md) → 04 (md→docx) — deliberately wedging the reverse capability into the 3rd slot to maximize the cognitive surprise of "bidirectional flow."

---

## SHOT 07 · "PUBLISHER GRADE · DOCX" (md → docx)

**[TIMECODE]** 14.50 — 17.50s (3.0s) `|` **FUNCTION** CAPABILITY 04. Publishing-house taste docx. Establish the argument that "md is not just for programmers."

**[VISUAL]**

Return to light-ground, return to "md on the left, destination on the right."

destination card design: **a publishing-house-grade docx chapter opening page** (high information density, but completely restrained).

```
┌─────────────────────────────────┐
│                       ON MARKDOWN│  ← page header, right-aligned, Smoke italic mono 9px
│  CHAPTER · 01                    │  ← Terracotta mono 11px bold 0.22em
│                                  │
│  On Markdown                     │  ← Newsreader 700, 36px, Ink, lh 1.1
│  A short essay on source-of-truth│  ← Newsreader italic 14px, Smoke
│  thinking                        │
│                                  │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━     │  ← Terracotta full-width rule 3px
│                                  │
│  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬       │  ← 10 lines of mica bar paragraphs
│  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬           │     (varied widths 76-95%)
│  ...                             │
│                                  │
│                — 1 —             │  ← page number, centered, mono 10px Smoke
└─────────────────────────────────┘
   480×580px, white card, Mica border, 24° corner fold
```

**Special details**:
- The "page header" at the top-right corner (book title in italic gray mono) is a detail signature of a real publishing-house docx
- The "CHAPTER · 01" prefix lets the audience realize at a glance "this is a page of a book, not an article"
- The terracotta full-width rule (not a hairline, but a 3px-thick rule) is the hallmark of a publishing-house chapter opening page
- The dashes before and after the bottom page number "— 1 —" are Newsreader em-dashes, not hyphens

**[TYPE]**

- page header: Newsreader italic 9px, Smoke, letter-spacing 0.14em
- CHAPTER · 01: JetBrains Mono Bold 11px, Terracotta, letter-spacing 0.22em
- main title: Newsreader 700, 36px, Ink, line-height 1.05
- subtitle: Newsreader italic 14px, Smoke
- terracotta rule: 3px thick, full card width
- bar paragraphs: Mica color #E6E1D6, height 6px
- page number: JetBrains Mono 10px, Smoke, letter-spacing 0.18em

**[ANIM]**

- 14.50-14.80s · the previous shot's card exits + md holds
- 14.80-15.10s · arrow line grows forward
- 15.10s · arrow head, label "md → docx" enters
- 15.30-16.10s · destination card enters as a whole
- 16.10-17.00s · interior stagger: page header (delay 0) → CHAPTER label (delay 100ms) → title (delay 300ms) → subtitle (delay 500ms) → rule (delay 700ms) → 10 paragraph lines cascade (delay 850ms + 60ms cascade) → page number (delay 1600ms)
- 17.00-17.50s · hold

**[AUDIO]**

- BGM: persisting; at 15.00s the BGM swells +2dB overall (hinting we are pushing toward the climax)
- SFX: chime: capability 04 at 15.00s (-18dB)
- SFX: paper rustle (15.30s)

**[CHROME]**

- A: `CAPABILITY · 04`, fourth dot filled
- B/C/D/E: ON

**[ANTI-SLOP]**

- ✅ Don't write explanatory text like "this is a book interior page mockup" (let the typography speak for itself)
- ✅ The bar paragraphs use Mica (#E6E1D6), an extremely faint gray, not black — giving an honest signal of "this is a typesetting style preview, not real content"
- ✅ pause-and-look signature: the top right-aligned page header italic mono — 99% of the audience won't see it, the 1% of designers who do will know "this company did its homework"
- ✅ This shot is the most color-saturated of the 6 capabilities (Terracotta occupies the page rule + chapter label + top-right chrome counter) — precisely at the mid-point of the story arc, matching the "build-up toward climax" curve

**[WHY]**

CAPABILITY 04 is the pivotal shot that bridges what comes before and after:
- It confirms that "md is not just for the web" — it can produce publishing-house-grade docx
- It establishes the visual context of "print products," preparing for SHOT 08 (pdf) and SHOT 09 (epub)

After this shot, the audience is ready for the chain of "md → print product." The NEW labels of the next two shots then have their carry-over.

---

## SHOT 08 · "★ NEW · PRINT" (md → pdf)

**[TIMECODE]** 17.50 — 20.50s (3.0s) `|` **FUNCTION** CAPABILITY 05. **NEW**. md → publication-grade PDF. The first "upgrade" mark lights up.

**[VISUAL]**

Enter via cross-dissolve. This shot's visual intensity is **markedly higher than** SHOT 05-07 — because this is "the new thing," it needs to be remembered.

Visual differences:
1. **NEW label**: at top-left, beside the capability counter, a Terracotta rectangular box lights up, containing the characters "★ NEW" (JetBrains Mono Bold 13px, Terracotta, letter-spacing 0.22em, 4px Terracotta border, 6px×12px padding)
2. **The destination is not a single card, but two PDFs fanned out**: A4 behind (slightly +5° rotated), Da-32-kai (176×240mm, a domestic paper-book spec) in front (slightly -3° rotated), forming the visual of "both page-sizes are supported"
3. **Each PDF carries "printing crop marks"** — one L-shaped small line at each of the four corners, 2px thick, Smoke colored — this is a detail of a real printing-house PDF
4. arrow + label colored entirely in Terracotta (not Ink), the overall palette warmer

**The two PDFs' content**:

PDF A (A4, behind):

```
┌──────────────────────────┐
│ ┌                      ┐ │  ← crop marks
│  A4 · 210×297mm           │  ← Mono Bold 10px Terracotta
│  ─── (Terracotta rule)    │
│  On Markdown              │  ← Newsreader 22px
│  ──────────────────       │
│  ▬▬▬▬▬▬▬▬▬▬▬             │  ← 7 lines mica bars
│  ▬▬▬▬▬▬▬▬▬▬▬▬            │
│  ...                      │
│                           │
│ └                      ┘ │  ← crop marks
└──────────────────────────┘
   360×460px, white card, +5° rotation
```

PDF B (Da-32-kai, in front):

```
┌────────────────────┐
│ ┌                ┐ │  ← crop marks
│  Da-32-kai · 176×240mm│  ← Mono Bold 10px Terracotta
│  ───                │
│  On Markdown        │  ← Newsreader 19px
│  ──────────         │
│  ▬▬▬▬▬▬▬▬▬▬        │  ← 6 lines mica bars
│  ...                │
│ └                ┘ │
└────────────────────┘
   290×410px, white card, -3° rotation
```

**[TYPE]**

- NEW label: Mono Bold 13px Terracotta, 0.22em letter-spacing, 1.5px Terracotta border
- arrow label "md → pdf": Mono Bold 14px Terracotta, 0.14em
- PDF spec labels (A4 · 210×297mm etc.): Mono Bold 10px Terracotta, 0.2em
- chapter titles inside PDFs: Newsreader 600 weight, 19-22px, Ink

**[ANIM]**

- 17.50-17.80s · the previous shot's card exits + md holds
- 17.70s · **NEW label lights up** (special handling: scale 0.8 → 1.1 → 1.0 over 400ms with overshoot easing; at the same time an extremely faint terracotta glow briefly pulses then disappears)
- 17.80-18.10s · arrow + label enter (this time using Terracotta accent, emphasizing "this is NEW")
- 18.20-18.60s · PDF B (the one in front) enters (400ms expoOut, scale 0.85 → 1 + clockwise -8° → -3°)
- 18.50-18.90s · PDF A (the one behind) enters right after (400ms expoOut, scale 0.85 → 1 + clockwise 0° → +5°, stagger delay 300ms)
- 18.90-19.70s · the two PDFs' interiors enter in a cascade stagger
- 19.70s · 4 crop marks (PDF B's) appear in turn (80ms cascade, giving the detail signature of "printing-house craft")
- 19.70-20.50s · hold

**[AUDIO]**

- BGM: percussion pulse L4 joins at 18.00s (-32dB) (the extremely faint sub-kick 4/4 rhythm is established)
- **SFX: chime: NEW (05) at 17.70s (double chime + soft glow + reverb tail, -14dB)** ← this is one of the most important SFX cues in the whole film
- SFX: paper rustle × 2 (as each PDF enters, -22dB each)
- SFX: subtle "ink stamp" at 19.70s (as the crop marks appear, -22dB)

**[CHROME]**

- A: `CAPABILITY · 05`, fifth dot filled
- A is joined by the new NEW label beside it
- B: ON, at this time the orange dot beside the version chip pulses in sync (emphasizing "v2.0 new addition")
- C: progress dot ● slides to the "md→pdf" position, the text at this position is enlarged by 0.5px for emphasis
- D: ON
- E: ON

**[ANTI-SLOP]**

- ✅ The NEW label is not an emoji, not a sticker — it is a typographic mark (mono + 0.22em + ★ + border)
- ✅ The two PDFs are not cheap "stacked on top of each other," they are fanned + rotated (implying the physical action of "opening to look")
- ✅ The crop marks are the visual expression of genuine printing-house terminology; pause and you can see "ah, this is print-ready"
- ✅ No glow or particle used to emphasize "NEW" — typography and SFX speak for themselves
- ✅ pause-and-look signature: PDF B's top "Da-32-kai · 176×240mm" mixed Chinese-English setting is the huashu ecosystem's respect for domestic paper-book specs

**[WHY]**

This is one of the climax shots of ACT II. Two things must happen at once:
1. The audience must immediately realize "this is a new feature"
2. Visual detail must demonstrate "this is not a filler wkhtmltopdf wrapper, it is genuinely publication-grade"

NEW label + crop marks + two PDFs fanned + the complete A4 / Da-32-kai spec annotations — these four things together accomplish the two above.

The next shot's epub is the second of the twin NEW shots; its sense of rhythm and emotional intensity must rise one notch above this shot.

---

## SHOT 09 · "★ NEW · EBOOK" (md → epub)

**[TIMECODE]** 20.50 — 22.50s (2.0s) `|` **FUNCTION** CAPABILITY 06. **NEW**. md → standard EPUB3. The second new feature. The last capability.

**[VISUAL]**

Enter via cross-dissolve. This shot's duration is **shorter than the preceding ones** (only 2.0s instead of 3.0s) — because we have already established the "NEW + destination" pattern; the second occurrence, the audience gets instantly, the rhythm can accelerate.

destination card design: **an Apple Books-style EPUB reader frame** (emphasizing the realism of "this book is already in the reader").

```
   ╔════════════════════════════════════╗
   ║ ● ● ●                              ║  ← window chrome (Apple Books)
   ╠════════════════════════════════════╣
   ║                                    ║
   ║  HUASHU · ORANGE BOOK              ║  ← Mono Bold 10px Terracotta 0.22em
   ║                                    ║
   ║                                    ║
   ║  On                                ║  ← Newsreader 700, 30px, Ivory paper
   ║  Markdown                          ║     (on Charred bg)
   ║                                    ║
   ║  ───                               ║  ← Terracotta rule 40×2px
   ║                                    ║
   ║  an essay · huashu                 ║  ← italic 14px Smoke on Charred
   ║                                    ║
   ╠════════════════════════════════════╣
   ║ Apple Books · 1 of 24    EPUB 3   ║  ← Mono 10px Smoke 0.14em
   ╚════════════════════════════════════╝
   460×470px, ivory paper outer + Charred inner book cover area
   2px Ink border, 22px border-radius (modern app frame)
```

**Key visual differences**:
- The overall frame has a "macOS app window" feel (three dots + 22px rounded corners)
- The middle is the "opened ebook" cover area (Charred ground + publishing-house-taste typography)
- The bottom is the "Apple Books · 1 of 24" reader chrome
- The whole card gives the realism of "I am reading this book inside Apple Books"

**[TYPE]**

- HUASHU · ORANGE BOOK: Mono Bold 10px, Terracotta, 0.22em
- book title (On Markdown): Newsreader 700, 30px, Ivory (on Charred bg), line-height 1.0
- terracotta rule: 40×2px
- author italic: Noto Serif SC italic 14px, Smoke
- Apple Books chrome: Mono 10px, Smoke, 0.14em

**[ANIM]**

- 20.50-20.80s · the previous shot's PDF exits + md holds
- 20.70s · the NEW label **stays lit** (this time it does not pop out anew, because it was already established in SHOT 08 — just display "★ NEW")
- 20.80-21.10s · arrow + label "md → epub" enter (Terracotta accent, same as SHOT 08)
- 21.20-21.80s · the EPUB destination card enters as a whole (600ms expoOut, scale 0.88 → 1)
- 21.30-22.00s · interior staggered: window chrome dots (delay 0) → top brand label (delay 200ms) → book title "On" (delay 400ms) → "Markdown" (delay 480ms) → rule (delay 700ms) → author italic (delay 850ms) → bottom chrome (delay 1000ms)
- 22.00-22.50s · hold + prepare the transition to ACT III

**[AUDIO]**

- BGM: percussion persists, but at 22.00s the BGM swells +3dB overall (build-up for SHOT 10's convergence)
- **SFX: chime: NEW (06) at 20.70s (double chime + soft glow, a half-tone higher than SHOT 08, -14dB)** — the half-tone difference makes the two NEW shots form a musical relationship
- SFX: window chrome subtle "click" at 21.20s (macOS window appearance feel, -24dB)
- SFX: page turn rustle at 21.40s

**[CHROME]**

- A: `CAPABILITY · 06`, sixth dot filled (**all filled — 6/6**)
- The NEW label beside A persists
- B: the version chip's orange dot pulse intensifies (amplitude × 1.5)
- C: progress dot ● reaches the far-right "md→epub" position
- D: ON
- E: ON

**[ANTI-SLOP]**

- ✅ Don't draw the real Kindle or Apple Books logo (avoiding IP risk); use the macOS window chrome to imply "reader"
- ✅ No e-ink gray filter used (avoiding Kindle slop)
- ✅ The "Apple Books · 1 of 24" chrome has a real publishing-data feel (24 chapters, chapter 1)
- ✅ pause-and-look signature: the book title "On / Markdown" **line break** — Newsreader's line-break design at the large 30px point size, a homage to Penguin Classics cover typesetting

**[WHY]**

This shot is the closing of ACT II. Two things must be completed:
1. All 6 capabilities have been shown (counter 6/6 filled)
2. The emotion begins to build up toward ACT III's climax

The shot length going from 3.0 → 2.0s is deliberate — the rhythm is accelerating, the audience perceives "we are about to reach the peak."

---

## SHOT 10 · "THE CONVERGENCE"

**[TIMECODE]** 22.50 — 24.00s (1.5s) `|` **FUNCTION** The transition from ACT II → ACT III. All elements return to place. Prepare the slogan.

**[VISUAL]**

22.50s: all the previous destination cards have exited. Chrome A/C begin to fade out (the capability counter has reached 6/6, mission accomplished).

In the center of the frame, the md character slides back from the left position (x=480) to dead center (x=960), while the size goes from 220px → 300px.

The 6 capability labels around md (any→md / md→html / html→md / md→docx / md→pdf / md→epub) surface one by one from afar (circumference r=380px), encircling the md character in a circle, one every 60°, arranged in clockwise order (starting from "any→md" at the top). These labels are a mix of Mono Bold 14px Smoke (non-active) + Terracotta (actually new).

Overall effect: **the md character is the sun, the 6 capabilities are the planets.**

But this shot does not need to make the audience linger too long — it is a transition shot.

23.50-24.00s: the 6 capability labels slowly fade out (200ms each, inverse cascade), the md character keeps holding in the center, shrinking to 180px, ready to yield to the slogan.

**[TYPE]**

- 6 capability labels: JetBrains Mono Bold 14px, letter-spacing 0.16em
  - The first 4 (any→md / md→html / html→md / md→docx): Smoke
  - The last 2 (md→pdf / md→epub): Terracotta

**[ANIM]**

- 22.50-22.80s · the previous shot's EPUB card exits, Chrome A/C fade out (300ms linear)
- 22.50-23.00s · the md character slides back to center + enlarges (500ms expoOut)
- 22.80-23.40s · the 6 capability labels surface around md (each at a 60° position, r=380px, stagger 80ms each, fade-in 300ms + slight outward slide 20px)
- 23.40-23.80s · hold (the 6 labels settle around md)
- 23.80-24.00s · the 6 labels fade out simultaneously (200ms linear), the md character shrinks to 180px (200ms expoOut)

**[AUDIO]**

- BGM: at 23.00s, the all-layer swell begins (L1+L2+L3+L4 → +4dB)
- BGM: at 23.50s, the percussion briefly pauses for 1 beat (giving the tension of sudden silence)
- SFX: as the 6 capability labels enter, an extremely faint "click" (-30dB each, staggered)
- SFX: ascending sweep begins at 23.50s (build-up to 24.00s)

**[CHROME]**

- A: fade out at 22.50s (counter already 6/6, mission complete)
- B: ON, but begins preparing the transition for ACT III (position stays the same, but the interior spacing slightly tightens)
- C: fade out at 22.50s
- D: ON
- E: ON

**[ANTI-SLOP]**

- ✅ The 6 capability labels do not "spin around md in a circle" (avoiding the "planet spinner" cyber slop); they "settle at fixed positions, then fade together" (more restrained)
- ✅ Chrome A/C exit gracefully after their mission is complete (not "forever on the frame"), a good habit of "making room for the next act"
- ✅ pause-and-look signature: at 23.40s the 6 labels are on the frame simultaneously, readable in clockwise order — this is the film's only "full-capability panorama" frame; if the audience pauses here, they can see all 6 pipelines in full — this is the best frame for a marketing screenshot

**[WHY]**

This is a bridge.

ACT II ends at 22.50s (NEW (06) just finished), but the slogan doesn't enter until 24.00s — the 1.5s in between cannot be "blank waiting," it must have narrative motion.

The concept of "convergence": after the 6 pipelines are done, all capabilities converge back to the source, md. This is precisely the essence of the whole film's story — **all the flows, in the end, return to the source.**

The next shot, make room for the slogan. The md character shrinks to 180px, ready to become the slogan's "brand seal."

---

## SHOT 11 · "ONE SOURCE."

**[TIMECODE]** 24.00 — 26.50s (2.5s) `|` **FUNCTION** ACT III peak first half. The slogan enters rising upward. Emotional climax.

**[VISUAL]**

The md character has shrunk to 180px, resting at the center of the frame (y=540).

24.00s: the md character **keeps sliding toward the frame top-left** to (x=128, y=88), shrinking to 56px — becoming the "brand seal" fixed in the top-left corner. This is the brand's homecoming.

24.20s: slightly above center (y=460) the hero slogan top line begins to surface:

```
ONE SOURCE.
```

Font: Newsreader 700, **168px**, letter-spacing -0.03em, line-height 0.95, Ink #1A1A1A
Position: horizontally centered (x=960), y=460 (character baseline)

Entrance method: **staggered letter reveal** — 10 characters (O-N-E-space-S-O-U-R-C-E-.) enter in turn at 30ms stagger, each character fade + 12px y slide-down + scale 0.92 → 1.0 (260ms expoOut each).

26.00s: 30px below the slogan, a short Terracotta rule (320×3px) appears, expanding from center to both ends (300ms expoOut).

26.50s: enter the next shot.

**[TYPE]**

- ONE SOURCE.: Newsreader 700, 168px, Ink, letter-spacing -0.03em, line-height 0.95
- terracotta rule: 320×3px, centered, accent

**[ANIM]**

- 24.00-24.30s · the md character slides to top-left (300ms expoOut, size 180 → 56)
- 24.20s · ONE SOURCE.'s first character 'O' enters (260ms expoOut)
- 24.23s · 'N' enters
- 24.26s · 'E' enters
- 24.29s · space (no visual, but occupies layout)
- 24.32s · 'S'
- 24.35s · 'O'
- 24.38s · 'U'
- 24.41s · 'R'
- 24.44s · 'C'
- 24.47s · 'E'
- 24.50s · '.' (period)
- 24.20-25.00s · the whole ONE SOURCE. completes (10 characters × 30ms stagger + 260ms each = total ~560ms)
- 25.00-26.00s · hold (let the audience read "ONE SOURCE.")
- 26.00-26.30s · Terracotta rule appears (300ms expoOut from 0 → 320px)
- 26.30-26.50s · hold

**[AUDIO]**

- BGM: the swell that began at 22.00s reaches its peak at 24.50s (loudest -6dB)
- BGM: the full string section enters (L5), cello + violin + viola three layers stacked
- **SFX: impact (slogan ONE) at 24.20s — deep bass impact + short reverb tail (-8dB)** ← this is the strongest SFX cue in this film
- SFX: an extremely light pen-on-paper stroke at 26.00s (as the rule appears, -22dB)

**[CHROME]**

- A: OFF (already exited)
- B: ON, but an **important change**: the version chip cross-dissolves into a new form at this moment — at the same top-right position, but the chip is slightly larger, point size 18px (previously 16px), more prominent. At the same time the Terracotta dot's pulse amplitude × 2 (emphasizing "the v2.0 upgrade moment")
- C: OFF (already exited)
- D: ON
- E: ON

**New chrome**:
- The md character (top-left, 56px, Newsreader 600 + Terracotta dot) officially takes up residence in the corner, becoming the brand seal

**[ANTI-SLOP]**

- ✅ The slogan is not "whole-word fade-in" (cheap), it is letter-by-letter stagger (cinematic grade)
- ✅ The single-character stagger time of 30ms is calculated — enough to see the cascade, but not slow enough to drag the rhythm (60ms would look slow)
- ✅ The 168px point size has been layout-verified — any larger and it clashes with SIX FORMS. (SHOT 12), any smaller and the momentum is insufficient
- ✅ pause-and-look signature: the "." at the end of "ONE SOURCE." is Terracotta (not Ink), echoing the hero md character's Terracotta dot — head-to-tail brand signature consistent

**[WHY]**

This is the first half of the emotional climax.

"ONE SOURCE." is this film's thesis. If the audience remembers only one sentence after watching the whole film, it is this one.

Having the md character recede to top-left at this moment is strategic — the slogan is the protagonist, md is the brand seal. The two don't steal the show from each other.

The next shot, SIX FORMS. drops down, and the thesis is complete.

---

## SHOT 12 · "SIX FORMS."

**[TIMECODE]** 26.50 — 29.00s (2.5s) `|` **FUNCTION** ACT III peak second half. The slogan descends + the capability map is fully presented. The whole film's emotional resolution.

**[VISUAL]**

26.50s: ONE SOURCE. is still in the upper position of the frame (y=460).

In the lower half of the frame (y=720), the hero slogan bottom line begins to enter:

```
SIX FORMS.
```

Font: Newsreader 700, 168px, letter-spacing -0.03em, line-height 0.95, **Terracotta #C2410C**
Position: horizontally centered (x=960), y=720 (character baseline)

Entrance method: mirror of SHOT 11 — staggered letter reveal, 9 characters + 1 . (10 total), each 30ms stagger (a slower stagger because this is the climax).

Entrance detail: each character is fade + 12px y **slide-up** (rather than SHOT 11's slide-down, the direction is symmetric) + scale 0.92 → 1.0 (260ms expoOut each).

27.20s: SIX FORMS. completes, the whole slogan double-line typography is complete.

27.20-27.80s: 30px below SIX FORMS., 6 capability pills appear, entering in turn:

```
[any→md] [md→html] [html→md] [md→docx] [md→pdf ★NEW] [md→epub ★NEW]
```

Each pill:
- Font: JetBrains Mono Bold 14px, letter-spacing 0.16em
- Size: 10px×18px padding, 1.5px border
- The first 4: Ink text + Ink border + transparent background
- The last 2 (NEW): Terracotta text + Terracotta border + Mist (#FFF7F0) background + a Terra Hot "NEW" mini badge at the top-right corner at -8/-10px

Each pill is 14px apart. The whole group is horizontally centered (x=960), y=820.

Entrance: staggered left to right, each 80ms delay, fade-in + 4px y slide-up (300ms expoOut).

27.80-28.30s: the subtitle line enters (y=890):

```
md is the source code, everything else is product.
```

Font: Noto Serif SC italic 26px, Ink, letter-spacing 0.04em
Horizontally centered.

Entrance: fade-in + 8px y slide-up (400ms expoOut).

28.30-29.00s: overall hold. This is the most static frame of the film — all elements in place, letting the audience "finish reading it."

**[TYPE]**

- SIX FORMS.: Newsreader 700, 168px, Terracotta, letter-spacing -0.03em, line-height 0.95
- pills: JetBrains Mono Bold 14px, letter-spacing 0.16em, 1.5px border
- subtitle: Noto Serif SC italic 26px, Ink, letter-spacing 0.04em

**[ANIM]**

- 26.50-27.20s · SIX FORMS. character stagger (mirror of SHOT 11)
- 27.20-27.30s · short hold
- 27.30-27.80s · 6 pills cascade (each 80ms stagger × 6 = 480ms total + 300ms each pill duration)
- 27.80-28.30s · subtitle enters (400ms)
- 28.30-29.00s · overall hold

**[AUDIO]**

- BGM: the 26.50s peak swell sustains, reaching the loudest of the whole film at 27.20s (-4dB)
- BGM: after 27.20s the BGM begins to sustain (no longer intensifying, but maintaining peak intensity)
- **SFX: impact (slogan SIX) at 26.50s — deep bass impact, slightly heavier by a half-tone than the ONE shot's impact (-7dB)**
- SFX: as the 6 pills enter, staggered metallic clicks (-24dB each, 50ms)
- SFX: at 27.80s an extremely light pen flourish (as the subtitle enters)

**[CHROME]**

- B: ON, version chip persists
- D: ON, watermark persists
- E: ON
- md seal (top-left): ON

**[ANTI-SLOP]**

- ✅ ONE SOURCE. is Ink, SIX FORMS. is Terracotta — representing the color contrast of "source" and "product" respectively, not decorative color
- ✅ The background of the two NEW pills among the 6 is #FFF7F0 (an extremely faint mist tint), not "orange fill" — restrained
- ✅ The NEW mini badge is in the prominent top-right corner of the pill at -8/-10px, but only 9px point size — the standard position of the detail signature
- ✅ The subtitle uses the Chinese comma "，" + period "。" — a respect for Chinese typesetting
- ✅ This frame (28.30s) is the film's "most complete frame for marketing use" — it can be screenshotted as a thumbnail / X poster / WeChat-official-account cover image; all the information is in one frame: slogan + 6 capabilities + subtitle + brand seal + version

**[WHY]**

This is the resolution shot.

If SHOT 11 is the thesis (ONE SOURCE.), SHOT 12 is the antithesis + synthesis (SIX FORMS. plus the complete capability map).

The audience at this frame, 27.50s, should be simultaneously hearing the strings peak and visually fully absorbed by the typography — these are the most worthwhile 5 seconds of the film.

The next shot is the closing; let the strings decay, let the md seal shine alone.

---

## SHOT 13 · "SIGN-OFF"

**[TIMECODE]** 29.00 — 30.00s (1.0s) `|` **FUNCTION** The ending. Let all the slogan elements exit, leaving the md seal shining alone. The brand imprint.

**[VISUAL]**

29.00s: SIX FORMS. + 6 pills + subtitle begin to hold-in-place.

29.20-29.60s: ONE SOURCE. + SIX FORMS. + 6 pills + subtitle slowly fade out (400ms linear each, **no stagger**, a synchronized fade-out — creating the feeling of "the frame settling").

29.40s: the top-left md seal character slowly enlarges from 56px to 88px, while its position slides from (128, 88) toward the frame center (960, 540) — this is md's "final return."

29.40-29.80s: the md character settles in the frame center, size 88px, color Ink + Terracotta dot.

29.80-30.00s: 30px below the md character, a short Terracotta rule appears (120×2px, shorter than SHOT 03, more refined), grown from 0.

30.00s: all elements in place. The final frame is:

```
                                                                  ● HUASHU-MD-HTML · v2.0
                                                                                              (top-right chrome)


                                            md.                   ← Newsreader 600, 88px, Ink + Terracotta dot
                                          ───                     ← Terracotta rule, 120×2px

                                                                                CREATED BY HUASHU-DESIGN
                                                                                              (bottom-right watermark)
```

The whole frame has only 4 elements: the md seal, the accent rule, the top-right chrome, the bottom-right watermark. Everything else is empty.

**[TYPE]**

- md.: Newsreader 600, 88px, Ink + Terracotta dot
- accent rule: 120×2px Terracotta

**[ANIM]**

- 29.00-29.20s · the previous shot holds (let the audience fully absorb)
- 29.20-29.60s · ONE SOURCE. + SIX FORMS. + 6 pills + subtitle fade out synchronously (400ms linear, synchronized)
- 29.40-29.80s · the md seal enlarges + slides to center (400ms expoOut, size 56 → 88, position (128,88) → (960,540))
- 29.80-30.00s · accent rule expands (200ms expoOut, 0 → 120px)
- 30.00s · final hold (if there is a loop, loop back to 00.00s)

**[AUDIO]**

- BGM: at 29.00s decay begins, entering L6 (all layers fading)
- BGM: at 29.40s the strings fade, leaving piano + reverb tail
- BGM: at 30.00s, everything returns to silence + room tone
- **SFX: final stamp / sign-off at 29.40s (ink stamp + soft reverb, -14dB)** — as md lands in the center
- SFX: an extremely light paper rustle at 29.80s (as the accent rule enters)

**[CHROME]**

- B: ON, persists
- D: ON, persists
- E: ON, persists
- All others OFF

**[ANTI-SLOP]**

- ✅ No sign-off text like "Thank you" or "Made with love" (cheap)
- ✅ No giant logo blow-up (not needed)
- ✅ The md seal is the true protagonist of the whole film's story; letting it remain alone in the frame center at the end is the simplest form of resolution
- ✅ pause-and-look signature: the final frame's md. at the 88px Newsreader font — the Terracotta dot is the visual focal point of the whole frame; the audience's eye naturally rests on this dot, then sees the accent rule below, then the top-right version chip. This "line of sight" is a success of visual-hierarchy design
- ✅ The silence in the last 0.2s gives the frame breathing room

**[WHY]**

The whole film begins with a blank page and ends with an md seal + a touch of terracotta orange.

This is a head-to-tail echo (visual rhyme):
- 0.0s: blank ivory page (empty)
- 30.0s: ivory page + md (full)

The audience travels from "empty" to "full," but "full" is in fact just an `md.` character — this is the visual manifesto of "source-of-truth": **everything originates from a simple md.**

If the whole film makes the audience remember one frame, I hope it is this one.

---

# Part V · Production Manifest

## 5.1 Font Manifest + Loading Method

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400;1,500&family=JetBrains+Mono:wght@400;500;700&family=Noto+Serif+SC:wght@400;500;700;900&display=swap" rel="stylesheet">
```

**Measured load time**: about 800-1500ms depending on CDN state. The `document.fonts.ready` wait must wait until it returns true before starting the Stage clock timer (the Stage already implements this).

## 5.2 Palette CSS Variables

```css
:root {
  --paper:       #FAFAF6;
  --mist:        #F2EDE4;
  --mica:        #E6E1D6;
  --smoke:       #6B6B6B;
  --cinder:      #3D3530;
  --ink:         #1A1A1A;
  --charred:     #2A2620;
  --terracotta:  #C2410C;
  --terra-hot:   #E55D21;
  --terra-deep:  #8B2D08;
}
```

## 5.3 BGM Sourcing Selection Criteria

**First choice**: generate a 30-second cinematic minimal piece yourself with Suno v6.0 / Udio v1.5, prompt keywords:

```
minimal cinematic piano, slow tempo 60bpm, single piano notes,
sparse arpeggio, low cello drone, subtle sub-kick percussion,
swelling strings at climax, decay to silence,
in the style of Max Richter on the nature of daylight,
no vocals, 30 seconds duration, ivory paper mood
```

**Alternative**: search royalty-free libraries
- artlist.io: "minimal cinematic"
- bensound.com: "cinematic"
- musicbed.com: "Jóhann Jóhannsson style"

**Minimum standard**: BGM 30 seconds long, 44.1kHz sample rate, aim for -16 LUFS integrated loudness.

## 5.4 SFX Sourcing

**First choice**: use the huashu-design skill's 37 prebuilt resources at `assets/sfx/<category>/*.mp3`:

```
Event                          Recommended SFX file
─────────────────────────────────────────────────────
keyboard clicks            sfx/ui/keyboard-click-*.mp3
cursor blink               sfx/ui/tick-soft.mp3
md morph swell             sfx/cinematic/whoosh-bloom.mp3
file card whoosh           sfx/cinematic/whoosh-short-*.mp3
absorb / ink drop          sfx/foley/ink-drop.mp3
paper rustle               sfx/foley/paper-turn.mp3
chime capability           sfx/melodic/chime-single-*.mp3
chime NEW (double)         sfx/melodic/chime-double-warm.mp3
build sweep                sfx/cinematic/ascending-sweep.mp3
impact (slogan)            sfx/cinematic/deep-impact-*.mp3
pen flourish               sfx/foley/pen-stroke.mp3
final stamp                sfx/foley/ink-stamp.mp3
```

## 5.5 Screenshot Verification Plan

After implementing the HTML, the following key frames must be verified (using Playwright + the `?t=NN` URL parameter):

```
t=0.5    ← SHOT 01 mid: blank ivory page (verify the paper texture doesn't steal the show)
t=2.5    ← SHOT 02 mid: typing in progress (verify cursor blink + JetBrains Mono)
t=3.8    ← SHOT 03 mid: md morphing (verify ghost residual + scale curve)
t=5.0    ← SHOT 03 end: hero md settled (verify 480px + Terracotta dot)
t=7.0    ← SHOT 04 mid: cards in flight (verify the parabola + card content genuinely readable)
t=8.4    ← SHOT 04 tagline (verify the "everything → md" Chinese italic)
t=10.5   ← SHOT 05 mid: html card complete (verify essay content readable)
t=13.5   ← SHOT 06 mid: md source visible (verify syntax highlighting)
t=16.5   ← SHOT 07 mid: docx page complete (verify chapter title + page number)
t=19.0   ← SHOT 08 mid: PDFs fanned out (verify crop marks visible)
t=21.5   ← SHOT 09 mid: EPUB frame complete (verify Apple Books chrome)
t=23.4   ← SHOT 10 mid: 6 capability orbit (verify the complete capability panorama)
t=25.0   ← SHOT 11 mid: ONE SOURCE. complete (verify tracking + Terracotta period)
t=27.5   ← SHOT 12 mid: SIX FORMS. + pills (verify the complete double-line slogan)
t=28.5   ← SHOT 12 marketing frame (verify the overall marketing-ready frame)
t=29.9   ← SHOT 13 final hold (verify the md seal + accent rule)
```

Each frame must satisfy:
- No element overflows the 1920×1080 canvas
- Tracking, line-height visually correct
- The anti-AI-slop checklist passes
- Key typography details (such as the Terracotta dot, page number em-dash, chapter title small caps) are identifiable

## 5.6 Recording Parameters

```bash
node scripts/render-video.js \
  --file file:///path/to/v5-six-forms.html \
  --duration 30 \
  --fps 25 \
  --width 1920 \
  --height 1080 \
  --out v5-final-silent.mp4
```

**Key codec parameters**:
- video codec: libx264
- pixel format: yuv420p (compatibility)
- bitrate: 12 Mbps (high quality, a 30s file is about 45MB)
- profile: high
- preset: slow (quality > speed)

**Subsequent frame interpolation** (optional, smooth 60fps version):

```bash
bash scripts/convert-formats.sh v5-final-silent.mp4 --fps 60
```

## 5.7 Audio Mixing

```bash
# Step 1: add BGM
bash scripts/add-music.sh v5-final-silent.mp4 \
  --bgm assets/bgm/cinematic-minimal-30s.mp3 \
  --bgm-volume -18dB \
  --out v5-with-bgm.mp4

# Step 2: add SFX cues (add cue by cue per the Part II.6 SFX dictionary)
# Use ffmpeg's -filter_complex amix for multi-track mixing
ffmpeg -i v5-with-bgm.mp4 \
  -i assets/sfx/ui/keyboard-click-1.mp3 \
  -i assets/sfx/ui/keyboard-click-2.mp3 \
  ... \
  -filter_complex "[1]adelay=500|500[s1];[2]adelay=550|550[s2];...;[0][s1][s2]...amix=inputs=N:duration=longest:dropout_transition=0[out]" \
  -map 0:v -map "[out]" \
  -c:v copy -c:a aac -b:a 192k \
  v5-final.mp4

# Step 3: verify audio stream
ffprobe -i v5-final.mp4 -show_streams -select_streams a 2>&1 | grep -E "(codec_type|sample_rate|channels|duration)"
```

**Expected output**:
- audio codec: aac
- sample rate: 44100Hz or 48000Hz
- channels: 2 (stereo)
- duration: 30.0s

## 5.8 Deliverables Manifest

```
v5-final.mp4              primary deliverable (30s, 1920×1080, 25fps, with audio, ~50MB)
v5-final-60fps.mp4        high-frame-rate version (60fps interpolated, ~80MB, for X / YouTube)
v5-final.gif              social media version (30s, palette-optimized, < 8MB, for WeChat-official-account embedding)
v5-final-silent.mp4       silent version (backup, convenient for later re-dubbing / swapping BGM)
v5-poster.png             poster version (the t=28.5s frame, for X cards / WeChat-official-account cover)
v5-director-notes.md      this document (director's notes)
v5-six-forms.html         source file (HTML animation)
v5-shot-list.csv          shot timecode + key parameter reference table (for pause verification)
```

## 5.9 End-to-End Time Estimate

| Step | Estimated time |
|-----|----------|
| Director's notes writing | done |
| HTML animation implementation | 4-6 hours |
| Key frame screenshots + visual check | 1 hour |
| Recording the silent MP4 | 5-10 minutes (including Playwright startup) |
| BGM generation / selection | 30 minutes |
| SFX cue placement + mixing | 2-3 hours |
| GIF derivation | 5 minutes |
| Poster screenshot + naming | 10 minutes |
| Final delivery + git commit | 10 minutes |
| **Total** | **8-11 hours** |

---

# Appendix · The First Principle of This Film

If, as director, I could keep only one sentence of this film, it would be:

> **A typographic film about the "source," whose protagonist is a single `md.` character.**

Every other design decision — palette, fonts, rhythm, SFX, chrome, anti-slop checklist — is derived from this one sentence.

If a concrete decision cannot trace back to this sentence, do not do it.

---

*Director's notes — end of document*
*Total word count: ~11,500 Chinese characters*
*Next: after user review passes, enter the HTML implementation phase*
