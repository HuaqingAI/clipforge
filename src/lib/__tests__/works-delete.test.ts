// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({ directory: "", root: "", sqlite: null as Database.Database | null, unlinkFailure: false }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(),
  unlinkSync: (file: string) => {
    if (state.unlinkFailure) throw Object.assign(new Error("fixture file lock"), { code: "EPERM" });
    return (awaitedFs.unlinkSync)(file);
  } }));
// Keep one actual fs binding for the single cleanup-failure fixture.
const awaitedFs = await vi.importActual<typeof import("node:fs")>("node:fs");
vi.mock("@/lib/paths", async (original) => ({ ...await original<typeof import("@/lib/paths")>(), getDataDir: () => state.directory,
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
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFirstFrame: vi.fn() }));

import { getDb } from "@/lib/db";
import { assets, batchJobItems, batchJobs, compositions, mediaEdits, mediaSources, pipelineRuns, projects } from "@/lib/db/schema";
import { klingFilmRuns, klingFilmShots, type KlingFilmData, type KlingFilmRun } from "@/lib/kling/film-schema";
import { assertWorkDeleteOrigin, deleteWork } from "@/lib/delete-work";
import { DELETE } from "@/app/api/works/[id]/route";
import { GET } from "@/app/api/works/route";
import { NextRequest } from "next/server";

function file(name: string, content = name): string {
  const target = join(state.directory, name); mkdirSync(resolve(target, ".."), { recursive: true }); writeFileSync(target, content); return target;
}
function work(id = "work-1", status: "pending" | "composing" | "done" | "failed" = "done", outputPath?: string) {
  const path = outputPath ?? file(`output/project-1/final_${id}.mp4`);
  const thumbnail = path + ".thumb.jpg";
  if (!outputPath) writeFileSync(thumbnail, "poster");
  return getDb().insert(compositions).values({ id, projectId: "project-1", outputPath: path, thumbnailPath: thumbnail, status }).returning().get()!;
}
function edit(status: "done" | "queued" | "rendering" = "done") {
  getDb().insert(mediaSources).values({ id: "source-1", projectId: "project-1", originalName: "original.mp4", filePath: file("uploads/project-1/original.mp4"), mimeType: "video/mp4" }).run();
  getDb().insert(mediaEdits).values({ id: "edit-1", projectId: "project-1", sourceId: "source-1", compositionId: "work-1", status, plan: {} as never, keepRanges: [] }).run();
}
function film(status: KlingFilmRun["status"], linked = true) {
  const data = { compositionId: linked ? "work-1" : undefined, videoUrl: linked ? "/api/output/project-1/final_work-1.mp4" : undefined,
    thumbnailUrl: "/api/output/project-1/final_work-1.mp4.thumb.jpg", quality: { width: 1280, height: 720, hasAudio: true, duration: 5 },
    expiresAt: Date.now() + 60_000, stage: "completed", authorizationEpoch: 1, scriptSnapshot: { shots: [] }, warnings: [] } as unknown as KlingFilmData;
  return getDb().insert(klingFilmRuns).values({ id: "film-1", projectId: "project-1", scriptId: "script-1", profileId: "profile-1", principalKey: "principal", status,
    data, createdAt: Date.now(), updatedAt: Date.now() }).returning().get()!;
}

beforeAll(() => { state.root = mkdtempSync(join(tmpdir(), "clipforge-works-delete-")); });
beforeEach(() => {
  state.unlinkFailure = false;
  state.directory = join(state.root, randomUUID()); mkdirSync(join(state.directory, "output", "project-1"), { recursive: true });
  state.sqlite!.exec("DROP TRIGGER IF EXISTS reject_work_delete; DELETE FROM media_edits; DELETE FROM media_sources; DELETE FROM pipeline_runs; DELETE FROM batch_job_items; DELETE FROM batch_jobs; DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM compositions; DELETE FROM assets; DELETE FROM projects;");
  getDb().insert(projects).values({ id: "project-1", name: "Fixture project" }).run();
});
afterAll(() => { state.sqlite?.close(); if (state.root && resolve(state.root).startsWith(resolve(tmpdir()))) rmSync(state.root, { recursive: true, force: true }); });

