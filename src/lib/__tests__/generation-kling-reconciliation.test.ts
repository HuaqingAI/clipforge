// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

const state = vi.hoisted(() => ({ directory: "", sqlite: null as Database.Database | null, execute: vi.fn(), createKling: vi.fn() }));
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
vi.mock("@/lib/kling/jobs", () => ({ createKlingJob: state.createKling,
  isKlingPreparedAuthorized: (job: { data: { authorizedBootId?: string; authorizedUntil?: number } }) =>
    job.data.authorizedBootId === "boot-A" && (job.data.authorizedUntil ?? 0) > Date.now(),
}));

import { getDb } from "@/lib/db";
import { assets, projects, scripts } from "@/lib/db/schema";
import { generationItems, generationRuns } from "@/lib/generation-schema";
import { klingJobs, klingJobOutputs } from "@/lib/kling/job-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { decryptGenerationValue, encryptGenerationValue } from "@/lib/generation-secrets";
import { getGenerationRun, listGenerationRuns, runGenerationTick, stopGenerationRunner } from "@/lib/generation-runs";

function seed(count = 1, status = "needs_attention") {
  const db = getDb(), now = Date.now() - 10_000;
  db.insert(generationRuns).values({ id: "run-A", projectId: "A", clientRequestId: "batch-request", requestHash: "frozen-request", kind: "video_batch", createdAt: now, updatedAt: now }).run();
  return Array.from({ length: count }, (_, index) => {
    const shotId = index + 1, itemId = `item-${shotId}`, jobId = `job-${shotId}`, outputId = `output-${shotId}`, assetId = `asset-${shotId}`;
    const filePath = `/api/files/A/kling/${jobId}/${outputId}.mp4`;
    db.insert(generationItems).values({ id: itemId, runId: "run-A", projectId: "A", kind: "video", scriptId: "script-A", shotId,
      status, stage: "retry_wait", attempts: 43 + index, payload: encryptGenerationValue({ request: { provider: "kling-cli", profileId: "profile-A", projectId: "A", scriptId: "script-A", shotId } }),
      checkpoint: encryptGenerationValue({ childJobId: jobId, remoteTaskId: `remote-${shotId}`, stage: "cloud_running" }), result: { childJobId: jobId },
      error: "此任务的执行进程尚未退出，请稍后刷新。", errorCode: "GENERATION_IMPORT_FAILED", nextRunAt: now, createdAt: now + index, updatedAt: now }).run();
    db.insert(klingJobs).values({ id: jobId, profileId: "profile-A", principalKey: "account-A", region: "global", clientRequestId: itemId,
      projectId: "A", scriptId: "script-A", shotId, remoteGenerationId: `remote-${shotId}`, submissionState: "acknowledged", remoteState: "completed", importState: "completed",
      data: { generationItemId: itemId } as never, createdAt: now, updatedAt: now }).run();
    db.insert(assets).values({ id: assetId, projectId: "A", shotId, type: "ai_generated", provider: "kling-cli", sourceScriptId: "script-A", filePath, status: "done" }).run();
    db.insert(klingJobOutputs).values({ id: outputId, jobId, workKey: `work-${shotId}`, importState: "imported", assetId,
      data: { url: `https://example.test/${outputId}.mp4`, urlObtainedAt: now, providerWorkId: `work-${shotId}`, filePath }, createdAt: now, updatedAt: now }).run();
    return { itemId, jobId, outputId, assetId, shotId, filePath };
  });
}

