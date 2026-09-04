# Design Style Library: 20 Web + 20 PPT (HTML-Native First)

> **2026-06 rebuild**. Reverse-engineered from research on the global top 10 website types + top 10 presentation types, with the top 5 universally acknowledged best designs for each (100 real-world cases total).
> The fatal problem with the old 20-style "graphic / installation designer philosophy" library: the bold styles were almost all AI-generation-only (particles / light-and-shadow / hand-drawn). **When the user has no image-generation capability by default and everything goes through HTML, the entire bold half drops to zero, leaving only minimalism — this is the root cause of "the default looks the same every time."** Every style in this library is tagged with its **fidelity** under "pure HTML/CSS, no image generation."
>
> ⚖️ **But remember the positioning**: this is **"ammunition to flip through when you're out of ideas," not "a checklist you must pick from."** When the user gives you content / brand / references, the design grows from there — don't force-fit the library. The skill's job is to help the user avoid the worst, not to dictate what the design looks like — good design grows out of the user's real needs.

## How to Use This Library

1. **First pick the half-section by output type**: building a webpage / landing page / official site → the 20 web styles; building a PPT / deck / presentation → the 20 PPT styles.
2. **Temperature system**: each style is tagged `bold / neutral / quiet`. **Bold styles are deliberately the majority** — the model's determinism bias naturally skews toward quiet minimalism, so the library's ratio has to push it back toward bold.
   - Direction A (a safe foundation) is chosen from quiet/neutral per the requirements; Direction B picks a different temperature to create contrast; **Direction C is force-injected with a bold style by the SKILL's "seconds roulette."**
   - ❌ Don't let all three directions land on "off-white + whitespace + one accent color" — that's the most common failure mode.
3. **Fidelity**: ≥90% can be done with eyes closed; 70-90% the main body is doable with individual details downgraded; <70% (e.g., Memphis aged textures) must **explicitly note in the output which parts are downgraded to flat color blocks** — don't pretend you can reproduce the original's texture.
4. **Fonts**: each style provides open-source alternatives (Inter/Geist/Manrope/Space Grotesk/Fraunces/Playfair, etc.) — don't specify paid fonts (Söhne/Circular, etc.).
5. Companion: the SKILL "Design Direction Advisor" Phases 3-5 use this library to propose 3 directions; `assets/showcases/` has prebuilt screenshot galleries.

---

## Web Style Library (20 styles)

#### Bold Camp

