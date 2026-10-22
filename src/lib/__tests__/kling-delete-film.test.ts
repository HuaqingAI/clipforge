// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  state.sqlite.pragma("foreign_keys = ON");
  return { getDb: () => db };
});

import { getDb } from "@/lib/db";
import { assets, compositions, klingProfiles, projects, scripts, type Shot } from "@/lib/db/schema";
import { klingFilmRuns, klingFilmShots, type KlingFilmRun } from "@/lib/kling/film-schema";
import { klingJobs, klingJobOutputs, type KlingJob } from "@/lib/kling/job-schema";
import { canDeleteKlingFilm, getKlingFilm, getKlingFilmShots, klingFilmView, listKlingFilms } from "@/lib/kling/film-repository";
import { getKlingJob } from "@/lib/kling/repository";
import { deleteKlingFilm } from "@/lib/kling/delete-film";

const shot: Shot = { shotId: 1, type: "demo", camera: "static", description: "Product", duration: 5, visualSource: "ai_generate", transition: "direct_concat", voiceover: "Product" };
const root = mkdtempSync(join(tmpdir(), "clipforge-delete-film-"));
function film(status: KlingFilmRun["status"], overrides: Partial<KlingFilmRun> = {}) {
  const now = Date.now();
  const run = getDb().insert(klingFilmRuns).values({ id: "film-1", projectId: "project-1", scriptId: "script-1", profileId: "profile-1", principalKey: "principal", status,
    data: { scriptRevision: "revision", scriptSnapshot: { shots: [shot] }, model: { displayName: "Kling" } as KlingFilmRun["data"]["model"],
      output: { resolution: "720p", aspectRatio: "9:16", audioStrategy: "native", voice: "voice", subtitles: false }, planHash: "plan",
      expiresAt: now + 60_000, reuseExistingVideos: true, warnings: [], stage: status, authorizationEpoch: 1,
      compositionId: "work-1", videoUrl: "/api/output/work.mp4" }, createdAt: now, updatedAt: now, ...overrides }).returning().get()!;
  getDb().insert(klingFilmShots).values({ id: "film-shot-1", runId: run.id, shotId: 1, ordinal: 0, status: "ready", jobId: "job-1", assetId: "asset-1",
    data: { shot, source: "generate", prompt: "Product", options: {}, missingKeyframe: false, inputs: [], baselineAssetId: null, attempt: 0 }, updatedAt: now }).run();
  return run;
}

beforeEach(() => {
  state.sqlite!.exec("DROP TRIGGER IF EXISTS reject_film_delete; DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM compositions; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects; DELETE FROM kling_profiles;");
  getDb().insert(projects).values({ id: "project-1", name: "Product" }).run();
  getDb().insert(scripts).values({ id: "script-1", projectId: "project-1", styleType: "scene", shots: [shot], selected: true }).run();
});
afterAll(() => { state.sqlite?.close(); rmSync(root, { recursive: true, force: true }); });

