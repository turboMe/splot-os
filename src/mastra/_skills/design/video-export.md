# Video Export: Exporting HTML Animations to MP4/GIF

Once an HTML animation is complete, users often ask, "Can it be exported as a video?" This guide provides the complete process.

## When to Export

**Export Timing**:
- The animation runs completely and has been visually verified (Playwright screenshots confirm correct states at various timestamps).
- The user has viewed it in a browser at least once and confirmed the effect is OK.
- **Do not** export when animation bugs are still being fixed—changes become more expensive after exporting to video.

**User's potential trigger phrases**:
- "Can it be exported as a video?"
- "Convert to MP4"
- "Make it a GIF"
- "60fps"

## Output Specifications

By default, provide three formats for the user to choose from:

| Format | Specification | Suitable Scenarios | Typical Size (30s) |
|---|---|---|---|
| MP4 25fps | 1920×1080 · H.264 · CRF 18 | WeChat Official Accounts embedding, Video Accounts, YouTube | 1-2 MB |
| MP4 60fps | 1920×1080 · minterpolate frame interpolation · H.264 · CRF 18 | High frame rate display, Bilibili, portfolio | 1.5-3 MB |
| GIF | 960×540 · 15fps · palette optimized | Twitter/X, README, Slack preview | 2-4 MB |

## Toolchain

Two scripts are in `scripts/`:

### 1. `render-video.js` — HTML → MP4

Records a 25fps MP4 base version. Requires global playwright.

```bash
NODE_PATH=$(npm root -g) node /path/to/claude-design/scripts/render-video.js <html-file>
```

Optional parameters:
- `--duration=30` Animation duration (seconds)
- `--width=1920 --height=1080` Resolution
- `--trim=2.2` Seconds to trim from the beginning of the video (to remove reload + font loading time)
- `--fontwait=1.5` Font loading wait time (seconds), increase if there are many fonts

Output: In the same directory as the HTML, with the same name `.mp4`.

### 2. `add-music.sh` — MP4 + BGM → MP4

Mixes background music into a silent MP4. Choose from the built-in BGM library by mood, or provide your own audio. Automatically matches duration and adds fade-in/fade-out.

```bash
bash add-music.sh <input.mp4> [--mood=<name>] [--music=<path>] [--out=<path>]
```

**Built-in BGM Library** (in `assets/bgm-<mood>.mp3`):

| `--mood=` | Style | Suitable Scenarios |
|-----------|------|---------|
| `tech` (default) | Apple Silicon / Apple keynote, minimalist synth + piano | Product launch, AI tools, Skill promotion |
| `ad` | Upbeat modern electronic, with build + drop | Social media ads, product previews, promotional videos |
| `educational` | Warm and bright, light guitar/electric piano, inviting | Science popularization, tutorial introductions, course previews |
| `educational-alt` | Alternative in the same category, try another track | Same as above |
| `tutorial` | Lo-fi ambient sound, almost imperceptible | Software demos, programming tutorials, long presentations |
| `tutorial-alt` | Alternative in the same category | Same as above |

**Behavior**:
- Music is trimmed to video duration.
- 0.3s fade-in + 1s fade-out (to avoid abrupt cuts).
- Video stream `-c:v copy` (no re-encoding), audio AAC 192k.
- `--music=<path>` takes precedence over `--mood`, allowing direct specification of any external audio.
- Entering an incorrect mood name will list all available options, it will not fail silently.

**Typical Pipeline** (Animation export triple-pack + soundtrack):
```bash
node render-video.js animation.html                        # Record screen
bash convert-formats.sh animation.mp4                      # Derive 60fps + GIF
bash add-music.sh animation-60fps.mp4                      # Add default tech BGM
# Or for different scenarios:
bash add-music.sh tutorial-demo.mp4 --mood=tutorial
bash add-music.sh product-promo.mp4 --mood=ad --out=promo-final.mp4
```

### 3. `convert-formats.sh` — MP4 → 60fps MP4 + GIF

Generates a 60fps version and a GIF from an existing MP4.

```bash
bash /path/to/claude-design/scripts/convert-formats.sh <input.mp4> [gif_width] [--minterpolate]
```

