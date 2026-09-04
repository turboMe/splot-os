# Core Asset Protocol (Full Version)

> The full protocol (streamlined in 2026-06) descended from SKILL.md "Core Philosophy #1.a". SKILL.md retains trigger conditions + 5-step titles + self-check; this document provides 5 detailed steps, download commands, a brand-spec template, full-process failure fallback, anti-patterns, and cost comparison.
> Trigger: Mandatory execution when a task involves a specific brand/product. Refer to SKILL.md for the condensed version and context.

#### 1.a Core Asset Protocol (Mandatory for Specific Brands)

> **This is v1's most critical constraint and the lifeline for stability.** Whether the Agent follows this protocol directly determines if the output quality is 40 points or 90 points. Do not skip any step.
>
> **v1.1 Refactor (2026-04-20)**: Upgraded from "Brand Asset Protocol" to "Core Asset Protocol". The previous version overly focused on color values and fonts, missing the most basic design elements like logos, product images, and UI screenshots. Uncle Hua's original words: "Besides so-called brand colors, we should obviously find and use DJI's logo, and Pocket 4's product images. If it's a website or app, or other non-physical product, the logo should at least be mandatory. This might be a more fundamental logic than so-called brand design specs. Otherwise, what are we expressing?"

**Trigger Conditions**: The task involves a specific brand—the user mentions a product name/company name/explicit client (Stripe, Linear, Anthropic, Notion, Lovart, DJI, our own company, etc.), regardless of whether the user proactively provided brand materials.

**Prerequisite Hard Condition**: Before following the protocol, you must have confirmed the brand/product exists and its status is known via "#0 Fact Verification Before Assumption". If you are unsure whether the product has been released/its specifications/version, go back and search first.

##### Core Philosophy: Assets > Specifications

**The essence of a brand is "it is recognized."** What enables recognition? Ranked by identifiability:

| Asset Type | Contribution to Recognition | Necessity |
|---|---|---|
| **Logo** | Highest · Any brand with a logo is instantly recognizable | **Mandatory for any brand** |
| **Product Image/Render** | Extremely High · The "protagonist" of physical products is the product itself | **Mandatory for physical products (hardware/packaging/consumer goods)** |
| **UI Screenshot/Interface Material** | Extremely High · The "protagonist" of digital products is its interface | **Mandatory for digital products (Apps/websites/SaaS)** |
| **Color Values** | Medium · Auxiliary recognition, often clashes when separated from the first three | Auxiliary |
| **Fonts** | Low · Requires combination with the above to establish recognition | Auxiliary |
| **Brand Persona Keywords** | Low · For agent self-check | Auxiliary |

**Translated into Execution Rules**:
- Only extract color values + fonts, but don't find logos / product images / UI → **Violates this protocol**
- Use CSS silhouettes/hand-drawn SVGs instead of real product images → **Violates this protocol** (generates "generic tech animations" where all brands look the same)
- Can't find assets but don't tell the user, nor AI generate, just force it → **Violates this protocol**
- Better to stop and ask the user for assets than to fill with generic content.

##### 5-Step Hard Process (Each step has a fallback, never silently skipped)

##### Step 1 · Ask (Ask for a complete asset list at once)

Don't just ask "Do you have brand guidelines?"—that's too broad, users won't know what to provide. Ask item by item according to the list:

```
Regarding <brand/product>, which of the following materials do you have? I've listed them by priority:
1. Logo (SVG / High-res PNG) — Essential for any brand
2. Product images / Official renders — Essential for physical products (e.g., DJI Pocket 4 product photos)
3. UI screenshots / Interface materials — Essential for digital products (e.g., main app page screenshots)
4. Color value list (HEX / RGB / Brand color palette)
5. Font list (Display / Body)
6. Brand guidelines PDF / Figma design system / Brand official website link

If you have them, send them directly to me. If not, I will search/grab/generate them.
```

##### Step 2 · Search Official Channels (By Asset Type)

| Asset | Search Path |
|---|---|
| **Logo** | `<brand>.com/brand` · `<brand>.com/press` · `<brand>.com/press-kit` · `brand.<brand>.com` · inline SVG in website header |
| **Product Image/Render** | `<brand>.com/<product>` product detail page hero image + gallery · official YouTube launch film screenshots · official press release images |
| **UI Screenshot** | App Store / Google Play product page screenshots · official website screenshots section · product official demo video screenshots |
| **Color Values** | Official website inline CSS / Tailwind config / brand guidelines PDF |
| **Fonts** | Official website `<link rel="stylesheet">` references · Google Fonts tracking · brand guidelines |

