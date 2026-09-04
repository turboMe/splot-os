# Apple Gallery Showcase · Gallery Display Wall Animation Style

> Inspiration: Claude Design official site hero video + Apple product-page "gallery wall" style display
> Production origin: huashu-design release hero v5
> Use cases: **product release hero animations, skill capability demos, portfolio showcases** — any scenario where you need to display "multiple high-quality outputs" simultaneously while guiding the viewer's attention

---

## Trigger Judgment: When to Use This Style

**Good fit**:
- You have 10+ real outputs to display on one screen (PPT, App, web pages, infographics)
- The audience is professional (developers, designers, product managers), sensitive to "craft / texture"
- The desired vibe is "restrained, exhibition-style, premium, with a sense of space"
- You need focus and the overall view to coexist (see details without losing the whole)

**Bad fit**:
- Single-product focus (use frontend-design's product hero template)
- Emotion-driven / strongly narrative animation (use the timeline narrative template)
- Small screen / portrait orientation (the tilted perspective gets blurry on small canvases)

---

## Core Visual Tokens

```css
:root {
  /* Light-mode gallery palette */
  --bg:         #F5F5F7;   /* main canvas base — Apple site gray */
  --bg-warm:    #FAF9F5;   /* warm off-white variant */
  --ink:        #1D1D1F;   /* main text color */
  --ink-80:     #3A3A3D;
  --ink-60:     #545458;
  --muted:      #86868B;   /* secondary text */
  --dim:        #C7C7CC;
  --hairline:   #E5E5EA;   /* card 1px border */
  --accent:     #D97757;   /* terracotta orange — Claude brand */
  --accent-deep:#B85D3D;

  --serif-cn: "Noto Serif SC", "Songti SC", Georgia, serif;
  --serif-en: "Source Serif 4", "Tiempos Headline", Georgia, serif;
  --sans:     "Inter", -apple-system, "PingFang SC", system-ui;
  --mono:     "JetBrains Mono", "SF Mono", ui-monospace;
}
```

**Key principles**:
1. **Never use a pure-black base**. A black base makes the work look like a movie, not like "a deliverable that can be adopted."
2. **Terracotta orange is the only hue accent**; everything else is grayscale + white.
3. **Three-font stack** (serif EN + serif CN + sans + mono) creates the vibe of a "publication" rather than an "internet product."

---

## Core Layout Patterns

### 1. Floating Card (the basic unit of the whole style)

```css
.gallery-card {
  background: #FFFFFF;
  border-radius: 14px;
  padding: 6px;                          /* the padding is the "mounting paper" */
  border: 1px solid var(--hairline);
  box-shadow:
    0 20px 60px -20px rgba(29, 29, 31, 0.12),   /* main shadow, soft and long */
    0 6px 18px -6px rgba(29, 29, 31, 0.06);     /* second near-light layer, creates float */
  aspect-ratio: 16 / 9;                  /* unified slide ratio */
  overflow: hidden;
}
.gallery-card img {
  width: 100%; height: 100%;
  object-fit: cover;
  border-radius: 9px;                    /* slightly smaller than card radius, visual nesting */
}
```

**Anti-pattern**: don't use flush tiles (no padding, no border, no shadow) — that's infographic-density expression, not an exhibition.

### 2. 3D Tilted Gallery Wall

```css
.gallery-viewport {
  position: absolute; inset: 0;
  overflow: hidden;
  perspective: 2400px;                   /* deeper perspective, so the tilt isn't exaggerated */
  perspective-origin: 50% 45%;
}
.gallery-canvas {
  width: 4320px;                         /* canvas = 2.25× viewport */
  height: 2520px;                        /* leave room for pan */
  transform-origin: center center;
  transform: perspective(2400px)
             rotateX(14deg)              /* tilt back */
             rotateY(-10deg)             /* turn left */
             rotateZ(-2deg);             /* slight tilt, removes the too-regular look */
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 40px;
  padding: 60px;
}
```

**Parameter sweet spots**:
- rotateX: 10-15deg (any more and it looks like a wine-party VIP backdrop)
- rotateY: ±8-12deg (a sense of left-right symmetry)
- rotateZ: ±2-3deg (the human touch of "this wasn't placed by a machine")
- perspective: 2000-2800px (below 2000 gets fisheye, above 3000 approaches an orthographic projection)

### 3. 2×2 Four-Corner Convergence (selection scene)

```css
.grid22 {
  display: grid;
  grid-template-columns: repeat(2, 800px);
  gap: 56px 64px;
  align-items: start;
}
```

Each card slides in from its corresponding corner (tl/tr/bl/br) toward the center + fades in. The matching `cornerEntry` vectors:

```js
const cornerEntry = {
  tl: { dx: -700, dy: -500 },
  tr: { dx:  700, dy: -500 },
  bl: { dx: -700, dy:  500 },
  br: { dx:  700, dy:  500 },
};
```

---

## Five Core Animation Patterns

### Pattern A · Four-Corner Convergence (0.8-1.2s)

4 elements slide in from the four corners of the viewport, scaling 0.85→1.0 at the same time, with ease-out. Good for an opening that "presents multi-directional choices."

```js
const inP = easeOut(clampLerp(t, start, end));
card.style.transform = `translate3d(${(1-inP)*ce.dx}px, ${(1-inP)*ce.dy}px, 0) scale(${0.85 + 0.15*inP})`;
card.style.opacity = inP;
```

### Pattern B · Select & Enlarge + Others Slide Out (0.8s)

The selected card enlarges 1.0→1.28, while the other cards fade out + blur + drift back toward the corners:

```js
// Selected
card.style.transform = `translate3d(${cellDx*outP}px, ${cellDy*outP}px, 0) scale(${1 + 0.28*easeOut(zoomP)})`;
// Not selected
card.style.opacity = 1 - outP;
card.style.filter = `blur(${outP * 1.5}px)`;
```

**Key**: the non-selected cards must blur, not just plain fade. Blur simulates depth of field and visually "pushes the selected one forward."

### Pattern C · Ripple Expand (1.7s)

From the center outward, delayed by distance, each card fades in one after another + scales from 1.25x down to 0.94x ("camera pulling back"):

```js
const col = i % COLS, row = Math.floor(i / COLS);
const dc = col - (COLS-1)/2, dr = row - (ROWS-1)/2;
const dist = Math.sqrt(dc*dc + dr*dr);
const delay = (dist / maxDist) * 0.8;
const localT = Math.max(0, (t - rippleStart - delay) / 0.7);
card.style.opacity = easeOut(Math.min(1, localT));

// Meanwhile the whole gallery scales 1.25→0.94
const galleryScale = 1.25 - 0.31 * easeOut(rippleProgress);
```

### Pattern D · Sinusoidal Pan (continuous drift)

Combine a sine wave + linear drift to avoid the marquee-style "has a start and an end" loop feeling:

```js
const panX = Math.sin(panT * 0.12) * 220 - panT * 8;    // drift left horizontally
const panY = Math.cos(panT * 0.09) * 120 - panT * 5;    // drift up vertically
const clampedX = Math.max(-900, Math.min(900, panX));   // prevent revealing edges
```

**Parameters**:
- Sine period `0.09-0.15 rad/s` (slow, about one oscillation every 30-50 seconds)
- Linear drift `5-8 px/s` (slower than the viewer's blink)
- Amplitude `120-220 px` (large enough to feel, small enough not to cause dizziness)

### Pattern E · Focus Overlay (focus switching)

**Key design**: the focus overlay is a **flat element** (not tilted), floating above the tilted canvas. The selected slide scales from the tile position (about 400×225) to the screen center (960×540); the background canvas's tilt doesn't change but **darkens to 45%**:

```js
// Focus overlay (flat, centered)
focusOverlay.style.width = (startW + (endW - startW) * focusIntensity) + 'px';
focusOverlay.style.height = (startH + (endH - startH) * focusIntensity) + 'px';
focusOverlay.style.opacity = focusIntensity;

// Background cards darken but stay visible (key! don't use a 100% mask)
card.style.opacity = entryOp * (1 - 0.55 * focusIntensity);   // 1 → 0.45
card.style.filter = `brightness(${1 - 0.3 * focusIntensity})`;
```

**Clarity hard rules**:
- The focus overlay's `<img>` `src` must link directly to the original image — **do not reuse the compressed thumbnail from the gallery**
- Preload all original images into a `new Image()[]` array in advance
- The overlay's own `width/height` is computed per frame; the browser resamples the original image every frame

---

## Timeline Architecture (reusable skeleton)

```js
const T = {
  DURATION: 25.0,
  s1_in: [0.0, 0.8],    s1_type: [1.0, 3.2],  s1_out: [3.5, 4.0],
  s2_in: [3.9, 5.1],    s2_hold: [5.1, 7.0],  s2_out: [7.0, 7.8],
  s3_hold: [7.8, 8.3],  s3_ripple: [8.3, 10.0],
  panStart: 8.6,
  focuses: [
    { start: 11.0, end: 12.7, idx: 2  },
    { start: 13.3, end: 15.0, idx: 3  },
    { start: 15.6, end: 17.3, idx: 10 },
    { start: 17.9, end: 19.6, idx: 16 },
  ],
  s4_walloff: [21.1, 21.8], s4_in: [21.8, 22.7], s4_hold: [23.7, 25.0],
};

// Core easing
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
function lerp(time, start, end, fromV, toV, easing) {
  if (time <= start) return fromV;
  if (time >= end) return toV;
  let p = (time - start) / (end - start);
  if (easing) p = easing(p);
  return fromV + (toV - fromV) * p;
}

// A single render(t) function reads the timestamp and writes all elements
function render(t) { /* ... */ }
requestAnimationFrame(function tick(now) {
  const t = ((now - startMs) / 1000) % T.DURATION;
  render(t);
  requestAnimationFrame(tick);
});
```

**The essence of the architecture**: **all state is derived from the timestamp t** — no state machine, no setTimeout. This way:
- Playing to any moment via `window.__setTime(12.3)` jumps there instantly (convenient for frame-by-frame capture with playwright)
- The loop is naturally seamless (t mod DURATION)
- You can freeze any single frame when debugging

---

## Texture Details (easy to overlook but fatal)

### 1. SVG noise texture

A light base is most afraid of being "too flat." Overlay an extremely faint layer of fractalNoise:

```html
<style>
.stage::before {
  content: '';
  position: absolute; inset: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.078  0 0 0 0 0.078  0 0 0 0 0.074  0 0 0 0.035 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  opacity: 0.5;
  pointer-events: none;
  z-index: 30;
}
</style>
```

It looks like there's no difference — until you remove it, and then you know it was there.

### 2. Corner Brand Mark

```html
<div class="corner-brand">
  <div class="mark"></div>
  <div>HUASHU · DESIGN</div>
</div>
```

```css
.corner-brand {
  position: absolute; top: 48px; left: 72px;
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--muted);
}
```

Show it only during the gallery-wall scene, fading in and out. Like a museum exhibit label.

### 3. Brand Closing Wordmark

```css
.brand-wordmark {
  font-family: var(--sans);
  font-size: 148px;
  font-weight: 700;
  letter-spacing: -0.045em;   /* negative tracking is key; it pulls the letters tight into a mark */
}
.brand-wordmark .accent {
  color: var(--accent);
  font-weight: 500;           /* the accent characters are actually a bit thinner, a visual contrast */
}
```

`letter-spacing: -0.045em` is the standard practice for the big type on Apple product pages.

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| Looks like a PPT template | Cards have no shadow / hairline | Add the two-layer box-shadow + 1px border |
| The tilt looks cheap | Only used rotateY without rotateZ | Add ±2-3deg rotateZ to break the regularity |
| Pan feels "janky" | Used setTimeout or CSS keyframes loop | Use rAF + continuous sin/cos functions |
| Text unreadable during focus | Reused the low-res image from the gallery tile | Independent overlay + direct original-image src |
| Background too empty | Flat color `#F5F5F7` | Overlay SVG fractalNoise at 0.5 opacity |
| Type too "internet-y" | Only Inter | Add Serif (one each CN/EN) + mono, a three-stack |

---

## References

- Full implementation sample: hero-animation-v5.html (author's local sample, not distributed with the repo)
- Original inspiration: claude.ai/design hero video
- Aesthetic reference: Apple product pages, Dribbble shot collection pages

When you hit an animation need where "multiple high-quality outputs need to be displayed," just copy the skeleton from this file, swap the content + adjust the timing.