beforeAll(() => { state.directory = mkdtempSync(path.join(tmpdir(), "clipforge-kling-reconciliation-")); });
afterAll(() => { stopGenerationRunner(); state.sqlite?.close(); rmSync(state.directory, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build"); vi.clearAllMocks();
  const db = getDb();
  db.delete(klingJobOutputs).run(); db.delete(klingJobs).run(); db.delete(klingProfiles).run();
  db.delete(generationItems).run(); db.delete(generationRuns).run(); db.delete(assets).run(); db.delete(scripts).run(); db.delete(projects).run();
  for (const id of ["A", "B"]) {
    db.insert(projects).values({ id, name: `Project ${id}` }).run();
    db.insert(scripts).values({ id: `script-${id}`, projectId: id, selected: true, styleType: "scene" }).run();
  }
  db.insert(klingProfiles).values({ id: "profile-A", data: {} as never }).run();
});
afterEach(() => { stopGenerationRunner(); vi.unstubAllEnvs(); });

describe("Kling child completion reconciliation", () => {
  it("settles an already saved Kling child from the runner without opening its details or task feed", async () => {
    const links = seed(3), db = getDb();
    vi.stubEnv("NEXT_PHASE", "");
    await runGenerationTick();
    const items = db.select().from(generationItems).all();
    expect(items).toHaveLength(3);
    for (const link of links) expect(items.find((item) => item.id === link.itemId)).toMatchObject({ status: "completed", stage: "ready", error: null, errorCode: null });
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });
  it.each(["get", "list"])("%s repairs all five stale failures using already saved assets and is idempotent", (method) => {
    const links = seed(5);
    const read = () => method === "get" ? getGenerationRun("run-A") : listGenerationRuns("A")[0];
    const run = read();
    expect(run).toMatchObject({ status: "completed", done: 5, failed: 0, total: 5 });
    for (const link of links) {
      const result = { childJobId: link.jobId, assetIds: [link.assetId], videoUrls: [link.filePath] };
      expect(run.items.find((item) => item.id === link.itemId)).toMatchObject({ status: "completed", stage: "ready", error: null, errorCode: null, result });
      const stored = getDb().select().from(generationItems).where(eq(generationItems.id, link.itemId)).get()!;
      expect(decryptGenerationValue(stored.checkpoint!)).toMatchObject({ childJobId: link.jobId, stage: "ready", completedResult: result });
    }
    const stored = getDb().select().from(generationItems).all();
    expect(read()).toEqual(run);
    expect(getDb().select().from(generationItems).all()).toEqual(stored);
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });

  it("recovers the child by its item request identity after the parent checkpoint was lost", () => {
    const [link] = seed();
    getDb().update(generationItems).set({ checkpoint: null, result: null }).where(eq(generationItems.id, link.itemId)).run();
    expect(getGenerationRun("run-A")).toMatchObject({ status: "completed", done: 1, failed: 0,
      items: [expect.objectContaining({ result: { childJobId: link.jobId, assetIds: [link.assetId], videoUrls: [link.filePath] } })] });
    const stored = getDb().select().from(generationItems).get()!;
    expect(decryptGenerationValue(stored.checkpoint!)).toMatchObject({ childJobId: link.jobId, completedResult: { assetIds: [link.assetId] } });
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "waiting", "importing", "failed", "needs_attention"])("reconciles an unleased %s parent", (status) => {
    seed(1, status);
    expect(getGenerationRun("run-A")).toMatchObject({ status: "completed", done: 1, failed: 0 });
  });

  it.each(["completed", "cancelled"])("preserves the terminal %s parent", (status) => {
    seed(1, status);
    const before = getDb().select().from(generationItems).get();
    getGenerationRun("run-A");
    expect(getDb().select().from(generationItems).get()).toEqual(before);
  });

  it.each(["deleted job", "deleted output", "wrong item", "wrong project", "wrong script", "wrong shot", "live parent lease", "missing asset", "wrong asset path", "conflicting checkpoint"])("leaves %s unresolved", (scenario) => {
    const [link] = seed(), db = getDb();
    if (scenario === "deleted job") db.update(klingJobs).set({ data: { deletedAt: Date.now() } as never }).where(eq(klingJobs.id, link.jobId)).run();
    if (scenario === "deleted output") {
      const output = db.select().from(klingJobOutputs).get()!;
      db.update(klingJobOutputs).set({ data: { ...output.data, deletedAt: Date.now() } }).where(eq(klingJobOutputs.id, link.outputId)).run();
    }
    if (scenario === "wrong item") db.update(klingJobs).set({ clientRequestId: "another-item" }).where(eq(klingJobs.id, link.jobId)).run();
    if (scenario === "wrong project") db.update(klingJobs).set({ projectId: "B" }).where(eq(klingJobs.id, link.jobId)).run();
    if (scenario === "wrong script") db.update(klingJobs).set({ scriptId: "script-B" }).where(eq(klingJobs.id, link.jobId)).run();
    if (scenario === "wrong shot") db.update(klingJobs).set({ shotId: 2 }).where(eq(klingJobs.id, link.jobId)).run();
    if (scenario === "live parent lease") db.update(generationItems).set({ leaseOwner: `${process.pid}:active`, leaseExpiresAt: Date.now() + 90_000 }).where(eq(generationItems.id, link.itemId)).run();
    if (scenario === "missing asset") db.delete(assets).where(eq(assets.id, link.assetId)).run();
    if (scenario === "wrong asset path") db.update(assets).set({ filePath: "/api/files/A/other.mp4" }).where(eq(assets.id, link.assetId)).run();
    if (scenario === "conflicting checkpoint") db.update(generationItems).set({ checkpoint: encryptGenerationValue({ childJobId: "another-child" }) }).where(eq(generationItems.id, link.itemId)).run();
    const before = db.select().from(generationItems).get();
    expect(getGenerationRun("run-A").items[0]).toMatchObject({ status: "needs_attention", errorCode: "GENERATION_IMPORT_FAILED" });
    const synchronized = db.select().from(generationItems).get()!;
    if (scenario === "missing asset" || scenario === "wrong asset path") {
      expect(synchronized.error).toContain("素材绑定不一致");
      expect(decryptGenerationValue(synchronized.checkpoint!)).toMatchObject({ childJobId: link.jobId, klingObserveOnly: true });
    } else expect(synchronized).toEqual(before);
    expect(listGenerationRuns("A")[0].items[0].status).toBe("needs_attention");
    expect(db.select().from(generationItems).get()).toEqual(synchronized);
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });
});

const itemRow = () => getDb().select().from(generationItems).get()!;
const childRow = () => getDb().select().from(klingJobs).get()!;
function makeUnfinished() {
  const [link] = seed(), db = getDb();
  db.delete(klingJobOutputs).run(); db.delete(assets).run();
  db.update(generationItems).set({ checkpoint: encryptGenerationValue({ childJobId: link.jobId }) }).run();
  db.update(klingJobs).set({ submissionState: "prepared", remoteState: "not_started", importState: "not_ready", remoteGenerationId: null,
    data: { ...childRow().data, authorizedBootId: "boot-A", authorizedUntil: Date.now() + 120_000, authorizationEpoch: 2 } }).run();
  return link;
}

describe("Kling child progress reconciliation", () => {
  it.each(["get", "list"])("%s follows manual confirmation, submission, cloud progress and saving without cloud side effects", (method) => {
    const link = makeUnfinished(), db = getDb();
    const read = () => method === "get" ? getGenerationRun("run-A") : listGenerationRuns("A")[0];
    expect(read().items[0]).toMatchObject({ status: "queued", stage: "queued_submission", error: null, errorCode: null });
    expect(decryptGenerationValue(itemRow().checkpoint!)).toMatchObject({ childJobId: link.jobId, klingObserveOnly: true });
    db.update(klingJobs).set({ submissionState: "submitting", data: { ...childRow().data, dispatchStartedAt: Date.now() } }).run();
    expect(read().items[0]).toMatchObject({ status: "running", stage: "submitting", error: null });
    db.update(klingJobs).set({ submissionState: "acknowledged", remoteGenerationId: "remote-1", remoteState: "pending" }).run();
    expect(read().items[0]).toMatchObject({ status: "waiting", stage: "cloud_running", error: null });
    expect(decryptGenerationValue(itemRow().checkpoint!)).toMatchObject({ remoteTaskId: "remote-1", submissionState: "acknowledged", klingObserveOnly: true });
    db.update(klingJobs).set({ remoteState: "processing" }).run();
    expect(read().items[0]).toMatchObject({ status: "waiting", stage: "cloud_running", error: null });
    db.update(klingJobs).set({ remoteState: "completed", importState: "pending" }).run();
    expect(read().items[0]).toMatchObject({ status: "importing", stage: "importing", error: null });
    db.insert(klingJobOutputs).values({ id: link.outputId, jobId: link.jobId, workKey: "work-1", importState: "pending",
      data: { url: "https://example.test/output.mp4", urlObtainedAt: Date.now(), providerWorkId: "work-1" }, createdAt: 1, updatedAt: 1 }).run();
    expect(read().items[0]).toMatchObject({ status: "importing", stage: "importing" });
    db.update(klingJobOutputs).set({ importState: "imported", assetId: link.assetId,
      data: { url: "https://example.test/output.mp4", urlObtainedAt: Date.now(), providerWorkId: "work-1", filePath: link.filePath } }).run();
    db.insert(assets).values({ id: link.assetId, projectId: "A", sourceScriptId: "script-A", shotId: 1, provider: "kling-cli", type: "ai_generated", status: "done", filePath: link.filePath }).run();
    expect(read()).toMatchObject({ status: "completed", done: 1, failed: 0,
      items: [expect.objectContaining({ status: "completed", stage: "ready", error: null, errorCode: null })] });
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });

  it("binds a recovered child before the worker can observe it and keeps repeated reads idempotent", async () => {
    const link = makeUnfinished(), db = getDb();
    db.update(generationItems).set({ checkpoint: null, result: null }).run();
    const first = getGenerationRun("run-A"), stored = itemRow();
    expect(first.items[0]).toMatchObject({ status: "queued", result: { childJobId: link.jobId } });
    expect(decryptGenerationValue(stored.checkpoint!)).toMatchObject({ childJobId: link.jobId, klingObserveOnly: true });
    expect(getGenerationRun("run-A")).toEqual(first); expect(itemRow()).toEqual(stored);
    state.execute.mockResolvedValue({ pending: true, stage: "queued_submission" });
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => expect(itemRow().leaseOwner).toBeNull());
    expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({ checkpoint: expect.objectContaining({ childJobId: link.jobId, klingObserveOnly: true }) }), expect.any(Function));
    expect(state.createKling).not.toHaveBeenCalled();
  });

  it("keeps a partially imported result in saving until every remaining output has a valid asset", () => {
    seed();
    getDb().insert(klingJobOutputs).values({ id: "second-output", jobId: "job-1", workKey: "second", importState: "pending",
      data: { url: "https://example.test/second.mp4", urlObtainedAt: Date.now(), providerWorkId: "second" }, createdAt: 1, updatedAt: 1 }).run();
    expect(getGenerationRun("run-A")).toMatchObject({ status: "running", done: 0, failed: 0,
      items: [expect.objectContaining({ status: "importing", stage: "importing", error: null })] });
  });

  it.each(["pending", "processing"] as const)("clears stale failure once the same child is acknowledged %s", (remoteState) => {
    seed();
    getDb().update(klingJobs).set({ remoteState, importState: "not_ready" }).run();
    expect(getGenerationRun("run-A").items[0]).toMatchObject({ status: "waiting", stage: "cloud_running", error: null, errorCode: null });
  });

  it("removes a stale cached completion before allowing observation of an unfinished child", () => {
    makeUnfinished();
    getDb().update(generationItems).set({ checkpoint: encryptGenerationValue({ childJobId: "job-1", completedResult: { childJobId: "job-1", assetIds: ["missing-old-asset"] } }) }).run();
    expect(getGenerationRun("run-A").items[0]).toMatchObject({ status: "queued", stage: "queued_submission" });
    expect(decryptGenerationValue(itemRow().checkpoint!)).not.toHaveProperty("completedResult");
  });

  it.each(["paused", "confirmation", "unknown submission", "auth blocked"])("reconciles already imported local results despite %s without resuming cloud work", (scenario) => {
    seed();
    if (scenario === "paused") getDb().update(klingJobs).set({ autoQueryPaused: true }).run();
    if (scenario === "confirmation") getDb().update(klingJobs).set({ needsConfirmation: true }).run();
    if (scenario === "unknown submission") getDb().update(klingJobs).set({ submissionState: "submission_unknown" }).run();
    if (scenario === "auth blocked") getDb().update(klingJobs).set({ data: { ...childRow().data, blockedReason: "auth_required" } }).run();
    const before = childRow();
    expect(getGenerationRun("run-A")).toMatchObject({ status: "completed", done: 1, failed: 0 });
    expect(childRow()).toEqual(before); expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)("reflects the original child's cloud %s terminal state", (remoteState) => {
    seed();
    getDb().update(klingJobs).set({ remoteState, data: { ...childRow().data, error: { code: "KLING_REMOTE_FAILED", message: "provider rejected original task", retryable: false } } }).run();
    expect(getGenerationRun("run-A").items[0]).toMatchObject({ status: remoteState, stage: remoteState,
      error: remoteState === "failed" ? "provider rejected original task" : null,
      errorCode: remoteState === "failed" ? "GENERATION_PROVIDER_FAILED" : null });
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });

  it.each(["confirmation", "expired authorization", "other boot", "paused", "auth blocked", "unknown", "not submitted", "failed import", "released child", "released checkpoint", "legacy film", "parent lease", "child lease", "deleted run", "cancelled parent"])("does not reactivate %s", (scenario) => {
    makeUnfinished(); const db = getDb();
    if (scenario === "confirmation") db.update(klingJobs).set({ needsConfirmation: true }).run();
    if (scenario === "expired authorization") db.update(klingJobs).set({ data: { ...childRow().data, authorizedUntil: Date.now() - 1 } }).run();
    if (scenario === "other boot") db.update(klingJobs).set({ data: { ...childRow().data, authorizedBootId: "old-boot" } }).run();
    if (scenario === "paused") db.update(klingJobs).set({ autoQueryPaused: true }).run();
    if (scenario === "auth blocked") db.update(klingJobs).set({ data: { ...childRow().data, blockedReason: "auth_required" } }).run();
    if (scenario === "unknown") db.update(klingJobs).set({ submissionState: "submission_unknown", remoteState: "unknown" }).run();
    if (scenario === "not submitted") db.update(klingJobs).set({ submissionState: "not_submitted" }).run();
    if (scenario === "failed import") db.update(klingJobs).set({ submissionState: "acknowledged", remoteGenerationId: "remote-1", remoteState: "completed", importState: "failed" }).run();
    if (scenario === "released child") db.update(klingJobs).set({ data: { ...childRow().data, blockingReleasedAt: Date.now() } }).run();
    if (scenario === "released checkpoint") db.update(generationItems).set({ checkpoint: encryptGenerationValue({ childJobId: "job-1", blockingReleasedAt: Date.now() }) }).run();
    if (scenario === "legacy film") db.update(klingJobs).set({ data: { ...childRow().data, filmRunId: "removed-workflow" } }).run();
    if (scenario === "parent lease") db.update(generationItems).set({ leaseOwner: `${process.pid}:active`, leaseExpiresAt: Date.now() + 90_000 }).run();
    if (scenario === "child lease") db.update(klingJobs).set({ leaseOwner: `${process.pid}:active`, leaseExpiresAt: Date.now() + 90_000 }).run();
    if (scenario === "deleted run") db.update(generationRuns).set({ deletedAt: Date.now() }).run();
    if (scenario === "cancelled parent") db.update(generationItems).set({ status: "cancelled", stage: "released" }).run();
    const before = itemRow();
    if (scenario === "deleted run") {
      expect(() => getGenerationRun("run-A")).toThrow(expect.objectContaining({ code: "GENERATION_RUN_DELETED" }));
      expect(listGenerationRuns("A")).toEqual([]);
    } else {
      const current = getGenerationRun("run-A").items[0], synchronized = itemRow();
      if (["confirmation", "expired authorization", "other boot", "paused", "auth blocked", "unknown", "not submitted", "failed import"].includes(scenario)) {
        expect(current).toMatchObject({ status: "needs_attention", stage: "needs_attention", result: { childJobId: "job-1" } });
        expect(decryptGenerationValue(synchronized.checkpoint!)).toMatchObject({ childJobId: "job-1", klingObserveOnly: true });
        listGenerationRuns("A"); expect(itemRow()).toEqual(synchronized);
        expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
        return;
      }
      listGenerationRuns("A");
    }
    expect(itemRow()).toEqual(before); expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });

  it.each(["provider", "request project", "request script", "request shot", "batch project", "profile", "worker provenance", "missing provenance", "result child", "completed checkpoint", "remote checkpoint", "snapshot account", "snapshot region", "project signature", "corrupt payload", "missing request", "null checkpoint"])("refuses to attach progress with conflicting %s", (scenario) => {
    makeUnfinished(); const db = getDb(), row = itemRow(), payload = decryptGenerationValue<{ request: Record<string, unknown>; snapshot?: unknown }>(row.payload);
    if (scenario === "provider") payload.request.provider = "other-provider";
    if (scenario === "request project") payload.request.projectId = "B";
    if (scenario === "request script") payload.request.scriptId = "script-B";
    if (scenario === "request shot") payload.request.shotId = 2;
    if (scenario === "batch project") db.update(generationRuns).set({ projectId: "B" }).run();
    if (scenario === "profile") payload.request.profileId = "other-profile";
    if (scenario === "worker provenance") db.update(klingJobs).set({ data: { ...childRow().data, generationItemId: "other-item" } }).run();
    if (scenario === "missing provenance") db.update(klingJobs).set({ data: { ...childRow().data, generationItemId: undefined } }).run();
    if (scenario === "result child") db.update(generationItems).set({ result: { childJobId: "other-child" } }).run();
    if (scenario === "completed checkpoint") db.update(generationItems).set({ checkpoint: encryptGenerationValue({ childJobId: "job-1", completedResult: { childJobId: "other-child" } }) }).run();
    if (scenario === "remote checkpoint") db.update(generationItems).set({ checkpoint: encryptGenerationValue({ childJobId: "job-1", remoteTaskId: "another-remote" }) }).run();
    if (scenario === "null checkpoint") db.update(generationItems).set({ checkpoint: encryptGenerationValue(null) }).run();
    if (scenario === "snapshot account" || scenario === "snapshot region") payload.snapshot = { kling: { profileId: "profile-A", principalKey: scenario === "snapshot account" ? "wrong-account" : "account-A", region: scenario === "snapshot region" ? "wrong-region" : "global" } };
    if (scenario === "project signature") db.update(klingJobs).set({ data: { ...childRow().data, generationProjectSignature: "other-project-inputs" } }).run();
    db.update(generationItems).set({ payload: scenario === "corrupt payload" ? "corrupt" : encryptGenerationValue(scenario === "missing request" ? {} : payload) }).run();
    const before = itemRow();
    getGenerationRun("run-A"); listGenerationRuns("A");
    expect(itemRow()).toEqual(before); expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });

  it("returns a newly blocked active item to attention without submitting or retrying it", () => {
    makeUnfinished();
    getGenerationRun("run-A");
    getDb().update(klingJobs).set({ needsConfirmation: true }).run();
    expect(getGenerationRun("run-A").items[0]).toMatchObject({ status: "needs_attention", stage: "needs_attention", errorCode: "GENERATION_NEEDS_ATTENTION" });
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });

  it("updates an already blocked parent's current error and original-child link after its checkpoint was lost", () => {
    makeUnfinished();
    getDb().update(generationItems).set({ checkpoint: null, result: null }).run();
    getDb().update(klingJobs).set({ needsConfirmation: true,
      data: { ...childRow().data, blockedReason: "account_mismatch", error: { code: "KLING_ACCOUNT_MISMATCH", message: "Please log in to the original account", retryable: false } } }).run();
    expect(getGenerationRun("run-A").items[0]).toMatchObject({ status: "needs_attention", stage: "needs_attention",
      error: "Please log in to the original account", errorCode: "GENERATION_NEEDS_ATTENTION", result: { childJobId: "job-1" } });
    expect(decryptGenerationValue(itemRow().checkpoint!)).toMatchObject({ childJobId: "job-1", klingObserveOnly: true });
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });
});
