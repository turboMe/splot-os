# Slide Decks: HTML Slide Production Spec

Making slides is a high-frequency design scenario. This document explains how to make good HTML slides — covering the full path from architecture selection and single-page design through to PDF/PPTX export.

**What this skill covers:**
- **HTML presentation version (the base deliverable, always the default and always required)** → each page is a standalone HTML + `assets/deck_index.html` aggregator, with keyboard page-turning and fullscreen presenting in the browser
- HTML → PDF export → `scripts/export_deck_pdf.mjs` / `scripts/export_deck_stage_pdf.mjs`
- HTML → editable PPTX export → `references/editable-pptx.md` + `scripts/html2pptx.js` + `scripts/export_deck_pptx.mjs` (requires the HTML to be written under 4 hard constraints)

> **⚠️ HTML is the base; PDF/PPTX are derivatives.** No matter what final format you deliver, you **must** first make the HTML aggregated presentation version (`index.html` + `slides/*.html`) — it is the "source" of the slide work. PDF/PPTX are snapshots exported from the HTML with a single command.
>
> **Why HTML first:**
> - Best for live talks/presentations (projectors / screen-sharing go fullscreen directly, keyboard page-turning, no dependency on Keynote/PPT software)
> - During development each page can be opened and verified by double-clicking individually, without re-running the export every time
> - It is the sole upstream of PDF/PPTX export (avoids the death loop of "discovering you need to change the HTML only after exporting, then re-exporting")
> - The deliverable can be a dual set of "HTML + PDF" or "HTML + PPTX" — the recipient uses whichever they prefer
>
> 2026-04-22 moxt brochure real-world test: after finishing 13 pages of HTML + index.html aggregation, `export_deck_pdf.mjs` exported the PDF in a single line, with zero changes. The HTML version is itself a deliverable that can be presented directly in the browser.

---

## 🛑 Confirm the delivery format before starting (the hardest checkpoint)

**This decision comes even before "single-file or multi-file."** 2026-04-20 options private board project real-world test: **not confirming the delivery format before starting = 2-3 hours of rework.**

### Decision tree (HTML-first architecture)

All deliverables start from the same set of HTML aggregation pages (`index.html` + `slides/*.html`). The delivery format only determines the **HTML authoring constraints** and the **export command**:

```
【Always default · required】 HTML aggregated presentation (index.html + slides/*.html)
   │
   ├── Browser presenting only / local HTML archive   → done here, HTML has maximum visual freedom
   │
   ├── Also need PDF (print / share to group / archive)     → run export_deck_pdf.mjs for one-click output
   │                                          HTML authoring is free, no visual constraints
   │
   └── Also need editable PPTX (colleagues will edit text)    → write HTML under the 4 hard constraints from line 1
                                              run export_deck_pptx.mjs for one-click output
                                              sacrifice gradients / web components / complex SVG
```

### Kickoff talking points (copy and use)

> No matter whether the final delivery is HTML, PDF, or PPTX, I will first make an HTML aggregated version that can be switched and presented in the browser (`index.html` plus keyboard page-turning) — this is always the default base deliverable. On top of that I'll ask whether you also want an extra PDF / PPTX snapshot.
>
> Which export format do you need?
> - **HTML only** (presenting/archiving) → fully free visually
> - **Also PDF** → same as above, plus one export command
> - **Also editable PPTX** (colleagues will edit the text in PPT) → I must write the HTML under the 4 hard constraints from line 1, which sacrifices some visual capability (no gradients, no web components, no complex SVG).

### Why "needing PPTX means going through the 4 hard constraints from the start"

The precondition for an editable PPTX is that `html2pptx.js` can translate the DOM element-by-element into PowerPoint objects. It requires **4 hard constraints**:

1. body fixed at 960pt × 540pt (matching `LAYOUT_WIDE`, 13.333″ × 7.5″, not 1920×1080px)
2. all text wrapped in `<p>`/`<h1>`-`<h6>` (no putting text directly in a div, no using `<span>` to carry primary text)
3. `<p>`/`<h*>` themselves cannot have background/border/shadow (put those on an outer div)
4. `<div>` cannot use `background-image` (use an `<img>` tag)
5. no CSS gradient, no web components, no complex SVG decorations

**This skill's default HTML has high visual freedom** — lots of spans, nested flex, complex SVG, web components (such as `<deck-stage>`), CSS gradients — **almost none of which naturally pass the html2pptx constraints** (real-world test: feeding visually-driven HTML straight into html2pptx has a pass rate < 30%).

### Cost comparison of two real paths (real pitfalls from 2026-04-20)

