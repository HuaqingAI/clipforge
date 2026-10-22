// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({ directory: "", root: "", sqlite: null as Database.Database | null, assertLocal: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory,
  getUploadsDir: () => join(state.directory, "uploads"), getOutputDir: () => join(state.directory, "output") }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  state.sqlite.pragma("foreign_keys = ON");
  return { db, getDb: () => db };
});
vi.mock("@/lib/kling/jobs", () => ({ startKlingJobRunner: vi.fn(), wakeKlingJobRunner: vi.fn() }));
vi.mock("@/lib/kling/local-access", async (original) => ({ ...await original<typeof import("@/lib/kling/local-access")>(),
  assertKlingLocalRequest: (...args: unknown[]) => state.assertLocal(...args) }));

import { getDb } from "@/lib/db";
import { aiTasks, assets, compositions, videoClips } from "@/lib/db/schema";
import { klingJobs, klingJobOutputs, type KlingJob, type KlingJobData } from "@/lib/kling/job-schema";
import { klingFilmRuns, klingFilmShots, type KlingFilmRun } from "@/lib/kling/film-schema";
import { klingFilmView } from "@/lib/kling/film-repository";
import { cleanupDeletedKlingJobs, deleteKlingJob } from "@/lib/kling/delete-job";
import { getKlingJob, listKlingJobs, patchKlingJob, klingJobView, withKlingJobLease, isKlingJobUnresolved, assertKlingJobLease } from "@/lib/kling/repository";
import { klingJobHasUnknownSubmission, klingJobOccupiesGenerationSlot } from "@/lib/kling/concurrency";
import { DELETE } from "@/app/api/integrations/kling/jobs/[id]/route";
import { NextRequest } from "next/server";

const model = { remoteModelId: "model", tool: "text_to_video" } as KlingJobData["model"];
function job(overrides: Partial<KlingJob> = {}): KlingJob {
  const now = Date.now();
  return getDb().insert(klingJobs).values({ id: "job-1", profileId: "profile-1", principalKey: "principal", region: "global", clientRequestId: "request-1",
    projectId: "project-1", scriptId: "script-1", shotId: 1, submissionState: "acknowledged", remoteState: "completed", importState: "completed", remoteGenerationId: "remote-1",
    data: { model, scriptRevision: "revision-1", shotKey: "shot-1", expectedSelectedAssetId: "original-image", payloadHash: "hash", requestHash: "hash", prompt: "prompt", options: {},
      inputs: [], args: [], cliVersion: "0.2.0", adapterVersion: "1", authorizedBootId: "boot", authorizedUntil: 0, authorizationEpoch: 1, billingAcknowledgedAt: now, queryAttempts: 0 },
    createdAt: now, updatedAt: now, ...overrides }).returning().get()!;
}
function video(): { file: string; url: string; source: string } {
  const directory = join(state.directory, "uploads", "project-1", "kling", "job-1");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "output-1.mp4"), url = "/api/files/project-1/kling/job-1/output-1.mp4";
  for (const suffix of ["", ".thumb.jpg", ".last.jpg"]) writeFileSync(file + suffix, "generated");
  const source = join(directory, "source-keyframe.png"); writeFileSync(source, "source image");
  getDb().insert(assets).values({ id: "generated-asset", projectId: "project-1", shotId: 1, type: "ai_generated", provider: "kling-cli", filePath: url,
    thumbnailPath: url + ".thumb.jpg", sourceKeyframeUrl: "/api/files/project-1/kling/job-1/source-keyframe.png", status: "done", selected: true }).run();
  getDb().insert(klingJobOutputs).values({ id: "output-1", jobId: "job-1", workKey: "work-1", assetId: "generated-asset", importState: "imported",
    data: { url: "https://provider.invalid/video.mp4", providerWorkId: "work-1", urlObtainedAt: Date.now(), localPath: file, filePath: url, thumbnailUrl: url + ".thumb.jpg" },
    createdAt: Date.now(), updatedAt: Date.now() }).run();
  return { file, url, source };
}
function film(status: KlingFilmRun["status"], expiresAt = Date.now() + 60_000) {
  getDb().insert(klingFilmRuns).values({ id: "film-1", projectId: "project-1", scriptId: "script-1", profileId: "profile-1", principalKey: "principal", status,
    data: { scriptRevision: "revision-1", scriptSnapshot: { shots: [] }, model, output: { audioStrategy: "native", resolution: "720p", aspectRatio: "9:16", voice: "voice", subtitles: false },
      expiresAt, planHash: "plan", reuseExistingVideos: true, warnings: [], stage: "stage", authorizationEpoch: 1, videoUrl: "/api/output/final.mp4" },
    createdAt: Date.now(), updatedAt: Date.now() }).run();
  getDb().insert(klingFilmShots).values({ id: "film-shot-1", runId: "film-1", shotId: 1, ordinal: 0, status: "ready", jobId: "job-1", assetId: "generated-asset",
    data: { shot: { shotId: 1 } as never, source: "reuse", prompt: "prompt", options: {}, missingKeyframe: false, inputs: [], baselineAssetId: "generated-asset", attempt: 0 }, updatedAt: Date.now() }).run();
}