`WebSearch` Fallback Keywords:
- Logo not found → `<brand> logo download SVG`, `<brand> press kit`
- Product image not found → `<brand> <product> official renders`, `<brand> <product> product photography`
- UI not found → `<brand> app screenshots`, `<brand> dashboard UI`

##### Step 3 · Download Assets · Three Fallback Paths by Type

**3.1 Logo (Mandatory for any brand)**

> ⚠️ **Don't just try `curl <brand>.com/logo.svg` and give up**—most modern websites are SPAs, direct static paths usually return empty HTML shells (2026-06-06 tested Trae's website, 5 direct paths were all empty shells). **For digital products / SaaS / AI tools, prioritize icon aggregation sources**, they have the highest hit rate and directly output clean SVGs.

In decreasing order of success rate:
0. **Icon Aggregation Sources (Preferred for well-known digital products/SaaS/AI tools, highest hit rate)**:
   ```bash
   unset ALL_PROXY HTTP_PROXY HTTPS_PROXY all_proxy http_proxy https_proxy   # Clear proxy, otherwise TLS is prone to errors
   # svgl —— Most comprehensive coverage for AI/developer brands (Claude/Cursor/OpenAI/Copilot/Anthropic/Vercel…), includes light/dark + wordmark
   curl -s "https://api.svgl.app?search=<brand>"   # Returns JSON, get the svg URL from route(.light/.dark) then download
   # simpleicons —— Monochromatic glyphs, can be directly colored with brand colors
   curl -o logo.svg "https://cdn.simpleicons.org/<slug>/<hexcolor>"
   ```
1. Independent SVG/PNG files / Official brand page (e.g., `<brand>.com/brand`, `/press`):
   ```bash
   curl -A "Mozilla/5.0" -L -o assets/<brand>-brand/logo.svg "<official-logo-url>"
   ```
2. Extract inline SVG from full website HTML:
   ```bash
   curl -A "Mozilla/5.0" -L https://<brand>.com -o assets/<brand>-brand/homepage.html
   # Then grep <svg>...</svg> to extract the logo node
   ```
