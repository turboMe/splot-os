/**
 * Mongo Telemetry Exporter (Faza 7.6 — Sprint 3).
 *
 * Hooks into Mastra's native ObservabilityExporter pipeline. Receives all
 * SPAN_STARTED / SPAN_ENDED events and persists agent lifecycle to
 * the `agent_events` MongoDB collection — feeding the dashboard.
 *
 * Strategy:
 *   1. SPAN_STARTED + AGENT_RUN  → cache agentId per traceId
 *   2. SPAN_ENDED + MODEL_GEN    → accumulate inputTokens/outputTokens + lastModel per traceId
 *   3. SPAN_ENDED + TOOL_CALL    → emit `tool_called` / `tool_error` event
 *   4. SPAN_ENDED + AGENT_RUN    → emit `task_completed` / `task_failed` with aggregated tokens, cleanup
 *
 * The exporter is fire-and-forget — failures are logged but never thrown back to the agent runtime.
 */
import { BaseExporter } from '@mastra/observability';
import type { TracingEvent } from '@mastra/core/observability';
import { logAgentEvent } from '../lib/agent-event-log.js';

// String constants matching SpanType enum values from @mastra/core.
// Avoids runtime enum import issues across module boundaries.
const SPAN_TYPE = {
  AGENT_RUN: 'agent_run',
  MODEL_GENERATION: 'model_generation',
  TOOL_CALL: 'tool_call',
} as const;

/**
 * Mastra's tool-input validation envelope, returned AS the tool result:
 * `{ error: true, message, validationErrors }` (see `validateToolInput`).
 *
 * Structural check only — `error === true` plus the `validationErrors` field.
 * Deliberately NOT a string search for "error"/"failed" in free text, which
 * would reclassify benign output such as `"failedSteps: 0"`. Kept local rather
 * than imported from the reflector so this hot telemetry path stays
 * dependency-light.
 */
function validationFailureEnvelope(output: unknown): { message?: unknown } | null {
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  if (record.error === true && 'validationErrors' in record) return record;
  return null;
}

function isValidationFailureOutput(output: unknown): boolean {
  return validationFailureEnvelope(output) !== null;
}

function validationFailureMessage(output: unknown): string | undefined {
  const message = validationFailureEnvelope(output)?.message;
  return typeof message === 'string' ? message : undefined;
}

const EVENT_TYPE = {
  SPAN_STARTED: 'span_started',
  SPAN_ENDED: 'span_ended',
} as const;

interface TraceAccumulator {
  agentId?: string;
  agentName?: string;
  promptTokens: number;
  completionTokens: number;
  lastModel?: string;
  toolCallCount: number;
  toolErrorCount: number;
  expiresAt: number;
}

const TRACE_TTL_MS = 10 * 60 * 1000;             // 10 min — abandons traces with no SPAN_ENDED
const CLEANUP_INTERVAL_MS = 60 * 1000;           // Sweep stale traces every 60s
const MAX_TRACES_IN_MEMORY = 1000;               // Hard ceiling to prevent leaks

