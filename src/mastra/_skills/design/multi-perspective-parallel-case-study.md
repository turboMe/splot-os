# Multi-Perspective Parallel Experiment · Case Study

> huashu-md-html v2.0 launch film project · 2026-05-11
> Parallel director's notes + HTML + keyframe experiment from 6 artist perspectives

---

## Background

When the user requested "to create a 30-second upgrade promotional video for huashu-md-html v2.0," the main thread first produced the v5 baseline (Anthropic / Penguin Classics publisher aesthetic). However, the user felt it could be better and gave a critical instruction:

> "Call different subagents to generate 6 completely different versions of expression and visual design. You can try enabling different directors and artists. Then, after all are complete, review and evaluate them."

This was the first systematic "multi-perspective parallel director's notes" experiment, validating a reusable workflow.

---

## Logic for Choosing 6 Perspectives

Don't just pick any 6 designers—they must have **extremely high visual differentiation** to avoid convergence.

The 6 perspectives finally chosen (including reasons for selection):

| Perspective | Genre | Aesthetic Anchor | Difference from other perspectives |
|-------------|--------------------|----------------------------------------------------------------|------------------------------------|
| **v5 Baseline** | Modern Publisher | Anthropic Terracotta Orange + Penguin Classics Serif + Vignelli grid | Safe "tasteful" choice |
| **v5a Wes Anderson** | Cinematic Chapter Aesthetic | The French Dispatch magazine feel + 1960 Olivetti industrial catalog | Symmetrical composition + chapter cards + decorative borders |
| **v5b Saul Bass** | 60s Film Title Art | cut-paper + Trajan caps + flowing geometry | Cut-paper silhouette + large type + strong diagonals |
| **v5c Wong Kar-wai** | Hong Kong New Wave | *In the Mood for Love*, *2046* letterboxing + Chinese serif | Slow pace + hazy glow + Chinese-centric |
| **v5d Massimo Vignelli** | 1970 Modernism | Knoll identity manual + NYC Subway map | Strict grid + 3-color rule + rejection of ornamentation |
| **v5e Kenya Hara** | Minimalist Japanese | MUJI posters + *White* | Philosophy of negative space + no chrome + *ma* interval |
| **v5f Yayoi Kusama** | Installation Art | Infinity Mirror Rooms + Polka Dot Obsession | Obsessive repetition + single strong color + polka dots |

**Selection Principles**:
1. **3 different geographical cultures** (Western cinema / Japanese design / Hong Kong Chinese)
2. **3 different eras** (1960s / 1970s / 2010s+)
3. **3 different mediums** (Film / Graphic Design / Installation Art)
4. **Each has a visual signature "completely opposite to the generic SaaS aesthetic in the training corpus"**

---

## Implementation Process

### Step 1 · Write an independent brief for each perspective (approx. 15 minutes)

Each brief contains 8 fixed fields:

```
1. Project Background (same for all)
2. Required References (same v5-director-notes.md as methodology template)
3. Your Task (4-item delivery checklist)
4. Artist DNA (6 core fields):
   - Color Palette (specific HEX)
   - Fonts (specific names + alternatives)
   - Visual Language (key principles)
   - Signature Elements (identifiable signatures)
   - Rhythm (distinguishing from other perspectives)
   - Enhanced Anti-AI Slop (forbidden zones within this style context)
5. 30-second Structure Reference (4-6 shot draft)
6. Destination Cards Design Requirements (maintain real readability)
7. Key Constraints (30s / 1920×1080 / file:// / Google Fonts CDN)
8. Output Verification Checklist + Completion Report Format
```

**Key**: Each brief must emphasize "**do not repeat the v5 aesthetic**" – otherwise, subagents will be influenced by the v5 director-notes and converge.

### Step 2 · Launch 6 subagents in parallel (6 Agent tool calls in the same message)

```js
Agent({ subagent_type: "general-purpose", run_in_background: true, name: "v5a-anderson", ... })
Agent({ subagent_type: "general-purpose", run_in_background: true, name: "v5b-bass", ... })
// ... 6 agents
```

Run in the background, expected 30-60 minutes.

### Step 3 · Idle work during waiting period

