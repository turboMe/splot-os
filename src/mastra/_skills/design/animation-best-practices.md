# Animation Best Practices · Forward Animation Design Syntax

> Based on a deep teardown of Anthropic's three official product animations (Claude Design / Claude Code Desktop / Claude for Word),
> distilling the "Anthropic-grade" animation design rules.
>
> Use alongside `animation-pitfalls.md` (the avoid-the-traps checklist) — this file is "**do it this way**,"
> pitfalls is "**don't do it this way**"; the two are orthogonal, read both.
>
> **Constraint statement**: this file only collects **motion logic and expressive style**, and **introduces no specific brand color values**.
> Color decisions go through §1.a the Core Asset Protocol (extracted from the brand spec) or the "Design Direction Advisor"
> (each of the 20 philosophies has its own color scheme). This reference discusses "**how it moves**," not "**what color**."

---

## §0 · Who You Are · Identity and Taste

> Before reading any of the technical rules that follow, read this section first. The rules **emerge from identity** —
> not the other way around.

### §0.1 Identity Anchor

**You are a motion designer who has studied the motion archives of Anthropic / Apple / Pentagram / Field.io.**

When you make animation, you're not tuning CSS transitions — you're using digital elements to **simulate a physical world**,
making the viewer's subconscious believe "this is an object with weight, with inertia, that can overshoot."

You don't make PowerPoint-style animation. You don't make "fade in fade out" animation. The animation you make **makes people believe the screen
is a space they can reach into**.

### §0.2 Core Beliefs (3)

1. **Animation is physics, not animation curves**
   `linear` is a number, `expoOut` is an object. You believe the pixels on screen deserve to be treated as "objects."
   Every easing choice is answering the physics question "how heavy is this element? how large is its friction coefficient?"

2. **Time allocation matters more than curve shape**
   Slow-Fast-Boom-Stop is your breathing. **Animation with even pacing is a tech demo; animation with rhythm is narrative.**
   Slowing down at the right moment matters more than using the right easing at the wrong moment.

3. **Yielding to the viewer is harder than showing off**
   A 0.5-second pause before a key result is **technique**, not a compromise. **Giving the human brain reaction time is the animator's highest virtue.**
   By default, AI makes a pause-free, max-information-density animation — that's the novice. What you must do is restrain.

### §0.3 Taste Standard · What Is Beautiful

Your criteria for judging "good" versus "great" are as follows. Each has a **way to recognize it** — when you see a candidate animation,
use these questions to judge whether it's up to standard, rather than mechanically checking against 14 rules.

| Dimension of Beauty | How to Recognize It (viewer reaction) |
|---|---|
| **Physical weight** | When the animation ends, the element "**lands**" steadily — it doesn't "**stop**" there. The viewer's subconscious feels "this has weight" |
| **Yielding to the viewer** | Before key info appears there's a perceptible pause (≥300ms) — the viewer has time to "**see it**" before continuing |
| **White space** | The ending is an abrupt cut + hold, not a fade to black. The final frame is clear, affirmative, with a sense of decision |
| **Restraint** | The whole piece has only one spot at "120% refinement," the other 80% is just right — **showing off everywhere is a cheap signal** |
| **Hand-feel** | Arcs (not straight lines), irregularity (not a setInterval mechanical rhythm), a sense of breathing |
| **Respect** | Show the tweaking process, show the bug fix — **don't hide the work, don't grant "magic."** AI is a collaborator, not a magician |

### §0.4 Self-Check · The Viewer's First-Reaction Method

After finishing an animation, **what is the viewer's first reaction after watching?** — this is the only metric you should optimize.

| Viewer Reaction | Rating | Diagnosis |
|---|---|---|
| "Looks pretty smooth" | good | Passable but featureless, you're making PowerPoint |
| "This animation is really fluid" | good+ | The technique is right, but nothing wowed |
| "This thing really looks like it's **floating up off the desktop**" | great | You touched physical weight |
| "This doesn't look like it was made by AI" | great+ | You touched the Anthropic threshold |
| "I want to **screenshot** this and post it" | great++ | You got the viewer to spread it on their own |