beforeAll(() => { state.root = mkdtempSync(join(tmpdir(), "clipforge-kling-delete-")); });
beforeEach(() => {
  state.assertLocal.mockReset();
  state.directory = join(state.root, randomUUID()); mkdirSync(join(state.directory, "uploads"), { recursive: true }); mkdirSync(join(state.directory, "output"));
  state.sqlite!.exec("DELETE FROM generation_reviews; DELETE FROM video_clips; DELETE FROM media_sources; DELETE FROM compositions; DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM ai_tasks; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects; DELETE FROM kling_profiles;");
  state.sqlite!.prepare("INSERT INTO kling_profiles(id,data) VALUES (?,?)").run("profile-1", "{}");
  state.sqlite!.prepare("INSERT INTO projects(id,name) VALUES (?,?)").run("project-1", "Test");
  state.sqlite!.prepare("INSERT INTO scripts(id,project_id,style_type,shots,selected) VALUES (?,?,?,?,?)").run("script-1", "project-1", "scene", "[]", 1);
  writeFileSync(join(state.directory, "uploads", "original.png"), "original image");
  getDb().insert(assets).values({ id: "original-image", projectId: "project-1", shotId: 1, type: "product_image", filePath: "/api/files/original.png", status: "done", selected: false }).run();
});
afterAll(() => { state.sqlite?.close(); if (state.root && resolve(state.root).startsWith(resolve(tmpdir()))) rmSync(state.root, { recursive: true, force: true }); });

