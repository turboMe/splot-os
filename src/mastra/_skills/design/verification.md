# Verification: Output Validation Process

Some design-agent native environments (e.g., Claude.ai Artifacts) have a built-in `fork_verifier_agent` that launches a subagent to perform iframe screenshot checks. Most agent environments (Claude Code / Codex / Cursor / Trae / etc.) lack this built-in capability – manual verification using Playwright can cover the same validation scenarios.

## Validation Checklist

After each HTML output, go through this checklist:

### 1. Browser Rendering Check (Mandatory)

The most basic: **Can the HTML be opened**? On macOS:

```bash
open -a "Google Chrome" "/path/to/your/design.html"
```

Or use Playwright for screenshots (next section).

### 2. Console Error Check

The most common issue in HTML files is a blank screen caused by JS errors. Run it with Playwright:

```bash
python ~/.claude/skills/huashu-design/scripts/verify.py path/to/design.html
```

This script will:
1. Open the HTML with headless Chromium
2. Save a screenshot to the project directory
3. Capture console errors
4. Report status

See `scripts/verify.py` for details.

### 3. Multiple Viewport Check

For responsive designs, capture multiple viewports:

```bash
python verify.py design.html --viewports 1920x1080,1440x900,768x1024,375x667
```

### 4. Interaction Check

Tweaks, animations, button toggles – these are not visible in default static screenshots. **It's recommended to have the user open the browser and click through it themselves**, or use Playwright for screen recording:

```python
page.video.record('interaction.mp4')
```

### 5. Slide-by-Slide Check

For deck-like HTML, capture slide by slide:

```bash
python verify.py deck.html --slides 10  # Capture the first 10 slides
```

Generates `deck-slide-01.png`, `deck-slide-02.png`... for quick browsing.

## Playwright Setup

First-time use requires:

```bash
# If not already installed
npm install -g playwright
npx playwright install chromium

# Or Python version
pip install playwright
playwright install chromium
```

If Playwright is already installed globally, you can use it directly.

## Screenshot Best Practices

### Capture Full Page

```python
page.screenshot(path='full.png', full_page=True)
```

### Capture Viewport

```python
page.screenshot(path='viewport.png')  # By default, only captures the visible area
```

### Capture Specific Element

```python
element = page.query_selector('.hero-section')
element.screenshot(path='hero.png')
```

### High-Resolution Screenshot

```python
page = browser.new_page(device_scale_factor=2)  # retina
```

### Wait for Animation to Finish Before Capturing

```python
page.wait_for_timeout(2000)  # Wait 2 seconds for animation to settle
page.screenshot(...)
```

## Send Screenshots to User

### Open Local Screenshots Directly

```bash
open screenshot.png
```

The user will view them in their own Preview/Figma/VSCode/browser.

### Upload to Image Host and Share Link

If you need to show them to remote collaborators (e.g., Slack/Feishu/WeChat), have the user upload the screenshots using their own image hosting tool or MCP to get a permanent link that can be pasted anywhere.

## When Validation Fails

### Blank Page

There must be an error in the console. First, check:

1. If the integrity hash of the React+Babel script tag is correct (see `react-setup.md`)
2. If there's a naming conflict with `const styles = {...}`
3. If cross-file components are exported to `window`
4. JSX syntax errors (if `babel.min.js` doesn't report errors, switch to the uncompressed `babel.js` version)

### Stuttering Animation

- Record a segment using the Chrome DevTools Performance tab
- Look for layout thrashing (frequent reflows)
- Prioritize `transform` and `opacity` for animations (GPU accelerated)

### Incorrect Font

- Check if the `@font-face` URL is accessible
- Check fallback fonts
- Slow loading of Chinese fonts: display fallback first, then switch after loading

### Layout Misalignment

- Check if `box-sizing: border-box` is applied globally
- Check `* margin: 0; padding: 0` reset
- Open gridlines in Chrome DevTools to see the actual layout

## Validation = Designer's Second Pair of Eyes

**Always review it yourself**. When AI writes code, issues often arise such as:

- Looks correct but has interaction bugs
- Static screenshots look good, but misalignment occurs on scroll
- Looks good on wide screens but breaks on narrow screens
- Dark mode forgotten to be tested
- Some components don't respond after tweak toggles

**The last minute of validation can save an hour of rework**.

## Common Validation Script Commands

```bash
# Basic: Open + Screenshot + Capture Errors
python verify.py design.html

# Multiple viewports
python verify.py design.html --viewports 1920x1080,375x667

# Multiple slides
python verify.py deck.html --slides 10

# Output to specified directory
python verify.py design.html --output ./screenshots/

# headless=false, opens a real browser for you to see
python verify.py design.html --show
```