describe("deleting a local Kling film record", () => {
  it.each(["draft", "completed", "cancelled"] as const)("deletes a %s record and its per-shot orchestration data", (status) => {
    const run = film(status);
    expect(klingFilmView(run).allowedActions).toContain("delete");
    expect(deleteKlingFilm(run.id)).toEqual({ deleted: true, runId: run.id });
    expect(listKlingFilms("project-1")).toEqual([]);
    expect(getKlingFilmShots(run.id)).toEqual([]);
    expect(() => getKlingFilm(run.id)).toThrowError("整片任务不存在");
  });

  it.each(["running", "composing", "paused", "needs_attention"] as const)("requires stopping a %s record before deletion", (status) => {
    const run = film(status);
    expect(klingFilmView(run).allowedActions).not.toContain("delete");
    expect(() => deleteKlingFilm(run.id)).toThrowError("整片任务尚未结束");
    expect(getKlingFilm(run.id).status).toBe(status);
    expect(getKlingFilmShots(run.id)).toHaveLength(1);
  });

  it.each([
    { name: "an unexpired lease", leaseOwner: "2147483647:worker", leaseExpiresAt: Date.now() + 60_000 },
    { name: "a live worker after the heartbeat expires", leaseOwner: `${process.pid}:worker`, leaseExpiresAt: 1 },
    { name: "an unverifiable worker", leaseOwner: "worker", leaseExpiresAt: 1 },
  ])("blocks deletion with $name", ({ leaseOwner, leaseExpiresAt }) => {
    const run = film("cancelled", { leaseOwner, leaseExpiresAt });
    expect(canDeleteKlingFilm(run)).toBe(false);
    expect(klingFilmView(run).allowedActions).not.toContain("delete");
    expect(() => deleteKlingFilm(run.id)).toThrowError("整片任务仍在处理");
    expect(getKlingFilmShots(run.id)).toHaveLength(1);
  });

  it("allows deleting a stale lease whose worker has exited", () => {
    const run = film("completed", { leaseOwner: "2147483647:worker", leaseExpiresAt: 1 });
    expect(canDeleteKlingFilm(run)).toBe(true);
    expect(deleteKlingFilm(run.id)).toEqual({ deleted: true, runId: run.id });
  });

  it("keeps shot jobs, outputs, selected assets, compositions and their local files", () => {
    const directory = join(root, "preserved"); mkdirSync(directory, { recursive: true });
    const file = join(directory, "video.mp4"); writeFileSync(file, "media");
    const now = Date.now();
    getDb().insert(klingProfiles).values({ id: "profile-1", data: {} as typeof klingProfiles.$inferInsert["data"] }).run();
    getDb().insert(klingJobs).values({ id: "job-1", profileId: "profile-1", principalKey: "principal", region: "global", clientRequestId: "request-1",
      projectId: "project-1", scriptId: "script-1", shotId: 1, submissionState: "acknowledged", remoteState: "processing", importState: "not_ready",
      data: { filmRunId: "film-1", filmShotId: "film-shot-1", filmAuthorizationEpoch: 1, inputs: [] } as unknown as KlingJob["data"], createdAt: now, updatedAt: now }).run();
    getDb().insert(assets).values({ id: "asset-1", projectId: "project-1", shotId: 1, type: "ai_generated", filePath: file, provider: "kling-cli", status: "done", selected: true }).run();
    getDb().insert(klingJobOutputs).values({ id: "output-1", jobId: "job-1", workKey: "work-1", assetId: "asset-1", importState: "imported", data: { url: "https://example.test/video", providerWorkId: "work-1", filePath: file, localPath: file, urlObtainedAt: now }, createdAt: now, updatedAt: now }).run();
    getDb().insert(compositions).values({ id: "work-1", projectId: "project-1", status: "done", outputPath: file }).run();
    film("cancelled");
    const before = { job: getKlingJob("job-1"), output: getDb().select().from(klingJobOutputs).all(), asset: getDb().select().from(assets).all(), work: getDb().select().from(compositions).all() };
    deleteKlingFilm("film-1");
    expect(getKlingJob("job-1")).toEqual(before.job);
    expect(getDb().select().from(klingJobOutputs).all()).toEqual(before.output);
    expect(getDb().select().from(assets).all()).toEqual(before.asset);
    expect(getDb().select().from(compositions).all()).toEqual(before.work);
    expect(existsSync(file)).toBe(true);
  });

  it("rolls back the shot deletion if removing the parent record fails", () => {
    film("completed");
    state.sqlite!.exec("CREATE TRIGGER reject_film_delete BEFORE DELETE ON kling_film_runs BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
    expect(() => deleteKlingFilm("film-1")).toThrowError("删除整片记录失败");
    expect(getKlingFilm("film-1").status).toBe("completed");
    expect(getKlingFilmShots("film-1")).toHaveLength(1);
  });

  it("does not remove another project's records", () => {
    film("completed");
    getDb().insert(klingFilmRuns).values({ ...getKlingFilm("film-1"), id: "other-film", projectId: "other-project" }).run();
    deleteKlingFilm("film-1");
    expect(getDb().select().from(klingFilmRuns).where(eq(klingFilmRuns.id, "other-film")).get()).toBeDefined();
  });

  it("rejects invalid and missing IDs, including a repeat delete", () => {
    expect(() => deleteKlingFilm("../film-1")).toThrowError("整片任务编号无效");
    expect(() => deleteKlingFilm("missing")).toThrowError("整片任务不存在");
    film("draft"); deleteKlingFilm("film-1");
    expect(() => deleteKlingFilm("film-1")).toThrowError("整片任务不存在");
  });
});