describe("completed work deletion", () => {
  it("removes just the chosen final, poster and exact sidecars while retaining project, originals, other works and historical links", async () => {
    const target = work(); const other = work("work-2");
    const sidecars = [".timeline.json", ".last.jpg", ".mastering.json"].map((suffix) => file(`output/project-1/final_work-1.mp4${suffix}`));
    const diagnostic = file("output/project-1/.composition-work-1.error.json");
    const stems = [file("output/project-1/stems_work-1/voice.wav"), file("output/project-1/stems_work-1/bgm.wav")];
    const independent = file("output/project-1/final_work-1-extra.mp4");
    const music = file("uploads/project-1/bgm.mp3"); getDb().update(compositions).set({ bgmPath: music }).where(eq(compositions.id, "work-1")).run();
    const asset = file("uploads/project-1/shot.mp4"); getDb().insert(assets).values({ id: "asset-1", projectId: "project-1", shotId: 1, type: "user_upload", filePath: asset, status: "done" }).run();
    edit(); const run = film("completed");
    getDb().insert(pipelineRuns).values({ id: "pipeline-1", projectId: "project-1", compositionId: "work-1", status: "done" }).run();
    getDb().insert(batchJobs).values({ id: "batch-1", total: 1, status: "done" }).run();
    getDb().insert(batchJobItems).values({ id: "item-1", jobId: "batch-1", productId: "product-1", productName: "Product", compositionId: "work-1", status: "done" }).run();

    expect(deleteWork("work-1")).toEqual({ deleted: true, workId: "work-1" });
    for (const removed of [target.outputPath!, target.thumbnailPath!, ...sidecars, ...stems, diagnostic]) expect(existsSync(removed)).toBe(false);
    for (const kept of [other.outputPath!, other.thumbnailPath!, independent, asset, music, join(state.directory, "uploads", "project-1", "original.mp4")]) expect(existsSync(kept)).toBe(true);
    expect(getDb().select().from(projects).all()).toHaveLength(1);
    expect(getDb().select().from(assets).all()).toHaveLength(1);
    expect(getDb().select().from(mediaEdits).get()?.compositionId).toBeNull();
    expect(getDb().select().from(pipelineRuns).get()?.compositionId).toBeNull();
    expect(getDb().select().from(batchJobItems).get()?.compositionId).toBeNull();
    expect(getDb().select().from(klingFilmRuns).get()).toMatchObject({ status: "completed", data: { stage: "成片已删除", scriptSnapshot: run.data.scriptSnapshot } });
    expect(getDb().select().from(klingFilmRuns).get()?.data.compositionId).toBeUndefined();
    expect(getDb().select().from(klingFilmRuns).get()?.data.videoUrl).toBeUndefined();
    expect(state.sqlite!.pragma("foreign_key_check")).toEqual([]);
    const feed = await GET(); expect(await feed.json()).toMatchObject({ works: [{ id: "work-2" }] });
    expect(() => deleteWork("work-1")).toThrowError("已删除");
  });
  it.each(["pending", "composing", "failed"] as const)("rejects a %s composition", (status) => {
    const row = work("work-1", status);
    expect(() => deleteWork(row.id)).toThrowError("只能删除已完成");
    expect(existsSync(row.outputPath!)).toBe(true);
  });
  it.each(["pending", "composing"] as const)("protects a source while another %s composition runs", (status) => {
    work(); work("work-2", status);
    expect(() => deleteWork("work-1")).toThrowError("正在合成或精修");
  });
  it.each(["queued", "rendering"] as const)("protects a %s transcript render", (status) => {
    work(); edit(status); expect(() => deleteWork("work-1")).toThrowError("剪辑任务");
  });
  it.each(["running", "paused", "needs_attention", "composing"] as const)("protects a %s linked film", (status) => {
    work(); film(status); expect(() => deleteWork("work-1")).toThrowError("整片任务尚未结束");
  });
  it("protects a completed film until its live lease releases", () => {
    work(); film("completed"); getDb().update(klingFilmRuns).set({ leaseOwner: "worker", leaseExpiresAt: Date.now() + 60_000 }).run();
    expect(() => deleteWork("work-1")).toThrowError("尚未结束");
  });
  it("protects a video used as a shot by a valid draft film", () => {
    const row = work(); film("draft", false);
    getDb().insert(klingFilmShots).values({ id: "film-shot", runId: "film-1", shotId: 1, ordinal: 0, status: "ready", updatedAt: Date.now(),
      data: { videoUrl: "/api/output/project-1/final_work-1.mp4", sourceFilePath: row.outputPath, inputs: [], shot: {} } as never }).run();
    expect(() => deleteWork("work-1")).toThrowError("有效整片计划");
  });
  it("protects an active production or batch reference", () => {
    work(); getDb().insert(pipelineRuns).values({ id: "pipeline-1", projectId: "project-1", compositionId: "work-1", status: "running" }).run();
    expect(() => deleteWork("work-1")).toThrowError("生产任务");
    getDb().delete(pipelineRuns).run();
    getDb().insert(batchJobs).values({ id: "batch-1", total: 1, status: "running" }).run();
    getDb().insert(batchJobItems).values({ id: "item-1", jobId: "batch-1", productId: "product-1", productName: "Product", compositionId: "work-1", status: "composing" }).run();
    expect(() => deleteWork("work-1")).toThrowError("批量任务");
  });
  it.each(["absolute", "data-relative", "api-route"] as const)("preserves bytes shared by another work through a %s path", (format) => {
    const first = work();
    const alias = format === "absolute" ? first.outputPath! : format === "data-relative" ? relative(state.directory, first.outputPath!) : "/api/output/project-1/final_work-1.mp4";
    work("work-2", "done", alias);
    const sidecar = file("output/project-1/final_work-1.mp4.timeline.json");
    deleteWork("work-1");
    expect(existsSync(first.outputPath!)).toBe(true); expect(existsSync(first.thumbnailPath!)).toBe(true); expect(existsSync(sidecar)).toBe(true);
    expect(getDb().select().from(compositions).all()).toHaveLength(1);
  });
  it("preserves a final re-used as an independent source asset", () => {
    const row = work(); getDb().insert(assets).values({ projectId: "project-1", shotId: 1, type: "user_upload", filePath: "/api/output/project-1/final_work-1.mp4", status: "done" }).run();
    deleteWork("work-1"); expect(existsSync(row.outputPath!)).toBe(true);
  });
  it.each(["outside", "upload", "other-project", "remote"] as const)("never deletes a referenced %s file", (location) => {
    const path = location === "remote" ? "https://provider.invalid/video.mp4" : location === "outside" ? file("elsewhere/source.mp4") :
      location === "upload" ? file("uploads/project-1/source.mp4") : file("output/project-2/source.mp4");
    work("work-1", "done", path); deleteWork("work-1");
    if (location !== "remote") expect(existsSync(path)).toBe(true);
  });
  it("rejects directory junctions pointing to another project's output", () => {
    const actual = file("output/project-2/shared.mp4");
    const linked = join(state.directory, "output", "project-1", "linked"); symlinkSync(resolve(actual, ".."), linked, "junction");
    work("work-1", "done", join(linked, "shared.mp4")); deleteWork("work-1"); expect(existsSync(actual)).toBe(true);
  });
  it("allows removal of a record whose final file is already missing", () => {
    const row = work(); rmSync(row.outputPath!); deleteWork("work-1");
    expect(existsSync(row.thumbnailPath!)).toBe(false); expect(getDb().select().from(compositions).all()).toEqual([]);
  });
  it("rolls staged files and historical pointers back when the DB delete fails", () => {
    const row = work(); film("completed"); edit();
    state.sqlite!.exec("CREATE TRIGGER reject_work_delete BEFORE DELETE ON compositions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    expect(() => deleteWork("work-1")).toThrowError("作品与文件已保留");
    expect(readFileSync(row.outputPath!, "utf8")).toContain("final_work-1"); expect(existsSync(row.thumbnailPath!)).toBe(true);
    expect(getDb().select().from(compositions).all()).toHaveLength(1);
    expect(getDb().select().from(mediaEdits).get()?.compositionId).toBe("work-1");
    expect(getDb().select().from(klingFilmRuns).get()?.data.compositionId).toBe("work-1");
  });
  it("reports success after commit even if a hidden staged-file cleanup is temporarily locked", () => {
    const row = work(); state.unlinkFailure = true;
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(deleteWork("work-1")).toEqual({ deleted: true, workId: "work-1" });
      expect(existsSync(row.outputPath!)).toBe(false); expect(getDb().select().from(compositions).all()).toEqual([]);
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); state.unlinkFailure = false; }
  });
  it("returns the route contract and Chinese errors, denies cross-site requests, and validates ids", async () => {
    work();
    const request = new NextRequest("http://localhost:3000/api/works/work-1", { method: "DELETE", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" } });
    const denied = await DELETE(new NextRequest(request, { headers: { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" } }), { params: Promise.resolve({ id: "work-1" }) });
    expect(denied.status).toBe(403); expect(getDb().select().from(compositions).all()).toHaveLength(1);
    const response = await DELETE(request, { params: Promise.resolve({ id: "work-1" }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ deleted: true, workId: "work-1" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const missing = await DELETE(request, { params: Promise.resolve({ id: "work-1" }) }); expect(missing.status).toBe(404);
    const invalid = await DELETE(request, { params: Promise.resolve({ id: "../work-1" }) }); expect(invalid.status).toBe(400);
  });
  it("accepts normal desktop/server requests and preserves the real loopback Host when Next canonicalizes its URL", () => {
    expect(() => assertWorkDeleteOrigin(new Request("http://localhost:3000/api/works/work-1", { method: "DELETE" }))).not.toThrow();
    expect(() => assertWorkDeleteOrigin(new Request("http://localhost:3000/api/works/work-1", { method: "DELETE", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }))).not.toThrow();
  });
});
