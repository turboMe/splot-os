/**
 * Workflow: automation-client-hunt-strategy
 *
 * 6-step DAG for finding, qualifying, and preparing outreach for potential
 * automation clients. Uses the `automation-client-hunt-strategy` skill for
 * ICP definitions, Tavily query patterns, scoring rules, and cold email templates.
 *
 * Steps:
 *   01 discover-leads         — 3 parallel Tavily searches using ICP × query patterns
 *   02 dedup-and-crm-check    — deduplicate results, filter out existing CRM leads
 *   03 enrich-and-qualify      — score & enrich leads using skill scoring rules
 *   04 generate-cold-emails   — parallel LLM workers generate personalized emails
 *   05 create-crm-and-drafts  — CRM lead creation + Gmail draft + link draft to CRM
 *   06 report-and-memory      — Markdown summary + memory write
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { marketingAgent } from '../agents/marketing-agent';
import { searchWebTool } from '../tools/search/tavily.js';
import { GmailService } from '../tools/google/gmail.js';
import { getDb } from '../lib/mongo';

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;

/**
 * Retry wrapper — retries a function up to `MAX_RETRIES` times on failure.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const delay = 1000 * (attempt + 1);
        console.warn(
          `[automation-client-hunt-strategy] ${label} attempt ${attempt + 1}/${retries + 1} failed: ${lastError.message}. Retrying in ${delay}ms…`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

/**
 * Extract JSON from LLM text that may contain markdown fences.
 */
const extractJsonText = (text: string): string => {
  const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (match) return match[1];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) return text.slice(objStart, objEnd + 1);
  return text;
};

const tryParseJson = <T = unknown>(text: string): T | null => {
  try {
    return JSON.parse(extractJsonText(text));
  } catch {
    return null;
  }
};

// ── Schemas ──────────────────────────────────────────────────────────────────

const prospectSchema = z.object({
  company_name: z.string(),
  website: z.string(),
  source_url: z.string().optional().default(''),
  quality_score: z.number().default(0),
  use_case_idea: z.string().default(''),
  estimated_hours_saved_per_month: z.number().optional().default(0),
  subject_line: z.string().default(''),
  email_body: z.string().default(''),
});
type Prospect = z.infer<typeof prospectSchema>;

const qualifiedLeadSchema = prospectSchema.extend({
  contact_name: z.string().optional().default(''),
});
type QualifiedLead = z.infer<typeof qualifiedLeadSchema>;

const draftResultSchema = z.object({
  company_name: z.string(),
  website: z.string(),
  email_body: z.string(),
  subject_line: z.string(),
  crmLeadId: z.string().optional(),
  gmailDraftId: z.string().optional(),
});

// ── ICP & Query Patterns (from skill YAML) ──────────────────────────────────

const ICP_SEGMENTS = [
  'firmy produkcyjne z polski',
  'e-commerce B2C z własnym magazynem',
  "software house'y z procesami CI/CD",
  'agencje marketingowe z powtarzalnymi raportami',
  'firmy z branży logistycznej i spedycyjnej',
];

const QUERY_TEMPLATES = [
  '{icp} case study automatyzacja procesów',
  '{icp} wdrożenie systemu ERP',
  '{icp} optymalizacja logistyki',
  'nowoczesne rozwiązania dla {icp}',
  '{icp} zatrudnia specjalista ds. automatyzacji',
  '{icp} problemy z wydajnością',
];

const SCORING_RULES = [
  { keyword: 'automatyzacj', delta: 3 },
  { keyword: 'optymalizacj', delta: 3 },
  { keyword: 'ERP', delta: 3 },
  { keyword: 'workflow', delta: 3 },
  { keyword: 'case stud', delta: 1 },
  { keyword: 'portfolio', delta: 1 },
];

/**
 * Build a set of Tavily queries for a given ICP segment.
 */
function buildQueries(icpSegment: string): string[] {
  return QUERY_TEMPLATES.map((t) => t.replace('{icp}', icpSegment));
}

/**
 * Simple keyword-based scoring based on the skill's scoring rules.
 */
