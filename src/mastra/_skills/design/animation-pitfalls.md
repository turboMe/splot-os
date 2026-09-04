# Animation Pitfalls: HTML Animation Traps and Rules

The most common bugs encountered when building animations, and how to avoid them. Every rule comes from a real failure case.

Read this through before writing an animation — it saves a round of iteration.

## 1. Stacked layout — `position: relative` is the default obligation

**The trap**: A sentence-wrap element wrapped 3 bracket-layers (`position: absolute`). Because `position: relative` wasn't set on the sentence-wrap, the absolute brackets used `.canvas` as their coordinate system and floated 200px off the bottom of the screen.

**Rules**:
- Any container holding `position: absolute` children **must** explicitly set `position: relative`
- Even when no visual "offset" is needed, write `position: relative` to anchor the coordinate system
- If you're writing `.parent { ... }` and its children include `.child { position: absolute }`, reflexively add relative to the parent

**Quick check**: For every `position: absolute` that appears, count up the ancestors and make sure the nearest positioned ancestor is the coordinate system you *want*.

## 2. Character traps — don't rely on rare Unicode

**The trap**: We wanted to use `␣` (U+2423 OPEN BOX) to visualize a "space token". Neither Noto Serif SC nor Cormorant Garamond has this glyph, so it rendered as blank / tofu, and the audience couldn't see it at all.

**Rules**:
- **Every character that appears in the animation must exist in the font you've chosen**
- Common rare-character blacklist: `␣ ␀ ␐ ␋ ␨ ↩ ⏎ ⌘ ⌥ ⌃ ⇧ ␦ ␖ ␛`
- To express metacharacters like "space / enter / tab", use a **CSS-constructed semantic box**:
  ```html
  <span class="space-key">Space</span>
  ```
  ```css
  .space-key {
    display: inline-flex;
    padding: 4px 14px;
    border: 1.5px solid var(--accent);
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.3em;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  ```
- Emoji must also be verified: some emoji fall back to gray boxes in fonts other than Noto Emoji — better to use an `emoji` font-family or SVG

## 3. Data-driven Grid/Flex templates

**The trap**: The code had `const N = 6` tokens, but the CSS hard-coded `grid-template-columns: 80px repeat(5, 1fr)`. As a result the 6th token had no column and the entire matrix was misaligned.

**Rules**:
- When the count comes from a JS array (`TOKENS.length`), the CSS template should be data-driven too
- Option A: inject a CSS variable from JS
  ```js
  el.style.setProperty('--cols', N);
  ```
  ```css
  .grid { grid-template-columns: 80px repeat(var(--cols), 1fr); }
  ```
- Option B: use `grid-auto-flow: column` to let the browser expand automatically
- **Ban the "fixed number + JS constant" combination** — when N changes, the CSS won't update in sync

## 4. Transition gaps — scene switches must be continuous

**The trap**: Between zoom1 (13-19s) → zoom2 (19.2-23s), the main sentence was already hidden, and zoom1 fade out (0.6s) + zoom2 fade in (0.6s) + stagger delay (0.2s+) = about 1 second of pure blank screen. The audience thinks the animation has frozen.

**Rules**:
- When switching scenes continuously, the fade out and fade in should **cross-overlap** — not "the previous one fully disappears, then the next begins"
  ```js
  // Bad:
  if (t >= 19) hideZoom('zoom1');      // 19.0s out
  if (t >= 19.4) showZoom('zoom2');    // 19.4s in → 0.4s blank in between

  // Good:
  if (t >= 18.6) hideZoom('zoom1');    // start fade out 0.4s early
  if (t >= 18.6) showZoom('zoom2');    // fade in at the same time (cross-fade)
  ```
- Or use an "anchor element" (such as the main sentence) as a visual link between scenes; it briefly reappears during the zoom switch
- Calculate the CSS transition durations carefully to avoid triggering the next one before the transition finishes

## 5. Pure Render principle — animation state should be seekable

