// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile, createShortVideoSalesProfile } from "@/lib/creative-profiles";
import { DELETE, GET, PATCH } from "@/app/api/project/[id]/scripts/route";

vi.mock("@/lib/db", () => ({ getDb: () => db }));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "project-1";
const scriptId = "current-script";
const shot: schema.Shot = {
  shotId: 1, type: "demo", duration: 5, description: "Show the product", camera: "static",
  voiceover: "Product demonstration", visualSource: "ai_generate", transition: "direct_concat",
};

function addScript(id: string, overrides: Partial<typeof schema.scripts.$inferInsert> = {}) {
  return db.insert(schema.scripts).values({
    id, projectId, version: 2, styleType: "scene", title: id, selected: false, shots: [shot],
    createdAt: new Date("2026-10-22T00:00:00Z"), ...overrides,
  }).returning().get()!;
}

function request(body: unknown, language = "en") {
  return new NextRequest(`http://localhost/api/project/${projectId}/scripts`, {
    method: "DELETE", headers: { "Accept-Language": language, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function remove(id = scriptId, requestedProjectId = projectId, language = "en") {
  return DELETE(request({ scriptId: id }, language), { params: Promise.resolve({ id: requestedProjectId }) });
}

function rows() {
  return db.select().from(schema.scripts).orderBy(schema.scripts.id).all();
}

function addJob(overrides: Partial<typeof schema.klingJobs.$inferInsert> = {}) {
  db.insert(schema.klingProfiles).values({ id: "profile-1", data: {} as never }).onConflictDoNothing().run();
  return db.insert(schema.klingJobs).values({
    id: "job-1", profileId: "profile-1", principalKey: "principal", region: "global",
    clientRequestId: "request-1", projectId, scriptId, shotId: 1, submissionState: "acknowledged",
    remoteState: "completed", importState: "completed", createdAt: Date.now(), updatedAt: Date.now(),
    data: {} as never, ...overrides,
  }).returning().get()!;
}

function addFilm(overrides: Partial<typeof schema.klingFilmRuns.$inferInsert> = {}) {
  return db.insert(schema.klingFilmRuns).values({
    id: "film-1", projectId, scriptId, profileId: "profile-1", principalKey: "principal", status: "completed",
    data: { scriptSnapshot: { shots: [shot] }, expiresAt: Date.now() + 60_000 } as never,
    createdAt: Date.now(), updatedAt: Date.now(), ...overrides,
  }).returning().get()!;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  sqlite.pragma("foreign_keys = ON");
  db.insert(schema.projects).values([
    { id: projectId, name: "Script deletion" }, { id: "other-project", name: "Other project" },
  ]).run();
  addScript(scriptId, { selected: true });
  addScript("archived-script", { version: 1 });
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

describe("DELETE project script", () => {
  it("selects a remaining alternative from the same generation", async () => {
    addScript("alternative-b");
    addScript("alternative-a");
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true, deletedScriptId: scriptId, selectedScriptId: "alternative-a",
      scripts: [{ id: "alternative-a", version: 2, selected: true }, { id: "alternative-b", version: 2, selected: false }],
    });
    expect(rows().map((row) => [row.id, row.selected])).toEqual([
      ["alternative-a", true], ["alternative-b", false], ["archived-script", false],
    ]);
  });

  it("keeps the selection when deleting an unselected alternative", async () => {
    addScript("alternative-a");
    const response = await remove("alternative-a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deletedScriptId: "alternative-a", selectedScriptId: scriptId,
      scripts: [{ id: scriptId, selected: true, version: 2 }],
    });
    expect(rows().find((row) => row.id === scriptId)?.selected).toBe(true);
  });

  it("keeps the active generation when deleting an archived script", async () => {
    const response = await remove("archived-script");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selectedScriptId: scriptId, scripts: [{ id: scriptId, version: 2 }] });
    expect(rows()).toHaveLength(1);
  });

  it("leaves an empty current batch without selecting history after its last alternative is deleted", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, deletedScriptId: scriptId, selectedScriptId: null, scripts: [] });
    expect(rows()).toMatchObject([{ id: "archived-script", selected: false }]);
    const refreshed = await GET(request({}), { params: Promise.resolve({ id: projectId }) });
    expect(await refreshed.json()).toMatchObject([{ id: "archived-script", selected: false }]);
  });

  it("keeps earlier-configuration alternatives eligible when selecting a replacement", async () => {
    addScript("alternative-a-stale", {
      creativeProfileSnapshot: createCreativeProfileSnapshot(createShortVideoSalesProfile(), 1),
    });
    addScript("alternative-b-current");
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selectedScriptId: "alternative-a-stale" });
    expect(rows().find((row) => row.id === "alternative-a-stale")?.selected).toBe(true);
    expect(rows().find((row) => row.id === "alternative-b-current")?.selected).toBe(false);
  });

  it("activates the remaining same-type alternative regardless of its configuration counter", async () => {
    addScript("stale-alternative", {
      creativeProfileSnapshot: createCreativeProfileSnapshot(createShortVideoSalesProfile(), 1),
    });
    const response = await remove();
    expect(await response.json()).toMatchObject({ selectedScriptId: "stale-alternative", scripts: [{ id: "stale-alternative", selected: true }] });
    expect(rows().find((row) => row.id === "stale-alternative")?.creativeProfileSnapshot?.creativeConfigRevision).toBe(1);
  });

  it("preserves generated assets, clips, completed works and Kling audit records", async () => {
    db.insert(schema.assets).values({
      id: "asset-1", projectId, sourceScriptId: scriptId, shotId: 1, type: "ai_generated",
      status: "done", filePath: "/api/files/project-1/generated.mp4",
    }).run();
    db.insert(schema.videoClips).values({
      id: "clip-1", projectId, shotId: 1, assetId: "asset-1", status: "done", filePath: "/api/files/project-1/clip.mp4",
    }).run();
    db.insert(schema.compositions).values({ id: "composition-1", projectId, status: "done", outputPath: "/api/output/film.mp4" }).run();
    db.insert(schema.aiTasks).values({ id: "task-1", projectId, provider: "test", model: "test", taskId: "remote-1", status: "completed" }).run();
    addJob();
    db.insert(schema.klingJobOutputs).values({
      id: "output-1", jobId: "job-1", workKey: "work-1", assetId: "asset-1", importState: "imported",
      data: { url: "https://example.invalid/video.mp4", urlObtainedAt: Date.now(), providerWorkId: "work-1" },
      createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
    addFilm();
    db.insert(schema.klingFilmShots).values({
      id: "film-shot-1", runId: "film-1", shotId: 1, ordinal: 0, status: "ready", assetId: "asset-1",
      data: { shot } as never, updatedAt: Date.now(),
    }).run();
    const before = {
      assets: db.select().from(schema.assets).all(), clips: db.select().from(schema.videoClips).all(),
      compositions: db.select().from(schema.compositions).all(), aiTasks: db.select().from(schema.aiTasks).all(),
      jobs: db.select().from(schema.klingJobs).all(), outputs: db.select().from(schema.klingJobOutputs).all(),
      films: db.select().from(schema.klingFilmRuns).all(), filmShots: db.select().from(schema.klingFilmShots).all(),
    };
    expect((await remove()).status).toBe(200);
    expect({
      assets: db.select().from(schema.assets).all(), clips: db.select().from(schema.videoClips).all(),
      compositions: db.select().from(schema.compositions).all(), aiTasks: db.select().from(schema.aiTasks).all(),
      jobs: db.select().from(schema.klingJobs).all(), outputs: db.select().from(schema.klingJobOutputs).all(),
      films: db.select().from(schema.klingFilmRuns).all(), filmShots: db.select().from(schema.klingFilmShots).all(),
    }).toEqual(before);
  });

  it.each([null, [], "script", {}, { scriptId: 123 }, { scriptId: " " }])("rejects an invalid deletion body: %j", async (body) => {
    const before = rows();
    const response = await DELETE(request(body), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "A valid script ID is required" });
    expect(rows()).toEqual(before);
  });

  it("rejects malformed JSON", async () => {
    const response = await DELETE(new NextRequest("http://localhost/api/project/project-1/scripts", {
      method: "DELETE", body: "{", headers: { "Accept-Language": "en" },
    }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Request body must be valid JSON" });
  });

  it.each(["missing-script", "foreign-script"])("does not delete an unavailable script: %s", async (id) => {
    addScript("foreign-script", { projectId: "other-project", selected: true });
    const before = rows();
    const response = await remove(id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Script not found" });
    expect(rows()).toEqual(before);
  });

  it("rejects a project that does not exist", async () => {
    const response = await remove(scriptId, "missing-project");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect(rows()).toHaveLength(2);
  });

  it("localizes validation errors for Chinese clients", async () => {
    const response = await DELETE(request({}, "zh-CN"), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "缺少有效的脚本编号" });
  });

  it("rolls back deletion when replacement selection fails", async () => {
    addScript("alternative-a");
    sqlite.exec("CREATE TRIGGER reject_replacement BEFORE UPDATE ON scripts WHEN NEW.selected = 1 BEGIN SELECT RAISE(ABORT, 'fixture selection failure'); END");
    const before = rows();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await remove();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to delete the script. Please retry." });
    expect(rows()).toEqual(before);
  });
});

describe("script deletion protects unfinished work", () => {
  async function expectConflict() {
    const before = rows();
    const response = await remove();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This script or project has unfinished generation tasks. Complete or resolve them before deleting the script.",
    });
    expect(rows()).toEqual(before);
  }

  it.each([scriptId, null])("protects a running pipeline bound to %s", async (pipelineScriptId) => {
    db.insert(schema.pipelineRuns).values({ projectId, scriptId: pipelineScriptId, status: "running" }).run();
    await expectConflict();
  });

  it.each(["pending", "composing"] as const)("protects a %s composition in the project", async (status) => {
    db.insert(schema.compositions).values({ projectId, status }).run();
    await expectConflict();
  });

  it.each(["pending", "generating"] as const)("protects a %s asset generated from this script", async (status) => {
    db.insert(schema.assets).values({ projectId, sourceScriptId: scriptId, shotId: 1, type: "ai_generated", status }).run();
    await expectConflict();
  });

  it.each(["submitted", "processing", "unknown"] as const)("protects a %s cloud generation task in the project", async (status) => {
    db.insert(schema.aiTasks).values({ projectId, provider: "test", model: "test", taskId: "remote-1", status }).run();
    await expectConflict();
  });

  it.each([
    { submissionState: "prepared", remoteState: "not_started", importState: "not_ready" },
    { submissionState: "acknowledged", remoteState: "processing", importState: "not_ready" },
    { submissionState: "submission_unknown", remoteState: "unknown", importState: "not_ready" },
    { submissionState: "acknowledged", remoteState: "completed", importState: "partial" },
  ] as const)("protects an unresolved Kling job: $submissionState/$remoteState/$importState", async (state) => {
    addJob(state);
    await expectConflict();
  });

  it.each(["running", "paused", "needs_attention", "composing"] as const)("protects a %s Kling film", async (status) => {
    addFilm({ status });
    await expectConflict();
  });

  it("allows deleting a script while unrelated scripts and projects have running work", async () => {
    db.insert(schema.pipelineRuns).values({ projectId, scriptId: "archived-script", status: "running" }).run();
    db.insert(schema.assets).values({ projectId, sourceScriptId: "archived-script", shotId: 1, type: "ai_generated", status: "generating" }).run();
    db.insert(schema.compositions).values({ projectId: "other-project", status: "composing" }).run();
    db.insert(schema.aiTasks).values({ projectId: "other-project", provider: "test", model: "test", taskId: "remote-1", status: "processing" }).run();
    addJob({ scriptId: "archived-script", remoteState: "processing", importState: "not_ready" });
    addFilm({ scriptId: "archived-script", status: "running" });
    expect((await remove()).status).toBe(200);
  });

  it("allows terminal or dismissed Kling jobs and completed pipeline work to remain as history", async () => {
    db.insert(schema.pipelineRuns).values({ projectId, scriptId, status: "done" }).run();
    addJob({ remoteState: "failed", importState: "failed" });
    addJob({ id: "dismissed-job", clientRequestId: "dismissed-request", remoteState: "processing", importState: "pending", data: { deletedAt: Date.now() } as never });
    addFilm({ status: "cancelled" });
    expect((await remove()).status).toBe(200);
    expect(db.select().from(schema.klingJobs).all()).toHaveLength(2);
    expect(db.select().from(schema.pipelineRuns).where(eq(schema.pipelineRuns.scriptId, scriptId)).get()).toBeDefined();
  });

  it("localizes busy errors for Chinese clients", async () => {
    db.insert(schema.compositions).values({ projectId, status: "composing" }).run();
    const response = await remove(scriptId, projectId, "zh-CN");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "脚本或项目仍有未完成的生成任务，请先完成或处理任务后再删除" });
  });
});