**The difference between great and good is not technical correctness, it's taste judgment**. Technically correct + right taste = great.
Technically correct + empty taste = good. Technically wrong = never got started.

### §0.5 The Relationship Between Identity and Rules

The technical rules in §1-§8 below are this identity's **execution means** in specific scenarios — not a standalone rule list.

- Hit a scenario the rules don't cover → go back to §0, judge with **identity**, don't guess wildly
- Hit a conflict between rules → go back to §0, judge with the **taste standard** which one matters more
- Want to break a rule → first answer: "Which beauty in §0.3 does doing this serve?" If you can answer, break it; if not, don't

Good. Keep reading.

---

## Overview · Animation Is Physics, Unfolded in Three Layers

The root of the cheap feeling in most AI-generated animation is — **they behave like "numbers," not "objects."**
Real-world objects have mass, inertia, elasticity, and overshoot. The root of the "premium feel" in Anthropic's three films
lies in giving digital elements a set of **physical-world motion rules**.

These rules have 3 layers:

1. **Narrative rhythm layer**: the time allocation of Slow-Fast-Boom-Stop
2. **Motion curve layer**: Expo Out / Overshoot / Spring, rejecting linear
3. **Expressive language layer**: showing the process, mouse arcs, logo morph-and-converge

---

## 1. Narrative Rhythm · The Slow-Fast-Boom-Stop 5-Stage Structure

Anthropic's three films, without exception, follow this structure:

| Stage | Share | Rhythm | Function |
|---|---|---|---|
| **S1 Trigger** | ~15% | slow | Give the human reaction time, establish realness |
| **S2 Generate** | ~15% | medium | The visual wow point appears |
| **S3 Process** | ~40% | fast | Show controllability / density / detail |
| **S4 Burst** | ~20% | Boom | Camera pulls back / 3D pop-out / multi-panel surge |
| **S5 Landing** | ~10% | still | Brand logo + abrupt cut |

**Concrete duration mapping** (using a 15-second animation as an example):
S1 Trigger 2s · S2 Generate 2s · S3 Process 6s · S4 Burst 3s · S5 Landing 2s

**Things you must not do**:
- ❌ Even rhythm (the same information density every second) — viewer fatigue
- ❌ Sustained high density — no peak, no memory point
- ❌ Fade-out ending (fade out to transparent) — it should be an **abrupt cut**

**Self-check**: with pen and paper, sketch 5 thumbnails, each representing the climax frame of one stage. If the 5 images don't differ much,
it means the rhythm didn't come through.

---

## 2. Easing Philosophy · Reject linear, Embrace Physics

All the motion in Anthropic's three films uses Bézier curves with a "damped" feel. The default cubic easeOut
(`1-(1-t)³`) is **not sharp enough** — the launch isn't fast enough, the stop isn't steady enough.

### Three Core Easings (built into animations.jsx)

```js
// 1. Expo Out · fast launch, slow brake (most common, default main easing)
// Maps to CSS: cubic-bezier(0.16, 1, 0.3, 1)
Easing.expoOut(t) // = t === 1 ? 1 : 1 - Math.pow(2, -10 * t)

// 2. Overshoot · elastic toggle/button pop-out
// Maps to CSS: cubic-bezier(0.34, 1.56, 0.64, 1)
Easing.overshoot(t)

// 3. Spring physics · geometry settling into place, natural landing
Easing.spring(t)
```

### Usage Mapping

| Scenario | Which Easing to Use |
|---|---|
| Card rise-in / panel entrance / Terminal fade / focus overlay | **`expoOut`** (main easing, most common) |
| Toggle switching / button pop-out / emphasis interaction | `overshoot` |
| Preview geometry settling / physical landing / UI element bounce | `spring` |
| Continuous motion (e.g. mouse-trajectory interpolation) | `easeInOut` (preserves symmetry) |

### Counterintuitive Insight

The animation in most product promos is **too fast and too hard**. `linear` makes digital elements feel like machines, `easeOut` is the baseline score,
and `expoOut` is the technical root of the "premium feel" — it gives digital elements a kind of **physical-world weight**.

