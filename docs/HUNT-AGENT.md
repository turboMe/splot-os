# Hunt Agent — Lead Hunting & Cold Outreach ("Hunt Report")

> **Status:** ✅ Phases 0–5 done + verified (components live + A/B + degraded mode; full agent-driven E2E = runtime)
> **Date:** 2026-06-15
> **Plan:** `ideas/huntAgent.md`

A domain agent for **GastroBridge** B2B lead generation. From a free-form intent
("find 5 artisan goat-cheese producers near Wrocław that already supply restaurants")
→ discover → deterministically qualify → enrich → extract a verified email → write a
human cold email → an incrementally-built **Hunt Report** (Markdown on disk) + CRM
records + Gmail **drafts** (never auto-sent — the send stays human-gated).

It replaces the rigid `producer-hunt` workflow and the six near-identical "producer-hunt
agents" (which differed only by model) with **one chef-style conductor**. The quality moat
is the **architecture** — an expert rubric prompt + a state machine + must-call deterministic
gates — **not** the model. The `producer-hunt` workflow stays alive for A/B comparison.

> **Design principle (inviolable):** the LLM owns **strategy + creativity** (what to research,
> who to target, how to phrase an email); deterministic `hunt_*` tools own **verification +
> gates** (whether a lead is good enough, whether a draft is allowed to ship). The agent never
> judges lead quality or footer compliance with its own opinion.

> **Three language axes (do not conflate):**
> 1. **Prompt / tooling language = English** (always — this file, prompts, worker briefs).
> 2. **Output language** (the email body) = **Polish by default**, overridable per request.
> 3. **Market / locale** = **PL first-class**, foreign markets degraded best-effort via a Market Pack.

## Architecture

```
metaAgent / user
  └── system_delegate_task(huntAgent)        ← meta can task or auto-delegate to hunt
        ├── hunt_* quality gates (deterministic spine — MUST-CALL):
        │     hunt_score_lead, hunt_validate_enrichment_identity,
        │     hunt_pick_best_email, hunt_validate_draft, hunt_get_market_pack
        ├── hunt_* state machine: hunt_start_run / _get_run / _list_runs / _set_run_status
        ├── hunt_doc_* Hunt Report: init / write_section / status / render
        ├── CRM (read+write): search/create/update leads, update_status, add_interaction, record_email_draft
        ├── Gmail DRAFTS only (NO send tool — send is human-gated by design)
        ├── searchWeb / findCompanyLinks (Tavily — quick seeds only)
        ├── knowledge_query / _multi (NotebookLM deep Q&A)
        ├── delegate_task → researcherAgent (web discovery / recon) | knowledgeAgent (deep research)
        ├── run_worker (fast/default/reasoning/powerful + cloud) — email extraction, bulk drafting
        └── request_approval (the single human gate before shipping)
```

**Model:** `gemini-3.5-flash` (`agentModels.huntAgent`) — parity with chef/content. Heavy
generation is delegated to workers; the gates are deterministic code.

**Conductor, not typist:** web discovery → `researcherAgent` (PSEV); deep per-company
research → `knowledgeAgent`/NotebookLM; email extraction / JSON repair / bulk drafting →
`run_worker`. The agent writes the **creative core** of a handful of emails personally; it
never scrapes pages itself.

## "Hunt Report" pipeline — state machine (10 statuses)

Status is tracked with `hunt_set_run_status` (persisted to the `hunt_runs` Mongo collection →
the pipeline is **resumable + auditable**). One hard `request_approval` checkpoint stops the
pipeline for sign-off.

```
intake → discover → score → enrich → extract_email → draft → assemble → checkpoint_review → ship → done
                      │ (reject)                                              [HUMAN GATE]
                      └─▶ dropped (logged in the Hunt Report)
```

