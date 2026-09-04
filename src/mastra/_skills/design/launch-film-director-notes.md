# Launch Film Workflow: Write a Ten-Thousand-Word Director's Notes First, Then Animate

> Standard workflow for high-spec visual productions (≥ 20 seconds, including brand narrative, slogan reveal, potentially promoted on X / official accounts / Bilibili).
>
> Trigger conditions: The task is "product upgrade promo / brand launch film / launch trailer / Super Bowl-tier ad / brand campaign / hero animation video," and the **user has clear quality expectations** (e.g., "Super Bowl quality," "10x detail," "Apple-level").
>
> Anti-trigger: Do not use this process for "quickly make an animation demo," "simple motion graphic," or "single icon animation"—it will be over-engineered.

---

## 1. Why Write Director's Notes First

Lessons learned from practice (2026-05-11 huashu-md-html v2.0 project):

The first round involved directly writing HTML, resulting in "programmer-perspective animation"—each capability given average effort, uniform rhythm, slogans clashing, and lacking a narrative arc.
In the second round, after receiving the user's instruction to "stop, first write a 10,000-word storyboard from an Apple director's perspective," v5-director-notes.md was written (11,500 words, 13 shot-by-shot specs). Implementing based on this script led to a first-pass approval, every pause frame being visually appealing, and a rhythm with a climax.

**Core difference**: Writing the script is thinking; writing HTML is executing. If you think it through thoroughly first, execution becomes mechanical translation. If you execute first, every shot is an on-the-spot decision, which inevitably leads to chaos.

Writing director's notes is not "showing off"; it's about documenting all visual decisions **before starting work**—every shot has been visualized, reasoned, and traced with its context in mind. During HTML implementation, there's no need for further creative decisions, only faithful translation.

---

## 2. Trigger Judgment (Ask Yourself 3 Questions First)

Before starting the launch film workflow, ask:

1.  **Does this film carry a brand narrative?** (Does it have a thesis / slogan reveal / sense of upgrade ceremony?) — Yes → Follow the director's notes process.
2.  **Will the audience pause to watch?** (Might they take screenshots, create X posters, make covers, or review in slow motion?) — Yes → Every frame must be visually appealing.
3.  **Does the client/user have a reference like "I want it to be like XXX"?** (Apple / Anthropic / Nike / Penguin / a specific director?) — Yes → The visual context must be clearly defined.

If any answer is "Yes," proceed with the workflow. If all three are "No," skip this and use the standard process from [animations.md](animations.md).

---

## 3. The 5 Major Sections of Director's Notes

A ten-thousand-word (10,000-12,000 Chinese characters / equivalent English) director's notes must include these 5 major sections. **The absence of any section means it's incomplete, and quality will be affected.**

### Part I · Director's Statement (Creative Philosophy, approx. 1500-2000 words)

Answers 5 questions:

1.  **What is this film NOT?** (Explicitly exclude—e.g., "This is not a feature introduction video," "This is not a demo.")
2.  **Core thesis in one line**—What is the single sentence the audience remembers after watching?
3.  **Whose context is it conversing with?**—List 5-8 visual references (director / designer / brand / photographer / work title + year), explaining what was learned from each.
4.  **Three audience personas + commitment to each**: Primary audience / Secondary audience / External audience, with a paragraph for each.
5.  **Rhythm philosophy**—Explanation of the slow / acceleration / peak / gentle decline curve + at which second the emotional climax occurs (**not necessarily the last second**).

Finally, add an anti-slop checklist: **Things this film will NOT do** (list specifically, no ambiguity).

### Part II · Visual System (Full Visual Specification, approx. 1500-2500 words)

This is the engineered visual spec. Once complete, any executor can produce consistent visuals.

Must include subsections:

-   **Complete Color Palette**: At least 8-10 colors, each with HEX + functional definition + maximum screen proportion.
-   **Typography System**: At least 6 font size levels, each with font name + weight + size + letter-spacing + usage.
-   **Grid System**: Canvas size + outer margins + column grid + baseline grid + key safe areas + golden ratio anchor points.
-   **Animation System**: Easing library (max 4 curves) + duration dictionary + stagger rules + scene transition rules.
-   **Chrome Elements**: Small details that run throughout the film (counter / chip / ticker / watermark / texture), each with position + entry/exit timing.
-   **Audio System**: BGM 30-second progression curve (layered) + SFX dictionary (10+ cues including timecode + volume + frequency isolation).
-   **Anti-AI Slop Checklist**: Per-shot self-check list (10-15 items).

Iron rule: **All visual decisions are derived from the Visual System; do not invent new values on the fly in the shot list.**

### Part III · Story Arc (approx. 500-800 words)

Three-act structure + emotional curve:

-   **Act I · SETUP** (0 → 1/5 duration, e.g., 0-6s for 30s): Audience enters, problem is introduced.
-   **Act II · ESCALATION** (middle 2/3): Solution unfolds, theme develops.
-   **Act III · PAYOFF** (last 1/4): Climax, slogan reveal, brand imprint.

Includes ASCII emotional curve diagram + emotional climax timestamp.

**Key decision**: The climax is not necessarily at the end. For a 30s film, the climax is usually at 22-25s (not 29s)—the last few seconds are resolution / decay, not the peak. Violating this rule will inevitably make the work "start strong, finish weak."

### Part IV · Shot-by-Shot Storyboard (approx. 5000-7000 words · 60% of total length)

Each shot must include 10 fields (none can be missing):

```
SHOT NN · NAME
[TIMECODE]    Start/end time + duration
[FUNCTION]    Function of this shot in the story arc (one sentence)
[VISUAL]      Composition + element positions + movement direction
[TYPE]        Typography spec (font / size / letter-spacing / line-height / color / alignment)
[ANIM]        In/out timing of each element + easing + duration + stagger + delay
[AUDIO]       Music beat + SFX cue (each shot corresponds to BGM rhythm + must include SFX time table)
[CHROME]      State of corner elements (which chrome elements are present / which fade in/out / which pulse)
[ANTI-SLOP]   Which self-check items this shot passed + what 120% detail signatures it has
[WHY]         Logic connecting to the previous shot + hook for the next shot
```

**Average 30-80 words per field → 400-700 words per shot → 12-15 shots → 5000-7000 words.**

Practical experience: After writing the storyboard, **read it yourself**—if any shot is removed, does the entire film still hold together? If it can be removed, that shot is redundant; delete it.

### Part V · Production Manifest (approx. 800-1200 words)

Engineering delivery checklist:

-   Font loading URL (including preconnect)
-   CSS variables (directly pasteable)
-   BGM source selection criteria + Suno/Udio prompt keywords + backup library
-   SFX dictionary (list file paths + volume for each cue by timecode)
-   **Keyframe validation plan**: 12-15 pause-and-check keyframe timecodes, with validation items listed for each frame (fonts / positions / chrome state).
-   Recording parameters (fps / codec / bitrate / preset)
-   ffmpeg audio mixing command (including audio stream validation)
-   Deliverables list (mp4 / mp4-60fps / gif / poster.png / silent.mp4 / shot-list.csv)
-   End-to-end time estimate (hour-level precision)

---

## 4. 5 Tips for Writing Director's Notes

**4.1 Use a director's voice, not a PM's voice.**

❌ "This shot displays the product features."
✅ "This is the hero shot — if the audience pauses anywhere, I want it to be here."

Director's notes are for the executor, but also for your future self. First-person + judgment expressions leave more decision clues than descriptive expressions.

**4.2 Cite specific works (including year), not just genres.**

❌ "Apple-inspired"
✅ "Apple 'Designed by Apple in California' (2013, dir. Mark Romanek) — learning from its slow pace + serif fonts + large white backgrounds."

Benefits of citing specific works: (a) Any audience can look it up online for comparison. (b) You force yourself to clarify what specific techniques you're learning. (c) Prevents "vague inspiration."