describe("script selection after concurrent deletion", () => {
  function select(id: string) {
    return PATCH(new NextRequest(`http://localhost/api/project/${projectId}/scripts`, {
      method: "PATCH", headers: { "Accept-Language": "en", "Content-Type": "application/json" },
      body: JSON.stringify({ selectedScriptId: id }),
    }), { params: Promise.resolve({ id: projectId }) });
  }

  it("retains the current selection when deletion wins before the selection transaction begins", async () => {
    addScript("alternative-a");
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) => {
      db.delete(schema.scripts).where(eq(schema.scripts.id, "alternative-a")).run();
      return transaction(callback, config);
    });

    const response = await select("alternative-a");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Script not found" });
    expect(rows().find((row) => row.id === scriptId)?.selected).toBe(true);
    expect(rows().find((row) => row.id === "archived-script")?.selected).toBe(false);
  });

  it("checks the current project creation type after acquiring the selection write lock", async () => {
    addScript("alternative-a", {
      creativeProfileSnapshot: createCreativeProfileSnapshot(createShortVideoSalesProfile(), 0),
    });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) => {
      db.update(schema.projects).set({ creativeProfile: createPremiumProductCgProfile(), creativeConfigRevision: 1 }).where(eq(schema.projects.id, projectId)).run();
      return transaction(callback, config);
    });

    const response = await select("alternative-a");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CREATIVE_PROFILE_MISMATCH" });
    expect(rows().find((row) => row.id === scriptId)?.selected).toBe(true);
    expect(rows().find((row) => row.id === "alternative-a")?.selected).toBe(false);
  });
});
