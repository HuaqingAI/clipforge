import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerationCheckpoint, GenerationPayload } from "./generation-types";
import { registerProviderGenerationHooks } from "./provider-generation-hooks";
import { persistGenerationCheckpointMedia } from "./generation-checkpoint-media";
import { GenerationExecutionError } from "./generation-types";
export { GenerationTaskPending } from "./provider-generation-hooks";

interface ExecutionContext {
  itemId: string;
  projectId?: string;
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
  input: { itemId: string; projectId?: string; checkpoint: Record<string, unknown> | null; save: GenerationCheckpoint; snapshot?: GenerationPayload["snapshot"]; deferPolling?: boolean; beforeSubmission?: () => void },
  run: () => Promise<T>,
): Promise<T> {
  return execution.run({ itemId: input.itemId, projectId: input.projectId, value: { ...input.checkpoint }, save: input.save, snapshot: input.snapshot, deferPolling: input.deferPolling, beforeSubmission: input.beforeSubmission }, run);
}

export function generationCheckpoint(patch: Record<string, unknown>): void {
  const context = execution.getStore();
  if (!context) return;
  const original = { ...context.value, ...patch };
  let value = original;
  if (context.projectId) {
    try { value = persistGenerationCheckpointMedia(context.projectId, original); }
    catch {
      // Preserve an acknowledged paid response in SQLite if only the media directory is unwritable.
      // Retrying this import must use its saved result, never buy a replacement generation.
      context.save(original);
      context.value = original;
      throw new GenerationExecutionError("生成图片的恢复文件暂时无法保存，已保留原始结果，请重试导入。", "GENERATION_IMPORT_FAILED", true);
    }
  }
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