| Status | What it does | Executor / tools |
|---|---|---|
| `intake` | parse free-form intent → HuntBrief; resolve Market Pack; create run + Hunt Report skeleton | `hunt_get_market_pack`, `hunt_start_run`, `hunt_doc_init` |
| `discover` | find candidate companies + URLs + first-pass facts | `delegate_task→researcherAgent` (or `searchWeb`/`findCompanyLinks` for seeds) |
| `score` | DETERMINISTIC qualification of EVERY candidate (reject/research_needed/draft_candidate) | `hunt_score_lead` |
| `enrich` | deep per-company research → personalization hook; then identity guard; re-score | `delegate_task→knowledgeAgent`, `knowledge_query`, `hunt_validate_enrichment_identity` |
| `extract_email` | get a verified address (deterministic first, LLM last) | `hunt_pick_best_email` → `run_worker(fast)` → `run_worker(cloud)` |
| `draft` | write the cold email (personal for small N, `run_worker` fan-out for bulk) | per `domain.md` + `hunt_validate_draft` |
| `assemble` | upsert CRM + create Gmail draft + write `lead:<slug>` section + append `qualified` row | CRM tools, `gmailCreateDraft`, `hunt_doc_write_section` |
| `checkpoint_review` | **HUMAN GATE** — render the report, present it, request send approval | `hunt_doc_render`, `request_approval` |
| `ship` | after approval: mark CRM status, write `summary` (no send tool by design) | CRM tools, `hunt_doc_write_section` |
| `done` | pipeline closed | `hunt_set_run_status(done)` |

**Continuation contract:** the agent runs the states back-to-back within a single turn,
chaining tool calls. The ONLY legitimate turn-ends are (1) a genuine missing-info question
research cannot answer, and (2) `checkpoint_review`. A short status line after a step is fine —
it does NOT mean ending the turn. `maxSteps: 150` (4 budget fields, matching chef/content) so
the long chain (discovery + per-lead score→enrich→extract→draft→gate→CRM/Gmail) does not stall
at the framework default (~5 steps). Full spec + anti-patterns: `prompts/hunt/pipeline.md`;
domain rubric: `prompts/hunt/domain.md`.

## Deterministic quality gates (the spine)

These wrap the "gold" logic from `workflows/producer-hunt/quality.ts` + `email.ts` as must-call
tools, so the agent runs the **same** reliability gates the workflow runs — without touching the
workflow (it keeps importing those functions unchanged).

