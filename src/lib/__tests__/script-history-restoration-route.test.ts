// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  createCreativeProfileSnapshot,
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
} from "@/lib/creative-profiles";
import { GET, PATCH } from "@/app/api/project/[id]/scripts/route";

vi.mock("@/lib/db", () => ({ getDb: () => db }));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "project-1";
const currentId = "current-script";
const historicalId = "historical-script";
const shot: schema.Shot = {
  shotId: 1, type: "demo", duration: 5, description: "Show the product", camera: "static",
  voiceover: "Product demonstration", visualSource: "ai_generate", transition: "direct_concat",
};

function addScript(id: string, overrides: Partial<typeof schema.scripts.$inferInsert> = {}) {
  return db.insert(schema.scripts).values({
    id, projectId, version: 1, styleType: "scene", title: id, selected: false, shots: [shot],
    creativeProfileSnapshot: createCreativeProfileSnapshot(createShortVideoSalesProfile(), 0),
    createdAt: new Date("2026-10-22T00:00:00Z"), ...overrides,
  }).returning().get()!;
}

function request(body: unknown, language = "en") {
  return new NextRequest(`http://localhost/api/project/${projectId}/scripts`, {
    method: "PATCH", headers: { "Accept-Language": language, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function restore(id = historicalId, requestedProjectId = projectId, language = "en") {
  return PATCH(request({ restoreScriptId: id }, language), { params: Promise.resolve({ id: requestedProjectId }) });
}

function rows() {
  return db.select().from(schema.scripts).orderBy(schema.scripts.id).all();
}

function addJob(overrides: Partial<typeof schema.klingJobs.$inferInsert> = {}) {
  db.insert(schema.klingProfiles).values({ id: "profile-1", data: {} as never }).onConflictDoNothing().run();
  return db.insert(schema.klingJobs).values({
    id: "job-1", profileId: "profile-1", principalKey: "principal", region: "global",
    clientRequestId: "request-1", projectId, scriptId: currentId, shotId: 1, submissionState: "acknowledged",
    remoteState: "completed", importState: "completed", createdAt: Date.now(), updatedAt: Date.now(),
    data: {} as never, ...overrides,
  }).returning().get()!;
}

function addFilm(overrides: Partial<typeof schema.klingFilmRuns.$inferInsert> = {}) {
  return db.insert(schema.klingFilmRuns).values({
    id: "film-1", projectId, scriptId: currentId, profileId: "profile-1", principalKey: "principal", status: "completed",
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
    { id: projectId, name: "Script history" }, { id: "other-project", name: "Other project" },
  ]).run();
  addScript(currentId, { selected: true, version: 2 });
  addScript(historicalId);
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

describe("PATCH historical script restoration", () => {
  it("activates the requested historical alternative and returns its complete generation", async () => {
    addScript("historical-alternative");
    addScript("foreign-history", { projectId: "other-project", selected: true });
    const before = rows();
    const response = await restore();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true, selectedScriptId: historicalId,
      scripts: [{ id: "historical-alternative", version: 1, selected: false }, { id: historicalId, version: 1, selected: true }],
    });
    expect(rows().map((row) => [row.id, row.selected])).toEqual([
      [currentId, false], ["foreign-history", true], ["historical-alternative", false], [historicalId, true],
    ]);
    expect(rows().map((row) => ({ ...row, selected: false }))).toEqual(before.map((row) => ({ ...row, selected: false })));
    const refreshed = await GET(request({}), { params: Promise.resolve({ id: projectId }) });
    const refreshedRows = await refreshed.json() as Array<{ id: string; selected: boolean }>;
    expect(refreshedRows).toHaveLength(3);
    expect(refreshedRows.find((row) => row.selected)?.id).toBe(historicalId);
  });

  it("restores history after the entire active generation was deleted", async () => {
    db.delete(schema.scripts).where(eq(schema.scripts.id, currentId)).run();
    expect((await restore()).status).toBe(200);
    expect(rows()).toMatchObject([{ id: historicalId, selected: true }]);
  });

  it("keeps the previously active generation available for restoring again", async () => {
    expect((await restore()).status).toBe(200);
    const response = await restore(currentId);
    expect(await response.json()).toMatchObject({ selectedScriptId: currentId, scripts: [{ id: currentId, selected: true, version: 2 }] });
    expect(rows().find((row) => row.id === historicalId)?.selected).toBe(false);
  });

  it("retains project configuration and generated assets, clips, completed compositions and task records", async () => {
    db.insert(schema.assets).values({ id: "asset-1", projectId, sourceScriptId: currentId, shotId: 1, type: "ai_generated", status: "done", filePath: "/generated.mp4" }).run();
    db.insert(schema.videoClips).values({ id: "clip-1", projectId, shotId: 1, assetId: "asset-1", status: "done", filePath: "/clip.mp4" }).run();
    db.insert(schema.compositions).values({ projectId, status: "done", outputPath: "/film.mp4" }).run();
    db.insert(schema.aiTasks).values({ projectId, provider: "test", model: "test", taskId: "remote-1", status: "completed" }).run();
    addJob();
    addFilm();
    const snapshot = () => ({
      projects: db.select().from(schema.projects).all(), assets: db.select().from(schema.assets).all(),
      clips: db.select().from(schema.videoClips).all(), compositions: db.select().from(schema.compositions).all(),
      tasks: db.select().from(schema.aiTasks).all(), jobs: db.select().from(schema.klingJobs).all(), films: db.select().from(schema.klingFilmRuns).all(),
    });
    const before = snapshot();
    expect((await restore()).status).toBe(200);
    expect(snapshot()).toEqual(before);
  });

  it.each([null, [], "script", {}, { restoreScriptId: 123 }, { restoreScriptId: " " },
    { restoreScriptId: historicalId, selectedScriptId: currentId },
    { restoreScriptId: historicalId, scriptId: currentId, shotTexts: [] },
  ])("rejects an invalid or ambiguous request: %j", async (body) => {
    const before = rows();
    const response = await PATCH(request(body), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(400);
    expect(rows()).toEqual(before);
  });

  it("rejects malformed JSON", async () => {
    const response = await PATCH(new NextRequest("http://localhost/api/project/project-1/scripts", {
      method: "PATCH", body: "{", headers: { "Accept-Language": "en" },
    }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Request body must be valid JSON" });
  });

  it.each(["missing-script", "foreign-script"])("rejects an unavailable or foreign script: %s", async (id) => {
    addScript("foreign-script", { projectId: "other-project", selected: true });
    const before = rows();
    const response = await restore(id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Script not found" });
    expect(rows()).toEqual(before);
  });

  it("rejects a missing project", async () => {
    const response = await restore(historicalId, "missing-project");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
  });

  it("restores an earlier configuration without changing its snapshot or project settings", async () => {
    db.update(schema.projects).set({ creativeConfigRevision: 1 }).where(eq(schema.projects.id, projectId)).run();
    const before = rows();
    const response = await restore(historicalId, projectId, "zh-CN");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true, selectedScriptId: historicalId,
    });
    expect(rows().map((row) => ({ ...row, selected: false }))).toEqual(before.map((row) => ({ ...row, selected: false })));
    expect(rows().find((row) => row.selected)?.id).toBe(historicalId);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()?.creativeConfigRevision).toBe(1);
  });

  it("rejects a different creative type with a readable conflict", async () => {
    db.update(schema.scripts).set({
      styleType: "premium_product_cg", creativeProfileSnapshot: createCreativeProfileSnapshot(createPremiumProductCgProfile(), 0),
    }).where(eq(schema.scripts.id, historicalId)).run();
    const before = rows();
    const response = await restore(historicalId, projectId, "zh-CN");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CREATIVE_PROFILE_MISMATCH", currentCreationType: "short_video_sales", scriptCreationType: "premium_product_cg",
      error: "该历史方案的创作类型与当前项目不一致，暂时无法恢复。",
    });
    expect(rows()).toEqual(before);
  });

  it("validates the current creation type after acquiring the write lock", async () => {
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) => {
      expect(config).toEqual({ behavior: "immediate" });
      db.update(schema.projects).set({ creativeProfile: createPremiumProductCgProfile(), creativeConfigRevision: 1 }).where(eq(schema.projects.id, projectId)).run();
      return transaction(callback, config);
    });
    const response = await restore();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CREATIVE_PROFILE_MISMATCH" });
    expect(rows().find((row) => row.selected)?.id).toBe(currentId);
  });

  it("rolls back all selection changes when activating the historical script fails", async () => {
    sqlite.exec(`CREATE TRIGGER reject_restore BEFORE UPDATE ON scripts WHEN NEW.selected = 1 AND NEW.id = '${historicalId}' BEGIN SELECT RAISE(ABORT, 'fixture restore failure'); END`);
    const before = rows();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await restore()).status).toBe(500);
    expect(rows()).toEqual(before);
  });
});