Output (in the same directory as the input):
- `<name>-60fps.mp4` — Defaults to `fps=60` frame duplication (wide compatibility); add `--minterpolate` to enable high-quality frame interpolation.
- `<name>.gif` — Palette-optimized GIF (default 960 width, can be changed).

**60fps Mode Selection**:

| Mode | Command | Compatibility | Use Case |
|---|---|---|---|
| Frame duplication (default) | `convert-formats.sh in.mp4` | QuickTime/Safari/Chrome/VLC all compatible | General delivery, platform uploads, social media |
| minterpolate interpolation | `convert-formats.sh in.mp4 --minterpolate` | macOS QuickTime/Safari might refuse to play | Bilibili and other scenarios requiring true interpolation; **must test locally** on target player before delivery |

Why default to frame duplication? minterpolate output H.264 elementary stream has a known compatibility bug—previously, when minterpolate was default, we repeatedly encountered issues where "macOS QuickTime couldn't open it." See `animation-pitfalls.md` §14 for details.

`gif_width` parameter:
- 960 (default) — General for social platforms
- 1280 — Clearer but larger file size
- 600 — Prioritized loading for Twitter/X

### 4. `render-video-seek.js` — True 60fps / Deterministic Rendering (Recommended for High-Quality Delivery)

The `recordVideo` path of `render-video.js` has three inherent limitations: frame rate locked to 25fps by Chromium compositor, initial loading black frames requiring trimming, and 60fps only achievable through post-processing minterpolate interpolation (which has ghosting + macOS QuickTime compatibility bugs, see `animation-pitfalls.md §14`). When **true 60fps, deterministic output, or delivery to Bilibili/portfolio** is required, switch to seek rendering.

It seeks to timestamps frame by frame, takes screenshots, and then uses ffmpeg to encode the PNG sequence into an MP4. The technical core borrows the "freeze clock + seek screenshot" idea from HeyGen HyperFrames (Apache 2.0), but without introducing any third-party packages—it only uses playwright + ffmpeg already present in this skill, making it runtime-agnostic.

```bash
NODE_PATH=$(npm root -g) node /path/to/claude-design/scripts/render-video-seek.js <html-file> --fps=60
```

Parameters: `--duration` · `--fps` (default 60) · `--width` · `--height` · `--concurrency` (default 4 workers in parallel) · `--settle` (wait for a few rAFs after seeking before taking a screenshot, default 2, can be increased for heavy layout animations) · `--keep-chrome`. Output is in the same directory as the HTML, with the same name `.mp4`.

Directly addresses the three deadlocks of recordVideo:
- **True native arbitrary frame rate**: `--fps=60` produces true 60fps (each frame is a real sought-after image), no longer relying on `convert-formats.sh`'s minterpolate interpolation, bypassing ghosting + macOS compatibility bugs.
- **No initial black frames**: No screen recording, so no loading period black frames at all, no need for `--trim` / `--fontwait`.
- **Determinism**: Screenshots are taken by seeking to timestamps, same input yields same output, unaffected by machine load/frame drops.

**Applicable Scope (Important)**: Only supports animations that use Stage clock—`<Stage>` from `assets/animations.jsx` or `<NarrationStage>` from `narration_stage.jsx`. These respond to `window.__seekRender` to freeze their self-driving clock and expose `window.__seek(t)`. Pure CSS `@keyframes` / Lottie / manually written non-Stage animations do not respond to `__seek`; for these, continue to use `render-video.js` (the script will error and prompt if `__seek` is not detected).

**Cost**: Frame-by-frame screenshots, total time for long videos might be longer than real-time recording with recordVideo (mitigated by `--concurrency` multiple workers); large number of temporary PNGs occupy disk space, it's recommended to close other memory-intensive apps before rendering.

**Either-or Strategy**: By default, still use `render-video.js` (zero risk, covers all animation types); use `render-video-seek.js` when true 60fps / determinism / high-quality delivery is needed, and the animation uses the Stage clock. Long animations with narration can use `render-narration.sh --seek` for one-click seek rendering + audio mixing.

## Complete Workflow (Standard Recommendation)

After the user says "export video":