| Path | Approach | Result | Cost |
|------|------|------|------|
| ❌ **Write HTML freely first, patch PPTX afterward** | single-file deck-stage + lots of SVG/span decoration | Getting an editable PPTX leaves only two options:<br>A. Hand-write hundreds of lines of pptxgenjs with hardcoded coordinates<br>B. Rewrite 17 pages of HTML into the Path A format | 2-3 hours of rework, and the hand-written version has **perpetual maintenance cost** (change one word in the HTML, and the PPTX must be manually re-synced) |
| ✅ **Write to the Path A constraints from step one** | each page is standalone HTML + 4 hard constraints + 960×540pt | One command exports a 100% editable PPTX, and it can also be presented fullscreen in the browser (Path A HTML is just standard HTML the browser can play) | Spend 5 extra minutes per page thinking "how do I wrap this text in `<p>`," zero rework |

### What to do about mixed delivery

A user says "I want HTML presenting **and** editable PPTX" — **this is not a mix**; the PPTX requirement subsumes the HTML requirement. HTML written to Path A can itself be presented fullscreen in the browser (just add a `deck_index.html` stitcher). **There's no extra cost.**

A user says "I want PPTX **and** animation / web components" — **this is a genuine contradiction.** Tell the user: wanting an editable PPTX means sacrificing these visual capabilities. Make them choose; don't secretly do the hand-written pptxgenjs approach (it becomes perpetual maintenance debt).

### What to do when you only learn PPTX is needed afterward (emergency remedy)

In rare cases: the HTML is already written before you discover PPTX is needed. The recommended approach is the **fallback flow** (full explanation at the end of `references/editable-pptx.md`, "Fallback: existing visual draft but the user insists on editable PPTX"):

1. **First choice: produce a PDF** (visuals 100% preserved, cross-platform, the recipient can view and print) — if the recipient's actual need is "presenting/archiving," PDF is the best deliverable
2. **Second choice: have the AI rewrite an editable HTML using the visual draft as a blueprint** → export an editable PPTX — preserving the design decisions of color/layout/copy, sacrificing gradients, web components, complex SVG, and other visual capabilities
3. **Not recommended: hand-rebuild with pptxgenjs** — position, font, and alignment all need manual tuning, the maintenance cost is high, and every later word change in the HTML requires manually re-syncing again

Always tell the user the choices and let them decide. **Never make hand-writing pptxgenjs your first reaction** — that is the last-resort fallback.

---

## 🛑 Before batch production: make a 2-page showcase to set the grammar

**As long as a deck is ≥ 5 pages, absolutely do not write straight from page 1 to the last page.** The correct sequence validated by the 2026-04-22 moxt brochure practice:

1. Pick the **2 page types with the biggest visual difference** to make a showcase first (e.g. "cover" + "emotion/quote page," or "cover" + "product showcase page")
2. Screenshot it and let the user confirm the grammar (masthead / fonts / colors / spacing / structure / Chinese-English bilingual ratio)
3. Once the direction is approved, batch out the remaining N-2 pages, reusing the established grammar on each page
4. After everything is done, assemble the HTML aggregation + PDF / PPTX derivatives together

**Why:** writing all 13 pages straight through → user says "wrong direction" = 13× rework. Make a 2-page showcase first → wrong direction = 2× rework. Once the visual grammar is established, the decision space for the remaining N pages shrinks dramatically, leaving only "how to fit the content in."

**Showcase page selection principle:** pick the two pages with the most different visual structure. If those two pass, all the in-between states will pass too.

| Deck type | Recommended showcase page combination |
|-----------|---------------------|
| B2B brochure / product launch | cover + content page (philosophy/emotion page) |
| Brand launch | cover + product feature page |
| Data report | big data visualization page + analysis conclusion page |
| Tutorial courseware | chapter cover page + specific knowledge-point page |

---

## 📐 Publication grammar template (reusable, moxt-tested)

Suitable for B2B brochure / product launch / long-report style decks. Reusing this structure per page = 13 pages perfectly visually consistent, 0 rework.

### Per-page skeleton

```
┌─ masthead (top strip + horizontal rule) ──┐
│  [logo 22-28px] · A Product Brochure                Issue · Date · URL │
├──────────────────────────────────────────┤
│                                          │
│  ── kicker (green short dash + uppercase label)   │
│  CHAPTER XX · SECTION NAME                 │
│                                          │
│  H1 (Chinese Noto Serif SC 900)           │
│  key word alone in the brand primary color │
│                                          │
│  English subtitle (Lora italic, subtitle) │
│  ─────────── divider ──────────          │
│                                          │
│  [specific content: two-column 60/40 / 2x2 grid / list] │
│                                          │
├──────────────────────────────────────────┤
│ section name                     XX / total │
└──────────────────────────────────────────┘
```

### Style conventions (copy directly)

