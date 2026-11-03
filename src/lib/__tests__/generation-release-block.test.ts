// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

const state = vi.hoisted(() => ({ directory: "", sqlite: null as Database.Database | null, execute: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getUploadsDir: () => `${state.directory}/uploads` }));
vi.mock("@/lib/db", async () => {
  const { default: Sqlite } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Sqlite(":memory:"); state.sqlite.pragma("foreign_keys = ON");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { getDb: () => db };
});
vi.mock("@/lib/generation-executor", () => ({ executeGenerationItem: state.execute }));

import { getDb } from "@/lib/db";
import { assets, projects, scripts } from "@/lib/db/schema";
import { generationItems, generationRuns } from "@/lib/generation-schema";
import { klingJobs, klingJobOutputs } from "@/lib/kling/job-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { klingJobHasUnknownSubmission, klingJobHasUnresolvedWork } from "@/lib/kling/concurrency";
import { decryptGenerationValue, encryptGenerationValue } from "@/lib/generation-secrets";
import { deleteGenerationRuns, enqueueGenerationRun, generationRunAction, getGenerationRun, runGenerationTick, stopGenerationRunner } from "@/lib/generation-runs";

const originalError = "提交进程已中断，平台可能已受理，请先核对原任务";
const release = { projectId: "A", itemId: "item-4", acknowledgePossibleCharge: true };
const replacement = { projectId: "A", clientRequestId: "new-shot-4", kind: "video", items: [{ kind: "video" as const, scriptId: "script-A", shotId: 4, request: { provider: "mock", model: "new-model" } }] };

