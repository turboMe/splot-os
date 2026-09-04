# Content Guidelines: Anti-AI Slop, Content Guidelines, and Scale Specifications

The easiest trap to fall into in AI design. This is a list of "what not to do," which is more important than "what to do"—because AI slop is the default, and it will happen if you don't actively avoid it.

## Complete AI Slop Blacklist

### Visual Traps

**❌ Aggressive Gradient Backgrounds**
- Purple → Pink → Blue full-screen gradients (typical of AI-generated webpages)
- Rainbow gradients in any direction
- Mesh gradients covering the entire background
- ✅ If using gradients: subtle, monochromatic, intentionally used as accents (e.g., button hover)

**❌ Rounded Cards + Left Border Accent Color**
```css
/* This is a typical signature of AI-generated cards */
.card {
  border-radius: 12px;
  border-left: 4px solid #3b82f6;
  padding: 16px;
}
```
This type of card is rampant in AI-generated dashboards. Want to add emphasis? Use a more design-conscious approach: background color contrast, font weight/size contrast, plain dividers, or simply don't separate into cards.

**❌ Emoji Decorations**
Unless the brand itself uses emojis (like Notion, Slack), do not put emojis on the UI. **Especially avoid**:
- 🚀 ⚡️ ✨ 🎯 💡 before titles
- ✅ in feature lists
- → in CTA buttons (a standalone arrow is OK, an emoji arrow is not)

If you don't have icons, use a real icon library (Lucide/Heroicons/Phosphor), or use a placeholder.

**❌ SVG Imagery**
Do not attempt to draw people, scenes, devices, objects, or abstract art with SVG. AI-drawn SVG imagery immediately looks AI-generated, childish, and cheap. **A gray rectangle with the text label "Illustration Placeholder 1200×800" is 100 times better than a clumsy SVG hero illustration**.

The only scenarios where SVG can be used:
- Real icons (16×16 to 32×32 pixels)
- Geometric shapes as decorative elements
- Charts for data visualization

**❌ Excessive Iconography**
Not every title/feature/section needs an icon. Overusing icons makes the interface look like a toy. Less is more.

**❌ "Data Slop"**
Fabricated stats for decoration:
- "10,000+ happy customers" (you don't even know if it's true)
- "99.9% uptime" (don't write it if you don't have real data)
- Decorative "metric cards" composed of icons + numbers + words
- Mock tables with fake data dressed up in flashy ways

If there's no real data, leave a placeholder or ask the client for it.

**❌ "Quote Slop"**
Fabricated user testimonials or famous quotes used to decorate pages. Leave a placeholder and ask the client for real quotes.

### Font Traps

