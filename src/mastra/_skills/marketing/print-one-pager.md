---
name: print-one-pager
category: marketing
description: >-
  Single-sheet print collateral — flyers, POS cards, price sheets, supplier one-pagers — built as
  fixed-geometry HTML that renders to exactly one page on this stack's Chromium PDF path, with no
  spill onto a blank second page. Trigger when the deliverable is one physical sheet.
keywords: [flier, flyer, one-pager, print, pos, a4, price-sheet, collateral, pdf-export, single-page]
allowedTools: [design_write_deliverable, design_export_pdf, design_verify, artifact_put]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 1600
outputFormat: html
tags: [marketing, design, print, flyer, collateral]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Single-Sheet Print Collateral

## 1. The one thing that decides how you write this

**On this stack, print CSS does not control the page.** `design_export_pdf` runs
`huashu-design/scripts/export_deck_pdf.mjs`, which drives Playwright Chromium with:

```js
await page.emulateMedia({ media: 'screen' });      // @media print never applies
const buf = await page.pdf({
  width: `${width}px`, height: `${height}px`,       // page box comes from CLI args
  printBackground: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  preferCSSPageSize: false,                         // @page size is ignored
});
```

So:

- ❌ `@media print { … }` — **never fires**, media is emulated as `screen`.
- ❌ `@page { size: A4; margin: 20mm }` — **ignored**, `preferCSSPageSize: false` plus explicit width/height wins.
- ❌ `@page { @top-right { content: … } }` and `counter(pages)` — Chromium does not render CSS
  margin boxes at all. Running headers and page numbers on this path come from
  `displayHeaderFooter` + `headerTemplate`/`footerTemplate` in `page.pdf()`, not from CSS.
- ❌ `page-break-*` inside one file — pagination here is **one HTML file = one page**, decided by the
  exporter, not by your CSS.
- ✅ **A fixed-size element whose height you control exactly.** That is the whole technique.

Anything you have read elsewhere about `@page` and paged-media CSS assumes a Paged.js/WeasyPrint/
Prince pipeline. This is not one.

## 2. The pattern

One file, one sheet, geometry pinned in the markup, page box passed to the exporter.

```html
<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<style>
  /* A4 at 96 CSS px/in = 794 × 1123 px. Match these to the --width/--height you export with. */
  :root { --sheet-w: 794px; --sheet-h: 1123px; --pad: 56px; }

  html, body { margin: 0; padding: 0; background: #fff; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .sheet {
    width: var(--sheet-w);
    height: var(--sheet-h);      /* height, not min-height — this is the no-second-page guarantee */
    overflow: hidden;            /* anything that does not fit is CLIPPED, never reflowed */
    padding: var(--pad);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #09090B;
  }

  .badge { display:inline-block; background:#09090B; color:#fff; padding:5px 13px;
           font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; border-radius:4px; }
  .headline { font-size:40px; line-height:1.08; font-weight:800; margin:18px 0 0; letter-spacing:-0.02em; }
  .sub { font-size:17px; line-height:1.45; color:#52525B; margin:14px 0 0; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:22px; }
  .card { border:1px solid #E4E4E7; border-radius:8px; padding:20px; }
  .card h3 { margin:0 0 7px; font-size:16px; }
  .card p  { margin:0; font-size:12.5px; line-height:1.5; color:#71717A; }
  .cta { background:#F4F4F5; border-radius:10px; padding:24px; text-align:center; }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <span class="badge">Dla szefów kuchni i zaopatrzenia</span>
      <h1 class="headline">Koniec z nocnym spisywaniem faktur na kartkach.</h1>
      <p class="sub">Zamawiaj od 15 lokalnych dostawców w jednym koszyku.</p>
    </header>

    <div class="grid">
      <div class="card"><h3>1 kliknięcie = 15 zamówień</h3>
        <p>System rozdziela koszyk na dostawców warzyw, mięsa i nabiału.</p></div>
      <div class="card"><h3>Gwarancja ceny dnia</h3>
        <p>Podgląd cen hurtowych na żywo. Zero niespodzianek przy dostawie.</p></div>
    </div>

    <div class="cta">
      <h2 style="margin:0 0 6px; font-size:20px;">Bezpłatny pilotaż w Twojej restauracji</h2>
      <p style="margin:0; font-size:13px; color:#52525B;">gastrobridge.pl/pilot</p>
    </div>
  </div>
</body>
</html>
```

Export with a matching page box:

```bash
node scripts/export_deck_pdf.mjs --slides <dir-with-this-one-file> --out flier.pdf --width 794 --height 1123
```

For print-shop output use 2× (`--width 1588 --height 2246`) and scale the `:root` variables with it,
rather than relying on DPI settings that this path does not expose.

## 3. Guaranteeing one page

`height` + `overflow: hidden` means overflow is **silently clipped**. That is the right trade for a
flyer — a clipped line is visible in review, a second blank page is not — but it makes verification
mandatory:

1. `design_verify` (or a Playwright screenshot at exactly 794×1123) and **look at it**.
2. Check the bottom edge: is the last element intact, or cut?
3. Confirm the PDF is **one page**, not two.

If content does not fit: cut copy. Do not shrink the sheet, do not switch to `min-height`, do not add
a second `.sheet` — a two-page "one-pager" is a different deliverable and needs saying so.

## 4. Print rules that still apply

- **Safety margin ≥ 12 mm (~45 px)** on every edge. Home and office printers clip.
- **No text below 9 pt (~12 px).** It survives a screen and dies on paper.
- **Vector or ≥ 300 DPI raster.** A 72-DPI logo that looks crisp in Chrome prints as mush.
- **Full contrast; assume greyscale.** A light-grey-on-white subhead disappears on an office printer.
  Check the design still reads with saturation removed.
- **Real, verified contact data.** A wrong phone number or URL on 500 printed sheets is not a bug you
  can hotfix.
- **QR codes: quiet zone of 4 modules and ≥ 20 mm square**, and scan-test the exported PDF, not the
  HTML.

## 5. Scope note

This covers geometry and print survival. **Visual direction — typography, colour, composition — is
`designAgent`'s call**, and its style library exists precisely so a one-pager does not default to
the same layout every time. Use this skill for the sheet mechanics, not to bypass the design domain.