**Editorial Brutalism (giant Helvetica crushing small body text)** `bold·fidelity 98%`
- Reference: Bloomberg Businessweek (Richard Turley's 2010-2014 redesign, executed by Code and Theory); the Neue Haas Grotesk lineage
- Fits: media/content publishing, AI product launches, brand site heroes, research report covers, opinion-piece longform header images
- Visual DNA: palette of pure black #000 + pure white #FFF + hyperlink blue #0000EE, accented with signal orange-red #FF433D / terminal green #00A33E. Fonts Helvetica/Neue Haas Grotesk, 120px+ giant headlines left-aligned with tight tracking directly crushing 14px small body text, extreme type-size contrast. Layout is a modular grid + 1px rule lines slicing columns, high information density with deliberately no whitespace. Signature elements: rule-line columns, hyperlink-blue underlines, large black-and-white color blocks.
- HTML implementation: pure CSS reproduces 1:1. CSS Grid for the modular grid + border for rule-line columns, clamp() for oversized responsive type + tightened letter-spacing, system Helvetica/Arial stack or Inter as fallback, hyperlinks straight #0000EE underlined. Zero asset dependency.
- Fonts: Inter (replacing Helvetica/Neue Haas Grotesk), Geist Mono for code

**Neo-Brutalism clashing-color feed (heavy black outlined cards + high-saturation clashes)** `bold·fidelity 95%`
- Reference: The Verge 2022 redesign (in-house team, PolySans + Mānuka)
- Fits: media/content sites, AI product aggregation pages, event landing pages, community ranking pages, Xiaohongshu-style info cards
- Visual DNA: palette of electric purple #5200FF ~ magenta #E1306C high-saturation primaries + bright yellow #F8E000 accent + pure black #08080D + white, large clashing-color blocks deliberately not softened. Fonts contrast a geometric sans-serif large headline against a serif body. Layout is a card-based feed, 2-4px heavy black outlines, hard color-block zoning, near-zero rounding. Signature elements: heavy-outlined cards that hover-flip to clashing colors, an unfinished-interface vibe.
- HTML implementation: a pure-CSS strong suit. border:3px solid #000 heavy outline + box-shadow hard offset shadow (4px 4px 0 #000) + grid/flex card flow + :hover swapping the background clashing color. No 3D / light-and-shadow obstacles.
- Fonts: Space Grotesk (replacing PolySans) + any serif such as Fraunces

**Memphis Maximalism (clashing color blocks + offset stacking + retro fonts)** `bold·fidelity 72%`
- Reference: Gucci Vault concept store (Alessandro Michele); the Memphis design movement / Sagmeister's rebellious gene
- Fits: e-commerce concept stores, creative event pages, brand experiment campaigns, Y2K retro themes, holiday marketing pages
- Visual DNA: palette juxtaposing large areas of retro red / mustard yellow / royal blue / purple / olive green clashing colors + an aged beige warm base, intense and deliberately disharmonious. Fonts mix retro serifs + decorative type, print texture, breaking the grid with offset stacking. Layout is anti-grid collage curation, modules of uneven size scattered and overlapping, like wandering through a digital room. Signature elements: clashing color blocks, offset stacking, unconventional navigation easter eggs.
- HTML implementation: transform:rotate() for offset stacking + position:absolute for overlaps + high-saturation background clashing color blocks + retro Google Fonts. Real aged textures cannot be reproduced in CSS — downgrade to flat color blocks + mix-blend-mode/contrast filters to simulate texture; the geometric-collage version holds up, the archival aged version downgrades.
- Fonts: DM Serif Display + Bungee (decorative) + Space Mono

**Friendly Geometric Candy (candy-color raised 3D buttons, gamified)** `bold·fidelity 85%`
- Reference: Duolingo (Johnson Banks + Monotype, Feather Bold typeface); anti-Silicon-Valley minimalism
- Fits: education / language learning, consumer app landing pages, gamified products, mass-market friendly products, event sign-up pages
- Visual DNA: palette of Duo green #58CC02 + duck yellow #FFC800 + sky blue #1CB0F6 candy high-saturation + white base, round and friendly. Fonts an extra-bold rounded face (Feather Bold feel). Layout large rounded cards, raised 3D buttons (hard bottom shadow = pressable feel), a mascot slot + progress bubbles. Signature elements: 3px solid bottom-shadow 3D buttons, press-down displacement animation, extra-rounded corners.
- HTML implementation: pure CSS. box-shadow:0 4px 0 hard bottom shadow for raised buttons + :active translateY(4px) removing the shadow to simulate the press, border-radius large rounding, flat color blocks. When no image generation is available, the mascot uses CSS geometric shapes or an emoji placeholder (slight downgrade).
- Fonts: Baloo 2 / Nunito (extra-bold rounded replacing Feather)

**Pure-CSS geometric illustration + responsive morphing easter egg (Pure-CSS Art)** `bold·fidelity 80%`
- Reference: Lynn Fisher (lynnandtonic.com, a pure-CSS art legend, covered in a dedicated Adobe feature)
- Fits: personal homepages, creative 404/easter-egg pages, playful brand landing pages, tech blog header images, designer self-showcases
- Visual DNA: palette of 2-4 high-contrast flat planes (swapping the palette at each breakpoint). Fonts a bold geometric sans-serif headline. Layout's core is "the image morphs with the viewport" — a set of CSS shapes reassembles into different scenes at different breakpoints (e.g., a building changing its number of floors as the screen widens). Signature elements: pure-CSS-drawn geometric illustration, breakpoint-driven reflow easter egg, zero images.
- HTML implementation: a pure-CSS show-off battlefield where zero assets is an advantage. div + border-radius/clip-path/transform/box-shadow stacking geometric shapes, @media breakpoints changing shape size/position to achieve the morph. The difficulty is in design conception rather than technique, but every shape needs to be carefully hand-built.
- Fonts: Rubik / Archivo (bold geometric replacing the custom face)

**Bold Big-Type Editorial (giant-type black-and-white high-contrast fashion poster)** `bold·fidelity 88%`
- Reference: Jacquemus official site / Rik Oostenbroek / Domestika; fashion-magazine big-type posters
- Fits: fashion e-commerce, portfolios, media features, brand manifesto pages, video-course covers, big-type versions of research reports
- Visual DNA: palette minimal black-and-white + a single restrained accent color (nude pink #E8C4C0 or true red). Fonts an oversized display sans-serif / high-contrast serif, the headline filling the entire screen. Layout a full-width grid, giant type wrestling with negative space, 1:1 image-text split. Signature elements: a screen-filling-proportion giant headline, luxury-grade whitespace, left-right counterposed typography.
- HTML implementation: pure CSS reproduces it perfectly. clamp() giant type + CSS Grid full-width split + heavy padding for whitespace + vh units letting the headline fill the viewport. When there's no image, flat color blocks / text blocks substitute for the fashion editorial placeholder (slight downgrade but the layout holds).
- Fonts: Archivo Expanded / Anton (display) + Playfair Display (high-contrast serif)

**Cosmic Retro-Futurism (retro-future space atlas)** `bold·fidelity 75%`
- Reference: Perplexity Comet browser launch site (The Brand Identity: Black/Blue/Cream; a "2001: A Space Odyssey" vibe)
- Fits: AI product launch sites, tech brand manifesto pages, event countdown pages, futuristic landing pages, concept launch events
- Visual DNA: palette of pure black #0A0A0A + creamy paper-white cream #F0EAD8 + a touch of cobalt-peacock blue #2B4F91, low-saturation like an old astronomical atlas. Fonts a high-contrast serif (classical astronomy-album feel) + whitespace. Layout line-drawn orbits / parabola SVGs, planet dots, dark type on a cream base, antiquarian typesetting. Signature elements: SVG celestial orbit lines, the cream + blue + black tricolor, retro serif large type, an astronomical-atlas texture.
- HTML implementation: pure CSS + SVG reproduces 80% of the static-version vibe. SVG path drawing orbital parabolas + CSS radial positioning of planet dots + tricolor variables + high-contrast serif. The gap is the full-screen video transition "space falling to Earth" (the soul part) — downgrade to a CSS scroll parallax + SVG orbit rotation approximation.
- Fonts: Cormorant Garamond / EB Garamond (high-contrast serif) + Space Mono

**Cinematic Sound-Viz Dark** `bold·fidelity 72%`
- Reference: ElevenLabs; film-opening title sequences (Saul Bass-style minimal motion) × audio-engineering interfaces
- Fits: audio/voice AI products, music-tech sites, podcast platforms, media launch pages, cinema-grade brand heroes
- Visual DNA: palette of a pure-black #000 base + pure-white text + blue-purple gradient accent waveforms. Fonts a large sans-serif headline, Saul Bass-style minimal. Layout a full-width dark stage, sound-wave / spectrum visualization running throughout, giant headline crushing the waveform, card-based feature zones. Signature elements: a colored audio-waveform band, film-opening-style minimalism, high-contrast black-and-white + a single gradient, the sound-visualization motif.
- HTML implementation: pure CSS + SVG reproduces 70% of the vibe (the skeleton is perfect, the waveform is the downgrade point). SVG polyline drawing a static waveform or an array of uneven-height divs + CSS animation for a "fake waveform" bounce approximation. The gap: a Web Audio/Canvas spectrum bouncing in real time to the sound cannot be reproduced in pure CSS — the static version looks right, the dynamic soul can't be done.
- Fonts: Inter / Sora (large sans-serif)

**Pixel-Game Side-Scroller** `bold·fidelity 70%`
- Reference: Robby Leonardi's interactive resume (8/16-bit platform-action-game narrative, paying homage to Nintendo SNES)
- Fits: creative resumes/portfolios, playful brand campaigns, gamified landing pages, event easter-egg pages, fun personal homepages
- Visual DNA: palette of retro-game multi-segment zones — forest green #4CAF50 grass + sky blue #5DADE2, transitioning to space purple #2C2A4A, volcanic orange-red #E8743B, undersea teal #1ABC9C, swapping in a high-saturation cartoon palette per "level." Fonts a pixel font (8-bit feel) + bold sans-serif. Layout side-scrolling / vertical-scrolling level-divided scenes, parallax layering, scroll-triggered displacement. Signature elements: per-level color swaps, pixel aesthetics, parallax scrolling, game-HUD-style UI.
- HTML implementation: pure CSS + a little JS reproduces the skeleton (the original was HTML + CSS + jQuery, no WebGL). Parallax layering with position + scroll displacement, image-rendering:pixelated, CSS frame-by-frame background-position for sprite animation, segmented background colors. The gap: original character / scene hand-drawn pixel illustration — when no image generation is available, CSS blocks assemble simple pixel icons as substitutes (art downgraded, technique not).
- Fonts: Press Start 2P / VT323 (pixel font) + Inter


#### Neutral Camp

**Bauhaus Geometric (geometric logomark + flat illustration system)** `neutral·fidelity 90%`
- Reference: Khan Academy rebrand (hexagon + petal logomark + Wonder Blocks design system); Bauhaus geometric construction
- Fits: education / course sites, brand logo systems, infographics, child-friendly products, event key visuals
- Visual DNA: palette of the three-primary lineage — Bauhaus red #E63946 / yellow #FFB703 / blue #0077B6 + black-and-white, flat color-block assembly. Fonts a geometric sans-serif (rounded geometric feel). Layout builds illustrations from the basic geometric units of circle / triangle / square, aligned to a grid, modular puzzle. Signature elements: a pure-geometric-form logomark, flat gradient-free illustration, primary-color-block construction.
- HTML implementation: pure CSS is all-powerful for geometry. border-radius:50% for circles, clip-path/border for triangles, square divs assembling geometric illustration, CSS Grid for grid alignment, flat fill needs no assets. Illustration is hand-built with CSS shapes or inline SVG geometric paths.
- Fonts: Poppins / Manrope (geometric rounded replacing Wonder Blocks)

**Dark Editorial (dark base + single neon accent + monospace; dark two-color sidebar developer portfolio)** `neutral·fidelity 96%`
- Reference: Brittany Chiang (brittanychiang.com v4, the de facto standard for dev portfolios)
- Fits: portfolio personal homepages, developer-facing products, tech brand sites, resume pages, AI tool landing pages
- Visual DNA: palette of a dark ink-green/navy base #0A192F + slate-gray text #8892B0 + a single neon teal-green accent #64FFDA. Fonts a sans-serif body + monospace (numbering / labels). Layout a left fixed sidebar nav + a right scrolling main area, two columns, section numbers 01/02, links hover-underline-slide-in. Signature elements: a single accent color, monospace numbered labels, sidebar anchor highlighting.
- HTML implementation: pure CSS reproduces fully. position:sticky for the fixed sidebar + CSS Grid two columns + single accent variable + monospace labels + :hover underline transform slide-in. Zero assets, pure layout and micro-interaction.
- Fonts: Inter + JetBrains Mono (monospace)

**Warm Editorial (cream paper base + terracotta orange + serif/sans-serif mix)** `neutral·fidelity 97%`
- Reference: Anthropic / Claude (DBCo + Geist Studio, Styrene × Tiempos); Penguin/Pelican paperback typesetting
- Fits: AI product sites, brand official sites, longform reading pages, orange-book e-books, research reports, training materials
- Visual DNA: palette of a cream paper base #F5F0E8 + terracotta orange #CC785C/#D97757 accent + near-black text #191919, warm and low-saturation. Fonts mix a serif headline (Tiempos feel) × sans-serif body (Styrene feel). Layout a book-style single-column reading flow, comfortable line height, restrained dividers. Signature elements: a paper-feel warm base, terracotta orange, publishing-grade typesetting rhythm.
- HTML implementation: pure CSS reproduces 100%, zero assets. Background-color variables + serif/sans-serif font-stack mix + max-width limiting reading width + line-height 1.7 comfortable line height. This is the safe home turf for the Anthropic terracotta-orange warm version.
- Fonts: Fraunces / Newsreader (replacing the Tiempos serif) + Inter (replacing Styrene)

**Glassmorphism Bento (Linear dark glow + Bento grid)** `neutral·fidelity 85%`
- Reference: Linear / Cursor (the phenomenon-level "The Linear Look" school, Frontend Horse has a code recipe)
- Fits: SaaS/AI product sites, developer tools, tech brand heroes, product feature showcases, dark-mode dashboard presentations
- Visual DNA: palette of a near-black base #08090A + a desaturated blue-purple brand #5E6AD2 + a low-saturation cyan-purple glow gradient #4EA7FC → #B59AFF. Fonts a geometric sans-serif with negative tracking, compact. Layout a bento-box grid in blocks, hairline dividers, glassmorphism cards. Signature elements: a dark-base glowing gradient border, bento blocking, a flowing-light streamer, frosted glass.
- HTML implementation: pure CSS reproduces strongly. box-shadow/filter blur + radial-gradient for the glow halo, backdrop-filter:blur for glassmorphism, conic/linear-gradient borders, CSS Grid assembling the bento. The only gap is "real product UI screenshots" — substitute color blocks + text assembling a simplified fake UI (this part downgrades).
- Fonts: Inter / Geist (negative tracking) + Geist Mono

**Angled Fluid Gradient (angled fluid gradient band)** `neutral·fidelity 92%`
- Reference: Stripe (the signature angled gradient banner, Klim's custom Söhne typeface)
- Fits: SaaS/Fintech landing pages, brand official-site heroes, product launch pages, event banners, AI product marketing pages
- Visual DNA: palette of a multi-color fluid gradient (indigo #635BFF → cyan → pink → orange warm tones) for the hero background + a pure-white content area + near-black text. Fonts a refined sans-serif (Söhne feel). Layout angled split color blocks (skew-cut zoning), the gradient hero crushing a structured-grid body. Signature elements: angled cut boundaries, a multi-color fluid gradient, a rational grid crushing an expressive gradient.
- HTML implementation: pure CSS. transform:skewY() or clip-path:polygon() for angled zoning, linear-gradient multi-color overlay (can add CSS animation slow flow) for the fluid gradient band, Grid for the structured body below. Zero assets.
- Fonts: Inter / Hanken Grotesk (replacing Söhne)

**Utility-First Colorful Docs (pragmatist rainbow-categorized documentation)** `neutral·fidelity 98%`
- Reference: Tailwind CSS Docs (Sky/Cyan brand color + functional-category rainbow hue bars)
- Fits: technical documentation, API references, design-system sites, tutorial sites, developer knowledge bases, SaaS help centers
- Visual DNA: palette of Sky blue #38BDF8 brand + a teal → cyan → sky cyan-blue gradient + Slate grayscale #0F172A/#64748B/#F8FAFC, with docs using a rainbow hue bar to distinguish functional categories (pink #EC4899 / purple #A855F7 / green #10B981 / orange). Fonts a crisp sans-serif + monospace code. Layout a left sidebar nav + center body + right TOC, three columns, color-highlighted code blocks, category color tags. Signature elements: a cyan-blue gradient hero, rainbow category colors, a three-column docs skeleton, syntax-highlighted code blocks.
- HTML implementation: pure CSS reproduces 98% (it is itself CSS-framework documentation). Grid three columns + linear-gradient cyan-blue hero + category color variables + code-block syntax colors via span coloring. Inter is open source; only dark-mode toggle / copy need lightweight JS. Zero light-and-shadow / 3D / hand-drawing.
- Fonts: Inter + JetBrains Mono / Fira Code (code)

**Terminal-Core Soft-Futurism (monospace + isometric cubes)** `neutral·fidelity 80%`
- Reference: Cursor (Anysphere); developer-terminal aesthetics × Teenage Engineering industrial minimalism
- Fits: AI coding tool sites, CLI product landing pages, developer infrastructure, tech brand heroes, terminal-type products
- Visual DNA: palette of a charcoal #0B0D14 base + warm-white text #F2F0EF + a restrained blue-purple gradient accent dotting buttons and glow. Fonts monospace as the lead role (command-line feel) + sans-serif as support. Layout a command-line / code block in the foreground, bento zoning, a 2.5D isometric cube schematic. Signature elements: monospace command lines, isometric-projection cubes, warm-white × charcoal, a restrained gradient glow, industrial minimalism.
- HTML implementation: pure CSS reproduces 80%. Monospace code blocks + dark bento + box-shadow glow; the 2.5D isometric cube is hand-built with CSS 3D transform (rotateX/Y + skew) or SVG isometric projection. The gap: a clickable multi-interface demo needs JS + fake-UI assembly. No hard WebGL requirement.
- Fonts: Geist Mono / JetBrains Mono (lead) + Inter (support)


#### Quiet Camp

**Functional Brutalism (gray-line dividers + system fonts + blue links)** `quiet·fidelity 98%`
- Reference: Are.na / Lobsters / Quartz; the digital landing of the Müller-Brockmann grid + Tufte information density
- Fits: community/UGC platforms, content aggregation sites, documentation knowledge bases, mobile-first content feeds, geek-facing products
- Visual DNA: palette of a near-white base #FBFBFB + black text + 1px gray dividers #E0E0E0 + classic link blue #0000EE / visited purple. Fonts a system font stack (-apple-system / undecorated). Layout a high-density information list, thin gray-line columns, minimal whitespace, compact line spacing. Signature elements: hairline gray dividers, blue links, system fonts, information-density priority.
- HTML implementation: pure CSS is the easiest to reproduce — this is the native color of Brutalist Web. border-bottom:1px gray-line list + system-ui font stack + compact padding + blue links. Needs almost no assets or JS, pure structure.
- Fonts: system-ui system font stack / IBM Plex Sans (fallback)

**Gallery Dark (deep-black negative space + single-column large images + EXIF small type)** `quiet·fidelity 75%`
- Reference: Glass (glass.photo) / Bottega Veneta; the gallery darkroom + Apple Photos content-first
- Fits: photography portfolios, luxury e-commerce, immersive visual-content display, personal gallery pages, high-end product display
- Visual DNA: palette of a pure-black base #0A0A0A + the artwork image itself providing the only color + very-light-gray EXIF small type #666. Fonts an ultra-thin sans-serif small type. Layout a single centered large image, giant negative-space matting, metadata small type below the image. Signature elements: a darkroom black base, content-first UI receding, EXIF-style small-type captions, a large image monopolizing the viewport.
- HTML implementation: pure CSS reproduces the layout skeleton. Pure-black base + centered max-width single column + giant padding matting whitespace + small-type metadata. The gap is the "real photographic work" itself — substituting placeholder images / flat color blocks loses the soul, but the darkroom mood and layout pair 100%.
- Fonts: Inter (thin weight 300) / Cormorant (optional serif luxury feel)

**Swiss Monochrome (Vercel-style pure black-and-white + Geist + sharp corners)** `quiet·fidelity 98%`
- Reference: Vercel / Next.js Docs (the self-developed Geist is open source); Massimo Vignelli's less-is-more
- Fits: developer-tool documentation, tech brand official sites, AI product sites, SaaS landing pages, minimal research reports
- Visual DNA: palette of pure black #000 + pure white #FFF + grayscale #888, zero color or only a touch of link blue. Fonts Geist geometric sans-serif + Geist Mono. Layout sharp right angles (no rounding or extremely small), high contrast, a precise grid, restrained whitespace. Signature elements: pure black-and-white, sharp corners, the Geist typeface, triangle/arrow geometric markers.
- HTML implementation: pure CSS reproduces 100%, Geist is open source and can be referenced directly. CSS Grid precise grid + pure black-and-white variables + border-radius:0 sharp corners + hairline borders. This is the most comfortable minimalist home turf for HTML, zero asset dependency.
- Fonts: Geist + Geist Mono (the Vercel open-source original)

**Kenya Hara White Gallery (Japanese-whitespace white-box gallery)** `quiet·fidelity 80%`
- Reference: Cosmos (cosmos.so) / Aesop official site; Kenya Hara's emptiness of "white" + a Swiss-grid hybrid
- Fits: high-end e-commerce, creative galleries, content-curation platforms, designer portfolios, brand boutiques, moodboard sites
- Visual DNA: palette of a near-all-white #FAFAFA base + pure-black text #0A0A0A + a very-light-gray divider #EFEFEF, with content images providing all the color and the UI receding to the background. Fonts a minimal system / geometric sans-serif small type, large tracking. Layout a masonry waterfall grid, extreme whitespace, light-gray hairline dividers, Eastern emptiness. Signature elements: white-box aesthetics, luxury whitespace, content-first UI receding, waterfall-flow curation.
- HTML implementation: pure CSS reproduces the static layout (distinguished from Gallery Dark by the "white"). CSS columns or Grid for masonry + near-white variables + large padding whitespace + light-gray dividers. The gap is Lenis/GSAP silky inertial scrolling and image entrance easing (60% of the high-end feel is here); CSS only has basic transitions, the motion layer downgrades.
- Fonts: Inter (thin weight) / Cooper Hewitt (the same open-source font Aesop uses)


## PPT Style Library (20 styles)

#### Bold Camp

**Neo-Swiss Billboard Editorial** `bold·fidelity 98%`
- Reference: the Big-Number Editorial school of AI/SaaS roadshow decks like Scribe $75M, Flock Safety $47M; Bloomberg Businessweek infographics; Pentagram
- Fits: fundraising roadshows, QBR/business reviews, annual trend recaps, product-launch key slides
- Visual DNA: palette = pure white (#FFFFFF) or near-black (#0A0A0A) base + a single high-saturation accent color (electric blue #2D5BFF / fluorescent green #00E676 / brand orange #FF6B2C) + neutral grid lines #E5E5E5. Fonts = an oversized bold sans-serif, the headline taking half the screen, numbers tabular-nums monospaced with tightened tracking. Masters = ① a large-color-block section page with one word ② a giant number taking half the screen (3.2x) + small notes ③ a left-right column comparison ④ a full-width flat line/bar chart. Signature = billboarding big type, a strict baseline grid, large-color-block section pages
- HTML implementation: oversized numbers use clamp(); the strict grid uses CSS Grid; large-color-block section pages use background-color; line/bar charts use pure div + CSS or inline SVG (sharper than a pasted image); number alignment uses font-variant-numeric:tabular-nums. Zero illustration, zero 3D
- Fonts: Inter / Geist / Söhne replacing Neue Haas Grotesk; numbers paired with Geist Mono

**Black Big-Number Stage** `bold·fidelity 97%`
- Reference: Steve Jobs' 2007 iPhone Keynote, the Xiaomi SU7 Ultra Lei Jun launch, Spotify Wrapped, Presentation Zen (Garr Reynolds)
- Fits: product-launch keynotes, thought presentations, all-hands town halls, emotionally-oriented annual recaps
- Visual DNA: palette = a pure-black #000000 base + pure-white #FFFFFF type, high contrast, with only one brand accent color highlighted per page (Xiaomi orange #FF6900 / Spotify green #1ED760 / Apple blue #2997FF). Fonts = a geometric sans-serif bold, one word per screen or one giant number filling the field of view, tightened tracking. Masters = ① a title page, black base, centered single line of large type ② a data-climax page, giant number + unit + a line of notes ③ a left-right parameter comparison, two columns (accent color vs gray) ④ a slogan single page. Lots of negative space
- HTML implementation: black base, white type, a few lines of CSS; giant numbers clamp() + flex centered; the accent-color highlight a separate span; left-right comparison CSS Grid two columns + bar highlight; tabular-nums. Dropping the product photo for pure text actually gets closer to the Zen essence
- Fonts: Geist / Inter / Source Han Sans replacing SF Pro

**Mono-Brand Type-as-Hero (high-saturation single-color brand clashing poster)** `bold·fidelity 96%`
- Reference: the Spotify Wrapped visual system, the Mailchimp Brand Book (Collins), the Netflix red-black modern revival, COLLINS brand systems
- Fits: brand/marketing strategy, campaign pitches, town-hall culture pages, event key visuals
- Visual DNA: palette = a single brand primary flooding the full bleed (Spotify green #1ED760 / Mailchimp yellow #FFE01B / Netflix red #E50914) + black or white contrast type, two clashing layers. Fonts = oversized type as the key visual (type-as-hero) floor-to-ceiling. Masters = ① a full-color-block base + reverse-white giant type ② a two-color block top/bottom or left/right split ③ a giant number filling the frame. Signature = single-color full bleed, type as image, high-contrast clashing color
- HTML implementation: full-bleed background-color; oversized type clamp() filling the frame; two-color uses two 100vh color blocks; type-as-image relies on font-weight 900 + negative letter-spacing. Flat color blocks, zero assets — HTML-native is happiest
- Fonts: Inter / Manrope / Archivo (extra-bold) replacing Circular/Cavendish

**Full-Bleed Gradient Manifesto** `bold·fidelity 82%`
- Reference: the Zuora "Tell a Different Story" sales deck (Andy Raskin's breakdown), the Nike "Just Do It" campaign, National Geographic spreads
- Fits: sales-proposal vision pages, brand manifestos, keynote turning-point pages, mission-vision single pages
- Visual DNA: palette = a full-bleed CSS gradient (warm orange → magenta / deep blue → cyan) or a solid-color bleed + reverse-white manifesto big type + a hashtag slogan (#shifthappens). Fonts = a heavy sans-serif all-caps slogan running across. Masters = ① a full-bleed gradient + centered reverse-white manifesto ② a promised-land vision page ③ a customer-logo wall. Signature = full-bleed, reverse-white big slogan, hashtag slogan
- HTML implementation: linear-gradient/radial-gradient full bleed (no particles / light-and-shadow, pure CSS gradient is allowed); reverse-white type position centered; the logo wall uses a grid of grayscale SVG / text placeholders. The part originally relying on documentary big photos downgrades to a CSS gradient base + big type; the missing photo drops this item's fidelity by ~15%
- Fonts: Archivo / Anton / Manrope (extra-bold)

**Candy-Color Lecture Stage (CS50 single-concept candy stage)** `bold·fidelity 94%`
- Reference: Harvard CS50 (David Malan), the Lessig Method / Takahashi method, Presentation Zen
- Fits: educational courseware, technical lectures, concept explanations, code teaching
- Visual DNA: palette = a deep-black base #0A0A0A + rotating high-saturation candy-color big type (magenta #FF2D95 / cyan #00E5FF / bright yellow #FFD500 / green #39FF14). Fonts = a sans-serif oversized type floating centered, one concept per screen, very little text. Masters = ① a deep-black base, single candy-color big word ② a monospace code block, syntax highlighted ③ stage-spotlight-feel big type. Signature = deep-black floating candy-color big type, monospace code highlighting, strong stage spotlight, very little text
- HTML implementation: deep-black background + single-color oversized type clamp() centered; the code block uses pre + monospace + span coloring for syntax highlighting; the spotlight feel uses a very-light radial-gradient vignette (not a particle light effect). High fidelity
- Fonts: Inter extra-bold + JetBrains Mono (code)

**Playful Maximalist Editorial (Collins-style) (playful hand-drawn minimalism)** `bold·fidelity 75%`
- Reference: the Mailchimp Brand Book (Collins 2018), the New Yorker cartoon vibe, the Cooper rounded serif, Cavendish fluorescent yellow
- Fits: brand decks with attitude, creative-agency pitches, culture-oriented town halls, anti-SaaS-minimalism marketing pages
- Visual DNA: palette = large areas of Cavendish fluorescent yellow #FFE01B + black + a little clashing color, anti-SaaS-minimalism. Fonts = a Cooper-style rounded serif big headline (playful) + magazine-style whitespace arrangement. Masters = ① a fluorescent-yellow full base + a quirky headline ② magazine-style irregular-whitespace layout ③ big-type meme copy. Signature = fluorescent yellow, rounded serif, playful arrangement, a quirky hand-drawn vibe (downgraded to geometric color blocks / emoji substituting for real illustration)
- HTML implementation: fluorescent-yellow background; rounded-serif font-family; magazine whitespace uses an asymmetric Grid. The hand-drawn monkey / illustration core element can't be done without AI image generation — downgrade to CSS geometric color blocks + large emoji + irregular transform-rotated text blocks; the missing illustration drops fidelity by ~20%
- Fonts: Fraunces (adjustable roundness) / Bree Serif replacing Cooper; body Inter

**Irreverent Pop (Reddit-style) (unruly meme pop version)** `bold·fidelity 80%`
- Reference: the Reddit Ads sales deck (listed by Dock as the most full of personality), David Carson-style unruly typography, '90s web retro, Memphis playfulness
- Fits: Gen-Z brands, meme marketing decks, community/creator-facing, pitches that dare to be unserious
- Visual DNA: palette = Reddit orange-red #FF4500 + clashing colors, '90s web retro colors. Fonts = David Carson-style mixed / grid-breaking typesetting, meme colloquial copy. Masters = ① a fun page, meme big type ② a facts page, a rhythm shift to serious data ③ colloquial headlines. Signature = grid-breaking mixed typesetting, orange-red, meme colloquialism, a fun→facts rhythm reversal, retro-web texture
- HTML implementation: deliberately break the grid with transform rotation / overlapping positioning / mixed type sizes; orange-red + clashing color blocks; the retro texture uses a heavy black border + a hard box-shadow (no blur). Custom meme illustration downgrades to emoji + geometric collage, but the mixed typesetting itself is HTML-reproducible
- Fonts: Archivo / Space Grotesk + a mixed-in Inter to create contrast

**Maximalist 3D-Type (Wrapped-style) (Y2K inflated big type)** `bold·fidelity 78%`
- Reference: Spotify Wrapped 2022/2023/2025, Memphis clashing color, Y2K/Maximalism, duotone portrait gradients
- Fits: annual recaps (emotionally-viral-oriented), personalized data cards, social-share portrait cards, brand year-end
- Visual DNA: palette = a high-saturation clashing-color full-bleed background (magenta + cyan + orange) + Spotify green as the eye-catcher + a duotone two-color gradient. Fonts = floor-to-ceiling giant numbers, with years / numbers given a 3D-inflated / metallic texture. Masters = ① clashing-color full bleed + giant inflated numbers ② a duotone portrait / color-block base + reverse-white big type ③ a portrait shareable card. Signature = giant inflated 3D numbers, clashing-color full bleed, a duotone gradient, a metallic-texture year, a portrait story card
- HTML implementation: clashing-color full-bleed background; 3D inflated numbers use multi-layer CSS text-shadow stacking + transform:perspective or SVG + stroke to create dimension (not real 3D rendering); duotone uses mix-blend-mode + a gradient overlaid on a grayscale-image placeholder block. The metallic texture downgrades to gradient-filled text background-clip:text, dropping fidelity by ~15%
- Fonts: Archivo Black / Anton extra-bold + numbers Clash Display


#### Neutral Camp

**Bento Grid (bento-box modular grid)** `neutral·fidelity 95%`
- Reference: the Apple Keynote Bento Grid era, the new generation of MBB Bento/Big-Type decks (2024-2026), the Stripe annual-report metric-card matrix, Pitch.com QBR templates
- Fits: product feature summaries, consulting/QBR data reports, sales-result pages, town-hall metric pages
- Visual DNA: palette = a light-gray / cream base (#F5F5F7 / cream) or a near-black base + a brand primary + 1-2 accent colors, cards with a light-color zone base + rounded corners + a micro-outline / micro-shadow. Fonts = an oversized display headline + regular body, strong weight contrast, KPI numbers tabular figures. Masters = ① a title page, a giant single sentence + whitespace ② a bento page, 2×2 / 3-column uneven-height cards with one insight per card (number / linear icon / sparkline) ③ a one-insight oversized-number page. Signature = an uneven-height card grid, rounded micro-outline, a breathing feel
- HTML implementation: CSS Grid grid-template-areas for the uneven-height bento; cards border-radius + box-shadow micro-shadow + 1px hairline; sparkline uses inline SVG; linear icons use inline SVG stroke. Zero pasted images
- Fonts: Inter / Geist + numbers Geist Mono

**Dark Hairline Terminal (Neo-Swiss dark terminal aesthetics)** `neutral·fidelity 94%`
- Reference: the Linear pitch deck, the Vercel design language, the CS50 deep-black stage courseware; fonts Inter Tight + JetBrains Mono
- Fits: developer-tool / tech-product launches, technical roadshows, engineering-oriented reports
- Visual DNA: palette = a near-black base (#0D0D0F / #111113) + a hairline thin-line #262629 grid + a single purple-blue accent (#5B5BD6 / #7C7CFF). Fonts = Inter Tight big headline + JetBrains Mono for labels / data. Masters = ① a minimal title page, one sentence + a mono subhead ② a hairline-divided data grid ③ a mono-label feature list. Signature = a 1px thin-line grid, a mono monospace label, extreme whitespace, near-black not pure-black
- HTML implementation: near-black background + a border:1px solid hairline grid; mono labels use a monospace font-family; glow uses a very-light box-shadow / border highlight rather than a real light effect (downgraded to avoid the cyber-neon forbidden zone). Note: avoid the #0D1117 deep-blue forbidden zone, use a neutral near-black
- Fonts: Inter Tight + JetBrains Mono / IBM Plex Mono

**Two-Font Consulting (Bower-style)** `neutral·fidelity 90%`
- Reference: the McKinsey 2019 brand system (designed by Wolff Olins, Bower serif + sans-serif), BCG Executive Perspectives, a deep-blue thin-line pattern
- Fits: consulting reports, executive briefings, industry research, authoritative-institution proposals
- Visual DNA: palette = deep blue (#051C2C / McKinsey deep blue) × white binary + a single brand-color highlight (BCG green #00805A), a warm-gray base with a breathing feel. Fonts = a characterful serif big headline (Bower-style) juxtaposed in high contrast with a sans-serif body. Masters = ① a top-left conclusion-style action-title ② blue thin-line pattern decoration ③ magazine-style left-right division of labor (conclusion text + visual) ④ a big-number data-point card. Signature = serif × sans-serif high contrast, a deep-blue thin-line pattern, action-titles, a warm-gray high-end feel
- HTML implementation: two-font font-family juxtaposition (serif headline + sans-serif body); the thin-line pattern uses repeating-linear-gradient or an SVG line; the data-point card pure CSS; photo grayscale treatment is omittable with no photo. The blue-purple edge shimmer downgrades to a solid-color edge
- Fonts: Playfair Display / Fraunces serif headline + Inter body (replacing Bower)

**Diagram-Driven Isotype (graph-and-arrow enterprise version)** `neutral·fidelity 88%`
- Reference: the Salesforce sales deck, the Isotype (Otto Neurath) lineage, Gene Zelazny's "Say It With Charts," Hans Rosling/Gapminder
- Fits: platform/architecture explanations, customer journeys, process methodologies, ecosystem maps
- Visual DNA: palette = enterprise-blue color blocks + product-line color differentiation + an iconified capability grid. Fonts = a clear sans-serif. Masters = ① a horizontal customer-journey arrow flow ② a layered platform-architecture diagram ③ an iconified capability grid ④ a 2×2 / waterfall / pyramid structure diagram. Signature = arrow processes, layered architecture boxes, an Isotype icon grid, process-as-narrative
- HTML implementation: arrow processes use Flexbox + CSS clip-path triangles or SVG arrows; architecture layering uses nested bordered divs; icons use inline SVG stroke with unified stroking; waterfall/pyramid uses Grid + skew. Bubble charts can use CSS circles + positioning. Pure vector drawing
- Fonts: Inter / IBM Plex Sans (chart-friendly)

**Diagrammatic Minimalism (single master-diagram concept illustration)** `neutral·fidelity 95%`
- Reference: Simon Sinek's Golden Circle TED, Bauhaus geometric abstraction, the information architecture of "one diagram defines the whole scene"
- Fits: theoretical-framework explanations, TED-style thought dissemination, model/methodology visualization, single-concept keynotes
- Visual DNA: palette = a minimal white / light base + black + 1 accent color, geometric flat color. Fonts = a sans-serif, labels uppercase embedded in the shapes. Masters = ① a single geometric master-diagram (concentric circles / triangle / matrix) carrying all the concepts ② arrows from inside out ③ contrast cases. Signature = a single geometric master-diagram, nested concentric circles / triangles, uppercase labels, one diagram carrying the concept
- HTML implementation: concentric circles use border-radius:50% nested divs or SVG circle; triangles use clip-path / SVG polygon; arrows SVG marker; labels absolute-positioned stuck on the shapes. Pure geometry, HTML reproduces perfectly
- Fonts: Manrope / Futura-family (Jost open-source alternative) geometric feel

**Narrative Sparkline (Duarte-style) (sparkline narrative waveform)** `neutral·fidelity 91%`
- Reference: Nancy Duarte's "Resonate" Sparkline narrative diagram, Al Gore's "An Inconvenient Truth," Duarte Inc. data storytelling
- Fits: speech-structure design, change narratives, before/after comparisons, data-story arcs
- Visual DNA: palette = a dark base or white base + a brand-orange accent on the turning points + grayed-out comparisons. Fonts = a sans-serif, annotation marker points. Masters = ① an oscillating waveform line running across the full screen ② text annotation points on the waveform ③ a top-bottom juxtaposed comparison waveform ④ a full-black base with a lone hanging data line ⑤ step-by-step reveal. Signature = a running waveform line, waveform annotation points, an orange turning point, a comparison waveform, a curve climbing out of the frame
- HTML implementation: the waveform line uses an inline SVG path (smooth Bézier); annotation points use SVG circle + text positioning; the comparison waveform two paths top and bottom; reveal uses CSS animation stroke-dashoffset. Pure SVG drawing, no assets
- Fonts: Inter + numbers Geist Mono


#### Quiet Camp

**Assertion-Evidence / Tufte information design** `quiet·fidelity 93%`
- Reference: Michael Alley's Assertion-Evidence (Penn State empirical), McKinsey/BCG action-titles, Edward Tufte's data-ink ratio, Barbara Minto's pyramid principle
- Fits: academic/engineering reports, data-rigorous consulting pages, policy research reports, technical reviews
- Visual DNA: palette = a white / very-light-gray base + black body + a single restrained accent color (deep blue / brick red). Fonts = a full-sentence headline (not a noun phrase), with a single diagram monopolizing the space below the headline, text annotations embedded in the diagram. Masters = ① a full-sentence action-title ② single-diagram evidence below the headline ③ zero bullets. Signature = full-sentence headlines, single-diagram evidence, embedded annotation, zero chartjunk, a high data-ink ratio
- HTML implementation: full-sentence headlines rely on typographic hierarchy; charts use pure CSS / inline SVG to draw a minimal line / scatter (remove grid lines, remove the legend, annotations text-positioned directly beside the data points); zero decoration. Tufte's restraint is exactly an HTML strong suit
- Fonts: Source Serif / Lora headline + Inter body (two-font reading-grade)

**Institutional Swiss Minimal (Swiss institutional minimalism)** `quiet·fidelity 96%`
- Reference: the Sequoia official 10-page pitch template, the Airbnb 2009 seed deck, the Müller-Brockmann grid, Massimo Vignelli
- Fits: investment roadshows, standard business proposals, problem-solution narratives, brand de-decorated proposals
- Visual DNA: palette = a pure-white base + black-gray body + a single brand accent color (Airbnb coral red #FF5A3C / a neutral blue). Fonts = a Helvetica-family sans-serif, the headline a medium-bold one-sentence, the body short sentences with large spacing. Masters = ① a centered logo + slogan ② a top one-sentence headline band + a 3-column counterpoint below (Problem/Solution three points) ③ a TAM big-number layering ④ a 2×2 competitor matrix. Signature = a top headline band, three-column counterpoint, single-color accent, a 2×2 matrix
- HTML implementation: Flexbox three-column counterpoint; the 2×2 matrix pure CSS Grid + border drawing; TAM layering uses nested divs or concentric squares; one message per page. Almost pure typographic grid, an ideal HTML target
- Fonts: Inter / Helvetica Now replacing Helvetica; body Inter

**Editorial Longform (magazine editorial longform flow)** `quiet·fidelity 95%`
- Reference: the Stripe Annual Letter ($1.9T), the Amazon six-page narrative memo, Benedict Evans' "X eats the world," Stripe Press
- Fits: annual letters / recap narratives, deep-thought longform, internal updates, research-report-style reading material
- Visual DNA: palette = a cream / off-white base (#FBFAF8) + dark-ink type + a brand-color eye-catcher (Stripe purple #635BFF). Fonts = a serif or high-quality sans-serif, prose paragraphs + inline data cards, oversized display numbers interspersed. Masters = ① a masthead big headline ② multi-column prose + inline metric cards ③ an oversized-number paragraph anchor. Signature = a publication reading rhythm, inline data cards, restrained whitespace, prose-style rather than bullets
- HTML implementation: multi-column column-count or Grid; inline data cards float/inline-block embedded in the body; serif body max-width controlling line width to 65ch; oversized numbers interspersed. Pure layout, zero assets
- Fonts: Newsreader / Source Serif body + Inter support; numbers tabular

**Humanist Rounded Cards (Khan-style)** `quiet·fidelity 80%`
- Reference: the Khan Academy Wonder Blocks design system, the Source Serif Pro serif, the forest-green brand, friendly humanism
- Fits: education products, approachable courseware, public-good / non-profit decks, warm brand proposals
- Visual DNA: palette = forest green #14BF96/#0A5C4B + a cream base + warm-color support, soft and not glaring. Fonts = a Source Serif serif headline (humanist feel) + sans-serif body. Masters = ① a rounded-card component set ② a serif headline + approachable body ③ a real-photography slot (downgraded to green-family geometric / rounded color blocks). Signature = forest green, serif headlines, large rounded cards, humanist warmth, an imperfect approachable texture
- HTML implementation: large-rounded border-radius cards + soft box-shadow; serif headline font-family; a warm cream base. The real teacher-student photography can't be done without AI image generation — downgrade to green-family geometric illustration blocks / large-rounded solid-color placeholders + emoji figures; the missing photo drops fidelity by ~18%
- Fonts: Source Serif 4 headline + Nunito Sans / Inter body (Nunito's roundness echoes humanism)

**Dense Research Report (Meeker-style)** `quiet·fidelity 92%`
- Reference: Mary Meeker's "Internet Trends" (BOND), CB Insights' "State of AI," the McKinsey Global Institute's "Year in Charts," FT/Bloomberg data journalism
- Fits: trend research reports, industry-data recaps, dense data reports, market maps
- Visual DNA: palette = a white base + a brand color (BOND/CB Insights bright blue #0066FF) in stepped single-color highlighting with the rest grayed out, almost zero whitespace. Fonts = conclusion-style sentence headlines, one diagram per page in density, very small source footnotes. Masters = ① a conclusion-sentence headline + a full-page single diagram ② a logo-grid market map ③ a big-number KPI card ④ a dense multi-diagram grid + footnotes. Signature = conclusion-sentence headlines, a zero-whitespace research-report feel, single-color stepped highlighting, a logo market map, source-footnote conventions
- HTML implementation: dense charts all drawn with pure CSS / inline SVG (bar / line / stacked / scatter); the logo market map uses Grid + text/SVG placeholder cells; KPI cards CSS; footnotes small type. Extreme information density is exactly HTML's forte, zero assets
- Fonts: Inter + IBM Plex Sans + numbers tabular Geist Mono

**All-Text Manifesto (Netflix/Amazon-style) (pure-text manifesto memo)** `quiet·fidelity 97%`
- Reference: the Netflix Culture Deck (2009, 125 pages), the Amazon six-page narrative memo (Bezos), Tufte's anti-PowerPoint stance, Matthew Carter reading-grade typography
- Fits: culture manifestos, values pitches, deep memos, anti-PPT pure-document presentations
- Visual DNA: palette = a pure-white or pure-black base + a single accent color (Netflix red #E50914) as the only highlight, extreme restraint. Fonts = reading-grade typography, one viewpoint per page, a punchy-line assertion / pure prose, zero bullets, zero diagrams. Masters = ① a full-bleed base + a punchy-line assertion ② colloquial candid paragraphs ③ a highlighted institutional term (Keeper Test) ④ six-page prose + an appendix table. Signature = pure text one viewpoint per page, zero diagrams zero bullets, a single-color highlighted punchy line, colloquial candor, a silent-read document feel
- HTML implementation: pure layout: punchy lines use big type clamp() left-aligned hierarchy; prose max-width controlling line width; the only accent color a span highlighting key phrases; the appendix uses a minimal table. Zero assets, zero diagrams — pure text is HTML's most stable reproduction
- Fonts: Newsreader / Source Serif (reading-grade) or Inter (manifesto-style); the headline can be Archivo extra-bold


---

## ⚠️ AI-Image-Generation-Only Styles (only recommend when the user is confirmed to have image-generation capability; not selectable by default)

The soul of the styles below lies in **dynamically generated visuals / 3D / particles / cinematic light-and-shadow / hand-drawn illustration**. Under pure HTML/CSS with no image generation, only a severely degraded mock can be made, so they are **removed from the default recommendation pool**. They become candidates only when the user explicitly has image-generation capability (going through `huashu-gpt-image`):

| Style | Soul | Why HTML Can't Do It |
|------|------|------------------|
| Active Theory (WebGL particles) | 3D particle system / real-time rendering | pure CSS can't |
| Field.io (generative art) | algorithmically generated graphics | static SVG can only do a rigid simplified version |
| Resn (illustration interaction) | character illustration + gamification | relies on hand-drawn assets |
| Zach Lieberman (real-time generation) | creative-coding brushstrokes | relies on real-time generation |
| Raven Kwok (fractal parameters) | recursive fractals | CSS can't reach the complexity |
| Ash Thorp (cinematic light-and-shadow) | cinematic volumetric light / concept art | CSS light-and-shadow is degraded |
| Territory Studio (FUI hologram) | sci-fi holographic interface | relies on lots of glowing stacked-layer assets |
| Neo Shen (ink wash) | organic ink-wash bleed | a CSS gradient ≠ ink wash |
| Sagmeister & Walsh (color explosion) | handmade physical objects + experimental typography | the clashing-color skeleton is doable (already merged into web "Memphis" and PPT "single-color clashing poster"), the handmade texture can't be done |

> These styles aren't "bad," the "medium is wrong" — their native medium is AI-direct-output images, not the browser DOM.

---

## Default Aesthetic Forbidden Zone (the user can override per their own brand)

- ❌ **The GitHub-dark lazy solution**: a uniform deep-blue base (#0D1117) + generic cyan/purple neon glow — only this one overused combination is forbidden, not "dark is universally banned"
- ✅ **Not in the forbidden zone**: cinematic dramatic light-and-shadow, warm-color cyber (Ash Thorp orange/cyan), the dark-stage narrative of movement poetics — dark with authorial intent is preserved (this library's "Linear dark glow," "Black Big-Number Stage," and "CS50 Candy Stage" are all legitimate dark)
- ❌ The aggressive purple-gradient universal formula, emoji as icons, a rounded card + left colored border accent (unless the brand itself uses it)
- ❌ Adding a personal signature / watermark on the cover image

---

## Prompt Mindset When You Have Image-Generation Capability (Mood, Not Layout)

> Applies only when going down the AI-image-generation path; the HTML path writes code directly per each style's "HTML implementation" above.

Short prompts > long prompts. Describing mood and content is more effective than piling on 30 lines of layout detail.

| Diversity-Killing Phrasing | Creativity-Sparking Phrasing |
|----------------|----------------|
| specifying color ratios (60%/25%/15%) | describing mood ("warm like Sunday morning") |
| prescribing layout positions | citing a specific aesthetic ("Pentagram editorial feel") |
| listing all the visual elements | describing what the audience should feel |

Full AI-image-generation methodology → the `huashu-gpt-image` skill.

---

**Version**: v3.0 (2026-06 fully rebuilt as the HTML-native 40-style library)
**Applies to**: the default HTML path for all visual design — web/PPT/PDF/infographic/cover/App, etc.
