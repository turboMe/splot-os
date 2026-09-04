# Content Agent → Universal Content Creator (multi-brand / brandless)

Goal: let the **meta-agent commission content in the same craft style but on a completely
different topic, without any GastroBridge data**, by toggling a flag — turning `contentAgent`
from a GastroBridge-only writer into a reusable content engine.

Source of truth for the existing agent: `src/mastra/agents/content-agent.ts`,
`prompts/content/business.md`, `prompts/content/domain.md`, `prompts/content/pipeline.md`.

**Nothing here deletes the GastroBridge behavior.** `brandProfile: "gastrobridge"` stays the
default and is byte-for-byte the current agent. Universality is purely additive.

---

## Why this is cheap (the craft is already separated from the brand)

The agent is already built from three physically separated prompt layers. That separation is
exactly what makes this refactor small. Audit of where coupling lives:

| Layer | File / source | Nature | Reusable? |
|---|---|---|---|
| Pipeline state machine | `content/pipeline.md` | neutral | ✅ as-is |
| Copy craft (hook taxonomy, STEPPS virality, per-platform rules, formatting, art-direction, hashtag strategy) | `content/domain.md` lines ~75–209 | near-neutral | ✅ extract |
| Founder voice (Patryk "chef who codes", anti-phrases, few-shots) | `content/domain.md` lines ~25–73 | brand-specific | ❌ brand pack |
| Business strategy (positioning, ICP, pillars, guardrails, claims, canonical hashtags) | `content/business.md` | brand-specific | ❌ brand pack |
| Fact / market grounding | `docs` notebook, `content_fetch_signals` (GastroBridge RSS), Patryk voice-exemplar corpus | brand data | ❌ per-brand or off |

**~60–70% of the agent (pipeline + all craft) is already brand-neutral.** "GastroBridge" lives in
only two prompt layers (business + voice section) plus the grounding tools. That's the moat — same
lesson as chef: quality comes from scaffolding, not the model.

### The two coupling points to cut

1. **Static prompt at construction.** `content-agent.ts:74`:
   `instructions: await combinePrompts('content/business','content/domain','content/pipeline')`.
   Every agent in the repo resolves `instructions` statically. But Mastra (1.32) supports
   `instructions` as a function `({ runtimeContext }) => string`, so we can pick which fragments
   load per call. **Technical barrier: zero.**
2. **Grounding tools hard-wired to GastroBridge data.** `content_fetch_signals` reads GastroBridge
   RSS signals, `knowledge_query` hits the `docs` notebook (product facts), the exemplar library is
   tagged with Patryk's voice. For "a different topic without my data" these must become flag-aware:
   either go silent / brandless, or point at a different source per brand. **This is the real work.**

---

## Target architecture: a "brand pack" plugin model

Refactor the prompt files so a brand becomes a swappable plugin, then both the flag and the
separate-agent options below collapse into "which brand pack do I load".

```
prompts/content/
  craft.md            # NEW — neutral: hook taxonomy, STEPPS, per-platform rules,
                      #       formatting, art-direction, hashtag strategy, notes mgmt
  pipeline.md         # unchanged (already neutral)
  brand/
    gastrobridge.md   # MOVED — business strategy + Patryk voice + grounding contract
    _neutral.md       # NEW — generic persona; reads topic/voice/CTA/guardrails from the brief
    <future-brand>.md # adding a brand = one new file
```

`content/domain.md` is split: craft → `craft.md`, founder-voice + knowledge-routing → the brand
pack. `content/business.md` moves wholesale into `brand/gastrobridge.md`.

Composition becomes:
```
instructions(runtimeContext) =
  combinePrompts('content/craft', 'content/pipeline')           // always
  + brandPackFor(runtimeContext.brandProfile)                   // pluggable
  + withContext(brief)                                          // per-call topic/voice/CTA
```

---

## The flag contract (runtimeContext)

Meta-agent passes via `delegateTaskTool`:

```ts
runtimeContext = {
  brandProfile: "gastrobridge" | "neutral" | "<brand-id>",  // default "gastrobridge"
  topic?: string,            // e.g. "personal finance for freelancers"
  voiceProfile?: string,     // free-text tone spec when brandless
  guardrails?: string[],     // banned claims/phrases for this brand
  grounding?: "off" | "web" | "<notebook-id>",  // where facts come from
  platforms?: ("linkedin-personal"|"linkedin-company"|"instagram"|"tiktok")[],
  language?: string,         // default "pl"
}
```

