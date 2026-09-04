# Voiceover Pipeline · Narration-Driven Animation

> Upgrade animation from "silent visuals + post-production voiceover" to a workflow where "**narration script comes first, then visuals are driven by actual audio duration**."
> Applicable for: 5-20 minute concept explanation videos, tutorial videos, long-form knowledge popularization.
>
> Use in conjunction with `references/animation-best-practices.md` – this file covers **how to synchronize narration and visuals**,
> while animation-best-practices covers **how each frame moves**.

---

## 🛑 Iron Rules · Must Read Before Writing a Single Line of Code

> **It cannot be stressed enough: The #1 failure mode for narrated animation is making it look like a PowerPoint with voiceover.**

### Rule 1 · The Entire Piece is a Continuous Motion Narrative, Not a Set of Independent Scenes

PowerPoint is 7 slides. What we're making is **1 continuous X-minute film**.

**Identity Shift**:
- ❌ You are not "creating content for 7 scenes"
- ✅ You are "making one or more hero elements perform for X minutes on screen"

**Visual Skeleton = One or More Hero Elements Throughout the Film**:
- It appears at t=0 and only leaves at the end.
- Each cue is a **state change** (position / size / color / perspective / form) of the hero element, not "introducing a new element."
- Scene boundaries exist in the script, but **should not exist visually** – the audience shouldn't perceive "this is the 3rd scene," only a continuous motion.

**Counter-example (Real-world pitfall of this skill v1 · 2026-05-10)**:
- 7 `<Scene>` components with independent layouts; scene switching = entire page opacity 1→0 to the next page.
- Each cue = `opacity: p, transform: translateY((1-p)*30px)` (monotonous use of fade-up).
- Result: Audience's first reaction was "it looks like a Keynote presentation," overall quality plummeted to zero.