**❌ Avoid These Overused Fonts**:
- Inter (default for AI-generated webpages)
- Roboto
- Arial / Helvetica
- Pure system font stack
- Fraunces (AI discovered this and overused it)
- Space Grotesk (AI's recent favorite)

**✅ Use distinctive display + body pairings**. Inspiration directions:
- Serif display + sans-serif body (editorial feel)
- Mono display + sans body (technical feel)
- Heavy display + light body (contrast)
- Variable font for hero weight animation

Font resources:
- Lesser-known good options from Google Fonts (Instrument Serif, Cormorant, Bricolage Grotesque, JetBrains Mono)
- Open-source font sites (Fraunces' sibling fonts, Adobe Fonts)
- Don't invent font names out of thin air.

### Color Traps

**❌ Inventing Colors Out of Thin Air**
Do not design an entire unfamiliar color palette from scratch. This usually results in disharmony.

**✅ Strategy**:
1. If brand colors exist → Use brand colors, interpolate missing color tokens with oklch
2. No brand colors but have references → Sample colors from reference product screenshots
3. Completely from scratch → Choose a known color system (Radix Colors / Tailwind default palette / Anthropic brand), don't adjust it yourself

**Defining colors with oklch** is the most modern approach:
```css
:root {
  --primary: oklch(0.65 0.18 25);      /* Warm terracotta */
  --primary-light: oklch(0.85 0.08 25); /* Lighter shade of the same hue */
  --primary-dark: oklch(0.45 0.20 25);  /* Darker shade of the same hue */
}
```
oklch ensures that the hue doesn't shift when adjusting brightness, making it easier to use than hsl.

**❌ Carelessly Inverting Colors for Dark Mode**
It's not just a simple color inversion. Good dark mode requires readjusting saturation, contrast, and accent colors. If you don't want to do dark mode, don't do it.

### Layout Traps

**❌ Overuse of Bento Grids**
Every AI-generated landing page wants a bento grid. Unless your information structure truly suits a bento, use other layouts.

**❌ Large Hero + 3-Column Features + Testimonials + CTA**
This landing page template is overused. If you want to innovate, truly innovate.

**❌ Card Grids Where Every Card Looks Identical**
Asymmetric, different sized cards, some with images, some with only text, some spanning columns—that's what a real designer's work looks like.

## Content Guidelines

### 1. Don't add filler content

Every element must earn its place. White space is a design problem, solved by **composition** (contrast, rhythm, white space), **not** by filling it with content.

**Questions to identify filler**:
- If this content were removed, would the design be worse? If the answer is "no," remove it.
- What real problem does this element solve? If it's "to make the page less empty," delete it.
- Is this stat/quote/feature supported by real data? If not, don't write it out of thin air.

"One thousand no's for every yes."

### 2. Ask before adding material

Do you think adding a section/page/segment would be better? Ask the client first, don't add it unilaterally.

Reasons:
- The client knows their audience better than you do.
- Adding content has costs, and the client might not want it.
- Unilaterally adding content violates the "junior designer reporting work" relationship.

### 3. Create a system up front

After exploring the design context, **verbally state the system you intend to use** for the client to confirm:

```markdown
My design system:
- Colors: #1A1A1A main + #F0EEE6 background + #D97757 accent (from your brand)
- Typography: Instrument Serif for display + Geist Sans for body
- Rhythm: Section titles with full-bleed colored backgrounds + white text; regular sections with white backgrounds
- Imagery: Hero with full-bleed photo, feature sections with placeholders for you to provide
- Use a maximum of 2 background colors to avoid clutter

Once this direction is confirmed, I'll start working.
```

Only start working after the client confirms. This check-in can prevent "halfway through, realizing the direction is wrong."

## Scale Specifications

### Slides (1920×1080)

- Body text minimum **24px**, ideal 28-36px
- Titles 60-120px
- Section titles 80-160px
- Hero headlines can use large text of 180-240px
- Never use text smaller than 24px on slides

### Print Documents

- Body text minimum **10pt** (≈13.3px), ideal 11-12pt
- Titles 18-36pt
- Caption 8-9pt

### Web and Mobile

- Body text minimum **14px** (16px for elderly-friendly)
- Mobile body text **16px** (to avoid iOS auto-scaling)
- Hit target (clickable elements) minimum **44×44px**
- Line height 1.5-1.7 (1.7-1.8 for Chinese)

### Contrast

- Body text vs. background **at least 4.5:1** (WCAG AA)
- Large text vs. background **at least 3:1**
- Check using Chrome DevTools' accessibility tools.

## CSS Superpowers

**Advanced CSS features** are a designer's best friend, use them boldly:

### Typography

```css
/* Makes titles wrap more naturally, avoiding a single word on the last line */
h1, h2, h3 { text-wrap: balance; }

/* Text wrapping, avoiding widows and orphans */
p { text-wrap: pretty; }

/* Chinese typography magic: punctuation compression, line start/end control */
p { 
  text-spacing-trim: space-all;
  hanging-punctuation: first;
}
```

### Layout

```css
/* CSS Grid + named areas = readability explosion */
.layout {
  display: grid;
  grid-template-areas:
    "header header"
    "sidebar main"
    "footer footer";
  grid-template-columns: 240px 1fr;
  grid-template-rows: auto 1fr auto;
}

/* Subgrid for aligning card content */
.card { display: grid; grid-template-rows: subgrid; }
```

### Visual Effects

```css
/* Stylish scrollbars */
* { scrollbar-width: thin; scrollbar-color: #666 transparent; }

/* Glassmorphism (use sparingly) */
.glass {
  backdrop-filter: blur(20px) saturate(150%);
  background: color-mix(in oklch, white 70%, transparent);
}

/* View transitions API for smooth page transitions */
@view-transition { navigation: auto; }
```

### Interactivity

```css
/* :has() selector makes conditional styling easier */
.card:has(img) { padding-top: 0; } /* Cards with images have no top padding */

/* Container queries make components truly responsive */
@container (min-width: 500px) { ... }

/* New color-mix function */
.button:hover {
  background: color-mix(in oklch, var(--primary) 85%, black);
}
```

## Quick Decision Guide: When in Doubt

- Thinking of adding a gradient? → Probably don't.
- Thinking of adding an emoji? → Don't.
- Thinking of adding rounded corners + border-left accent to a card? → Don't, use another method.
- Thinking of using SVG for a hero illustration? → Don't, use a placeholder.
- Thinking of adding a quote for decoration? → First ask the client if they have a real quote.
- Thinking of adding a row of icon features? → First ask if icons are needed, they might not be.
- Using Inter? → Switch to something more distinctive.
- Using a purple gradient? → Switch to a well-justified color scheme.

**When you think "adding this would look better"—that's usually a sign of AI slop**. Start with the simplest version, and only add more when the client requests it.