# Editable PPTX Export: HTML Hard Constraints + Size Decisions + Common Errors

This document describes the path of **translating HTML element by element into truly editable PowerPoint text boxes using `scripts/html2pptx.js` + `pptxgenjs`**, which is also the only path supported by `export_deck_pptx.mjs`.

> **Core premise**: To follow this path, the HTML must be written according to the 4 constraints below from the very first line. **Don't write it first and convert later** — after-the-fact remediation triggers 2-3 hours of rework (verified by hitting this trap on the 2026-04-20 options private board meeting project).
>
> For scenarios that prioritize visual freedom (animation / web components / CSS gradients / complex SVG), please switch to the PDF path (`export_deck_pdf.mjs` / `export_deck_stage_pdf.mjs`). **Do not** expect PPTX export to have both visual fidelity and editability — this is a physical constraint of the PPTX file format itself (see "Why the 4 Constraints Are Not Bugs But Physical Constraints" at the end of the document).

---

## Canvas size: use 960×540pt (LAYOUT_WIDE)

The PPTX unit is **inch** (physical size), not px. Decision principle: the body's computedStyle dimensions must **match the presentation layout's inch dimensions** (±0.1", enforced by `html2pptx.js`'s `validateDimensions` check).

### Comparison of the 3 candidate sizes

| HTML body | Physical size | Corresponding PPT layout | When to choose |
|---|---|---|---|
| **`960pt × 540pt`** | **13.333″ × 7.5″** | **pptxgenjs `LAYOUT_WIDE`** | ✅ **Default recommendation** (the standard for modern PowerPoint 16:9) |
| `720pt × 405pt` | 10″ × 5.625″ | Custom | Only when the user specifies the "old PowerPoint Widescreen" template |
| `1920px × 1080px` | 20″ × 11.25″ | Custom | ❌ Non-standard size; fonts look abnormally small when projected |

**Don't think of the HTML size as resolution.** PPTX is a vector document; what the body size determines is the **physical size**, not the clarity. An oversized body (20″×11.25″) won't make the text clearer — it only makes the pt font size smaller relative to the canvas, which actually looks worse when projected/printed.

### Three equivalent ways to write the body

```css
body { width: 960pt;  height: 540pt; }    /* clearest, recommended */
body { width: 1280px; height: 720px; }    /* equivalent, px habit */
body { width: 13.333in; height: 7.5in; }  /* equivalent, inch intuition */
```

The matching pptxgenjs code:

```js
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';  // 13.333 × 7.5 inch, no custom needed
```

---

## The 4 hard constraints (violating them errors out directly)

`html2pptx.js` translates the HTML DOM element by element into PowerPoint objects. PowerPoint's format constraints projected onto HTML = the 4 rules below.

### Rule 1: text can't be written directly in a DIV — it must be wrapped in `<p>` or `<h1>`-`<h6>`

```html
<!-- ❌ Wrong: text directly in a div -->
<div class="title">Q3 revenue grew 23%</div>

<!-- ✅ Correct: text in <p> or <h1>-<h6> -->
<div class="title"><h1>Q3 revenue grew 23%</h1></div>
<div class="body"><p>New users are the main driver</p></div>
```

**Why**: PowerPoint text must exist in a text frame, and a text frame corresponds to HTML's paragraph-level elements (p/h*/li). A bare `<div>` has no corresponding text container in PPTX.

**You also can't use `<span>` to carry the main text** — span is an inline element and can't be independently aligned into a text box. A span can only be **nested inside a p/h\*** for local styling (bold, color change).

### Rule 2: CSS gradients are not supported — only solid colors

```css
/* ❌ Wrong */
background: linear-gradient(to right, #FF6B6B, #4ECDC4);

/* ✅ Correct: solid color */
background: #FF6B6B;

/* ✅ If multi-color stripes are required, use flex children each with a solid color */
.stripe-bar { display: flex; }
.stripe-bar div { flex: 1; }
.red   { background: #FF6B6B; }
.teal  { background: #4ECDC4; }
```

**Why**: PowerPoint's shape fill only supports two kinds, solid / gradient-fill, but pptxgenjs's `fill: { color: ... }` only maps to solid. Going through PowerPoint's native gradient requires writing a separate structure, which the current toolchain doesn't support.

### Rule 3: background/border/shadow can only go on a DIV, not on text tags

```html
<!-- ❌ Wrong: <p> has a background color -->
<p style="background: #FFD700; border-radius: 4px;">Key content</p>

<!-- ✅ Correct: the outer div carries the background/border, <p> only handles text -->
<div style="background: #FFD700; border-radius: 4px; padding: 8pt 12pt;">
  <p>Key content</p>
</div>
```

**Why**: in PowerPoint a shape (rectangle / rounded rectangle) and a text frame are two objects. HTML's `<p>` only translates into a text frame; background/border/shadow belong to a shape — they must be written on the **div that wraps the text**.

### Rule 4: a DIV can't use `background-image` — use an `<img>` tag

```html
<!-- ❌ Wrong -->
<div style="background-image: url('chart.png')"></div>

<!-- ✅ Correct -->
<img src="chart.png" style="position: absolute; left: 50%; top: 20%; width: 300pt; height: 200pt;" />
```

**Why**: `html2pptx.js` only extracts the image path from `<img>` elements; it doesn't parse the `background-image` URL in CSS.

---

## Merging text boxes (`data-pptx-merge`)

**Default behavior**: each `<p>`/`<h1>`-`<h6>` in the HTML becomes an **independent text box** in the PPTX. Writing 3 `<p>` in a card → 3 text boxes stacked in the PPT; when editing, you can't add a paragraph with a single carriage return across the whole block, and you have to change the font size/alignment one by one.

**Solution**: add `data-pptx-merge="true"` to the outer div, and all the `<p>/<h*>` inside the container will merge into **one editable text box**, with paragraphs separated by paragraph separators — so in the PPT it's one continuous block to edit, paragraph by paragraph.

```html
<!-- ✅ Merged form: all 4 paragraphs in one text box -->
<div class="card" data-pptx-merge="true"
     style="position: absolute; top: 60pt; left: 60pt; width: 420pt;
            background: #1A4A8A; border-radius: 8pt; padding: 20pt 24pt;">
  <h2 style="font-size: 24pt; color: #FFFFFF;">Title</h2>
  <p  style="font-size: 14pt; color: #DDEEFF;">First body paragraph.</p>
  <p  style="font-size: 14pt; color: #FFD166;">Second paragraph: change color for emphasis.</p>
  <p  style="font-size: 14pt; color: #DDEEFF;">Third paragraph: keep writing in the same text box.</p>
</div>
```

**Styles that are preserved** (written per-paragraph as run options): `font-size`, `color`, `font-family`, `font-weight` (bold), `font-style` (italic), `text-decoration: underline`, and the inline styles of `<b>/<i>/<u>/<strong>/<em>/<span>`.

**Taken from the first paragraph, unified across the whole box**: `text-align`, `line-height`. Because PowerPoint's alignment and line spacing are paragraph/textbox level — a single box can only have one alignment. If several paragraphs have different alignments, don't use merge; let them stay independent.

**The container's own `background`/`border`/`box-shadow`/`border-radius`** still render as a shape, behaving exactly like a normal div — that is, the blue card background + text is still two layers, "shape + text frame", only the text layer collapses from 3-4 text boxes into 1.

**Limitations**:
- You can't nest `data-pptx-merge` (it will error).
- The container can't use `background-image` (same as hard constraint rule 4).
- Don't put child divs that have a `background`/`border` inside the container — they'll still be rendered as independent shapes, but the text inside them has already been merged away, which may produce visual misalignment.

**When to use it**: scenarios where the content will be revised repeatedly and needs to keep being edited in the PPT. For a one-off export to archive, no need to add it; the behavior is consistent.

---

## Path A HTML template skeleton

One independent HTML file per slide, scope-isolated from one another (avoiding the CSS pollution of a single-file deck).

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 960pt; height: 540pt;           /* ⚠️ match LAYOUT_WIDE */
    font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
    background: #FEFEF9;                    /* solid color, no gradient allowed */
    overflow: hidden;
  }
  /* DIV handles layout/background/border */
  .card {
    position: absolute;
    background: #1A4A8A;                    /* background on the DIV */
    border-radius: 4pt;
    padding: 12pt 16pt;
  }
  /* text tags only handle font styling, no background/border */
  .card h2 { font-size: 24pt; color: #FFFFFF; font-weight: 700; }
  .card p  { font-size: 14pt; color: rgba(255,255,255,0.85); }
</style>
</head>
<body>

  <!-- Title area: outer div positions, inner text tags -->
  <div style="position: absolute; top: 40pt; left: 60pt; right: 60pt;">
    <h1 style="font-size: 36pt; color: #1A1A1A; font-weight: 700;">Use an assertion sentence for the title, not a topic word</h1>
    <p style="font-size: 16pt; color: #555555; margin-top: 10pt;">Subtitle supplementary note</p>
  </div>

  <!-- Content card: div handles the background, h2/p handle the text -->
  <div class="card" style="top: 130pt; left: 60pt; width: 240pt; height: 160pt;">
    <h2>Point one</h2>
    <p>Brief explanatory text</p>
  </div>

  <!-- List: use ul/li, not manual • symbols -->
  <div style="position: absolute; top: 320pt; left: 60pt; width: 540pt;">
    <ul style="font-size: 16pt; color: #1A1A1A; padding-left: 24pt; list-style: disc;">
      <li>First point</li>
      <li>Second point</li>
      <li>Third point</li>
    </ul>
  </div>

  <!-- Illustration: use the <img> tag, not background-image -->
  <img src="illustration.png" style="position: absolute; right: 60pt; top: 110pt; width: 320pt; height: 240pt;" />

</body>
</html>
```

---

## Common-error quick reference

| Error message | Cause | How to fix |
|---------|------|---------|
| `DIV element contains unwrapped text "XXX"` | bare text in a div | wrap the text in `<p>` or `<h1>`-`<h6>` |
| `CSS gradients are not supported` | used a linear/radial-gradient | change to a solid color, or split with flex children |
| `Text element <p> has background` | a background color was added to a `<p>` tag | wrap it in a `<div>` to carry the background; `<p>` only holds text |
| `Background images on DIV elements are not supported` | a div used background-image | change to an `<img>` tag |
| `HTML content overflows body by Xpt vertically` | content exceeds 540pt | reduce content or shrink the font size, or `overflow: hidden` to truncate |
| `HTML dimensions don't match presentation layout` | the body size doesn't match the pres layout | use `960pt × 540pt` for the body with `LAYOUT_WIDE`; or defineLayout with a custom size |
| `Text box "XXX" ends too close to bottom edge` | a large-font `<p>` is < 0.5 inch from the body's bottom edge | move it up, leave enough bottom margin; the bottom of the PPT itself gets partly obscured |

---

## Basic workflow (3 steps to a PPTX)

### Step 1: write one independent HTML per page per the constraints

```
MyDeck/
├── slides/
│   ├── 01-cover.html    # each file is a complete 960×540pt HTML
│   ├── 02-agenda.html
│   └── ...
└── illustration/        # all images referenced by <img>
    ├── chart1.png
    └── ...
```

### Step 2: write build.js to call `html2pptx.js`

```js
const pptxgen = require('pptxgenjs');
const html2pptx = require('../scripts/html2pptx.js');  // this skill's script

(async () => {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_WIDE';  // 13.333 × 7.5 inch, matches the HTML's 960×540pt

  const slides = ['01-cover.html', '02-agenda.html', '03-content.html'];
  for (const file of slides) {
    await html2pptx(`./slides/${file}`, pres);
  }

  await pres.writeFile({ fileName: 'deck.pptx' });
})();
```

### Step 3: open and check

- Open the exported PPTX in PowerPoint/Keynote
- Double-clicking any text should let you edit it directly (if it's an image, that means rule 1 was violated)
- Verify overflow: each page should be within the body bounds, not cut off

---

## This path vs other options (when to choose what)

| Need | Choose what |
|------|------|
| Colleagues will edit the text in the PPTX / it's sent to non-technical people to keep editing | **This document's path** (editable, requires writing HTML per the 4 constraints from scratch) |
| Just for presenting / archiving, no more edits | `export_deck_pdf.mjs` (multi-file) or `export_deck_stage_pdf.mjs` (single-file deck-stage), produces a vector PDF |
| Visual freedom takes priority (animation, web components, CSS gradients, complex SVG), accept non-editable | **PDF** (as above) — PDF is both faithful and cross-platform, more suitable than an "image PPTX" |

**Never force-run html2pptx on HTML written for visual freedom** — in practice the pass rate of visually-driven HTML is < 30%, and reworking the remaining ones page by page is slower than rewriting. This scenario should produce a PDF, not be forced into a PPTX.

---

## Fallback: you already have a visual draft but the user insists on editable PPTX

Occasionally you'll hit this scenario: you/the user have already written a visually-driven HTML (gradients, web components, complex SVG all used), and producing a PDF would be most suitable, but the user explicitly says "no, it must be editable PPTX".

**Don't force-run `html2pptx` expecting it to pass** — in practice visually-driven HTML has a pass rate <30% on html2pptx, and the remaining 70% will error out or look broken. The correct fallback is:

### Step 1 · First explain the limitations (transparent communication)

Tell the user three things clearly in one breath:

> "Your current HTML uses [list specifically: gradients / web components / complex SVG / ...], and converting it directly to editable PPTX will fail. I have two options:
> - A. **Produce a PDF** (recommended) — visuals 100% preserved, the recipient can view and print but can't edit the text
> - B. **Use the visual draft as the blueprint and rewrite an editable HTML** (keep the design decisions of color/layout/copy, but reorganize the HTML structure per the 4 hard constraints, **sacrificing** visual capabilities like gradients, web components, complex SVG) → then export editable PPTX
>
> Which do you choose?"

Don't make option B sound effortless — clearly state **what will be lost**. Let the user make the trade-off.

### Step 2 · If the user chooses B: the AI rewrites proactively, doesn't ask the user to write it themselves

The doctrine here is: **the user gives the design intent, you're responsible for translating it into a compliant implementation**. It's not about making the user learn the 4 hard constraints and then rewrite it themselves.

Principles to follow when rewriting:
- **Keep**: the color system (primary/secondary/neutral colors), the information hierarchy (title/subtitle/body/annotation), the core copy, the layout skeleton (top-middle-bottom / left-right columns / grid), the page rhythm
- **Downgrade**: CSS gradient → solid color or flex segments, web component → paragraph-level HTML, complex SVG → simplified `<img>` or solid-color geometry, shadow → delete or reduce to very faint, custom font → align with system fonts
- **Rewrite**: bare text → wrap in `<p>` / `<h*>`, `background-image` → `<img>` tag, background/border on a `<p>` → carried by the outer div

### Step 3 · Produce a comparison list (transparent delivery)

After the rewrite, give the user a before/after comparison so they know which visual details were simplified:

```
Original design → editable-version adjustment
- Title area purple gradient → solid #5B3DE8 primary-color background
- Data card shadow → removed (distinguished with a 2pt stroke instead)
- Complex SVG line chart → simplified to an <img> PNG (generated from an HTML screenshot)
- Hero web-component animation → static first frame (web components can't be translated)
```

### Step 4 · Export & dual-format delivery

- `editable` version HTML → run `scripts/export_deck_pptx.mjs` to produce the editable PPTX
- **Recommended to also keep** the original visual draft → run `scripts/export_deck_pdf.mjs` to produce a high-fidelity PDF
- Deliver both formats to the user: the visual draft's PDF + the editable PPTX, each doing its job

### When to flatly refuse option B

In a few scenarios the cost of rewriting is too high, and you should advise the user to give up on editable PPTX:
- The core value of the HTML is animation or interaction (after rewriting only a static first frame remains, losing 50%+ of the information)
- Page count > 30, the rewrite cost exceeds 2 hours
- The visual design deeply depends on precise SVG / custom filters (after rewriting it bears almost no relation to the original)

In this case, tell the user: "Rewriting this deck costs too much; I recommend producing a PDF rather than a PPTX. If the recipient really needs the pptx format, then accept that the visuals will be substantially plainer — do you want to switch to PDF instead?"

---

## Why the 4 constraints are not bugs but physical constraints

These 4 aren't the `html2pptx.js` author being lazy — they're the result of the constraints of **the PowerPoint file format (OOXML) itself** projected onto HTML:

- In PPTX, text must be in a text frame (`<a:txBody>`), corresponding to paragraph-level HTML elements
- A PPTX shape and a text frame are two objects; you can't draw a background and write text on the same element at once
- A PPTX shape fill has limited support for gradients (only certain preset gradients, no arbitrary-angle CSS gradients)
- A PPTX picture object must reference a real image file, not a CSS property

Once you understand this, **don't expect the tool to get smarter** — it's the HTML way of writing that must adapt to the PPTX format, not the other way around.
