/**
 * Composer: bierze pattern.id + AutomationSpec i zwraca gotowy n8n workflow JSON.
 * Nie deployuje — tylko buduje. Deploy odbywa sie przez architect.deploy_automation.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getPatternById } from './pattern-catalog.js';
import type { AutomationSpec } from './types.js';
import { evaluateWorkflowCoverage, formatCoverageForModel } from './capability-coverage.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

const inputItemSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'url', 'secret', 'json']),
  required: z.boolean(),
  description: z.string(),
  value: z.unknown().optional(),
  defaultValue: z.unknown().optional(),
  url: z.unknown().optional(),
  source: z.enum(['user', 'env', 'runtime', 'derived', 'placeholder']).optional(),
  aliases: z.array(z.string()).optional(),
});

const stepSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  actionType: z.enum([
    'read',
    'transform',
    'condition',
    'notify',
    'write',
    'send',
    'delete',
    'execute',
  ]),
  expectedInput: z.string().optional(),
  expectedOutput: z.string().optional(),
  failureBehavior: z.enum(['stop', 'continue', 'retry', 'notify_user']).optional(),
});

const triggerSchema = z.object({
  type: z.enum(['manual', 'schedule', 'webhook', 'email', 'external_event']),
  schedule: z
    .object({
      frequency: z.enum(['once', 'hourly', 'daily', 'weekly', 'monthly']),
      time: z.string().optional(),
      timezone: z.string(),
      cron: z.string().optional(),
    })
    .optional(),
  webhook: z
    .object({
      method: z.enum(['GET', 'POST']),
      expectedPayloadDescription: z.string(),
    })
    .optional(),
});

const automationSpecSchema = z
  .object({
    id: z.string(),
    requestId: z.string(),
    name: z.string(),
    description: z.string(),
    goal: z.string(),
    trigger: triggerSchema,
    inputs: z.array(inputItemSchema),
    steps: z.array(stepSchema),
    externalServices: z.array(z.string()).optional(),
    credentialsNeeded: z
      .array(
        z.object({
          service: z.string(),
          credentialName: z.string().optional(),
          required: z.boolean(),
          notes: z.string().optional(),
        }),
      )
      .optional(),
    dataPolicy: z
      .object({
        readsExternalData: z.boolean().optional(),
        writesExternalData: z.boolean().optional(),
        sendsMessages: z.boolean().optional(),
        touchesCustomerData: z.boolean().optional(),
        touchesProductionDb: z.boolean().optional(),
        usesPaidApi: z.boolean().optional(),
        usesFileSystem: z.boolean().optional(),
        usesShellCommand: z.boolean().optional(),
      })
      .optional(),
    successCriteria: z.array(z.string()).optional(),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    requiresApproval: z.boolean().optional(),
    missingConfig: z
      .array(
        z.object({
          key: z.string(),
          description: z.string(),
          required: z.boolean(),
        }),
      )
      .optional(),
  })
  .passthrough();

function parseJsonObjectInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced ? fenced[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

const automationSpecInputSchema = z.preprocess(parseJsonObjectInput, automationSpecSchema);

export const composeWorkflowTool = createTool({
  id: 'architect_compose_workflow',
  description:
    'Composes an n8n workflow JSON from the selected pattern and specification. After composing, you MUST call architect.risk_score on the result before deploying.',
  inputSchema: z.object({
    patternId: z.string().describe('Pattern ID from the catalog (e.g. "webhook-validate-respond")'),
    spec: automationSpecInputSchema,
    workflowName: z
      .string()
      .optional()
      .describe('Name of the workflow in n8n. Defaults to spec.name.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    workflow: z
      .object({
        name: z.string(),
        nodes: z.array(z.unknown()),
        connections: z.record(z.string(), z.unknown()),
        settings: z.record(z.string(), z.unknown()),
        active: z.boolean(),
      })
      .optional(),
	    patternId: z.string(),
	    reason: z.string().optional(),
	    coverage: z.any().optional(),
	    message: z.string(),
    error: z.string().optional(),
    missingConfig: z
      .array(
        z.object({
          key: z.string(),
          description: z.string(),
          required: z.boolean(),
        }),
      )
      .optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_compose_workflow',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['spec'],
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      target: input.patternId,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    try {
      const spec = context.spec as AutomationSpec;
      const pattern = getPatternById(context.patternId);
      if (!pattern) {
        return {
          success: false,
          patternId: context.patternId,
          message: `Pattern not found: ${context.patternId}. Call architect.match_pattern to find available ones.`,
        };
      }

      // Pattern governance: refuse to compose abstract / knowledge-only patterns.
      // These exist as documentation in the catalog but do not produce a deployable
      // workflow JSON. Treat undefined as executable=true (legacy default).
      if (pattern.executable === false) {
        return {
          success: false,
          patternId: context.patternId,
          message: `Pattern "${pattern.id}" is abstract (executable=false, maturity=${pattern.maturity ?? 'draft'}). Use it as a reasoning context, not as an executable workflow. Choose another pattern from architect.match_pattern.`,
        };
      }

      // Walidacja wymaganych inputow: kazdy alias z pattern.requiredInputs
      // powinien pasowac do nazwy ktoregos ze spec.inputs[].name (case-insensitive,
      // substring match — taka sama logika jak w jarvis findInput) I miec wartosc.
      const specInputs = (spec.inputs ?? []) as Array<{
        name: string;
        value?: any;
        defaultValue?: any;
        url?: any;
        aliases?: string[];
      }>;
      const missing = pattern.requiredInputs.filter((alias) => {
        const a = alias.toLowerCase();
        const found = specInputs.find(
          (i) => {
            const name = i.name.toLowerCase();
            return (
              name.includes(a) ||
              a.includes(name) ||
              (i.aliases &&
                i.aliases.some((al) => {
                  const inputAlias = al.toLowerCase();
                  return inputAlias.includes(a) || a.includes(inputAlias);
                }))
            );
          },
        );

        if (!found) return true;

        const val = found.value ?? found.defaultValue ?? found.url;
        return val === undefined || val === null || val === '';
      });

      if (missing.length > 0) {
        const missingConfig = missing.map((key) => ({
          key,
          description: `Required input value for pattern "${pattern.id}"`,
          required: true,
        }));
        return {
          success: false,
          patternId: context.patternId,
          message: `Missing required input values: ${missing.join(', ')}`,
          missingConfig,
        };
      }

      const built = pattern.build(spec);

      const nodes = (built.nodes as Array<{ name?: string }>) ?? [];
      const rawConnections =
        built.connections && typeof built.connections === 'object' && !Array.isArray(built.connections)
          ? (built.connections as Record<string, unknown>)
          : {};

      // Sanity check: connection source keys MUST match a node name exactly.
      // n8n is strict — even a stray apostrophe or space mismatch makes the
      // workflow unrunnable. Fail loud here so the agent doesn't ship junk.
      const nodeNames = new Set(nodes.map((n) => n?.name).filter(Boolean));
      const danglingKeys = Object.keys(rawConnections).filter((k) => !nodeNames.has(k));
      if (danglingKeys.length > 0) {
        return {
          success: false,
          patternId: context.patternId,
          message: `Pattern builder "${pattern.id}" produced connections pointing to non-existent nodes: ${danglingKeys.join(', ')}. Names in connections must exactly match node.name (no quotes, apostrophes, or extra spaces).`,
          error: 'connection_keys_do_not_match_node_names',
        };
      }

	      const workflow = {
	        name: context.workflowName ?? spec.name,
	        nodes,
	        connections: rawConnections,
	        settings: (built.settings as Record<string, unknown>) ?? {},
	        active: false, // ZAWSZE inactive — patrz prompt automation/base.md
	      };

	      const coverage = evaluateWorkflowCoverage({
	        spec,
	        request: `${spec.name}\n${spec.description}\n${spec.goal}`,
	        workflow,
	      });
	      if (!coverage.ok) {
	        return {
	          success: false,
	          patternId: context.patternId,
	          reason: 'pattern_coverage_gap',
	          coverage,
	          message: `Pattern "${pattern.id}" does not cover the spec: ${formatCoverageForModel(coverage)}. Delegate to n8nMcpEngineer or compose custom workflow_json and rerun Golden Path.`,
	        };
	      }

	      return {
	        success: true,
	        workflow,
	        patternId: context.patternId,
	        coverage,
	        message: `Workflow composed from pattern "${pattern.name}". Next step: architect.risk_score.`,
	      };
    } catch (error) {
      return {
        success: false,
        patternId: context.patternId,
        message: 'Error composing workflow',
        error: (error as Error).message,
      };
    }
    }
  }),
});