**Correct Mode**:
- Select 1-2 hero elements (e.g., for this article's demo, "md" and "html" characters should be chosen as the skeleton).
- These two characters remain on screen **from beginning to end**.
- Each "scene" is actually a state change of the hero element.
  - opening: The two characters confront each other in the center of the screen.
  - md-side: "md" grows larger and bolder, dominating the screen; "html" recedes to a small font in the corner; data flows around "md."
  - html-side: "html" reverses to become the protagonist; "md" recedes to the corner.
  - the-real-question: The two characters return to the center, but a "≠" appears between them.
  - the-split: The two characters push apart to the sides, and the space between them expands.
  - activity-proof: The two characters alternately flash on a timeline.
  - closing: The two characters settle into their final answer positions.
- This way, the entire piece is "md and html performing on screen for X minutes," not 7 independent PPT slides.

**Minimal Implementation Skeleton** (copy and modify directly):

```jsx
// ── Step 1: Define the hero's target state (position/size/opacity) for each scene ──
const HERO_KEYS = {
  opening:    { md: { x: 50, y: 35, scale: 1.0, opacity: 1 }, html: { x: 50, y: 65, scale: 1.0, opacity: 1 } },
  'md-side':  { md: { x: 78, y: 50, scale: 1.6, opacity: 1 }, html: { x: 92, y: 8,  scale: 0.25, opacity: 0.4 } },
  'html-side':{ md: { x: 8,  y: 8,  scale: 0.25, opacity: 0.4 }, html: { x: 22, y: 50, scale: 1.6, opacity: 1 } },
  // ... one entry per segment, continuous motion from previous segment's final → this segment's from
};

// ── Step 2: easing + lerp utilities ──
const expoOut = t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const lerpPos = (from, to, t) => ({
  x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t),
  scale: lerp(from.scale, to.scale, t),
  opacity: lerp(from.opacity ?? 1, to.opacity ?? 1, t),
});

// ── Step 3: HeroAnchor Component – Mount directly as a child of <NarrationStage>, not inside <Scene> ──
const HeroAnchor = () => {
  const { time, scene, timeline } = useNarration();
  if (!scene) return null;
  const idx = timeline.scenes.findIndex(s => s.id === scene.id);
  const prevId = idx > 0 ? timeline.scenes[idx - 1].id : scene.id;
  const from = HERO_KEYS[prevId];
  const to   = HERO_KEYS[scene.id];

  // The first ~45% of the segment's time is used to morph from the prev state to the current state, remaining time is hold
  const transitionDur = Math.min(2.0, scene.duration * 0.45);
  const t = expoOut(Math.min(1, (time - scene.start) / transitionDur));
  const md   = lerpPos(from.md,   to.md,   t);
  const html = lerpPos(from.html, to.html, t);

  // Add subtle breathing to ensure motion in any frame (corresponds to Iron Rule 3)
  const breath = 1 + Math.sin(time * 0.6) * 0.012;

  const renderHero = (label, pos, color) => (
    <div style={{
      position: 'absolute', left: `${pos.x}%`, top: `${pos.y}%`,
      transform: `translate(-50%, -50%) scale(${pos.scale * breath})`,
      opacity: pos.opacity, color, fontSize: 360, fontWeight: 800,
      lineHeight: 1, willChange: 'transform, opacity', pointerEvents: 'none',
    }}>{label}</div>
  );
  return <>
    {renderHero('md',   md,   '#1B4965')}
    {renderHero('html', html, '#C04A1A')}
  </>;
};

// ── Step 4: Main Component – hero as a child of NarrationStage, auxiliary elements within scene managed separately ──
const App = () => (
  <NarrationStage timeline={TIMELINE} audioSrc="_narration/voiceover.mp3" width={1920} height={1080}>
    <HeroAnchor />  {/* ← Persists across scenes, the visual skeleton for the entire piece */}
    {/* Auxiliary elements within scenes use useSceneFade for soft fade-in/out, no hard cuts */}
    <MdSideAux />
    <HtmlSideAux />
    {/* ... */}
  </NarrationStage>
);
```

**Full runnable reference**: `demos/md-html-narration/md-html-demo.html` (3 min 21 sec, 7 segments, 21 cues, validated in practice)

### Rule 2 · No "Hard Cuts" Between Scenes

| Incorrect Mode (PowerPoint slop) | Correct Mode (Cinematic feel) |
|---|---|
| Scene A `opacity 1→0` while Scene B `opacity 0→1` | Scene A's core elements **morph into** B (smooth transformation of position/size/color) |
| Each scene has an independent layout, elements appear/disappear | Elements **persist** on screen, only their position and form change |
| `keepMounted=false`, components unmounted at scene switch | Hero uses `keepMounted=true`, sharing DOM nodes across scenes |
| Subtitle bars/data cards fade in and fade out independently | Subtitle bar enters as the only "non-hero" element, holds, then **exits in conjunction with the hero's motion** |

Implementation level:
- **Shared elements across scenes** → Lift the hero element to be a direct child of `<NarrationStage>`, **not inside any `<Scene>`**.
- Use the `useNarration()` hook within the hero to read `time`, `scene`, `isCueTriggered`, and determine its form based on the current time.
- `<Scene>` is only used to manage auxiliary elements that appear only in that segment (data cards, quote blocks, etc.), and **these auxiliary elements should also not hard cut** – use expoOut + stagger for entry, and fade overlap for exit, stacking with the next segment.

### Rule 3 · Every Frame Must Have Motion

**Self-check method**: **Take a screenshot of any frame** during recording (not just the second a cue triggers).
- If the screen appears "completely still" → Incorrect. Go back and add underlying motion (background drift / hero subtle scale / camera pan / parallax).
- There should always be an **underlying motion** running (even if it's not the focus):
  - Hero element's `scale: 1 ↔ 1.02` 5-second breathing cycle.
  - Background `translateX: 0 ↔ -20px` slow drift.
  - Data cards retain a slight `translateY` jitter after entry (Perlin noise).
- A completely still frame = PowerPoint slop.

### Rule 4 · Easing / Stagger / Hold Are the Baseline

| Item | Must | Forbidden |
|---|---|---|
| Easing | `expoOut` for main axis (`cubic-bezier(0.16, 1, 0.3, 1)`), `overshoot` for emphasis, `spring` for settling | `linear`, `ease`, CSS default |
| Multiple element entry | 30ms stagger (each enters 30ms later) | All appear at once |
| Before key cue | Hold 0.3-0.5s to let the audience "see" (previous segment's elements pause for 0.3s, then trigger cue) | Seamless cut to next segment after one finishes |
| Ending | Abrupt stop, last frame holds for 1s | Fade to black |

Detailed rules refer to §1-§4 of `animation-best-practices.md`.

### Self-Check · First Audience Reaction

After completion, show it to someone who hasn't seen it (or watch it yourself after 24 hours). **What is their first reaction?**

| Reaction | Rating | Action |
|---|---|---|
| "This is a PPT with voiceover" | Failure | Go back and redo |
| "The visuals switch with the sound" | Failing | Lacks continuous narrative, hero element absent or not continuous |
| "This thing is moving" | Pass | But no memorable moments |
| "I want to watch it all" | Good | Pacing is right |
| "I want to screenshot this part" | Great | You've succeeded |

---

## Workflow (High-Level)

```
                ┌──────────────────────────┐
                │  Narration Script .md    │
                │  (## scene + [[cue:xx]]  │
                │  mark key sentences)     │
                └──────────────┬───────────┘
                               │
                  narrate-pipeline.mjs
                               │
                               ▼
            ┌──────────────────────────────┐
            │ voiceover.mp3 (concatenated) │
            │ timeline.json (actual duration)│
            └──────────────┬───────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
    ┌─────────────────┐      ┌──────────────────┐
    │ HTML Animation  │      │ Record MP4 + Mix │
    │ (NarrationStage)│      │ render-narration │
    │ Live playback   │      │ → Final MP4      │
    │ with audio sync │      │ for publishing   │
    └─────────────────┘      └──────────────────┘
       Delivery Form 1           Delivery Form 2
```

## Narration Script Format

Place it anywhere in the project directory, suggested filename `script.md`:

```markdown
---
title: What is LLM
voice: S_JSdgdWk22   # Optional, overrides .env default voice
speed: 1.0           # Optional, 0.5-2.0
gap: 0.4             # Silence duration between segments in seconds, default 0.3
---

## intro
Hello everyone, today we'll explain what LLM is in 5 minutes.

## what-is
LLM stands for Large Language Model, [[cue:bigmodel]]it's a neural network with hundreds of billions of parameters.
Essentially, it's a text completion predictor.

## demo
For example, if you input "Today's weather is", [[cue:input]]the model will predict what the next word is most likely to be.
[[cue:predict]]Perhaps "good", perhaps "nice".
```

**Rules**:
- Segment title `## scene-id` should be English/numbers + hyphens (e.g., `## what-is`, `## scene-1`).
- `[[cue:xx]]` is placed **in the middle of a key sentence** – the script will cut the text at this position during runtime, and the moment after the cue is the trigger point for the visual.
- Cue IDs are listened to in the animation HTML using `<Cue id="xx">`.
- When writing narration, **focus on rhythm + short sentences**; long sentences tend to sound flat when TTS is generated.

## timeline.json schema

```ts
{
  title: string,
  voice: string | null,
  speed: number,
  gap: number,
  totalDuration: number,        // Actual duration of the entire voiceover.mp3 in seconds
  voiceover: 'voiceover.mp3',   // Path relative to timeline.json
  scenes: [
    {
      id: string,
      start: number,            // Start time of this segment within the entire audio
      end: number,
      duration: number,
      audio: 'audio/<id>.mp3',  // Separate audio for this segment (sub-segments before merging are already concatenated)
      text: string,             // Full text of the segment, with [[cue:xx]] markers stripped
      // chunks are the source for subtitle display – each chunk is a sub-segment cut by cues, including actual TTS time window
      chunks: [
        {
          text: string,            // Sub-segment text
          start: number,           // Relative time within the segment
          end: number,
          absoluteStart: number,   // Absolute time on the entire track (aligned with voiceover.mp3)
          absoluteEnd: number,
        }
      ],
      cues: [
        {
          id: string,
          offset: number,       // Relative time within the segment
          absoluteTime: number, // Absolute time on the entire timeline
        }
      ]
    }
  ]
}
```

`absoluteTime` and `absoluteStart/End` are all **actually measured** – the pipeline cuts the text within a segment by cues into sub-segments, performs TTS for each, and the time is the cumulative actual duration of the preceding sub-segments. **It is not an approximation estimated linearly by character count.**

## Subtitles

> **Subtitles are included by default** – long narration videos without subtitles will have significantly lower retention rates. NarrationStage provides `<Subtitles />` out-of-the-box.

### Usage (One Line)

```jsx
const { NarrationStage, Subtitles } = NarrationStageLib;
<NarrationStage timeline={TIMELINE} audioSrc="...">
  {/* Your hero / scene content */}
  <Subtitles />  {/* ← Automatically fetches active text from timeline.scenes[].chunks */}
</NarrationStage>
```

### Visual Rules (Bilibili Style · Anti-PowerPoint)

| Item | Rule | Counter-example |
|---|---|---|
| Background | **No background** (no black bars, no backdrop-blur) | Semi-transparent black background + blur = subtitle bar obscures visuals = PPT feel |
| Text Color | **Dark ink `#1a1a1a` with white glow for light backgrounds**; white text with black glow for dark backgrounds | White text + black stroke on light background = blurry text |
| Font Size | 32px (for 1080p video) | <24px is hard to read, >40px competes with main visuals |
| Font | `PingFang SC` / `Noto Sans SC` (sans-serif, Bilibili standard) | Serif fonts = looks like movie subtitles |
| Position | bottom: 90px (not flush with edge) | Flush with bottom edge looks cheap |
| Single Line Length | **≤ 12-13 characters** (when mixed with English, count English characters as 0.5) | >15 characters per line is too long for mobile screens |
| Sentence Splitting Rule | **Never break across a period**: First split by `。！？`, then merge each sentence by `，、；：` to ≤maxLen | Hard cut by character count, splitting "This is good" into "This is go" + "od" |

`<Subtitles />` runs by default according to the above rules, no props needed. For dark background scenes: `<Subtitles color="#fff" haloColor="rgba(0,0,0,0.85)" />`.

### Sentence Splitting Algorithm (Built into narration_stage.jsx)

```js
splitChunkToLines(text, maxLen = 13)
// 1. Split by strong punctuation (.！？\n)
// 2. If a sentence is ≤ maxLen, keep it as is
// 3. Otherwise, split by weak punctuation (，、；：) and merge to ≤ maxLen
// 4. Fallback hard cut (rare)
// Mixed Chinese/English: English/numbers count as 0.5 characters for visual width
```

If a chunk is split and a line is noticeably too long or too short, **adjust the cue position in the narration script** (cues split the segment more finely), do not modify the splitting logic in the frontend.

## NarrationStage API

```jsx
import 'assets/narration_stage.jsx';
const { NarrationStage, Scene, Cue, useNarration } = NarrationStageLib;

<NarrationStage
  timeline={TIMELINE}                  // timeline.json content
  audioSrc="_narration/voiceover.mp3"  // Path relative to current HTML
  width={1920} height={1080}
  background="#f5f1e8"
  controls={true}                      // Show bottom playback bar during live playback
>
  {/* hero element: persists across scenes – placed directly as a child of NarrationStage */}
  <HeroAnchor />

  {/* Auxiliary elements within scenes: appear only in that segment */}
  <Scene id="intro">
    <Cue id="bigmodel">{(triggered, progress) => (
      <SomeElement style={{ opacity: progress }} />
    )}</Cue>
  </Scene>
</NarrationStage>
```

**Hooks**:
- `useNarration()` returns `{ time, scene, sceneTime, isCueTriggered, cueProgress }`
- Read directly in custom components, no need to pass props.

**Scene Component**:
- By default, mounts only when `scene.id === id`.
- Add `keepMounted` to keep it mounted continuously (for continuous animation across scenes).

**Cue Component**:
- Children must be `(triggered, progress) => ReactNode`.
- `progress` is a 0→1 progressive value after the cue is triggered (default 0.6s ramp).

## Time Source (Dual Track)

NarrationStage automatically detects `window.__recording`:
- **Live Playback Mode** (default): Follows the `currentTime` of the audio element; user pause/seek operations are synchronized.
- **Video Recording Mode** (`render-video.js` sets `window.__recording = true`): rAF wall-clock self-driven from 0, exposes `window.__seek(t)` for `render-video.js` to reset.

## Three Scripts

| Script | Input | Output |
|---|---|---|
| `scripts/tts-doubao.mjs` | Single text segment | Single mp3 + actual duration |
| `scripts/narrate-pipeline.mjs` | Narration script .md | voiceover.mp3 + timeline.json |
| `scripts/mix-voiceover.sh` | Video + voiceover.mp3 [+ BGM] | MP4 with audio |
| `scripts/render-narration.sh` | Narration HTML + timeline.json | Final MP4 (recording + audio mixing in one go) |

## .env Configuration

`.env` in the skill root directory (already gitignored):

```
DOUBAO_TTS_API_KEY=<your_key>
DOUBAO_TTS_VOICE_ID=<your_clone_voice_id>
DOUBAO_TTS_CLUSTER=volcano_icl
DOUBAO_TTS_ENDPOINT=https://openspeech.bytedance.com/api/v1/tts
```

Refer to the `.env.example` template. Doubao voice clone ID can be obtained from the Volcano Engine console.

## Standard Workflow (10 Steps)

1. **Write the narration script**: The narration script is the source code. First, write the entire spoken content, mark segment titles `## scene-id`, and add `[[cue:xx]]` before key sentences.
2. **Run narrate-pipeline**: `node scripts/narrate-pipeline.mjs --script script.md --out-dir _narration`
3. **Listen to the entire voiceover.mp3**: If the rhythm is off, go back and revise the script. **This step determines the upper limit of the entire piece's quality.**
4. **🛑 Answer the Iron Rules before designing**: What is the hero element? What is its state in each segment? How does it morph across scenes? Do not write code if you cannot answer these.
5. **Write the animation HTML**: Use NarrationStage + one or more hero elements to perform across scenes.
6. **Live playback preview**: Open the HTML in a browser, click ▶ Play, listen to the synchronized visuals + narration.
7. **First audience self-check**: Use the "Self-Check · First Audience Reaction" table above to score. If it fails, go back to Step 4 and redo.
8. **Record video**: `bash scripts/render-narration.sh demo.html --timeline=_narration/timeline.json` (automatically records silent MP4 + mixes in voiceover).
9. **Optional BGM**: Add `--bgm-mood=educational` (or tech / tutorial, etc.) to `render-narration`.
10. **Deliver**: Browser HTML (for live demonstration) + final MP4 (for publishing).

## Troubleshooting

| Problem | Solution |
|---|---|
| TTS API error | Check if `DOUBAO_TTS_API_KEY` in .env is correct |
| A segment's audio is noticeably longer/shorter than the script | The segment text contains strange punctuation or emojis, causing TTS parsing errors → Revise the script |
| `cue absoluteTime` is inaccurate | ffmpeg issue during sub-segment concatenation → Check mp3 encoding consistency |
| Recording results in black screen | `render-video.js` didn't receive `window.__ready` signal → Check if NarrationStage is mounted correctly |
| Recorded video stutters | Animation has heavy layout changes (lots of box-shadow / blur) → Simplify or pre-compose |
| Live playback audio/visual out of sync | Audio element loading delay → Add `preload="auto"` or local preloading |

## When Not to Use This Pipeline

- **<60s short animations**: Directly create silent animations + post-production voiceover (using `add-music.sh` + a single TTS segment) is sufficient, no timeline driving needed.
- **Pure BGM videos**: Use `add-music.sh` to add preset BGM.
- **Replacing TTS with human recording**: Replace `voiceover.mp3` with human recording, manually write the timeline or use `ffprobe` to measure segment durations + a utility script to generate it → The rest of the workflow is general.

---

**Last reminder**: Go back to the Iron Rules before writing code. **Don't make a PowerPoint with voiceover.**