**4.3 Trace every decision back to a first principle.**

The entire film has one first principle (e.g., "Markdown is the new typewriter."). Every specific decision—color scheme / font / rhythm / chrome—must be traceable back to this statement.

Decisions that cannot be traced back are decorative; delete them.

**4.4 Writing anti-slop is more important than writing "do-this."**

The "Things this film will NOT do" checklist (purple gradients / emojis / Lorem ipsum / Inter display / SVG character illustrations / rounded cards + left border accent) protects quality more effectively than the "Things this film WILL do" checklist.

Positive decisions are infinite, but negative checklists are finite—yet violating a negative checklist immediately results in slop.

**4.5 Don't implement immediately after writing—read it again after 30 minutes.**

While writing, your brain is in "production mode" and might miss inconsistencies. Reading your own storyboard after 30 minutes will reveal:
-   Two shots have redundant functions (delete one).
-   A shot has too large a narrative jump (add a transition).
-   The emotional climax is misplaced (move it).
-   Chrome elements don't match the number of shots (realign).

These 30 minutes save 2 hours of rework later.

---

## 5. Director's Notes → HTML Implementation Process

After writing the director's notes, the HTML implementation steps are:

1.  **Reuse starter components** (`assets/animations.jsx`'s Stage/Sprite/Easing/interpolate) — do not reinvent.
2.  **Paste CSS variables directly from Visual System Part II** — do not change colors temporarily in HTML.
3.  **Match Sprite start/end timeline against Part IV timecodes** — do not add shots arbitrarily.
4.  **Extract chrome elements into independent components** (ChromeA/B/C/D), driven by `useTime()`.
5.  **Destination card content must be real and readable** (not fake bar lines) — this was the most frequently mentioned 120% detail signature in the v5 project.
6.  **Immediately capture keyframes for validation after writing each shot** (using `?t=NN` URL parameter + Playwright), do not wait until the entire film is written.

---

## 6. Keyframe Validation Process

URL parameter implementation (must be added to the Stage component):

```js
const urlMatch = window.location.search.match(/[?&]t=([\d.]+)/);
const frozenTime = urlMatch ? parseFloat(urlMatch[1]) : null;
const [time, setTime] = useState(frozenTime != null ? frozenTime : 0);
const [playing, setPlaying] = useState(frozenTime == null);
```

→ This way, `file:///path/animation.html?t=14.5` directly freezes at 14.5 seconds.

Batch screenshotting:

```bash
for t in 0.5 2.5 4.9 7.0 10.5 13.5 16.5 19.0 21.5 23.4 25.5 28.0 29.9; do
  npx -y playwright screenshot \
    "file://$PWD/animation.html?t=$t" \
    "keyframes/t-$t.png" \
    --viewport-size=1920,1136 \
    --wait-for-timeout=2500
done
```

Each screenshot must validate:
-   [ ] Elements do not overflow the 1920×1080 canvas.
-   [ ] Letter-spacing, line-height are visually correct (not too tight, not too loose).
-   [ ] Key typography details (period color / em-dash / italic / small caps) are discernible.
-   [ ] Chrome element positions + states are correct.
-   [ ] Anti-AI slop checklist passed.
-   [ ] The "worth a closer look when paused" 120% details are present.

---

## 7. Multi-Perspective Parallel Strategy (Advanced)

For complex projects (e.g., launch film where direction is unclear / wanting to see multiple aesthetic differences / client hasn't finalized style), you can **launch multiple subagents to work in parallel on different director's perspective versions.**

Practical configuration (2026-05-11 huashu-md-html project, 6 versions in parallel):

```
v5  · Baseline (Anthropic / Penguin Classics publisher taste)
v5a · Wes Anderson (Symmetry + retro + chapter cards)
v5b · Saul Bass (Paper cutouts + 60s large type + geometric cuts)
v5c · Wong Kar-wai (Chinese serif + slow motion + nostalgia)
v5d · Massimo Vignelli (Modernist grid + red and black)
v5e · Kenya Hara (Minimalist Japanese + whitespace)
v5f · Yayoi Kusama (Polka dots + repetition + single strong color)
```

Each subagent receives an independent brief:
-   Project background (same document)
-   Required references (same v5-director-notes.md as a methodology template)
-   **Assigned artist DNA** (color palette / typography / visual language / rhythm / signature elements / enhanced anti-slop version, 30-50 words each)
-   Unified task list (director-notes.md + animation.html + keyframes/ + README.md)
-   Unified constraints (30s / 1920×1080 / file:// / Google Fonts)

Launch in parallel + run in the background, approximately 30-60 minutes to produce 6 complete versions.

After completion, review and compare:
1.  Core aesthetic decision table for each version.
2.  Keyframe side-by-side comparison (one frame at the same timestamp for each version).
3.  Vote: Which best aligns with the user's true needs?

**Key**: Do not let subagents reference each other—they must produce independently, otherwise they will converge to an "average." The instructions for each subagent should explicitly state, "Do not repeat the aesthetics of v5."

---

## 8. Typical Trigger Scenarios

| User Scenario | Triggered? | Notes |
| :------------ | :--------- | :---- |
| "Make a SaaS upgrade promo" | ✅ Triggered | Default to full process |
| "Apple-level / Super Bowl-tier quality video" | ✅ Triggered + Upgrade | Strongly recommend multi-perspective parallel |
| "30-second brand launch film" | ✅ Triggered | |
| "This project needs a 10,000-word script before animation" | ✅ Triggered | User explicitly specified |
| "Simple motion graphic, just animate the logo" | ❌ Not triggered | Use animations.md standard process |
| "Make an onboarding animation demo" | ❌ Not triggered | Use animations.md |
| "Tutorial video with voiceover" | ❌ Not triggered | Follow voiceover-pipeline.md |
| "Single hero animation" | ⚠️ Depends on complexity | If it's a high-spec hero, triggered; for a regular hero, use hero-animation-case-study.md |

---

## 9. Reference Samples

Complete director's notes reference sample (self-contained, within this skill):

`assets/director-notes-samples/launch-film-30s-sample.md` (approx. 78KB · 11,500 words · 13 shots · all 5 major sections complete)

Original project location (including corresponding implemented HTML + keyframes):

-   v5-director-notes.md (director's notes, author's local, not distributed with repository)
-   v5-six-forms.html (HTML implementation, author's local, not distributed with repository)
-   v5-keyframes/ (keyframe validation screenshots, author's local, not distributed with repository)

When starting a new project, it is strongly recommended to **Read this sample first** to understand the workload and detail density before deciding whether to follow the full process.

---

## 10. Anti-Patterns (Do Not Do This)

❌ **Write a condensed 1000-word director's notes and then start working.**
→ A condensed version will inevitably miss some sub-items of the Visual System, leading to constant backtracking to fill in specs during HTML implementation. Either do the full ten-thousand-word version, or skip it entirely.

❌ **Storyboard only 5-8 shots.**
→ A 30-second film needs at least 12-15 shots (2-3 seconds per shot). Fewer shots = uniform rhythm = no climax.

❌ **Deliver director's notes without implementation.**
→ The document is not the deliverable; the animation is. Deliver the document + animation together, with the document as an appendix for "design rationale."

❌ **Let subagents see other versions during multi-perspective parallel work.**
→ Each subagent must be independent, otherwise they will converge. Compare only during the review stage.

❌ **Skip keyframe validation and directly record MP4.**
→ This will inevitably lead to rework. Keyframe validation is the cheapest quality gate.

❌ **Postpone animation detail decisions to "I'll figure it out when I record."**
→ The recording phase is mechanical execution; no creative decisions should be made. All decisions must be locked down in the director's notes.

---

*Last Revised: 2026-05-11*
*Real Case: huashu-md-html v2.0 launch film (v5-director-notes.md)*