---

## 3. Motion Language · 8 Shared Principles

### 3.1 Don't Use Pure Black or Pure White for the Base

None of Anthropic's three films uses `#FFFFFF` or `#000000` as the main base color. **A neutral color with color temperature**
(warm or cool) has a "paper / canvas / desktop" material quality that weakens the machine feel.

**Concrete color-value decisions** go through §1.a the Core Asset Protocol (extracted from the brand spec) or the "Design Direction Advisor"
(each of the 20 philosophies has its own base-color scheme). This reference gives no concrete color values — that's a **brand decision**, not a motion rule.

### 3.2 Easing Is Never linear

See §2.

### 3.3 Slow-Fast-Boom-Stop Narrative

See §1.

### 3.4 Show the "Process," Not the "Magic Result"

- Claude Design shows tweaking parameters, dragging sliders (not one-click perfect generation)
- Claude Code shows code errors + AI fixing them (not first-try success)
- Claude for Word shows the Redline red-delete/green-add editing process (not handing over the final draft directly)

**Shared subtext**: the product is a **collaborator, a pair-engineer, a senior editor** — not a one-click magician.
This precisely hits professional users' pain points about "controllability" and "authenticity."

**Anti-AI-slop**: by default AI makes a "magic one-click success" animation (one click to generate → perfect result),
which is the universal common denominator. **Do the reverse** — show the process, show the tweaking, show the bug and the fix —
that's the source of brand recognizability.

### 3.5 Hand-Draw the Mouse Trajectory (arc + Perlin Noise)

A real person's mouse movement isn't a straight line; it's "accelerate from rest → arc → decelerate-correct → click."
A mouse trajectory that AI interpolates straight has a **subconscious off-putting feel**.

```js
// Quadratic Bézier curve interpolation (start → control point → end)
function bezierQuadratic(p0, p1, p2, t) {
  const x = (1-t)*(1-t)*p0[0] + 2*(1-t)*t*p1[0] + t*t*p2[0];
  const y = (1-t)*(1-t)*p0[1] + 2*(1-t)*t*p1[1] + t*t*p2[1];
  return [x, y];
}

// Path: start → off-center midpoint → end (makes an arc)
const path = [[100, 100], [targetX - 200, targetY + 80], [targetX, targetY]];

// Then overlay tiny Perlin Noise (±2px) to create the "hand tremble"
const jitterX = (simpleNoise(t * 10) - 0.5) * 4;
const jitterY = (simpleNoise(t * 10 + 100) - 0.5) * 4;
```

### 3.6 Logo "Morph-and-Converge" (Morph)

The logo entrance in Anthropic's three films is **never a simple fade-in**; it's **morphed from the previous visual element**.

**Shared pattern**: in the final 1-2 seconds, do a Morph / Rotate / Converge, letting the whole narrative "collapse" onto the brand point.

**Low-cost implementation** (without a real morph):
let the previous visual element "collapse" into a color block (scale → 0.1, translate toward center),
then the block "expands" out into the wordmark. Use a 150ms hard cut for the transition + motion blur
(`filter: blur(6px)` → `0`).

```js
<Sprite start={13} end={14}>
  {/* Collapse: previous element scales to 0.1, opacity held, filter blur increases */}
  const scale = interpolate(t, [0, 0.5], [1, 0.1], Easing.expoOut);
  const blur = interpolate(t, [0, 0.5], [0, 6]);
</Sprite>
<Sprite start={13.5} end={15}>
  {/* Expand: logo scales 0.1 → 1 from the block center, blur 6 → 0 */}
  const scale = interpolate(t, [0, 0.6], [0.1, 1], Easing.overshoot);
  const blur = interpolate(t, [0, 0.6], [6, 0]);
</Sprite>
```

### 3.7 Serif + Sans-Serif Dual Fonts

- **Brand / narration**: serif (carries "academic feel / publication feel / taste")
- **UI / code / data**: sans-serif + monospace

**A single font is always wrong**. Serif gives "taste," sans-serif gives "function."

