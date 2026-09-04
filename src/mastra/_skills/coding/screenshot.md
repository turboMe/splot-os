---
name: screenshot
category: coding
description: "Use when the user explicitly asks for a desktop or system screenshot (full screen, specific app or window, or a pixel region), or when tool-specific capture capabilities are unavailable and an OS-level capture is needed."
keywords: [screenshot, capture, screen, window, desktop, scrot, visual, debug]
source: openai/skills
recommendedTier: pro
handoffCapable: true
---

# Screenshot Capture

Save-location rules:
1) If the user specifies a path, save there.
2) If no path specified, save to the OS default screenshot location.
3) If the agent needs a screenshot for its own inspection, save to temp.

## Tool priority

- Prefer tool-specific screenshot capabilities when available (Playwright, agent-browser).
- Use this skill for whole-system desktop captures or when no better tool exists.

## Linux (Python helper)

```bash
python3 screenshot-scripts/take_screenshot.py
python3 screenshot-scripts/take_screenshot.py --mode temp
python3 screenshot-scripts/take_screenshot.py --path output/screen.png
python3 screenshot-scripts/take_screenshot.py --mode temp --active-window
python3 screenshot-scripts/take_screenshot.py --mode temp --region 100,200,800,600
python3 screenshot-scripts/take_screenshot.py --window-id 12345
```

### Linux prerequisites

The helper selects the first available tool: `scrot` → `gnome-screenshot` → ImageMagick `import`.

## Direct OS fallbacks

```bash
scrot output/screen.png                              # full screen
scrot -a 100,200,800,600 output/region.png           # region
scrot -u output/window.png                           # active window
gnome-screenshot -f output/screen.png                # full screen
gnome-screenshot -w -f output/window.png             # active window
import -window root output/screen.png                # ImageMagick full
import -window root -crop 800x600+100+200 output/region.png  # region
```

## Error handling

- Check tool availability: `command -v scrot`, `command -v gnome-screenshot`, `command -v import`.
- Always report the saved file path in the response.