- **H1**: Chinese Noto Serif SC 900, font size 80-140px depending on information density, key word alone in the brand primary color (don't pile color over the whole text)
- **English subtitle**: Lora italic 26-46px, brand signature word (e.g. "AI team") bold + primary-color italic
- **Body**: Noto Serif SC 17-21px, line-height 1.75-1.85
- **Accent highlight**: use the primary color and bold to mark keywords in the body, no more than 3 per page (too many lose their anchoring effect)
- **Background**: warm-beige base #FAFAFA + a very faint radial-gradient noise (`rgba(33,33,33,0.015)`) to add a paper feel

### The visual lead must be differentiated

13 pages of all "text + one screenshot" would be too monotonous. **Rotate the type of visual lead on each page:**

| Visual type | Suitable section |
|---------|---------------|
| Cover layout (big type + masthead + pillar) | first page / chapter cover |
| Single-character portrait (oversized single momo, etc.) | introducing a single concept/character |
| Multi-character group shot / avatar cards side by side | team / user cases |
| Timeline card progression | showing "long-term relationship" or "evolution" |
| Knowledge graph / connected-node diagram | showing "collaboration" or "flow" |
| Before/After comparison cards + arrow in the middle | showing "change" or "difference" |
| Product UI screenshot + outlined device frame | specific feature demo |
| Big-quote (half-page big type) | emotion page / problem page / quote page |
| Real person avatar + quote card (2×2 or 1×4) | user testimonials / use scenarios |
| Big-type back cover + URL pill button | CTA / ending |

---

## ⚠️ Common pitfalls (summary from moxt practice)

### 1. Emoji don't render during Chromium / Playwright export

Chromium by default does not ship a color emoji font; with `page.pdf()` or `page.screenshot()`, emoji show as empty boxes.

**Countermeasure:** use Unicode text symbols (`✦` `✓` `✕` `→` `·` `—`) as replacements, or switch to plain text directly ("Email · 23" instead of "📧 23 emails").

### 2. `export_deck_pdf.mjs` errors with `Cannot find package 'playwright'`

Cause: ESM module resolution searches upward for `node_modules` from the script's location. The script is in `~/.claude/skills/huashu-design/scripts/`, which has no dependencies there.

**Countermeasure:** copy the script into the deck project directory (e.g. `brochure/build-pdf.mjs`), run `npm install playwright pdf-lib` at the project root, then `node build-pdf.mjs --slides slides --out output/deck.pdf`.

### 3. Screenshot taken before Google Fonts finish loading → Chinese shows as the system default heiti

Before a Playwright screenshot/PDF, wait at least `wait-for-timeout=3500` to let the webfont download and paint. Or self-host the fonts to `shared/fonts/` to reduce network dependency.

### 4. Information-density imbalance: content page crammed too full

The first version of the moxt philosophy page used 2×2 = 4 paragraphs + 3 tenets at the bottom = 7 blocks of content, crowded and repetitive. After changing to 1×3 = 3 paragraphs, the breathing room returned immediately.

**Countermeasure:** keep each page to "1 core message + 3-4 supporting points + 1 visual lead"; if you exceed that, split it onto a new page. **Less is more** — the audience looks at one page for 10 seconds; giving them 1 memory point is easier to remember than 4.

---

## 🛑 Decide the architecture first: single-file or multi-file?

**This choice is the first step of making slides; getting it wrong leads to repeated pitfalls. Finish reading this section before starting.**

### Comparison of the two architectures

| Dimension | Single-file + `deck_stage.js` | **Multi-file + `deck_index.html` stitcher** |
|------|--------------------------|--------------------------------------|
| Code structure | one HTML, all slides are `<section>` | each page is standalone HTML, `index.html` stitches via iframe |
| CSS scope | ❌ global, one page's styles can affect all pages | ✅ naturally isolated, each iframe has its own world |
| Verification granularity | ❌ need JS goTo to switch to a page | ✅ a single-page file can be viewed in the browser with a double-click |
| Parallel development | ❌ one file, multiple agents editing will conflict | ✅ multiple agents can do different pages in parallel, zero-conflict merge |
| Debugging difficulty | ❌ one CSS mistake capsizes the whole deck | ✅ a page error only affects itself |
| Embedded interactivity | ✅ sharing state across pages is simple | 🟡 iframes need postMessage between them |
| Print PDF | ✅ built-in | ✅ stitcher iterates iframes on beforeprint |
| Keyboard navigation | ✅ built-in | ✅ built into the stitcher |

### Which one to pick? (decision tree)

```
│ Q: how many pages is the deck expected to have?
├── ≤10 pages, needs in-deck animation or cross-page interaction, pitch deck → single-file
└── ≥10 pages, academic lecture, courseware, long deck, multi-agent parallel → multi-file (recommended)
```

**Default to the multi-file path.** It is not an "alternative"; it is the **main path for long decks and team collaboration.** Reason: every advantage of the single-file architecture (keyboard navigation, print, scale) is also present in multi-file, while multi-file's scope isolation and verifiability are things single-file can never recover.

### Why is this rule so hard? (record of a real incident)

The single-file architecture once stepped on four pitfalls during the production of the AI Psychology Lecture deck:

1. **CSS specificity override**: `.emotion-slide { display: grid }` (specificity 10) overpowered `deck-stage > section { display: none }` (specificity 2), causing all pages to render stacked at once.
2. **Shadow DOM slot rules suppressed by outer CSS**: `::slotted(section) { display: none }` couldn't hold back the outer rule's override, and the sections refused to hide.
3. **localStorage + hash navigation race condition**: after a refresh, instead of jumping to the hash position, it stopped at the old position recorded in localStorage.
4. **High verification cost**: you had to `page.evaluate(d => d.goTo(n))` to capture a page — twice as slow as `goto(file://.../slides/05-X.html)` directly, and frequently errored.

The root cause of all of this is **a single global namespace** — the multi-file architecture eliminates these problems at the physical layer.

---

## Path A (default): multi-file architecture

### Directory structure

```
MyDeck/
├── index.html              # copied from assets/deck_index.html, edit the MANIFEST
├── shared/
│   ├── tokens.css          # shared design tokens (palette/font sizes/common chrome)
│   └── fonts.html          # <link> to import Google Fonts (include on every page)
└── slides/
    ├── 01-cover.html       # each file is a complete 1920×1080 HTML
    ├── 02-agenda.html
    ├── 03-problem.html
    └── ...
```

### Template skeleton of each slide

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>P05 · Chapter Title</title>
<link href="https://fonts.googleapis.com/css2?family=..." rel="stylesheet">
<link rel="stylesheet" href="../shared/tokens.css">
<style>
  /* Styles unique to this page. Any class name used here won't pollute other pages. */
  body { padding: 120px; }
  .my-thing { ... }
</style>
</head>
<body>
  <!-- 1920×1080 content (the body's width/height is locked in tokens.css) -->
  <div class="page-header">...</div>
  <div>...</div>
  <div class="page-footer">...</div>
</body>
</html>
```

**Key constraints:**
- `<body>` is the canvas; lay out directly on it. Don't wrap a `<section>` or other wrapper.
- `width: 1920px; height: 1080px` is locked by the `body` rule in `shared/tokens.css`.
- Import `shared/tokens.css` for shared design tokens (palette, font sizes, page-header/footer, etc.).
- Write the font `<link>` on each page yourself (importing fonts separately is cheap, and it guarantees each page can be opened independently).

### Stitcher: `deck_index.html`

**Copy directly from `assets/deck_index.html`.** You only need to change one thing — the `window.DECK_MANIFEST` array, listing all slide file names and human-readable labels in order:

```js
window.DECK_MANIFEST = [
  { file: "slides/01-cover.html",    label: "Cover" },
  { file: "slides/02-agenda.html",   label: "Agenda" },
  { file: "slides/03-problem.html",  label: "Problem statement" },
  // ...
];
```

The stitcher has built-in: keyboard navigation (←/→/Home/End/number keys/P to print), scale + letterbox, bottom-right counter, localStorage memory, hash page jumping, print mode (iterates iframes to output PDF page by page).

#### Two overview modes (adaptive + pitfall-proof, rewritten 2026-06)

Opening a deck defaults to the **overview**; when the user doesn't specify, it's randomized by seconds: **grid 60% / infinite gallery 40%** (can be fixed via the URL `?ov=grid|gallery` or `window.DECK_OVERVIEW='grid'|'gallery'`).

- **Grid (the default workhorse)**: uses **iframes to render the real child pages** (sharp, WYSIWYG, no thumbnails needed). **Adaptive**: if it can fit on one screen → diagonally tilted, centered, filling the screen; if there are too many pages to fit → cards stay a comfortable size and **scroll vertically** (never cram dozens of pages onto one screen shrunk to postage-stamp size).
- **Infinite gallery**: all pages **seamlessly tile infinitely + drift slowly + gently breathe with scale**; one tile contains all pages (shuffled arrangement, repeating only after you've seen all pages). With many tiles, you **must use `<img>` thumbnails** to bear the performance load (see below); when there are no thumbs, it falls back to iframes.

🛑 **Three hard constraints from practice (must-read before editing this file, or you'll repeat the same mistakes):**
1. **Never build the overview wall as a card wall with `transform-style: preserve-3d`.** In a preserve-3d 3D scene, the browser's hit-testing for "cards receding into the back" (top row) is unreliable → the top row can't be clicked, the middle row works intermittently. **The correct solution**: treat the whole wall as a **single 3D-tilted plane** (without enabling preserve-3d), with all cards coplanar, and clicks back-projected onto one plane → reliable. Use 2D `scale` for hover, not `translateZ`.
2. **It must be adaptive for any page count**: a fixed column count + hardcoding a strong tilt on the whole wall causes overflow/collapsed corners/perspective distortion once there are many pages. You must compute the column count from page count + viewport, flatten the tilt when there are many rows, and scroll when it can't fit on one screen.
3. **Don't make the thumbnail resolution too low**: gallery thumbnails < 1000px look blurry after hover zoom. Default to 1600px.

**Generate thumbnails for the gallery**: use `scripts/gen_deck_thumbs.mjs` (playwright captures each page + sharp downsamples):
```bash
npm install playwright sharp
node gen_deck_thumbs.mjs --slides slides --out thumbs --width 1600
```
Then add `thumb: "thumbs/<same-name>.jpg"` to each MANIFEST item. Grid mode ignores thumb (always iframe); only gallery mode uses it.

### Single-page verification (this is the killer advantage of the multi-file architecture)

Each slide is a standalone HTML. **As soon as you finish one, double-click to open it in the browser and look:**

```bash
open slides/05-personas.html
```

Playwright screenshots also `goto(file://.../slides/05-personas.html)` directly, with no JS page jumping needed, and no interference from other pages' CSS. This brings the cost of the "change a little, verify a little" workflow close to zero.

### Parallel development

Split each slide's task to a different agent and run them simultaneously — the HTML files are independent of each other, with no conflict at merge time. Using this parallel approach for long decks can compress production time to 1/N.

### What to put in `shared/tokens.css`

Only put things that are **genuinely shared across pages:**

- CSS variables (palette, font-size scale, spacing scale)
- canvas locking like `body { width: 1920px; height: 1080px; }`
- chrome that's identical on every page, like `.page-header` / `.page-footer`

**Don't** stuff single-page layout classes in here — that regresses back to the single-file architecture's global pollution problem.

---

## Path B (small deck): single-file + `deck_stage.js`

Applicable to ≤10 pages, needing cross-page shared state (e.g. a React tweaks panel that controls all pages), or making a pitch deck demo and similar scenarios that require extreme compactness.

### Basic usage

1. Read the content from `assets/deck_stage.js` and embed it in the HTML's `<script>` (or `<script src="deck_stage.js">`)
2. In the body, wrap the slides with `<deck-stage>`
3. 🛑 **The script tag must come after `</deck-stage>`** (see the hard constraint below)

```html
<body>

  <deck-stage>
    <section>
      <h1>Slide 1</h1>
    </section>
    <section>
      <h1>Slide 2</h1>
    </section>
  </deck-stage>

  <!-- ✅ Correct: script comes after deck-stage -->
  <script src="deck_stage.js"></script>

</body>
```

### 🛑 Script-position hard constraint (real pitfall from 2026-04-20)

**You cannot put `<script src="deck_stage.js">` inside `<head>`.** Even though it can define `customElements` there, the parser triggers `connectedCallback` the moment it parses the `<deck-stage>` opening tag — at which point the child `<section>`s haven't been parsed yet, `_collectSlides()` gets an empty array, the counter shows `1 / 0`, and all pages render stacked at once.

**Three compliant ways to write it** (pick any one):

```html
<!-- ✅ Most recommended: script after </deck-stage> -->
</deck-stage>
<script src="deck_stage.js"></script>

<!-- ✅ Also OK: script in head but with defer -->
<head><script src="deck_stage.js" defer></script></head>

<!-- ✅ Also OK: module scripts are deferred by nature -->
<head><script src="deck_stage.js" type="module"></script></head>
```

`deck_stage.js` itself has built-in `DOMContentLoaded` deferred-collection defense, so even putting the script in head won't completely blow up — but `defer` or putting it at the bottom of body is still the cleaner approach, avoiding reliance on the defense branch.

### ⚠️ The CSS trap of the single-file architecture (must read)

The most common pitfall of the single-file architecture — **the `display` property gets stolen by single-page styles.**

Common wrong posture 1 (writing display: flex directly on the section):

```css
/* ❌ External CSS specificity 2 overrides the shadow DOM's ::slotted(section){display:none} (also 2) */
deck-stage > section {
  display: flex;            /* all pages will render stacked at once! */
  flex-direction: column;
  padding: 80px;
  ...
}
```

Common wrong posture 2 (the section has a class with higher specificity):

```css
.emotion-slide { display: grid; }   /* specificity: 10, worse */
```

Both will make **all slides render stacked at once** — the counter may show `1 / 10` pretending all is fine, but visually the first page covers the second covers the third.

### ✅ Starter CSS (copy at the start, no pitfalls)

The **section itself** only manages "visible/invisible"; the **layout (flex/grid, etc.) goes on `.active`:**

```css
/* section only defines non-display common styles */
deck-stage > section {
  background: var(--paper);
  padding: 80px 120px;
  overflow: hidden;
  position: relative;
  /* ⚠️ Don't write display here! */
}

/* Lock "if not active, hidden" — double insurance of specificity + weight */
deck-stage > section:not(.active) {
  display: none !important;
}

/* Only the active page writes the needed display + layout */
deck-stage > section.active {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* Print mode: all pages must show, overriding :not(.active) */
@media print {
  deck-stage > section { display: flex !important; }
  deck-stage > section:not(.active) { display: flex !important; }
}
```

Alternative: **put the single page's flex/grid on an inner wrapper `<div>`**, so the section itself is always just a `display: block/none` switch. This is the cleanest approach:

```html
<deck-stage>
  <section>
    <div class="slide-content flex-layout">...</div>
  </section>
</deck-stage>
```

### Custom dimensions

```html
<deck-stage width="1080" height="1920">
  <!-- 9:16 portrait -->
</deck-stage>
```

---

## Slide Labels

Both deck_stage and deck_index label each page (shown in the counter). Give them **more meaningful** labels:

**Multi-file**: write `{ file, label: "04 Problem statement" }` in the `MANIFEST`
**Single-file**: add `<section data-screen-label="04 Problem Statement">` on the section

**Key: slide numbering starts at 1, not 0.**

When a user says "slide 5," they mean the 5th slide, never the array position `[4]`. Humans don't speak 0-indexed.

---

## Speaker Notes

**Not added by default**; only add them when the user explicitly requests it.

Once you add speaker notes, you can reduce the text on the slide to a minimum and focus on impactful visuals — the notes carry the full script.

### Format

**Multi-file**: write this inside `<head>` of `index.html`:

```html
<script type="application/json" id="speaker-notes">
[
  "Script for slide 1...",
  "Script for slide 2...",
  "..."
]
</script>
```

**Single-file**: same place as above.

### Key points for writing notes

- **Complete**: not an outline, but the actual words you'll say
- **Conversational**: like everyday speech, not written language
- **Corresponding**: array item N corresponds to slide N
- **Length**: 200-400 words is best
- **Emotion line**: mark stresses, pauses, and emphasis points

---

## Slide Design Patterns

### 1. Establish a system (required)

After exploring the design context, **first state verbally the system you'll use:**

```markdown
Deck system:
- Background colors: at most 2 (90% white + 10% dark section divider)
- Typeface: Instrument Serif for display, Geist Sans for body
- Rhythm: section dividers use full-bleed color + white text, normal slides white background
- Imagery: hero slides use full-bleed photos, data slides use charts

I'll make it to this system; tell me if there are issues.
```

Proceed only after the user confirms.

### 2. Common slide layouts

- **Title slide**: solid background + giant title + subtitle + author/date
- **Section divider**: colored background + chapter number + chapter title
- **Content slide**: white background + title + 1-3 bullet points
- **Data slide**: title + big chart/number + brief explanation
- **Image slide**: full-bleed photo + small caption at the bottom
- **Quote slide**: whitespace + giant quote + attribution
- **Two-column**: left/right comparison (vs / before-after / problem-solution)

Use at most 4-5 layout types in a deck.

### 3. Scale (emphasizing again)

- Body minimum **24px**, ideal 28-36px
- Title **60-120px**
- Hero type **180-240px**
- Slides are meant to be seen from 10 meters away; the text must be big enough

### 4. Visual rhythm

A deck needs **intentional variety:**

- Color rhythm: mostly white background + occasional colored section dividers + occasional dark segments
- Density rhythm: a few text-heavy + a few image-heavy + a few quote-whitespace ones
- Font-size rhythm: normal titles + occasional giant hero text

**Don't make every slide look the same** — that's a PPT template, not design.

### 5. Spatial breathing (must read for data-dense pages)

**The pitfall beginners most easily step on**: cramming all the information you can onto one page.

Information density ≠ effective information delivery. Academic/lecture decks especially need restraint:

- List/matrix pages: don't draw all N elements at the same size. Use **primary/secondary layering** — enlarge the 5 you'll talk about today as the lead, and shrink the remaining 16 as a background hint.
- Big-number pages: the number itself is the visual lead. Don't let the surrounding caption exceed 3 lines, or the audience's eyes will dart back and forth.
- Quote pages: there should be whitespace separating the quote from the attribution; don't stick them together.

Self-review against "is the data the lead" and "is the text crowded together," and keep editing until the whitespace makes you a little uneasy.

---

## Print to PDF

**Multi-file**: `deck_index.html` already handles the `beforeprint` event, outputting the PDF page by page.

**Single-file**: `deck_stage.js` handles it the same way.

The print styles are already written; you don't need to write extra `@media print` CSS.

---

## Export to PPTX / PDF (self-service scripts)

HTML-first is first-class citizen. But users often need PPTX/PDF delivery. Two general scripts are provided that **any multi-file deck can use**, located under `scripts/`:

### `export_deck_pdf.mjs` — export a vector PDF (multi-file architecture)

```bash
node scripts/export_deck_pdf.mjs --slides <slides-dir> --out deck.pdf
```

**Features:**
- Text **stays vector** (selectable, searchable)
- 100% visual fidelity (Playwright's embedded Chromium renders then prints)
- **No need to change a single word of the HTML**
- Each slide gets its own `page.pdf()`, then merged with `pdf-lib`

**Dependencies**: `npm install playwright pdf-lib`

**Limitation**: text in the PDF can't be re-edited — to change it, go back to the HTML.

### `export_deck_stage_pdf.mjs` — dedicated to the single-file deck-stage architecture ⚠️

**When to use**: the deck is a single HTML file + a `<deck-stage>` web component wrapping N `<section>`s (i.e. the Path B architecture). Here the "one `page.pdf()` per HTML" approach of `export_deck_pdf.mjs` won't work, and you need this dedicated script.

```bash
node scripts/export_deck_stage_pdf.mjs --html deck.html --out deck.pdf
```

**Why you can't reuse export_deck_pdf.mjs** (record of real pitfalls from 2026-04-20):

1. **Shadow DOM beats `!important`**: the deck-stage's shadow CSS has `::slotted(section) { display: none }` (only the active one is `display: block`). Even in the light DOM using `@media print { deck-stage > section { display: block !important } }` can't suppress it — after `page.pdf()` triggers the print media, Chromium's final render is only the active one, resulting in **the whole PDF having just 1 page** (a repeat of the current active slide).

2. **Looping goto still outputs only 1 page**: the intuitive fix of "navigate once to each `#slide-N` then `page.pdf({pageRanges:'1'})`" also fails — because the print CSS also has a `deck-stage > section { display: block }` rule outside the shadow DOM that gets overridden, and the final render is always the first in the section list (not the page you navigated to). The result is 17 loops producing 17 copies of the P01 cover.

3. **Absolute child elements run onto the next page**: even if you successfully get all sections to render, if the section itself is `position: static`, its absolutely-positioned `cover-footer`/`slide-footer` will be positioned relative to the initial containing block — when the section is forced by print to 1080px height, the absolute footer may be pushed to the next page (showing up as the PDF having 1 more page than the number of sections, with the extra page containing only the orphan footer).

**Fix strategy** (implemented in the script):

```js
// After opening the HTML, use page.evaluate to lift the sections out of the deck-stage slot,
// attach them directly into an ordinary div under body, and inline styles to ensure position:relative + fixed dimensions
await page.evaluate(() => {
  const stage = document.querySelector('deck-stage');
  const sections = Array.from(stage.querySelectorAll(':scope > section'));
  document.head.appendChild(Object.assign(document.createElement('style'), {
    textContent: `
      @page { size: 1920px 1080px; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important; }
      deck-stage { display: none !important; }
    `,
  }));
  const container = document.createElement('div');
  sections.forEach(s => {
    s.style.cssText = 'width:1920px!important;height:1080px!important;display:block!important;position:relative!important;overflow:hidden!important;page-break-after:always!important;break-after:page!important;background:#F7F4EF;margin:0!important;padding:0!important;';
    container.appendChild(s);
  });
  // Disable page break on the last page to avoid a trailing blank page
  sections[sections.length - 1].style.pageBreakAfter = 'auto';
  sections[sections.length - 1].style.breakAfter = 'auto';
  document.body.appendChild(container);
});

await page.pdf({ width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
```

**Why this works:**
- Pulling the sections out of the shadow DOM slot into an ordinary div in the light DOM — completely bypasses the `::slotted(section) { display: none }` rule
- Inlining `position: relative` makes the absolute child elements position relative to the section, so they don't overflow
- `page-break-after: always` makes the browser put each section on its own page when printing
- `:last-child` not breaking avoids a trailing blank page

**Note when verifying with `mdls -name kMDItemNumberOfPages`**: macOS Spotlight metadata is cached; after rewriting the PDF you must run `mdimport file.pdf` to force a refresh, otherwise it shows the old page count. Counting with `pdfinfo` or `pdftoppm` for the file count is the real count.

---

### `export_deck_pptx.mjs` — export an editable PPTX

```bash
# Only mode: text boxes are natively editable (fonts fall back to system fonts)
node scripts/export_deck_pptx.mjs --slides <dir> --out deck.pptx
```

How it works: `html2pptx` reads computedStyle element-by-element to translate the DOM into PowerPoint objects (text frame / shape / picture). Text becomes real text boxes, editable by double-clicking in PPT.

**Hard constraints** (the HTML must satisfy these or the page is skipped; detailed explanation in `references/editable-pptx.md`):
- All text must be inside `<p>`/`<h1>`-`<h6>`/`<ul>`/`<ol>` (no bare-text divs)
- `<p>`/`<h*>` tags themselves cannot have background/border/shadow (put those on an outer div)
- Don't use `::before`/`::after` to insert decorative text (pseudo-elements can't be extracted)
- inline elements (span/em/strong) cannot have margin
- No CSS gradient (not renderable)
- div doesn't use `background-image` (use `<img>`)

The script has a built-in **automatic preprocessor** — it automatically wraps "bare text inside a leaf div" into a `<p>` (preserving the class). This solves the most common violation (bare text). But other violations (border on a p, margin on a span, etc.) still require the HTML source to be compliant.

**Font-fallback caveat:**
- Playwright uses webfonts to measure text-box dimensions; PowerPoint/Keynote renders with local fonts
- When the two differ there will be **overflow or misalignment** — eyeball every page
- It's recommended to install the fonts used in the HTML on the target machine, or fall back to `system-ui`

**Don't take this path for visual-first scenarios** → use `export_deck_pdf.mjs` to produce a PDF instead. PDF is 100% visually faithful, vector, cross-platform, and the text is searchable — it's the true home of a visual-first deck, not some "non-editable compromise."

### Make the HTML export-friendly from the start

For the most reliable deck performance: **write the HTML to the editable 4 hard constraints from the moment you write it.** This way `export_deck_pptx.mjs` can pass everything directly. The extra cost is small:

```html
<!-- ❌ Bad -->
<div class="title">Key findings</div>

<!-- ✅ Good (wrapped in p, class inherited) -->
<p class="title">Key findings</p>

<!-- ❌ Bad (border on the p) -->
<p class="stat" style="border-left: 3px solid red;">41%</p>

<!-- ✅ Good (border on the outer div) -->
<div class="stat-wrap" style="border-left: 3px solid red;">
  <p class="stat">41%</p>
</div>
```

### When to choose which

| Scenario | Recommended |
|------|------|
| For the host/archive | **PDF** (universal, high fidelity, searchable text) |
| Sent to collaborators for them to fine-tune the text | **PPTX editable** (accept font fallback) |
| Live presentation on-site, no content changes | **PDF** (vector fidelity, cross-platform) |
| HTML is the preferred presentation medium | play directly in the browser; export is just a backup |

## Deep path to editable PPTX (long-term projects only)

If your deck will be maintained long-term, repeatedly revised, and team-collaborated — it's recommended to **write the HTML to the html2pptx constraints from the very start**, so that `export_deck_pptx.mjs` can pass everything directly. See `references/editable-pptx.md` for details (4 hard constraints + HTML template + common-mistakes quick reference + the fallback flow for an existing visual draft).

---

## FAQ

**Multi-file: a page in the iframe won't open / blank screen**
→ Check whether the `MANIFEST`'s `file` path is correct relative to `index.html`. Use the browser DevTools to see whether the iframe's src can be accessed directly.

**Multi-file: one page's styles conflict with another's**
→ Impossible (iframe isolation). If it feels like a conflict, it's the cache — Cmd+Shift+R to hard refresh.

**Single-file: multiple slides render stacked at once**
→ A CSS specificity issue. See the "The CSS trap of the single-file architecture" section above.

**Single-file: scaling looks wrong**
→ Check whether all slides are attached directly under `<deck-stage>` as `<section>`s. There can't be a `<div>` in between.

**Single-file: want to jump to a specific slide**
→ Add a hash to the URL: `index.html#slide-5` jumps to the 5th slide.

**Applicable to both architectures: text positions are inconsistent on different screens**
→ Use fixed dimensions (1920×1080) and `px` units, not `vw`/`vh` or `%`. Scaling is handled uniformly.

---

## Verification checklist (must pass after finishing the deck)

1. [ ] Open `index.html` (or the main HTML) directly in the browser, check the first page has no broken images and the fonts are loaded
2. [ ] Press → to flip through every page, no blank pages, no layout misalignment
3. [ ] Press P for print preview, each page is exactly one A4 (or 1920×1080) with no clipping
4. [ ] Randomly pick 3 pages and Cmd+Shift+R hard-refresh, localStorage memory works correctly
5. [ ] Playwright batch screenshots (single-page architecture: iterate `slides/*.html`; single-file architecture: switch with goTo), eyeball them all manually
6. [ ] Search for leftover `TODO` / `placeholder`, confirm they're all cleaned up
