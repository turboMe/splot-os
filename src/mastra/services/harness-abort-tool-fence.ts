import type {
  ProcessInputStepArgs,
  ProcessInputStepResult,
} from '@mastra/core/processors';
import { BaseProcessor } from '@mastra/core/processors';

type ExecutableTool = {
  execute?: (...args: any[]) => unknown;
};

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(String(reason ?? 'harness_tool_call_after_abort'));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/**
 * Mastra 1.32 does not forward AI SDK's `experimental_onToolCallStart` option.
 * It does, however, let an input-step processor replace the converted CoreTool
 * map immediately before the model loop. Wrapping `execute` there covers agent,
 * workspace, memory, skill, browser and request-supplied tools alike.
 */
export class HarnessAbortToolFenceProcessor extends BaseProcessor<'harness-abort-tool-fence'> {
  readonly id = 'harness-abort-tool-fence' as const;
  readonly name = 'Harness Abort Tool Fence';

  private readonly wrapped = new WeakMap<object, object>();

  constructor(private readonly signal: AbortSignal) {
    super();
  }

  processInputStep(args: ProcessInputStepArgs): ProcessInputStepResult | undefined {
    if (!args.tools) return undefined;

    const tools = Object.fromEntries(
      Object.entries(args.tools).map(([name, candidate]) => [name, this.wrap(candidate)]),
    );
    return { tools };
  }

  private wrap(candidate: unknown): unknown {
    if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
      return candidate;
    }

    const tool = candidate as ExecutableTool & object;
    if (typeof tool.execute !== 'function') return candidate;

    const cached = this.wrapped.get(tool);
    if (cached) return cached;

    const execute = tool.execute;
    const fenced = new Proxy(tool, {
      get: (target, property) => {
        if (property !== 'execute') return Reflect.get(target, property, target);
        return async (...callArgs: any[]) => {
          // The provider may return a tool call after fetch cancellation. This
          // check runs in the actual tool dispatch path, before any side effect.
          throwIfAborted(this.signal);
          return Reflect.apply(execute, target, callArgs);
        };
      },
    });

    this.wrapped.set(tool, fenced);
    return fenced;
  }
}

export function createHarnessAbortToolFenceProcessor(
  signal: AbortSignal,
): HarnessAbortToolFenceProcessor {
  return new HarnessAbortToolFenceProcessor(signal);
}
