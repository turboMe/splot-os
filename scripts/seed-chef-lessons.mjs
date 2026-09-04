/**
 * Seed chef-pipeline lessons into the Failure Brain (system_knowledge).
 *
 * One-shot utility for E3 (chef-agent-dev-plan §6). Writes the chef pipeline's
 * hard-won anti-patterns and implementation gotchas as `failure_case` /
 * `prompt_rule` entries so chefAgent (via memory_recall) and future maintainers
 * surface them automatically. Idempotent — writeKnowledge dedupes by (type, title).
 *
 * Run:  set -a && . ./.env 2>/dev/null; set +a; npx tsx scripts/seed-chef-lessons.mjs
 */
import { writeKnowledge } from '../src/mastra/lib/failure-brain.js';

/** @type {{type: import('../src/mastra/services/memory-extractor.js').KnowledgeType, title: string, content: string}[]} */
const LESSONS = [
  {
    type: 'prompt_rule',
    title: 'chef: build the Menu Book incrementally, never in one shot',
    content:
      'The "Księga Menu" (Menu Book) grows with the pipeline. After EACH finished phase write the relevant section via chef_document_write_section (rule: write the section FIRST, report AFTER). Never assemble the whole document at the end and never edit the .md by hand — use chef_document_* exclusively (idempotent anchored upsert). Successive recipes use mode:append to prove incrementality.',
  },
  {
    type: 'prompt_rule',
    title: 'chef: set project status on every phase transition',
    content:
      'Call chef_set_project_status on every transition across the 11 states (intake→recon→profile_synthesis→checkpoint_profile→menu_draft→critic_gate→checkpoint_menu→recipes→qa_final→render→done). Skipping a status write loses pipeline resumability/auditability. The two checkpoint_* states MUST go through request_approval before proceeding.',
  },
  {
    type: 'failure_case',
    title: 'chef: do not generate recipes before menu-card approval',
    content:
      'Generating technical recipe cards before checkpoint_menu (request_approval on the menu card) wastes work — the menu may change on review. Gate the recipes phase behind menu approval. Likewise never run profile_synthesis output past checkpoint_profile without sign-off.',
  },
  {
    type: 'failure_case',
    title: 'chef: never scrape directly or let workers write state',
    content:
      'The chef must NOT scrape with Playwright/Tavily/Firecrawl directly — delegate recon to researcherAgent (Mission A menu, Mission B reputation). Workers (run_worker) may reason/draft but must NEVER write to Mongo or the Menu Book; ONLY the chef writes state (single writer = consistency). Never hallucinate a venue\'s menu or reviews — run recon; if a key is missing (e.g. GOOGLE_MAPS_API_KEY) the tool degrades to researcherAgent.',
  },
  {
    type: 'failure_case',
    title: 'chef: verify classic ratios before drafting recipes',
    content:
      'Do not write recipe ratios from memory for canonical preparations (hollandaise, demi-glace, etc.) — query knowledge_query(chef_classic) first. Use metric units only (g, ml); never "a cup"/"a pinch" (exception q.s.). NO HALLUCINATING RATIOS. A critic gate (fresh-eyes worker) validates the menu vs profile before recipes.',
  },
  {
    type: 'tool_contract',
    title: 'chef tools: execute(context) receives validated input directly',
    content:
      'Chef createTool execute signature is `execute: async (context) => { ... context.field ... }` — context IS the validated input object, NOT destructured as {context}. chef_start_project REQUIRES establishmentType (e.g. fine_dining); the created project id is start.project.id. priceRange.tier comes from CHEF_PRICE_TIER_PLN thresholds (default 35,70,130 → budget/mid/premium/luxury): avgMain 75 → premium (luxury needs ≥130).',
  },
  {
    type: 'tool_contract',
    title: 'chef PDF render: GFM tables need a separator row',
    content:
      'chef_document_pdf renders the Menu Book via headless Chromium (env CHEF_CHROME_BIN, default google-chrome-stable) using micromark+GFM. A pipe table renders as a real bordered <table> ONLY if it has the GFM separator row (| --- | --- |). Without it (e.g. "| Składnik | Ilość |" alone) the pipes render as literal text — recipe BOM tables MUST include the |---|---| header divider.',
  },
];

const main = async () => {
  let created = 0;
  let deduped = 0;
  for (const l of LESSONS) {
    const res = await writeKnowledge(l.type, l.title, l.content);
    if (res.deduplicated) deduped++;
    else created++;
    console.log(`${res.deduplicated ? 'updated ' : 'created '} [${l.type}] ${l.title} (${res.knowledgeId})`);
  }
  console.log(`\nDone: ${created} created, ${deduped} updated/deduped, ${LESSONS.length} total.`);
  process.exit(0);
};

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