Concrete font choices go through the brand spec (the Display / Body / Mono three-stack of brand-spec.md) or the Design Direction
Advisor's 20 philosophies. This reference gives no concrete fonts — that's a **brand decision**.

### 3.8 Focus Switching = Background Weakening + Foreground Sharpening + Flash Guidance

Focus switching is **not just** lowering opacity. The full recipe is:

```js
// Filter combination for non-focus elements
tile.style.filter = `
  brightness(${1 - 0.5 * focusIntensity})
  saturate(${1 - 0.3 * focusIntensity})
  blur(${focusIntensity * 4}px)        // ← key: only with blur does it really "recede"
`;
tile.style.opacity = 0.4 + 0.6 * (1 - focusIntensity);

// After focus completes, do a 150ms Flash highlight at the focus position to guide the gaze back
focusOverlay.animate([
  { background: 'rgba(255,255,255,0.3)' },
  { background: 'rgba(255,255,255,0)' }
], { duration: 150, easing: 'ease-out' });
```

**Why blur is mandatory**: relying only on opacity + brightness, the off-focus elements are still "sharp,"
and there's no visual "recede into the background" effect. blur(4-8px) makes the non-focus elements really step back one layer of depth of field.

---

## 4. Concrete Motion Techniques (code snippets you can copy directly)

### 4.1 FLIP / Shared Element Transition

The button "expands" into the input box; it's **not** the button disappearing + a new panel appearing. The core is **the same DOM element**
transitioning between two states, not two elements cross-fading.

```jsx
// Use Framer Motion layoutId
<motion.div layoutId="design-button">Design</motion.div>
// ↓ after click, same layoutId
<motion.div layoutId="design-button">
  <input placeholder="Describe your design..." />
</motion.div>
```

Native implementation reference: https://aerotwist.com/blog/flip-your-animations/

### 4.2 "Breathing-Style" Expansion (width→height)

A panel expanding is **not pulling width and height at the same time**; instead:
- First 40% of the time: only pull width (keep height small)
- Last 60% of the time: width holds, push out height

This simulates the physical-world feeling of "open first, then fill with water."

```js
const widthT = interpolate(t, [0, 0.4], [0, 1], Easing.expoOut);
const heightT = interpolate(t, [0.3, 1], [0, 1], Easing.expoOut);
style.width = `${widthT * targetW}px`;
style.height = `${heightT * targetH}px`;
```

### 4.3 Staggered Fade-up (30ms stagger)

When table rows, card columns, or list items enter, **each element is delayed by 30ms**, with `translateY` going from 10px back to 0.

```js
rows.forEach((row, i) => {
  const localT = Math.max(0, t - i * 0.03);  // 30ms stagger
  row.style.opacity = interpolate(localT, [0, 0.3], [0, 1], Easing.expoOut);
  row.style.transform = `translateY(${
    interpolate(localT, [0, 0.3], [10, 0], Easing.expoOut)
  }px)`;
});
```

### 4.4 Nonlinear Breathing · Hover 0.5s Before the Key Result

The machine executes fast and continuously, but **hover 0.5 seconds before the key result appears** to give the viewer's brain reaction time.

```jsx
// Typical scenario: AI finishes generating → hover 0.5s → result emerges
<Sprite start={8} end={8.5}>
  {/* 0.5s pause — nothing moves, let the viewer stare at the loading state */}
  <LoadingState />
</Sprite>
<Sprite start={8.5} end={10}>
  <ResultAppear />
</Sprite>
```

**Counter-example**: AI finishes generating and instantly, seamlessly cuts to the result — the viewer has no reaction time, information is lost.

### 4.5 Chunk Reveal · Simulating Token Streaming

AI-generated text **should not use `setInterval` to pop out one character at a time** (like old-movie subtitles); use **chunk reveal**
— 2-5 characters appearing at once, with irregular intervals, simulating real token streaming output.

```js
// Split into chunks rather than characters
const chunks = text.split(/(\s+|,\s*|\.\s*|;\s*)/);  // split by word + punctuation
let i = 0;
function reveal() {
  if (i >= chunks.length) return;
  element.textContent += chunks[i++];
  const delay = 40 + Math.random() * 80;  // irregular 40-120ms
  setTimeout(reveal, delay);
}
reveal();
```