function scoreFromContent(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const rule of SCORING_RULES) {
    if (lower.includes(rule.keyword.toLowerCase())) score += rule.delta;
  }
  return score;
}

// ── Step 01: Discovery ──────────────────────────────────────────────────────

interface SearchHit {
  title: string;
  url: string;
  content: string;
}

const discoverLeadsStep = createStep({
  id: 'discover-leads',
  description:
    'Runs 3 parallel discovery workers using Tavily web search across ICP segments and query patterns.',
  inputSchema: z.object({
    maxResultsPerQuery: z.number().default(5),
    icpOverride: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    rawHits: z.array(
      z.object({
        company_name: z.string(),
        website: z.string(),
        source_url: z.string(),
        snippet: z.string(),
        icp_segment: z.string(),
      }),
    ),
    totalHits: z.number(),
    queriesIssued: z.number(),
  }),
  execute: async (context) => {
    const taskId = randomUUID().slice(0, 8);
    const maxResults = context.inputData.maxResultsPerQuery;
    const segments = context.inputData.icpOverride ?? ICP_SEGMENTS;

    // Split ICP segments into 3 worker groups
    const workerGroups: string[][] = [[], [], []];
    segments.forEach((seg, i) => workerGroups[i % 3].push(seg));

    const accumulatedHits = new Map<
      string,
      { company_name: string; website: string; source_url: string; snippet: string; icp_segment: string }
    >();
    let queriesIssued = 0;

    // Run 3 parallel workers
    const workerResults = await Promise.allSettled(
      workerGroups.map(async (group, workerIdx) => {
        for (const segment of group) {
          const queries = buildQueries(segment);
          for (const query of queries) {
            try {
              queriesIssued++;
              const res = await withRetry(
                () => searchWebTool.execute!({ query, maxResults }, {} as any),
                `discover-w${workerIdx}-tavily`,
              );
              if (res && 'success' in res && (res as any).success) {
                for (const hit of ((res as any).results ?? []) as SearchHit[]) {
                  if (!accumulatedHits.has(hit.url)) {
                    // Extract company name from title or URL
                    const companyName =
                      hit.title?.split(/[–—|-]/)[0]?.trim() ||
                      new URL(hit.url).hostname.replace('www.', '').split('.')[0];
                    accumulatedHits.set(hit.url, {
                      company_name: companyName,
                      website: hit.url,
                      source_url: hit.url,
                      snippet: (hit.content ?? '').slice(0, 500),
                      icp_segment: segment,
                    });
                  }
                }
              }
            } catch (err) {
              console.warn(
                `[automation-client-hunt-strategy:${taskId}] discover worker ${workerIdx} query failed: ${(err as Error).message}`,
              );
            }
          }
        }
      }),
    );

    console.log(
      `[automation-client-hunt-strategy:${taskId}] discovery: ${workerResults.length} workers, ${accumulatedHits.size} unique hits from ${queriesIssued} queries`,
    );

    return {
      taskId,
      rawHits: Array.from(accumulatedHits.values()),
      totalHits: accumulatedHits.size,
      queriesIssued,
    };
  },
});

// ── Step 02: Deduplication & CRM Check ──────────────────────────────────────

