// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({ directory: "", root: "", sqlite: null as Database.Database | null, unlinkFailure: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, unlinkSync: (path: string) => {
    if (state.unlinkFailure) throw Object.assign(new Error("Fixture file lock"), { code: "EPERM" });
    return actual.unlinkSync(path);
  } };
});
vi.mock("@/lib/paths", async (original) => ({ ...await original<typeof import("@/lib/paths")>(),
  getDataDir: () => state.directory,
  getUploadsDir: () => join(state.directory, "uploads"),
  getOutputDir: () => join(state.directory, "output"),
}));
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
vi.mock("@/lib/kling/download", () => ({ downloadPublicFile: vi.fn(async () => { throw new Error("Unexpected fixture download"); }) }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: vi.fn() }));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFirstFrame: vi.fn(), extractLastFrame: vi.fn() }));

import { getDb } from "@/lib/db";
import { assets, compositions, projects, scripts, settings, videoClips, type Shot } from "@/lib/db/schema";
import { klingFilmRuns, klingFilmShots, type KlingFilmData, type KlingFilmRun } from "@/lib/kling/film-schema";
import { klingJobs, klingJobOutputs, type KlingJobData } from "@/lib/kling/job-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { importKlingOutputs } from "@/lib/kling/output-import";
import { downloadPublicFile } from "@/lib/kling/download";
import { klingJobView } from "@/lib/kling/repository";
import { assertShotDeleteOrigin, deleteLocalShotVideo, listLocalShotVideos, ShotLibraryError } from "@/lib/shot-library";
import { GET } from "@/app/api/shots/route";
import { DELETE } from "@/app/api/shots/[id]/route";
import { NextRequest } from "next/server";

function file(name: string, content = name): string {
  const target = join(state.directory, name);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function shot(shotId = 1, description = "The original script shot"): Shot {
  return { shotId, type: "demo", duration: 5, description, camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "Demo voiceover" };
}

function script(id = "script-1", selected = false) {
  return getDb().insert(scripts).values({ id, projectId: "project-1", title: `Plan ${id}`, version: 2, styleType: "scene", selected, shots: [shot()] }).returning().get()!;
}

function asset(id = "asset-1", overrides: Partial<typeof assets.$inferInsert> = {}) {
  return getDb().insert(assets).values({ id, projectId: "project-1", shotId: 1, type: "ai_generated", status: "done", filePath: "filePath" in overrides ? overrides.filePath : file(`uploads/project-1/${id}.mp4`), provider: "kling", model: "kling-test", ...overrides }).returning().get()!;
}

function clip(id = "clip-1", overrides: Partial<typeof videoClips.$inferInsert> = {}) {
  return getDb().insert(videoClips).values({ id, projectId: "project-1", shotId: 1, filePath: "filePath" in overrides ? overrides.filePath : file(`uploads/project-1/${id}.mp4`), provider: "kling", model: "kling-test", status: "done", duration: 5000, ...overrides }).returning().get()!;
}

function output(localPath = file("uploads/project-1/kling-output.mp4"), linkedAssetId: string | null = null) {
  const now = Date.now();
  getDb().insert(klingProfiles).values({ id: "profile-1", data: {} as never }).onConflictDoNothing().run();
  getDb().insert(klingJobs).values({ id: "job-1", profileId: "profile-1", principalKey: "principal", region: "global", clientRequestId: "request-1", projectId: "project-1", scriptId: "script-1", shotId: 1,
    submissionState: "acknowledged", remoteState: "completed", importState: "completed", createdAt: now, updatedAt: now,
    data: { scriptRevision: "original-revision", shotKey: "original-shot", expectedSelectedAssetId: null, model: { remoteModelId: "kling-test" }, inputs: [], options: {}, args: [], queryAttempts: 1 } as unknown as KlingJobData }).run();
  return getDb().insert(klingJobOutputs).values({ id: "output-1", jobId: "job-1", workKey: "provider-work-1", assetId: linkedAssetId, importState: "imported", createdAt: now, updatedAt: now,
    data: { url: "https://provider.invalid/private-signed-video?token=secret", urlObtainedAt: now, providerWorkId: "provider-work-1", localPath, durationMs: 6500, selectionOutcome: "kept_as_alternative" } }).returning().get()!;
}

function film(status: KlingFilmRun["status"], path: string, assetId?: string) {
  const now = Date.now();
  getDb().insert(klingFilmRuns).values({ id: "film-1", projectId: "project-1", scriptId: "script-1", profileId: "profile-1", principalKey: "principal", status,
    data: { expiresAt: now + 60_000, stage: "working", authorizationEpoch: 1, scriptSnapshot: { shots: [shot()] }, warnings: [] } as unknown as KlingFilmData, createdAt: now, updatedAt: now }).run();
  getDb().insert(klingFilmShots).values({ id: "film-shot-1", runId: "film-1", shotId: 1, ordinal: 0, assetId, status: "ready", updatedAt: now,
    data: { shot: shot(), source: "reuse", sourceFilePath: path, inputs: [], baselineAssetId: assetId ?? null } as never }).run();
}

function listed(name: string) {
  const result = listLocalShotVideos().find((item) => item.fileName === name);
  expect(result, `Expected ${name} in the local shot library`).toBeDefined();
  return result!;
}

function expectStatus(action: () => unknown, status: number) {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(ShotLibraryError);
    expect(error).toHaveProperty("status", status);
    return;
  }
  throw new Error(`Expected ShotLibraryError with status ${status}`);
}

