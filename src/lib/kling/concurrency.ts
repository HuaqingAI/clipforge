import type { KlingJobView } from "./job-types";

type GenerationState = Pick<KlingJobView, "submissionState" | "remoteState"> & {
  blockingReleasedAt?: string;
  data?: { deletedAt?: number; blockingReleasedAt?: number };
};

/** Both persisted records and browser DTOs carry the explicit local release. */
export function klingJobBlockingReleased(job: Pick<GenerationState, "blockingReleasedAt" | "data">): boolean {
  return Boolean(job.blockingReleasedAt || job.data?.blockingReleasedAt);
}

export function klingJobHasUnknownSubmission(job: GenerationState): boolean {
  return !job.data?.deletedAt && !klingJobBlockingReleased(job) && job.submissionState === "submission_unknown";
}

/** Prepared jobs reserve capacity; completed cloud jobs no longer consume generation slots. */
export function klingJobOccupiesGenerationSlot(job: GenerationState): boolean {
  if (job.data?.deletedAt || klingJobBlockingReleased(job)) return false;
  if (["not_submitted"].includes(job.submissionState) || ["failed", "cancelled"].includes(job.remoteState)) return false;
  if (["prepared", "submitting", "submission_unknown"].includes(job.submissionState)) return true;
  return job.submissionState === "acknowledged" && job.remoteState !== "completed";
}

/** Recovery of unfinished local imports still protects the same shot from duplicate generation. */
export function klingJobHasUnresolvedWork(job: GenerationState & Pick<KlingJobView, "importState">): boolean {
  return !job.data?.deletedAt && !klingJobBlockingReleased(job) && !["failed", "cancelled"].includes(job.remoteState) && job.submissionState !== "not_submitted"
    && (job.importState !== "completed" || job.submissionState === "submission_unknown");
}

export interface KlingConcurrencyStatus {
  active: number;
  /** No application-side cap; the provider may enforce its own account quota. */
  max: null;
  blockedByUnknownSubmission: boolean;
}
