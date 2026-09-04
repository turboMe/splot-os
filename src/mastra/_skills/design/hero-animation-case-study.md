# Gallery Ripple + Multi-Focus · Scene Orchestration Philosophy

> A reusable visual orchestration structure extracted from huashu-design hero animation v9 (25 seconds, 8 scenes).
> Not an animation production pipeline, but rather **under what scenarios this orchestration is "correct"**.
> Practical reference: [demos/hero-animation-v9.mp4](../demos/hero-animation-v9.mp4) · [https://www.huasheng.ai/huashu-design-hero/](https://www.huasheng.ai/huasheng-design-hero/)

## One Sentence First

> **When you have 20+ homogeneous visual assets and scenes that need to "express scale and depth", prioritize the Gallery Ripple + Multi-Focus orchestration over simply stacking layouts.**

General SaaS feature animations, product launches, skill promotions, series portfolio displays—as long as there's enough material and consistent style, this structure almost always delivers results.

---

## What This Technique Actually Expresses

It's not about "showing off assets"—it's about telling a narrative through **two rhythmic changes**:

**First Beat · Ripple Expansion (~1.5s)**: 48 cards spread out from the center, stunning the audience with "quantity"—"Oh, this thing has so many outputs."

**Second Beat · Multi-Focus (~8s, 4 cycles)**: While the camera pans slowly, the background dims + desaturates 4 times, zooming a single card to the center of the screen—the audience switches from "impact of quantity" to "gaze at quality", with a stable rhythm of 1.7s each time.

**Core Narrative Structure**: **Scale (Ripple) → Gaze (Focus × 4) → Fade Out (Walloff)**. This three-beat combination expresses "Breadth × Depth"—not only can it do a lot, but each one is also worth pausing to look at.

Compare with counter-examples:

| Approach | Audience Perception |
|-----------------------------------|----------------------------------------------------------------|
| 48 cards statically arranged (no Ripple) | Looks good but no narrative, like a grid screenshot |
| Quick cuts one by one (no Gallery context) | Like a slideshow, loses "sense of scale" |
| Only Ripple, no Focus | Stunning, but no specific card is remembered |
| **Ripple + Focus × 4 (this recipe)** | **First impressed by quantity, then gaze at quality, finally a calm fade out—a complete emotional arc** |

---

## Prerequisites (All Must Be Met)

This orchestration is **not a panacea**; the following 4 conditions are indispensable:

1.  **Asset Scale ≥ 20 cards, preferably 30+**
    Less than 20 cards will make the Ripple look "empty"—a sense of density comes from every cell in the 48-grid moving. v9 used 48 cells × 32 images (looping fill).

2.  **Consistent Visual Style of Assets**
    All 16:9 slide previews / all app screenshots / all cover designs—aspect ratio, color tone, layout must look like "a set". Mixing and matching will make the Gallery look like a clipboard.

3.  **Readable Information Remains When Assets Are Magnified Individually**
    Focus magnifies a card to 960px wide. If the original image is blurry or has sparse information when magnified, the Focus beat is wasted. Reverse verification: Can you pick 4 cards from the 48 as "most representative"? If not, it means the asset quality is inconsistent.

4.  **Scene Itself is Landscape or Square, Not Portrait**
    The Gallery's 3D tilt (`rotateX(14deg) rotateY(-10deg)`) requires a horizontal sense of extension; portrait orientation will make the tilt effect look narrow and awkward.

**Backup paths if conditions are missing**:

| What's Missing | Degrades to What |
|------------------------|---------------------------------------------------|
| Assets < 20 cards | Switch to "3-5 cards static display + individual focus" |
| Inconsistent style | Switch to "cover + 3 chapter large images" keynote-style |
| Sparse information | Switch to "data-driven dashboard" or "quote + large text" |
| Portrait scene | Switch to "vertical scroll + sticky cards" |

---

## Technical Recipe (v9 Practical Parameters)

### 4-Layer Structure

```
viewport (1920×1080, perspective: 2400px)
  └─ canvas (4320×2520, huge overflow) → 3D tilt + pan
      └─ 8×6 grid = 48 cards (gap 40px, padding 60px)
          └─ img (16:9, border-radius 9px)
      └─ focus-overlay (absolute center, z-index 40)
          └─ img (matches selected slide)
```

**Key**: The canvas is 2.25 times larger than the viewport, so panning gives the feeling of "peeking into a larger world".

### Ripple Expansion (Distance Delay Algorithm)

```js
// Entry time for each card = distance from center × 0.8s delay
const col = i % 8, row = Math.floor(i / 8);
const dc = col - 3.5, dr = row - 2.5;       // Offset to center
const dist = Math.hypot(dc, dr);
const maxDist = Math.hypot(3.5, 2.5);
const delay = (dist / maxDist) * 0.8;       // 0 → 0.8s
const localT = Math.max(0, (t - rippleStart - delay) / 0.7);
const opacity = expoOut(Math.min(1, localT));
```

**Key Parameters**:
- Total duration 1.7s (`T.s3_ripple: [8.3, 10.0]`)
- Max delay 0.8s (center appears earliest, corners latest)
- Each card's entry duration 0.7s
- Easing: `expoOut` (burst feeling, not smooth)

**What happens simultaneously**: canvas scale from 1.25 → 0.94 (zoom out to reveal) — combined with a synchronous push-away feeling as elements appear.

### Multi-Focus (4 Rhythms)

```js
T.focuses = [
  { start: 11.0, end: 12.7, idx: 2  },  // 1.7s
  { start: 13.3, end: 15.0, idx: 3  },  // 1.7s
  { start: 15.6, end: 17.3, idx: 10 },  // 1.7s
  { start: 17.9, end: 19.6, idx: 16 },  // 1.7s
];
```

**Rhythm Pattern**: Each focus is 1.7s, with a 0.6s breathing interval. Total 8s (11.0–19.6s).

**Inside each focus**:
- In ramp: 0.4s (`expoOut`)
- Hold: middle 0.9s (`focusIntensity = 1`)
- Out ramp: 0.4s (`easeOut`)

**Background changes (this is key)**:

```js
if (focusIntensity > 0) {
  const dimOp = entryOp * (1 - 0.6 * focusIntensity);  // dim to 40%
  const brt = 1 - 0.32 * focusIntensity;                // brightness 68%
  const sat = 1 - 0.35 * focusIntensity;                // saturate 65%
  card.style.filter = `brightness(${brt}) saturate(${sat})`;
}
```

**Not just opacity—also desaturate + darken**. This makes the foreground overlay's colors "pop out", rather than just "getting a bit brighter".

**Focus overlay size animation**:
- From 400×225 (entry) → 960×540 (hold state)
- Outer edge has 3 layers of shadow + 3px accent color outline ring, creating a "framed" look.

### Pan (Sustained Movement Keeps Stillness Engaging)

```js
const panT = Math.max(0, t - 8.6);
const panX = Math.sin(panT * 0.12) * 220 - panT * 8;
const panY = Math.cos(panT * 0.09) * 120 - panT * 5;
```

- Sine wave + linear drift dual-layer motion—not purely cyclical, position is different at every moment
- Different X/Y frequencies (0.12 vs 0.09) to avoid visually perceiving a "regular cycle"
- Clamped at ±900/500px to prevent drifting out of bounds

**Why not pure linear pan**: Pure linear pan allows the audience to "predict" where it will be next; sine + drift makes every second new, creating a "slight seasickness" (the good kind) under 3D tilt, keeping attention engaged.

---

## 5 Reusable Patterns (Distilled from v6→v9 Iterations)

### 1. **expoOut as the main easing, not cubicOut**

`easeOut = 1 - (1-t)³` (smooth) vs `expoOut = 1 - 2^(-10t)` (bursts then quickly converges).

**Reason for choice**: The first 30% of expoOut quickly reaches 90%, more like physical damping, aligning with the intuition of "heavy objects landing". Especially suitable for:
- Card entry (sense of weight)
- Ripple diffusion (shockwave)
- Brand lift (settling feeling)

**When to still use cubicOut**: focus out ramp, symmetrical micro-animations.

### 2. **Paper-like background + Terracotta Orange accent (Anthropic lineage)**

```css
--bg: #F7F4EE;        /* Warm paper */
--ink: #1D1D1F;       /* Almost black */
--accent: #D97757;    /* Terracotta orange */
--hairline: #E4DED2;  /* Warm lines */
```

**Why**: The warm background still has a "breathing feel" after GIF compression, unlike pure white which can look "screen-like". Terracotta orange as the sole accent runs through terminal prompt, dir-card selection, cursor, brand hyphen, focus ring—all visual anchor points are tied together by this single color.

**v5 Lesson**: Added a noise overlay to simulate "paper texture", but GIF frame compression completely ruined it (each frame was different). v6 changed to "only background color + warm shadow", retaining 90% of the paper feel, while reducing GIF size by 60%.

### 3. **Two-tier Shadow to Simulate Depth, No True 3D**

```css
.gallery-card.depth-near { box-shadow: 0 32px 80px -22px rgba(60,40,20,0.22), ... }
.gallery-card.depth-far  { box-shadow: 0 14px 40px -16px rgba(60,40,20,0.10), ... }
```

Using `sin(i × 1.7) + cos(i × 0.73)` deterministic algorithm to assign near/mid/far three-tier shadows to each card—**visually creating a "three-dimensional stacking" feel, but with completely unchanged transforms per frame, 0 GPU consumption**.

**Cost of true 3D**: Each card's individual `translateZ`, GPU calculates 48 transforms + shadow blur every frame. v4 tried it, Playwright recording struggled even at 25fps. v6's two-tier shadow has <5% visual difference to the naked eye, but costs 10 times less.

### 4. **Font weight variation (font-variation-settings) is more cinematic than font size variation**

```js
const wght = 100 + (700 - 100) * morphP;  // 100 → 700 over 0.9s
wordmark.style.fontVariationSettings = `"wght" ${wght.toFixed(0)}`;
```

Brand wordmark transitions from Thin → Bold over 0.9s, combined with subtle letter-spacing adjustment (-0.045 → -0.048em).

**Why it's better than scaling**:
- Audiences have seen scaling too many times, expectations are fixed
- Font weight variation is an "internal sense of fullness", like a balloon being inflated, rather than "being pushed closer"
- Variable fonts are a feature popularized only after 2020+, audiences subconsciously perceive it as "modern"

**Limitations**: Must use fonts that support variable fonts (Inter/Roboto Flex/Recursive, etc.). Regular static fonts can only mimic this (switching between fixed weights will have jumps).

### 5. **Corner Brand Low-Intensity Persistent Signature**

During the Gallery phase, there's a small `HUASHU · DESIGN` identifier in the top-left corner, with 16% opacity color value, 12px font size, and wide letter spacing.

**Why add this**:
- After the Ripple burst, the audience can easily "lose focus" and forget what they're looking at; the subtle top-left indicator helps anchor them.
- More sophisticated than a full-screen large logo—brand people know that a brand signature doesn't need to shout.
- Still leaves a sense of attribution when the GIF is screenshotted and shared.

**Rule**: Only appears in the middle section (when the screen is busy), off at the beginning (not to obscure the terminal), and off at the end (brand reveal is the main focus).

---

## Counter-Examples: When NOT to Use This Orchestration

❌ **Product Demos (for showing features)**: The Gallery makes each card flash by, and the audience won't remember any specific feature. Switch to "single-screen focus + tooltip annotations".

❌ **Data-Driven Content**: Audiences need to read numbers; the fast pace of the Gallery doesn't allow time to read. Switch to "data charts + item-by-item reveal".

❌ **Storytelling**: The Gallery is a "parallel" structure; stories require "causality". Switch to keynote chapter transitions.

❌ **Only 3-5 assets**: Ripple density is insufficient, looks like "patches". Switch to "static arrangement + highlight one by one".

❌ **Portrait (9:16)**: 3D tilt requires horizontal extension; portrait orientation will make the tilt feel "skewed" rather than "expanded".

---

## How to Determine if Your Task Suits This Orchestration

Three quick checks:

**Step 1 · Asset Quantity**: Count how many similar visual assets you have. < 15 → Stop; 15-25 → Gather more; 25+ → Use directly.

**Step 2 · Consistency Test**: Place 4 random assets side-by-side. Do they look like "a set"? If not → Unify the style first, or change the plan.

**Step 3 · Narrative Match**: Are you trying to express "Breadth × Depth" (quantity × quality)? Or "process", "features", "story"? If not the former, don't force it.

If all three steps are yes, directly fork v6 HTML, modify the `SLIDE_FILES` array and timeline to reuse. Change the color palette with `--bg / --accent / --ink`, a complete reskin without changing the core structure.

---

## Related References

- Complete technical workflow: [references/animations.md](animations.md) · [references/animation-best-practices.md](animation-best-practices.md)
- Animation export pipeline: [references/video-export.md](video-export.md)
- Audio configuration (BGM + SFX dual track): [references/audio-design-rules.md](audio-design-rules.md)
- Apple gallery-style horizontal reference: [references/apple-gallery-showcase.md](apple-gallery-showcase.md)
- Source HTML (v6 + audio integrated version): `www.huasheng.ai/huashu-design-hero/index.html`