describe("historical restoration protects unfinished work across the project", () => {
  async function expectConflict() {
    const before = rows();
    const response = await restore();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This project has unfinished generation tasks. Complete or resolve them before restoring a historical script." });
    expect(rows()).toEqual(before);
  }

  it.each([currentId, historicalId, null])("blocks a running pipeline attached to %s", async (scriptId) => {
    db.insert(schema.pipelineRuns).values({ projectId, scriptId, status: "running" }).run();
    await expectConflict();
  });

  it.each(["pending", "composing"] as const)("blocks a %s composition", async (status) => {
    db.insert(schema.compositions).values({ projectId, status }).run();
    await expectConflict();
  });

  it.each(["pending", "generating"] as const)("blocks a %s asset belonging to the current generation", async (status) => {
    db.insert(schema.assets).values({ projectId, sourceScriptId: currentId, shotId: 1, type: "ai_generated", status }).run();
    await expectConflict();
  });

  it.each(["submitted", "processing", "unknown"] as const)("blocks a %s AI task", async (status) => {
    db.insert(schema.aiTasks).values({ projectId, provider: "test", model: "test", taskId: "remote-1", status }).run();
    await expectConflict();
  });

  it.each([
    { submissionState: "prepared", remoteState: "not_started", importState: "not_ready" },
    { submissionState: "acknowledged", remoteState: "processing", importState: "not_ready" },
    { submissionState: "submission_unknown", remoteState: "unknown", importState: "not_ready" },
    { submissionState: "acknowledged", remoteState: "completed", importState: "partial" },
  ] as const)("blocks unfinished Kling work from the current generation: $submissionState/$importState", async (state) => {
    addJob(state);
    await expectConflict();
  });

  it.each(["running", "paused", "needs_attention", "composing"] as const)("blocks a %s Kling film belonging to the current generation", async (status) => {
    addFilm({ status });
    await expectConflict();
  });

  it("ignores unfinished work belonging to another project", async () => {
    db.insert(schema.pipelineRuns).values({ projectId: "other-project", scriptId: currentId, status: "running" }).run();
    db.insert(schema.compositions).values({ projectId: "other-project", status: "composing" }).run();
    db.insert(schema.assets).values({ projectId: "other-project", sourceScriptId: currentId, shotId: 1, type: "ai_generated", status: "generating" }).run();
    db.insert(schema.aiTasks).values({ projectId: "other-project", provider: "test", model: "test", taskId: "remote-1", status: "processing" }).run();
    addJob({ projectId: "other-project", remoteState: "processing", importState: "not_ready" });
    addFilm({ projectId: "other-project", status: "running" });
    expect((await restore()).status).toBe(200);
  });

  it("allows terminal work and dismissed Kling jobs to stay in history", async () => {
    db.insert(schema.pipelineRuns).values({ projectId, scriptId: currentId, status: "done" }).run();
    db.insert(schema.compositions).values({ projectId, status: "failed" }).run();
    db.insert(schema.assets).values({ projectId, sourceScriptId: currentId, shotId: 1, type: "ai_generated", status: "failed" }).run();
    db.insert(schema.aiTasks).values({ projectId, provider: "test", model: "test", taskId: "remote-1", status: "failed" }).run();
    addJob({ remoteState: "failed", importState: "failed" });
    addJob({ id: "dismissed-job", clientRequestId: "dismissed-request", remoteState: "processing", importState: "pending", data: { deletedAt: Date.now() } as never });
    addFilm({ status: "cancelled" });
    expect((await restore()).status).toBe(200);
  });

  it("checks new work appearing before the transaction acquires its lock", async () => {
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) => {
      db.insert(schema.compositions).values({ projectId, status: "composing" }).run();
      return transaction(callback, config);
    });
    await expectConflict();
  });

  it("returns a readable Chinese busy error", async () => {
    db.insert(schema.compositions).values({ projectId, status: "composing" }).run();
    const response = await restore(historicalId, projectId, "zh-CN");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "项目仍有未完成的生成任务，请先完成或处理任务后再恢复历史方案。" });
  });
});