const dedupAndCrmCheckStep = createStep({
  id: 'dedup-and-crm-check',
  description:
    'Deduplicates discovered companies and filters out those already in the CRM.',
  inputSchema: z.object({
    taskId: z.string(),
    rawHits: z.array(
      z.object({
        company_name: z.string(),
        website: z.string(),
        source_url: z.string(),
        snippet: z.string(),
        icp_segment: z.string(),
      }),
    ),
    totalHits: z.number(),
    queriesIssued: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    newProspects: z.array(
      z.object({
        company_name: z.string(),
        website: z.string(),
        source_url: z.string(),
        snippet: z.string(),
        icp_segment: z.string(),
      }),
    ),
    filteredCount: z.number(),
    existingInCrm: z.number(),
  }),
  execute: async (context) => {
    const { taskId, rawHits } = context.inputData;
    const db = await getDb();

    // Deduplicate by normalised domain
    const seen = new Map<
      string,
      (typeof rawHits)[number]
    >();
    for (const hit of rawHits) {
      try {
        const domain = new URL(
          hit.website.startsWith('http') ? hit.website : `https://${hit.website}`,
        ).hostname
          .replace('www.', '')
          .toLowerCase();
        if (!seen.has(domain)) seen.set(domain, hit);
      } catch {
        // Malformed URL — skip
      }
    }

    const unique = Array.from(seen.values());
    const newProspects: typeof unique = [];
    let existingInCrm = 0;

    for (const prospect of unique) {
      try {
        // Check CRM by company name (case-insensitive partial match)
        const existing = await db.collection('leads').findOne({
          $or: [
            { companyName: { $regex: new RegExp(prospect.company_name.slice(0, 30), 'i') } },
            { website: { $regex: new RegExp(prospect.website.replace(/https?:\/\//, '').split('/')[0], 'i') } },
          ],
        });
        if (existing) {
          existingInCrm++;
          continue;
        }
        newProspects.push(prospect);
      } catch (err) {
        console.warn(
          `[automation-client-hunt-strategy:${taskId}] CRM check fail for ${prospect.company_name}: ${(err as Error).message}`,
        );
        // On CRM error, include the prospect anyway
        newProspects.push(prospect);
      }
    }

    console.log(
      `[automation-client-hunt-strategy:${taskId}] dedup: ${rawHits.length} → ${unique.length} unique → ${newProspects.length} new (${existingInCrm} already in CRM)`,
    );

    return {
      taskId,
      newProspects,
      filteredCount: newProspects.length,
      existingInCrm,
    };
  },
});

// ── Step 03: Enrichment & Qualification ─────────────────────────────────────

const enrichAndQualifyStep = createStep({
  id: 'enrich-and-qualify',
  description:
    'Scores and enriches new prospects using keyword analysis and LLM-based qualification.',
  inputSchema: z.object({
    taskId: z.string(),
    newProspects: z.array(
      z.object({
        company_name: z.string(),
        website: z.string(),
        source_url: z.string(),
        snippet: z.string(),
        icp_segment: z.string(),
      }),
    ),
    filteredCount: z.number(),
    existingInCrm: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    qualifiedLeads: z.array(qualifiedLeadSchema),
    qualifiedCount: z.number(),
    droppedCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, newProspects } = context.inputData;
    const qualifiedLeads: QualifiedLead[] = [];
    const MINIMUM_SCORE = 2;

    for (const prospect of newProspects) {
      // Keyword scoring from snippet
      const keywordScore = scoreFromContent(prospect.snippet);

      // Use LLM for deeper qualification if initial score looks promising
      let llmScore = 0;
      let useCaseIdea = '';
      let estimatedHours = 0;

      if (keywordScore >= 1) {
        try {
          const qualifyPrompt = `Jesteś ekspertem ds. automatyzacji procesów biznesowych.
Przeanalizuj tę firmę i oceń potencjał automatyzacji:

Firma: ${prospect.company_name}
Strona: ${prospect.website}
Segment ICP: ${prospect.icp_segment}
Opis: ${prospect.snippet}

Zwróć JSON:
{
  "quality_score": <0-10>,
  "use_case_idea": "<krótki opis przypadku użycia automatyzacji>",
  "estimated_hours_saved": <szacunkowe godziny oszczędności/miesiąc>,
  "contact_name": "<imię osoby kontaktowej jeśli widoczne, lub puste>"
}`;

          const result = await withRetry(
            () => marketingAgent.generate(qualifyPrompt),
            `enrich-qualify-${prospect.company_name}`,
          );
          const parsed = tryParseJson<{
            quality_score?: number;
            use_case_idea?: string;
            estimated_hours_saved?: number;
            contact_name?: string;
          }>(result.text);

          if (parsed) {
            llmScore = parsed.quality_score ?? 0;
            useCaseIdea = parsed.use_case_idea ?? '';
            estimatedHours = parsed.estimated_hours_saved ?? 0;
          }
        } catch (err) {
          console.warn(
            `[automation-client-hunt-strategy:${taskId}] LLM enrich fail for ${prospect.company_name}: ${(err as Error).message}`,
          );
        }
      }

      const totalScore = keywordScore + llmScore;
      if (totalScore >= MINIMUM_SCORE) {
        qualifiedLeads.push({
          company_name: prospect.company_name,
          website: prospect.website,
          source_url: prospect.source_url,
          quality_score: totalScore,
          use_case_idea: useCaseIdea || `Automatyzacja procesów w segmencie: ${prospect.icp_segment}`,
          estimated_hours_saved_per_month: estimatedHours,
          subject_line: '',
          email_body: '',
          contact_name: '',
        });
      }
    }

    console.log(
      `[automation-client-hunt-strategy:${taskId}] qualify: ${newProspects.length} → ${qualifiedLeads.length} qualified`,
    );

    return {
      taskId,
      qualifiedLeads,
      qualifiedCount: qualifiedLeads.length,
      droppedCount: newProspects.length - qualifiedLeads.length,
    };
  },
});

// ── Step 04: Cold Email Generation ──────────────────────────────────────────

const generateColdEmailsStep = createStep({
  id: 'generate-cold-emails',
  description:
    'Generates personalized cold emails for each qualified lead using the skill template and parallel LLM workers.',
  inputSchema: z.object({
    taskId: z.string(),
    qualifiedLeads: z.array(qualifiedLeadSchema),
    qualifiedCount: z.number(),
    droppedCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    leadsWithEmails: z.array(qualifiedLeadSchema),
    generatedCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, qualifiedLeads } = context.inputData;

    if (qualifiedLeads.length === 0) {
      return { taskId, leadsWithEmails: [], generatedCount: 0 };
    }

    // Process leads in parallel batches of 3
    const BATCH_SIZE = 3;
    const results: QualifiedLead[] = [];

    for (let i = 0; i < qualifiedLeads.length; i += BATCH_SIZE) {
      const batch = qualifiedLeads.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (lead) => {
          const emailPrompt = `Jesteś Patrykiem z GastroBridge. Napisz spersonalizowany cold email do potencjalnego klienta automatyzacji.

Firma: ${lead.company_name}
Strona: ${lead.website}
Potencjalny use-case: ${lead.use_case_idea}
Szacowane oszczędności: ~${lead.estimated_hours_saved_per_month}h/miesiąc

SZABLON (dostosuj, nie kopiuj dosłownie):
---
Temat: Pomysł na automatyzację w {company_name}

Cześć {contact_name},

Nazywam się Patryk i w GastroBridge pomagamy firmom takim jak {company_name} automatyzować powtarzalne procesy.

Zauważyłem, że [WSTAW SPOSTRZEŻENIE].

Czy zastanawialiście się kiedyś, ile czasu i zasobów moglibyście zaoszczędzić przez automatyzację [WSTAW OBSZAR]?

Chętnie przygotuję dla Was bezpłatną, krótką analizę potencjalnych usprawnień. Czy znajdziecie Państwo 15 minut w przyszłym tygodniu na rozmowę?

Pozdrawiam,
Patryk
---

Zwróć JSON: { "subject_line": "...", "email_body": "..." }
Nie używaj markdown w email_body — czysty tekst z akapitami.`;

          try {
            const result = await withRetry(
              () => marketingAgent.generate(emailPrompt),
              `email-gen-${lead.company_name}`,
            );
            const parsed = tryParseJson<{ subject_line?: string; email_body?: string }>(
              result.text,
            );
            return {
              ...lead,
              subject_line: parsed?.subject_line ?? `Pomysł na automatyzację w ${lead.company_name}`,
              email_body:
                parsed?.email_body ??
                `Cześć,\n\nNazywam się Patryk i w GastroBridge pomagamy firmom takim jak ${lead.company_name} automatyzować powtarzalne procesy.\n\nChętnie przygotuję dla Was bezpłatną analizę potencjalnych usprawnień.\n\nPozdrawiam,\nPatryk`,
            };
          } catch (err) {
            console.warn(
              `[automation-client-hunt-strategy:${taskId}] email gen fail for ${lead.company_name}: ${(err as Error).message}`,
            );
            // Fallback: use template directly
            return {
              ...lead,
              subject_line: `Pomysł na automatyzację w ${lead.company_name}`,
              email_body: `Cześć,\n\nNazywam się Patryk i w GastroBridge pomagamy firmom takim jak ${lead.company_name} automatyzować powtarzalne procesy.\n\nZauważyłem, że ${lead.use_case_idea}. Czy zastanawialiście się kiedyś, ile czasu moglibyście zaoszczędzić?\n\nChętnie przygotuję dla Was bezpłatną, krótką analizę potencjalnych usprawnień. Czy znajdziecie Państwo 15 minut w przyszłym tygodniu na rozmowę?\n\nPozdrawiam,\nPatryk`,
            };
          }
        }),
      );

      for (const res of batchResults) {
        if (res.status === 'fulfilled') {
          results.push(res.value);
        }
      }
    }

    console.log(
      `[automation-client-hunt-strategy:${taskId}] email gen: ${results.length}/${qualifiedLeads.length} emails generated`,
    );

    return {
      taskId,
      leadsWithEmails: results,
      generatedCount: results.length,
    };
  },
});

// ── Step 05: CRM & Gmail Draft Creation ─────────────────────────────────────

const createCrmAndDraftsStep = createStep({
  id: 'create-crm-and-drafts',
  description:
    'Creates CRM leads, Gmail drafts, and links draft IDs to CRM records.',
  inputSchema: z.object({
    taskId: z.string(),
    leadsWithEmails: z.array(qualifiedLeadSchema),
    generatedCount: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    results: z.array(draftResultSchema),
    crmCreated: z.number(),
    draftsCreated: z.number(),
    errors: z.number(),
  }),
  execute: async (context) => {
    const { taskId, leadsWithEmails } = context.inputData;
    const db = await getDb();
    const now = new Date();
    let gmail: GmailService | null = null;
    const results: z.infer<typeof draftResultSchema>[] = [];
    let crmCreated = 0;
    let draftsCreated = 0;
    let errors = 0;

    for (const lead of leadsWithEmails) {
      let crmLeadId: string | undefined;
      let gmailDraftId: string | undefined;

      // 1. Create CRM lead
      try {
        const leadId = randomUUID().slice(0, 12);
        await db.collection('leads').insertOne({
          id: leadId,
          companyName: lead.company_name,
          website: lead.website,
          status: 'nowy',
          segment: 'automation-prospect',
          source: 'automation-client-hunt-strategy',
          metadata: {
            quality_score: lead.quality_score,
            use_case_idea: lead.use_case_idea,
            estimated_hours_saved: lead.estimated_hours_saved_per_month,
            source_url: lead.source_url,
            taskId,
          },
          createdAt: now,
          updatedAt: now,
          history: [
            {
              action: 'lead_created',
              description: `Lead z automation-client-hunt (score: ${lead.quality_score})`,
              agentId: 'automation-client-hunt-strategy-workflow',
              timestamp: now,
            },
          ],
        });
        crmLeadId = leadId;
        crmCreated++;
      } catch (err) {
        console.warn(
          `[automation-client-hunt-strategy:${taskId}] CRM create fail for ${lead.company_name}: ${(err as Error).message}`,
        );
        errors++;
      }

      // 2. Create Gmail draft
      try {
        gmail ??= await GmailService.create();
        gmailDraftId = await gmail.createDraft({
          to: '', // No email address available — draft will be completed manually
          subject: lead.subject_line,
          body: lead.email_body,
        });
        draftsCreated++;
        console.log(
          `[automation-client-hunt-strategy:${taskId}] gmail draft created id=${gmailDraftId} for ${lead.company_name}`,
        );
      } catch (err) {
        console.warn(
          `[automation-client-hunt-strategy:${taskId}] Gmail draft fail for ${lead.company_name}: ${(err as Error).message}`,
        );
        errors++;
      }

      // 3. Link draft to CRM record
      if (crmLeadId && gmailDraftId) {
        try {
          await db.collection('leads').updateOne(
            { id: crmLeadId },
            {
              $set: {
                status: 'draft_gotowy',
                'metadata.draft': {
                  subject: lead.subject_line,
                  gmailDraftId,
                  createdAt: now.toISOString(),
                },
                updatedAt: now,
              },
              $push: {
                history: {
                  action: 'draft_created',
                  description: `Gmail draft (id=${gmailDraftId}) created`,
                  agentId: 'automation-client-hunt-strategy-workflow',
                  timestamp: now,
                } as any,
              },
            },
          );
        } catch (err) {
          console.warn(
            `[automation-client-hunt-strategy:${taskId}] CRM draft link fail: ${(err as Error).message}`,
          );
        }
      }

      results.push({
        company_name: lead.company_name,
        website: lead.website,
        email_body: lead.email_body,
        subject_line: lead.subject_line,
        crmLeadId,
        gmailDraftId,
      });
    }

    console.log(
      `[automation-client-hunt-strategy:${taskId}] CRM+drafts: ${crmCreated} CRM leads, ${draftsCreated} Gmail drafts, ${errors} errors`,
    );

    return { taskId, results, crmCreated, draftsCreated, errors };
  },
});

// ── Step 06: Reporting & Memory ─────────────────────────────────────────────

const reportAndMemoryStep = createStep({
  id: 'report-and-memory',
  description:
    'Generates a Markdown summary report and persists a summary to MongoDB for memory recall.',
  inputSchema: z.object({
    taskId: z.string(),
    results: z.array(draftResultSchema),
    crmCreated: z.number(),
    draftsCreated: z.number(),
    errors: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    report: z.string(),
    memorySaved: z.boolean(),
  }),
  execute: async (context) => {
    const { taskId, results, crmCreated, draftsCreated, errors } = context.inputData;
    const now = new Date();

    // Build Markdown report
    const companySummaries = results
      .map(
        (r) =>
          `| ${r.company_name} | ${r.website} | ${r.crmLeadId ?? '—'} | ${r.gmailDraftId ?? '—'} |`,
      )
      .join('\n');

    const report = `# Automation Client Hunt — Report
**Task ID:** ${taskId}
**Date:** ${now.toISOString()}

## Summary
- **Leads created in CRM:** ${crmCreated}
- **Gmail drafts created:** ${draftsCreated}
- **Errors:** ${errors}
- **Total prospects processed:** ${results.length}

## Prospects

| Company | Website | CRM Lead ID | Gmail Draft ID |
|---------|---------|-------------|----------------|
${companySummaries}

---
*Generated by automation-client-hunt-strategy workflow*
`;

    // Persist summary to MongoDB (memory)
    let memorySaved = false;
    try {
      const db = await getDb();
      await db.collection('workflow_runs').insertOne({
        workflowId: 'automation-client-hunt-strategy',
        taskId,
        type: 'automation-client-hunt-strategy',
        summary: {
          crmCreated,
          draftsCreated,
          errors,
          totalProspects: results.length,
          companies: results.map((r) => r.company_name),
        },
        report,
        createdAt: now,
      });
      memorySaved = true;
      console.log(
        `[automation-client-hunt-strategy:${taskId}] report saved to workflow_runs collection`,
      );
    } catch (err) {
      console.warn(
        `[automation-client-hunt-strategy:${taskId}] memory save fail: ${(err as Error).message}`,
      );
    }

    return { taskId, report, memorySaved };
  },
});

// ── Workflow Definition ─────────────────────────────────────────────────────

export const automationClientHuntStrategyWorkflow = createWorkflow({
  id: 'automation-client-hunt-strategy',
  description:
    'Wyszukuje potencjalnych klientów automatyzacji (6-step): discovery → dedup+CRM → enrich → cold-email → CRM+Gmail drafts → report.',
  inputSchema: z.object({
    maxResultsPerQuery: z.number().default(5),
    icpOverride: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    report: z.string(),
    memorySaved: z.boolean(),
  }),
})
  .then(discoverLeadsStep)
  .then(dedupAndCrmCheckStep)
  .then(enrichAndQualifyStep)
  .then(generateColdEmailsStep)
  .then(createCrmAndDraftsStep)
  .then(reportAndMemoryStep);

automationClientHuntStrategyWorkflow.commit();