**The trap**: Using `setTimeout` + `fireOnce(key, fn)` to chain-trigger animation states. Normal playback is fine, but when doing frame-by-frame recording / seeking to an arbitrary time point, any `setTimeout` that has already executed can't "go back in time".

**Rules**:
- The `render(t)` function should ideally be a **pure function**: given t, it outputs a unique DOM state
- If side effects are unavoidable (such as class toggling), use a `fired` set together with an explicit reset:
  ```js
  const fired = new Set();
  function fireOnce(key, fn) { if (!fired.has(key)) { fired.add(key); fn(); } }
  function reset() { fired.clear(); /* clear all .show classes */ }
  ```
- Expose `window.__seek(t)` for Playwright / debugging:
  ```js
  window.__seek = (t) => { reset(); render(t); };
  ```
- Animation-related setTimeout should not span >1 second, otherwise things break when seek jumps backward

## 6. Measuring before fonts load = measuring wrong

**The trap**: As soon as the page fired DOMContentLoaded, it called `charRect(idx)` to measure bracket positions. The fonts hadn't loaded yet, so every character width was that of the fallback font and all positions were wrong. Once the fonts loaded (about 500ms later), the bracket's `left: Xpx` still held the old value — permanently offset.

**Rules**:
- Any layout code that depends on DOM measurement (`getBoundingClientRect`, `offsetWidth`) **must** be wrapped in `document.fonts.ready.then()`
  ```js
  document.fonts.ready.then(() => {
    requestAnimationFrame(() => {
      buildBrackets(...);  // fonts are ready now, measurement is accurate
      tick();              // animation begins
    });
  });
  ```
- The extra `requestAnimationFrame` gives the browser one frame to commit the layout
- If using the Google Fonts CDN, `<link rel="preconnect">` speeds up the first load

## 7. Recording prep — leave handles for video export

**The trap**: Playwright `recordVideo` defaults to 25fps and starts recording the moment the context is created. The first 2 seconds of page load and font load all get recorded. On delivery, the video has a 2-second blank / white flash at the front.

**Rules**:
- Provide a `render-video.js` tool that handles: warmup navigate → reload to restart the animation → wait the duration → ffmpeg trim head + convert to H.264 MP4
- The **frame 0** of the animation should be the complete initial state with the final layout already in place (not blank or loading)
- Want 60fps? Use ffmpeg `minterpolate` post-processing — don't count on the browser's source frame rate
- Want a GIF? Use a two-stage palette (`palettegen` + `paletteuse`); for a 30s 1080p animation this can compress down to 3MB

See `video-export.md` for the full script invocation.

## 8. Batch export — the tmp directory must include the PID to prevent concurrency conflicts

**The trap**: Using `render-video.js`, 3 processes recorded 3 HTML files in parallel. Because TMP_DIR was named with only `Date.now()`, when the 3 processes started in the same millisecond they shared the same tmp directory. The first process to finish cleaned up tmp, and when the other two read the directory they hit `ENOENT` and all crashed.

**Rules**:
- Any temporary directory that multiple processes might share must be named with a **PID or random suffix**:
  ```js
  const TMP_DIR = path.join(DIR, '.video-tmp-' + Date.now() + '-' + process.pid);
  ```
- If you really want multi-file parallelism, use the shell's `&` + `wait` rather than forking inside a single node script
- When batch-recording multiple HTML files, the conservative approach: **run serially** (2 or fewer can run in parallel; 3 or more should honestly queue up)

## 9. Progress bars / replay buttons in the recording — Chrome elements pollute the video

**The trap**: The animation HTML added a `.progress` progress bar, a `.replay` replay button, and a `.counter` timestamp to make it easy for humans to debug playback. When recorded into the delivered MP4, these elements appeared at the bottom of the video — as if devtools had been captured into it.

