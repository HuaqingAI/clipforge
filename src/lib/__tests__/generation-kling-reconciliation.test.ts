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
vi.mock("@/lib/kling/jobs", () => ({ createKlingJob: state.createKling }));

import { getDb } from "@/lib/db";
import { assets, projects, scripts } from "@/lib/db/schema";
import { generationItems, generationRuns } from "@/lib/generation-schema";
import { klingJobs, klingJobOutputs } from "@/lib/kling/job-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { decryptGenerationValue, encryptGenerationValue } from "@/lib/generation-secrets";
import { getGenerationRun, listGenerationRuns, stopGenerationRunner } from "@/lib/generation-runs";

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
afterEach(() => { vi.unstubAllEnvs(); });

describe("Kling child completion reconciliation", () => {
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

  it.each(["deleted job", "deleted output", "partial outputs", "wrong item", "wrong project", "wrong script", "wrong shot", "live parent lease", "missing asset", "wrong asset path", "conflicting checkpoint"])("leaves %s unresolved", (scenario) => {
    const [link] = seed(), db = getDb();
    if (scenario === "deleted job") db.update(klingJobs).set({ data: { deletedAt: Date.now() } as never }).where(eq(klingJobs.id, link.jobId)).run();
    if (scenario === "deleted output") {
      const output = db.select().from(klingJobOutputs).get()!;
      db.update(klingJobOutputs).set({ data: { ...output.data, deletedAt: Date.now() } }).where(eq(klingJobOutputs.id, link.outputId)).run();
    }
    if (scenario === "partial outputs") db.insert(klingJobOutputs).values({ id: "pending-output", jobId: link.jobId, workKey: "pending-work", importState: "pending",
      data: { url: "https://example.test/pending.mp4", urlObtainedAt: Date.now(), providerWorkId: "pending-work" }, createdAt: 1, updatedAt: 1 }).run();
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
    expect(listGenerationRuns("A")[0].items[0].status).toBe("needs_attention");
    expect(db.select().from(generationItems).get()).toEqual(before);
    expect(state.execute).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });
});