describe("deleting locally generated Kling videos", () => {
  it("removes video, frames, output assets and FK references while preserving keyframes, copies and completed films", () => {
    const row = job(); const { file, url, source } = video();
    getDb().insert(assets).values({ id: "adopted", projectId: "project-1", shotId: 1, type: "ai_generated", provider: "kling-cli", filePath: url,
      derivedFromAssetId: "generated-asset", status: "done", selected: false }).run();
    const copy = join(state.directory, "uploads", "independent-copy.mp4"); writeFileSync(copy, "independent copy");
    getDb().insert(assets).values({ id: "edited-copy", projectId: "project-1", shotId: 1, type: "ai_generated", provider: "kling-cli", filePath: copy,
      derivedFromAssetId: "generated-asset", status: "done", selected: false }).run();
    getDb().insert(videoClips).values({ id: "clip-1", projectId: "project-1", shotId: 1, assetId: "generated-asset", status: "done" }).run();
    state.sqlite!.prepare("INSERT INTO generation_reviews(id,project_id,asset_id,shot_id,contract,report,disposition,evaluator_model,verdict) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("review-1", "project-1", "generated-asset", 1, "{}", "{}", "{}", "model", "accept");
    getDb().insert(aiTasks).values({ id: "task-1", provider: "kling-cli", model: "model", taskId: "remote-1", status: "completed", resultUrls: [url] }).run();
    patchKlingJob(row.id, {}, { aiTaskId: "task-1" });
    film("completed");
    const final = join(state.directory, "output", "final.mp4"); writeFileSync(final, "completed film");
    getDb().insert(compositions).values({ projectId: "project-1", outputPath: final, status: "done" }).run();

    expect(klingJobView(getKlingJob(row.id)).allowedActions).toContain("delete");
    expect(deleteKlingJob(row.id)).toEqual({ deleted: true, jobId: row.id });
    for (const suffix of ["", ".thumb.jpg", ".last.jpg"]) expect(existsSync(file + suffix)).toBe(false);
    for (const keep of [source, copy, final, join(state.directory, "uploads", "original.png")]) expect(existsSync(keep)).toBe(true);
    expect(getDb().select().from(assets).all().map((item) => item.id).sort()).toEqual(["edited-copy", "original-image"]);
    expect(getDb().select().from(assets).where(eq(assets.id, "edited-copy")).get()?.derivedFromAssetId).toBeNull();
    expect(getDb().select().from(assets).where(eq(assets.id, "original-image")).get()?.selected).toBe(true);
    expect(getDb().select().from(videoClips).get()?.assetId).toBeNull();
    expect(getDb().select().from(klingJobOutputs).all()).toEqual([]);
    expect(getDb().select().from(aiTasks).all()).toEqual([]);
    expect(state.sqlite!.prepare("SELECT * FROM generation_reviews").all()).toEqual([]);
    expect(state.sqlite!.pragma("foreign_key_check")).toEqual([]);
    expect(listKlingJobs("project-1")).toEqual([]);
    expect(deleteKlingJob(row.id)).toEqual({ deleted: true, jobId: row.id });
    expect(() => getKlingJob(row.id)).toThrowError("已删除");
    expect(() => patchKlingJob(row.id, { autoQueryPaused: false })).toThrowError("已删除");
  });
  it.each([
    { submissionState: "prepared" }, { submissionState: "submitting" }, { submissionState: "submission_unknown", remoteState: "failed" },
    { remoteState: "pending" }, { remoteState: "processing" }, { importState: "importing" },
    { leaseOwner: "worker", leaseExpiresAt: Date.now() + 120_000 },
  ] as Partial<KlingJob>[]) ("allows immediate local deletion while generation, submission or a worker is active: %j", (overrides) => {
    const row = job(overrides); const { file } = video();
    expect(klingJobView(row).allowedActions).toContain("delete");
    expect(deleteKlingJob("job-1")).toEqual({ deleted: true, jobId: "job-1" });
    expect(listKlingJobs()).toHaveLength(0);
    const audit = getDb().select().from(klingJobs).get()!;
    expect(klingJobHasUnknownSubmission(audit)).toBe(false);
    expect(klingJobOccupiesGenerationSlot(audit)).toBe(false);
    expect(isKlingJobUnresolved(audit)).toBe(false);
    if (overrides.leaseOwner) {
      expect(existsSync(file)).toBe(true);
      getDb().update(klingJobs).set({ leaseOwner: null, leaseExpiresAt: null }).run();
      cleanupDeletedKlingJobs();
    }
    expect(existsSync(file)).toBe(false);
  });
  it.each(["failed", "cancelled"] as const)("deletes a %s terminal job with no downloaded video", (remoteState) => {
    job({ remoteState, importState: "not_ready" });
    expect(deleteKlingJob("job-1").deleted).toBe(true);
  });
  it("does not let a deleted failed import block future generation for the shot", () => {
    job({ importState: "failed" });
    deleteKlingJob("job-1");
    const audit = getDb().select().from(klingJobs).where(eq(klingJobs.id, "job-1")).get()!;
    expect(isKlingJobUnresolved(audit)).toBe(false);
  });
  it("deletes a cancelled prepared job without reopening its submission", async () => {
    job({ submissionState: "not_submitted", remoteState: "not_started", importState: "not_ready" });
    deleteKlingJob("job-1");
    await expect(withKlingJobLease("job-1", async () => "cannot run")).rejects.toMatchObject({ code: "KLING_JOB_DELETED", status: 410 });
  });
  it.each(["downloading", "validating"] as const)("allows deletion of a %s output with stale top-level import state", (importState) => {
    job(); video(); getDb().update(klingJobOutputs).set({ importState }).run();
    expect(deleteKlingJob("job-1").deleted).toBe(true);
  });
  it("revokes an active lease immediately and cleans files written by the late worker only after it exits", async () => {
    job({ remoteState: "processing", importState: "importing" }); const { file, source } = video();
    let ready!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const worker = withKlingJobLease("job-1", async () => {
      ready(); await blocked;
      writeFileSync(file + ".last.jpg", "late frame");
      assertKlingJobLease("job-1");
    });
    const settled = worker.catch((error) => error);
    await started;
    expect(deleteKlingJob("job-1").deleted).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(listKlingJobs()).toEqual([]);
    finish(); expect(await settled).toMatchObject({ code: "KLING_JOB_DELETED" });
    for (const suffix of ["", ".last.jpg", ".thumb.jpg"]) expect(existsSync(file + suffix)).toBe(false);
    expect(existsSync(source)).toBe(true);
    expect(getDb().select().from(klingJobs).get()?.data.deletePendingOutputIds).toEqual([]);
  });
  it("recovers deferred cleanup after a vanished worker without touching unrelated or source files", () => {
    job({ leaseOwner: "999999999:old-worker", leaseExpiresAt: Date.now() + 60_000 }); const { file, source } = video();
    deleteKlingJob("job-1");
    expect(existsSync(file)).toBe(true);
    writeFileSync(file + ".last.jpg", "worker's late frame");
    const unrelated = file + ".unrelated.mp4"; writeFileSync(unrelated, "unrelated");
    getDb().update(klingJobs).set({ leaseExpiresAt: Date.now() - 1 }).run();
    cleanupDeletedKlingJobs();
    expect(existsSync(file)).toBe(false); expect(existsSync(file + ".last.jpg")).toBe(false);
    expect(existsSync(source)).toBe(true); expect(existsSync(unrelated)).toBe(true);
  });
  it("keeps deletion successful if deferred cleanup fails and retries its durable output list later", () => {
    job({ leaseOwner: "999999999:old-worker", leaseExpiresAt: Date.now() + 60_000 }); const { file } = video();
    deleteKlingJob("job-1");
    getDb().update(klingJobs).set({ leaseOwner: null, leaseExpiresAt: null }).run();
    state.sqlite!.exec("CREATE TRIGGER reject_cleanup BEFORE UPDATE ON kling_jobs WHEN json_array_length(json_extract(NEW.data, '$.deletePendingOutputIds')) = 0 BEGIN SELECT RAISE(ABORT, 'fixture cleanup failure'); END;");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(deleteKlingJob("job-1")).toEqual({ deleted: true, jobId: "job-1" });
      expect(warning).toHaveBeenCalled();
      expect(getDb().select().from(klingJobs).get()?.data.deletePendingOutputIds).toEqual(["output-1"]);
    } finally { state.sqlite!.exec("DROP TRIGGER reject_cleanup;"); warning.mockRestore(); }
    cleanupDeletedKlingJobs();
    expect(existsSync(file)).toBe(false);
    expect(getDb().select().from(klingJobs).get()?.data.deletePendingOutputIds).toEqual([]);
  });
  it.each(["draft", "running", "paused", "needs_attention", "composing"] as const)("protects a video referenced by a %s film", (status) => {
    job(); const { file } = video(); film(status);
    expect(() => deleteKlingJob("job-1")).toThrowError("整片");
    expect(existsSync(file)).toBe(true);
  });
  it.each(["cancelled", "draft"] as const)("allows a cancelled or expired plan: %s", (status) => {
    job(); video(); film(status, Date.now() - 1000);
    expect(deleteKlingJob("job-1").deleted).toBe(true);
  });
  it.each([
    ["cancelled", "deleted"], ["cancelled", "missing"], ["draft", "deleted"], ["draft", "missing"],
  ] as const)("keeps historical %s film details readable when a failed child job is %s", (status, condition) => {
    job({ remoteState: "failed", importState: "not_ready" }); film(status, Date.now() - 1000);
    getDb().update(klingFilmShots).set({ status: "needs_attention" }).run();
    if (condition === "deleted") deleteKlingJob("job-1");
    else getDb().delete(klingJobs).where(eq(klingJobs.id, "job-1")).run();
    const run = getDb().select().from(klingFilmRuns).get()!;
    const view = klingFilmView(run);
    expect(view).toMatchObject({ status, runId: "film-1", shots: [{ id: "film-shot-1", status: "needs_attention", allowedActions: [] }] });
    expect(view.allowedActions).not.toContain("retry-shot");
  });
  it("protects an ordinary pending composition", () => {
    job(); video(); getDb().insert(compositions).values({ projectId: "project-1", status: "composing" }).run();
    expect(() => deleteKlingJob("job-1")).toThrowError("正在合成");
  });
  it("preserves shared bytes and shared thumbnails referenced by independent assets", () => {
    job(); const { file, url } = video();
    getDb().insert(assets).values({ id: "shared", projectId: "project-1", shotId: 2, type: "user_upload", filePath: url,
      thumbnailPath: url + ".thumb.jpg", status: "done", selected: false }).run();
    deleteKlingJob("job-1");
    expect(existsSync(file)).toBe(true); expect(existsSync(file + ".thumb.jpg")).toBe(true);
    expect(getDb().select().from(assets).where(eq(assets.id, "shared")).get()).toBeTruthy();
    expect(getDb().select().from(assets).where(eq(assets.id, "generated-asset")).get()).toBeUndefined();
  });
  it("does not follow external paths or remove source images and unrelated files in its job directory", () => {
    job(); const { file, source } = video();
    const outside = join(state.directory, "outside.mp4"); writeFileSync(outside, "unowned");
    const unrelated = join(state.directory, "uploads", "project-1", "kling", "job-1", "other.mp4"); writeFileSync(unrelated, "unrelated");
    getDb().update(klingJobOutputs).set({ data: { url: "https://example.invalid/remote.mp4", urlObtainedAt: 0, providerWorkId: "work-1", localPath: outside,
      filePath: "/api/files/../../outside.mp4", thumbnailUrl: "/api/files/original.png" } }).run();
    deleteKlingJob("job-1");
    for (const keep of [outside, unrelated, source, join(state.directory, "uploads", "original.png")]) expect(existsSync(keep)).toBe(true);
    expect(existsSync(file)).toBe(true); // The surviving asset still references it after mismatched metadata.
  });
  it("rolls staged files back when a database write fails", () => {
    job(); const { file } = video();
    state.sqlite!.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON assets WHEN OLD.id = 'generated-asset' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    try {
      expect(() => deleteKlingJob("job-1")).toThrowError("原记录和文件已保留");
      expect(existsSync(file)).toBe(true);
      expect(getKlingJob("job-1")).toBeTruthy();
      expect(getDb().select().from(klingJobOutputs).all()).toHaveLength(1);
    } finally { state.sqlite!.exec("DROP TRIGGER reject_delete;"); }
  });
  it("uses the authenticated mutation guard and returns the delete contract", async () => {
    job(); video();
    const request = new NextRequest("http://localhost:3000/api/integrations/kling/jobs/job-1", { method: "DELETE", headers: { "Content-Type": "application/json" } });
    const response = await DELETE(request, { params: Promise.resolve({ id: "job-1" }) });
    expect(state.assertLocal).toHaveBeenCalledWith(request, true);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ deleted: true, jobId: "job-1" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    state.assertLocal.mockRejectedValueOnce(Object.assign(new Error("禁止跨站删除"), { code: "KLING_LOCAL_ACCESS_DENIED", status: 403 }));
    const denied = await DELETE(request, { params: Promise.resolve({ id: "job-1" }) });
    expect(denied.status).toBe(403);
  });
  it("returns 404 for an unknown id and rejects invalid path-like ids", () => {
    expect(() => deleteKlingJob("missing")).toThrowError("没有找到");
    expect(() => deleteKlingJob("../job-1")).toThrowError("任务编号无效");
  });
});