**Rules**:
- Manage the "chrome elements" meant for humans (progress bar / replay button / footer / masthead / counter / phase labels) separately from the video content itself
- **Establish a class name convention** `.no-record`: the recording script automatically hides any element with this class
- On the script side (`render-video.js`), inject CSS by default to hide the common chrome class names:
  ```
  .progress .counter .phases .replay .masthead .footer .no-record [data-role="chrome"]
  ```
- Inject via Playwright's `addInitScript` (it takes effect before every navigate, so it's stable on reload too)
- Add a `--keep-chrome` flag when you want to see the HTML as-is (with chrome)

## 10. The animation repeats in the first few seconds of the recording — Warmup frame leak

**The trap**: The old flow of `render-video.js` was `goto → wait fonts 1.5s → reload → wait duration`. Recording started the moment the context was created, so during the warmup phase the animation had already played a stretch, and after reload it restarted from 0. The result: the first few seconds of the video were "mid-animation + switch + animation starting from 0", with a strong sense of repetition.

**Rules**:
- **Warmup and Record must use separate contexts**:
  - Warmup context (no `recordVideo` option): only responsible for loading the url, waiting for fonts, then closing
  - Record context (with `recordVideo`): starts from a fresh state, the animation is recorded from t=0
- ffmpeg `-ss trim` can only trim Playwright's tiny startup latency (~0.3s); it **cannot** be used to mask warmup frames — the source must be clean
- Closing the record context = the webm file is written to disk; this is a Playwright constraint
- Related code pattern:
  ```js
  // Phase 1: warmup (throwaway)
  const warmupCtx = await browser.newContext({ viewport });
  const warmupPage = await warmupCtx.newPage();
  await warmupPage.goto(url, { waitUntil: 'networkidle' });
  await warmupPage.waitForTimeout(1200);
  await warmupCtx.close();

  // Phase 2: record (fresh)
  const recordCtx = await browser.newContext({ viewport, recordVideo });
  const page = await recordCtx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(DURATION * 1000);
  await page.close();
  await recordCtx.close();
  ```

## 11. Don't draw "fake chrome" inside the frame — a decorative player UI collides with the real chrome

**The trap**: The animation used a `Stage` component, which already comes with a scrubber + timecode + pause button (these belong to the `.no-record` chrome and are auto-hidden on export). I then drew a "magazine-page-number-style decorative progress bar" reading "`00:60 ──── CLAUDE-DESIGN / ANATOMY`" along the bottom of the frame, feeling rather pleased with myself. **The result**: the user saw two progress bars — one from the Stage controller, one I drew as decoration. A complete visual collision, judged to be a bug. "Why is there another progress bar inside the video?"

**Rules**:

