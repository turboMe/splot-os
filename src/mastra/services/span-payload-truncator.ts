import type { SpanOutputProcessor, AnySpan } from '@mastra/core/observability';

export interface SpanPayloadTruncatorOptions {
  maxStringLength?: number;
}

function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}... [TRUNCATED ${str.length - maxLen} chars]`;
}

function truncateValue(val: unknown, maxLen: number, depth = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    return truncateString(val, maxLen);
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => truncateValue(item, maxLen, depth + 1));
  }
  if (typeof val === 'object') {
    try {
      const serialized = JSON.stringify(val);
      if (serialized.length <= maxLen) return val;
    } catch {
      return '[UNSERIALIZABLE]';
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      result[k] = truncateValue(v, maxLen, depth + 1);
    }
    return result;
  }
  return val;
}

export class SpanPayloadTruncator implements SpanOutputProcessor {
  readonly name = 'span-payload-truncator';
  private readonly maxStringLength: number;

  constructor(options: SpanPayloadTruncatorOptions = {}) {
    this.maxStringLength = options.maxStringLength ?? 4096;
  }

  process(span?: AnySpan): AnySpan | undefined {
    if (!span) return span;
    const s = span as any;
    if (s.input !== undefined) {
      s.input = truncateValue(s.input, this.maxStringLength);
    }
    if (s.output !== undefined) {
      s.output = truncateValue(s.output, this.maxStringLength);
    }
    return span;
  }

  async shutdown(): Promise<void> {
    // No-op
  }
}