Do not poll agent status. Subagents will automatically send task-notifications upon completion. During the wait, do:

- Fix bugs in the main thread's v5 baseline
- Write a review framework (dimensions for scoring each version / Q&A)
- Consolidate methodology into a skill (this is the source of this case study)
- Prepare the skeleton for the final summary document

### Step 4 · Failure handling (approx. 16% failure rate, acceptable)

Observed in practice: about 1 out of 6 subagents would fail due to network issues or token limits (Bass's first round had a socket error). Handling:

1. **Immediately check** the agent's output folder upon receiving a completion notification
2. Missing key deliverables → Restart the agent (with the same brief, can add "failed last time, please re-execute")
3. Partially complete (e.g., HTML but no screenshot) → Main thread supplements Playwright screenshots, do not restart the agent

### Step 5 · System review after 6 versions are complete

Review framework (5 dimensions + 3 top-level questions + use case allocation):

```
5-dimension scoring (1-10 for each dimension):
- Distinctiveness (visual differentiation)
- Coherence (aesthetic consistency)
- Anti-slop (execution of anti-AI slop)
- Story arc (rhythm and narrative arc)
- Pause-and-look (detail density)

3 top-level questions:
- Q1 Shareable screenshot? (Can trigger a pause on social media)
- Q2 Memorable phrase? (Can leave a proposition-level memory)
- Q3 Timeless? (Doesn't look cheap 5 years later)

Use case allocation (by platform and audience):
- WeChat Official Account / X / Bilibili / WeChat Moments / Dribbble / Client Presentation / Private Domain / ...
```

See REVIEW.md in the same directory as `assets/director-notes-samples/launch-film-30s-sample.md` for details.

---

## Experimental Output (Facts)

### Document Volume

- v5 Baseline director-notes: 11,500 words
- 6 perspective director-notes: 4,000-12,000 words each
- Total document volume: approx. 55,000-70,000 words
- 5 major structural parts complete: 6/6 versions

### HTML Implementation

- Each version has an independent animation.html, 30 seconds, 1920×1080
- File size 28-74KB
- All can be opened via file:// (no server dependency)

### Keyframes

- Each version has 10-18 PNGs, covering the complete 30-second story arc
- Total screenshots: 80+ images
- Average PNG size: 100-200KB

### Duration

- 6 subagents running in parallel: approx. 12-15 minutes (as shown by duration_ms)
- Main thread parallel idle work (fixing v5 + writing methodology): completed concurrently
- Overall "from launching 6 perspectives to all deliverables in place": approx. 60 minutes

---

## Key Insights (for future huashu-design users)

### Insight 1 · The "first write ten thousand words of director's notes" methodology is **completely reproducible**

All 6 subagents produced complete specs of 4,000-12,000 words, structured into 5 major parts, and implemented HTML to marketing-ready quality. This proves that the methodology itself does not rely on the talent of a single executor—**as long as the brief is clear, multiple independent executors can produce consistent high-quality results**.

### Insight 2 · "Perspective" must be specific to "work + year"

Each brief listed specific works for dialogue:
- Anderson → *The French Dispatch* (2021) + *Moonrise Kingdom* (2012) + Penguin Classics dust jackets + 1960s Olivetti catalogues
- WKW → *In the Mood for Love* (2000) + *2046* (2004)
- Vignelli → 1972 NYC Subway map + Knoll identity manual + *The Vignelli Canon*
- Hara → MUJI brand 1995-2023 + *White* + Junya Ishigami transparency
- Kusama → Infinity Mirrored Rooms (2013-2023) + Polka Dot Obsession installations

**Practical result**: All subagents accurately captured the core visual DNA of the specific work, rather than the "average" of the genre.

### Insight 3 · The "style-reinforced version" of anti-AI slop is crucial

General anti-slop (purple gradients / emojis / SVG characters) applies to all versions. But **each style also needed "exclusive anti-slop"**:

- Bass: No Helvetica (too clean, Bass is raw)
- Vignelli: No rounded corners (all corners 90°)
- Hara: No gradients + No sans display
- Kusama: No modern SaaS look
- Anderson: No cyber color schemes
- WKW: No Inter (WKW uses serif)

With these additions, the 6 versions maintained extremely high style purity, with no convergence among them.

### Insight 4 · The true value of multi-perspective is not "choosing a winner"

The initial idea was an A/B test to select the best version. During actual review, it was found that: **each of the 6 versions had clear use cases**:
- v5 Baseline → Product page / WeChat Reading (high information density)
- Anderson → WeChat Official Account long-form header image (strong magazine feel)
- WKW → Bilibili / Chinese cultural content (nostalgic warmth)
- Vignelli → Design community / Dribbble (each frame is a print poster)
- Hara → Client presentation / Static screenshots (minimalist philosophy)
- Kusama → X short video / Viral spread (visual impact)

**Conclusion**: Marketing is not single-shot, it's platform-specific multiplex. The true value of 6-perspective parallelism is **giving a project 6 differentiated weapons**, not making 5 versions unusable.

### Insight 5 · Subagent failure rate of ~16% is acceptable

1 out of 6 failed (Bass's first round socket error). Cost of handling: restart + 5-minute simplified brief, then wait another 12-15 minutes. **Compared to vs. waiting for 1 agent to run 6 versions sequentially (90+ minutes)**—parallel + retry is clearly more economical.

### Insight 6 · The main thread must do substantive idle work during waiting periods

Subagents take 12-15 minutes to complete. The main thread should absolutely not be idle during this time:

- **Fix main version bugs** (already reported by users)
- **Write review framework** (to be filled during review)
- **Consolidate methodology into a skill** (like this case study)
- **Prepare final summary** (clear at a glance for the user)

This is the "main thread's responsibility" in a parallel multi-agent workflow—not a PM waiting for results, but an orchestrator driving progress concurrently.

---

## When to Enable "Multi-Perspective Parallel"

| Scenario | Enable? | Reason |
|----------|---------|--------|
| User explicitly says "want to see different directions" or "make a few more versions" | ✅ Enable immediately | Direct request |
| First version is unsatisfactory but user can't articulate what they want | ✅ Enable | A/B testing is better than "I guess what you want" |
| Project requires multi-platform distribution (X / WeChat Official Account / Bilibili / WeChat Moments) | ✅ Enable | One version per platform |
| Client hasn't decided on a style but has budget (time + token) | ✅ Enable | Repeated revisions = 5x cost |
| User has already provided clear style reference and only wants 1 version | ❌ Do not enable | Wasteful |
| Task is a simple motion graphic / icon animation | ❌ Do not enable | Over-engineering |
| Time is tight < 30 minutes | ❌ Do not enable | Subagents won't finish |

---

## Complete Methodology Flowchart

```
User brief (including quality expectations)
       ↓
[Main Thread] Write v5 Baseline director's notes (ten thousand words, 5 major parts)
       ↓
[Main Thread] Implement v5 HTML + capture keyframes (marketing baseline)
       ↓
[Decision Point] Enable multi-perspective?
       ↓ YES
[Main Thread] Select 6 differentiated perspectives + write 6 independent briefs (8 fields each)
       ↓
[6 Subagents Parallel]
   ├── v5a brief → director-notes + html + keyframes + README
   ├── v5b brief → ...
   ├── v5c brief → ...
   ├── v5d brief → ...
   ├── v5e brief → ...
   └── v5f brief → ...
       ↓
[Main Thread Concurrent Work] Fix v5 bugs · Write review framework · Consolidate methodology
       ↓
[All 6 Notifications Arrive]
       ↓
[Main Thread] Failure detection + retry / supplement screenshots
       ↓
[Main Thread] 5-dimension scoring + 3 top-level questions + use case allocation
       ↓
[Main Thread] Write final REVIEW.md
       ↓
[Deliver] 6 complete versions + review + platform distribution recommendations
```

---

## Related Documents

- Complete Methodology: `references/launch-film-director-notes.md`
- Single Perspective Sample: `assets/director-notes-samples/launch-film-30s-sample.md` (v5 Baseline)
- Project Location in Practice: Author's local demos directory (contains all 6 + 1 perspective files, not distributed with repository)
- Review: Author's local REVIEW.md (not distributed with repository)

---

*Last updated: 2026-05-11*
*Real case study: huashu-md-html v2.0 launch film 6-perspective parallel experiment*