### 4.6 Anticipation → Action → Follow-through

3 of Disney's 12 principles. Anthropic uses them very explicitly:

- **Anticipation**: a small reverse motion before the action begins (a button shrinks slightly then pops out)
- **Action**: the main action itself
- **Follow-through**: an aftermath after the action ends (a card lands and bounces slightly)

```js
// The complete three stages of a card entrance
const anticip = interpolate(t, [0, 0.2], [1, 0.95], Easing.easeIn);     // anticipation
const action  = interpolate(t, [0.2, 0.7], [0.95, 1.05], Easing.expoOut); // action
const settle  = interpolate(t, [0.7, 1], [1.05, 1], Easing.spring);       // settle
// Final scale = product of the three stages, or applied piecewise
```

**Counter-example**: animation with only Action, no Anticipation + Follow-through, looks like "PowerPoint animation."

### 4.7 3D Perspective + translateZ Layering

For the vibe of "tilted 3D + floating cards," give the container a perspective and give individual elements different translateZ values:

```css
.stage-wrap {
  perspective: 2400px;
  perspective-origin: 50% 30%;  /* line of sight slightly looking down */
}
.card-grid {
  transform-style: preserve-3d;
  transform: rotateX(8deg) rotateY(-4deg);  /* golden ratio */
}
.card:nth-child(3n) { transform: translateZ(30px); }
.card:nth-child(5n) { transform: translateZ(-20px); }
.card:nth-child(7n) { transform: translateZ(60px); }
```

**Why rotateX 8° / rotateY -4° is the golden ratio**:
- Greater than 10° → the elements feel over-distorted, they look like they're "falling over"
- Less than 5° → it looks like "shearing" rather than "perspective"
- The 8° × -4° asymmetric ratio simulates the natural angle of "a camera looking down from the top-left corner of the desk"

### 4.8 Diagonal Pan · Move XY at the Same Time

Camera motion isn't purely up-down or purely left-right; instead, **move XY at the same time** to simulate diagonal movement:

```js
const panX = Math.sin(flowT * 0.22) * 40;
const panY = Math.sin(flowT * 0.35) * 30;
stage.style.transform = `
  translate(-50%, -50%)
  rotateX(8deg) rotateY(-4deg)
  translate3d(${panX}px, ${panY}px, 0)
`;
```

**Key**: X and Y have different frequencies (0.22 vs 0.35), avoiding the Lissajous loop becoming regularized.

---

## 5. Scene Recipes (three narrative templates)

The three videos in the reference material correspond to three product personalities. **Pick the one that best fits your product**, don't mix and match.

### Recipe A · Apple Keynote Dramatic (Claude Design type)

**Good for**: major version releases, hero animations, visual-wow priority
**Rhythm**: Slow-Fast-Boom-Stop, strong arc
**Easing**: `expoOut` throughout + a little `overshoot`
**SFX density**: high (~0.4/s), SFX pitch tuned to the BGM scale
**BGM**: IDM / minimal tech electronic, calm + precise
**Closing**: camera pulls back fast → drop → logo morph → an ethereal single note → abrupt cut

### Recipe B · One-Take Tool Style (Claude Code type)

**Good for**: developer tools, productivity Apps, flow-state scenarios
**Rhythm**: sustained, steady flow, no obvious peak
**Easing**: `spring` physics + `expoOut`
**SFX density**: **0** (drive the editing rhythm purely with BGM)
**BGM**: Lo-fi Hip-hop / Boom-bap, 85-90 BPM
**Core technique**: land key UI actions on the BGM kick/snare transients — "**the musical groove is the interaction SFX**"

### Recipe C · Office Efficiency Narrative (Claude for Word type)

