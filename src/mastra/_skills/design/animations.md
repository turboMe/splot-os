# Animations: Timeline Animation Engine

Read this when creating HTML animations/motion designs. Covers principles, usage, and typical patterns.

## Core Pattern: Stage + Sprite

Our animation system (`assets/animations.jsx`) provides a timeline-driven engine:

- **`<Stage>`**: The container for the entire animation, automatically providing auto-scale (fit viewport) + scrubber + play/pause/loop controls.
- **`<Sprite start end>`**: A time segment. A Sprite is only displayed within the `start` to `end` duration. Internally, you can read its local progress `t` (0→1) using the `useSprite()` hook.
- **`useTime()`**: Reads the current global time (in seconds).
- **`Easing.easeInOut` / `Easing.easeOut` / ...**: Easing functions.
- **`interpolate(t, from, to, easing?)`**: Interpolates based on t.

This pattern draws inspiration from Remotion/After Effects but is lightweight and has zero dependencies.

## Getting Started

```html
<script type="text/babel" src="animations.jsx"></script>
<script type="text/babel">
  const { Stage, Sprite, useTime, useSprite, Easing, interpolate } = window.Animations;

  function Title() {
    const { t } = useSprite();  // Local progress 0→1
    const opacity = interpolate(t, [0, 1], [0, 1], Easing.easeOut);
    const y = interpolate(t, [0, 1], [40, 0], Easing.easeOut);
    return (
      <h1 style={{ 
        opacity, 
        transform: `translateY(${y}px)`,
        fontSize: 120,
        fontWeight: 900,
      }}>
        Hello.
      </h1>
    );
  }

  function Scene() {
    return (
      <Stage duration={10}>  {/* 10-second animation */}
        <Sprite start={0} end={3}>
          <Title />
        </Sprite>
        <Sprite start={2} end={5}>
          <SubTitle />
        </Sprite>
        {/* ... */}
      </Stage>
    );
  }

  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<Scene />);
</script>
```

## Common Animation Patterns

### 1. Fade In / Fade Out

```jsx
function FadeIn({ children }) {
  const { t } = useSprite();
  const opacity = interpolate(t, [0, 0.3], [0, 1], Easing.easeOut);
  return <div style={{ opacity }}>{children}</div>;
}
```

**Note the range**: `[0, 0.3]` means the fade-in completes within the first 30% of the sprite's duration, and opacity remains 1 afterward.

### 2. Slide In

```jsx
function SlideIn({ children, from = 'left' }) {
  const { t } = useSprite();
  const progress = interpolate(t, [0, 0.4], [0, 1], Easing.easeOut);
  const offset = (1 - progress) * 100;
  const directions = {
    left: `translateX(-${offset}px)`,
    right: `translateX(${offset}px)`,
    top: `translateY(-${offset}px)`,
    bottom: `translateY(${offset}px)`,
  };
  return (
    <div style={{
      transform: directions[from],
      opacity: progress,
    }}>
      {children}
    </div>
  );
}
```

### 3. Typewriter Effect (character by character)

```jsx
function Typewriter({ text }) {
  const { t } = useSprite();
  const charCount = Math.floor(text.length * Math.min(t * 2, 1));
  return <span>{text.slice(0, charCount)}</span>;
}
```

### 4. Number Counting

```jsx
function CountUp({ from = 0, to = 100, duration = 0.6 }) {
  const { t } = useSprite();
  const progress = interpolate(t, [0, duration], [0, 1], Easing.easeOut);
  const value = Math.floor(from + (to - from) * progress);
  return <span>{value.toLocaleString()}</span>;
}
```

### 5. Segmented Explanation (Typical Educational Animation)

```jsx
function Scene() {
  return (
    <Stage duration={20}>
      {/* Phase 1: Present the problem */}
      <Sprite start={0} end={4}>
        <Problem />
      </Sprite>

      {/* Phase 2: Present the approach */}
      <Sprite start={4} end={10}>
        <Approach />
      </Sprite>

      {/* Phase 3: Present the result */}
      <Sprite start={10} end={16}>
        <Result />
      </Sprite>

      {/* Caption displayed throughout */}
      <Sprite start={0} end={20}>
        <Caption />
      </Sprite>
    </Stage>
  );
}
```

## Easing Functions

Preset easing curves:

| Easing | Characteristic | Used for |
|--------|----------------|----------|
| `linear` | Constant speed | Scrolling captions, continuous animations |
| `easeIn` | Slow → Fast | Exiting/disappearing |
| `easeOut` | Fast → Slow | Entering/appearing |
| `easeInOut` | Slow → Fast → Slow | Position changes |
| **`expoOut`** ⭐ | **Exponential ease-out** | **Anthropic-grade primary easing** (physical weight sensation) |
| **`overshoot`** ⭐ | **Elastic overshoot** | **Toggle / Button pop-out / Emphasizing interaction** |
| `spring` | Spring | Interactive feedback, geometric return to position |
| `anticipation` | Reverse first, then forward | Emphasizing action |

**The default primary easing is `expoOut`** (not `easeOut`) — see `animation-best-practices.md` §2.
Use `expoOut` for entry, `easeIn` for exit, and `overshoot` for toggles — fundamental principles for Anthropic-grade animations.

## Pacing and Duration Guidelines

### Micro-interactions (0.1-0.3 seconds)
- Button hover
- Card expand
- Tooltip appearance

### UI Transitions (0.3-0.8 seconds)
- Page switching
- Modal dialog appearance
- List item addition

### Narrative Animations (2-10 seconds per segment)
- A phase of concept explanation
- Data chart reveal
- Scene transition

### Single narrative animation segment should not exceed 10 seconds
Human attention span is limited. Explain one thing in 10 seconds, then move to the next.

## Animation Design Thought Process

### 1. Content/Story First, Then Animation

**Wrong**: Wanting to create fancy animations first, then stuffing content into them.
**Correct**: First clarify what information needs to be conveyed, then use animation to serve that information.

Animation is a **signal**, not **decoration**. A fade-in emphasizes "this is important, please look" — if everything fades in, the signal loses its effectiveness.

### 2. Write the Timeline Scene by Scene

```
0:00 - 0:03   Problem appears (fade in)
0:03 - 0:06   Problem magnified/expanded (zoom+pan)
0:06 - 0:09   Solution appears (slide in from right)
0:09 - 0:12   Solution explained in detail (typewriter)
0:12 - 0:15   Result demonstration (counter up + chart reveal)
0:15 - 0:18   Summary sentence (static, read for 3 seconds)
0:18 - 0:20   CTA or fade out
```

Write components after completing the timeline.

### 3. Resources First

Prepare images/icons/fonts needed for the animation **first**. Don't search for assets halfway through — it breaks the flow.

## Common Issues

**Animation Lag**
→ Primarily layout thrashing. Use `transform` and `opacity`; avoid changing `top`/`left`/`width`/`height`/`margin`. Browsers GPU-accelerate `transform`.

**Animation too fast, unclear**
→ A person needs 100-150ms to read a Chinese character, and 300-500ms for a word. If you're telling a story with text, allow at least 3 seconds per sentence.

**Animation too slow, audience bored**
→ Interesting visual changes should be dense. Static screens for more than 5 seconds become dull.

**Multiple animations interfering with each other**
→ Use CSS `will-change: transform` to inform the browser in advance that this element will move, reducing reflows.

**Recording as Video**
→ Use the skill's built-in toolchain (one command for three formats): see `video-export.md`
- `scripts/render-video.js` — HTML → 25fps MP4 (Playwright + ffmpeg)
- `scripts/convert-formats.sh` — 25fps MP4 → 60fps MP4 + optimized GIF
- Want more precise frame rendering? Make `render(t)` a pure function; see `animation-pitfalls.md` item 5.

## Integration with Video Tools

This skill creates **HTML animations** (running in the browser). If the final output is to be used as video material:

- **Short animations/concept demos**: Use the methods here to create HTML animations → screen recording.
- **Long videos/narratives**: This skill focuses on HTML animations; for long videos, use AI video generation skills or professional video software.
- **Motion graphics**: Professional After Effects/Motion Canvas are more suitable.

## Regarding Libraries like Popmotion

If you truly need physics-based animations (spring, decay, keyframes with precise timing), our engine might not handle it, and you can fall back to Popmotion:

```html
<script src="https://unpkg.com/popmotion@11.0.5/dist/popmotion.min.js"></script>
```

But **try our engine first**. It's sufficient for 90% of cases.