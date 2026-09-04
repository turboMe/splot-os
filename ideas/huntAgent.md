# Hunt Agent — implementation plan (workflow → specialized agent)

Goal: build a **lead-hunting agent** (`huntAgent`) that finds and qualifies food **suppliers**
(producers, manufacturers, wholesalers, distributors, importers, cooperatives, aggregators) AND
**restaurants** for GastroBridge, enriches them reliably, and drafts genuinely human cold emails —
modeled 1:1 on the architecture that makes `chefAgent` and `contentAgent` good.

Move from the rigid linear `producer-hunt` workflow (fixed input: `count` + `category` + `region`)
to an autonomous, tool-driven, delegating agent that accepts **free-form intent**
("find 5 artisan goat-cheese producers near Wrocław that already supply restaurants",
"find suppliers similar to company X", "3 Italian-product importers for a fine-dining client in Warsaw").

**`producer-hunt` workflow STAYS.** It works, stays running as a deterministic fallback / batch path.
We *reuse* its deterministic gold (scoring, identity validation, draft validation, email picking, JSON
repair) by wrapping it in **tools**, but we **do not delete or modify it** beyond optionally lifting pure
helpers into a shared lib both can import. Decision on retiring the workflow is **deferred until A/B
shows the agent is reliably better** — maybe we keep both.

Source of truth for the "moat" pattern:
[chef-agent.ts](agentic-agents/src/mastra/agents/chef-agent.ts),
[prompts/chef/domain.md](agentic-agents/src/mastra/prompts/chef/domain.md),
[prompts/chef/pipeline.md](agentic-agents/src/mastra/prompts/chef/pipeline.md),
and the sibling migration plan [contentAgent.md](agentic-agents/ideas/contentAgent.md).

---

## 0. The core finding (why this migration is low-risk)

The 7 "Producer Hunt agents" are **one agent**. All come from a single factory in
[marketing-agent.ts:76](agentic-agents/src/mastra/agents/marketing-agent.ts) — identical
`marketing/base` instructions, identical 22 tools, identical memory. The **only** difference is the
`model` string. They are not agents; they are **model-routing handles** for workflow steps.

The real intelligence already lives in two places we will reuse verbatim:

1. **Per-step prompt families** (the only real "personalities"):
   [discovery-prompts.ts](agentic-agents/src/mastra/workflows/producer-hunt/discovery-prompts.ts),
   [enrichment-prompts.ts](agentic-agents/src/mastra/workflows/producer-hunt/enrichment-prompts.ts),
   [draft-prompts.ts](agentic-agents/src/mastra/workflows/producer-hunt/draft-prompts.ts).
2. **A deterministic quality engine** —
   [quality.ts](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts) (~700 lines of pure
   functions): `scoreLead`, `validateEnrichmentIdentity`, `validateDraft`, supplier-type inference,
   email/domain logic. **This — not the model — is what makes the data reliable.**

So the migration is: keep the deterministic gold, drop the 6 fake agents, and let ONE real agent
orchestrate the prompt families + gates as a chef-style pipeline.

---

## 1. Why this works (the moat is architecture, not the model)

ChefAgent's quality comes from five patterns (orchestrator = light cloud model, NOT a flagship, with
heavy lifting pushed to local workers). We copy all five:

| Chef pattern | Hunt equivalent |
|---|---|
| `chef/domain.md` = expert rubric (menu engineering) | `hunt/domain.md` = B2B lead-qualification + cold-email rubric (Patryk's voice, RODO, supplier typology) |
| `chef/pipeline.md` = state machine + autonomous-continuation contract | `hunt/pipeline.md` = lead-hunting states |
| Menu Book built section-by-section (external memory, crash-safe) | **Hunt Report** built incrementally (candidates → qualified → drafts), resumable |
| NotebookLM (culinary canon) | NotebookLM via `knowledgeAgent` for deep per-company research |
| `run_worker` + `delegate_task` + notes | same primitives, unchanged |

Today orchestration is hardcoded in TS ([producer-hunt.ts](agentic-agents/src/mastra/workflows/producer-hunt.ts),
11 fixed steps, each agent called once). In chef, the **agent** orchestrates via prompt + tools + a
persisted state machine. We replicate that.

**Key design principle (do not violate):**
> **LLM owns strategy + creativity. Deterministic code owns verification + gates.**
> The agent decides *what to research, who to target, how to phrase the email*. The `quality.ts`
> engine decides *whether a lead is good enough* and *whether a draft is allowed to ship*. Handing the
> gates to the model would make the system **less** reliable, not more. The whole "rzetelność" of the
> current workflow lives in those deterministic gates — they must survive the migration untouched, as
> tools the agent is **required** to call.

---

## 2. Decisions (locked 2026-06-15)

1. **Agent-driven, not a new workflow.** `huntAgent` runs the pipeline through `hunt/domain.md` +
   `hunt/pipeline.md` + a state machine persisted to Mongo. Mirror
   [chef-agent.ts](agentic-agents/src/mastra/agents/chef-agent.ts) construction exactly:
   `combinePrompts`, `maxSteps: 150`, thread-scoped `observationalMemory`, `createTokenLimiter`.
2. **Orchestrator = cloud model** (confirmed). Same lesson as chef/content: the conductor needs a
   capable model to not wander across a 150-step loop. Route via
   [model-manifest.ts](agentic-agents/src/mastra/config/model-manifest.ts) under a new
   `agentModels.huntAgent` (cloud, e.g. the same `gemini-3.1-flash-lite` class chef uses).
3. **Workers = local, cloud fallback** (confirmed). All narrow sub-tasks (email extraction, JSON
   repair, classification/reformatting, bulk drafting) run through `run_worker` on local presets
   (`fast`/`default`/`reasoning`) with `cloud` as fallback — exactly the pattern in
   [run-worker.ts](agentic-agents/src/mastra/tools/system/run-worker.ts). This replaces 3 of the 6
   fake agents (email-extraction, json-repair, cloud-fallback) with worker calls.
4. **Reuse deterministic gold by wrapping, not rewriting.** `scoreLead`, `validateEnrichmentIdentity`,
   `validateDraft`, `pickBestEmail`, `generateJsonWithFallback` become tools the agent calls. The
   workflow keeps its own copies untouched. Where trivial, lift the pure functions into
   `lib/hunt-shared.ts` (or keep importing from `workflows/producer-hunt/`) with **zero behavior
   change** to the workflow.
5. **`producer-hunt` workflow STAYS for A/B.** Run agent + workflow in parallel; the agent calls the
   **same** gates so quality is comparable from day one, then exceeds it on flexibility. Retire the
   workflow only if/when the agent proves better. Optionally expose the batch workflow as a tool the
   agent can invoke for large deterministic runs ("50 leads, same as always") — best of both worlds.
6. **Free-form intent replaces `{count, category, region}`.** An `intake` state parses the user's
   request into an internal `HuntBrief` (target kind, typology filter, region/geo, count, hard
   constraints, "similar-to" seed). The agent plans its own discovery queries instead of the fixed
   profiles in
   [discovery-queries.ts](agentic-agents/src/mastra/workflows/producer-hunt/discovery-queries.ts)
   (those become a fallback/seed, not the only path).
7. **Dual scoring — suppliers AND restaurants** (confirmed). Today
   [quality.ts](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts) deliberately **rejects**
   restaurants (`END_CONSUMER_KEYWORDS`) because they are GastroBridge's demand side. To also hunt
   restaurants as marketplace **customers**, add a second scoring profile. `scoreLeadTool` takes a
   `targetKind: 'supplier' | 'restaurant'` and routes to the matching rubric. The supplier rubric is
   the current `scoreLead` unchanged; the restaurant rubric is **new** (see §6).
8. **Drafting: agent personally for the creative core, workers for bulk** (chef lesson — don't
   fragment the creative core). For a handful of leads the agent writes copy itself using the
   per-type `draft-prompts.ts` rules; for large batches it fans out to `run_worker` and then runs
   `validateDraftTool` on every result. Either way the RODO footer + "GastroBridge" + no-placeholder
   gate is enforced deterministically.
9. **Approval gate before send stays.** `requestApprovalTool`
   ([request-approval.ts](agentic-agents/src/mastra/tools/system/request-approval.ts)) gates the
   send; Gmail **drafts** are created freely, only the actual send is human-gated (parity with the
   workflow, which has no `gmailSendDraftTool` in the agent's hands).
10. **Hunt Report is the external-memory artifact** (analog Menu Book / Content Pack): incremental,
    crash-resumable, persisted to Mongo + disk, rendered at the end. Makes a run auditable and
    resumable.
11. **`huntAgent` is reachable from the meta agent** (confirmed 2026-06-15). The user must be able to
    task `huntAgent` *through a conversation with meta* ("meta, find me 5 cheese producers near
    Wrocław"), and meta must be able to **auto-delegate** hunting sub-tasks to it when a request needs
    lead hunting. Concretely: register `huntAgent` in the Mastra `agents` map AND add `huntAgent` to
    the `delegate_task` `AGENT_IDS` map + `targetAgent` enum + a domain-description line, so meta (and
    any other agent) can route to it. This is a **Phase 1** step, not optional.

### Open / to-decide (not blocking v1)
- **Human-er email worker prompts** (raised by Patryk): improve worker briefs for format + a more
  human writing style (less template-y, better rhythm, stronger hooks). Treat like the content
  `domain.md` voice work — iterate after v1 is wired, with `validateDraft` as the safety net. Possible
  approach: a curated swipe-file of great B2B cold emails injected as few-shot into the draft worker
  brief (mirrors the content exemplar-library idea), plus a `run_worker(reasoning)` editor pass.
- Whether to expose the batch workflow as a callable tool (Decision 5) now or later.
- Restaurant outreach angle/value-prop copy (the supplier angles in `draft-prompts.ts` don't apply to
  the demand side) — needs its own per-target email rubric once the restaurant scoring lands.

### Non-goals (v1)
- No deletion/refactor of `producer-hunt` beyond optional pure-helper extraction.
- No automatic sending — drafts + human approval only (parity with workflow).
- No new scraping stack — discovery/recon delegated to `researcherAgent` (PSEV), as chef does.
- No engagement/feedback learning loop.
- No cron/trigger wired now (only a clean entrypoint kept ready).

---

## 3. Architecture overview

```
huntAgent (orchestrator, cloud model, maxSteps 150, observationalMemory, tokenLimiter)
  │  drives state machine via prompt; builds Hunt Report incrementally
  ├─ INTAKE:     parse free-form request → HuntBrief (targetKind, typology, geo, count, constraints, similar-to)
  ├─ DISCOVER:   delegate_task → researcherAgent (PSEV web research: candidate URLs + first-pass facts)
  │              + tavily search/findCompanyLinks for quick seeds
  ├─ SCORE:      scoreLeadTool (DETERMINISTIC) per candidate → draft_candidate | research_needed | reject
  ├─ ENRICH:     delegate_task → knowledgeAgent (NotebookLM deep Q&A) OR knowledge_query directly
  │              → personalization hook + deep analysis; validateEnrichmentIdentityTool gate
  ├─ EXTRACT:    pickBestEmailTool (regex+validation) → run_worker(fast) fallback → run_worker(cloud) fallback
  ├─ DRAFT:      agent personally (small N) OR run_worker(default) ×N (bulk) using draft-prompts rules
  │              → validateDraftTool (DETERMINISTIC hard gate: GastroBridge + RODO + no placeholders)
  ├─ ASSEMBLE:   hunt_doc_write_section → Hunt Report (crash-safe), CRM upsert, Gmail create-draft
  └─ SHIP:       requestApprovalTool [HUMAN GATE] → send approved drafts → CRM status email_sent
```

Deterministic gates (must-call tools) are the spine: **DISCOVER and ENRICH are LLM/delegation,
SCORE / EXTRACT-validate / DRAFT-validate are code.**

---

## 4. Delegation map (you are the conductor, not the typist)

| Task | Owner | How |
|---|---|---|
| Web discovery / candidate URLs / first-pass recon | **researcherAgent** (PSEV) | `delegate_task` — already wired in [delegate-task.ts:84](agentic-agents/src/mastra/tools/system/delegate-task.ts) |
| Deep per-company research (NotebookLM) | **knowledgeAgent** (NotebookLM MCP) or `knowledge_query` directly | `delegate_task` / tool |
| Lead scoring + supplier-type inference | **deterministic tool** `scoreLeadTool` | wraps `scoreLead` / `inferSupplierType` |
| Enrichment identity sanity check | **deterministic tool** `validateEnrichmentIdentityTool` | wraps `validateEnrichmentIdentity` |
| Email extraction | `pickBestEmailTool` → `run_worker(fast)` → `run_worker(cloud)` | regex first, then local LLM, then cloud |
| JSON repair | `run_worker(reasoning)` → `run_worker(cloud)` | replaces json-repair + cloud-fallback agents |
| Cold-email creative core (small N) | **huntAgent personally** | per-type `draft-prompts` rules; do not fragment |
| Cold-email bulk | `run_worker(default)` ×N | then `validateDraftTool` on each |
| Draft hard-gate (RODO/GastroBridge/placeholders) | **deterministic tool** `validateDraftTool` | wraps `validateDraft` |
| CRM upsert + interaction | CRM tools | unchanged from marketing tool set |
| Gmail draft creation | gmail create/update draft tools | no send tool in agent hands |
| Send | **human** via `requestApprovalTool` then send | only after approval |
| Hunt Report doc | `hunt_doc_*` tools | incremental, crash-safe (Menu Book analog) |

---

## 5. File map — extract / create / leave alone

### Extract as TOOLS (Phase 0 — pure refactor, zero logic change)
From [quality.ts](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts):
- `scoreLeadTool` ← `scoreLead` (+ `targetKind` param routing to supplier/restaurant rubric)
- `validateEnrichmentIdentityTool` ← `validateEnrichmentIdentity`
- `validateDraftTool` ← `validateDraft`
- (helpers `inferSupplierType`, `mapToCrmSegment` reused internally)

From [email.ts](agentic-agents/src/mastra/workflows/producer-hunt/email.ts):
- `pickBestEmailTool` ← `pickBestEmail`

From [helpers.ts](agentic-agents/src/mastra/workflows/producer-hunt/helpers.ts):
- `generateJsonWithFallback` → reuse inside the draft/JSON-repair tool path (or as a tool)

These are already pure functions → wrapping in `createTool` is trivial. The workflow keeps importing
them unchanged.

### Create new
- `agents/hunt-agent.ts` — mirror [chef-agent.ts](agentic-agents/src/mastra/agents/chef-agent.ts).
- `prompts/hunt/domain.md` — qualification + cold-email rubric, supplier typology, RODO, Patryk voice
  (distill from `draft-prompts.ts` + `enrichment-prompts.ts` + `marketing/base.md`).
- `prompts/hunt/pipeline.md` — the state machine + continuation contract (mirror `chef/pipeline.md`).
- `tools/hunt/hunt-quality-tools.ts` — the deterministic tool wrappers above.
- `tools/hunt/hunt-doc-tools.ts` — Hunt Report incremental document (mirror chef document tools).
- Restaurant scoring rubric inside `quality.ts` (new `scoreRestaurant`) — see §6.
- `config/model-manifest.ts` — add `agentModels.huntAgent` (cloud).
- Register `huntAgent` in [index.ts] Mastra `agents` map + add `huntAgent` to the `delegate_task`
  `AGENT_IDS` enum so meta/other agents can delegate to it.

### Leave alone (reused by both)
- [producer-hunt.ts](agentic-agents/src/mastra/workflows/producer-hunt.ts) — the whole workflow.
- [discovery-prompts.ts](agentic-agents/src/mastra/workflows/producer-hunt/discovery-prompts.ts),
  [enrichment-prompts.ts](agentic-agents/src/mastra/workflows/producer-hunt/enrichment-prompts.ts),
  [draft-prompts.ts](agentic-agents/src/mastra/workflows/producer-hunt/draft-prompts.ts) — imported
  by the agent's prompt/worker briefs too.
- The 6 `producerHunt*` agent exports — left for the workflow; not used by `huntAgent`.

---

## 6. Dual scoring — adding the restaurant target

Current [scoreLead](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts) is **supplier-only**
and penalizes restaurants via `END_CONSUMER_KEYWORDS` (−30) because for GastroBridge they're demand,
not supply. To hunt restaurants as **customers**:

- Add `scoreRestaurant(lead, region): LeadQuality` — a parallel rubric where the signals **flip**:
  - reward: real restaurant/HoReCa signals (cuisine type, menu present, reservation/ordering, multiple
    locations, active reviews), official own site, region match, business email on own domain.
  - penalize: directories/social-only/aggregators (same `DIRECTORIES`/`SOCIAL_DOMAINS` lists reused),
    closed/defunct signals, chains we don't want, no contactability.
- `scoreLeadTool({ targetKind })` dispatches: `'supplier'` → existing `scoreLead`, `'restaurant'` →
  `scoreRestaurant`. No change to existing supplier behavior.
- CRM segment mapping extended (`mapToCrmSegment`) with a `restaurant` segment.
- Email rubric: restaurant outreach needs its **own** value-prop/angle (demand side: "get supplied by
  vetted local producers via GastroBridge", not "sell to restaurants"). New per-target draft rules —
  flagged as open item in §2.

---

## 7. Localization / multi-market (PL first-class, others best-effort)

Three **independent** language axes — do not conflate them:

| Axis | What | huntAgent value |
|---|---|---|
| **Prompt language** (domain.md, pipeline.md, worker briefs) | how we instruct the agent/workers | **English** (tooling convention) |
| **Output language** (email body, replies to user) | what the agent produces | **Polish by default**, overridable by instruction ("write in English") |
| **Market / locale** (where we search, which sites, which rules) | research context + deterministic gates | **PL first-class**, foreign markets best-effort |

Prompt-vs-output is already proven by chef: [chef/pipeline.md:10](agentic-agents/src/mastra/prompts/chef/pipeline.md)
— *"instructions and all tooling are in English; only the produced artifact follows the client's
language."* A worker gets an English brief that says `Output language: pl` and writes Polish. Switching
the email language = one field in the brief, not a prompt rewrite.

### The real work is the market axis — `quality.ts` is Poland-coded

[quality.ts](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts) hardcodes PL-specific
knowledge: `REGION_TOKENS` (voivodeships/cities), `PUBLIC_EMAIL_DOMAINS` (wp.pl, o2.pl…),
`DIRECTORIES` (panoramafirm.pl, pkt.pl…), `RETAIL_CHAIN_KEYWORDS` (Biedronka, Dino…), `legalForms`
(sp. z o.o., s.c.…), all keyword packs (Polish), and `validateDraft` **hard-checks the Polish RODO
string**. On Iceland none of that matches.

### Design: universal gates + a per-locale Market Pack

Split the deterministic layer in two:

1. **Universal gates (locale-agnostic, always on):** email validity (regex), email↔website domain
   match, official-site vs social-only (global domains like `facebook.com`), confidence thresholds,
   structural scoring.
2. **Market Pack (loaded per locale, default `PL`):**
   ```
   MarketPack {
     locale: 'pl' | 'is' | ...
     outputLanguage: 'pl'                     // default email language
     searchLocale: { lang, country, tldHints } // steers researcherAgent / Tavily
     publicEmailDomains, directories, retailChains, legalForms, regionTokens
     keywordPacks: { production, food, wholesale, ... }  // localized
     complianceFooter: string                 // PL: RODO | IS: GDPR/EEA in Icelandic
   }
   ```

- `PL` pack = today's `quality.ts` constants, 1:1, fully-specified, first-class — **no behavior change.**
- **Foreign market = degraded pack:** supply the minimum (output language, search locale, compliance
  footer); the rest falls back to universal gates + LLM/researcher knowledge. Less hard filtering →
  more weight on the model — acceptable for a market you don't run daily.
- **Quality is a slider, not a switch.** The more of a pack you fill, the closer to PL rigor:
  nothing (degraded) → +language/locale/footer → +directory/chain/domain/legal-form lists → full pack
  (first-class). **Promoting a market = adding a few lists (hours, not weeks).**

### The one hard-gate change required

`validateDraft` must stop hard-checking the literal Polish RODO string and instead take
`expectedFooter` from the active Market Pack. For PL that is still today's RODO check (gate unchanged);
for IS it is the Icelandic footer. This is the **only** place locale enters a hard gate.

### How the agent picks the market (in `intake`)

`HuntBrief` gets two separate, independently-defaulted fields:
- `market` → default **`PL`** (Polish sites, Polish output). "na rynku islandzkim" / "w Reykjavíku"
  → `is`, load IS pack (or degraded), point researcher at Icelandic sources, localize footer + email.
- `outputLanguage` → default **`pl`**, overridable ("napisz po angielsku") **without** changing the
  market.

### Safety for degraded markets

On any non-PL market the agent must **flag it explicitly** in the Hunt Report and to the user, e.g.
*"market: IS (degraded pack) — verify directory filtering and X, Y manually"*. Combined with the
existing approval gate + scored Hunt Report, even a degraded foreign run is safe to review before
anything ships. Honest framing: **PL = code-guaranteed specialization; foreign = functional
best-effort until its pack is built out.**

---

## 8. State machine (`hunt/pipeline.md` skeleton)

```
intake ─▶ discover ─▶ score ─▶ enrich ─▶ extract_email ─▶ draft ─▶ assemble ─▶ checkpoint_review ─▶ send ─▶ done
                        │ (reject)                                              [HUMAN GATE]
                        └─▶ dropped (logged in Hunt Report)
```

- Statuses persisted via a `hunt_set_status` tool (resumability/audit, like `chef_set_project_status`).
- **Continuation contract** (copy chef's): run states back-to-back in one turn; the ONLY legitimate
  stop is (a) a genuine missing-info question research can't answer, or (b) `checkpoint_review` before
  send. Stalling mid-pipeline is a defect.
- Per-lead loop (score→enrich→extract→draft) can fan out in parallel batches (like chef recipes,
  4–6 workers/turn).
- Each finished lead is written to the Hunt Report immediately (FIRST write, THEN short status line).

---

## 9. Phased migration (low-risk, each phase shippable)

- **Phase 0 — Extract gates as tools. ✅ DONE (2026-06-15).** Wrapped `scoreLead` /
  `validateEnrichmentIdentity` / `validateDraft` / `pickBestEmail` in
  [tools/hunt/hunt-quality-tools.ts](agentic-agents/src/mastra/tools/hunt/hunt-quality-tools.ts)
  (`huntScoreLeadTool` / `huntValidateEnrichmentIdentityTool` / `huntValidateDraftTool` /
  `huntPickBestEmailTool` + `huntQualityTools` bundle). Zero logic change; workflow untouched —
  imports the functions verbatim from `workflows/producer-hunt/`. Typechecks clean (`tsc --noEmit`
  exit 0). *Note:* the §7 `validateDraft` footer parameterization is **deferred to Phase 1** so PL
  stays byte-for-byte equivalent here.
- **Phase 1 — Skeleton agent + PL Market Pack. ✅ DONE (2026-06-15).**
  [agents/hunt-agent.ts](agentic-agents/src/mastra/agents/hunt-agent.ts) (chef/content-style: 150-step
  budget, thread-scoped observationalMemory, tokenLimiter) +
  [prompts/hunt/domain.md](agentic-agents/src/mastra/prompts/hunt/domain.md) +
  [prompts/hunt/pipeline.md](agentic-agents/src/mastra/prompts/hunt/pipeline.md). Tool set: tavily +
  knowledge + `delegate_task` + `run_worker` + `requestApproval` + CRM + gmail drafts + the Phase 0
  quality tools. **Market Pack** stood up in
  [lib/hunt-market-pack.ts](agentic-agents/src/mastra/lib/hunt-market-pack.ts): `PL` first-class (today's
  RODO footer 1:1) + `is` degraded stub + unknown→degraded fallback; surfaced via the new
  `hunt_get_market_pack` tool and consumed by `hunt_validate_draft(market)`. The §7 footer
  parameterization landed as an **optional 3rd arg** to `validateDraft` (PL default = byte-for-byte
  workflow parity). HuntBrief `market`/`outputLanguage` handled in the intake prompt (default `pl`/`pl`).
  **Meta access (Decision 11):** registered in the Mastra `agents` map
  ([index.ts](agentic-agents/src/mastra/index.ts)), added to `delegate_task` `AGENT_IDS` + `targetAgent`
  enum + a domain line ([delegate-task.ts](agentic-agents/src/mastra/tools/system/delegate-task.ts)), and
  a `huntAgent` row added to [meta/base.md](agentic-agents/src/mastra/prompts/meta/base.md) so meta can
  route to it. Manifest model `agentModels.huntAgent` (cloud `gemini-3.5-flash`, parity with chef/content).
  Typechecks clean (`tsc --noEmit` exit 0); module constructs (id/name OK). *E2E live supplier run
  deferred to A/B in Phase 4 (needs Mongo/tunnel up).*
- **Phase 2 — Hunt Report doc + resumability. ✅ DONE (2026-06-15).**
  [hunt-document-tools.ts](agentic-agents/src/mastra/tools/hunt/hunt-document-tools.ts) (`hunt_doc_init` /
  `hunt_doc_write_section` / `hunt_doc_status` / `hunt_doc_render` — anchored, idempotent-upsert Markdown
  Hunt Report with canonical sections brief/discovery/qualified/dropped/drafts/review/summary + dynamic
  `lead:<slug>`; smoke-tested E2E) +
  [hunt-state-tools.ts](agentic-agents/src/mastra/tools/hunt/hunt-state-tools.ts) (`hunt_start_run` /
  `hunt_get_run` / `hunt_list_runs` / `hunt_set_run_status`) backed by
  [hunt-service.ts](agentic-agents/src/mastra/tools/hunt/hunt-service.ts) (`hunt_runs` Mongo collection,
  10-state machine). Wired into the agent; the pipeline prompt now drives status + doc writes per phase.
  CRM + Gmail-draft wiring is in the agent's tool set at parity with the workflow. Typechecks clean.
- **Phase 3 — Restaurant target. ✅ DONE (2026-06-15).** Added `scoreRestaurant(lead, region)` to
  [quality.ts](agentic-agents/src/mastra/workflows/producer-hunt/quality.ts) — a parallel rubric with
  flipped polarity (venue/menu/booking/reputation signals QUALIFY a demand-side buyer; reuses the same
  DIRECTORIES/SOCIAL_DOMAINS/RETAIL_CHAIN_KEYWORDS/REGION_TOKENS + new RESTAURANT_VENUE/MENU/BOOKING/
  REPUTATION/CLOSED keyword lists; penalizes directories/social/chains/closed venues; same ≥55/≥25
  thresholds; returns `inferredSupplierType:'unknown'`). `hunt_score_lead`'s `targetKind` enum extended to
  `['supplier','restaurant']` and dispatches to the matching scorer; new `crmSegment` output (`restaurant`
  for demand-side, else `mapToCrmSegment`). Restaurant angle added to hunt/domain.md (sourcing-channel
  pitch) and the intake-detection note to hunt/pipeline.md. Typechecks clean; runtime-verified (a real
  venue → draft_candidate, a grocery chain via directory → reject).
- **Phase 4 — A/B + polish. ✅ DONE (2026-06-15).** Lead *qualification* is identical by construction
  (both paths call the same `quality.ts` gates), so the A/B isolated the real variable: **email-copy
  quality** (workflow's static `draft-prompts.ts` vs the agent's `run_worker` brief). Ran a same-model
  (gemini-2.5-flash = `cloud` preset), same-leads, same-gate harness comparing a terse brief (V1) vs a
  polished spec (V2): **V1 → ~200-word marketing wall signed "Zespół GastroBridge"; V2 → ~120-word
  founder-voice email** opening on a verbatim research detail, one timed ask, correct supplier-type
  terminology, no invented facts — both passing the hard gate. Encoded the winning V2 spec as the
  **bulk-draft brief spec** in `prompts/hunt/domain.md` (+ a pointer from `pipeline.md` §6). Fixed a
  soft-gate blind spot in `quality.ts`: the advisory "uses their offer" keyword list recognized only
  wholesaler/distributor/importer vocabulary, so a human PRODUCER email naming a real product ("chleb
  żytni na zakwasie") got a false soft-warning that pushed the agent toward keyword-stuffing — added
  food-product nouns (advisory-only; the workflow reads only `.ok`/`.hardFailures`, never `softWarnings`,
  so gating is unchanged). **Decision: keep BOTH** — the agent (free-form intent + restaurants + better
  copy) and the workflow (deterministic batch reference) — until a full live agent-driven E2E run is
  logged; do not retire the workflow yet.
- **Phase 5 — Foreign-market readiness. ✅ DONE (2026-06-15).** Degraded mode is enabled and
  runtime-verified end-to-end: `getMarketPack` returns `pl` (first-class, `.pl`), `is` (degraded, `.is`,
  Icelandic GDPR footer), and an unknown market (`de`) as a degraded fallback (PL footer as safety net,
  empty TLD hints). **Critically, the footer gate switches per market**: a PL RODO footer HARD-FAILS the
  Icelandic gate (`Vantar persónuverndarfót (GDPR)`), the Icelandic footer passes the IS gate, PL passes
  PL — so a degraded market enforces its OWN compliance text, not a hardcoded PL one. The `degraded` flag
  flows `hunt_get_market_pack` → `hunt_start_run(marketDegraded)` → `hunt_validate_draft.marketDegraded`,
  and the prompt instructs the agent to flag it in the Hunt Report. Building a NEW first-class foreign
  market stays out of scope until a real market matters — promote then by filling its lists
  (directories/chains/domains/legal-forms/keywords), exactly as PL is specified.

---

## 10. Risks / trade-offs (eyes open)

- **Autonomy vs determinism.** A 150-step loop on local-ish models wanders more than a fixed pipeline.
  Mitigation: cloud orchestrator (Decision 2) + deterministic gates as must-call tools + workers only
  for narrow tasks + strong continuation contract.
- **Cost / call count.** Agent loops call the model more than a fixed workflow. Accepted — same as
  chef/content. Local workers keep the bulk cheap.
- **Big deterministic batches.** For "50 leads, same as always" the workflow is genuinely fine; keep
  it (Decision 5) and optionally expose it as a tool.
- **Gate erosion.** The temptation will be to let the model "judge" quality. Resist — gates stay code.
- **Identifier drift in this plan.** Before implementing, re-verify exact exports/paths (e.g.
  `pickBestEmail`, `generateJsonWithFallback`, the Mastra `agents` registry keys) — code may have moved
  since 2026-06-15.

---

## 11. TL;DR

Build `huntAgent` as a chef-style conductor: **cloud orchestrator + local workers (cloud fallback)**,
free-form intent in, Hunt Report out. **Reuse `quality.ts` as must-call deterministic tools** so
reliability is preserved while flexibility explodes. Delegate discovery to `researcherAgent`, deep
research to `knowledgeAgent`/NotebookLM, drobiazgi to `run_worker`. Keep the `producer-hunt` workflow
alive for A/B and batch. Add a restaurant scoring profile so the same agent hunts both sides of the
marketplace. Prompts/workers in English, emails in Polish by default; **PL is a code-guaranteed
first-class market, foreign markets run in degraded best-effort mode via a Market Pack you can promote
to first-class when one matters.** Human approval gates the send.
