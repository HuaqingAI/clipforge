/** Serializable, encrypted execution inputs. Never expose this payload in task feeds. */
import type { KlingVideoModelDescriptor } from "./kling/types";

export interface GenerationPayload {
  request: Record<string, unknown>;
  asset?: Record<string, unknown>;
  snapshot?: {
    project?: Record<string, unknown>;
    script?: Record<string, unknown>;
    kling?: { profileId: string; principalKey: string; region: string; model: KlingVideoModelDescriptor };
    referenceInputs?: Array<{ url: string; hash: string }>;
  };
}

export type GenerationKind = "video" | "image" | "script" | "storyboard_grid";

export interface GenerationExecutionItem {
  id: string;
  runId: string;
  projectId: string;
  kind: GenerationKind;
  scriptId: string | null;
  shotId: number | null;
  payload: GenerationPayload;
  checkpoint: Record<string, unknown> | null;
}

export type GenerationCheckpoint = (value: Record<string, unknown>) => void;

export class GenerationExecutionError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable = false) {
    super(message);
    this.name = "GenerationExecutionError";
  }
}