beforeAll(() => { state.directory = mkdtempSync(path.join(tmpdir(), "clipforge-release-block-")); });
afterAll(() => { stopGenerationRunner(); state.sqlite?.close(); rmSync(state.directory, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build"); state.execute.mockReset();
  const db = getDb();
  db.delete(klingJobOutputs).run(); db.delete(klingJobs).run(); db.delete(klingProfiles).run();
  db.delete(generationItems).run(); db.delete(generationRuns).run(); db.delete(assets).run(); db.delete(scripts).run(); db.delete(projects).run();
  db.insert(projects).values({ id: "A", name: "Original project" }).run();
  db.insert(scripts).values({ id: "script-A", projectId: "A", styleType: "scene", selected: true,
    shots: Array.from({ length: 6 }, (_, index) => ({ shotId: index + 1, type: "demo", duration: 5, description: "Product", camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "Product demo" })) }).run();
  db.insert(klingProfiles).values({ id: "profile-A", data: {} as never }).run();
  db.insert(generationRuns).values({ id: "run-A", projectId: "A", clientRequestId: "original-batch", requestHash: "immutable-batch-hash", kind: "video_batch", createdAt: 1, updatedAt: 1 }).run();
  for (let shotId = 1; shotId <= 6; shotId++) db.insert(generationItems).values({ id: `item-${shotId}`, runId: "run-A", projectId: "A", kind: "video", scriptId: "script-A", shotId,
    status: shotId === 4 ? "needs_attention" : "completed", stage: shotId === 4 ? "needs_attention" : "ready",
    payload: encryptGenerationValue({ request: { provider: "kling-cli", profileId: "profile-A", apiKey: "private-snapshot" } }),
    checkpoint: shotId === 4 ? encryptGenerationValue({ childJobId: "job-4", submissionState: "submitting" }) : null,
    result: shotId === 4 ? { childJobId: "job-4" } : { assetId: `saved-${shotId}` }, error: shotId === 4 ? originalError : null,
    errorCode: shotId === 4 ? "GENERATION_NEEDS_ATTENTION" : null, nextRunAt: 1, createdAt: 1, updatedAt: 1 }).run();
  db.insert(klingJobs).values({ id: "job-4", profileId: "profile-A", principalKey: "original-account", region: "global", clientRequestId: "item-4", projectId: "A", scriptId: "script-A", shotId: 4,
    submissionState: "submission_unknown", remoteState: "unknown", importState: "not_ready", needsConfirmation: true,
    data: { generationItemId: "item-4", error: { code: "KLING_SUBMISSION_UNKNOWN", message: originalError, retryable: false }, authorizedUntil: 123456 } as never,
    createdAt: 1, updatedAt: 1 }).run();
  db.insert(assets).values({ id: "keyframe-4", projectId: "A", shotId: 4, type: "ai_generated", filePath: "/api/files/A/keyframe.png", status: "done", selected: true }).run();
});
afterEach(() => { stopGenerationRunner(); vi.unstubAllEnvs(); });

const itemRow = () => getDb().select().from(generationItems).where(eq(generationItems.id, "item-4")).get()!;
const jobRow = () => getDb().select().from(klingJobs).where(eq(klingJobs.id, "job-4")).get()!;

describe("explicit task unbinding with retained Kling work", () => {
  it.each(["submission_unknown", "acknowledged"] as const)("unbinds stopped %s work without cancelling or deleting its remote identity", submissionState => {
    const db = getDb();
    db.update(klingJobs).set({ submissionState, remoteGenerationId: submissionState === "acknowledged" ? "paid-remote-task" : null,
      remoteState: submissionState === "acknowledged" ? "processing" : "unknown" }).run();
    const before = jobRow(), payload = itemRow().payload;
    expect(getGenerationRun("run-A")).toMatchObject({ canDelete: true });
    expect(getGenerationRun("run-A").items.find(item => item.id === "item-4")?.canUnbind).toBe(true);
    const run = generationRunAction("run-A", "unbind", release);
    expect(run.items.find(item => item.id === "item-4")).toMatchObject({ status: "cancelled", stage: "released", canUnbind: false });
    expect(jobRow()).toMatchObject({ submissionState: before.submissionState, remoteState: before.remoteState, remoteGenerationId: before.remoteGenerationId,
      autoQueryPaused: true, nextQueryAt: null, data: { ...before.data, authorizedUntil: 0, blockingReleasedAt: expect.any(Number) } });
    expect(itemRow().payload).toBe(payload);
    expect(klingJobHasUnresolvedWork(jobRow())).toBe(false);
    expect(enqueueGenerationRun(replacement).status).toBe("queued");
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("deleting a stopped parent releases only its linked child and retains both records and the keyframe", () => {
    const before = jobRow(), keyframe = getDb().select().from(assets).get();
    expect(deleteGenerationRuns("A", "run-A")).toEqual({ deletedIds: ["run-A"], deletedCount: 1 });
    expect(itemRow()).toMatchObject({ status: "cancelled", stage: "released", error: originalError, result: { childJobId: "job-4" } });
    expect(jobRow()).toMatchObject({ id: before.id, remoteState: before.remoteState, submissionState: before.submissionState,
      autoQueryPaused: true, data: { blockingReleasedAt: expect.any(Number) } });
    expect(getDb().select().from(assets).get()).toEqual(keyframe);
  });
  it.each(["active child", "expired but living child", "wrong script", "wrong request", "conflicting checkpoint"])("refuses to unbind or delete with %s", scenario => {
    const db = getDb();
    if (scenario === "active child" || scenario === "expired but living child") db.update(klingJobs).set({ leaseOwner: `${process.pid}:live`, leaseExpiresAt: scenario === "active child" ? Date.now() + 90000 : 1 }).run();
    if (scenario === "wrong script") db.update(klingJobs).set({ scriptId: "wrong-script" }).run();
    if (scenario === "wrong request") db.update(klingJobs).set({ clientRequestId: "another-item" }).run();
    if (scenario === "conflicting checkpoint") db.update(generationItems).set({ checkpoint: encryptGenerationValue({ childJobId: "another-job" }) }).where(eq(generationItems.id, "item-4")).run();
    const beforeItem = itemRow(), beforeJob = jobRow();
    expect(getGenerationRun("run-A")).toMatchObject({ canDelete: false });
    expect(() => generationRunAction("run-A", "unbind", release)).toThrow(expect.objectContaining({ code: "GENERATION_UNBIND_CONFLICT" }));
    expect(() => deleteGenerationRuns("A", "run-A")).toThrow(expect.objectContaining({ code: "GENERATION_RUN_NOT_DELETABLE" }));
    expect(itemRow()).toEqual(beforeItem); expect(jobRow()).toEqual(beforeJob);
  });
});

describe("explicit interrupted Kling block release", () => {
  it("atomically releases only shot four, retains the unknown paid-task audit and keyframe, and allows a new single shot", () => {
    const db = getDb(), before = db.select().from(generationItems).all(), payload = itemRow().payload, originalJob = jobRow();
    expect(getGenerationRun("run-A").items.find((item) => item.shotId === 4)?.canReleaseBlock).toBe(true);
    expect(klingJobHasUnknownSubmission(originalJob)).toBe(true);
    expect(klingJobHasUnresolvedWork(originalJob)).toBe(true);
    expect(() => enqueueGenerationRun(replacement)).toThrow(expect.objectContaining({ code: "GENERATION_ALREADY_ACTIVE" }));
    const run = generationRunAction("run-A", "release_block", release);
    expect(run).toMatchObject({ done: 5, total: 6, failed: 0, status: "cancelled" });
    expect(run.items.find((item) => item.shotId === 4)).toMatchObject({ status: "cancelled", stage: "released", canReleaseBlock: false, error: originalError, result: { childJobId: "job-4" } });
    expect(itemRow().payload).toBe(payload);
    expect(decryptGenerationValue(itemRow().checkpoint!)).toMatchObject({ childJobId: "job-4", submissionState: "submitting", blockingReleasedAt: expect.any(Number), acknowledgedPossibleCharge: true });
    expect(jobRow()).toMatchObject({ submissionState: "submission_unknown", remoteState: "unknown", remoteGenerationId: null, autoQueryPaused: true, nextQueryAt: null,
      data: { ...originalJob.data, authorizedUntil: 0, blockingReleasedAt: expect.any(Number) } });
    expect(klingJobHasUnknownSubmission(jobRow())).toBe(false);
    expect(klingJobHasUnresolvedWork(jobRow())).toBe(false);
    expect(db.select().from(generationItems).all().filter((item) => item.shotId !== 4)).toEqual(before.filter((item) => item.shotId !== 4));
    expect(db.select().from(assets).get()).toMatchObject({ id: "keyframe-4", selected: true });
    expect(JSON.stringify(run)).not.toContain("private-snapshot");
    expect(enqueueGenerationRun(replacement)).toMatchObject({ status: "queued", items: [expect.objectContaining({ shotId: 4 })] });
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("is idempotent and cannot requeue the old unknown submission through recovery", async () => {
    const first = generationRunAction("run-A", "release_block", release), item = itemRow(), job = jobRow();
    expect(generationRunAction("run-A", "release_block", release)).toEqual(first);
    expect(itemRow()).toEqual(item); expect(jobRow()).toEqual(job);
    expect(() => generationRunAction("run-A", "retry_import")).toThrow(expect.objectContaining({ code: "GENERATION_RECOVERY_UNSAFE" }));
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    expect(state.execute).not.toHaveBeenCalled();
    expect(itemRow()).toEqual(item);
  });

  it.each([undefined, false, "true"])("requires explicit charge acknowledgement: %s", (acknowledgePossibleCharge) => {
    const item = itemRow(), job = jobRow();
    expect(() => generationRunAction("run-A", "release_block", { ...release, acknowledgePossibleCharge })).toThrow(expect.objectContaining({ status: 400, code: "GENERATION_RELEASE_ACK_REQUIRED" }));
    expect(itemRow()).toEqual(item); expect(jobRow()).toEqual(job);
  });

  it.each([{ projectId: "B" }, { projectId: undefined }, { itemId: "another-item" }])("rejects a release outside the original project or batch: %j", (options) => {
    const item = itemRow(), job = jobRow();
    expect(() => generationRunAction("run-A", "release_block", { ...release, ...options })).toThrow(expect.objectContaining({ status: 404, code: "GENERATION_ITEM_NOT_FOUND" }));
    expect(itemRow()).toEqual(item); expect(jobRow()).toEqual(job);
  });

  it.each(["known cloud task", "active parent", "active child", "expired but living child", "changed item status", "wrong shot", "wrong script", "wrong request", "conflicting checkpoint", "corrupt checkpoint", "other provider"])("keeps %s protected and leaves both records unchanged", (scenario) => {
    const db = getDb();
    if (scenario === "known cloud task") db.update(klingJobs).set({ submissionState: "acknowledged", remoteGenerationId: "paid-cloud-task" }).run();
    if (scenario === "active parent") db.update(generationItems).set({ leaseOwner: `${process.pid}:active`, leaseExpiresAt: Date.now() + 90000 }).where(eq(generationItems.id, "item-4")).run();
    if (scenario === "active child" || scenario === "expired but living child") db.update(klingJobs).set({ leaseOwner: `${process.pid}:active`, leaseExpiresAt: scenario === "active child" ? Date.now() + 90000 : 1 }).run();
    if (scenario === "changed item status") db.update(generationItems).set({ status: "waiting" }).where(eq(generationItems.id, "item-4")).run();
    if (scenario === "wrong shot") db.update(klingJobs).set({ shotId: 3 }).run();
    if (scenario === "wrong script") db.update(klingJobs).set({ scriptId: "other-script" }).run();
    if (scenario === "wrong request") db.update(klingJobs).set({ clientRequestId: "another-item" }).run();
    if (scenario === "conflicting checkpoint") db.update(generationItems).set({ checkpoint: encryptGenerationValue({ childJobId: "another-job" }) }).where(eq(generationItems.id, "item-4")).run();
    if (scenario === "corrupt checkpoint") db.update(generationItems).set({ checkpoint: "corrupt" }).where(eq(generationItems.id, "item-4")).run();
    if (scenario === "other provider") db.update(generationItems).set({ payload: encryptGenerationValue({ request: { provider: "other" } }) }).where(eq(generationItems.id, "item-4")).run();
    const item = itemRow(), job = jobRow();
    expect(getGenerationRun("run-A").items.find((entry) => entry.id === "item-4")?.canReleaseBlock).toBe(false);
    expect(() => generationRunAction("run-A", "release_block", release)).toThrow(expect.objectContaining({ status: 409, code: "GENERATION_RELEASE_CONFLICT" }));
    expect(itemRow()).toEqual(item); expect(jobRow()).toEqual(job);
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("releases the parent when the original unknown child was already soft deleted, preserving its tombstone", () => {
    const deletedAt = Date.now();
    getDb().update(klingJobs).set({ data: { ...jobRow().data, deletedAt } }).run();
    expect(getGenerationRun("run-A").items.find((item) => item.shotId === 4)?.canReleaseBlock).toBe(true);
    expect(() => enqueueGenerationRun(replacement)).toThrow(expect.objectContaining({ code: "GENERATION_ALREADY_ACTIVE" }));
    expect(generationRunAction("run-A", "release_block", release).items.find((item) => item.shotId === 4)).toMatchObject({ status: "cancelled", stage: "released", canReleaseBlock: false });
    expect(jobRow()).toMatchObject({ submissionState: "submission_unknown", remoteGenerationId: null, autoQueryPaused: true,
      data: { deletedAt, blockingReleasedAt: expect.any(Number) } });
    expect(enqueueGenerationRun(replacement)).toMatchObject({ status: "queued", items: [expect.objectContaining({ shotId: 4 })] });
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("recovers the original child association even if the item checkpoint was lost", () => {
    getDb().update(generationItems).set({ checkpoint: null, result: null }).where(eq(generationItems.id, "item-4")).run();
    expect(getGenerationRun("run-A").items.find((item) => item.shotId === 4)?.canReleaseBlock).toBe(true);
    expect(generationRunAction("run-A", "release_block", release).items.find((item) => item.shotId === 4)).toMatchObject({ status: "cancelled", stage: "released", result: { childJobId: "job-4" } });
  });
});