- `brandProfile: "gastrobridge"` (default) → identical to today; ignores the brandless fields.
- `brandProfile: "neutral"` → load `_neutral.md`, inject `topic`/`voiceProfile`/`guardrails` from
  the brief, set grounding per `grounding`.

---

## Implementation phases

### Phase 0 — safety net (before touching anything)
- Snapshot a current GastroBridge run output (a known Content Pack) as a golden regression fixture.
- Acceptance: after every later phase, a `brandProfile:"gastrobridge"` run must reproduce the same
  structure/voice (no regression).

### Phase 1 — prompt refactor (no behavior change)
- Split `domain.md` → `craft.md` (neutral) + voice section folded into `brand/gastrobridge.md`.
- Move `business.md` → `brand/gastrobridge.md`.
- Keep `combinePrompts` static for now, just pointed at the new files.
- **Gate:** GastroBridge run is byte-equivalent in structure to the golden fixture. `tsc` EXIT 0.

### Phase 2 — dynamic instructions + flag plumbing
- Change `content-agent.ts` `instructions` to a function of `runtimeContext`.
- Implement `brandPackFor(brandProfile)` loader (falls back to `gastrobridge` if unknown, logs warn).
- Add `_neutral.md` brand pack: generic senior content strategist; reads topic/voice/CTA/guardrails
  from the injected brief; explicit "you have NO proprietary data — work from the brief + research".
- **Gate:** default path unchanged; `brandProfile:"neutral"` produces a coherent pack on a non-gastro
  topic with zero GastroBridge leakage (grep output for "GastroBridge"/"Patryk"/canonical hashtags).

### Phase 3 — brand-aware grounding (the hard part)
- `content_fetch_signals`: when `grounding!=="<gastro notebook>"`, skip GastroBridge RSS; if
  `grounding:"web"`, route market research through `researcherAgent`/web instead.
- `knowledge_query`: when brandless, do NOT touch the `docs` notebook; only `content-strategy`
  (craft) stays available since it's brand-neutral.
- Exemplar library: key `content_search_exemplars` by `voiceProfile`/brand; brandless returns empty
  → agent leans on `craft.md` calibrators only.
- **Gate:** anti-hallucination holds — brandless run invents no product facts, cites only web/brief.

### Phase 4 — meta-agent integration
- Decide the surface: **Option A (recommended)** — one agent, meta-agent sets `runtimeContext`;
  vs **Option B** — a thin `universalContentAgent` wrapper sharing `craft.md`+`pipeline.md` with
  the `_neutral` pack, for hard isolation when leakage risk is unacceptable.
- Teach the meta-agent (its prompt) when/how to fill the brand brief before delegating.
- **Gate:** end-to-end E2E: meta-agent commissions a pack on a non-gastro topic via `/stream`,
  drafts/render/PDF all work through the existing workspace-service engine unchanged.

---

## Option A vs Option B

| | A: flag on one agent | B: separate `universalContentAgent` |
|---|---|---|
| Code | dynamic `instructions` + brand packs | + a second agent definition |
| Leakage risk | needs prompt guardrails | structurally impossible |
| Reuse | full (one pipeline, one render) | full craft/pipeline, duplicated config |
| Best when | brands are trusted variants | strict client isolation needed |

Recommendation: **A**, because the brand-pack refactor (Phase 1) makes A clean and B becomes a
trivial future addition (instantiate the same engine with the `_neutral` pack pinned).

---

## Hardest element / honest risk

The persona is the easy part. The hard part is **grounding**: "a different topic without my data"
means that for a new brand we either (a) rely on live research (`researcherAgent`/web) with no
proprietary corpus, or (b) build a dedicated knowledge source per brand. Without one of those, a
brandless run is only as factual as its brief + public web. Phase 3 is where the real effort sits;
Phases 1–2 are mostly mechanical prompt surgery.

## Out of scope (for now)
- Per-brand visual themes in the workspace-ui render (current green theme is fine; themeVars already
  parameterized in `workspace-service.ts` if we want it later).
- Multi-tenant storage separation of Content Packs on disk.
