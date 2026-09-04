/**
 * Pattern RAG: embeds the pattern catalog to MongoDB and performs semantic search.
 *
 * Tools:
 * - architect.sync_patterns — one-off or after editing catalog.ts. Saves
 *   to `automation_patterns` with embeddings controlled by
 *   model-manifest.ts -> infrastructure.embedding.model.
 * - architect.match_pattern — searches for top-K patterns for a given AutomationSpec.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import {
  EMBEDDING_MODEL_ID,
  generateEmbedding,
  cosineSimilarity,
} from '../../lib/embedder.js';
import {
  PATTERN_CATALOG,
  type StoredAutomationPattern,
} from './pattern-catalog.js';
import { evaluatePatternCoverage } from './capability-coverage.js';

const COLLECTION = 'automation_patterns';
const MIN_SIMILARITY = 0.35;

export const syncPatternsTool = createTool({
  id: 'architect_sync_patterns',
  description:
    'Synchronizes the pattern catalog to MongoDB with semantic embeddings. Invoke after editing pattern-catalog.ts or on first run.',
  inputSchema: z.object({
    force: z
      .boolean()
      .default(false)
      .describe('Force re-embedding of all patterns (even unmodified ones)'),
  }),
  outputSchema: z.object({
    synced: z.number(),
    embedded: z.number(),
    skipped: z.number(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_sync_patterns',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    policy: () => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    const force = context.force ?? false;
    const db = await getDb();
    const col = db.collection<StoredAutomationPattern>(COLLECTION);

    let synced = 0;
    let embedded = 0;
    let skipped = 0;

    for (const p of PATTERN_CATALOG) {
      const existing = await col.findOne({ id: p.id });
      const descChanged = !!existing && existing.description !== p.description;
      const needsEmbedding =
        force ||
        !existing ||
        descChanged ||
        !existing.embedding ||
        existing.embeddingModel !== EMBEDDING_MODEL_ID;

      let embedding = existing?.embedding;
      if (needsEmbedding) {
        try {
          const text = `${p.name}: ${p.description} (Intents: ${p.supportedIntents.join(', ')})`;
          embedding = await generateEmbedding(text);
          embedded++;
        } catch (e) {
          console.warn(`[PatternRAG] sync failed for ${p.id}:`, (e as Error).message);
          skipped++;
          continue;
        }
      }

      const stored: StoredAutomationPattern = {
        id: p.id,
        name: p.name,
        description: p.description,
        risk: p.risk,
        supportedIntents: p.supportedIntents,
        requiredInputs: p.requiredInputs,
        requiredCredentials: p.requiredCredentials,
        forbiddenWithoutApproval: p.forbiddenWithoutApproval,
        executable: p.executable !== false,
        maturity: p.maturity,
        n8nCommunityCompatible: p.n8nCommunityCompatible,
        capabilities: p.capabilities,
        builderId: p.id,
        embedding,
        embeddingModel: embedding ? EMBEDDING_MODEL_ID : existing?.embeddingModel,
        createdAt: existing?.createdAt ?? new Date(),
        updatedAt: new Date(),
      };

      await col.updateOne({ id: p.id }, { $set: stored }, { upsert: true });
      synced++;
    }

    return { synced, embedded, skipped };
    }
  }),
});

export const matchPatternTool = createTool({
  id: 'architect_match_pattern',
	    description:
	    'Searches for the top-K patterns that best match the automation specification. `score` is the final semantic+coverage score; `semanticScore` preserves embedding similarity. Patterns with `coverage.ok=false` are similar but incomplete and should not be deployed as-is.',
  inputSchema: z.object({
    name: z.string().describe('Short name of the task, e.g., "Webhook to CRM"'),
    description: z.string().describe('Description of what the workflow should do'),
    goal: z.string().describe('Business goal'),
    topK: z.number().default(3),
    includeAbstract: z
      .boolean()
      .default(false)
      .describe('If true, also returns abstract patterns as reasoning context (marked with executable: false).'),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        risk: z.enum(['low', 'medium', 'high', 'critical']),
        requiredInputs: z.array(z.string()),
        requiredCredentials: z.array(z.string()),
        forbiddenWithoutApproval: z.boolean(),
        executable: z.boolean(),
        maturity: z.enum(['draft', 'tested', 'production']).optional(),
	        score: z.number(),
	        semanticScore: z.number(),
	        coverageScore: z.number(),
	        finalScore: z.number(),
	        coverage: z.object({
	          ok: z.boolean(),
	          score: z.number(),
	          missingRequired: z.array(z.string()),
	          forbidden: z.array(z.string()).optional(),
	          forbiddenActual: z.array(z.string()).optional(),
	          recommendation: z.enum(['use_pattern', 'delegate_mcp', 'compose_workflow_json', 'block']),
	        }),
	      }),
	    ),
    message: z.string(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_match_pattern',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      target: input.name,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    try {
      const queryText = `${context.name}: ${context.description} ${context.goal}`;
      const queryEmbedding = await generateEmbedding(queryText);

      const db = await getDb();
      const col = db.collection<StoredAutomationPattern>(COLLECTION);
      const stored = await col.find({
        embedding: { $exists: true },
        embeddingModel: EMBEDDING_MODEL_ID,
      }).toArray();

      if (stored.length === 0) {
        return {
          matches: [],
          message: 'No patterns in the database. Run architect.sync_patterns first.',
        };
      }

	      const scored = stored
	        .map((p) => {
	          const semanticScore = cosineSimilarity(queryEmbedding, p.embedding!);
	          const livePattern = PATTERN_CATALOG.find((catalogPattern) => catalogPattern.id === p.id);
	          const coverage = livePattern
	            ? evaluatePatternCoverage({ pattern: livePattern, request: queryText })
	            : {
	                ok: true,
	                score: 1,
	                required: [],
	                actual: [],
	                missingRequired: [],
	                warnings: [],
	                recommendation: 'use_pattern' as const,
	                evidence: [],
	              };
	          const coverageScore = coverage.score;
	          const finalScore = Math.round(((semanticScore * 0.55) + (coverageScore * 0.45)) * 1000) / 1000;
	          return {
	            pattern: p,
	            semanticScore,
	            coverageScore,
	            finalScore,
	            coverage,
	          };
	        })
	        .filter((s) => s.semanticScore >= MIN_SIMILARITY)
	        .filter((s) => context.includeAbstract || s.pattern.executable !== false)
	        .sort((a, b) => b.finalScore - a.finalScore)
	        .slice(0, context.topK);

      const executableCount = scored.filter((s) => s.pattern.executable !== false).length;

      const ALLOWED_MATURITY = new Set(['draft', 'tested', 'production']);

      return {
	        matches: scored.map(({ pattern, semanticScore, coverageScore, finalScore, coverage }) => ({
	          id: pattern.id,
	          name: pattern.name,
	          description: pattern.description,
          risk: pattern.risk,
          requiredInputs: pattern.requiredInputs,
          requiredCredentials: pattern.requiredCredentials,
          forbiddenWithoutApproval: pattern.forbiddenWithoutApproval,
          executable: pattern.executable !== false,
          // MongoDB persists missing fields as `null`; the schema's
          // `z.enum(...).optional()` accepts `undefined` but rejects `null`.
          // Strip null + any unexpected legacy values back to undefined.
	          maturity:
	            pattern.maturity && ALLOWED_MATURITY.has(pattern.maturity) ? pattern.maturity : undefined,
	          score: finalScore,
	          semanticScore,
	          coverageScore,
	          finalScore,
	          coverage: {
	            ok: coverage.ok,
	            score: coverage.score,
	            missingRequired: coverage.missingRequired,
	            recommendation: coverage.recommendation,
	          },
	        })),
	        message:
	          scored.length > 0
	            ? `Found ${scored.length} patterns (${executableCount} executable). Check coverage.ok before composing.`
	            : 'No matches > 0.35 — consider creating a new pattern or refining the description',
      };
    } catch (error) {
      return {
        matches: [],
        message: `RAG error: ${(error as Error).message}`,
      };
    }
    }
  }),
});
