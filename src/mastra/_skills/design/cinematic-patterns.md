# Cinematic Patterns · Best Practices for Workflow Demos

> 5 key patterns to upgrade from "PPT animations" to "release-level cinematics".
> Distilled from two cinematic demos (Nuwa workflow + Darwin workflow) in the 2026-04 "Talking about skills" deck, verified to be reproducible.

---

## 0 · What this document solves

When you need to create an "animation demo for a workflow" (typical scenarios: skill workflows, product onboarding, API call processes, agent task execution), there are two common approaches:

| Paradigm | What it looks like | Consequence |
|---|---|---|
| **PPT Animation** (Poor) | step 1 fade in → step 2 fade in → step 3 fade in, 4 boxes arranged on screen | Audience feels "it's just a PPT with fade effects," no wow moment |
| **Cinematic** (Good) | scene-based, focuses on one thing at a time, scenes transition with dissolve / focus pull / morph | Audience feels "this is a product launch segment," will want to screenshot and share |

The root cause of the difference is **not animation technology**, but **narrative paradigm**. This document explains how to upgrade from the former to the latter.

---

## 1 · Five Core Patterns

### Pattern A · Dashboard + Cinematic Overlay Dual-Layer Structure

**Problem**: A pure cinematic defaults to a black screen with a ▶ button; if the user doesn't click it on this page, they see nothing.

**Solution**:
```
DEFAULT state (always visible): complete static workflow dashboard
  └── Audience can instantly understand how this skill / workflow runs

POINT ▶ trigger (overlay floats up): 22-second cinematic
  └── Automatically fades back to DEFAULT after running

```

**Implementation points**:
- `.dash` is visible by default, `.cinema` defaults to `opacity: 0; pointer-events: none`
- `.play-cta` is the small golden button in the bottom right (not the large central overlay)
- Click → `cinema.classList.add('show')` + `dash.classList.add('hide')`
- Use `requestAnimationFrame` to run once (not a loop), then `endCinematic()` reverses the state

**Anti-pattern**: Default = large central ▶ overlay covers everything, page is blank until clicked.

---

### Pattern B · Scene-based, NOT Step-based

**Problem**: Breaking an animation into "step 1 shows → step 2 shows → ..." is PPT thinking.

**Solution**: Break it into 5 scenes, where each scene is an **independent shot**, focusing on one thing full-screen:

| Scene Type | Responsibility | Duration |
|---|---|---|
| 1 · Invoke | User input trigger (terminal typewriter) | 3-4s |
| 2 · Process | Visualization of the core workflow (unique visual language) | 5-6s |
| 3 · Result/Insight | Key output extracted (visualization) | 4-5s |
| 4 · Output | Actual output display (file / diff / numbers) | 3-4s |
| 5 · Hero Reveal | Concluding hero moment (large text + value proposition) | 4-5s |

**Total duration ≈ 22 seconds** — this is the tested golden length:
- Shorter than 18 seconds: PM hasn't gotten into it before it ends
- Longer than 25 seconds: Loses patience
- 22 seconds is just enough to "hook → unfold → conclude → leave an impression"

**Implementation points**:
- `T = { DURATION: 22.0, s1_in: [0, 0.7], s2_in: [3.8, 4.6], ... }` global timeline
- A single `requestAnimationFrame(render)` runs opacity / transform calculations for all scenes
- Do not use `setTimeout` chains (prone to breaking, difficult to debug)
- Easing must use `expoOut` / `easeOut` / cubic-bezier, **linear is forbidden**

---

### Pattern C · Each demo's visual language must be independent

**Problem**: After completing the first cinematic, you get lazy and reuse the same template for the second (same orbit + pentagon + typewriter + hero large text), only changing the copy.

**Consequence**: The audience finds that the two skills "look exactly the same," implying "these two skills are indistinguishable."

**Solution**: The core metaphor of each workflow is different, so the visual language must be different.

**Comparison cases**:

| Dimension | Nuwa (Distillation Agent) | Darwin (Skill Optimization) |
|---|---|---|
| Core Metaphor | Collect → Refine → Write | Loop → Evaluate → Ratchet |
| Visual Movement | Float / Radiate / Pentagon | Loop / Ascend / Contrast |
| Scene 2 | 3D Orbit · 8 archive cards floating in perspective ellipse | Spin Loop · tokens run 5 circles along 6-node ring |
| Scene 3 | Pentagon · 5 tokens radiate from center | v1 vs v5 · Side-by-side diff (red version vs gold version) |
| Scene 4 | SKILL.md typewriter | Hill-Climb · Full-screen curve drawing |
| Scene 5 hero | "21 minutes" serif italic large text | Rotating gear ⚙ + "KEPT +1.1" golden tag |

**Judgment standard**: Cover the text, only look at the visuals, can you distinguish which demo this is? If not, you're being lazy.

---

### Pattern D · Use AI-generated real assets, not emojis or hand-drawn SVGs

**Problem**: 3D orbit / gallery needs asset fragments to float, emojis (📚🎤) are ugly and unbranded, hand-drawn SVG book spines never look like real books.

**Solution**: Use `huashu-gpt-image` to generate a 4×2 grid large image (8 theme-related items · white background · 60px breathing space · unified style), then use `extract_grid.py --mode bbox` to cut them into 8 independent transparent PNGs.

**Prompt key points** (detailed prompt patterns see `huashu-gpt-image` skill):
- IP anchoring ("1960s Caltech archive aesthetic" / "Hearthstone-style consistent treatment")
- White background (easy for cutting, gray background is good for atmosphere but difficult to cut transparent backgrounds)
- 4×2 not 5×5 (avoids last row compression bug)
- Persona finishing ("You are a Wired magazine curator preparing an exhibition photo")

**Anti-pattern**: Using emojis as icons, using CSS silhouettes instead of product images.

---

### Pattern E · BGM + SFX Dual-Track System

**Problem**: Only animation, no sound, audience subconsciously feels "this thing looks like a cheap demo."

**Solution**: BGM long tone + 11 SFX cues.

**General SFX cue recipe** (applicable to workflow demos):

