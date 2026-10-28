/** Browser-safe bridge: provider metadata is shared with client components. */
interface ProviderGenerationHooks {
  checkpoint: (patch: Record<string, unknown>) => void;
  defersPolling: () => boolean;
}

const providerRuntime = globalThis as typeof globalThis & {
  __clipforgeProviderGenerationHooks?: ProviderGenerationHooks;
};

/** The server's execution context registers these hooks; browser providers remain inert. */
export function registerProviderGenerationHooks(hooks: ProviderGenerationHooks): void {
  providerRuntime.__clipforgeProviderGenerationHooks = hooks;
}

export function generationCheckpoint(patch: Record<string, unknown>): void {
  providerRuntime.__clipforgeProviderGenerationHooks?.checkpoint(patch);
}

export function generationContextDefersPolling(): boolean {
  return providerRuntime.__clipforgeProviderGenerationHooks?.defersPolling() === true;
}

/** Shared class identity lets server routes recognize the provider's durable handoff. */
export class GenerationTaskPending extends Error {
  readonly code = "GENERATION_TASK_PENDING";
  constructor(public readonly taskId: string) {
    super("云端任务已登记，后台继续查询");
    this.name = "GenerationTaskPending";
  }
}
