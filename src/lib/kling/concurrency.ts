import type { KlingJobView } from "./job-types";

type GenerationState = Pick<KlingJobView, "submissionState" | "remoteState"> & { data?: { deletedAt?: number } };

export function klingJobHasUnknownSubmission(job: GenerationState): boolean {
  return !job.data?.deletedAt && job.submissionState === "submission_unknown";
}

/** Prepared jobs reserve capacity; completed cloud jobs no longer consume generation slots. */
export function klingJobOccupiesGenerationSlot(job: GenerationState): boolean {
  if (job.data?.deletedAt) return false;
  if (["not_submitted"].includes(job.submissionState) || ["failed", "cancelled"].includes(job.remoteState)) return false;
  if (["prepared", "submitting", "submission_unknown"].includes(job.submissionState)) return true;
  return job.submissionState === "acknowledged" && job.remoteState !== "completed";
}

/** Recovery of unfinished local imports still protects the same shot from duplicate generation. */
export function klingJobHasUnresolvedWork(job: GenerationState & Pick<KlingJobView, "importState">): boolean {
  return !job.data?.deletedAt && !["failed", "cancelled"].includes(job.remoteState) && job.submissionState !== "not_submitted"
    && (job.importState !== "completed" || job.submissionState === "submission_unknown");
}

export interface KlingConcurrencyStatus {
  active: number;
  /** No application-side cap; the provider may enforce its own account quota. */
  max: null;
  blockedByUnknownSubmission: boolean;
}