export class MongoTelemetryExporter extends BaseExporter {
  name = 'mongo-telemetry';
  private readonly traces = new Map<string, TraceAccumulator>();
  private lastCleanup = Date.now();

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    try {
      const span = event.exportedSpan;
      const traceId = span.traceId;
      if (!traceId) return;

      // Lightweight periodic cleanup
      if (Date.now() - this.lastCleanup > CLEANUP_INTERVAL_MS) this.cleanupStaleTraces();

      // Track AGENT_RUN start to capture agentId before tool/model child spans complete
      if (event.type === EVENT_TYPE.SPAN_STARTED && span.type === SPAN_TYPE.AGENT_RUN) {
        this.upsertAcc(traceId, {
          agentId: span.entityId,
          agentName: span.entityName,
        });
        return;
      }

      if (event.type !== EVENT_TYPE.SPAN_ENDED) return;

      switch (span.type) {
        case SPAN_TYPE.MODEL_GENERATION: {
          const attrs = (span.attributes ?? {}) as {
            model?: string;
            usage?: { inputTokens?: number; outputTokens?: number };
          };
          this.upsertAcc(traceId, {
            promptTokensDelta: attrs.usage?.inputTokens ?? 0,
            completionTokensDelta: attrs.usage?.outputTokens ?? 0,
            lastModel: attrs.model,
          });
          break;
        }

        case SPAN_TYPE.TOOL_CALL: {
          const acc = this.getAcc(traceId);
          // Mastra RETURNS an input-validation failure as the tool result instead
          // of throwing, so `errorInfo` is empty and such a call used to be
          // recorded as a plain success. That made a real failure invisible:
          // measured 2026-08-19, one run logged 145 consecutive
          // `chefDraftRecipeTool` calls as `status: "success"` while every one of
          // them had rejected empty arguments and saved nothing.
          const isError = Boolean(span.errorInfo) || isValidationFailureOutput(span.output);
          const durationMs = this.durationOf(span);
          const toolId = span.entityName || span.name || 'unknown';

          if (acc) {
            if (isError) acc.toolErrorCount++;
            else acc.toolCallCount++;
          }

          await logAgentEvent({
            type: isError ? 'tool_error' : 'tool_called',
            agentId: acc?.agentId || acc?.agentName || 'unknown',
            taskId: traceId,
            toolId,
            status: isError ? 'error' : 'success',
            durationMs,
            errorMessage: this.errorMessageOf(span),
            input: this.stringifyPayload(span.input),
            output: this.stringifyPayload(span.output),
            ...(acc?.lastModel ? { model: acc.lastModel } : {}),
          });
          break;
        }

        case SPAN_TYPE.AGENT_RUN: {
          const acc = this.traces.get(traceId);
          const isError = Boolean(span.errorInfo);
          const durationMs = this.durationOf(span);
          const agentId = span.entityId || span.entityName || acc?.agentId || acc?.agentName || 'unknown';

          await logAgentEvent({
            type: isError ? 'task_failed' : 'task_completed',
            agentId,
            taskId: traceId,
            status: isError ? 'error' : 'success',
            durationMs,
            errorMessage: this.errorMessageOf(span),
            input: this.stringifyPayload(span.input),
            output: this.stringifyPayload(span.output),
            ...(acc?.lastModel ? { model: acc.lastModel } : {}),
            ...(acc && (acc.promptTokens > 0 || acc.completionTokens > 0)
              ? { tokenUsage: { prompt: acc.promptTokens, completion: acc.completionTokens } }
              : {}),
            metadata: {
              ...(acc?.toolCallCount ? { toolCalls: acc.toolCallCount } : {}),
              ...(acc?.toolErrorCount ? { toolErrors: acc.toolErrorCount } : {}),
            },
          });

          // Done — release accumulator
          this.traces.delete(traceId);
          break;
        }

        default:
          // Other span types (workflow, scorer, processor, memory…) ignored for now.
          break;
      }
    } catch (err) {
      // Telemetry must never break the runtime
      this.logger?.warn?.(`[MongoTelemetryExporter] export failed: ${(err as Error).message}`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private upsertAcc(
    traceId: string,
    patch: {
      agentId?: string;
      agentName?: string;
      promptTokensDelta?: number;
      completionTokensDelta?: number;
      lastModel?: string;
    },
  ): void {
    if (this.traces.size >= MAX_TRACES_IN_MEMORY) this.cleanupStaleTraces();

    const existing = this.traces.get(traceId);
    const acc: TraceAccumulator = existing ?? {
      promptTokens: 0,
      completionTokens: 0,
      toolCallCount: 0,
      toolErrorCount: 0,
      expiresAt: Date.now() + TRACE_TTL_MS,
    };

    if (patch.agentId !== undefined) acc.agentId = patch.agentId;
    if (patch.agentName !== undefined) acc.agentName = patch.agentName;
    if (patch.lastModel !== undefined) acc.lastModel = patch.lastModel;
    if (patch.promptTokensDelta) acc.promptTokens += patch.promptTokensDelta;
    if (patch.completionTokensDelta) acc.completionTokens += patch.completionTokensDelta;
    acc.expiresAt = Date.now() + TRACE_TTL_MS;

    this.traces.set(traceId, acc);
  }

  private getAcc(traceId: string): TraceAccumulator | undefined {
    return this.traces.get(traceId);
  }

  private durationOf(span: { startTime?: Date; endTime?: Date }): number {
    if (!span.startTime || !span.endTime) return 0;
    const start = span.startTime instanceof Date ? span.startTime.getTime() : new Date(span.startTime).getTime();
    const end = span.endTime instanceof Date ? span.endTime.getTime() : new Date(span.endTime).getTime();
    return Math.max(0, end - start);
  }

  private errorMessageOf(span: { errorInfo?: { message?: string } | unknown; output?: unknown }): string | undefined {
    const ei = span.errorInfo as { message?: string } | undefined;
    // Fall back to the returned validation envelope, so a call flagged as an
    // error by its OUTPUT still carries a message a reader can act on.
    return ei?.message ?? validationFailureMessage(span.output);
  }

  /**
   * Serialize span input/output for logging.
   * Returns string (JSON or raw) or undefined. agent-event-log truncates to 500 chars
   * and runs secrets-redactor — we just need a string here.
   */
  private stringifyPayload(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private cleanupStaleTraces(): void {
    const now = Date.now();
    for (const [traceId, acc] of this.traces) {
      if (acc.expiresAt < now) this.traces.delete(traceId);
    }
    this.lastCleanup = now;
  }

  override async shutdown(): Promise<void> {
    this.traces.clear();
  }
}