beforeAll(() => { state.root = mkdtempSync(join(tmpdir(), "clipforge-shot-library-")); });
beforeEach(() => {
  vi.clearAllMocks();
  state.unlinkFailure = false;
  state.directory = join(state.root, randomUUID());
  mkdirSync(join(state.directory, "uploads", "project-1"), { recursive: true });
  state.sqlite!.exec("DROP TRIGGER IF EXISTS reject_shot_delete; DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM kling_profiles; DELETE FROM video_clips; DELETE FROM compositions; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects; DELETE FROM settings;");
  getDb().insert(projects).values({ id: "project-1", name: "Fixture project", productName: "Fixture product" }).run();
});
afterAll(() => {
  state.sqlite?.close();
  if (state.root && resolve(state.root).startsWith(resolve(tmpdir()))) rmSync(state.root, { recursive: true, force: true });
});

describe("local generated shot library", () => {
  it("lists all takes and generated clips with their original script provenance", () => {
    script(); script("currently-selected-script", true);
    const keyframe = asset("keyframe", { filePath: file("uploads/project-1/keyframe.png"), sourceScriptId: "script-1" });
    asset("selected-take", { sourceScriptId: "script-1", selected: true });
    asset("old-take", { sourceScriptId: "script-1", selected: false });
    clip("animated-keyframe", { assetId: keyframe.id });
    clip("legacy-clip");

    expect(listLocalShotVideos()).toHaveLength(4);
    for (const name of ["selected-take.mp4", "old-take.mp4", "animated-keyframe.mp4"]) {
      expect(listed(name)).toMatchObject({ projectId: "project-1", projectName: "Fixture project", productName: "Fixture product", scriptId: "script-1", scriptTitle: "Plan script-1", scriptVersion: 2, scriptStyle: "scene", shotId: 1, shotDescription: "The original script shot" });
    }
    expect(listed("old-take.mp4").selected).toBe(false);
    expect(listed("animated-keyframe.mp4").duration).toBe(5000);
    expect(listed("legacy-clip.mp4")).toMatchObject({ scriptId: null, scriptTitle: null, shotDescription: null });
  });

  it("keeps legacy assets unassigned when a selected script has the same shot number", () => {
    script("unrelated-selected-script", true); asset();
    expect(listed("asset-1.mp4")).toMatchObject({ scriptId: null, scriptTitle: null, scriptVersion: null, scriptStyle: null, shotDescription: null });
  });

  it("includes locally downloaded Kling alternatives and deduplicates matching asset, clip and output paths", () => {
    script();
    const row = asset("shared", { sourceScriptId: "script-1", selected: false });
    clip("duplicate", { assetId: row.id, filePath: "/api/files/project-1/shared.mp4" });
    output(row.filePath!, row.id);
    expect(listLocalShotVideos()).toHaveLength(1);
    expect(listed("shared.mp4")).toMatchObject({ scriptId: "script-1", selected: false });

    getDb().delete(videoClips).run(); getDb().delete(assets).run();
    getDb().update(klingJobOutputs).set({ assetId: null }).run();
    expect(listLocalShotVideos()).toHaveLength(1);
    expect(listed("shared.mp4")).toMatchObject({ scriptId: "script-1", duration: 6500, selected: false, model: "kling-test" });
    const serialized = JSON.stringify(listLocalShotVideos());
    expect(serialized).not.toContain(state.directory);
    expect(serialized).not.toContain("private-signed-video");
    expect(serialized).not.toContain("token=secret");
  });

  it("excludes missing, remote, uploaded, stock, image, unfinished and composition files", () => {
    asset("missing", { filePath: join(state.directory, "uploads", "project-1", "missing.mp4") });
    asset("remote", { filePath: "https://provider.invalid/remote.mp4" });
    asset("uploaded", { type: "user_upload" });
    asset("stock", { type: "stock_footage" });
    asset("frame", { filePath: file("uploads/project-1/frame.jpg") });
    asset("unfinished", { status: "generating" });
    clip("uploaded-clip", { assetId: "uploaded", provider: null });
    const finalPath = file("output/project-1/final.mp4");
    getDb().insert(compositions).values({ id: "work-1", projectId: "project-1", status: "done", outputPath: finalPath }).run();
    expect(listLocalShotVideos()).toEqual([]);
  });

  it("excludes files outside the owned trees and project junctions pointing at another directory", () => {
    const outside = file("elsewhere/private.mp4");
    asset("outside", { filePath: outside });
    const original = file("uploads/project-2/original.mp4");
    const junction = join(state.directory, "uploads", "project-1", "linked");
    symlinkSync(resolve(original, ".."), junction, "junction");
    asset("junction", { filePath: join(junction, "original.mp4") });
    expect(listLocalShotVideos()).toEqual([]);
    expect(existsSync(original)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("lists a generated film shot saved before its asset or job binding", () => {
    script();
    const path = file("uploads/project-1/orphan-film-shot.mp4");
    film("completed", path);
    const row = getDb().select().from(klingFilmShots).get()!;
    getDb().update(klingFilmShots).set({ data: { ...row.data, source: "generate", videoUrl: "/api/files/project-1/orphan-film-shot.mp4" } }).run();
    expect(listed("orphan-film-shot.mp4")).toMatchObject({ scriptId: "script-1", shotId: 1, shotDescription: "The original script shot" });
  });

  it("does not infer generation from a reused film source without a generated asset or job", () => {
    script();
    film("completed", file("uploads/project-1/uploaded-film-source.mp4"));
    expect(listLocalShotVideos()).toEqual([]);
  });
});

describe("local shot deletion", () => {
  it("deletes exact generated files and sidecars while preserving scripts, keyframes, copies and completed works", () => {
    script();
    const keyframe = file("uploads/project-1/source-keyframe.png");
    const row = asset("take", { sourceScriptId: "script-1", thumbnailPath: keyframe, sourceKeyframeUrl: "/api/files/project-1/source-keyframe.png" });
    asset("duplicate-record", { filePath: row.filePath });
    const poster = file("uploads/project-1/take.mp4.thumb.jpg");
    const last = file("uploads/project-1/take.mp4.last.jpg");
    const extra = file("uploads/project-1/take-extra.mp4");
    const copy = file("uploads/project-1/take-copy.mp4");
    const final = file("output/project-1/final.mp4");
    getDb().insert(compositions).values({ id: "work-1", projectId: "project-1", status: "done", outputPath: final }).run();
    clip("same-file", { assetId: row.id, filePath: row.filePath });
    clip("waiting-clip", { assetId: row.id, filePath: null, status: "pending" });
    const independentClip = clip("other-file", { assetId: row.id });
    const entry = listed("take.mp4");
    const result = deleteLocalShotVideo(entry.id);

    expect(result).toMatchObject({ success: true, deletedId: entry.id, deletedFiles: 3 });
    expect(result.freedBytes).toBeGreaterThan(0);
    for (const removed of [row.filePath!, poster, last]) expect(existsSync(removed)).toBe(false);
    for (const kept of [keyframe, extra, copy, final, independentClip.filePath!]) expect(existsSync(kept)).toBe(true);
    expect(getDb().select().from(assets).all()).toEqual([]);
    expect(getDb().select().from(videoClips).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "waiting-clip", assetId: null, filePath: null }),
      expect.objectContaining({ id: "other-file", assetId: null, filePath: independentClip.filePath }),
    ]));
    expect(getDb().select().from(videoClips).all()).toHaveLength(2);
    expect(getDb().select().from(projects).all()).toHaveLength(1);
    expect(getDb().select().from(scripts).all()).toHaveLength(1);
    expect(getDb().select().from(compositions).all()).toHaveLength(1);
    expect(state.sqlite!.pragma("foreign_key_check")).toEqual([]);
  });

  it("retains an independently referenced last frame", () => {
    const row = asset();
    const last = file("uploads/project-1/asset-1.mp4.last.jpg");
    asset("other-take", { sourceKeyframeUrl: "/api/files/project-1/asset-1.mp4.last.jpg" });
    deleteLocalShotVideo(listed("asset-1.mp4").id);
    expect(existsSync(row.filePath!)).toBe(false);
    expect(existsSync(last)).toBe(true);
  });

  it.each(["asset", "source", "composition"] as const)("preserves shared video bytes referenced by an independent %s", (reference) => {
    const row = asset();
    const poster = file("uploads/project-1/asset-1.mp4.thumb.jpg");
    if (reference === "asset") asset("user-source", { type: "user_upload", filePath: "/api/files/project-1/asset-1.mp4" });
    if (reference === "source") state.sqlite!.prepare("INSERT INTO media_sources (id, project_id, original_name, file_path, mime_type) VALUES (?, ?, ?, ?, ?)").run("source-1", "project-1", "original.mp4", row.filePath, "video/mp4");
    if (reference === "composition") getDb().insert(compositions).values({ id: "work-1", projectId: "project-1", outputPath: row.filePath, status: "done" }).run();

    const result = deleteLocalShotVideo(listed("asset-1.mp4").id);
    expect(result).toMatchObject({ success: true, deletedFiles: 0, freedBytes: 0 });
    expect(existsSync(row.filePath!)).toBe(true);
    expect(existsSync(poster)).toBe(true);
    expect(getDb().select().from(assets).all().some((item) => item.id === row.id)).toBe(false);
  });

  it("marks Kling output history deleted so a future import cannot resurrect the shot", async () => {
    script();
    const row = asset("kling-take", { sourceScriptId: "script-1" });
    output(row.filePath!, row.id);
    const entry = listed("kling-take.mp4");
    deleteLocalShotVideo(entry.id);
    const retainedOutput = getDb().select().from(klingJobOutputs).get();
    expect(retainedOutput).toMatchObject({ assetId: null, data: { deletedAt: expect.any(Number) } });
    expect(retainedOutput?.data.localPath).toBeUndefined();
    expect(retainedOutput?.data.filePath).toBeUndefined();
    expect(getDb().select().from(klingJobs).all()).toHaveLength(1);
    expect(listLocalShotVideos()).toEqual([]);
    await importKlingOutputs("job-1");
    expect(downloadPublicFile).not.toHaveBeenCalled();
    expect(getDb().select().from(assets).all()).toEqual([]);
    expect(listLocalShotVideos()).toEqual([]);
    expect(klingJobView(getDb().select().from(klingJobs).get()!).outputs).toEqual([]);
  });

  it.each(["pending", "composing"] as const)("protects shot inputs while a %s composition runs", (status) => {
    const row = asset();
    getDb().insert(compositions).values({ id: "work-1", projectId: "project-1", status }).run();
    expectStatus(() => deleteLocalShotVideo(listed("asset-1.mp4").id), 409);
    expect(existsSync(row.filePath!)).toBe(true);
  });

  it.each(["running", "paused", "composing"] as const)("protects an input used by a %s film", (status) => {
    const row = asset(); film(status, row.filePath!, row.id);
    expectStatus(() => deleteLocalShotVideo(listed("asset-1.mp4").id), 409);
    expect(existsSync(row.filePath!)).toBe(true);
  });

  it("protects a locally downloaded output while its worker lease is live", () => {
    script(); output();
    getDb().update(klingJobs).set({ leaseOwner: "worker", leaseExpiresAt: Date.now() + 60_000 }).run();
    expectStatus(() => deleteLocalShotVideo(listed("kling-output.mp4").id), 409);
    expect(getDb().select().from(klingJobOutputs).get()?.data.localPath).toBeDefined();
  });

  it("protects a completed film input until its worker releases its lease", () => {
    const row = asset(); film("completed", row.filePath!, row.id);
    getDb().update(klingFilmRuns).set({ leaseOwner: "worker", leaseExpiresAt: Date.now() + 60_000 }).run();
    expectStatus(() => deleteLocalShotVideo(listed("asset-1.mp4").id), 409);
    expect(existsSync(row.filePath!)).toBe(true);
  });

  it("removes a standalone downloaded output before it has an asset binding", () => {
    script();
    const row = output();
    const entry = listed("kling-output.mp4");
    expect(deleteLocalShotVideo(entry.id)).toMatchObject({ success: true, deletedFiles: 1 });
    expect(existsSync(row.data.localPath!)).toBe(false);
    expect(listLocalShotVideos()).toEqual([]);
    expect(getDb().select().from(klingJobOutputs).get()).toMatchObject({ assetId: null, data: { deletedAt: expect.any(Number) } });
  });

  it("clears completed film-shot video references while preserving the film plan and its final", () => {
    script();
    const row = asset("finished-film-input", { sourceScriptId: "script-1" });
    film("completed", row.filePath!, row.id);
    const filmShot = getDb().select().from(klingFilmShots).get()!;
    getDb().update(klingFilmShots).set({ data: { ...filmShot.data, videoUrl: "/api/files/project-1/finished-film-input.mp4", sourceFileHash: "previous-hash" } }).run();
    const final = file("output/project-1/film-final.mp4");
    getDb().insert(compositions).values({ id: "work-1", projectId: "project-1", outputPath: final, status: "done" }).run();

    deleteLocalShotVideo(listed("finished-film-input.mp4").id);
    const updatedShot = getDb().select().from(klingFilmShots).get()!;
    expect(updatedShot.assetId).toBeNull();
    expect(updatedShot.data.baselineAssetId).toBeNull();
    expect(updatedShot.data.videoUrl).toBeUndefined();
    expect(updatedShot.data.sourceFilePath).toBeUndefined();
    expect(updatedShot.data.sourceFileHash).toBeUndefined();
    expect(updatedShot.data.shot).toEqual(shot());
    expect(getDb().select().from(klingFilmRuns).get()?.status).toBe("completed");
    expect(getDb().select().from(compositions).get()?.outputPath).toBe(final);
    expect(existsSync(final)).toBe(true);
  });

  it("restores staged files and database references when the database delete fails", () => {
    script();
    const row = asset("rollback", { sourceScriptId: "script-1" });
    const poster = file("uploads/project-1/rollback.mp4.thumb.jpg", "poster bytes");
    clip("linked", { assetId: row.id, filePath: row.filePath });
    output(row.filePath!, row.id);
    const entry = listed("rollback.mp4");
    state.sqlite!.exec("CREATE TRIGGER reject_shot_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT, 'fixture rollback failure'); END;");
    expect(() => deleteLocalShotVideo(entry.id)).toThrow();
    expect(readFileSync(row.filePath!, "utf8")).toContain("rollback.mp4");
    expect(readFileSync(poster, "utf8")).toBe("poster bytes");
    expect(getDb().select().from(assets).get()?.id).toBe(row.id);
    expect(getDb().select().from(videoClips).get()?.assetId).toBe(row.id);
    expect(getDb().select().from(klingJobOutputs).get()?.data.localPath).toBe(row.filePath);
    expect(listed("rollback.mp4").id).toBe(entry.id);
    expect(getDb().select().from(settings).all().find((item) => item.key === "shot-library:pending-deletes")?.value ?? []).toEqual([]);
  });

  it("journals a locked staged file and retries cleanup on the next library read", () => {
    const row = asset("locked-take");
    const entry = listed("locked-take.mp4");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      state.unlinkFailure = true;
      expect(deleteLocalShotVideo(entry.id)).toEqual({ success: true, deletedId: entry.id, deletedFiles: 0, freedBytes: 0 });
      expect(existsSync(row.filePath!)).toBe(false);
      expect(getDb().select().from(assets).all()).toEqual([]);
      const pending = getDb().select().from(settings).get()?.value as string[];
      expect(pending).toHaveLength(1);
      expect(pending[0]).toContain(row.filePath! + ".shot-delete-");
      expect(existsSync(pending[0])).toBe(true);
      expect(listLocalShotVideos()).toEqual([]);
      expect(existsSync(pending[0])).toBe(true);

      state.unlinkFailure = false;
      expect(listLocalShotVideos()).toEqual([]);
      expect(existsSync(pending[0])).toBe(false);
      const afterCleanup = getDb().select().from(settings).all().find((item) => item.key === "shot-library:pending-deletes");
      expect(afterCleanup?.value ?? []).toEqual([]);
    } finally {
      state.unlinkFailure = false;
      warn.mockRestore();
    }
  });

  it("ignores cleanup journal entries that point at arbitrary original or outside files", () => {
    const original = file("uploads/project-1/original.mp4");
    const outside = file(`elsewhere/private.mp4.shot-delete-${randomUUID()}`);
    getDb().insert(settings).values({ key: "shot-library:pending-deletes", value: [original, outside] }).run();
    expect(listLocalShotVideos()).toEqual([]);
    expect(existsSync(original)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });
});