3. **Google favicon service (site's real mark fallback, almost never fails)**:
   ```bash
   curl -o logo.png "https://www.google.com/s2/favicons?domain=<brand-domain>&sz=256"   # 256px official site icon
   ```
4. Official social media avatar (last resort): Company avatars on GitHub/Twitter/LinkedIn are usually 400x400 or 800x800 transparent PNGs.

After downloading, **verify each one**: `file <logo>` to confirm it's a real SVG/PNG (not a 106-byte placeholder or empty HTML shell), `head -c 90 <logo.svg>` to check if it starts with `<svg`.

**3.2 Product Image/Render (Mandatory for physical products)**

By priority:
1. **Official product page hero image** (highest priority): Right-click to view image address / curl to get. Resolution is usually 2000px+.
2. **Official press kit**: `<brand>.com/press` often has high-res product images for download.
3. **Official launch video screenshots**: Use `yt-dlp` to download YouTube videos, ffmpeg to extract a few high-res frames.
4. **Wikimedia Commons**: Often has public domain images.
5. **AI generation fallback** (nano-banana-pro): Provide real product images as reference to AI, let it generate variations suitable for animation scenes. **Do not use CSS/SVG hand-drawing as a substitute.**

```bash
# Example: Download DJI official website product hero image
curl -A "Mozilla/5.0" -L "<hero-image-url>" -o assets/<brand>-brand/product-hero.png
```

**3.3 UI Screenshot (Mandatory for digital products)**

- App Store / Google Play product screenshots (Note: may be mockups rather than real UI, compare them)
- Official website screenshots section
- Product demo video screenshots
- Product's official Twitter/X release screenshots (often the latest version)
- If the user has an account, directly screenshot the real product interface.

**3.4 · Asset Quality Threshold '5-10-2-8' Principle (Iron Rule)**

> **The rules for logos are different from other assets.** If a logo exists, it must be used (if not, stop and ask the user); other assets (product images/UI/reference images/illustrations) follow the '5-10-2-8' quality threshold.
>
> 2026-04-20 Uncle Hua's original words: "Our principle is to search 5 rounds, find 10 assets, and select 2 good ones. Each must score 8/10 or higher. Better to have fewer than to use substandard assets just to complete the task."

| Dimension | Standard | Anti-Pattern |
|---|---|---|
| **5 Rounds of Search** | Cross-channel search (official website / press kit / official social media / YouTube screenshots / Wikimedia / user account screenshots), don't stop after grabbing the first 2 in one round | Directly use first page results |
| **10 Candidates** | Gather at least 10 candidates before starting to filter | Only grab 2, no choice |
| **Select 2 Good Ones** | Carefully select 2 from 10 as final assets | Use all = visual overload + taste dilution |
| **Each 8/10 Points or Higher** | If less than 8 points, **better not to use it**, use an honest placeholder (gray block + text label) or AI generation (nano-banana-pro based on official references) | Include 7-point assets in brand-spec.md |

**8/10 Scoring Dimensions** (record in `brand-spec.md` when scoring):

1.  **Resolution** · ≥2000px (≥3000px for print/large screen scenarios)
2.  **Copyright Clarity** · Official source > Public domain > Free assets > Suspected stolen images (suspected stolen images get 0 points directly)
3.  **Alignment with Brand Persona** · Consistent with "Brand Persona Keywords" in brand-spec.md
4.  **Lighting/Composition/Style Consistency** · The two assets don't clash when placed together
5.  **Independent Narrative Capability** · Can independently express a narrative role (not just decorative)

**Why this threshold is an iron rule**:
- Uncle Hua's philosophy: **Better to have less than to have something substandard.** Substandard assets are worse than no assets at all—they pollute visual taste and convey a "lack of professionalism" signal.
- **Quantified version of "do one detail 120%, others 80%"**: 8 points is the baseline for "others 80%", truly hero assets should be 9-10 points.
- When consumers view a work, every visual element is either **gaining or losing points**. A 7-point asset = a deduction, better to leave it blank.

**Logo Exception** (reiteration): If a logo exists, it must be used, the "5-10-2-8" rule does not apply. This is because a logo is not a "choose one of many" problem, but a "foundation of recognition" problem—even if the logo itself is only 6 points, it's 10 times better than no logo.

##### Step 4 · Verify + Extract (Not just grep color values)

| Asset | Verification Action |
|---|---|
| **Logo** | File exists + SVG/PNG can be opened + at least two versions (for dark/light backgrounds) + transparent background |
| **Product Image** | At least one 2000px+ resolution + transparent or clean background + multiple angles (main view, details, scene) |
| **UI Screenshot** | Actual resolution (1x / 2x) + is the latest version (not an old version) + no user data contamination |
| **Color Values** | `grep -hoE '#[0-9A-Fa-f]{6}' assets/<brand>-brand/*.{svg,html,css} \| sort \| uniq -c \| sort -rn \| head -20`, filter out black, white, gray |

**Beware of Demo Brand Contamination**: Product screenshots often contain the brand colors of user demos (e.g., a tool screenshot demonstrating Heytea Red), which are not the tool's own colors. **When two strong colors appear simultaneously, they must be differentiated.**

**Multi-faceted Brand Identity**: The official website marketing colors and product UI colors of the same brand are often different (Lovart's website is warm beige + orange, while its product UI is Charcoal + Lime). **Both sets are valid**—choose the appropriate facet based on the delivery scenario.

##### Step 5 · Solidify into `brand-spec.md` file (Template must cover all assets)

```markdown
# <Brand> · Brand Spec
> Collection Date: YYYY-MM-DD
> Asset Sources: <List download sources>
> Asset Completeness: <Complete / Partial / Inferred>

## 🎯 Core Assets (First-Class Citizens)

### Logo
- Main Version: `assets/<brand>-brand/logo.svg`
- Light Background Inverted Version: `assets/<brand>-brand/logo-white.svg`
- Usage Scenarios: <Intro/Outro/Corner Watermark/Global>
- Forbidden Transformations: <Cannot stretch/change color/add stroke>

### Product Images (Mandatory for physical products)
- Main View: `assets/<brand>-brand/product-hero.png` (2000×1500)
- Detail Images: `assets/<brand>-brand/product-detail-1.png` / `product-detail-2.png`
- Scene Image: `assets/<brand>-brand/product-scene.png`
- Usage Scenarios: <Close-up/Rotation/Comparison>

### UI Screenshots (Mandatory for digital products)
- Homepage: `assets/<brand>-brand/ui-home.png`
- Core Feature: `assets/<brand>-brand/ui-feature-<name>.png`
- Usage Scenarios: <Product display/Dashboard fade-in/Comparison demo>

## 🎨 Auxiliary Assets

### Color Palette
- Primary: #XXXXXX  <Source Annotation>
- Background: #XXXXXX
- Ink: #XXXXXX
- Accent: #XXXXXX
- Forbidden Colors: <Color schemes explicitly not used by the brand>

### Typography
- Display: <font stack>
- Body: <font stack>
- Mono (for data HUD): <font stack>

### Signature Details
- <Which details are "done 120%">

### No-Go Zones
- <Explicitly forbidden actions: e.g., Lovart doesn't use blue, Stripe doesn't use low-saturation warm colors>

### Brand Persona Keywords
- <3-5 adjectives>
```

**Execution Discipline after writing the spec (Hard Requirement)**:
- All HTML must **reference** the asset file paths in `brand-spec.md`, not use CSS silhouettes/hand-drawn SVGs as substitutes.
- Logo should be referenced as an `<img>` to the real file, not redrawn.
- Product images should be referenced as `<img>` to the real file, not replaced by CSS silhouettes.
- CSS variables should be injected from the spec: `:root { --brand-primary: ...; }`, HTML only uses `var(--brand-*)`.
- This transforms brand consistency from "relying on self-awareness" to "relying on structure"—to temporarily add a color, the spec must be changed first.

##### Fallback for Full Process Failure

Handle separately by asset type:

| Missing | Handling |
|---|---|
| **Logo completely missing** | **Stop and ask the user**, do not force it (logo is the foundation of brand recognition) |
| **Product image (physical product) missing** | Prioritize nano-banana-pro AI generation (based on official reference images) → Second option is to ask the user → Last resort is an honest placeholder (gray block + text label, clearly marked "Product image to be added") |
| **UI screenshot (digital product) missing** | Ask the user for screenshots from their own account → Official demo video screenshots. Do not cobble together with mockup generators. |
| **Color values completely missing** | Follow the "Design Direction Consultant Mode", recommend 3 directions to the user and annotate assumptions |

**Forbidden**: Silently using CSS silhouettes/generic gradients to force it when assets are not found—this is the biggest anti-pattern of this protocol. **Better to stop and ask than to cobble together.**

##### Anti-Patterns (Real pitfalls encountered)

-   **Kimi Animation**: Guessed "it should be orange" from memory, but Kimi is actually `#1783FF` blue—had to redo it.
-   **Lovart Design**: Mistook the Heytea Red of a demo brand in a product screenshot for Lovart's own color—almost ruined the entire design.
-   **DJI Pocket 4 Launch Animation (2026-04-20, real case that triggered this protocol upgrade)**: Followed the old protocol that only extracted colors, didn't download the DJI logo, didn't find Pocket 4 product images, and used CSS silhouettes instead of products—resulted in a "generic black background + orange accent tech animation" that lacked DJI recognition. Uncle Hua's original words: "Otherwise, what are we expressing?" → Protocol upgraded.
-   After extracting colors, didn't write them into brand-spec.md, forgot the main color value by the third page, and added a "close but not quite" hex on the fly—brand consistency collapsed.
-   **Comparison PPT of Five Coding Agents (2026-06-06, real case that triggered trigger condition expansion)**: The agent misjudged the task as "PPT + no style reference" and went with the Fallback Design Direction Consultant, only extracted the brand colors of five companies and spawned three design logics, **didn't retrieve a single logo for the five products (Claude Code / Cursor / Codex / Copilot / Trae)**—caught red-handed by Uncle Hua: "Why didn't we retrieve the logos for these products?" Root cause: Misjudged "comparison / ranking decks" as not triggering §1.a (thinking §1.a only applied to "creating materials for a single client"), and there was no logo checkpoint in the Fallback path. → Fix: ① Trigger conditions expanded to two categories (including "named/listed real products in the design") ② Fallback does not exempt logo retrieval ③ Phase 3.5 added a "named product logo sub-gate" that must be passed before spawning ④ Supplemented reliable image retrieval links for svgl/simpleicons/Google favicon.

##### Protocol Cost vs. Cost of Not Doing

| Scenario | Time |
|---|---|
| Correctly follow protocol | Download logo 5 min + download 3-5 product images/UI 10 min + grep color values 5 min + write spec 10 min = **30 minutes** |
| Cost of not following protocol | Produce generic animation lacking recognition → User rework 1-2 hours, or even complete redo |

**This is the cheapest investment for stability.** Especially for commercial orders/launch events/important client projects, 30 minutes on the asset protocol is life-saving money.