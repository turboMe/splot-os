# Design Context: Starting from Existing Context

**This is the most important one thing for this skill.**

Good hi-fi design always grows out of an existing design context. **Designing hi-fi from scratch is a last resort and will inevitably produce generic work.** So, every time a design task begins, first ask: Is there anything I can reference?

## What is Design Context

In order of priority from high to low:

### 1. User's Design System/UI Kit
The user's own product's existing component library, color tokens, typography guidelines, and icon system. **The most ideal situation.**

### 2. User's Codebase
If the user provides a codebase, it contains live component implementations. Read those component files:
- `theme.ts` / `colors.ts` / `tokens.css` / `_variables.scss`
- Specific components (Button.tsx, Card.tsx)
- Layout scaffold (App.tsx, MainLayout.tsx)
- Global stylesheets

**Read the code and copy exact values**: hex codes, spacing scale, font stack, border radius. Do not redraw from memory.

### 3. User's Published Product
If the user has a live product but hasn't provided code, use Playwright or ask the user for screenshots.

```bash
# Use Playwright to screenshot a public URL
npx playwright screenshot https://example.com screenshot.png --viewport-size=1920,1080
```

This lets you see the real visual vocabulary.

### 4. Brand Guidelines/Logo/Existing Assets
The user might have: Logo files, brand color specifications, marketing materials, slide templates. These are all context.

### 5. Competitor References
If the user says "like XX website" – ask them to provide the URL or screenshots. **Do not** rely on vague impressions from your training data.

### 6. Known Design Systems (fallback)
If none of the above are available, use a recognized design system as a base:
- Apple HIG
- Material Design 3
- Radix Colors (color palette)
- shadcn/ui (components)
- Tailwind default palette

Clearly tell the user what you are using, so they know it's a starting point, not a final design.

## Getting Context Flow

### Step 1: Ask the User

Mandatory checklist at the start of a task (from `workflow.md`):

```markdown
1. Do you have an existing design system/UI kit/component library? Where is it?
2. Do you have brand guidelines, color/font specifications?
3. Can you provide screenshots or a URL of your existing product?
4. Do you have a codebase I can read?
```

### Step 2: If the User Says "No," Help Them Find It

Don't give up immediately. Try:

```markdown
Let me see if there are any clues:
- Do your previous projects have related designs?
- What colors/fonts does the company's marketing website use?
- What style is your product's logo? Can you give me an image?
- Are there any products you admire that could serve as a reference?
```

### Step 3: Read All Available Context

If the user provides a codebase path, you should read:
1. **First, list the file structure**: Look for style/theme/component-related files.
2. **Read theme/token files**: Extract specific hex/px values.
3. **Read 2-3 representative components**: Observe the visual vocabulary (hover state, shadow, border, padding node pattern).
4. **Read global stylesheet**: Base resets, font loading.
5. **If there's a Figma link/screenshot**: Look at the image, but **trust the code more**.

**Important**: **Do not** just glance and then design from impression. You've truly extracted context only when you've lifted 30+ specific values.

### Step 4: Vocalize the System You Plan to Use

After reviewing the context, tell the user the system you plan to use:

```markdown
Based on your codebase and product screenshots, I've extracted the following design system:

**Colors**
- Primary: #C27558 (from tokens.css)
- Background: #FDF9F0
- Text: #1A1A1A
- Muted: #6B6B6B

**Typography**
- Display: Instrument Serif (from @font-face in global.css)
- Body: Geist Sans
- Mono: JetBrains Mono

**Spacing** (from your scale system)
- 4, 8, 12, 16, 24, 32, 48, 64

**Shadow pattern**
- `0 1px 2px rgba(0,0,0,0.04)` (subtle card)
- `0 10px 40px rgba(0,0,0,0.1)` (elevated modal)

**Border-radius**
- Small components 4px, cards 12px, buttons 8px

**Component vocabulary**
- Button: filled primary, outlined secondary, ghost tertiary, all with 8px border-radius
- Card: white background, subtle shadow, no border

I will start designing according to this system. Is this okay?
```

Only proceed after the user confirms.

## Designing from Scratch (Fallback when no Context)

**Strong warning**: The quality of output in this situation will significantly decrease. Clearly inform the user.

```markdown
You don't have design context, so I can only base this on general intuition.
The output will be something that "looks okay but lacks uniqueness."
Do you wish to proceed, or would you prefer to provide some reference materials first?
```

If the user insists you proceed, make decisions in this order:

### 1. Choose an Aesthetic Direction
Don't produce generic results. Pick a clear direction:
- brutally minimal
- editorial/magazine
- brutalist/raw
- organic/natural
- luxury/refined
- playful/toy
- retro-futuristic
- soft/pastel

Tell the user which one you've chosen.

### 2. Choose a Known Design System as a Skeleton
- Use Radix Colors for the color palette (https://www.radix-ui.com/colors)
- Use shadcn/ui for component vocabulary (https://ui.shadcn.com)
- Use Tailwind spacing scale (multiples of 4)

### 3. Choose Distinctive Font Pairings

Avoid Inter/Roboto. Suggested combinations (free from Google Fonts):
- Instrument Serif + Geist Sans
- Cormorant Garamond + Inter Tight
- Bricolage Grotesque + Söhne (paid)
- Fraunces + Work Sans (note Fraunces is overused by AI)
- JetBrains Mono + Geist Sans (technical feel)

### 4. Provide Reasoning for Every Key Decision

Don't make choices silently. Write them in HTML comments:

```html
<!--
Design decisions:
- Primary color: warm terracotta (oklch 0.65 0.18 25) — fits the "editorial" direction  
- Display: Instrument Serif for humanist, literary feel
- Body: Geist Sans for cleanness contrast
- No gradients — committed to minimal, no AI slop
- Spacing: 8px base, golden ratio friendly (8/13/21/34)
-->
```

## Import Strategy (User provides codebase)

If the user says "import this codebase for reference":

### Small (<50 files)
Read everything and internalize the context.

### Medium (50-500 files)
Focus on:
- `src/components/` or `components/`
- All styles/tokens/theme-related files
- 2-3 representative full-page components (Home.tsx, Dashboard.tsx)

### Large (>500 files)
Ask the user to specify the focus:
- "I need to build the settings page" → Read existing settings-related files
- "I need to build a new feature" → Read the overall shell + the closest reference
- Don't aim for completeness, aim for accuracy.

## Cooperation with Figma/Design Drafts

If the user provides a Figma link:

- **Do not** expect to directly "convert Figma to HTML" – that requires additional tools.
- Figma links are usually not publicly accessible.
- Ask the user to: export as **screenshots** and send them to you + tell you the specific color/spacing values.

If only Figma screenshots are provided, tell the user:
- I can see the visuals, but I cannot extract precise values.
- Please tell me the key numbers (hex, px), or export as code (Figma supports this).

## Final Reminder

**The maximum design quality of a project is determined by the quality of the context you receive.**

Spending 10 minutes collecting context is more valuable than spending 1 hour designing hi-fi from scratch.

**When encountering situations with no context, prioritize asking the user for it rather than forcing a design.**