```bash
cd <project-directory>

# Assume $SKILL points to the root directory of this skill (replace according to installation location)

# 1. Record 25fps base MP4
NODE_PATH=$(npm root -g) node "$SKILL/scripts/render-video.js" my-animation.html

# 2. Derive 60fps MP4 and GIF
bash "$SKILL/scripts/convert-formats.sh" my-animation.mp4

# Output list:
# my-animation.mp4         (25fps · 1-2 MB)
# my-animation-60fps.mp4   (60fps · 1.5-3 MB)
# my-animation.gif         (15fps · 2-4 MB)
```

## Technical Details (for Troubleshooting)

### Pitfalls of Playwright recordVideo

- Frame rate fixed at 25fps, cannot directly record 60fps (Chromium headless compositor limit).
- Recording starts from context creation, requiring `trim` to cut off initial loading time.
- Default webm format, requires ffmpeg to convert to H.264 MP4 for universal playback.

`render-video.js` already handles these issues.

### ffmpeg minterpolate parameters

Current configuration: `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`

- `mi_mode=mci` — motion compensation interpolation
- `mc_mode=aobmc` — adaptive overlapped block motion compensation
- `me_mode=bidir` — bidirectional motion estimation
- `vsbmc=1` — variable size block motion compensation

Works well for CSS **transform animations** (translate/scale/rotate).
May produce slight ghosting for **pure fades**—if the user dislikes it, revert to simple frame duplication:

```bash
ffmpeg -i input.mp4 -r 60 -c:v libx264 ... output.mp4
```

### Why GIF palette needs two stages

GIFs are limited to 256 colors. A single-pass GIF will compress all animation colors into a universal 256-color palette, which can blur delicate color schemes like beige background + orange.

Two stages:
1. `palettegen=stats_mode=diff` — First scans the entire video to generate an **optimal palette specifically for this animation**.
2. `paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle` — Encodes using this palette, with rectangle diff only updating changed areas, significantly reducing file size.

For fade transitions, `dither=bayer` is smoother than `none`, but results in a slightly larger file.

## Pre-flight check (before export)

30-second self-check before export:

- [ ] HTML has run completely in the browser, with no console errors.
- [ ] Animation's 0th frame is the complete initial state (not a blank loading state).
- [ ] Animation's last frame is a stable ending state (not cut off midway).
- [ ] All fonts/images/emojis render correctly (refer to `animation-pitfalls.md`).
- [ ] `Duration` parameter matches the actual animation duration in HTML.
- [ ] HTML's Stage detects `window.__recording` to force `loop=false` (must check for custom Stages; `assets/animations.jsx` handles this automatically).
- [ ] Ending Sprite has `fadeOut={0}` (no fade-out on the last video frame).
- [ ] Includes "Created by Huashu-Design" watermark (required only for animation scenarios; for third-party brand works, add "Unofficial Production · " prefix. See SKILL.md § "Skill Promotion Watermark" for details).

## Accompanying Notes for Delivery

Standard note format for users after export:

```
**Complete Delivery**

| File | Format | Specification | Size |
|---|---|---|---|
| foo.mp4 | MP4 | 1920×1080 · 25fps · H.264 | X MB |
| foo-60fps.mp4 | MP4 | 1920×1080 · 60fps (motion interpolated) · H.264 | X MB |
| foo.gif | GIF | 960×540 · 15fps · palette optimized | X MB |

**Notes**
- 60fps uses minterpolate for motion estimation interpolation, which works well for transform animations.
- GIF uses palette optimization, a 30s animation can be compressed to around 3MB.

Let me know if you need different dimensions or frame rates.
```

## Common User Follow-up Requests

| User says | Response |
|---|---|
| "It's too big" | MP4: Increase CRF to 23-28; GIF: Reduce resolution to 600 or fps to 10 |
| "GIF is too blurry" | Increase `gif_width` to 1280; or suggest using MP4 instead (WeChat Moments also supports it) |
| "I need vertical 9:16" | Change HTML source's `--width=1080 --height=1920`, re-record |
| "Add a watermark" | Use ffmpeg with `-vf "drawtext=..."` or `overlay=` a PNG |
| "I need a transparent background" | MP4 does not support alpha; use WebM VP9 + alpha or APNG |
| "I need lossless" | Change CRF to 0 + preset veryslow (file size will be 10x larger) |