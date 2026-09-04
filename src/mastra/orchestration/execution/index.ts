/**
 * Execution layer — where attempts become real, budget-bounded model work.
 * `gateway.ts` is transport-agnostic; `ollama-caller.ts` is the live model path.
 */
export * from './gateway.js';
export * from './ollama-caller.js';
export * from './mastra-agent-caller.js';
export * from './harness-agent-caller.js';
export * from './registry-worker.js';
export * from './native-worker.js';
export * from './linux-process-tree.js';
export * from './process-supervisor.js';
export * from './process-worker.js';
export * from './lane-decider.js';
export * from './headless-contract.js';
export * from './writer-progress.js';
