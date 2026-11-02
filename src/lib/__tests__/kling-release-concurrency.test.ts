import { describe, expect, it } from "vitest";
import { klingJobBlocksSubmission } from "@/components/kling-job-detail";
import { klingJobHasUnknownSubmission, klingJobHasUnresolvedWork, klingJobOccupiesGenerationSlot } from "@/lib/kling/concurrency";
import type { KlingJobView } from "@/lib/kling/job-types";

const job: KlingJobView = {
  jobId: "released-job", profileId: "profile", projectId: "project", scriptId: "script", shotId: 4,
  modelId: "model", tool: "image_to_video", prompt: "Slow camera move", submissionState: "submission_unknown",
  remoteState: "unknown", importState: "not_ready", createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
  outputs: [], allowedActions: ["bind"], autoQueryPaused: true, needsConfirmation: false, inputSummary: [], options: {},
};

describe("released Kling submission protection", () => {
  it("keeps unresolved unknown jobs blocking unless explicitly released", () => {
    expect(klingJobHasUnknownSubmission(job)).toBe(true);
    expect(klingJobHasUnresolvedWork(job)).toBe(true);
    expect(klingJobOccupiesGenerationSlot(job)).toBe(true);
    expect(klingJobBlocksSubmission(job)).toBe(true);
  });

  it("removes account, shot, capacity and browser blockers for both persisted and public records", () => {
    const blockingReleasedAt = Date.parse("2026-11-02T01:00:00.000Z");
    const persisted = { ...job, data: { blockingReleasedAt } };
    const view = { ...job, blockingReleasedAt: new Date(blockingReleasedAt).toISOString() };
    for (const released of [persisted, view]) {
      expect(klingJobHasUnknownSubmission(released)).toBe(false);
      expect(klingJobHasUnresolvedWork(released)).toBe(false);
      expect(klingJobOccupiesGenerationSlot(released)).toBe(false);
      expect(klingJobBlocksSubmission(released)).toBe(false);
      expect(released.submissionState).toBe("submission_unknown");
    }
  });

  it("keeps a released record unblocking after its original remote task is recovered", () => {
    const recovered = { ...job, blockingReleasedAt: "2026-11-02T01:00:00.000Z", submissionState: "acknowledged" as const,
      remoteState: "completed" as const, importState: "failed" as const, remoteGenerationId: "original-remote" };
    expect(klingJobHasUnresolvedWork(recovered)).toBe(false);
    expect(klingJobBlocksSubmission(recovered)).toBe(false);
  });
});