describe("shot library HTTP API", () => {
  it("returns the feed, rejects foreign origins, deletes a local shot and validates ids", async () => {
    asset();
    const entry = listed("asset-1.mp4");
    const feed = await GET();
    expect(feed.status).toBe(200);
    expect(await feed.json()).toMatchObject({ shots: [{ id: entry.id }] });
    expect(feed.headers.get("Cache-Control")).toBe("no-store");
    const url = `http://localhost:3000/api/shots/${encodeURIComponent(entry.id)}`;
    const denied = await DELETE(new NextRequest(url, { method: "DELETE", headers: { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" } }), { params: Promise.resolve({ id: entry.id }) });
    expect(denied.status).toBe(403);
    expect(listLocalShotVideos()).toHaveLength(1);
    const response = await DELETE(new NextRequest(url, { method: "DELETE", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" } }), { params: Promise.resolve({ id: entry.id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, deletedId: entry.id });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const missing = await DELETE(new NextRequest(url, { method: "DELETE" }), { params: Promise.resolve({ id: entry.id }) });
    expect(missing.status).toBe(404);
    const invalid = await DELETE(new NextRequest(url, { method: "DELETE" }), { params: Promise.resolve({ id: "../bad" }) });
    expect(invalid.status).toBe(400);
  });

  it("accepts desktop requests and canonicalized loopback hosts while denying cross-site fetch metadata", () => {
    const url = "http://localhost:3000/api/shots/fixture";
    expect(() => assertShotDeleteOrigin(new Request(url, { method: "DELETE" }))).not.toThrow();
    expect(() => assertShotDeleteOrigin(new Request(url, { method: "DELETE", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }))).not.toThrow();
    expectStatus(() => assertShotDeleteOrigin(new Request(url, { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } })), 403);
  });
});