- Stage already provides: scrubber + timecode + pause/replay buttons. **Don't draw, inside the frame,** progress indicators, the current timecode, copyright credit bars, or chapter counters — they either collide with the chrome or are filler slop (violating the "earn its place" principle).
- "Page-number feel", "magazine feel", "bottom credit bar" — these **decorative urges** are high-frequency filler that AI adds automatically. Be on guard for every one — does it really convey irreplaceable information? Or does it merely fill empty space?
- If you firmly believe a certain bottom strip must exist (for example: the animation's theme is literally about player UI), then it must be **narratively necessary** and **visually distinct from the Stage scrubber** (different position, different form, different tone).

**Element ownership test** (every element drawn into the canvas must be able to answer):

| What it belongs to | Handling |
|------------|------|
| Narrative content of some scene | OK, keep it |
| Global chrome (for control/debugging) | Add the `.no-record` class, hide on export |
| **Belongs to no scene, and is not chrome** | **Delete it.** This is an orphan, inevitably filler slop |

**Self-check (3 seconds before delivery)**: take a static screenshot and ask yourself —

- Is there anything in the frame "that looks like video player UI" (a horizontal-line progress bar, a timecode, control-button shapes)?
- If so, does deleting it harm the narrative? If not, delete it.
- Does the same class of information (progress / time / credit) appear twice? Merge it into one place in the chrome.

**Counter-example**: drawing `00:42 ──── PROJECT NAME` at the bottom, a "CH 03 / 06" chapter counter in the lower right corner, a version number "v0.3.1" at the edge of the frame — all fake-chrome filler.

## 12. Leading blank in the recording + recording start-point offset — the `__ready` × tick × lastTick triple trap

**The trap (A · leading blank)**: A 60-second animation exported to MP4 has 2-3 seconds of blank page at the front. `ffmpeg --trim=0.3` can't cut it out.

**The trap (B · start-point offset, real incident 2026-04-20)**: A 24-second video was exported, and the user's impression was "the video doesn't play its first frame until 19 seconds in". In reality the animation was recorded from t=5, recorded until t=24, then looped back to t=0 and recorded another 5 seconds to the end — so the last 5 seconds of the video are the animation's actual beginning.

**Root cause** (both traps share one root cause):

Playwright `recordVideo` starts writing WebM from the moment of `newContext()`, while Babel/React/font loading collectively takes L seconds (2-6s). The recording script waits for `window.__ready = true` as the anchor for "the animation starts here" — it must be strictly paired with the animation's `time = 0`. There are two common ways to get this wrong:

| Wrong way | Symptom |
|------|------|
| `__ready` is set during `useEffect` or synchronous setup (before the first tick frame) | The recording script thinks the animation has started, but the WebM is still recording a blank page → **leading blank** |
| The tick's `lastTick = performance.now()` is initialized **at the top level of the script** | The L seconds of font loading get counted into the first frame's `dt`, `time` instantly jumps to L → the entire recording lags by L seconds → **start-point offset** |

**✅ The correct complete starter tick template** (hand-written animations must use this skeleton):

```js
// ━━━━━━ state ━━━━━━
let time = 0;
let playing = false;   // ❗ don't play by default; wait until fonts are ready before starting
let lastTick = null;   // ❗ sentinel — force dt to 0 on tick's first frame (don't use performance.now())
const fired = new Set();

// ━━━━━━ tick ━━━━━━
function tick(now) {
  if (lastTick === null) {
    lastTick = now;
    window.__ready = true;   // ✅ pair: "recording start" and "animation t=0" on the same frame
    render(0);               // render once more to ensure the DOM is ready (fonts are ready by now)
    requestAnimationFrame(tick);
    return;
  }
  const dt = (now - lastTick) / 1000;   // dt only starts advancing after the first frame
  lastTick = now;

  if (playing) {
    let t = time + dt;
    if (t >= DURATION) {
      t = window.__recording ? DURATION - 0.001 : 0;  // don't loop while recording; leave 0.001s to keep the last frame
      if (!window.__recording) fired.clear();
    }
    time = t;
    render(time);
  }
  requestAnimationFrame(tick);
}

// ━━━━━━ boot ━━━━━━
// Don't rAF immediately at the top level — start only after fonts have loaded
document.fonts.ready.then(() => {
  render(0);                 // draw the initial frame first (fonts are ready)
  playing = true;
  requestAnimationFrame(tick);  // the first tick will pair __ready + t=0
});

// ━━━━━━ seek interface (for defensive correction by render-video) ━━━━━━
window.__seek = (t) => { fired.clear(); time = t; lastTick = null; render(t); };
```

**Why this template is correct**:

| Step | Why it must be this way |
|------|-------------|
| `lastTick = null` + first-frame `return` | Avoids counting the L seconds "from script load to tick's first execution" into the animation time |
| `playing = false` by default | Even if `tick` runs during font loading, time doesn't advance, avoiding rendering misalignment |
| `__ready` set on tick's first frame | The recording script starts timing at this moment, and the corresponding frame is the animation's true t=0 |
| Start tick only inside `document.fonts.ready.then(...)` | Avoids font-fallback width measurement, avoids the first-frame font jump |
| `window.__seek` exists | Lets `render-video.js` actively correct — a second line of defense |

**Corresponding defenses on the recording-script side**:
1. Use `addInitScript` to inject `window.__recording = true` (before page goto)
2. `waitForFunction(() => window.__ready === true)`, recording this moment's offset as the ffmpeg trim
3. **Additionally**: after `__ready`, actively call `page.evaluate(() => window.__seek && window.__seek(0))` to forcibly zero out any time offset the HTML might have — this is the second line of defense, against HTML that doesn't strictly follow the starter template

**Verification method**: after exporting the MP4
```bash
ffmpeg -i video.mp4 -ss 0 -vframes 1 frame-0.png
ffmpeg -i video.mp4 -ss $DURATION-0.1 -vframes 1 frame-end.png
```
The first frame must be the animation's t=0 initial state (not mid-animation, not black), and the last frame must be the animation's final state (not some moment in a second loop).

**Reference implementation**: the Stage component in `assets/animations.jsx` and `scripts/render-video.js` are both implemented per this protocol. Hand-written HTML must follow the starter tick template — every line defends against a specific bug.

## 13. Disallow looping while recording — the `window.__recording` signal

**The trap**: The animation Stage defaults to `loop=true` (convenient for viewing effects in the browser). `render-video.js` waits an extra 300ms buffer after recording the duration seconds before stopping, and that 300ms lets the Stage enter the next loop. When ffmpeg `-t DURATION` clips, the last 0.5-1s falls into the next loop — the end of the video suddenly returns to the first frame (Scene 1), and the audience thinks the video is buggy.

**Root cause**: there's no "I'm recording" handshake protocol between the recording script and the HTML. The HTML doesn't know it's being recorded, and still loops per the browser-interaction scenario.

**Rules**:

1. **Recording script**: inject `window.__recording = true` in `addInitScript` (before page goto):
   ```js
   await recordCtx.addInitScript(() => { window.__recording = true; });
   ```

2. **Stage component**: recognize this signal, force loop=false:
   ```js
   const effectiveLoop = (typeof window !== 'undefined' && window.__recording) ? false : loop;
   // ...
   if (next >= duration) return effectiveLoop ? 0 : duration - 0.001;
   //                                                       ↑ leave 0.001 to prevent a Sprite with end=duration from being turned off
   ```

3. **The ending Sprite's fadeOut**: in the recording scenario it should be set to `fadeOut={0}`, otherwise the end of the video will fade to transparent/dark — the user expects to stop on a clear last frame, not a fade-out. For hand-written HTML, it's recommended that ending Sprites all use `fadeOut={0}`.

**Reference implementation**: the Stage in `assets/animations.jsx` and `scripts/render-video.js` both have the handshake built in. A hand-written Stage must implement `__recording` detection — otherwise recording will inevitably hit this trap.

**Verification**: after exporting the MP4, run `ffmpeg -ss 19.8 -i video.mp4 -frames:v 1 end.png`, and check whether the last 0.2 seconds is still the expected last frame, with no sudden switch to another scene.

## 14. 60fps video defaults to frame duplication — minterpolate has poor compatibility

**The trap**: The 60fps MP4 generated by `convert-formats.sh` using `minterpolate=fps=60:mi_mode=mci...` cannot be opened in some versions of macOS QuickTime / Safari (all black, or simply refuses to open). VLC / Chrome can open it.

**Root cause**: the H.264 elementary stream output by minterpolate contains certain SEI / SPS fields that some players have trouble parsing.

**Rules**:

- For default 60fps, use the simple `fps=60` filter (frame duplication), which has broad compatibility (QuickTime/Safari/Chrome/VLC can all open it)
- For high-quality interpolation, enable it explicitly with the `--minterpolate` flag — but you **must test the target player locally** before delivery
- The value of the 60fps label is **the upload platform's algorithmic recognition** (Bilibili / YouTube prioritize streaming for the 60fps marker); the actual perceived smoothness improvement for CSS animations is marginal
- Add `-profile:v high -level 4.0` to improve H.264 general compatibility

**`convert-formats.sh` has already been changed to compatibility mode by default**. If you need high-quality interpolation, add the `--minterpolate` flag:
```bash
bash convert-formats.sh input.mp4 --minterpolate
```

## 15. The `file://` + external `.jsx` CORS trap — single-file delivery must inline the engine

**The trap**: The animation HTML loaded the engine externally with `<script type="text/babel" src="animations.jsx"></script>`. Opening it locally by double-click (the `file://` protocol) → Babel Standalone fetches `.jsx` via XHR → Chrome reports `Cross origin requests are only supported for protocol schemes: http, https, chrome, chrome-extension...` → the whole page goes black; it doesn't report a `pageerror`, only a console error, which is easily misdiagnosed as "the animation didn't trigger".

Starting an HTTP server doesn't necessarily save you either — when there's a global proxy on the machine, `localhost` also goes through the proxy, returning 502 / connection failure.

**Rules**:

- **Single-file delivery (HTML that works on double-click)** → `animations.jsx` must be **inlined** inside the `<script type="text/babel">...</script>` tag; don't use `src="animations.jsx"`
- **Multi-file project (start an HTTP server to demo)** → external loading is fine, but state the `python3 -m http.server 8000` command clearly on delivery
- The deciding question: is what you're delivering to the user an "HTML file" or a "project directory with a server"? Use inlining for the former
- The Stage component / animations.jsx is often 200+ lines — pasting it into the HTML `<script>` block is entirely acceptable, don't be afraid of the size

**Minimal verification**: double-click the HTML you generated, and **do not** open it through any server. Only if the Stage shows the animation's first frame normally does it pass.

## 16. Cross-scene inverted-color context — don't hard-code colors on in-frame elements

**The trap**: When building a multi-scene animation, elements that **appear across all scenes** like `ChapterLabel` / `SceneNumber` / `Watermark` hard-coded `color: '#1A1A1A'` (dark text) in the component. The first 4 scenes with light backgrounds were OK, but in the 5th, black-background scene the "05" and the watermark simply vanished — no error, no check triggered, key information invisible.

**Rules**:

- **In-frame elements reused across multiple scenes** (chapter label / scene number / timecode / watermark / copyright bar) **must not hard-code color values**
- Use one of three approaches instead:
  1. **`currentColor` inheritance**: the element only writes `color: currentColor`, and the parent scene container sets `color: <computed value>`
  2. **invert prop**: the component accepts `<ChapterLabel invert />` to manually toggle light/dark
  3. **Automatic computation based on background color**: `color: contrast-color(var(--scene-bg))` (the new CSS 4 API, or a JS check)
- Before delivery, use Playwright to extract **a representative frame of each scene** and eyeball whether all "cross-scene elements" are visible

The insidiousness of this trap is that — **there is no bug alarm**. Only the human eye or OCR can catch it.

## 17. Truly self-contained, offline / no CDN — fully inline React/Babel, and the engine must be transpiled too

**The trap (2026-05 Mioo promo animation)**: The animation HTML loaded `<script src="https://unpkg.com/react...">` + `<script src=".../@babel/standalone">` via CDN. With a global proxy on the machine, during Playwright recording chromium hit `net::ERR_CONNECTION_CLOSED` for all of unpkg / Google Fonts:

1. React/ReactDOM didn't load → `window.React undefined`
2. Babel didn't load → the JSX in `<script type="text/babel">` ran as plain JS → `Unexpected token '<'`

After fixing React/Babel, we hit a second trap: **inlining the `animations.jsx` engine as a plain `<script>` still reported `Unexpected token '<'` → `window.Animations is undefined`**. Root cause: **the `animations.jsx` engine itself contains JSX** (the `Stage`/`Sprite` components `return (<div>...)`); it was originally designed to be loaded and transpiled by Babel via `<script type="text/babel">`. We only transpiled the app code and forgot to transpile the engine → that JSX in the engine never got compiled.

**Rules** (when making a truly self-contained single file that's "double-click to open / offline / recordable by Playwright"):

- **Inline React + ReactDOM locally**: `curl` download `react.production.min.js` (~10KB) + `react-dom.production.min.js` (~131KB) locally, inline them into `<script>`, no CDN
- **Babel pre-compiles at build time, no Babel at runtime**: use `@babel/standalone` (download once, build-only) in node with `Babel.transform(src,{presets:['react']}).code` to turn JSX → `React.createElement`. **Both the app and the `animations.jsx` engine must go through transform** — the engine contains JSX; missing it will inevitably report `Unexpected token '<'`
- **Switch fonts to system fonts**: the Google Fonts CDN will likewise be cut off by the proxy. Chinese animations use the system fonts `'PingFang SC'` (sans) / `'Songti SC'` (serif), with no network dependency. `document.fonts.ready` resolves immediately for system fonts, so recording doesn't stall
- **Inline image assets as base64**: a `<img src="png/x.png">` relative path can render under `file://`, but to be truly portable (no missing images when files are moved), inline it as a base64 data URL; convert large background images to JPEG and compress first, then base64
- **Templatize the build**: leave `__REACT__/__REACTDOM__/__ASSETS__/__ENGINE__` tokens in the HTML template + a chunk of `type="text/jsx-source"` app source, and have the node build script read the tokens and inject (vendor as-is, engine + app through Babel) → write out the final single file. To change the animation, just edit the template and rerun the build

**Verification**: Playwright `page.evaluate(()=>({React:typeof window.React, Animations:typeof window.Animations}))` — both should be `object`. Either being `undefined` → the corresponding `<script>` threw an error (most likely un-transpiled JSX).

**Relationship to trap #15**: #15 is about "don't use `src=` to link an external `.jsx` in a single file (file:// CORS)"; this trap goes a step further — even the **remote CDN** for React/Babel/fonts **will be cut off on restricted networks**. To be truly self-contained you must fully inline + transpile at build time.

## Quick self-check list (5 seconds before starting)

- [ ] Does every `position: absolute` parent element have `position: relative`?
- [ ] Do all special characters in the animation (`␣` `⌘` `emoji`) exist in the font?
- [ ] Does the Grid/Flex template count match the length of the JS data?
- [ ] Is there a cross-fade between scene switches, with no pure blank > 0.3s?
- [ ] Is the DOM-measurement code wrapped in `document.fonts.ready.then()`?
- [ ] Is `render(t)` pure, or does it have an explicit reset mechanism?
- [ ] Is frame 0 the complete initial state, not blank?
- [ ] Is there no "fake chrome" decoration in the frame (progress bar / timecode / bottom credit bar colliding with the Stage scrubber)?
- [ ] Does the animation's first tick frame synchronously set `window.__ready = true`? (built into animations.jsx; add it yourself for hand-written HTML)
- [ ] Does the Stage detect `window.__recording` to force loop=false? (must add for hand-written HTML)
- [ ] Is the ending Sprite's `fadeOut` set to 0 (the video ends on a clear frame)?
- [ ] Does the 60fps MP4 use frame-duplication mode by default (compatibility), adding `--minterpolate` only for high-quality interpolation?
- [ ] After export, did you extract frame 0 + the last frame to verify they're the animation's initial/final state?
- [ ] When a specific brand is involved (Stripe/Anthropic/Lovart/...): did you complete the "brand asset protocol" (the 5 steps in SKILL.md §1.a)? Did you write a `brand-spec.md`?
- [ ] For single-file-delivery HTML: is `animations.jsx` inlined, not `src="..."`? (an external .jsx will CORS-blackscreen under file://)
- [ ] Do elements appearing across scenes (chapter label / watermark / scene number) avoid hard-coded colors? Are they visible against every scene's background color?
- [ ] For offline / truly self-contained: are React+ReactDOM inlined locally, are **both the app and the `animations.jsx` engine run through Babel transpile**, and are system fonts used? (see trap #17; the engine contains JSX, and missing the transpile will inevitably report `Unexpected token '<'`)
