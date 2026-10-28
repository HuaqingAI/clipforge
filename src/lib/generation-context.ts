import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerationCheckpoint, GenerationPayload } from "./generation-types";
import { registerProviderGenerationHooks } from "./provider-generation-hooks";
export { GenerationTaskPending } from "./provider-generation-hooks";

interface ExecutionContext {
  itemId: string;
  value: Record<string, unknown>;
  save: GenerationCheckpoint;
  snapshot?: GenerationPayload["snapshot"];
  deferPolling?: boolean;
  beforeSubmission?: () => void;
}

const contextRuntime = globalThis as typeof globalThis & {
  __clipforgeGenerationExecutionContext?: AsyncLocalStorage<ExecutionContext>;
};
const execution = contextRuntime.__clipforgeGenerationExecutionContext ??= new AsyncLocalStorage<ExecutionContext>();

/** Routes and provider adapters share the worker's durable checkpoint without HTTP headers. */
export function withGenerationContext<T>(
  input: { itemId: string; checkpoint: Record<string, unknown> | null; save: GenerationCheckpoint; snapshot?: GenerationPayload["snapshot"]; deferPolling?: boolean; beforeSubmission?: () => void },
  run: () => Promise<T>,
): Promise<T> {
  return execution.run({ itemId: input.itemId, value: { ...input.checkpoint }, save: input.save, snapshot: input.snapshot, deferPolling: input.deferPolling, beforeSubmission: input.beforeSubmission }, run);
}

export function generationCheckpoint(patch: Record<string, unknown>): void {
  const context = execution.getStore();
  if (!context) return;
  const value = { ...context.value, ...patch };
  // A failed durable write must stop execution before another paid operation.
  context.save(value);
  context.value = value;
}

export function beforeGenerationSubmission(): void {
  execution.getStore()?.beforeSubmission?.();
  generationCheckpoint({ submissionState: "submitting", submissionStartedAt: Date.now() });
}

export function generationContextItemId(): string | undefined {
  return execution.getStore()?.itemId;
}

/** Only internal worker execution can supply this snapshot; browser JSON cannot impersonate it. */
export function generationContextSnapshot(): GenerationPayload["snapshot"] {
  return execution.getStore()?.snapshot;
}

export function generationContextCheckpoint(): Readonly<Record<string, unknown>> | undefined {
  return execution.getStore()?.value;
}

export function generationContextDefersPolling(): boolean {
  return execution.getStore()?.deferPolling === true;
}

registerProviderGenerationHooks({ checkpoint: generationCheckpoint, defersPolling: generationContextDefersPolling });
