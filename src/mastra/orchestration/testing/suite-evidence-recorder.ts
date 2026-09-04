import {
  startBoundedProcessOutputCapture,
  type ProcessOutputCapture,
  type RawEvidenceArtifactInput,
} from './raw-evidence-sink.js';

const SAFE_TRACE_TYPE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;

type TraceValue =
  | null
  | boolean
  | number
  | string
  | TraceValue[]
  | { [key: string]: TraceValue };

function canonical(value: TraceValue): TraceValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('trace rejects non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}
export interface SuiteEvidenceRecorder {
  trace(type: string, detail?: Record<string, TraceValue>): void;
  finalize(summary: Record<string, TraceValue>): RawEvidenceArtifactInput[];
}

/**
 * Capture starts immediately. `finalize` is a one-way cutoff: callers must not
 * write stdout/stderr after it in strict-gate mode.
 */
export function createSuiteEvidenceRecorder(suiteId: string): SuiteEvidenceRecorder {
  const outputCapture: ProcessOutputCapture = startBoundedProcessOutputCapture();
  const traceEvents: string[] = [];
  let sequence = 0;
  let finalized = false;

  function trace(type: string, detail: Record<string, TraceValue> = {}): void {
    if (finalized) throw new Error('suite evidence recorder is finalized');
    if (!SAFE_TRACE_TYPE_RE.test(type)) throw new TypeError('invalid trace event type');
    sequence++;
    traceEvents.push(JSON.stringify(canonical({
      sequence,
      type,
      detail,
    })));
  }

  trace('suite.capture.started', { suiteId });

  return Object.freeze({
    trace,
    finalize(summary: Record<string, TraceValue>): RawEvidenceArtifactInput[] {
      if (finalized) throw new Error('suite evidence recorder was already finalized');
      trace('suite.evidence.cutoff', { suiteId });
      finalized = true;
      const output = outputCapture.stop();
      return [
        {
          artifactId: 'normalized-summary',
          kind: 'normalizedSummary',
          mediaType: 'application/json',
          content: `${JSON.stringify(canonical({ suiteId, ...summary }))}\n`,
        },
        {
          artifactId: 'stdout',
          kind: 'stdout',
          mediaType: 'text/plain; charset=utf-8',
          content: output.stdout,
        },
        {
          artifactId: 'stderr',
          kind: 'stderr',
          mediaType: 'text/plain; charset=utf-8',
          content: output.stderr,
        },
        {
          artifactId: 'trace-event-log',
          kind: 'trace',
          mediaType: 'application/x-ndjson',
          content: `${traceEvents.join('\n')}\n`,
        },
      ];
    },
  });
}