**Good for**: enterprise software, document/spreadsheet/calendar types, professionalism priority
**Rhythm**: multi-scene hard cuts + Dolly In/Out
**Easing**: `overshoot` (toggle) + `expoOut` (panel)
**SFX density**: medium (~0.3/s), mainly UI clicks
**BGM**: Jazzy Instrumental, minor key, BPM 90-95
**Core highlight**: one scene must have the "whole-piece highlight" — 3D pop-out / floating up off the plane

---

## 6. Counter-Examples · Doing This Is AI Slop

| Anti-pattern | Why It's Wrong | Correct Approach |
|---|---|---|
| `transition: all 0.3s ease` | `ease` is a cousin of linear, all elements at the same speed | Use `expoOut` + per-element stagger |
| All entrances `opacity 0→1` | No sense of motion direction | Pair with `translateY 10→0` + Anticipation |
| Logo fade-in | No sense of narrative convergence | Morph / Converge / collapse-expand |
| Mouse moving in a straight line | Subconscious machine feel | Bézier arc + Perlin Noise |
| Typing pops out one character at a time (setInterval) | Like old-movie subtitles | Chunk Reveal, random intervals |
| No hover before the key result | The viewer has no reaction time | 0.5s hover before the result |
| Focus switching only changes opacity | Off-focus elements are still sharp | opacity + brightness + **blur** |
| Pure black base / pure white base | Cyber feel / glare fatigue | Neutral color with color temperature (via the brand spec) |
| All animation equally fast | No rhythm | Slow-Fast-Boom-Stop |
| Fade-out ending | No sense of decision | Abrupt cut (hold the final frame) |

---

## 7. Self-Check List (60 seconds before animation delivery)

- [ ] Is the narrative structure Slow-Fast-Boom-Stop, not even pacing?
- [ ] Is the default easing `expoOut`, not `easeOut` or `linear`?
- [ ] Did the toggle / button pop-out use `overshoot`?
- [ ] Do the card / list entrances have a 30ms stagger?
- [ ] Is there a 0.5s hover before the key result?
- [ ] Does typing use Chunk Reveal, not setInterval single-character?
- [ ] Did focus switching add blur (not just opacity)?
- [ ] Is the logo a morph-and-converge (Morph), not a fade-in?
- [ ] Is the base color not pure black / pure white (has color temperature)?
- [ ] Does the type have a serif + sans-serif hierarchy?
- [ ] Is the ending an abrupt cut, not a fade-out?
- [ ] (If there's a mouse) Is the mouse trajectory an arc, not a straight line?
- [ ] Does the SFX density match the product personality (see Recipes A/B/C)?
- [ ] Do BGM and SFX have a 6-8dB loudness difference? (see `audio-design-rules.md`)

---

## 8. Relationship to Other References

| reference | Position | Relationship |
|---|---|---|
| `animation-pitfalls.md` | Technical trap-avoidance (16 items) | "**don't do it this way**" · the flip side of this file |
| `animations.md` | Stage/Sprite engine usage | The basics of **how to write** animation |
| `audio-design-rules.md` | Dual-track audio rules | The rules for **adding audio** to animation |
| `sfx-library.md` | A list of 37 SFX | The SFX **asset library** |
| `apple-gallery-showcase.md` | Apple gallery display style | A deep-dive on one specific motion style |
| **This file** | Forward motion design syntax | "**do it this way**" |

**Call order**:
1. First look at the position-four-questions in SKILL.md workflow Step 3 (decide the narrative role and visual temperature)
2. After choosing a direction, read this file to fix the **motion language** (Recipe A/B/C)
3. When writing code, refer to `animations.md` and `animation-pitfalls.md`
4. When exporting the video, go through `audio-design-rules.md` + `sfx-library.md`

---

## Appendix · Material Sources for This File

- Anthropic official animation teardown: `参考动画/BEST-PRACTICES.md` in Huashu's project directory
- Anthropic audio teardown: `AUDIO-BEST-PRACTICES.md` in the same directory
- 3 reference videos: `ref-{1,2,3}.mp4` + corresponding `gemini-ref-*.md` / `audio-ref-*.md`
- **Strict filtering**: this reference collects no concrete brand color values, font names, or product names.
  Color/font decisions go through §1.a the Core Asset Protocol or the 20 design philosophies.