| Tool | Gate |
|---|---|
| `hunt_score_lead` | Scores ONE candidate 0–100 → `draft_candidate` (≥55) / `research_needed` (≥25) / `reject`. Dispatches by `targetKind`: `supplier`→`scoreLead`, `restaurant`→`scoreRestaurant`. Returns score, decision, inferred supplier type, `crmSegment`, and human-readable reasons. Call on EVERY candidate after discovery AND after enrichment. |
| `hunt_validate_enrichment_identity` | Confirms the enrichment is about the SAME company as the discovered lead (catches research drift to similarly-named firms). `ok:false` → re-research or drop, never draft. Call after ENRICH, before drafting. |
| `hunt_pick_best_email` | Regex + domain-match email extractor. ALWAYS first; only on `null` fall back to `run_worker(fast)` then `run_worker(cloud)`. Never hand-guess an address. |
| `hunt_validate_draft` | Hard gate for a cold-email draft. HARD failures (block ship): short subject, leftover placeholders, missing "GastroBridge", invented competitors, missing/incomplete compliance footer. SOFT warnings advisory. Footer check parameterized by `market`. Call on EVERY draft (own or worker's). |
| `hunt_get_market_pack` | Resolves the locale's output language, search locale, compliance-footer markers, and the `degraded` flag. Call in intake. |

### Supplier scoring (`scoreLead`)

Rewards: valid business email (+25), email↔website domain match (+20), official own site
(+20), usable source URL (+10), supplier-type signal (+15), food signal (+15), product category
(+10), direct-to-HoReCa (+15), region match (+10), legal form (+10). Penalizes: directory
listing (−40), social-only (−15), retail chain (−25), unknown type + no HoReCa (−50),
end-consumer-only (−30), negative research (−50). Infers `supplierType` (producer / manufacturer
/ wholesaler / distributor / importer / cooperative / producer_group / farm_aggregator), which
drives the **email angle** (a distributor cares about demand flow, not "finding buyers").

### Restaurant scoring (`scoreRestaurant`, Phase 3)

A **parallel rubric with flipped polarity** — some hunts target restaurants as GastroBridge
*customers* (buyers), not suppliers. The venue words that *penalize* a supplier now *qualify* a
demand-side lead. Pass `targetKind:"restaurant"` to `hunt_score_lead` to dispatch here.

- **Reward:** valid business email on the venue's own domain (+25/+20), own site not a
  directory/social profile (+20), usable source (+10), a venue signal (restauracja/bistro/
  pizzeria/trattoria… +20), a visible menu / cuisine (+10), active booking-or-ordering
  (rezerwacje/dowóz/Pyszne/Glovo/godziny otwarcia +10), reputation (opinie/TripAdvisor/multiple
  locations +10), region match (+10).
- **Penalize:** directory website (−40), social-only (−15), closed/defunct venue (−50), retail
  grocery chain (−25), no venue/menu signal at all (−30), negative research (−50).
- Same `≥55 / ≥25` thresholds. Returns `inferredSupplierType:'unknown'` (restaurants are buyers,
  not suppliers); the CRM segment is `restaurant`. Reuses the shared `DIRECTORIES` /
  `SOCIAL_DOMAINS` / `RETAIL_CHAIN_KEYWORDS` / `REGION_TOKENS` lists + new
  `RESTAURANT_VENUE/MENU/BOOKING/REPUTATION/CLOSED` keyword lists.
- **Email angle inverts:** offer the restaurant a **sourcing channel** (vetted suppliers, simpler
  buying of what's already on their menu). Same gates, same footer, same founder voice.

> All restaurant scoring is **additive** to `quality.ts` — `scoreLead` and every workflow caller
> are unchanged.

## "Hunt Report" — incremental document

File `<runId>.md` in `HUNT_DOCS_DIR` (default `/projekty/splot-projects/hunt-reports`), built
section-by-section as the run progresses (NOT in one shot at the end) so a crash in any state is
resumable. **Rule: write the section FIRST, report AFTER.**

**7 canonical sections** (skeleton from `hunt_doc_init`, anchored with HTML comments):
`brief`, `discovery`, `qualified`, `dropped`, `drafts`, `review`, `summary`.

**Dynamic sections:** `lead:<slug>` (e.g. `lead:goat-cheese-co` → title "Lead: goat cheese co")
for per-lead detail (company, score, type, email, draft subject + body, enrichment hook).

Sections are anchored by `<!-- section:ANCHOR start -->` … `<!-- section:ANCHOR end -->`.
`hunt_doc_write_section` replaces (`mode:'replace'`, default) or appends (`mode:'append'`) the
content between markers — **idempotent upsert**, safe to call repeatedly, does not duplicate the
anchor. `append` is for incremental rows (e.g. one-line `qualified` rows; `dropped` rows for
rejected/identity-failed candidates — always log one line, never silently discard). The anchor
must match `ANCHOR_PATTERN` (`^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$`); the path is sanitized +
must stay under `HUNT_DOCS_DIR` (path-traversal guard).

| Tool | Action |
|---|---|
| `hunt_doc_init` | creates the Hunt Report skeleton (idempotent — does not overwrite an existing one) |
| `hunt_doc_write_section` | writes/updates 1 section by anchor (replace/append) |
| `hunt_doc_status` | progress `filled/total` + `missing` list |
| `hunt_doc_render` | returns the full file content |

> The Hunt Report on disk + CRM records are the persistent backing store — never hand-edit the
> report file; use the `hunt_doc_*` tools exclusively.

## Localization — the Market Pack

`lib/hunt-market-pack.ts` separates **universal gates** (locale-agnostic, in `quality.ts`) from a
**per-locale pack**. A `MarketPack` supplies `{ locale, label, outputLanguage, searchLocale
{lang, country, tldHints}, footerCheck, degraded }`.

- **`PL_PACK`** — first-class. RODO footer hard-checked 1:1 (admin marker "Administratorem danych
  jest GastroBridge" + opt-out 'Odpisz "NIE"').
- **`IS_PACK`** — degraded example (Icelandic GDPR markers). Foreign / unknown markets fall back
  to a degraded pack (PL footer as a safety net).
- **Degraded mode:** the pack supplies the minimum (output language, search locale, compliance
  footer); the agent leans more on the researcher + universal gates and **MUST flag the degraded
  market** explicitly in the Hunt Report and to the user. To promote a market to first-class, fill
  its lists (directories/chains/domains/legal-forms/keywords) exactly as PL is specified.

`validateDraft(draft, lead, footerCheck = PL_RODO_FOOTER)` takes an optional 3rd param so the
workflow's `validateDraft(draft, lead)` callers are byte-for-byte unchanged, while
`hunt_validate_draft` passes the active market's `footerCheck` and surfaces `marketDegraded`.

## Meta-agent access (registration, 4 points)

huntAgent is available to the meta-agent both for **user-tasking-through-meta** and
**meta-auto-delegation**.

| File | What |
|---|---|
| `index.ts` | import `huntAgent` + entry in the `agents` map |
| `config/model-manifest.ts` | `agentModels.huntAgent: 'gemini-3.5-flash'` |
| `tools/system/delegate-task.ts` | `AGENT_IDS` + `targetAgent` enum + domain line (routing: generic "direct generate", no harness) |
| `prompts/meta/base.md` | delegation-table row |

> Like chef/content, huntAgent is NOT in `config/agent-ids.ts` — the lead-hunt domain belongs to
> huntAgent via delegation.

## Memory / context (parity with chef/content)

- **`observationalMemory`** — per-thread running summary (a run spans many turns: a batch of
  leads, each through score→enrich→draft) so earlier decisions (HuntBrief, market, approvals)
  stay in context past `lastMessages: 20`. Summariser `gemma4-e4b`
  (`infrastructure.observationalMemory`), `scope: 'thread'` (isolates separate hunt chats),
  `temporalMarkers`, `threadTitle`. Plus `generateTitle: true`.
- **`TokenLimiterProcessor`** (`inputProcessors`, 120K) — context-overflow guard for long
  autonomous runs.

## Anti-patterns (do NOT do this)

- ❌ Judging lead quality or footer compliance with the model's opinion instead of the `hunt_*` gates.
- ❌ Scraping pages yourself instead of delegating to `researcherAgent`.
- ❌ Drafting on enrichment that failed the identity guard.
- ❌ Hand-guessing an email address.
- ❌ Sending email — only Gmail drafts + human approval.
- ❌ Silently dropping rejected candidates — always log one line in the report.
- ❌ Running a degraded foreign market without flagging it.
- ❌ Stalling mid-pipeline to wait for a go-ahead outside the one human checkpoint.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `HUNT_DOCS_DIR` | Optional | Hunt Report directory (default `/projekty/splot-projects/hunt-reports`) |

## Verification

- `tsc --noEmit` — ✅ green after Phases 0, 1, 2, 3.
- **`hunt_doc_*` e2e** (fs): init → write canonical sections → write a dynamic `lead:<slug>` →
  status → render — idempotent re-write does not duplicate the anchor; file under `HUNT_DOCS_DIR`.
- **`scoreRestaurant`** (runtime): a real venue (Trattoria, own site, menu, rezerwacje,
  TripAdvisor) → **draft_candidate**; a grocery chain via a directory site → **reject** (−40
  directory, −25 chain, −30 no venue signal). Same venue via `scoreLead` → also draft_candidate
  (proves the dispatch is additive, not destructive).
- **Boundary:** full agent-driven E2E (intent → researcher → gates → CRM → Gmail draft) is a
  runtime test on the live agent (needs Mongo + tunnel); each component was verified individually.

## A/B vs the workflow + email-copy tuning (Phase 4)

Lead **qualification** is identical by construction — huntAgent and the `producer-hunt` workflow
call the *same* `quality.ts` gates — so the A/B isolated the one real variable: **email-copy
quality** (the workflow's static `draft-prompts.ts` vs the agent's `run_worker` brief).

A same-model (`gemini-2.5-flash` = `cloud` preset), same-leads, same-gate harness compared a terse
brief (V1) against a polished spec (V2):

| | V1 (terse brief) | V2 (polished spec) |
|---|---|---|
| Body length | ~200–240 words | **~120 words** |
| Opener | generic ("Szanowni Państwo, piszę…") | verbatim research detail ("Wasz żytni razowy na zakwasie z 24h fermentacją…") |
| Voice | "Zespół GastroBridge", bullet lists, marketing clichés | founder first-person ("Jestem Patryk… Patryk — GastroBridge") |
| Ask | diffuse / drifted | one ask, soft time box ("15 min w tym tygodniu") |
| Type terminology | loose | correct (wholesaler ≠ producent; "istniejąca sieć logistyczna") |

Both passed the hard gate; V2 is the human one. The winning spec is encoded as the **bulk-draft
brief spec** in `prompts/hunt/domain.md` (referenced from `pipeline.md` §6): founder ROLE,
`Output language`, verbatim-detail opener, supplier-type angle + terminology guard, one timed ask,
a named product in the body, no invented facts, ≤140 words, mandatory footer + brand.

**Soft-gate fix:** `validateDraft`'s advisory "uses their offer" keyword list recognized only
wholesaler/distributor/importer vocabulary, so a human PRODUCER email naming a real product (e.g.
"chleb żytni na zakwasie") tripped a **false** soft-warning — which would train the agent to
keyword-stuff. Added food-product nouns to the list. This is **advisory-only and safe**: every
`validateDraft` consumer (the workflow + `hunt_validate_draft`) reads only `.ok` / `.hardFailures`;
nothing acts on `softWarnings` for gating, so the hard contract is unchanged.

> **Decision: keep BOTH.** huntAgent (free-form intent + restaurant target + better copy spec) and
> the `producer-hunt` workflow (deterministic batch reference) run side by side until a full live
> agent-driven E2E run is logged. The workflow is **not** retired yet.

## Foreign-market readiness — degraded mode (Phase 5)

Degraded mode is enabled and **runtime-verified end-to-end**. `getMarketPack` returns `pl`
(first-class, `.pl`), `is` (degraded, `.is`, Icelandic GDPR footer), and an unknown market (e.g.
`de`) as a degraded fallback (PL footer as a safety net, empty TLD hints).

**The footer gate switches per market** — verified:

| Draft footer | Gate (market) | Result |
|---|---|---|
| PL RODO | IS | **hard-fail** (`Vantar persónuverndarfót (GDPR)`) |
| Icelandic | IS | pass |
| PL RODO | PL | pass |
| PL RODO | unknown `de` (fallback) | pass (PL footer safety net; `degraded` flag carries the warning) |

So a degraded market enforces its **own** compliance text, not a hardcoded PL one. The `degraded`
flag flows `hunt_get_market_pack` → `hunt_start_run(marketDegraded)` →
`hunt_validate_draft.marketDegraded`, and the prompt instructs the agent to flag it in the Hunt
Report. Building a NEW first-class foreign market stays out of scope until a real market matters —
promote then by filling its lists (directories/chains/domains/legal-forms/keywords), exactly as PL
is specified.

## Remaining (genuinely runtime / on demand)

- **Live agent-driven E2E** (intent → researcher → gates → CRM → Gmail draft) on the live agent —
  the only thing that gates retiring the workflow.