| Timestamp | SFX | Trigger Scene |
|---|---|---|
| 0.10s | whoosh | Terminal rises from below |
| 3.0s | enter | Typewriter completes, press enter |
| 4.0s | slide-in | Scene 2 elements enter |
| 5-9s × 5 times | sparkle | Key process nodes (each generation / each token / each data point) |
| 14s | click | Switch to output scene |
| 17.8s | logo-reveal | Hero reveal moment |
| typewriter | type | Trigger once every 2 characters (don't make density too high) |

**Frequency band isolation**: BGM volume 0.32 (low-frequency background noise), SFX volume 0.55 (mid-high frequency punch), sparkle 0.7 (should be noticeable), logo-reveal 0.85 (strongest hero moment).

**User control**:
- Must have a ▶ start overlay (browser autoplay restrictions)
- Small mute button in the top right (user can switch to mute at any time)
- Do not make it "force sound when you flip to this page"

---

## 2 · Static Dashboard Design Points

The Dashboard is Layer 1 of the dual-layer structure; PMs can understand the skill without clicking ▶.

**Layout**: 3-column grid (or 1 large + 2 small), each panel solves a problem:

| Panel Type | What problem it solves | Example |
|---|---|---|
| **Pipeline / Flow Diagram** | "What is the workflow of this skill?" | Nuwa 4-stage pipeline · Darwin autoresearch loop |
| **Snapshot / State** | "What does the real data look like when run?" | Darwin 8-dimension rubric snapshot |
| **Trajectory / Evolution** | "How does it change after multiple runs?" | Darwin 5-generation hill-climb curve |
| **Examples / Gallery** | "What has already been produced?" | Nuwa 21 personas gallery |
| **Strip · Example I/O** | "What input → what output" | Nuwa example strip: `› nuwa distill Feynman → feynman.skill (21 min)` |

**Key constraints**:
- Information density must be sufficient (each panel must carry differentiated information)
- But cannot be data slop (every number must be meaningful)
- Color scheme consistent with cinematic (same color family, for seamless switching)

---

## 3 · Debugging and Development Tools

Any long animation must be equipped with three dev tools, otherwise debugging will explode.

### Tool 1 · `?seek=N` Freeze to N seconds

```js
const seek = parseFloat(params.get('seek'));
if (!isNaN(seek)) {
  started = true; muted = true;
  frozenT = seek;  // render() uses this t instead of elapsed
  cinema.classList.add('show'); dash.classList.add('hide');
}

// render() inside:
let t = frozenT !== null ? frozenT : (elapsed % T.DURATION);
```

Usage: `http://.../slide.html?seek=12` directly view the screen at 12 seconds, no need to wait for playback.

### Tool 2 · `?autoplay=1` Skip ▶ overlay

Convenient for playwright automated screenshot testing, and also for force-starting when embedded in an iframe.

### Tool 3 · Manual REPLAY button

Small button in the top right, users/debuggers can replay any number of times. CSS:

```css
.replay{position:absolute;top:18px;right:18px;background:rgba(212,165,116,0.1);
  border:1px solid rgba(212,165,116,0.3);color:#D4A574;
  font-family:monospace;font-size:10px;letter-spacing:.28em;text-transform:uppercase;
  padding:6px 12px;border-radius:1px;cursor:pointer;backdrop-filter:blur(6px);z-index:6}
```

---

## 4 · iframe Embedding Pitfalls (if cinematic is embedded in deck)

### Pitfall 1 · Parent window's click zone intercepts iframe internal buttons

If the deck index.html adds "left/right 22vw transparent click zones for page turning," it will **overlap the ▶ play button inside the iframe** — clicking the button will be swallowed as "next page."

**Fix**: Add `top: 12vh; bottom: 25vh` to the click zone, leaving the top and bottom 25% unobstructed, so that both the central ▶ and bottom-right ▶ buttons inside the iframe can be clicked.

### Pitfall 2 · Keyboard events lost after iframe grabs focus

After the user clicks the iframe, focus is inside the iframe, and the parent window's ←/→ keyboard events are not received.

**Fix**:
```js
iframe.addEventListener('load', () => {
  // Inject keyboard forwarder
  const doc = iframe.contentDocument;
  doc.addEventListener('keydown', (e) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, ... }));
  });
  // Pull focus back to parent window after click
  doc.addEventListener('click', () => setTimeout(() => window.focus(), 0));
});
```

### Pitfall 3 · file:// vs https:// behavior differences

A cinematic tested locally with file:// might break after deployment, because:
- Under file://, iframe contentDocument is same-origin
- Under https://, it's also same-origin (if same host), but audio autoplay restrictions are stricter

**Fix**:
- Before deployment, test it locally with `python3 -m http.server` to start a local HTTP server
- BGM must `bgm.play()` only after the user clicks ▶, not immediately on page-load

---

## 5 · Anti-Pattern Quick Reference

| ❌ Anti-pattern | ✅ Correct pattern |
|---|---|
| Default = black screen ▶ overlay | Default = static dashboard, ▶ is supplementary |
| 4 steps arranged horizontally on screen fade in | 5 full-screen scene transitions, each scene focuses on one thing |
| Reusing templates and changing copy for different demos | Each demo has an independent visual language (can be distinguished by covering text) |
| Emojis / hand-drawn SVGs as assets | gpt-image-2 large image + extract_grid for cutting |
| No BGM, no SFX | BGM + 11 SFX cues dual-track system |
| Using `setTimeout` chains for scheduling | `requestAnimationFrame` + global timeline T object |
| Linear animation | Expo / cubic-bezier easing |
| No dev tools | `?seek=N` + `?autoplay=1` + REPLAY button |
| iframe internal buttons intercepted by parent click zone | Add top/bottom margins to click zone to make way for buttons |

---

## 6 · Time Budget

Following this set of patterns, a complete cinematic demo (including dashboard):

| Task | Time |
|---|---|
| Design 5-scene narrative + visual language | 30 minutes (be cautious, determines independence) |
| Dashboard static layout + content | 1 hour |
| Cinematic 5 scenes implementation | 1.5 hours |
| Audio cues timing + replay button | 30 minutes |
| Playwright screenshot verification of 5 key moments | 15 minutes |
| **Total for a single demo** | **3-4 hours** |

The second demo reuses the framework but **visual language must be independent**, time approximately 2-3 hours.